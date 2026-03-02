import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthProvider'

type RequireAdminProps = {
  children: ReactNode
}

export default function RequireAdmin({ children }: RequireAdminProps) {
  const { loading, user } = useAuth()

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

  if (user.is_admin !== true) {
    return <Navigate to="/app/home" replace />
  }

  return <>{children}</>
}
