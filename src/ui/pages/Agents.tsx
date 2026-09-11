import { useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { BadgePercent, Car, Eye, Pencil, Plus, Search, Settings2, Trash2, UserRound, UsersRound, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import {
    createBusinessPartner,
    deleteBusinessPartner,
    updateBusinessPartner,
    useAgents,
    useBusinessPartners,
    useWorkspaceUsers,
    type Agent,
    type AgentStatus,
    type BusinessPartner,
    type CurrencyCode
} from '@/local-db'
import { platformService } from '@/services/platformService'
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast
} from '@/ui/components'
import { BusinessPartnerFormDialog, type BusinessPartnerFormPayload } from '@/ui/components/crm/BusinessPartnerFormDialog'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { useWorkspace } from '@/workspace'
import { hasEffectiveSalesAgentCommissionPermission, useWorkspacePermissions } from '@/permissions'
import {
    CommissionFeatureBoundary,
    useOptionalCommissionFeatureData
} from '@/ui/components/commissions/useCommissionAgentDirectory'
import { formatCommissionPlanTerms } from '@/ui/components/commissions/agentCommissionPresentation'

function statusClass(status: AgentStatus) {
    if (status === 'active') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    if (status === 'blocked') return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
    return 'border-border bg-muted text-muted-foreground'
}

export function Agents() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features, hasFeature } = useWorkspace()
    const { permissionKeys } = useWorkspacePermissions()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const partners = useBusinessPartners(user?.workspaceId, { roles: ['agent'], includeAgentRoles: true })
    const agents = useAgents(user?.workspaceId)
    const workspaceUsers = useWorkspaceUsers(user?.workspaceId)
    const [search, setSearch] = useState('')
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingPartner, setEditingPartner] = useState<BusinessPartner | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<BusinessPartner | null>(null)
    const [isSaving, setIsSaving] = useState(false)

    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'
    const salesAgentCommissionsEnabled = hasFeature('sales_agent_commissions')
    const canManageCommissionPlans = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.managePlans')
    const canViewAllCommissions = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.viewAll')
    const canViewOwnCommissions = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.viewOwn')
    const canSettleCommissions = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.pay')
    const canAssignCommissionOrders = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.assignOrders')
    const canShowCommissionPlanColumn = canViewAllCommissions || canViewOwnCommissions
    const canReconcileCommissionLifecycle = canViewAllCommissions || canSettleCommissions || canAssignCommissionOrders
    const availableCurrencies = useMemo(
        () => Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[],
        [features.allowed_currencies, features.default_currency]
    )
    const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
    const userById = useMemo(() => new Map(workspaceUsers.map((workspaceUser) => [workspaceUser.id, workspaceUser])), [workspaceUsers])
    const listedAgentFacets = useMemo(
        () => partners.map((partner) => partner.agentFacetId ? agentById.get(partner.agentFacetId) : undefined)
            .filter((agent): agent is Agent => Boolean(agent)),
        [agentById, partners]
    )
    const visibleAgents = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return partners
        return partners.filter((partner) => {
            const agent = partner.agentFacetId ? agentById.get(partner.agentFacetId) : undefined
            const linkedUser = agent?.linkedUserId ? userById.get(agent.linkedUserId) : undefined
            return [partner.partnerName, partner.phone, agent?.zone, agent?.agentType, agent?.carModel, agent?.plateNumber, agent?.status, linkedUser?.name, linkedUser?.email]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .some((value) => value.toLowerCase().includes(query))
        })
    }, [agentById, partners, search, userById])
    const activeCount = listedAgentFacets.filter((agent) => agent.status === 'active').length
    const driverCount = listedAgentFacets.filter((agent) => agent.agentType === 'driver').length
    const blockedCount = listedAgentFacets.filter((agent) => agent.status === 'blocked').length

    async function handleSubmit(payload: BusinessPartnerFormPayload) {
        if (!user?.workspaceId) return
        setIsSaving(true)
        try {
            const agentPayload = { ...payload, role: 'agent' as const }
            if (editingPartner) {
                await updateBusinessPartner(editingPartner.id, agentPayload, { allowAgentRole: true })
                toast({ title: t('agents.updateSuccess', { defaultValue: 'Agent updated successfully' }) })
            } else {
                await createBusinessPartner(user.workspaceId, agentPayload, { allowAgentRole: true })
                toast({ title: t('agents.createSuccess', { defaultValue: 'Agent created successfully' }) })
            }
            setDialogOpen(false)
            setEditingPartner(null)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('agents.saveFailed', { defaultValue: 'Failed to save agent' }),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    async function handleDelete() {
        if (!deleteTarget) return
        try {
            await deleteBusinessPartner(deleteTarget.id)
            toast({ title: t('agents.deleteSuccess', { defaultValue: 'Agent deleted successfully' }) })
            setDeleteTarget(null)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('agents.deleteFailed', { defaultValue: 'Failed to delete agent' }),
                variant: 'destructive'
            })
        }
    }

    return (
        <CommissionFeatureBoundary enabled={canShowCommissionPlanColumn || canReconcileCommissionLifecycle} workspaceId={user?.workspaceId}>
            <div className="space-y-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <h1 className="flex items-center gap-2 text-2xl font-bold">
                            <UserRound className="h-6 w-6 text-primary" />
                            {t('agents.title', { defaultValue: 'Agents' })}
                        </h1>
                        <p className="text-muted-foreground">
                            {t('agents.subtitle', { defaultValue: 'Manage drivers and field agents, territories, vehicles, and linked workspace users.' })} <ModulePageFreshness className="ms-2" />
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2 self-start">
                        {canManageCommissionPlans ? (
                            <Button variant="outline" onClick={() => navigate('/agents/commission-settings')} className="gap-2 rounded-xl">
                                <Settings2 className="h-4 w-4" />
                                {t('salesAgentCommissions.settings')}
                            </Button>
                        ) : null}
                        {canEdit ? (
                            <Button onClick={() => { setEditingPartner(null); setDialogOpen(true) }} className="gap-2 rounded-xl">
                                <Plus className="h-4 w-4" />
                                {t('agents.addAgent', { defaultValue: 'Add Agent' })}
                            </Button>
                        ) : null}
                    </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <AgentMetric title={t('agents.total', { defaultValue: 'Total Agents' })} value={partners.length} icon={UsersRound} />
                    <AgentMetric title={t('agents.active', { defaultValue: 'Active' })} value={activeCount} icon={UserRound} />
                    <AgentMetric title={t('agents.drivers', { defaultValue: 'Drivers' })} value={driverCount} icon={Car} />
                    <AgentMetric title={t('agents.blocked', { defaultValue: 'Blocked' })} value={blockedCount} icon={UserRound} />
                </div>

                <Card>
                    <CardHeader className="gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <CardTitle>{t('agents.directory', { defaultValue: 'Agent Directory' })}</CardTitle>
                        <div className="relative w-full lg:max-w-sm">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input value={search} onChange={(event) => setSearch(event.target.value)} allowViewer={true} placeholder={t('agents.searchPlaceholder', { defaultValue: 'Search agents, zones, vehicles, or users...' })} className="pl-9" />
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('agents.agent', { defaultValue: 'Agent' })}</TableHead>
                                        <TableHead>{t('businessPartners.agent.zone', { defaultValue: 'Territory' })}</TableHead>
                                        <TableHead>{t('businessPartners.agent.type', { defaultValue: 'Type' })}</TableHead>
                                        <TableHead>{t('agents.vehicle', { defaultValue: 'Vehicle' })}</TableHead>
                                        <TableHead>{t('businessPartners.agent.linkedUser', { defaultValue: 'Workspace User' })}</TableHead>
                                        <TableHead>{t('businessPartners.agent.status', { defaultValue: 'Status' })}</TableHead>
                                        {canShowCommissionPlanColumn ? <TableHead>{t('salesAgentCommissions.commissionPlan')}</TableHead> : null}
                                        <TableHead className="text-right">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {visibleAgents.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={7 + (canShowCommissionPlanColumn ? 1 : 0)} className="py-12 text-center text-muted-foreground">
                                                {t('agents.empty', { defaultValue: 'No agents found.' })}
                                            </TableCell>
                                        </TableRow>
                                    ) : visibleAgents.map((partner) => {
                                        const agent = partner.agentFacetId ? agentById.get(partner.agentFacetId) : undefined
                                        const linkedUser = agent?.linkedUserId ? userById.get(agent.linkedUserId) : undefined
                                        const unavailable = t('common.noData', { defaultValue: 'N/A' })
                                        return (
                                            <TableRow key={partner.id}>
                                                <TableCell>
                                                    <div className="flex items-center gap-3">
                                                        <AgentAvatar profileUrl={linkedUser?.profileUrl} />
                                                        <div>
                                                            <div className="font-semibold">{partner.partnerName}</div>
                                                            <div className="text-xs text-muted-foreground">{partner.phone || unavailable}</div>
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>{agent?.zone || unavailable}</TableCell>
                                                <TableCell>
                                                    {agent
                                                        ? agent.agentType === 'driver'
                                                            ? t('businessPartners.agent.types.driver', { defaultValue: 'Driver' })
                                                            : agent.agentType === 'courier'
                                                                ? t('businessPartners.agent.types.courier', { defaultValue: 'Courier' })
                                                                : t('businessPartners.agent.types.fieldAgent', { defaultValue: 'Field Agent' })
                                                        : unavailable}
                                                </TableCell>
                                                <TableCell>{agent?.agentType === 'driver' ? [agent.carModel, agent.plateNumber].filter(Boolean).join(' / ') || unavailable : unavailable}</TableCell>
                                                <TableCell>{linkedUser?.name || linkedUser?.email || t('businessPartners.agent.noLinkedUser', { defaultValue: 'Not linked' })}</TableCell>
                                                <TableCell>
                                                    {agent ? (
                                                        <Badge variant="outline" className={statusClass(agent.status)}>
                                                            {t(`businessPartners.agent.statuses.${agent.status}`, { defaultValue: agent.status })}
                                                        </Badge>
                                                    ) : unavailable}
                                                </TableCell>
                                                {canShowCommissionPlanColumn ? <AgentCommissionPlanCell agentId={agent?.id} viewerUserId={user?.id} canViewAll={canViewAllCommissions} /> : null}
                                                <TableCell className="text-right">
                                                    <div className="flex justify-end gap-1">
                                                        <Button variant="ghost" size="icon" allowViewer={true} onClick={() => navigate(`/agents/${partner.id}`)} title={t('agents.viewProfile', { defaultValue: 'View Profile' })}>
                                                            <Eye className="h-4 w-4" />
                                                        </Button>
                                                        {canEdit ? (
                                                            <Button variant="ghost" size="icon" onClick={() => { setEditingPartner(partner); setDialogOpen(true) }} title={t('common.edit')}>
                                                                <Pencil className="h-4 w-4" />
                                                            </Button>
                                                        ) : null}
                                                        {canDelete ? (
                                                            <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget(partner)} title={t('common.delete')}>
                                                                <Trash2 className="h-4 w-4" />
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    </CardContent>
                </Card>

                <BusinessPartnerFormDialog
                    isOpen={dialogOpen}
                    onOpenChange={(open) => {
                        setDialogOpen(open)
                        if (!open) setEditingPartner(null)
                    }}
                    partner={editingPartner}
                    defaultCurrency={features.default_currency}
                    availableCurrencies={availableCurrencies}
                    initialRole="agent"
                    lockedRole="agent"
                    enableAgentRole={true}
                    workspaceId={user?.workspaceId}
                    isSaving={isSaving}
                    title={editingPartner ? t('agents.editAgent', { defaultValue: 'Edit Agent' }) : t('agents.createAgent', { defaultValue: 'Create Agent' })}
                    onSubmit={handleSubmit}
                />

                <DeleteConfirmationModal
                    isOpen={!!deleteTarget}
                    onClose={() => setDeleteTarget(null)}
                    onConfirm={handleDelete}
                    itemName={deleteTarget?.partnerName}
                    title={t('agents.deleteTitle', { defaultValue: 'Delete Agent' })}
                    description={t('agents.deleteWarning', { defaultValue: 'Agents with transaction history cannot be deleted.' })}
                />
            </div>
        </CommissionFeatureBoundary>
    )
}

function AgentCommissionPlanCell({ agentId, viewerUserId, canViewAll }: { agentId?: string; viewerUserId?: string; canViewAll: boolean }) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const commissionData = useOptionalCommissionFeatureData()
    const commissionAgent = agentId ? commissionData?.agentById.get(agentId) : undefined
    const canView = canViewAll || commissionAgent?.agent.linkedUserId === viewerUserId
    return (
        <TableCell>
            {!agentId ? t('common.noData', { defaultValue: 'N/A' }) : !canView ? (
                <span className="text-sm text-muted-foreground">{t('salesAgentCommissions.restricted')}</span>
            ) : commissionAgent?.plan ? (
                <Badge variant="outline" className="gap-1.5 border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                    <BadgePercent className="h-3.5 w-3.5" />
                    {commissionAgent.plan.name} · {formatCommissionPlanTerms(commissionAgent.plan, features.iqd_display_preference)}
                </Badge>
            ) : <span className="text-sm text-muted-foreground">{t('salesAgentCommissions.optionalNone')}</span>}
        </TableCell>
    )
}

function AgentMetric({ title, value, icon: Icon }: { title: string; value: number; icon: LucideIcon }) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
                <Icon className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent><div className="text-3xl font-black">{value}</div></CardContent>
        </Card>
    )
}

function AgentAvatar({ profileUrl }: { profileUrl?: string }) {
    return (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
            {profileUrl ? <img src={platformService.convertFileSrc(profileUrl)} alt="" className="h-full w-full object-cover" /> : <UserRound className="h-4 w-4 text-muted-foreground" />}
        </div>
    )
}
