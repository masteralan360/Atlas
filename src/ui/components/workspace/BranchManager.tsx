import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ArrowLeft, GitBranch, Loader2, Plus, RotateCcw } from 'lucide-react'
import { useAuth } from '@/auth'
import { useWorkspaceBranchSwitcher, type BranchListItem } from '@/hooks/useWorkspaceBranchSwitcher'
import { Input } from '@/ui/components/input'
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
  Label,
  useToast,
} from '@/ui/components'
import { cn, formatDate } from '@/lib/utils'
import {
    getRetriableActionToast,
    isRetriableWebRequestError,
    normalizeSupabaseActionError,
} from '@/lib/supabaseRequest'
import { invokeWorkspaceAccess } from '@/lib/workspaceAccess'

export function BranchManager() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { session } = useAuth()
    const {
        branchInfo,
        branches,
        archivedBranches,
        canReturnToSource,
        currentWorkspaceLabel,
        isLoadingBranches: isLoading,
        loadBranches,
        switchingWorkspaceId,
        switchWorkspace
    } = useWorkspaceBranchSwitcher({ showLoadError: true })
    const [createName, setCreateName] = useState('')
    const [isCreating, setIsCreating] = useState(false)
    const [branchToArchive, setBranchToArchive] = useState<BranchListItem | null>(null)
    const [isArchiving, setIsArchiving] = useState(false)
    const [restoringWorkspaceId, setRestoringWorkspaceId] = useState<string | null>(null)

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

    const handleCreateBranch = async () => {
        const branchName = createName.trim()
        if (!branchName) {
            return
        }

        setIsCreating(true)

        try {
            const { error } = await invokeWorkspaceAccess({
                label: 'branches.create',
                fallbackAccessToken: session?.access_token,
                timeoutMs: 20000,
                body: {
                    action: 'create-branch',
                    name: branchName
                }
            })

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

    const handleArchiveBranch = async () => {
        if (!branchToArchive) {
            return
        }

        setIsArchiving(true)

        try {
            const { error } = await invokeWorkspaceAccess({
                label: 'branches.archive',
                fallbackAccessToken: session?.access_token,
                timeoutMs: 20000,
                body: {
                    action: 'archive-branch',
                    targetWorkspaceId: branchToArchive.branchWorkspaceId
                }
            })

            if (error) {
                throw error
            }

            toast({
                title: t('branches.archive', { defaultValue: 'Archive Branch' }),
                description: branchToArchive.workspaceName || branchToArchive.name
            })
            setBranchToArchive(null)
            await loadBranches()
        } catch (error) {
            console.error('[BranchManager] Failed to archive branch:', error)
            showActionError(
                error,
                t('branches.archiveError', { defaultValue: 'Failed to archive branch.' })
            )
        } finally {
            setIsArchiving(false)
        }
    }

    const handleRestoreBranch = async (branch: BranchListItem) => {
        setRestoringWorkspaceId(branch.branchWorkspaceId)

        try {
            const { error } = await invokeWorkspaceAccess({
                label: 'branches.restore',
                fallbackAccessToken: session?.access_token,
                timeoutMs: 20000,
                body: {
                    action: 'restore-branch',
                    targetWorkspaceId: branch.branchWorkspaceId
                }
            })

            if (error) {
                throw error
            }

            toast({
                title: t('branches.restore', { defaultValue: 'Restore Branch' }),
                description: branch.workspaceName || branch.name
            })
            await loadBranches()
        } catch (error) {
            console.error('[BranchManager] Failed to restore branch:', error)
            showActionError(
                error,
                t('branches.restoreError', { defaultValue: 'Failed to restore branch.' })
            )
        } finally {
            setRestoringWorkspaceId(null)
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
                            {t('branches.noActiveBranches', { defaultValue: 'No active branches' })}
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
                                                disabled={isSwitching || isArchiving || Boolean(restoringWorkspaceId)}
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
                                                variant="outline"
                                                onClick={() => setBranchToArchive(branch)}
                                                disabled={isSwitching || isArchiving || Boolean(restoringWorkspaceId)}
                                                className="gap-2"
                                            >
                                                <Archive className="h-4 w-4" />
                                                {t('branches.archive', { defaultValue: 'Archive Branch' })}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )
                        })
                    )}
                </div>

                {archivedBranches.length > 0 && (
                    <div className="space-y-3 border-t border-border/60 pt-6">
                        <div>
                            <h3 className="font-semibold text-foreground">
                                {t('branches.archived', { defaultValue: 'Archived Branches' })}
                            </h3>
                            <p className="text-sm text-muted-foreground">
                                {t('branches.archivedHint', {
                                    defaultValue: 'Archived branches are unavailable, but all of their data is retained.'
                                })}
                            </p>
                        </div>

                        {archivedBranches.map((branch) => {
                            const isRestoring = restoringWorkspaceId === branch.branchWorkspaceId
                            return (
                                <div
                                    key={branch.id}
                                    className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-muted/20 p-4 md:flex-row md:items-center md:justify-between"
                                >
                                    <div className="space-y-1">
                                        <p className="font-semibold text-foreground">
                                            {branch.workspaceName || branch.name}
                                        </p>
                                        {branch.archivedAt && (
                                            <p className="text-xs text-muted-foreground">
                                                {t('branches.archivedOn', { defaultValue: 'Archived' })}: {formatDate(branch.archivedAt)}
                                            </p>
                                        )}
                                    </div>

                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => handleRestoreBranch(branch)}
                                        disabled={Boolean(restoringWorkspaceId) || isArchiving}
                                        className="gap-2"
                                    >
                                        {isRestoring ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <RotateCcw className="h-4 w-4" />
                                        )}
                                        {t('branches.restore', { defaultValue: 'Restore Branch' })}
                                    </Button>
                                </div>
                            )
                        })}
                    </div>
                )}
            </CardContent>

            <Dialog open={!!branchToArchive} onOpenChange={(open) => !open && setBranchToArchive(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('branches.archive', { defaultValue: 'Archive Branch' })}</DialogTitle>
                        <DialogDescription>
                            {t('branches.archiveConfirm', {
                                defaultValue: 'This branch will become unavailable. Its sales and all other data will be retained and can be restored later.'
                            })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                        {branchToArchive?.workspaceName || branchToArchive?.name}
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setBranchToArchive(null)}
                            disabled={isArchiving}
                        >
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="button"
                            onClick={handleArchiveBranch}
                            disabled={isArchiving}
                            className="gap-2"
                        >
                            {isArchiving ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Archive className="h-4 w-4" />
                            )}
                            {t('branches.archive', { defaultValue: 'Archive Branch' })}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    )
}
