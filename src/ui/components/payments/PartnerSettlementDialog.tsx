import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownLeft, ArrowUpRight, Link2, Loader2 } from 'lucide-react'

import {
    getPartnerSettlementBalance,
    type BusinessPartner,
    type CurrencySettlementAmount,
    type PaymentAccount,
    type PartnerSettlementBalance,
    type PartnerSettlementProgress,
    type PaymentTransactionDirection,
    type WorkspacePaymentMethod,
    useAgents
} from '@/local-db'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import {
    cn,
    formatCurrency,
    formatLocalDateTimeValue,
    formatNumericInput,
    parseFormattedNumber,
    parseLocalDateTimeValue,
    sanitizeNumericInput
} from '@/lib/utils'
import {
    Button,
    DateTimePicker,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Textarea
} from '@/ui/components'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { PressAndHoldButton } from '@/ui/components/PressAndHoldButton'
import { useWorkspace } from '@/workspace'
import { PaymentMethodSelector } from '@/ui/components/PaymentMethodSelector'
import { PaymentAccountSelector } from './PaymentAccountSelector'

interface PartnerSettlementDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    defaultDirection?: PaymentTransactionDirection | null
    includeSalesAgentCommissionPartners?: boolean
    isSubmitting?: boolean
    onSubmit: (input: {
        partner: BusinessPartner
        direction: PaymentTransactionDirection
        paymentMethod: WorkspacePaymentMethod
        paidAt: string
        note?: string
        amountsByCurrency?: CurrencySettlementAmount[]
        onProgress?: (progress: PartnerSettlementProgress) => void
        accountId?: string | null
        accountNameSnapshot?: string | null
    }) => Promise<void> | void
}

const AMOUNT_EPSILON = 0.000001

