const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionPresentation } = require('../services/sessionPresentation');
const { reconcile, billingReady } = require('../services/energyValidation');

test('histórico anterior exibe energia e preço salvos sem validar automaticamente', () => {
  const session = { status: 'done', user_id: 1, energy_kwh: 14.93, price_calculated: 17.92, energy_once: 14.93, start_energy_total: 100, end_energy_total: 114.93 };
  const display = sessionPresentation(session);
  assert.equal(display.energy_kwh, 14.93);
  assert.equal(display.price_calculated, 17.92);
  assert.equal(display.reconciliation.recorded_kwh, 14.93);
  assert.equal(display.reconciliation.once_kwh, 14.93);
  assert.equal(display.reconciliation.status, 'legacy');
  assert.equal(billingReady(session), false);
  assert.equal(session.reconciliation, undefined);
});
test('revisão usa contador salvo e calcula preço quando o valor não existe', () => {
  const result = sessionPresentation({ start_energy_total: 10, end_energy_total: 12.5, tariff_per_kwh: 2 });
  assert.equal(result.energy_kwh, 2.5);
  assert.equal(result.reconciliation.counter_kwh, 2.5);
  assert.equal(result.price_calculated, 5);
});
test('consumo e valor zero são preservados; ausência não vira zero', () => {
  const zero = sessionPresentation({ energy_kwh: 0, price_calculated: 0, energy_once: 12 });
  assert.equal(zero.energy_kwh, 0); assert.equal(zero.price_calculated, 0);
  const absent = sessionPresentation({});
  assert.equal(absent.energy_kwh, null); assert.equal(absent.price_calculated, null);
});
test('sessão inconclusiva conserva sugestão do acompanhamento sem liberar cobrança', () => {
  const session = { status: 'done', user_id: 1, start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-01T01:00:00Z', start_energy_total: 100, end_energy_total: 112, energy_once: 30, tariff_per_kwh: 1.5 };
  const result = reconcile(session, []);
  assert.equal(result.proposed_kwh, 12); assert.equal(result.reconciled_kwh, null);
  const view = sessionPresentation({ ...session, reconciliation: result });
  assert.equal(view.energy_kwh, 12); assert.equal(view.price_calculated, 18);
  assert.equal(billingReady({ ...session, reconciliation: result }), false);
});
test('valor manual validado prevalece sobre a sugestão e o histórico bruto', () => {
  const view = sessionPresentation({ energy_kwh: 12, price_override: 19, reconciliation: { status: 'validated', reconciled_kwh: 10, proposed_kwh: 12 } });
  assert.equal(view.energy_kwh, 10); assert.equal(view.price_override, 19);
});
test('reset de contador não produz sugestão falsa nem reutiliza once da carga anterior', () => {
  const session = { start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-01T01:00:00Z', start_energy_total: 100, end_energy_total: 1, energy_once: 12 };
  const result = reconcile(session, []);
  assert.equal(result.proposed_kwh, null);
  assert.equal(sessionPresentation({ ...session, reconciliation: result }).energy_kwh, null);
});
