import {
    ArrowDownLeft,
    ArrowUpRight,
    CircleAlert,
    ExternalLink,
    History,
    Link2,
    RotateCcw,
    Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { LedgerSettlementStatus } from '@/lib/ledgerSettlement'
import type { CurrencyCode, IQDDisplayPreference } from '@/local-db'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { Button } from '@/ui/components/button'
import {
    SmallDialog,
    SmallDialogBody,
    SmallDialogContent,
    SmallDialogDescription,
    SmallDialogFooter,
    SmallDialogHeader,
    SmallDialogTitle,
} from '@/ui/components/small-dialog'

export interface LedgerPaymentHistoryMovement {
    id: string
    transactionId: string
    date: string
    typeLabel: string
    movementAmount: number
    currency: CurrencyCode
    isCashMovement: boolean
    isReversal: boolean
    settlementStatus: LedgerSettlementStatus
    isSelected: boolean
    isOutsideDateRange: boolean
    isOutsideCurrentFilters: boolean
    canGoToMovement: boolean
}

export interface LedgerPaymentHistoryTotal {
    currency: CurrencyCode
    amount: number
}

interface LedgerPaymentHistoryDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    sourceReference: string
    sourceStatus?: string | null
    selectedMovement: LedgerPaymentHistoryMovement | null
    selectedFinalTotals: LedgerPaymentHistoryTotal[]
    selectedFinalIsRelationTotal: boolean
    selectedFinalStatus: LedgerSettlementStatus
    sourceTotals: LedgerPaymentHistoryTotal[]
    movements: LedgerPaymentHistoryMovement[]
    iqdPreference: IQDDisplayPreference
    onGoToMovement: (movementId: string) => void
}

function formatSignedCurrency(amount: number, currency: CurrencyCode, iqdPreference: IQDDisplayPreference) {
    if (amount === 0) return formatCurrency(0, currency, iqdPreference)
    return `${amount > 0 ? '+' : '-'}${formatCurrency(Math.abs(amount), currency, iqdPreference)}`
}

function settlementStatusClass(status: LedgerSettlementStatus) {
    switch (status) {
        case 'not_applicable':
            return 'border-border bg-muted text-muted-foreground'
        case 'fully_reversed':
            return 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300'
        case 'partially_reversed':
            return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        case 'inconsistent':
        case 'relationship_missing':
            return 'border-destructive/25 bg-destructive/10 text-destructive'
        default:
            return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    }
}

