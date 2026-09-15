import { useEffect, useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { Eye, MapPin, Pencil, Plus, Search, Trash2, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import { useDemoTutorial } from '@/demo'
import {
    createBusinessPartner,
    deleteBusinessPartner,
    updateBusinessPartner,
    useAgents,
    useBusinessPartners,
    useWorkspaceUsers,
    type BusinessPartner,
    type BusinessPartnerRole,
    type CurrencyCode
} from '@/local-db'
import { cn, formatCurrency } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useWorkspace } from '@/workspace'
import { useWorkspacePermissions } from '@/permissions/WorkspacePermissionsContext'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Map as AtlasMap,
    MapControls,
    MapMarker,
    MarkerContent,
    MarkerPopup,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    useMap,
    useToast
} from '@/ui/components'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { BusinessPartnerFormDialog, type BusinessPartnerFormPayload } from '@/ui/components/crm/BusinessPartnerFormDialog'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { AutocompleteLoadingIndicator } from '@/ui/components/AutocompleteLoadingIndicator'
function roleLabel(role: BusinessPartnerRole, t: (key: string, options?: Record<string, unknown>) => string) {
    switch (role) {
        case 'customer':
            return t('customers.title') || 'Customer'
        case 'supplier':
            return t('suppliers.title') || 'Supplier'
        case 'buyer':
            return t('businessPartners.roles.buyer', { defaultValue: 'Buyer' })
        case 'seller':
            return t('businessPartners.roles.seller', { defaultValue: 'Seller' })
        case 'agent':
            return t('businessPartners.roles.agent', { defaultValue: 'Agent' })
        default:
            return t('businessPartners.roles.both') || 'Both'
    }
}

function groupPartnerTotalsByCurrency(
    partners: BusinessPartner[],
    selectAmount: (partner: BusinessPartner) => number
) {
    const totals = new Map<CurrencyCode, number>()

    for (const partner of partners) {
        const amount = selectAmount(partner)
        if (!amount) {
            continue
        }

        totals.set(partner.defaultCurrency, (totals.get(partner.defaultCurrency) || 0) + amount)
    }

    return Array.from(totals.entries())
        .map(([currency, amount]) => ({ currency, amount }))
        .sort((left, right) => left.currency.localeCompare(right.currency))
}

type LocatedBusinessPartner = BusinessPartner & {
    latitude: number
    longitude: number
}

const DEFAULT_MAP_CENTER: [number, number] = [44.3661, 33.3152]

function hasValidPartnerLocation(partner: BusinessPartner): partner is LocatedBusinessPartner {
    return typeof partner.latitude === 'number'
        && Number.isFinite(partner.latitude)
        && partner.latitude >= -90
        && partner.latitude <= 90
        && typeof partner.longitude === 'number'
        && Number.isFinite(partner.longitude)
        && partner.longitude >= -180
        && partner.longitude <= 180
}

function PartnerMapBounds({
    partners,
    focusedPartnerId
}: {
    partners: LocatedBusinessPartner[]
    focusedPartnerId: string | null
}) {
    const { map, isLoaded } = useMap()

    useEffect(() => {
        if (!map || !isLoaded || partners.length === 0) {
            return
        }

        map.resize()

        const focusedPartner = focusedPartnerId
            ? partners.find((partner) => partner.id === focusedPartnerId)
            : undefined

        if (focusedPartner) {
            map.flyTo({
                center: [focusedPartner.longitude, focusedPartner.latitude],
                zoom: 14,
                duration: 500
            })
            return
        }

        const bounds = partners.reduce(
            (result, partner) => ({
                minLatitude: Math.min(result.minLatitude, partner.latitude),
                maxLatitude: Math.max(result.maxLatitude, partner.latitude),
                minLongitude: Math.min(result.minLongitude, partner.longitude),
                maxLongitude: Math.max(result.maxLongitude, partner.longitude)
            }),
            {
                minLatitude: partners[0].latitude,
                maxLatitude: partners[0].latitude,
                minLongitude: partners[0].longitude,
                maxLongitude: partners[0].longitude
            }
        )

        if (
            bounds.minLatitude === bounds.maxLatitude
            && bounds.minLongitude === bounds.maxLongitude
        ) {
            map.flyTo({
                center: [bounds.minLongitude, bounds.minLatitude],
                zoom: 14,
                duration: 0
            })
            return
        }

        map.fitBounds(
            [
                [bounds.minLongitude, bounds.minLatitude],
                [bounds.maxLongitude, bounds.maxLatitude]
            ],
            {
                padding: 96,
                maxZoom: 14,
                duration: 0
            }
        )
    }, [focusedPartnerId, isLoaded, map, partners])

    return null
}

