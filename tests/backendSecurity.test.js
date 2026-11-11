const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { gzipSync, gunzipSync } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const load = createRequire(path.join(root, 'server.js'));
const password = 'fixture-password-only';
const hash = load('bcryptjs').hashSync(password, 4);

// Real Express, proxy parsing, rate limiter, bcrypt, JWT and auth-session service.
// Only repositories/session storage are simulated; no startup monitor or real secrets.
async function application(t) {
  const settings = {
    isProd: true, jwtSecret: 'backend-security-test-only', jwtExpiresIn: '1h', adminRememberExpiresIn: '7d',
    cookie: { name: 'token', secure: true, sameSite: 'lax', path: '/' }, push: {}, tuya: {},
  };
  const users = [
    { id: 1, name: 'Admin', email: 'admin@invalid.local', is_admin: true, approval_status: 'approved', password_hash: hash },
    { id: 2, name: 'Usuário', email: 'user@invalid.local', is_admin: false, approval_status: 'approved', password_hash: hash },
  ];
  const sessions = new Map();
  const db = { query: async (sql, params) => {
    if (sql.startsWith('INSERT INTO auth_sessions')) {
      const [id, userId, expiresAt, remembered] = params;
      if (sql.includes('revoked_at')) {
        if (users.some((user) => user.id === userId)) sessions.set(id, { ...sessions.get(id), user_id: userId, expires_at: expiresAt, revoked_at: new Date() });
      } else if (!sessions.has(id)) sessions.set(id, { user_id: userId, expires_at: expiresAt, remembered });
      return [];
    }
    if (sql.startsWith('SELECT id FROM auth_sessions')) {
      const [id, userId] = params; const session = sessions.get(id);
      return session && session.user_id === userId && !session.revoked_at && new Date(session.expires_at) > new Date() ? [{ id }] : [];
    }
    assert.fail('SQL inesperado no armazenamento simulado');
  } };
  const authModule = { exports: {} };
  vm.runInThisContext('(function(require,module){' + fs.readFileSync(path.join(root, 'services/authSessions.js'), 'utf8') + '\n})')(
    (name) => name === '../config' ? settings : name === '../db/pg' ? db : load(name), authModule);
  const usersRepo = {
    findByEmail: async (email) => users.find((user) => user.email === email),
    findById: async (id) => users.find((user) => user.id === id),
    setLastLoginAt: async (id) => users.find((user) => user.id === id),
  };
  const mockRequire = (name) => {
    if (name === 'dotenv') return { config() {} };
    if (name === './config') return settings;
    if (name === './db/pg') return db;
    if (name === './services/authSessions') return authModule.exports;
    if (name === './repositories/usersRepo') return usersRepo;
    if (name.startsWith('./repositories/') || name === './tuya_api') return new Proxy({}, { get: () => () => assert.fail('Acesso a banco/Tuya real proibido') });
    if (name === 'pino') return () => load('pino')({ enabled: false });
    return load(name);
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  new Function('require', '__dirname', 'module', source.slice(0, source.indexOf('const PORT = config.port;')) + '\nmodule.exports=app;')(mockRequire, root, module);
  assert.equal(module.exports.get('trust proxy'), 1);
  const server = await new Promise((resolve) => { const listener = module.exports.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, { ip = '198.51.100.10', method = 'POST', body, headers = {} } = {}) => fetch(base + url, {
    method, headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json', ...headers },
    body: body == null ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  return { request, sessions, settings, base, users };
}

test('HTTP: login admin, cookie seguro/persistente opcional, reabertura e logout revogado', async (t) => {
  const app = await application(t);
  for (const remember of [false, true]) {
    const result = await app.request('/auth/login', { body: { email: 'admin@invalid.local', password, remember_me: remember } });
    assert.equal(result.status, 200); assert.equal((await result.json()).user.is_admin, true);
    const cookie = result.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
    assert.equal(/Max-Age=/.test(cookie), remember); assert.equal(/Expires=/.test(cookie), remember);
    const token = cookie.split(';')[0];
    const claims = load('jsonwebtoken').verify(token.slice('token='.length), app.settings.jwtSecret);
    assert.equal(claims.exp - claims.iat, remember ? 7 * 86400 : 3600);
    const session = app.sessions.get(claims.jti); assert.equal(session.remembered, remember);
    if (remember) {
      const maxAge = Number(cookie.match(/Max-Age=(\d+)/)[1]);
      assert.ok(Math.abs(maxAge - (claims.exp - Date.now() / 1000)) <= 2);
    }
    const reopened = await app.request('/api/me', { method: 'GET', headers: { Cookie: token } });
    assert.equal(reopened.status, 200);
    const logout = await app.request('/api/logout', { headers: { Cookie: token } });
    assert.equal(logout.status, 200); assert.ok(session !== app.sessions.get(claims.jti));
    assert.ok(app.sessions.get(claims.jti).revoked_at);
    assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    assert.equal((await app.request('/api/me', { method: 'GET', headers: { Cookie: token } })).status, 401);
  }
  const common = await app.request('/auth/login', { body: { email: 'user@invalid.local', password, remember_me: true } });
  assert.equal(common.status, 200); assert.doesNotMatch(common.headers.get('set-cookie'), /Max-Age=|Expires=/);
});

test('HTTP: dez tentativas por IP atrás de um proxy; 11ª bloqueada sem bloquear outro cliente', async (t) => {
  const app = await application(t);
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await app.request('/auth/login', { body: { email: 'admin@invalid.local', password: 'wrong' } });
    assert.equal(response.status, 401);
  }
  const blocked = await app.request('/auth/login', { body: { email: 'admin@invalid.local', password } });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.ok((await blocked.json()).retry_after_seconds > 0);
  const other = await app.request('/auth/login', { ip: '198.51.100.11', body: { email: 'admin@invalid.local', password } });
  assert.equal(other.status, 200);
  // With one trusted hop, a forged leftmost address must not replace the actual rightmost client.
  const forged = await app.request('/auth/login', { ip: '203.0.113.99, 198.51.100.10', body: { email: 'admin@invalid.local', password } });
  assert.equal(forged.status, 429);
});

test('HTTP: alternar IPv4 e suas representações IPv6 não contorna limite de login', async (t) => {
  const app = await application(t);
  const addresses = ['198.51.100.20', '::ffff:198.51.100.20', '::ffff:c633:6414', '0:0:0:0:0:ffff:c633:6414'];
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await app.request('/auth/login', { ip: addresses[attempt % addresses.length], body: {} })).status, 400);
  }
  for (const ip of addresses) assert.equal((await app.request('/auth/login', { ip, body: {} })).status, 429);
});

