import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from 'react'
import {
  supabase,
  isSupabaseConfigured,
  resolvedSupabaseAnonKey,
  resolvedSupabaseUrl,
  refreshSupabaseSession,
  signOutCurrentSupabaseSession
} from './supabase'
import { createClient } from '@supabase/supabase-js'
import { isSupabaseRateLimitedError } from './sessionManager'
import { isAuthenticatedState, resolveCachedWorkspaceAssignment } from './authenticationState'
import type { User, Session } from '@supabase/supabase-js'
import type { CashierShiftAssignment, CashierShiftOccurrence, UserRole, WorkspaceDataMode } from '@/local-db/models'
import { connectionManager } from '@/lib/connectionManager'
import { setActiveBusinessUser, setActiveBusinessWorkspace } from '@/lib/network'
import { clearWorkspaceCache } from '@/workspace/workspaceCache'
import {
  clearWorkspaceModeSnapshot,
  normalizeWorkspaceDataMode,
  writeWorkspaceModeSnapshot
} from '@/workspace/workspaceMode'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { WORKSPACE_USAGE_SKIP_HEADER } from '@/lib/workspaceUsageFetch'
import { resolveFetchedWorkspaceName } from '@/workspace/workspaceLocalSettings'
import { db } from '@/local-db/database'
import { hydrateLocalModeCacheFromSqlite, readLocalProfileWorkspaceState } from '@/local-db/localModeSqlite'
import { runDailyBackupIfNeeded, runR2BackupIfNeeded } from '@/local-db/sqliteBackup'
import { clearLocalDemoWorkspaceData, clearStoredDemoWorkspaces } from '@/demo/demoCleanup'
import { isDemoWorkspace } from '@/demo/demoConfig'
import { deleteDemoWorkspace } from '@/demo/demoService'
import {
  enrollLocalAccountCredential,
  getLocalWorkspaceAccount,
  persistLocalAccountProfile,
  verifyLocalAccountPassword
} from './localAccountAuth'
import {
  CloudAccountSwitchError,
  performCloudAccountSwitch,
  requestCloudWorkspaceAccount
} from './cloudAccountSwitcher'
import { writeCachedPermissions } from '@/permissions/workspacePermissionCache'
import {
  completeCashierShiftOccurrence,
  getCashierLoginLogoutShiftState,
  startCashierShiftOccurrence
} from '@/local-db/paymentAccounts'
import { fetchTableFromSupabase } from '@/local-db/hooks'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button
} from '@/ui/components'
import i18n from '@/i18n/config'

export interface AuthUser {
  id: string
  email: string
  name: string
  role: UserRole
  workspaceId: string
  sourceWorkspaceId: string
  workspaceCode: string
  workspaceName?: string
  profileUrl?: string
  isConfigured?: boolean
  workspaceMode: WorkspaceDataMode
}

interface AuthContextType {
  user: AuthUser | null
  session: Session | null
  isLoading: boolean
  isAuthenticated: boolean
  isKicked: boolean
  isSupabaseConfigured: boolean
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>
  signInWithDemo: (result: {
    userId: string
    email: string
    password: string
    workspaceId: string
    workspaceCode: string
    workspaceName: string
  }) => Promise<void>
  signUp: (params: {
    email: string
    password: string
    name: string
    role: UserRole
    passkey: string
    workspaceName?: string
    workspaceCode?: string
    adminContacts?: {
      type: 'phone' | 'email' | 'address'
      value: string
      label?: string
      isPrimary: boolean
    }[]
  }) => Promise<{ error: Error | null }>
  signOut: (options?: { explicit?: boolean }) => Promise<void>
  hasRole: (roles: UserRole[]) => boolean
  refreshUser: () => Promise<void>
  updateUser: (updates: Partial<AuthUser>) => void
  switchLocalAccount: (userId: string, password: string) => Promise<{ error: Error | null }>
  switchCloudAccount: (userId: string, password: string) => Promise<{ error: Error | null }>
}

interface CashierShiftAuthRequest {
  kind: 'start' | 'logout'
  user: AuthUser
  assignment?: CashierShiftAssignment
  occurrence?: CashierShiftOccurrence
  resolve: (confirmed: boolean) => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// Demo user for offline/non-configured mode
const DEMO_USER: AuthUser = {
  id: 'demo-user',
  email: 'demo@atlas.local',
  name: 'Demo User',
  role: 'admin',
  workspaceId: 'demo-workspace',
  sourceWorkspaceId: 'demo-workspace',
  workspaceCode: 'DEMO-1234',
  workspaceName: 'Demo Workspace',
  profileUrl: undefined,
  workspaceMode: 'local'
}

const AUTH_WORKSPACE_BOOTSTRAP_COLUMNS = 'name, code, is_configured, data_mode'
const ACTIVE_LOCAL_ACCOUNT_PREFIX = 'atlas_active_local_account:'

function parseUserFromSupabase(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email ?? '',
    name: user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User',
    role: (user.user_metadata?.role as UserRole) ?? 'viewer',
    workspaceId: '',
    sourceWorkspaceId: '',
    workspaceCode: '',
    workspaceName: undefined,
    profileUrl: user.user_metadata?.profile_url,
    isConfigured: user.user_metadata?.is_configured,
    workspaceMode: 'cloud'
  }
}

async function clearStoredDemoWorkspacesBestEffort() {
  try {
    await clearStoredDemoWorkspaces()
  } catch (error) {
    console.error('[Auth] Failed to clear stale local demo data:', error)
  }
}

async function hydrateAssetProfile(user: AuthUser) {
  const isLocalOrHybrid = user.workspaceMode === 'local' || user.workspaceMode === 'hybrid'
  const isDemo = user.workspaceMode === 'demo'

  if (!(isLocalOrHybrid || isDemo) || !user.workspaceId) {
    return
  }

  const localProfile = await db.profiles.get(user.id)
  if (localProfile?.profile_url) {
    user.profileUrl = localProfile.profile_url
  }

  await db.profiles.put({
    ...localProfile,
    id: user.id,
    workspaceId: user.sourceWorkspaceId || user.workspaceId,
    currentWorkspaceId: user.workspaceId,
    name: user.name,
    role: user.role,
    profile_url: user.profileUrl ?? localProfile?.profile_url ?? null,
    created_at: localProfile?.created_at || new Date().toISOString()
  })
}

function clearPreviousWorkspaceArtifacts(previousWorkspaceId?: string | null, nextWorkspaceId?: string | null) {
  if (!previousWorkspaceId || previousWorkspaceId === nextWorkspaceId) {
    return
  }

  clearWorkspaceCache(previousWorkspaceId)
  clearWorkspaceModeSnapshot(previousWorkspaceId)
}

function getActiveLocalAccountKey(workspaceId: string) {
  return `${ACTIVE_LOCAL_ACCOUNT_PREFIX}${workspaceId}`
}

function readActiveLocalAccountId(workspaceId: string) {
  return localStorage.getItem(getActiveLocalAccountKey(workspaceId))
}

