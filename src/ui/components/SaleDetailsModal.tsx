import { useState, useMemo } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { Sale, SaleItem } from '@/types'
import { formatCurrency, formatDate, formatDateTime, formatSnapshotTime, cn, formatSaleDetailsForWhatsApp } from '@/lib/utils'
import { getLoanDetailsPath } from '@/lib/loanPresentation'
import { localizeReturnReason } from '@/lib/returnReasons'
import { whatsappManager } from '@/lib/whatsappWebviewManager'
import { WhatsAppNumberInputModal } from '@/ui/components/modals/WhatsAppNumberInputModal'
import { PartialReturnInfoModal } from '@/ui/components/PartialReturnInfoModal'
import { useTheme } from '@/ui/components/theme-provider'
import { type Loan, useLoanBySaleId, usePriceBookCatalogState } from '@/local-db'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Button,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    TooltipProvider
} from '@/ui/components'
import { RotateCcw, ArrowRight, ArrowRightLeft, XCircle, MessageCircle, CircleDollarSign, TrendingUp, Download, CircleAlert, BookOpen } from 'lucide-react'
import { isMobile } from '@/lib/platform'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useHideCosts } from '@/permissions'

type EffectiveLoanStatus = 'pending' | 'active' | 'overdue' | 'completed'

function resolveEffectiveLoanStatus(loan: Loan | undefined): EffectiveLoanStatus {
    if (!loan) return 'pending'
    if (loan.balanceAmount <= 0) return 'completed'
    const today = new Date().toISOString().slice(0, 10)
    if (loan.nextDueDate && loan.nextDueDate < today) return 'overdue'
    return 'active'
}

function getLoanStatusLabelKey(status: EffectiveLoanStatus): string {
    if (status === 'active') return 'sales.loanActive'
    if (status === 'overdue') return 'sales.loanOverdue'
    if (status === 'completed') return 'sales.loanCompleted'
    return 'sales.loanPending'
}

function getLoanStatusFallbackLabel(status: EffectiveLoanStatus): string {
    if (status === 'active') return 'Loan Active'
    if (status === 'overdue') return 'Loan Overdue'
    if (status === 'completed') return 'Loan Completed'
    return 'Loan Pending'
}

function getLoanStatusChipClass(status: EffectiveLoanStatus, neoStyle: boolean): string {
    const base = neoStyle ? "rounded-[var(--radius)]" : "rounded-full"
    if (status === 'overdue') return `${base} bg-destructive/10 text-destructive border border-destructive/20`
    if (status === 'completed') return `${base} bg-blue-500/10 text-blue-600 dark:text-blue-300 border border-blue-500/20`
    if (status === 'active') return `${base} bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20`
    return `${base} bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/20`
}

interface SaleDetailsModalProps {
    sale: Sale | null
    isOpen: boolean
    onClose: () => void
    onReturnItem?: (item: SaleItem) => void
    onExchangeItem?: (item: SaleItem) => void
    onReturnSale?: (sale: Sale) => void
    onDownloadInvoice?: (sale: Sale) => void
}

