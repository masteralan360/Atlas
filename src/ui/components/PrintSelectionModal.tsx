import { AlertTriangle, FileText, Printer, Receipt } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { StoredCustomTemplateRow } from '@/lib/customTemplates'
import type { OrderPrintVersion } from '@/lib/orderPrintReturnState'
import type { PrintFormat } from '@/services/pdfGenerator'
import { useWorkspace } from '@/workspace'
import { Button } from '@/ui/components/button'
import {
    SmallDialog,
    SmallDialogContent,
    SmallDialogHeader,
    SmallDialogTitle
} from '@/ui/components/small-dialog'

export type PrintSelectionNativeOption = {
    format: PrintFormat
    label: string
    description: string
    /** Distinguishes native layouts that use the same paper format. */
    nativeTemplateKey?: string
    /** Marks an option that prints returned items only. */
    returned?: boolean
    /** Marks a normal order print whose rows include return adjustments. */
    returnsReflected?: boolean
    disabled?: boolean
    warning?: string
}

export type PrintSelectionTemplateOption = {
    format: PrintFormat
    template: StoredCustomTemplateRow
    label: string
    description?: string
    primary?: boolean
    /** Marks a saved layout dedicated to partial and fully returned orders. */
    returned?: boolean
    /** Marks a normal order print whose rows include return adjustments. */
    returnsReflected?: boolean
    disabled?: boolean
    warning?: string
}

interface PrintSelectionModalProps {
    isOpen: boolean
    onClose: () => void
    onSelect: (format: PrintFormat, template?: StoredCustomTemplateRow, nativeTemplateKey?: string, printVersion?: OrderPrintVersion) => void
    nativeOptions: PrintSelectionNativeOption[]
    templateOptions?: PrintSelectionTemplateOption[]
    onCreateReturnTemplate?: () => void
    /** A4 business documents that are independent of the invoice entitlement. */
    allowA4Document?: boolean
}

function PrintOptionIcon({ format, custom = false }: { format: PrintFormat; custom?: boolean }) {
    if (format === 'receipt') {
        return <Receipt className={`h-6 w-6 ${custom ? 'text-primary' : 'text-foreground'}`} />
    }

    return <FileText className={`h-6 w-6 ${custom ? 'text-primary' : 'text-foreground'}`} />
}

function PrintOptionBadges({
    primary = false,
    returned = false,
    returnsReflected = false,
    original = false
}: {
    primary?: boolean
    returned?: boolean
    returnsReflected?: boolean
    original?: boolean
}) {
    const { t } = useTranslation()
    if (!primary && !returned && !returnsReflected && !original) return null

    return (
        <span className="flex w-full flex-wrap items-start justify-end gap-1">
            {primary ? (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold leading-tight text-primary">
                    {t('customTemplates.primary', { defaultValue: 'Primary' })}
                </span>
            ) : null}
            {returned ? (
                <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold leading-tight text-rose-700 dark:text-rose-300">
                    {t('orders.return.returnedStatus', { defaultValue: 'Returned' })}
                </span>
            ) : null}
            {returnsReflected ? (
                <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold leading-tight text-amber-800 dark:text-amber-200">
                    {t('orders.return.returnsReflected', { defaultValue: 'Returns reflected' })}
                </span>
            ) : null}
            {original ? (
                <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold leading-tight text-sky-700 dark:text-sky-300">
                    {t('orders.return.originalPrint', { defaultValue: 'Original' })}
                </span>
            ) : null}
        </span>
    )
}

