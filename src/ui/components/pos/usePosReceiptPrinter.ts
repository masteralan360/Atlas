import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/ui/components'
import { isSupabaseConfigured, useAuth } from '@/auth'
import { useWorkspace, type WorkspaceFeatures } from '@/workspace'
import { disableInvoiceQrInLocalMode } from '@/services/localInvoiceStorage'
import { generateInvoicePdf } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { renderPdfPageToPngDataUrl } from '@/services/pdfRasterizer'
import { printService } from '@/services/printService'
import {
    DEFAULT_POS_RECEIPT_PRINT_QUALITY,
    resolvePosReceiptThermalWidth,
    type PosReceiptPrintQuality
} from '@/services/posReceiptPrintQuality'
import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'
import {
    SALES_HISTORY_RECEIPT_TEMPLATE_KEY,
    buildCustomTemplateLayoutPdf,
    getCustomTemplateTarget,
    isCustomTemplatePrintLanguageCompatible,
    readCustomTemplateLayout,
    resolveCustomTemplatePrintLanguage,
    type StoredCustomTemplateRow
} from '@/lib/customTemplates'
import type { UniversalInvoice } from '@/types'

interface UsePosReceiptPrinterOptions {
    saleData: UniversalInvoice | null | undefined
    features: WorkspaceFeatures
    /** Enables loading the primary receipt template while the caller is active. */
    enabled: boolean
    /** Uses a source-specific receipt while retaining the normal POS direct-print flow. */
    receiptPdfBuilder?: (quality?: PosReceiptPrintQuality) => Promise<Blob>
    /** Custom Template target used to resolve the active primary receipt layout. */
    receiptTemplateKey?: string
    /** Prepare a completed-sale receipt in the background before the user requests printing. */
    prewarmPrint?: boolean
    /** Delay preparation until this many milliseconds after receipt data changes. */
    prewarmDelayMs?: number
    /** Quality profile used by Checkout Success receipt printing. */
    receiptQuality?: PosReceiptPrintQuality
}

interface PrintPosReceiptOptions {
    title?: string
    /** Allows callers to share one PDF between receipt sync and printing. */
    pdfBuilder?: () => Promise<Blob>
}

interface PreparedThermalReceipt {
    imageBase64: string
    maxWidth: number
}

interface ReceiptPrintPreparation {
    pdfBuilder: () => Promise<Blob>
    pdfPromise: Promise<Blob>
    thermalImagePromise?: Promise<PreparedThermalReceipt>
}

/**
 * The POS receipt pipeline shared by completed sales and cart pre-prints.
 * It intentionally contains no sale persistence or invoice synchronization.
 */
