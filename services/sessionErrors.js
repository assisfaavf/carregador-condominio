const ERROR_SESSION_FILTER = "(s.status = 'failed' OR s.reconciliation->>'status' IN ('divergent', 'inconclusive'))";
const diagnostics = {
  counter_reset: 'O contador de energia foi reiniciado durante a sessão.',
  missing_samples: 'Há intervalos sem leituras de energia.',
  invalid_power: 'A potência registrada está ausente ou fora da faixa esperada.',
  incomplete_coverage: 'As leituras não cobrem todo o período da sessão.',
  invalid_counter: 'Foram encontrados valores inválidos no contador de energia.',
  sample_limit: 'A sessão excedeu o limite de amostras para conciliação automática.',
};

function sessionErrors(session) {
  const errors = [];
  if (session.status === 'failed') {
    errors.push({ code: 'charging_failed', title: 'Falha no início do carregamento', detail: typeof session.notes === 'string' && session.notes.trim() ? session.notes.trim() : 'Não foi possível confirmar o início da recarga.' });
  }
  const validation = session.reconciliation;
  if (!['divergent', 'inconclusive'].includes(validation?.status)) return errors;
  errors.push(validation.status === 'divergent'
    ? { code: 'energy_divergence', title: 'Divergência no consumo', detail: 'As medições de energia apresentam diferenças acima da tolerância configurada.' }
    : { code: 'energy_inconclusive', title: 'Dados de energia insuficientes', detail: 'Não há evidências suficientes para confirmar automaticamente o consumo.' });
  for (const code of new Set(Array.isArray(validation.issues) ? validation.issues : [])) {
    if (typeof code === 'string' && Object.hasOwn(diagnostics, code)) errors.push({ code, title: 'Diagnóstico da energia', detail: diagnostics[code] });
  }
  return errors;
}

module.exports = { sessionErrors, ERROR_SESSION_FILTER };
