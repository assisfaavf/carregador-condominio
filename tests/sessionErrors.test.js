const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionErrors } = require('../services/sessionErrors');

test('aba de erros identifica falha de início e preserva o motivo registrado', () => {
  const [error] = sessionErrors({ status: 'failed', notes: 'Corrente insuficiente: 0,9 A.' });
  assert.equal(error.code, 'charging_failed');
  assert.equal(error.detail, 'Corrente insuficiente: 0,9 A.');
});
test('falha sem detalhes tem mensagem legível', () => {
  assert.match(sessionErrors({ status: 'failed' })[0].detail, /início da recarga/);
});
test('divergência e dados insuficientes aparecem com diagnósticos em português', () => {
  const errors = sessionErrors({ status: 'done', reconciliation: { status: 'inconclusive', issues: ['counter_reset', 'missing_samples', 'missing_samples'] } });
  assert.deepEqual(errors.map((error) => error.code), ['energy_inconclusive', 'counter_reset', 'missing_samples']);
  assert.equal(sessionErrors({ reconciliation: { status: 'divergent' } })[0].code, 'energy_divergence');
});
test('cliente ausente, pagamento pendente e sessão antiga não são erros', () => {
  assert.deepEqual(sessionErrors({ status: 'done', client_id: null, payment_status: 'pendente', notes: 'Sem cliente', needs_review: true }), []);
  assert.deepEqual(sessionErrors({ status: 'running' }), []);
  assert.deepEqual(sessionErrors({ reconciliation: { status: 'pending' } }), []);
});
test('correção manual confirmada não reapresenta os diagnósticos antigos', () => {
  assert.deepEqual(sessionErrors({ status: 'done', reconciliation: { status: 'validated', manual: true, issues: ['counter_reset'] } }), []);
});
test('dados incompletos de diagnóstico não quebram a lista', () => {
  assert.equal(sessionErrors({ reconciliation: { status: 'inconclusive', issues: 'unexpected' } }).length, 1);
  assert.equal(sessionErrors({ reconciliation: { status: 'divergent', issues: ['unknown', '__proto__', 'toString', null] } }).length, 1);
});
