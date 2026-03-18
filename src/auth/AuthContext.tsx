import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from 'react'
import { supabase, isSupabaseConfigured } from './supabase'
import type { User, Session } from '@supabase/supabase-js'
import type {
    UserRole,
    WorkspaceDataMode
} from '@/local-db/models'
import { connectionManager } from '@/lib/connectionManager'
import { setActiveBusinessWorkspace } from '@/lib/network'
import { clearWorkspaceCache } from '@/workspace/workspaceCache'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { runSupabaseAction } from '@/lib/supabaseRequest'

interface AuthUser {
    id: string
    email: string
    name: string
    role: UserRole
    workspaceId: string
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
    signUp: (params: {
        email: string;
        password: string;
        name: string;
        role: UserRole;
        passkey: string;
        workspaceName?: string;
        workspaceCode?: string;
        adminContacts?: { type: 'phone' | 'email' | 'address'; value: string; label?: string; isPrimary: boolean }[];
    }) => Promise<{ error: Error | null }>
    signOut: () => Promise<void>
    hasRole: (roles: UserRole[]) => boolean
    refreshUser: () => Promise<void>
    updateUser: (updates: Partial<AuthUser>) => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// Demo user for offline/non-configured mode
const DEMO_USER: AuthUser = {
    id: 'demo-user',
    email: 'demo@asaas.local',
    name: 'Demo User',
    role: 'admin',
    workspaceId: 'demo-workspace',
    workspaceCode: 'DEMO-1234',
    workspaceName: 'Demo Workspace',
    profileUrl: undefined,
    workspaceMode: 'local'
}

function parseUserFromSupabase(user: User): AuthUser {
    return {
        id: user.id,
        email: user.email ?? '',
        name: user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User',
        role: (user.user_metadata?.role as UserRole) ?? 'viewer',
        workspaceId: user.user_metadata?.workspace_id ?? '',
        workspaceCode: user.user_metadata?.workspace_code ?? '',
        workspaceName: user.user_metadata?.workspace_name,
        profileUrl: user.user_metadata?.profile_url,
        isConfigured: user.user_metadata?.is_configured,
        workspaceMode: user.user_metadata?.data_mode === 'local' ? 'local' : 'cloud'
    }
}

// Helper: fetch workspace + profile data for a parsed user
async function enrichUser(parsedUser: AuthUser): Promise<AuthUser> {
    if (!parsedUser.workspaceId) return parsedUser

    const [wsResult, profileResult] = await Promise.allSettled([
        supabase
            .from('workspaces')
            .select('code, name, is_configured, data_mode')
            .eq('id', parsedUser.workspaceId)
            .single(),
        supabase
            .from('profiles')
            .select('profile_url')
            .eq('id', parsedUser.id)
            .single()
    ])

    if (wsResult.status === 'fulfilled' && wsResult.value.data) {
        parsedUser.workspaceCode = wsResult.value.data.code
        parsedUser.workspaceName = wsResult.value.data.name
        parsedUser.isConfigured = wsResult.value.data.is_configured
        parsedUser.workspaceMode = wsResult.value.data.data_mode === 'local' ? 'local' : 'cloud'
        writeWorkspaceModeSnapshot({
            workspaceId: parsedUser.workspaceId,
            dataMode: parsedUser.workspaceMode
        })
    }
    if (profileResult.status === 'fulfilled' && profileResult.value.data?.profile_url) {
        parsedUser.profileUrl = profileResult.value.data.profile_url
    }

    return parsedUser
}

// Recovery bridge helpers
function saveRecovery(user: AuthUser) {
    localStorage.setItem('asaas_session_recovery', JSON.stringify({
        ...user,
        recoveredAt: Date.now()
    }))
}

function getRecoveredUser(): (AuthUser & { recoveredAt?: number }) | null {
    try {
        const recovered = localStorage.getItem('asaas_session_recovery')
        return recovered ? JSON.parse(recovered) : null
    } catch { return null }
}

function clearRecovery() {
    localStorage.removeItem('asaas_session_recovery')
}

function isRecoveryEligibleError(error: unknown) {
    if (!error) return false

    const message = error instanceof Error
        ? error.message.toLowerCase()
        : String(error).toLowerCase()

    return (
        message.includes('timed out') ||
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('failed to fetch') ||
        message.includes('fetch failed') ||
        message.includes('offline')
    )
}

function canUseRecoveryBridge(error?: unknown) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return true
    }

    return isRecoveryEligibleError(error)
}



