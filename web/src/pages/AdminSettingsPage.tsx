import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { ApiError, apiFetch } from '../api/client'

type AdminSettings = {
  price_per_kwh: number
  default_charge_current_a: number
}

type AdminStation = {
  id: number
  name: string
  location_label: string | null
  tuya_device_id: string
  max_current_a: number | null
  is_active: boolean
}

type SettingsResponse = {
  success: boolean
  settings: AdminSettings
}

type UpdateSettingsResponse = {
  ok: boolean
  success: boolean
  settings: AdminSettings
}

type StationsResponse = {
  success: boolean
  stations: AdminStation[]
}

type StationResponse = {
  success: boolean
  station: AdminStation
}

type StationDraft = {
  name: string
  location_label: string
  tuya_device_id: string
  max_current_a: string
  is_active: boolean
}

const EMPTY_STATION_DRAFT: StationDraft = {
  name: '',
  location_label: '',
  tuya_device_id: '',
  max_current_a: '32',
  is_active: true,
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.message.trim()) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function toStationDraft(station: AdminStation): StationDraft {
  return {
    name: station.name,
    location_label: station.location_label ?? '',
    tuya_device_id: station.tuya_device_id,
    max_current_a: String(station.max_current_a ?? 32),
    is_active: station.is_active === true,
  }
}

function sanitizeStationDraft(draft: StationDraft) {
  return {
    name: draft.name.trim(),
    location_label: draft.location_label.trim() || null,
    tuya_device_id: draft.tuya_device_id.trim(),
    max_current_a: Number(draft.max_current_a),
    is_active: draft.is_active,
  }
}

function validateStationDraft(draft: StationDraft) {
  if (!draft.name.trim()) return 'name e obrigatorio.'
  if (!draft.tuya_device_id.trim()) return 'tuya_device_id e obrigatorio.'
  const current = Number(draft.max_current_a)
  if (!Number.isInteger(current) || current < 6 || current > 32) {
    return 'max_current_a deve ser inteiro entre 6 e 32.'
  }
  return null
}

function StationFields({
  draft,
  onChange,
}: {
  draft: StationDraft
  onChange: (patch: Partial<StationDraft>) => void
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#90cba4]">Nome</span>
        <input
          className="h-11 w-full rounded-xl border border-white/10 bg-[#102216] px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ name: event.target.value })}
          value={draft.name}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#90cba4]">Local</span>
        <input
          className="h-11 w-full rounded-xl border border-white/10 bg-[#102216] px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ location_label: event.target.value })}
          value={draft.location_label}
        />
      </label>
      <label className="space-y-1 md:col-span-2">
        <span className="text-xs uppercase tracking-[0.18em] text-[#90cba4]">Tuya Device ID</span>
        <input
          className="h-11 w-full rounded-xl border border-white/10 bg-[#102216] px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ tuya_device_id: event.target.value })}
          value={draft.tuya_device_id}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#90cba4]">Corrente maxima (A)</span>
        <input
          className="h-11 w-full rounded-xl border border-white/10 bg-[#102216] px-3 text-sm text-white outline-none transition focus:border-primary/40"
          inputMode="numeric"
          onChange={(event) => onChange({ max_current_a: event.target.value })}
          value={draft.max_current_a}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-white">
        <input
          checked={draft.is_active}
          className="h-4 w-4 rounded border-white/10 bg-[#102216] text-primary focus:ring-primary/40"
          onChange={(event) => onChange({ is_active: event.target.checked })}
          type="checkbox"
        />
        Estação ativa
      </label>
    </div>
  )
}

