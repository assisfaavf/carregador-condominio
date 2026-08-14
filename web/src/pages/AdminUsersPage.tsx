import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, apiFetch } from '../api/client'

type ApprovalStatus = 'pending' | 'approved' | 'rejected'
type UserRole = 'morador' | 'visitante'

type AdminUser = {
  id: number
  name: string
  email: string
  role: UserRole | string | null
  is_admin: boolean
  approval_status: ApprovalStatus | string
  created_at: string | null
  last_login_at: string | null
}

type AdminAddress = {
  id: number
  label: string
  street: string | null
  number: string | null
  complement: string | null
  neighborhood: string | null
  city: string | null
  state: string | null
  zip: string | null
  is_default: boolean
  created_at: string | null
  updated_at: string | null
}

type UsersResponse = {
  success: boolean
  users: AdminUser[]
  total: number
  limit: number
  offset: number
}

type UpdateUserResponse = {
  success: boolean
  user: AdminUser
}

type UserAddressesResponse = {
  success: boolean
  addresses: AdminAddress[]
}

type AddressResponse = {
  success: boolean
  address: AdminAddress
}

type DeleteAddressResponse = {
  success: boolean
}

type UserFilters = {
  q: string
  role: '' | UserRole
  status: '' | ApprovalStatus
  limit: number
  offset: number
}

type AddressModalState = {
  user: AdminUser
  addresses: AdminAddress[]
}

type AddressDraft = {
  label: string
  street: string
  number: string
  complement: string
  neighborhood: string
  city: string
  state: string
  zip: string
  is_default: boolean
}

const DEFAULT_FILTERS: UserFilters = {
  q: '',
  role: '',
  status: '',
  limit: 50,
  offset: 0,
}

const EMPTY_ADDRESS_DRAFT: AddressDraft = {
  label: '',
  street: '',
  number: '',
  complement: '',
  neighborhood: '',
  city: '',
  state: '',
  zip: '',
  is_default: false,
}

const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'medium',
})

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.message.trim()) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function buildUsersQuery(filters: UserFilters) {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.role) params.set('role', filters.role)
  if (filters.q) params.set('q', filters.q)
  params.set('limit', String(filters.limit))
  params.set('offset', String(filters.offset))
  return params.toString()
}

function formatRole(role: string | null | undefined) {
  if (role === 'visitante') return 'Visitante'
  return 'Morador'
}

function formatStatus(status: string | null | undefined) {
  if (status === 'approved') return 'Aprovado'
  if (status === 'rejected') return 'Reprovado'
  return 'Pendente'
}

function formatCreatedAt(value: string | null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return dateFormatter.format(date)
}

function formatDateTime(value: string | null) {
  if (!value) return 'Nunca'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Nunca'
  return dateTimeFormatter.format(date)
}

function getStatusBadgeClass(status: string | null | undefined) {
  if (status === 'approved') return 'border-primary/20 bg-primary/10 text-primary'
  if (status === 'rejected') return 'border-red-500/20 bg-red-500/10 text-red-300'
  return 'border-amber-400/20 bg-amber-400/10 text-amber-200'
}

function getPendingCardClass(index: number) {
  return index % 2 === 0
    ? 'from-blue-400/15 via-surface-dark to-surface-dark'
    : 'from-cyan-400/15 via-surface-dark to-surface-dark'
}

function buildAddressDetails(address: AdminAddress) {
  const line1 = [address.street, address.number].filter(Boolean).join(', ')
  const line2 = [address.neighborhood, address.city, address.state].filter(Boolean).join(' - ')
  const line3 = [address.complement, address.zip].filter(Boolean).join(' | ')
  return [line1, line2, line3].filter(Boolean)
}

function toAddressDraft(address?: AdminAddress | null): AddressDraft {
  return {
    label: address?.label ?? '',
    street: address?.street ?? '',
    number: address?.number ?? '',
    complement: address?.complement ?? '',
    neighborhood: address?.neighborhood ?? '',
    city: address?.city ?? '',
    state: address?.state ?? '',
    zip: address?.zip ?? '',
    is_default: address?.is_default === true,
  }
}

