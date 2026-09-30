import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    Dialog,
    DialogContent,
    DialogTitle,
    Button
} from '@/ui/components'
import { CheckCircle2, Printer, Coins, Table2 } from 'lucide-react'
import { formatCurrency, cn } from '@/lib/utils'
import { triggerInvoiceSync } from '@/services/invoiceSyncService'
import { printService } from '@/services/printService'
import { useAuth } from '@/auth'
import { useWorkspace, type WorkspaceFeatures } from '@/workspace'
import { Textarea } from '@/ui/components/textarea'
import { supabase } from '@/auth/supabase'
import { db } from '@/local-db'
import { useDebounce } from '@/lib/hooks'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { SALES_HISTORY_RECEIPT_TEMPLATE_KEY } from '@/lib/customTemplates'
import { usePosReceiptPrinter } from './usePosReceiptPrinter'

interface CheckoutSuccessModalProps {
    isOpen: boolean
    onClose: () => void
    saleData: any // Universal format expected by SaleReceipt
    features: WorkspaceFeatures
    tutorialDisablePrint?: boolean
    /** Uses a source-specific receipt while retaining the normal POS direct-print flow. */
    receiptPdfBuilder?: () => Promise<Blob>
    /** Custom Template target used for the receipt's primary-layout lookup. */
    receiptTemplateKey?: string
    /** Persists the note to the underlying source record instead of the POS sales table. */
    onSaveNote?: (note: string) => Promise<void> | void
    /** Table context shown for restaurant-table checkouts. */
    tableNumber?: string | number | null
}