function writeActiveLocalAccountId(workspaceId: string, userId: string) {
  localStorage.setItem(getActiveLocalAccountKey(workspaceId), userId)
}

function clearActiveLocalAccount(workspaceId?: string | null) {
  if (workspaceId) {
    localStorage.removeItem(getActiveLocalAccountKey(workspaceId))
    return
  }

  const keysToRemove: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(ACTIVE_LOCAL_ACCOUNT_PREFIX)) {
      keysToRemove.push(key)
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key))
}

async function persistAuthUserLocally(user: AuthUser) {
  if (user.workspaceMode !== 'local' || !user.workspaceId) return

  await persistLocalAccountProfile({
    id: user.id,
    workspaceId: user.workspaceId,
    sourceWorkspaceId: user.sourceWorkspaceId,
    currentWorkspaceId: user.workspaceId,
    email: user.email,
    name: user.name,
    role: user.role,
    profileUrl: user.profileUrl
  })
}

async function cacheLocalAccountPermissions(workspaceId: string, userId: string) {
  const { data, error } = (await runSupabaseAction(
    'auth.cacheLocalAccountPermissions',
    () => supabase.from('workspace_permissions').select('key').eq('workspace_id', workspaceId).eq('user_uuid', userId),
    { timeoutMs: 8000, platform: 'all' }
  )) as { data: Array<{ key: string }> | null; error?: unknown }

  if (error) {
    throw normalizeSupabaseActionError(error)
  }

  writeCachedPermissions(
    workspaceId,
    userId,
    (data ?? []).map((permission) => permission.key)
  )
}

async function cacheLocalWorkspaceAccounts(workspaceId: string, options?: { isLocalFirst?: boolean }) {
  const { data, error } = (await runSupabaseAction(
    'auth.cacheLocalWorkspaceAccounts',
    () =>
      supabase
        .from('profiles')
        .select('id, name, role, profile_url, workspace_id, current_workspace, created_at')
        .eq('workspace_id', workspaceId),
    { timeoutMs: 8000, platform: 'all' }
  )) as {
    data: Array<{
      id: string
      name: string | null
      role: string | null
      profile_url: string | null
      workspace_id: string
      current_workspace: string | null
      created_at: string | null
    }> | null
    error?: unknown
  }

  if (error) {
    throw normalizeSupabaseActionError(error)
  }

  const remoteProfiles = data ?? []
  const existingProfiles = await db.profiles.where('workspaceId').equals(workspaceId).toArray()
  const profileMap = new Map(existingProfiles.map((p) => [p.id, p]))
  const remoteProfileIds = new Set(remoteProfiles.map((profile) => profile.id))
  const removedProfiles = existingProfiles.filter((profile) => !remoteProfileIds.has(profile.id))
  const now = new Date().toISOString()

  await db.transaction('rw', db.profiles, db.users, async () => {
    await db.profiles.bulkPut(
      remoteProfiles.map((profile) => {
        const existing = profileMap.get(profile.id)
        return {
          id: profile.id,
          workspaceId: profile.workspace_id,
          currentWorkspaceId: profile.current_workspace || profile.workspace_id,
          name: profile.name || 'User',
          role: profile.role || 'viewer',
          profile_url: options?.isLocalFirst && existing?.profile_url ? existing.profile_url : profile.profile_url,
          created_at: profile.created_at || undefined
        }
      })
    )

    for (const profile of remoteProfiles) {
      const existing = profileMap.get(profile.id)
      const existingUser = await db.users.get(profile.id)
      await db.users.put({
        ...existingUser,
        id: profile.id,
        workspaceId: profile.workspace_id,
        email: existingUser?.email || '',
        name: profile.name || 'User',
        role: profile.role === 'admin' || profile.role === 'staff' ? profile.role : 'viewer',
        profileUrl:
          options?.isLocalFirst && existing?.profile_url ? existing.profile_url : profile.profile_url || undefined,
        createdAt: existingUser?.createdAt || profile.created_at || now,
        updatedAt: now,
        syncStatus: 'synced',
        lastSyncedAt: now,
        version: existingUser?.version ?? 1,
        isDeleted: false
      })
    }

    for (const profile of removedProfiles) {
      const existingUser = await db.users.get(profile.id)
      await db.users.put({
        ...existingUser,
        id: profile.id,
        workspaceId,
        email: existingUser?.email || '',
        name: existingUser?.name || profile.name || 'User',
        role: existingUser?.role || (profile.role === 'admin' || profile.role === 'staff' ? profile.role : 'viewer'),
        profileUrl: existingUser?.profileUrl || profile.profile_url || undefined,
        createdAt: existingUser?.createdAt || profile.created_at || now,
        updatedAt: now,
        syncStatus: 'synced',
        lastSyncedAt: now,
        version: existingUser?.version ?? 1,
        isDeleted: true
      })
    }
  })
}

async function restoreActiveLocalAccount(baseUser: AuthUser): Promise<AuthUser> {
  if (baseUser.workspaceMode !== 'local' || !baseUser.workspaceId) {
    return baseUser
  }

  await persistAuthUserLocally(baseUser)

  const activeUserId = readActiveLocalAccountId(baseUser.workspaceId)
  if (!activeUserId || activeUserId === baseUser.id) {
    return baseUser
  }

  const localAccount = await getLocalWorkspaceAccount(baseUser.workspaceId, activeUserId)
  if (!localAccount?.hasCredential) {
    clearActiveLocalAccount(baseUser.workspaceId)
    return baseUser
  }

  return {
    ...baseUser,
    id: localAccount.id,
    email: localAccount.email || baseUser.email,
    name: localAccount.name,
    role: localAccount.role,
    profileUrl: localAccount.profileUrl
  }
}

function resetWorkspaceAssignment(user: AuthUser, previousWorkspaceId?: string | null): AuthUser {
  clearPreviousWorkspaceArtifacts(previousWorkspaceId ?? user.workspaceId, null)

  return {
    ...user,
    workspaceId: '',
    sourceWorkspaceId: '',
    workspaceCode: '',
    workspaceName: undefined,
    isConfigured: undefined,
    workspaceMode: 'cloud'
  }
}

