import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, apiFetch } from '../api/client'
import AdminStartModal from '../components/AdminStartModal'
import ConfirmModal from '../components/ConfirmModal'

const ADMIN_POLL_INTERVAL_MS = 3000

type AdminStation = {
  id: number
  name: string
  location_label: string | null
  is_active: boolean
  max_current_a: number | null
}

type AdminUser = {
  id: number
  name: string
  email: string
  is_admin?: boolean
}

type AdminAddress = {
  id: number
  label: string
  is_default: boolean
}

type CurrentSession = {
  session_id: number
  station_id: number
  user_id: number
  user_name: string | null
  user_email: string | null
  address_label: string | null
  start_time: string
  elapsed_seconds?: number | null
}

type StationsResponse = {
  success: boolean
  stations: AdminStation[]
}

type UsersResponse = {
  success: boolean
  users: AdminUser[]
}

type UserAddressesResponse = {
  success: boolean
  addresses: AdminAddress[]
}

type CurrentSessionsResponse = {
  success: boolean
  running: CurrentSession[]
}

type LiveResponse = {
  success: boolean
  telemetry_unavailable?: boolean
  telemetry_error?: string | null
  charging?: boolean
  workState?: string | null
  stateLabel?: string | null
  powerKw?: number | null
  session_active?: boolean
  session_energy_kwh?: number | null
}

type StartResponse = {
  success: boolean
  message?: string
  sessionId?: number
}

type StopResponse = {
  success: boolean
  message?: string
}

type DebugResponse = Record<string, unknown>

