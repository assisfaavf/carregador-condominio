import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
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

export default function AppRouter() {
  return (
    <BrowserRouter>
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
