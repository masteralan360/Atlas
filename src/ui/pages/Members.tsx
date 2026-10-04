import { useState, useEffect, useMemo } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogDescription,
    Select,
    SelectContent,
    SelectGroup,
    SelectLabel,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch
} from '@/ui/components'
import { UsersRound, UserMinus, Loader2, Shield, Eye, Briefcase, UserRound, KeyRound, ShieldCheck, Copy, CopyCheck } from 'lucide-react'
import { ProfileCardModal } from '@/ui/components/ProfileCardModal'
import { useTranslation } from 'react-i18next'
import { cn, formatDate } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { invokeWorkspaceAccess } from '@/lib/workspaceAccess'
import { useToast } from '@/ui/components'
import { useWorkspace } from '@/workspace'
import {
    WORKSPACE_PERMISSION_DEFINITIONS,
    getWorkspacePermissionModule,
    getViewOwnRecordPermissionState,
    isSupportedWorkspacePermissionKey,
    VIEW_OWN_RECORD_PERMISSION_KEYS,
    type WorkspacePermissionKey
} from '@/permissions'
import { launcherSections, launcherSectionOrder } from '@/ui/navigation/navigationMeta'
import type { PlanModuleKey } from '@/plans/workspacePlans'
import { db } from '@/local-db'
import { getLocalModeSqliteConnection } from '@/local-db/localModeSqlite'

interface Member {
    id: string
    name: string
    role: string
    profile_url?: string
    created_at: string
}

interface WorkspacePermission {
    id: string
    workspace_id: string
    user_uuid: string
    key: string
    module: string
}

interface PermissionCopyWorkspace {
    workspaceId: string
    workspaceName: string
    workspaceCode?: string
    relationType: 'current' | 'source' | 'branch'
}

interface PermissionCopyMember {
    id: string
    name: string
    role: string
    profile_url?: string | null
    permissionKeys: string[]
}

const roleIcons: Record<string, typeof Shield> = {
    admin: Shield,
    staff: Briefcase,
    viewer: Eye
}

const roleColors: Record<string, string> = {
    admin: 'bg-purple-500/10 text-purple-500',
    staff: 'bg-blue-500/10 text-blue-500',
    viewer: 'bg-slate-500/10 text-slate-500'
}

type WorkspacePermissionDefinition = typeof WORKSPACE_PERMISSION_DEFINITIONS[number]
type WorkspacePermissionModule = WorkspacePermissionDefinition['module']

// These permission keys use database-facing module names, while the existing
// permission picker already presents their corresponding user-facing modules.
const PERMISSION_MODULE_DISPLAY_GROUP: Partial<Record<WorkspacePermissionModule, WorkspacePermissionModule>> = {
    sales: 'salesHistory',
    invoice_history: 'invoiceHistory',
}

function getPermissionDisplayModule(module: WorkspacePermissionModule) {
    return PERMISSION_MODULE_DISPLAY_GROUP[module] ?? module
}

const PERMISSION_MODULE_DEFAULT_LABELS: Record<string, string> = {
    global: 'Global',
    payment: 'Payments',
    paymentAccounts: 'Payment Accounts',
    cashierShiftControl: 'Cashier Shift Control',
    directTransaction: 'Direct Transactions',
    businessPartners: 'Business Partners',
    agents: 'Agents',
    salesAgentCommissions: 'Sales Agent Commissions',
    postService: 'Post Service',
    fleet: 'Fleet',
    customers: 'Customers',
    suppliers: 'Suppliers',
    orders: 'Orders',
    ecommerce: 'E-Commerce',
    accounting: 'Accounting and Expenses',
    invoiceHistory: 'Invoice History',
    loans: 'Loans',
    realEstate: 'Real Estate',
    travelTransportation: 'Travel & Transportation',
    currencyExchange: 'Currency Exchange',
    currencyExchangeFeeRules: 'Fee & Commission Rules',
    clinicalAppointments: 'Clinical Appointments',
    clinicalPatients: 'Patients',
    installments: 'Installments',
    ledger: 'Ledger',
    stockAdjustments: 'Stock Adjustments',
    inventoryTransactions: 'Inventory Transactions',
    inventoryTransfer: 'Inventory Transfer',
    storages: 'Storages',
    discounts: 'Discounts',
    revenueAnalytics: 'Revenue Analytics',
    teamPerformance: 'Team Performance',
    hr: 'HR',
    manualEntry: 'Manual Entry',
    manualEntryTemplates: 'Manual Entry Templates',
    pos: 'POS',
    instantPos: 'Instant POS',
    salesHistory: 'Sales History',
    products: 'Products',
    budget: 'Budget'
}

const PERMISSION_MODULE_PLAN_MODULES: Partial<Record<WorkspacePermissionModule, PlanModuleKey>> = {
    payment: 'payments',
    paymentAccounts: 'payment_accounts',
    cashierShiftControl: 'cashier_shift_control',
    directTransaction: 'direct_transactions',
    businessPartners: 'business_partners',
    agents: 'agents',
    salesAgentCommissions: 'sales_agent_commissions',
    postService: 'post_service',
    fleet: 'agents',
    customers: 'customers',
    suppliers: 'suppliers',
    orders: 'orders',
    sales: 'sales_history',
    ecommerce: 'ecommerce',
    accounting: 'accounting',
    invoiceHistory: 'invoice_history',
    invoice_history: 'invoice_history',
    loans: 'loans',
    realEstate: 'real_estate',
    travelTransportation: 'travel_transportation',
    currencyExchange: 'currency_exchange',
    currencyExchangeFeeRules: 'currency_exchange',
    clinicalAppointments: 'clinical_appointments',
    clinicalPatients: 'clinical_appointments',
    installments: 'installments',
    ledger: 'ledger',
    stockAdjustments: 'stock_adjustments',
    inventoryTransactions: 'inventory_transactions',
    inventoryTransfer: 'inventory_transfer',
    storages: 'storages',
    discounts: 'discounts',
    revenueAnalytics: 'revenue_analytics',
    teamPerformance: 'team_performance',
    hr: 'hr',
    pos: 'pos',
    instantPos: 'instant_pos',
    salesHistory: 'sales_history',
    products: 'products',
    budget: 'accounting'
}

