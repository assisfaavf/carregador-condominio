const finite = (value) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value) => value == null ? null : Math.round(value * 1000) / 1000;

// Integrate only adjacent, fresh, observed charging samples; never fill gaps.
function reconcile(session, readings, options = {}) {
  const absolute = options.absolute ?? 0.2;
  const relative = options.relative ?? 0.05;
  const maxGapMs = (options.maxGapSeconds ?? 30) * 1000;
  const issues = [];
  const startMs = new Date(session.start_time).getTime();
  const endMs = session.end_time ? new Date(session.end_time).getTime() : Infinity;
  const inSession = readings.filter((r) => {
    const time = new Date(r.observed_at).getTime();
    return Number.isFinite(time) && time >= startMs && time <= endMs;
  });
  const unique = [...new Map(inSession.map((r) => [r.fingerprint || `${r.observed_at}:${r.source}`, r])).values()];
  const samples = unique.sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at));
  if (readings.length >= 20000) issues.push('sample_limit');
  let system = 0;
  let covered = 0;
  let chargingSeconds = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1];
    const current = samples[i];
    const elapsed = new Date(current.observed_at) - new Date(previous.observed_at);
    if (finite(current.total_kwh) != null && finite(previous.total_kwh) != null && Number(current.total_kwh) < Number(previous.total_kwh)) issues.push('counter_reset');
    if (elapsed <= 0) continue;
    if (elapsed > maxGapMs) { issues.push('missing_samples'); continue; }
    const a = finite(previous.power_kw);
    const b = finite(current.power_kw);
    if (a == null || b == null || a < 0 || b < 0 || a > 100 || b > 100) { issues.push('invalid_power'); continue; }
    covered += elapsed / 1000;
    if (previous.charging && current.charging) {
      system += ((a + b) / 2) * elapsed / 3600000;
      if (a > 0.1 || b > 0.1) chargingSeconds += elapsed / 1000;
    }
  }
  const duration = session.end_time ? (new Date(session.end_time) - new Date(session.start_time)) / 1000 : null;
  if (duration == null || covered < Math.max(0, duration - (options.maxGapSeconds ?? 30))) issues.push('incomplete_coverage');
  const initial = finite(session.start_energy_total);
  const final = finite(session.end_energy_total);
  const counter = initial != null && final != null && final >= initial ? final - initial : null;
  if (initial != null && final != null && final < initial) issues.push('counter_reset');
  if ((counter != null && counter < 0) || samples.some((sample) => finite(sample.total_kwh) < 0)) issues.push('invalid_counter');
  // once is diagnostic only until the device's semantics and same-session association are verified.
  const once = finite(session.energy_once);
  const onceTrusted = options.onceVerified === true && options.onceAssociated === true;
  const systemReliable = samples.length > 1 && !issues.includes('incomplete_coverage') && !issues.includes('missing_samples') && !issues.includes('invalid_power');
  const references = [systemReliable ? system : null, counter, onceTrusted ? once : null].filter((n) => n != null);
  const all = [systemReliable ? system : null, counter, once].filter((n) => n != null && n >= 0);
  const differs = (a, b) => Math.abs(a - b) > Math.max(absolute, Math.max(a, b) * relative);
  const disagreement = all.some((a, i) => all.slice(i + 1).some((b) => differs(a, b)));
  let status = disagreement ? 'divergent' : references.length >= 2 && issues.length === 0 ? 'validated' : 'inconclusive';
  if (issues.includes('counter_reset')) status = 'inconclusive';
  const energy = status === 'validated' ? counter ?? system : null;
  return { status, system_kwh: samples.length > 1 ? round(system) : null, counter_kwh: round(counter), once_kwh: once, once_trusted: onceTrusted, reconciled_kwh: round(energy), charging_seconds: chargingSeconds, covered_seconds: covered, sample_count: samples.length, issues: [...new Set(issues)], end_time_uncertain: !session.end_time, tolerance: { absolute, relative } };
}

function billingReady(session, result = session.reconciliation) {
  const price = finite(session.price_override ?? session.price_calculated);
  return session.status === 'done' && result?.status === 'validated' && finite(result.reconciled_kwh) != null && result.reconciled_kwh >= 0 && (session.client_id != null || session.user_id != null) && price != null && price >= 0;
}
module.exports = { reconcile, billingReady };
