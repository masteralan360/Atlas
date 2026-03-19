import { useMemo, useState, type FormEvent } from 'react'
import { Plus, Pencil, Search, Trash2, Truck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { formatCurrency } from '@/lib/utils'
import {
    createSupplier,
    deleteSupplier,
    updateSupplier,
    useSuppliers,
    type CurrencyCode,
    type Supplier
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

type SupplierFormState = {
    name: string
    contactName: string
    email: string
    phone: string
    address: string
    city: string
    country: string
    defaultCurrency: CurrencyCode
    notes: string
    creditLimit: string
}

const emptyForm: SupplierFormState = {
    name: '',
    contactName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: '',
    defaultCurrency: 'usd',
    notes: '',
    creditLimit: ''
}

export function Suppliers() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { toast } = useToast()
    const suppliers = useSuppliers(user?.workspaceId)
    const [search, setSearch] = useState('')
    const [dialogOpen, setDialogOpen] = useState(false)
    const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null)
    const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null)
    const [formState, setFormState] = useState<SupplierFormState>({
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

    const filteredSuppliers = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return suppliers
        return suppliers.filter((supplier) =>
            supplier.name.toLowerCase().includes(query)
            || supplier.contactName?.toLowerCase().includes(query)
            || supplier.phone?.toLowerCase().includes(query)
            || supplier.email?.toLowerCase().includes(query)
        )
    }, [suppliers, search])

    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'

    function resetForm() {
        setEditingSupplier(null)
        setFormState({
            ...emptyForm,
            defaultCurrency: features.default_currency
        })
    }

    function openCreateDialog() {
        resetForm()
        setDialogOpen(true)
    }

    function openEditDialog(supplier: Supplier) {
        setEditingSupplier(supplier)
        setFormState({
            name: supplier.name,
            contactName: supplier.contactName || '',
            email: supplier.email || '',
            phone: supplier.phone || '',
            address: supplier.address || '',
            city: supplier.city || '',
            country: supplier.country || '',
            defaultCurrency: supplier.defaultCurrency,
            notes: supplier.notes || '',
            creditLimit: supplier.creditLimit ? String(supplier.creditLimit) : ''
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
                contactName: formState.contactName.trim() || undefined,
                email: formState.email.trim() || undefined,
                phone: formState.phone.trim() || undefined,
                address: formState.address.trim() || undefined,
                city: formState.city.trim() || undefined,
                country: formState.country.trim() || undefined,
                defaultCurrency: formState.defaultCurrency,
                notes: formState.notes.trim() || undefined,
                creditLimit: Number(formState.creditLimit || 0)
            }

            if (editingSupplier) {
                await updateSupplier(editingSupplier.id, payload)
                toast({ title: t('suppliers.messages.updateSuccess') || 'Supplier updated successfully' })
            } else {
                await createSupplier(user.workspaceId, payload)
                toast({ title: t('suppliers.messages.addSuccess') || 'Supplier added successfully' })
            }

            setDialogOpen(false)
            resetForm()
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
            await deleteSupplier(deleteTarget.id)
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
                    <p className="text-muted-foreground">{t('suppliers.subtitle') || 'Manage your suppliers'}</p>
                </div>
                {canEdit && (
                    <Button onClick={openCreateDialog} className="gap-2 self-start rounded-xl">
                        <Plus className="h-4 w-4" />
                        {t('suppliers.addSupplier') || 'Add Supplier'}
                    </Button>
                )}
            </div>

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
                        <CardTitle className="text-sm text-muted-foreground">{t('orders.tabs.purchase') || 'Purchase Orders'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{suppliers.reduce((sum, supplier) => sum + supplier.totalPurchases, 0)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('common.total') || 'Total Spent'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{suppliers.filter((supplier) => supplier.totalSpent > 0).length}</div>
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
                                    <TableHead>{t('suppliers.table.company') || 'Company'}</TableHead>
                                    <TableHead>{t('suppliers.table.contact') || 'Contact'}</TableHead>
                                    <TableHead>{t('suppliers.table.email') || 'Email'}</TableHead>
                                    <TableHead>{t('suppliers.table.phone') || 'Phone'}</TableHead>
                                    <TableHead>{t('suppliers.table.currency') || 'Currency'}</TableHead>
                                    <TableHead>{t('orders.tabs.purchase') || 'Purchases'}</TableHead>
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
                                            <TableCell className="font-semibold">{supplier.name}</TableCell>
                                            <TableCell>{supplier.contactName || '—'}</TableCell>
                                            <TableCell>{supplier.email || '—'}</TableCell>
                                            <TableCell>{supplier.phone || '—'}</TableCell>
                                            <TableCell>{supplier.defaultCurrency.toUpperCase()}</TableCell>
                                            <TableCell>{supplier.totalPurchases}</TableCell>
                                            <TableCell>{formatCurrency(supplier.totalSpent, supplier.defaultCurrency, features.iqd_display_preference)}</TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex justify-end gap-1">
                                                    {canEdit && (
                                                        <Button variant="ghost" size="icon" onClick={() => openEditDialog(supplier)}>
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

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editingSupplier ? (t('suppliers.editSupplier') || 'Edit Supplier') : (t('suppliers.addSupplier') || 'Add Supplier')}</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="supplier-name">{t('suppliers.form.name') || 'Company Name'}</Label>
                                <Input id="supplier-name" value={formState.name} onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))} required />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="supplier-contact">{t('suppliers.form.contactName') || 'Contact Name'}</Label>
                                <Input id="supplier-contact" value={formState.contactName} onChange={(event) => setFormState((current) => ({ ...current, contactName: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="supplier-email">{t('suppliers.form.email') || 'Email'}</Label>
                                <Input id="supplier-email" type="email" value={formState.email} onChange={(event) => setFormState((current) => ({ ...current, email: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="supplier-phone">{t('suppliers.form.phone') || 'Phone'}</Label>
                                <Input id="supplier-phone" value={formState.phone} onChange={(event) => setFormState((current) => ({ ...current, phone: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label>{t('suppliers.form.defaultCurrency') || 'Default Currency'}</Label>
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
                                <Label htmlFor="supplier-credit">{t('suppliers.form.creditLimit') || 'Credit Limit'}</Label>
                                <Input id="supplier-credit" type="number" min="0" step="0.01" value={formState.creditLimit} onChange={(event) => setFormState((current) => ({ ...current, creditLimit: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="supplier-city">{t('suppliers.form.city') || 'City'}</Label>
                                <Input id="supplier-city" value={formState.city} onChange={(event) => setFormState((current) => ({ ...current, city: event.target.value }))} />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="supplier-country">{t('suppliers.form.country') || 'Country'}</Label>
                                <Input id="supplier-country" value={formState.country} onChange={(event) => setFormState((current) => ({ ...current, country: event.target.value }))} />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="supplier-address">{t('suppliers.form.address') || 'Address'}</Label>
                                <Input id="supplier-address" value={formState.address} onChange={(event) => setFormState((current) => ({ ...current, address: event.target.value }))} />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="supplier-notes">{t('suppliers.form.notes') || 'Notes'}</Label>
                                <Textarea id="supplier-notes" rows={4} value={formState.notes} onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))} />
                            </div>
                        </div>

                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                                {t('common.cancel') || 'Cancel'}
                            </Button>
                            <Button type="submit" disabled={isSaving}>
                                {isSaving ? (t('common.loading') || 'Loading...') : (editingSupplier ? (t('common.save') || 'Save') : (t('common.create') || 'Create'))}
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
                title={t('suppliers.confirmDelete') || 'Delete Supplier'}
                description={t('suppliers.deleteWarning') || 'All supplier data and transaction history will be permanently removed.'}
            />
        </div>
    )
}
