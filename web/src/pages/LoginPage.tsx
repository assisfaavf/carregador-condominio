import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthProvider'

const heroImageUrl =
  'https://lh3.googleusercontent.com/aida-public/AB6AXuBh0wNUBTiM_TX7OcaWms93nDB8U-1KldippwbDPEGMXb29qIiz4Kb3cQgJwGhPcZzBjdQ_e90fTkC9ZZ7GRvTB7OOU-kIhSW-fSiVOQ3QD9UoGbUPamvWbnLKJsEQ1vU3Y7juhZxOA2WePpzQEbCngUZZ0Ym8ik-e60-iX5ocVIq3dav9-XvdUxbn4hknVZoI41VZDo6eYx3Hc1ARl_a5jZby5E3ayQb9m1dhX2-f4-Q-Fs3Whp7ilGbfpP5X2mbMTrIqULMDBsg2Y'

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

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,_#eaf5ff_0%,_#f5fbff_48%,_#ffffff_100%)] font-display text-slate-900">
      <header className="sticky top-0 z-20 border-b border-sky-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex min-h-[76px] w-[min(980px,calc(100%-2rem))] items-center justify-between gap-4">
          <img alt="Logo" className="h-[46px] w-auto object-contain" src="/assets/Logo-rem.png" />
          <button
            className="inline-flex h-12 items-center justify-center rounded-xl border-2 border-sky-200 bg-white px-4 text-sm font-bold text-sky-700 transition hover:bg-sky-50"
            onClick={() => document.documentElement.classList.toggle('dark')}
            type="button"
          >
            Modo escuro
          </button>
        </div>
      </header>

      <main className="mx-auto w-[min(980px,calc(100%-2rem))] pb-8 pt-6">
        <div className="relative min-h-[200px] overflow-hidden rounded-[14px] border border-sky-200 bg-sky-100/60">
          <div className="absolute inset-0 z-10 bg-gradient-to-t from-sky-950/35 via-sky-500/10 to-sky-100/15" />
          <div
            className="h-full w-full bg-cover bg-center"
            style={{
              backgroundImage: `url("${heroImageUrl}")`,
            }}
          />
        </div>

        <div className="px-0 pb-1 pt-5 text-center">
          <h1 className="m-0 text-[clamp(1.65rem,3vw,2.1rem)] font-bold leading-tight tracking-[-0.02em] text-slate-950">
            Bem-vindo de volta
          </h1>
          <p className="mt-2 text-[0.98rem] text-sky-700">
            Energize sua jornada. Entre na sua conta.
          </p>
        </div>

        <section className="mx-auto mt-4 w-[min(560px,100%)] rounded-[14px] border border-sky-100 bg-white/90 p-5 shadow-[0_12px_30px_rgba(56,189,248,0.18)]">
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <label className="grid gap-2">
              <span className="text-[0.93rem] font-semibold text-slate-800">E-mail ou CPF</span>
              <input
                autoComplete="username"
                className="h-[52px] w-full rounded-xl border border-sky-100 bg-white px-3.5 text-[0.98rem] text-slate-900 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="nome@exemplo.com ou 12345678909"
                required
                type="text"
                value={email}
              />
            </label>

            <label className="grid gap-2">
              <span className="text-[0.93rem] font-semibold text-slate-800">Senha</span>
              <div className="relative">
                <input
                  autoComplete="current-password"
                  className="h-[52px] w-full rounded-xl border border-sky-100 bg-white px-3.5 pr-12 text-[0.98rem] text-slate-900 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button
                  aria-label="Mostrar ou ocultar senha"
                  className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-sky-700 transition hover:bg-sky-50"
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
                className="inline-flex h-[52px] w-full items-center justify-center rounded-xl bg-sky-500 text-base font-bold text-white shadow-[0_12px_30px_rgba(56,189,248,0.28)] transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-70"
                disabled={submitting}
                type="submit"
              >
                {submitting ? 'Entrando...' : 'Entrar'}
              </button>
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-sky-100" />
                <span className="text-xs font-semibold text-sky-700">-- ou --</span>
                <div className="h-px flex-1 bg-sky-100" />
              </div>
              <Link
                className="inline-flex h-[52px] w-full items-center justify-center rounded-xl border-2 border-sky-200 bg-white text-base font-bold text-sky-800 transition hover:bg-sky-50"
                to="/register"
              >
                Criar conta
              </Link>
            </div>

            <p className={`min-h-5 text-[0.92rem] ${message ? 'text-red-500' : 'text-sky-700'}`}>
              {message}
            </p>
          </form>
        </section>

        <div className="mt-8 flex flex-wrap justify-center gap-6 pb-2 pt-4 text-center text-sky-700">
          {[
            ['Rede', 'ONLINE'],
            ['Criptografia', 'AES-256'],
            ['Versão', 'v4.2.0'],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.1em]">{label}</div>
              <div className="mt-0.5 text-[0.88rem] font-bold text-sky-500">{value}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