type SessionSummaryCard = {
  station: AdminStation
  session: CurrentSession | null
  live: LiveResponse | null
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.message.trim()) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function parseId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function formatNumber(value: number | null | undefined, unit: string, fractionDigits = 1) {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${value.toLocaleString('pt-BR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} ${unit}`
}

function formatElapsedLong(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

function calcElapsedSeconds(startTime: string | null | undefined) {
  if (!startTime) return null
  const startMs = new Date(startTime).getTime()
  if (Number.isNaN(startMs)) return null
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000))
}

function getStationShortLabel(station: AdminStation) {
  const initials = station.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return initials || `#${station.id}`
}

function getChargerStateMeta(live: LiveResponse | null) {
  if (!live || live.telemetry_unavailable) {
    return {
      label: 'Offline',
      className: 'bg-red-500/10 text-red-400 ring-red-400/20',
      accentClassName: 'text-red-400',
    }
  }

  const stateLabel = String(live.stateLabel || '').toLowerCase()
  const workState = String(live.workState || '').toLowerCase()

  if (live.charging === true || workState === 'charger_charging') {
    return {
      label: 'Charging',
      className: 'bg-green-400/10 text-green-400 ring-green-400/20',
      accentClassName: 'text-green-400',
    }
  }

  if (stateLabel.includes('finalizado') || workState === 'charger_end') {
    return {
      label: 'Finished',
      className: 'bg-yellow-400/10 text-yellow-400 ring-yellow-400/20',
      accentClassName: 'text-yellow-400',
    }
  }

  return {
    label: 'Online',
    className: 'bg-blue-400/10 text-blue-400 ring-blue-400/20',
    accentClassName: 'text-blue-400',
  }
}

function getOccupancyMeta(isOccupied: boolean) {
  if (isOccupied) {
    return {
      label: 'Ocupada',
      className: 'bg-primary/10 text-primary ring-primary/20',
    }
  }

  return {
    label: 'Livre',
    className: 'bg-slate-500/10 text-slate-300 ring-slate-400/20',
  }
}

function isStationOffline(live: LiveResponse | null) {
  return !live || live.telemetry_unavailable === true
}

export default function AdminDashboardPage() {
  const [stations, setStations] = useState<AdminStation[]>([])
  const [currentSessions, setCurrentSessions] = useState<CurrentSession[]>([])
  const [liveByStation, setLiveByStation] = useState<Record<number, LiveResponse | null>>({})
  const [users, setUsers] = useState<AdminUser[]>([])
  const [addresses, setAddresses] = useState<AdminAddress[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [startStationId, setStartStationId] = useState<number | null>(null)
  const [stopStationId, setStopStationId] = useState<number | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null)
  const [startModalError, setStartModalError] = useState<string | null>(null)
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [loadingAddresses, setLoadingAddresses] = useState(false)
  const [startingStationId, setStartingStationId] = useState<number | null>(null)
  const [stoppingStationId, setStoppingStationId] = useState<number | null>(null)
  const [debugStationId, setDebugStationId] = useState('')
  const [debugOutput, setDebugOutput] = useState('(vazio)')
  const [debugLoading, setDebugLoading] = useState(false)
  const refreshBusyRef = useRef(false)

  const activeStations = useMemo(
    () => stations.filter((station) => station.is_active === true),
    [stations],
  )

  const activeStationIdsKey = useMemo(
    () => activeStations.map((station) => station.id).join(','),
    [activeStations],
  )

  const sessionsByStation = useMemo(() => {
    const entries = currentSessions.map((session) => [session.station_id, session] as const)
    return new Map<number, CurrentSession>(entries)
  }, [currentSessions])

  const stationCards = useMemo<SessionSummaryCard[]>(
    () =>
      activeStations.map((station) => ({
        station,
        session: sessionsByStation.get(station.id) ?? null,
        live: liveByStation[station.id] ?? null,
      })),
    [activeStations, liveByStation, sessionsByStation],
  )

  const activeChargersCount = stationCards.filter((card) => card.session != null).length
  const currentPowerSumKw = stationCards.reduce((sum, card) => sum + (card.live?.powerKw ?? 0), 0)
  const sessionEnergySumKwh = stationCards.reduce(
    (sum, card) => sum + (card.live?.session_energy_kwh ?? 0),
    0,
  )

  const startStation = useMemo(
    () => (startStationId == null ? null : activeStations.find((station) => station.id === startStationId) ?? null),
    [activeStations, startStationId],
  )

  const startStationSession = useMemo(
    () => (startStationId == null ? null : sessionsByStation.get(startStationId) ?? null),
    [sessionsByStation, startStationId],
  )

  const startStationLive = useMemo(
    () => (startStationId == null ? null : liveByStation[startStationId] ?? null),
    [liveByStation, startStationId],
  )

  const stopStation = useMemo(
    () => (stopStationId == null ? null : activeStations.find((station) => station.id === stopStationId) ?? null),
    [activeStations, stopStationId],
  )

  const loadStations = useCallback(async () => {
    const response = await apiFetch<StationsResponse>('/api/admin/stations')
    const nextStations = Array.isArray(response.stations) ? response.stations : []
    setStations(nextStations)
    return nextStations
  }, [])

  const refreshDashboard = useCallback(async (stationList: AdminStation[]) => {
    if (refreshBusyRef.current) return
    refreshBusyRef.current = true

    try {
      const activeOnly = stationList.filter((station) => station.is_active === true)
      const sessionsPromise = apiFetch<CurrentSessionsResponse>('/api/admin/current-sessions')
      const livePromises = activeOnly.map(async (station) => {
        try {
          const live = await apiFetch<LiveResponse>(`/api/live?station_id=${station.id}`)
          return [station.id, live] as const
        } catch (error) {
          return [
            station.id,
            {
              success: false,
              telemetry_unavailable: true,
              telemetry_error: getErrorMessage(error, 'Falha ao consultar telemetria.'),
            } satisfies LiveResponse,
          ] as const
        }
      })

      const [sessionsResponse, liveEntries] = await Promise.all([
        sessionsPromise,
        Promise.all(livePromises),
      ])

      setCurrentSessions(Array.isArray(sessionsResponse.running) ? sessionsResponse.running : [])
      setLiveByStation(Object.fromEntries(liveEntries))
      setLastUpdatedAt(new Date().toLocaleTimeString('pt-BR'))
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Nao foi possivel atualizar o dashboard em tempo real.'))
    } finally {
      refreshBusyRef.current = false
      setIsLoading(false)
    }
  }, [])

  const reloadStationsAndDashboard = useCallback(async () => {
    const nextStations = await loadStations()
    await refreshDashboard(nextStations)
  }, [loadStations, refreshDashboard])

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true)
    try {
      const response = await apiFetch<UsersResponse>('/api/admin/users')
      setUsers(Array.isArray(response.users) ? response.users : [])
    } finally {
      setLoadingUsers(false)
    }
  }, [])

  const loadAddressesForUser = useCallback(async (userId: number) => {
    setLoadingAddresses(true)
    try {
      const response = await apiFetch<UserAddressesResponse>(`/api/admin/users/${userId}/addresses`)
      const nextAddresses = Array.isArray(response.addresses) ? response.addresses : []
      setAddresses(nextAddresses)
      const defaultAddress = nextAddresses.find((address) => address.is_default)
      setSelectedAddressId(defaultAddress?.id ?? nextAddresses[0]?.id ?? null)
    } finally {
      setLoadingAddresses(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      setIsLoading(true)
      try {
        await reloadStationsAndDashboard()
      } catch (error) {
        if (cancelled) return
        setErrorMessage(getErrorMessage(error, 'Nao foi possivel carregar as estacoes.'))
        setIsLoading(false)
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [reloadStationsAndDashboard])

  useEffect(() => {
    if (activeStations.length === 0) return

    let cancelled = false

    const runPoll = async () => {
      if (cancelled) return
      await refreshDashboard(activeStations)
    }

    const intervalId = window.setInterval(() => {
      void runPoll()
    }, ADMIN_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [activeStationIdsKey, activeStations, refreshDashboard])

  useEffect(() => {
    if (startStationId == null) return

    if (startStation == null) {
      setStartModalError('Estação não encontrada ou inativa.')
      return
    }
    if (startStationSession) {
      setStartModalError('Estação ocupada')
      return
    }
    if (isStationOffline(startStationLive)) {
      setStartModalError('Estação offline no momento.')
      return
    }

    setStartModalError((current) => (
      current === 'Estação ocupada' || current === 'Estação offline no momento.' ? null : current
    ))
  }, [startStation, startStationId, startStationLive, startStationSession])

  useEffect(() => {
    if (startStationId == null) return
    if (users.length > 0 || loadingUsers) return

    void loadUsers().catch((error: unknown) => {
      setStartModalError(getErrorMessage(error, 'Nao foi possivel carregar os usuarios.'))
    })
  }, [loadUsers, loadingUsers, startStationId, users.length])

  useEffect(() => {
    if (startStationId == null || selectedUserId == null) {
      setAddresses([])
      setSelectedAddressId(null)
      return
    }

    let cancelled = false

    const run = async () => {
      try {
        await loadAddressesForUser(selectedUserId)
      } catch (error) {
        if (cancelled) return
        setAddresses([])
        setSelectedAddressId(null)
        setStartModalError(getErrorMessage(error, 'Não foi possível carregar os endereços do usuário.'))
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [loadAddressesForUser, selectedUserId, startStationId])

  const openStartModal = useCallback((stationId: number) => {
    setStartStationId(stationId)
    setSelectedUserId(null)
    setSelectedAddressId(null)
    setAddresses([])
    setStartModalError(null)
  }, [])

  const closeStartModal = useCallback(() => {
    if (startingStationId != null) return
    setStartStationId(null)
    setSelectedUserId(null)
    setSelectedAddressId(null)
    setAddresses([])
    setStartModalError(null)
  }, [startingStationId])

  const handleUserChange = (value: string) => {
    setStartModalError(null)
    setSelectedUserId(parseId(value))
    setSelectedAddressId(null)
    setAddresses([])
  }

  const handleAddressChange = (value: string) => {
    setStartModalError(null)
    setSelectedAddressId(parseId(value))
  }

  const handleStartSubmit = useCallback(async () => {
    if (!startStation) {
      setStartModalError('Estação não encontrada ou inativa.')
      return
    }
    if (selectedUserId == null) {
      setStartModalError('Selecione um usuario valido.')
      return
    }
    if (selectedAddressId == null) {
      setStartModalError('Usuário sem endereço cadastrado/default.')
      return
    }
    if (startStationSession) {
      setStartModalError('Estação ocupada')
      return
    }
    if (isStationOffline(startStationLive)) {
      setStartModalError('Estação offline no momento.')
      return
    }

    setStartingStationId(startStation.id)
    setStartModalError(null)

    try {
      const response = await apiFetch<StartResponse>('/api/admin/start', {
        method: 'POST',
        body: {
          station_id: startStation.id,
          user_id: selectedUserId,
          address_id: selectedAddressId,
        },
      })

      setErrorMessage(response.message ?? 'Sessão iniciada (admin).')
      setStartStationId(null)
      setSelectedUserId(null)
      setSelectedAddressId(null)
      setAddresses([])
      setStartModalError(null)
      await reloadStationsAndDashboard()
    } catch (error) {
      setStartModalError(getErrorMessage(error, 'Nao foi possivel iniciar o carregamento.'))
    } finally {
      setStartingStationId(null)
    }
  }, [
    closeStartModal,
    reloadStationsAndDashboard,
    selectedAddressId,
    selectedUserId,
    startStation,
    startStationLive,
    startStationSession,
  ])

  const handleStopConfirm = useCallback(async () => {
    if (stopStationId == null) return

    setStoppingStationId(stopStationId)
    try {
      const response = await apiFetch<StopResponse>('/api/admin/stop', {
        method: 'POST',
        body: { station_id: stopStationId },
      })

      setErrorMessage(response.message ?? 'Sessão finalizada (admin).')
      setStopStationId(null)
      await reloadStationsAndDashboard()
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Nao foi possivel encerrar o carregamento.'))
    } finally {
      setStoppingStationId(null)
    }
  }, [reloadStationsAndDashboard, stopStationId])

  const writeDebugOutput = useCallback((data: unknown) => {
    setDebugOutput(JSON.stringify(data, null, 2))
  }, [])

  const loadDebugSessions = useCallback(async () => {
    setDebugLoading(true)
    try {
      const response = await apiFetch<DebugResponse>('/sessions')
      writeDebugOutput(response)
    } catch (error) {
      writeDebugOutput({ success: false, message: getErrorMessage(error, 'Falha ao carregar sessões.') })
    } finally {
      setDebugLoading(false)
    }
  }, [writeDebugOutput])

  const loadDebugTuya = useCallback(async () => {
    setDebugLoading(true)
    try {
      const params = new URLSearchParams()
      if (debugStationId) params.set('station_id', debugStationId)
      const suffix = params.toString() ? `?${params.toString()}` : ''
      const response = await apiFetch<DebugResponse>(`/tuya/status${suffix}`)
      writeDebugOutput(response)
    } catch (error) {
      writeDebugOutput({ success: false, message: getErrorMessage(error, 'Falha ao carregar status Tuya.') })
    } finally {
      setDebugLoading(false)
    }
  }, [debugStationId, writeDebugOutput])

  return (
    <div className="bg-background-light font-display text-slate-900 antialiased selection:bg-primary selection:text-background-dark dark:bg-background-dark dark:text-slate-100">
      <main className="mx-auto w-full max-w-6xl space-y-8 px-4 pb-28 pt-6">
        {errorMessage ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {errorMessage}
          </div>
        ) : null}

        <section>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold">Resumo em Tempo Real</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {lastUpdatedAt ? `Atualizado as ${lastUpdatedAt}` : 'Aguardando telemetria'}
              </p>
            </div>
            <button
              className="text-xs font-medium text-primary transition-colors hover:text-primary/80"
              onClick={() => {
                void reloadStationsAndDashboard().catch((error: unknown) => {
                  setErrorMessage(getErrorMessage(error, 'Nao foi possivel atualizar as estacoes.'))
                })
              }}
              type="button"
            >
              Atualizar agora
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4">
            <div className="relative overflow-hidden rounded-xl border border-secondary bg-surface-dark p-5 shadow-lg">
              <div className="absolute right-0 top-0 p-4 opacity-10">
                <span className="material-symbols-outlined text-6xl text-primary">ev_station</span>
              </div>
              <div className="relative z-10">
                <p className="text-sm font-medium text-slate-400">Carregadores Ativos</p>
                <div className="mt-2 flex items-end gap-3">
                  <h3 className="text-3xl font-bold text-white">
                    {activeChargersCount}{' '}
                    <span className="text-base font-normal text-slate-400">/ {activeStations.length}</span>
                  </h3>
                  <span className="mb-1 flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-sm font-medium text-primary">
                    <span className="material-symbols-outlined mr-1 text-[16px]">bolt</span>
                    {activeStations.length > 0
                      ? `${Math.round((activeChargersCount / activeStations.length) * 100)}%`
                      : '0%'}
                  </span>
                </div>
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-secondary/50">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width:
                        activeStations.length > 0
                          ? `${(activeChargersCount / activeStations.length) * 100}%`
                          : '0%',
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col justify-between rounded-xl border border-secondary bg-surface-dark p-4 shadow-lg">
                <div className="mb-2 flex items-start justify-between">
                  <div className="rounded-lg bg-blue-500/20 p-2 text-blue-400">
                    <span className="material-symbols-outlined text-xl">bolt</span>
                  </div>
                  <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-400">
                    tempo real
                  </span>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-400">Consumo Atual</p>
                  <h3 className="mt-1 text-xl font-bold text-white">
                    {formatNumber(currentPowerSumKw, 'kW', 1)}
                  </h3>
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-xl border border-secondary bg-surface-dark p-4 shadow-lg">
                <div className="mb-2 flex items-start justify-between">
                  <div className="rounded-lg bg-primary/20 p-2 text-primary">
                    <span className="material-symbols-outlined text-xl">battery_charging_full</span>
                  </div>
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                    sessões ativas
                  </span>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-400">Energia em Sessões</p>
                  <h3 className="mt-1 text-xl font-bold text-white">
                    {formatNumber(sessionEnergySumKwh, 'kWh', 2)}
                  </h3>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold">Sessões Ativas</h2>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              <span className="text-xs text-slate-400">
                {isLoading ? 'Carregando' : `Polling ${ADMIN_POLL_INTERVAL_MS / 1000}s`}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {stationCards.map((card) => {
              const { station, session, live } = card
              const elapsedSeconds = session?.elapsed_seconds ?? calcElapsedSeconds(session?.start_time)
              const chargerState = getChargerStateMeta(live)
              const occupancyState = getOccupancyMeta(session != null)
              const offline = isStationOffline(live)
              const starting = startingStationId === station.id
              const stopping = stoppingStationId === station.id

              return (
                <article
                  className="group relative rounded-xl border border-secondary bg-surface-dark p-4 transition-all hover:border-primary/50"
                  key={station.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-secondary bg-slate-700 text-xs font-bold text-white">
                        {getStationShortLabel(station)}
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-100">{station.name}</h4>
                        <p className="flex items-center gap-1 text-xs text-slate-400">
                          <span className="material-symbols-outlined text-[12px]">location_on</span>
                          {station.location_label || 'Sem local'}
                        </p>
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${occupancyState.className}`}
                      >
                        {occupancyState.label}
                      </span>
                      <p className={`mt-2 text-xs font-medium ${chargerState.accentClassName}`}>
                        {chargerState.label}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 space-y-1 text-sm">
                    <p className="text-slate-300">
                      Usuário:{' '}
                      <span className="font-semibold text-slate-100">
                        {session?.user_name || 'Nenhuma sessao running'}
                      </span>
                    </p>
                    <p className="text-slate-400">
                      {session?.user_email || station.max_current_a == null
                        ? session?.user_email || 'Sem usuário associado'
                        : `Corrente maxima ${station.max_current_a} A`}
                    </p>
                    <p className="text-slate-500">
                      {session?.address_label
                        ? `Unidade: ${session.address_label}`
                        : `Estado do carregador: ${live?.stateLabel || chargerState.label}`}
                    </p>
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2 border-t border-secondary/50 pt-3">
                    <div className="text-center">
                      <p className="text-[10px] uppercase tracking-wider text-slate-500">Tempo</p>
                      <p className="text-sm font-medium text-slate-200">
                        {formatElapsedLong(elapsedSeconds)}
                      </p>
                    </div>
                    <div className="border-l border-secondary/50 text-center">
                      <p className="text-[10px] uppercase tracking-wider text-slate-500">Energia</p>
                      <p className="text-sm font-medium text-slate-200">
                        {formatNumber(live?.session_energy_kwh ?? null, 'kWh', 2)}
                      </p>
                    </div>
                    <div className="border-l border-secondary/50 text-center">
                      <p className="text-[10px] uppercase tracking-wider text-slate-500">Potencia</p>
                      <p className="text-sm font-medium text-primary">
                        {formatNumber(live?.powerKw ?? null, 'kW', 1)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4">
                    {session ? (
                      <button
                        className="flex h-11 w-full items-center justify-center rounded-xl border border-red-500/40 bg-red-500/10 px-4 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={stopping || startingStationId != null}
                        onClick={() => {
                          setErrorMessage(null)
                          setStopStationId(station.id)
                        }}
                        type="button"
                      >
                        {stopping ? 'Encerrando...' : 'Encerrar carregamento'}
                      </button>
                    ) : (
                      <button
                        className="flex h-11 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-background-dark transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={offline || starting || stoppingStationId != null}
                        onClick={() => {
                          setErrorMessage(null)
                          openStartModal(station.id)
                        }}
                        type="button"
                      >
                        {starting ? 'Iniciando...' : 'Iniciar carregamento'}
                      </button>
                    )}
                    {!session && offline ? (
                      <p className="mt-2 text-xs text-red-300">
                        Start bloqueado: estação offline no momento.
                      </p>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>

          {!isLoading && stationCards.length === 0 ? (
            <div className="rounded-xl border border-secondary bg-surface-dark px-4 py-6 text-center text-sm text-slate-400">
              Nenhuma estação ativa cadastrada.
            </div>
          ) : null}
        </section>

        <section>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-bold">Debug</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Consultas rápidas usadas para conferir sessões e status bruto da Tuya.
              </p>
            </div>
            <select
              className="h-11 rounded-xl border border-secondary bg-surface-dark px-3 text-sm text-slate-100 outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              onChange={(event) => setDebugStationId(event.target.value)}
              value={debugStationId}
            >
              <option value="">Estação padrão</option>
              {stations.map((station) => (
                <option key={station.id} value={String(station.id)}>
                  {station.name}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-xl border border-secondary bg-surface-dark p-4 shadow-lg">
            <div className="grid gap-3 md:grid-cols-3">
              <button
                className="h-11 rounded-xl border border-primary/30 bg-primary/10 px-4 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={debugLoading}
                onClick={() => {
                  void loadDebugSessions()
                }}
                type="button"
              >
                Ver sessões
              </button>
              <button
                className="h-11 rounded-xl border border-primary/30 bg-primary/10 px-4 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={debugLoading}
                onClick={() => {
                  void loadDebugTuya()
                }}
                type="button"
              >
                Ver status Tuya
              </button>
              <button
                className="h-11 rounded-xl border border-secondary bg-background-dark px-4 text-sm font-semibold text-slate-200 transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={debugLoading}
                onClick={() => setDebugOutput('(vazio)')}
                type="button"
              >
                Limpar saída
              </button>
            </div>

            <pre className="mt-4 max-h-[440px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-secondary bg-background-dark p-4 text-xs leading-relaxed text-slate-200">
              {debugLoading ? 'Carregando...' : debugOutput}
            </pre>
          </div>
        </section>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-secondary bg-surface-dark px-4 pb-6 pt-3">
        <div className="mx-auto flex w-full max-w-6xl justify-between items-end">
          <Link className="group flex flex-1 flex-col items-center justify-end gap-1 text-primary" to="/admin/dashboard">
            <div className="flex h-7 items-center justify-center transition-transform group-active:scale-95">
              <span
                className="material-symbols-outlined text-[26px]"
                style={{ fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}
              >
                monitoring
              </span>
            </div>
            <p className="text-[10px] font-medium leading-normal tracking-[0.015em]">Dashboard</p>
          </Link>
          <Link
            className="group flex flex-1 flex-col items-center justify-end gap-1 text-slate-400 transition-colors hover:text-slate-200"
            to="/admin/history"
          >
            <div className="flex h-7 items-center justify-center transition-transform group-active:scale-95">
              <span className="material-symbols-outlined text-[26px]">history</span>
            </div>
            <p className="text-[10px] font-medium leading-normal tracking-[0.015em]">Histórico</p>
          </Link>
          <Link
            className="group flex flex-1 flex-col items-center justify-end gap-1 text-slate-400 transition-colors hover:text-slate-200"
            to="/admin/users"
          >
            <div className="flex h-7 items-center justify-center transition-transform group-active:scale-95">
              <span className="material-symbols-outlined text-[26px]">group</span>
            </div>
            <p className="text-[10px] font-medium leading-normal tracking-[0.015em]">Usuários</p>
          </Link>
          <Link
            className="group flex flex-1 flex-col items-center justify-end gap-1 text-slate-400 transition-colors hover:text-slate-200"
            to="/admin/settings"
          >
            <div className="flex h-7 items-center justify-center transition-transform group-active:scale-95">
              <span className="material-symbols-outlined text-[26px]">settings</span>
            </div>
            <p className="text-[10px] font-medium leading-normal tracking-[0.015em]">Configurações</p>
          </Link>
        </div>
      </nav>

      <AdminStartModal
        addresses={addresses}
        errorMessage={startModalError}
        loadingAddresses={loadingAddresses}
        loadingUsers={loadingUsers}
        onAddressChange={handleAddressChange}
        onClose={closeStartModal}
        onSubmit={() => {
          void handleStartSubmit()
        }}
        onUserChange={handleUserChange}
        open={startStation != null}
        selectedAddressId={selectedAddressId}
        selectedUserId={selectedUserId}
        stationName={startStation?.name || 'Estação'}
        submitting={startingStationId === startStationId && startStationId != null}
        users={users}
      />

      <ConfirmModal
        cancelDisabled={stoppingStationId != null}
        cancelText="Cancelar"
        confirmDisabled={stoppingStationId != null}
        confirmText={stoppingStationId != null ? 'Encerrando...' : 'Encerrar'}
        message={`Tem certeza que deseja encerrar o carregamento desta estação${stopStation ? ` (${stopStation.name})` : ''}?`}
        onCancel={() => {
          if (stoppingStationId == null) {
            setStopStationId(null)
          }
        }}
        onConfirm={() => {
          void handleStopConfirm()
        }}
        open={stopStation != null}
        title="Confirmar encerramento"
      />
    </div>
  )
}
