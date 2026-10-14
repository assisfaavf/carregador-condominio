const db = require('../db/pg');
const { createHash } = require('crypto');

async function record(sessionId, reading, tx = db) {
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...reading, source: undefined })).digest('hex');
  await tx.query(`INSERT INTO session_energy_readings
    (session_id, observed_at, source, fingerprint, total_kwh, once_kwh, power_kw, current_a, voltage_v, work_state, charging, raw_fields)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (session_id, fingerprint) DO NOTHING`,
  [sessionId, reading.observed_at, reading.source, fingerprint, reading.total_kwh, reading.once_kwh,
    reading.power_kw, reading.current_a, reading.voltage_v, reading.work_state, reading.charging, reading.raw_fields]);
}
async function list(sessionId, tx = db) {
  return tx.query('SELECT * FROM session_energy_readings WHERE session_id = $1 ORDER BY observed_at, id LIMIT 20000', [sessionId]);
}
async function saveResult(sessionId, result, tx = db) {
  await tx.query(`UPDATE sessions SET reconciliation = $2, needs_review = $3,
    energy_kwh = $4, price_calculated = CASE WHEN $4::numeric IS NULL THEN NULL ELSE ROUND($4::numeric * tariff_per_kwh, 2) END
    WHERE id = $1 AND status = 'done'`, [sessionId, result, result.status !== 'validated', result.reconciled_kwh]);
}
async function audit(sessionId, actorId, action, before, after, reason, tx = db) {
  await tx.query(`INSERT INTO session_revisions(session_id, actor_id, action, before_values, after_values, reason)
    VALUES ($1,$2,$3,$4,$5,$6)`, [sessionId, actorId, action, before, after, reason]);
}
module.exports = { record, list, saveResult, audit };
async function revise(sessionId, actorId, patch, reason) {
  const reject = (message) => { const error = new Error(message); error.statusCode = 409; error.publicMessage = message; throw error; };
  return db.withTransaction(async (tx) => {
    const [before] = await tx.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (!before) return null;
    if (patch.reconciliation && before.status !== 'done') reject('Somente sessões encerradas podem ser validadas.');
    if (before.reconciliation?.manual && patch.reconciliation && !patch.reconciliation.manual) reject('Uma validação manual não pode ser substituída automaticamente.');
    const result = patch.reconciliation ?? before.reconciliation;
    const clientId = Object.hasOwn(patch, 'client_id') ? patch.client_id : before.client_id;
    const userId = Object.hasOwn(patch, 'user_id') ? patch.user_id : before.user_id;
    const energy = result?.reconciled_kwh ?? before.energy_kwh;
    const price = patch.price_override !== undefined ? patch.price_override : before.price_override;
    const ready = require('../services/energyValidation').billingReady({ ...before, client_id: clientId, user_id: userId, price_override: price, price_calculated: energy == null || before.tariff_per_kwh == null ? null : Number(energy) * Number(before.tariff_per_kwh) }, result);
    if (patch.payment_status === 'pago' && !ready) reject('Sessão sem consumo validado, responsável ou valor financeiro.');
    if (before.payment_status === 'pago' && !ready) reject('Revise o pagamento antes de remover a validação ou o responsável.');
    if (before.end_time == null && patch.verified_end_time) {
      await tx.query(`UPDATE sessions SET end_time=$2, duration_seconds=GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz-start_time))::integer) WHERE id=$1`, [sessionId, patch.verified_end_time]);
    }
    await require('./sessionsRepo').updateAdminFields(sessionId, patch, tx);
    if (patch.reconciliation) await saveResult(sessionId, patch.reconciliation, tx);
    const [updated] = await tx.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    await audit(sessionId, actorId, patch.reconciliation ? actorId == null ? 'automatic_reconciliation' : 'manual_validation' : 'admin_change', before, updated, reason, tx);
    return updated;
  });
}
module.exports.revise = revise;