export function SaleDetailsModal({ sale, isOpen, onClose, onReturnItem, onExchangeItem, onReturnSale, onDownloadInvoice }: SaleDetailsModalProps) {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const hideCosts = useHideCosts()
    const { features, hasCapability } = useWorkspace()
    const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)
    const [partialReturnItem, setPartialReturnItem] = useState<SaleItem | null>(null)
    const [, setLocation] = useLocation()
    const { style } = useTheme()
    const linkedLoan = useLoanBySaleId(sale?.id, user?.workspaceId)
    const priceBookCatalog = usePriceBookCatalogState(user?.workspaceId, { enabled: !!user?.workspaceId })
    const priceBookNameById = useMemo(() => {
        const map = new Map<string, string>()
        for (const priceBook of priceBookCatalog.priceBooks) {
            if (!priceBook.isDeleted) {
                map.set(priceBook.id, priceBook.name)
            }
        }
        return map
    }, [priceBookCatalog.priceBooks])
    const canUseMultiCurrency = hasCapability('multiCurrency')
    const canUseWhatsApp = hasCapability('whatsappSharing')
    const canDownloadInvoice = hasCapability('pdfInvoiceGeneration')

    const handleShareOnWhatsApp = (phone: string, dialogLanguage: string) => {
        if (!sale) return
        const translator = i18n.getFixedT(dialogLanguage)
        const text = formatSaleDetailsForWhatsApp(sale, translator)
        void whatsappManager.openChat(phone, text).catch((error) => {
            console.error('[Sales] Failed to open WhatsApp chat:', error)
        })
        setLocation('/whatsapp')
    }

    if (!sale) return null

    const isFullyReturned = sale.is_returned || (sale.items && sale.items.length > 0 && sale.items.every(item =>
        item.is_returned || (item.returned_quantity || 0) >= item.quantity
    ))

    const returnedItemsCount = sale.items?.filter(item => item.is_returned).length || 0
    const partialReturnedItemsCount = sale.items?.filter(item => (item.returned_quantity || 0) > 0 && !item.is_returned).length || 0
    const hasAnyReturn = returnedItemsCount > 0 || partialReturnedItemsCount > 0
    const localizedReturnReason = localizeReturnReason(
        sale.return_reason,
        i18n,
        i18n.language,
        t('invoice.refund.notProvided') || 'Not provided'
    )

    const hasPriceBookItems = sale.items?.some((item) => Boolean(item.price_book_id)) ?? false

    const netTotal = (() => {
        if (sale.is_returned) return 0
        if (sale.items && sale.items.length > 0) {
            const allItemsReturned = sale.items.every(item =>
                item.is_returned || (item.returned_quantity || 0) >= item.quantity
            )
            if (allItemsReturned) return 0

            return sale.items.reduce((sum, item) => {
                const quantity = item.quantity || 0
                const returnedQty = item.returned_quantity || 0
                const remainingQty = Math.max(0, quantity - returnedQty)

                if (remainingQty <= 0) return sum

                const unitPrice = item.converted_unit_price || item.unit_price || 0
                return sum + (unitPrice * remainingQty)
            }, 0)
        }
        return sale.total_amount
    })()

    const displayCurrency = (sale.settlement_currency || 'usd') as any

    const hasExchange = sale.items?.some(item =>
        item.original_currency &&
        item.settlement_currency &&
        item.original_currency !== item.settlement_currency
    ) ?? false
    const hasExchangeSnapshot = (sale.exchange_rates?.length || 0) > 0

    const isLoanSale = sale.payment_method === 'loan'
    const loanStatus = resolveEffectiveLoanStatus(linkedLoan)
    const loanStatusLabel = t(getLoanStatusLabelKey(loanStatus)) || getLoanStatusFallbackLabel(loanStatus)
    const loanStatusClass = getLoanStatusChipClass(loanStatus, style === 'neo-orange')
    const loanBalanceLabel = t('sales.loanBalance') || 'Balance'
    const loanNextDueLabel = t('sales.loanNextDue') || 'Next Due'
    const loanSourceLabel = t('loans.source') || 'Source'
    const loanPendingMessage = t('sales.loanPendingMessage') || 'Loan record pending sync/link'
    const loanBalanceValue = linkedLoan
        ? formatCurrency(linkedLoan.balanceAmount, linkedLoan.settlementCurrency, features.iqd_display_preference)
        : '-'
    const loanNextDueValue = linkedLoan?.nextDueDate ? formatDate(linkedLoan.nextDueDate) : '-'
    const loanSourceValue = linkedLoan?.source === 'pos' ? 'POS' : (t('common.manual') || 'Manual')

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className={cn(
                "w-[95vw] sm:w-full max-w-3xl md:max-w-4xl lg:max-w-5xl max-h-[90vh] overflow-y-auto",
                "p-0 gap-0 rounded-lg border border-border shadow-xl bg-card",
                style === 'neo-orange' && "neo-border rounded-none"
            )}>
                {/* ═══════════════ HEADER ═══════════════ */}
                <DialogHeader className="p-6 pb-4 bg-card rounded-t-lg">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                            <CircleDollarSign className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <DialogTitle className={cn(
                                "text-lg font-bold leading-tight text-primary",
                                style === 'neo-orange' && "neo-title"
                            )}>
                                {t('sales.details') || 'Sale Details'}
                            </DialogTitle>
                            {canUseMultiCurrency && (hasExchange || hasExchangeSnapshot) && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                    {t('sales.multiCurrencyTransaction') || 'Multi-Currency Transaction'}
                                </p>
                            )}
                        </div>
                    </div>
                </DialogHeader>

                {/* ═══════════════ STATUS BANNERS ═══════════════ */}
                {/* ═══════════════ INFO BAR (Merged with Header) ═══════════════ */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 px-6 pb-6 pt-2 bg-card border-b border-border">
                    <div>
                        <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                            {t('sales.id') || 'Sale ID'}
                        </div>
                        <div className="font-bold text-sm mt-0.5 font-mono">
                            {sale.sequenceId
                                ? (sale._orderNumber || `#SALE-${sale.sequenceId}`)
                                : `#${sale.id.slice(0, 8)}`}
                        </div>
                    </div>
                    <div>
                        <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                            {t('sales.date') || 'Date'}
                        </div>
                        <div className="font-medium text-sm mt-0.5">
                            {formatDateTime(sale.created_at)}
                        </div>
                    </div>
                    <div>
                        <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                            {t('sales.cashier') || 'Cashier'}
                        </div>
                        <div className="font-medium text-sm mt-0.5">
                            {sale.cashier_name || 'Staff'}
                        </div>
                    </div>
                    <div>
                        <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                            {t('pos.paymentMethod') || 'Payment Method'}
                        </div>
                        <div className="font-medium text-sm mt-0.5 flex items-center gap-1.5">
                            {sale.payment_method === 'fib' && (
                                <>
                                    <img src="./icons/fib.svg" alt="FIB" className="w-4 h-4 rounded" />
                                    <span>FIB</span>
                                </>
                            )}
                            {sale.payment_method === 'qicard' && (
                                <>
                                    <img src="./icons/qi.svg" alt="QiCard" className="w-4 h-4 rounded" />
                                    <span>QiCard</span>
                                </>
                            )}
                            {sale.payment_method === 'zaincash' && (
                                <>
                                    <img src="./icons/zain.svg" alt="ZainCash" className="w-4 h-4 rounded" />
                                    <span>ZainCash</span>
                                </>
                            )}
                            {sale.payment_method === 'fastpay' && (
                                <>
                                    <img src="./icons/fastpay.svg" alt="FastPay" className="w-4 h-4 rounded" />
                                    <span>FastPay</span>
                                </>
                            )}
                            {sale.payment_method === 'loan' && (
                                <span>{t('pos.loan') || 'Loan'}</span>
                            )}
                            {(!sale.payment_method || sale.payment_method === 'cash') && (
                                <span>{t('pos.cash') || 'Cash'} ({(sale.settlement_currency || 'USD').toUpperCase()})</span>
                            )}
                        </div>
                    </div>
                </div>

                {/* ═══════════════ CONTENT ═══════════════ */}
                <div className="px-6 py-4 space-y-4">
                    {isLoanSale && (
                        <div className={cn(
                            "p-3 border rounded-xl",
                            loanStatus === 'overdue' ? "bg-destructive/5 border-destructive/20" : "bg-secondary/20 border-border"
                        )}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                                        {t('sales.loanStatus') || 'Loan Status'}
                                    </span>
                                    <span className={cn("px-2 py-0.5 text-[10px] font-bold uppercase", loanStatusClass)}>
                                        {loanStatusLabel}
                                    </span>
                                </div>
                                {linkedLoan && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        allowViewer={true}
                                        className="h-7 px-2 text-[10px] font-semibold"
                                        onClick={() => {
                                            onClose()
                                            setLocation(getLoanDetailsPath(linkedLoan, linkedLoan.id))
                                        }}
                                    >
                                        {t('sales.openLoan') || 'Open Loan'}
                                        <ArrowRight className="w-3 h-3 ml-1" />
                                    </Button>
                                )}
                            </div>

                            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <div className="rounded-lg border border-border/70 bg-background/50 px-2.5 py-2">
                                    <div className="text-[10px] uppercase font-semibold tracking-wide text-muted-foreground">
                                        {loanBalanceLabel}
                                    </div>
                                    <div className="mt-0.5 text-xs font-bold">{loanBalanceValue}</div>
                                </div>
                                <div className="rounded-lg border border-border/70 bg-background/50 px-2.5 py-2">
                                    <div className="text-[10px] uppercase font-semibold tracking-wide text-muted-foreground">
                                        {loanNextDueLabel}
                                    </div>
                                    <div className="mt-0.5 text-xs font-bold">{loanNextDueValue}</div>
                                </div>
                                {linkedLoan && (
                                    <div className="rounded-lg border border-border/70 bg-background/50 px-2.5 py-2">
                                        <div className="text-[10px] uppercase font-semibold tracking-wide text-muted-foreground">
                                            {loanSourceLabel}
                                        </div>
                                        <div className="mt-0.5 text-xs font-bold">{loanSourceValue}</div>
                                    </div>
                                )}
                            </div>

                            {!linkedLoan && (
                                <p className="mt-2 text-xs text-muted-foreground">
                                    {loanPendingMessage}
                                </p>
                            )}
                        </div>
                    )}

                    {/* ─── Status Banners ─── */}
                    <div className="space-y-2">
                        {sale.currency_conversion_applied === false && (
                            <div className="relative p-3 overflow-hidden bg-sky-500/10 border border-sky-500/20 rounded-xl">
                                <div className="flex items-start gap-3 relative z-10">
                                    <div className="p-2 rounded-lg bg-sky-500/20 text-sky-700 dark:text-sky-300">
                                        <CircleAlert className="w-4 h-4" />
                                    </div>
                                    <div className="space-y-0.5">
                                        <span className="font-black text-[10px] block uppercase tracking-[0.1em] text-sky-700 dark:text-sky-300">
                                            {t('sales.currencyConversionDisabled', 'Currency conversion disabled')}
                                        </span>
                                        <p className="text-xs font-medium text-sky-950/80 dark:text-sky-100/80">
                                            {t('sales.currencyConversionDisabledDescription', 'This sale was recorded in its product currency without conversion to the workspace currency.')}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {sale.system_review_status === 'flagged' && (
                            <div className="relative p-3 overflow-hidden bg-orange-500/10 border border-orange-500/20 rounded-xl">
                                <div className="flex items-start gap-3 relative z-10">
                                    <div className="p-2 rounded-lg bg-orange-500/20 text-orange-600 dark:text-orange-400">
                                        <span className="text-base">⚠️</span>
                                    </div>
                                    <div className="space-y-0.5">
                                        <span className="font-black text-[10px] block uppercase tracking-[0.1em] text-orange-600 dark:text-orange-400">
                                            {t('sales.flagged') || 'System Review Flagged'}
                                        </span>
                                        <p className="text-xs font-medium text-orange-950/80 dark:text-orange-200/80">
                                            {sale.system_review_reason || 'Inconsistent checkout data detected.'}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {isFullyReturned && (
                            <div className="relative p-3 overflow-hidden bg-destructive/10 border border-destructive/20 rounded-xl">
                                <div className="flex items-center gap-3 relative z-10 text-destructive dark:text-destructive-foreground">
                                    <div className="p-2 rounded-lg bg-destructive/20 flex items-center justify-center">
                                        <XCircle className="w-5 h-5" />
                                    </div>
                                    <div className="space-y-0.5">
                                        <span className="font-black text-[10px] block uppercase tracking-[0.1em]">
                                            {t('sales.return.returnedStatus') || 'Fully Returned'}
                                        </span>
                                        <p className="text-xs font-bold">
                                            {t('sales.return.returnedMessage') || 'This sale has been returned'}
                                        </p>
                                        <div className="flex flex-col gap-0.5 opacity-80">
                                            {sale.return_reason && (
                                                <p className="text-[10px] font-semibold">
                                                    {t('sales.return.reason') || 'Reason'}: {localizedReturnReason}
                                                </p>
                                            )}
                                            {sale.returned_at && (
                                                <p className="text-[9px] font-medium opacity-60">
                                                    {t('sales.return.returnedAt') || 'Returned at'}: {formatDateTime(sale.returned_at)}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {!isFullyReturned && hasAnyReturn && (
                            <div className="p-2.5 bg-orange-500/10 border border-orange-500/20 rounded-xl flex items-center gap-3">
                                <div className="p-1.5 rounded-lg bg-orange-500/20 text-orange-600 dark:text-orange-400">
                                    <RotateCcw className="w-3.5 h-3.5" />
                                </div>
                                <span className="font-bold text-[10px] uppercase tracking-wide text-orange-600 dark:text-orange-400">
                                    {t('sales.return.partialReturnDetected') || 'This sale has partial returns.'}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* ─── Market Rates Snapshot ─── */}
                    {canUseMultiCurrency && hasExchangeSnapshot && sale.exchange_rates && (
                        <div className={cn(
                            "border border-primary/10 rounded-md p-4 space-y-3 bg-primary/5",
                            style === 'neo-orange' && "snapshot-neo"
                        )}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <TrendingUp className="w-4 h-4 text-primary" />
                                    <span className="text-[10px] uppercase font-black tracking-[0.15em] text-primary">
                                        {t('sales.marketRatesSnapshot') || 'Market Rates Snapshot'}
                                    </span>
                                </div>
                                <span className="text-[10px] text-muted-foreground italic">
                                    {t('sales.ratesLockedAt') || 'Rates locked at'}: {formatSnapshotTime(sale.exchange_rates[0]?.timestamp)}
                                </span>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                {sale.exchange_rates.map((rate: any, idx: number) => (
                                    <div key={idx} className="bg-card border border-primary/10 shadow-sm rounded-sm p-3 space-y-1 relative overflow-hidden">
                                        {/* Source Badge */}
                                        {rate.source && (
                                            <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-primary/10 text-primary text-[8px] font-bold uppercase tracking-wider rounded-bl-sm border-l border-b border-primary/5">
                                                {rate.source}
                                            </div>
                                        )}

                                        <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                                            {rate.pair}
                                        </div>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-base font-black">
                                                {rate.priceBasisAmount || 100} {rate.pair.split('/')[0]}
                                            </span>
                                            <span className="text-sm text-muted-foreground font-medium">
                                                {formatCurrency(rate.rate, rate.pair.split('/')[1].toLowerCase() as any, features.iqd_display_preference)}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ─── Items Table ─── */}
                    <div className="border border-primary/10 rounded-md overflow-hidden bg-card">
                        {isMobile() ? (
                            /* ═══ MOBILE CARD LAYOUT ═══ */
                            <div className="divide-y divide-border">
                                {sale.items?.map((item) => {
                                    const isItemReturned = item.is_returned || sale.is_returned
                                    const hasItemPartialReturn = (item.returned_quantity || 0) > 0 && !item.is_returned
                                    const displayUnitPrice = item.converted_unit_price || item.unit_price || 0
                                    const itemDisplayCurrency = (sale.settlement_currency || 'usd') as any
                                    const netQuantity = item.quantity - (item.returned_quantity || 0)

                                    const hasNegotiated = item.negotiated_price !== undefined && item.negotiated_price !== null && item.negotiated_price > 0
                                    const originalUnitPrice = item.original_unit_price || item.unit_price || 0
                                    const originalCurrency = (item.original_currency || 'usd') as any
                                    const negotiatedPrice = item.negotiated_price || 0
                                    const isConverted = item.original_currency && item.settlement_currency && item.original_currency !== item.settlement_currency

                                    return (
                                        <div
                                            key={item.id}
                                            className={cn(
                                                "p-4 space-y-3 transition-colors duration-200",
                                                isItemReturned ? 'bg-destructive/5 border-l-4 border-destructive' :
                                                    hasItemPartialReturn ? 'bg-orange-500/5 border-l-4 border-orange-500' :
                                                        'border-l-4 border-transparent'
                                            )}
                                        >
                                            <div className="flex justify-between items-start gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <div className={cn("font-bold text-sm", isItemReturned && "line-through opacity-50")}>
                                                            {item.product_name}
                                                        </div>
                                                        {item.price_book_id && (
                                                            <span className="inline-flex items-center gap-1 text-[8px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded leading-none whitespace-nowrap">
                                                                <BookOpen className="w-2.5 h-2.5 shrink-0" />
                                                                {priceBookNameById.get(item.price_book_id) || t('priceBooks.unavailable', { defaultValue: 'Unavailable Price Book' })}
                                                            </span>
                                                        )}
                                                        {item.batch_allocations && item.batch_allocations.length > 0 && (
                                                            <TooltipProvider>
                                                                <Tooltip delayDuration={200}>
                                                                    <TooltipTrigger asChild>
                                                                        <span className="inline-flex items-center gap-1 text-[8px] font-mono font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded cursor-default leading-none border-b border-dashed border-amber-600/40 dark:border-amber-400/40">
                                                                            {item.batch_allocations.map(a => a.batch_number.slice(0, 10)).join(', ')}
                                                                        </span>
                                                                    </TooltipTrigger>
                                                                    <TooltipContent side="top" align="start" className="max-w-[260px] p-3 space-y-2">
                                                                        <div className="text-xs font-bold text-foreground">{t('sales.batchSnapshot') || 'Batch Snapshot'}</div>
                                                                        <div className="space-y-1.5">
                                                                            {item.batch_allocations.map((a, i) => (
                                                                                <div key={a.batch_id} className={cn("text-[11px] space-y-0.5", i > 0 && "pt-1.5 border-t border-border/50")}>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('sales.batchNumber') || 'Batch'}:</span>
                                                                                        <span className="font-medium text-foreground text-right">{a.batch_number}</span>
                                                                                    </div>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('common.id') || 'ID'}:</span>
                                                                                        <span className="font-mono text-[10px] text-foreground text-right break-all">{a.batch_id}</span>
                                                                                    </div>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('common.quantity') || 'Quantity'}:</span>
                                                                                        <span className="font-medium text-foreground text-right">{a.quantity}</span>
                                                                                    </div>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('products.form.price') || 'Selling Price'}:</span>
                                                                                        <span className="font-medium text-foreground text-right">
                                                                                            {a.price == null
                                                                                                ? '—'
                                                                                                : formatCurrency(a.price, a.currency || item.original_currency || 'usd', features.iqd_display_preference)}
                                                                                        </span>
                                                                                    </div>
                                                                                    <div className={hideCosts ? 'hidden' : 'flex justify-between gap-2'}>
                                                                                        <span className="text-muted-foreground">{t('products.form.cost') || 'Cost Price'}:</span>
                                                                                        <span className="font-medium text-foreground text-right">
                                                                                            {a.cost_price == null
                                                                                                ? '—'
                                                                                                : formatCurrency(a.cost_price, a.currency || item.original_currency || 'usd', features.iqd_display_preference)}
                                                                                        </span>
                                                                                    </div>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('common.currency') || 'Currency'}:</span>
                                                                                        <span className="font-medium text-foreground text-right uppercase">{a.currency || item.original_currency || 'usd'}</span>
                                                                                    </div>
                                                                                    {a.manufacturing_date && (
                                                                                        <div className="flex justify-between gap-2">
                                                                                            <span className="text-muted-foreground">{t('products.manufacturingDate') || 'Mfg'}:</span>
                                                                                            <span className="font-medium text-foreground text-right">{formatDate(a.manufacturing_date)}</span>
                                                                                        </div>
                                                                                    )}
                                                                                    {a.expiry_date && (
                                                                                        <div className="flex justify-between gap-2">
                                                                                            <span className="text-muted-foreground">{t('products.expiryDate') || 'Expiry'}:</span>
                                                                                            <span className="font-medium text-foreground text-right">{formatDate(a.expiry_date)}</span>
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    </TooltipContent>
                                                                </Tooltip>
                                                            </TooltipProvider>
                                                        )}
                                                        {!isItemReturned && !item.is_returned && onReturnItem && (user?.role === 'admin' || user?.role === 'staff') && (
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={(e) => { e.stopPropagation(); onReturnItem(item) }}
                                                                className="h-6 w-6 p-0 text-muted-foreground hover:text-orange-600 hover:bg-orange-50 rounded-lg"
                                                            >
                                                                <RotateCcw className="h-3 w-3" />
                                                            </Button>
                                                        )}
                                                        {!isItemReturned && !item.is_returned && netQuantity > 0 && sale.origin === 'pos' && onExchangeItem && (user?.role === 'admin' || user?.role === 'staff') && (
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={(e) => { e.stopPropagation(); onExchangeItem(item) }}
                                                                className="h-6 gap-1 px-2 text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg"
                                                                title={t('sales.exchange.title', { defaultValue: 'Product Exchange' })}
                                                            >
                                                                <ArrowRightLeft className="h-3 w-3" />
                                                                {t('sales.exchange.action', { defaultValue: 'Exchange' })}
                                                            </Button>
                                                        )}
                                                        {hasNegotiated && (
                                                            <span className="inline-flex items-center px-1.5 py-0.5 text-[8px] font-bold bg-emerald-500/15 text-emerald-600 rounded whitespace-nowrap leading-none">
                                                                {t('pos.negotiatedPrice') || 'Negotiated Price'}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-[10px] text-muted-foreground font-mono">{item.product_sku}</div>
                                                </div>
                                                <div className="flex gap-1 shrink-0">
                                                    {isItemReturned && (
                                                        <span className="px-1.5 py-0.5 text-[8px] font-black bg-destructive/10 text-destructive rounded-full uppercase">
                                                            {t('sales.return.returnedStatus')}
                                                        </span>
                                                    )}
                                                    {isItemReturned && !hasItemPartialReturn && (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); setPartialReturnItem(item) }}
                                                            className="h-5 w-5 p-0 inline-flex items-center justify-center text-destructive hover:text-destructive/70 hover:bg-destructive/10 rounded-full transition-colors"
                                                            title={t('sales.return.returnedInfo') || 'Return Information'}
                                                        >
                                                            <CircleAlert className="h-3.5 w-3.5" />
                                                        </button>
                                                    )}
                                                    {hasItemPartialReturn && !isItemReturned && (
                                                        <span className="px-1.5 py-0.5 text-[8px] font-black bg-orange-500/10 text-orange-600 rounded-full uppercase">
                                                            {t('sales.return.partialReturn')}
                                                        </span>
                                                    )}
                                                    {hasItemPartialReturn && !isItemReturned && (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); setPartialReturnItem(item) }}
                                                            className="h-5 w-5 p-0 inline-flex items-center justify-center text-orange-600 hover:text-orange-700 hover:bg-orange-100 rounded-full transition-colors"
                                                            title={t('sales.return.partialReturnInfo') || 'Partial Return Information'}
                                                        >
                                                            <CircleAlert className="h-3.5 w-3.5" />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-2 gap-4 mt-2">
                                                <div className="space-y-1">
                                                    <div className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight">
                                                        {t('common.quantity')}
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <div className="flex items-baseline gap-1.5">
                                                            <span className={cn("text-base font-black", isItemReturned && "line-through opacity-50")}>
                                                                {netQuantity}
                                                                {(item.selling_unit_code || item.product?.unit) ? ' ' + t(`products.units.${item.selling_unit_code || item.product?.unit}` as any, item.selling_unit_code || item.product?.unit || '') : ''}
                                                            </span>
                                                            {(hasItemPartialReturn || isItemReturned) && (
                                                                <span className="text-[10px] text-muted-foreground opacity-60 line-through">
                                                                    {item.quantity}
                                                                    {(item.selling_unit_code || item.product?.unit) ? ' ' + t(`products.units.${item.selling_unit_code || item.product?.unit}` as any, item.selling_unit_code || item.product?.unit || '') : ''}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {hasItemPartialReturn && !isItemReturned && (
                                                            <div className="text-[9px] text-orange-600 font-bold leading-none mt-0.5">
                                                                -{item.returned_quantity} {t('sales.return.returnedLabel') || 'returned'}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="space-y-1">
                                                    <div className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight text-right">
                                                        {t('common.price')}
                                                    </div>
                                                    <div className="flex flex-col items-end">
                                                        <span className={cn(
                                                            "text-sm font-bold",
                                                            hasNegotiated ? "text-emerald-600" : "text-foreground",
                                                            isItemReturned && "opacity-50"
                                                        )}>
                                                            {formatCurrency(displayUnitPrice, itemDisplayCurrency, features.iqd_display_preference)}
                                                        </span>
                                                        {hasNegotiated && (
                                                            <div className="flex items-center justify-end gap-1 text-[9px] text-muted-foreground opacity-60 mt-0.5">
                                                                <span className="line-through">{formatCurrency(originalUnitPrice, originalCurrency, features.iqd_display_preference)}</span>
                                                                <ArrowRight className="w-2 h-2" />
                                                                <span className="font-bold">{formatCurrency(negotiatedPrice, originalCurrency, features.iqd_display_preference)}</span>
                                                            </div>
                                                        )}
                                                        {!hasNegotiated && isConverted && (
                                                            <span className="text-[9px] text-muted-foreground line-through opacity-60 mt-0.5">
                                                                {formatCurrency(originalUnitPrice, originalCurrency, features.iqd_display_preference)}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex flex-col gap-1 pt-2 border-t border-border">
                                                <div className="flex justify-between items-center">
                                                    <div className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight">
                                                        {t('common.total')}
                                                    </div>
                                                    <div className={cn("text-base font-black text-primary", isItemReturned && "line-through opacity-50")}>
                                                        {formatCurrency(displayUnitPrice * netQuantity, itemDisplayCurrency, features.iqd_display_preference)}
                                                    </div>
                                                </div>
                                                {(hasNegotiated || isConverted) && (
                                                    <div className="flex justify-end mt-[-4px]">
                                                        {hasNegotiated ? (
                                                            <div className={cn("flex items-center justify-end gap-1 text-[9px] text-muted-foreground opacity-60", isItemReturned && "opacity-30")}>
                                                                <span className="line-through">{formatCurrency(originalUnitPrice * netQuantity, originalCurrency, features.iqd_display_preference)}</span>
                                                                <ArrowRight className="w-2 h-2" />
                                                                <span className="font-bold">{formatCurrency(negotiatedPrice * netQuantity, originalCurrency, features.iqd_display_preference)}</span>
                                                            </div>
                                                        ) : (
                                                            <span className={cn("text-[9px] text-muted-foreground line-through opacity-50", isItemReturned && "opacity-30")}>
                                                                {formatCurrency(originalUnitPrice * netQuantity, originalCurrency, features.iqd_display_preference)}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        ) : (
                            /* ═══ DESKTOP TABLE ═══ */
                            <Table>
                                <TableHeader>
                                    <TableRow className={cn(
                                        "border-b border-primary/10 bg-primary/5",
                                        style === 'neo-orange' && "table-header-neo"
                                    )}>
                                        <TableHead className="text-start text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{t('products.table.name') || 'Product'}</TableHead>
                                        {hasPriceBookItems && (
                                            <TableHead className="text-start text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{t('priceBooks.titleSingular') || 'Price Book'}</TableHead>
                                        )}
                                        <TableHead className="text-start text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{t('products.table.sku') || 'SKU'}</TableHead>
                                        <TableHead className="text-center text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{t('common.quantity') || 'QTY'}</TableHead>
                                        <TableHead className="text-end text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{t('common.price') || 'Unit Price'}</TableHead>
                                        <TableHead className="text-end text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{t('common.total') || 'Total'}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {sale.items?.map((item) => {
                                        const isConverted = item.original_currency && item.settlement_currency && item.original_currency !== item.settlement_currency
                                        const hasNegotiated = item.negotiated_price !== undefined && item.negotiated_price !== null && item.negotiated_price > 0
                                        const isItemReturned = item.is_returned || sale.is_returned
                                        const hasItemPartialReturn = (item.returned_quantity || 0) > 0 && !item.is_returned

                                        const displayUnitPrice: number = item.converted_unit_price || item.unit_price || 0
                                        const itemDisplayCurrency: string = sale.settlement_currency || 'usd'

                                        const originalUnitPrice = item.original_unit_price || item.unit_price || 0
                                        const originalCurrency = item.original_currency || 'usd'
                                        const negotiatedPrice = item.negotiated_price || 0

                                        const netQuantity = item.quantity - (item.returned_quantity || 0)

                                        return (
                                            <TableRow
                                                key={item.id}
                                                className={cn(
                                                    "transition-colors duration-200 border-b border-border/30",
                                                    isItemReturned ? 'bg-destructive/5 opacity-80' :
                                                        hasItemPartialReturn ? 'bg-orange-500/5' :
                                                            'hover:bg-muted/30'
                                                )}
                                            >
                                                {/* Product Name */}
                                                <TableCell className="text-start">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <div className={cn("font-medium text-sm", isItemReturned && "line-through opacity-50")}>
                                                            {item.product_name}
                                                        </div>
                                                        {item.batch_allocations && item.batch_allocations.length > 0 && (
                                                            <TooltipProvider>
                                                                <Tooltip delayDuration={200}>
                                                                     <TooltipTrigger asChild>
                                                                        <span className="inline-flex items-center gap-1 text-[9px] font-mono font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded cursor-default leading-none border-b border-dashed border-amber-600/40 dark:border-amber-400/40">
                                                                            {item.batch_allocations.map(a => a.batch_number.slice(0, 10)).join(', ')}
                                                                        </span>
                                                                    </TooltipTrigger>
                                                                    <TooltipContent side="top" align="start" className="max-w-[260px] p-3 space-y-2">
                                                                        <div className="text-xs font-bold text-foreground">{t('sales.batchSnapshot') || 'Batch Snapshot'}</div>
                                                                        <div className="space-y-1.5">
                                                                            {item.batch_allocations.map((a, i) => (
                                                                                <div key={a.batch_id} className={cn("text-[11px] space-y-0.5", i > 0 && "pt-1.5 border-t border-border/50")}>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('sales.batchNumber') || 'Batch'}:</span>
                                                                                        <span className="font-medium text-foreground text-right">{a.batch_number}</span>
                                                                                    </div>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('common.id') || 'ID'}:</span>
                                                                                        <span className="font-mono text-[10px] text-foreground text-right break-all">{a.batch_id}</span>
                                                                                    </div>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('common.quantity') || 'Quantity'}:</span>
                                                                                        <span className="font-medium text-foreground text-right">{a.quantity}</span>
                                                                                    </div>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('products.form.price') || 'Selling Price'}:</span>
                                                                                        <span className="font-medium text-foreground text-right">
                                                                                            {a.price == null
                                                                                                ? '—'
                                                                                                : formatCurrency(a.price, a.currency || item.original_currency || 'usd', features.iqd_display_preference)}
                                                                                        </span>
                                                                                    </div>
                                                                                    <div className={hideCosts ? 'hidden' : 'flex justify-between gap-2'}>
                                                                                        <span className="text-muted-foreground">{t('products.form.cost') || 'Cost Price'}:</span>
                                                                                        <span className="font-medium text-foreground text-right">
                                                                                            {a.cost_price == null
                                                                                                ? '—'
                                                                                                : formatCurrency(a.cost_price, a.currency || item.original_currency || 'usd', features.iqd_display_preference)}
                                                                                        </span>
                                                                                    </div>
                                                                                    <div className="flex justify-between gap-2">
                                                                                        <span className="text-muted-foreground">{t('common.currency') || 'Currency'}:</span>
                                                                                        <span className="font-medium text-foreground text-right uppercase">{a.currency || item.original_currency || 'usd'}</span>
                                                                                    </div>
                                                                                    {a.manufacturing_date && (
                                                                                        <div className="flex justify-between gap-2">
                                                                                            <span className="text-muted-foreground">{t('products.manufacturingDate') || 'Mfg'}:</span>
                                                                                            <span className="font-medium text-foreground text-right">{formatDate(a.manufacturing_date)}</span>
                                                                                        </div>
                                                                                    )}
                                                                                    {a.expiry_date && (
                                                                                        <div className="flex justify-between gap-2">
                                                                                            <span className="text-muted-foreground">{t('products.expiryDate') || 'Expiry'}:</span>
                                                                                            <span className="font-medium text-foreground text-right">{formatDate(a.expiry_date)}</span>
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    </TooltipContent>
                                                                </Tooltip>
                                                            </TooltipProvider>
                                                        )}
                                                        {!isItemReturned && !item.is_returned && onReturnItem && (user?.role === 'admin' || user?.role === 'staff') && (
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={(e) => { e.stopPropagation(); onReturnItem(item) }}
                                                                className="h-6 w-6 p-0 text-muted-foreground hover:text-orange-600 hover:bg-orange-50"
                                                                title={t('sales.return.returnItem') || 'Return Item'}
                                                            >
                                                                <RotateCcw className="h-3 w-3" />
                                                            </Button>
                                                        )}
                                                        {!isItemReturned && !item.is_returned && netQuantity > 0 && sale.origin === 'pos' && onExchangeItem && (user?.role === 'admin' || user?.role === 'staff') && (
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={(e) => { e.stopPropagation(); onExchangeItem(item) }}
                                                                className="h-6 gap-1 px-2 text-[10px] text-muted-foreground hover:text-primary hover:bg-primary/10"
                                                                title={t('sales.exchange.title', { defaultValue: 'Product Exchange' })}
                                                            >
                                                                <ArrowRightLeft className="h-3 w-3" />
                                                                {t('sales.exchange.action', { defaultValue: 'Exchange' })}
                                                            </Button>
                                                        )}
                                                        {isItemReturned && (
                                                            <span className="px-1.5 py-0.5 text-[9px] font-bold bg-destructive/10 text-destructive rounded-full uppercase">
                                                                {t('sales.return.returnedStatus')}
                                                            </span>
                                                        )}
                                                        {isItemReturned && !hasItemPartialReturn && (
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); setPartialReturnItem(item) }}
                                                                className="h-5 w-5 p-0 inline-flex items-center justify-center text-destructive hover:text-destructive/70 hover:bg-destructive/10 rounded-full transition-colors"
                                                                title={t('sales.return.returnedInfo') || 'Return Information'}
                                                            >
                                                                <CircleAlert className="h-3.5 w-3.5" />
                                                            </button>
                                                        )}
                                                        {hasItemPartialReturn && !isItemReturned && (
                                                            <span className="px-1.5 py-0.5 text-[9px] font-bold bg-orange-500/10 text-orange-600 rounded-full uppercase">
                                                                {t('sales.return.partialReturn')}
                                                            </span>
                                                        )}
                                                        {hasItemPartialReturn && !isItemReturned && (
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); setPartialReturnItem(item) }}
                                                                className="h-5 w-5 p-0 inline-flex items-center justify-center text-orange-600 hover:text-orange-700 hover:bg-orange-100 rounded-full transition-colors"
                                                                title={t('sales.return.partialReturnInfo') || 'Partial Return Information'}
                                                            >
                                                                <CircleAlert className="h-3.5 w-3.5" />
                                                            </button>
                                                        )}
                                                        {hasNegotiated && (
                                                            <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-bold bg-emerald-500/15 text-emerald-600 rounded whitespace-nowrap leading-none">
                                                                {t('pos.negotiatedPrice') || 'Negotiated Price'}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>

                                                {hasPriceBookItems && (
                                                    <TableCell className="text-start">
                                                        {item.price_book_id ? (
                                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded leading-none whitespace-nowrap">
                                                                <BookOpen className="w-3 h-3 shrink-0" />
                                                                {priceBookNameById.get(item.price_book_id) || t('priceBooks.unavailable', { defaultValue: 'Unavailable Price Book' })}
                                                            </span>
                                                        ) : (
                                                            <span className="text-xs text-muted-foreground">—</span>
                                                        )}
                                                    </TableCell>
                                                )}

                                                {/* SKU */}
                                                <TableCell className="text-start">
                                                    <span className="text-xs text-muted-foreground font-mono">{item.product_sku}</span>
                                                </TableCell>

                                                {/* Quantity */}
                                                <TableCell className="text-center font-mono">
                                                    <div className="flex flex-col items-center">
                                                        <span className={cn("text-sm font-semibold", isItemReturned && "line-through opacity-50")}>
                                                            {netQuantity}
                                                            {(item.selling_unit_code || item.product?.unit) ? ' ' + t(`products.units.${item.selling_unit_code || item.product?.unit}` as any, item.selling_unit_code || item.product?.unit || '') : ''}
                                                        </span>
                                                        {hasItemPartialReturn && !isItemReturned && (
                                                            <div className="text-[10px] text-orange-600 font-medium whitespace-nowrap">
                                                                -{item.returned_quantity} {(item.selling_unit_code || item.product?.unit) ? t(`products.units.${item.selling_unit_code || item.product?.unit}` as any, item.selling_unit_code || item.product?.unit || '') + ' ' : ''}{t('sales.return.returnedLabel') || 'returned'}
                                                            </div>
                                                        )}
                                                    </div>
                                                </TableCell>

                                                {/* Unit Price */}
                                                <TableCell className="text-end">
                                                    <div className="flex flex-col items-end">
                                                        <span className={cn(
                                                            hasNegotiated ? "font-medium text-emerald-600" : "font-medium",
                                                            isItemReturned && "opacity-50"
                                                        )}>
                                                            {formatCurrency(displayUnitPrice, itemDisplayCurrency, features.iqd_display_preference)}
                                                        </span>
                                                        {hasNegotiated && (
                                                            <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground opacity-60">
                                                                <span className="line-through">{formatCurrency(originalUnitPrice, originalCurrency, features.iqd_display_preference)}</span>
                                                                <ArrowRight className="w-2.5 h-2.5" />
                                                                <span className="font-bold">{formatCurrency(negotiatedPrice, originalCurrency, features.iqd_display_preference)}</span>
                                                            </div>
                                                        )}
                                                        {!hasNegotiated && isConverted && (
                                                            <span className="text-[10px] text-muted-foreground line-through opacity-60">
                                                                {formatCurrency(originalUnitPrice, originalCurrency, features.iqd_display_preference)}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>

                                                {/* Total */}
                                                <TableCell className="text-end font-bold">
                                                    <div className="flex flex-col items-end">
                                                        <span className={cn(
                                                            hasNegotiated ? "text-emerald-600" : "",
                                                            isItemReturned && "line-through opacity-50"
                                                        )}>
                                                            {formatCurrency(displayUnitPrice * netQuantity, itemDisplayCurrency, features.iqd_display_preference)}
                                                        </span>

                                                        {(hasItemPartialReturn || isItemReturned) && (
                                                            <span className="text-[10px] text-muted-foreground opacity-40 line-through">
                                                                {formatCurrency(displayUnitPrice * item.quantity, itemDisplayCurrency, features.iqd_display_preference)}
                                                            </span>
                                                        )}

                                                        {hasNegotiated && (
                                                            <div className={cn("flex items-center justify-end gap-1 text-[10px] text-muted-foreground opacity-60", isItemReturned && "opacity-30")}>
                                                                <span className="line-through">{formatCurrency(originalUnitPrice * netQuantity, originalCurrency, features.iqd_display_preference)}</span>
                                                                <ArrowRight className="w-2.5 h-2.5" />
                                                                <span className="font-bold">{formatCurrency(negotiatedPrice * netQuantity, originalCurrency, features.iqd_display_preference)}</span>
                                                            </div>
                                                        )}
                                                        {!hasNegotiated && isConverted && (
                                                            <span className={cn("text-[10px] text-muted-foreground line-through opacity-50", isItemReturned && "opacity-30")}>
                                                                {formatCurrency(originalUnitPrice * netQuantity, originalCurrency, features.iqd_display_preference)}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        )}
                    </div>

                    {/* ─── Totals Section ─── */}
                    <div className="flex justify-end">
                        <div className={cn(
                            "border border-primary/10 rounded-md p-4 min-w-[240px] space-y-2 bg-primary/5",
                            style === 'neo-orange' && "neo-border rounded-none"
                        )}>
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-muted-foreground font-medium">{t('sales.subtotal') || 'Subtotal'}</span>
                                <span className="font-semibold tabular-nums">
                                    {formatCurrency(sale.total_amount, displayCurrency, features.iqd_display_preference)}
                                </span>
                            </div>
                            <div className="border-t border-border/50 pt-2 mt-2">
                                <div className="flex justify-between items-center">
                                    <span className="text-sm font-black uppercase tracking-wider">
                                        {t('sales.grandTotal') || 'Grand Total'}
                                    </span>
                                    <span className="text-xl font-black tabular-nums text-primary">
                                        {formatCurrency(netTotal, displayCurrency, features.iqd_display_preference)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* ═══════════════ FOOTER ═══════════════ */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-card rounded-b-lg">
                    <div>
                        {!isFullyReturned && onReturnSale && (user?.role === 'admin' || user?.role === 'staff') && (
                            <button
                                onClick={() => onReturnSale(sale)}
                                className="text-sm font-medium text-muted-foreground hover:text-destructive transition-colors"
                            >
                                {t('sales.returnSale') || 'Return Sale'}
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {canUseWhatsApp && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-2 text-emerald-600 border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-500/10"
                                onClick={() => setShowWhatsAppModal(true)}
                            >
                                <MessageCircle className="w-4 h-4" />
                            </Button>
                        )}
                        {canDownloadInvoice && (
                            <Button
                                size="sm"
                                className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
                                onClick={() => onDownloadInvoice?.(sale)}
                                disabled={!onDownloadInvoice}
                            >
                                <Download className="w-4 h-4" />
                                {t('sales.downloadInvoice') || 'Download Invoice'}
                            </Button>
                        )}
                    </div>
                </div>
            </DialogContent>

            <WhatsAppNumberInputModal
                isOpen={showWhatsAppModal}
                onClose={() => setShowWhatsAppModal(false)}
                onConfirm={handleShareOnWhatsApp}
            />

            <PartialReturnInfoModal
                item={partialReturnItem!}
                isOpen={partialReturnItem !== null}
                onClose={() => setPartialReturnItem(null)}
                settlementCurrency={sale.settlement_currency}
                iqdDisplayPreference={features.iqd_display_preference}
                workspaceId={user?.workspaceId}
                sale={sale}
            />
        </Dialog>
    )
}