export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(null)
    const [session, setSession] = useState<Session | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const sessionRef = useRef<Session | null>(null)
    const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const authStateTaskRef = useRef(0)

    // Keep sessionRef in sync
    useEffect(() => { sessionRef.current = session }, [session])
    useEffect(() => {
        setActiveBusinessWorkspace(user?.workspaceId ?? null)
    }, [user?.workspaceId])

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

        const processAuthStateChange = async (session: Session | null, taskId: number) => {
            if (!isMounted || taskId !== authStateTaskRef.current) return

            setSession(session)
            const parsedUser = session?.user ? parseUserFromSupabase(session.user) : null

            if (!parsedUser) {
                clearWorkspaceModeSnapshot(user?.workspaceId)
                setUser(null)
                clearRecovery()
                setIsLoading(false)
                return
            }

            if (parsedUser.workspaceId) {
                const enriched = await enrichUser(parsedUser)

                if (!isMounted || taskId !== authStateTaskRef.current) return

                // Final verify to ensure we haven't logged out during enrichment
                const { data: { session: currentSession } } = await runSupabaseAction(
                    'auth.verifyStateChangeSession',
                    () => supabase.auth.getSession(),
                    { timeoutMs: 5000, platform: 'all' }
                ) as any

                if (!isMounted || taskId !== authStateTaskRef.current) return

                if (currentSession?.user?.id === parsedUser.id) {
                    setUser({ ...enriched })
                    saveRecovery(enriched)
                }
            } else {
                setUser(parsedUser)
                saveRecovery(parsedUser)
            }

            if (!isMounted || taskId !== authStateTaskRef.current) return
            setIsLoading(false)
        }

        // Register auth state listener FIRST so it catches deferred events
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            console.log(`[Auth] State change: ${_event}`, session?.user?.id)
            const taskId = ++authStateTaskRef.current
            window.setTimeout(() => {
                void processAuthStateChange(session, taskId)
            }, 0)
        })

        const fetchInitialSession = async () => {
            try {
                const { data: { session } } = await runSupabaseAction(
                    'auth.initialSession',
                    () => supabase.auth.getSession(),
                    { timeoutMs: 8000, platform: 'all' }
                ) as any

                if (session) {
                    setSession(session)
                    const parsedUser = session.user ? parseUserFromSupabase(session.user) : null

                    if (parsedUser) {
                        const enriched = await enrichUser(parsedUser)
                        setUser(enriched)
                        saveRecovery(enriched)
                    }
                } else {
                    if (canUseRecoveryBridge()) {
                        const recovered = getRecoveredUser()
                        if (recovered) {
                            const maxAge = 7 * 24 * 60 * 60 * 1000
                            const isStale = recovered.recoveredAt && (Date.now() - recovered.recoveredAt > maxAge)

                            if (!isStale) {
                                console.log('[Auth] Restoring session from recovery bridge...')
                                setUser(recovered)
                            } else {
                                console.log('[Auth] Recovery bridge is stale (>7 days), clearing.')
                                clearRecovery()
                            }
                        }
                    } else {
                        clearRecovery()
                    }
                }
            } catch (e) {
                console.error('[Auth] Initial session fetch failed:', e);
                let allowRecovery = canUseRecoveryBridge(e)

                // Second chance: try refreshSession directly (different code path)
                try {
                    console.log('[Auth] Attempting refreshSession as fallback...')
                    const { data, error } = await runSupabaseAction(
                        'auth.refreshFallback',
                        () => supabase.auth.refreshSession(),
                        { timeoutMs: 5000, platform: 'all' }
                    ) as any

                    if (!error && data?.session) {
                        console.log('[Auth] refreshSession succeeded ✓')
                        setSession(data.session)
                        const parsedUser = parseUserFromSupabase(data.session.user)
                        const enriched = await enrichUser(parsedUser)
                        setUser(enriched)
                        saveRecovery(enriched)
                        return // Success — skip recovery bridge
                    }
                } catch (refreshErr) {
                    console.warn('[Auth] refreshSession also failed:', refreshErr)
                    allowRecovery = allowRecovery || canUseRecoveryBridge(refreshErr)

                    if (!allowRecovery) {
                        clearRecovery()
                    }
                }

                if (!allowRecovery) {
                    clearRecovery()
                }

                if (allowRecovery) {
                    const recovered = getRecoveredUser()
                    if (recovered) {
                        console.log('[Auth] Using recovery bridge (limited mode).')
                        setUser(recovered)
                    }
                }
            } finally {
                setIsLoading(false)
            }
        }

        fetchInitialSession();

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
            if (!sessionRef.current) return

            console.log(`[Auth] Connection event: ${event} — verifying session...`)

            try {
                const { data: { session }, error } = await runSupabaseAction(
                    'auth.wakeSessionCheck',
                    () => supabase.auth.getSession(),
                    { timeoutMs: 5000, platform: 'all' }
                ) as any

                if (error || !session) {
                    console.log('[Auth] Session invalid after wake, attempting refresh...')
                    const { data: refreshData, error: refreshError } = await runSupabaseAction(
                        'auth.wakeRefreshSession',
                        () => supabase.auth.refreshSession(),
                        { timeoutMs: 5000, platform: 'all' }
                    ) as any

                    if (refreshError || !refreshData.session) {
                        console.error('[Auth] Session refresh failed — signing out gracefully.')
                        // Import toast lazily to avoid circular deps
                        const { toast } = await import('@/ui/components/use-toast')
                        toast({
                            title: "Session expired",
                            description: "Your session has expired. Please sign in again.",
                            variant: "destructive",
                        })
                        await signOut()
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
        watchdogRef.current = setInterval(async () => {
            const currentSession = sessionRef.current
            if (!currentSession?.expires_at) return

            const expiresAt = currentSession.expires_at * 1000 // convert to ms
            const timeUntilExpiry = expiresAt - Date.now()

            // If token expires in less than 2 minutes, proactively refresh
            if (timeUntilExpiry < 2 * 60 * 1000 && timeUntilExpiry > 0) {
                console.log(`[Auth] Token expires in ${Math.round(timeUntilExpiry / 1000)}s — proactive refresh`)
                const { error } = await runSupabaseAction(
                    'auth.proactiveRefresh',
                    () => supabase.auth.refreshSession(),
                    { timeoutMs: 5000, platform: 'all' }
                ) as any
                if (error) {
                    console.error('[Auth] Proactive refresh failed:', error)
                }
            }
        }, 5 * 60 * 1000) // every 5 minutes

        return () => {
            if (watchdogRef.current) clearInterval(watchdogRef.current)
        }
    }, [])

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
            const { error } = await runSupabaseAction(
                'auth.signIn',
                () => supabase.auth.signInWithPassword({
                    email,
                    password
                }),
                { timeoutMs: 15000, platform: 'all' }
            ) as any
            return { error: error as Error | null }
        } catch (err: any) {
            console.error('[Auth] Sign in failed/timeout:', err)
            return { error: err }
        }
    }

    const signUp = async ({ email, password, name, role = 'viewer', passkey, workspaceName, workspaceCode, adminContacts }: {
        email: string;
        password: string;
        name: string;
        role: UserRole;
        passkey: string;
        workspaceName?: string;
        workspaceCode?: string;
        adminContacts?: { type: 'phone' | 'email' | 'address'; value: string; label?: string; isPrimary: boolean }[];
    }) => {
        if (!isSupabaseConfigured) {
            const localDemoUser = { ...DEMO_USER, email, name, role, workspaceName: workspaceName || 'Local Workspace' }
            setUser(localDemoUser)
            writeWorkspaceModeSnapshot({
                workspaceId: localDemoUser.workspaceId,
                dataMode: localDemoUser.workspaceMode
            })
            return { error: null }
        }

        let workspaceId = ''
        let resolvedWorkspaceName = workspaceName

        try {
            if (role === 'admin') {
                if (!workspaceName) throw new Error('Workspace name is required for Admins')

                const { data: wsData, error: wsError } = await supabase.rpc('create_workspace', {
                    w_name: workspaceName
                })
                if (wsError) throw wsError

                workspaceId = wsData?.id || (Array.isArray(wsData) ? wsData[0]?.id : (wsData?.create_workspace?.id || ''))
                resolvedWorkspaceName = wsData?.name || (Array.isArray(wsData) ? wsData[0]?.name : (wsData?.create_workspace?.name || workspaceName))


            } else {
                if (!workspaceCode) throw new Error('Workspace code is required to join')

                const { data: wsData, error: wsError } = await supabase
                    .from('workspaces')
                    .select('id, name')
                    .eq('code', workspaceCode.toUpperCase())
                    .single()

                if (wsError || !wsData) throw new Error('Invalid workspace code')

                workspaceId = wsData.id
                resolvedWorkspaceName = wsData.name
            }

            let resolvedWorkspaceCode = workspaceCode
            if (role === 'admin' && !resolvedWorkspaceCode) {
                const { data: wsData } = await supabase.from('workspaces').select('code').eq('id', workspaceId).single()
                if (wsData) resolvedWorkspaceCode = wsData.code
            }

            const { error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        name,
                        role,
                        passkey,
                        workspace_id: workspaceId,
                        workspace_code: resolvedWorkspaceCode,
                        workspace_name: resolvedWorkspaceName
                    }
                }
            })

            // Insert workspace contacts AFTER signUp so the session is active for RLS
            if (!error && role === 'admin' && workspaceId && adminContacts && adminContacts.length > 0) {
                const contactsPayload = adminContacts.map(p => ({
                    workspace_id: workspaceId,
                    type: p.type,
                    value: p.value,
                    label: p.label || null,
                    is_primary: p.isPrimary
                }))
                const { error: contactsErr } = await supabase.from('workspace_contacts').insert(contactsPayload)
                if (contactsErr) console.error('[Auth] Failed to insert workspace contacts:', contactsErr)
            }

            return { error: error as Error | null }
        } catch (err: any) {
            return { error: err as Error }
        }
    }

    const signOut = async () => {
        try {
            console.log('[Auth] Signing out...')

            try {
                const { assetManager } = await import('@/lib/assetManager')
                assetManager.stopWatcher()
            } catch (e) {
                console.error('[Auth] Error stopping assetManager:', e)
            }

            if (isSupabaseConfigured) {
                await supabase.auth.signOut()
            }
        } catch (err) {
            console.error('[Auth] Error during signOut:', err)
        } finally {
            setUser(null)
            setSession(null)

            clearWorkspaceCache()
            clearWorkspaceModeSnapshot()
            clearRecovery()

            console.log('[Auth] Sign out complete')
        }
    }

    const hasRole = (roles: UserRole[]): boolean => {
        if (!user) return false
        return roles.includes(user.role)
    }

    const refreshUser = async () => {
        if (!isSupabaseConfigured) return

        const { data: { session }, error } = await runSupabaseAction(
            'auth.refreshUser',
            () => supabase.auth.refreshSession(),
            { timeoutMs: 5000, platform: 'all' }
        ) as any

        if (error) {
            console.error('Error refreshing session:', error)
            return
        }

        if (session?.user) {
            setSession(session)
            const parsedUser = parseUserFromSupabase(session.user)
            const enriched = await enrichUser(parsedUser)
            setUser(enriched)
        }
    }

    const updateUser = (updates: Partial<AuthUser>) => {
        if (!user) return
        const nextUser = { ...user, ...updates }
        setUser(nextUser)

        if (nextUser.workspaceId) {
            writeWorkspaceModeSnapshot({
                workspaceId: nextUser.workspaceId,
                dataMode: nextUser.workspaceMode
            })
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
                isAuthenticated: !!user,
                isKicked,
                isSupabaseConfigured,
                signIn,
                signUp,
                signOut,
                hasRole,
                refreshUser,
                updateUser
            }}
        >
            {children}
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
