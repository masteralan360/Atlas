import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useRoute } from 'wouter'
import {
    ArrowLeft,
    BriefcaseBusiness,
    Camera,
    ChevronRight,
    DollarSign,
    FileText,
    Images,
    ImagePlus,
    Info,
    Save,
    Settings,
    Tag,
    Trash2,
    Type,
    Wallet
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import {
    createProduct,
    db,
    deleteProduct,
    fetchTableFromSupabase,
    updateProduct,
    useCategories,
    useProduct,
    type Product
} from '@/local-db'
import type { CurrencyCode } from '@/local-db/models'
import { isService } from '@/lib/catalogItem'
import { assetManager } from '@/lib/assetManager'
import { getClipboardImageFile } from '@/lib/clipboardImage'
import { storeProductImageFile } from '@/lib/productImageStorage'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isTauri } from '@/lib/platform'
import { cn, formatCurrency, formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { getMediaUploadErrorCode } from '@/services/mediaUploadService'
import { useWorkspace } from '@/workspace'
import { useHideCosts } from '@/permissions'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { ProductAdditionalImagesModal } from '@/ui/components/ProductAdditionalImagesModal'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CurrencySelector,
    DeleteConfirmationModal,
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
    Switch,
    Textarea,
    useToast
} from '@/ui/components'

type ServiceFormMode = 'create' | 'edit'

type ServiceFormData = {
    name: string
    description: string
    categoryId: string | undefined
    price: string
    costPrice: string
    currency: CurrencyCode
    imageUrl: string
    canBeReturned: boolean
    returnRules: string
}

const emptyServiceFormData: ServiceFormData = {
    name: '',
    description: '',
    categoryId: undefined,
    price: '',
    costPrice: '',
    currency: 'usd',
    imageUrl: '',
    canBeReturned: true,
    returnRules: ''
}

function getCurrencySymbol(currency: string, iqdPreference: string) {
    switch (currency.toLowerCase()) {
        case 'usd':
            return '$'
        case 'eur':
            return 'EUR'
        case 'try':
            return 'TRY'
        case 'iqd':
            return iqdPreference
        default:
            return currency.toUpperCase()
    }
}

function createInitialFormData(defaultCurrency: CurrencyCode): ServiceFormData {
    return {
        ...emptyServiceFormData,
        currency: defaultCurrency
    }
}

function mapServiceToFormData(product: Product, hideCosts = false): ServiceFormData {
    return {
        name: product.name,
        description: product.description || '',
        categoryId: product.categoryId || undefined,
        price: String(product.price),
        // A restricted user must never receive an existing service cost in
        // form state; edit saves intentionally omit the field below.
        costPrice: hideCosts || product.costPrice == null ? '' : String(product.costPrice),
        currency: product.currency,
        imageUrl: product.imageUrl || '',
        canBeReturned: product.canBeReturned ?? true,
        returnRules: product.returnRules || ''
    }
}

