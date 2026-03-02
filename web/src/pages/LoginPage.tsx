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
    <div className="flex min-h-screen items-center justify-center bg-background-light p-4 font-display text-slate-900 dark:bg-background-dark dark:text-slate-100">
      <div className="w-full max-w-md space-y-6">
        <div className="relative h-48 overflow-hidden rounded-xl ring-1 ring-white/10">
          <div className="absolute inset-0 z-10 bg-gradient-to-t from-background-dark/80 to-transparent" />
          <div
            className="h-full w-full bg-cover bg-center"
            style={{
              backgroundImage:
                'url("https://lh3.googleusercontent.com/aida-public/AB6AXuBh0wNUBTiM_TX7OcaWms93nDB8U-1KldippwbDPEGMXb29qIiz4Kb3cQgJwGhPcZzBjdQ_e90fTkC9ZZ7GRvTB7OOU-kIhSW-fSiVOQ3QD9UoGbUPamvWbnLKJsEQ1vU3Y7juhZxOA2WePpzQEbCngUZZ0Ym8ik-e60-iX5ocVIq3dav9-XvdUxbn4hknVZoI41VZDo6eYx3Hc1ARl_a5jZby5E3ayQb9m1dhX2-f4-Q-Fs3Whp7ilGbfpP5X2mbMTrIqULMDBsg2Y")',
            }}
          />
          <div className="absolute bottom-4 left-4 z-20">
            <h1 className="text-3xl font-bold tracking-tight text-white">Welcome Back</h1>
            <p className="mt-1 text-sm text-slate-300">Sign in to continue your journey</p>
          </div>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <label className="block space-y-2">
            <span className="ml-1 text-sm font-semibold text-slate-900 dark:text-white">Email</span>
            <input
              autoComplete="email"
              className="h-14 w-full rounded-xl border border-slate-200 bg-white px-4 text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/50 dark:border-[#316843] dark:bg-[#183422] dark:text-white"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Enter your email"
              required
              type="email"
              value={email}
            />
          </label>

          <label className="block space-y-2">
            <span className="ml-1 text-sm font-semibold text-slate-900 dark:text-white">Password</span>
            <input
              autoComplete="current-password"
              className="h-14 w-full rounded-xl border border-slate-200 bg-white px-4 text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/50 dark:border-[#316843] dark:bg-[#183422] dark:text-white"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
              type="password"
              value={password}
            />
          </label>

          {message ? (
            <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {message}
            </p>
          ) : null}

          <button
            className="w-full rounded-xl bg-primary py-4 font-bold text-background-dark shadow-lg shadow-primary/20 transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={submitting}
            type="submit"
          >
            {submitting ? 'Entrando...' : 'Log In'}
          </button>

          <Link
            className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-slate-200 py-3.5 font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-[#316843] dark:text-white dark:hover:bg-[#183422]"
            to="/register"
          >
            <span className="material-symbols-outlined text-[20px]">person_add</span>
            Create Account
          </Link>
        </form>
      </div>
    </div>
  )
}
