import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Ban, CheckCircle2, CircleDollarSign, CreditCard, FilePenLine, Printer, ReceiptText, RotateCcw, Trash2, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { STATUS_ADVANCE_HOLD_DURATION_MS } from '@/lib/pressAndHold'
import type { TemplatePreview } from '@/lib/printPreviewEditorStore'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import {
    bookTravelBooking,
    cancelTravelBooking,
    deleteTravelBooking,
    getActiveTravelBookingPayments,
    reversePaymentTransaction,
    type PaymentTransaction,
    type TravelBooking,
    type TravelPassenger
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DeleteConfirmationModal,
    PrintPreviewModal,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast
} from '@/ui/components'
import { PressAndHoldButton } from '@/ui/components/PressAndHoldButton'
import { RecordTravelBookingPaymentDialog } from './RecordTravelBookingPaymentDialog'
import { TravelBookingPrintTemplate } from './TravelBookingPrintTemplate'
import { PaymentReversalDialog, type PaymentReversalDialogInput } from '@/ui/components/payments/PaymentReversalDialog'

interface TravelBookingDetailsViewProps {
    booking: TravelBooking
    passengers: TravelPassenger[]
    payments: PaymentTransaction[]
    onBack: () => void
    onEdit: () => void
}

function statusClass(status: TravelBooking['status']) {
    if (status === 'completed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    if (status === 'partially_paid') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    if (status === 'cancelled') return 'border-destructive/30 bg-destructive/10 text-destructive'
    if (status === 'booked') return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
    return 'border-muted bg-muted text-muted-foreground'
}

export function TravelBookingDetailsView({ booking, passengers, payments, onBack, onEdit }: TravelBookingDetailsViewProps) {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features, workspaceName } = useWorkspace()
    const [isProcessing, setIsProcessing] = useState(false)
    const [isPaymentOpen, setIsPaymentOpen] = useState(false)
    const [isDeleteOpen, setIsDeleteOpen] = useState(false)
    const [isCancelOpen, setIsCancelOpen] = useState(false)
    const [isPrintOpen, setIsPrintOpen] = useState(false)
    const [transactionToReverse, setTransactionToReverse] = useState<PaymentTransaction | null>(null)
    const [showAdvanceHoldTip, setShowAdvanceHoldTip] = useState(false)
    const advanceHoldMissCountRef = useRef(0)
    const advanceHoldTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const activePayments = useMemo(() => getActiveTravelBookingPayments(payments), [payments])
    const paymentHistoryEntries = useMemo(() => {
        const reversalsByOriginalPaymentId = new Map<string, PaymentTransaction>()
        for (const payment of payments) {
            if (!payment.isDeleted && payment.reversalOfTransactionId) {
                reversalsByOriginalPaymentId.set(payment.reversalOfTransactionId, payment)
            }
        }

        return payments
            .filter((payment) => !payment.isDeleted && !payment.reversalOfTransactionId)
            .map((payment) => ({
                payment,
                reversal: reversalsByOriginalPaymentId.get(payment.id) ?? null
            }))
    }, [payments])
    const canEdit = (booking.status === 'draft' || booking.status === 'booked') && activePayments.length === 0
    const canRecordPayment = booking.status === 'booked' || booking.status === 'partially_paid'
    const bookingPrintPreview = useMemo<TemplatePreview>(() => ({
        fields: [],
        page: { widthMm: 210, heightMm: 297 },
        createElement: (_data, _effectiveId, printLangOverride) => {
            const baseLanguage = features.print_lang !== 'auto' ? features.print_lang : i18n.language
            return <TravelBookingPrintTemplate
                workspaceName={workspaceName}
                printLang={printLangOverride || baseLanguage}
                booking={booking}
                passengers={passengers}
                iqdPreference={features.iqd_display_preference}
                logoUrl={features.logo_url}
            />
        },
        buildPdf: async (element, printLangOverride) => {
            const baseLanguage = features.print_lang !== 'auto' ? features.print_lang : i18n.language
            return generateTemplatePdf({
                element,
                format: 'a4',
                printLang: printLangOverride || baseLanguage
            })
        }
    }), [booking, features.iqd_display_preference, features.logo_url, features.print_lang, i18n.language, passengers, workspaceName])

    const runAction = async (action: () => Promise<void>, successMessage: string) => {
        if (isProcessing) return
        setIsProcessing(true)
        try {
            await action()
            toast({ title: t('common.success'), description: successMessage })
        } catch (error: unknown) {
            toast({
                title: t('common.error'),
                description: error instanceof Error ? error.message : t('travelTransportation.errors.actionFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsProcessing(false)
        }
    }

    const handlePaymentReversal = async (input: PaymentReversalDialogInput) => {
        if (!transactionToReverse || isProcessing) return
        setIsProcessing(true)
        try {
            await reversePaymentTransaction(booking.workspaceId, transactionToReverse.id, {
                ...input,
                createdBy: user?.id ?? null
            })
            toast({ title: t('common.success'), description: t('travelTransportation.paymentReversed') })
            setTransactionToReverse(null)
        } catch (error: unknown) {
            toast({
                title: t('common.error'),
                description: error instanceof Error ? error.message : t('travelTransportation.errors.actionFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsProcessing(false)
        }
    }

    const handleAdvancePressStart = () => {
        advanceHoldMissCountRef.current += 1
        if (advanceHoldMissCountRef.current < 3) return

        advanceHoldMissCountRef.current = 0
        setShowAdvanceHoldTip(true)
        if (advanceHoldTipTimerRef.current) clearTimeout(advanceHoldTipTimerRef.current)
        advanceHoldTipTimerRef.current = setTimeout(() => setShowAdvanceHoldTip(false), 3500)
    }

    const handleAdvanceComplete = () => {
        advanceHoldMissCountRef.current = 0
        if (advanceHoldTipTimerRef.current) clearTimeout(advanceHoldTipTimerRef.current)
        advanceHoldTipTimerRef.current = null
        setShowAdvanceHoldTip(false)
    }

    useEffect(() => () => {
        if (advanceHoldTipTimerRef.current) clearTimeout(advanceHoldTipTimerRef.current)
    }, [])

    return (
        <div className="w-full space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <Button type="button" variant="ghost" size="icon" onClick={onBack} disabled={isProcessing} aria-label={t('common.back')}>
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="text-2xl font-bold tracking-tight">{booking.bookingNumber}</h1>
                            <Badge className={statusClass(booking.status)}>{t(`travelTransportation.statuses.${booking.status}`)}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{t('travelTransportation.bookingDetails')}</p>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => setIsPrintOpen(true)} disabled={isProcessing}>
                        <Printer className="mr-2 h-4 w-4" />{t('common.print')}
                    </Button>
                    {canEdit ? <Button type="button" variant="outline" onClick={onEdit} disabled={isProcessing}><FilePenLine className="mr-2 h-4 w-4" />{t('travelTransportation.editBooking')}</Button> : null}
                    {booking.status === 'draft' ? <div className="relative">
                        <PressAndHoldButton
                            icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                            disabled={isProcessing}
                            isLoading={isProcessing}
                            onPressStart={handleAdvancePressStart}
                            onComplete={() => {
                                handleAdvanceComplete()
                                void runAction(() => bookTravelBooking(booking.id).then(() => undefined), t('travelTransportation.bookingBooked'))
                            }}
                            idleLabel={t('travelTransportation.book')}
                            holdingLabel={t('travelTransportation.actions.keepHolding')}
                            loadingLabel={t('travelTransportation.book')}
                            durationMs={STATUS_ADVANCE_HOLD_DURATION_MS}
                        />
                        {showAdvanceHoldTip ? <div
                            role="status"
                            className="pointer-events-none absolute start-0 top-[calc(100%+0.5rem)] z-50 w-max max-w-72 rounded-lg border border-border bg-popover px-3 py-2 text-xs font-semibold text-popover-foreground shadow-lg"
                        >
                            {t('travelTransportation.actions.advanceHoldHint')}
                        </div> : null}
                    </div> : null}
                    {canRecordPayment ? <Button type="button" onClick={() => setIsPaymentOpen(true)} disabled={isProcessing || booking.outstandingProfitAmount <= 0}>
                        <CreditCard className="mr-2 h-4 w-4" />{t('travelTransportation.recordPayment')}
                    </Button> : null}
                    {booking.status === 'booked' && activePayments.length === 0 ? <Button type="button" variant="outline" onClick={() => setIsCancelOpen(true)} disabled={isProcessing}>
                        <Ban className="mr-2 h-4 w-4" />{t('travelTransportation.cancelBooking')}
                    </Button> : null}
                    {booking.status === 'draft' ? <Button type="button" variant="destructive" onClick={() => setIsDeleteOpen(true)} disabled={isProcessing}>
                        <Trash2 className="mr-2 h-4 w-4" />{t('travelTransportation.deleteBooking')}
                    </Button> : null}
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard icon={UsersRound} label={t('travelTransportation.passengers')} value={String(passengers.length)} />
                <MetricCard icon={ReceiptText} label={t('travelTransportation.bookingTotal')} value={formatCurrency(booking.bookingTotal, booking.currency, features.iqd_display_preference)} />
                <MetricCard icon={CircleDollarSign} label={t('travelTransportation.profit')} value={formatCurrency(booking.profitAmount, booking.currency, features.iqd_display_preference)} />
                <MetricCard icon={CreditCard} label={t('travelTransportation.outstandingProfit')} value={booking.status === 'cancelled' ? '--' : formatCurrency(booking.outstandingProfitAmount, booking.currency, features.iqd_display_preference)} />
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_330px]">
                <div className="space-y-6">
                    <Card className="border-border/60 shadow-sm">
                        <CardHeader><CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5 text-primary" />{t('travelTransportation.passengers')}</CardTitle></CardHeader>
                        <CardContent className="overflow-x-auto">
                            <Table>
                                <TableHeader><TableRow><TableHead>{t('travelTransportation.name')}</TableHead><TableHead>{t('travelTransportation.transportationType')}</TableHead><TableHead className="text-end">{t('travelTransportation.price')}</TableHead></TableRow></TableHeader>
                                <TableBody>
                                    {passengers.map((passenger) => <TableRow key={passenger.id}>
                                        <TableCell className="font-medium">{passenger.name}</TableCell>
                                        <TableCell>{t(`travelTransportation.${passenger.transportationType}`)}</TableCell>
                                        <TableCell className="text-end">{formatCurrency(passenger.price, booking.currency, features.iqd_display_preference)}</TableCell>
                                    </TableRow>)}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>

                    <Card className="border-border/60 shadow-sm">
                        <CardHeader><CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5 text-primary" />{t('travelTransportation.paymentHistory')}</CardTitle></CardHeader>
                        <CardContent className="overflow-x-auto">
                            <Table>
                                <TableHeader><TableRow><TableHead>{t('travelTransportation.payment.amount')}</TableHead><TableHead>{t('travelTransportation.payment.method')}</TableHead><TableHead>{t('travelTransportation.table.created')}</TableHead><TableHead>{t('travelTransportation.paymentStatus')}</TableHead><TableHead className="text-end">{t('travelTransportation.table.actions')}</TableHead></TableRow></TableHeader>
                                <TableBody>
                                    {paymentHistoryEntries.length === 0 ? <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{t('travelTransportation.noPayments')}</TableCell></TableRow> : paymentHistoryEntries.map(({ payment, reversal }) => {
                                        const isReversed = Boolean(reversal)
                                        const canReverse = !isReversed && payment.amount > 0
                                        return <TableRow key={payment.id} className={isReversed ? 'text-muted-foreground' : undefined}>
                                            <TableCell className="font-medium">
                                                {isReversed ? <div>
                                                    <p>{formatCurrency(0, booking.currency, features.iqd_display_preference)}</p>
                                                    <p className="mt-0.5 text-xs text-muted-foreground">{t('travelTransportation.reversedOriginalAmount', { amount: formatCurrency(payment.amount, booking.currency, features.iqd_display_preference) })}</p>
                                                </div> : formatCurrency(payment.amount, booking.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell>{payment.paymentMethod}</TableCell>
                                            <TableCell>
                                                <p>{formatDateTime(payment.paidAt)}</p>
                                                {reversal ? <p className="mt-0.5 text-xs text-muted-foreground">{t('travelTransportation.reversedOn', { date: formatDateTime(reversal.paidAt) })}</p> : null}
                                            </TableCell>
                                            <TableCell><Badge className={isReversed ? 'border-muted bg-muted text-muted-foreground' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}>{t(isReversed ? 'travelTransportation.paymentReversedStatus' : 'travelTransportation.paymentRecordedStatus')}</Badge></TableCell>
                                            <TableCell className="text-end">{canReverse ? <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                disabled={isProcessing}
                                                onClick={() => setTransactionToReverse(payment)}
                                            ><RotateCcw className="mr-1 h-4 w-4" />{t('travelTransportation.reversePayment')}</Button> : '-'}</TableCell>
                                        </TableRow>
                                    })}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </div>

                <div className="space-y-6">
                    <Card className="border-border/60 shadow-sm">
                        <CardHeader><CardTitle>{t('travelTransportation.bookingDetailsCard')}</CardTitle></CardHeader>
                        <CardContent className="space-y-3">
                            <InfoRow label={t('travelTransportation.travelDate')} value={booking.travelDate ? formatDate(booking.travelDate) : '-'} />
                            <InfoRow label={t('travelTransportation.currency')} value={booking.currency.toUpperCase()} />
                            <InfoRow label={t('travelTransportation.passengerTotal')} value={formatCurrency(booking.passengerTotal, booking.currency, features.iqd_display_preference)} />
                            <InfoRow label={t('travelTransportation.bookingTotal')} value={formatCurrency(booking.bookingTotal, booking.currency, features.iqd_display_preference)} />
                            <InfoRow label={t('travelTransportation.adjustedBookingTotal')} value={formatCurrency(booking.adjustedBookingTotal, booking.currency, features.iqd_display_preference)} />
                            <InfoRow label={t('travelTransportation.paidProfit')} value={formatCurrency(booking.paidProfitAmount, booking.currency, features.iqd_display_preference)} />
                            {booking.notes ? <InfoRow label={t('travelTransportation.notes')} value={booking.notes} /> : null}
                        </CardContent>
                    </Card>
                    <Card className="border-border/60 shadow-sm">
                        <CardHeader><CardTitle>{t('travelTransportation.bookingAdjustments')}</CardTitle></CardHeader>
                        <CardContent className="space-y-3">
                            {(booking.bookingAdjustments || []).length === 0 ? <p className="text-sm text-muted-foreground">-</p> : booking.bookingAdjustments?.map((adjustment) => <div key={adjustment.id} className="flex items-start justify-between gap-3 border-b pb-3 last:border-0 last:pb-0">
                                <div><p className="font-medium">{adjustment.name}</p><p className="text-xs text-muted-foreground">{adjustment.type}</p></div>
                                <span className="font-semibold">{formatCurrency(adjustment.convertedAmount, booking.currency, features.iqd_display_preference)}</span>
                            </div>)}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <PrintPreviewModal
                isOpen={isPrintOpen}
                onClose={() => setIsPrintOpen(false)}
                onConfirm={() => setIsPrintOpen(false)}
                title={t('travelTransportation.print.title')}
                module="travelTransportation"
                features={features}
                workspaceName={workspaceName}
                originId={booking.id}
                showSaveButton={false}
                pdfBuilder={async ({ effectiveId, printLangOverride }) => bookingPrintPreview.buildPdf(
                    bookingPrintPreview.createElement({}, effectiveId, printLangOverride),
                    printLangOverride
                )}
                printTemplate={({ effectiveId }) => bookingPrintPreview.createElement({}, effectiveId)}
                templatePreview={bookingPrintPreview}
                printSelectionOptions={[{
                    format: 'a4',
                    label: t('travelTransportation.print.a4'),
                    description: t('travelTransportation.print.a4Description')
                }]}
                onPreviewPrint={async (blob) => {
                    await printPdfBlob(blob, { title: t('travelTransportation.print.title') })
                    setIsPrintOpen(false)
                }}
                previewPrintActionLabel={t('common.print')}
            />

            <RecordTravelBookingPaymentDialog open={isPaymentOpen} onOpenChange={setIsPaymentOpen} booking={booking} />
            <PaymentReversalDialog
                open={!!transactionToReverse}
                onOpenChange={(open) => {
                    if (!open) setTransactionToReverse(null)
                }}
                onSubmit={handlePaymentReversal}
                isProcessing={isProcessing}
                transaction={transactionToReverse}
                workspaceId={booking.workspaceId}
                iqdPreference={features.iqd_display_preference}
            />
            <DeleteConfirmationModal
                isOpen={isDeleteOpen}
                onClose={() => { if (!isProcessing) setIsDeleteOpen(false) }}
                onConfirm={() => void runAction(async () => {
                    await deleteTravelBooking(booking.id)
                    onBack()
                }, t('travelTransportation.bookingDeleted'))}
                itemName={booking.bookingNumber}
                isLoading={isProcessing}
                title={t('travelTransportation.deleteBooking')}
                description={t('travelTransportation.deleteBooking')}
            />
            <AppDialog open={isCancelOpen} onOpenChange={(open) => { if (!isProcessing) setIsCancelOpen(open) }}>
                <AppDialogContent showCloseButton={!isProcessing} onPointerDownOutside={(event) => { if (isProcessing) event.preventDefault() }}>
                    <AppDialogHeader><AppDialogTitle>{t('travelTransportation.cancelBooking')}</AppDialogTitle><AppDialogDescription>{t('travelTransportation.cancelConfirmation')}</AppDialogDescription></AppDialogHeader>
                    <AppDialogBody />
                    <AppDialogFooter>
                        <Button type="button" variant="outline" disabled={isProcessing} onClick={() => setIsCancelOpen(false)}>{t('common.cancel')}</Button>
                        <Button type="button" variant="destructive" disabled={isProcessing} onClick={() => void runAction(async () => {
                            await cancelTravelBooking(booking.id)
                            setIsCancelOpen(false)
                        }, t('travelTransportation.bookingCancelled'))}>{isProcessing ? t('common.loading') : t('travelTransportation.cancelBooking')}</Button>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>
        </div>
    )
}

function MetricCard({ icon: Icon, label, value }: { icon: typeof UsersRound; label: string; value: string }) {
    return <Card className="border-border/60 shadow-sm"><CardContent className="pt-6"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="h-4 w-4" />{label}</div><p className="mt-2 text-xl font-bold">{value}</p></CardContent></Card>
}

function InfoRow({ label, value }: { label: string; value: string }) {
    return <div className="flex items-start justify-between gap-4 border-b border-border/60 pb-2 text-sm last:border-0 last:pb-0"><span className="text-muted-foreground">{label}</span><span className="max-w-[60%] text-right font-medium">{value}</span></div>
}