export function PrintSelectionModal({
    isOpen,
    onClose,
    onSelect,
    nativeOptions,
    templateOptions = [],
    onCreateReturnTemplate,
    allowA4Document = false
}: PrintSelectionModalProps) {
    const { t } = useTranslation()
    const { hasCapability } = useWorkspace()
    const canUseA4Invoices = allowA4Document || hasCapability('a4PdfInvoices')
    const hasPrintVersionSelector = nativeOptions.some((option) => option.returned)
        || templateOptions.some((option) => option.returned)
    const hasNormalPrintOptions = nativeOptions.some((option) => !option.returned)
        || templateOptions.some((option) => !option.returned)
    const [printVersion, setPrintVersion] = useState<OrderPrintVersion>(() =>
        hasPrintVersionSelector && !hasNormalPrintOptions ? 'returned' : 'adjusted'
    )

    useEffect(() => {
        if (!isOpen) setPrintVersion('adjusted')
    }, [isOpen])

    const isReturnedVersion = printVersion === 'returned'
    const visibleNativeOptions = nativeOptions.filter((option) =>
        (option.format !== 'a4' || canUseA4Invoices)
        && (isReturnedVersion ? option.returned : !option.returned)
    )
    const visibleTemplateOptions = templateOptions.filter((option) =>
        (option.format !== 'a4' || canUseA4Invoices)
        && (isReturnedVersion ? option.returned : !option.returned)
    )
    // A saved return layout is the destination of the creation action, so do not
    // offer to create another one once the workspace already has one available.
    const shouldShowCreateReturnTemplate = isReturnedVersion
        && Boolean(onCreateReturnTemplate)
        && !templateOptions.some((option) => option.returned)
    const visibleOptionCount = visibleNativeOptions.length
        + visibleTemplateOptions.length
        + (shouldShowCreateReturnTemplate ? 1 : 0)

    return (
        <SmallDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <SmallDialogContent className="sm:max-w-lg">
                <SmallDialogHeader>
                    <SmallDialogTitle className="flex items-center gap-2">
                        <Printer className="h-5 w-5 text-primary" />
                        {t('common.print', { defaultValue: 'Select Print' })}
                    </SmallDialogTitle>
                </SmallDialogHeader>

                {hasPrintVersionSelector ? (
                    <div className="space-y-2 pt-2">
                        <div className="text-xs font-semibold text-muted-foreground">
                            {t('orders.return.printVersion', { defaultValue: 'Print version' })}
                        </div>
                        <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/30 p-1">
                            {([
                                ['adjusted', 'orders.return.adjustedPrint', 'Returns reflected', 'bg-amber-400/20 text-amber-800 dark:text-amber-200'],
                                ['original', 'orders.return.originalPrint', 'Original', 'bg-sky-500/10 text-sky-700 dark:text-sky-300'],
                                ['returned', 'orders.return.returnedPrint', 'Returned', 'bg-rose-500/10 text-rose-700 dark:text-rose-300']
                            ] as const).map(([version, labelKey, fallbackLabel, activeClassName]) => (
                                <Button
                                    key={version}
                                    type="button"
                                    variant="ghost"
                                    className={`min-h-8 min-w-fit flex-1 basis-[calc(33.333%-0.25rem)] whitespace-normal px-2 py-1.5 text-[10px] font-bold leading-tight sm:py-1 sm:text-xs ${
                                        printVersion === version ? activeClassName : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                    onClick={() => setPrintVersion(version)}
                                >
                                    {t(labelKey, { defaultValue: fallbackLabel })}
                                </Button>
                            ))}
                        </div>
                    </div>
                ) : null}

                <div className="grid max-h-[65vh] grid-cols-1 gap-4 overflow-y-auto py-4 sm:grid-cols-2">
                    {visibleNativeOptions.length === 0 && visibleTemplateOptions.length === 0 ? (
                        <div className="col-span-full rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                            {t('print.noFormatsAvailable', {
                                defaultValue: 'No print formats are available for this workspace.'
                            })}
                        </div>
                    ) : null}
                    {visibleNativeOptions.map(({ format, label, description, nativeTemplateKey, returned, returnsReflected, disabled, warning }) => (
                        <Button
                            key={`native-${format}-${label}`}
                            variant="outline"
                            className={`relative flex min-h-32 min-w-0 flex-col gap-2 whitespace-normal px-3 py-3 text-center transition-all hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-70 ${
                                visibleOptionCount === 1 ? 'sm:col-span-2' : ''
                            }`}
                            onClick={() => onSelect(format, undefined, nativeTemplateKey, printVersion)}
                            disabled={disabled}
                        >
                            <PrintOptionBadges
                                returned={returned}
                                returnsReflected={printVersion === 'adjusted' && returnsReflected}
                                original={printVersion === 'original'}
                            />
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                                <PrintOptionIcon format={format} />
                            </div>
                            <div className="w-full min-w-0 space-y-1">
                                <div className="font-bold">{label}</div>
                                <div className="line-clamp-2 break-words text-center text-xs leading-4 text-muted-foreground">
                                    {description}
                                </div>
                                {warning ? (
                                    <div className="mt-1 flex items-start justify-center gap-1 rounded-md border border-amber-300/70 bg-amber-500/10 px-2 py-1 text-[10px] leading-3 text-amber-800 dark:text-amber-300">
                                        <AlertTriangle className="h-3 w-3 shrink-0" />
                                        <span className="line-clamp-3">{warning}</span>
                                    </div>
                                ) : null}
                            </div>
                        </Button>
                    ))}

                    {shouldShowCreateReturnTemplate ? (
                        <Button
                            variant="outline"
                            className={`relative flex min-h-32 min-w-0 flex-col gap-2 whitespace-normal border-dashed px-3 py-3 text-center transition-all hover:border-primary hover:bg-primary/5 ${
                                visibleOptionCount === 1 ? 'sm:col-span-2' : ''
                            }`}
                            onClick={onCreateReturnTemplate}
                        >
                            <PrintOptionBadges returned />
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10">
                                <FileText className="h-6 w-6 text-rose-700 dark:text-rose-300" />
                            </div>
                            <div className="w-full min-w-0 space-y-1">
                                <div className="font-bold">
                                    {t('orders.print.createReturnTemplate', { defaultValue: 'Create return template' })}
                                </div>
                                <div className="line-clamp-2 break-words text-center text-xs leading-4 text-muted-foreground">
                                    {t('orders.print.createReturnTemplateDescription', {
                                        defaultValue: 'Create an independent layout for partial and fully returned orders.'
                                    })}
                                </div>
                            </div>
                        </Button>
                    ) : null}

                    {visibleTemplateOptions.map(({ format, template, label, description, primary, returned, returnsReflected, disabled, warning }) => (
                        <Button
                            key={template.id}
                            variant="outline"
                            className={`relative flex min-h-32 min-w-0 flex-col gap-2 whitespace-normal px-3 py-3 text-center transition-all hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-70 ${
                                visibleOptionCount === 1 ? 'sm:col-span-2' : ''
                            }`}
                            onClick={() => onSelect(format, template, undefined, printVersion)}
                            disabled={disabled}
                        >
                            <PrintOptionBadges
                                primary={primary}
                                returned={returned}
                                returnsReflected={printVersion === 'adjusted' && returnsReflected}
                                original={printVersion === 'original'}
                            />
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                                <PrintOptionIcon format={format} custom />
                            </div>
                            <div className="w-full min-w-0 space-y-1">
                                <div className="font-bold">
                                    {label}
                                </div>
                                <div className="line-clamp-2 break-words text-center text-xs leading-4 text-muted-foreground">
                                    {description || t('customTemplates.customPrint', {
                                        defaultValue: format === 'receipt' ? 'Custom Receipt' : 'Custom A4 Print'
                                    })}
                                </div>
                                {warning ? (
                                    <div className="mt-1 flex items-start justify-center gap-1 rounded-md border border-amber-300/70 bg-amber-500/10 px-2 py-1 text-[10px] leading-3 text-amber-800 dark:text-amber-300">
                                        <AlertTriangle className="h-3 w-3 shrink-0" />
                                        <span className="line-clamp-3">{warning}</span>
                                    </div>
                                ) : null}
                            </div>
                        </Button>
                    ))}
                </div>
            </SmallDialogContent>
        </SmallDialog>
    )
}