function sanitizeAddressDraft(draft: AddressDraft) {
  return {
    label: draft.label.trim(),
    street: draft.street.trim() || null,
    number: draft.number.trim() || null,
    complement: draft.complement.trim() || null,
    neighborhood: draft.neighborhood.trim() || null,
    city: draft.city.trim() || null,
    state: draft.state.trim() || null,
    zip: draft.zip.trim() || null,
    is_default: draft.is_default,
  }
}

function AddressFields({
  draft,
  onChange,
}: {
  draft: AddressDraft
  onChange: (patch: Partial<AddressDraft>) => void
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="space-y-1 md:col-span-2">
        <span className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Rótulo</span>
        <input
          className="h-11 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ label: event.target.value })}
          value={draft.label}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Rua / Torre</span>
        <input
          className="h-11 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ street: event.target.value })}
          value={draft.street}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Número / Apto</span>
        <input
          className="h-11 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ number: event.target.value })}
          value={draft.number}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Complemento</span>
        <input
          className="h-11 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ complement: event.target.value })}
          value={draft.complement}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Bairro</span>
        <input
          className="h-11 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ neighborhood: event.target.value })}
          value={draft.neighborhood}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Cidade</span>
        <input
          className="h-11 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ city: event.target.value })}
          value={draft.city}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Estado</span>
        <input
          className="h-11 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ state: event.target.value })}
          value={draft.state}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">CEP</span>
        <input
          className="h-11 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
          onChange={(event) => onChange({ zip: event.target.value })}
          value={draft.zip}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-white">
        <input
          checked={draft.is_default}
          className="h-4 w-4 rounded border-white/30 bg-surface-dark text-primary focus:ring-primary/40"
          onChange={(event) => onChange({ is_default: event.target.checked })}
          type="checkbox"
        />
        Definir como principal
      </label>
    </div>
  )
}

