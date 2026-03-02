import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { type AuthUser, type LoginInput, login, logout, me } from '../api/auth'
import { ApiError } from '../api/client'

type AuthContextValue = {
  user: AuthUser | null
  loading: boolean
  signIn: (input: LoginInput) => Promise<AuthUser>
  signOut: () => Promise<void>
  refreshMe: () => Promise<AuthUser | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

type AuthProviderProps = {
  children: ReactNode
}

export default function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshMe = useCallback(async () => {
    try {
      const nextUser = await me()
      setUser(nextUser)
      return nextUser
    } catch (error) {
      if (error instanceof ApiError && error.code === 'unauthorized') {
        setUser(null)
        return null
      }
      throw error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshMe().catch(() => {
      setUser(null)
    })
  }, [refreshMe])

  const signIn = useCallback(
    async (input: LoginInput) => {
      await login(input)
      const nextUser = await refreshMe()
      if (!nextUser) {
        throw new ApiError('unauthorized', 401, 'unauthorized', null)
      }
      return nextUser
    },
    [refreshMe],
  )

  const signOut = useCallback(async () => {
    try {
      await logout()
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      signIn,
      signOut,
      refreshMe,
    }),
    [loading, refreshMe, signIn, signOut, user],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within <AuthProvider>.')
  }
  return context
}