export function BusinessPartners() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const demoTutorial = useDemoTutorial()
    const { hasPermission } = useWorkspacePermissions()
    const canViewCustomers = hasPermission('customers.access')
    const canViewSuppliers = hasPermission('suppliers.access')
        && (!features.suppliers_admin_only || user?.role === 'admin')
    const [scope, setScope] = useState<'all' | 'customers' | 'suppliers'>('all')
    const partners = useBusinessPartners(user?.workspaceId, {
        includeRealEstateRoles: features.real_estate,
        includeAgentRoles: features.agents
    })
    const agents = useAgents(user?.workspaceId)
    const workspaceUsers = useWorkspaceUsers(user?.workspaceId)
    const [search, setSearch] = useState('')
    const [activeTab, setActiveTab] = useState<'partners' | 'maps'>('partners')
    const [mapPartnerSearch, setMapPartnerSearch] = useState('')
    const [focusedMapPartnerId, setFocusedMapPartnerId] = useState<string | null>(null)
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingPartner, setEditingPartner] = useState<BusinessPartner | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<BusinessPartner | null>(null)
    const [isSaving, setIsSaving] = useState(false)

    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'
    const isTutorialBusinessPartnerTask = demoTutorial.isCurrentTask('business-partner')

    const availableCurrencies = useMemo(() => {
        return Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[]
    }, [features.allowed_currencies, features.default_currency])

    const visiblePartners = useMemo(
        () => partners.filter((partner) => !partner.isEcommerce),
        [partners]
    )
    const agentMap = useMemo(
        () => new Map(agents.map((agent) => [agent.id, agent])),
        [agents]
    )
    const workspaceUserMap = useMemo(
        () => new Map(workspaceUsers.map((workspaceUser) => [workspaceUser.id, workspaceUser])),
        [workspaceUsers]
    )

    const filteredPartners = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) {
            return visiblePartners
        }

        return visiblePartners.filter((partner) => {
            const agent = partner.agentFacetId ? agentMap.get(partner.agentFacetId) : undefined
            return [partner.partnerName, partner.phone, partner.city, agent?.zone, agent?.agentType, agent?.status]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .some((value) => value.toLowerCase().includes(query))
        })
    }, [agentMap, visiblePartners, search])

    const receivableTotals = useMemo(
        () => groupPartnerTotalsByCurrency(visiblePartners, (partner) => partner.receivableBalance),
        [visiblePartners]
    )
    const payableTotals = useMemo(
        () => groupPartnerTotalsByCurrency(visiblePartners, (partner) => partner.payableBalance),
        [visiblePartners]
    )
    const partnersWithLocations = useMemo(
        () => partners.filter(hasValidPartnerLocation),
        [partners]
    )
    const partnerIdsWithoutLocations = useMemo(
        () => partners
            .filter((partner) => !hasValidPartnerLocation(partner))
            .map((partner) => partner.id),
        [partners]
    )

    const renderGroupedTotals = (totals: Array<{ currency: CurrencyCode; amount: number }>) => {
        if (totals.length === 0) {
            return (
                <div className="text-lg font-black">
                    {formatCurrency(0, features.default_currency, features.iqd_display_preference)}
                </div>
            )
        }

        return (
            <div className="space-y-1.5">
                {totals.map((row) => (
                    <div key={row.currency} className="text-lg font-black">
                        {formatCurrency(row.amount, row.currency, features.iqd_display_preference)}
                    </div>
                ))}
                <div className="text-xs text-muted-foreground">
                    {t('businessPartners.groupedByCurrency', { defaultValue: 'Grouped by partner currency' })}
                </div>
            </div>
        )
    }

    async function handleSubmit(payload: BusinessPartnerFormPayload) {
        if (!user?.workspaceId) {
            return
        }

        setIsSaving(true)
        try {
            if (editingPartner) {
                await updateBusinessPartner(editingPartner.id, payload, {
                    allowRealEstateRoles: features.real_estate,
                    allowAgentRole: features.agents
                })
                toast({ title: t('businessPartners.messages.updateSuccess') || 'Business partner updated successfully' })
            } else {
                const createdPartner = await createBusinessPartner(user.workspaceId, payload, {
                    allowRealEstateRoles: features.real_estate,
                    allowAgentRole: features.agents
                })
                demoTutorial.completeBusinessPartnerCreated(createdPartner)
                toast({ title: t('businessPartners.messages.addSuccess') || 'Business partner created successfully' })
            }

            setDialogOpen(false)
            setEditingPartner(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to save business partner',
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    async function handleDelete() {
        if (!deleteTarget) {
            return
        }

        try {
            await deleteBusinessPartner(deleteTarget.id)
            toast({ title: t('businessPartners.messages.deleteSuccess') || 'Business partner deleted successfully' })
            setDeleteTarget(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to delete business partner',
                variant: 'destructive'
            })
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <UsersRound className="h-6 w-6 text-primary" />
                        {t('businessPartners.title') || 'Business Partners'}
                    </h1>
                    <p className="text-muted-foreground">
                        {t('businessPartners.subtitle') || 'Manage shared customer and supplier profiles in one place.'} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                {canEdit ? (
                    <Button
                        data-tour-id="tutorial-business-partner-add"
                        onClick={() => { setEditingPartner(null); setDialogOpen(true) }}
                        className="gap-2 self-start rounded-xl"
                    >
                        <Plus className="h-4 w-4" />
                        {t('businessPartners.addPartner') || 'Add Business Partner'}
                    </Button>
                ) : null}
            </div>

            <Tabs
                value={scope}
                onValueChange={(value) => {
                    const next = value as 'all' | 'customers' | 'suppliers'
                    setScope(next)
                    if (next === 'customers') {
                        navigate('/customers')
                    } else if (next === 'suppliers') {
                        navigate('/suppliers')
                    }
                }}
                className="space-y-4"
            >
                <TabsList className={cn(
                    'grid w-full max-w-[420px] rounded-2xl bg-secondary/50 p-1',
                    canViewCustomers && canViewSuppliers
                        ? 'grid-cols-3'
                        : canViewCustomers || canViewSuppliers
                            ? 'grid-cols-2'
                            : 'grid-cols-1'
                )}>
                    <TabsTrigger value="all" className="rounded-xl">{t('businessPartners.scope.all', { defaultValue: 'All' })}</TabsTrigger>
                    {canViewCustomers ? (
                        <TabsTrigger value="customers" className="rounded-xl">{t('nav.customers', { defaultValue: 'Customers' })}</TabsTrigger>
                    ) : null}
                    {canViewSuppliers ? (
                        <TabsTrigger value="suppliers" className="rounded-xl">{t('nav.suppliers', { defaultValue: 'Suppliers' })}</TabsTrigger>
                    ) : null}
                </TabsList>

                <TabsContent value="all" className="mt-0 space-y-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('businessPartners.title') || 'Business Partners'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{visiblePartners.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('orders.details.outstanding', { defaultValue: 'Receivable' })}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {renderGroupedTotals(receivableTotals)}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('businessPartners.payable') || 'Payable'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {renderGroupedTotals(payableTotals)}
                    </CardContent>
                </Card>
            </div>

            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'partners' | 'maps')} className="space-y-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <TabsList className="grid w-full max-w-[360px] grid-cols-2 rounded-2xl bg-secondary/50 p-1">
                        <TabsTrigger value="partners" className="rounded-xl">{t('businessPartners.title') || 'Business Partners'}</TabsTrigger>
                        <TabsTrigger value="maps" className="rounded-xl">{t('businessPartners.maps', { defaultValue: 'Maps' })}</TabsTrigger>
                    </TabsList>

                    {activeTab === 'partners' ? (
                    <div className="flex w-full flex-col gap-3 lg:max-w-2xl lg:flex-row lg:items-center lg:justify-end">
                        <div className="relative w-full max-w-sm">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                allowViewer={true}
                                placeholder={t('businessPartners.searchPlaceholder') || 'Search business partners...'}
                                className="pl-9"
                            />
                        </div>
                    </div>
                    ) : null}
                </div>

                <TabsContent value="partners" className="mt-0">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('businessPartners.title') || 'Business Partners'}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('businessPartners.form.partnerName')}</TableHead>
                                            <TableHead>{t('suppliers.table.contact') || 'Contact'}</TableHead>
                                            <TableHead>{t('businessPartners.form.role') || 'Role'}</TableHead>
                                            <TableHead>{t('suppliers.table.currency') || 'Currency'}</TableHead>
                                            <TableHead>{t('businessPartners.creditLimits', { defaultValue: 'Credit Limits' })}</TableHead>
                                            <TableHead>{t('businessPartners.receivable') || 'Receivable'}</TableHead>
                                            <TableHead>{t('businessPartners.payable') || 'Payable'}</TableHead>
                                            <TableHead>{t('businessPartners.loans') || 'Loans'}</TableHead>
                                            <TableHead>{t('businessPartners.netExposure') || 'Net Exposure'}</TableHead>
                                            <TableHead className="text-right">{t('common.actions') || 'Actions'}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {filteredPartners.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                                                    {t('common.noData') || 'No data available'}
                                                </TableCell>
                                            </TableRow>
                                        ) : filteredPartners.map((partner) => {
                                            const agent = partner.agentFacetId ? agentMap.get(partner.agentFacetId) : undefined
                                            const linkedUser = agent?.linkedUserId ? workspaceUserMap.get(agent.linkedUserId) : undefined
                                            return (
                                                <TableRow
                                                    key={partner.id}
                                                    data-tour-id={demoTutorial.state?.businessPartnerId === partner.id ? 'tutorial-business-partner-created' : undefined}
                                                >
                                                    <TableCell className="font-semibold">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            {partner.role === 'agent' ? (
                                                                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
                                                                    {linkedUser?.profileUrl ? (
                                                                        <img
                                                                            src={platformService.convertFileSrc(linkedUser.profileUrl)}
                                                                            alt=""
                                                                            className="h-full w-full object-cover"
                                                                        />
                                                                    ) : (
                                                                        <UsersRound className="h-4 w-4 text-muted-foreground" />
                                                                    )}
                                                                </div>
                                                            ) : null}
                                                            <span>{partner.partnerName}</span>
                                                            {partner.isEcommerce ? (
                                                                <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                                                                    {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>{partner.phone || 'N/A'}</TableCell>
                                                    <TableCell>
                                                        <span className={partner.role === 'both'
                                                            ? 'inline-flex rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-primary'
                                                            : partner.role === 'customer'
                                                                ? 'inline-flex rounded-full border border-secondary bg-secondary px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-secondary-foreground'
                                                                : partner.role === 'supplier'
                                                                    ? 'inline-flex rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-foreground'
                                                                    : 'inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300'}>
                                                            {roleLabel(partner.role, t)}
                                                        </span>
                                                        {agent ? (
                                                            <div className="mt-1 flex flex-wrap gap-1.5">
                                                                <span className="text-xs text-muted-foreground">
                                                                    {agent.agentType === 'driver'
                                                                        ? t('businessPartners.agent.types.driver', { defaultValue: 'Driver' })
                                                                        : t('businessPartners.agent.types.fieldAgent', { defaultValue: 'Field Agent' })}
                                                                </span>
                                                                <span className={agent.status === 'active'
                                                                    ? 'rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700 dark:text-emerald-300'
                                                                    : agent.status === 'blocked'
                                                                        ? 'rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-700 dark:text-rose-300'
                                                                        : 'rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground'}>
                                                                    {t(`businessPartners.agent.statuses.${agent.status}`, { defaultValue: agent.status })}
                                                                </span>
                                                            </div>
                                                        ) : null}
                                                    </TableCell>
                                                    <TableCell>{partner.defaultCurrency.toUpperCase()}</TableCell>
                                                    <TableCell className="text-xs">
                                                        <div>R: {partner.receivableCreditLimit == null ? '∞' : formatCurrency(partner.receivableCreditLimit, partner.defaultCurrency, features.iqd_display_preference)}</div>
                                                        <div>P: {partner.payableCreditLimit == null ? '∞' : formatCurrency(partner.payableCreditLimit, partner.defaultCurrency, features.iqd_display_preference)}</div>
                                                    </TableCell>
                                                    <TableCell>{formatCurrency(partner.receivableBalance, partner.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                                    <TableCell>{formatCurrency(partner.payableBalance, partner.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                                    <TableCell>{formatCurrency(partner.loanOutstandingBalance, partner.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                                    <TableCell>{formatCurrency(partner.netExposure, partner.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                                    <TableCell className="text-right">
                                                        <div className="flex justify-end gap-1">
                                                            <Button variant="ghost" size="icon" allowViewer={true} onClick={() => navigate(`/business-partners/${partner.id}`)}>
                                                                <Eye className="h-4 w-4" />
                                                            </Button>
                                                            {canEdit ? (
                                                                <Button variant="ghost" size="icon" onClick={() => { setEditingPartner(partner); setDialogOpen(true) }}>
                                                                    <Pencil className="h-4 w-4" />
                                                                </Button>
                                                            ) : null}
                                                            {canDelete ? (
                                                                <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget(partner)}>
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
                </TabsContent>

                <TabsContent value="maps" className="mt-0">
                    <Card className="overflow-hidden">
                        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-1.5">
                                <CardTitle className="flex items-center gap-2">
                                    <MapPin className="h-5 w-5 text-primary" />
                                    {t('businessPartners.maps', { defaultValue: 'Maps' })}
                                    <AutocompleteLoadingIndicator isLoading={partners.isLoading} />
                                </CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('businessPartners.mapsDescription', { defaultValue: 'All business partner locations in this workspace.' })}
                                </p>
                            </div>
                            <div className="flex w-full flex-col gap-3 sm:w-80 sm:items-end">
                                <PartnerAutocompleteInput
                                    value={mapPartnerSearch}
                                    onChange={(value) => {
                                        setMapPartnerSearch(value)
                                        if (!value.trim()) {
                                            setFocusedMapPartnerId(null)
                                        }
                                    }}
                                    onSelectPartner={(partner) => {
                                        setMapPartnerSearch(partner.partnerName)
                                        setFocusedMapPartnerId(partner.id)
                                    }}
                                    workspaceId={user?.workspaceId || ''}
                                    includeRealEstateRoles={features.real_estate}
                                    includeAgentRoles={features.agents}
                                    excludePartnerIds={partnerIdsWithoutLocations}
                                    disabled={!user?.workspaceId}
                                    isLoading={partners.isLoading}
                                    placeholder={t('businessPartners.searchMapPlaceholder', { defaultValue: 'Search a partner on the map...' })}
                                />
                                <div className="shrink-0 rounded-full bg-primary/10 px-3 py-1 text-sm font-semibold text-primary">
                                    {t('businessPartners.locationsOnMap', {
                                        count: partnersWithLocations.length,
                                        defaultValue: '{{count}} locations on map'
                                    })}
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className="relative p-0">
                            <AtlasMap
                                center={partnersWithLocations[0]
                                    ? [partnersWithLocations[0].longitude, partnersWithLocations[0].latitude]
                                    : DEFAULT_MAP_CENTER}
                                zoom={partnersWithLocations.length ? 11 : 5}
                                className="h-[600px] w-full md:h-[720px]"
                            >
                                <MapControls showCompass showFullscreen showLocate position="top-right" />
                                <PartnerMapBounds
                                    partners={partnersWithLocations}
                                    focusedPartnerId={focusedMapPartnerId}
                                />
                                {partnersWithLocations.map((partner) => (
                                    <MapMarker
                                        key={partner.id}
                                        longitude={partner.longitude}
                                        latitude={partner.latitude}
                                    >
                                        <MarkerContent>
                                            <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-background bg-primary text-white shadow-lg transition-transform hover:scale-110">
                                                <MapPin className="h-5 w-5" />
                                            </div>
                                        </MarkerContent>
                                        <MarkerPopup closeButton>
                                            <div className="min-w-52 space-y-2 pr-4">
                                                <div>
                                                    <p className="font-semibold">{partner.partnerName}</p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {roleLabel(partner.role, t)}
                                                    </p>
                                                </div>
                                                {partner.address || partner.city ? (
                                                    <p className="text-sm text-muted-foreground">
                                                        {[partner.address, partner.city]
                                                            .filter((value): value is string => Boolean(value))
                                                            .join(', ')}
                                                    </p>
                                                ) : null}
                                                {partner.phone ? (
                                                    <p className="text-sm text-muted-foreground">
                                                        {partner.phone}
                                                    </p>
                                                ) : null}
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    allowViewer={true}
                                                    onClick={() => navigate(`/business-partners/${partner.id}`)}
                                                >
                                                    {t('common.view', { defaultValue: 'View' })}
                                                </Button>
                                            </div>
                                        </MarkerPopup>
                                    </MapMarker>
                                ))}
                            </AtlasMap>
                            {partnersWithLocations.length === 0 ? (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/50 p-6 text-center backdrop-blur-[1px]">
                                    <div className="max-w-sm rounded-2xl border bg-background/95 p-5 shadow-lg">
                                        <MapPin className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
                                        <p className="font-semibold">
                                            {t('businessPartners.noPartnerLocations', { defaultValue: 'No partner locations yet' })}
                                        </p>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                            {t('businessPartners.noPartnerLocationsDescription', { defaultValue: 'Add a location to a business partner to show it here.' })}
                                        </p>
                                    </div>
                                </div>
                            ) : null}
                        </CardContent>
                    </Card>
                </TabsContent>

            </Tabs>
                </TabsContent>
            </Tabs>

            <BusinessPartnerFormDialog
                isOpen={dialogOpen}
                onOpenChange={(open) => {
                    setDialogOpen(open)
                    if (!open) {
                        setEditingPartner(null)
                    }
                }}
                partner={editingPartner}
                defaultCurrency={features.default_currency}
                availableCurrencies={availableCurrencies}
                enableRealEstateRoles={features.real_estate}
                enableAgentRole={features.agents}
                lockedRole={isTutorialBusinessPartnerTask && !editingPartner ? 'both' : undefined}
                workspaceId={user?.workspaceId}
                isSaving={isSaving}
                onSubmit={handleSubmit}
            />

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onConfirm={handleDelete}
                itemName={deleteTarget?.partnerName}
                title={t('businessPartners.deleteTitle') || 'Delete Business Partner'}
                description={t('businessPartners.deleteWarning') || 'Partners with historical transactions cannot be deleted and must be archived instead.'}
            />
        </div>
    )
}
