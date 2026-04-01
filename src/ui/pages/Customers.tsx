import { useMemo, useState } from 'react'
import { Eye, Pencil, Plus, Search, Trash2, Users } from 'lucide-react'
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
    useToast
} from '@/ui/components'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { BusinessPartnerFormDialog, type BusinessPartnerFormPayload } from '@/ui/components/crm/BusinessPartnerFormDialog'

export function Customers() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const customers = useBusinessPartners(user?.workspaceId, { roles: ['customer'] })
    const [search, setSearch] = useState('')
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingPartner, setEditingPartner] = useState<BusinessPartner | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<BusinessPartner | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [showEcommerceCustomers, setShowEcommerceCustomers] = useState(true)

    const availableCurrencies = useMemo(() => {
        const currencies: CurrencyCode[] = ['usd', 'iqd']
        if (features.eur_conversion_enabled) currencies.push('eur')
        if (features.try_conversion_enabled) currencies.push('try')
        return currencies
    }, [features.eur_conversion_enabled, features.try_conversion_enabled])

    const visibleCustomers = useMemo(() => {
        if (showEcommerceCustomers) {
            return customers
        }

        return customers.filter((customer) => !customer.isEcommerce)
    }, [customers, showEcommerceCustomers])

    const filteredCustomers = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return visibleCustomers
        return visibleCustomers.filter((customer) =>
            [customer.name, customer.contactName, customer.phone, customer.email, customer.city]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .some((value) => value.toLowerCase().includes(query))
        )
    }, [visibleCustomers, search])

    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'

    async function handleSubmit(payload: BusinessPartnerFormPayload) {
        if (!user?.workspaceId) return

        setIsSaving(true)
        try {
            if (editingPartner) {
                await updateBusinessPartner(editingPartner.id, payload)
                toast({ title: t('customers.messages.updateSuccess') || 'Customer updated successfully' })
            } else {
                await createBusinessPartner(user.workspaceId, {
                    ...payload,
                    role: payload.role || 'customer'
                })
                toast({ title: t('customers.messages.addSuccess') || 'Customer added successfully' })
            }

            setDialogOpen(false)
            setEditingPartner(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to save customer',
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
            toast({ title: t('customers.messages.deleteSuccess') || 'Customer deleted successfully' })
            setDeleteTarget(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to delete customer',
                variant: 'destructive'
            })
        }
    }

    const totalOutstanding = visibleCustomers.reduce((count, customer) => count + (customer.receivableBalance > 0 ? 1 : 0), 0)

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <Users className="h-6 w-6 text-primary" />
                        {t('customers.title') || 'Customers'}
                    </h1>
                    <p className="text-muted-foreground">{t('customers.subtitle') || 'Manage customer accounts and balances'}</p>
                </div>
                {canEdit && (
                    <Button onClick={() => { setEditingPartner(null); setDialogOpen(true) }} className="gap-2 self-start rounded-xl">
                        <Plus className="h-4 w-4" />
                        {t('customers.addCustomer') || 'Add Customer'}
                    </Button>
                )}
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('customers.title') || 'Customers'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{visibleCustomers.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('orders.table.items') || 'Orders'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{visibleCustomers.reduce((sum, customer) => sum + customer.totalSalesOrders, 0)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('customers.form.creditLimit') || 'Outstanding Accounts'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{totalOutstanding}</div>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader className="gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <CardTitle>{t('customers.title') || 'Customers'}</CardTitle>
                    <div className="flex w-full flex-col gap-3 lg:max-w-xl lg:flex-row lg:items-center lg:justify-end">
                        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-background/60 px-4 py-3">
                            <div className="space-y-0.5">
                                <div className="text-sm font-medium">
                                    {t('customers.showEcommerce', { defaultValue: 'Show E-Commerce buyers' })}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    {showEcommerceCustomers
                                        ? t('customers.showEcommerceVisible', { defaultValue: 'E-Commerce buyers are visible in this module.' })
                                        : t('customers.showEcommerceHidden', { defaultValue: 'E-Commerce buyers are hidden from this module.' })}
                                </div>
                            </div>
                            <Switch
                                checked={showEcommerceCustomers}
                                onCheckedChange={setShowEcommerceCustomers}
                                allowViewer={true}
                            />
                        </div>
                        <div className="relative w-full max-w-sm">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                allowViewer={true}
                                placeholder={t('customers.searchPlaceholder') || 'Search customers...'}
                                className="pl-9"
                            />
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('customers.table.name') || 'Name'}</TableHead>
                                    <TableHead>{t('customers.table.contact') || 'Contact'}</TableHead>
                                    <TableHead>{t('customers.table.location') || 'Location'}</TableHead>
                                    <TableHead>{t('customers.table.orders') || 'Orders'}</TableHead>
                                    <TableHead>{t('customers.table.totalSpent') || 'Total Spent'}</TableHead>
                                    <TableHead>{t('customers.form.creditLimit') || 'Credit Limit'}</TableHead>
                                    <TableHead>{t('common.status') || 'Status'}</TableHead>
                                    <TableHead className="text-right">{t('common.actions') || 'Actions'}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredCustomers.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                                            {t('common.noData') || 'No data available'}
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    filteredCustomers.map((customer) => {
                                        const location = [customer.city, customer.country].filter(Boolean).join(', ') || 'N/A'
                                        const outstandingLabel = customer.receivableBalance > 0
                                            ? `${t('common.amount') || 'Amount'}: ${formatCurrency(customer.receivableBalance, customer.defaultCurrency, features.iqd_display_preference)}`
                                            : (t('common.status') || 'Clear')

                                        return (
                                            <TableRow key={customer.id}>
                                                <TableCell className="font-semibold">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span>{customer.name}</span>
                                                        {customer.isEcommerce ? (
                                                            <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                                                                {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="space-y-1">
                                                        <div>{customer.phone || customer.contactName || 'N/A'}</div>
                                                        <div className="text-xs text-muted-foreground">{customer.email || 'N/A'}</div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>{location}</TableCell>
                                                <TableCell>{customer.totalSalesOrders}</TableCell>
                                                <TableCell>{formatCurrency(customer.totalSalesValue, customer.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell>{formatCurrency(customer.creditLimit || 0, customer.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell>
                                                    <span className={customer.receivableBalance > 0 ? 'font-semibold text-amber-600' : 'text-emerald-600'}>
                                                        {outstandingLabel}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <div className="flex justify-end gap-1">
                                                        <Button variant="ghost" size="icon" allowViewer={true} onClick={() => navigate(`/customers/${customer.id}`)}>
                                                            <Eye className="h-4 w-4" />
                                                        </Button>
                                                        {canEdit && (
                                                            <Button variant="ghost" size="icon" onClick={() => { setEditingPartner(customer); setDialogOpen(true) }}>
                                                                <Pencil className="h-4 w-4" />
                                                            </Button>
                                                        )}
                                                        {canDelete && (
                                                            <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget(customer)}>
                                                                <Trash2 className="h-4 w-4" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })
                                )}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>

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
                initialRole="customer"
                isSaving={isSaving}
                title={editingPartner ? (t('customers.editCustomer') || 'Edit Customer') : (t('customers.addCustomer') || 'Add Customer')}
                submitLabel={editingPartner ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}
                onSubmit={handleSubmit}
            />

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onConfirm={handleDelete}
                itemName={deleteTarget?.name}
                title={t('customers.confirmDelete') || 'Delete Customer'}
                description={t('customers.deleteWarning') || 'All customer data and transaction history will be permanently removed.'}
            />
        </div>
    )
}
