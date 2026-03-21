import { useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { Button, Input, Label, Card, CardContent, CardHeader, CardTitle, CardDescription, LanguageSwitcher, ThemeToggle } from '@/ui/components'
import { Boxes, Key, Loader2, LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'

export function WorkspaceRegistration() {
    const [, setLocation] = useLocation()
    const { user, refreshUser, signOut, updateUser } = useAuth()
    const { t } = useTranslation()
    const [workspaceCode, setWorkspaceCode] = useState('')
    const [error, setError] = useState('')
    const [isLoading, setIsLoading] = useState(false)

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setIsLoading(true)

        try {
            const { data, error: rpcError } = await runSupabaseAction('workspace.join', () =>
                supabase.rpc('join_workspace', {
                    workspace_code_input: workspaceCode.toUpperCase()
                })
            )

            if (rpcError) {
                const normalizedRpcError = normalizeSupabaseActionError(rpcError)
                if (normalizedRpcError.message.includes('Invalid workspace code')) {
                    setError(t('workspaceRegistration.invalidCode'))
                } else {
                    setError(normalizedRpcError.message)
                }
                return
            }

            // Manually update local state with returned data to allow immediate navigation
            if (data) {
                updateUser({
                    workspaceId: data.workspace_id,
                    workspaceCode: data.workspace_code,
                    workspaceName: data.workspace_name
                })
            }

            // Trigger a refresh in background
            refreshUser()

            // Redirect to dashboard with a small delay to allow state update to propagate
            setTimeout(() => {
                setLocation('/')
            }, 100)
        } catch (err: any) {
            const normalized = normalizeSupabaseActionError(err)
            if (isRetriableWebRequestError(normalized)) {
                setError(getRetriableActionToast(normalized).description)
            } else {
                setError(normalized.message || t('common.error'))
            }
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="h-screen overflow-hidden bg-background relative flex flex-col">
            {/* Theme & Language Switchers */}
            <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
                <LanguageSwitcher />
                <ThemeToggle />
                <Button variant="ghost" size="icon" onClick={() => signOut()} title={t('auth.signOut')}>
                    <LogOut className="h-[1.2rem] w-[1.2rem]" />
                    <span className="sr-only">{t('auth.signOut')}</span>
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex items-center justify-center">
                <div className="w-full max-w-md space-y-6 py-12">
                    {/* Logo */}
                    <div className="flex flex-col items-center gap-2">
                        <div className="p-3 bg-primary/10 rounded-2xl">
                            <Boxes className="w-10 h-10 text-primary" />
                        </div>
                        <h1 className="text-2xl font-bold gradient-text">Atlas</h1>
                        <p className="text-sm text-muted-foreground">{t('workspaceRegistration.title')}</p>
                    </div>

                    <Card className="glass shadow-xl">
                        <CardHeader className="text-center">
                            <CardTitle>{t('workspaceRegistration.title')}</CardTitle>
                            <CardDescription>{t('workspaceRegistration.subtitle')}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {/* Info about current state */}
                            <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                                <p className="text-sm text-amber-600 dark:text-amber-400">
                                    {t('workspaceRegistration.kickedMessage')}
                                </p>
                            </div>

                            {/* User info */}
                            {user && (
                                <div className="mb-4 p-3 rounded-lg bg-secondary/50">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-sm font-bold text-white">
                                            {user.name?.charAt(0).toUpperCase() || 'U'}
                                        </div>
                                        <div className="flex-1">
                                            <p className="font-medium">{user.name}</p>
                                            <p className="text-xs text-muted-foreground capitalize">
                                                {t(`auth.roles.${user.role}`)}
                                            </p>
                                        </div>
                                        <Button variant="ghost" size="icon" onClick={() => signOut()} className="text-muted-foreground hover:text-destructive" title={t('auth.signOut')}>
                                            <LogOut className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="workspaceCode">{t('auth.workspaceCode')}</Label>
                                    <div className="relative">
                                        <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="workspaceCode"
                                            type="text"
                                            placeholder="ABCD-1234"
                                            value={workspaceCode}
                                            onChange={(e) => setWorkspaceCode(e.target.value.toUpperCase())}
                                            className="pl-10 uppercase"
                                            required
                                        />
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {t('workspaceRegistration.codeHint')}
                                    </p>
                                </div>

                                {error && (
                                    <p className="text-sm text-destructive">{error}</p>
                                )}

                                <Button type="submit" className="w-full" disabled={isLoading || !workspaceCode}>
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            {t('workspaceRegistration.joining')}
                                        </>
                                    ) : (
                                        t('workspaceRegistration.join')
                                    )}
                                </Button>
                            </form>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    )
}
