import { useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { Eye, Pencil, Plus, Search, Trash2, Truck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import {
    createBusinessPartner,
    deleteBusinessPartner,
    updateBusinessPartner,
    useBusinessPartners,
    type BusinessPartner,
    type CurrencyCode
} from '@/local-db'
import { cn, formatCurrency } from '@/lib/utils'
import { useWorkspace } from '@/workspace'
import {
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
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    useToast
} from '@/ui/components'
import { useWorkspacePermissions } from '@/permissions/WorkspacePermissionsContext'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { BusinessPartnerFormDialog, type BusinessPartnerFormPayload } from '@/ui/components/crm/BusinessPartnerFormDialog'

export function Suppliers() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const { hasPermission } = useWorkspacePermissions()
    const canViewAll = hasPermission('businessPartners.access')
    const canViewCustomers = hasPermission('customers.access')
    const [scope, setScope] = useState<'all' | 'customers' | 'suppliers'>('suppliers')
    const suppliers = useBusinessPartners(user?.workspaceId, { roles: ['supplier'] })
    const [search, setSearch] = useState('')
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingPartner, setEditingPartner] = useState<BusinessPartner | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<BusinessPartner | null>(null)
    const [isSaving, setIsSaving] = useState(false)

    const availableCurrencies = useMemo(() => {
        return Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[]
    }, [features.allowed_currencies, features.default_currency])

    const filteredSuppliers = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return suppliers
        return suppliers.filter((supplier) =>
            [supplier.partnerName, supplier.phone, supplier.city]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .some((value) => value.toLowerCase().includes(query))
        )
    }, [suppliers, search])

    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'

    async function handleSubmit(payload: BusinessPartnerFormPayload) {
        if (!user?.workspaceId) return

        setIsSaving(true)
        try {
            if (editingPartner) {
                await updateBusinessPartner(editingPartner.id, payload)
                toast({ title: t('suppliers.messages.updateSuccess') || 'Supplier updated successfully' })
            } else {
                await createBusinessPartner(user.workspaceId, {
                    ...payload,
                    role: payload.role || 'supplier'
                })
                toast({ title: t('suppliers.messages.addSuccess') || 'Supplier added successfully' })
            }

            setDialogOpen(false)
            setEditingPartner(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to save supplier',
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
            toast({ title: t('suppliers.messages.deleteSuccess') || 'Supplier deleted successfully' })
            setDeleteTarget(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to delete supplier',
                variant: 'destructive'
            })
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <Truck className="h-6 w-6 text-primary" />
                        {t('suppliers.title') || 'Suppliers'}
                    </h1>
                    <p className="text-muted-foreground">
                        {t('suppliers.subtitle') || 'Manage your suppliers'} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                {canEdit && (
                    <Button onClick={() => { setEditingPartner(null); setDialogOpen(true) }} className="gap-2 self-start rounded-xl">
                        <Plus className="h-4 w-4" />
                        {t('suppliers.addSupplier') || 'Add Supplier'}
                    </Button>
                )}
            </div>

            <Tabs
                value={scope}
                onValueChange={(value) => {
                    const next = value as 'all' | 'customers' | 'suppliers'
                    setScope(next)
                    if (next === 'all') {
                        navigate('/business-partners')
                    } else if (next === 'customers') {
                        navigate('/customers')
                    }
                }}
                className="space-y-4"
            >
                <TabsList className={cn(
                    'grid w-full max-w-[420px] rounded-2xl bg-secondary/50 p-1',
                    canViewAll && canViewCustomers
                        ? 'grid-cols-3'
                        : canViewAll || canViewCustomers
                            ? 'grid-cols-2'
                            : 'grid-cols-1'
                )}>
                    {canViewAll ? (
                        <TabsTrigger value="all" className="rounded-xl">{t('businessPartners.scope.all', { defaultValue: 'All' })}</TabsTrigger>
                    ) : null}
                    {canViewCustomers ? (
                        <TabsTrigger value="customers" className="rounded-xl">{t('nav.customers', { defaultValue: 'Customers' })}</TabsTrigger>
                    ) : null}
                    <TabsTrigger value="suppliers" className="rounded-xl">{t('nav.suppliers', { defaultValue: 'Suppliers' })}</TabsTrigger>
                </TabsList>

                <TabsContent value="suppliers" className="mt-0 space-y-6">
            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('suppliers.title') || 'Suppliers'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{suppliers.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('suppliers.details.transactions', { defaultValue: 'Transactions' })}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{suppliers.reduce((sum, supplier) => sum + supplier.totalPurchaseOrders, 0)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('common.total') || 'Total Spent'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{suppliers.filter((supplier) => supplier.totalPurchaseValue > 0).length}</div>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader className="gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <CardTitle>{t('suppliers.title') || 'Suppliers'}</CardTitle>
                    <div className="relative w-full max-w-sm">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            allowViewer={true}
                            placeholder={t('suppliers.searchPlaceholder') || 'Search suppliers...'}
                            className="pl-9"
                        />
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('businessPartners.form.partnerName')}</TableHead>
                                    <TableHead>{t('suppliers.table.contact') || 'Contact'}</TableHead>
                                    <TableHead>{t('suppliers.table.phone') || 'Phone'}</TableHead>
                                    <TableHead>{t('suppliers.table.currency') || 'Currency'}</TableHead>
                                    <TableHead>{t('suppliers.details.transactions', { defaultValue: 'Transactions' })}</TableHead>
                                    <TableHead>{t('common.total') || 'Total Spent'}</TableHead>
                                    <TableHead className="text-right">{t('common.actions') || 'Actions'}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredSuppliers.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                                            {t('common.noData') || 'No data available'}
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    filteredSuppliers.map((supplier) => (
                                        <TableRow key={supplier.id}>
                                            <TableCell className="font-semibold">{supplier.partnerName}</TableCell>
                                            <TableCell>{supplier.phone || 'N/A'}</TableCell>
                                            <TableCell>{supplier.phone || 'N/A'}</TableCell>
                                            <TableCell>{supplier.defaultCurrency.toUpperCase()}</TableCell>
                                            <TableCell>{supplier.totalPurchaseOrders}</TableCell>
                                            <TableCell>{formatCurrency(supplier.totalPurchaseValue, supplier.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex justify-end gap-1">
                                                    <Button variant="ghost" size="icon" allowViewer={true} onClick={() => navigate(`/suppliers/${supplier.id}`)}>
                                                        <Eye className="h-4 w-4" />
                                                    </Button>
                                                    {canEdit && (
                                                        <Button variant="ghost" size="icon" onClick={() => { setEditingPartner(supplier); setDialogOpen(true) }}>
                                                            <Pencil className="h-4 w-4" />
                                                        </Button>
                                                    )}
                                                    {canDelete && (
                                                        <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget(supplier)}>
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </div>
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
                initialRole="supplier"
                isSaving={isSaving}
                title={editingPartner ? (t('suppliers.editSupplier') || 'Edit Supplier') : (t('suppliers.addSupplier') || 'Add Supplier')}
                submitLabel={editingPartner ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}
                onSubmit={handleSubmit}
            />

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onConfirm={handleDelete}
                itemName={deleteTarget?.partnerName}
                title={t('suppliers.confirmDelete') || 'Delete Supplier'}
                description={t('suppliers.deleteWarning') || 'All supplier data and transaction history will be permanently removed.'}
            />
        </div>
    )
}
