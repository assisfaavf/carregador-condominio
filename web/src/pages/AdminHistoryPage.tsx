import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, apiFetch } from '../api/client'

const PAGE_SIZE = 20
const PAYMENT_OPTIONS = [
  ['pendente', 'Pendente'],
  ['pago', 'Pago'],
  ['cortesia', 'Cortesia'],
  ['n/a', 'N/A'],
] as const

type PaymentStatus = (typeof PAYMENT_OPTIONS)[number][0]
type SavingField = 'payment_status' | 'price_override'
type AdminStation = { id: number; name: string; location_label: string | null; is_active: boolean }
type AdminSession = {
  id: number
  user_id: number | null
  station_id: number | null
  start_time: string | null
  end_time: string | null
  duration_seconds: number | null
  status: string | null
  energy_kwh: number | null
  tariff_per_kwh: number | null
  price_calculated: number | null
  price_override: number | null
  payment_status: string | null
  notes: string | null
  needs_review: boolean
  user_name: string | null
  user_email: string | null
  station_name: string | null
  address_label: string | null
}
type SessionsResponse = { success: boolean; limit: number; offset: number; sessions: AdminSession[] }
type StationsResponse = { success: boolean; stations: AdminStation[] }
type PatchResponse = { success: boolean; session: AdminSession }
type RowDraft = { payment_status: PaymentStatus; price_override_input: string }

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.message.trim()) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function formatDateTime(value: string | null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function formatDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${Math.max(minutes, 1)} min`
}

function formatKwh(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} kWh`
}