export function Members() {
    const { user, session } = useAuth()
    const { hasCapability, isDemoMode, isLocalMode, planCapabilities } = useWorkspace()
    const { t } = useTranslation()
    const { toast } = useToast()
    const [members, setMembers] = useState<Member[]>([])
    const [permissions, setPermissions] = useState<WorkspacePermission[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [permissionsLoading, setPermissionsLoading] = useState(false)
    const [kickingMemberId, setKickingMemberId] = useState<string | null>(null)
    const [permissionMutationKey, setPermissionMutationKey] = useState<string | null>(null)
    const [memberToKick, setMemberToKick] = useState<Member | null>(null)
    const [permissionMember, setPermissionMember] = useState<Member | null>(null)
    const [selectedPermissionModule, setSelectedPermissionModule] = useState<string>('global')
    const [profileUserId, setProfileUserId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [copyDialogOpen, setCopyDialogOpen] = useState(false)
    const [copyWorkspaces, setCopyWorkspaces] = useState<PermissionCopyWorkspace[]>([])
    const [copyWorkspacesLoading, setCopyWorkspacesLoading] = useState(false)
    const [copyWorkspaceId, setCopyWorkspaceId] = useState<string>('')
    const [copyMembers, setCopyMembers] = useState<PermissionCopyMember[]>([])
    const [copyMembersLoading, setCopyMembersLoading] = useState(false)
    const [copyMemberId, setCopyMemberId] = useState<string>('')
    const [copyingPermissions, setCopyingPermissions] = useState(false)
    const [copyError, setCopyError] = useState<string | null>(null)
    const canManageWorkspacePermissions = !isDemoMode
        && hasCapability('workspaceManagementPermissions')

    const getErrorMessage = (err: unknown) => {
        const normalized = normalizeSupabaseActionError(err)
        if (isRetriableWebRequestError(normalized)) {
            return getRetriableActionToast(normalized).description
        }
        return normalized.message || t('common.error')
    }

    const fetchPermissions = async () => {
        if (
            isDemoMode
            || user?.role !== 'admin'
            || !user?.workspaceId
            || !canManageWorkspacePermissions
        ) {
            setPermissions([])
            return
        }

        setPermissionsLoading(true)
        try {
            if (isLocalMode) {
                const connection = await getLocalModeSqliteConnection()
                const rows: WorkspacePermission[] = []
                if (connection) {
                    const entities = await connection.select<Array<{
                        entity_id: string
                        workspace_id: string
                        payload: string
                    }>>(
                        `SELECT entity_id, workspace_id, payload
                         FROM local_entities
                         WHERE entity_type = 'workspace_permissions'
                           AND workspace_id = $1`,
                        [user.workspaceId]
                    )
                    for (const entity of entities) {
                        const data = JSON.parse(entity.payload) as Record<string, unknown>
                        rows.push({
                            id: entity.entity_id,
                            workspace_id: entity.workspace_id,
                            user_uuid: data.userUuid as string,
                            key: data.key as string,
                            module: data.module as string,
                        })
                    }
                }
                setPermissions(rows)
            } else {
                const { data, error } = await runSupabaseAction('members.permissions.fetch', () =>
                    supabase
                        .from('workspace_permissions')
                        .select('id, workspace_id, user_uuid, key, module')
                        .eq('workspace_id', user.workspaceId)
                        .order('module', { ascending: true })
                )

                if (error) throw normalizeSupabaseActionError(error)
                setPermissions((data || []) as WorkspacePermission[])
            }
        } catch (err) {
            console.error('Error fetching member permissions:', err)
            setError(getErrorMessage(err))
        } finally {
            setPermissionsLoading(false)
        }
    }

    const fetchMembers = async () => {
        if (!user?.workspaceId) return

        setIsLoading(true)
        setError(null)
        try {
            if (isDemoMode || isLocalMode) {
                const localProfiles = await db.profiles
                    .where('workspaceId')
                    .equals(user.workspaceId)
                    .toArray()
                setMembers(localProfiles.map((profile) => ({
                    id: profile.id,
                    name: profile.name,
                    role: profile.role,
                    profile_url: profile.profile_url ?? undefined,
                    created_at: profile.created_at ?? new Date().toISOString()
                })))
                if (user.role === 'admin') {
                    await fetchPermissions()
                } else {
                    setPermissions([])
                }
                return
            }

            const { data, error } = await runSupabaseAction('members.fetch', () =>
                supabase
                    .from('profiles')
                    .select('id, name, role, created_at, profile_url, workspace_id, current_workspace')
                    .eq('workspace_id', user.workspaceId)
                    .order('created_at', { ascending: true })
            )

            if (error) throw normalizeSupabaseActionError(error)
            setMembers(data || [])
            if (data) {
                db.profiles.bulkPut(data.map((p) => ({
                    id: p.id,
                    workspaceId: p.workspace_id,
                    currentWorkspaceId: p.current_workspace || p.workspace_id,
                    name: p.name,
                    role: p.role || '',
                    profile_url: p.profile_url,
                    created_at: p.created_at,
                }))).catch(console.error)
            }
            if (user.role === 'admin') {
                await fetchPermissions()
            } else {
                setPermissions([])
            }
        } catch (err) {
            console.error('Error fetching members:', err)
            setError(getErrorMessage(err))
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        fetchMembers()
    }, [canManageWorkspacePermissions, isDemoMode, user?.workspaceId, user?.role])

    const permissionsByUserId = useMemo(() => {
        const next = new Map<string, Set<WorkspacePermissionKey>>()

        permissions.forEach((permission) => {
            if (!isSupportedWorkspacePermissionKey(permission.key)) {
                return
            }

            const existing = next.get(permission.user_uuid) || new Set<WorkspacePermissionKey>()
            existing.add(permission.key)
            next.set(permission.user_uuid, existing)
        })

        return next
    }, [permissions])

    const handlePermissionToggle = async (
        member: Member,
        permissionKey: WorkspacePermissionKey,
        shouldGrant: boolean
    ) => {
        if (user?.role !== 'admin' || !user.workspaceId || member.role === 'admin' || !canManageWorkspacePermissions) {
            return
        }

        const mutationKey = `${member.id}:${permissionKey}`
        setPermissionMutationKey(mutationKey)
        setError(null)

        try {
            if (isLocalMode) {
                if (shouldGrant) {
                    const existing = await db.workspace_permissions
                        .where('[workspaceId+userUuid+key]')
                        .equals([user.workspaceId, member.id, permissionKey])
                        .first()
                    if (!existing) {
                        const { generateId } = await import('@/lib/utils')
                        await db.workspace_permissions.put({
                            id: generateId(),
                            workspaceId: user.workspaceId,
                            userUuid: member.id,
                            key: permissionKey,
                            module: getWorkspacePermissionModule(permissionKey),
                        })
                    }
                } else {
                    await db.workspace_permissions
                        .where('[workspaceId+userUuid+key]')
                        .equals([user.workspaceId, member.id, permissionKey])
                        .delete()
                }
            } else {
                if (shouldGrant) {
                    const payload = {
                        workspace_id: user.workspaceId,
                        user_uuid: member.id,
                        key: permissionKey,
                        module: getWorkspacePermissionModule(permissionKey)
                    }

                    const { error } = await runSupabaseAction('members.permissions.grant', () =>
                        supabase
                            .from('workspace_permissions')
                            .upsert(payload, { onConflict: 'workspace_id,user_uuid,key' })
                    )

                    if (error) throw normalizeSupabaseActionError(error)
                } else {
                    const { error } = await runSupabaseAction('members.permissions.revoke', () =>
                        supabase
                            .from('workspace_permissions')
                            .delete()
                            .eq('workspace_id', user.workspaceId)
                            .eq('user_uuid', member.id)
                            .eq('key', permissionKey)
                    )

                    if (error) throw normalizeSupabaseActionError(error)
                }
            }

            await fetchPermissions()
            window.dispatchEvent(new CustomEvent('workspace-permissions:changed'))
        } catch (err) {
            console.error('Error updating member permission:', err)
            setError(getErrorMessage(err))
        } finally {
            setPermissionMutationKey(null)
        }
    }

    const handleGlobalViewOwnToggle = async (member: Member, shouldGrant: boolean) => {
        if (user?.role !== 'admin' || !user.workspaceId || member.role === 'admin' || !canManageWorkspacePermissions) {
            return
        }

        const mutationKey = `${member.id}:global.view_own`
        setPermissionMutationKey(mutationKey)
        setError(null)

        try {
            if (isLocalMode) {
                await db.transaction('rw', db.workspace_permissions, async () => {
                    if (shouldGrant) {
                        const { generateId } = await import('@/lib/utils')
                        for (const permissionKey of VIEW_OWN_RECORD_PERMISSION_KEYS) {
                            const existing = await db.workspace_permissions
                                .where('[workspaceId+userUuid+key]')
                                .equals([user.workspaceId, member.id, permissionKey])
                                .first()

                            if (!existing) {
                                await db.workspace_permissions.put({
                                    id: generateId(),
                                    workspaceId: user.workspaceId,
                                    userUuid: member.id,
                                    key: permissionKey,
                                    module: getWorkspacePermissionModule(permissionKey),
                                })
                            }
                        }
                        return
                    }

                    for (const permissionKey of VIEW_OWN_RECORD_PERMISSION_KEYS) {
                        await db.workspace_permissions
                            .where('[workspaceId+userUuid+key]')
                            .equals([user.workspaceId, member.id, permissionKey])
                            .delete()
                    }
                })
            } else if (shouldGrant) {
                const payload = VIEW_OWN_RECORD_PERMISSION_KEYS.map((permissionKey) => ({
                    workspace_id: user.workspaceId,
                    user_uuid: member.id,
                    key: permissionKey,
                    module: getWorkspacePermissionModule(permissionKey)
                }))

                const { error } = await runSupabaseAction('members.permissions.grantAllViewOwn', () =>
                    supabase
                        .from('workspace_permissions')
                        .upsert(payload, { onConflict: 'workspace_id,user_uuid,key' })
                )

                if (error) throw normalizeSupabaseActionError(error)
            } else {
                const { error } = await runSupabaseAction('members.permissions.revokeAllViewOwn', () =>
                    supabase
                        .from('workspace_permissions')
                        .delete()
                        .eq('workspace_id', user.workspaceId)
                        .eq('user_uuid', member.id)
                        .in('key', [...VIEW_OWN_RECORD_PERMISSION_KEYS])
                )

                if (error) throw normalizeSupabaseActionError(error)
            }

            await fetchPermissions()
            window.dispatchEvent(new CustomEvent('workspace-permissions:changed'))
        } catch (err) {
            console.error('Error updating global view-own permissions:', err)
            setError(getErrorMessage(err))
        } finally {
            setPermissionMutationKey(null)
        }
    }

    const visiblePermissionDefinitions = useMemo(() => {
        const availableModules = new Set(planCapabilities.modules)
        return WORKSPACE_PERMISSION_DEFINITIONS.filter((permission) => {
            if (permission.module === 'global') return true
            if (permission.module === 'installments' && availableModules.has('real_estate')) return true
            const planModule = PERMISSION_MODULE_PLAN_MODULES[permission.module]
            return planModule ? availableModules.has(planModule) : false
        })
    }, [planCapabilities.modules])

    const selectedModulePermissions = useMemo(() => (
        visiblePermissionDefinitions.filter((permission) => (
            getPermissionDisplayModule(permission.module) === selectedPermissionModule
        ))
    ), [selectedPermissionModule, visiblePermissionDefinitions])

    const selectedMemberPermissionKeys = useMemo(() => (
        permissionMember
            ? permissionsByUserId.get(permissionMember.id) || new Set<WorkspacePermissionKey>()
            : new Set<WorkspacePermissionKey>()
    ), [permissionMember, permissionsByUserId])

    const globalViewOwnState = useMemo(
        () => getViewOwnRecordPermissionState(selectedMemberPermissionKeys),
        [selectedMemberPermissionKeys]
    )

    const modulesBySection = useMemo(() => {
        const groups: Record<string, Array<{
            module: string
            section: string
            icon: typeof WORKSPACE_PERMISSION_DEFINITIONS[number]['icon']
            labelKey: string
            defaultLabel: string
        }>> = {}
        visiblePermissionDefinitions.forEach((permission) => {
            const section = permission.section || 'other'
            const displayModule = getPermissionDisplayModule(permission.module)
            if (!groups[section]) groups[section] = []
            if (groups[section].some((entry) => entry.module === displayModule)) return
            groups[section].push({
                module: displayModule,
                section,
                icon: permission.icon,
                labelKey: `members.permissions.modules.${displayModule}`,
                defaultLabel: PERMISSION_MODULE_DEFAULT_LABELS[displayModule] ?? permission.defaultLabel
            })
        })
        return groups
    }, [visiblePermissionDefinitions])

    const moduleMetaMap = useMemo(() => {
        const map: Record<string, {
            icon: typeof WORKSPACE_PERMISSION_DEFINITIONS[number]['icon']
            labelKey: string
            defaultLabel: string
        }> = {}
        Object.values(modulesBySection).forEach((moduleList) => {
            moduleList.forEach((entry) => {
                map[entry.module] = {
                    icon: entry.icon,
                    labelKey: entry.labelKey,
                    defaultLabel: entry.defaultLabel
                }
            })
        })
        return map
    }, [modulesBySection])

    useEffect(() => {
        if (!permissionMember) return
        if (visiblePermissionDefinitions.some((permission) => (
            getPermissionDisplayModule(permission.module) === selectedPermissionModule
        ))) return
        setSelectedPermissionModule('global')
    }, [permissionMember, selectedPermissionModule, visiblePermissionDefinitions])

    const openPermissionModal = (member: Member) => {
        if (member.role === 'admin' || !canManageWorkspacePermissions) return
        setSelectedPermissionModule('global')
        setPermissionMember(member)
    }

    const handleKick = async () => {
        if (!memberToKick || isDemoMode || isLocalMode) return

        setKickingMemberId(memberToKick.id)
        setError(null)

        try {
            const { error } = await invokeWorkspaceAccess({
                label: 'members.kick',
                fallbackAccessToken: session?.access_token,
                timeoutMs: 12000,
                body: {
                    action: 'kick',
                    targetUserId: memberToKick.id
                }
            })

            if (error) throw normalizeSupabaseActionError(error)

            // Remove member from local state
            setMembers(prev => prev.filter(m => m.id !== memberToKick.id))
            setMemberToKick(null)
        } catch (err: any) {
            console.error('Error kicking member:', err)
            setError(getErrorMessage(err))
        } finally {
            setKickingMemberId(null)
        }
    }

    const openCopyPermissionsDialog = async () => {
        setCopyDialogOpen(true)
        setCopyError(null)
        setCopyWorkspaceId('')
        setCopyMemberId('')
        setCopyMembers([])
        setCopyWorkspacesLoading(true)
        try {
            let workspaces: PermissionCopyWorkspace[]
            if (isLocalMode) {
                workspaces = await getLocalCopyWorkspaces()
            } else {
                const { data, error } = await invokeWorkspaceAccess<{ workspaces: PermissionCopyWorkspace[] }>({
                    label: 'members.permissions.copy.listWorkspaces',
                    fallbackAccessToken: session?.access_token,
                    timeoutMs: 15000,
                    body: { action: 'list-permission-copy-workspaces' }
                })
                if (error) throw error
                workspaces = data?.workspaces ?? []
            }
            setCopyWorkspaces(workspaces)
        } catch (err) {
            console.error('Error listing permission copy workspaces:', err)
            setCopyError(getErrorMessage(err))
        } finally {
            setCopyWorkspacesLoading(false)
        }
    }

    const loadCopyWorkspaceMembers = async (workspaceId: string) => {
        setCopyWorkspaceId(workspaceId)
        setCopyMemberId('')
        setCopyMembers([])
        if (!workspaceId) return
        setCopyMembersLoading(true)
        setCopyError(null)
        try {
            let members: PermissionCopyMember[]
            if (isLocalMode) {
                members = await getLocalCopyMembers(workspaceId)
            } else {
                const { data, error } = await invokeWorkspaceAccess<{ members: PermissionCopyMember[] }>({
                    label: 'members.permissions.copy.listMembers',
                    fallbackAccessToken: session?.access_token,
                    timeoutMs: 15000,
                    body: { action: 'list-workspace-member-permissions', workspaceId }
                })
                if (error) throw error
                members = data?.members ?? []
            }
            setCopyMembers(members.filter((member) => member.id !== permissionMember?.id))
        } catch (err) {
            console.error('Error listing workspace members for permission copy:', err)
            setCopyError(getErrorMessage(err))
            setCopyMembers([])
        } finally {
            setCopyMembersLoading(false)
        }
    }

    const handleCopyPermissions = async () => {
        if (!permissionMember || !copyWorkspaceId || !copyMemberId) return
        setCopyingPermissions(true)
        setCopyError(null)
        try {
            if (isLocalMode) {
                await copyPermissionsLocally(copyWorkspaceId, copyMemberId, permissionMember.id)
            } else {
                const { error } = await invokeWorkspaceAccess<{ added?: number; removed?: number }>({
                    label: 'members.permissions.copy.apply',
                    fallbackAccessToken: session?.access_token,
                    timeoutMs: 20000,
                    body: {
                        action: 'copy-member-permissions',
                        sourceWorkspaceId: copyWorkspaceId,
                        sourceMemberId: copyMemberId,
                        targetWorkspaceId: user?.workspaceId,
                        targetMemberId: permissionMember.id
                    }
                })
                if (error) throw error
            }
            await fetchPermissions()
            window.dispatchEvent(new CustomEvent('workspace-permissions:changed'))
            toast({
                title: t('members.permissions.copySuccess', { defaultValue: 'Permissions copied successfully' }),
                description: t('members.permissions.copySuccessDescription', {
                    name: permissionMember.name,
                    defaultValue: '{{name}} now has the same permissions as the selected member.'
                })
            })
            setCopyDialogOpen(false)
        } catch (err) {
            console.error('Error copying member permissions:', err)
            setCopyError(getErrorMessage(err))
        } finally {
            setCopyingPermissions(false)
        }
    }

    const getLocalCopyWorkspaces = async (): Promise<PermissionCopyWorkspace[]> => {
        const currentId = user?.workspaceId ?? ''
        const workspaceMap = new Map<string, PermissionCopyWorkspace>()
        const addWorkspace = (id: string, name: string, code?: string) => {
            if (!id || workspaceMap.has(id)) return
            workspaceMap.set(id, {
                workspaceId: id,
                workspaceName: name || 'Workspace',
                workspaceCode: code,
                relationType: id === currentId ? 'current' : 'source'
            })
        }

        const connection = await getLocalModeSqliteConnection()
        if (connection) {
            const entities = await connection.select<Array<{ entity_id: string; payload: string }>>(
                `SELECT entity_id, payload
                 FROM local_entities
                 WHERE entity_type = 'workspaces'`
            )
            for (const entity of entities ?? []) {
                const data = JSON.parse(entity.payload) as Record<string, unknown>
                if (data.isDeleted === true) continue
                addWorkspace(
                    String(data.id ?? entity.entity_id),
                    typeof data.name === 'string' ? data.name : '',
                    typeof data.code === 'string' ? data.code : undefined
                )
            }
        }

        const dexieWorkspaces = await db.workspaces.toArray()
        for (const workspace of dexieWorkspaces ?? []) {
            if (workspace.isDeleted) continue
            addWorkspace(workspace.id, workspace.name ?? '', workspace.code ?? undefined)
        }

        if (!workspaceMap.has(currentId)) {
            const currentWorkspace = await db.workspaces.get(currentId)
            addWorkspace(currentId, currentWorkspace?.name ?? 'My Workspace', currentWorkspace?.code ?? undefined)
        }

        return [...workspaceMap.values()].sort((a, b) => {
            if (a.relationType === 'current' && b.relationType !== 'current') return -1
            if (b.relationType === 'current' && a.relationType !== 'current') return 1
            return a.workspaceName.localeCompare(b.workspaceName)
        })
    }

    const getLocalWorkspacePermissionData = async (workspaceId: string) => {
        const connection = await getLocalModeSqliteConnection()
        const profiles: Array<Record<string, unknown>> = []
        const permissionRows: Array<{ userUuid: string; key: string; module: string }> = []

        if (connection) {
            const [profileEntities, permissionEntities] = await Promise.all([
                connection.select<Array<{ entity_id: string; payload: string }>>(
                    `SELECT entity_id, payload
                     FROM local_entities
                     WHERE entity_type = 'profiles'
                       AND workspace_id = $1`,
                    [workspaceId]
                ),
                connection.select<Array<{ entity_id: string; payload: string }>>(
                    `SELECT entity_id, payload
                     FROM local_entities
                     WHERE entity_type = 'workspace_permissions'
                       AND workspace_id = $1`,
                    [workspaceId]
                )
            ])
            for (const entity of profileEntities ?? []) {
                profiles.push(JSON.parse(entity.payload) as Record<string, unknown>)
            }
            for (const entity of permissionEntities ?? []) {
                const data = JSON.parse(entity.payload) as Record<string, unknown>
                if (typeof data.userUuid !== 'string' || typeof data.key !== 'string') continue
                permissionRows.push({
                    userUuid: data.userUuid,
                    key: data.key,
                    module: typeof data.module === 'string' ? data.module : ''
                })
            }
        } else {
            const dexieProfiles = await db.profiles.where('workspaceId').equals(workspaceId).toArray()
            for (const profile of dexieProfiles) {
                profiles.push(profile as unknown as Record<string, unknown>)
            }
            const dexiePermissions = await db.workspace_permissions.where('workspaceId').equals(workspaceId).toArray()
            for (const permission of dexiePermissions) {
                permissionRows.push({ userUuid: permission.userUuid, key: permission.key, module: permission.module })
            }
        }

        return { profiles, permissionRows }
    }

    const getLocalCopyMembers = async (workspaceId: string): Promise<PermissionCopyMember[]> => {
        const { profiles, permissionRows } = await getLocalWorkspacePermissionData(workspaceId)
        const keysByUser = new Map<string, string[]>()
        for (const row of permissionRows) {
            const keys = keysByUser.get(row.userUuid) ?? []
            keys.push(row.key)
            keysByUser.set(row.userUuid, keys)
        }

        return profiles
            .filter((profile) => typeof profile.id === 'string' && profile.role !== 'admin')
            .map((profile) => ({
                id: String(profile.id),
                name: typeof profile.name === 'string' ? profile.name : 'Member',
                role: typeof profile.role === 'string' ? profile.role : 'staff',
                profile_url: typeof profile.profile_url === 'string' ? profile.profile_url : null,
                permissionKeys: keysByUser.get(String(profile.id)) ?? []
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
    }

    const copyPermissionsLocally = async (sourceWorkspaceId: string, sourceMemberId: string, targetMemberId: string) => {
        const targetWorkspaceId = user?.workspaceId
        if (!targetWorkspaceId) throw new Error('Workspace not found')

        const targetProfile = await db.profiles.get(targetMemberId)
        if (!targetProfile || targetProfile.role === 'admin') {
            throw new Error('Target member not found')
        }

        const { profiles, permissionRows } = await getLocalWorkspacePermissionData(sourceWorkspaceId)
        const sourceProfile = profiles.find((profile) => profile.id === sourceMemberId)
        if (!sourceProfile) {
            throw new Error('Source member not found')
        }

        const sourceKeys = new Map<string, string>()
        for (const row of permissionRows) {
            if (row.userUuid === sourceMemberId) {
                sourceKeys.set(row.key, row.module)
            }
        }

        const { generateId } = await import('@/lib/utils')

        await db.workspace_permissions
            .where('[workspaceId+userUuid]')
            .equals([targetWorkspaceId, targetMemberId])
            .delete()

        for (const [key, module] of sourceKeys) {
            await db.workspace_permissions.put({
                id: generateId(),
                workspaceId: targetWorkspaceId,
                userUuid: targetMemberId,
                key,
                module
            })
        }
    }

    const canKick = (member: Member) => {
        if (isDemoMode || isLocalMode) return false
        // Can't kick yourself
        if (member.id === user?.id) return false
        // Can't kick admins
        if (member.role === 'admin') return false
        // Only admins can kick
        return user?.role === 'admin'
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <UsersRound className="w-6 h-6 text-primary" />
                        {t('members.title')}
                    </h1>
                    <p className="text-muted-foreground">
                        {members.length} {t('members.subtitle')} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
            </div>

            {/* Error Alert */}
            {error && (
                <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive">
                    {error}
                </div>
            )}

            {/* Members Table */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('members.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {isLoading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : members.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            {t('common.noData')}
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="text-start">{t('members.table.name')}</TableHead>
                                    <TableHead className="text-start">{t('members.table.role')}</TableHead>
                                    <TableHead className="text-start">{t('members.table.joinedAt')}</TableHead>
                                    {user?.role === 'admin' && (
                                        <TableHead className="text-end">{t('common.actions')}</TableHead>
                                    )}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {members.map((member) => {
                                    const RoleIcon = roleIcons[member.role] || Eye
                                    return (
                                        <TableRow key={member.id}>
                                            <TableCell>
                                                <div className="flex items-center gap-3">
                                                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-sm font-bold text-white overflow-hidden shadow-sm">
                                                        {member.profile_url ? (
                                                            <img
                                                                src={member.profile_url.startsWith('http') ? member.profile_url : platformService.convertFileSrc(member.profile_url)}
                                                                alt={member.name}
                                                                className="w-full h-full object-cover"
                                                            />
                                                        ) : (
                                                            member.name?.charAt(0).toUpperCase() || 'M'
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-1.5">
                                                        <div>
                                                            <p className="font-medium">
                                                                {member.name}
                                                                {member.id === user?.id && (
                                                                    <span className="ms-2 text-xs text-muted-foreground">
                                                                        ({t('members.you')})
                                                                    </span>
                                                                )}
                                                            </p>
                                                        </div>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                                            onClick={() => setProfileUserId(member.id)}
                                                            aria-label={t('profileCard.viewProfile')}
                                                        >
                                                            <UserRound className="h-3.5 w-3.5" />
                                                        </Button>
                                                        {canManageWorkspacePermissions && user?.role === 'admin' && member.role !== 'admin' && (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                                                onClick={() => openPermissionModal(member)}
                                                                aria-label={t('members.permissions.manage', { defaultValue: 'Manage permissions' })}
                                                            >
                                                                <KeyRound className="h-3.5 w-3.5" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${roleColors[member.role]}`}>
                                                    <RoleIcon className="w-3 h-3" />
                                                    {t(`auth.roles.${member.role}`)}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-muted-foreground text-start">
                                                {formatDate(member.created_at)}
                                            </TableCell>
                                            {user?.role === 'admin' && (
                                                <TableCell className="text-end">
                                                    {canKick(member) ? (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => setMemberToKick(member)}
                                                            disabled={kickingMemberId === member.id}
                                                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                                        >
                                                            {kickingMemberId === member.id ? (
                                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                                <>
                                                                    <UserMinus className="w-4 h-4 mr-1" />
                                                                    {t('members.kick')}
                                                                </>
                                                            )}
                                                        </Button>
                                                    ) : member.role === 'admin' && member.id !== user?.id ? (
                                                        <span className="text-xs text-muted-foreground">
                                                            {t('members.cannotKickAdmin')}
                                                        </span>
                                                    ) : null}
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card >

            <Dialog open={!!permissionMember} onOpenChange={(open) => { if (!open) setPermissionMember(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <KeyRound className="h-5 w-5 text-primary" />
                            {t('members.permissions.manageTitle', { defaultValue: 'Manage Permissions' })}
                        </DialogTitle>
                        <DialogDescription>
                            {t('members.permissions.manageDescription', {
                                name: permissionMember?.name,
                                defaultValue: 'Choose a module, then toggle the available permissions for {{name}}.'
                            })}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={openCopyPermissionsDialog}
                                disabled={isDemoMode}
                            >
                                <Copy className="h-4 w-4 mr-1.5" />
                                {t('members.permissions.copyButton', { defaultValue: 'Copy from another member' })}
                            </Button>
                        </div>
                        <div className="w-full max-w-[260px]">
                            <Select value={selectedPermissionModule} onValueChange={setSelectedPermissionModule}>
                                <SelectTrigger>
                                    <div className="flex items-center gap-2">
                                        {moduleMetaMap[selectedPermissionModule] && (
                                            (() => {
                                                const Icon = moduleMetaMap[selectedPermissionModule].icon
                                                return <Icon className="h-4 w-4 text-primary" />
                                            })()
                                        )}
                                        <SelectValue placeholder={t('members.permissions.selectModule', { defaultValue: 'Select module' })} />
                                    </div>
                                </SelectTrigger>
                                <SelectContent>
                                    {/* Global module explicitly at the top and sectionless */}
                                    {(() => {
                                        const globalModule = moduleMetaMap['global']
                                        if (!globalModule) return null
                                        const GlobalIcon = globalModule.icon
                                        return (
                                            <SelectItem value="global">
                                                <div className="flex items-center gap-2">
                                                    <GlobalIcon className="h-4 w-4 text-muted-foreground" />
                                                    {t('members.permissions.global', { defaultValue: 'Global' })}
                                                </div>
                                            </SelectItem>
                                        )
                                    })()}

                                    {launcherSectionOrder.map((sectionKey) => {
                                        if (sectionKey === 'global') return null
                                        const moduleList = modulesBySection[sectionKey]
                                        if (!moduleList || moduleList.length === 0) return null
                                        const sectionInfo = launcherSections[sectionKey]
                                        const SectionIcon = sectionInfo.icon

                                        return (
                                            <SelectGroup key={sectionKey}>
                                                <SelectLabel className="flex items-center gap-2 px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-muted/30 rounded-sm mb-1 mt-2 first:mt-0">
                                                    {SectionIcon && <SectionIcon className="h-3 w-3" />}
                                                    {t(`members.permissions.sections.${sectionKey}`, { defaultValue: sectionInfo.title })}
                                                </SelectLabel>
                                                {moduleList.map((moduleMeta) => {
                                                    const ModuleIcon = moduleMeta.icon
                                                    return (
                                                        <SelectItem key={moduleMeta.module} value={moduleMeta.module}>
                                                            <div className="flex items-center gap-2">
                                                                <ModuleIcon className="h-4 w-4 text-muted-foreground" />
                                                                {t(moduleMeta.labelKey, { defaultValue: moduleMeta.defaultLabel })}
                                                            </div>
                                                        </SelectItem>
                                                    )
                                                })}
                                            </SelectGroup>
                                        )
                                    })}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-4">
                            {permissionMember && selectedPermissionModule === 'global' && (
                                <div className="rounded-lg border border-border/60 bg-background/60 p-4">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <ShieldCheck className="h-4 w-4 text-primary" />
                                                <p className="font-medium">
                                                    {t('members.permissions.globalViewOwn', { defaultValue: 'Global View Own Records' })}
                                                </p>
                                            </div>
                                            <p className="mt-1 text-sm text-muted-foreground">
                                                {t('members.permissions.globalViewOwnDescription', {
                                                    defaultValue: 'Grant or remove View Own Records for orders, posts, sales, loans, installments, and invoice history together.'
                                                })}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                            {globalViewOwnState === 'custom' && (
                                                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                                                    {t('members.permissions.custom', { defaultValue: 'Custom' })}
                                                </span>
                                            )}
                                            <Switch
                                                checked={globalViewOwnState === 'all'}
                                                disabled={Boolean(permissionMutationKey) || permissionsLoading}
                                                className={cn(
                                                    globalViewOwnState === 'custom' && (
                                                        '!bg-amber-500/70 [&>span]:!translate-x-[9px]'
                                                    )
                                                )}
                                                onCheckedChange={(value) => {
                                                    handleGlobalViewOwnToggle(permissionMember, value)
                                                }}
                                                aria-label={t('members.permissions.globalViewOwn', { defaultValue: 'Global View Own Records' })}
                                            />
                                        </div>
                                    </div>
                                    {permissionMutationKey === `${permissionMember.id}:global.view_own` && (
                                        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            {t('members.permissions.saving', { defaultValue: 'Saving...' })}
                                        </div>
                                    )}
                                </div>
                            )}
                            {permissionMember && selectedModulePermissions.map((permission) => {
                                const PermissionIcon = permission.icon
                                return (
                                    <div key={permission.key} className="rounded-lg border border-border/60 bg-background/60 p-4">
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2">
                                                    {permission.module === 'global' ? (
                                                        <PermissionIcon className="h-4 w-4 text-primary" />
                                                    ) : (
                                                        <ShieldCheck className="h-4 w-4 text-primary" />
                                                    )}
                                                    <p className="font-medium">
                                                        {permission.key.endsWith('.access')
                                                            ? t(`members.permissions.modules.${permission.module}`, {
                                                                defaultValue: PERMISSION_MODULE_DEFAULT_LABELS[permission.module] ?? permission.defaultLabel
                                                            })
                                                            : t(permission.labelKey, { defaultValue: permission.defaultLabel })}
                                                    </p>
                                                </div>
                                                <p className="mt-1 text-sm text-muted-foreground">
                                                    {t(permission.descriptionKey, {
                                                        defaultValue: permission.defaultDescription
                                                    })}
                                                </p>
                                            </div>
                                            <Switch
                                                checked={permission.key === 'global.NOprint' ? !selectedMemberPermissionKeys.has(permission.key) : selectedMemberPermissionKeys.has(permission.key)}
                                                disabled={permissionMutationKey === `${permissionMember.id}:${permission.key}` || permissionsLoading}
                                                onCheckedChange={(value) => {
                                                    const shouldGrant = permission.key === 'global.NOprint' ? !value : value
                                                    handlePermissionToggle(permissionMember, permission.key, shouldGrant)
                                                }}
                                                aria-label={t(permission.labelKey, { defaultValue: permission.defaultLabel })}
                                            />
                                        </div>
                                        {permissionMutationKey === `${permissionMember.id}:${permission.key}` && (
                                            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                {t('members.permissions.saving', { defaultValue: 'Saving...' })}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Copy Permissions Dialog */}
            <Dialog open={copyDialogOpen} onOpenChange={(open) => { if (!open) setCopyDialogOpen(false) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Copy className="h-5 w-5 text-primary" />
                            {t('members.permissions.copyTitle', { defaultValue: 'Copy Permissions from Another Member' })}
                        </DialogTitle>
                        <DialogDescription>
                            {t('members.permissions.copyDescription', {
                                name: permissionMember?.name,
                                defaultValue: 'Select a member from another workspace to copy their permissions into {{name}}.'
                            })}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        {copyError && (
                            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                                {copyError}
                            </div>
                        )}

                        <div className="space-y-1.5">
                            <p className="text-sm font-medium">
                                {t('members.permissions.copyWorkspaceLabel', { defaultValue: 'Workspace' })}
                            </p>
                            {copyWorkspacesLoading ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    {t('members.permissions.copyLoading', { defaultValue: 'Loading...' })}
                                </div>
                            ) : copyWorkspaces.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    {t('members.permissions.copyNoWorkspaces', { defaultValue: 'No other workspaces are available.' })}
                                </p>
                            ) : (
                                <Select value={copyWorkspaceId} onValueChange={loadCopyWorkspaceMembers}>
                                    <SelectTrigger>
                                        <SelectValue placeholder={t('members.permissions.copyWorkspacePlaceholder', { defaultValue: 'Select workspace' })} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {copyWorkspaces.map((workspace) => (
                                            <SelectItem key={workspace.workspaceId} value={workspace.workspaceId}>
                                                <div className="flex items-center gap-2">
                                                    {workspace.relationType === 'source' ? (
                                                        <Briefcase className="h-4 w-4 text-muted-foreground" />
                                                    ) : workspace.relationType === 'current' ? (
                                                        <Shield className="h-4 w-4 text-primary" />
                                                    ) : (
                                                        <Shield className="h-4 w-4 text-muted-foreground" />
                                                    )}
                                                    <span className="font-medium">{workspace.workspaceName}</span>
                                                    {workspace.relationType === 'current' && (
                                                        <span className="text-xs text-muted-foreground">
                                                            ({t('members.permissions.copyCurrent', { defaultValue: 'current' })})
                                                        </span>
                                                    )}
                                                </div>
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>

                        <div className="space-y-1.5">
                            <p className="text-sm font-medium">
                                {t('members.permissions.copyMemberLabel', { defaultValue: 'Member' })}
                            </p>
                            {copyMembersLoading ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    {t('members.permissions.copyLoading', { defaultValue: 'Loading...' })}
                                </div>
                            ) : copyWorkspaceId && copyMembers.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    {t('members.permissions.copyNoMembers', { defaultValue: 'No members available in this workspace.' })}
                                </p>
                            ) : (
                                <Select value={copyMemberId} onValueChange={setCopyMemberId} disabled={!copyWorkspaceId}>
                                    <SelectTrigger>
                                        <SelectValue placeholder={t('members.permissions.copyMemberPlaceholder', { defaultValue: 'Select member' })} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {copyMembers.map((member) => (
                                            <SelectItem key={member.id} value={member.id}>
                                                <div className="flex items-center gap-2">
                                                    <UserRound className="h-4 w-4 text-muted-foreground" />
                                                    <span className="font-medium">{member.name}</span>
                                                    <span className="text-xs text-muted-foreground">
                                                        ({member.permissionKeys.length})
                                                    </span>
                                                </div>
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setCopyDialogOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            onClick={handleCopyPermissions}
                            disabled={!copyWorkspaceId || !copyMemberId || copyingPermissions}
                        >
                            {copyingPermissions ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <>
                                    <CopyCheck className="w-4 h-4 mr-1" />
                                    {t('members.permissions.copyAction', { defaultValue: 'Copy Permissions' })}
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Kick Confirmation Dialog */}
            <Dialog open={!!memberToKick} onOpenChange={() => setMemberToKick(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('members.kickTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('members.kickConfirm', { name: memberToKick?.name })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="py-4">
                        <p className="text-sm text-muted-foreground">
                            {t('members.kickWarning')}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setMemberToKick(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleKick}
                            disabled={!!kickingMemberId}
                        >
                            {kickingMemberId ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <>
                                    <UserMinus className="w-4 h-4 mr-1" />
                                    {t('members.kick')}
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Profile Card Modal */}
            <ProfileCardModal
                open={!!profileUserId}
                onOpenChange={(open) => { if (!open) setProfileUserId(null) }}
                userId={profileUserId}
            />
        </div >
    )
}
