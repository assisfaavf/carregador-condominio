import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import RequireAdmin from './auth/RequireAdmin'
import RequireAuth from './auth/RequireAuth'
import AdminLayout from './layouts/AdminLayout'
import UserLayout from './layouts/UserLayout'
import AdminDashboardPage from './pages/AdminDashboardPage'
import AdminHistoryPage from './pages/AdminHistoryPage'
import AdminSettingsPage from './pages/AdminSettingsPage'
import AdminUsersPage from './pages/AdminUsersPage'
import LoginPage from './pages/LoginPage'
import NotFoundPage from './pages/NotFoundPage'
import PendingApprovalPage from './pages/PendingApprovalPage'
import RegisterPage from './pages/RegisterPage'
import UserHistoryPage from './pages/UserHistoryPage'
import UserHomePage from './pages/UserHomePage'
import UserProfilePage from './pages/UserProfilePage'
import UserSupportPage from './pages/UserSupportPage'

const PAGE_TITLES: Record<string, string> = {
  '/login': 'Login - Carregador',
  '/register': 'Cadastro - Carregador',
  '/pending': 'Cadastro em análise - Carregador',
  '/app': 'Home - Carregador',
  '/app/home': 'Home - Carregador',
  '/app/history': 'Histórico - Carregador',
  '/app/profile': 'Perfil - Carregador',
  '/app/support': 'Suporte - Carregador',
  '/admin': 'Home Admin - Carregador',
  '/admin/dashboard': 'Home Admin - Carregador',
  '/admin/history': 'Histórico Admin - Carregador',
  '/admin/users': 'Usuários Admin - Carregador',
  '/admin/settings': 'Configurações Admin - Carregador',
}

function PageTitle() {
  const location = useLocation()

  useEffect(() => {
    document.title = PAGE_TITLES[location.pathname] ?? 'Página não encontrada - Carregador'
  }, [location.pathname])

  return null
}

export default function AppRouter() {
  return (
    <BrowserRouter>
      <PageTitle />
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/pending" element={<PendingApprovalPage />} />

        <Route
          path="/app"
          element={
            <RequireAuth>
              <UserLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="home" replace />} />
          <Route path="home" element={<UserHomePage />} />
          <Route path="history" element={<UserHistoryPage />} />
          <Route path="profile" element={<UserProfilePage />} />
          <Route path="support" element={<UserSupportPage />} />
        </Route>

        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminLayout />
            </RequireAdmin>
          }
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<AdminDashboardPage />} />
          <Route path="history" element={<AdminHistoryPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}
