import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, apiFetch } from '../api/client'
import { useAuth } from '../auth/AuthProvider'

const PAGE_SIZE = 100

type ApiSession = {
  id: number
  start_time: string | null
  end_time: string | null
  duration_seconds: number | null
  energy_kwh: number | null
  energy_once: number | null
  price_calculated: number | null
  price_override: number | null
  payment_status: string | null
  station_id: number | null
  station_name: string | null
  station_location_label: string | null
  address_id: number | null
  address_label: string | null
}

type MySessionsResponse = {
  success: boolean
  limit: number
  offset: number
  sessions: ApiSession[]
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.message.trim()) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Nao foi possivel carregar seu historico.'
}

function formatDateTime(value: string | null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--:--'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':')
}

function formatKwh(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${value.toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  })} kWh`
}

function formatCurrency(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function getCurrentMonthValue() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getMonthRange(monthValue: string) {
  const [yearText, monthText] = monthValue.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return getMonthRange(getCurrentMonthValue())
  }

  const lastDay = new Date(year, month, 0).getDate()
  return {
    dateFrom: `${yearText}-${monthText}-01`,
    dateTo: `${yearText}-${monthText}-${String(lastDay).padStart(2, '0')}`,
  }
}

function formatMonthLabel(monthValue: string) {
  const [yearText, monthText] = monthValue.split('-')
  const date = new Date(Number(yearText), Number(monthText) - 1, 1)
  if (Number.isNaN(date.getTime())) return 'mes selecionado'
  return date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
}

function getEffectiveKwh(session: ApiSession) {
  return session.energy_kwh ?? session.energy_once
}

function getEffectivePrice(session: ApiSession) {
  return session.price_override ?? session.price_calculated
}

function getPaymentBadge(status: string | null) {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'pago') {
    return {
      label: 'Pago',
      className: 'bg-primary/20 text-primary',
    }
  }
  if (normalized === 'pendente') {
    return {
      label: 'Pendente',
      className: 'bg-amber-500/20 text-amber-300',
    }
  }
  if (normalized === 'cortesia') {
    return {
      label: 'Cortesia',
      className: 'bg-sky-500/20 text-sky-300',
    }
  }
  return {
    label: 'N/A',
    className: 'bg-slate-600/40 text-slate-300',
  }
}

function summarizeBySessions(sessions: ApiSession[]) {
  return sessions.reduce(
    (acc, session) => {
      const energy = getEffectiveKwh(session)
      const price = getEffectivePrice(session)
      const duration = session.duration_seconds
      const paymentStatus = String(session.payment_status || '').trim().toLowerCase()
      const addressKey = session.address_id != null
        ? String(session.address_id)
        : String(session.address_label || '').trim()
      return {
        totalKwh: acc.totalKwh + (energy != null ? energy : 0),
        totalValue: acc.totalValue + (price != null ? price : 0),
        totalSeconds: acc.totalSeconds + (duration != null && Number.isFinite(duration) ? duration : 0),
        paidCount: acc.paidCount + (paymentStatus === 'pago' ? 1 : 0),
        pendingCount: acc.pendingCount + (paymentStatus === 'pendente' ? 1 : 0),
        courtesyCount: acc.courtesyCount + (paymentStatus === 'cortesia' ? 1 : 0),
        addressKeys: addressKey ? acc.addressKeys.add(addressKey) : acc.addressKeys,
      }
    },
    {
      totalKwh: 0,
      totalValue: 0,
      totalSeconds: 0,
      paidCount: 0,
      pendingCount: 0,
      courtesyCount: 0,
      addressKeys: new Set<string>(),
    },
  )
}

export default function UserHistoryPage() {
  const { user } = useAuth()
  const [sessions, setSessions] = useState<ApiSession[]>([])
  const [offset, setOffset] = useState(0)
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthValue)
  const [hasMore, setHasMore] = useState(true)
  const [loadingInitial, setLoadingInitial] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const fetchPage = useCallback(async (targetOffset: number, append: boolean, monthValue = selectedMonth) => {
    if (append) {
      setLoadingMore(true)
    } else {
      setLoadingInitial(true)
    }
    setErrorMessage(null)

    try {
      const { dateFrom, dateTo } = getMonthRange(monthValue)
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(targetOffset),
        date_from: dateFrom,
        date_to: dateTo,
      })
      const response = await apiFetch<MySessionsResponse>(
        `/api/my/sessions?${params.toString()}`,
      )
      const page = response.sessions ?? []

      setSessions((previous) => (append ? [...previous, ...page] : page))
      setOffset(targetOffset + page.length)
      setHasMore(page.length === PAGE_SIZE)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      if (append) {
        setLoadingMore(false)
      } else {
        setLoadingInitial(false)
      }
    }
  }, [selectedMonth])

  useEffect(() => {
    void fetchPage(0, false, selectedMonth)
  }, [fetchPage])

  const summary = useMemo(() => summarizeBySessions(sessions), [sessions])
  const averageKwh = sessions.length > 0 ? summary.totalKwh / sessions.length : null
  const averageValue = sessions.length > 0 ? summary.totalValue / sessions.length : null
  const monthLabel = formatMonthLabel(selectedMonth)

  return (
    <div className="min-h-screen bg-background-dark font-display text-slate-100">
      <main className="mx-auto w-full max-w-md space-y-6 px-4 py-6 pb-28">
        <section className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Histórico de Carregamentos</h1>
          <p className="text-sm text-slate-300">Acompanhe suas sessões e pagamentos por mês.</p>
        </section>

        <section className="rounded-2xl border border-primary/20 bg-[#1a3523] p-4">
          <label className="flex flex-col gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Filtrar por mês</span>
            <input
              className="h-12 rounded-xl border border-primary/20 bg-slate-900/35 px-4 text-sm font-semibold text-slate-100 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
              onChange={(event) => {
                setSelectedMonth(event.target.value || getCurrentMonthValue())
              }}
              type="month"
              value={selectedMonth}
            />
          </label>
        </section>

        <section className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-primary/20 bg-[#1a3523] p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-300">Carregamentos</p>
            <p className="mt-1 text-lg font-bold text-primary">{sessions.length}</p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-[#1a3523] p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-300">Energia</p>
            <p className="mt-1 text-lg font-bold text-primary">{formatKwh(summary.totalKwh)}</p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-[#1a3523] p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-300">Valor</p>
            <p className="mt-1 text-lg font-bold text-primary">{formatCurrency(summary.totalValue)}</p>
          </div>
        </section>

        {errorMessage && sessions.length === 0 ? (
          <section className="rounded-2xl border border-danger/40 bg-danger/10 p-5">
            <p className="text-sm font-medium text-danger">{errorMessage}</p>
            <button
              className="mt-3 rounded-xl border border-danger/40 px-4 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger/10"
              onClick={() => {
                void fetchPage(0, false)
              }}
              type="button"
            >
              Tentar novamente
            </button>
          </section>
        ) : null}

        {loadingInitial ? (
          <section className="space-y-3">
            {[1, 2, 3].map((item) => (
              <div
                className="animate-pulse rounded-2xl border border-primary/10 bg-[#1a3523] p-4"
                key={`skeleton-${item}`}
              >
                <div className="h-4 w-1/2 rounded bg-primary/20" />
                <div className="mt-3 h-3 w-2/3 rounded bg-primary/15" />
                <div className="mt-2 h-3 w-1/3 rounded bg-primary/15" />
              </div>
            ))}
          </section>
        ) : null}

        {!loadingInitial && !errorMessage && sessions.length === 0 ? (
          <section className="rounded-2xl border border-primary/20 bg-[#1a3523] p-6 text-center">
            <p className="text-base font-semibold text-slate-100">Nenhuma sessao encontrada</p>
            <p className="mt-1 text-sm text-slate-300">Nao ha recargas em {monthLabel}.</p>
          </section>
        ) : null}

        {sessions.length > 0 ? (
          <section className="space-y-3">
            {sessions.map((session) => {
              const paymentBadge = getPaymentBadge(session.payment_status)
              const stationName = session.station_name ?? (session.station_id ? `Carregador ${session.station_id}` : 'Carregador')
              const addressLabel = session.address_label ?? (session.address_id ? `Unidade ${session.address_id}` : 'Unidade nao informada')

              return (
                <article
                  className="rounded-2xl border border-primary/20 bg-[#1a3523] p-4 shadow-sm"
                  key={session.id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-slate-100">#{session.id}</p>
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${paymentBadge.className}`}
                    >
                      {paymentBadge.label}
                    </span>
                  </div>

                  <p className="mt-2 text-xs text-slate-300">{formatDateTime(session.start_time)}</p>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-slate-900/35 p-2">
                      <p className="text-slate-400">Estação</p>
                      <p className="font-semibold text-slate-100">{stationName}</p>
                      {session.station_location_label ? (
                        <p className="text-[11px] text-slate-300">{session.station_location_label}</p>
                      ) : null}
                    </div>
                    <div className="rounded-lg bg-slate-900/35 p-2">
                      <p className="text-slate-400">Unidade</p>
                      <p className="font-semibold text-slate-100">{addressLabel}</p>
                    </div>
                    <div className="rounded-lg bg-slate-900/35 p-2">
                      <p className="text-slate-400">Energia</p>
                      <p className="font-semibold text-primary">{formatKwh(getEffectiveKwh(session))}</p>
                    </div>
                    <div className="rounded-lg bg-slate-900/35 p-2">
                      <p className="text-slate-400">Duracao</p>
                      <p className="font-semibold text-slate-100">{formatDuration(session.duration_seconds)}</p>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-primary/10 pt-3">
                    <p className="text-xs text-slate-400">
                      Fim: <span className="text-slate-300">{formatDateTime(session.end_time)}</span>
                    </p>
                    <p className="text-sm font-bold text-primary">{formatCurrency(getEffectivePrice(session))}</p>
                  </div>
                </article>
              )
            })}
          </section>
        ) : null}

        {errorMessage && sessions.length > 0 ? (
          <section className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3">
            <p className="text-sm text-danger">{errorMessage}</p>
            <button
              className="mt-2 text-xs font-semibold text-danger underline underline-offset-2"
              onClick={() => {
                void fetchPage(offset, true)
              }}
              type="button"
            >
              Tentar novamente
            </button>
          </section>
        ) : null}

        {!loadingInitial && hasMore ? (
          <button
            className="h-12 w-full rounded-xl border border-primary/30 bg-primary/10 text-sm font-bold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={loadingMore}
            onClick={() => {
              void fetchPage(offset, true)
            }}
            type="button"
          >
            {loadingMore ? 'Carregando...' : 'Carregar mais'}
          </button>
        ) : null}

        <section className="space-y-4 rounded-2xl border border-primary/20 bg-[#1a3523] p-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100">Dashboard do mês</h2>
            <p className="mt-1 text-sm text-slate-300">
              Resumo de {monthLabel} com os carregamentos carregados na tela.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-slate-900/35 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">Valor total</p>
              <p className="mt-1 text-lg font-bold text-primary">{formatCurrency(summary.totalValue)}</p>
            </div>
            <div className="rounded-xl bg-slate-900/35 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">Energia total</p>
              <p className="mt-1 text-lg font-bold text-primary">{formatKwh(summary.totalKwh)}</p>
            </div>
            <div className="rounded-xl bg-slate-900/35 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">Carregamentos</p>
              <p className="mt-1 text-lg font-bold text-slate-100">{sessions.length}</p>
            </div>
            <div className="rounded-xl bg-slate-900/35 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">Usuário</p>
              <p className="mt-1 truncate text-sm font-bold text-slate-100">{user?.name || '--'}</p>
            </div>
            <div className="rounded-xl bg-slate-900/35 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">Unidades usadas</p>
              <p className="mt-1 text-lg font-bold text-slate-100">{summary.addressKeys.size}</p>
            </div>
            <div className="rounded-xl bg-slate-900/35 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-400">Tempo total</p>
              <p className="mt-1 text-lg font-bold text-slate-100">{formatDuration(summary.totalSeconds)}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-primary/15 bg-primary/10 p-3 text-center">
              <p className="text-lg font-bold text-primary">{summary.paidCount}</p>
              <p className="text-[10px] uppercase tracking-wider text-slate-300">Pagos</p>
            </div>
            <div className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-3 text-center">
              <p className="text-lg font-bold text-amber-300">{summary.pendingCount}</p>
              <p className="text-[10px] uppercase tracking-wider text-slate-300">Pendentes</p>
            </div>
            <div className="rounded-xl border border-sky-400/20 bg-sky-500/10 p-3 text-center">
              <p className="text-lg font-bold text-sky-300">{summary.courtesyCount}</p>
              <p className="text-[10px] uppercase tracking-wider text-slate-300">Cortesias</p>
            </div>
          </div>

          <div className="rounded-xl border border-primary/10 bg-slate-900/30 p-3 text-sm text-slate-300">
            <div className="flex items-center justify-between gap-3">
              <span>Média por carregamento</span>
              <strong className="text-primary">{formatKwh(averageKwh)}</strong>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span>Ticket médio</span>
              <strong className="text-primary">{formatCurrency(averageValue)}</strong>
            </div>
          </div>
        </section>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 border-t border-primary/20 bg-slate-900 px-4 pb-6 pt-2">
        <div className="mx-auto flex w-full max-w-md items-center justify-around">
          <Link
            className="flex flex-col items-center gap-1 p-2 text-slate-400 transition-colors hover:text-primary"
            to="/app/home"
          >
            <span className="material-symbols-outlined">home</span>
            <span className="text-[10px] font-bold uppercase tracking-wider">Início</span>
          </Link>
          <Link className="flex flex-col items-center gap-1 p-2 text-primary" to="/app/history">
            <span className="material-symbols-outlined active-icon">history</span>
            <span className="text-[10px] font-bold uppercase tracking-wider">Histórico</span>
          </Link>
          <Link
            className="flex flex-col items-center gap-1 p-2 text-slate-400 transition-colors hover:text-primary"
            to="/app/profile"
          >
            <span className="material-symbols-outlined">person</span>
            <span className="text-[10px] font-bold uppercase tracking-wider">Perfil</span>
          </Link>
          <Link
            className="flex flex-col items-center gap-1 p-2 text-slate-400 transition-colors hover:text-primary"
            to="/app/support"
          >
            <span className="material-symbols-outlined">support_agent</span>
            <span className="text-[10px] font-bold uppercase tracking-wider">Suporte</span>
          </Link>
        </div>
      </nav>
    </div>
  )
}
