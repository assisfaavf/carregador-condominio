function telemetrySnapshot(status, now = Date.now()) {
  const rows = Array.isArray(status?.result) ? status.result : status?.result?.properties || [];
  const get = (code) => rows.find((row) => row.code === code);
  const cp = get('connection_state')?.value;
  const connected = cp === 'controlpi_12v' ? false : ['controlpi_9v','controlpi_6v','controlpi_3v'].includes(cp) ? true : null;
  const work = get('work_state')?.value;
  let flow = false;
  try {
    const phase = get('phase_a');
    const raw = Buffer.from(phase?.value || '', 'base64');
    const fresh = phase?.time == null || now - Number(phase.time) <= 30000;
    flow = fresh && raw.length >= 8 && (raw.readUIntBE(2, 3) / 1000 >= 2 || raw.readUIntBE(5, 3) / 1000 >= 0.5);
  } catch { /* Missing/invalid telemetry is not evidence of charging. */ }
  const waiting = !flow && ['charger_wait','charger_idle','charger_charging'].includes(work);
  const charging = connected === false ? false : work === 'charger_charging' && flow ? true
    : !flow && ['charger_end','charger_finish','charger_finished','charger_free'].includes(work) ? false : null;
  const timestamps = ['connection_state','work_state','phase_a'].map((code) => Number(get(code)?.time)).filter((time) => Number.isFinite(time) && time > 0 && time <= now + 5000);
  return { connected, charging, waiting, observedAt: new Date(timestamps.length ? Math.max(...timestamps) : now) };
}

function transitions(previous, sample) {
  if (!previous || new Date(sample.observedAt) <= new Date(previous.observed_at)) return [];
  const events = [];
  if (previous.connected === false && sample.connected === true) events.push('connected');
  if (previous.charging === false && sample.charging === true) events.push('started');
  return events;
}
module.exports = { telemetrySnapshot, transitions };
