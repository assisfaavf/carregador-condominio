import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthProvider'

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'unauthorized') return 'Credenciais invalidas.'
    return error.message || 'Falha ao entrar.'
  }
  if (error instanceof Error) return error.message
  return 'Falha ao entrar.'
}

export default function LoginPage() {
  const navigate = useNavigate()
  const { user, loading, signIn } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isDarkMode, setIsDarkMode] = useState(() => document.documentElement.classList.contains('dark'))
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (loading || !user) return
    navigate(
      user.is_admin ? '/admin/dashboard' : user.approval_status === 'approved' ? '/app/home' : '/pending',
      { replace: true },
    )
  }, [loading, navigate, user])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setSubmitting(true)
    try {
      const nextUser = await signIn({ email, password })
      navigate(
        nextUser.is_admin
          ? '/admin/dashboard'
          : nextUser.approval_status === 'approved'
            ? '/app/home'
            : '/pending',
        { replace: true },
      )
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  function toggleTheme() {
    const nextDarkMode = !document.documentElement.classList.contains('dark')
    document.documentElement.classList.toggle('dark', nextDarkMode)
    setIsDarkMode(nextDarkMode)
  }

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,_#edf3ff_0%,_#f5f8f6_48%,_#ffffff_100%)] font-display text-slate-900 dark:bg-[linear-gradient(180deg,_#17213a_0%,_#1c2944_48%,_#22304d_100%)] dark:text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-white/10 dark:bg-[#17213a]/85">
        <div className="mx-auto flex min-h-[76px] w-[min(980px,calc(100%-2rem))] items-center justify-between gap-4">
          <img alt="Logo" className="h-[46px] w-auto object-contain" src="/assets/Logo-rem.png" />
          <button
            className="inline-flex h-12 items-center justify-center rounded-xl border-2 border-slate-900 bg-slate-900 px-4 text-sm font-bold text-white transition hover:bg-slate-800 dark:border-white dark:bg-white dark:text-[#17213a] dark:hover:bg-slate-100"
            onClick={toggleTheme}
            type="button"
          >
            {isDarkMode ? 'Modo claro' : 'Modo escuro'}
          </button>
        </div>
      </header>

      <main className="mx-auto w-[min(980px,calc(100%-2rem))] pb-8 pt-6">
        <div className="px-0 pb-1 pt-5 text-center">
          <h1 className="m-0 text-[clamp(1.65rem,3vw,2.1rem)] font-bold leading-tight tracking-[-0.02em] text-slate-950 dark:text-white">
            Bem-vindo de volta
          </h1>
          <p className="mt-2 text-[0.98rem] text-slate-500 dark:text-slate-300">
            Energize sua jornada. Entre na sua conta.
          </p>
        </div>

        <section className="mx-auto mt-4 w-[min(560px,100%)] rounded-[14px] border border-primary/15 bg-[#eef4ff]/95 p-5 shadow-[0_12px_30px_rgba(37,89,244,0.14)] dark:border-white/10 dark:bg-[#263653]/95 dark:shadow-[0_12px_30px_rgba(7,11,20,0.32)]">
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <label className="grid gap-2">
              <span className="text-[0.93rem] font-semibold text-slate-800 dark:text-white">E-mail ou CPF</span>
              <input
                autoComplete="username"
                className="h-[52px] w-full rounded-xl border border-primary/15 bg-white px-3.5 text-[0.98rem] text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary focus:ring-2 focus:ring-primary/25 dark:border-white/15 dark:bg-[#1d2b47] dark:text-white dark:placeholder:text-slate-300"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="nome@exemplo.com ou 12345678909"
                required
                type="text"
                value={email}
              />
            </label>

            <label className="grid gap-2">
              <span className="text-[0.93rem] font-semibold text-slate-800 dark:text-white">Senha</span>
              <div className="relative">
                <input
                  autoComplete="current-password"
                  className="h-[52px] w-full rounded-xl border border-primary/15 bg-white px-3.5 pr-12 text-[0.98rem] text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary focus:ring-2 focus:ring-primary/25 dark:border-white/15 dark:bg-[#1d2b47] dark:text-white dark:placeholder:text-slate-300"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button
                  aria-label="Mostrar ou ocultar senha"
                  className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10"
                  onClick={() => setShowPassword((current) => !current)}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[20px]">
                    {showPassword ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </label>

            <div className="grid gap-3">
              <button
                className="inline-flex h-[52px] w-full items-center justify-center rounded-xl bg-primary text-base font-bold text-white shadow-[0_12px_30px_rgba(37,89,244,0.24)] transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
                disabled={submitting}
                type="submit"
              >
                {submitting ? 'Entrando...' : 'Entrar'}
              </button>
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-300">-- ou --</span>
                <div className="h-px flex-1 bg-slate-200 dark:bg-white/10" />
              </div>
              <Link
                className="inline-flex h-[52px] w-full items-center justify-center rounded-xl border-2 border-primary/20 bg-white text-base font-bold text-slate-800 transition hover:bg-slate-50 dark:border-white/15 dark:bg-[#1d2b47] dark:text-white dark:hover:bg-[#314263]"
                to="/register"
              >
                Criar conta
              </Link>
            </div>

            <p className={`min-h-5 text-[0.92rem] ${message ? 'text-red-500' : 'text-slate-500 dark:text-slate-300'}`}>
              {message}
            </p>
          </form>
        </section>

        <div className="mt-8 flex flex-wrap justify-center gap-6 pb-2 pt-4 text-center text-slate-500 dark:text-slate-300">
          {[
            ['Rede', 'ONLINE'],
            ['Criptografia', 'AES-256'],
            ['Versão', 'v4.2.0'],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.1em]">{label}</div>
              <div className="mt-0.5 text-[0.88rem] font-bold text-primary">{value}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