function ServiceEditor({ mode, serviceId }: { mode: ServiceFormMode; serviceId?: string }) {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const hideCosts = useHideCosts()
    const [, navigate] = useLocation()
    const { toast } = useToast()
    const categories = useCategories(user?.workspaceId)
    const service = useProduct(serviceId)
    const isOnline = useNetworkStatus()
    const workspaceId = user?.workspaceId || ''
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const isEditing = mode === 'edit'
    const isReadOnly = isEditing && !canEdit
    const isDesktopShell = isTauri()
    const persistedServiceId = isEditing ? service?.id : undefined

    const [formData, setFormData] = useState<ServiceFormData>(() =>
        createInitialFormData(features.default_currency)
    )
    const [isSaving, setIsSaving] = useState(false)
    const [imageError, setImageError] = useState(false)
    const [returnRulesModalOpen, setReturnRulesModalOpen] = useState(false)
    const [visualsModalOpen, setVisualsModalOpen] = useState(false)
    const [additionalImagesModalOpen, setAdditionalImagesModalOpen] = useState(false)
    const [missingServiceStateVisible, setMissingServiceStateVisible] = useState(false)
    const [serviceHydrationResolved, setServiceHydrationResolved] = useState(false)
    const [deleteServiceOpen, setDeleteServiceOpen] = useState(false)
    const [isDeletingService, setIsDeletingService] = useState(false)
    const imageUploadInputRef = useRef<HTMLInputElement>(null)
    const cameraInputRef = useRef<HTMLInputElement>(null)
    const initializedKeyRef = useRef<string | null>(null)
    const initialFormSnapshotRef = useRef<string | null>(null)
    const createdServiceIdRef = useRef<string | null>(null)

    const isServiceDirty = useMemo(() => {
        if (!initialFormSnapshotRef.current || isReadOnly) {
            return false
        }

        const currentStr = JSON.stringify(formData)
        if (currentStr === initialFormSnapshotRef.current) {
            return false
        }

        try {
            const snapshot = JSON.parse(initialFormSnapshotRef.current)
            const keys = Object.keys(formData) as (keyof ServiceFormData)[]

            for (const key of keys) {
                let v1: any = formData[key]
                let v2: any = snapshot[key]

                // normalize empty representations
                if (v1 === '' || v1 === undefined) v1 = null
                if (v2 === '' || v2 === undefined) v2 = null

                // string-based comparison for values that might be coerced
                if (v1 !== null && v2 !== null) {
                    if (String(v1) !== String(v2)) {
                        return true
                    }
                } else if (v1 !== v2) {
                    return true
                }
            }
            return false
        } catch {
            return currentStr !== initialFormSnapshotRef.current
        }
    }, [formData, isReadOnly])

    const { showGuard, confirmNavigation, cancelNavigation, requestNavigation } = useUnsavedChangesGuard(isServiceDirty)

    useEffect(() => {
        createdServiceIdRef.current = null
    }, [mode, serviceId])

    useEffect(() => {
        setServiceHydrationResolved(false)
    }, [mode, serviceId])

    useEffect(() => {
        if (!canEdit && mode !== 'edit') {
            navigate('/services')
        }
    }, [canEdit, mode, navigate])

    useEffect(() => {
        if (mode === 'create' || service) {
            setMissingServiceStateVisible(false)
            setServiceHydrationResolved(true)
            return
        }

        if (!serviceHydrationResolved) {
            setMissingServiceStateVisible(false)
            return
        }

        const timer = window.setTimeout(() => setMissingServiceStateVisible(true), 500)
        return () => window.clearTimeout(timer)
    }, [mode, service, serviceHydrationResolved])

    // Self-hydrate the target service from Supabase when the local cache does
    // not have it yet. The edit page must not depend on another page having
    // already pulled the products table, otherwise a direct or repeated open
    // can leave the page in a permanent "loading"/not-found state.
    useEffect(() => {
        let cancelled = false

        const hydrateService = async () => {
            if (mode === 'create' || service) {
                setServiceHydrationResolved(true)
                return
            }

            if (!workspaceId || isLocalWorkspaceMode(workspaceId) || !isOnline) {
                setServiceHydrationResolved(true)
                return
            }

            try {
                await fetchTableFromSupabase('products', db.products, workspaceId)
                if (cancelled) return
            } catch (error) {
                if (!cancelled) {
                    console.error('[ServiceForm] Failed to hydrate service:', error)
                }
            } finally {
                if (!cancelled) {
                    setServiceHydrationResolved(true)
                }
            }
        }

        void hydrateService()

        return () => {
            cancelled = true
        }
    }, [isOnline, mode, service, serviceId, workspaceId])

    useEffect(() => {
        if (mode === 'edit' && service && !isService(service)) {
            navigate('/services')
        }
    }, [mode, navigate, service])

    useEffect(() => {
        const nextKey = mode === 'create'
            ? `create:${hideCosts ? 'hidden' : 'visible'}`
            : service
                ? `${mode}:${service.id}:${service.updatedAt}:${hideCosts ? 'hidden' : 'visible'}`
                : null

        if (!nextKey || initializedKeyRef.current === nextKey) {
            return
        }

        let nextFormData: ServiceFormData

        if (mode === 'create') {
            nextFormData = createInitialFormData(features.default_currency)
        } else {
            if (!service) {
                return
            }

            nextFormData = mapServiceToFormData(service, hideCosts)
        }

        setFormData(nextFormData)
        setImageError(false)
        initialFormSnapshotRef.current = JSON.stringify(nextFormData)
        initializedKeyRef.current = nextKey
    }, [features.default_currency, hideCosts, mode, service])

    if (!canEdit && mode !== 'edit') {
        return null
    }

    if (mode !== 'create' && service && !isService(service)) {
        return null
    }

    const goToServices = () => {
        if (isReadOnly) {
            navigate('/services')
            return
        }

        if (!requestNavigation('/services')) {
            navigate('/services')
        }
    }

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return ''
        if (url.startsWith('http')) return url
        return platformService.convertFileSrc(url)
    }

    const handleImageUpload = async () => {
        if (!canEdit) return

        if (isDesktopShell) {
            const selectedFile = await platformService.pickImageFile()
            if (selectedFile) await handleFileSelected(selectedFile)
            return
        }

        imageUploadInputRef.current?.click()
    }

    const handleFileSelected = async (file: File) => {
        try {
            const targetPath = await storeProductImageFile(file, workspaceId, 'service-image')
            if (targetPath) {
                setFormData((current) => ({ ...current, imageUrl: targetPath }))
                setImageError(false)
            }
        } catch (error) {
            const code = getMediaUploadErrorCode(error) || 'upload_failed'
            toast({
                title: t('common.error'),
                description: t(`mediaUpload.errors.${code}`),
                variant: 'destructive',
            })
        }
    }

    const handleCameraCapture = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return

        await handleFileSelected(file)

        if (cameraInputRef.current) {
            cameraInputRef.current.value = ''
        }
    }

    const handleImageFileInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return

        await handleFileSelected(file)

        if (imageUploadInputRef.current) {
            imageUploadInputRef.current.value = ''
        }
    }

    const handleVisualsPaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
        if (!canEdit) return

        const file = getClipboardImageFile(event.clipboardData)
        if (!file) return

        event.preventDefault()
        await handleFileSelected(file)
    }

    const handleRemoveImage = async () => {
        if (!formData.imageUrl || !canEdit) {
            return
        }

        try {
            await assetManager.deleteAsset(formData.imageUrl)
            setFormData((current) => ({ ...current, imageUrl: '' }))
            setImageError(false)
        } catch (error) {
            console.error('[Services] Error removing image:', error)
        }
    }

    const handleConfirmDeleteService = async () => {
        if (!isEditing || !service || isReadOnly) {
            return
        }

        setIsDeletingService(true)
        try {
            await deleteProduct(service.id)
            navigate('/services')
        } catch (error) {
            console.error('[ServiceForm] Error deleting service:', error)
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error
                    ? error.message
                    : (t('services.messages.deleteError', { defaultValue: 'Failed to delete the service' })),
                variant: 'destructive'
            })
        } finally {
            setIsDeletingService(false)
        }
    }

    const persistService = async ({ navigateAfterSave = true }: { navigateAfterSave?: boolean } = {}) => {
        if (!workspaceId || !canEdit) {
            return false
        }

        setIsSaving(true)

        try {
            const categoryName = formData.categoryId
                ? categories.find((category) => category.id === formData.categoryId)?.name
                : null
            const enteredCost = formData.costPrice.trim() === ''
                ? null
                : Number(formData.costPrice)
            const shouldPersistCost = !isEditing || !hideCosts
            const dataToSave = {
                isService: true,
                name: formData.name.trim(),
                description: formData.description.trim(),
                categoryId: formData.categoryId || null,
                category: categoryName || null,
                price: Number(formData.price) || 0,
                ...(shouldPersistCost ? { costPrice: enteredCost } : {}),
                currency: formData.currency,
                imageUrl: formData.imageUrl.trim() || undefined,
                canBeReturned: formData.canBeReturned,
                returnRules: formData.returnRules.trim() || undefined,
                // Required by the shared local Product type; createProduct
                // deliberately strips these for services.
                sku: '', unit: '', quantity: 0, minStockLevel: 0,
                createdBy: user?.id || null
            }

            if (isEditing && service) {
                if (service.imageUrl && service.imageUrl !== formData.imageUrl) {
                    assetManager.deleteAsset(service.imageUrl).catch((error) =>
                        console.error('[Services] Failed to delete old asset:', error)
                    )
                }

                await updateProduct(service.id, dataToSave)
            } else if (createdServiceIdRef.current) {
                await updateProduct(createdServiceIdRef.current, dataToSave)
            } else {
                // Creation always persists the (possibly null) submitted cost;
                // only a restricted edit is allowed to omit the property.
                const createdService = await createProduct(workspaceId, {
                    ...dataToSave,
                    costPrice: enteredCost
                })
                createdServiceIdRef.current = createdService.id
            }

            initialFormSnapshotRef.current = JSON.stringify(formData)

            if (navigateAfterSave) {
                navigate('/services')
            }

            return true
        } catch (error: any) {
            console.error('Error saving service:', error)
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error ? error.message : t('services.messages.saveError', {
                    defaultValue: 'Failed to save the service'
                }),
                variant: 'destructive'
            })
            return false
        } finally {
            setIsSaving(false)
        }
    }

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        await persistService()
    }

    const title = isEditing
        ? isReadOnly
            ? (t('common.view') || 'View Service')
            : (t('common.edit') || 'Edit Service')
        : (t('services.addService') || 'Add Service')

    const subtitle = isReadOnly
        ? (t('services.readOnlyNotice') || 'Viewing this service in read-only mode.')
        : isEditing
            ? (t('services.editSubtitle') || 'Update service details, pricing, and return rules.')
            : (t('services.createSubtitle') || 'Services have no SKU, unit, stock, or physical storage.')

    const statusLabel = isEditing
        ? isReadOnly
            ? (t('common.view') || 'View')
            : (t('common.edit') || 'Edit')
        : (t('common.create') || 'Create')

    const effectivePrice = Number(formData.price) || 0
    const effectiveCost = formData.costPrice.trim() === ''
        ? null
        : Number(formData.costPrice)
    const pricePreview = formatCurrency(effectivePrice, formData.currency, features.iqd_display_preference)
    const costPreview = effectiveCost == null ? null : formatCurrency(effectiveCost, formData.currency, features.iqd_display_preference)
    const marginValue = effectiveCost == null ? null : effectivePrice - effectiveCost
    const marginPreview = marginValue == null ? null : formatCurrency(marginValue, formData.currency, features.iqd_display_preference)
    const selectedCategoryLabel = formData.categoryId
        ? categories.find((category) => category.id === formData.categoryId)?.name || (t('categories.noCategory') || 'No category')
        : (t('categories.noCategory') || 'No category')
    const returnRulesPreview = formData.returnRules.trim() || (t('services.form.noReturnRules') || 'No custom return guidance yet.')

    if (mode !== 'create' && !service) {
        return (
            <div className="mx-auto max-w-5xl space-y-6">
                <Button variant="ghost" className="w-fit gap-2 px-0" allowViewer={true} onClick={() => navigate('/services')}>
                    <ArrowLeft className="h-4 w-4" />
                    {t('services.backToList') || 'Back to Services'}
                </Button>
                <Card className="border-border/60 shadow-sm">
                    <CardContent className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-center">
                        <BriefcaseBusiness className="h-10 w-10 text-muted-foreground/50" />
                        <h1 className="text-xl font-bold">
                            {missingServiceStateVisible
                                ? (t('services.notFoundTitle') || 'Service not found')
                                : (t('common.loading') || 'Loading...')}
                        </h1>
                        <p className="max-w-md text-sm text-muted-foreground">
                            {missingServiceStateVisible
                                ? (t('services.notFoundDescription') || 'This service could not be found. It may have been deleted or is no longer available.')
                                : (t('services.loadingDescription') || 'Fetching the service details for this page.')}
                        </p>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="mx-auto w-full max-w-[1600px] space-y-3 pb-8">
            <header className="flex flex-col gap-3 border-b border-border/60 px-1 pb-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2 sm:gap-4">
                    <Button variant="ghost" className="h-10 shrink-0 gap-2 px-2 sm:px-3" allowViewer={true} onClick={goToServices}>
                        <ArrowLeft className="h-4 w-4" />
                        <span className="hidden sm:inline">{t('common.back') || 'Back'}</span>
                    </Button>
                    <div className="hidden h-6 w-px bg-border sm:block" />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="truncate text-xl font-black tracking-tight text-foreground sm:text-2xl">{title}</h1>
                            <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-[0.14em] text-primary">
                                {statusLabel}
                            </span>
                        </div>
                        <p className="hidden text-sm text-muted-foreground lg:block">{subtitle}</p>
                    </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                    {isEditing && !isReadOnly && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setDeleteServiceOpen(true)}
                            className="h-10 gap-2 border-destructive/30 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive sm:px-4"
                        >
                            <Trash2 className="h-4 w-4" />
                            <span className="hidden sm:inline">{t('services.confirmDelete', { defaultValue: 'Delete Service' })}</span>
                        </Button>
                    )}
                    {!isReadOnly && (
                        <Button
                            type="submit"
                            form="service-form-page"
                            disabled={isSaving}
                            className="h-10 gap-2 px-4 font-bold"
                        >
                            <Save className="h-4 w-4" />
                            {isSaving
                                ? (t('common.loading') || 'Loading...')
                                : isEditing
                                    ? (t('common.save') || 'Save')
                                    : (t('common.create') || 'Create')}
                        </Button>
                    )}
                </div>
            </header>

            <section className="grid gap-5 rounded-2xl border border-border/60 bg-card p-4 shadow-sm sm:p-5 md:grid-cols-[190px_minmax(0,1fr)]">
                <button
                    type="button"
                    onClick={() => setVisualsModalOpen(true)}
                    className="group relative mx-auto aspect-square w-full max-w-[190px] overflow-hidden rounded-xl border border-border/60 bg-muted/30 text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label={t('services.form.visuals') || 'Visuals'}
                >
                    {!formData.imageUrl ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-primary">
                            <ImagePlus className="h-8 w-8" />
                            <span className="text-[10px] font-black uppercase tracking-[0.12em]">{t('services.form.noImage') || 'Add image'}</span>
                        </div>
                    ) : imageError ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-destructive">
                            <BriefcaseBusiness className="h-8 w-8" />
                            <span className="text-[10px] font-black uppercase tracking-[0.12em]">{t('services.form.imageError') || 'Image Error'}</span>
                        </div>
                    ) : (
                        <img
                            src={getDisplayImageUrl(formData.imageUrl)}
                            alt={formData.name || 'Service preview'}
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                            onError={() => setImageError(true)}
                        />
                    )}
                    <span className="absolute inset-x-2 bottom-2 rounded-lg bg-background/90 px-2 py-1.5 text-center text-xs font-bold text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                        {t('services.form.visuals') || 'Change image'}
                    </span>
                </button>

                <div className="min-w-0 self-center">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="truncate text-2xl font-black tracking-tight text-foreground">{formData.name || (t('services.form.name') || 'Service name')}</h2>
                                <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[11px] font-bold text-primary">{selectedCategoryLabel}</span>
                            </div>
                            <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">
                                {formData.description || (t('services.form.serviceDetailsDesc') || 'Add the service details, price, and image.')}
                            </p>
                        </div>
                        {isServiceDirty && !isReadOnly && (
                            <span className="w-fit shrink-0 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-amber-700">
                                {t('common.unsavedChanges.title') || 'Unsaved Changes'}
                            </span>
                        )}
                    </div>
                    <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                        <div><dt className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{t('products.table.category')}</dt><dd className="mt-0.5 font-semibold text-foreground">{selectedCategoryLabel}</dd></div>
                        <div><dt className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{t('products.table.price')}</dt><dd className="mt-0.5 font-semibold text-foreground">{pricePreview}</dd></div>
                        <div><dt className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{t('products.form.canBeReturned') || 'Can be Returned'}</dt><dd className="mt-0.5 font-semibold text-foreground">{formData.canBeReturned ? (t('common.yes') || 'Yes') : (t('common.no') || 'No')}</dd></div>
                    </dl>
                </div>
            </section>

            {isReadOnly && (
                <div className="flex items-center gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800">
                    <Info className="h-5 w-5" />
                    {t('services.readOnlyNotice') || 'Viewing this service in read-only mode.'}
                </div>
            )}

            <form id="service-form-page" onSubmit={handleSubmit} className="space-y-4">
                <div className="min-w-0 space-y-4">
                    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm">
                        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-primary/5 via-transparent to-transparent px-5 py-3 sm:px-6">
                            <CardTitle className="text-lg font-black tracking-tight">
                                {t('services.form.serviceDetailsTitle') || 'Service Details'}
                            </CardTitle>
                            <p className="sr-only">
                                {t('services.form.serviceDetailsDesc') || 'Capture the core identity, description, and category for this service.'}
                            </p>
                        </CardHeader>
                        <CardContent className="grid gap-x-8 gap-y-4 p-5 sm:p-6 md:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="service-name" className="flex items-center gap-2 font-bold">
                                    <Type className="h-4 w-4 text-primary/60" />
                                    {t('products.table.name')}
                                </Label>
                                <Input
                                    id="service-name"
                                    value={formData.name}
                                    onChange={(event) => setFormData((current) => ({ ...current, name: event.target.value }))}
                                    placeholder={t('services.form.name') || 'Service name'}
                                    readOnly={isReadOnly}
                                    required
                                    className="h-12 rounded-xl border-border/80 bg-background/80 font-bold shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="service-category" className="flex items-center gap-2 font-bold">
                                    <Tag className="h-4 w-4 text-primary/60" />
                                    {t('products.table.category')}
                                </Label>
                                <Select
                                    value={formData.categoryId || 'none'}
                                    onValueChange={(value) => setFormData((current) => ({ ...current, categoryId: value === 'none' ? undefined : value }))}
                                    disabled={isReadOnly}
                                >
                                    <SelectTrigger id="service-category" className="h-12 rounded-xl border-border/80 bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50" allowViewer={true}>
                                        <SelectValue placeholder={t('categories.noCategory')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="none">{t('categories.noCategory')}</SelectItem>
                                        {categories.map((category) => (
                                            <SelectItem key={category.id} value={category.id}>
                                                {category.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <Label htmlFor="service-description" className="flex items-center gap-2 font-bold">
                                    <FileText className="h-4 w-4 text-primary/60" />
                                    {t('products.form.description')}
                                </Label>
                                <Textarea
                                    id="service-description"
                                    value={formData.description}
                                    onChange={(event) => setFormData((current) => ({ ...current, description: event.target.value }))}
                                    placeholder={t('services.form.description') || 'Service description...'}
                                    rows={3}
                                    readOnly={isReadOnly}
                                    className="min-h-[76px] rounded-xl border-border/80 bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                />
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm">
                        <CardHeader className="border-b border-border/50 bg-gradient-to-r from-primary/5 via-transparent to-transparent">
                            <CardTitle className="text-2xl font-black">
                                {t('products.form.pricing') || 'Pricing'}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('services.form.pricingDesc') || 'Set the selling price, cost basis, and active currency for this service.'}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-6 p-6 sm:p-8">
                            <div className="grid gap-6 md:grid-cols-3">
                                <div className="space-y-2">
                                    <Label htmlFor="service-price" className="flex items-center gap-2 font-bold">
                                        <DollarSign className="h-4 w-4 text-primary/60" />
                                        {t('products.form.price')}
                                    </Label>
                                    <div className="relative">
                                        <Input
                                            id="service-price"
                                            type="text"
                                            inputMode="decimal"
                                            value={formatNumericInput(formData.price)}
                                            onChange={(event) => setFormData((current) => {
                                                const raw = sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 })
                                                return { ...current, price: raw }
                                            })}
                                            placeholder="0.000"
                                            readOnly={isReadOnly}
                                            required
                                            className="h-12 rounded-xl border-border/80 bg-background/80 pr-16 text-lg font-black text-primary shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                        />
                                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">
                                            {getCurrencySymbol(formData.currency, features.iqd_display_preference)}
                                        </span>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <CurrencySelector
                                        label={t('products.form.currency') || 'Currency'}
                                        value={formData.currency}
                                        onChange={(value) => setFormData((current) => ({ ...current, currency: value }))}
                                        iqdDisplayPreference={features.iqd_display_preference}
                                        disabled={isReadOnly}
                                    />
                                </div>
                                {!hideCosts && (
                                    <div className="space-y-2">
                                        <Label htmlFor="service-cost-price" className="flex items-center gap-2 font-bold">
                                            <Wallet className="h-4 w-4 text-primary/60" />
                                            {t('products.form.cost')}
                                        </Label>
                                        <div className="relative">
                                            <Input
                                                id="service-cost-price"
                                                type="text"
                                                inputMode="decimal"
                                                value={formatNumericInput(formData.costPrice)}
                                                onChange={(event) => setFormData((current) => {
                                                    const raw = sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 })
                                                    return {
                                                        ...current,
                                                        costPrice: raw
                                                    }
                                                })}
                                                placeholder="0.000"
                                                readOnly={isReadOnly}
                                                className="h-12 rounded-xl border-border/80 bg-background/80 pr-16 font-bold shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                            />
                                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">
                                                {getCurrencySymbol(formData.currency, features.iqd_display_preference)}
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className={cn('grid gap-3', hideCosts ? 'sm:grid-cols-1' : 'sm:grid-cols-3')}>
                                <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                    <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.table.price')}</div>
                                    <div className="mt-1 text-base font-black text-primary">{pricePreview}</div>
                                </div>
                                {!hideCosts && (
                                    <>
                                        <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                            <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.form.cost')}</div>
                                            <div className="mt-1 text-base font-black text-foreground">{costPreview ?? '—'}</div>
                                        </div>
                                        <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                            <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.form.margin') || 'Margin'}</div>
                                            <div className={cn('mt-1 text-base font-black', marginValue != null && marginValue < 0 ? 'text-destructive' : 'text-emerald-600')}>
                                                {marginPreview ?? '—'}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm">
                        <CardHeader className="border-b border-border/50 bg-muted/10">
                            <CardTitle className="text-2xl font-black">
                                {t('services.form.returnsTitle') || 'Returns'}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('services.form.returnsDesc') || 'Define whether this service can be returned and any return conditions.'}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-6 p-6 sm:p-8">
                            <div className="flex items-start gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-sm font-medium text-sky-700">
                                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                                {t('services.form.noInventoryNotice') || 'Services don\'t track stock, units, or storage. This form only manages pricing and return behavior.'}
                            </div>

                            <div className="rounded-2xl border border-border/60 bg-muted/30 p-5">
                                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                    <div className="space-y-1 text-start">
                                        <Label htmlFor="service-can-be-returned" className="flex cursor-pointer items-center gap-2 text-base font-black text-foreground/90">
                                            <div className={cn(
                                                'flex h-8 w-8 items-center justify-center rounded-xl shadow-sm transition-colors',
                                                formData.canBeReturned ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                                            )}>
                                                <ChevronRight className={cn('h-4 w-4 transition-transform', formData.canBeReturned && 'rotate-90')} />
                                            </div>
                                            {t('products.form.canBeReturned') || 'Can be Returned'}
                                        </Label>
                                        <p className="pl-10 text-sm font-medium leading-relaxed text-muted-foreground/80">
                                            {formData.canBeReturned
                                                ? (t('services.form.canBeReturnedDesc') || 'Customers can return this service.')
                                                : (t('services.form.cannotBeReturnedDesc') || 'This service is non-returnable.')}
                                        </p>
                                    </div>
                                    <div className="flex items-center">
                                        <Switch
                                            id="service-can-be-returned"
                                            checked={formData.canBeReturned}
                                            onCheckedChange={(checked) => setFormData((current) => ({ ...current, canBeReturned: checked }))}
                                            disabled={isReadOnly}
                                            className="data-[state=checked]:bg-emerald-500"
                                        />
                                    </div>
                                </div>

                                {formData.canBeReturned && (
                                    <div className="mt-5 rounded-2xl border border-border/50 bg-background/80 p-4">
                                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="space-y-1">
                                                <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                                                    {t('products.form.returnRulesTitle') || 'Return Rules'}
                                                </div>
                                                <p className="text-sm leading-6 text-muted-foreground">
                                                    {returnRulesPreview}
                                                </p>
                                            </div>
                                            {!isReadOnly && (
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => setReturnRulesModalOpen(true)}
                                                    className="h-10 gap-2 rounded-xl border border-primary/10 px-5 font-bold"
                                                >
                                                    <Settings className="h-4 w-4" />
                                                    {formData.returnRules.trim()
                                                        ? (t('products.form.editRules') || 'Edit rules')
                                                        : (t('products.form.addRules') || 'Add rules')}
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    <Dialog open={visualsModalOpen} onOpenChange={setVisualsModalOpen}>
                        <DialogContent
                            className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto rounded-2xl border-border/60 p-0 sm:w-[calc(100vw-2rem)]"
                            onPaste={handleVisualsPaste}
                        >
                            <DialogHeader className="border-b border-border/50 bg-muted/10 px-5 py-4 sm:px-6">
                                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                                    <div>
                                        <DialogTitle className="text-2xl font-black">
                                            {t('services.form.visuals') || 'Visuals'}
                                        </DialogTitle>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                            {t('services.form.visualsDesc') || 'Upload or link a service image and keep the preview synced with the current record.'}
                                        </p>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => setAdditionalImagesModalOpen(true)}
                                        disabled={!persistedServiceId}
                                        title={!persistedServiceId ? t('services.form.additionalImagesDisabled') : undefined}
                                        className="h-10 shrink-0 gap-2 rounded-xl border-primary/20 font-bold"
                                    >
                                        <Images className="h-4 w-4" />
                                        {t('services.form.additionalImages')}
                                    </Button>
                                </div>
                            </DialogHeader>
                            <div className="space-y-6 p-5 sm:p-6">
                                <div className="space-y-4">
                                    <div className="flex flex-col items-start gap-6 md:flex-row">
                                        <div className="relative aspect-square w-full shrink-0 overflow-hidden rounded-xl border-2 border-dashed border-primary/20 bg-muted/30 shadow-inner md:w-44">
                                            {!formData.imageUrl ? (
                                                <div className="flex h-full flex-col items-center justify-center gap-3">
                                                    <ImagePlus className="h-8 w-8 text-primary" />
                                                    <span className="text-[10px] font-black uppercase tracking-tighter text-primary/60">
                                                        {t('services.form.noImagePreview') || 'No Preview'}
                                                    </span>
                                                </div>
                                            ) : imageError ? (
                                                <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center">
                                                    <BriefcaseBusiness className="h-10 w-10 text-destructive/30" />
                                                    <span className="text-[11px] font-bold uppercase text-destructive/60">
                                                        {t('services.form.imageError') || 'Image Error'}
                                                    </span>
                                                </div>
                                            ) : (
                                                <>
                                                    <img
                                                        src={getDisplayImageUrl(formData.imageUrl)}
                                                        alt={formData.name || 'Service preview'}
                                                        className="h-full w-full object-cover"
                                                        onError={() => setImageError(true)}
                                                    />
                                                    {!isReadOnly && (
                                                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity hover:opacity-100">
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="icon"
                                                                aria-label={t('common.delete') || 'Delete'}
                                                                onClick={handleRemoveImage}
                                                                className="h-12 w-12 rounded-full bg-destructive/90 text-white hover:bg-destructive"
                                                            >
                                                                <Trash2 className="h-6 w-6" />
                                                            </Button>
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                        </div>

                                        <div className="w-full flex-1 space-y-4">
                                            <div className="space-y-2">
                                                <Label htmlFor="service-image-url" className="flex items-center gap-2 font-bold">
                                                    <Info className="h-4 w-4 text-primary/60" />
                                                    {t('products.form.imageUrl') || 'Image Source'}
                                                </Label>
                                                <div className="flex flex-col gap-3 sm:flex-row">
                                                    <Input
                                                        id="service-image-url"
                                                        value={formData.imageUrl}
                                                        onChange={(event) => {
                                                            setFormData((current) => ({ ...current, imageUrl: event.target.value }))
                                                            setImageError(false)
                                                        }}
                                                        placeholder={t('products.form.imageUrlPlaceholder') || 'Image URL or local path'}
                                                        readOnly={isReadOnly}
                                                        className="h-12 flex-1 rounded-xl border-border/80 bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                    />
                                                    {!isReadOnly && (
                                                        <div className="flex gap-2">
                                                            <Button
                                                                type="button"
                                                                variant="outline"
                                                                onClick={handleImageUpload}
                                                                className="h-12 gap-2 rounded-lg border-primary/20 px-6 font-bold"
                                                            >
                                                                <ImagePlus className="h-4 w-4" />
                                                                {t('products.form.upload') || 'Upload'}
                                                            </Button>
                                                            <Button
                                                                type="button"
                                                                variant="outline"
                                                                aria-label={t('products.form.camera') || 'Camera'}
                                                                onClick={() => cameraInputRef.current?.click()}
                                                                className="h-12 gap-2 rounded-lg border-primary/20 px-4 font-bold text-primary sm:px-6"
                                                            >
                                                                <Camera className="h-4 w-4" />
                                                                <span className="hidden sm:inline">{t('products.form.camera') || 'Camera'}</span>
                                                            </Button>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex items-start gap-3 rounded-xl border border-border/40 bg-muted/30 p-4">
                                                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                                <div className="space-y-1 text-[11px] font-medium leading-relaxed text-muted-foreground/80">
                                                    <p>
                                                        {isDesktopShell
                                                            ? (t('products.form.localPathDesc') || 'Image will be stored locally on this device and synced to other devices in your workspace.')
                                                            : (t('products.form.webUploadDesc') || 'Image will be securely uploaded and synced via cloud storage.')}
                                                    </p>
                                                    {!isReadOnly && <p>{t('services.form.pasteImageHint')}</p>}
                                                </div>
                                            </div>

                                            <input
                                                ref={cameraInputRef}
                                                type="file"
                                                className="hidden"
                                                accept="image/*"
                                                capture="environment"
                                                onChange={handleCameraCapture}
                                            />
                                            <input
                                                ref={imageUploadInputRef}
                                                type="file"
                                                className="hidden"
                                                accept="image/*"
                                                onChange={handleImageFileInputChange}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </DialogContent>
                    </Dialog>
                </div>
            </form>

            <ProductAdditionalImagesModal
                open={additionalImagesModalOpen}
                onOpenChange={setAdditionalImagesModalOpen}
                workspaceId={workspaceId}
                productId={persistedServiceId}
                productName={formData.name}
                primaryImageUrl={formData.imageUrl}
                canManage={!isReadOnly && canEdit}
            />

            <Dialog open={returnRulesModalOpen} onOpenChange={setReturnRulesModalOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Settings className="h-5 w-5 text-primary" />
                            {t('products.form.returnRulesTitle') || 'Return Rules'}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label htmlFor="service-return-rules">
                                    {t('products.form.rulesLabel') || 'Specify return conditions'}
                                </Label>
                                <span className={cn(
                                    'text-[10px] font-mono',
                                    formData.returnRules.length >= 225 ? 'font-bold text-destructive' : 'text-muted-foreground'
                                )}>
                                    {formData.returnRules.length}/250
                                </span>
                            </div>
                            <Textarea
                                id="service-return-rules"
                                value={formData.returnRules}
                                onChange={(event) => setFormData((current) => ({
                                    ...current,
                                    returnRules: event.target.value.slice(0, 250)
                                }))}
                                placeholder={t('products.form.rulesPlaceholder') || 'e.g. Must be pre-paid, Only within 7 days...'}
                                rows={6}
                                maxLength={250}
                                readOnly={isReadOnly}
                                className="resize-none"
                            />
                        </div>
                        <p className="text-xs italic text-muted-foreground">
                            {t('products.form.rulesHint') || 'These rules will be shown to staff during the return process.'}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button type="button" onClick={() => setReturnRulesModalOpen(false)}>
                            {t('common.done') || 'Done'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={deleteServiceOpen}
                onClose={() => {
                    if (!isDeletingService) {
                        setDeleteServiceOpen(false)
                    }
                }}
                onConfirm={() => {
                    void handleConfirmDeleteService()
                }}
                isLoading={isDeletingService}
                title={t('services.confirmDelete', { defaultValue: 'Delete Service' })}
                description={t('services.deleteDescription', { defaultValue: 'This will remove the service from your catalog. Existing sale history is kept.' })}
                itemName={service?.name || formData.name}
            />

            {!isReadOnly && (
                <Dialog open={showGuard} onOpenChange={(open) => { if (!open) cancelNavigation() }}>
                    <DialogContent className="max-w-md rounded-3xl">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <Info className="h-5 w-5 text-amber-500" />
                                {t('common.unsavedChanges.title') || 'Unsaved Changes'}
                            </DialogTitle>
                        </DialogHeader>
                        <p className="text-sm text-muted-foreground">
                            {t('common.unsavedChanges.message') || 'You have unsaved changes. Would you like to save your work before leaving?'}
                        </p>
                        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => confirmNavigation(navigate)}>
                                {t('common.unsavedChanges.discard') || 'Discard Changes'}
                            </Button>
                            <div className="flex gap-2">
                                <Button variant="secondary" onClick={() => cancelNavigation()}>
                                    {t('common.unsavedChanges.continue') || 'Continue Editing'}
                                </Button>
                                <Button
                                    disabled={isSaving}
                                    onClick={async () => {
                                        const didSave = await persistService({ navigateAfterSave: false })
                                        if (didSave) {
                                            confirmNavigation(navigate)
                                        }
                                    }}
                                >
                                    {isSaving ? (t('common.loading') || 'Loading...') : (t('common.unsavedChanges.save') || 'Save Changes')}
                                </Button>
                            </div>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    )
}

export function ServiceFormPage() {
    const [, params] = useRoute('/services/:serviceId')
    const serviceId = params?.serviceId || ''
    const editing = Boolean(serviceId && serviceId !== 'new')
    return <ServiceEditor mode={editing ? 'edit' : 'create'} serviceId={editing ? serviceId : undefined} />
}

export function ServiceCreatePage() {
    return <ServiceEditor mode="create" />
}

export function ServiceEditPage() {
    const [, params] = useRoute('/services/:serviceId')
    return <ServiceEditor mode="edit" serviceId={params?.serviceId} />
}