function formatMoney(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function displayText(value: string | null | undefined, fallback = '—') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

function effectivePrice(session: AdminSession) {
  return session.price_override ?? session.price_calculated
}

function rowDraft(session: AdminSession): RowDraft {
  const payment = PAYMENT_OPTIONS.some(([value]) => value === session.payment_status)
    ? (session.payment_status as PaymentStatus)
    : 'pendente'
  return {
    payment_status: payment,
    price_override_input:
      session.price_override == null
        ? ''
        : session.price_override.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }
}

function parsePrice(raw: string): number | null | 'invalid' {
  const text = raw.trim()
  if (!text) return null
  let normalized = text.replace(/\s+/g, '')
  if (normalized.includes(',') && normalized.includes('.')) normalized = normalized.replace(/\./g, '').replace(',', '.')
  else if (normalized.includes(',')) normalized = normalized.replace(',', '.')
  const value = Number(normalized)
  if (!Number.isFinite(value) || value < 0) return 'invalid'
  return value
}

function paymentBadge(status: string | null) {
  if (status === 'pago') return 'bg-primary/15 text-primary ring-primary/20'
  if (status === 'pendente') return 'bg-amber-500/15 text-amber-300 ring-amber-400/20'
  if (status === 'cortesia') return 'bg-sky-500/15 text-sky-300 ring-sky-400/20'
  return 'bg-slate-500/15 text-slate-300 ring-slate-400/20'
}

function paymentLabel(status: string | null) {
  return PAYMENT_OPTIONS.find(([value]) => value === status)?.[1] ?? 'N/A'
}

function sessionBadge(status: string | null) {
  if (status === 'done') return ['Concluida', 'bg-green-500/10 text-green-400', 'ev_station'] as const
  if (status === 'running') return ['Running', 'bg-blue-500/10 text-blue-300', 'bolt'] as const
  if (status === 'failed') return ['Falha', 'bg-red-500/10 text-red-400', 'error'] as const
  return [status || 'Sessão', 'bg-slate-500/10 text-slate-300', 'history'] as const
}

export default function AdminHistoryPage() {
  const [stations, setStations] = useState<AdminStation[]>([])
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [stationId, setStationId] = useState('')
  const [paymentStatus, setPaymentStatus] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [loadingInitial, setLoadingInitial] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<number, RowDraft>>({})
  const [saving, setSaving] = useState<Record<number, SavingField | undefined>>({})
  const [rowErrors, setRowErrors] = useState<Record<number, string | null>>({})
  const requestIdRef = useRef(0)

  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions])
  const visibleSessions = useMemo(() => {
    const text = search.trim().toLowerCase()
    if (!text) return sessions
    return sessions.filter((session) =>
      [session.user_name, session.user_email, session.station_name, session.address_label, String(session.id)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(text),
    )
  }, [search, sessions])
  const summary = useMemo(
    () =>
      visibleSessions.reduce(
        (acc, session) => ({
          energy: acc.energy + (session.energy_kwh ?? 0),
          value: acc.value + (effectivePrice(session) ?? 0),
        }),
        { energy: 0, value: 0 },
      ),
    [visibleSessions],
  )

  const fetchSessions = useCallback(
    async (targetOffset: number, append: boolean) => {
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      append ? setLoadingMore(true) : setLoadingInitial(true)
      setErrorMessage(null)
      if (!append) setRowErrors({})

      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(targetOffset) })
        if (stationId) params.set('station_id', stationId)
        if (paymentStatus) params.set('payment_status', paymentStatus)
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo) params.set('date_to', dateTo)
        const response = await apiFetch<SessionsResponse>(`/api/admin/sessions?${params.toString()}`)
        if (requestId !== requestIdRef.current) return
        const page = Array.isArray(response.sessions) ? response.sessions : []
        setSessions((current) => (append ? [...current, ...page] : page))
        setDrafts((current) => {
          const next = append ? { ...current } : {}
          page.forEach((session) => {
            next[session.id] = rowDraft(session)
          })
          return next
        })
        setOffset(targetOffset + page.length)
        setHasMore(page.length === PAGE_SIZE)
      } catch (error) {
        if (requestId !== requestIdRef.current) return
        setErrorMessage(getErrorMessage(error, 'Nao foi possivel carregar o historico global.'))
      } finally {
        if (requestId !== requestIdRef.current) return
        append ? setLoadingMore(false) : setLoadingInitial(false)
      }
    },
    [dateFrom, dateTo, paymentStatus, stationId],
  )

  useEffect(() => {
    void apiFetch<StationsResponse>('/api/admin/stations')
      .then((response) => {
        setStations(Array.isArray(response.stations) ? response.stations : [])
      })
      .catch((error: unknown) => {
        setErrorMessage(getErrorMessage(error, 'Nao foi possivel carregar as estacoes.'))
      })
  }, [])

  useEffect(() => {
    void fetchSessions(0, false)
  }, [fetchSessions])

  const patchSession = useCallback((id: number, patch: Partial<AdminSession>) => {
    setSessions((current) => current.map((session) => (session.id === id ? { ...session, ...patch } : session)))
  }, [])

  const updateDraft = useCallback(
    (id: number, patch: Partial<RowDraft>) => {
      const session = sessionsById.get(id)
      if (!session) return
      setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? rowDraft(session)), ...patch } }))
    },
    [sessionsById],
  )

  const savePayment = useCallback(
    async (id: number, nextStatus: PaymentStatus) => {
      const previous = sessionsById.get(id)
      if (!previous) return
      updateDraft(id, { payment_status: nextStatus })
      setRowErrors((current) => ({ ...current, [id]: null }))
      setSaving((current) => ({ ...current, [id]: 'payment_status' }))
      patchSession(id, { payment_status: nextStatus })
      try {
        const response = await apiFetch<PatchResponse>(`/api/admin/sessions/${id}`, {
          method: 'PATCH',
          body: { payment_status: nextStatus },
        })
        const merged = { ...previous, ...(response.session ?? {}), payment_status: nextStatus }
        if (paymentStatus && paymentStatus !== nextStatus) {
          setSessions((current) => current.filter((session) => session.id !== id))
          setDrafts((current) => {
            const next = { ...current }
            delete next[id]
            return next
          })
        } else {
          patchSession(id, merged)
          setDrafts((current) => ({ ...current, [id]: rowDraft(merged) }))
        }
      } catch (error) {
        patchSession(id, previous)
        setDrafts((current) => ({ ...current, [id]: rowDraft(previous) }))
        setRowErrors((current) => ({ ...current, [id]: getErrorMessage(error, 'Falha ao atualizar pagamento.') }))
      } finally {
        setSaving((current) => ({ ...current, [id]: undefined }))
      }
    },
    [patchSession, paymentStatus, sessionsById, updateDraft],
  )

  const savePrice = useCallback(
    async (id: number) => {
      const session = sessionsById.get(id)
      const draft = drafts[id]
      if (!session || !draft) return
      const parsed = parsePrice(draft.price_override_input)
      if (parsed === 'invalid') {
        setRowErrors((current) => ({ ...current, [id]: 'Valor invalido. Use numero >= 0 ou deixe vazio.' }))
        return
      }
      setRowErrors((current) => ({ ...current, [id]: null }))
      setSaving((current) => ({ ...current, [id]: 'price_override' }))
      try {
        const response = await apiFetch<PatchResponse>(`/api/admin/sessions/${id}`, {
          method: 'PATCH',
          body: { price_override: parsed },
        })
        const merged = { ...session, ...(response.session ?? {}), price_override: parsed }
        patchSession(id, merged)
        setDrafts((current) => ({ ...current, [id]: rowDraft(merged) }))
      } catch (error) {
        setRowErrors((current) => ({ ...current, [id]: getErrorMessage(error, 'Falha ao salvar valor.') }))
      } finally {
        setSaving((current) => ({ ...current, [id]: undefined }))
      }
    },
    [drafts, patchSession, sessionsById],
  )

  return (
    <div className="bg-background-light font-display text-slate-900 antialiased dark:bg-background-dark dark:text-slate-100">
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-28 pt-6">
        {errorMessage ? <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{errorMessage}</div> : null}

        <section className="space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Histórico Global</h1>
              <p className="text-sm text-slate-500 dark:text-text-secondary">Sessões recentes com ajuste rápido de pagamento e valor.</p>
            </div>
            <div className="text-xs text-slate-500 dark:text-text-secondary">Carregadas: {sessions.length}</div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-white/5 dark:bg-surface-dark">
            <div className="flex h-12 items-center rounded-xl bg-slate-100 px-4 focus-within:ring-2 focus-within:ring-primary/50 dark:bg-background-dark">
              <span className="material-symbols-outlined text-slate-500 dark:text-text-secondary">search</span>
              <input className="flex-1 border-none bg-transparent px-3 text-sm font-medium outline-none placeholder:text-slate-500 dark:text-white" onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por usuário, estação ou unidade" value={search} />
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <select className="h-11 rounded-full bg-slate-100 px-4 text-sm font-medium outline-none dark:bg-background-dark dark:text-white" onChange={(event) => setStationId(event.target.value)} value={stationId}>
                <option value="">Todas as estações</option>
                {stations.map((station) => <option key={station.id} value={String(station.id)}>{station.name}</option>)}
              </select>
              <select className="h-11 rounded-full bg-slate-100 px-4 text-sm font-medium outline-none dark:bg-background-dark dark:text-white" onChange={(event) => setPaymentStatus(event.target.value)} value={paymentStatus}>
                <option value="">Todos os pagamentos</option>
                {PAYMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <input className="h-11 rounded-full bg-slate-100 px-4 text-sm font-medium outline-none dark:bg-background-dark dark:text-white" onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} />
              <input className="h-11 rounded-full bg-slate-100 px-4 text-sm font-medium outline-none dark:bg-background-dark dark:text-white" onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/5 dark:bg-surface-dark"><p className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-text-secondary">Sessões visíveis</p><p className="mt-2 text-2xl font-bold">{visibleSessions.length}</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/5 dark:bg-surface-dark"><p className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-text-secondary">Energia</p><p className="mt-2 text-2xl font-bold text-primary">{formatKwh(summary.energy)}</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/5 dark:bg-surface-dark"><p className="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-text-secondary">Valor exibido</p><p className="mt-2 text-2xl font-bold">{formatMoney(summary.value)}</p></div>
          </div>
        </section>

        {loadingInitial ? <section className="space-y-4">{[1, 2, 3].map((item) => <div className="animate-pulse rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-white/5 dark:bg-surface-dark" key={item}><div className="h-5 w-1/3 rounded bg-slate-200 dark:bg-white/10" /><div className="mt-4 grid gap-3 md:grid-cols-4">{[1, 2, 3, 4].map((cell) => <div className="h-16 rounded-xl bg-slate-100 dark:bg-white/5" key={cell} />)}</div></div>)}</section> : null}

        {!loadingInitial && !errorMessage && visibleSessions.length === 0 ? <section className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-white/5 dark:bg-surface-dark"><p className="text-base font-semibold">Nenhuma sessão encontrada</p><p className="mt-1 text-sm text-slate-500 dark:text-text-secondary">Ajuste os filtros ou carregue mais sessões.</p></section> : null}

        {visibleSessions.length > 0 ? (
          <section className="space-y-4">
            {visibleSessions.map((session) => {
              const [statusLabel, statusClass, statusIcon] = sessionBadge(session.status)
              const draft = drafts[session.id] ?? rowDraft(session)
              const savingField = saving[session.id]
              return (
                <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-primary/30 dark:border-white/5 dark:bg-surface-dark" key={session.id}>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-primary"><span className="material-symbols-outlined">{statusIcon}</span></div>
                      <div>
                        <h3 className="text-base font-bold">{session.station_name ?? `Estação #${session.station_id ?? session.id}`}</h3>
                        <p className="text-xs text-slate-500 dark:text-text-secondary">Sessão #{session.id}{session.address_label ? ` • ${session.address_label}` : ''}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] ${statusClass}`}>{statusLabel}</span>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] ring-1 ring-inset ${paymentBadge(session.payment_status)}`}>{paymentLabel(session.payment_status)}</span>
                      {session.needs_review ? <span className="rounded-full bg-red-500/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-red-400">Revisar</span> : null}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-background-dark"><p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 dark:text-text-secondary">Data/hora</p><p className="mt-2 text-sm font-semibold">{formatDateTime(session.start_time)}</p><p className="mt-1 text-xs text-slate-500 dark:text-text-secondary">Duracao: {formatDuration(session.duration_seconds)}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-background-dark"><p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 dark:text-text-secondary">Usuário</p><p className="mt-2 text-sm font-semibold">{displayText(session.user_name)}</p>{session.user_email && session.user_email.trim() ? <p className="mt-1 text-xs text-slate-500 dark:text-text-secondary">{session.user_email}</p> : null}</div>
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-background-dark"><p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 dark:text-text-secondary">Estação</p><p className="mt-2 text-sm font-semibold">{session.station_name ?? 'Sem estação'}</p><p className="mt-1 text-xs text-slate-500 dark:text-text-secondary">{session.address_label ?? 'Unidade não informada'}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-background-dark"><p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 dark:text-text-secondary">Energia</p><p className="mt-2 text-sm font-semibold">{formatKwh(session.energy_kwh)}</p><p className="mt-1 text-xs text-slate-500 dark:text-text-secondary">Tarifa: {formatMoney(session.tariff_per_kwh)}</p></div>
                    <div className="rounded-xl bg-slate-50 p-3 dark:bg-background-dark"><p className="text-[10px] uppercase tracking-[0.18em] text-slate-400 dark:text-text-secondary">Valor</p><p className="mt-2 text-sm font-semibold">{formatMoney(effectivePrice(session))}</p><p className="mt-1 text-xs text-slate-500 dark:text-text-secondary">{session.price_override != null ? 'Usando ajuste manual' : 'Usando valor calculado'}</p></div>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,220px)_minmax(0,220px)_auto] lg:items-end">
                    <div><p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-slate-400 dark:text-text-secondary">Pagamento</p><select className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 dark:border-white/10 dark:bg-background-dark dark:text-white" disabled={savingField != null} onChange={(event) => void savePayment(session.id, event.target.value as PaymentStatus)} value={draft.payment_status}>{PAYMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
                    <div><p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-slate-400 dark:text-text-secondary">Price override</p><input className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 dark:border-white/10 dark:bg-background-dark dark:text-white" disabled={savingField === 'price_override'} inputMode="decimal" onChange={(event) => { updateDraft(session.id, { price_override_input: event.target.value }); setRowErrors((current) => ({ ...current, [session.id]: null })) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void savePrice(session.id) } }} placeholder="Vazio para limpar" value={draft.price_override_input} /></div>
                    <button className="h-11 rounded-xl bg-primary px-5 text-sm font-semibold text-background-dark transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70" disabled={savingField != null} onClick={() => void savePrice(session.id)} type="button">{savingField === 'price_override' ? 'Salvando...' : 'Salvar valor'}</button>
                  </div>

                  <div className="mt-3 flex flex-col gap-2 text-xs md:flex-row md:items-center md:justify-between">
                    <div className="text-slate-500 dark:text-text-secondary">{savingField ? 'Salvando alteracoes da linha...' : `Fim: ${formatDateTime(session.end_time)}`}</div>
                    {rowErrors[session.id] ? <div className="font-medium text-red-400">{rowErrors[session.id]}</div> : session.notes ? <div className="text-slate-500 dark:text-text-secondary">{session.notes}</div> : null}
                  </div>
                </article>
              )
            })}
          </section>
        ) : null}

        {!loadingInitial && hasMore ? <button className="h-12 w-full rounded-xl border border-primary/30 bg-primary/10 text-sm font-bold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-70" disabled={loadingMore} onClick={() => void fetchSessions(offset, true)} type="button">{loadingMore ? 'Carregando...' : 'Carregar mais'}</button> : null}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-secondary bg-surface-dark px-4 pb-6 pt-3">
        <div className="mx-auto flex w-full max-w-6xl justify-between items-end">
          <Link className="group flex flex-1 flex-col items-center justify-end gap-1 text-slate-400 transition-colors hover:text-slate-200" to="/admin/dashboard"><div className="flex h-7 items-center justify-center transition-transform group-active:scale-95"><span className="material-symbols-outlined text-[26px]">monitoring</span></div><p className="text-[10px] font-medium tracking-[0.015em]">Dashboard</p></Link>
          <Link className="group flex flex-1 flex-col items-center justify-end gap-1 text-primary" to="/admin/history"><div className="flex h-7 items-center justify-center rounded-2xl bg-primary/20 px-4 transition-transform group-active:scale-95"><span className="material-symbols-outlined text-[26px]" style={{ fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}>history</span></div><p className="text-[10px] font-medium tracking-[0.015em]">Histórico</p></Link>
          <Link className="group flex flex-1 flex-col items-center justify-end gap-1 text-slate-400 transition-colors hover:text-slate-200" to="/admin/users"><div className="flex h-7 items-center justify-center transition-transform group-active:scale-95"><span className="material-symbols-outlined text-[26px]">group</span></div><p className="text-[10px] font-medium tracking-[0.015em]">Usuários</p></Link>
          <Link className="group flex flex-1 flex-col items-center justify-end gap-1 text-slate-400 transition-colors hover:text-slate-200" to="/admin/settings"><div className="flex h-7 items-center justify-center transition-transform group-active:scale-95"><span className="material-symbols-outlined text-[26px]">settings</span></div><p className="text-[10px] font-medium tracking-[0.015em]">Configurações</p></Link>
        </div>
      </nav>
    </div>
  )
}