export function usePosReceiptPrinter({
    saleData,
    features,
    enabled,
    receiptPdfBuilder,
    receiptTemplateKey = SALES_HISTORY_RECEIPT_TEMPLATE_KEY,
    prewarmPrint = false,
    prewarmDelayMs = 0,
    receiptQuality = DEFAULT_POS_RECEIPT_PRINT_QUALITY
}: UsePosReceiptPrinterOptions) {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { workspaceName, activeWorkspace, isLocalMode } = useWorkspace()
    const { toast } = useToast()
    const [primaryReceiptTemplate, setPrimaryReceiptTemplate] = useState<StoredCustomTemplateRow | null>(null)
    const [isLoadingPrimaryReceiptTemplate, setIsLoadingPrimaryReceiptTemplate] = useState(false)
    const [resolvedPrimaryTemplateKey, setResolvedPrimaryTemplateKey] = useState<string | null>(null)
    const [isPreparingReceiptPrint, setIsPreparingReceiptPrint] = useState(false)
    const receiptPrintPreparationRef = useRef<ReceiptPrintPreparation | null>(null)

    const workspaceId = activeWorkspace?.id || user?.workspaceId || ''
    const resolvedWorkspaceName = workspaceName || workspaceId || 'Atlas'
    const printFeatures = useMemo(
        () => disableInvoiceQrInLocalMode(workspaceId, features),
        [features, workspaceId]
    )
    const currentTemplatePrintLanguage = resolveCustomTemplatePrintLanguage(
        printFeatures.print_lang,
        i18n.language
    )
    const shouldLoadPrimaryReceiptTemplate = !receiptPdfBuilder
        && enabled
        && !!workspaceId
        && (isLocalMode || isSupabaseConfigured)
    const primaryTemplateLookupKey = `${receiptTemplateKey}:${workspaceId}:${currentTemplatePrintLanguage}`
    const isPrimaryReceiptTemplateLoading = isLoadingPrimaryReceiptTemplate
        || (shouldLoadPrimaryReceiptTemplate && resolvedPrimaryTemplateKey !== primaryTemplateLookupKey)

    useEffect(() => {
        if (!shouldLoadPrimaryReceiptTemplate) {
            setPrimaryReceiptTemplate(null)
            setIsLoadingPrimaryReceiptTemplate(false)
            setResolvedPrimaryTemplateKey(null)
            return
        }

        let cancelled = false
        setIsLoadingPrimaryReceiptTemplate(true)
        void (async () => {
            try {
                const templates = await fetchCachedCustomTemplates(workspaceId, {
                    moduleTypeKey: receiptTemplateKey,
                    activeOnly: true,
                    primaryOnly: true,
                })
                const primaryTemplate = templates.find((template) =>
                    isCustomTemplatePrintLanguageCompatible(
                        template as StoredCustomTemplateRow,
                        currentTemplatePrintLanguage,
                    )
                ) || null
                if (!cancelled) setPrimaryReceiptTemplate(primaryTemplate as StoredCustomTemplateRow | null)
            } catch (templateError) {
                console.error('[usePosReceiptPrinter] Failed to load primary receipt template:', templateError)
                if (!cancelled) setPrimaryReceiptTemplate(null)
            } finally {
                if (!cancelled) {
                    setIsLoadingPrimaryReceiptTemplate(false)
                    setResolvedPrimaryTemplateKey(primaryTemplateLookupKey)
                }
            }
        })()

        return () => {
            cancelled = true
        }
    }, [currentTemplatePrintLanguage, primaryTemplateLookupKey, receiptTemplateKey, shouldLoadPrimaryReceiptTemplate, workspaceId])

    const primaryReceiptTarget = useMemo(
        () => getCustomTemplateTarget(receiptTemplateKey),
        [receiptTemplateKey]
    )
    const primaryReceiptLayout = useMemo(
        () => primaryReceiptTemplate
            && isCustomTemplatePrintLanguageCompatible(primaryReceiptTemplate, currentTemplatePrintLanguage)
            ? readCustomTemplateLayout(primaryReceiptTemplate)
            : null,
        [currentTemplatePrintLanguage, primaryReceiptTemplate]
    )

    const buildReceiptPdf = useCallback(async () => {
        if (receiptPdfBuilder) {
            return receiptPdfBuilder(receiptQuality)
        }

        if (!saleData) {
            throw new Error('Receipt data is not available.')
        }

        if (primaryReceiptTarget && primaryReceiptLayout) {
            return buildCustomTemplateLayoutPdf({
                target: primaryReceiptTarget,
                layout: primaryReceiptLayout,
                values: {},
                options: {
                    workspaceId,
                    workspaceName,
                    features: printFeatures,
                    receiptData: saleData
                },
                effectiveId: saleData.id,
                receiptQuality
            })
        }

        return generateInvoicePdf({
            data: { ...saleData },
            format: 'receipt',
            features: printFeatures,
            workspaceName: resolvedWorkspaceName,
            workspaceId,
            receiptQuality
        })
    }, [primaryReceiptLayout, primaryReceiptTarget, printFeatures, receiptPdfBuilder, receiptQuality, resolvedWorkspaceName, saleData, workspaceId, workspaceName])

    const getReceiptPrintPreparation = useCallback((pdfBuilder = buildReceiptPdf) => {
        const current = receiptPrintPreparationRef.current
        if (current?.pdfBuilder === pdfBuilder) return current

        const pdfPromise = Promise.resolve().then(pdfBuilder)
        const thermalImagePromise = features.thermal_printing
            ? (async () => {
                const [maxWidth, receiptPdf] = await Promise.all([
                    printService.getThermalPrinterMaxWidth(workspaceId),
                    pdfPromise
                ])
                const qualityWidth = resolvePosReceiptThermalWidth(maxWidth, receiptQuality)
                const imageBase64 = await renderPdfPageToPngDataUrl(receiptPdf, { maxWidthPx: qualityWidth })
                return { imageBase64, maxWidth: qualityWidth }
            })()
            : undefined

        const preparation: ReceiptPrintPreparation = {
            pdfBuilder,
            pdfPromise,
            thermalImagePromise
        }
        receiptPrintPreparationRef.current = preparation
        void pdfPromise.catch(() => {
            if (receiptPrintPreparationRef.current === preparation) {
                receiptPrintPreparationRef.current = null
            }
        })
        if (thermalImagePromise) void thermalImagePromise.catch(() => undefined)
        return preparation
    }, [buildReceiptPdf, features.thermal_printing, receiptQuality, workspaceId])

    const preparedReceiptPdfBuilder = useCallback(
        () => getReceiptPrintPreparation().pdfPromise,
        [getReceiptPrintPreparation]
    )

    const prepareReceiptPrint = useCallback(async (pdfBuilder = buildReceiptPdf) => {
        const preparation = getReceiptPrintPreparation(pdfBuilder)
        await preparation.pdfPromise
        if (preparation.thermalImagePromise) {
            await preparation.thermalImagePromise.catch(() => undefined)
        }
    }, [buildReceiptPdf, getReceiptPrintPreparation])

    useEffect(() => {
        if (!prewarmPrint || !enabled || !saleData || isPrimaryReceiptTemplateLoading) {
            setIsPreparingReceiptPrint(false)
            return
        }

        // Let the success modal paint first, then build the PDF (and thermal
        // raster, when needed) while the cashier reviews the sale summary.
        let cancelled = false
        setIsPreparingReceiptPrint(true)
        let frame: number | null = null
        const timer = window.setTimeout(() => {
            frame = window.requestAnimationFrame(() => {
                void prepareReceiptPrint().catch((error) => {
                    console.warn('[usePosReceiptPrinter] Receipt prewarm failed:', error)
                }).finally(() => {
                    if (!cancelled) setIsPreparingReceiptPrint(false)
                })
            })
        }, Math.max(0, prewarmDelayMs))
        return () => {
            cancelled = true
            window.clearTimeout(timer)
            if (frame !== null) window.cancelAnimationFrame(frame)
        }
    }, [enabled, isPrimaryReceiptTemplateLoading, prepareReceiptPrint, prewarmDelayMs, prewarmPrint, saleData])

    useEffect(() => {
        if (!enabled) receiptPrintPreparationRef.current = null
    }, [enabled])

    const printReceipt = useCallback(async ({
        title = `Receipt_${saleData?.invoiceid || saleData?.id || 'Sale'}`,
        pdfBuilder = preparedReceiptPdfBuilder
    }: PrintPosReceiptOptions = {}) => {
        let handledByThermalPrinter = false
        const preparation = getReceiptPrintPreparation(
            pdfBuilder === preparedReceiptPdfBuilder ? buildReceiptPdf : pdfBuilder
        )
        if (features.thermal_printing) {
            try {
                const { imageBase64, maxWidth } = await preparation.thermalImagePromise!
                handledByThermalPrinter = await printService.silentPrintImage({
                    imageBase64,
                    workspaceId,
                    maxWidth
                })
            } catch (thermalError) {
                console.error('[usePosReceiptPrinter] Thermal print failed:', thermalError)
                toast({
                    title: t('settings.printing.thermalPrintErrorTitle', { defaultValue: 'Thermal printing failed' }),
                    description: t('settings.printing.thermalPrintErrorDesc', {
                        defaultValue: 'Falling back to the regular receipt print flow for this sale.'
                    }),
                    variant: 'destructive'
                })
            }
        }

        if (!handledByThermalPrinter) {
            await printPdfBlob(await preparation.pdfPromise, { title })
        }
    }, [buildReceiptPdf, features.thermal_printing, getReceiptPrintPreparation, preparedReceiptPdfBuilder, saleData?.id, saleData?.invoiceid, t, toast, workspaceId])

    return {
        buildReceiptPdf: preparedReceiptPdfBuilder,
        isLoadingPrimaryReceiptTemplate: isPrimaryReceiptTemplateLoading,
        isPreparingReceiptPrint,
        printFeatures,
        printReceipt,
        resolvedWorkspaceName,
        workspaceId,
    }
}
