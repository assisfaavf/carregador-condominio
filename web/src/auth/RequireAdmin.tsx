import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { isAdmin, isAuthenticated } from './auth'

type RequireAdminProps = {
  children: ReactNode
}

export default function RequireAdmin({ children }: RequireAdminProps) {
  if (!isAuthenticated() || !isAdmin()) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