// Helper: fetch workspace + profile data for a parsed user
async function enrichUser(parsedUser: AuthUser): Promise<AuthUser> {
  type WorkspaceBootstrapRow = {
    name?: string | null
    code?: string | null
    is_configured?: boolean | null
    data_mode?: WorkspaceDataMode | null
  }

  type ProfileBootstrapRow = {
    profile_url?: string | null
    role?: UserRole | null
    workspace_id?: string | null
    current_workspace?: string | null
  }

  const originalWorkspaceId = parsedUser.workspaceId || ''
  let canonicalWorkspaceId = originalWorkspaceId
  let sourceWorkspaceId = parsedUser.sourceWorkspaceId || ''
  let profileBootstrapCompleted = false
  let cachedWorkspaceAssignment: ReturnType<typeof resolveCachedWorkspaceAssignment> = null

  try {
    const { data: profileRow, error: profileError } = (await runSupabaseAction(
      'auth.profileBootstrap',
      () =>
        supabase
          .from('profiles')
          .select('profile_url, role, workspace_id, current_workspace')
          .eq('id', parsedUser.id)
          .maybeSingle()
          // This read establishes the workspace needed by the Web Live
          // gateway itself. It remains protected by profile RLS, but must not
          // be sent through that gateway before the context exists.
          .setHeader(WORKSPACE_USAGE_SKIP_HEADER, '1'),
      { timeoutMs: 8000, platform: 'all' }
    )) as { data: ProfileBootstrapRow | null; error?: unknown }

    if (profileError) {
      throw profileError
    }

    profileBootstrapCompleted = true

    if (profileRow) {
      if (profileRow.profile_url) {
        parsedUser.profileUrl = profileRow.profile_url
      }
      if (profileRow.role) {
        parsedUser.role = profileRow.role
      }
      sourceWorkspaceId = profileRow.workspace_id ?? ''
      canonicalWorkspaceId = profileRow.current_workspace ?? ''
    }
  } catch (error) {
    console.warn('[Auth] Failed to fetch profile bootstrap:', error)
  }

  if (!profileBootstrapCompleted && !canonicalWorkspaceId) {
    try {
      const recoveredUser = getRecoveredUser()
      const cachedProfile = await db.profiles.get(parsedUser.id)
      const recoveredUserIsActiveLocalAccount = Boolean(
        recoveredUser?.workspaceId
        && readActiveLocalAccountId(recoveredUser.workspaceId) === recoveredUser.id
      )
      cachedWorkspaceAssignment = resolveCachedWorkspaceAssignment({
        authenticatedUserId: parsedUser.id,
        recoveredUser,
        cachedProfile,
        recoveredUserIsActiveLocalAccount
      })

      if (cachedWorkspaceAssignment) {
        sourceWorkspaceId = cachedWorkspaceAssignment.sourceWorkspaceId
        canonicalWorkspaceId = cachedWorkspaceAssignment.currentWorkspaceId
      }
    } catch (error) {
      console.warn('[Auth] Failed to recover workspace state from local browser storage:', error)
    }
  }

  if (!profileBootstrapCompleted && !canonicalWorkspaceId) {
    try {
      const localWorkspaceState = await readLocalProfileWorkspaceState(parsedUser.id)
      if (localWorkspaceState) {
        sourceWorkspaceId = localWorkspaceState.sourceWorkspaceId
        canonicalWorkspaceId = localWorkspaceState.currentWorkspaceId
      }
    } catch (error) {
      console.warn('[Auth] Failed to recover workspace state from local SQLite:', error)
    }
  }

  if (originalWorkspaceId !== canonicalWorkspaceId) {
    clearPreviousWorkspaceArtifacts(originalWorkspaceId, canonicalWorkspaceId)
    parsedUser.workspaceCode = ''
    parsedUser.workspaceName = undefined
    parsedUser.isConfigured = undefined
    parsedUser.workspaceMode = 'cloud'
  }

  if (cachedWorkspaceAssignment) {
    parsedUser.workspaceCode = cachedWorkspaceAssignment.workspaceCode || parsedUser.workspaceCode
    parsedUser.workspaceName = cachedWorkspaceAssignment.workspaceName || parsedUser.workspaceName
    parsedUser.isConfigured = cachedWorkspaceAssignment.isConfigured ?? parsedUser.isConfigured
    parsedUser.workspaceMode = cachedWorkspaceAssignment.workspaceMode ?? parsedUser.workspaceMode
  }

  if (!canonicalWorkspaceId) {
    return resetWorkspaceAssignment(parsedUser, originalWorkspaceId)
  }

  parsedUser.workspaceId = canonicalWorkspaceId
  parsedUser.sourceWorkspaceId = sourceWorkspaceId

  try {
    const { data: workspaceRow, error: workspaceError } = (await runSupabaseAction(
      'auth.workspaceBootstrap',
      () =>
        supabase
          .from('workspaces')
          .select(AUTH_WORKSPACE_BOOTSTRAP_COLUMNS)
          .eq('id', parsedUser.workspaceId)
          .maybeSingle()
          .setHeader(WORKSPACE_USAGE_SKIP_HEADER, '1'),
      { timeoutMs: 8000, platform: 'all' }
    )) as { data: WorkspaceBootstrapRow | null; error?: unknown }

    if (workspaceError) {
      throw workspaceError
    }

    if (workspaceRow) {
      const localWorkspaceBootstrap = await db.workspaces.get(parsedUser.workspaceId)
      const bootstrapMode = normalizeWorkspaceDataMode(workspaceRow.data_mode)
      parsedUser.workspaceName =
        resolveFetchedWorkspaceName({
          workspaceMode: bootstrapMode,
          persistedMode: localWorkspaceBootstrap?.data_mode ?? bootstrapMode,
          remoteName: workspaceRow.name,
          persistedName: localWorkspaceBootstrap?.name,
          currentName: parsedUser.workspaceName
        }) ||
        parsedUser.workspaceName ||
        undefined
      parsedUser.workspaceCode = workspaceRow.code || parsedUser.workspaceCode
      parsedUser.isConfigured = workspaceRow.is_configured ?? parsedUser.isConfigured
      parsedUser.workspaceMode = bootstrapMode
      writeWorkspaceModeSnapshot({
        workspaceId: parsedUser.workspaceId,
        dataMode: parsedUser.workspaceMode
      })
      if (parsedUser.workspaceMode === 'local' || parsedUser.workspaceMode === 'hybrid') {
        await hydrateLocalModeCacheFromSqlite(db, parsedUser.workspaceId)
        void runDailyBackupIfNeeded(parsedUser.workspaceId)
        void runR2BackupIfNeeded(parsedUser.workspaceId)
      }
      await hydrateAssetProfile(parsedUser)
      return parsedUser
    }
  } catch (error) {
    console.warn('[Auth] Failed to fetch workspace bootstrap:', error)
  }

  const localWorkspace = await db.workspaces.get(parsedUser.workspaceId)
  if (localWorkspace) {
    parsedUser.workspaceCode = localWorkspace.code || parsedUser.workspaceCode
    parsedUser.workspaceName = localWorkspace.name || parsedUser.workspaceName
    parsedUser.isConfigured = localWorkspace.is_configured
    parsedUser.workspaceMode = normalizeWorkspaceDataMode(localWorkspace.data_mode ?? parsedUser.workspaceMode)
    writeWorkspaceModeSnapshot({
      workspaceId: parsedUser.workspaceId,
      dataMode: parsedUser.workspaceMode
    })
    if (parsedUser.workspaceMode === 'local' || parsedUser.workspaceMode === 'hybrid') {
      await hydrateLocalModeCacheFromSqlite(db, parsedUser.workspaceId)
      void runDailyBackupIfNeeded(parsedUser.workspaceId)
      void runR2BackupIfNeeded(parsedUser.workspaceId)
    }
    await hydrateAssetProfile(parsedUser)
  }

  return parsedUser
}

