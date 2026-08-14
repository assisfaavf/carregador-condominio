import { useState } from 'react'
import { Link, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

export default function AdminLayout() {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const [message, setMessage] = useState('')

  const handleLogout = async () => {
    setLoggingOut(true)
    setMessage('')
    try {
      await signOut()
      navigate('/login', { replace: true })
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'Não foi possível sair da sessão.'
      setMessage(nextMessage)
      navigate('/login', { replace: true })
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="min-h-screen bg-background-light dark:bg-background-dark">
      <header className="sticky top-0 z-[70] border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-primary/20 dark:bg-slate-900/95">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">
              Area Administrativa
            </h1>
            <Link
              className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-slate-800 transition-colors hover:bg-primary/20 dark:text-slate-100"
              to="/app/home"
            >
              Ver como usuário
            </Link>
            <Link
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              to="/app/home"
            >
              Home do usuário
            </Link>
          </div>
          <button
            className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={loggingOut}
            onClick={() => {
              void handleLogout()
            }}
            type="button"
          >
            {loggingOut ? 'Saindo...' : 'Sair'}
          </button>
        </div>
        {message ? (
          <p className="mx-auto mt-2 w-full max-w-6xl text-xs font-medium text-danger">{message}</p>
        ) : null}
      </header>
      <Outlet />
    </div>
  )
}
