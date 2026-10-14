const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { reconcile, billingReady } = require('../services/energyValidation');
const start = new Date('2026-10-01T12:00:00Z');
const end = new Date(start.getTime() + 600000);
const base = { id: 1, status: 'done', start_time: start, end_time: end, start_energy_total: 100, end_energy_total: 101, energy_once: 1, user_id: 4, client_id: null, price_calculated: 1.2 };
const readings = Array.from({ length: 121 }, (_, i) => ({ observed_at: new Date(start.getTime() + i * 5000), power_kw: 6, total_kwh: 100 + i / 120, charging: true, fingerprint: `sample-${i}` }));
test('1. sessão normal: três medições compatíveis', () => { const r = reconcile(base, readings); assert.equal(r.status, 'validated'); assert.equal(r.reconciled_kwh, 1); assert.equal(r.once_trusted, false); });
test('2. diferenças pequenas respeitam tolerância', () => assert.equal(reconcile({ ...base, energy_once: 1.02, end_energy_total: 101.01 }, readings).status, 'validated'));
test('3. divergência não confirma cobrança', () => { const r = reconcile({ ...base, energy_once: 2 }, readings); assert.equal(r.status, 'divergent'); assert.equal(r.reconciled_kwh, null); });
test('4. ausência de once usa sistema e contador', () => assert.equal(reconcile({ ...base, energy_once: null }, readings).status, 'validated'));
test('5. ausência de contador exige revisão', () => assert.equal(reconcile({ ...base, start_energy_total: null }, readings).status, 'inconclusive'));
test('6. reinício sem lacuna conserva resultados persistidos', () => assert.deepEqual(reconcile(base, structuredClone(readings)), reconcile(base, readings)));
test('7. backend indisponível no término não inventa horário', () => { const r = reconcile({ ...base, end_time: null }, readings); assert.equal(r.status, 'inconclusive'); assert.equal(r.end_time_uncertain, true); });
test('8. API indisponível deixa lacuna sem energia fictícia', () => { const r = reconcile(base, [readings[0], readings.at(-1)]); assert.equal(r.system_kwh, 0); assert.equal(r.status, 'inconclusive'); });
test('9. conectado sem carregar não integra potência', () => { const r = reconcile({ ...base, end_energy_total: 100, energy_once: 0 }, readings.map((r) => ({ ...r, charging: false, power_kw: 0 }))); assert.equal(r.reconciled_kwh, 0); assert.equal(r.charging_seconds, 0); });
test('10. reconciliação repetida é determinística', () => assert.deepEqual(reconcile(base, readings), reconcile(base, readings)));
test('11. duplicadas e fora de ordem não duplicam energia', () => assert.deepEqual(reconcile(base, [...readings, ...readings].reverse()), reconcile(base, readings)));
test('12. reset do contador exige revisão', () => { const r = reconcile({ ...base, end_energy_total: 1 }, readings); assert.equal(r.status, 'inconclusive'); assert.ok(r.issues.includes('counter_reset')); });
test('13. validada sem responsável não está pronta', () => assert.equal(billingReady({ ...base, user_id: null, reconciliation: reconcile(base, readings) }), false));
test('14. vínculo posterior libera cobrança validada', () => assert.equal(billingReady({ ...base, user_id: null, client_id: 2, reconciliation: reconcile(base, readings) }), true));
test('15. dashboards excluem divergentes e inconclusivas', () => { const rows = [base, { ...base, energy_once: 8 }, { ...base, end_time: null }].map((s) => ({ ...s, reconciliation: reconcile(s, readings) })); assert.equal(rows.filter((s) => billingReady(s)).length, 1); });
test('leituras de sessões anteriores não são integradas', () => assert.deepEqual(reconcile(base, [{ ...readings[0], observed_at: new Date(start - 60000) }, ...readings]), reconcile(base, readings)));
test('autoencerramento não encerra na partida ou com carga efetiva', () => {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const body = source.slice(source.indexOf('function didChargingEnd('), source.indexOf('function calcElapsedSeconds('));
  const context = { config: { energyValidation: { maxGapSeconds: 30 } }, pickPowerKwFromStatus: (s) => s.power, calcElapsedSeconds: () => 10,
    AUTO_END_MIN_SESSION_AGE_SECONDS: 180, AUTO_END_ZERO_POWER_THRESHOLD_KW: .1,
    AUTO_END_CONSECUTIVE_POLLS: 6, AUTO_END_EXPLICIT_CONSECUTIVE_POLLS: 3,
    hasEffectiveChargingFlow: (s) => ({ ok: s.power > .5 }), detectExplicitChargingEnd: () => ({ code: 'work_state', value: 'charger_end' }),
    findDp: () => ({ value: 'charger_end' }) };
  vm.createContext(context); vm.runInContext(body, context);
  assert.equal(context.didChargingEnd({ power: 0 }, {}, base).ended, false);
  context.calcElapsedSeconds = () => 400;
  assert.equal(context.didChargingEnd({ power: 6 }, { explicitEndCount: 2 }, base).ended, false);
  assert.equal(context.didChargingEnd({ power: 0 }, { explicitEndCount: 2 }, base).ended, true);
});