// Recovery bridge helpers
function saveRecovery(user: AuthUser) {
  localStorage.setItem(
    'atlas_session_recovery',
    JSON.stringify({
      ...user,
      recoveredAt: Date.now()
    })
  )
}

function getRecoveredUser(): (AuthUser & { recoveredAt?: number }) | null {
  try {
    const recovered = localStorage.getItem('atlas_session_recovery')
    if (!recovered) return null
    const parsed = JSON.parse(recovered) as AuthUser & { recoveredAt?: number }
    if (!parsed.sourceWorkspaceId) {
      parsed.sourceWorkspaceId = parsed.workspaceId
    }
    return parsed
  } catch {
    return null
  }
}

function clearRecovery() {
  localStorage.removeItem('atlas_session_recovery')
}

function isRecoveryEligibleError(error: unknown) {
  if (!error) return false

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('network') ||
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('offline')
  )
}

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * A cached cloud profile is not proof of authentication while the device is
 * online. Restoring it after a timeout or a 429 lets background requests run
 * without a bearer token, which then makes the app show a fallback workspace.
 *
 * Local/demo workspaces can always run from their local source of truth. Any
 * cached workspace may be used while the browser is definitely offline.
 */
function canRestoreWithoutSupabaseSession(recovered: AuthUser | null | undefined) {
  if (!recovered?.workspaceId) return false

  return recovered.workspaceMode === 'local' || recovered.workspaceMode === 'demo' || isBrowserOffline()
}

