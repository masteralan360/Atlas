import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    AlertCircle,
    BadgePercent,
    CalendarClock,
    CheckCircle2,
    Clock3,
    CreditCard,
    Gift,
    Gauge,
    QrCode,
    RefreshCw,
    XCircle
} from 'lucide-react'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { Button } from '@/ui/components/button'
import { Label } from '@/ui/components/label'
import { PaymentAccountHolderNameAutocomplete } from '@/ui/components/PaymentAccountHolderNameAutocomplete'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/ui/components/dialog'
import { PressAndHoldButton } from '@/ui/components/PressAndHoldButton'
import { cn } from '@/lib/utils'
import {
    OPEN_WORKSPACE_PAYMENT_DIALOG_EVENT,
    OPEN_WORKSPACE_PAYMENT_STATUS_DIALOG_EVENT,
    WORKSPACE_PAYMENT_CURRENCY,
    canSubmitWorkspacePayment,
    formatWorkspacePaymentDecimal,
    getWorkspacePaymentAlertKind,
    getWorkspacePaymentQrPath,
    getWorkspacePaygSummary,
    getSavedWorkspacePaymentAccountHolderNames,
    hasNewlyApprovedWorkspacePayment,
    hasWorkspacePaymentAccessBeenRestored,
    isValidWorkspacePaymentAccountHolderName,
    normalizeWorkspacePaymentAccountHolderName,
    submitWorkspacePayment,
    submitWorkspacePaygPayment,
    type WorkspacePaymentAlertKind,
    type WorkspacePaymentConfiguration,
    type WorkspacePaymentProvider,
    type WorkspacePaymentStatus,
    type WorkspacePaymentSummary,
    type WorkspacePaymentTransaction,
    type WorkspacePaygSummary
} from '@/lib/workspacePayments'

const PENDING_PAYMENT_POLL_INTERVAL_MS = 10_000
const PAYMENT_SUMMARY_REFRESH_INTERVAL_MS = 60_000
const PAYMENT_CONFIRMATION_DELAY_MS = 15_000

let hasUsedPaymentConfirmationDelay = false
let paymentConfirmationDelayEndsAtForSession: number | null = null

function getPaymentConfirmationDelayRemaining(endsAt: number | null) {
    return endsAt ? Math.max(0, endsAt - Date.now()) : 0
}

function getWorkspacePaymentCurrencyLabel(iqdDisplayPreference: string) {
    return iqdDisplayPreference === 'د.ع' ? 'د.ع' : WORKSPACE_PAYMENT_CURRENCY
}

function getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return 'Unable to submit the payment. Please try again.'
}

function getAlertCopy(kind: WorkspacePaymentAlertKind | null, t: ReturnType<typeof useTranslation>['t']) {
    switch (kind) {
        case 'payg_renewal_due':
            return {
                title: t('workspacePayments.payg.renewalDueTitle'),
                description: t('workspacePayments.payg.renewalDueDescription')
            }
        case 'subscription_expired':
            return {
                title: t('workspacePayments.subscriptionExpiredTitle'),
                description: t('workspacePayments.subscriptionExpiredDescription')
            }
        case 'usage_exhausted':
            return {
                title: t('workspacePayments.usageExhaustedTitle'),
                description: t('workspacePayments.usageExhaustedDescription')
            }
        default:
            return {
                title: t('workspacePayments.dialogTitle'),
                description: t('workspacePayments.dialogDescription')
            }
    }
}

function getStatusPresentation(status: WorkspacePaymentStatus, t: ReturnType<typeof useTranslation>['t']) {
    switch (status) {
        case 'pending':
            return {
                label: t('workspacePayments.statuses.pending'),
                icon: Clock3,
                className: 'bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:text-amber-300'
            }
        case 'approved':
            return {
                label: t('workspacePayments.statuses.approved'),
                icon: CheckCircle2,
                className: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300'
            }
        case 'rejected':
            return {
                label: t('workspacePayments.statuses.rejected'),
                icon: XCircle,
                className: 'bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300'
            }
        case 'expired':
        default:
            return {
                label: t('workspacePayments.statuses.expired'),
                icon: CalendarClock,
                className: 'bg-slate-500/10 text-slate-700 ring-slate-500/20 dark:text-slate-300'
            }
    }
}

