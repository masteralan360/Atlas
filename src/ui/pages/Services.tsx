import { useDeferredValue, useState } from 'react'
import { useLocation } from 'wouter'
import { BriefcaseBusiness, FolderKey, Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import {
    deleteProduct,
    useCategories,
    useServicesCatalogPage,
    type Product
} from '@/local-db'
import { getProductImageDisplayUrl } from '@/lib/productImageStorage'
import { formatCurrency } from '@/lib/utils'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { ServiceAccessCategoriesDialog } from '@/ui/components/services/ServiceAccessCategoriesDialog'
import { Input } from '@/ui/components/input'
import {
    AppPagination,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    useToast,
} from '@/ui/components'

export function Services() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const [, navigate] = useLocation()
    const { toast } = useToast()
    const categories = useCategories(user?.workspaceId)
    const isOnline = useNetworkStatus()
    const workspaceId = user?.workspaceId
    const isRemoteBrowse = Boolean(workspaceId && isOnline && !isLocalWorkspaceMode(workspaceId))
    const [search, setSearch] = useState('')
    const deferredSearch = useDeferredValue(search)
    const pagination = usePaginationState({ resetOn: [search], initialPageSize: 20 })
    const [refreshKey, setRefreshKey] = useState(0)
    const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canManageAccess = user?.role === 'admin' && Boolean(workspaceId)
    const [accessCategoriesOpen, setAccessCategoriesOpen] = useState(false)

    const servicesPage = useServicesCatalogPage({
        workspaceId,
        search: deferredSearch,
        page: pagination.currentPage,
        pageSize: pagination.pageSize,
        enabled: isRemoteBrowse,
        refreshKey
    }, categories)
    const servicesPagination = usePaginationBounds({
        currentPage: pagination.currentPage,
        setCurrentPage: pagination.setCurrentPage,
        totalCount: servicesPage.totalCount,
        pageCount: servicesPage.pageCount,
        pageSize: pagination.pageSize,
        isLoading: servicesPage.isLoading,
        error: servicesPage.error,
    })

    const handleDelete = async () => {
        if (!deleteTarget || isDeleting) return
        setIsDeleting(true)
        try {
            await deleteProduct(deleteTarget.id)
            setDeleteTarget(null)
            setRefreshKey((key) => key + 1)
        } catch (error) {
            toast({
                variant: 'destructive',
                title: t('services.messages.deleteError'),
                description: t('services.messages.deleteErrorDescription')
            })
            console.error('[Services] Failed to delete a service:', error)
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold"><BriefcaseBusiness className="h-6 w-6 text-primary" />{t('services.title')}</h1>
                    <p className="text-muted-foreground">{t('services.subtitle')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canManageAccess && <Button variant="outline" onClick={() => setAccessCategoriesOpen(true)}><FolderKey className="h-4 w-4" />{t('services.access.manage')}</Button>}
                    {canEdit && <Button onClick={() => navigate('/services/new')}><Plus className="h-4 w-4" />{t('services.addService')}</Button>}
                </div>
            </div>

            <div className="relative max-w-md">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="pl-9"
                    placeholder={t('services.searchPlaceholder')}
                />
            </div>

            <Card>
                <CardHeader className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div className="space-y-1">
                        <CardTitle>{t('services.title')}</CardTitle>
                        <p className="text-xs text-muted-foreground">
                            {t('services.pagination.total', { count: servicesPage.totalCount })}
                        </p>
                    </div>
                    <AppPagination
                        currentPage={servicesPagination.currentPage}
                        totalCount={servicesPage.totalCount}
                        pageCount={servicesPagination.pageCount}
                        pageSize={pagination.pageSize}
                        onPageChange={pagination.setCurrentPage}
                        onPageSizeChange={pagination.setPageSize}
                        className="mx-0 w-auto justify-start"
                    />
                </CardHeader>
                <CardContent className="p-0">
                    {servicesPage.isLoading ? (
                        <div className="flex min-h-60 items-center justify-center gap-2 py-8 text-center text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t('common.loading', { defaultValue: 'Loading...' })}
                        </div>
                    ) : servicesPage.error ? (
                        <div className="flex min-h-60 items-center justify-center px-4 py-8 text-center text-muted-foreground">
                            {t('services.catalogLoadError')}
                        </div>
                    ) : servicesPage.services.length === 0 ? (
                        <div className="py-14 text-center text-muted-foreground">
                            {search.trim() ? t('services.noMatching') : t('services.empty')}
                        </div>
                    ) : (
                        <div className="divide-y">
                            {servicesPage.services.map((service) => (
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
                onClose={() => {
                    if (!isDeleting) setDeleteTarget(null)
                }}
                title={t('services.confirmDelete')}
                description={t('services.deleteDescription')}
                itemName={deleteTarget?.name || ''}
                isLoading={isDeleting}
                onConfirm={() => void handleDelete()}
            />
            {canManageAccess && workspaceId && (
                <ServiceAccessCategoriesDialog
                    open={accessCategoriesOpen}
                    onOpenChange={setAccessCategoriesOpen}
                    workspaceId={workspaceId}
                />
            )}
        </div>
    )
}