function shouldKeepRecoveryForTemporaryAuthFailure(error: unknown) {
  return isSupabaseRateLimitedError(error) || isRecoveryEligibleError(error)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const sessionRef = useRef<Session | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const authStateTaskRef = useRef(0)
  const userRef = useRef<AuthUser | null>(null)
  const explicitSignOutRef = useRef(false)
  const [cashierShiftAuthRequest, setCashierShiftAuthRequest] = useState<CashierShiftAuthRequest | null>(null)
  const [isCashierShiftAuthProcessing, setIsCashierShiftAuthProcessing] = useState(false)
  const [cashierShiftAuthError, setCashierShiftAuthError] = useState<string | null>(null)

  // Keep sessionRef in sync
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  useEffect(() => {
    userRef.current = user
  }, [user])
  useEffect(() => {
    setActiveBusinessWorkspace(user?.workspaceId ?? null)
    setActiveBusinessUser(user?.id ?? null, user?.role ?? null, user?.workspaceId ?? null)
  }, [user?.id, user?.role, user?.workspaceId])

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setUser(DEMO_USER)
      writeWorkspaceModeSnapshot({
        workspaceId: DEMO_USER.workspaceId,
        dataMode: DEMO_USER.workspaceMode
      })
      setIsLoading(false)
      return
    }

    let isMounted = true

    const processAuthStateChange = async (event: string, session: Session | null, taskId: number) => {
      if (!isMounted || taskId !== authStateTaskRef.current) return

      setSession(session)
      const parsedUser = session?.user ? parseUserFromSupabase(session.user) : null

      if (!parsedUser) {
        const recovered = getRecoveredUser()
        if (!explicitSignOutRef.current && recovered && canRestoreWithoutSupabaseSession(recovered)) {
          setUser(recovered)
          writeWorkspaceModeSnapshot({
            workspaceId: recovered.workspaceId,
            dataMode: recovered.workspaceMode
          })
          setIsLoading(false)
          return
        }

        // Supabase can emit INITIAL_SESSION with a null session while its
        // automatic refresh is still being throttled. Keep recovery metadata
        // for a later offline session or fresh sign-in, but do not treat it as
        // an authenticated cloud session.
        if (event === 'INITIAL_SESSION') {
          setUser(null)
          setIsLoading(false)
          return
        }

        await clearStoredDemoWorkspacesBestEffort()
        clearWorkspaceCache()
        clearWorkspaceModeSnapshot()
        setUser(null)
        clearRecovery()
        setIsLoading(false)
        return
      }

      const enriched = await enrichUser(parsedUser)
      const effectiveUser = await restoreActiveLocalAccount(enriched)

      if (!isMounted || taskId !== authStateTaskRef.current) return

      // Final verify to ensure we haven't logged out during enrichment
      const {
        data: { session: currentSession }
      } = (await runSupabaseAction('auth.verifyStateChangeSession', () => supabase.auth.getSession(), {
        timeoutMs: 5000,
        platform: 'all'
      })) as any

      if (!isMounted || taskId !== authStateTaskRef.current) return

      if (currentSession?.user?.id === parsedUser.id) {
        setUser({ ...effectiveUser })
        saveRecovery(effectiveUser)
      }

      if (!isMounted || taskId !== authStateTaskRef.current) return
      setIsLoading(false)
    }

    // Register auth state listener FIRST so it catches deferred events
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      console.log(`[Auth] State change: ${_event}`, session?.user?.id)
      const taskId = ++authStateTaskRef.current
      window.setTimeout(() => {
        void processAuthStateChange(_event, session, taskId)
      }, 0)
    })

    const fetchInitialSession = async () => {
      try {
        const {
          data: { session },
          error: sessionError
        } = (await runSupabaseAction('auth.initialSession', () => supabase.auth.getSession(), {
          timeoutMs: 8000,
          platform: 'all'
        })) as any

        if (session) {
          setSession(session)
          const parsedUser = session.user ? parseUserFromSupabase(session.user) : null

          if (parsedUser) {
            const enriched = await enrichUser(parsedUser)
            const effectiveUser = await restoreActiveLocalAccount(enriched)
            setUser(effectiveUser)
            saveRecovery(effectiveUser)
          }
        } else {
          const recovered = getRecoveredUser()

          if (canRestoreWithoutSupabaseSession(recovered)) {
            const maxAge = 7 * 24 * 60 * 60 * 1000
            const isStale = recovered?.recoveredAt && Date.now() - recovered.recoveredAt > maxAge

            if (recovered && !isStale) {
              console.log('[Auth] Restoring offline/local session from recovery bridge...')
              setUser(recovered)
              writeWorkspaceModeSnapshot({
                workspaceId: recovered.workspaceId,
                dataMode: recovered.workspaceMode
              })
            } else if (isStale) {
              console.log('[Auth] Recovery bridge is stale (>7 days), clearing.')
              clearRecovery()
            }
          } else {
            await clearStoredDemoWorkspacesBestEffort()
            if (!shouldKeepRecoveryForTemporaryAuthFailure(sessionError)) {
              clearRecovery()
            }
          }
        }
      } catch (e) {
        console.error('[Auth] Initial session fetch failed:', e)
        const recoveredUser = getRecoveredUser()
        let allowRecovery = canRestoreWithoutSupabaseSession(recoveredUser)
        let keepRecovery = shouldKeepRecoveryForTemporaryAuthFailure(e)

        // Second chance: try refreshSession directly (different code path)
        try {
          console.log('[Auth] Attempting refreshSession as fallback...')
          const { data, error } = (await runSupabaseAction(
            'auth.refreshFallback',
            () => refreshSupabaseSession(),
            { timeoutMs: 5000, platform: 'all' }
          )) as any

          if (!error && data?.session) {
            console.log('[Auth] refreshSession succeeded ✓')
            setSession(data.session)
            const parsedUser = parseUserFromSupabase(data.session.user)
            const enriched = await enrichUser(parsedUser)
            const effectiveUser = await restoreActiveLocalAccount(enriched)
            setUser(effectiveUser)
            saveRecovery(effectiveUser)
            return // Success — skip recovery bridge
          }

          keepRecovery ||= shouldKeepRecoveryForTemporaryAuthFailure(error)
        } catch (refreshErr) {
          console.warn('[Auth] refreshSession also failed:', refreshErr)
          allowRecovery = canRestoreWithoutSupabaseSession(recoveredUser)
          keepRecovery ||= shouldKeepRecoveryForTemporaryAuthFailure(refreshErr)
        }

        if (!allowRecovery && !keepRecovery) {
          clearRecovery()
        }

        if (allowRecovery) {
          const recovered = recoveredUser ?? getRecoveredUser()
          if (recovered) {
            console.log('[Auth] Using recovery bridge (limited mode).')
            setUser(recovered)
          }
        }
      } finally {
        setIsLoading(false)
      }
    }

    fetchInitialSession()

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  // ───────────────────────────────────────────────────────
  // RESILIENCE: Wake handler — verify session on tab return
  // ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isSupabaseConfigured) return

    const handleConnectionEvent = async (event: string) => {
      if (event !== 'wake' && event !== 'online') return
      if (userRef.current?.workspaceMode === 'local') return
      if (!sessionRef.current) return

      console.log(`[Auth] Connection event: ${event} — verifying session...`)

      try {
        const {
          data: { session },
          error
        } = (await runSupabaseAction('auth.wakeSessionCheck', () => supabase.auth.getSession(), {
          timeoutMs: 5000,
          platform: 'all'
        })) as any

        if (error || !session) {
          console.log('[Auth] Session invalid after wake, attempting refresh...')
          const { data: refreshData, error: refreshError } = (await runSupabaseAction(
            'auth.wakeRefreshSession',
            () => refreshSupabaseSession(),
            { timeoutMs: 5000, platform: 'all' }
          )) as any

          if (isSupabaseRateLimitedError(refreshError)) {
            // Supabase owns the refresh cooldown and preserves a still-valid
            // stored session. A genuine SIGNED_OUT event clears React state.
            console.warn('[Auth] Session refresh is rate-limited; preserving current auth state.')
            return
          }

          if (refreshError || !refreshData.session) {
            console.error('[Auth] Session refresh failed — signing out gracefully.')
            // Import toast lazily to avoid circular deps
            const { toast } = await import('@/ui/components/use-toast')
            toast({
              title: 'Session expired',
              description: 'Your session has expired. Please sign in again.',
              variant: 'destructive'
            })
            await signOut({ explicit: false })
            return
          }
        }

        console.log('[Auth] Session verified after wake ✓')
      } catch (e) {
        console.error('[Auth] Wake session check failed (network?):', e)
        // Don't sign out on network failure — recovery bridge keeps user in
      }
    }

    const unsubscribe = connectionManager.subscribe(handleConnectionEvent)
    return unsubscribe
  }, [])

  // ───────────────────────────────────────────────────────
  // RESILIENCE: Session watchdog — proactive token refresh
  // ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isSupabaseConfigured) return

    // Check every 5 minutes if token is about to expire
    watchdogRef.current = setInterval(
      async () => {
        if (userRef.current?.workspaceMode === 'local') return
        const currentSession = sessionRef.current
        if (!currentSession?.expires_at) return

        const expiresAt = currentSession.expires_at * 1000 // convert to ms
        const timeUntilExpiry = expiresAt - Date.now()

        // If token expires in less than 2 minutes, proactively refresh
        if (timeUntilExpiry < 2 * 60 * 1000 && timeUntilExpiry > 0) {
          console.log(`[Auth] Token expires in ${Math.round(timeUntilExpiry / 1000)}s — proactive refresh`)
          const { error } = (await runSupabaseAction(
            'auth.proactiveRefresh',
            () => refreshSupabaseSession(),
            { timeoutMs: 5000, platform: 'all' }
          )) as any
          if (error) {
            console.error('[Auth] Proactive refresh failed:', error)
          }
        }
      },
      5 * 60 * 1000
    ) // every 5 minutes

    return () => {
      if (watchdogRef.current) clearInterval(watchdogRef.current)
    }
  }, [])

  const refreshCashierShiftAuthState = async (authUser: AuthUser) => {
    if (!authUser.workspaceId) return
    if (authUser.workspaceMode !== 'local' && typeof navigator !== 'undefined' && navigator.onLine !== false) {
      await Promise.all([
        fetchTableFromSupabase('cashier_shift_assignments', db.cashier_shift_assignments, authUser.workspaceId),
        fetchTableFromSupabase('cashier_shift_occurrences', db.cashier_shift_occurrences, authUser.workspaceId)
      ])
    }
  }

  const requestCashierShiftStartConfirmation = async (authUser: AuthUser) => {
    if (!authUser.workspaceId) return true
    await refreshCashierShiftAuthState(authUser)
    const { assignment, activeOccurrence } = await getCashierLoginLogoutShiftState(authUser.workspaceId, authUser.id)
    if (!assignment || activeOccurrence) return true
    return new Promise<boolean>((resolve) => {
      setCashierShiftAuthError(null)
      setCashierShiftAuthRequest({
        kind: 'start',
        user: authUser,
        assignment,
        resolve
      })
    })
  }

  const requestCashierShiftLogoutConfirmation = async (authUser: AuthUser | null) => {
    if (!authUser?.workspaceId) return true
    const { activeOccurrence } = await getCashierLoginLogoutShiftState(authUser.workspaceId, authUser.id)
    if (!activeOccurrence) return true
    return new Promise<boolean>((resolve) => {
      setCashierShiftAuthError(null)
      setCashierShiftAuthRequest({
        kind: 'logout',
        user: authUser,
        occurrence: activeOccurrence,
        resolve
      })
    })
  }

  const cancelCashierShiftAuthRequest = () => {
    if (!cashierShiftAuthRequest || isCashierShiftAuthProcessing) return
    const request = cashierShiftAuthRequest
    setCashierShiftAuthRequest(null)
    setCashierShiftAuthError(null)
    request.resolve(false)
  }

  const confirmCashierShiftAuthRequest = async () => {
    if (!cashierShiftAuthRequest || isCashierShiftAuthProcessing) return
    setIsCashierShiftAuthProcessing(true)
    setCashierShiftAuthError(null)
    try {
      if (cashierShiftAuthRequest.kind === 'start') {
        await startCashierShiftOccurrence(cashierShiftAuthRequest.user.workspaceId, {
          assignmentId: cashierShiftAuthRequest.assignment!.id,
          cashierUserId: cashierShiftAuthRequest.user.id,
          source: 'login'
        })
      } else {
        await completeCashierShiftOccurrence(cashierShiftAuthRequest.user.workspaceId, {
          occurrenceId: cashierShiftAuthRequest.occurrence!.id,
          cashierUserId: cashierShiftAuthRequest.user.id,
          reason: 'logged_out'
        })
      }
      const request = cashierShiftAuthRequest
      setCashierShiftAuthRequest(null)
      request.resolve(true)
    } catch (error) {
      setCashierShiftAuthError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsCashierShiftAuthProcessing(false)
    }
  }

  const signIn = async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      setUser(DEMO_USER)
      writeWorkspaceModeSnapshot({
        workspaceId: DEMO_USER.workspaceId,
        dataMode: DEMO_USER.workspaceMode
      })
      return { error: null }
    }

    try {
      const { data, error } = (await runSupabaseAction(
        'auth.signIn',
        () =>
          supabase.auth.signInWithPassword({
            email,
            password
          }),
        { timeoutMs: 15000, platform: 'all' }
      )) as any
      if (!error && data?.user && data?.session) {
        const enriched = await enrichUser(parseUserFromSupabase(data.user))
        if (enriched.workspaceMode === 'local' && enriched.workspaceId) {
          await persistAuthUserLocally(enriched)
          try {
            await Promise.all([
              cacheLocalWorkspaceAccounts(enriched.workspaceId, {
                isLocalFirst: enriched.workspaceMode === 'local' || enriched.workspaceMode === 'hybrid'
              }),
              cacheLocalAccountPermissions(enriched.workspaceId, enriched.id)
            ])
          } catch (preparationError) {
            console.warn('[Auth] Failed to fully prepare local workspace accounts:', preparationError)
          }
          await enrollLocalAccountCredential({
            workspaceId: enriched.workspaceId,
            userId: enriched.id,
            email: enriched.email,
            password
          })
          writeActiveLocalAccountId(enriched.workspaceId, enriched.id)
        }

        // This is intentionally reached only from an explicit password
        // login; token refreshes and restored sessions never call it.
        const confirmed = await requestCashierShiftStartConfirmation(enriched)
        if (!confirmed) {
          await signOut({ explicit: false })
          return {
            error: new Error(i18n.t('paymentAccounts.errors.loginLogoutShiftStartCancelled'))
          }
        }

        // Do not wait for the asynchronous auth-state listener to populate the
        // context. The Login page redirects as soon as this method resolves;
        // without this synchronous handoff a slower desktop can briefly render
        // the protected route as anonymous, sending the user back to Login and
        // clearing the form even though Supabase accepted the credentials.
        setSession(data.session ?? null)
        setUser({ ...enriched })
        saveRecovery(enriched)

        return { error: null }
      }

      return {
        error: (error as Error | null) ?? new Error(i18n.t('auth.signInIncomplete'))
      }
    } catch (err: any) {
      console.error('[Auth] Sign in failed/timeout:', err)
      return { error: err }
    }
  }

  const signUp = async ({
    email,
    password,
    name,
    role = 'viewer',
    passkey,
    workspaceName,
    workspaceCode,
    adminContacts
  }: {
    email: string
    password: string
    name: string
    role: UserRole
    passkey: string
    workspaceName?: string
    workspaceCode?: string
    adminContacts?: {
      type: 'phone' | 'email' | 'address'
      value: string
      label?: string
      isPrimary: boolean
    }[]
  }) => {
    if (!isSupabaseConfigured) {
      const localDemoUser = {
        ...DEMO_USER,
        email,
        name,
        role,
        workspaceName: workspaceName || 'Local Workspace'
      }
      setUser(localDemoUser)
      writeWorkspaceModeSnapshot({
        workspaceId: localDemoUser.workspaceId,
        dataMode: localDemoUser.workspaceMode
      })
      return { error: null }
    }

    let workspaceId = ''
    let resolvedWorkspaceName = workspaceName
    let resolvedWorkspacePlan = 'basic'
    const normalizedPasskey = passkey.trim()

    try {
      if (role === 'admin') {
        if (!workspaceName) throw new Error('Workspace name is required for Admins')

        const { data: wsData, error: wsError } = (await runSupabaseAction(
          'auth.createWorkspace',
          () =>
            supabase.functions.invoke('workspace-access', {
              body: {
                action: 'create',
                workspaceName,
                passkey: normalizedPasskey
              }
            }),
          { timeoutMs: 12000, platform: 'all' }
        )) as any

        if (wsError || !wsData?.id) {
          throw normalizeSupabaseActionError(wsError ?? new Error('Workspace creation failed'))
        }

        workspaceId = wsData.id
        workspaceCode = wsData.code || workspaceCode
        resolvedWorkspaceName = wsData.name || workspaceName
        resolvedWorkspacePlan = wsData.plan || resolvedWorkspacePlan
      } else {
        if (!workspaceCode) throw new Error('Workspace code is required to join')

        const { data: wsData, error: wsError } = (await runSupabaseAction(
          'auth.lookupWorkspaceByCode',
          () => supabase.rpc('lookup_workspace_by_code', { p_code: workspaceCode }).maybeSingle(),
          { timeoutMs: 8000, platform: 'all' }
        )) as any

        if (wsError || !wsData) throw new Error('Invalid workspace code')

        workspaceId = wsData.id
        resolvedWorkspaceName = wsData.name
        resolvedWorkspacePlan = wsData.plan || resolvedWorkspacePlan
      }

      const resolvedWorkspaceCode = workspaceCode

      const { data: signUpData, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            name,
            role,
            passkey: normalizedPasskey,
            workspace_id: workspaceId,
            workspace_code: resolvedWorkspaceCode,
            workspace_name: resolvedWorkspaceName,
            workspace_plan: resolvedWorkspacePlan
          }
        }
      })

      if (!error && signUpData.user && workspaceId) {
        await persistLocalAccountProfile({
          id: signUpData.user.id,
          workspaceId,
          email,
          name,
          role
        })
        await enrollLocalAccountCredential({
          workspaceId,
          userId: signUpData.user.id,
          email,
          password
        })
        writeActiveLocalAccountId(workspaceId, signUpData.user.id)
      }

      // Insert workspace contacts AFTER signUp so the session is active for RLS
      if (!error && role === 'admin' && workspaceId && adminContacts && adminContacts.length > 0) {
        const contactsPayload = adminContacts.slice(0, 1).map((p) => ({
          workspace_id: workspaceId,
          type: p.type,
          value: p.value,
          label: p.label || null,
          is_primary: true
        }))
        const { error: contactsErr } = await supabase.from('workspace_contacts').insert(contactsPayload)
        if (contactsErr) console.error('[Auth] Failed to insert workspace contacts:', contactsErr)
      }

      return { error: error as Error | null }
    } catch (err: any) {
      return { error: err as Error }
    }
  }

  const signInWithDemo = async (result: {
    userId: string
    email: string
    password: string
    workspaceId: string
    workspaceCode: string
    workspaceName: string
  }) => {
    const demoUser: AuthUser = {
      id: result.userId,
      email: result.email,
      name: 'Demo User',
      role: 'admin',
      workspaceId: result.workspaceId,
      sourceWorkspaceId: result.workspaceId,
      workspaceCode: result.workspaceCode,
      workspaceName: result.workspaceName,
      profileUrl: undefined,
      workspaceMode: 'demo',
      isConfigured: true
    }
    setUser(demoUser)
    setSession(null)
    writeWorkspaceModeSnapshot({
      workspaceId: demoUser.workspaceId,
      dataMode: 'demo'
    })
    saveRecovery(demoUser)
  }

  const performSignOut = async () => {
    explicitSignOutRef.current = true
    const signingOutUser = userRef.current
    const isDemoSession = signingOutUser?.workspaceMode === 'demo' || isDemoWorkspace(signingOutUser?.workspaceCode)
    try {
      console.log('[Auth] Signing out...')

      try {
        const { assetManager } = await import('@/lib/assetManager')
        assetManager.stopWatcher()
      } catch (e) {
        console.error('[Auth] Error stopping assetManager:', e)
      }

      if (isDemoSession && signingOutUser?.workspaceId) {
        await deleteDemoWorkspace(signingOutUser.workspaceId)
      }

      if (isSupabaseConfigured && !isDemoSession) {
        await signOutCurrentSupabaseSession()
      }
    } catch (err) {
      console.error('[Auth] Error during signOut:', err)
    } finally {
      if (isDemoSession && signingOutUser?.workspaceId) {
        try {
          await clearLocalDemoWorkspaceData(signingOutUser.workspaceId)
        } catch (cleanupError) {
          console.error('[Auth] Failed to clear local demo data:', cleanupError)
        }
      }

      setUser(null)
      setSession(null)

      clearWorkspaceCache()
      clearWorkspaceModeSnapshot()
      clearRecovery()
      clearActiveLocalAccount()

      console.log('[Auth] Sign out complete')
      explicitSignOutRef.current = false
    }
  }

  const signOut = async (options: { explicit?: boolean } = {}) => {
    if (options.explicit !== false) {
      const confirmed = await requestCashierShiftLogoutConfirmation(userRef.current)
      if (!confirmed) return
    }
    await performSignOut()
  }

  const hasRole = (roles: UserRole[]): boolean => {
    if (!user) return false
    return roles.includes(user.role)
  }

  const refreshUser = async () => {
    if (!isSupabaseConfigured) return

    const {
      data: { session },
      error
    } = (await runSupabaseAction('auth.refreshUser', () => refreshSupabaseSession(), {
      timeoutMs: 5000,
      platform: 'all'
    })) as any

    if (error) {
      console.error('Error refreshing session:', error)
      return
    }

    if (session?.user) {
      setSession(session)
      const parsedUser = parseUserFromSupabase(session.user)
      const enriched = await enrichUser(parsedUser)
      const effectiveUser = await restoreActiveLocalAccount(enriched)
      setUser(effectiveUser)
      saveRecovery(effectiveUser)
    }
  }

  const updateUser = (updates: Partial<AuthUser>) => {
    if (!user) return
    const nextUser = { ...user, ...updates }

    if (!nextUser.workspaceId) {
      const resetUser = resetWorkspaceAssignment(nextUser, user.workspaceId)
      setUser(resetUser)
      saveRecovery(resetUser)
      return
    }

    clearPreviousWorkspaceArtifacts(user.workspaceId, nextUser.workspaceId)
    setUser(nextUser)
    saveRecovery(nextUser)

    if (nextUser.workspaceId) {
      writeWorkspaceModeSnapshot({
        workspaceId: nextUser.workspaceId,
        dataMode: nextUser.workspaceMode
      })
    }
    void hydrateAssetProfile(nextUser)
  }

  const switchLocalAccount = async (userId: string, password: string) => {
    const currentUser = userRef.current
    if (!currentUser?.workspaceId || currentUser.workspaceMode !== 'local') {
      return {
        error: new Error('Account switching is available only in Local Mode.')
      }
    }
    if (!password) {
      return { error: new Error('Enter the account password.') }
    }

    try {
      const workspaceId = currentUser.workspaceId
      let account = await getLocalWorkspaceAccount(workspaceId, userId)
      if (!account) {
        return {
          error: new Error('This account is not available in the local workspace data.')
        }
      }

      const verification = await verifyLocalAccountPassword(workspaceId, userId, password)
      if (!verification.ok && verification.reason === 'missing') {
        if (!account.email) {
          return {
            error: new Error('This account must sign in online on this device once before it can be used offline.')
          }
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          return {
            error: new Error(
              'This account has not been prepared for offline access. Sign in with it once while online.'
            )
          }
        }

        const accountEmail = account.email
        const previousSession = sessionRef.current
        const restorePreviousSession = async () => {
          if (previousSession?.access_token && previousSession.refresh_token) {
            await supabase.auth.setSession({
              access_token: previousSession.access_token,
              refresh_token: previousSession.refresh_token
            })
          }
        }
        const { data, error } = (await runSupabaseAction(
          'auth.enrollLocalAccount',
          () =>
            supabase.auth.signInWithPassword({
              email: accountEmail,
              password
            }),
          { timeoutMs: 15000, platform: 'all' }
        )) as any

        if (error || !data?.user) {
          return {
            error: normalizeSupabaseActionError(error ?? new Error('Account validation failed.'))
          }
        }
        if (data.user.id !== userId) {
          await restorePreviousSession()
          return {
            error: new Error('The password belongs to a different account.')
          }
        }

        const enrolledUser = await enrichUser(parseUserFromSupabase(data.user))
        if (enrolledUser.workspaceId !== workspaceId || enrolledUser.workspaceMode !== 'local') {
          await restorePreviousSession()
          return {
            error: new Error('The selected account does not belong to this Local Mode workspace.')
          }
        }

        try {
          await cacheLocalWorkspaceAccounts(workspaceId, {
            isLocalFirst: enrolledUser.workspaceMode === 'local' || enrolledUser.workspaceMode === 'hybrid'
          })
        } catch (profileError) {
          console.warn('[Auth] Failed to refresh local workspace accounts:', profileError)
        }

        try {
          await cacheLocalAccountPermissions(workspaceId, userId)
        } catch (permissionError) {
          await restorePreviousSession()
          return {
            error: new Error(
              `The account was validated, but its offline permissions could not be prepared: ${normalizeSupabaseActionError(permissionError).message}`
            )
          }
        }

        if (data.session) {
          setSession(data.session)
        }
        await persistAuthUserLocally(enrolledUser)
        await enrollLocalAccountCredential({
          workspaceId,
          userId,
          email: enrolledUser.email,
          password
        })
        account = await getLocalWorkspaceAccount(workspaceId, userId)
        if (!account) {
          return {
            error: new Error('Failed to prepare the selected account for offline access.')
          }
        }
      } else if (!verification.ok && verification.reason === 'locked') {
        const seconds = Math.max(1, Math.ceil((verification.retryAfterMs ?? 0) / 1000))
        return {
          error: new Error(`Too many failed attempts. Try again in ${seconds} seconds.`)
        }
      } else if (!verification.ok) {
        return { error: new Error('Incorrect password.') }
      }

      // A local account switch is an explicit user hand-off. Complete the
      // current linked login/logout shift before changing identities.
      if (userId !== currentUser.id) {
        const completedForSwitch = await requestCashierShiftLogoutConfirmation(currentUser)
        if (!completedForSwitch) {
          return {
            error: new Error(i18n.t('paymentAccounts.errors.loginLogoutAccountSwitchCancelled'))
          }
        }
      }

      const nextUser: AuthUser = {
        ...currentUser,
        id: account.id,
        email: account.email || currentUser.email,
        name: account.name,
        role: account.role,
        profileUrl: account.profileUrl
      }

      await persistAuthUserLocally(nextUser)
      writeActiveLocalAccountId(workspaceId, nextUser.id)
      setUser(nextUser)
      saveRecovery(nextUser)

      return { error: null }
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  const switchCloudAccount = async (userId: string, password: string) => {
    const currentUser = userRef.current
    const currentSession = sessionRef.current
    if (
      !currentUser?.workspaceId ||
      (currentUser.workspaceMode !== 'cloud' && currentUser.workspaceMode !== 'hybrid')
    ) {
      return { error: new CloudAccountSwitchError('unavailable') }
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { error: new CloudAccountSwitchError('offline') }
    }

    let verifiedAuthUser: User | null = null
    const result = await performCloudAccountSwitch<AuthUser, Session>(
      {
        currentIdentity: currentUser,
        currentSession,
        targetUserId: userId,
        password
      },
      {
        isOnline: () =>
          connectionManager.getState().isOnline &&
          (typeof navigator === 'undefined' || navigator.onLine !== false),
        loadMember: (workspaceId, targetUserId) =>
          requestCloudWorkspaceAccount(workspaceId, targetUserId),
        verifyCredentials: async (email, enteredPassword) => {
          try {
            const isolatedClient = createClient(resolvedSupabaseUrl, resolvedSupabaseAnonKey, {
              auth: {
                autoRefreshToken: false,
                persistSession: false,
                detectSessionInUrl: false
              }
            })
            const { data, error } = (await runSupabaseAction(
              'auth.verifyCloudAccountSwitchPassword',
              () => isolatedClient.auth.signInWithPassword({ email, password: enteredPassword }),
              { timeoutMs: 15000, platform: 'all' }
            )) as any

            if (error || !data?.user || !data?.session) {
              const message = String(error?.message ?? '')
              const status = Number(error?.status ?? error?.context?.status)
              return {
                error:
                  status === 400 ||
                  status === 401 ||
                  /invalid login credentials|invalid credentials|email not confirmed/i.test(message)
                    ? 'credentials' as const
                    : 'connection' as const
              }
            }

            verifiedAuthUser = data.user as User
            return {
              credential: {
                user: { id: data.user.id },
                session: data.session
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
              error: /invalid login credentials|invalid credentials|email not confirmed/i.test(message)
                ? 'credentials' as const
                : 'connection' as const
            }
          }
        },
        completeOutgoingShift: (identity) => requestCashierShiftLogoutConfirmation(identity),
        commitSession: async (credential) => {
          const nextSession = credential.session as Session
          const { data, error } = await supabase.auth.setSession({
            access_token: nextSession.access_token,
            refresh_token: nextSession.refresh_token
          })
          if (error || !data.session) throw error ?? new Error('Session could not be changed.')
          sessionRef.current = data.session
          setSession(data.session)
          return data.session
        },
        loadIdentity: async () => {
          if (!verifiedAuthUser) throw new Error('Verified account is unavailable.')
          return enrichUser(parseUserFromSupabase(verifiedAuthUser))
        },
        publishIdentity: (nextIdentity) => {
          userRef.current = nextIdentity
          setUser({ ...nextIdentity })
          if (sessionRef.current) setSession(sessionRef.current)
          saveRecovery(nextIdentity)
        },
        confirmIncomingShift: (nextIdentity) => requestCashierShiftStartConfirmation(nextIdentity),
        restoreIdentity: async (previousSession, previousIdentity) => {
          const { data, error } = await supabase.auth.setSession({
            access_token: previousSession.access_token,
            refresh_token: previousSession.refresh_token
          })
          if (error || !data.session) throw error ?? new Error('Session could not be restored.')
          sessionRef.current = data.session
          userRef.current = previousIdentity
          setSession(sessionRef.current)
          setUser({ ...previousIdentity })
          saveRecovery(previousIdentity)
        }
      }
    )

    return {
      error: result.error ? new CloudAccountSwitchError(result.error) : null
    }
  }

  // User is kicked if authenticated but has no workspace
  const isKicked = !!user && !user.workspaceId

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        isLoading,
        isAuthenticated: isAuthenticatedState({
          hasSession: Boolean(session),
          hasUser: Boolean(user),
          canRestoreWithoutSession: canRestoreWithoutSupabaseSession(user)
        }),
        isKicked,
        isSupabaseConfigured,
        signIn,
        signInWithDemo,
        signUp,
        signOut,
        hasRole,
        refreshUser,
        updateUser,
        switchLocalAccount,
        switchCloudAccount
      }}
    >
      {children}
      <AppDialog open={Boolean(cashierShiftAuthRequest)} onOpenChange={() => undefined}>
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={false}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>
              {cashierShiftAuthRequest?.kind === 'start'
                ? i18n.t('paymentAccounts.loginLogoutStartTitle')
                : i18n.t('paymentAccounts.loginLogoutLogoutTitle')}
            </AppDialogTitle>
            <AppDialogDescription>
              {cashierShiftAuthRequest?.kind === 'start'
                ? i18n.t('paymentAccounts.loginLogoutStartDescription', {
                    cashier: cashierShiftAuthRequest.user.name,
                    drawer: cashierShiftAuthRequest.assignment?.accountNameSnapshot
                  })
                : i18n.t('paymentAccounts.loginLogoutLogoutDescription', {
                    cashier: cashierShiftAuthRequest?.user.name
                  })}
            </AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody>
            {cashierShiftAuthError ? (
              <p
                role="alert"
                className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {cashierShiftAuthError}
              </p>
            ) : null}
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={cancelCashierShiftAuthRequest} disabled={isCashierShiftAuthProcessing}>
              {cashierShiftAuthRequest?.kind === 'start'
                ? i18n.t('paymentAccounts.cancelLoginAndSignOut')
                : i18n.t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                void confirmCashierShiftAuthRequest()
              }}
              disabled={isCashierShiftAuthProcessing}
            >
              {cashierShiftAuthRequest?.kind === 'start'
                ? i18n.t('paymentAccounts.confirmStartShift')
                : i18n.t('paymentAccounts.confirmLogoutAndCompleteShift')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

export function useOptionalAuth() {
  return useContext(AuthContext)
}
