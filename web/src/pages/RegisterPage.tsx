import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { register, type RegisterRole } from '../api/auth'
import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthProvider'

type AddressForm = {
  id: string
  tower: string
  apartment: string
}

function createAddress(seed: number): AddressForm {
  return {
    id: `address-${Date.now()}-${seed}`,
    tower: 'mississipi',
    apartment: '',
  }
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message || 'Falha ao cadastrar.'
  if (error instanceof Error) return error.message
  return 'Falha ao cadastrar.'
}

export default function RegisterPage() {
  const navigate = useNavigate()
  const { user, loading, signIn } = useAuth()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [cpf, setCpf] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<RegisterRole>('morador')
  const [addresses, setAddresses] = useState<AddressForm[]>([createAddress(1)])
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (loading || !user) return
    navigate(
      user.is_admin ? '/admin/dashboard' : user.approval_status === 'approved' ? '/app/home' : '/pending',
      { replace: true },
    )
  }, [loading, navigate, user])

  const visibleAddresses = useMemo(
    () => (role === 'visitante' ? addresses.slice(0, 1) : addresses),
    [addresses, role],
  )

  function updateAddress(id: string, patch: Partial<AddressForm>) {
    setAddresses((current) =>
      current.map((address) => (address.id === id ? { ...address, ...patch } : address)),
    )
  }

  function addAddress() {
    setAddresses((current) => [...current, createAddress(current.length + 1)])
  }

  function removeAddress(id: string) {
    setAddresses((current) => {
      const next = current.filter((address) => address.id !== id)
      return next.length > 0 ? next : [createAddress(1)]
    })
  }

  function sanitizeCpf(value: string) {
    return value.replace(/\D/g, '')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage('')
    setSubmitting(true)
    try {
      const normalizedCpf = sanitizeCpf(cpf)
      if (normalizedCpf.length !== 11) {
        throw new Error('CPF invalido. Informe 11 numeros.')
      }
      if (password.length < 8) {
        throw new Error('Senha deve ter no minimo 8 caracteres.')
      }

      const payloadAddresses = visibleAddresses.map((address, index) => ({
        label: index === 0 ? 'Principal' : `Endereco ${index + 1}`,
        tower: address.tower,
        apartment: address.apartment.trim(),
      }))

      if (payloadAddresses.some((address) => !address.apartment)) {
        throw new Error('Preencha apartamento em todos os enderecos.')
      }

      await register({
        name,
        email,
        cpf: normalizedCpf,
        password,
        role,
        addresses: payloadAddresses,
      })

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
    <div className="flex min-h-screen justify-center bg-background-light px-4 py-8 font-display text-slate-900 dark:bg-background-dark dark:text-slate-100">
      <div className="w-full max-w-2xl space-y-6">
        <header className="space-y-2 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Criar Conta</h1>
          <p className="text-sm text-slate-500 dark:text-[#90cba4]">
            Cadastre-se para acessar o painel do carregador.
          </p>
        </header>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-2 md:col-span-2">
              <span className="text-sm font-medium">Nome completo</span>
              <input
                className="h-12 w-full rounded-xl border-slate-300 bg-white px-4 text-base placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-[#316843] dark:bg-[#183422] dark:text-white"
                onChange={(event) => setName(event.target.value)}
                placeholder="Seu nome"
                required
                type="text"
                value={name}
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium">CPF</span>
              <input
                className="h-12 w-full rounded-xl border-slate-300 bg-white px-4 text-base placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-[#316843] dark:bg-[#183422] dark:text-white"
                onChange={(event) => setCpf(event.target.value)}
                placeholder="00000000000"
                required
                type="text"
                value={cpf}
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium">Email</span>
              <input
                className="h-12 w-full rounded-xl border-slate-300 bg-white px-4 text-base placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-[#316843] dark:bg-[#183422] dark:text-white"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                required
                type="email"
                value={email}
              />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-2">
              <span className="text-sm font-medium">Senha</span>
              <input
                className="h-12 w-full rounded-xl border-slate-300 bg-white px-4 text-base placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-[#316843] dark:bg-[#183422] dark:text-white"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Minimo 8 caracteres"
                required
                type="password"
                value={password}
              />
            </label>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Tipo</legend>
              <div className="flex h-12 items-center rounded-xl border border-[#316843] bg-[#1a3826] p-1">
                <label className="relative flex h-full flex-1 cursor-pointer items-center justify-center overflow-hidden rounded-lg text-sm font-semibold">
                  <input
                    checked={role === 'morador'}
                    className="peer absolute invisible w-0"
                    name="role"
                    onChange={() => setRole('morador')}
                    type="radio"
                    value="morador"
                  />
                  <span className="absolute inset-0 rounded-lg bg-transparent transition-all peer-checked:bg-background-dark" />
                  <span className="relative z-10 text-[#90cba4] peer-checked:text-primary">Morador</span>
                </label>
                <label className="relative flex h-full flex-1 cursor-pointer items-center justify-center overflow-hidden rounded-lg text-sm font-semibold">
                  <input
                    checked={role === 'visitante'}
                    className="peer absolute invisible w-0"
                    name="role"
                    onChange={() => setRole('visitante')}
                    type="radio"
                    value="visitante"
                  />
                  <span className="absolute inset-0 rounded-lg bg-transparent transition-all peer-checked:bg-background-dark" />
                  <span className="relative z-10 text-[#90cba4] peer-checked:text-primary">Visitante</span>
                </label>
              </div>
            </fieldset>
          </div>

          <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-100 p-4 dark:border-[#316843] dark:bg-[#183422]">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[#90cba4]">Enderecos</h2>
              {role === 'morador' ? (
                <button
                  className="rounded-lg border border-primary/50 px-3 py-1.5 text-xs font-semibold text-primary transition hover:bg-primary/10"
                  onClick={addAddress}
                  type="button"
                >
                  + Adicionar
                </button>
              ) : null}
            </div>

            {visibleAddresses.map((address, index) => (
              <div
                className="space-y-3 rounded-xl border border-slate-300 bg-white p-3 dark:border-[#316843] dark:bg-[#102216]"
                key={address.id}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    {index === 0 ? 'Endereco principal' : `Endereco ${index + 1}`}
                  </p>
                  {role === 'morador' && visibleAddresses.length > 1 ? (
                    <button
                      className="text-xs font-semibold text-red-400 hover:text-red-300"
                      onClick={() => removeAddress(address.id)}
                      type="button"
                    >
                      Remover
                    </button>
                  ) : null}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs uppercase tracking-wide text-[#90cba4]">Torre</span>
                    <select
                      className="h-10 w-full rounded-lg border-slate-300 bg-white px-3 text-sm focus:border-primary focus:ring-primary dark:border-[#316843] dark:bg-[#102216]"
                      onChange={(event) => updateAddress(address.id, { tower: event.target.value })}
                      value={address.tower}
                    >
                      <option value="mississipi">Mississipi</option>
                      <option value="missouri">Missouri</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs uppercase tracking-wide text-[#90cba4]">Apartamento</span>
                    <input
                      className="h-10 w-full rounded-lg border-slate-300 bg-white px-3 text-sm focus:border-primary focus:ring-primary dark:border-[#316843] dark:bg-[#102216] dark:text-white"
                      onChange={(event) => updateAddress(address.id, { apartment: event.target.value })}
                      placeholder="Ex.: 301"
                      required
                      type="text"
                      value={address.apartment}
                    />
                  </label>
                </div>
              </div>
            ))}
          </section>

          {message ? (
            <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {message}
            </p>
          ) : null}

          <button
            className="w-full rounded-xl bg-primary py-4 text-lg font-bold text-background-dark shadow-[0_0_15px_rgba(13,242,89,0.3)] transition hover:bg-[#0be050] disabled:cursor-not-allowed disabled:opacity-70"
            disabled={submitting}
            type="submit"
          >
            {submitting ? 'Cadastrando...' : 'Register Account'}
          </button>

          <Link
            className="block text-center text-sm font-medium text-primary hover:text-primary/80"
            to="/login"
          >
            Ja tenho conta
          </Link>
        </form>
      </div>
    </div>
  )
}
