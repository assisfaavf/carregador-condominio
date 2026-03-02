import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

function PendingStep({
  icon,
  title,
  description,
}: {
  icon: string
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-primary/5 dark:bg-slate-800/30">
      <span className="material-symbols-outlined text-primary">{icon}</span>
      <div>
        <h3 className="text-sm font-bold">{title}</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">{description}</p>
      </div>
    </div>
  )
}

export default function PendingApprovalPage() {
  const navigate = useNavigate()
  const { loading, user, signOut } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background-dark text-slate-100">
        Carregando...
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (user.is_admin === true || user.approval_status === 'approved') {
    return <Navigate to={user.is_admin ? '/admin/dashboard' : '/app/home'} replace />
  }

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await signOut()
    } finally {
      navigate('/login', { replace: true })
      setLoggingOut(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background-light text-slate-900 dark:bg-background-dark dark:text-slate-100">
      <header className="relative flex items-center gap-4 border-b border-slate-200 p-4 dark:border-primary/10">
        <button
          aria-label="Sair"
          className="absolute left-4 rounded-full p-2 transition-colors hover:bg-slate-200 dark:hover:bg-primary/10"
          disabled={loggingOut}
          onClick={() => {
            void handleLogout()
          }}
          type="button"
        >
          <span className="material-symbols-outlined text-slate-600 dark:text-slate-100">
            arrow_back
          </span>
        </button>
        <h1 className="w-full text-center text-xl font-bold">Cadastro</h1>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="relative mb-8">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-3xl" />
          <div className="relative rounded-full border-4 border-primary/30 bg-white p-6 shadow-2xl dark:bg-slate-800/50">
            <span className="material-symbols-outlined !text-6xl animate-pulse text-primary">
              verified_user
            </span>
          </div>
        </div>

        <h1 className="mb-4 text-center font-display text-3xl font-bold tracking-tight">
          Cadastro em <span className="text-primary">Analise</span>
        </h1>

        <p className="mb-4 text-center text-base text-slate-600 dark:text-slate-400">
          Ola, {user.name}. Recebemos seus dados com sucesso. Agora nossa equipe administrativa
          esta revisando suas informacoes para liberar seu acesso total.
        </p>

        <p className="mb-10 text-center text-lg leading-relaxed text-slate-600 dark:text-slate-400">
          Enquanto isso, sua conta permanece com status pendente e por isso voce fica nesta tela
          ate a aprovacao.
        </p>

        <div className="mb-8 w-full rounded-xl border border-slate-300 bg-slate-200 p-6 dark:border-primary/10 dark:bg-slate-800">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-primary/70">
              Progresso da aprovacao
            </span>
            <span className="text-sm font-bold text-primary">75%</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-slate-300 dark:bg-slate-700">
            <div
              className="h-full bg-primary shadow-[0_0_15px_rgba(13,242,89,0.5)]"
              style={{ width: '75%' }}
            />
          </div>
          <p className="mt-4 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="material-symbols-outlined !text-sm text-primary">info</span>
            Fase final: verificacao dos dados enviados no cadastro.
          </p>
        </div>

        <div className="grid w-full grid-cols-1 gap-4">
          <PendingStep
            description="Voce sera avisado assim que sua conta for ativada."
            icon="mark_email_unread"
            title="Notificacao por e-mail"
          />
          <PendingStep
            description="Use a seta no topo esquerdo para sair da sessao enquanto aguarda."
            icon="logout"
            title="Sair com seguranca"
          />
          <PendingStep
            description="Se a aprovacao demorar alem do esperado, fale com a administracao."
            icon="support_agent"
            title="Precisa de ajuda?"
          />
        </div>

        <button
          className="mt-10 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-4 font-bold text-background-dark shadow-lg shadow-primary/20 transition-all hover:opacity-90"
          onClick={() => {
            void handleLogout()
          }}
          type="button"
        >
          {loggingOut ? 'Saindo...' : 'Sair e voltar ao login'}
          <span className="material-symbols-outlined !text-lg">logout</span>
        </button>
      </main>
    </div>
  )
}