export function PartnerSettlementDialog({
    open,
    onOpenChange,
    workspaceId,
    defaultDirection = null,
    includeSalesAgentCommissionPartners = false,
    isSubmitting = false,
    onSubmit
}: PartnerSettlementDialogProps) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const [partnerName, setPartnerName] = useState('')
    const [partner, setPartner] = useState<BusinessPartner | null>(null)
    const [direction, setDirection] = useState<PaymentTransactionDirection | null>(defaultDirection)
    const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [paidAt, setPaidAt] = useState('')
    const [note, setNote] = useState('')
    const [balance, setBalance] = useState<PartnerSettlementBalance | null>(null)
    const [balanceLoading, setBalanceLoading] = useState(false)
    const [balanceError, setBalanceError] = useState<string | null>(null)
    const [settleProgress, setSettleProgress] = useState<PartnerSettlementProgress | null>(null)
    const [amountInputs, setAmountInputs] = useState<Record<string, string>>({})
    const agents = useAgents(includeSalesAgentCommissionPartners ? workspaceId : undefined)
    const eligibleSalesAgentCommissionPartnerIds = useMemo(
        () => agents
            .filter((agent) => (
                !agent.isDeleted
                && agent.agentType === 'field_agent'
            ))
            .map((agent) => agent.businessPartnerId),
        [agents]
    )

    useEffect(() => {
        if (!open) {
            return
        }

        setPartnerName('')
        setPartner(null)
        setDirection(defaultDirection || null)
        setPaymentMethod('cash')
        setPaymentAccount(null)
        setPaidAt(formatLocalDateTimeValue(new Date()))
        setNote('')
        setBalance(null)
        setBalanceLoading(false)
        setBalanceError(null)
        setSettleProgress(null)
        setAmountInputs({})
    }, [defaultDirection, open])

    useEffect(() => {
        if (!open || !partner || !direction) {
            setBalance(null)
            setBalanceLoading(false)
            setBalanceError(null)
            return
        }

        let cancelled = false
        setBalanceLoading(true)
        setBalanceError(null)

        getPartnerSettlementBalance(workspaceId, partner.id, direction)
            .then((result) => {
                if (cancelled) {
                    return
                }
                setBalance(result)
                setBalanceLoading(false)
            })
            .catch((error: any) => {
                if (cancelled) {
                    return
                }
                setBalance(null)
                setBalanceError(error?.message || t('partnerSettlement.balanceLoadFailed', { defaultValue: 'Failed to load the outstanding balance.' }))
                setBalanceLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [direction, open, partner, t, workspaceId])

    useEffect(() => {
        setAmountInputs({})
    }, [direction, open, partner])

    useEffect(() => {
        if (!balance || balance.groups.length === 0) {
            return
        }

        setAmountInputs((current) => {
            const next = { ...current }
            let changed = false
            for (const group of balance.groups) {
                if (next[group.currency] === undefined) {
                    next[group.currency] = String(group.total)
                    changed = true
                }
            }
            return changed ? next : current
        })
    }, [balance])

    const selectedPaidAt = parseLocalDateTimeValue(paidAt)
    const total = balance?.total ?? 0
    const itemCount = balance?.items ?? 0
    const hasBalance = !!balance && total > AMOUNT_EPSILON

    const summaryText = useMemo(() => {
        if (!balance || balance.groups.length === 0) {
            return ''
        }

        return balance.groups
            .map((group) => formatCurrency(group.total, group.currency, features.iqd_display_preference))
            .join(' • ')
    }, [balance, features.iqd_display_preference])

    const amountEntries = useMemo(() => {
        if (!balance) {
            return []
        }

        return balance.groups.map((group) => {
            const raw = (amountInputs[group.currency] ?? '').trim()
            if (raw === '') {
                return { currency: group.currency, total: group.total, raw, amount: 0, valid: true }
            }

            const parsed = parseFormattedNumber(raw)
            if (!Number.isFinite(parsed) || parsed < 0) {
                return { currency: group.currency, total: group.total, raw, amount: 0, valid: false }
            }
            if (parsed - group.total > AMOUNT_EPSILON) {
                return { currency: group.currency, total: group.total, raw, amount: 0, valid: false }
            }

            return { currency: group.currency, total: group.total, raw, amount: parsed, valid: true }
        })
    }, [amountInputs, balance])

    const enteredTotal = amountEntries.reduce((sum, entry) => sum + entry.amount, 0)
    const hasEnteredAmount = enteredTotal > AMOUNT_EPSILON
    const allAmountsValid = amountEntries.length > 0 && amountEntries.every((entry) => entry.valid)
    const enteredSummaryText = useMemo(() => {
        const enteredGroups = amountEntries
            .filter((entry) => entry.amount > AMOUNT_EPSILON)
            .map((entry) => ({ currency: entry.currency, total: entry.amount }))

        if (enteredGroups.length === 0) {
            return ''
        }

        return enteredGroups
            .map((group) => formatCurrency(group.total, group.currency, features.iqd_display_preference))
            .join(' • ')
    }, [amountEntries, features.iqd_display_preference])

    const isPartial = hasEnteredAmount && hasBalance && total - enteredTotal > AMOUNT_EPSILON
    const remainingText = useMemo(() => {
        if (!isPartial || !balance) {
            return ''
        }

        return balance.groups
            .filter((group) => {
                const entry = amountEntries.find((item) => item.currency === group.currency)
                return !entry || group.total - entry.amount > AMOUNT_EPSILON
            })
            .map((group) => {
                const entry = amountEntries.find((item) => item.currency === group.currency)
                return formatCurrency(group.total - (entry?.amount ?? 0), group.currency, features.iqd_display_preference)
            })
            .join(' • ')
    }, [amountEntries, balance, features.iqd_display_preference, isPartial])

    const dialogTitle = direction === 'incoming'
        ? t('partnerSettlement.collectFromPartner', { defaultValue: 'Collect from Partner' })
        : direction === 'outgoing'
            ? t('partnerSettlement.payPartner', { defaultValue: 'Pay Partner' })
            : t('partnerSettlement.settleBalance', { defaultValue: 'Settle Balance' })

    const amountLabel = direction === 'incoming'
        ? t('partnerSettlement.amountToCollect', { defaultValue: 'Amount to collect' })
        : t('partnerSettlement.amountToPay', { defaultValue: 'Amount to pay' })

    const actionLabel = direction === 'incoming' && hasEnteredAmount
        ? (isPartial
            ? t('partnerSettlement.collectAmountPartial', {
                defaultValue: 'Collect {{amount}} of {{total}}',
                amount: enteredSummaryText,
                total: summaryText
            })
            : t('partnerSettlement.collectAmount', { defaultValue: 'Collect {{amount}}', amount: enteredSummaryText }))
        : direction === 'outgoing' && hasEnteredAmount
            ? (isPartial
                ? t('partnerSettlement.payAmountPartial', {
                    defaultValue: 'Pay {{amount}} of {{total}}',
                    amount: enteredSummaryText,
                    total: summaryText
                })
                : t('partnerSettlement.payAmount', { defaultValue: 'Pay {{amount}}', amount: enteredSummaryText }))
            : t('partnerSettlement.confirm', { defaultValue: 'Confirm' })

    const canSubmit = !!partner
        && !!direction
        && !!balance
        && !balanceLoading
        && !balanceError
        && hasBalance
        && allAmountsValid
        && hasEnteredAmount
        && !!selectedPaidAt
        && !isSubmitting

    const submitSettlement = () => {
        if (!canSubmit || !partner || !direction || !selectedPaidAt || !balance || isSubmitting) {
            return
        }

        const amountsByCurrency: CurrencySettlementAmount[] = amountEntries
            .filter((entry) => entry.amount > AMOUNT_EPSILON)
            .map((entry) => ({ currency: entry.currency, amount: entry.amount }))

        setSettleProgress({ settledItems: 0, totalItems: balance.items })
        void onSubmit({
            partner,
            direction,
            paymentMethod,
            paidAt: selectedPaidAt.toISOString(),
            note: note.trim() || undefined,
            amountsByCurrency: amountsByCurrency.length > 0 ? amountsByCurrency : undefined,
            onProgress: setSettleProgress,
            accountId: paymentAccount?.id ?? null,
            accountNameSnapshot: paymentAccount?.name ?? null
        })
    }

    const progressPercent = settleProgress && settleProgress.totalItems > 0
        ? Math.min(100, Math.round((settleProgress.settledItems / settleProgress.totalItems) * 100))
        : null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                layout="structured"
                className="max-w-2xl"
                showCloseButton={!isSubmitting}
                onPointerDownOutside={(e) => {
                    if (isSubmitting) {
                        e.preventDefault()
                    }
                }}
                onInteractOutside={(e) => {
                    if (isSubmitting) {
                        e.preventDefault()
                    }
                }}
                onEscapeKeyDown={(e) => {
                    if (isSubmitting) {
                        e.preventDefault()
                    }
                }}
                onOpenAutoFocus={(e) => {
                    if (!partnerName) {
                        e.preventDefault()
                    }
                }}
            >
                <DialogHeader layout="structured">
                    <DialogTitle>{dialogTitle}</DialogTitle>
                    <DialogDescription>
                        {partner
                            ? (direction
                                ? t('partnerSettlement.settleDescription', {
                                    defaultValue: 'Settle {{name}} by {{direction}}.',
                                    name: partner.partnerName,
                                    direction: direction === 'incoming'
                                        ? t('partnerSettlement.collect', { defaultValue: 'Collect' })
                                        : t('partnerSettlement.pay', { defaultValue: 'Pay' })
                                })
                                : t('partnerSettlement.chooseDirection', { defaultValue: 'Choose whether to collect or pay.' }))
                            : t('partnerSettlement.selectPartner', { defaultValue: 'Select a business partner to settle their outstanding balance.' })}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={(e) => e.preventDefault()} className="flex min-h-0 flex-1 flex-col">
                    <DialogBody>
                        <div className="grid gap-4">
                            <div className="grid gap-2">
                                <Label>
                                    {t('payments.table.counterparty', { defaultValue: 'Counterparty' })}
                                    <span className="text-destructive"> *</span>
                                </Label>
                                <PartnerAutocompleteInput
                                    value={partnerName}
                                    onChange={(value) => {
                                        setPartnerName(value)
                                        setPartner(null)
                                        setBalance(null)
                                    }}
                                    onSelectPartner={(selectedPartner) => {
                                        setPartner(selectedPartner)
                                    }}
                                    workspaceId={workspaceId}
                                    placeholder={t('partnerSettlement.partnerPlaceholder', { defaultValue: 'Search business partner' })}
                                    disabled={isSubmitting}
                                    includeRealEstateRoles
                                    includeAgentRoles={includeSalesAgentCommissionPartners}
                                    eligibleAgentPartnerIds={eligibleSalesAgentCommissionPartnerIds}
                                />
                                {partner ? (
                                    <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
                                        <Link2 className="h-4 w-4 shrink-0 text-primary" />
                                        <div className="min-w-0">
                                            <div className="truncate text-[11px] font-bold uppercase tracking-wide text-primary">
                                                {t('businessPartners.linked', { defaultValue: 'Linked' })}
                                                {' '}
                                                {t('businessPartners.title', { defaultValue: 'Business Partner' })}
                                            </div>
                                            <div className="truncate text-sm font-semibold">{partner.partnerName}</div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="ms-auto h-8 shrink-0 px-2 text-muted-foreground"
                                            onClick={() => {
                                                setPartnerName('')
                                                setPartner(null)
                                                setBalance(null)
                                            }}
                                            disabled={isSubmitting}
                                        >
                                            {t('common.remove', { defaultValue: 'Remove' })}
                                        </Button>
                                    </div>
                                ) : null}
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('partnerSettlement.direction', { defaultValue: 'Settlement direction' })}</Label>
                                <div className="grid grid-cols-2 gap-2">
                                    <Button
                                        type="button"
                                        variant={direction === 'incoming' ? 'default' : 'outline'}
                                        className="flex items-center gap-2"
                                        onClick={() => setDirection('incoming')}
                                        disabled={isSubmitting}
                                    >
                                        <ArrowDownLeft className="h-4 w-4" />
                                        {t('partnerSettlement.collect', { defaultValue: 'Collect' })}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant={direction === 'outgoing' ? 'default' : 'outline'}
                                        className="flex items-center gap-2"
                                        onClick={() => setDirection('outgoing')}
                                        disabled={isSubmitting}
                                    >
                                        <ArrowUpRight className="h-4 w-4" />
                                        {t('partnerSettlement.pay', { defaultValue: 'Pay' })}
                                    </Button>
                                </div>
                            </div>

                            {partner && direction ? (
                                <div className="rounded-xl border bg-muted/20 p-4">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {amountLabel}
                                    </div>

                                    {balanceLoading ? (
                                        <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            {t('partnerSettlement.loadingBalance', { defaultValue: 'Loading outstanding balance…' })}
                                        </div>
                                    ) : balanceError ? (
                                        <p className="mt-2 text-sm text-destructive">{balanceError}</p>
                                    ) : balance ? (
                                        hasBalance ? (
                                            <>
                                                <div className="mt-3 grid gap-3">
                                                    {amountEntries.map((entry) => (
                                                        <div className="grid gap-1" key={entry.currency}>
                                                            <div className="flex items-center gap-2">
                                                                <span className="w-14 shrink-0 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                                                                    {entry.currency}
                                                                </span>
                                                                <Input
                                                                    id={`partner-settlement-amount-${entry.currency}`}
                                                                    inputMode={entry.currency === 'iqd' ? 'numeric' : 'decimal'}
                                                                    className={cn(
                                                                        'h-10 text-base font-bold tabular-nums',
                                                                        !entry.valid && 'border-destructive text-destructive focus-visible:border-destructive focus-visible:ring-destructive/30'
                                                                    )}
                                                                    value={formatNumericInput(amountInputs[entry.currency] ?? '')}
                                                                    onChange={(event) => {
                                                                        setAmountInputs((current) => ({
                                                                            ...current,
                                                                            [entry.currency]: sanitizeNumericInput(event.target.value)
                                                                        }))
                                                                    }}
                                                                    onBlur={() => {
                                                                        const parsed = parseFormattedNumber(amountInputs[entry.currency] ?? '')
                                                                        if (parsed - entry.total > AMOUNT_EPSILON) {
                                                                            setAmountInputs((current) => ({
                                                                                ...current,
                                                                                [entry.currency]: String(entry.total)
                                                                            }))
                                                                        }
                                                                    }}
                                                                    onFocus={(event) => event.target.select()}
                                                                    disabled={isSubmitting}
                                                                    aria-invalid={!entry.valid}
                                                                />
                                                                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                                                                    {t('partnerSettlement.ofTotal', {
                                                                        defaultValue: 'of {{total}}',
                                                                        total: formatCurrency(entry.total, entry.currency, features.iqd_display_preference)
                                                                    })}
                                                                </span>
                                                            </div>
                                                            {!entry.valid && (
                                                                <p className="text-xs font-medium text-destructive">
                                                                    {t('partnerSettlement.amountExceedsBalance', {
                                                                        defaultValue: 'Cannot exceed {{amount}}.',
                                                                        amount: formatCurrency(entry.total, entry.currency, features.iqd_display_preference)
                                                                    })}
                                                                </p>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="mt-2 text-sm text-muted-foreground">
                                                    {itemCount === 1
                                                        ? t('partnerSettlement.oneOpenItem', { defaultValue: '1 open item' })
                                                        : t('partnerSettlement.openItems', { defaultValue: '{{count}} open items', count: itemCount })}
                                                </div>
                                                {isPartial && remainingText ? (
                                                    <div className="mt-1.5 text-sm font-medium text-muted-foreground">
                                                        {t('partnerSettlement.remainsOpen', {
                                                            defaultValue: '{{amount}} will remain open.',
                                                            amount: remainingText
                                                        })}
                                                    </div>
                                                ) : null}
                                            </>
                                        ) : (
                                            <div className="mt-2">
                                                <div className="text-sm font-semibold">
                                                    {direction === 'incoming'
                                                        ? t('partnerSettlement.nothingToCollect', { defaultValue: 'Nothing to collect' })
                                                        : t('partnerSettlement.nothingToPay', { defaultValue: 'Nothing to pay' })}
                                                </div>
                                                <div className="mt-0.5 text-sm text-muted-foreground">
                                                    {direction === 'incoming'
                                                        ? t('partnerSettlement.nothingToCollectDescription', { defaultValue: 'This partner currently has no outstanding collectable balance.' })
                                                        : t('partnerSettlement.nothingToPayDescription', { defaultValue: 'There are currently no outstanding payables for this partner.' })}
                                                </div>
                                            </div>
                                        )
                                    ) : null}
                                </div>
                            ) : null}

                            <div className="grid gap-2">
                                <Label>{t('partnerSettlement.paymentMethod', { defaultValue: 'Payment Method' })}</Label>
                                <PaymentMethodSelector
                                    value={paymentMethod}
                                    onValueChange={(value) => setPaymentMethod(value as WorkspacePaymentMethod)}
                                    onLinkedPaymentAccountSelect={setPaymentAccount}
                                    workspaceId={workspaceId}
                                    methods={STANDARD_PAYMENT_METHODS}
                                    disabled={isSubmitting}
                                />
                            </div>

                            <PaymentAccountSelector
                                workspaceId={workspaceId}
                                value={paymentAccount?.id}
                                onValueChange={setPaymentAccount}
                                disabled={isSubmitting}
                            />

                            <div className="grid gap-2">
                                <Label>{t('partnerSettlement.paidAt', { defaultValue: 'Paid At' })}</Label>
                                <DateTimePicker
                                    id="partner-settlement-paid-at"
                                    date={selectedPaidAt}
                                    setDate={(value) => setPaidAt(value ? formatLocalDateTimeValue(value) : '')}
                                    placeholder={t('partnerSettlement.pickPaymentTime', { defaultValue: 'Pick payment time' })}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label>{t('partnerSettlement.note', { defaultValue: 'Note' })}</Label>
                                <Textarea
                                    rows={3}
                                    value={note}
                                    onChange={(event) => setNote(event.target.value)}
                                    placeholder={t('partnerSettlement.optionalNote', { defaultValue: 'Optional note' })}
                                />
                            </div>
                        </div>
                    </DialogBody>

                    <DialogFooter layout="structured" className="flex-col gap-3 sm:flex-col">
                        <div className="flex w-full items-center">
                            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                                {t('partnerSettlement.cancel', { defaultValue: 'Cancel' })}
                            </Button>
                        </div>

                        {isSubmitting ? (
                            <div className="w-full space-y-1.5" aria-live="polite">
                                <div
                                    role="progressbar"
                                    aria-label={t('partnerSettlement.settling', { defaultValue: 'Settling open items…' })}
                                    aria-valuemin={0}
                                    aria-valuemax={settleProgress?.totalItems ?? undefined}
                                    aria-valuenow={settleProgress?.settledItems ?? undefined}
                                    className="h-2 w-full overflow-hidden rounded-full bg-muted"
                                >
                                    <div
                                        className={cn(
                                            'h-full rounded-full bg-primary transition-all duration-300',
                                            progressPercent === null ? 'w-1/2 animate-pulse' : ''
                                        )}
                                        style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
                                    />
                                </div>
                                <p className="text-xs font-medium text-muted-foreground">
                                    {settleProgress && settleProgress.totalItems > 0
                                        ? t('partnerSettlement.settlingProgress', {
                                            defaultValue: 'Settling {{settled}} of {{total}} open items…',
                                            settled: settleProgress.settledItems,
                                            total: settleProgress.totalItems
                                        })
                                        : t('partnerSettlement.settling', { defaultValue: 'Settling open items…' })}
                                </p>
                            </div>
                        ) : null}

                        <PressAndHoldButton
                            onComplete={submitSettlement}
                            idleLabel={actionLabel}
                            holdingLabel={t('partnerSettlement.keepHolding', { defaultValue: 'Keep holding…' })}
                            loadingLabel={t('partnerSettlement.processing', { defaultValue: 'Processing…' })}
                            isLoading={isSubmitting}
                            disabled={!canSubmit}
                            className="h-12 w-full rounded-2xl font-bold shadow-sm"
                        />
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