test('HTTP: IPv6 preserva o limite por sub-rede sem bloquear outro /56', async (t) => {
  const app = await application(t);
  for (let attempt = 0; attempt < 10; attempt++) {
    const ip = `2001:db8:1234:5600::${attempt + 1}`;
    assert.equal((await app.request('/auth/login', { ip, body: {} })).status, 400);
  }
  assert.equal((await app.request('/auth/login', { ip: '2001:db8:1234:56ff::b', body: {} })).status, 429);
  assert.equal((await app.request('/auth/login', { ip: '2001:db8:1234:5700::b', body: {} })).status, 400);
});

test('proxy-addr não confia em IP arbitrário com prefixo IPv4 mapeado incorreto', () => {
  const proxy = load('proxy-addr');
  assert.equal(proxy.compile('::ffff:10.0.0.0/8')('198.51.100.20'), false);
  const trust = proxy.compile('::ffff:10.0.0.0/104');
  assert.equal(trust('10.1.2.3'), true); assert.equal(trust('198.51.100.20'), false);
});

test('HTTP: body-parser aceita gzip válido, rejeita JSON inválido e limita tamanho', async (t) => {
  const app = await application(t);
  const zipped = await app.request('/auth/login', { headers: { 'Content-Encoding': 'gzip' }, body: gzipSync(JSON.stringify({ email: 'admin@invalid.local', password })) });
  assert.equal(zipped.status, 200);
  assert.equal((await app.request('/auth/login', { body: '{' })).status, 400);
  const oversized = { email: 'admin@invalid.local', password, padding: 'x'.repeat(110 * 1024) };
  assert.equal((await app.request('/auth/login', { body: oversized })).status, 413);
  assert.equal((await app.request('/auth/login', { headers: { 'Content-Encoding': 'gzip' }, body: gzipSync(JSON.stringify(oversized)) })).status, 413);
});

test('HTTP: compression mantém resposta gzip válida após atualização', async (t) => {
  const app = await application(t);
  app.users[0].name = 'Admin '.repeat(400);
  const login = await app.request('/auth/login', { body: { email: 'admin@invalid.local', password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  // Raw HTTP avoids fetch's transparent decompression and verifies the actual wire payload.
  const payload = await new Promise((resolve, reject) => {
    load('node:http').get(app.base + '/api/me', { headers: { 'Accept-Encoding': 'gzip', Cookie: cookie, 'X-Forwarded-For': '198.51.100.10' } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, encoding: res.headers['content-encoding'], bytes: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  assert.equal(payload.status, 200); assert.equal(payload.encoding, 'gzip');
  assert.equal(JSON.parse(gunzipSync(payload.bytes).toString('utf8')).user.name, app.users[0].name);
});
