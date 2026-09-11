import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useLocation } from 'wouter'
import { Activity, CheckCircle2, ClipboardList, Edit3, ImagePlus, Infinity as InfinityIcon, Loader2, Plus, Printer, Receipt, RotateCcw, Search, Trash2, XCircle } from 'lucide-react'

import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useWorkspacePermissions } from '@/permissions'
import { UiAccessGate } from '@/context/UiAccessContext'
import { useDateRange } from '@/context/DateRangeContext'
import {
    hardDeleteActivityTransaction,
    reverseActivityTransaction,
    saveActivityCatalogItem,
    setActivityCatalogStatus,
    updateActivityTransaction,
    useActivityCatalog,
    useActivityTransactionLines,
    useActivityTransactions,
    type ActivityCatalogInput,
    type ActivityTransactionInput
} from '@/local-db/activities'
import type { ActivityCatalogItem, ActivityTransaction, ActivityTransactionLine, IQDDisplayPreference, PaymentAccount, WorkspacePaymentMethod } from '@/local-db/models'
import { usePaymentTransactions } from '@/local-db'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import { ACTIVITY_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { assetManager } from '@/lib/assetManager'
import { isTauri } from '@/lib/platform'
import { formatCurrency } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
import type { TemplatePreview } from '@/lib/printPreviewEditorStore'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { PaymentMethodSelect } from '@/ui/components/payments/PaymentMethodSelect'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { PaymentReversalDialog, type PaymentReversalDialogInput } from '@/ui/components/payments/PaymentReversalDialog'
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    DateTimePicker,
    DeleteConfirmationModal,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    NumericInput,
    PrintPreviewModal,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    Textarea,
    useToast
} from '@/ui/components'

type DraftLine = {
    id?: string
    activityId: string
    quantity: string
    unitPrice: string
}

type TransactionDraft = {
    name: string
    customerName: string
    occurredAt: Date
    paymentMethod: WorkspacePaymentMethod
    notes: string
    lines: DraftLine[]
}

type CatalogDraft = {
    id?: string
    name: string
    imageUrl: string
    defaultUnitPrice: string
    isInfinite: boolean
    availableQuantity: string
    isActive: boolean
}

type ActivityReceiptLabels = {
    activityReceipt: string
    priceOverridden: string
    customer: string
    status: string
    statusValue: string
    paymentMethod: string
    activity: string
    quantity: string
    unitPrice: string
    total: string
    madeby: string
}

const PAYMENT_METHODS = ACTIVITY_PAYMENT_METHODS

function createTransactionDraft(transaction?: ActivityTransaction, lines: ActivityTransactionLine[] = []): TransactionDraft {
    return {
        name: transaction?.name || '',
        customerName: transaction?.customerName || '',
        occurredAt: transaction ? new Date(transaction.occurredAt) : new Date(),
        paymentMethod: transaction?.paymentMethod || 'cash',
        notes: transaction?.notes || '',
        lines: lines.map((line) => ({
            id: line.id,
            activityId: line.activityId,
            quantity: String(line.quantity),
            unitPrice: String(line.unitPrice)
        }))
    }
}

function createCatalogDraft(item?: ActivityCatalogItem): CatalogDraft {
    return {
        id: item?.id,
        name: item?.name || '',
        imageUrl: item?.imageUrl || '',
        defaultUnitPrice: item ? String(item.defaultUnitPrice) : '',
        isInfinite: item?.isInfinite ?? true,
        availableQuantity: item?.availableQuantity == null ? '' : String(item.availableQuantity),
        isActive: item?.isActive ?? true
    }
}

function statusVariant(status: ActivityTransaction['status']) {
    if (status === 'completed') return 'default'
    if (status === 'refunded') return 'secondary'
    return 'outline'
}

function statusLabel(status: ActivityTransaction['status'], t: TFunction) {
    return t(`activities.status.${status}`, { defaultValue: status })
}

function paymentMethodLabel(paymentMethod: WorkspacePaymentMethod, t: TFunction) {
    return t(`activities.paymentMethods.${paymentMethod}`, {
        defaultValue: paymentMethod.replace(/_/g, ' ')
    })
}

function getActivityErrorMessage(error: unknown, t: TFunction) {
    const message = error instanceof Error ? error.message : ''
    const key = message.includes('no longer available')
        ? 'activityUnavailable'
        : message.includes('name is required')
            ? 'nameRequired'
            : message.includes('Available quantity is required')
                ? 'availabilityRequired'
                : message.includes('Add at least one')
                    ? 'lineRequired'
                    : message.includes('quantity greater than zero')
                        ? 'quantityInvalid'
                        : message.includes('valid unit price')
                            ? 'priceInvalid'
                            : message.includes('total must be greater than zero')
                                ? 'totalInvalid'
                                : message.includes('Only completed')
                                    ? 'completedOnly'
                                    : message.includes('has only')
                                        ? 'availabilityInsufficient'
                                        : 'generic'
    return t(`activities.errors.${key}`, {
        defaultValue: t('activities.errors.generic', { defaultValue: 'Please try again.' })
    })
}

function escapeReceiptValue(value: string) {
    return value.replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[character] || character))
}

function resolveWorkspaceLogoSrc(logoUrl?: string | null) {
    if (!logoUrl) return null
    return /^(https?:|data:|blob:)/i.test(logoUrl) ? logoUrl : platformService.convertFileSrc(logoUrl)
}

