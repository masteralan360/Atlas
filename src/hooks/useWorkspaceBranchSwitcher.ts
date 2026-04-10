import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { useWorkspace } from '@/workspace'
import { useToast } from '@/ui/components'
import {
    getRetriableActionToast,
    isRetriableWebRequestError,
    normalizeSupabaseActionError,
    runSupabaseAction
} from '@/lib/supabaseRequest'

export type BranchListItem = {
    id: string
    branchWorkspaceId: string
    name: string
    createdAt: string
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
    const [isLoadingBranches, setIsLoadingBranches] = useState(false)
    const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(null)

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
        if (!user?.workspaceId || branchInfo?.isBranch) {
            setBranches([])
            setIsLoadingBranches(false)
            return
        }

        setIsLoadingBranches(true)

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
            console.error('[useWorkspaceBranchSwitcher] Failed to fetch branches:', error)
            setBranches([])
            if (options.showLoadError) {
                showActionError(
                    error,
                    t('branches.loadError', { defaultValue: 'Failed to load branches.' })
                )
            }
        } finally {
            setIsLoadingBranches(false)
        }
    }

    useEffect(() => {
        void loadBranches()
    }, [user?.workspaceId, branchInfo?.isBranch])

    const switchWorkspace = async (targetWorkspaceId: string) => {
        if (!targetWorkspaceId) {
            return false
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
                    branch_source_workspace_id?: string | null
                    branch_workspace_id?: string | null
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
                branchSourceWorkspaceId: data.branch_source_workspace_id ?? undefined,
                branchWorkspaceId: data.branch_workspace_id ?? undefined,
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
    const hasTrackedBranchEntry = Boolean(user?.branchSourceWorkspaceId || user?.branchWorkspaceId)
    const canReturnToSource = Boolean(
        branchInfo?.sourceWorkspaceId
        && (
            !hasTrackedBranchEntry
            || (
                user?.branchSourceWorkspaceId === branchInfo.sourceWorkspaceId
                && user?.branchWorkspaceId === user.workspaceId
            )
        )
    )

    return {
        branchInfo,
        branches,
        canReturnToSource,
        currentWorkspaceLabel,
        isLoadingBranches,
        loadBranches,
        switchingWorkspaceId,
        switchWorkspace
    }
}
