import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { ApiError, apiFetch } from '../api/client'
import ConfirmModal from '../components/ConfirmModal'

const ADDRESS_STORAGE_KEY = 'user-home.selectedAddressId'
const STATION_STORAGE_KEY = 'user-home.selectedStationId'
const LIVE_POLL_INTERVAL_MS = 3000

type Address = {
  id: number
  label: string
  street?: string | null
  number?: string | null
  is_default: boolean
}

type Station = {
  id: number
  name: string
  location_label: string | null
  max_current_a: number | null
}

type CurrentSession = {
  session_id: number
  user_id: number
  station_id: number
  start_time: string
}

type SessionState = {
  active: boolean
  occupied: boolean
  session: CurrentSession | null
}

type SessionCurrentResponse = {
  success: boolean
  active: boolean
  occupied?: boolean
  session: CurrentSession | null
}

type AddressesResponse = {
  success: boolean
  addresses: Address[]
}

type StationsResponse = {
  success: boolean
  stations: Station[]
}

type LiveResponse = {
  success: boolean
  telemetry?: {
    power_kw: number | null
    total_kwh: number | null
    session_energy_kwh?: number | null
    state_label: string | null
  }
  running_session?: {
    elapsed_seconds: number | null
    session_energy_kwh?: number | null
  } | null
  energy_total_kwh?: number | null
  session_energy_kwh?: number | null
  session_energy_source?: string | null
  session_active?: boolean
  session_id?: number | null
  session_start_time?: string | null
  powerKw?: number | null
  totalKwh?: number | null
  stateLabel?: string | null
  elapsedSeconds?: number | null
}

type StartResponse = {
  success: boolean
  message?: string
  sessionId?: number
}

type StopResponse = {
  success: boolean
  message?: string
  sessionId?: number
  duration_seconds?: number | null
  energy_kwh?: number | null
  price_calculated?: number | null
}

type OperationState = 'idle' | 'starting' | 'stopping'
type PanelState = 'idle' | 'active' | 'starting' | 'stopping' | 'error'
type ChargeMode = 'until_complete' | 'by_value'

type StopSummary = {
  durationSeconds: number | null
  energyKwh: number | null
  priceCalculated: number | null
}

function mapCurrentSessionResponse(response: SessionCurrentResponse): SessionState {
  return {
    active: response.active === true,
    occupied: response.occupied === true,
    session: response.session ?? null,
  }
}

function parseId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function readStoredId(key: string) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? parseId(raw) : null
  } catch {
    return null
  }
}

function persistStoredId(key: string, id: number | null) {
  try {
    if (id == null) {
      window.localStorage.removeItem(key)
      return
    }
    window.localStorage.setItem(key, String(id))
  } catch {
    // no-op
  }
}

function pickInitialAddressId(addresses: Address[], storedId: number | null) {
  const defaultAddress = addresses.find((address) => address.is_default)
  if (defaultAddress) return defaultAddress.id
  if (storedId && addresses.some((address) => address.id === storedId)) return storedId
  return addresses[0]?.id ?? null
}

function pickInitialStationId(stations: Station[], storedId: number | null) {
  if (storedId && stations.some((station) => station.id === storedId)) return storedId
  return stations[0]?.id ?? null
}