/** @deprecated Activities now print through PrintPreviewModal and /print-preview-editor. */
export function printActivityReceipt(
    transaction: ActivityTransaction,
    lines: ActivityTransactionLine[],
    workspaceName: string,
    logoUrl: string | null,
    iqdDisplayPreference: IQDDisplayPreference,
    labels: ActivityReceiptLabels,
    locale: string
) {
    const receiptWindow = window.open('', '_blank', 'popup,width=420,height=720')
    if (!receiptWindow) return

    const money = (value: number) => escapeReceiptValue(formatCurrency(value, transaction.currency, iqdDisplayPreference))
    const rows = lines.map((line) => `
      <tr>
        <td><strong>${escapeReceiptValue(line.activityNameSnapshot)}</strong>${line.priceOverridden ? `<div class="override">${escapeReceiptValue(labels.priceOverridden)}</div>` : ''}</td>
        <td>${escapeReceiptValue(String(line.quantity))}</td>
        <td>${money(line.unitPrice)}</td>
        <td>${money(line.lineTotal)}</td>
      </tr>`).join('')
    const resolvedLogoUrl = resolveWorkspaceLogoSrc(logoUrl)
    const logo = resolvedLogoUrl ? `<img src="${escapeReceiptValue(resolvedLogoUrl)}" alt="" />` : ''

    receiptWindow.document.write(`<!doctype html><html><head><title>${escapeReceiptValue(transaction.transactionNo)}</title><style>
      @page { margin: 12mm; } body { font-family: Inter, Arial, sans-serif; color:#111; max-width: 360px; margin:0 auto; } header{text-align:center;border-bottom:1px dashed #777;padding-bottom:12px} img{max-width:64px;max-height:64px;object-fit:contain} h1{font-size:18px;margin:6px 0 2px} p{font-size:12px;margin:4px 0;color:#444}.number{font-weight:700;font-size:13px} table{width:100%;border-collapse:collapse;margin-top:14px;font-size:12px} th{text-align:left;color:#555;border-bottom:1px solid #bbb;padding:6px 2px} td{padding:7px 2px;border-bottom:1px solid #eee;vertical-align:top}td:nth-child(n+2),th:nth-child(n+2){text-align:right}.override{font-size:10px;color:#9a6700;margin-top:2px}.total{display:flex;justify-content:space-between;font-weight:700;font-size:17px;padding-top:13px}.footer{text-align:center;border-top:1px dashed #777;margin-top:16px;padding-top:10px;font-size:11px;color:#555}</style></head><body>
      <header>${logo}<h1>${escapeReceiptValue(workspaceName)}</h1><p>${escapeReceiptValue(labels.activityReceipt)}</p><p class="number">${escapeReceiptValue(transaction.transactionNo)}</p></header>
      <p><strong>${escapeReceiptValue(transaction.name)}</strong></p>
      ${transaction.customerName ? `<p>${escapeReceiptValue(labels.customer)}: ${escapeReceiptValue(transaction.customerName)}</p>` : ''}
      <p>${escapeReceiptValue(labels.status)}: ${escapeReceiptValue(labels.statusValue)}</p>
      <p>${escapeReceiptValue(new Date(transaction.occurredAt).toLocaleString(locale))} · ${escapeReceiptValue(labels.paymentMethod)}</p>
      <table><thead><tr><th>${escapeReceiptValue(labels.activity)}</th><th>${escapeReceiptValue(labels.quantity)}</th><th>${escapeReceiptValue(labels.unitPrice)}</th><th>${escapeReceiptValue(labels.total)}</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="total"><span>${escapeReceiptValue(labels.total)}</span><span>${money(transaction.totalAmount)}</span></div>
      <div class="footer">${escapeReceiptValue(labels.madeby)} · ${escapeReceiptValue(transaction.currency.toUpperCase())}</div>
      <script>window.addEventListener('load', () => window.print())</script></body></html>`)
    receiptWindow.document.close()
}

function createActivityReceiptLabels(transaction: ActivityTransaction, t: TFunction): ActivityReceiptLabels {
    return {
        activityReceipt: t('activities.receiptTitle', { defaultValue: 'Activity receipt' }),
        priceOverridden: t('activities.priceOverridden', { defaultValue: 'Price overridden' }),
        customer: t('activities.customer', { defaultValue: 'Customer' }),
        status: t('activities.statusLabel', { defaultValue: 'Status' }),
        statusValue: statusLabel(transaction.status, t),
        paymentMethod: paymentMethodLabel(transaction.paymentMethod, t),
        activity: t('activities.activity', { defaultValue: 'Activity' }),
        quantity: t('activities.quantity', { defaultValue: 'Qty' }),
        unitPrice: t('activities.unitPrice', { defaultValue: 'Unit price' }),
        total: t('activities.total', { defaultValue: 'Total' }),
        madeby: t('common.madeBy', { defaultValue: 'Made by AtlasERP' })
    }
}

