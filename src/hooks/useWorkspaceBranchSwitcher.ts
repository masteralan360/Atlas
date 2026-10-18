import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { normalizeWorkspaceDataMode } from '@/workspace/workspaceMode'
import { supabase } from '@/auth/supabase'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useToast } from '@/ui/components'
import {
    getRetriableActionToast,
    isRetriableWebRequestError,
    normalizeSupabaseActionError,
    runSupabaseAction
} from '@/lib/supabaseRequest'
import { invokeWorkspaceAccess } from '@/lib/workspaceAccess'

export type BranchListItem = {
    id: string
    branchWorkspaceId: string
    name: string
    createdAt: string
    archivedAt?: string
    workspaceName?: string
    workspaceCode?: string
}

interface UseWorkspaceBranchSwitcherOptions {
    showLoadError?: boolean
}

export function useWorkspaceBranchSwitcher(options: UseWorkspaceBranchSwitcherOptions = {}) {
    const [, setLocation] = useLocation()
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user, session, refreshUser, updateUser } = useAuth()
    const { workspaceName, branchInfo } = useWorkspace()
    const [branches, setBranches] = useState<BranchListItem[]>([])
    const [archivedBranches, setArchivedBranches] = useState<BranchListItem[]>([])
    const [isLoadingBranches, setIsLoadingBranches] = useState(false)
    const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null)

    const showActionError = useCallback((error: unknown, fallbackDescription: string) => {
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
    }, [t, toast])

    const loadBranches = useCallback(async () => {
        if (!user?.sourceWorkspaceId || branchInfo?.isBranch) {
            setBranches([])
            setArchivedBranches([])
            setIsLoadingBranches(false)
            return
        }

        setIsLoadingBranches(true)

        try {
            const { data: branchRows, error: branchError } = await runSupabaseAction(
                'branches.fetchMappings',
                () => supabase
                    .from('workspace_branches')
                    .select('id, name, created_at, archived_at, branch_workspace_id')
                    .eq('source_workspace_id', user.sourceWorkspaceId)
                    .order('created_at', { ascending: true }),
                { timeoutMs: 12000, platform: 'all' }
            ) as {
                data: Array<{
                    id: string
                    name: string
                    created_at: string
                    archived_at?: string | null
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

            const mappedBranches = rows.map((row): BranchListItem => {
                const workspace = workspaceMap.get(row.branch_workspace_id)
                return {
                    id: String(row.id),
                    branchWorkspaceId: String(row.branch_workspace_id),
                    name: row.name,
                    createdAt: row.created_at,
                    archivedAt: row.archived_at ?? undefined,
                    workspaceName: workspace?.name ?? row.name,
                    workspaceCode: workspace?.code
                }
            })

            setBranches(mappedBranches.filter((branch) => !branch.archivedAt))
            setArchivedBranches(mappedBranches.filter((branch) => Boolean(branch.archivedAt)))
        } catch (error) {
            console.error('[useWorkspaceBranchSwitcher] Failed to fetch branches:', error)
            setBranches([])
            setArchivedBranches([])
            if (options.showLoadError) {
                showActionError(
                    error,
                    t('branches.loadError', { defaultValue: 'Failed to load branches.' })
                )
            }
        } finally {
            setIsLoadingBranches(false)
        }
    }, [branchInfo?.isBranch, options.showLoadError, showActionError, t, user?.sourceWorkspaceId])

    useEffect(() => {
        void loadBranches()
    }, [loadBranches])

    const switchWorkspace = async (targetWorkspaceId: string) => {
        if (!targetWorkspaceId) {
            return false
        }

        setSwitchingWorkspaceId(targetWorkspaceId)

        try {
            const { data, error } = await invokeWorkspaceAccess<{
                workspace_id: string
                source_workspace_id: string
                current_workspace: string
                workspace_code: string
                workspace_name: string
                data_mode?: string | null
            }>({
                label: 'branches.switchWorkspace',
                fallbackAccessToken: session?.access_token,
                timeoutMs: 20000,
                body: {
                    action: 'switch-branch',
                    targetWorkspaceId
                }
            })

            if (error || !data) {
                throw error ?? new Error('Workspace switch failed')
            }

            updateUser({
                workspaceId: data.workspace_id,
                sourceWorkspaceId: data.source_workspace_id,
                workspaceCode: data.workspace_code,
                workspaceName: data.workspace_name,
                workspaceMode: normalizeWorkspaceDataMode(data.data_mode)
            })

            void refreshUser()

            setTimeout(() => {
                setLocation('/')
            }, 100)

            return true
        } catch (error) {
            console.error('[useWorkspaceBranchSwitcher] Failed to switch workspace:', error)
            showActionError(
                error,
                t('branches.switchError', { defaultValue: 'Failed to switch branches.' })
            )
            return false
        } finally {
            setSwitchingWorkspaceId(null)
        }
    }

    const currentWorkspaceLabel = workspaceName || branchInfo?.branchName || 'Atlas'
    const canReturnToSource = Boolean(
        branchInfo?.sourceWorkspaceId
        && user?.sourceWorkspaceId === branchInfo.sourceWorkspaceId
        && user.workspaceId !== user.sourceWorkspaceId
    )

    return {
        branchInfo,
        branches,
        archivedBranches,
        canReturnToSource,
        currentWorkspaceLabel,
        isLoadingBranches,
        loadBranches,
        switchingWorkspaceId,
        switchWorkspace
    }
}
