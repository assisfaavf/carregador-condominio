const nonNegative = (value) => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

// Display existing evidence without changing historical records or approving billing.
function sessionPresentation(session) {
  const validation = session.reconciliation;
  const initial = nonNegative(session.start_energy_total);
  const final = nonNegative(session.end_energy_total);
  const counter = initial != null && final != null && final >= initial ? Math.round((final - initial) * 1000) / 1000 : null;
  const recorded = nonNegative(session.energy_kwh);
  const energy = nonNegative(validation?.reconciled_kwh) ?? nonNegative(validation?.proposed_kwh)
    ?? recorded ?? counter ?? nonNegative(validation?.system_kwh)
    ?? (!validation ? nonNegative(session.energy_once) : null);
  const reconciliation = {
    ...(validation || { status: 'legacy', end_time_uncertain: !session.end_time }),
    recorded_kwh: recorded,
    counter_kwh: validation?.counter_kwh ?? counter,
    once_kwh: validation?.once_kwh ?? nonNegative(session.energy_once),
    proposed_kwh: energy,
  };
  return {
    energy_kwh: energy,
    price_calculated: nonNegative(session.price_calculated)
      ?? (energy != null && nonNegative(session.tariff_per_kwh) != null ? Math.round(energy * Number(session.tariff_per_kwh) * 100) / 100 : null),
    price_override: nonNegative(session.price_override),
    reconciliation,
  };
}
module.exports = { sessionPresentation };
