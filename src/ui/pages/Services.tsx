import { useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { BriefcaseBusiness, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import {
    deleteProduct,
    useCategories,
    useProducts,
    type Product
} from '@/local-db'
import { isService } from '@/lib/catalogItem'
import { getProductImageDisplayUrl } from '@/lib/productImageStorage'
import { formatCurrency } from '@/lib/utils'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Card,
    CardContent,
    DeleteConfirmationModal,
    Input,
    useToast
} from '@/ui/components'

export function Services() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const [, navigate] = useLocation()
    const { toast } = useToast()
    const products = useProducts(user?.workspaceId, { syncBarcodeCache: false })
    const categories = useCategories(user?.workspaceId)
    const [search, setSearch] = useState('')
    const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)
    const canEdit = user?.role === 'admin' || user?.role === 'staff'

    const services = useMemo(() => products
        .filter(isService)
        .filter((service) => {
            const query = search.trim().toLocaleLowerCase()
            return !query
                || service.name.toLocaleLowerCase().includes(query)
                || service.sku?.toLocaleLowerCase().includes(query)
                || service.description?.toLocaleLowerCase().includes(query)
                || categories.find((category) => category.id === service.categoryId)?.name.toLocaleLowerCase().includes(query)
        })
        .sort((left, right) => left.name.localeCompare(right.name)), [categories, products, search])

    return (
        <div className="space-y-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold"><BriefcaseBusiness className="h-6 w-6 text-primary" />{t('services.title')}</h1>
                    <p className="text-muted-foreground">{t('services.subtitle')}</p>
                </div>
                {canEdit && <Button onClick={() => navigate('/services/new')}><Plus className="h-4 w-4" />{t('services.addService')}</Button>}
            </div>

            <div className="relative max-w-md"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder={t('services.searchPlaceholder')} /></div>

            <Card>
                <CardContent className="p-0">
                    {services.length === 0 ? <div className="py-14 text-center text-muted-foreground">{t('services.empty')}</div> : (
                        <div className="divide-y">
                            {services.map((service) => (
                                <div key={service.id} className="flex items-center gap-4 p-4">
                                    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10 text-primary">
                                        {service.imageUrl ? <img src={getProductImageDisplayUrl(service.imageUrl)} alt="" className="h-full w-full object-cover" /> : <BriefcaseBusiness className="h-5 w-5" />}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2"><span className="truncate font-semibold">{service.name}</span><span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">{t('services.badge')}</span></div>
                                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                                            <span className="truncate">{categories.find((category) => category.id === service.categoryId)?.name || t('categories.noCategory')}</span>
                                            {service.sku && <span className="font-mono text-xs">{t('products.table.sku')}: {service.sku}</span>}
                                        </div>
                                    </div>
                                    <div className="text-right font-semibold">{formatCurrency(service.price, service.currency, features.iqd_display_preference)}</div>
                                    <Button variant="ghost" size="icon" onClick={() => navigate(`/services/${service.id}`)}><Pencil className="h-4 w-4" /></Button>
                                    {canEdit && <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget(service)}><Trash2 className="h-4 w-4" /></Button>}
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                title={t('services.confirmDelete')}
                description={t('services.deleteDescription')}
                itemName={deleteTarget?.name || ''}
                onConfirm={() => {
                    if (!deleteTarget) return
                    void deleteProduct(deleteTarget.id).then(() => setDeleteTarget(null)).catch((error) => toast({ variant: 'destructive', title: t('services.messages.deleteError'), description: String(error) }))
                }}
            />
        </div>
    )
}
