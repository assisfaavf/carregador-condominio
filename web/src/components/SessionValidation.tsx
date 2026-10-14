import { useState } from 'react'
import { apiFetch } from '../api/client'

export type EnergyReconciliation = {
  status: string; system_kwh?: number | null; counter_kwh?: number | null; once_kwh?: number | null
  reconciled_kwh?: number | null; once_trusted?: boolean; issues?: string[]; end_time_uncertain?: boolean
  charging_seconds?: number; sample_count?: number
}
export type ValidatedSession = { id: number; status: string | null; client_id: number | null; user_id: number | null; reconciliation?: EnergyReconciliation | null; billing_ready?: boolean }
type Client = { id: number; name: string; tower?: string; apartment?: string }
const labels: Record<string, string> = { validated: 'Validada', divergent: 'Divergente — revisão necessária', inconclusive: 'Inconclusiva — revisão necessária', pending: 'Validação pendente' }
const issueLabels: Record<string, string> = { counter_reset: 'Contador reiniciado', missing_samples: 'Lacunas nas leituras', invalid_power: 'Potência indisponível ou inválida', incomplete_coverage: 'Monitoramento incompleto' }
const kwh = (n?: number | null) => n == null ? 'Indisponível' : `${n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kWh`
export function SessionValidation({ session, onUpdated }: { session: ValidatedSession; onUpdated: (value: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(false)
  const [clients, setClients] = useState<Client[]>([])
  const [client, setClient] = useState(String(session.client_id ?? ''))
  const [energy, setEnergy] = useState('')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [audit, setAudit] = useState<Array<{ created_at: string; reason: string; actor_id: number | null }>>([])
  const result = session.reconciliation
  const field = 'rounded-lg border border-slate-300 bg-slate-50 p-2 text-sm dark:border-white/30 dark:bg-slate-800 dark:text-white'
  async function expand() {
    setOpen(!open)
    if (open) return
    try {
      const [list, detail] = await Promise.all([
        apiFetch<{ clients: Client[] }>('/api/admin/charging-clients'),
        apiFetch<{ revisions: typeof audit }>(`/api/admin/sessions/${session.id}/energy`),
      ])
      setClients(list.clients); setAudit(detail.revisions)
    } catch { setMessage('Não foi possível carregar clientes ou auditoria.') }
  }
  async function save(action: 'link' | 'validate' | 'reconcile') {
    setBusy(true); setMessage('')
    try {
      const response = await apiFetch<{ session: Record<string, unknown> }>(`/api/admin/sessions/${session.id}${action === 'link' ? '' : '/validate'}`, {
        method: action === 'link' ? 'PATCH' : 'POST',
        body: action === 'link' ? { client_id: client ? Number(client) : null, reason: reason || 'Vínculo do responsável.' }
          : action === 'reconcile' ? { action: 'reconcile' } : { energy_kwh: energy.trim().replace(',', '.'), reason },
      })
      onUpdated(response.session); setMessage('Atualização registrada.')
      const detail = await apiFetch<{ revisions: typeof audit }>(`/api/admin/sessions/${session.id}/energy`)
      setAudit(detail.revisions)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Falha ao salvar.') }
    finally { setBusy(false) }
  }
  return <section className="mt-3 rounded-xl border border-primary/30 p-3 text-sm">
    <div className="flex flex-wrap items-center gap-3"><span>{result ? labels[result.status] || 'Validação pendente' : 'Histórico anterior — revisão necessária'}</span><span>{session.billing_ready ? 'Pronta para cobrança' : session.client_id == null && session.user_id == null ? 'Aguardando cliente' : 'Cobrança pendente de validação'}</span><button className="text-primary underline" type="button" onClick={() => void expand()}>{open ? 'Fechar revisão' : 'Revisar consumo / vincular cliente'}</button></div>
    {open ? <div className="mt-3 space-y-3">
      <table className="w-full text-left"><thead><tr><th>Fonte</th><th>Consumo</th></tr></thead><tbody>
        <tr><td>Sistema (amostras observadas)</td><td>{kwh(result?.system_kwh)}</td></tr>
        <tr><td>Contador do carregador</td><td>{kwh(result?.counter_kwh)}</td></tr>
        <tr><td>charge_energy_once {result?.once_trusted ? '' : '(associação não confirmada)'}</td><td>{kwh(result?.once_kwh)}</td></tr>
        <tr><td>Consumo conciliado</td><td>{kwh(result?.reconciled_kwh)}</td></tr>
      </tbody></table>
      {result?.end_time_uncertain ? <p>Horário real de término não confirmado.</p> : null}
      <p>{(result?.issues || []).map((issue) => issueLabels[issue] || issue).join(' • ')}</p>
      <p>Tempo efetivamente carregando observado: {Math.round((result?.charging_seconds || 0) / 60)} min. Amostras: {result?.sample_count ?? 0}.</p>
      <div className="flex flex-wrap gap-2"><select aria-label="Cliente responsável" className={field} value={client} onChange={(e) => setClient(e.target.value)}><option value="">Sem cliente</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.tower}/{c.apartment}</option>)}</select><button disabled={busy} type="button" className="text-primary" onClick={() => void save('link')}>{session.client_id ? 'Alterar cliente' : 'Vincular cliente'}</button></div>
      {session.status === 'done' ? <><div className="flex flex-wrap gap-2"><input aria-label="Consumo revisado em kWh" className={field} placeholder="Consumo revisado (kWh)" inputMode="decimal" value={energy} onChange={(e) => setEnergy(e.target.value)} /><input aria-label="Justificativa da revisão" className={field} placeholder="Justificativa obrigatória" value={reason} onChange={(e) => setReason(e.target.value)} /><button disabled={busy || !energy.trim() || !reason.trim()} className="text-primary" type="button" onClick={() => void save('validate')}>Confirmar validação</button><button disabled={busy} className="text-primary" type="button" onClick={() => void save('reconcile')}>Reconciliar leituras</button></div></> : null}
      {message ? <p role="status">{message}</p> : null}
      <details><summary>Auditoria das revisões</summary>{audit.map((entry, i) => <p key={i}>{new Date(entry.created_at).toLocaleString('pt-BR')} — {entry.actor_id ? `Administrador #${entry.actor_id}` : 'Sistema'}: {entry.reason}</p>)}</details>
    </div> : null}
  </section>
}
