import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
    useToast,
    A4InvoiceTemplate,
    ModernA4InvoiceTemplate,
    ProfessionalA4InvoiceTemplate,
    RefundA4InvoiceTemplate,
    RefundPrimaryA4InvoiceTemplate,
    SaleReceiptBase
} from '@/ui/components'
import { saveInvoiceFromSnapshot, useWorkspaceContacts } from '@/local-db/hooks'
import { useAuth } from '@/auth'
import { db, type Invoice } from '@/local-db'
import { generateInvoicePdf, generateTemplatePdf, isInvoicePrintFormat, type InvoicePrintFormat, type PrintFormat } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { reportPdfProgress } from '@/services/pdfProgress'
import {
    disableInvoiceQrInLocalMode
} from '@/services/localInvoiceStorage'
import { persistInvoiceVersion } from '@/services/invoiceVersionService'
import { useWorkspace, type WorkspaceFeatures } from '@/workspace'
import { useWorkspacePermissions } from '@/permissions/WorkspacePermissionsContext'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError } from '@/lib/supabaseRequest'
import {
    setPrintPreviewEditorSource,
    type CustomTemplateLayout,
    type CustomTemplatePreviewTarget,
    type TemplatePreview
} from '@/lib/printPreviewEditorStore'
import { PRINT_PREVIEW_EDITOR_PATH, shouldOpenPrintPreviewEditor } from '@/lib/printFlow'
import {
    PrintSelectionModal,
    type PrintSelectionNativeOption,
    type PrintSelectionTemplateOption
} from '@/ui/components/PrintSelectionModal'
import type { OrderPrintVersion } from '@/lib/orderPrintReturnState'
import type { StoredCustomTemplateRow } from '@/lib/customTemplates'

interface PrintFlowProps {
    isOpen: boolean
    onClose: () => void
    onConfirm?: () => void
    title?: string
    children?: ReactNode
    showSaveButton?: boolean
    invoiceData?: Omit<Invoice, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'invoiceid'> & { invoiceid?: string }
    pdfData?: any // UniversalInvoice
    pdfBuilder?: (options: { format: PrintFormat; effectiveId: string; printLangOverride?: string }) => Promise<Blob>
    documentId?: string
    /** UUID of the source entity/report represented by this print. */
    originId?: string
    printTemplate?: ReactNode | ((options: { effectiveId: string }) => ReactNode)
    templatePreview?: TemplatePreview
    customTemplate?: CustomTemplatePreviewTarget
    templateFieldValues?: Record<string, string>
    initialTemplateLayout?: CustomTemplateLayout | null
    allowTemplateFieldEditing?: boolean
    enableTemplatePreviewSave?: boolean
    templatePrimaryActionLabel?: string
    generateTemplateLayoutBlob?: (layout: CustomTemplateLayout, printLangOverride?: string, effectiveId?: string) => Promise<Blob>
    features?: WorkspaceFeatures
    workspaceName?: string | null
    module?: string
    printSelectionOptions?: PrintSelectionNativeOption[]
    printSelectionTemplates?: PrintSelectionTemplateOption[]
    onPrintSelection?: (format: PrintFormat, template?: StoredCustomTemplateRow, nativeTemplateKey?: string, printVersion?: OrderPrintVersion) => void
    onCreateReturnTemplate?: () => void
    onPreviewPrint?: (blob: Blob) => Promise<void>
    onPreviewSave?: (blob: Blob) => Promise<string | undefined | void>
    savedDocumentKind?: 'voucher'
    previewPrintActionLabel?: string
    /** A4 business documents that are independent of the invoice entitlement. */
    allowA4Document?: boolean
}

type WorkspaceContactPair = {
    primary?: string
    nonPrimary?: string
}

type WorkspaceFooterContacts = {
    address?: WorkspaceContactPair
    email?: WorkspaceContactPair
    phone?: WorkspaceContactPair
}

