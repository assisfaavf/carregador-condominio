const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');

const server = fs.readFileSync(require.resolve('../server'), 'utf8');
const policy = { jwtSecret: 'login-unit-test-only', jwtExpiresIn: '1h', adminRememberExpiresIn: '7d' };

function loginHarness(admin = true) {
  const module = { exports: {} };
  vm.runInThisContext('(function(require,module){' + fs.readFileSync(require.resolve('../services/authSessions'), 'utf8') + '\n})')(
    (name) => name === '../db/pg' ? {} : name === '../config' ? policy : require(name), module);
  const sessions = new Set();
  const user = { id: 1, is_admin: admin, approval_status: 'approved', password_hash: 'fixture' };
  let login;
  const context = {
    config: { ...policy, isProd: true, cookie: { name: 'token', secure: true, sameSite: 'lax', path: '/' } },
    app: { post: (_path, handler) => { login = handler; } }, jwt,
    usersRepo: { findByEmail: async () => user, setLastLoginAt: async () => user, findById: async () => user },
    bcrypt: { compareSync: (password) => password === 'correct-test-password' },
    authSessions: {
      issueToken: module.exports.issueToken,
      create: async (issued) => { sessions.add(issued.id); },
      validate: async (_token, claims) => sessions.has(claims.jti) ? claims.jti : null,
      revokeToken: async (token) => { if (token) sessions.delete(jwt.decode(token).jti); },
    },
    toAuthUser: (value) => value,
    isDatabaseUnavailableError: () => false,
    sendErrorResponse: (res, status, message) => res.status(status).json({ message }),
  };
  vm.createContext(context);
  vm.runInContext(server.slice(server.indexOf('function getAuthCookieOptions('), server.indexOf('function hasTuyaCredentials(')), context);
  vm.runInContext(server.slice(server.indexOf('async function requireAuth('), server.indexOf('function diagnoseStartFailure(')), context);
  vm.runInContext(server.slice(server.indexOf('app.post("/auth/login"'), server.indexOf('app.get("/auth/me"')), context);
  vm.runInContext(server.slice(server.indexOf('async function logoutSession('), server.indexOf("app.post('/auth/logout'")), context);
  const response = () => ({ code: 200, locals: {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; },
    cookie(_name, token, options) { this.token = token; this.options = options; }, clearCookie() { this.cleared = true; } });
  return { context, login, response, sessions, user };
}

test('handler de login: administrador com e sem persistência; reabrir e sair revoga o token', async () => {
  for (const remember of [false, true]) {
    const h = loginHarness(); const res = h.response();
    await h.login({ body: { email: 'admin@example.com', password: 'correct-test-password', remember_me: remember } }, res);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.options.maxAge, remember ? 'number' : 'undefined');
    assert.equal(res.options.httpOnly, true); assert.equal(res.options.secure, true);
    const claims = jwt.verify(res.token, policy.jwtSecret);
    assert.equal(claims.exp - claims.iat, remember ? 7 * 86400 : 3600);
    // A fresh request has no in-memory UI state: only the cookie and persisted session matter.
    let authenticated = false;
    await h.context.requireAuth({ cookies: { token: res.token } }, h.response(), () => { authenticated = true; });
    assert.equal(authenticated, true);
    const logout = h.response(); await h.context.logoutSession({ cookies: { token: res.token } }, logout);
    assert.equal(logout.cleared, true);
    const replay = h.response();
    await h.context.requireAuth({ cookies: { token: res.token } }, replay, () => assert.fail('Token revogado aceito'));
    assert.equal(replay.code, 401);
  }
});

test('login comum não ganha persistência e rotas administrativas negam acesso', async () => {
  const h = loginHarness(false); const res = h.response();
  await h.login({ body: { email: 'user@example.com', password: 'correct-test-password', remember_me: true } }, res);
  assert.equal(res.options.maxAge, undefined);
  const denied = h.response();
  h.context.requireAdmin({ user: h.user }, denied, () => assert.fail('Usuário comum autorizado'));
  assert.equal(denied.code, 403);
});

test('sessão expirada não autentica; falha de revogação não confirma logout', async () => {
  const h = loginHarness(); const res = h.response();
  const token = jwt.sign({ id: 1 }, policy.jwtSecret, { expiresIn: -1 });
  await h.context.requireAuth({ cookies: { token } }, res, () => assert.fail('JWT expirado aceito'));
  assert.equal(res.code, 401);
  h.context.authSessions.revokeToken = async () => { throw new Error('DB offline'); };
  const logout = h.response(); await h.context.logoutSession({ cookies: { token } }, logout);
  assert.equal(logout.code, 503); assert.equal(logout.cleared, undefined);
});

function workerHarness() {
  const handlers = {}; const shown = []; const opened = [];
  const self = { location: { origin: 'https://spate.example' }, addEventListener: (kind, callback) => { handlers[kind] = callback; },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: { matchAll: async () => [], openWindow: async (url) => { opened.push(url); } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/public/sw.js'), 'utf8'), { self, URL });
  return { handlers, shown, opened, self };
}

test('service worker exibe Push sem janela aberta e clique abre histórico ou estação', async () => {
  for (const destination of ['/admin/history', '/admin/dashboard?station_id=7']) {
    const h = workerHarness(); let pending;
    h.handlers.push({ data: { json: () => ({ title: 'Aviso', body: 'Estação', tag: 'finished:7', url: destination }) }, waitUntil: (value) => { pending = value; } });
    await pending;
    assert.equal(h.shown[0].options.tag, 'finished:7');
    let closed = false;
    h.handlers.notificationclick({ notification: { close: () => { closed = true; }, data: h.shown[0].options.data }, waitUntil: (value) => { pending = value; } });
    await pending;
    assert.equal(closed, true); assert.equal(h.opened[0], 'https://spate.example' + destination);
  }
});

test('service worker bloqueia destinos externos e reutiliza a janela do app', async () => {
  const h = workerHarness(); let pending; let navigated; let focused = false;
  h.self.clients.matchAll = async () => [{ url: 'https://spate.example/login', navigate: async (url) => { navigated = url; }, focus: async () => { focused = true; } }];
  h.handlers.push({ data: { json: () => ({ url: 'https://evil.example/admin/history' }) }, waitUntil: (value) => { pending = value; } });
  await pending;
  assert.equal(h.shown[0].options.data.url, '/admin/dashboard');
  h.handlers.notificationclick({ notification: { close() {}, data: h.shown[0].options.data }, waitUntil: (value) => { pending = value; } });
  await pending;
  assert.equal(navigated, 'https://spate.example/admin/dashboard'); assert.equal(focused, true);
});
