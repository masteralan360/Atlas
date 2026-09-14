import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Database, HardDrive, LockKeyhole, LogOut, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { checkNativeSqliteReadiness } from '@/local-db/localModeSqlite'
import {
    bindPwaWorkspaceAssetScope,
    checkPwaSqliteReadiness,
    clearPwaWorkspaceAssetScope,
    closePwaDatabase,
    PWA_SQLITE_FATAL_EVENT
} from '@/local-db/pwaSqlite'
import { isTauri } from '@/lib/platform'
import { Button } from '@/ui/components/button'
import {
    isSqliteWorkspaceGateOpenForScope,
    requiresSqliteWorkspaceGate,
    resolveSqliteWorkspaceGateState,
    type SqliteWorkspaceGateState
} from './sqliteWorkspaceGateState'

/**
 * Cloud Sync and Local workspaces never fall back to IndexedDB durability.
 * This gate stays above the application until the scoped OPFS database is
 * writable and this browser instance owns the workspace-wide lease.
 */
export function SqliteWorkspaceGate({ children }: { children: ReactNode }) {
    const { t } = useTranslation()
    const { user, isAuthenticated, signOut } = useAuth()
    const [retryToken, setRetryToken] = useState(0)
    const [state, setState] = useState<SqliteWorkspaceGateState>({ status: 'idle' })
    const workspaceId = user?.workspaceId ?? ''
    const userId = user?.id ?? ''
    const scopeKey = `${workspaceId}:${userId}`
    const shouldCheck = Boolean(
        isAuthenticated
        && userId
        && workspaceId
        && requiresSqliteWorkspaceGate({ dataMode: user?.workspaceMode })
    )
    const intendedScopeRef = useRef<string | null>(null)
    intendedScopeRef.current = shouldCheck ? scopeKey : null

    useEffect(() => () => {
        intendedScopeRef.current = null
    }, [])

    useEffect(() => {
        if (!shouldCheck) {
            setState({ status: 'idle' })
            return
        }

        let cancelled = false
        setState({ status: 'checking', scopeKey })
        const readinessCheck = isTauri() ? checkNativeSqliteReadiness : checkPwaSqliteReadiness
        const scope = {
            workspaceId,
            userId
        }
        void readinessCheck(scope).then(async (readiness) => {
            if (cancelled || intendedScopeRef.current !== scopeKey) {
                if (!isTauri() && readiness.ready && intendedScopeRef.current !== scopeKey) {
                    void closePwaDatabase(scope)
                }
                return
            }
            if (!isTauri() && readiness.ready) {
                await bindPwaWorkspaceAssetScope(scope)
            }
            setState(resolveSqliteWorkspaceGateState(scopeKey, readiness))
        }).catch(() => {
            if (cancelled) return
            setState({ status: 'blocked', scopeKey, reason: 'initialization-failed' })
        })

        return () => {
            cancelled = true
            queueMicrotask(() => {
                if (!isTauri() && intendedScopeRef.current !== scopeKey) {
                    void clearPwaWorkspaceAssetScope()
                    void closePwaDatabase(scope)
                }
            })
        }
    }, [retryToken, scopeKey, shouldCheck, userId, workspaceId])

    useEffect(() => {
        const handleFatalWorker = (event: Event) => {
            const detail = (event as CustomEvent<{ scope?: { workspaceId?: string; userId?: string } }>).detail
            if (`${detail?.scope?.workspaceId ?? ''}:${detail?.scope?.userId ?? ''}` !== scopeKey) return
            setState({ status: 'blocked', scopeKey, reason: 'initialization-failed' })
        }
        window.addEventListener(PWA_SQLITE_FATAL_EVENT, handleFatalWorker)
        return () => window.removeEventListener(PWA_SQLITE_FATAL_EVENT, handleFatalWorker)
    }, [scopeKey])

    if (!shouldCheck) return <>{children}</>

    const currentState: SqliteWorkspaceGateState = state.status !== 'idle' && state.scopeKey === scopeKey
        ? state
        : { status: 'checking', scopeKey }
    if (isSqliteWorkspaceGateOpenForScope(currentState, scopeKey)) return <>{children}</>

    const ownedElsewhere = currentState.status === 'blocked' && currentState.reason === 'workspace-owned'
    const Icon = ownedElsewhere ? LockKeyhole : currentState.status === 'checking' ? Database : HardDrive

    return (
        <div
            className="fixed inset-0 z-[20000] flex items-center justify-center bg-background p-6"
            role={currentState.status === 'blocked' ? 'alertdialog' : 'status'}
            aria-modal={currentState.status === 'blocked' ? 'true' : undefined}
            aria-labelledby="sqlite-workspace-gate-title"
            aria-describedby="sqlite-workspace-gate-description"
        >
            <div className="w-full max-w-lg rounded-3xl border border-border/70 bg-card p-8 text-center shadow-2xl">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Icon className={currentState.status === 'checking' ? 'h-8 w-8 animate-pulse' : 'h-8 w-8'} />
                </div>
                <h1 id="sqlite-workspace-gate-title" className="mt-5 text-2xl font-bold tracking-tight text-foreground">
                    {currentState.status === 'checking'
                        ? t('sqliteWorkspaceGate.checkingTitle')
                        : ownedElsewhere
                            ? t('sqliteWorkspaceGate.ownedTitle')
                            : t('sqliteWorkspaceGate.unavailableTitle')}
                </h1>
                <p id="sqlite-workspace-gate-description" className="mt-3 text-sm leading-6 text-muted-foreground">
                    {currentState.status === 'checking'
                        ? t('sqliteWorkspaceGate.checkingDescription')
                        : ownedElsewhere
                            ? t('sqliteWorkspaceGate.ownedDescription')
                            : t('sqliteWorkspaceGate.unavailableDescription')}
                </p>

                {currentState.status === 'blocked' && (
                    <div className="mt-7 grid gap-3 sm:grid-cols-2">
                        <Button type="button" allowViewer onClick={() => setRetryToken((value) => value + 1)}>
                            <RefreshCw className="h-4 w-4" />
                            {t('sqliteWorkspaceGate.retry')}
                        </Button>
                        <Button type="button" variant="outline" allowViewer onClick={() => void signOut()}>
                            <LogOut className="h-4 w-4" />
                            {t('sqliteWorkspaceGate.signOut')}
                        </Button>
                    </div>
                )}
            </div>
        </div>
    )
}
