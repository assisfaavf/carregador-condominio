import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, apiFetch } from '../api/client'
import { useAuth } from '../auth/AuthProvider'

type Address = {
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
}

type AddressesResponse = {
  success: boolean
  addresses: Address[]
}

type AddressResponse = {
  success: boolean
  address: Address
}

type ProfileResponse = {
  success: boolean
  user: {
    id: number
    name: string
    email: string
    cpf?: string | null
    role?: string | null
    tower?: string | null
    apartment?: string | null
    approval_status?: string | null
  }
}

type PasswordResponse = {
  success: boolean
  message?: string
}

type ProfileDraft = {
  name: string
  email: string
  cpf: string
  tower: string
  apartment: string
}

type AddressDraft = {
  id: number | null
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

type PasswordDraft = {
  current_password: string
  new_password: string
  confirm_password: string
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.message.trim()) return error.message
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function onlyDigits(value: string) {
  return value.replace(/\D/g, '')
}

function formatCpf(value: string | null | undefined) {
  const digits = onlyDigits(String(value || '')).slice(0, 11)
  return digits
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4')
}

function toProfileDraft(user: ProfileResponse['user'] | null | undefined): ProfileDraft {
  return {
    name: user?.name ?? '',
    email: user?.email ?? '',
    cpf: formatCpf(user?.cpf),
    tower: user?.tower ?? '',
    apartment: user?.apartment ?? '',
  }
}

function toAddressDraft(address?: Address | null): AddressDraft {
  return {
    id: address?.id ?? null,
    label: address?.label ?? '',
    street: address?.street ?? '',
    number: address?.number ?? '',
    complement: address?.complement ?? '',
    neighborhood: address?.neighborhood ?? '',
    city: address?.city ?? '',
    state: address?.state ?? '',
    zip: address?.zip ?? '',
    is_default: address?.is_default ?? false,
  }
}

function formatAddressTitle(address: Address) {
  const street = String(address.street || '').trim()
  const number = String(address.number || '').trim()
  if (street && number) return `${street} - Apt ${number}`
  if (street) return street
  return address.label
}

function formatAddressSubtitle(address: Address) {
  return [address.neighborhood, address.city, address.state].filter(Boolean).join(' - ') || 'Unidade cadastrada'
}

function normalizeProfilePayload(draft: ProfileDraft) {
  return {
    name: draft.name.trim(),
    email: draft.email.trim().toLowerCase(),
    cpf: onlyDigits(draft.cpf),
    tower: draft.tower.trim().toLowerCase(),
    apartment: draft.apartment.trim(),
  }
}

function normalizeAddressPayload(draft: AddressDraft) {
  return {
    label: draft.label.trim(),
    street: draft.street.trim(),
    number: draft.number.trim(),
    complement: draft.complement.trim(),
    neighborhood: draft.neighborhood.trim(),
    city: draft.city.trim(),
    state: draft.state.trim(),
    zip: draft.zip.trim(),
    is_default: draft.is_default,
  }
}

const emptyPasswordDraft: PasswordDraft = {
  current_password: '',
  new_password: '',
  confirm_password: '',
}

export default function UserProfilePage() {
  const navigate = useNavigate()
  const { user, refreshMe, signOut } = useAuth()

  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(() => toProfileDraft(user))
  const [addresses, setAddresses] = useState<Address[]>([])
  const [addressDraft, setAddressDraft] = useState<AddressDraft>(() => toAddressDraft())
  const [passwordDraft, setPasswordDraft] = useState<PasswordDraft>(emptyPasswordDraft)
  const [editingAddressId, setEditingAddressId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingAddress, setSavingAddress] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setProfileDraft(toProfileDraft(user))
  }, [user])

  const loadAddresses = useCallback(async () => {
    setLoading(true)
    setErrorMessage(null)
    try {
      const response = await apiFetch<AddressesResponse>('/api/my/addresses')
      setAddresses(response.addresses ?? [])
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Nao foi possivel carregar suas unidades.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAddresses()
  }, [loadAddresses])

  const defaultAddress = useMemo(
    () => addresses.find((address) => address.is_default) ?? addresses[0] ?? null,
    [addresses],
  )

  const handleSaveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const payload = normalizeProfilePayload(profileDraft)

    if (!payload.name) {
      setErrorMessage('Informe seu nome.')
      return
    }
    if (!payload.email) {
      setErrorMessage('Informe seu email.')
      return
    }
    if (payload.cpf && payload.cpf.length !== 11) {
      setErrorMessage('CPF deve ter 11 numeros.')
      return
    }

    setSavingProfile(true)
    setMessage(null)
    setErrorMessage(null)
    try {
      const response = await apiFetch<ProfileResponse>('/api/me', {
        method: 'PATCH',
        body: payload,
      })
      setProfileDraft(toProfileDraft(response.user))
      await refreshMe()
      setMessage('Perfil atualizado.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Nao foi possivel salvar seu perfil.'))
    } finally {
      setSavingProfile(false)
    }
  }

  const handleSaveAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const payload = normalizeAddressPayload(addressDraft)

    if (!payload.label) {
      setErrorMessage('Informe um nome para a unidade.')
      return
    }

    setSavingAddress(true)
    setMessage(null)
    setErrorMessage(null)
    try {
      if (addressDraft.id) {
        await apiFetch<AddressResponse>(`/api/my/addresses/${addressDraft.id}`, {
          method: 'PATCH',
          body: payload,
        })
        setMessage('Unidade atualizada.')
      } else {
        await apiFetch<AddressResponse>('/api/my/addresses', {
          method: 'POST',
          body: payload,
        })
        setMessage('Unidade adicionada.')
      }

      setAddressDraft(toAddressDraft())
      setEditingAddressId(null)
      await loadAddresses()
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Nao foi possivel salvar a unidade.'))
    } finally {
      setSavingAddress(false)
    }
  }

  const handleDeleteAddress = async (addressId: number) => {
    if (!window.confirm('Remover esta unidade do perfil?')) return

    setMessage(null)
    setErrorMessage(null)
    try {
      await apiFetch<{ success: boolean }>(`/api/my/addresses/${addressId}`, {
        method: 'DELETE',
      })
      if (editingAddressId === addressId) {
        setAddressDraft(toAddressDraft())
        setEditingAddressId(null)
      }
      await loadAddresses()
      setMessage('Unidade removida.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Nao foi possivel remover a unidade.'))
    }
  }

  const handleSetDefaultAddress = async (address: Address) => {
    setMessage(null)
    setErrorMessage(null)
    try {
      await apiFetch<AddressResponse>(`/api/my/addresses/${address.id}`, {
        method: 'PATCH',
        body: { is_default: true },
      })
      await loadAddresses()
      setMessage('Unidade principal atualizada.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Nao foi possivel definir a unidade principal.'))
    }
  }

  const handleChangePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (passwordDraft.new_password.length < 8) {
      setErrorMessage('Nova senha deve ter no minimo 8 caracteres.')
      return
    }
    if (passwordDraft.new_password !== passwordDraft.confirm_password) {
      setErrorMessage('Confirmacao de senha nao confere.')
      return
    }

    setSavingPassword(true)
    setMessage(null)
    setErrorMessage(null)
    try {
      const response = await apiFetch<PasswordResponse>('/api/me/password', {
        method: 'PATCH',
        body: {
          current_password: passwordDraft.current_password,
          new_password: passwordDraft.new_password,
        },
      })
      setPasswordDraft(emptyPasswordDraft)
      setMessage(response.message || 'Senha atualizada.')
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Nao foi possivel alterar sua senha.'))
    } finally {
      setSavingPassword(false)
    }
  }

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await signOut()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  const startEditingAddress = (address: Address) => {
    setEditingAddressId(address.id)
    setAddressDraft(toAddressDraft(address))
  }

  const cancelAddressEditing = () => {
    setEditingAddressId(null)
    setAddressDraft(toAddressDraft())
  }

  return (
    <div className="min-h-screen bg-background-light font-display text-slate-900 antialiased selection:bg-primary selection:text-background-dark dark:bg-background-dark dark:text-white">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-background-light px-4 py-3 dark:border-white/10 dark:bg-background-dark">
        <Link
          className="flex h-10 w-10 items-center justify-center rounded-full text-slate-900 transition-colors hover:bg-black/5 dark:text-white dark:hover:bg-white/10"
          to="/app/home"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <h2 className="text-lg font-bold">Perfil</h2>
        <div className="w-10" />
      </div>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-4 pb-28 pt-8">
        <section className="flex flex-col items-center">
          <div className="flex h-28 w-28 items-center justify-center rounded-full border-2 border-primary bg-primary/10 text-4xl font-bold text-primary shadow-lg shadow-primary/20">
            {(profileDraft.name || user?.email || '?').trim().charAt(0).toUpperCase()}
          </div>
          <h1 className="mt-4 text-center text-2xl font-bold">{profileDraft.name || 'Usuario'}</h1>
          <p className="text-center text-sm text-slate-500 dark:text-slate-400">{profileDraft.email}</p>
          <p className="mt-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-primary">
            {user?.approval_status === 'approved' ? 'Aprovado' : user?.approval_status || 'Cadastro'}
          </p>
        </section>

        {message ? (
          <section className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm font-semibold text-primary">
            {message}
          </section>
        ) : null}

        {errorMessage ? (
          <section className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm font-semibold text-danger">
            {errorMessage}
          </section>
        ) : null}

        <form className="space-y-4" onSubmit={handleSaveProfile}>
          <h3 className="ml-1 text-sm font-semibold uppercase tracking-wider text-primary">Dados Pessoais</h3>
          <div className="space-y-4 rounded-xl border border-slate-100 bg-white p-4 shadow-sm dark:border-white/5 dark:bg-surface-dark">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Nome Completo</span>
              <input
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                onChange={(event) => setProfileDraft((draft) => ({ ...draft, name: event.target.value }))}
                value={profileDraft.name}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Email</span>
              <input
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                onChange={(event) => setProfileDraft((draft) => ({ ...draft, email: event.target.value }))}
                type="email"
                value={profileDraft.email}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">CPF</span>
              <input
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                inputMode="numeric"
                onChange={(event) => setProfileDraft((draft) => ({ ...draft, cpf: formatCpf(event.target.value) }))}
                value={profileDraft.cpf}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Torre principal</span>
                <input
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                  onChange={(event) => setProfileDraft((draft) => ({ ...draft, tower: event.target.value }))}
                  value={profileDraft.tower}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Apartamento</span>
                <input
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                  onChange={(event) => setProfileDraft((draft) => ({ ...draft, apartment: event.target.value }))}
                  value={profileDraft.apartment}
                />
              </label>
            </div>
            <button
              className="h-12 w-full rounded-xl bg-primary font-bold text-background-dark transition-opacity disabled:cursor-not-allowed disabled:opacity-70"
              disabled={savingProfile}
              type="submit"
            >
              {savingProfile ? 'Salvando...' : 'Salvar dados'}
            </button>
          </div>
        </form>

        <section className="space-y-3">
          <div className="ml-1 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Minhas Unidades</h3>
            <button
              className="flex items-center gap-1 text-xs font-bold text-primary hover:text-primary/80"
              onClick={cancelAddressEditing}
              type="button"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              Adicionar
            </button>
          </div>

          {loading ? (
            <div className="rounded-xl border border-white/5 bg-surface-dark p-4 text-sm text-slate-300">
              Carregando unidades...
            </div>
          ) : null}

          {!loading && addresses.length === 0 ? (
            <div className="rounded-xl border border-white/5 bg-surface-dark p-4 text-sm text-slate-300">
              Nenhuma unidade cadastrada.
            </div>
          ) : null}

          {addresses.map((address) => (
            <article
              className={`flex items-center justify-between gap-3 rounded-xl border bg-white p-4 shadow-sm dark:bg-surface-dark ${
                address.is_default ? 'border-primary/50 dark:border-primary/50' : 'border-slate-100 dark:border-white/5'
              }`}
              key={address.id}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <span className="material-symbols-outlined filled">apartment</span>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold">{formatAddressTitle(address)}</p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">{formatAddressSubtitle(address)}</p>
                  {address.is_default ? <p className="mt-1 text-[11px] font-bold text-primary">Principal</p> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!address.is_default ? (
                  <button
                    className="p-2 text-slate-400 transition-colors hover:text-primary"
                    onClick={() => {
                      void handleSetDefaultAddress(address)
                    }}
                    title="Definir como principal"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[20px]">star</span>
                  </button>
                ) : null}
                <button
                  className="p-2 text-slate-400 transition-colors hover:text-primary"
                  onClick={() => startEditingAddress(address)}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[20px]">edit</span>
                </button>
                <button
                  className="p-2 text-slate-400 transition-colors hover:text-red-500"
                  onClick={() => {
                    void handleDeleteAddress(address.id)
                  }}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[20px]">delete</span>
                </button>
              </div>
            </article>
          ))}
        </section>

        <form className="space-y-4" onSubmit={handleSaveAddress}>
          <h3 className="ml-1 text-sm font-semibold uppercase tracking-wider text-primary">
            {editingAddressId ? 'Editar unidade' : 'Adicionar unidade'}
          </h3>
          <div className="space-y-3 rounded-xl border border-slate-100 bg-white p-4 shadow-sm dark:border-white/5 dark:bg-surface-dark">
            <input
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
              onChange={(event) => setAddressDraft((draft) => ({ ...draft, label: event.target.value }))}
              placeholder="Nome da unidade. Ex: Principal"
              value={addressDraft.label}
            />
            <div className="grid grid-cols-2 gap-3">
              <input
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                onChange={(event) => setAddressDraft((draft) => ({ ...draft, street: event.target.value }))}
                placeholder="Torre / Rua"
                value={addressDraft.street}
              />
              <input
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                onChange={(event) => setAddressDraft((draft) => ({ ...draft, number: event.target.value }))}
                placeholder="Apartamento"
                value={addressDraft.number}
              />
            </div>
            <input
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
              onChange={(event) => setAddressDraft((draft) => ({ ...draft, complement: event.target.value }))}
              placeholder="Complemento"
              value={addressDraft.complement}
            />
            <div className="grid grid-cols-2 gap-3">
              <input
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                onChange={(event) => setAddressDraft((draft) => ({ ...draft, city: event.target.value }))}
                placeholder="Cidade"
                value={addressDraft.city}
              />
              <input
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
                onChange={(event) => setAddressDraft((draft) => ({ ...draft, state: event.target.value }))}
                placeholder="UF"
                value={addressDraft.state}
              />
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
              <input
                checked={addressDraft.is_default}
                className="rounded border-slate-400 text-primary focus:ring-primary"
                onChange={(event) => setAddressDraft((draft) => ({ ...draft, is_default: event.target.checked }))}
                type="checkbox"
              />
              Definir como unidade principal
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                className="h-11 rounded-xl bg-primary font-bold text-background-dark disabled:cursor-not-allowed disabled:opacity-70"
                disabled={savingAddress}
                type="submit"
              >
                {savingAddress ? 'Salvando...' : editingAddressId ? 'Salvar unidade' : 'Adicionar'}
              </button>
              <button
                className="h-11 rounded-xl border border-slate-300 font-bold text-slate-700 dark:border-white/10 dark:text-slate-200"
                onClick={cancelAddressEditing}
                type="button"
              >
                Limpar
              </button>
            </div>
          </div>
        </form>

        <form className="space-y-4" onSubmit={handleChangePassword}>
          <h3 className="ml-1 text-sm font-semibold uppercase tracking-wider text-primary">Seguranca</h3>
          <div className="space-y-3 rounded-xl border border-slate-100 bg-white p-4 shadow-sm dark:border-white/5 dark:bg-surface-dark">
            <input
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
              onChange={(event) => setPasswordDraft((draft) => ({ ...draft, current_password: event.target.value }))}
              placeholder="Senha atual"
              type="password"
              value={passwordDraft.current_password}
            />
            <input
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
              onChange={(event) => setPasswordDraft((draft) => ({ ...draft, new_password: event.target.value }))}
              placeholder="Nova senha"
              type="password"
              value={passwordDraft.new_password}
            />
            <input
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-white/10 dark:bg-background-dark/50 dark:text-white"
              onChange={(event) => setPasswordDraft((draft) => ({ ...draft, confirm_password: event.target.value }))}
              placeholder="Confirmar nova senha"
              type="password"
              value={passwordDraft.confirm_password}
            />
            <button
              className="h-12 w-full rounded-xl border border-primary/30 bg-primary/10 font-bold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-70"
              disabled={savingPassword}
              type="submit"
            >
              {savingPassword ? 'Alterando...' : 'Alterar senha'}
            </button>
          </div>
        </form>

        <section className="mb-8">
          <button
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 py-3.5 font-bold text-red-500 transition-all duration-200 hover:bg-red-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
            disabled={loggingOut}
            onClick={() => {
              void handleLogout()
            }}
            type="button"
          >
            <span className="material-symbols-outlined">logout</span>
            {loggingOut ? 'Saindo...' : 'Sair da Conta'}
          </button>
          <p className="mt-4 text-center text-xs text-slate-400 opacity-60">
            Unidade principal: {defaultAddress ? formatAddressTitle(defaultAddress) : 'nao definida'}
          </p>
        </section>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-200 bg-surface-light px-6 pb-6 pt-3 dark:border-white/10 dark:bg-surface-dark">
        <div className="mx-auto flex w-full max-w-md items-end justify-between">
          <Link className="flex w-16 flex-col items-center gap-1 text-slate-400 transition-colors hover:text-primary" to="/app/home">
            <span className="material-symbols-outlined">home</span>
            <span className="text-[10px] font-medium">Inicio</span>
          </Link>
          <Link className="flex w-16 flex-col items-center gap-1 text-slate-400 transition-colors hover:text-primary" to="/app/history">
            <span className="material-symbols-outlined">history</span>
            <span className="text-[10px] font-medium">Historico</span>
          </Link>
          <Link className="relative flex w-16 flex-col items-center gap-1 text-primary" to="/app/profile">
            <div className="absolute -top-3 h-1 w-1 rounded-full bg-primary shadow-[0_0_8px_2px_rgba(13,242,89,0.5)]" />
            <span className="material-symbols-outlined filled">person</span>
            <span className="text-[10px] font-medium">Perfil</span>
          </Link>
          <Link className="flex w-16 flex-col items-center gap-1 text-slate-400 transition-colors hover:text-primary" to="/app/support">
            <span className="material-symbols-outlined">support_agent</span>
            <span className="text-[10px] font-medium">Suporte</span>
          </Link>
        </div>
      </nav>
    </div>
  )
}
