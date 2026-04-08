import { useMemo, useState } from 'react'
import { Eye, GitMerge, Pencil, Plus, Search, Trash2, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import {
    createBusinessPartner,
    deleteBusinessPartner,
    dismissBusinessPartnerMergeCandidate,
    mergeBusinessPartners,
    updateBusinessPartner,
    useBusinessPartnerMergeCandidates,
    useBusinessPartners,
    type BusinessPartner,
    type BusinessPartnerRole,
    type CurrencyCode
} from '@/local-db'
import { formatCurrency } from '@/lib/utils'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Switch,
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
    useToast
} from '@/ui/components'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { BusinessPartnerFormDialog, type BusinessPartnerFormPayload } from '@/ui/components/crm/BusinessPartnerFormDialog'

function roleLabel(role: BusinessPartnerRole, t: (key: string, options?: Record<string, unknown>) => string) {
    switch (role) {
        case 'customer':
            return t('customers.title') || 'Customer'
        case 'supplier':
            return t('suppliers.title') || 'Supplier'
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

export function BusinessPartners() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const partners = useBusinessPartners(user?.workspaceId)
    const mergeCandidates = useBusinessPartnerMergeCandidates(user?.workspaceId)
    const [search, setSearch] = useState('')
    const [activeTab, setActiveTab] = useState<'partners' | 'merge-review'>('partners')
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingPartner, setEditingPartner] = useState<BusinessPartner | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<BusinessPartner | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isMerging, setIsMerging] = useState<string | null>(null)
    const [showEcommercePartners, setShowEcommercePartners] = useState(true)

    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'

    const availableCurrencies = useMemo(() => {
        const currencies: CurrencyCode[] = ['usd', 'iqd']
        if (features.eur_conversion_enabled) currencies.push('eur')
        if (features.try_conversion_enabled) currencies.push('try')
        return currencies
    }, [features.eur_conversion_enabled, features.try_conversion_enabled])

    const visiblePartners = useMemo(() => {
        if (showEcommercePartners) {
            return partners
        }

        return partners.filter((partner) => !partner.isEcommerce)
    }, [partners, showEcommercePartners])

    const filteredPartners = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) {
            return visiblePartners
        }

        return visiblePartners.filter((partner) =>
            [partner.name, partner.contactName, partner.email, partner.phone, partner.city, partner.country]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .some((value) => value.toLowerCase().includes(query))
        )
    }, [visiblePartners, search])

    const partnerMap = useMemo(
        () => new Map(partners.map((partner) => [partner.id, partner])),
        [partners]
    )
    const pendingMergeCandidates = useMemo(
        () => mergeCandidates.filter((candidate) => candidate.status === 'pending' && !candidate.isDeleted),
        [mergeCandidates]
    )
    const receivableTotals = useMemo(
        () => groupPartnerTotalsByCurrency(visiblePartners, (partner) => partner.receivableBalance),
        [visiblePartners]
    )
    const payableTotals = useMemo(
        () => groupPartnerTotalsByCurrency(visiblePartners, (partner) => partner.payableBalance),
        [visiblePartners]
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
                await updateBusinessPartner(editingPartner.id, payload)
                toast({ title: t('businessPartners.messages.updateSuccess') || 'Business partner updated successfully' })
            } else {
                await createBusinessPartner(user.workspaceId, payload)
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

    async function handleAcceptMerge(candidateId: string, primaryPartnerId: string, secondaryPartnerId: string) {
        setIsMerging(candidateId)
        try {
            await mergeBusinessPartners(primaryPartnerId, secondaryPartnerId)
            toast({ title: t('businessPartners.messages.mergeSuccess') || 'Business partners merged successfully' })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to merge business partners',
                variant: 'destructive'
            })
        } finally {
            setIsMerging(null)
        }
    }

    async function handleDismissMerge(candidateId: string) {
        setIsMerging(candidateId)
        try {
            await dismissBusinessPartnerMergeCandidate(candidateId)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to dismiss merge candidate',
                variant: 'destructive'
            })
        } finally {
            setIsMerging(null)
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
                        {t('businessPartners.subtitle') || 'Manage shared customer and supplier profiles in one place.'}
                    </p>
                </div>
                {canEdit ? (
                    <Button onClick={() => { setEditingPartner(null); setDialogOpen(true) }} className="gap-2 self-start rounded-xl">
                        <Plus className="h-4 w-4" />
                        {t('businessPartners.addPartner') || 'Add Business Partner'}
                    </Button>
                ) : null}
            </div>

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
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('businessPartners.mergeReview') || 'Merge Review'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{pendingMergeCandidates.length}</div>
                    </CardContent>
                </Card>
            </div>

            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'partners' | 'merge-review')} className="space-y-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <TabsList className="grid w-full max-w-[360px] grid-cols-2 rounded-2xl bg-secondary/50 p-1">
                        <TabsTrigger value="partners" className="rounded-xl">{t('businessPartners.title') || 'Business Partners'}</TabsTrigger>
                        <TabsTrigger value="merge-review" className="rounded-xl">{t('businessPartners.mergeReview') || 'Merge Review'}</TabsTrigger>
                    </TabsList>

                    <div className="flex w-full flex-col gap-3 lg:max-w-2xl lg:flex-row lg:items-center lg:justify-end">
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-background/60 px-4 py-3">
                            <div className="space-y-0.5">
                                <div className="text-sm font-medium">
                                    {t('businessPartners.showEcommerce', { defaultValue: 'Show E-Commerce profiles' })}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    {showEcommercePartners
                                        ? t('businessPartners.showEcommerceVisible', { defaultValue: 'E-Commerce profiles are visible in this module.' })
                                        : t('businessPartners.showEcommerceHidden', { defaultValue: 'E-Commerce profiles are hidden from this module.' })}
                                </div>
                            </div>
                            <Switch
                                checked={showEcommercePartners}
                                onCheckedChange={setShowEcommercePartners}
                                allowViewer={true}
                            />
                        </div>
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
                                            <TableHead>{t('suppliers.table.company') || 'Company'}</TableHead>
                                            <TableHead>{t('suppliers.table.contact') || 'Contact'}</TableHead>
                                            <TableHead>{t('businessPartners.form.role') || 'Role'}</TableHead>
                                            <TableHead>{t('suppliers.table.currency') || 'Currency'}</TableHead>
                                            <TableHead>{t('customers.form.creditLimit') || 'Credit Limit'}</TableHead>
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
                                        ) : filteredPartners.map((partner) => (
                                            <TableRow key={partner.id}>
                                                <TableCell className="font-semibold">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span>{partner.name}</span>
                                                        {partner.isEcommerce ? (
                                                            <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                                                                {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                                <TableCell>{partner.contactName || partner.phone || 'N/A'}</TableCell>
                                                <TableCell>
                                                    <span className={partner.role === 'both'
                                                        ? 'inline-flex rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-primary'
                                                        : partner.role === 'customer'
                                                            ? 'inline-flex rounded-full border border-secondary bg-secondary px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-secondary-foreground'
                                                            : 'inline-flex rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-foreground'}>
                                                        {roleLabel(partner.role, t)}
                                                    </span>
                                                </TableCell>
                                                <TableCell>{partner.defaultCurrency.toUpperCase()}</TableCell>
                                                <TableCell>{formatCurrency(partner.creditLimit || 0, partner.defaultCurrency, features.iqd_display_preference)}</TableCell>
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
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="merge-review" className="mt-0">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('businessPartners.mergeReview') || 'Merge Review'}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {pendingMergeCandidates.length === 0 ? (
                                <div className="rounded-2xl border py-12 text-center text-muted-foreground">
                                    {t('businessPartners.noMergeCandidates') || 'No merge candidates found.'}
                                </div>
                            ) : pendingMergeCandidates.map((candidate) => {
                                const primary = partnerMap.get(candidate.primaryPartnerId)
                                const secondary = partnerMap.get(candidate.secondaryPartnerId)
                                return (
                                    <div key={candidate.id} className="rounded-2xl border bg-background/70 p-4">
                                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-2 text-sm font-semibold">
                                                    <GitMerge className="h-4 w-4 text-primary" />
                                                    <span>{primary?.name || candidate.primaryPartnerId}</span>
                                                    <span className="text-muted-foreground">/</span>
                                                    <span>{secondary?.name || candidate.secondaryPartnerId}</span>
                                                </div>
                                                <div className="text-sm text-muted-foreground">
                                                    {candidate.reason} · {(candidate.confidence * 100).toFixed(0)}%
                                                </div>
                                            </div>
                                            <div className="flex gap-2">
                                                <Button
                                                    variant="outline"
                                                    disabled={isMerging === candidate.id}
                                                    onClick={() => handleDismissMerge(candidate.id)}
                                                >
                                                    {t('common.dismiss') || 'Dismiss'}
                                                </Button>
                                                <Button
                                                    disabled={isMerging === candidate.id}
                                                    onClick={() => handleAcceptMerge(candidate.id, candidate.primaryPartnerId, candidate.secondaryPartnerId)}
                                                >
                                                    {t('businessPartners.merge') || 'Merge'}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                        </CardContent>
                    </Card>
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
                isSaving={isSaving}
                onSubmit={handleSubmit}
            />

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onConfirm={handleDelete}
                itemName={deleteTarget?.name}
                title={t('businessPartners.deleteTitle') || 'Delete Business Partner'}
                description={t('businessPartners.deleteWarning') || 'Partners with historical transactions cannot be deleted and must be archived instead.'}
            />
        </div>
    )
}
