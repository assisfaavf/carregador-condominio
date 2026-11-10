const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const jwt = require('jsonwebtoken');

const root = path.resolve(__dirname, '..');
const built = fs.existsSync(path.join(root, 'web/dist/index.html'));

test('Express de produção: arquivos PWA e APIs Push protegidas, sem iniciar monitoramento', { skip: !built }, async () => {
  const realRequire = createRequire(path.join(root, 'server.js'));
  const settings = { isProd: true, jwtSecret: 'http-push-test-only', push: { publicKey: 'public-test-key', privateKey: '', subject: '' },
    cookie: { name: 'token', secure: true, sameSite: 'lax', path: '/' }, tuya: {} };
  const db = { query: async () => [], withTransaction: async () => assert.fail('Transação inesperada no smoke test') };
  const auth = { validate: async (_token, claims) => claims.id === 3 ? null : 'test-session' };
  const mockRequire = (name) => {
    if (name === 'dotenv') return { config() {} };
    if (name === './config') return settings;
    if (name === './db/pg') return db;
    if (name === './services/authSessions') return auth;
    if (name === './repositories/usersRepo') return { findById: async (id) => ({ id, is_admin: id !== 2, approval_status: 'approved' }) };
    if (name.startsWith('./repositories/') || name === './tuya_api') return new Proxy({}, { get: () => () => assert.fail('Acesso real a banco/Tuya proibido no smoke test') });
    if (name === 'pino') return () => realRequire('pino')({ enabled: false });
    return realRequire(name);
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  // Mount the real Express stack but never execute its startup/background callbacks.
  new Function('require', '__dirname', 'module', source.slice(0, source.indexOf('const PORT = config.port;')) + '\nmodule.exports=app;')(mockRequire, root, module);
  const listener = await new Promise((resolve) => { const value = module.exports.listen(0, '127.0.0.1', () => resolve(value)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  try {
    const html = await (await fetch(base + '/login')).text();
    assert.match(html, /href="\/manifest\.webmanifest"/);
    assert.match(html, /href="\/assets\/spate_charge_icon\.svg"/);
    const worker = await fetch(base + '/sw.js');
    assert.equal(worker.status, 200); assert.match(worker.headers.get('content-type'), /javascript/);
    assert.match(await worker.text(), /notificationclick/);
    const manifest = await fetch(base + '/manifest.webmanifest');
    assert.equal(manifest.status, 200); assert.equal((await manifest.json()).display, 'standalone');
    const icon = await fetch(base + '/apple-touch-icon.png');
    assert.equal(icon.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await icon.arrayBuffer());
    assert.equal(png.readUInt32BE(16), 180); assert.equal(png.readUInt32BE(20), 180);
    for (const method of ['GET', 'POST', 'DELETE']) {
      const anonymous = await fetch(base + '/api/admin/push', { method });
      assert.equal(anonymous.status, 401);
      for (const [id, status] of [[2, 403], [3, 401]]) {
        const token = jwt.sign({ id }, settings.jwtSecret, { expiresIn: '1h' });
        const denied = await fetch(base + '/api/admin/push', { method, headers: { Cookie: `token=${token}` } });
        assert.equal(denied.status, status);
      }
    }
    const token = jwt.sign({ id: 1 }, settings.jwtSecret, { expiresIn: '1h' });
    const allowed = await fetch(base + '/api/admin/push', { headers: { Cookie: `token=${token}` } });
    assert.equal(allowed.status, 200);
    const result = await allowed.json();
    assert.equal(result.publicKey, settings.push.publicKey); assert.equal(result.privateKey, undefined);
  } finally {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
});
