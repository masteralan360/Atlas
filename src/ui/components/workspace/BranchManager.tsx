import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, GitBranch, Loader2, Plus, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    useToast
} from '@/ui/components'
import { cn, formatDate } from '@/lib/utils'
import {
    getRetriableActionToast,
    isRetriableWebRequestError,
    normalizeSupabaseActionError,
    runSupabaseAction
} from '@/lib/supabaseRequest'

type BranchListItem = {
    id: string
    branchWorkspaceId: string
    name: string
    createdAt: string
    workspaceName?: string
    workspaceCode?: string
}

export function BranchManager() {
    const [, setLocation] = useLocation()
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user, session, refreshUser, updateUser } = useAuth()
    const { workspaceName, branchInfo } = useWorkspace()
    const [branches, setBranches] = useState<BranchListItem[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [createName, setCreateName] = useState('')
    const [isCreating, setIsCreating] = useState(false)
    const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null)
    const [branchToDelete, setBranchToDelete] = useState<BranchListItem | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    const showActionError = (error: unknown, fallbackDescription: string) => {
        const normalized = normalizeSupabaseActionError(error)
        if (isRetriableWebRequestError(normalized)) {
            const message = getRetriableActionToast(normalized)
            toast({
                title: message.title,
                description: message.description,
                variant: 'destructive'
            })
            return
        }

        toast({
            title: t('common.error', { defaultValue: 'Error' }),
            description: fallbackDescription || normalized.message,
            variant: 'destructive'
        })
    }

    const getAccessToken = async () => {
        const { data } = await supabase.auth.getSession()
        return data.session?.access_token ?? session?.access_token ?? ''
    }

    const loadBranches = async () => {
        if (!user?.workspaceId || user.role !== 'admin') {
            setBranches([])
            setIsLoading(false)
            return
        }

        setIsLoading(true)

        try {
            const { data: branchRows, error: branchError } = await runSupabaseAction(
                'branches.fetchMappings',
                () => supabase
                    .from('workspace_branches')
                    .select('id, name, created_at, branch_workspace_id')
                    .eq('source_workspace_id', user.workspaceId)
                    .order('created_at', { ascending: true }),
                { timeoutMs: 12000, platform: 'all' }
            ) as {
                data: Array<{
                    id: string
                    name: string
                    created_at: string
                    branch_workspace_id: string
                }> | null
                error?: unknown
            }

            if (branchError) {
                throw branchError
            }

            const rows = branchRows ?? []
            const branchIds = rows.map((row) => row.branch_workspace_id).filter(Boolean)
            const workspaceMap = new Map<string, { name?: string; code?: string }>()

            if (branchIds.length > 0) {
                const { data: branchWorkspaces, error: branchWorkspacesError } = await runSupabaseAction(
                    'branches.fetchWorkspaces',
                    () => supabase
                        .from('workspaces')
                        .select('id, name, code')
                        .in('id', branchIds),
                    { timeoutMs: 12000, platform: 'all' }
                ) as {
                    data: Array<{ id: string; name?: string | null; code?: string | null }> | null
                    error?: unknown
                }

                if (branchWorkspacesError) {
                    throw branchWorkspacesError
                }

                for (const row of branchWorkspaces ?? []) {
                    workspaceMap.set(String(row.id), {
                        name: row.name ?? undefined,
                        code: row.code ?? undefined
                    })
                }
            }

            setBranches(rows.map((row) => {
                const workspace = workspaceMap.get(row.branch_workspace_id)
                return {
                    id: String(row.id),
                    branchWorkspaceId: String(row.branch_workspace_id),
                    name: row.name,
                    createdAt: row.created_at,
                    workspaceName: workspace?.name ?? row.name,
                    workspaceCode: workspace?.code
                }
            }))
        } catch (error) {
            console.error('[BranchManager] Failed to fetch branches:', error)
            setBranches([])
            showActionError(
                error,
                t('branches.loadError', { defaultValue: 'Failed to load branches.' })
            )
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        void loadBranches()
    }, [user?.workspaceId, user?.role])

    const handleSwitchWorkspace = async (targetWorkspaceId: string) => {
        if (!targetWorkspaceId) {
            return
        }

        setSwitchingWorkspaceId(targetWorkspaceId)

        try {
            const accessToken = await getAccessToken()
            if (!accessToken) {
                throw new Error('Authentication required')
            }

            const { data, error } = await runSupabaseAction(
                'branches.switchWorkspace',
                () => supabase.functions.invoke('workspace-access', {
                    headers: {
                        Authorization: `Bearer ${accessToken}`
                    },
                    body: {
                        action: 'switch-branch',
                        targetWorkspaceId
                    }
                }),
                { timeoutMs: 20000, platform: 'all' }
            ) as {
                data: {
                    workspace_id: string
                    workspace_code: string
                    workspace_name: string
                    data_mode?: string | null
                } | null
                error?: unknown
            }

            if (error || !data) {
                throw error ?? new Error('Workspace switch failed')
            }

            updateUser({
                workspaceId: data.workspace_id,
                workspaceCode: data.workspace_code,
                workspaceName: data.workspace_name,
                workspaceMode: data.data_mode === 'local'
                    ? 'local'
                    : data.data_mode === 'hybrid'
                        ? 'hybrid'
                        : 'cloud'
            })

            void refreshUser()

            setTimeout(() => {
                setLocation('/')
            }, 100)
        } catch (error) {
            console.error('[BranchManager] Failed to switch workspace:', error)
            showActionError(
                error,
                t('branches.switchError', { defaultValue: 'Failed to switch branches.' })
            )
        } finally {
            setSwitchingWorkspaceId(null)
        }
    }

    const handleCreateBranch = async () => {
        const branchName = createName.trim()
        if (!branchName) {
            return
        }

        setIsCreating(true)

        try {
            const accessToken = await getAccessToken()
            if (!accessToken) {
                throw new Error('Authentication required')
            }

            const { error } = await runSupabaseAction(
                'branches.create',
                () => supabase.functions.invoke('workspace-access', {
                    headers: {
                        Authorization: `Bearer ${accessToken}`
                    },
                    body: {
                        action: 'create-branch',
                        name: branchName
                    }
                }),
                { timeoutMs: 20000, platform: 'all' }
            ) as { data: unknown; error?: unknown }

            if (error) {
                const normalized = normalizeSupabaseActionError(error)
                if (normalized.message.includes('Cannot create branches from a branch workspace')) {
                    throw new Error(t('branches.noNested'))
                }
                throw normalized
            }

            setCreateName('')
            toast({
                title: t('branches.create', { defaultValue: 'Create Branch' }),
                description: branchName
            })
            await loadBranches()
        } catch (error) {
            console.error('[BranchManager] Failed to create branch:', error)
            showActionError(
                error,
                t('branches.createError', { defaultValue: 'Failed to create branch.' })
            )
        } finally {
            setIsCreating(false)
        }
    }

    const handleDeleteBranch = async () => {
        if (!branchToDelete) {
            return
        }

        setIsDeleting(true)

        try {
            const accessToken = await getAccessToken()
            if (!accessToken) {
                throw new Error('Authentication required')
            }

            const { error } = await runSupabaseAction(
                'branches.delete',
                () => supabase.functions.invoke('workspace-access', {
                    headers: {
                        Authorization: `Bearer ${accessToken}`
                    },
                    body: {
                        action: 'delete-branch',
                        targetWorkspaceId: branchToDelete.branchWorkspaceId
                    }
                }),
                { timeoutMs: 20000, platform: 'all' }
            ) as { data: unknown; error?: unknown }

            if (error) {
                throw error
            }

            toast({
                title: t('branches.delete', { defaultValue: 'Delete Branch' }),
                description: branchToDelete.workspaceName || branchToDelete.name
            })
            setBranchToDelete(null)
            await loadBranches()
        } catch (error) {
            console.error('[BranchManager] Failed to delete branch:', error)
            showActionError(
                error,
                t('branches.deleteError', { defaultValue: 'Failed to delete branch.' })
            )
        } finally {
            setIsDeleting(false)
        }
    }

    if (branchInfo?.isBranch) {
        const currentBranchLabel = workspaceName || branchInfo.branchName || t('branches.title')
        const canReturnToSource = Boolean(branchInfo.sourceWorkspaceId)

        return (
            <Card className="border-emerald-500/20 bg-emerald-500/5">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <GitBranch className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
                        {t('branches.title', { defaultValue: 'Branches' })}
                    </CardTitle>
                    <CardDescription>
                        {t('branches.onBranch', { defaultValue: 'You are on branch' })}: {currentBranchLabel}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="rounded-2xl border border-emerald-500/20 bg-background/80 p-4">
                        <p className="text-sm text-muted-foreground">
                            {branchInfo.sourceWorkspaceName
                                ? `${currentBranchLabel} \u2190 ${branchInfo.sourceWorkspaceName}`
                                : currentBranchLabel}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                            {t('branches.createHint', {
                                defaultValue: 'Create an isolated workspace branch for testing or parallel operations.'
                            })}
                        </p>
                    </div>

                    <Button
                        type="button"
                        onClick={() => branchInfo.sourceWorkspaceId && handleSwitchWorkspace(branchInfo.sourceWorkspaceId)}
                        disabled={!canReturnToSource || switchingWorkspaceId === branchInfo.sourceWorkspaceId}
                        className="gap-2"
                    >
                        {switchingWorkspaceId === branchInfo.sourceWorkspaceId ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <ArrowLeft className="h-4 w-4" />
                        )}
                        {t('branches.returnToSource', { defaultValue: 'Return to Source' })}
                    </Button>
                </CardContent>
            </Card>
        )
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <GitBranch className="h-5 w-5 text-primary" />
                    {t('branches.title', { defaultValue: 'Branches' })}
                </CardTitle>
                <CardDescription>
                    {t('branches.createHint', {
                        defaultValue: 'Create an isolated workspace branch for testing or parallel operations.'
                    })}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                <div className="grid gap-3 rounded-2xl border border-border/60 bg-muted/20 p-4 md:grid-cols-[1fr_auto]">
                    <div className="space-y-2">
                        <Label htmlFor="branch-name">{t('branches.branchName', { defaultValue: 'Branch Name' })}</Label>
                        <Input
                            id="branch-name"
                            value={createName}
                            onChange={(event) => setCreateName(event.target.value)}
                            placeholder={t('branches.branchName', { defaultValue: 'Branch Name' })}
                            maxLength={80}
                        />
                    </div>
                    <div className="flex items-end">
                        <Button
                            type="button"
                            onClick={handleCreateBranch}
                            disabled={isCreating || createName.trim().length === 0}
                            className="gap-2"
                        >
                            {isCreating ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Plus className="h-4 w-4" />
                            )}
                            {t('branches.create', { defaultValue: 'Create Branch' })}
                        </Button>
                    </div>
                </div>

                <div className="space-y-3">
                    {isLoading ? (
                        <div className="flex items-center justify-center rounded-2xl border border-dashed border-border p-8">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                    ) : branches.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                            {t('branches.noBranches', { defaultValue: 'No branches yet' })}
                        </div>
                    ) : (
                        branches.map((branch) => {
                            const isSwitching = switchingWorkspaceId === branch.branchWorkspaceId
                            return (
                                <div
                                    key={branch.id}
                                    className={cn(
                                        'rounded-2xl border border-border/70 bg-background/70 p-4',
                                        isSwitching && 'border-primary/40'
                                    )}
                                >
                                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                        <div className="space-y-1">
                                            <p className="font-semibold text-foreground">
                                                {branch.workspaceName || branch.name}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {t('branches.branchName', { defaultValue: 'Branch Name' })}: {branch.name}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatDate(branch.createdAt)}
                                            </p>
                                            {branch.workspaceCode && (
                                                <p className="text-xs font-mono text-muted-foreground">
                                                    {branch.workspaceCode}
                                                </p>
                                            )}
                                        </div>

                                        <div className="flex flex-wrap gap-2">
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={() => handleSwitchWorkspace(branch.branchWorkspaceId)}
                                                disabled={isSwitching || isDeleting}
                                                className="gap-2"
                                            >
                                                {isSwitching ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <GitBranch className="h-4 w-4" />
                                                )}
                                                {t('branches.switchTo', { defaultValue: 'Switch to Branch' })}
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="destructive"
                                                onClick={() => setBranchToDelete(branch)}
                                                disabled={isSwitching || isDeleting}
                                                className="gap-2"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                                {t('branches.delete', { defaultValue: 'Delete Branch' })}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )
                        })
                    )}
                </div>
            </CardContent>

            <Dialog open={!!branchToDelete} onOpenChange={(open) => !open && setBranchToDelete(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('branches.delete', { defaultValue: 'Delete Branch' })}</DialogTitle>
                        <DialogDescription>
                            {t('branches.deleteConfirm', {
                                defaultValue: 'Are you sure? This will permanently delete all data in this branch.'
                            })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-muted-foreground">
                        {branchToDelete?.workspaceName || branchToDelete?.name}
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setBranchToDelete(null)}
                            disabled={isDeleting}
                        >
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={handleDeleteBranch}
                            disabled={isDeleting}
                            className="gap-2"
                        >
                            {isDeleting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Trash2 className="h-4 w-4" />
                            )}
                            {t('branches.delete', { defaultValue: 'Delete Branch' })}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    )
}
