const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { sessionPresentation } = require('../services/sessionPresentation');

// Run the actual route without starting Express, the watchdog or Tuya requests.
function correctionRoute(status = 'done') {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const start = source.indexOf("app.post('/api/admin/sessions/:id/validate'");
  const end = source.indexOf('app.patch("/api/admin/sessions/:id"', start);
  const session = { id: 1, status, user_id: 7, energy_kwh: 12, needs_review: true, tariff_per_kwh: 1.2, reconciliation: { status: 'divergent' } };
  const calls = [];
  let handler;
  const context = {
    app: { post(_path, auth, admin, callback) { assert.equal(typeof auth, 'function'); assert.equal(typeof admin, 'function'); handler = callback; } },
    requireAuth() {}, requireAdmin() {},
    parsePositiveInt: (value) => Number(value),
    normalizeNullableText: (value) => typeof value === 'string' ? value.trim() || null : null,
    sessionPresentation,
    sessionsRepo: { getById: async () => session, listAdmin: async () => [session] },
    energyReadingsRepo: { revise: async (...args) => { calls.push(args); session.reconciliation = args[2].reconciliation; session.needs_review = false; } },
    mapAdminSessionForUi: (value) => value,
    sendErrorResponse: (res, code, message) => res.status(code).json({ message }),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function toFiniteNumber('), source.indexOf('function round2(')), context);
  vm.runInContext(source.slice(start, end), context);
  return {
    calls,
    async invoke(body) {
      const response = { code: 200, body: null, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
      await handler({ params: { id: '1' }, user: { id: 7 }, body }, response);
      return response;
    },
  };
}

test('correção de consumo aceita justificativa omitida, vazia ou com espaços', async () => {
  for (const body of [{ energy_kwh: 8 }, { energy_kwh: 8, reason: '' }, { energy_kwh: 8, reason: '   ' }]) {
    const route = correctionRoute();
    const response = await route.invoke(body);
    assert.equal(response.code, 200);
    assert.equal(route.calls.length, 1);
    const [id, actor, patch, reason] = route.calls[0];
    assert.equal(id, 1); assert.equal(actor, 7);
    assert.equal(patch.reconciliation.reconciled_kwh, 8);
    assert.equal(patch.reconciliation.status, 'validated');
    assert.equal(patch.reconciliation.manual, true);
    assert.equal(reason, 'Correção manual do consumo.');
  }
});
test('justificativa informada continua na auditoria e zero é aceito', async () => {
  const route = correctionRoute();
  const response = await route.invoke({ energy_kwh: 0, reason: '  Correção do medidor  ' });
  assert.equal(response.code, 200);
  assert.equal(route.calls[0][3], 'Correção do medidor');
  assert.equal(route.calls[0][2].reconciliation.reconciled_kwh, 0);
});
test('remoção da justificativa obrigatória não aceita energia inválida ou ausente', async () => {
  for (const value of ['', '   ', null, undefined, -1, 10001, 'inválido', Infinity]) {
    const route = correctionRoute();
    const response = await route.invoke({ energy_kwh: value });
    assert.equal(response.code, 400, String(value));
    assert.equal(route.calls.length, 0);
  }
});
test('correção aceita consumo decimal com vírgula sem justificativa', async () => {
  const route = correctionRoute();
  assert.equal((await route.invoke({ energy_kwh: '14,93' })).code, 200);
  assert.equal(route.calls[0][2].reconciliation.reconciled_kwh, 14.93);
});
test('sessão em andamento não pode ter consumo final corrigido', async () => {
  const route = correctionRoute('running');
  assert.equal((await route.invoke({ energy_kwh: 8 })).code, 409);
  assert.equal(route.calls.length, 0);
});
