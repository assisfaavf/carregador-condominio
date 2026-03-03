import type { MouseEvent } from 'react'

type AdminUserOption = {
  id: number
  name: string
  email: string
}

type AdminAddressOption = {
  id: number
  label: string
  is_default: boolean
}

type AdminStartModalProps = {
  open: boolean
  stationName: string
  users: AdminUserOption[]
  addresses: AdminAddressOption[]
  selectedUserId: number | null
  selectedAddressId: number | null
  loadingUsers: boolean
  loadingAddresses: boolean
  submitting: boolean
  errorMessage: string | null
  onClose: () => void
  onUserChange: (value: string) => void
  onAddressChange: (value: string) => void
  onSubmit: () => void
}

export default function AdminStartModal({
  open,
  stationName,
  users,
  addresses,
  selectedUserId,
  selectedAddressId,
  loadingUsers,
  loadingAddresses,
  submitting,
  errorMessage,
  onClose,
  onUserChange,
  onAddressChange,
  onSubmit,
}: AdminStartModalProps) {
  if (!open) return null

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !submitting) {
      onClose()
    }
  }

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/60 p-4 sm:items-center"
      onClick={handleBackdropClick}
      role="dialog"
    >
      <div className="w-full max-w-md rounded-2xl border border-secondary bg-surface-dark p-5 shadow-2xl">
        <h2 className="text-lg font-bold text-slate-100">Iniciar carregamento</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Selecione o usuário e a unidade para iniciar a sessão na estação{' '}
          <span className="font-semibold text-slate-100">{stationName}</span>.
        </p>

        {errorMessage ? (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {errorMessage}
          </div>
        ) : null}

        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-200" htmlFor="admin-start-user">
              Usuário
            </label>
            <select
              className="h-12 w-full rounded-xl border border-secondary bg-background-dark px-3 text-sm text-slate-100 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loadingUsers || submitting}
              id="admin-start-user"
              onChange={(event) => onUserChange(event.target.value)}
              value={selectedUserId ?? ''}
            >
              <option value="">{loadingUsers ? 'Carregando usuários...' : 'Selecione um usuário'}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.email})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-200" htmlFor="admin-start-address">
              Unidade
            </label>
            <select
              className="h-12 w-full rounded-xl border border-secondary bg-background-dark px-3 text-sm text-slate-100 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
              disabled={selectedUserId == null || loadingAddresses || submitting}
              id="admin-start-address"
              onChange={(event) => onAddressChange(event.target.value)}
              value={selectedAddressId ?? ''}
            >
              <option value="">
                {selectedUserId == null
                  ? 'Selecione um usuário primeiro'
                  : loadingAddresses
                    ? 'Carregando endereços...'
                    : 'Selecione uma unidade'}
              </option>
              {addresses.map((address) => (
                <option key={address.id} value={address.id}>
                  {address.label}
                  {address.is_default ? ' [padrao]' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className="h-11 flex-1 rounded-xl border border-slate-700 bg-transparent px-4 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            Cancelar
          </button>
          <button
            className="h-11 flex-1 rounded-xl bg-primary px-4 text-sm font-semibold text-background-dark transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={
              submitting || loadingUsers || selectedUserId == null || selectedAddressId == null
            }
            onClick={onSubmit}
            type="button"
          >
            {submitting ? 'Iniciando...' : 'Iniciar'}
          </button>
        </div>
      </div>
    </div>
  )
}