function PrepaidTermSummary({
    configuration,
    locale,
    iqdDisplayPreference,
    t
}: {
    configuration: WorkspacePaymentConfiguration
    locale: string
    iqdDisplayPreference: string
    t: ReturnType<typeof useTranslation>['t']
}) {
    const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium'
    }), [locale])
    const currencyLabel = getWorkspacePaymentCurrencyLabel(iqdDisplayPreference)
    const usesTermPool = configuration.prepaidAllowanceMode === 'term_pool'
    const formatDate = (value: string | null) => {
        if (!value) return '\u2014'
        const parsed = new Date(value)
        return Number.isNaN(parsed.getTime()) ? '\u2014' : dateFormatter.format(parsed)
    }

    return (
        <section className="rounded-[24px] border border-emerald-500/25 bg-emerald-500/[0.06] p-4 sm:p-5">
            <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                    <CalendarClock className="h-5 w-5" />
                </span>
                <div>
                    <h3 className="font-bold text-foreground">{t('workspacePayments.prepaidTerm.title')}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {t('workspacePayments.prepaidTerm.description')}
                    </p>
                </div>
            </div>

            <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-2xl bg-background/80 p-3 ring-1 ring-border/60">
                    <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <CreditCard className="h-3.5 w-3.5" />
                        {t('workspacePayments.prepaidTerm.monthlyPrice')}
                    </dt>
                    <dd className="mt-1 font-bold text-foreground">
                        {formatWorkspacePaymentDecimal(configuration.monthlyListPrice, locale, 3)} {currencyLabel}
                    </dd>
                </div>
                <div className="rounded-2xl bg-background/80 p-3 ring-1 ring-border/60">
                    <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <Gauge className="h-3.5 w-3.5" />
                        {usesTermPool
                            ? t('workspacePayments.prepaidTerm.termAllowance')
                            : t('workspacePayments.prepaidTerm.monthlyAllowance')}
                    </dt>
                    <dd className="mt-1 font-bold text-foreground">
                        {formatWorkspacePaymentDecimal(
                            usesTermPool ? configuration.termAllowanceGb : configuration.monthlyAllowanceGb,
                            locale,
                            6
                        )} GB
                    </dd>
                </div>
                <div className="rounded-2xl bg-background/80 p-3 ring-1 ring-border/60">
                    <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <RefreshCw className="h-3.5 w-3.5" />
                        {t('workspacePayments.prepaidTerm.cycles')}
                    </dt>
                    <dd className="mt-1 font-bold text-foreground">{configuration.prepaidCycles ?? '\u2014'}</dd>
                </div>
                <div className="rounded-2xl bg-background/80 p-3 ring-1 ring-border/60">
                    <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <BadgePercent className="h-3.5 w-3.5" />
                        {t('workspacePayments.prepaidTerm.amountPaid')}
                    </dt>
                    <dd className="mt-1 font-bold text-foreground">
                        {formatWorkspacePaymentDecimal(configuration.prepaidAmount, locale, 3)} {currencyLabel}
                    </dd>
                </div>
                <div className="rounded-2xl bg-background/80 p-3 ring-1 ring-border/60">
                    <dt className="text-xs font-medium text-muted-foreground">
                        {t('workspacePayments.prepaidTerm.startedAt')}
                    </dt>
                    <dd className="mt-1 font-bold text-foreground">{formatDate(configuration.prepaidTermStartedAt)}</dd>
                </div>
                <div className="rounded-2xl bg-background/80 p-3 ring-1 ring-border/60">
                    <dt className="text-xs font-medium text-muted-foreground">
                        {t('workspacePayments.prepaidTerm.paidThrough')}
                    </dt>
                    <dd className="mt-1 font-bold text-foreground">{formatDate(configuration.renewalDueAt)}</dd>
                </div>
            </dl>

            <p className="mt-3 text-xs font-medium text-emerald-800 dark:text-emerald-200">
                {usesTermPool
                    ? t('workspacePayments.prepaidTerm.termPoolNoMonthlyReset')
                    : t('workspacePayments.prepaidTerm.noRollover')}
            </p>
        </section>
    )
}

function TransactionHistory({
    transactions,
    locale,
    iqdDisplayPreference,
    showHeading = true,
    showDivider = true,
    t
}: {
    transactions: WorkspacePaymentTransaction[]
    locale: string
    iqdDisplayPreference: string
    showHeading?: boolean
    showDivider?: boolean
    t: ReturnType<typeof useTranslation>['t']
}) {
    const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short'
    }), [locale])

    return (
        <section className={cn(
            'space-y-3',
            showDivider && 'border-t border-border/60 pt-5'
        )}>
            {showHeading && (
                <h3 className="text-sm font-bold text-foreground">
                    {t('workspacePayments.statusHistory')}
                </h3>
            )}
            {transactions.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                    {t('workspacePayments.noTransactions')}
                </p>
            ) : (
                <div className="max-h-56 space-y-2 overflow-y-auto pe-1">
                    {transactions.map((transaction) => {
                        const status = getStatusPresentation(transaction.status, t)
                        const StatusIcon = status.icon
                        const createdAt = new Date(transaction.createdAt)
                        const paidAt = transaction.paidAt ? new Date(transaction.paidAt) : null

                        return (
                            <article key={transaction.id} className="rounded-xl border border-border/60 bg-muted/20 p-3">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div>
                                        <p className="font-semibold text-foreground">
                                            {transaction.provider === 'fib'
                                                ? t('workspacePayments.fib')
                                                : transaction.provider === 'qicard'
                                                    ? t('workspacePayments.qicard')
                                                    : transaction.provider === 'free'
                                                        ? t('workspacePayments.freeRenewal', 'Free Renewal')
                                                        : t('workspacePayments.manualProvider')}
                                        </p>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {formatWorkspacePaymentDecimal(transaction.amount, locale, 3)} {transaction.currency === WORKSPACE_PAYMENT_CURRENCY
                                                ? getWorkspacePaymentCurrencyLabel(iqdDisplayPreference)
                                                : transaction.currency}
                                            {' \u00b7 '}{formatWorkspacePaymentDecimal(
                                                transaction.paymentType === 'prepaid_term'
                                                    ? transaction.prepaidAllowanceMode === 'term_pool'
                                                        ? transaction.termAllowanceGb ?? '0'
                                                        : transaction.monthlyAllowanceGb ?? '0'
                                                    : transaction.gbAdded,
                                                locale,
                                                6
                                            )} GB
                                        </p>
                                    </div>
                                    <span className={cn(
                                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ring-1',
                                        status.className
                                    )}>
                                        <StatusIcon className="h-3.5 w-3.5" />
                                        {status.label}
                                    </span>
                                </div>
                                <dl className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                                    <div>
                                        <dt className="font-medium">{t('workspacePayments.submittedAt')}</dt>
                                        <dd>{Number.isNaN(createdAt.getTime()) ? '\u2014' : dateFormatter.format(createdAt)}</dd>
                                    </div>
                                    {paidAt && (
                                        <div>
                                            <dt className="font-medium">{t('workspacePayments.paidAt')}</dt>
                                            <dd>{Number.isNaN(paidAt.getTime()) ? '\u2014' : dateFormatter.format(paidAt)}</dd>
                                        </div>
                                    )}
                                </dl>
                                {transaction.reviewNote && (
                                    <p className="mt-3 rounded-lg bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                                        <span className="font-semibold text-foreground">{t('workspacePayments.reviewNote')}: </span>
                                        {transaction.reviewNote}
                                    </p>
                                )}
                            </article>
                        )
                    })}
                </div>
            )}
        </section>
    )
}

