const test = require('node:test');
const assert = require('node:assert/strict');
const trackerModule = import('../web/src/lib/adminStartTracker.js');
const request = { stationId: 1, userId: 7, existingSessionIds: [12] };
const session = { station_id: 1, user_id: 7, session_id: 13 };
const live = { success: true, session_id: 13, charging: true, currentA: 16, powerKw: 3.5 };
async function createTracker() { const { AdminStartTracker } = await trackerModule; return new AdminStartTracker(); }

test('início administrativo bloqueia dois envios antes do próximo render', async () => {
  const tracker = await createTracker();
  assert.ok(tracker.begin(request));
  assert.equal(tracker.begin(request), null);
  assert.equal(tracker.pending, true);
});
test('resposta de sucesso confirma uma vez e permite fechar a janela', async () => {
  const tracker = await createTracker();
  const attempt = tracker.begin(request);
  assert.equal(tracker.confirm(attempt), true);
  assert.equal(tracker.confirm(attempt), false);
  tracker.finish(attempt);
  assert.equal(tracker.pending, false);
  assert.equal(tracker.tracking, false);
});
test('poll reconhece a nova recarga do usuário sem acusar estação ocupada', async () => {
  const tracker = await createTracker();
  const attempt = tracker.begin(request);
  assert.equal(tracker.confirmCharging(session, live), true);
  assert.equal(attempt.confirmed, true);
  // A later HTTP error must not reopen the already-confirmed modal.
  assert.equal(!attempt.confirmed, false);
  tracker.finish(attempt);
  assert.equal(tracker.pending, false);
});
test('registro running antes da confirmação física não é sucesso de início', async () => {
  const tracker = await createTracker();
  tracker.begin(request);
  assert.equal(tracker.confirmCharging(session, { ...live, charging: false, workState: 'charger_wait', currentA: 0, powerKw: 0 }), false);
  assert.equal(tracker.confirmCharging(session, { ...live, currentA: 0.9, powerKw: 0.1 }), false);
});
test('erro de rede seguido de poll confirmado fecha a janela sem recarregar a página', async () => {
  const tracker = await createTracker();
  const attempt = tracker.begin(request);
  tracker.finish(attempt);
  assert.equal(tracker.pending, false);
  assert.equal(tracker.tracking, true);
  assert.equal(tracker.confirmCharging(session, live), true);
  tracker.reset();
  assert.equal(tracker.tracking, false);
});
test('sessão de outro usuário, estação ou preexistente não confirma a solicitação', async () => {
  const tracker = await createTracker();
  tracker.begin(request);
  assert.equal(tracker.confirmCharging({ ...session, user_id: 9 }, live), false);
  assert.equal(tracker.confirmCharging({ ...session, station_id: 2 }, live), false);
  assert.equal(tracker.confirmCharging({ ...session, session_id: 12 }, { ...live, session_id: 12 }), false);
});
test('telemetria ausente, indisponível ou de outra sessão mantém a janela para revisão', async () => {
  const tracker = await createTracker();
  tracker.begin(request);
  assert.equal(tracker.confirmCharging(session, null), false);
  assert.equal(tracker.confirmCharging(session, { ...live, telemetry_unavailable: true }), false);
  assert.equal(tracker.confirmCharging(session, { ...live, success: false }), false);
  assert.equal(tracker.confirmCharging(session, { ...live, session_id: 15 }), false);
  assert.equal(tracker.confirmCharging(null, live), false);
});
test('IDs numéricos serializados pelo PostgreSQL são reconhecidos', async () => {
  const tracker = await createTracker();
  tracker.begin(request);
  assert.equal(tracker.confirmCharging({ station_id: '1', user_id: '7', session_id: '13' }, { ...live, session_id: '13' }), true);
});
test('conclusão atrasada não libera o bloqueio de uma nova solicitação', async () => {
  const tracker = await createTracker();
  const old = tracker.begin(request);
  tracker.finish(old);
  const next = tracker.begin({ ...request, stationId: 2 });
  tracker.finish(old);
  assert.equal(tracker.pending, true);
  assert.equal(tracker.confirm(old), false);
  assert.equal(tracker.confirm(next), true);
});
test('cancelar após falha remove a identificação da solicitação anterior', async () => {
  const tracker = await createTracker();
  const attempt = tracker.begin(request);
  tracker.finish(attempt);
  tracker.reset();
  assert.equal(tracker.confirmCharging(session, live), false);
});