export default function AdminSettingsPage() {
  const { user } = useAuth()
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [pricePerKwh, setPricePerKwh] = useState('')
  const [defaultChargeCurrentA, setDefaultChargeCurrentA] = useState('32')
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)

  const [stations, setStations] = useState<AdminStation[]>([])
  const [stationDrafts, setStationDrafts] = useState<Record<number, StationDraft>>({})
  const [stationsLoading, setStationsLoading] = useState(true)
  const [stationsError, setStationsError] = useState<string | null>(null)
  const [createStationDraft, setCreateStationDraft] = useState<StationDraft>(EMPTY_STATION_DRAFT)
  const [createStationError, setCreateStationError] = useState<string | null>(null)
  const [creatingStation, setCreatingStation] = useState(false)
  const [savingStationId, setSavingStationId] = useState<number | null>(null)
  const [stationMessage, setStationMessage] = useState<string | null>(null)
  const [stationRowErrors, setStationRowErrors] = useState<Record<number, string>>({})

  const adminInitials = useMemo(() => {
    const parts = String(user?.name || 'Admin')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
    return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || 'AD'
  }, [user?.name])

  const syncStationDrafts = useCallback((nextStations: AdminStation[]) => {
    setStationDrafts(Object.fromEntries(nextStations.map((station) => [station.id, toStationDraft(station)])))
  }, [])

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true)
    try {
      const response = await apiFetch<SettingsResponse>('/api/admin/settings')
      setSettings(response.settings)
      setPricePerKwh(String(response.settings.price_per_kwh))
      setDefaultChargeCurrentA(String(response.settings.default_charge_current_a))
      setSettingsError(null)
    } catch (error) {
      setSettingsError(getErrorMessage(error, 'Não foi possível carregar as configurações.'))
    } finally {
      setSettingsLoading(false)
    }
  }, [])

  const loadStations = useCallback(async () => {
    setStationsLoading(true)
    try {
      const response = await apiFetch<StationsResponse>('/api/admin/stations')
      const nextStations = Array.isArray(response.stations) ? response.stations : []
      setStations(nextStations)
      syncStationDrafts(nextStations)
      setStationsError(null)
    } catch (error) {
      setStationsError(getErrorMessage(error, 'Nao foi possivel carregar as estacoes.'))
    } finally {
      setStationsLoading(false)
    }
  }, [syncStationDrafts])

  useEffect(() => {
    void Promise.all([loadSettings(), loadStations()])
  }, [loadSettings, loadStations])

  const handleSaveSettings = async () => {
    setSettingsSaving(true)
    setSettingsError(null)
    setSettingsMessage(null)

    const price = Number(String(pricePerKwh).replace(',', '.'))
    const current = Number(defaultChargeCurrentA)
    if (!Number.isFinite(price) || price <= 0) {
      setSettingsError('price_per_kwh deve ser maior que zero.')
      setSettingsSaving(false)
      return
    }
    if (!Number.isInteger(current) || current < 6 || current > 32) {
      setSettingsError('default_charge_current_a deve ser inteiro entre 6 e 32.')
      setSettingsSaving(false)
      return
    }

    try {
      const response = await apiFetch<UpdateSettingsResponse>('/api/admin/settings', {
        method: 'PATCH',
        body: {
          price_per_kwh: price,
          default_charge_current_a: current,
        },
      })
      setSettings(response.settings)
      setPricePerKwh(String(response.settings.price_per_kwh))
      setDefaultChargeCurrentA(String(response.settings.default_charge_current_a))
      setSettingsMessage('Salvo.')
    } catch (error) {
      setSettingsError(getErrorMessage(error, 'Não foi possível salvar as configurações.'))
    } finally {
      setSettingsSaving(false)
    }
  }

  const handleCreateStation = async () => {
    setCreatingStation(true)
    setCreateStationError(null)
    setStationMessage(null)

    const validationError = validateStationDraft(createStationDraft)
    if (validationError) {
      setCreateStationError(validationError)
      setCreatingStation(false)
      return
    }

    try {
      await apiFetch<StationResponse>('/api/admin/stations', {
        method: 'POST',
        body: sanitizeStationDraft(createStationDraft),
      })
      setCreateStationDraft({
        ...EMPTY_STATION_DRAFT,
        max_current_a: defaultChargeCurrentA,
      })
      setStationMessage('Estação criada.')
      await loadStations()
    } catch (error) {
      setCreateStationError(getErrorMessage(error, 'Nao foi possivel criar a estacao.'))
    } finally {
      setCreatingStation(false)
    }
  }

  const handleSaveStation = async (stationId: number) => {
    const draft = stationDrafts[stationId]
    if (!draft) return

    setSavingStationId(stationId)
    setStationRowErrors((current) => ({ ...current, [stationId]: '' }))
    setStationMessage(null)

    const validationError = validateStationDraft(draft)
    if (validationError) {
      setStationRowErrors((current) => ({ ...current, [stationId]: validationError }))
      setSavingStationId(null)
      return
    }

    try {
      await apiFetch<StationResponse>(`/api/admin/stations/${stationId}`, {
        method: 'PATCH',
        body: sanitizeStationDraft(draft),
      })
      setStationMessage('Estação atualizada.')
      await loadStations()
    } catch (error) {
      setStationRowErrors((current) => ({
        ...current,
        [stationId]: getErrorMessage(error, 'Nao foi possivel atualizar a estacao.'),
      }))
    } finally {
      setSavingStationId(null)
    }
  }

  return (
    <div className="bg-background-light font-display text-slate-900 antialiased selection:bg-primary selection:text-background-dark dark:bg-background-dark dark:text-slate-100">
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-28 pt-6">
        <section className="rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_right,_rgba(13,242,89,0.12),_transparent_30%),linear-gradient(160deg,_rgba(24,52,34,1),_rgba(16,34,22,1))] p-6 shadow-[0_20px_80px_rgba(0,0,0,0.28)]">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-600 text-lg font-bold text-background-dark">
              {adminInitials}
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Configurações</h1>
              <p className="text-sm text-[#90cba4]">{user?.email || 'Administrador'}</p>
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-white/10 bg-surface-dark/95 p-5 shadow-[0_16px_60px_rgba(0,0,0,0.28)]">
          <div className="mb-5 flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#22492f] text-primary">
              <span className="material-symbols-outlined">currency_exchange</span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Tarifas e parametros</h2>
              <p className="text-sm text-slate-400">A tarifa salva aqui passa a ser usada no cálculo das sessões.</p>
            </div>
          </div>

          {settingsError ? (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {settingsError}
            </div>
          ) : null}

          {settingsMessage ? (
            <div className="mb-4 rounded-xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-primary">
              {settingsMessage}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">Tarifa por kWh (R$)</span>
              <input
                className="h-12 w-full rounded-xl border border-white/10 bg-[#102216] px-4 text-sm text-white outline-none transition focus:border-primary/40"
                disabled={settingsLoading || settingsSaving}
                inputMode="decimal"
                onChange={(event) => setPricePerKwh(event.target.value)}
                value={pricePerKwh}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-white">Corrente padrao (A)</span>
              <input
                className="h-12 w-full rounded-xl border border-white/10 bg-[#102216] px-4 text-sm text-white outline-none transition focus:border-primary/40"
                disabled={settingsLoading || settingsSaving}
                inputMode="numeric"
                onChange={(event) => setDefaultChargeCurrentA(event.target.value)}
                value={defaultChargeCurrentA}
              />
            </label>
          </div>

          {settings ? (
            <p className="mt-4 text-xs text-slate-400">
              Em uso agora: R$ {settings.price_per_kwh.toFixed(2)} por kWh e corrente padrao de{' '}
              {settings.default_charge_current_a} A.
            </p>
          ) : null}

          <div className="mt-5 flex justify-end">
            <button
              className="rounded-xl bg-primary px-5 py-3 text-sm font-bold text-background-dark transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={settingsLoading || settingsSaving}
              onClick={() => {
                void handleSaveSettings()
              }}
              type="button"
            >
              {settingsSaving ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </section>

        <section className="rounded-[28px] border border-white/10 bg-surface-dark/95 p-5 shadow-[0_16px_60px_rgba(0,0,0,0.28)]">
          <div className="mb-5 flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#22492f] text-primary">
              <span className="material-symbols-outlined">ev_station</span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Estações de recarga</h2>
              <p className="text-sm text-slate-400">Cadastre e ajuste os carregadores disponiveis no sistema.</p>
            </div>
          </div>

          {stationsError ? (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {stationsError}
            </div>
          ) : null}

          {stationMessage ? (
            <div className="mb-4 rounded-xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-primary">
              {stationMessage}
            </div>
          ) : null}

          <section className="mb-5 rounded-2xl border border-primary/20 bg-primary/5 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-white">Nova estação</h3>
                <p className="text-xs text-[#90cba4]">Tuya Device ID deve ser unico.</p>
              </div>
              <button
                className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-background-dark transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={creatingStation}
                onClick={() => {
                  void handleCreateStation()
                }}
                type="button"
              >
                {creatingStation ? 'Salvando...' : 'Criar estação'}
              </button>
            </div>

            <StationFields
              draft={createStationDraft}
              onChange={(patch) => setCreateStationDraft((current) => ({ ...current, ...patch }))}
            />

            {createStationError ? (
              <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {createStationError}
              </p>
            ) : null}
          </section>

          <div className="space-y-4">
            {stationsLoading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <div className="h-40 animate-pulse rounded-2xl bg-white/5" key={`station-loading-${index}`} />
              ))
            ) : null}

            {!stationsLoading && stations.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-10 text-center text-sm text-slate-300">
                Nenhuma estação cadastrada.
              </div>
            ) : null}

            {!stationsLoading &&
              stations.map((station) => {
                const draft = stationDrafts[station.id] ?? toStationDraft(station)
                const saving = savingStationId === station.id
                const rowError = stationRowErrors[station.id]

                return (
                  <article
                    className="rounded-2xl border border-white/10 bg-white/5 p-4 text-slate-100"
                    key={station.id}
                  >
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-bold text-white">{station.name}</h3>
                        <p className="text-xs uppercase tracking-[0.18em] text-[#90cba4]">
                          {station.location_label || 'Sem local definido'}
                        </p>
                      </div>
                      <span
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                          station.is_active
                            ? 'border-primary/20 bg-primary/10 text-primary'
                            : 'border-slate-500/20 bg-slate-500/10 text-slate-300'
                        }`}
                      >
                        {station.is_active ? 'Ativa' : 'Inativa'}
                      </span>
                    </div>

                    <StationFields
                      draft={draft}
                      onChange={(patch) =>
                        setStationDrafts((current) => ({
                          ...current,
                          [station.id]: { ...(current[station.id] ?? draft), ...patch },
                        }))
                      }
                    />

                    {rowError ? (
                      <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                        {rowError}
                      </p>
                    ) : null}

                    <div className="mt-4 flex justify-end">
                      <button
                        className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-background-dark transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={saving}
                        onClick={() => {
                          void handleSaveStation(station.id)
                        }}
                        type="button"
                      >
                        {saving ? 'Salvando...' : 'Salvar alteracoes'}
                      </button>
                    </div>
                  </article>
                )
              })}
          </div>
        </section>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-secondary bg-surface-dark px-4 pb-6 pt-3">
        <div className="mx-auto flex w-full max-w-6xl justify-between items-end">
          <Link
            className="group flex flex-1 flex-col items-center justify-end gap-1 text-slate-400 transition-colors hover:text-slate-200"
            to="/admin/dashboard"
          >
            <div className="flex h-7 items-center justify-center transition-transform group-active:scale-95">
              <span className="material-symbols-outlined text-[26px]">monitoring</span>
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
          <Link className="group flex flex-1 flex-col items-center justify-end gap-1 text-primary" to="/admin/settings">
            <div className="relative flex h-7 items-center justify-center transition-transform group-active:scale-95">
              <span
                className="material-symbols-outlined text-[28px]"
                style={{ fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}
              >
                settings
              </span>
            </div>
            <p className="text-[10px] font-bold leading-normal tracking-[0.015em]">Configurações</p>
          </Link>
        </div>
      </nav>
    </div>
  )
}