export function PrintFlow({
    isOpen,
    onClose,
    onConfirm,
    title,
    children,
    showSaveButton = true,
    invoiceData,
    pdfData,
    pdfBuilder,
    documentId,
    originId,
    printTemplate,
    templatePreview: templatePreviewProp,
    customTemplate,
    templateFieldValues,
    initialTemplateLayout,
    allowTemplateFieldEditing,
    enableTemplatePreviewSave,
    templatePrimaryActionLabel,
    generateTemplateLayoutBlob,
    features,
    workspaceName,
    module,
    printSelectionOptions,
    printSelectionTemplates,
    onPrintSelection,
    onCreateReturnTemplate,
    onPreviewPrint,
    onPreviewSave,
    savedDocumentKind,
    previewPrintActionLabel,
    allowA4Document = false
}: PrintFlowProps) {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { hasCapability } = useWorkspace()
    const { hasPermission } = useWorkspacePermissions()
    const [, setLocation] = useLocation()
    const workspaceId = user?.workspaceId
    const workspaceContacts = useWorkspaceContacts(workspaceId)
    const [selectedPrintFormat, setSelectedPrintFormat] = useState<PrintFormat | null>(null)
    const previewOpenedRef = useRef(false)
    const canPrint = useMemo(() => {
        const permissionKey = `${module || 'global'}.print` as any
        return hasPermission(permissionKey)
    }, [hasPermission, module])

    useEffect(() => {
        if (!isOpen) {
            setSelectedPrintFormat(null)
            previewOpenedRef.current = false
        }
    }, [isOpen])

    // Use the source entity/report UUID for QR, invoice tracing, and versioning.
    // The temporary UUID is only a last-resort fallback for non-persisted previews.
    const [tempId, setTempId] = useState<string>('')

    // The actual ID to be used for generation and saving
    const effectiveId = useMemo(
        () => originId || pdfData?.id || documentId || tempId,
        [originId, pdfData?.id, documentId, tempId]
    )

    useEffect(() => {
        if (isOpen && !originId && !pdfData?.id && !documentId) {
            setTempId(crypto.randomUUID())
        }
    }, [isOpen, originId, pdfData?.id, documentId])

    const [isSaving, setIsSaving] = useState(false)

    const hasPdfData = !!pdfBuilder || !!(pdfData && features)
    const requestedPrintFormat: PrintFormat = (invoiceData?.printFormat || 'a4') as PrintFormat
    const defaultPrintFormat: PrintFormat = requestedPrintFormat === 'a4' && !allowA4Document && !hasCapability('a4PdfInvoices')
        ? 'receipt'
        : requestedPrintFormat
    const printFormat = selectedPrintFormat || defaultPrintFormat
    const resolvedPrintSelectionOptions = useMemo<PrintSelectionNativeOption[]>(
        () => printSelectionOptions || [{
            format: defaultPrintFormat,
            label: title || (defaultPrintFormat === 'receipt'
                ? (t('sales.print.receipt', { defaultValue: 'Thermal Receipt' }))
                : (t('sales.print.a4', { defaultValue: 'A4 Print' }))),
            description: defaultPrintFormat === 'receipt'
                ? t('sales.print.receiptdesc', { defaultValue: 'Thermal receipt document' })
                : t('sales.print.a4desc', { defaultValue: 'Detailed full-page document' })
        }],
        [defaultPrintFormat, printSelectionOptions, t, title]
    )
    const handlePrintSelection = useCallback((
        format: PrintFormat,
        template?: StoredCustomTemplateRow,
        nativeTemplateKey?: string,
        printVersion?: OrderPrintVersion
    ) => {
        if (!canPrint) return
        onPrintSelection?.(format, template, nativeTemplateKey, printVersion)
        setSelectedPrintFormat(format)
    }, [canPrint, onPrintSelection])
    const printableFeatures = useMemo(
        () => disableInvoiceQrInLocalMode(workspaceId, features),
        [features, workspaceId]
    )
    const printLang = printableFeatures?.print_lang && printableFeatures.print_lang !== 'auto' ? printableFeatures.print_lang : i18n.language
    const t_print = useMemo(() => i18n.getFixedT(printLang), [i18n, printLang])

    const translations = useMemo(() => ({
        date: t_print('sales.print.date') || 'Date',
        number: t_print('sales.print.number') || 'Invoice #',
        soldTo: t_print('sales.print.soldTo') || 'Sold To',
        soldBy: t_print('sales.print.soldBy') || 'Sold By',
        qty: t_print('sales.print.qty') || 'Qty',
        productName: t_print('sales.print.productName') || 'Product',
        description: t_print('sales.print.description') || 'Description',
        price: t_print('sales.print.price') || 'Price',
        discount: t_print('sales.print.discount') || 'Discount',
        total: t_print('sales.print.total') || 'Total',
        subtotal: t_print('sales.print.subtotal') || 'Subtotal',
        terms: t_print('sales.print.terms') || 'Terms & Conditions',
        exchangeRates: t_print('sales.print.exchangeRates') || 'Exchange Rates',
        posSystem: t_print('sales.print.posSystem') || 'POS System',
        generated: t_print('sales.print.generated') || 'Generated',
        id: t_print('sales.print.id') || 'ID',
        cashier: t_print('sales.print.cashier') || 'Cashier',
        paymentMethod: t_print('sales.print.paymentMethod') || 'Payment Method',
        name: t_print('sales.print.name') || 'Name',
        quantity: t_print('sales.print.quantity') || 'Qty',
        thankYou: t_print('sales.print.thankYou') || 'Thank You',
        keepRecord: t_print('sales.print.keepRecord') || 'Please keep this for your records',
        snapshots: t_print('sales.print.snapshots') || 'Snapshots'
    }), [t_print])

    const workspaceFooterContacts = useMemo<WorkspaceFooterContacts>(() => {
        const pickContactPair = (type: 'address' | 'email' | 'phone'): WorkspaceContactPair => {
            const contactsOfType = workspaceContacts.filter((contact) =>
                contact.type === type
                && typeof contact.value === 'string'
                && contact.value.trim().length > 0
            )
            if (contactsOfType.length === 0) return {}

            const primaryContact = contactsOfType.find((contact) => contact.isPrimary) || contactsOfType[0]
            const primary = primaryContact.value.trim()
            const nonPrimaryContact = contactsOfType.find((contact) =>
                contact.id !== primaryContact.id
                && (!contact.isPrimary || contact.value.trim() !== primary)
            )
            const nonPrimary = nonPrimaryContact?.value.trim()

            return {
                ...(primary ? { primary } : {}),
                ...(nonPrimary ? { nonPrimary } : {})
            }
        }

        return {
            address: pickContactPair('address'),
            email: pickContactPair('email'),
            phone: pickContactPair('phone')
        }
    }, [workspaceContacts])

    const templateContent = useMemo<ReactNode>(() => {
        if (printTemplate) {
            return typeof printTemplate === 'function'
                ? printTemplate({ effectiveId })
                : printTemplate
        }

        if (pdfData && printableFeatures) {
            return printFormat === 'receipt' ? (
                <div className="w-[80mm]">
                    <SaleReceiptBase
                        data={pdfData}
                        features={printableFeatures}
                        workspaceName={workspaceName || workspaceId || 'Atlas'}
                        workspaceId={workspaceId || undefined}
                    />
                </div>
            ) : (
                pdfData?.is_refund_invoice ? (
                    printableFeatures?.a4_template === 'modern' ? (
                        <RefundA4InvoiceTemplate
                            data={pdfData}
                            features={printableFeatures}
                            workspaceId={workspaceId || undefined}
                            workspaceName={workspaceName || workspaceId || 'Atlas'}
                        />
                    ) : (
                        <RefundPrimaryA4InvoiceTemplate
                            data={pdfData}
                            features={printableFeatures}
                            workspaceId={workspaceId || undefined}
                            workspaceName={workspaceName || workspaceId || 'Atlas'}
                        />
                    )
                ) : printableFeatures?.a4_template === 'professional' ? (
                    <ProfessionalA4InvoiceTemplate
                        data={pdfData}
                        features={printableFeatures}
                        workspaceId={workspaceId || undefined}
                        workspaceName={workspaceName || workspaceId || 'Atlas'}
                        workspaceFooterContacts={workspaceFooterContacts}
                    />
                ) : printableFeatures?.a4_template === 'modern' ? (
                    <ModernA4InvoiceTemplate
                        data={pdfData}
                        features={printableFeatures}
                        workspaceId={workspaceId || undefined}
                        workspaceName={workspaceName || workspaceId || 'Atlas'}
                        workspaceFooterContacts={workspaceFooterContacts}
                    />
                ) : (
                    <A4InvoiceTemplate
                        data={pdfData}
                        features={printableFeatures}
                        workspaceId={workspaceId || undefined}
                        workspaceName={workspaceName || workspaceId || 'Atlas'}
                    />
                )
            )
        }

        return children || null
    }, [children, effectiveId, pdfData, printFormat, printTemplate, printableFeatures, workspaceFooterContacts, workspaceId, workspaceName])



    const ensureSaveBlob = useCallback(async (printLangOverride?: string): Promise<Blob> => {
        const effectiveLang = printLangOverride || printLang
        if (pdfBuilder) {
            return await pdfBuilder({ format: printFormat, effectiveId, printLangOverride })
        }
        if (!pdfData || !printableFeatures) throw new Error('Missing PDF data')
        return await generateInvoicePdf({
            data: { ...pdfData, id: effectiveId },
            format: printFormat,
            workspaceId: workspaceId || '',
            features: { 
                ...printableFeatures, 
                logo_url: printableFeatures.logo_url || undefined,
                print_lang: effectiveLang
            },
            workspaceName: workspaceName || workspaceId || '',
            translations,
            workspaceFooterContacts
        })
    }, [pdfBuilder, pdfData, printableFeatures, printFormat, effectiveId, workspaceId, workspaceName, translations, printLang, workspaceFooterContacts])

    const handleSave = useCallback(async (preGeneratedBlob?: Blob) => {
        if (isSaving) return
        if (!hasPdfData) return

        // Barcode labels deliberately never create or update invoice records.
        if (!isInvoicePrintFormat(printFormat)) {
            throw new Error('Barcode labels cannot be saved as invoices')
        }
        const invoicePrintFormat: InvoicePrintFormat = printFormat

        setIsSaving(true)
        try {
            const activeBlob = preGeneratedBlob || await ensureSaveBlob()
            let savedInvoice: Invoice | null = null

            if (invoiceData && workspaceId) {
                const snapshotData: any = {
                    ...invoiceData,
                    sourceId: effectiveId,
                    createdBy: invoiceData.createdBy || user?.id,
                    createdByName: invoiceData.createdByName || user?.name,
                    printFormat: invoicePrintFormat,
                }
                if (invoicePrintFormat === 'a4') { snapshotData.pdfBlobA4 = activeBlob }
                else { snapshotData.pdfBlobReceipt = activeBlob }

                savedInvoice = await saveInvoiceFromSnapshot(workspaceId, snapshotData, effectiveId)
                const confirmedInvoice = await db.invoices.get(effectiveId)
                if (confirmedInvoice) savedInvoice = confirmedInvoice
            }

            if (savedInvoice) {
                const finalBlob = preGeneratedBlob || (!pdfBuilder && pdfData && printableFeatures
                    ? await generateInvoicePdf({
                        data: { ...pdfData, ...savedInvoice, id: savedInvoice.sourceId || savedInvoice.id, invoiceid: savedInvoice.invoiceid, sequenceId: savedInvoice.sequenceId },
                        format: invoicePrintFormat,
                        workspaceId: workspaceId || '',
                        features: { ...printableFeatures, logo_url: printableFeatures?.logo_url || undefined },
                        workspaceName: workspaceName || workspaceId || '',
                        translations,
                        workspaceFooterContacts
                    })
                    : activeBlob)

                reportPdfProgress(0.96, 'print.progressSavingInvoice')
                await persistInvoiceVersion({
                    invoice: { ...savedInvoice, sourceId: savedInvoice.sourceId || effectiveId },
                    blob: finalBlob,
                    format: invoicePrintFormat,
                    author: { id: user?.id, name: user?.name || savedInvoice.createdByName },
                    metadata: {
                        module: module || null,
                        title: title || null,
                        templateId: customTemplate?.templateId || null,
                        templateLabel: customTemplate?.label || null,
                    },
                })
                reportPdfProgress(1, 'print.progressSavingInvoice')
            }

            if (savedInvoice) {
                toast({
                    title: t('print.saveSuccess') || 'Invoice Saved',
                    description: t('print.saveSuccessDesc') || 'A record of this invoice has been added to history.'
                })
            }

            if (onConfirm) onConfirm()
            return savedInvoice?.invoiceid
        } catch (error) {
            console.error('Error saving invoice snapshot:', error)
            const normalized = normalizeSupabaseActionError(error)
            toast({
                title: isRetriableWebRequestError(normalized) ? getRetriableActionToast(normalized).title : (t('print.saveError') || 'Save Failed'),
                description: isRetriableWebRequestError(normalized) ? getRetriableActionToast(normalized).description : (t('print.saveErrorDesc') || 'Could not save invoice record.'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }, [
        effectiveId,
        ensureSaveBlob,
        hasPdfData,
        customTemplate,
        invoiceData,
        isSaving,
        module,
        onConfirm,
        pdfBuilder,
        pdfData,
        printFormat,
        printableFeatures,
        t,
        title,
        toast,
        translations,
        user?.id,
        user?.name,
        workspaceFooterContacts,
        workspaceId,
        workspaceName
    ])

    const handleOpenPreview = useCallback(async () => {
        try {
            templatePreviewProp?.resetFreshPartnerBalance?.()
            const hasPdfDataForPreview = !!pdfData
            const hasPdfBuilder = !!pdfBuilder
            const previewTitle = title || t('print.previewTitle') || 'Print Preview'

            if (hasPdfDataForPreview) {
                const generatePdfBlob = async (editedData: any, printLangOverride?: string): Promise<Blob> => {
                    const dataToUse = editedData || pdfData
                    if (pdfBuilder) {
                        return await pdfBuilder({ format: printFormat, effectiveId, printLangOverride })
                    }
                    if (!dataToUse || !printableFeatures) throw new Error('Missing PDF data')
                    const effectiveLang = printLangOverride || printLang
                    return await generateInvoicePdf({
                        data: { ...dataToUse, id: effectiveId },
                        format: printFormat,
                        workspaceId: workspaceId || '',
                        features: { 
                            ...printableFeatures, 
                            logo_url: printableFeatures.logo_url || undefined,
                            print_lang: effectiveLang
                        },
                        workspaceName: workspaceName || workspaceId || '',
                        translations,
                        workspaceFooterContacts
                    })
                }

                setPrintPreviewEditorSource({
                    data: pdfData || { id: effectiveId, items: [], total_amount: 0, settlement_currency: 'usd', created_at: new Date().toISOString() },
                    features: printableFeatures || {},
                    workspaceId,
                    workspaceName: workspaceName || undefined,
                    workspaceFooterContacts,
                    printFormat,
                    title: previewTitle,
                    onSave: showSaveButton ? handleSave : undefined,
                    invoiceData,
                    effectiveId,
                    generatePdfBlob,
                })
            } else if (templatePreviewProp) {
                setPrintPreviewEditorSource({
                    title: previewTitle,
                    onSave: onPreviewSave || (!onPreviewPrint && hasPdfData && (showSaveButton || enableTemplatePreviewSave) ? handleSave : undefined),
                    onPrint: onPreviewPrint,
                    savedDocumentKind,
                    printActionLabel: previewPrintActionLabel,
                    effectiveId,
                    printFormat,
                    workspaceId,
                    templatePreview: templatePreviewProp,
                    customTemplate,
                    templateFieldValues,
                    initialTemplateLayout,
                    allowTemplateFieldEditing,
                    templatePrimaryActionLabel,
                    generateTemplateLayoutBlob,
                    workspaceFooterContacts,
                })
            } else if (hasPdfBuilder && !templateContent) {
                setPrintPreviewEditorSource({
                    title: previewTitle,
                    effectiveId,
                    printFormat,
                    workspaceId,
                    generatePreviewPdfBlob: (printLangOverride) => pdfBuilder({
                        format: printFormat,
                        effectiveId,
                        printLangOverride
                    }),
                    onPrint: onPreviewPrint || ((blob) => printPdfBlob(blob, { title: previewTitle })),
                    printActionLabel: previewPrintActionLabel || t('pdfPreview.print', { defaultValue: 'Print' })
                })
            } else if (templateContent) {
                const genericTemplatePreview: TemplatePreview = {
                    fields: [],
                    page: {
                        widthMm: printFormat === 'receipt' ? 80 : 210,
                        heightMm: 297
                    },
                    createElement: () => createElement(Fragment, null, templateContent),
                    buildPdf: (element, printLangOverride) => pdfBuilder
                        ? pdfBuilder({ format: printFormat, effectiveId, printLangOverride })
                        : generateTemplatePdf({
                            element,
                            format: printFormat,
                            printLang: printLangOverride || printLang
                        })
                }

                setPrintPreviewEditorSource({
                    title: previewTitle,
                    effectiveId,
                    printFormat,
                    workspaceId,
                    workspaceName: workspaceName || undefined,
                    workspaceFooterContacts,
                    templatePreview: genericTemplatePreview,
                    onSave: onPreviewSave,
                    onPrint: onPreviewPrint || ((blob) => printPdfBlob(blob, { title: previewTitle })),
                    printActionLabel: previewPrintActionLabel || t('pdfPreview.print', { defaultValue: 'Print' })
                })
            } else {
                throw new Error('No printable content is available.')
            }

            if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                await new Promise<void>((resolve) => window.setTimeout(resolve, 200))
            }
            setLocation(PRINT_PREVIEW_EDITOR_PATH)
        } catch (err) {
            console.error('Failed to open preview:', err)
            previewOpenedRef.current = false
            setSelectedPrintFormat(null)
            toast({
                title: t('print.previewErrorTitle', { defaultValue: 'Could not open print preview' }),
                description: t('print.previewErrorDescription', { defaultValue: 'Please try again.' }),
                variant: 'destructive'
            })
        }
    }, [printFormat, printLang, title, t, setLocation, handleSave, pdfData, hasPdfData, printableFeatures, workspaceId, workspaceName, workspaceFooterContacts, invoiceData, effectiveId, pdfBuilder, translations, templateContent, templatePreviewProp, customTemplate, templateFieldValues, initialTemplateLayout, allowTemplateFieldEditing, enableTemplatePreviewSave, templatePrimaryActionLabel, generateTemplateLayoutBlob, onPreviewPrint, onPreviewSave, savedDocumentKind, previewPrintActionLabel, showSaveButton, toast])

    useEffect(() => {
        if (!shouldOpenPrintPreviewEditor(isOpen, selectedPrintFormat, previewOpenedRef.current)) return
        previewOpenedRef.current = true
        void handleOpenPreview()
    }, [handleOpenPreview, isOpen, selectedPrintFormat])

    return (
        <>
            <PrintSelectionModal
                isOpen={isOpen && selectedPrintFormat === null}
                onClose={onClose}
                onSelect={handlePrintSelection}
                nativeOptions={resolvedPrintSelectionOptions.map((option) => ({
                    ...option,
                    disabled: option.disabled || !canPrint
                }))}
                templateOptions={printSelectionTemplates?.map((option) => ({
                    ...option,
                    disabled: option.disabled || !canPrint
                }))}
                onCreateReturnTemplate={canPrint ? onCreateReturnTemplate : undefined}
                allowA4Document={allowA4Document}
            />
        </>
    )
}