function ActivityReceiptPrintTemplate({
    transaction,
    lines,
    infiniteActivityIds,
    workspaceName,
    logoUrl,
    iqdDisplayPreference,
    labels,
    locale
}: {
    transaction: ActivityTransaction
    lines: ActivityTransactionLine[]
    infiniteActivityIds: ReadonlySet<string>
    workspaceName: string
    logoUrl: string | null
    iqdDisplayPreference: IQDDisplayPreference
    labels: ActivityReceiptLabels
    locale: string
}): ReactElement {
    const isRtl = locale === 'ar' || locale === 'ku'
    const resolvedLogoUrl = resolveWorkspaceLogoSrc(logoUrl)
    const quantity = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value)
    const showQuantityColumn = lines.some((line) => !infiniteActivityIds.has(line.activityId))

    return (
        <article
            dir={isRtl ? 'rtl' : 'ltr'}
            className="bg-white p-4 text-black"
            style={{ fontFamily: 'Inter, Arial, sans-serif', fontSize: '11px', lineHeight: 1.45 }}
        >
            <header className="border-b border-dashed border-slate-400 pb-3 text-center">
                {resolvedLogoUrl ? <img src={resolvedLogoUrl} alt="" className="mx-auto mb-2 h-14 w-14 object-contain" /> : null}
                <h1 className="m-0 text-base font-bold">{workspaceName}</h1>
                <p className="m-0 font-semibold text-black">{labels.activityReceipt}</p>
                <p className="m-0 font-semibold text-black">{transaction.transactionNo}</p>
            </header>

            <section className="space-y-1 border-b border-dashed border-slate-300 py-3">
                <p className="m-0 font-semibold">{transaction.name}</p>
                {transaction.customerName ? <p className="m-0 font-medium text-black">{labels.customer}: {transaction.customerName}</p> : null}
                <p className="m-0 font-medium text-black">{new Date(transaction.occurredAt).toLocaleString(locale)}</p>
                <p className="m-0 font-medium text-black">{labels.status}: {labels.statusValue} · {labels.paymentMethod}</p>
            </section>

            <table className="w-full border-collapse text-[10px]">
                <thead>
                    <tr className="border-b border-slate-300 text-black">
                        <th className="py-2 text-start font-semibold">{labels.activity}</th>
                        {showQuantityColumn ? <th className="py-2 text-end font-semibold">{labels.quantity}</th> : null}
                        <th className="py-2 text-end font-semibold">{labels.unitPrice}</th>
                        <th className="py-2 text-end font-semibold">{labels.total}</th>
                    </tr>
                </thead>
                <tbody>
                    {lines.map((line) => (
                        <tr key={line.id} className="border-b border-slate-200">
                            <td className="py-2 pe-1"><strong>{line.activityNameSnapshot}</strong>{line.priceOverridden ? <div className="mt-0.5 text-[9px] text-amber-700">{labels.priceOverridden}</div> : null}</td>
                            {showQuantityColumn ? <td className="py-2 text-end font-medium">{infiniteActivityIds.has(line.activityId) ? null : quantity(line.quantity)}</td> : null}
                            <td className="py-2 text-end font-medium">{formatCurrency(line.unitPrice, transaction.currency, iqdDisplayPreference)}</td>
                            <td className="py-2 text-end font-semibold">{formatCurrency(line.lineTotal, transaction.currency, iqdDisplayPreference)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <footer className="mt-3 border-t border-dashed border-slate-400 pt-3">
                <div className="flex items-center justify-between text-sm font-bold"><span>{labels.total}</span><span>{formatCurrency(transaction.totalAmount, transaction.currency, iqdDisplayPreference)}</span></div>
                <p className="mb-0 mt-4 text-center text-[10px] font-medium text-black">{labels.madeby}</p>
            </footer>
        </article>
    )
}

export function Activities() {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const [location] = useLocation()
    const { features, workspaceName } = useWorkspace()
    const { hasPermission } = useWorkspacePermissions()
    const { dateRange, customDates } = useDateRange()
    const workspaceId = user?.workspaceId
    const catalog = useActivityCatalog(workspaceId)
    const transactions = useActivityTransactions(workspaceId)
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const selectedTransaction = transactions.find((transaction) => transaction.id === selectedId) || null
    const selectedLines = useActivityTransactionLines(selectedTransaction?.id, workspaceId)
    const [search, setSearch] = useState('')
    const [catalogOpen, setCatalogOpen] = useState(false)
    const [catalogDraft, setCatalogDraft] = useState<CatalogDraft>(() => createCatalogDraft())
    const [catalogImageError, setCatalogImageError] = useState(false)
    const activityImageInputRef = useRef<HTMLInputElement>(null)
    const [transactionOpen, setTransactionOpen] = useState(false)
    const [transactionDraft, setTransactionDraft] = useState<TransactionDraft>(() => createTransactionDraft())
    const [transactionPaymentAccount, setTransactionPaymentAccount] = useState<PaymentAccount | null>(null)
    const [hasTransactionPaymentAccountSelection, setHasTransactionPaymentAccountSelection] = useState(false)
    const [editingTransactionId, setEditingTransactionId] = useState<string | null>(null)
    const [receiptOpen, setReceiptOpen] = useState(false)
    const [activityPrintOpen, setActivityPrintOpen] = useState(false)
    const [reverseAction, setReverseAction] = useState<'cancelled' | 'refunded' | null>(null)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [isSubmitting, setIsSubmitting] = useState(false)

    useEffect(() => {
        const transactionId = new URLSearchParams(location.split('?')[1] || '').get('transaction')
        if (transactionId) setSelectedId(transactionId)
    }, [location])

    const canManageCatalog = hasPermission('activities.manageCatalog')
    const canViewHistory = hasPermission('activities.viewHistory')
    const canPrint = hasPermission('activities.print')
    const canEdit = hasPermission('activities.editTransaction')
    const canRefund = hasPermission('activities.refundTransaction')
    const canDelete = hasPermission('activities.deleteTransaction')
    const paymentTransactions = usePaymentTransactions(workspaceId, { includeReversals: true })
    const selectedOriginalPayment = paymentTransactions.find((payment) =>
        payment.sourceType === 'activity_transaction'
        && payment.sourceRecordId === selectedTransaction?.id
        && !payment.isDeleted
        && !payment.reversalOfTransactionId
    ) || null
    const activeCatalog = catalog.filter((activity) => activity.isActive && !activity.isDeleted && activity.currency === features.default_currency)
    const infiniteActivityIds = useMemo(() => new Set(catalog
        .filter((activity) => activity.isInfinite && !activity.isDeleted)
        .map((activity) => activity.id)), [catalog])
    const workspaceLogoSrc = resolveWorkspaceLogoSrc(features.logo_url)
    const priceFractionDigits = features.default_currency === 'iqd' ? 0 : 2
    const isDesktopShell = isTauri()
    const formatDateTime = (value: string) => new Date(value).toLocaleString(i18n.language)
    const visibleTransactions = useMemo(() => {
        const query = search.trim().toLowerCase()
        return transactions.filter((transaction) => {
            if (!isDateInDateRange(transaction.occurredAt, dateRange, customDates)) return false
            if (!query) return true
            return [transaction.transactionNo, transaction.name, transaction.customerName]
            .some((value) => value?.toLowerCase().includes(query))
        })
    }, [customDates, dateRange, search, transactions])

    const transactionTotal = useMemo(() => transactionDraft.lines.reduce(
        (sum, line) => sum + Math.max(0, Number(line.quantity || 0)) * Math.max(0, Number(line.unitPrice || 0)),
        0
    ), [transactionDraft.lines])

    const activityPrintSelectionOptions = useMemo(() => [{
        format: 'receipt' as const,
        label: t('activities.receiptTitle', { defaultValue: 'Activity receipt' }),
        description: t('activities.receiptDescription', { defaultValue: 'This is the only print format for Activities.' })
    }], [t])

    const buildActivityReceiptPdf = useCallback(async ({ format, printLangOverride }: { format: PrintFormat; effectiveId: string; printLangOverride?: string }) => {
        if (!selectedTransaction) throw new Error('Activity transaction is not available.')
        if (format !== 'receipt') throw new Error('Activities support receipt printing only.')

        const printLanguage = printLangOverride || i18n.language
        return generateTemplatePdf({
            element: <ActivityReceiptPrintTemplate
                transaction={selectedTransaction}
                lines={selectedLines}
                infiniteActivityIds={infiniteActivityIds}
                workspaceName={workspaceName || 'Atlas'}
                logoUrl={features.logo_url}
                iqdDisplayPreference={features.iqd_display_preference}
                labels={createActivityReceiptLabels(selectedTransaction, i18n.getFixedT(printLanguage))}
                locale={printLanguage}
            />,
            format: 'receipt',
            printLang: printLanguage
        })
    }, [features.iqd_display_preference, features.logo_url, i18n, infiniteActivityIds, selectedLines, selectedTransaction, workspaceName])

    const activityReceiptTemplatePreview = useMemo<TemplatePreview | undefined>(() => {
        if (!selectedTransaction) return undefined

        return {
            fields: [],
            page: { widthMm: 80, heightMm: 160 },
            createElement: (_data, _effectiveId, printLangOverride) => {
                const printLanguage = printLangOverride || i18n.language
                return <ActivityReceiptPrintTemplate
                    transaction={selectedTransaction}
                    lines={selectedLines}
                    infiniteActivityIds={infiniteActivityIds}
                    workspaceName={workspaceName || 'Atlas'}
                    logoUrl={features.logo_url}
                    iqdDisplayPreference={features.iqd_display_preference}
                    labels={createActivityReceiptLabels(selectedTransaction, i18n.getFixedT(printLanguage))}
                    locale={printLanguage}
                />
            },
            buildPdf: async (element, printLangOverride) => generateTemplatePdf({
                element,
                format: 'receipt',
                printLang: printLangOverride || i18n.language
            })
        }
    }, [features.iqd_display_preference, features.logo_url, i18n, infiniteActivityIds, selectedLines, selectedTransaction, workspaceName])

    const activityReceiptInvoiceData = useMemo(() => selectedTransaction ? ({
        invoiceid: selectedTransaction.transactionNo,
        totalAmount: selectedTransaction.totalAmount,
        settlementCurrency: selectedTransaction.currency,
        origin: 'activities' as const,
        cashierName: user?.name || 'Unknown',
        createdByName: user?.name || 'Unknown',
        printFormat: 'receipt' as const
    }) : undefined, [selectedTransaction, user?.name])

    const openActivityReceiptPrintFlow = () => {
        if (!selectedTransaction) return
        setReceiptOpen(false)
        setActivityPrintOpen(true)
    }

    const setCatalogImage = (imageUrl: string) => {
        setCatalogDraft((current) => ({ ...current, imageUrl }))
        setCatalogImageError(false)
    }

    const handleCatalogImageUpload = async () => {
        if (!workspaceId) return

        if (isDesktopShell) {
            const targetPath = await platformService.pickAndSaveImage(workspaceId, 'activity-images')
            if (!targetPath) return
            setCatalogImage(targetPath)
            void assetManager.uploadFromPath(targetPath).catch(console.error)
            return
        }

        activityImageInputRef.current?.click()
    }

    const handleCatalogImageFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file || !workspaceId) return

        try {
            if (isDesktopShell) {
                const targetPath = await platformService.saveImageFile(file, workspaceId, 'activity-images')
                if (targetPath) {
                    setCatalogImage(targetPath)
                    void assetManager.uploadFromPath(targetPath).catch(console.error)
                }
                return
            }

            const extension = file.name.split('.').pop() || 'jpg'
            const fileName = `${Date.now()}.${extension}`
            const targetPath = `activity-images/${workspaceId}/${fileName}`
            const r2Path = `${workspaceId}/activity-images/${fileName}`
            const { r2Service } = await import('@/services/r2Service')

            if (!isLocalWorkspaceMode(workspaceId) && r2Service.isConfigured() && await r2Service.upload(r2Path, file)) {
                setCatalogImage(targetPath)
                return
            }

            const reader = new FileReader()
            reader.onloadend = () => setCatalogImage(String(reader.result || ''))
            reader.readAsDataURL(file)
        } catch (error) {
            console.error('[Activities] Failed to attach activity image:', error)
            toast({
                variant: 'destructive',
                title: t('messages.error'),
                description: t('activities.messages.imageUploadFailed', { defaultValue: 'Could not attach activity image.' })
            })
        } finally {
            if (activityImageInputRef.current) activityImageInputRef.current.value = ''
        }
    }

    const openEditTransaction = () => {
        if (!selectedTransaction) return
        setEditingTransactionId(selectedTransaction.id)
        setTransactionDraft(createTransactionDraft(selectedTransaction, selectedLines))
        setTransactionPaymentAccount(null)
        setHasTransactionPaymentAccountSelection(false)
        setTransactionOpen(true)
    }

    const addDraftLine = () => {
        const first = activeCatalog[0]
        if (!first) return
        setTransactionDraft((current) => ({
            ...current,
            lines: [...current.lines, { activityId: first.id, quantity: '1', unitPrice: String(first.defaultUnitPrice) }]
        }))
    }

    const updateDraftLine = (index: number, changes: Partial<DraftLine>) => {
        setTransactionDraft((current) => ({
            ...current,
            lines: current.lines.map((line, lineIndex) => {
                if (lineIndex !== index) return line
                const updated = { ...line, ...changes }
                if (changes.activityId) {
                    const activity = activeCatalog.find((item) => item.id === changes.activityId)
                    if (activity) updated.unitPrice = String(activity.defaultUnitPrice)
                }
                return updated
            })
        }))
    }

    const submitCatalog = async (event: React.FormEvent) => {
        event.preventDefault()
        if (!workspaceId) return
        setIsSubmitting(true)
        try {
            const input: ActivityCatalogInput = {
                name: catalogDraft.name,
                imageUrl: catalogDraft.imageUrl,
                defaultUnitPrice: Number(catalogDraft.defaultUnitPrice || 0),
                currency: features.default_currency,
                isInfinite: catalogDraft.isInfinite,
                availableQuantity: catalogDraft.isInfinite ? null : Number(catalogDraft.availableQuantity || 0),
                isActive: catalogDraft.isActive,
                createdBy: user?.id ?? null
            }
            await saveActivityCatalogItem(workspaceId, input, catalogDraft.id)
            toast({ title: t(catalogDraft.id ? 'activities.messages.activityUpdated' : 'activities.messages.activityCreated', { defaultValue: catalogDraft.id ? 'Activity updated' : 'Activity created' }) })
            setCatalogOpen(false)
        } catch (error) {
            toast({
                variant: 'destructive',
                title: t('activities.messages.saveActivityFailed', { defaultValue: 'Could not save activity' }),
                description: getActivityErrorMessage(error, t)
            })
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleCatalogStatus = async (item: ActivityCatalogItem) => {
        try {
            await setActivityCatalogStatus(item.id, !item.isActive)
            toast({ title: t(item.isActive ? 'activities.messages.activityDeactivated' : 'activities.messages.activityActivated', { defaultValue: item.isActive ? 'Activity deactivated' : 'Activity activated' }) })
        } catch (error) {
            toast({
                variant: 'destructive',
                title: t('activities.messages.updateActivityFailed', { defaultValue: 'Could not update activity' }),
                description: getActivityErrorMessage(error, t)
            })
        }
    }

    const submitTransaction = async (event: React.FormEvent) => {
        event.preventDefault()
        if (!workspaceId || !editingTransactionId) return
        setIsSubmitting(true)
        try {
            const input: ActivityTransactionInput = {
                name: transactionDraft.name,
                customerName: transactionDraft.customerName,
                occurredAt: transactionDraft.occurredAt.toISOString(),
                currency: features.default_currency,
                paymentMethod: transactionDraft.paymentMethod,
                notes: transactionDraft.notes,
                lines: transactionDraft.lines.map((line) => ({
                    id: line.id,
                    activityId: line.activityId,
                    quantity: Number(line.quantity),
                    unitPrice: Number(line.unitPrice)
                })),
                createdBy: user?.id ?? null,
                ...(hasTransactionPaymentAccountSelection
                    ? {
                        accountId: transactionPaymentAccount?.id ?? null,
                        accountNameSnapshot: transactionPaymentAccount?.name ?? null
                    }
                    : {})
            }
            const result = await updateActivityTransaction(workspaceId, editingTransactionId, input)
            setSelectedId(result.transaction.id)
            setTransactionOpen(false)
            toast({ title: t('activities.messages.transactionUpdated', { defaultValue: 'Activity transaction updated' }) })
        } catch (error) {
            toast({
                variant: 'destructive',
                title: t('activities.messages.saveTransactionFailed', { defaultValue: 'Could not save transaction' }),
                description: getActivityErrorMessage(error, t)
            })
        } finally {
            setIsSubmitting(false)
        }
    }

    const requestReversal = (action: 'cancelled' | 'refunded') => {
        if (!selectedOriginalPayment) {
            toast({
                variant: 'destructive',
                title: t('paymentReversal.noPostedPayment', { defaultValue: 'No posted payment was found.' })
            })
            return
        }
        setReverseAction(action)
    }

    const handleReverse = async (input: PaymentReversalDialogInput) => {
        const status = reverseAction
        if (!workspaceId || !selectedTransaction || !status) return
        const action = status === 'cancelled'
            ? t('activities.cancel', { defaultValue: 'Cancel' })
            : t('activities.refund', { defaultValue: 'Refund' })

        setIsSubmitting(true)
        try {
            await reverseActivityTransaction(workspaceId, selectedTransaction.id, status, user?.id ?? null, input)
            setReverseAction(null)
            toast({ title: t(status === 'cancelled' ? 'activities.messages.transactionCancelled' : 'activities.messages.transactionRefunded', { defaultValue: status === 'cancelled' ? 'Transaction cancelled' : 'Transaction refunded' }) })
        } catch (error) {
            toast({
                variant: 'destructive',
                title: t('activities.messages.reverseTransactionFailed', { defaultValue: 'Could not {{action}} transaction', action: action.toLowerCase() }),
                description: getActivityErrorMessage(error, t)
            })
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleHardDelete = async () => {
        if (!workspaceId || !selectedTransaction) return
        setIsSubmitting(true)
        try {
            await hardDeleteActivityTransaction(workspaceId, selectedTransaction.id)
            setSelectedId(null)
            setDeleteOpen(false)
            toast({ title: t('activities.messages.transactionDeleted', { defaultValue: 'Activity transaction permanently deleted' }) })
        } catch (error) {
            toast({
                variant: 'destructive',
                title: t('activities.messages.deleteTransactionFailed', { defaultValue: 'Could not delete transaction' }),
                description: getActivityErrorMessage(error, t)
            })
        } finally {
            setIsSubmitting(false)
        }
    }

    if (!workspaceId) return null

    return (
        <div className="space-y-6 p-4 sm:p-6">
            <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
                <div>
                    <div className="flex items-center gap-2 text-primary">
                        <Activity className="h-5 w-5" />
                        <span className="text-sm font-medium">{t('activities.workspaceModule', { defaultValue: 'Workspace module' })}</span>
                    </div>
                    <h1 className="mt-1 text-3xl font-bold tracking-tight">{t('activities.title', { defaultValue: 'Activities' })}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {t('activities.description', { defaultValue: 'Sell configurable activities with inventory-aware availability and custom receipts.' })} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {canManageCatalog ? (
                        <Button variant="outline" onClick={() => { setCatalogDraft(createCatalogDraft()); setCatalogImageError(false); setCatalogOpen(true) }}>
                            <ClipboardList className="mr-2 h-4 w-4" />
                            {t('activities.catalog', { defaultValue: 'Activity catalog' })}
                        </Button>
                    ) : null}
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <Card><CardHeader className="pb-2"><CardDescription>{t('activities.activeActivities', { defaultValue: 'Active activities' })}</CardDescription><CardTitle>{catalog.filter((item) => item.isActive).length}</CardTitle></CardHeader></Card>
                <Card><CardHeader className="pb-2"><CardDescription>{t('activities.completedToday', { defaultValue: 'Completed today' })}</CardDescription><CardTitle>{transactions.filter((item) => item.status === 'completed' && item.occurredAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length}</CardTitle></CardHeader></Card>
                <Card><CardHeader className="pb-2"><CardDescription>{t('activities.defaultCurrency', { defaultValue: 'Workspace currency' })}</CardDescription><CardTitle className="uppercase">{features.default_currency}</CardTitle></CardHeader></Card>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
                <Card>
                    <CardHeader className="gap-4">
                        <div>
                            <CardTitle>{t('activities.transactionHistory', { defaultValue: 'Transaction history' })}</CardTitle>
                            <CardDescription>{t('activities.transactionHistoryDescription', { defaultValue: 'Every line retains its own price snapshot.' })}</CardDescription>
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <DateRangeFilters />
                            <div className="relative w-full sm:w-64">
                                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('common.search', { defaultValue: 'Search' })} />
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {!canViewHistory ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{t('activities.historyPermissionRequired', { defaultValue: 'You do not have permission to view activity history.' })}</div> : null}
                        {canViewHistory && visibleTransactions.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{t('activities.noTransactions', { defaultValue: 'No activity transactions yet.' })}</div> : null}
                        {canViewHistory && visibleTransactions.map((transaction) => (
                            <button type="button" key={transaction.id} onClick={() => setSelectedId(transaction.id)} className={`flex w-full items-center justify-between gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 ${transaction.id === selectedId ? 'border-primary bg-primary/5' : ''}`}>
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{transaction.name}</span><Badge variant={statusVariant(transaction.status)}>{statusLabel(transaction.status, t)}</Badge></div>
                                    <div className="mt-1 truncate text-xs text-muted-foreground">{transaction.transactionNo} · {transaction.customerName || t('activities.walkIn', { defaultValue: 'Walk-in' })} · {formatDateTime(transaction.occurredAt)}</div>
                                </div>
                                <div className="shrink-0 text-right font-semibold">{formatCurrency(transaction.totalAmount, transaction.currency, features.iqd_display_preference)}</div>
                            </button>
                        ))}
                    </CardContent>
                </Card>

                <Card>
                    {!selectedTransaction ? (
                        <CardContent className="flex min-h-80 flex-col items-center justify-center text-center">
                            <Receipt className="mb-3 h-10 w-10 text-muted-foreground" />
                            <CardTitle>{t('activities.selectTransaction', { defaultValue: 'Select a transaction' })}</CardTitle>
                            <p className="mt-2 max-w-xs text-sm text-muted-foreground">{t('activities.selectTransactionDescription', { defaultValue: 'Open a transaction to see its activity lines, overridden prices, receipt, and lifecycle actions.' })}</p>
                        </CardContent>
                    ) : <>
                        <CardHeader>
                            <div className="flex items-start justify-between gap-3">
                                <div><CardTitle>{selectedTransaction.name}</CardTitle><CardDescription>{selectedTransaction.transactionNo} · {formatDateTime(selectedTransaction.occurredAt)}</CardDescription></div>
                                <Badge variant={statusVariant(selectedTransaction.status)}>{statusLabel(selectedTransaction.status, t)}</Badge>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <div><p className="text-muted-foreground">{t('activities.customer', { defaultValue: 'Customer' })}</p><p className="font-medium">{selectedTransaction.customerName || t('activities.walkIn', { defaultValue: 'Walk-in' })}</p></div>
                                <div><p className="text-muted-foreground">{t('activities.paymentMethod', { defaultValue: 'Payment method' })}</p><p className="font-medium">{paymentMethodLabel(selectedTransaction.paymentMethod, t)}</p></div>
                            </div>
                            <div className="rounded-lg border">
                                <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b px-3 py-2 text-xs font-medium text-muted-foreground"><span>{t('activities.activity', { defaultValue: 'Activity' })}</span><span>{t('activities.quantity', { defaultValue: 'Qty' })}</span><span>{t('activities.total', { defaultValue: 'Total' })}</span></div>
                                {selectedLines.map((line) => (
                                    <div key={line.id} className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-3 text-sm">
                                        <div><p className="font-medium">{line.activityNameSnapshot}</p>{line.priceOverridden ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('activities.priceOverridden', { defaultValue: 'Price overridden' })}: {formatCurrency(line.catalogUnitPriceSnapshot, selectedTransaction.currency, features.iqd_display_preference)} → {formatCurrency(line.unitPrice, selectedTransaction.currency, features.iqd_display_preference)}</p> : null}</div>
                                        <span>{line.quantity}</span>
                                        <span className="font-medium">{formatCurrency(line.lineTotal, selectedTransaction.currency, features.iqd_display_preference)}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex items-center justify-between border-t pt-4"><span className="font-semibold">{t('activities.total', { defaultValue: 'Total' })}</span><span className="text-xl font-bold">{formatCurrency(selectedTransaction.totalAmount, selectedTransaction.currency, features.iqd_display_preference)}</span></div>
                            {selectedTransaction.notes ? <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{selectedTransaction.notes}</p> : null}
                            <div className="flex flex-wrap gap-2 border-t pt-4">
                                {canPrint ? <Button variant="outline" onClick={() => setReceiptOpen(true)}><Printer className="mr-2 h-4 w-4" />{t('common.print', { defaultValue: 'Print receipt' })}</Button> : null}
                                {canEdit && selectedTransaction.status === 'completed' ? <Button variant="outline" onClick={openEditTransaction}><Edit3 className="mr-2 h-4 w-4" />{t('common.edit', { defaultValue: 'Edit' })}</Button> : null}
                                {canRefund && selectedTransaction.status === 'completed' ? <><Button variant="outline" onClick={() => requestReversal('cancelled')}><XCircle className="mr-2 h-4 w-4" />{t('activities.cancel', { defaultValue: 'Cancel' })}</Button><Button variant="outline" onClick={() => requestReversal('refunded')}><RotateCcw className="mr-2 h-4 w-4" />{t('activities.refund', { defaultValue: 'Refund' })}</Button></> : null}
                                {canDelete ? <UiAccessGate><Button variant="destructive" onClick={() => setDeleteOpen(true)}><Trash2 className="mr-2 h-4 w-4" />{t('common.delete', { defaultValue: 'Delete' })}</Button></UiAccessGate> : null}
                            </div>
                        </CardContent>
                    </>}
                </Card>
            </div>

            <Dialog open={catalogOpen} onOpenChange={setCatalogOpen}>
                <DialogContent layout="structured" className="sm:max-w-lg">
                    <form className="flex min-h-0 flex-1 flex-col" onSubmit={submitCatalog}>
                        <DialogHeader layout="structured">
                            <DialogTitle>{catalogDraft.id ? t('activities.editActivity', { defaultValue: 'Edit activity' }) : t('activities.newActivity', { defaultValue: 'New activity' })}</DialogTitle>
                            <DialogDescription>{t('activities.catalogDescription', { defaultValue: 'Set a default price and choose whether availability is unlimited or finite.' })}</DialogDescription>
                        </DialogHeader>
                        <DialogBody>
                            {catalog.length ? <div className="mt-4 space-y-2 rounded-lg border p-3">
                                <div className="flex items-center justify-between"><Label>{t('activities.existingActivities', { defaultValue: 'Existing activities' })}</Label><Button type="button" size="sm" variant="ghost" onClick={() => { setCatalogDraft(createCatalogDraft()); setCatalogImageError(false) }}>{t('activities.newActivity', { defaultValue: 'New activity' })}</Button></div>
                                {catalog.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2 text-sm">
                                    <button type="button" className="min-w-0 text-left" onClick={() => setCatalogDraft(createCatalogDraft(item))}><p className="truncate font-medium">{item.name}</p><p className="text-xs text-muted-foreground">{item.isInfinite ? t('activities.infinite', { defaultValue: 'Infinite' }) : t('activities.availableCount', { defaultValue: '{{count}} available', count: item.availableQuantity ?? 0 })} · {formatCurrency(item.defaultUnitPrice, item.currency, features.iqd_display_preference)}</p></button>
                                    <Button type="button" size="sm" variant="ghost" onClick={() => void handleCatalogStatus(item)}>{item.isActive ? t('activities.deactivate', { defaultValue: 'Deactivate' }) : t('activities.activate', { defaultValue: 'Activate' })}</Button>
                                </div>)}
                            </div> : null}
                            <div className="grid gap-4 py-5">
                                <div className="grid gap-2"><Label htmlFor="activity-name">{t('common.name', { defaultValue: 'Name' })}</Label><Input id="activity-name" value={catalogDraft.name} onChange={(event) => setCatalogDraft((current) => ({ ...current, name: event.target.value }))} autoFocus /></div>
                                <div className="grid gap-2">
                                    <Label htmlFor="activity-image-url">{t('activities.image', { defaultValue: 'Activity photo' })}</Label>
                                    <div className="flex items-start gap-3">
                                        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/40">
                                            {!catalogDraft.imageUrl ? <ImagePlus className="h-6 w-6 text-muted-foreground" /> : catalogImageError ? <ImagePlus className="h-6 w-6 text-destructive" /> : <img src={resolveWorkspaceLogoSrc(catalogDraft.imageUrl) || ''} alt="" className="h-full w-full object-cover" onError={() => setCatalogImageError(true)} />}
                                        </div>
                                        <div className="min-w-0 flex-1 space-y-2">
                                            <div className="flex gap-2">
                                                <Input id="activity-image-url" value={catalogDraft.imageUrl} onChange={(event) => setCatalogImage(event.target.value)} placeholder={t('activities.imageUrlPlaceholder', { defaultValue: 'Image URL or local path' })} />
                                                <Button type="button" variant="outline" onClick={() => void handleCatalogImageUpload()}><ImagePlus className="mr-2 h-4 w-4" />{t('activities.uploadImage', { defaultValue: 'Upload' })}</Button>
                                            </div>
                                            {catalogDraft.imageUrl ? <Button type="button" size="sm" variant="ghost" className="h-auto px-0 text-destructive hover:text-destructive" onClick={() => setCatalogImage('')}><Trash2 className="mr-1 h-3.5 w-3.5" />{t('activities.removeImage', { defaultValue: 'Remove photo' })}</Button> : null}
                                        </div>
                                    </div>
                                    <input ref={activityImageInputRef} type="file" className="hidden" accept="image/*" onChange={(event) => void handleCatalogImageFileSelected(event)} />
                                </div>
                                <div className="grid gap-2"><Label htmlFor="activity-price">{t('activities.defaultPrice', { defaultValue: 'Default unit price' })} ({features.default_currency.toUpperCase()})</Label><NumericInput id="activity-price" inputMode={priceFractionDigits === 0 ? 'numeric' : 'decimal'} min="0" maxFractionDigits={priceFractionDigits} value={catalogDraft.defaultUnitPrice} onValueChange={(value) => setCatalogDraft((current) => ({ ...current, defaultUnitPrice: value }))} /></div>
                                <div className="flex items-center justify-between rounded-lg border p-3"><div><Label htmlFor="activity-infinite" className="flex items-center gap-2"><InfinityIcon className="h-4 w-4" />{t('activities.infiniteAvailability', { defaultValue: 'Infinite availability' })}</Label><p className="mt-1 text-xs text-muted-foreground">{t('activities.infiniteAvailabilityDescription', { defaultValue: 'Unlimited activities never consume availability.' })}</p></div><Switch id="activity-infinite" checked={catalogDraft.isInfinite} onCheckedChange={(value) => setCatalogDraft((current) => ({ ...current, isInfinite: value }))} /></div>
                                {!catalogDraft.isInfinite ? <div className="grid gap-2"><Label htmlFor="activity-quantity">{t('activities.availableQuantity', { defaultValue: 'Available quantity' })}</Label><NumericInput id="activity-quantity" inputMode="decimal" min="0" maxFractionDigits={3} value={catalogDraft.availableQuantity} onValueChange={(value) => setCatalogDraft((current) => ({ ...current, availableQuantity: value }))} /></div> : null}
                                <div className="flex items-center justify-between rounded-lg border p-3"><div><Label htmlFor="activity-active">{t('common.active', { defaultValue: 'Active' })}</Label><p className="mt-1 text-xs text-muted-foreground">{t('activities.activeDescription', { defaultValue: 'Inactive activities stay in history but cannot be selected for new transactions.' })}</p></div><Switch id="activity-active" checked={catalogDraft.isActive} onCheckedChange={(value) => setCatalogDraft((current) => ({ ...current, isActive: value }))} /></div>
                            </div>
                        </DialogBody>
                        <DialogFooter layout="structured"><Button type="button" variant="outline" onClick={() => setCatalogOpen(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button><Button type="submit" disabled={isSubmitting}>{isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t('common.save', { defaultValue: 'Save' })}</Button></DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog open={transactionOpen} onOpenChange={setTransactionOpen}>
                <DialogContent layout="structured" className="sm:max-w-3xl">
                    <form className="flex min-h-0 flex-1 flex-col" onSubmit={submitTransaction}>
                        <DialogHeader layout="structured"><DialogTitle>{t('activities.editTransaction', { defaultValue: 'Edit activity transaction' })}</DialogTitle><DialogDescription>{t('activities.transactionDescription', { defaultValue: 'Activity prices are copied into the transaction and can be overridden per line.' })}</DialogDescription></DialogHeader>
                        <DialogBody>
                            <div className="grid gap-4 py-5">
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="grid gap-2"><Label htmlFor="transaction-name">{t('activities.transactionName', { defaultValue: 'Transaction name' })}</Label><Input id="transaction-name" value={transactionDraft.name} onChange={(event) => setTransactionDraft((current) => ({ ...current, name: event.target.value }))} /></div>
                                    <div className="grid gap-2"><Label htmlFor="transaction-customer">{t('activities.customerName', { defaultValue: 'Customer name (optional)' })}</Label><Input id="transaction-customer" value={transactionDraft.customerName} onChange={(event) => setTransactionDraft((current) => ({ ...current, customerName: event.target.value }))} /></div>
                                    <div className="grid gap-2"><Label>{t('activities.dateTime', { defaultValue: 'Date and time' })}</Label><DateTimePicker date={transactionDraft.occurredAt} setDate={(date) => date && setTransactionDraft((current) => ({ ...current, occurredAt: date }))} /></div>
                                    <div className="grid gap-2"><Label>{t('activities.paymentMethod', { defaultValue: 'Payment method' })}</Label><PaymentMethodSelect value={transactionDraft.paymentMethod} onValueChange={(value) => setTransactionDraft((current) => ({ ...current, paymentMethod: value as WorkspacePaymentMethod }))} onLinkedPaymentAccountSelect={(account) => { setTransactionPaymentAccount(account); setHasTransactionPaymentAccountSelection(true) }} workspaceId={workspaceId} methods={PAYMENT_METHODS} /></div>
                                    <PaymentAccountSelector
                                        workspaceId={workspaceId}
                                        value={transactionPaymentAccount?.id ?? null}
                                        onValueChange={(account) => {
                                            setTransactionPaymentAccount(account)
                                            setHasTransactionPaymentAccountSelection(true)
                                        }}
                                        disabled={isSubmitting}
                                        cashDrawerOnly={transactionDraft.paymentMethod === 'cash'}
                                    />
                                </div>
                                <div className="space-y-3 rounded-lg border p-3">
                                    <div className="flex items-center justify-between"><div><Label>{t('activities.lines', { defaultValue: 'Activity lines' })}</Label><p className="text-xs text-muted-foreground">{t('activities.linesDescription', { defaultValue: 'Add one activity or combine several in the same transaction.' })}</p></div><Button type="button" size="sm" variant="outline" onClick={addDraftLine}><Plus className="mr-1 h-4 w-4" />{t('common.add', { defaultValue: 'Add' })}</Button></div>
                                    {transactionDraft.lines.map((line, index) => {
                                        const selectedActivity = activeCatalog.find((activity) => activity.id === line.activityId)
                                        const overridden = selectedActivity && Number(line.unitPrice || 0) !== selectedActivity.defaultUnitPrice
                                        return <div key={line.id || `${line.activityId}-${index}`} className="grid gap-2 border-t pt-3 sm:grid-cols-[minmax(0,1fr)_88px_120px_auto]">
                                            <Select value={line.activityId} onValueChange={(value) => updateDraftLine(index, { activityId: value })}><SelectTrigger><SelectValue placeholder={t('activities.selectActivity', { defaultValue: 'Select activity' })} /></SelectTrigger><SelectContent>{activeCatalog.map((activity) => <SelectItem key={activity.id} value={activity.id}>{activity.name}{activity.isInfinite ? ' · ∞' : ` · ${t('activities.quantityLeft', { defaultValue: '{{count}} left', count: activity.availableQuantity ?? 0 })}`}</SelectItem>)}</SelectContent></Select>
                                            <NumericInput aria-label={t('activities.quantity', { defaultValue: 'Quantity' })} inputMode="decimal" min="0.001" maxFractionDigits={3} value={line.quantity} onValueChange={(value) => updateDraftLine(index, { quantity: value })} />
                                            <div className="space-y-1"><NumericInput aria-label={t('activities.unitPrice', { defaultValue: 'Unit price' })} inputMode={priceFractionDigits === 0 ? 'numeric' : 'decimal'} min="0" maxFractionDigits={priceFractionDigits} value={line.unitPrice} onValueChange={(value) => updateDraftLine(index, { unitPrice: value })} />{overridden ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('activities.overridden', { defaultValue: 'Overridden' })}</p> : null}</div>
                                            <Button type="button" variant="ghost" size="icon" disabled={transactionDraft.lines.length === 1} onClick={() => setTransactionDraft((current) => ({ ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) }))}><Trash2 className="h-4 w-4" /><span className="sr-only">{t('common.remove', { defaultValue: 'Remove' })}</span></Button>
                                        </div>
                                    })}
                                </div>
                                <div className="grid gap-2"><Label htmlFor="transaction-notes">{t('common.notes', { defaultValue: 'Notes' })}</Label><Textarea id="transaction-notes" value={transactionDraft.notes} onChange={(event) => setTransactionDraft((current) => ({ ...current, notes: event.target.value }))} /></div>
                                <div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3"><span className="font-medium">{t('activities.total', { defaultValue: 'Total' })}</span><span className="text-xl font-bold">{formatCurrency(transactionTotal, features.default_currency, features.iqd_display_preference)}</span></div>
                            </div>
                        </DialogBody>
                        <DialogFooter layout="structured"><Button type="button" variant="outline" onClick={() => setTransactionOpen(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button><Button type="submit" disabled={isSubmitting}>{isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{t('common.save', { defaultValue: 'Save changes' })}</Button></DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog open={receiptOpen} onOpenChange={setReceiptOpen}>
                <DialogContent layout="structured" className="sm:max-w-md">
                    <DialogHeader layout="structured"><DialogTitle>{t('activities.receiptPreview', { defaultValue: 'Activity receipt' })}</DialogTitle><DialogDescription>{t('activities.receiptDescription', { defaultValue: 'This is the only print format for Activities.' })}</DialogDescription></DialogHeader>
                    <DialogBody>
                        {selectedTransaction ? <div className="space-y-3 rounded-lg border p-4 text-sm text-foreground">
                            <div className="text-center">{workspaceLogoSrc ? <img src={workspaceLogoSrc} alt="" className="mx-auto mb-2 h-12 w-12 object-contain" /> : null}<p className="font-semibold">{workspaceName || 'Atlas'}</p><p className="text-xs font-semibold text-foreground">{selectedTransaction.transactionNo}</p></div>
                            <div className="border-y py-3"><p className="font-semibold">{selectedTransaction.name}</p><p className="text-xs font-medium text-foreground">{formatDateTime(selectedTransaction.occurredAt)}</p></div>
                            {selectedLines.map((line) => <div key={line.id} className="flex justify-between gap-3"><span className="font-medium">{line.activityNameSnapshot}{infiniteActivityIds.has(line.activityId) ? null : ` × ${line.quantity}`}</span><span className="font-semibold">{formatCurrency(line.lineTotal, selectedTransaction.currency, features.iqd_display_preference)}</span></div>)}
                            <div className="flex justify-between border-t pt-3 text-base font-bold"><span>{t('activities.total', { defaultValue: 'Total' })}</span><span>{formatCurrency(selectedTransaction.totalAmount, selectedTransaction.currency, features.iqd_display_preference)}</span></div>
                        </div> : null}
                    </DialogBody>
                    <DialogFooter layout="structured"><Button variant="outline" onClick={() => setReceiptOpen(false)}>{t('common.close', { defaultValue: 'Close' })}</Button>{selectedTransaction ? <Button onClick={openActivityReceiptPrintFlow}><Printer className="mr-2 h-4 w-4" />{t('common.print', { defaultValue: 'Print' })}</Button> : null}</DialogFooter>
                </DialogContent>
            </Dialog>

            <PrintPreviewModal
                isOpen={activityPrintOpen}
                onClose={() => setActivityPrintOpen(false)}
                onConfirm={() => setActivityPrintOpen(false)}
                title={t('activities.receiptTitle', { defaultValue: 'Activity receipt' })}
                documentId={selectedTransaction?.id}
                originId={selectedTransaction?.id}
                invoiceData={activityReceiptInvoiceData}
                pdfBuilder={buildActivityReceiptPdf}
                templatePreview={activityReceiptTemplatePreview}
                features={features}
                workspaceName={workspaceName}
                module="activities"
                printSelectionOptions={activityPrintSelectionOptions}
            />

            <PaymentReversalDialog
                open={reverseAction !== null && !!selectedOriginalPayment}
                onOpenChange={(open) => {
                    if (!open && !isSubmitting) setReverseAction(null)
                }}
                onSubmit={handleReverse}
                isProcessing={isSubmitting}
                transaction={selectedOriginalPayment}
                workspaceId={workspaceId}
                iqdPreference={features.iqd_display_preference}
            />

            <DeleteConfirmationModal
                isOpen={deleteOpen}
                onClose={() => !isSubmitting && setDeleteOpen(false)}
                onConfirm={() => void handleHardDelete()}
                isLoading={isSubmitting}
                itemName={selectedTransaction?.transactionNo || ''}
                title={t('activities.deleteTransaction', { defaultValue: 'Permanently delete activity transaction' })}
                description={t('activities.deleteTransactionWarning', { defaultValue: 'This hard-deletes the transaction, its activity lines, and its linked payment records. Finite activity availability is restored.' })}
            />
        </div>
    )
}