function formatNumber(value: number | null | undefined, unit: string, fractionDigits = 1) {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${value.toLocaleString('pt-BR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} ${unit}`
}

function formatCurrency(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatAddressLabel(address: Address) {
  const street = String(address.street || '').trim()
  const number = String(address.number || '').trim()

  if (street && number) {
    return `${street} - Apto ${number}`
  }
  if (street) {
    return street
  }
  return address.label
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('pt-BR')
}

function formatElapsed(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--:--'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':')
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.message.trim()) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function getPanelBadge(panelState: PanelState) {
  if (panelState === 'starting') {
    return {
      label: 'Iniciando',
      className: 'bg-primary/10 text-primary',
      dotClassName: 'bg-primary animate-pulse',
    }
  }
  if (panelState === 'stopping') {
    return {
      label: 'Encerrando',
      className: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
      dotClassName: 'bg-amber-500 animate-pulse',
    }
  }
  if (panelState === 'active') {
    return {
      label: 'Carregando',
      className: 'bg-primary/10 text-primary',
      dotClassName: 'bg-primary animate-pulse',
    }
  }
  if (panelState === 'error') {
    return {
      label: 'Erro',
      className: 'bg-danger/15 text-danger',
      dotClassName: 'bg-danger',
    }
  }
  return {
    label: 'Pronto',
    className: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
    dotClassName: 'bg-slate-400',
  }
}

export default function UserHomePage() {
  const { user } = useAuth()

  const [addresses, setAddresses] = useState<Address[]>([])
  const [stations, setStations] = useState<Station[]>([])
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(() =>
    readStoredId(ADDRESS_STORAGE_KEY),
  )
  const [selectedStationId, setSelectedStationId] = useState<number | null>(() =>
    readStoredId(STATION_STORAGE_KEY),
  )

  const [sessionState, setSessionState] = useState<SessionState>({
    active: false,
    occupied: false,
    session: null,
  })
  const [liveData, setLiveData] = useState<LiveResponse | null>(null)
  const [operationState, setOperationState] = useState<OperationState>('idle')
  const [actionError, setActionError] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [stopSummary, setStopSummary] = useState<StopSummary | null>(null)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [isLoadingOptions, setIsLoadingOptions] = useState(true)
  const [chargeMode, setChargeMode] = useState<ChargeMode>('until_complete')
  const [limitValue, setLimitValue] = useState('')
  const [clock, setClock] = useState(() => Date.now())
  const previousSessionActiveRef = useRef(false)
  const lastActiveSummaryRef = useRef<StopSummary>({
    durationSeconds: null,
    energyKwh: null,
    priceCalculated: null,
  })

  const isBusy = operationState !== 'idle'
  const isSessionActive = sessionState.active
  const controlsLocked = isBusy || isSessionActive

  const panelState: PanelState = useMemo(() => {
    if (actionError || liveError) return 'error'
    if (operationState === 'starting') return 'starting'
    if (operationState === 'stopping') return 'stopping'
    if (isSessionActive) return 'active'
    return 'idle'
  }, [actionError, isSessionActive, liveError, operationState])
  const panelBadge = useMemo(() => getPanelBadge(panelState), [panelState])

  const currentPowerKw = liveData?.telemetry?.power_kw ?? liveData?.powerKw ?? null
  const currentSessionEnergyKwh =
    liveData?.running_session?.session_energy_kwh ??
    liveData?.telemetry?.session_energy_kwh ??
    liveData?.session_energy_kwh ??
    null
  const totalEnergyKwh =
    liveData?.telemetry?.total_kwh ??
    liveData?.energy_total_kwh ??
    liveData?.totalKwh ??
    null
  const chargerStatus = liveData?.telemetry?.state_label ?? liveData?.stateLabel ?? 'Sem dados'

  const elapsedSeconds = useMemo(() => {
    if (!isSessionActive) return null

    const telemetryElapsed = liveData?.running_session?.elapsed_seconds ?? liveData?.elapsedSeconds ?? null
    if (telemetryElapsed != null && Number.isFinite(telemetryElapsed) && telemetryElapsed >= 0) {
      return Math.floor(telemetryElapsed)
    }

    const startTime = sessionState.session?.start_time
    if (!startTime) return null

    const startMs = new Date(startTime).getTime()
    if (Number.isNaN(startMs)) return null
    return Math.max(0, Math.floor((clock - startMs) / 1000))
  }, [
    clock,
    isSessionActive,
    liveData?.elapsedSeconds,
    liveData?.running_session?.elapsed_seconds,
    sessionState.session?.start_time,
  ])
  const displayedElapsedSeconds = isSessionActive ? elapsedSeconds : stopSummary?.durationSeconds ?? null
  const displayedSessionEnergyKwh = isSessionActive
    ? currentSessionEnergyKwh
    : stopSummary?.energyKwh ?? null

  const fetchSessionStateForStation = useCallback(async (stationId: number) => {
    const response = await apiFetch<SessionCurrentResponse>(`/api/session/current?station_id=${stationId}`)
    return mapCurrentSessionResponse(response)
  }, [])

  const refreshSessionState = useCallback(async () => {
    if (!selectedStationId) {
      const nextState = { active: false, occupied: false, session: null }
      setSessionState(nextState)
      return nextState
    }

    const nextState = await fetchSessionStateForStation(selectedStationId)
    setSessionState(nextState)
    return nextState
  }, [fetchSessionStateForStation, selectedStationId])

  useEffect(() => {
    let cancelled = false

    const loadOptions = async () => {
      setIsLoadingOptions(true)

      try {
        const [addressesResponse, stationsResponse] = await Promise.all([
          apiFetch<AddressesResponse>('/api/my/addresses'),
          apiFetch<StationsResponse>('/api/stations'),
        ])
        if (cancelled) return

        const nextAddresses = addressesResponse.addresses ?? []
        const nextStations = stationsResponse.stations ?? []
        setAddresses(nextAddresses)
        setStations(nextStations)

        const storedAddressId = readStoredId(ADDRESS_STORAGE_KEY)
        const storedStationId = readStoredId(STATION_STORAGE_KEY)
        setSelectedAddressId(pickInitialAddressId(nextAddresses, storedAddressId))
        setSelectedStationId(pickInitialStationId(nextStations, storedStationId))
      } catch (error) {
        if (cancelled) return
        setActionError(
          getErrorMessage(error, 'Nao foi possivel carregar os enderecos e as estacoes.'),
        )
      } finally {
        if (!cancelled) {
          setIsLoadingOptions(false)
        }
      }
    }

    void loadOptions()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    persistStoredId(ADDRESS_STORAGE_KEY, selectedAddressId)
  }, [selectedAddressId])

  useEffect(() => {
    persistStoredId(STATION_STORAGE_KEY, selectedStationId)
  }, [fetchSessionStateForStation, selectedStationId])

  useEffect(() => {
    previousSessionActiveRef.current = false
    lastActiveSummaryRef.current = {
      durationSeconds: null,
      energyKwh: null,
      priceCalculated: null,
    }
  }, [selectedStationId])

  useEffect(() => {
    if (!selectedStationId) {
      setSessionState({ active: false, occupied: false, session: null })
      setLiveData(null)
      setLiveError(null)
      return
    }

    let cancelled = false
    const syncCurrentSession = async () => {
      try {
        await refreshSessionState()
      } catch (error) {
        if (cancelled) return
        setActionError(getErrorMessage(error, 'Nao foi possivel consultar a sessao atual.'))
      }
    }

    void syncCurrentSession()
    return () => {
      cancelled = true
    }
  }, [refreshSessionState, selectedStationId])

  useEffect(() => {
    if (!selectedStationId) return

    let cancelled = false

    const pollLive = async () => {
      const [liveResult, sessionResult] = await Promise.allSettled([
        apiFetch<LiveResponse>(`/api/live?station_id=${selectedStationId}`),
        fetchSessionStateForStation(selectedStationId),
      ])

      if (cancelled) return

      let nextLiveError: string | null = null

      if (liveResult.status === 'fulfilled') {
        setLiveData(liveResult.value)
      } else {
        nextLiveError = getErrorMessage(
          liveResult.reason,
          'Falha ao atualizar dados ao vivo do carregador.',
        )
      }

      if (sessionResult.status === 'fulfilled') {
        setSessionState(sessionResult.value)
      } else if (!nextLiveError) {
        nextLiveError = getErrorMessage(
          sessionResult.reason,
          'Falha ao atualizar o estado da sessao atual.',
        )
      }

      setLiveError(nextLiveError)
    }

    void pollLive()
    const intervalId = window.setInterval(() => {
      void pollLive()
    }, LIVE_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [selectedStationId])

  useEffect(() => {
    if (!isSessionActive) return
    const intervalId = window.setInterval(() => {
      setClock(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(intervalId)
    }
  }, [isSessionActive])

  useEffect(() => {
    if (!isSessionActive) return
    lastActiveSummaryRef.current = {
      durationSeconds: elapsedSeconds ?? null,
      energyKwh: currentSessionEnergyKwh ?? null,
      priceCalculated: null,
    }
  }, [currentSessionEnergyKwh, elapsedSeconds, isSessionActive])

  useEffect(() => {
    const wasActive = previousSessionActiveRef.current

    if (wasActive && !isSessionActive && operationState !== 'stopping') {
      const snapshot = lastActiveSummaryRef.current
      if (snapshot.durationSeconds != null || snapshot.energyKwh != null) {
        setStopSummary(snapshot)
      }
      setActionError(null)
      setSuccessMessage('Sessao finalizada automaticamente (carregamento concluido).')
    }

    previousSessionActiveRef.current = isSessionActive
  }, [isSessionActive, operationState])

  const handleStartSession = useCallback(async () => {
    setActionError(null)
    setSuccessMessage(null)
    setStopSummary(null)

    if (!selectedStationId) {
      setActionError('Selecione uma estacao para iniciar o carregamento.')
      return
    }
    if (!selectedAddressId) {
      setActionError('Selecione uma unidade para iniciar o carregamento.')
      return
    }

    setOperationState('starting')
    try {
      const response = await apiFetch<StartResponse>('/session/start', {
        method: 'POST',
        body: { station_id: selectedStationId, address_id: selectedAddressId },
      })
      setSuccessMessage(response.message ?? 'Carregamento iniciado com sucesso.')

      try {
        await refreshSessionState()
      } catch (error) {
        setActionError(
          getErrorMessage(error, 'Sessao iniciada, mas nao foi possivel atualizar o estado atual.'),
        )
      }

      try {
        const live = await apiFetch<LiveResponse>(`/api/live?station_id=${selectedStationId}`)
        setLiveData(live)
        setLiveError(null)
      } catch (error) {
        setLiveError(getErrorMessage(error, 'Sessao iniciada, mas sem telemetria no momento.'))
      }
    } catch (error) {
      setActionError(getErrorMessage(error, 'Nao foi possivel iniciar o carregamento.'))
    } finally {
      setOperationState('idle')
    }
  }, [refreshSessionState, selectedAddressId, selectedStationId])

  const handleStopSession = useCallback(async () => {
    setShowStopConfirm(false)
    setActionError(null)
    setSuccessMessage(null)

    if (!selectedStationId) {
      setActionError('Selecione uma estacao para encerrar o carregamento.')
      return
    }

    setOperationState('stopping')
    try {
      const response = await apiFetch<StopResponse>('/session/stop', {
        method: 'POST',
        body: { station_id: selectedStationId },
      })

      setSuccessMessage(response.message ?? 'Sessao encerrada com sucesso.')
      setStopSummary({
        durationSeconds: response.duration_seconds ?? null,
        energyKwh: response.energy_kwh ?? null,
        priceCalculated: response.price_calculated ?? null,
      })

      try {
        await refreshSessionState()
      } catch (error) {
        setActionError(
          getErrorMessage(error, 'Sessao encerrada, mas nao foi possivel atualizar o estado atual.'),
        )
      }

      try {
        const live = await apiFetch<LiveResponse>(`/api/live?station_id=${selectedStationId}`)
        setLiveData(live)
        setLiveError(null)
      } catch (error) {
        setLiveError(getErrorMessage(error, 'Sessao encerrada, mas sem telemetria no momento.'))
      }
    } catch (error) {
      setActionError(getErrorMessage(error, 'Nao foi possivel encerrar o carregamento.'))
    } finally {
      setOperationState('idle')
    }
  }, [refreshSessionState, selectedStationId])

  const handleAddressChange = (value: string) => {
    setSelectedAddressId(parseId(value))
  }

  const handleStationChange = (value: string) => {
    setSelectedStationId(parseId(value))
    setSuccessMessage(null)
    setStopSummary(null)
  }

  const actionButtonText =
    operationState === 'starting'
      ? 'Iniciando carregamento...'
      : operationState === 'stopping'
        ? 'Encerrando carregamento...'
        : isSessionActive
          ? 'Encerrar Carregamento'
          : 'Iniciar Carregamento'

  const actionButtonIcon =
    operationState === 'starting' || operationState === 'stopping'
      ? 'progress_activity'
      : isSessionActive
        ? 'stop_circle'
        : 'ev_charger'

  return (
    <div className="min-h-screen bg-background-light font-display text-slate-900 dark:bg-background-dark dark:text-slate-100">
      <header className="sticky top-0 z-50 flex items-center border-b border-slate-200 bg-background-light p-4 dark:border-primary/20 dark:bg-background-dark">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <img alt="SPATE Engenharia" className="size-8 object-contain" src="/assets/Logo.svg" />
        </div>
        <h1 className="flex-1 text-center text-lg font-bold leading-tight">SPATE Engenharia</h1>
        <div className="flex w-10 items-center justify-end">
          <button
            className="flex size-10 items-center justify-center rounded-full text-slate-900 transition-colors hover:bg-primary/10 dark:text-slate-100"
            type="button"
          >
            <span className="material-symbols-outlined">notifications</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md space-y-6 px-4 py-6 pb-28">
        {actionError ? (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {actionError}
          </div>
        ) : null}

        {!actionError && liveError ? (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {liveError}
          </div>
        ) : null}

        {!actionError && !liveError && successMessage ? (
          <div className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-slate-800 dark:text-slate-100">
            {successMessage}
          </div>
        ) : null}

        {stopSummary ? (
          <section className="rounded-2xl border border-primary/20 bg-white p-4 dark:bg-slate-800/40">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Resumo da ultima sessao
            </h3>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-lg bg-slate-100 p-2 dark:bg-slate-800">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Tempo</p>
                <p className="font-bold">{formatElapsed(stopSummary.durationSeconds)}</p>
              </div>
              <div className="rounded-lg bg-slate-100 p-2 dark:bg-slate-800">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Energia</p>
                <p className="font-bold">{formatNumber(stopSummary.energyKwh, 'kWh', 2)}</p>
              </div>
              <div className="rounded-lg bg-slate-100 p-2 dark:bg-slate-800">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Valor</p>
                <p className="font-bold">{formatCurrency(stopSummary.priceCalculated)}</p>
              </div>
            </div>
          </section>
        ) : null}

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold tracking-tight">Painel do Carregador</h2>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-bold ${panelBadge.className}`}
            >
              <span className={`h-2 w-2 rounded-full ${panelBadge.dotClassName}`} />
              {panelBadge.label}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-primary/10 dark:bg-slate-800/50">
              {isBusy ? <div className="absolute inset-0 animate-pulse bg-primary/5" /> : null}
              <p className="relative z-10 mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Potencia
              </p>
              <p className="relative z-10 text-lg font-bold text-primary">
                {formatNumber(currentPowerKw, 'kW', 1)}
              </p>
            </div>
            <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-primary/10 dark:bg-slate-800/50">
              {isBusy ? <div className="absolute inset-0 animate-pulse bg-primary/5" /> : null}
              <p className="relative z-10 mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Energia da Sessao
              </p>
              <p className="relative z-10 text-lg font-bold text-primary">
                {formatNumber(displayedSessionEnergyKwh, 'kWh', 2)}
              </p>
              <p className="relative z-10 mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Total carregador: {formatNumber(totalEnergyKwh, 'kWh', 2)}
              </p>
            </div>
            <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-primary/10 dark:bg-slate-800/50">
              {isBusy ? <div className="absolute inset-0 animate-pulse bg-primary/5" /> : null}
              <p className="relative z-10 mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Tempo Decorrido
              </p>
              <p className="relative z-10 text-lg font-bold text-primary">
                {formatElapsed(displayedElapsedSeconds)}
              </p>
            </div>
            <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-primary/10 dark:bg-slate-800/50">
              {isBusy ? <div className="absolute inset-0 animate-pulse bg-primary/5" /> : null}
              <p className="relative z-10 mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Status
              </p>
              <p className="relative z-10 text-sm font-bold text-primary">{chargerStatus}</p>
            </div>
          </div>
        </section>

        {isSessionActive && sessionState.session ? (
          <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4 dark:border-primary/10 dark:bg-slate-800/30">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Sessao ativa
            </h3>
            <p className="text-sm">
              Usuario:{' '}
              <span className="font-semibold">
                {user?.name
                  ? `${user.name} (id ${sessionState.session.user_id})`
                  : `id ${sessionState.session.user_id}`}
              </span>
            </p>
            <p className="text-sm">
              Inicio: <span className="font-semibold">{formatDateTime(sessionState.session.start_time)}</span>
            </p>
            <p className="text-sm">
              Sessao: <span className="font-semibold">#{sessionState.session.session_id}</span>
            </p>
          </section>
        ) : null}

        <section
          className={`space-y-5 rounded-2xl border border-slate-200 bg-white p-5 dark:border-primary/10 dark:bg-slate-800/30 ${
            controlsLocked ? 'pointer-events-none opacity-75 grayscale-[0.2]' : ''
          }`}
        >
          <div className="space-y-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                Selecionar Unidade
              </label>
              <div className="relative">
                <select
                  className="h-14 w-full appearance-none rounded-xl border-slate-200 bg-slate-100 pl-4 pr-10 font-medium text-slate-900 focus:border-primary focus:ring-primary dark:border-primary/20 dark:bg-background-dark dark:text-slate-100"
                  disabled={isLoadingOptions || controlsLocked}
                  onChange={(event) => handleAddressChange(event.target.value)}
                  value={selectedAddressId ?? ''}
                >
                  <option value="">Selecione uma unidade</option>
                  {addresses.map((address) => (
                    <option key={address.id} value={address.id}>
                      {formatAddressLabel(address)}
                    </option>
                  ))}
                </select>
                <span className="material-symbols-outlined pointer-events-none absolute right-3 top-4 text-slate-400">
                  {controlsLocked ? 'lock' : 'expand_more'}
                </span>
              </div>
              {!isLoadingOptions && addresses.length === 0 ? (
                <p className="text-xs text-danger">Nenhum endereco cadastrado para este usuario.</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                Estacao de Recarga
              </label>
              <div className="relative">
                <select
                  className="h-14 w-full appearance-none rounded-xl border-slate-200 bg-slate-100 pl-4 pr-10 font-medium text-slate-900 focus:border-primary focus:ring-primary dark:border-primary/20 dark:bg-background-dark dark:text-slate-100"
                  disabled={isLoadingOptions || controlsLocked}
                  onChange={(event) => handleStationChange(event.target.value)}
                  value={selectedStationId ?? ''}
                >
                  <option value="">Selecione uma estacao</option>
                  {stations.map((station) => (
                    <option key={station.id} value={station.id}>
                      {station.location_label
                        ? `${station.name} - ${station.location_label}`
                        : station.name}
                    </option>
                  ))}
                </select>
                <span className="material-symbols-outlined pointer-events-none absolute right-3 top-4 text-slate-400">
                  {controlsLocked ? 'lock' : 'expand_more'}
                </span>
              </div>
              {!isLoadingOptions && stations.length === 0 ? (
                <p className="text-xs text-danger">Nenhuma estacao ativa disponivel.</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              Modo de Carregamento
            </label>
            <div className="flex rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-primary/20 dark:bg-background-dark">
              <button
                className={`flex-1 rounded-lg px-4 py-3 text-sm font-bold transition-all ${
                  chargeMode === 'until_complete'
                    ? 'bg-primary text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
                disabled={controlsLocked}
                onClick={() => setChargeMode('until_complete')}
                type="button"
              >
                Ate completar
              </button>
              <button
                className={`flex-1 rounded-lg px-4 py-3 text-sm font-bold transition-all ${
                  chargeMode === 'by_value'
                    ? 'bg-primary text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
                disabled={controlsLocked}
                onClick={() => setChargeMode('by_value')}
                type="button"
              >
                Valor em R$
              </button>
            </div>
          </div>

          {chargeMode === 'by_value' ? (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                Valor Limite
              </label>
              <div className="relative">
                <span className="absolute left-4 top-4 text-slate-500">R$</span>
                <input
                  className="h-14 w-full rounded-xl border-slate-200 bg-slate-100 pl-12 pr-4 font-medium text-slate-900 focus:border-primary focus:ring-primary dark:border-primary/20 dark:bg-background-dark dark:text-slate-100"
                  disabled={controlsLocked}
                  min={0}
                  onChange={(event) => setLimitValue(event.target.value)}
                  placeholder="0,00"
                  step="0.01"
                  type="number"
                  value={limitValue}
                />
              </div>
            </div>
          ) : null}
        </section>

        {sessionState.occupied && !sessionState.active ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-200">
            Esta estacao esta ocupada por outro usuario no momento.
          </div>
        ) : null}

        <div className="pt-2">
          <button
            className={`h-16 w-full rounded-2xl text-lg font-bold transition-all active:scale-95 ${
              isSessionActive
                ? 'group flex items-center justify-center gap-3 border-2 border-danger bg-transparent text-danger hover:bg-danger/10'
                : 'flex items-center justify-center gap-3 bg-primary text-background-dark shadow-lg shadow-primary/20 hover:bg-primary/90'
            } ${isBusy ? 'cursor-not-allowed opacity-80' : ''}`}
            disabled={isBusy}
            onClick={() => {
              if (isSessionActive) {
                setShowStopConfirm(true)
                return
              }
              void handleStartSession()
            }}
            type="button"
          >
            <span
              className={`material-symbols-outlined transition-transform ${
                operationState === 'starting' || operationState === 'stopping'
                  ? 'animate-spin'
                  : isSessionActive
                    ? 'group-hover:scale-110'
                    : 'active-icon'
              }`}
            >
              {actionButtonIcon}
            </span>
            {actionButtonText}
          </button>
          <p className="mt-4 px-6 text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {isSessionActive
              ? 'O encerramento pode levar alguns segundos para destravar o conector.'
              : 'Ao iniciar, confirme se o cabo esta conectado corretamente ao veiculo.'}
          </p>
        </div>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 border-t border-slate-200 bg-white px-4 pb-6 pt-2 dark:border-primary/20 dark:bg-slate-900">
        <div className="mx-auto flex w-full max-w-md items-center justify-around">
          <Link className="flex flex-col items-center gap-1 p-2 text-primary" to="/app/home">
            <span className="material-symbols-outlined active-icon">home</span>
            <span className="text-[10px] font-bold uppercase tracking-wider">Inicio</span>
          </Link>
          <Link
            className="flex flex-col items-center gap-1 p-2 text-slate-400 transition-colors hover:text-primary"
            to="/app/history"
          >
            <span className="material-symbols-outlined">history</span>
            <span className="text-[10px] font-bold uppercase tracking-wider">Historico</span>
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

      <ConfirmModal
        cancelText="Cancelar"
        confirmText="Encerrar"
        message="Deseja realmente encerrar o carregamento desta estacao agora?"
        onCancel={() => setShowStopConfirm(false)}
        onConfirm={() => {
          void handleStopSession()
        }}
        open={showStopConfirm}
        title="Confirmar encerramento"
      />
    </div>
  )
}