function AddressModal({
  state,
  loading,
  errorMessage,
  onClose,
  isCreating,
  onStartCreate,
  onCancelCreate,
  creating,
  createError,
  createDraft,
  onCreateDraftChange,
  onCreate,
  editingAddressId,
  onStartEdit,
  onCancelEdit,
  editingDrafts,
  onEditDraftChange,
  onSaveEdit,
  savingAddressId,
  deletingAddressId,
  onDelete,
}: {
  state: AddressModalState | null
  loading: boolean
  errorMessage: string | null
  onClose: () => void
  isCreating: boolean
  onStartCreate: () => void
  onCancelCreate: () => void
  creating: boolean
  createError: string | null
  createDraft: AddressDraft
  onCreateDraftChange: (patch: Partial<AddressDraft>) => void
  onCreate: () => void
  editingAddressId: number | null
  onStartEdit: (addressId: number) => void
  onCancelEdit: () => void
  editingDrafts: Record<number, AddressDraft>
  onEditDraftChange: (addressId: number, patch: Partial<AddressDraft>) => void
  onSaveEdit: (addressId: number) => void
  savingAddressId: number | null
  deletingAddressId: number | null
  onDelete: (addressId: number) => void
}) {
  if (!state && !loading && !errorMessage) return null

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/70 p-4 backdrop-blur-sm md:items-center">
      <div className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-primary/20 bg-[#17213a] shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#9fb7e8]">
              Endereços do usuário
            </p>
            <h2 className="mt-1 text-2xl font-bold text-white">{state?.user.name || 'Carregando...'}</h2>
            <p className="mt-1 text-sm text-[#9fb7e8]">{state?.user.email || 'Consultando cadastro'}</p>
          </div>
          <button
            className="rounded-full border border-white/10 p-2 text-slate-300 transition hover:border-primary/30 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-slate-300">
              Carregando endereços...
            </div>
          ) : null}

          {!loading && errorMessage ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {errorMessage}
            </div>
          ) : null}

          {!loading && !errorMessage && state && state.addresses.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-slate-300">
              Nenhum endereço cadastrado para este usuário.
            </div>
          ) : null}

          {!loading && state ? (
            <section className="mb-4 rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-white">Novo endereço</h3>
                  <p className="text-xs text-[#9fb7e8]">Abra o formulário apenas quando precisar adicionar.</p>
                </div>
                {isCreating ? (
                  <div className="flex gap-2">
                    <button
                      className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                      disabled={creating}
                      onClick={onCancelCreate}
                      type="button"
                    >
                      Cancelar
                    </button>
                    <button
                      className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-background-dark transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={creating}
                      onClick={onCreate}
                      type="button"
                    >
                      {creating ? 'Salvando...' : 'Salvar endereço'}
                    </button>
                  </div>
                ) : (
                  <button
                    className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-background-dark transition hover:bg-primary/90"
                    onClick={onStartCreate}
                    type="button"
                  >
                    Adicionar endereço
                  </button>
                )}
              </div>
              {isCreating ? (
                <>
                  <AddressFields draft={createDraft} onChange={onCreateDraftChange} />
                  {createError ? (
                    <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                      {createError}
                    </p>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {!loading && !errorMessage && state && state.addresses.length > 0 ? (
            <div className="space-y-3">
              {state.addresses.map((address) => {
                const details = buildAddressDetails(address)
                const draft = editingDrafts[address.id] ?? toAddressDraft(address)
                const savingThis = savingAddressId === address.id
                const deletingThis = deletingAddressId === address.id
                const editingThis = editingAddressId === address.id
                return (
                  <article
                    className="rounded-2xl border border-white/10 bg-white/5 p-4 text-slate-100"
                    key={address.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-base font-bold">{address.label}</h3>
                        <p className="text-xs text-[#9fb7e8]">
                          Atualizado em {formatDateTime(address.updated_at)}
                        </p>
                      </div>
                      {address.is_default ? (
                        <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                          Principal
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-4 space-y-1 text-sm text-slate-300">
                      {details.length > 0 ? (
                        details.map((detail) => <p key={`${address.id}-${detail}`}>{detail}</p>)
                      ) : (
                        <p>Endereço sem detalhes adicionais.</p>
                      )}
                    </div>

                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                      {editingThis ? (
                        <button
                          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                          disabled={savingThis || deletingThis}
                          onClick={onCancelEdit}
                          type="button"
                        >
                          Cancelar
                        </button>
                      ) : (
                        <button
                          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={deletingThis}
                          onClick={() => onStartEdit(address.id)}
                          type="button"
                        >
                          Editar
                        </button>
                      )}
                      <button
                        className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={savingThis || deletingThis}
                        onClick={() => onDelete(address.id)}
                        type="button"
                      >
                        {deletingThis ? 'Removendo...' : 'Excluir'}
                      </button>
                    </div>

                    {editingThis ? (
                      <div className="mt-4 rounded-2xl border border-white/30 bg-surface-dark/70 p-4">
                        <AddressFields
                          draft={draft}
                          onChange={(patch) => onEditDraftChange(address.id, patch)}
                        />
                        <div className="mt-4 flex flex-wrap justify-end gap-2">
                          <button
                            className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-background-dark transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={savingThis || deletingThis}
                            onClick={() => onSaveEdit(address.id)}
                            type="button"
                          >
                            {savingThis ? 'Salvando...' : 'Salvar alterações'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default function AdminUsersPage() {
  const [filters, setFilters] = useState<UserFilters>(DEFAULT_FILTERS)
  const [searchInput, setSearchInput] = useState('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [pendingCount, setPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState<string | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [savingById, setSavingById] = useState<Record<number, boolean>>({})
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})
  const [addressModal, setAddressModal] = useState<AddressModalState | null>(null)
  const [loadingAddresses, setLoadingAddresses] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [createAddressDraft, setCreateAddressDraft] = useState<AddressDraft>(EMPTY_ADDRESS_DRAFT)
  const [createAddressError, setCreateAddressError] = useState<string | null>(null)
  const [creatingAddress, setCreatingAddress] = useState(false)
  const [isCreatingAddress, setIsCreatingAddress] = useState(false)
  const [editingAddressDrafts, setEditingAddressDrafts] = useState<Record<number, AddressDraft>>({})
  const [editingAddressId, setEditingAddressId] = useState<number | null>(null)
  const [savingAddressId, setSavingAddressId] = useState<number | null>(null)
  const [deletingAddressId, setDeletingAddressId] = useState<number | null>(null)

  const pendingPreview = useMemo(
    () => users.filter((user) => user.approval_status === 'pending').slice(0, 2),
    [users],
  )

  const totalPages = Math.max(1, Math.ceil(total / filters.limit))
  const currentPage = Math.floor(filters.offset / filters.limit) + 1
  const showingFrom = total === 0 ? 0 : filters.offset + 1
  const showingTo = Math.min(filters.offset + users.length, total)

  const loadUsers = useCallback(
    async (signal?: AbortSignal, showLoading = true) => {
      if (showLoading) {
        setLoading(true)
      }

      try {
        const response = await apiFetch<UsersResponse>(`/api/admin/users?${buildUsersQuery(filters)}`, {
          signal,
        })

        if (signal?.aborted) return
        setUsers(Array.isArray(response.users) ? response.users : [])
        setTotal(Number(response.total || 0))
        setPageError(null)
      } catch (error) {
        if (signal?.aborted) return
        setPageError(getErrorMessage(error, 'Não foi possível carregar os usuários.'))
      } finally {
        if (!signal?.aborted) {
          setLoading(false)
        }
      }
    },
    [filters],
  )

  const loadPendingCount = useCallback(async () => {
    try {
      const response = await apiFetch<UsersResponse>('/api/admin/users?status=pending&limit=1&offset=0')
      setPendingCount(Number(response.total || 0))
    } catch {
      setPendingCount(0)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadUsers(controller.signal)
    void loadPendingCount()
    return () => controller.abort()
  }, [loadPendingCount, loadUsers])

  const refreshUsers = useCallback(async () => {
    await loadUsers(undefined, false)
    await loadPendingCount()
  }, [loadPendingCount, loadUsers])

  const updateUser = useCallback(
    async (
      userId: number,
      payload: Partial<Pick<AdminUser, 'name' | 'role' | 'is_admin' | 'approval_status'>>,
      successMessage: string,
    ) => {
      setSavingById((current) => ({ ...current, [userId]: true }))
      setRowErrors((current) => ({ ...current, [userId]: '' }))

      try {
        await apiFetch<UpdateUserResponse>(`/api/admin/users/${userId}`, {
          method: 'PATCH',
          body: payload,
        })

        setFeedbackMessage(successMessage)
        await refreshUsers()
      } catch (error) {
        setRowErrors((current) => ({
          ...current,
          [userId]: getErrorMessage(error, 'Não foi possível salvar esta linha.'),
        }))
      } finally {
        setSavingById((current) => ({ ...current, [userId]: false }))
      }
    },
    [refreshUsers],
  )

  const handleSearchSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedbackMessage(null)
    setFilters((current) => ({
      ...current,
      q: searchInput.trim(),
      offset: 0,
    }))
  }

  const syncAddressDrafts = useCallback((addresses: AdminAddress[]) => {
    setEditingAddressDrafts(
      Object.fromEntries(addresses.map((address) => [address.id, toAddressDraft(address)])),
    )
  }, [])

  const setAddressModalState = useCallback(
    (user: AdminUser, addresses: AdminAddress[]) => {
      setAddressModal({ user, addresses })
      syncAddressDrafts(addresses)
    },
    [syncAddressDrafts],
  )

  const loadAddressesForUser = useCallback(
    async (user: AdminUser) => {
      const response = await apiFetch<UserAddressesResponse>(`/api/admin/users/${user.id}/addresses`)
      const addresses = Array.isArray(response.addresses) ? response.addresses : []
      setAddressModalState(user, addresses)
      return addresses
    },
    [setAddressModalState],
  )

  const openAddressModal = async (user: AdminUser) => {
    setAddressModal({ user, addresses: [] })
    setLoadingAddresses(true)
    setAddressError(null)
    setCreateAddressDraft(EMPTY_ADDRESS_DRAFT)
    setCreateAddressError(null)
    setIsCreatingAddress(false)
    setEditingAddressId(null)

    try {
      await loadAddressesForUser(user)
    } catch (error) {
      setAddressError(getErrorMessage(error, 'Não foi possível carregar os endereços.'))
    } finally {
      setLoadingAddresses(false)
    }
  }

  const handleCreateAddress = useCallback(async () => {
    if (!addressModal?.user) return

    setCreatingAddress(true)
    setCreateAddressError(null)
    try {
      await apiFetch<AddressResponse>(`/api/admin/users/${addressModal.user.id}/addresses`, {
        method: 'POST',
        body: sanitizeAddressDraft(createAddressDraft),
      })
      setFeedbackMessage('Endereço adicionado.')
      setCreateAddressDraft(EMPTY_ADDRESS_DRAFT)
      setIsCreatingAddress(false)
      await loadAddressesForUser(addressModal.user)
    } catch (error) {
      setCreateAddressError(getErrorMessage(error, 'Não foi possível adicionar o endereço.'))
    } finally {
      setCreatingAddress(false)
    }
  }, [addressModal?.user, createAddressDraft, loadAddressesForUser])

  const handleSaveAddress = useCallback(
    async (addressId: number) => {
      const draft = editingAddressDrafts[addressId]
      if (!draft || !addressModal?.user) return

      setSavingAddressId(addressId)
      setAddressError(null)
      try {
        await apiFetch<AddressResponse>(`/api/admin/addresses/${addressId}`, {
          method: 'PATCH',
          body: sanitizeAddressDraft(draft),
        })
        setFeedbackMessage('Endereço atualizado.')
        setEditingAddressId(null)
        await loadAddressesForUser(addressModal.user)
      } catch (error) {
        setAddressError(getErrorMessage(error, 'Não foi possível atualizar o endereço.'))
      } finally {
        setSavingAddressId(null)
      }
    },
    [addressModal?.user, editingAddressDrafts, loadAddressesForUser],
  )

  const handleDeleteAddress = useCallback(
    async (addressId: number) => {
      if (!addressModal?.user) return

      setDeletingAddressId(addressId)
      setAddressError(null)
      try {
        await apiFetch<DeleteAddressResponse>(`/api/admin/addresses/${addressId}`, {
          method: 'DELETE',
        })
        setFeedbackMessage('Endereço removido.')
        await loadAddressesForUser(addressModal.user)
      } catch (error) {
        setAddressError(getErrorMessage(error, 'Não foi possível remover o endereço.'))
      } finally {
        setDeletingAddressId(null)
      }
    },
    [addressModal?.user, loadAddressesForUser],
  )

  return (
    <div className="bg-background-light font-display text-slate-900 antialiased selection:bg-primary selection:text-background-dark dark:bg-background-dark dark:text-slate-100">
      <main className="mx-auto w-full max-w-6xl space-y-6 px-4 pb-28 pt-6">
        <section className="relative overflow-hidden rounded-[32px] border border-primary/15 bg-[radial-gradient(circle_at_top_left,_rgba(37,89,244,0.18),_transparent_35%),linear-gradient(135deg,_rgba(23,33,58,1),_rgba(15,23,42,1))] p-6 shadow-[0_20px_80px_rgba(0,0,0,0.28)]">
          <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute bottom-0 right-0 h-36 w-36 rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="relative z-10">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#9fb7e8]">
                  Gestão de usuários
                </p>
                <h1 className="mt-2 text-3xl font-bold tracking-tight text-white md:text-4xl">
                  Aprovar, classificar e acompanhar acessos
                </h1>
                <p className="mt-3 max-w-2xl text-sm text-[#dbe7ff]">
                  Pendentes aparecem primeiro. Filtros, busca e ações por linha atualizam sem travar a tela.
                </p>
              </div>

              <div className="grid min-w-[220px] grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Pendentes</p>
                  <p className="mt-2 text-3xl font-bold text-white">{pendingCount}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Usuários</p>
                  <p className="mt-2 text-3xl font-bold text-white">{total}</p>
                </div>
              </div>
            </div>

            <div className="mt-6 flex border-b border-white/10">
              <button
                className={`flex-1 border-b-2 px-4 pb-3 text-sm font-semibold transition-colors ${
                  filters.status === 'pending'
                    ? 'border-primary text-white'
                    : 'border-transparent text-[#9fb7e8] hover:text-white'
                }`}
                onClick={() => {
                  setFeedbackMessage(null)
                  setFilters((current) => ({ ...current, status: 'pending', offset: 0 }))
                }}
                type="button"
              >
                Solicitações
                <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-background-dark">
                  {pendingCount}
                </span>
              </button>
              <button
                className={`flex-1 border-b-2 px-4 pb-3 text-sm font-semibold transition-colors ${
                  filters.status === ''
                    ? 'border-primary text-white'
                    : 'border-transparent text-[#9fb7e8] hover:text-white'
                }`}
                onClick={() => {
                  setFeedbackMessage(null)
                  setFilters((current) => ({ ...current, status: '', offset: 0 }))
                }}
                type="button"
              >
                Lista de usuários
              </button>
            </div>
          </div>
        </section>

        {feedbackMessage ? (
          <div className="rounded-2xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-primary">
            {feedbackMessage}
          </div>
        ) : null}

        {pageError ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {pageError}
          </div>
        ) : null}

        {pendingPreview.length > 0 ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">Aprovações pendentes</h2>
                <p className="text-sm text-slate-400">Atalhos para as solicitações mais recentes.</p>
              </div>
              {filters.status !== 'pending' ? (
                <button
                  className="text-sm font-semibold text-primary transition hover:text-primary/80"
                  onClick={() => setFilters((current) => ({ ...current, status: 'pending', offset: 0 }))}
                  type="button"
                >
                  Ver todas
                </button>
              ) : null}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {pendingPreview.map((user, index) => {
                const saving = savingById[user.id] === true
                const rowError = rowErrors[user.id]
                return (
                  <article
                    className={`overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-br p-5 shadow-lg ${getPendingCardClass(index)}`}
                    key={user.id}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-xl font-bold text-white">
                          {user.name
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((part) => part[0]?.toUpperCase() ?? '')
                            .join('') || 'U'}
                        </div>
                        <div>
                          <h3 className="text-xl font-bold text-white">{user.name}</h3>
                          <p className="mt-1 text-sm text-[#dbe7ff]">{user.email}</p>
                          <p className="mt-2 text-xs uppercase tracking-[0.22em] text-[#9fb7e8]">
                            Cadastro em {formatCreatedAt(user.created_at)}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`rounded-full border px-3 py-1 text-xs font-semibold ${getStatusBadgeClass(user.approval_status)}`}
                      >
                        {formatStatus(user.approval_status)}
                      </span>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-3 text-sm text-slate-200">
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Perfil</p>
                        <p className="mt-2 font-semibold">{formatRole(user.role)}</p>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <p className="text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">Último login</p>
                        <p className="mt-2 font-semibold">{formatDateTime(user.last_login_at)}</p>
                      </div>
                    </div>

                    {rowError ? (
                      <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                        {rowError}
                      </p>
                    ) : null}

                    <div className="mt-5 flex flex-wrap gap-3">
                      <button
                        className="flex-1 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-semibold text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={saving}
                        onClick={() => {
                          void updateUser(user.id, { approval_status: 'rejected' }, 'Usuário reprovado.')
                        }}
                        type="button"
                      >
                        {saving ? 'Salvando...' : 'Reprovar'}
                      </button>
                      <button
                        className="flex-1 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-background-dark transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={saving}
                        onClick={() => {
                          void updateUser(user.id, { approval_status: 'approved' }, 'Usuário aprovado.')
                        }}
                        type="button"
                      >
                        {saving ? 'Salvando...' : 'Aprovar'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ) : null}

        <section className="rounded-[32px] border border-white/10 bg-surface-dark/95 p-5 shadow-[0_16px_60px_rgba(0,0,0,0.28)]">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-white">Lista de usuários</h2>
              <p className="text-sm text-slate-400">
                {loading ? 'Carregando usuários...' : `Mostrando ${showingFrom}-${showingTo} de ${total}`}
              </p>
            </div>

            <form className="flex w-full max-w-xl flex-col gap-3 md:flex-row" onSubmit={handleSearchSubmit}>
              <label className="relative flex-1">
                <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">
                  search
                </span>
                <input
                  className="h-12 w-full rounded-2xl border border-white/30 bg-surface-dark pl-12 pr-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-primary/40"
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Buscar por nome ou email"
                  type="search"
                  value={searchInput}
                />
              </label>

              <select
                className="h-12 rounded-2xl border border-white/30 bg-surface-dark px-4 text-sm text-white outline-none transition focus:border-primary/40"
                onChange={(event) => {
                  setFilters((current) => ({
                    ...current,
                    role: event.target.value as UserFilters['role'],
                    offset: 0,
                  }))
                }}
                value={filters.role}
              >
                <option value="">Todos os perfis</option>
                <option value="morador">Morador</option>
                <option value="visitante">Visitante</option>
              </select>

              <select
                className="h-12 rounded-2xl border border-white/30 bg-surface-dark px-4 text-sm text-white outline-none transition focus:border-primary/40"
                onChange={(event) => {
                  setFilters((current) => ({
                    ...current,
                    status: event.target.value as UserFilters['status'],
                    offset: 0,
                  }))
                }}
                value={filters.status}
              >
                <option value="">Todos os status</option>
                <option value="pending">Pendentes</option>
                <option value="approved">Aprovados</option>
                <option value="rejected">Reprovados</option>
              </select>

              <button
                className="h-12 rounded-2xl bg-primary px-5 text-sm font-bold text-background-dark transition hover:bg-primary/90"
                type="submit"
              >
                Buscar
              </button>
            </form>
          </div>

          <div className="mt-5 overflow-hidden rounded-[24px] border border-white/10 lg:overflow-x-auto">
            <div className="lg:min-w-[1160px]">
              <div className="hidden grid-cols-[minmax(180px,1.4fr)_minmax(220px,1.6fr)_120px_120px_120px_340px] gap-4 bg-[#0f172a] px-5 py-4 text-xs font-semibold uppercase tracking-[0.18em] text-[#9fb7e8] lg:grid">
                <span>Nome</span>
                <span>E-mail</span>
                <span>Perfil</span>
                <span>Status</span>
                <span>Último login</span>
                <span>Ações</span>
              </div>

              {loading ? (
                <div className="space-y-3 bg-[#17213a] p-4">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div
                      className="h-24 animate-pulse rounded-2xl bg-white/5"
                      key={`loading-row-${index}`}
                    />
                  ))}
                </div>
              ) : null}

              {!loading && users.length === 0 ? (
                <div className="bg-[#17213a] px-4 py-12 text-center text-sm text-slate-300">
                Nenhum usuário encontrado com os filtros atuais.
                </div>
              ) : null}

              {!loading && users.length > 0 ? (
                <div className="divide-y divide-white/10 bg-[#17213a]">
                  {users.map((user) => {
                    const saving = savingById[user.id] === true
                    const rowError = rowErrors[user.id]
                    return (
                      <article
                        className="px-4 py-4 transition hover:bg-white/[0.03] lg:px-5"
                        key={user.id}
                      >
                        <div className="grid gap-4 lg:grid-cols-[minmax(180px,1.4fr)_minmax(220px,1.6fr)_120px_120px_120px_340px] lg:items-center">
                          <div>
                            <p className="text-base font-bold text-white">{user.name}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-[#9fb7e8]">
                              Criado em {formatCreatedAt(user.created_at)}
                            </p>
                          </div>

                          <div className="text-sm text-slate-300">{user.email}</div>

                          <div>
                            <select
                              className="h-10 w-full rounded-xl border border-white/30 bg-surface-dark px-3 text-sm text-white outline-none transition focus:border-primary/40"
                              disabled={saving}
                              onChange={(event) => {
                                void updateUser(
                                  user.id,
                                  { role: event.target.value as UserRole },
                                  'Perfil do usuário atualizado.',
                                )
                              }}
                              value={user.role ?? 'morador'}
                            >
                              <option value="morador">Morador</option>
                              <option value="visitante">Visitante</option>
                            </select>
                          </div>

                          <div>
                            <span
                              className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${getStatusBadgeClass(user.approval_status)}`}
                            >
                              {formatStatus(user.approval_status)}
                            </span>
                          </div>

                          <div className="text-sm text-slate-300">{formatDateTime(user.last_login_at)}</div>

                          <div className="grid grid-cols-2 gap-2">
                            <button
                              className="w-full rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-center text-xs font-semibold text-primary transition hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={saving || user.approval_status === 'approved'}
                              onClick={() => {
                                void updateUser(user.id, { approval_status: 'approved' }, 'Usuário aprovado.')
                              }}
                              type="button"
                            >
                              Aprovar
                            </button>
                            <button
                              className="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-center text-xs font-semibold text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={saving || user.approval_status === 'rejected'}
                              onClick={() => {
                                void updateUser(user.id, { approval_status: 'rejected' }, 'Usuário reprovado.')
                              }}
                              type="button"
                            >
                              Reprovar
                            </button>
                            <button
                              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center text-xs font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={saving}
                              onClick={() => {
                                void updateUser(
                                  user.id,
                                  { is_admin: !user.is_admin },
                                  user.is_admin ? 'Acesso de admin removido.' : 'Usuário promovido a admin.',
                                )
                              }}
                              type="button"
                            >
                              {user.is_admin ? 'Remover admin' : 'Tornar admin'}
                            </button>
                            <button
                              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center text-xs font-semibold text-white transition hover:bg-white/10"
                              onClick={() => {
                                void openAddressModal(user)
                              }}
                              type="button"
                            >
                              Ver endereços
                            </button>
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                          {saving ? <span className="text-primary">Salvando...</span> : null}
                          {user.is_admin ? (
                            <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2.5 py-1 font-semibold text-cyan-200">
                              Admin
                            </span>
                          ) : null}
                          <span className="text-slate-400">Perfil atual: {formatRole(user.role)}</span>
                        </div>

                        {rowError ? (
                          <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                            {rowError}
                          </p>
                        ) : null}
                      </article>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
            <p>
              Página {currentPage} de {totalPages}
            </p>
            <div className="flex gap-2">
              <button
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={filters.offset === 0 || loading}
                onClick={() => {
                  setFilters((current) => ({
                    ...current,
                    offset: Math.max(0, current.offset - current.limit),
                  }))
                }}
                type="button"
              >
                Anterior
              </button>
              <button
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={loading || filters.offset + filters.limit >= total}
                onClick={() => {
                  setFilters((current) => ({
                    ...current,
                    offset: current.offset + current.limit,
                  }))
                }}
                type="button"
              >
                Próxima
              </button>
            </div>
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
            <p className="text-[10px] font-medium leading-normal tracking-[0.015em]">Home</p>
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
          <Link className="group flex flex-1 flex-col items-center justify-end gap-1 text-primary" to="/admin/users">
            <div className="relative flex h-7 items-center justify-center transition-transform group-active:scale-95">
              <span
                className="material-symbols-outlined text-[28px]"
                style={{ fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}
              >
                group
              </span>
            </div>
            <p className="text-[10px] font-bold leading-normal tracking-[0.015em]">Usuários</p>
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

      <AddressModal
        createDraft={createAddressDraft}
        createError={createAddressError}
        creating={creatingAddress}
        deletingAddressId={deletingAddressId}
        editingAddressId={editingAddressId}
        editingDrafts={editingAddressDrafts}
        errorMessage={addressError}
        isCreating={isCreatingAddress}
        loading={loadingAddresses}
        onCreate={() => {
          void handleCreateAddress()
        }}
        onCreateDraftChange={(patch) => {
          setCreateAddressDraft((current) => ({ ...current, ...patch }))
        }}
        onCancelCreate={() => {
          if (creatingAddress) return
          setIsCreatingAddress(false)
          setCreateAddressDraft(EMPTY_ADDRESS_DRAFT)
          setCreateAddressError(null)
        }}
        onClose={() => {
          if (loadingAddresses) return
          setAddressModal(null)
          setAddressError(null)
          setCreateAddressDraft(EMPTY_ADDRESS_DRAFT)
          setCreateAddressError(null)
          setIsCreatingAddress(false)
          setEditingAddressId(null)
          setEditingAddressDrafts({})
        }}
        onDelete={(addressId) => {
          void handleDeleteAddress(addressId)
        }}
        onCancelEdit={() => {
          if (savingAddressId != null) return
          setEditingAddressId(null)
          if (addressModal) {
            syncAddressDrafts(addressModal.addresses)
          }
        }}
        onEditDraftChange={(addressId, patch) => {
          setEditingAddressDrafts((current) => ({
            ...current,
            [addressId]: {
              ...(current[addressId] ?? EMPTY_ADDRESS_DRAFT),
              ...patch,
            },
          }))
        }}
        onSaveEdit={(addressId) => {
          void handleSaveAddress(addressId)
        }}
        onStartCreate={() => {
          setEditingAddressId(null)
          setCreateAddressError(null)
          setCreateAddressDraft(EMPTY_ADDRESS_DRAFT)
          setIsCreatingAddress(true)
        }}
        onStartEdit={(addressId) => {
          setIsCreatingAddress(false)
          setCreateAddressError(null)
          setEditingAddressId(addressId)
        }}
        savingAddressId={savingAddressId}
        state={addressModal}
      />
    </div>
  )
}