export function CheckoutSuccessModal({
    isOpen,
    onClose,
    saleData,
    features,
    tutorialDisablePrint = false,
    receiptPdfBuilder,
    receiptTemplateKey = SALES_HISTORY_RECEIPT_TEMPLATE_KEY,
    onSaveNote,
    tableNumber
}: CheckoutSuccessModalProps) {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { isLocalMode } = useWorkspace()

    const [timeLeft, setTimeLeft] = useState(15)
    const [isPaused, setIsPaused] = useState(false)
    const [isProcessing, setIsProcessing] = useState(false)
    const [note, setNote] = useState(saleData?.notes || '')
    const [noteSourceId, setNoteSourceId] = useState<string | null>(saleData?.id || null)
    const hasAutoPrintedRef = useRef(false)
    const hasTableNumber = tableNumber !== null && tableNumber !== undefined && tableNumber !== ''
    const debouncedNote = useDebounce(note, 1000)
    const receiptSaleData = useMemo(
        () => saleData ? { ...saleData, notes: note } : saleData,
        [note, saleData]
    )
    const {
        buildReceiptPdf,
        isLoadingPrimaryReceiptTemplate,
        printFeatures,
        printReceipt,
        resolvedWorkspaceName,
        workspaceId,
    } = usePosReceiptPrinter({
        saleData: receiptSaleData,
        features,
        enabled: isOpen,
        receiptPdfBuilder,
        receiptTemplateKey,
    })
    const isPrintDisabled = isProcessing || isLoadingPrimaryReceiptTemplate || tutorialDisablePrint

    useEffect(() => {
        if (!isOpen) {
            setTimeLeft(15)
            setIsPaused(false)
            return
        }

        const timer = setInterval(() => {
            setTimeLeft((prev) => {
                if (isPaused) return prev
                if (prev <= 1) {
                    clearInterval(timer)
                    onClose()
                    return 0
                }
                return prev - 1
            })
        }, 1000)

        return () => clearInterval(timer)
    }, [isOpen, onClose, isPaused])

    useEffect(() => {
        if (isOpen) {
            setNote(saleData?.notes || '')
            setNoteSourceId(saleData?.id || null)
        }
    }, [isOpen, saleData?.id, saleData?.notes])

    const persistNote = useCallback(async (noteToSave: string) => {
        if (!saleData?.id || noteSourceId !== saleData.id || noteToSave === (saleData.notes || '')) return

        if (onSaveNote) {
            await onSaveNote(noteToSave)
            return
        }

        await db.sales.update(saleData.id, { notes: noteToSave })

        if (isLocalMode) return

        const { error } = await runSupabaseAction('checkoutSuccess.saveNote', () =>
            supabase
                .from('sales')
                .update({ notes: noteToSave })
                .eq('id', saleData.id)
        )

        if (error) throw normalizeSupabaseActionError(error)
    }, [isLocalMode, noteSourceId, onSaveNote, saleData])

    // Auto-save the note while the modal stays open. Printing also flushes the latest value.
    useEffect(() => {
        void persistNote(debouncedNote).catch((error) => {
            console.error('[CheckoutSuccessModal] Failed to auto-save note:', error)
        })
    }, [debouncedNote, persistNote])

    const handlePrintAndUpload = useCallback(async () => {
        if (isProcessing || !saleData) {
            // If already processing or missing data, just close or do nothing
            onClose()
            return
        }

        setIsProcessing(true)
        try {
            if (!user) {
                onClose()
                return
            }

            void persistNote(note).catch((error) => {
                console.error('[CheckoutSuccessModal] Failed to save note before printing:', error)
            })

            let receiptPdfPromise: Promise<Blob> | null = null
            const getReceiptPdf = () => {
                receiptPdfPromise ||= buildReceiptPdf()
                return receiptPdfPromise
            }

            // 1. Trigger background sync with the same receipt PDF used for printing.
            triggerInvoiceSync({
                saleData: receiptSaleData,
                features: printFeatures,
                workspaceName: resolvedWorkspaceName,
                workspaceId,
                user: {
                    id: user.id,
                    name: user.name || 'System'
                },
                format: 'receipt',
                pdfBuilder: getReceiptPdf
            });

            // 2. Print with the same thermal-printer-first fallback used by cart pre-prints.
            await printReceipt({
                pdfBuilder: getReceiptPdf,
                title: `Receipt_${receiptSaleData?.invoiceid || receiptSaleData?.id || 'Sale'}`
            })

            // Keep the success modal open; the timer or manual New Sale action closes it.
        } catch (error) {
            console.error('[CheckoutSuccessModal] Failed to start background sync or print:', error)
            // Even if there's an error, we want to close the modal to not block the user
            onClose();
        } finally {
            setIsProcessing(false)
        }
    }, [
        buildReceiptPdf,
        isProcessing,
        note,
        onClose,
        printFeatures,
        printReceipt,
        receiptSaleData,
        resolvedWorkspaceName,
        saleData,
        user,
        workspaceId,
        persistNote,
    ])

    useEffect(() => {
        if (!isOpen) {
            hasAutoPrintedRef.current = false
        }
    }, [isOpen])

    useEffect(() => {
        if (
            !isOpen
            || hasAutoPrintedRef.current
            || tutorialDisablePrint
            || isProcessing
            || isLoadingPrimaryReceiptTemplate
            || !saleData
            || !printService.isAutoPrintUponCheckoutEnabled(workspaceId)
        ) {
            return
        }

        // Mark the checkout before starting the shared flow so a print error
        // follows the existing close-on-error behavior without an auto-retry.
        hasAutoPrintedRef.current = true
        void handlePrintAndUpload()
    }, [
        handlePrintAndUpload,
        isLoadingPrimaryReceiptTemplate,
        isOpen,
        isProcessing,
        saleData,
        tutorialDisablePrint,
        workspaceId,
    ])

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                data-tour-id="tutorial-pos-success-modal"
                onOpenAutoFocus={(e) => e.preventDefault()}
                className="max-w-sm rounded-[2.5rem] p-0 overflow-hidden border-none shadow-2xl animate-in fade-in zoom-in duration-300"
            >
                <DialogTitle className="sr-only">
                    {t('pos.saleSuccessful') || 'Sale Successful'}
                </DialogTitle>
                <div className="bg-emerald-500 p-6 flex flex-col items-center justify-center text-white gap-3 relative overflow-hidden">
                    {/* Timer Corner */}
                    <div className="absolute top-4 left-4 flex items-center gap-1.5 bg-black/10 backdrop-blur-md px-2.5 py-1 rounded-full border border-white/10">
                        <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                        <span className="text-[10px] font-black font-mono tracking-widest">{timeLeft}S</span>
                    </div>

                    {/* Decorative background pattern */}
                    <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mt-16 blur-2xl" />
                    <div className="absolute bottom-0 left-0 w-24 h-24 bg-black/10 rounded-full -ml-12 -mb-12 blur-2xl" />

                    <div className="p-3 bg-white/20 backdrop-blur-md rounded-full animate-in zoom-in duration-500">
                        <CheckCircle2 className="w-16 h-16" />
                    </div>
                    <div className="text-center space-y-0.5">
                        <h2 className="text-xl font-black tracking-tight">
                            {t('pos.saleSuccessful') || 'Sale Successful'}
                        </h2>
                        <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest">
                            {saleData?.sequenceId ? `#${String(saleData.sequenceId).padStart(5, '0')}` : saleData?.invoiceid}
                        </p>
                        {hasTableNumber && (
                            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-white">
                                <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>{t('instantPos.table', { defaultValue: 'Table' })} {tableNumber}</span>
                            </div>
                        )}
                    </div>
                </div>

                <div className="p-6 space-y-6">
                    <div className="flex flex-col items-center gap-1">
                        <span className="text-muted-foreground text-sm font-bold uppercase tracking-widest opacity-50">
                            Total Amount
                        </span>
                        <div className="text-4xl font-black text-foreground">
                            {saleData ? formatCurrency(saleData.total_amount, saleData.settlement_currency, features.iqd_display_preference) : '-'}
                        </div>
                    </div>

                    {/* Note Section (Replaces Change Due) */}
                    <div className={cn(
                        "bg-muted/30 rounded-3xl p-4 flex flex-col gap-2 border transition-all duration-300 group",
                        isPaused ? "border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.1)]" : "border-border/50"
                    )}>
                        <div className="flex items-center justify-between px-1">
                            <div className="flex items-center gap-2">
                                <div className="p-1.5 bg-background rounded-lg border border-border shadow-sm">
                                    <Coins className="w-3.5 h-3.5 text-muted-foreground" />
                                </div>
                                <span className="font-bold text-xs text-muted-foreground uppercase tracking-tight">
                                    {t('sales.notes.title') || 'Sale Note'}
                                </span>
                            </div>

                            {isPaused && (
                                <div className="flex items-center gap-1.5 bg-emerald-500/10 text-emerald-600 px-2 py-0.5 rounded-full border border-emerald-500/20 animate-in fade-in slide-in-from-right-2">
                                    <div className="w-1 h-1 bg-emerald-500 rounded-full animate-pulse" />
                                    <span className="text-[9px] font-black uppercase tracking-widest leading-none">{t('sales.notes.paused')}</span>
                                </div>
                            )}
                        </div>

                        <Textarea
                            placeholder={t('sales.notes.placeholder') || "Add a private note to this sale..."}
                            value={note}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
                            onFocus={() => setIsPaused(true)}
                            className="bg-background/50 border-none shadow-none resize-none min-h-[80px] rounded-2xl text-sm focus-visible:ring-1 focus-visible:ring-emerald-500/20 placeholder:text-muted-foreground/30 font-medium"
                        />
                    </div>

                    {/* Action Buttons */}
                    <div className="flex flex-col gap-3">
                        <Button
                            data-tour-id="tutorial-pos-print-receipt"
                            size="lg"
                            className={cn(
                                "w-full text-lg h-14 rounded-xl transition-all active:scale-95 group",
                                isPrintDisabled
                                    ? "bg-muted text-muted-foreground border border-border shadow-none cursor-not-allowed hover:bg-muted"
                                    : "bg-[#23c55e] hover:bg-[#1ea34d] text-white shadow-lg shadow-green-500/20"
                            )}
                            onClick={handlePrintAndUpload}
                            disabled={isPrintDisabled}
                        >
                            <Printer className={cn("w-6 h-6 mr-3 transition-transform", !isPrintDisabled && "group-hover:rotate-12")} />
                            {isProcessing || isLoadingPrimaryReceiptTemplate ? t('common.loading') : t('pos.printReceipt')}
                        </Button>

                        <Button
                            data-tour-id="tutorial-pos-success-continue"
                            variant="outline"
                            size="lg"
                            className="w-full text-lg h-14 border-2 rounded-xl hover:bg-gray-50 dark:hover:bg-slate-800 transition-all active:scale-95"
                            onClick={onClose}
                            disabled={isProcessing}
                        >
                            {t('pos.continueSale')}
                        </Button>
                    </div>
                </div>

            </DialogContent>
        </Dialog>
    )
}