export function LedgerPaymentHistoryDialog({
    open,
    onOpenChange,
    sourceReference,
    sourceStatus,
    selectedMovement,
    selectedFinalTotals,
    selectedFinalIsRelationTotal,
    selectedFinalStatus,
    sourceTotals,
    movements,
    iqdPreference,
    onGoToMovement,
}: LedgerPaymentHistoryDialogProps) {
    const { t } = useTranslation()

    const statusLabel = (status: LedgerSettlementStatus) =>
        t(`ledger.settlement.status.${status}`, {
            defaultValue:
                status === 'fully_reversed'
                    ? 'Fully reversed'
                    : status === 'partially_reversed'
                      ? 'Partially reversed'
                      : status === 'relationship_missing'
                        ? 'Relationship unavailable'
                        : status === 'not_applicable'
                          ? 'Not cash flow'
                        : status === 'inconsistent'
                          ? 'Needs review'
                          : 'Posted',
        })

    return (
        <SmallDialog open={open} onOpenChange={onOpenChange}>
            <SmallDialogContent className="sm:max-w-3xl">
                <SmallDialogHeader>
                    <SmallDialogTitle className="flex items-center gap-2">
                        <History className="h-5 w-5 text-primary" />
                        {t('ledger.settlement.historyTitle', { defaultValue: 'Payment activity' })}
                    </SmallDialogTitle>
                    <SmallDialogDescription>
                        {t('ledger.settlement.historyDescription', {
                            reference: sourceReference,
                            defaultValue: `All recorded cash movements for ${sourceReference}, shown in chronological order.`,
                        })}
                    </SmallDialogDescription>
                </SmallDialogHeader>

                <SmallDialogBody className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                        <section className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
                                {t('ledger.settlement.finalAllDates', { defaultValue: 'Final settlement · all dates' })}
                            </p>
                            <div className="mt-2 space-y-1 text-lg font-black tabular-nums">
                                {selectedFinalTotals.length > 0
                                    ? selectedFinalTotals.map((total) => (
                                          <div key={total.currency}>{formatSignedCurrency(total.amount, total.currency, iqdPreference)}</div>
                                      ))
                                    : t('ledger.settlement.unavailable', { defaultValue: 'Unavailable' })}
                            </div>
                            {selectedMovement ? (
                                <span
                                    className={cn(
                                        'mt-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                        selectedFinalIsRelationTotal && selectedFinalTotals.length > 0
                                            ? 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                                            : settlementStatusClass(selectedFinalStatus),
                                    )}
                                >
                                    {selectedFinalIsRelationTotal && selectedFinalTotals.length > 0
                                        ? t('ledger.settlement.relatedTotal', { defaultValue: 'Related total' })
                                        : statusLabel(selectedFinalStatus)}
                                </span>
                            ) : null}
                        </section>

                        <section className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
                                {t('ledger.settlement.sourceCashNet', { defaultValue: 'Source cash net · all dates' })}
                            </p>
                            <div className="mt-2 space-y-1 text-sm font-black tabular-nums">
                                {sourceTotals.length > 0
                                    ? sourceTotals.map((total) => (
                                          <div key={total.currency}>{formatSignedCurrency(total.amount, total.currency, iqdPreference)}</div>
                                      ))
                                    : t('ledger.settlement.unavailable', { defaultValue: 'Unavailable' })}
                            </div>
                        </section>

                        <section className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
                                {t('ledger.settlement.sourceStatus', { defaultValue: 'Current source status' })}
                            </p>
                            <p className="mt-2 text-sm font-black">
                                {sourceStatus || t('ledger.settlement.sourceStatusUnavailable', { defaultValue: 'Open the source record' })}
                            </p>
                        </section>
                    </div>

                    <div className="rounded-2xl border border-border/60">
                        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
                            <Link2 className="h-4 w-4 text-primary" />
                            <h3 className="text-sm font-black">
                                {t('ledger.settlement.chronology', { defaultValue: 'Recorded chronology' })}
                            </h3>
                        </div>
                        <div className="divide-y divide-border/60">
                            {movements.map((movement) => (
                                <article
                                    key={movement.id}
                                    className={cn(
                                        'flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between',
                                        movement.isSelected && 'bg-primary/[0.06] shadow-[inset_3px_0_0_hsl(var(--primary))]',
                                    )}
                                >
                                    <div className="flex min-w-0 items-start gap-3">
                                        <span
                                            className={cn(
                                                'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border',
                                                movement.isReversal
                                                    ? 'border-violet-500/25 bg-violet-500/10 text-violet-600'
                                                    : movement.movementAmount >= 0
                                                      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600'
                                                      : 'border-amber-500/25 bg-amber-500/10 text-amber-600',
                                            )}
                                        >
                                            {movement.isReversal ? (
                                                <RotateCcw className="h-4 w-4" />
                                            ) : !movement.isCashMovement ? (
                                                <Wallet className="h-4 w-4" />
                                            ) : movement.movementAmount >= 0 ? (
                                                <ArrowDownLeft className="h-4 w-4" />
                                            ) : (
                                                <ArrowUpRight className="h-4 w-4" />
                                            )}
                                        </span>
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-bold">{movement.typeLabel}</span>
                                                {movement.isSelected ? (
                                                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-black uppercase text-primary">
                                                        {t('ledger.settlement.selected', { defaultValue: 'Selected' })}
                                                    </span>
                                                ) : null}
                                                <span
                                                    className={cn(
                                                        'rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                        settlementStatusClass(movement.settlementStatus),
                                                    )}
                                                >
                                                    {movement.isReversal
                                                        ? t('ledger.settlement.reversalMovement', { defaultValue: 'Reversal' })
                                                        : statusLabel(movement.settlementStatus)}
                                                </span>
                                            </div>
                                            <p className="mt-1 font-mono text-xs text-muted-foreground">{movement.transactionId}</p>
                                            <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(movement.date)}</p>
                                            {movement.isOutsideDateRange || movement.isOutsideCurrentFilters ? (
                                                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                                                    <CircleAlert className="h-3.5 w-3.5" />
                                                    {movement.isOutsideDateRange
                                                        ? t('ledger.settlement.outsideDateRange', {
                                                              defaultValue: 'Outside the selected date range',
                                                          })
                                                        : t('ledger.settlement.outsideFilters', {
                                                              defaultValue: 'Hidden by the current Ledger filters',
                                                          })}
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>

                                    <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                                        <span
                                            className={cn(
                                                'text-base font-black tabular-nums',
                                                movement.isCashMovement
                                                    ? movement.movementAmount < 0
                                                        ? 'text-rose-600'
                                                        : 'text-emerald-600'
                                                    : 'text-foreground',
                                            )}
                                        >
                                            {movement.isCashMovement
                                                ? formatSignedCurrency(movement.movementAmount, movement.currency, iqdPreference)
                                                : formatCurrency(movement.movementAmount, movement.currency, iqdPreference)}
                                        </span>
                                        {movement.canGoToMovement ? (
                                            <Button type="button" variant="outline" size="sm" onClick={() => onGoToMovement(movement.id)}>
                                                <ExternalLink className="me-2 h-3.5 w-3.5" />
                                                {t('ledger.settlement.goToMovement', { defaultValue: 'Go to movement' })}
                                            </Button>
                                        ) : null}
                                    </div>
                                </article>
                            ))}
                        </div>
                    </div>

                    <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('ledger.settlement.accountingNote', {
                            defaultValue:
                                'Final settlement nets every posted cash movement in a legitimate Ledger relation, with each reversal chain counted once. Unrelated movements remain standalone, and currencies are never mixed.',
                        })}
                    </p>
                </SmallDialogBody>

                <SmallDialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common.close', { defaultValue: 'Close' })}
                    </Button>
                </SmallDialogFooter>
            </SmallDialogContent>
        </SmallDialog>
    )
}
