import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, GitBranch, Loader2, Plus, Trash2 } from 'lucide-react'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { useWorkspaceBranchSwitcher, type BranchListItem } from '@/hooks/useWorkspaceBranchSwitcher'
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

export function BranchManager() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { session } = useAuth()
    const {
        branchInfo,
        branches,
        canReturnToSource,
        currentWorkspaceLabel,
        isLoadingBranches: isLoading,
        loadBranches,
        switchingWorkspaceId,
        switchWorkspace
    } = useWorkspaceBranchSwitcher({ showLoadError: true })
    const [createName, setCreateName] = useState('')
    const [isCreating, setIsCreating] = useState(false)
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
        return (
            <Card className="border-emerald-500/20 bg-emerald-500/5">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <GitBranch className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
                        {t('branches.title', { defaultValue: 'Branches' })}
                    </CardTitle>
                    <CardDescription>
                        {t('branches.onBranch', { defaultValue: 'You are on branch' })}: {currentWorkspaceLabel}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="rounded-2xl border border-emerald-500/20 bg-background/80 p-4">
                        <p className="text-sm text-muted-foreground">
                            {branchInfo.sourceWorkspaceName
                                ? `${currentWorkspaceLabel} \u2190 ${branchInfo.sourceWorkspaceName}`
                                : currentWorkspaceLabel}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">
                            {t('branches.createHint', {
                                defaultValue: 'Create an isolated workspace branch for testing or parallel operations.'
                            })}
                        </p>
                    </div>

                    <Button
                        type="button"
                        onClick={() => branchInfo.sourceWorkspaceId && switchWorkspace(branchInfo.sourceWorkspaceId)}
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
                                                onClick={() => switchWorkspace(branch.branchWorkspaceId)}
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