function ProviderButton({
    provider,
    selected,
    onSelect,
    label,
    currencyLabel
}: {
    provider: WorkspacePaymentProvider
    selected: boolean
    onSelect: (provider: WorkspacePaymentProvider) => void
    label: string
    currencyLabel: string
}) {
    const isFree = provider === 'free'
    const providerIcon = provider === 'fib' ? '/icons/fib.svg' : '/icons/qi.svg'
    return (
        <button
            type="button"
            onClick={() => onSelect(provider)}
            aria-pressed={selected}
            className={cn(
                'flex min-h-[5.5rem] items-center gap-3 rounded-2xl border p-4 text-start transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5',
                selected
                    ? 'border-primary bg-primary/[0.08] shadow-sm ring-1 ring-primary/20'
                    : 'border-border/70 bg-background hover:border-primary/40 hover:bg-accent/40'
            )}
        >
            <span className={cn(
                'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl',
                selected ? 'bg-background shadow-sm ring-1 ring-primary/15' : 'bg-muted'
            )}>
                {isFree ? (
                    <Gift className="h-5 w-5 text-foreground" />
                ) : (
                    <img
                        src={providerIcon}
                        alt=""
                        aria-hidden="true"
                        className="h-8 w-8 rounded-lg object-contain"
                    />
                )}
            </span>
            <span>
                <span className="block text-sm font-bold text-foreground">{label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                    {isFree ? 'No payment required' : currencyLabel}
                </span>
            </span>
        </button>
    )
}

export function WorkspacePaymentController() {
    const { t, i18n } = useTranslation()
    const { isAuthenticated, user } = useAuth()
    const {
        activeWorkspace,
        features,
        isDemoMode,
        paymentSummary,
        isPaymentSummaryLoading,
        refreshPaymentSummary,
        refreshFeatures
    } = useWorkspace()
    const [open, setOpen] = useState(false)
    const [selectedProvider, setSelectedProvider] = useState<WorkspacePaymentProvider | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [submitted, setSubmitted] = useState(false)
    const [submittedTransactionId, setSubmittedTransactionId] = useState<string | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [accountHolderName, setAccountHolderName] = useState('')
    const [savedAccountHolderNames, setSavedAccountHolderNames] = useState<string[]>([])
    const [isSavedAccountHolderNamesLoading, setIsSavedAccountHolderNamesLoading] = useState(false)
    const [isConfirmationHighlighted, setIsConfirmationHighlighted] = useState(false)
    const [confirmationDelayEndsAt, setConfirmationDelayEndsAt] = useState<number | null>(
        () => paymentConfirmationDelayEndsAtForSession
    )
    const [confirmationDelayRemainingMs, setConfirmationDelayRemainingMs] = useState(
        () => getPaymentConfirmationDelayRemaining(paymentConfirmationDelayEndsAtForSession)
    )
    const [paygSummary, setPaygSummary] = useState<WorkspacePaygSummary | null>(null)
    const submissionGuardRef = useRef(false)
    const previousSummaryRef = useRef<WorkspacePaymentSummary | null>(null)
    const refreshPaymentSummaryRef = useRef(refreshPaymentSummary)
    const refreshFeaturesRef = useRef(refreshFeatures)

    useEffect(() => {
        refreshPaymentSummaryRef.current = refreshPaymentSummary
        refreshFeaturesRef.current = refreshFeatures
    }, [refreshFeatures, refreshPaymentSummary])

    useEffect(() => {
        const handleOpen = () => {
            setPaygSummary(null)
            setOpen(true)
            void getWorkspacePaygSummary()
                .then((summary) => setPaygSummary(summary.enabled ? summary : null))
                .catch((error) => setLoadError(getErrorMessage(error)))
        }
        window.addEventListener(OPEN_WORKSPACE_PAYMENT_DIALOG_EVENT, handleOpen)
        return () => window.removeEventListener(OPEN_WORKSPACE_PAYMENT_DIALOG_EVENT, handleOpen)
    }, [])

    useEffect(() => {
        setOpen(false)
        setSelectedProvider(null)
        setSubmitted(false)
        setSubmittedTransactionId(null)
        setLoadError(null)
        setSubmitError(null)
        setAccountHolderName('')
        setSavedAccountHolderNames([])
        setIsSavedAccountHolderNamesLoading(false)
        setPaygSummary(null)
        setIsConfirmationHighlighted(false)
        submissionGuardRef.current = false
        previousSummaryRef.current = null
    }, [activeWorkspace?.id])

    useEffect(() => {
        if (!open) return
        const config = paymentSummary?.configuration
        if (!config) return
        if (config.subscriptionAmount === '0' && selectedProvider === null) {
            setSelectedProvider('free')
        }
    }, [open, paymentSummary?.configuration, selectedProvider])

    useEffect(() => {
        const previousSummary = previousSummaryRef.current
        previousSummaryRef.current = paymentSummary

        if (
            hasNewlyApprovedWorkspacePayment(previousSummary, paymentSummary)
            || hasWorkspacePaymentAccessBeenRestored(previousSummary, paymentSummary)
        ) {
            void refreshFeaturesRef.current()
        }
    }, [paymentSummary])

    useEffect(() => {
        if (!isAuthenticated || isDemoMode || !activeWorkspace?.id) return

        const refresh = () => {
            void refreshPaymentSummaryRef.current().catch(() => undefined)
        }
        const intervalMs = paymentSummary?.hasWorkspacePendingTransaction
            ? PENDING_PAYMENT_POLL_INTERVAL_MS
            : PAYMENT_SUMMARY_REFRESH_INTERVAL_MS
        const intervalId = window.setInterval(refresh, intervalMs)
        window.addEventListener('focus', refresh)

        return () => {
            window.clearInterval(intervalId)
            window.removeEventListener('focus', refresh)
        }
    }, [activeWorkspace?.id, isAuthenticated, isDemoMode, paymentSummary?.hasWorkspacePendingTransaction])

    useEffect(() => {
        if (!open || paymentSummary || isPaymentSummaryLoading || isDemoMode || !isAuthenticated) return

        setLoadError(null)
        void refreshPaymentSummaryRef.current().catch((error) => {
            setLoadError(getErrorMessage(error))
        })
    }, [isAuthenticated, isDemoMode, isPaymentSummaryLoading, open, paymentSummary])

    useEffect(() => {
        if (paymentSummary?.pendingTransaction) {
            setSelectedProvider(null)
        }

        if (paymentSummary) {
            setLoadError(null)
        }

        if (!submittedTransactionId) return

        const submittedTransaction = paymentSummary?.pendingTransaction?.id === submittedTransactionId
            ? paymentSummary.pendingTransaction
            : paymentSummary?.transactions.find(({ id }) => id === submittedTransactionId)

        if (submittedTransaction && submittedTransaction.status !== 'pending') {
            setSubmitted(false)
            setSubmittedTransactionId(null)
        }
    }, [paymentSummary, submittedTransactionId])

    useEffect(() => {
        if (!confirmationDelayEndsAt) {
            setConfirmationDelayRemainingMs(0)
            return
        }

        const updateRemainingTime = () => {
            const remainingMs = getPaymentConfirmationDelayRemaining(confirmationDelayEndsAt)
            setConfirmationDelayRemainingMs(remainingMs)

            if (remainingMs === 0) {
                paymentConfirmationDelayEndsAtForSession = null
                setConfirmationDelayEndsAt(null)
            }
        }

        updateRemainingTime()
        const intervalId = window.setInterval(updateRemainingTime, 250)
        return () => window.clearInterval(intervalId)
    }, [confirmationDelayEndsAt])

    const loadSavedAccountHolderNames = useCallback(() => {
        setIsSavedAccountHolderNamesLoading(true)
        void getSavedWorkspacePaymentAccountHolderNames()
            .then(setSavedAccountHolderNames)
            .catch((error) => {
                console.warn('[WorkspacePayment] Failed to load saved account holder names:', error)
            })
            .finally(() => setIsSavedAccountHolderNamesLoading(false))
    }, [])

    if (!isAuthenticated || isDemoMode || user?.role !== 'admin') return null

    const locale = i18n.language || 'en'
    const workspacePaymentCurrencyLabel = getWorkspacePaymentCurrencyLabel(features.iqd_display_preference)
    const configuration = paymentSummary?.configuration ?? null
    const paygMode = Boolean(configuration?.paygEnabled)
    const prepaidTermActive = configuration?.billingInterval === 'prepaid_term'
    const paygPaymentDue = Boolean(paygMode && paygSummary?.enabled && paygSummary.cycleStatus === 'awaiting_payment')
    const isFreeRenewal = Boolean(!paygMode && configuration && Number(configuration.subscriptionAmount) === 0)
    const alertKind = getWorkspacePaymentAlertKind(paymentSummary)
    const alertCopy = prepaidTermActive
        ? {
            title: t('workspacePayments.prepaidTerm.title'),
            description: t('workspacePayments.prepaidTerm.description')
        }
        : paygPaymentDue
            ? {
            title: t('workspacePayments.payg.paymentSubmission'),
            description: t('workspacePayments.payg.paymentSubmissionDescription')
            }
            : getAlertCopy(alertKind, t)
    const pendingTransaction = paymentSummary?.pendingTransaction ?? null
    const hasWorkspacePendingTransaction = paymentSummary?.hasWorkspacePendingTransaction ?? false
    const paymentEnabled = paygMode
        ? paygPaymentDue
        : Boolean(configuration?.isPaymentEnabled && paymentSummary?.eligibility.paymentEnabled)
    const gbForPayment = paygMode
        ? paygSummary?.chargedUsageGb ?? '0'
        : configuration?.usageEnabled
        ? configuration.gbPerPayment
        : '0'
    const paymentAmount = paygMode
        ? paygSummary?.amountIqd ?? configuration?.subscriptionAmount ?? '0'
        : configuration?.subscriptionAmount ?? '0'
    const isConfirmationDelayActive = confirmationDelayRemainingMs > 0
    const confirmationDelaySeconds = Math.ceil(confirmationDelayRemainingMs / 1000)
    const normalizedAccountHolderName = normalizeWorkspacePaymentAccountHolderName(accountHolderName)
    const isAccountHolderNameIncomplete = Boolean(normalizedAccountHolderName)
        && !isValidWorkspacePaymentAccountHolderName(normalizedAccountHolderName)
    const paymentSummaryCardClass = cn(
        'rounded-2xl p-3 transition-all duration-200',
        isConfirmationHighlighted
            ? 'bg-primary/[0.09] ring-2 ring-primary/55 shadow-lg shadow-primary/20'
            : 'bg-muted/[0.28] ring-1 ring-border/60'
    )

    const handleSubmit = async () => {
        if (!selectedProvider || !paymentEnabled) {
            return
        }

        if (selectedProvider !== 'free' && !isValidWorkspacePaymentAccountHolderName(normalizedAccountHolderName)) {
            setSubmitError(t('workspacePayments.accountHolderNameThreeWordsRequired'))
            return
        }

        if (isConfirmationDelayActive || submissionGuardRef.current || !canSubmitWorkspacePayment({
            provider: selectedProvider,
            accountHolderName: normalizedAccountHolderName,
            isSubmitting,
            hasWorkspacePendingTransaction,
            pendingTransaction
        })) {
            return
        }

        submissionGuardRef.current = true
        setIsSubmitting(true)
        setSubmitError(null)
        setAccountHolderName(normalizedAccountHolderName)

        try {
            let transaction: WorkspacePaymentTransaction
            if (paygMode) {
                if (!paygPaymentDue || selectedProvider === 'free') {
                    throw new Error(t('workspacePayments.payg.paymentNotDue'))
                }
                transaction = await submitWorkspacePaygPayment(selectedProvider, normalizedAccountHolderName)
            } else {
                transaction = await submitWorkspacePayment(selectedProvider, normalizedAccountHolderName)
            }
            setSubmitted(true)
            setSubmittedTransactionId(transaction.id)
            setSelectedProvider(null)
            await refreshPaymentSummaryRef.current()
            if (paygMode) {
                const refreshedPayg = await getWorkspacePaygSummary()
                setPaygSummary(refreshedPayg.enabled ? refreshedPayg : null)
            }
        } catch (error) {
            // A database uniqueness guard may have accepted the first request
            // even if this client lost its response. Refresh before presenting
            // an error so the existing pending transaction remains authoritative.
            try {
                const refreshed = await refreshPaymentSummaryRef.current()
                if (refreshed?.pendingTransaction) {
                    setSubmitted(true)
                    setSubmittedTransactionId(refreshed.pendingTransaction.id)
                    setSelectedProvider(null)
                    return
                }
            } catch {
                // Preserve the original submission error below.
            }
            setSubmitError(getErrorMessage(error))
        } finally {
            submissionGuardRef.current = false
            setIsSubmitting(false)
        }
    }

    const handleProviderSelect = (provider: WorkspacePaymentProvider) => {
        setSelectedProvider(provider)

        if (provider === 'free' || hasUsedPaymentConfirmationDelay) return

        const endsAt = Date.now() + PAYMENT_CONFIRMATION_DELAY_MS
        hasUsedPaymentConfirmationDelay = true
        paymentConfirmationDelayEndsAtForSession = endsAt
        setConfirmationDelayEndsAt(endsAt)
        setConfirmationDelayRemainingMs(PAYMENT_CONFIRMATION_DELAY_MS)
    }

    const retryLoad = () => {
        setLoadError(null)
        void refreshPaymentSummaryRef.current().catch((error) => {
            setLoadError(getErrorMessage(error))
        })
    }

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => {
            setOpen(nextOpen)
            if (!nextOpen) {
                setSelectedProvider(null)
                setSubmitError(null)
                setAccountHolderName('')
                setIsConfirmationHighlighted(false)
            }
        }}>
            <DialogContent className="max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1rem)] max-w-6xl overflow-y-auto rounded-[28px] p-0 shadow-2xl">
                <div className="border-b border-border/60 bg-gradient-to-br from-primary/[0.12] via-background to-amber-500/[0.07] px-5 py-5 sm:px-8 sm:py-6">
                    <DialogHeader className="pe-10 text-start">
                        <div className="flex items-start gap-4">
                            <span className="flex h-[3.25rem] w-[3.25rem] shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
                                <CreditCard className="h-6 w-6" />
                            </span>
                            <div className="space-y-1.5">
                                <DialogTitle className="text-xl sm:text-2xl">{alertCopy.title}</DialogTitle>
                                <DialogDescription className="max-w-2xl leading-relaxed">
                                    {alertCopy.description}
                                </DialogDescription>
                            </div>
                        </div>
                    </DialogHeader>
                </div>

                <div className="space-y-6 px-5 py-5 sm:px-8 sm:py-7">
                    {isPaymentSummaryLoading && !paymentSummary ? (
                        <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-muted-foreground">
                            <RefreshCw className="h-6 w-6 animate-spin" />
                            <p className="text-sm">{t('workspacePayments.loading')}</p>
                        </div>
                    ) : loadError ? (
                        <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
                            <AlertCircle className="h-8 w-8 text-destructive" />
                            <div>
                                <p className="font-semibold text-foreground">{t('workspacePayments.loadFailed')}</p>
                                <p className="mt-1 max-w-md text-sm text-muted-foreground">{loadError}</p>
                            </div>
                            <Button allowViewer={true} variant="outline" onClick={retryLoad}>
                                <RefreshCw className="h-4 w-4" />
                                {t('workspacePayments.retry')}
                            </Button>
                        </div>
                    ) : !configuration && !paygPaymentDue ? (
                        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-5 text-center">
                            <AlertCircle className="mx-auto h-8 w-8 text-amber-600 dark:text-amber-300" />
                            <h3 className="mt-3 font-bold text-foreground">{t('workspacePayments.paymentUnavailableTitle')}</h3>
                            <p className="mt-1 text-sm text-muted-foreground">{t('workspacePayments.noConfiguration')}</p>
                        </div>
                    ) : (
                        <>
                            {(submitted || pendingTransaction) && (
                                <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4">
                                    <div className="flex items-start gap-3">
                                        <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
                                        <div>
                                            <p className="font-bold text-foreground">{t('workspacePayments.submittedTitle')}</p>
                                            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                                                {t('workspacePayments.submittedMessage')}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {prepaidTermActive && configuration && (
                                <PrepaidTermSummary
                                    configuration={configuration}
                                    locale={locale}
                                    iqdDisplayPreference={features.iqd_display_preference}
                                    t={t}
                                />
                            )}

                            {!paymentEnabled && !hasWorkspacePendingTransaction && !prepaidTermActive && (
                                <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4">
                                    <p className="font-bold text-foreground">{t('workspacePayments.paymentUnavailableTitle')}</p>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        {t('workspacePayments.paymentUnavailableDescription')}
                                    </p>
                                </div>
                            )}

                            {hasWorkspacePendingTransaction && !pendingTransaction && (
                                <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4">
                                    <div className="flex items-start gap-3">
                                        <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
                                        <p className="text-sm font-medium text-foreground">
                                            {t('workspacePayments.pendingAlreadyExists')}
                                        </p>
                                    </div>
                                </div>
                            )}

                            {!hasWorkspacePendingTransaction && paymentEnabled && (
                                <div className="grid overflow-hidden rounded-[28px] border border-border/70 bg-background shadow-sm md:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
                                    <section className="flex min-h-[34rem] flex-col border-b border-border/60 bg-primary/[0.045] p-5 sm:p-7 md:border-b-0 md:border-e">
                                        <div className="mb-5">
                                            <h3 className="text-sm font-bold text-foreground">
                                                {t('workspacePayments.selectProvider')}
                                            </h3>
                                        </div>
                                        <div className="grid gap-3 sm:grid-cols-2">
                                            {isFreeRenewal ? (
                                                <ProviderButton
                                                    provider="free"
                                                    selected={selectedProvider === 'free'}
                                                    onSelect={handleProviderSelect}
                                                    label={t('workspacePayments.freeRenewal', 'Free Renewal')}
                                                    currencyLabel={workspacePaymentCurrencyLabel}
                                                />
                                            ) : (
                                                <>
                                                    <ProviderButton
                                                        provider="fib"
                                                        selected={selectedProvider === 'fib'}
                                                        onSelect={handleProviderSelect}
                                                        label={t('workspacePayments.fib')}
                                                        currencyLabel={workspacePaymentCurrencyLabel}
                                                    />
                                                    <ProviderButton
                                                        provider="qicard"
                                                        selected={selectedProvider === 'qicard'}
                                                        onSelect={handleProviderSelect}
                                                        label={t('workspacePayments.qicard')}
                                                        currencyLabel={workspacePaymentCurrencyLabel}
                                                    />
                                                </>
                                            )}
                                        </div>

                                        <div className="mt-6 flex flex-1 flex-col items-center justify-center">
                                            {selectedProvider === 'free' ? (
                                                <div className="flex aspect-square w-full max-w-[20rem] flex-col items-center justify-center rounded-3xl border border-dashed border-primary/30 bg-background/70 p-6 text-center">
                                                    <Gift className="h-10 w-10 text-primary" />
                                                    <p className="mt-3 text-sm font-bold text-foreground">
                                                        {t('workspacePayments.freeRenewal', 'Free Renewal')}
                                                    </p>
                                                </div>
                                            ) : selectedProvider ? (
                                                <div className="w-full max-w-[20rem] rounded-[28px] bg-white p-4 shadow-xl ring-1 ring-black/[0.05]">
                                                    <div className="mb-3 flex items-center justify-center gap-2 text-sm font-bold text-primary">
                                                        <QrCode className="h-5 w-5" />
                                                        <span>{selectedProvider === 'fib' ? t('workspacePayments.fib') : t('workspacePayments.qicard')}</span>
                                                    </div>
                                                    <img
                                                        src={getWorkspacePaymentQrPath(selectedProvider)!}
                                                        alt={t('workspacePayments.qrAlt', {
                                                            provider: selectedProvider === 'fib'
                                                                ? t('workspacePayments.fib')
                                                                : t('workspacePayments.qicard')
                                                        })}
                                                        className="aspect-square w-full rounded-2xl object-contain"
                                                    />
                                                    {selectedProvider === 'fib' && (
                                                        <div className="mt-3 text-center">
                                                            <p className="text-xs font-medium text-slate-500">
                                                                {t('workspacePayments.or', { defaultValue: 'or' })}
                                                            </p>
                                                            <a
                                                                href="tel:+9647701990012"
                                                                dir="ltr"
                                                                className="mt-0.5 inline-block text-sm font-bold tracking-wide text-slate-800 hover:text-primary hover:underline"
                                                            >
                                                                0770 199 0012
                                                            </a>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : (
                                                <div className="flex aspect-square w-full max-w-[20rem] flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-background/70 p-6 text-center text-muted-foreground">
                                                    <QrCode className="h-11 w-11" />
                                                    <p className="mt-3 text-sm font-medium">
                                                        {t('workspacePayments.selectProvider')}
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </section>

                                    <section className="flex min-h-[34rem] flex-col p-5 sm:p-7">
                                        <div className="space-y-1.5">
                                            <h3 className="text-xl font-bold text-foreground">
                                                {t('workspacePayments.paymentInstructions')}
                                            </h3>
                                            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                                                {t('workspacePayments.dialogDescription')}
                                            </p>
                                        </div>

                                        {selectedProvider ? (
                                            <>
                                                <dl className="mt-6 grid grid-cols-2 gap-2.5 sm:gap-3">
                                                    <div className={paymentSummaryCardClass}>
                                                        <dt className="text-[11px] font-semibold text-muted-foreground">{t('workspacePayments.amount')}</dt>
                                                        <dd className="mt-1 text-sm font-black tabular-nums text-foreground sm:text-base">
                                                            {formatWorkspacePaymentDecimal(paymentAmount, locale, 3)} {workspacePaymentCurrencyLabel}
                                                        </dd>
                                                    </div>
                                                    <div className={paymentSummaryCardClass}>
                                                        <dt className="text-[11px] font-semibold text-muted-foreground">{t('workspacePayments.gigabytes')}</dt>
                                                        <dd className="mt-1 text-sm font-black tabular-nums text-foreground sm:text-base">
                                                            {formatWorkspacePaymentDecimal(gbForPayment, locale, 6)} GB
                                                        </dd>
                                                    </div>
                                                </dl>

                                                {selectedProvider !== 'free' && (
                                                    <div className="mt-5 space-y-2">
                                                        <div className="flex items-center justify-between gap-3">
                                                            <Label htmlFor="workspace-payment-account-holder-name" isLoading={isSavedAccountHolderNamesLoading}>
                                                                {t('workspacePayments.accountHolderName')}
                                                            </Label>
                                                            <span className="text-xs font-semibold text-destructive">*</span>
                                                        </div>
                                                        <PaymentAccountHolderNameAutocomplete
                                                            id="workspace-payment-account-holder-name"
                                                            value={accountHolderName}
                                                            suggestions={savedAccountHolderNames}
                                                            onChange={(value) => setAccountHolderName(value.toUpperCase())}
                                                            onSelect={(name) => setAccountHolderName(
                                                                normalizeWorkspacePaymentAccountHolderName(name)
                                                            )}
                                                            onFocus={loadSavedAccountHolderNames}
                                                            onBlur={() => setAccountHolderName(normalizedAccountHolderName)}
                                                            placeholder={selectedProvider === 'fib'
                                                                ? t('workspacePayments.fibAccountHolderNameHint')
                                                                : t('workspacePayments.qiCardAccountHolderNameHint')}
                                                            isInvalid={isAccountHolderNameIncomplete}
                                                            inputClassName={cn(
                                                                isAccountHolderNameIncomplete
                                                                && 'border-destructive text-destructive focus-visible:border-destructive focus-visible:ring-destructive/30'
                                                            )}
                                                            required={true}
                                                            disabled={isSubmitting}
                                                            isLoading={isSavedAccountHolderNamesLoading}
                                                        />
                                                        {isAccountHolderNameIncomplete && (
                                                            <p role="alert" aria-live="polite" className="text-xs font-medium text-destructive">
                                                                {t('workspacePayments.accountHolderNameThreeWordsRequired')}
                                                            </p>
                                                        )}
                                                    </div>
                                                )}

                                                {submitError && (
                                                    <p role="alert" className="mt-5 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                                        {submitError}
                                                    </p>
                                                )}

                                                <div className="mt-6 space-y-2">
                                                    <PressAndHoldButton
                                                        onComplete={() => void handleSubmit()}
                                                        idleLabel={isConfirmationDelayActive
                                                            ? t('workspacePayments.completePaymentBeforeConfirm', {
                                                                seconds: confirmationDelaySeconds
                                                            })
                                                            : t('workspacePayments.holdToConfirm')}
                                                        holdingLabel={t('workspacePayments.keepHolding')}
                                                        loadingLabel={t('workspacePayments.submitting')}
                                                        isLoading={isSubmitting}
                                                        disabled={isConfirmationDelayActive || !canSubmitWorkspacePayment({
                                                            provider: selectedProvider,
                                                            accountHolderName: normalizedAccountHolderName,
                                                            isSubmitting,
                                                            hasWorkspacePendingTransaction,
                                                            pendingTransaction
                                                        })}
                                                        className={cn(
                                                            'h-[3.25rem] w-full rounded-2xl font-bold shadow-sm',
                                                            isConfirmationDelayActive && 'bg-muted text-muted-foreground shadow-none hover:bg-muted'
                                                        )}
                                                        onMouseEnter={() => setIsConfirmationHighlighted(true)}
                                                        onMouseLeave={() => setIsConfirmationHighlighted(false)}
                                                        onFocus={() => setIsConfirmationHighlighted(true)}
                                                        onBlur={() => setIsConfirmationHighlighted(false)}
                                                    />
                                                    <p className="text-center text-xs text-muted-foreground">
                                                        {t('workspacePayments.pendingMessage')}
                                                    </p>
                                                </div>
                                            </>
                                        ) : (
                                            <div className="flex flex-1 items-center justify-center py-10 text-center">
                                                <div className="max-w-xs text-muted-foreground">
                                                    <CreditCard className="mx-auto h-9 w-9 text-primary/70" />
                                                    <p className="mt-3 text-sm leading-relaxed">
                                                        {t('workspacePayments.selectProvider')}
                                                    </p>
                                                </div>
                                            </div>
                                        )}

                                        <div className="mt-6">
                                            <TransactionHistory
                                                transactions={paymentSummary?.transactions ?? []}
                                                locale={locale}
                                                iqdDisplayPreference={features.iqd_display_preference}
                                                t={t}
                                            />
                                        </div>
                                    </section>
                                </div>
                            )}

                            {(hasWorkspacePendingTransaction || !paymentEnabled) && (
                                <TransactionHistory
                                    transactions={paymentSummary?.transactions ?? []}
                                    locale={locale}
                                    iqdDisplayPreference={features.iqd_display_preference}
                                    t={t}
                                />
                            )}
                        </>
                    )}
                </div>

                <DialogFooter className="border-t border-border/60 bg-muted/[0.12] px-5 py-4 sm:px-8">
                    <Button allowViewer={true} variant="outline" onClick={() => setOpen(false)}>
                        {t('workspacePayments.close')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

export function WorkspacePaymentStatusDialog() {
    const { t, i18n } = useTranslation()
    const { isAuthenticated } = useAuth()
    const {
        activeWorkspace,
        features,
        isDemoMode,
        paymentSummary,
        isPaymentSummaryLoading,
        refreshPaymentSummary,
    } = useWorkspace()
    const [open, setOpen] = useState(false)
    const [loadError, setLoadError] = useState<string | null>(null)

    const refreshStatus = useCallback(async () => {
        setLoadError(null)
        try {
            await refreshPaymentSummary()
        } catch (error) {
            setLoadError(getErrorMessage(error))
        }
    }, [refreshPaymentSummary])

    useEffect(() => {
        const handleOpen = () => {
            setOpen(true)
            void refreshStatus()
        }

        window.addEventListener(OPEN_WORKSPACE_PAYMENT_STATUS_DIALOG_EVENT, handleOpen)
        return () => window.removeEventListener(OPEN_WORKSPACE_PAYMENT_STATUS_DIALOG_EVENT, handleOpen)
    }, [refreshStatus])

    useEffect(() => {
        setOpen(false)
        setLoadError(null)
    }, [activeWorkspace?.id])

    if (!isAuthenticated || isDemoMode) return null

    const locale = i18n.language || 'en'

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto rounded-[28px] p-0 shadow-2xl">
                <div className="border-b border-border/60 bg-gradient-to-br from-primary/[0.12] via-background to-amber-500/[0.07] px-5 py-5 sm:px-8 sm:py-6">
                    <DialogHeader className="pe-10 text-start">
                        <div className="flex items-start gap-4">
                            <span className="flex h-[3.25rem] w-[3.25rem] shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
                                <CreditCard className="h-6 w-6" />
                            </span>
                            <div className="space-y-1.5">
                                <DialogTitle className="text-xl sm:text-2xl">
                                    {t('workspacePayments.statusHistory')}
                                </DialogTitle>
                                <DialogDescription className="max-w-2xl leading-relaxed">
                                    {t('workspacePayments.historyDescription')}
                                </DialogDescription>
                            </div>
                        </div>
                    </DialogHeader>
                </div>

                <div className="px-5 py-5 sm:px-8 sm:py-7">
                    {isPaymentSummaryLoading && !paymentSummary ? (
                        <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-muted-foreground">
                            <RefreshCw className="h-6 w-6 animate-spin" />
                            <p className="text-sm">{t('workspacePayments.loading')}</p>
                        </div>
                    ) : loadError ? (
                        <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
                            <AlertCircle className="h-8 w-8 text-destructive" />
                            <div>
                                <p className="font-semibold text-foreground">{t('workspacePayments.loadFailed')}</p>
                                <p className="mt-1 max-w-md text-sm text-muted-foreground">{loadError}</p>
                            </div>
                            <Button allowViewer={true} variant="outline" onClick={() => void refreshStatus()}>
                                <RefreshCw className="h-4 w-4" />
                                {t('workspacePayments.retry')}
                            </Button>
                        </div>
                    ) : (
                        <div className="space-y-5">
                            {paymentSummary?.configuration?.billingInterval === 'prepaid_term' && (
                                <PrepaidTermSummary
                                    configuration={paymentSummary.configuration}
                                    locale={locale}
                                    iqdDisplayPreference={features.iqd_display_preference}
                                    t={t}
                                />
                            )}
                            <TransactionHistory
                                transactions={paymentSummary?.transactions ?? []}
                                locale={locale}
                                iqdDisplayPreference={features.iqd_display_preference}
                                showHeading={false}
                                showDivider={false}
                                t={t}
                            />
                        </div>
                    )}
                </div>

                <DialogFooter className="border-t border-border/60 bg-muted/[0.12] px-5 py-4 sm:px-8">
                    <Button allowViewer={true} variant="outline" onClick={() => setOpen(false)}>
                        {t('workspacePayments.close')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
