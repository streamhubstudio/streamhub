/**
 * Authentication state (simple email/password — no OIDC).
 *
 * A single bearer token (persisted by the http layer) backs the session,
 * obtained from either:
 *  - POST /auth/login   { email|user, password }  (accounts + break-glass admin)
 *  - POST /auth/signup  { email, password, teamName? }
 *
 * From the token we derive a client-side `identity` (tenants, role, superadmin)
 * purely to render/gate the UI — the backend re-verifies and is the source of
 * truth. A 401 from any API call clears the session.
 */
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  api,
  clearToken,
  getToken,
  setToken,
  setUnauthorizedHandler,
} from '@/api'
import {
  adminIdentity,
  canEditRole,
  canManageTenantRole,
  roleForTenant,
  type Identity,
  type UiRole,
} from './identity'

const TENANT_KEY = 'streamhub.tenant'

export interface AuthContextValue {
  token: string | null
  isAuthenticated: boolean
  identity: Identity | null
  /** Effective UI role in the current tenant (or 'superadmin'). */
  role: UiRole | null
  isSuperadmin: boolean
  /** May the current role mutate resources in the current tenant? */
  canEdit: boolean
  /** May the current role manage members/quotas of the current tenant? */
  canManageTenant: boolean
  /** Selected tenant id (the UI scopes to it; superadmin can switch). */
  currentTenant: string | null
  setCurrentTenant: (id: string | null) => void
  /** Log in with an account email (or admin username) + password (+ TOTP code when 2FA is on). */
  login: (identifier: string, password: string, code?: string) => Promise<void>
  /** Create an account (+ optional team) and start a session. */
  signup: (email: string, password: string, teamName?: string) => Promise<void>
  /** Passwordless: ask the backend to email a magic sign-in link. */
  requestMagicLink: (email: string) => Promise<void>
  /** Passwordless: exchange a magic-link token (+ TOTP code when 2FA is on) for a session. */
  verifyMagic: (token: string, code?: string) => Promise<void>
  logout: () => void
}

// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken())
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const t = getToken()
    return t ? adminIdentity(t) : null
  })
  const [currentTenant, setCurrentTenantState] = useState<string | null>(() => {
    const stored = localStorage.getItem(TENANT_KEY)
    if (stored) return stored
    const t = getToken()
    return t ? (adminIdentity(t).tenants[0] ?? null) : null
  })

  const setCurrentTenant = useCallback((id: string | null) => {
    setCurrentTenantState(id)
    try {
      if (id) localStorage.setItem(TENANT_KEY, id)
      else localStorage.removeItem(TENANT_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const logout = useCallback(() => {
    clearToken()
    try {
      localStorage.removeItem(TENANT_KEY)
    } catch {
      /* ignore */
    }
    setTokenState(null)
    setIdentity(null)
    setCurrentTenantState(null)
  }, [])

  const adopt = useCallback((jwt: string) => {
    setToken(jwt)
    const ident = adminIdentity(jwt)
    setTokenState(jwt)
    setIdentity(ident)
    setCurrentTenantState((prev) => prev ?? ident.tenants[0] ?? null)
  }, [])

  const login = useCallback(
    async (identifier: string, password: string, code?: string) => {
      // Send both keys so the backend can match on email or admin username.
      const { token: jwt } = await api.auth.login({
        user: identifier,
        email: identifier,
        password,
        ...(code ? { code } : {}),
      })
      adopt(jwt)
    },
    [adopt],
  )

  const signup = useCallback(
    async (email: string, password: string, teamName?: string) => {
      const { token: jwt } = await api.auth.signup({
        email,
        password,
        ...(teamName ? { teamName } : {}),
      })
      adopt(jwt)
    },
    [adopt],
  )

  const requestMagicLink = useCallback(async (email: string) => {
    await api.auth.magicLink({ email })
  }, [])

  const verifyMagic = useCallback(
    async (token: string, code?: string) => {
      const { token: jwt } = await api.auth.magicVerify({
        token,
        ...(code ? { code } : {}),
      })
      adopt(jwt)
    },
    [adopt],
  )

  // Wire 401 -> logout for the whole app.
  useEffect(() => {
    setUnauthorizedHandler(() => logout())
    return () => setUnauthorizedHandler(null)
  }, [logout])

  const value = useMemo<AuthContextValue>(() => {
    const role = roleForTenant(identity, currentTenant ?? undefined)
    return {
      token,
      isAuthenticated: Boolean(token),
      identity,
      role,
      isSuperadmin: Boolean(identity?.isSuperadmin),
      canEdit: canEditRole(role),
      canManageTenant: canManageTenantRole(role),
      currentTenant,
      setCurrentTenant,
      login,
      signup,
      requestMagicLink,
      verifyMagic,
      logout,
    }
  }, [
    token,
    identity,
    currentTenant,
    setCurrentTenant,
    login,
    signup,
    requestMagicLink,
    verifyMagic,
    logout,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
