import { useMemo, useState, type FormEvent } from 'react'
import { Users, Plus, Pencil, Trash2, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { formatCurrency } from '@/lib/utils'
import {
    createCustomer,
    deleteCustomer,
    updateCustomer,
    useCustomers,
    type CurrencyCode,
    type Customer
} from '@/local-db'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
    useToast
} from '@/ui/components'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'

type CustomerFormState = {
    name: string
    email: string
    phone: string
    address: string
    city: string
    country: string
    defaultCurrency: CurrencyCode
    notes: string
    creditLimit: string
}

const emptyForm: CustomerFormState = {
    name: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: '',
    defaultCurrency: 'usd',
    notes: '',
    creditLimit: ''
}

export function Customers() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { toast } = useToast()
    const customers = useCustomers(user?.workspaceId)
    const [search, setSearch] = useState('')
    const [dialogOpen, setDialogOpen] = useState(false)
    const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null)
    const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
    const [formState, setFormState] = useState<CustomerFormState>({
        ...emptyForm,
        defaultCurrency: features.default_currency
    })
    const [isSaving, setIsSaving] = useState(false)

    const availableCurrencies = useMemo(() => {
        const currencies: CurrencyCode[] = ['usd', 'iqd']
        if (features.eur_conversion_enabled) currencies.push('eur')
        if (features.try_conversion_enabled) currencies.push('try')
        return currencies
    }, [features.default_currency, features.eur_conversion_enabled, features.try_conversion_enabled])

    const filteredCustomers = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return customers
        return customers.filter((customer) =>
            customer.name.toLowerCase().includes(query)
            || customer.phone?.toLowerCase().includes(query)
            || customer.email?.toLowerCase().includes(query)
            || customer.city?.toLowerCase().includes(query)
        )
    }, [customers, search])

    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'

    function resetForm() {
        setEditingCustomer(null)
        setFormState({
            ...emptyForm,
            defaultCurrency: features.default_currency
        })
    }

    function openCreateDialog() {
        resetForm()
        setDialogOpen(true)
    }

    function openEditDialog(customer: Customer) {
        setEditingCustomer(customer)
        setFormState({
            name: customer.name,
            email: customer.email || '',
            phone: customer.phone || '',
            address: customer.address || '',
            city: customer.city || '',
            country: customer.country || '',
            defaultCurrency: customer.defaultCurrency,
            notes: customer.notes || '',
            creditLimit: customer.creditLimit ? String(customer.creditLimit) : ''
        })
        setDialogOpen(true)
    }

    async function handleSubmit(event: FormEvent) {
        event.preventDefault()
        if (!user?.workspaceId) return

        setIsSaving(true)
        try {
            const payload = {
                name: formState.name.trim(),
                email: formState.email.trim() || undefined,
                phone: formState.phone.trim() || undefined,
                address: formState.address.trim() || undefined,
                city: formState.city.trim() || undefined,
                country: formState.country.trim() || undefined,
                defaultCurrency: formState.defaultCurrency,
                notes: formState.notes.trim() || undefined,
                creditLimit: Number(formState.creditLimit || 0)
            }

            if (editingCustomer) {
                await updateCustomer(editingCustomer.id, payload)
                toast({ title: t('customers.messages.updateSuccess') || 'Customer updated successfully' })
            } else {
                await createCustomer(user.workspaceId, payload)
                toast({ title: t('customers.messages.addSuccess') || 'Customer added successfully' })
            }

            setDialogOpen(false)
            resetForm()
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
            await deleteCustomer(deleteTarget.id)
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

    const totalOutstanding = filteredCustomers.reduce((count, customer) => count + (customer.outstandingBalance > 0 ? 1 : 0), 0)

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
                    <Button onClick={openCreateDialog} className="gap-2 self-start rounded-xl">
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
                        <div className="text-3xl font-black">{customers.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('orders.table.items') || 'Orders'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{customers.reduce((sum, customer) => sum + customer.totalOrders, 0)}</div>
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
                    <div className="relative w-full max-w-sm">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('customers.searchPlaceholder') || 'Search customers...'}
                            className="pl-9"
                        />
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
                                        const location = [customer.city, customer.country].filter(Boolean).join(', ') || '—'
                                        const outstandingLabel = customer.outstandingBalance > 0
                                            ? `${t('common.amount') || 'Amount'}: ${formatCurrency(customer.outstandingBalance, customer.defaultCurrency, features.iqd_display_preference)}`
                                            : (t('common.status') || 'Clear')

                                        return (
                                            <TableRow key={customer.id}>
                                                <TableCell className="font-semibold">{customer.name}</TableCell>
                                                <TableCell>
                                                    <div className="space-y-1">
                                                        <div>{customer.phone || '—'}</div>
                                                        <div className="text-xs text-muted-foreground">{customer.email || '—'}</div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>{location}</TableCell>
                                                <TableCell>{customer.totalOrders}</TableCell>
                                                <TableCell>{formatCurrency(customer.totalSpent, customer.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell>{formatCurrency(customer.creditLimit || 0, customer.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell>
                                                    <span className={customer.outstandingBalance > 0 ? 'font-semibold text-amber-600' : 'text-emerald-600'}>
                                                        {outstandingLabel}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <div className="flex justify-end gap-1">
                                                        {canEdit && (
                                                            <Button variant="ghost" size="icon" onClick={() => openEditDialog(customer)}>
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

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editingCustomer ? (t('customers.editCustomer') || 'Edit Customer') : (t('customers.addCustomer') || 'Add Customer')}</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="customer-name">{t('customers.form.name') || 'Full Name'}</Label>
                                <Input id="customer-name" value={formState.name} onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))} required />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="customer-phone">{t('customers.form.phone') || 'Phone'}</Label>
                                <Input id="customer-phone" value={formState.phone} onChange={(event) => setFormState((current) => ({ ...current, phone: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="customer-email">{t('customers.form.email') || 'Email'}</Label>
                                <Input id="customer-email" type="email" value={formState.email} onChange={(event) => setFormState((current) => ({ ...current, email: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label>{t('customers.form.defaultCurrency') || 'Default Currency'}</Label>
                                <Select value={formState.defaultCurrency} onValueChange={(value) => setFormState((current) => ({ ...current, defaultCurrency: value as CurrencyCode }))}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {availableCurrencies.map((currency) => (
                                            <SelectItem key={currency} value={currency}>
                                                {currency.toUpperCase()}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="customer-city">{t('customers.form.city') || 'City'}</Label>
                                <Input id="customer-city" value={formState.city} onChange={(event) => setFormState((current) => ({ ...current, city: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="customer-country">{t('customers.form.country') || 'Country'}</Label>
                                <Input id="customer-country" value={formState.country} onChange={(event) => setFormState((current) => ({ ...current, country: event.target.value }))} />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="customer-address">{t('customers.form.address') || 'Address'}</Label>
                                <Input id="customer-address" value={formState.address} onChange={(event) => setFormState((current) => ({ ...current, address: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="customer-credit">{t('customers.form.creditLimit') || 'Credit Limit'}</Label>
                                <Input id="customer-credit" type="number" min="0" step="0.01" value={formState.creditLimit} onChange={(event) => setFormState((current) => ({ ...current, creditLimit: event.target.value }))} />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="customer-notes">{t('customers.form.notes') || 'Notes'}</Label>
                                <Textarea id="customer-notes" rows={4} value={formState.notes} onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))} />
                            </div>
                        </div>

                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                                {t('common.cancel') || 'Cancel'}
                            </Button>
                            <Button type="submit" disabled={isSaving}>
                                {isSaving ? (t('common.loading') || 'Loading...') : (editingCustomer ? (t('common.save') || 'Save') : (t('common.create') || 'Create'))}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

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
