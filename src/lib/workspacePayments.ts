import { supabase } from '@/auth/supabase'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { WORKSPACE_PAYMENT_HOLD_DURATION_MS } from '@/lib/pressAndHold'

export const WORKSPACE_PAYMENT_CURRENCY = 'IQD' as const
export const OPEN_WORKSPACE_PAYMENT_DIALOG_EVENT = 'open-workspace-payment-dialog'
export const OPEN_WORKSPACE_PAYMENT_STATUS_DIALOG_EVENT = 'open-workspace-payment-status-dialog'
export const OPEN_WORKSPACE_EXTRA_DAYS_DIALOG_EVENT = 'open-workspace-extra-days-dialog'
export { WORKSPACE_PAYMENT_HOLD_DURATION_MS }

export type WorkspacePaymentProvider = 'fib' | 'qicard' | 'free'
export type WorkspacePaymentTransactionProvider = WorkspacePaymentProvider | 'manual'
export type WorkspacePaymentStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'unknown'
export type WorkspacePaymentType = 'subscription' | 'usage' | 'payg' | 'prepaid_term' | 'unknown'
export type WorkspaceBillingInterval = 'monthly' | 'prepaid_term'
export type WorkspaceBillingMode = 'subscription' | 'usage' | 'prepaidTerm' | 'payg'
export type WorkspacePrepaidAllowanceMode = 'monthly_reset' | 'term_pool'
export type WorkspacePaymentAlertKind =
    | 'subscription_expired'
    | 'usage_exhausted'
    | 'usage_renewal_due'
    | 'payg_renewal_due'

export interface WorkspacePaymentConfiguration {
    id: string
    workspaceId: string
    subscriptionAmount: string
    currency: typeof WORKSPACE_PAYMENT_CURRENCY
    isPaymentEnabled: boolean
    usageEnabled: boolean
    paygEnabled: boolean
    gbPerPayment: string
    renewalDueAt: string | null
    usageStartDate: string | null
    billingInterval: WorkspaceBillingInterval
    monthlyListPrice: string
    monthlyAllowanceGb: string
    prepaidAllowanceMode: WorkspacePrepaidAllowanceMode
    termAllowanceGb: string
    prepaidCycles: number | null
    prepaidAmount: string
    prepaidTermStartedAt: string | null
    rolloverEnabled: boolean
}

export interface WorkspacePaymentTransaction {
    id: string
    provider: WorkspacePaymentTransactionProvider
    accountHolderName: string | null
    amount: string
    currency: string
    gbAdded: string
    paymentType: WorkspacePaymentType
    status: WorkspacePaymentStatus
    expiresAt: string | null
    paidAt: string | null
    reviewNote: string | null
    createdAt: string
    monthlyListPrice: string | null
    monthlyAllowanceGb: string | null
    prepaidAllowanceMode: WorkspacePrepaidAllowanceMode | null
    termAllowanceGb: string | null
    prepaidCycles: number | null
    termStartedAt: string | null
    termPaidThroughAt: string | null
}

export interface WorkspacePaymentEligibility {
    subscriptionExpired: boolean
    usageExhausted: boolean
    usageRenewalDue: boolean
    alertReason: string | null
    paymentEnabled: boolean
}

export interface WorkspaceSubscriptionExtraDays {
    id: string
    workspaceId: string
    extraDays: number
    grantedAt: string
    temporaryPeriodStartsAt: string
    consumedDurationSeconds: number
    remainingDurationSeconds: number
}

export interface WorkspacePaymentSummary {
    workspaceId: string
    billingWorkspaceId: string
    workspaceName: string
    configuration: WorkspacePaymentConfiguration | null
    eligibility: WorkspacePaymentEligibility
    hasWorkspacePendingTransaction: boolean
    pendingTransaction: WorkspacePaymentTransaction | null
    pendingExtraDays: WorkspaceSubscriptionExtraDays | null
    transactions: WorkspacePaymentTransaction[]
}

export type WorkspacePaygCycleStatus = 'open' | 'awaiting_payment' | 'paid' | 'no_payment_required'
export type WorkspacePaygLimitMetric = 'accrued_charge' | 'changed_usage'

export interface WorkspacePaygLimit {
    metric: WorkspacePaygLimitMetric
    threshold: string
    currentValue: string
    locked: boolean
    createdAt: string | null
    updatedAt: string | null
}

export interface WorkspacePaygLimitState {
    workspaceId: string
    billingWorkspaceId: string
    enabled: boolean
    hasLimit: boolean
    locked: boolean
    limit: WorkspacePaygLimit | null
    metrics: Record<WorkspacePaygLimitMetric, string>
}

export interface WorkspacePaygCheckpoint {
    gb: number
    amountIqd: number
    protected: boolean
}

export interface WorkspacePaygCycleHistory {
    id: string
    periodStartedAt: string
    periodEndedAt: string | null
    chargedUsageBytes: number
    chargedUsageGb: string
    amountIqd: string
    status: WorkspacePaygCycleStatus
    pricingVersion: number
    pricingProfileId: string | null
    pricingProfileName: string | null
    paymentTransactionId: string | null
}

export interface WorkspacePaygSummary {
    enabled: boolean
    workspaceId: string
    billingWorkspaceId: string
    isInherited: boolean
    canSubmitPayment: boolean
    cycleId: string | null
    cycleStatus: WorkspacePaygCycleStatus | null
    cycleStartedAt: string | null
    renewalDueAt: string | null
    chargedUsageBytes: number
    chargedUsageGb: string
    amountIqd: string
    currency: typeof WORKSPACE_PAYMENT_CURRENCY
    pricingVersionId: string | null
    pricingVersion: number | null
    pricingProfileId: string | null
    pricingProfileName: string | null
    pricingCheckpoints: WorkspacePaygCheckpoint[]
    pendingBillingMode: 'monthly' | 'prepaid_usage' | null
    lastUpdatedAt: string | null
    history: WorkspacePaygCycleHistory[]
    paymentHistory: WorkspacePaymentTransaction[]
    paygLimitState: WorkspacePaygLimitState | null
}

type UnknownRecord = Record<string, unknown>

const SUPPORTED_PROVIDERS = new Set<WorkspacePaymentProvider>(['fib', 'qicard', 'free'])
const SUPPORTED_STATUSES = new Set<Exclude<WorkspacePaymentStatus, 'unknown'>>([
    'pending',
    'approved',
    'rejected',
    'expired'
])
const SUPPORTED_PAYMENT_TYPES = new Set<Exclude<WorkspacePaymentType, 'unknown'>>([
    'subscription',
    'usage',
    'payg',
    'prepaid_term'
])

let submitPaymentInFlight: Promise<WorkspacePaymentTransaction> | null = null
let grantExtraDaysInFlight: Promise<WorkspaceSubscriptionExtraDays> | null = null

function isRecord(value: unknown): value is UnknownRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function unwrapRpcJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value[0] ?? null
    }

    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as unknown
        } catch {
            return value
        }
    }

    return value
}

function getText(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback
}

function getNullableText(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null
}

function getDecimalText(value: unknown): string {
    const raw = typeof value === 'string'
        ? value.trim()
        : typeof value === 'number' && Number.isFinite(value)
            ? Math.max(0, value).toLocaleString('en-US', {
                useGrouping: false,
                maximumFractionDigits: 20
            })
            : ''

    return /^\d+(?:\.\d+)?$/.test(raw) ? raw : '0'
}

export function normalizeWorkspacePaymentAccountHolderName(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toUpperCase()
}

export function isValidWorkspacePaymentAccountHolderName(value: string): boolean {
    return normalizeWorkspacePaymentAccountHolderName(value).split(' ').filter(Boolean).length >= 3
}

export function formatWorkspacePaymentDecimal(
    value: string,
    locale: string,
    maximumFractionDigits: number
): string {
    const [rawWhole, rawFraction = ''] = getDecimalText(value).split('.')
    const whole = rawWhole.replace(/^0+(?=\d)/, '') || '0'
    const fraction = rawFraction
        .slice(0, Math.max(0, maximumFractionDigits))
        .replace(/0+$/, '')

    try {
        const integerFormatter = new Intl.NumberFormat(locale, {
            useGrouping: true,
            maximumFractionDigits: 0
        })
        const formattedWhole = integerFormatter.format(BigInt(whole))
        if (!fraction) return formattedWhole

        const decimalSeparator = new Intl.NumberFormat(locale, {
            minimumFractionDigits: 1
        }).formatToParts(1.1).find(({ type }) => type === 'decimal')?.value ?? '.'
        const digitFormatter = new Intl.NumberFormat(locale, {
            useGrouping: false,
            maximumFractionDigits: 0
        })
        const localizedFraction = Array.from(fraction, (digit) => (
            digitFormatter.format(Number(digit))
        )).join('')

        return `${formattedWhole}${decimalSeparator}${localizedFraction}`
    } catch {
        return fraction ? `${whole}.${fraction}` : whole
    }
}

function getBoolean(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback
}

function normalizeProvider(value: unknown): WorkspacePaymentTransactionProvider {
    return value === 'qicard'
        ? 'qicard'
        : value === 'free'
            ? 'free'
            : value === 'manual'
                ? 'manual'
                : 'fib'
}

function getSafeInteger(value: unknown): number {
    const number = typeof value === 'number' ? value : Number(value)
    return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function normalizeStatus(value: unknown): WorkspacePaymentStatus {
    return typeof value === 'string' && SUPPORTED_STATUSES.has(value as Exclude<WorkspacePaymentStatus, 'unknown'>)
        ? value as Exclude<WorkspacePaymentStatus, 'unknown'>
        : 'unknown'
}

function normalizePaymentType(value: unknown): WorkspacePaymentType {
    return typeof value === 'string' && SUPPORTED_PAYMENT_TYPES.has(value as Exclude<WorkspacePaymentType, 'unknown'>)
        ? value as Exclude<WorkspacePaymentType, 'unknown'>
        : 'unknown'
}

function normalizeConfiguration(value: unknown): WorkspacePaymentConfiguration | null {
    if (!isRecord(value)) return null

    return {
        id: getText(value.id),
        workspaceId: getText(value.workspace_id),
        subscriptionAmount: getDecimalText(value.subscription_amount),
        currency: WORKSPACE_PAYMENT_CURRENCY,
        isPaymentEnabled: getBoolean(value.is_payment_enabled),
        usageEnabled: getBoolean(value.usage_enabled),
        paygEnabled: getBoolean(value.payg_enabled),
        gbPerPayment: getDecimalText(value.gb_per_payment),
        renewalDueAt: getNullableText(value.renewal_due_at),
        usageStartDate: getNullableText(value.usage_start_date),
        billingInterval: value.billing_interval === 'prepaid_term' ? 'prepaid_term' : 'monthly',
        monthlyListPrice: getDecimalText(value.monthly_list_price ?? value.subscription_amount),
        monthlyAllowanceGb: getDecimalText(value.monthly_allowance_gb ?? value.gb_per_payment),
        prepaidAllowanceMode: value.prepaid_allowance_mode === 'monthly_reset'
            ? 'monthly_reset'
            : 'term_pool',
        termAllowanceGb: getDecimalText(value.term_allowance_gb),
        prepaidCycles: value.billing_interval === 'prepaid_term'
            ? getSafeInteger(value.prepaid_cycles) || null
            : null,
        prepaidAmount: getDecimalText(value.prepaid_amount),
        prepaidTermStartedAt: getNullableText(value.prepaid_term_started_at),
        rolloverEnabled: getBoolean(value.rollover_enabled)
    }
}

export function normalizeWorkspacePaymentTransaction(value: unknown): WorkspacePaymentTransaction | null {
    if (!isRecord(value)) return null

    const id = getText(value.id)
    if (!id) return null

    return {
        id,
        provider: normalizeProvider(value.provider),
        accountHolderName: getNullableText(value.account_holder_name),
        amount: getDecimalText(value.amount),
        currency: getText(value.currency, WORKSPACE_PAYMENT_CURRENCY).toUpperCase(),
        gbAdded: getDecimalText(value.gb_added),
        paymentType: normalizePaymentType(value.payment_type),
        status: normalizeStatus(value.status),
        expiresAt: getNullableText(value.expires_at),
        paidAt: getNullableText(value.paid_at),
        reviewNote: getNullableText(value.review_note),
        createdAt: getText(value.created_at, new Date(0).toISOString()),
        monthlyListPrice: getNullableText(value.monthly_list_price),
        monthlyAllowanceGb: getNullableText(value.monthly_allowance_gb),
        prepaidAllowanceMode: value.payment_type === 'prepaid_term'
            ? value.prepaid_allowance_mode === 'monthly_reset' ? 'monthly_reset' : 'term_pool'
            : null,
        termAllowanceGb: getNullableText(value.term_allowance_gb),
        prepaidCycles: value.payment_type === 'prepaid_term'
            ? getSafeInteger(value.prepaid_cycles) || null
            : null,
        termStartedAt: getNullableText(value.term_started_at),
        termPaidThroughAt: getNullableText(value.term_paid_through_at)
    }
}

export function normalizeWorkspaceSubscriptionExtraDays(value: unknown): WorkspaceSubscriptionExtraDays | null {
    if (!isRecord(value)) return null

    const id = getText(value.id)
    const workspaceId = getText(value.workspace_id)
    const extraDays = typeof value.extra_days === 'number'
        ? value.extra_days
        : typeof value.extra_days === 'string'
            ? Number(value.extra_days)
            : Number.NaN
    const grantedAt = getNullableText(value.granted_at)
    const temporaryPeriodStartsAt = getNullableText(value.temporary_period_starts_at) ?? grantedAt
    const maximumDurationSeconds = extraDays * 24 * 60 * 60
    const rawConsumedDurationSeconds = typeof value.consumed_duration_seconds === 'number'
        ? value.consumed_duration_seconds
        : typeof value.consumed_duration_seconds === 'string'
            ? Number(value.consumed_duration_seconds)
            : 0
    const consumedDurationSeconds = Number.isInteger(rawConsumedDurationSeconds)
        ? rawConsumedDurationSeconds
        : Number.NaN
    const rawRemainingDurationSeconds = typeof value.remaining_duration_seconds === 'number'
        ? value.remaining_duration_seconds
        : typeof value.remaining_duration_seconds === 'string'
            ? Number(value.remaining_duration_seconds)
            : maximumDurationSeconds - consumedDurationSeconds
    const remainingDurationSeconds = Number.isInteger(rawRemainingDurationSeconds)
        ? rawRemainingDurationSeconds
        : Number.NaN

    if (
        !id
        || !workspaceId
        || !Number.isInteger(extraDays)
        || extraDays < 1
        || extraDays > 6
        || !grantedAt
        || !temporaryPeriodStartsAt
        || consumedDurationSeconds < 0
        || remainingDurationSeconds < 0
        || consumedDurationSeconds + remainingDurationSeconds !== maximumDurationSeconds
    ) {
        return null
    }

    return {
        id,
        workspaceId,
        extraDays,
        grantedAt,
        temporaryPeriodStartsAt,
        consumedDurationSeconds,
        remainingDurationSeconds
    }
}

export function normalizeWorkspacePaymentSummary(value: unknown): WorkspacePaymentSummary {
    const unwrapped = unwrapRpcJson(value)
    if (!isRecord(unwrapped)) {
        throw new Error('Workspace payment summary is invalid')
    }

    const configuration = normalizeConfiguration(unwrapped.configuration)
    const rawEligibility = isRecord(unwrapped.eligibility) ? unwrapped.eligibility : {}
    const transactions = (Array.isArray(unwrapped.transactions) ? unwrapped.transactions : [])
        .map(normalizeWorkspacePaymentTransaction)
        .filter((transaction): transaction is WorkspacePaymentTransaction => Boolean(transaction))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    const explicitPending = normalizeWorkspacePaymentTransaction(unwrapped.pending_transaction)
    const pendingTransaction = explicitPending?.status === 'pending'
        ? explicitPending
        : transactions.find((transaction) => transaction.status === 'pending') ?? null
    const pendingExtraDays = normalizeWorkspaceSubscriptionExtraDays(unwrapped.pending_extra_days)

    return {
        workspaceId: getText(unwrapped.workspace_id),
        billingWorkspaceId: getText(unwrapped.billing_workspace_id, getText(unwrapped.workspace_id)),
        workspaceName: getText(unwrapped.workspace_name),
        configuration,
        eligibility: {
            subscriptionExpired: getBoolean(rawEligibility.subscription_expired),
            usageExhausted: getBoolean(rawEligibility.usage_exhausted),
            usageRenewalDue: getBoolean(rawEligibility.usage_renewal_due),
            alertReason: getNullableText(rawEligibility.alert_reason),
            paymentEnabled: getBoolean(
                rawEligibility.payment_enabled,
                Boolean(configuration?.isPaymentEnabled)
            )
        },
        hasWorkspacePendingTransaction: getBoolean(
            unwrapped.has_workspace_pending_transaction,
            Boolean(pendingTransaction)
        ),
        pendingTransaction,
        pendingExtraDays,
        transactions
    }
}

export function isWorkspacePaymentProvider(value: unknown): value is WorkspacePaymentProvider {
    return typeof value === 'string' && SUPPORTED_PROVIDERS.has(value as WorkspacePaymentProvider)
}

export function getWorkspacePaymentQrPath(provider: WorkspacePaymentProvider): string | null {
    if (provider === 'free') return null
    return provider === 'fib' ? '/qr_code_fib.png' : '/qr_code_qicard.png'
}

export function openWorkspacePaymentDialog() {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_PAYMENT_DIALOG_EVENT))
}

export function normalizeWorkspacePaygSummary(value: unknown): WorkspacePaygSummary {
    const unwrapped = unwrapRpcJson(value)
    if (!isRecord(unwrapped)) throw new Error('Workspace PAYG summary is invalid')

    const normalizeCycleStatus = (status: unknown): WorkspacePaygCycleStatus | null => (
        status === 'open' || status === 'awaiting_payment' || status === 'paid' || status === 'no_payment_required'
            ? status
            : null
    )
    const checkpoints = (Array.isArray(unwrapped.pricing_checkpoints) ? unwrapped.pricing_checkpoints : [])
        .flatMap((checkpoint): WorkspacePaygCheckpoint[] => {
            if (!isRecord(checkpoint)) return []
            const gb = Number(checkpoint.gb)
            const amountIqd = Number(checkpoint.amount_iqd)
            return Number.isFinite(gb) && Number.isInteger(amountIqd)
                ? [{ gb, amountIqd, protected: getBoolean(checkpoint.protected) }]
                : []
        })
        .sort((left, right) => left.gb - right.gb)
    const history = (Array.isArray(unwrapped.history) ? unwrapped.history : [])
        .flatMap((cycle): WorkspacePaygCycleHistory[] => {
            if (!isRecord(cycle)) return []
            const status = normalizeCycleStatus(cycle.status)
            const id = getText(cycle.id)
            if (!id || !status) return []
            return [{
                id,
                periodStartedAt: getText(cycle.period_started_at),
                periodEndedAt: getNullableText(cycle.period_ended_at),
                chargedUsageBytes: getSafeInteger(cycle.charged_usage_bytes),
                chargedUsageGb: getDecimalText(cycle.charged_usage_gb),
                amountIqd: getDecimalText(cycle.amount_iqd),
                status,
                pricingVersion: getSafeInteger(cycle.pricing_version),
                pricingProfileId: getNullableText(cycle.pricing_profile_id),
                pricingProfileName: getNullableText(cycle.pricing_profile_name),
                paymentTransactionId: getNullableText(cycle.payment_transaction_id)
            }]
        })
    const paymentHistory = (Array.isArray(unwrapped.payment_history) ? unwrapped.payment_history : [])
        .map(normalizeWorkspacePaymentTransaction)
        .filter((transaction): transaction is WorkspacePaymentTransaction => Boolean(transaction))
    const limitStateValue = isRecord(unwrapped.payg_limit_state) ? unwrapped.payg_limit_state : null
    const limitValue = limitStateValue && isRecord(limitStateValue.limit) ? limitStateValue.limit : null
    const limitMetric = limitValue?.metric === 'accrued_charge' || limitValue?.metric === 'changed_usage'
        ? limitValue.metric
        : null
    const paygLimitState: WorkspacePaygLimitState | null = limitStateValue
        ? {
            workspaceId: getText(limitStateValue.workspace_id),
            billingWorkspaceId: getText(limitStateValue.billing_workspace_id),
            enabled: getBoolean(limitStateValue.enabled),
            hasLimit: getBoolean(limitStateValue.has_limit) && Boolean(limitMetric),
            locked: getBoolean(limitStateValue.locked),
            limit: limitMetric && limitValue
                ? {
                    metric: limitMetric,
                    threshold: getDecimalText(limitValue.threshold),
                    currentValue: getDecimalText(limitValue.current_value),
                    locked: getBoolean(limitValue.locked),
                    createdAt: getNullableText(limitValue.created_at),
                    updatedAt: getNullableText(limitValue.updated_at)
                }
                : null,
            metrics: {
                accrued_charge: getDecimalText(
                    isRecord(limitStateValue.metrics) ? limitStateValue.metrics.accrued_charge : undefined
                ),
                changed_usage: getDecimalText(
                    isRecord(limitStateValue.metrics) ? limitStateValue.metrics.changed_usage : undefined
                )
            }
        }
        : null

    return {
        enabled: getBoolean(unwrapped.enabled),
        workspaceId: getText(unwrapped.workspace_id),
        billingWorkspaceId: getText(unwrapped.billing_workspace_id),
        isInherited: getBoolean(unwrapped.is_inherited),
        canSubmitPayment: getBoolean(unwrapped.can_submit_payment),
        cycleId: getNullableText(unwrapped.cycle_id),
        cycleStatus: normalizeCycleStatus(unwrapped.cycle_status),
        cycleStartedAt: getNullableText(unwrapped.cycle_started_at),
        renewalDueAt: getNullableText(unwrapped.renewal_due_at),
        chargedUsageBytes: getSafeInteger(unwrapped.charged_usage_bytes),
        chargedUsageGb: getDecimalText(unwrapped.charged_usage_gb),
        amountIqd: getDecimalText(unwrapped.amount_iqd),
        currency: WORKSPACE_PAYMENT_CURRENCY,
        pricingVersionId: getNullableText(unwrapped.pricing_version_id),
        pricingVersion: unwrapped.pricing_version === null || unwrapped.pricing_version === undefined
            ? null
            : getSafeInteger(unwrapped.pricing_version),
        pricingProfileId: getNullableText(unwrapped.pricing_profile_id),
        pricingProfileName: getNullableText(unwrapped.pricing_profile_name),
        pricingCheckpoints: checkpoints,
        pendingBillingMode: unwrapped.pending_billing_mode === 'monthly' || unwrapped.pending_billing_mode === 'prepaid_usage'
            ? unwrapped.pending_billing_mode
            : null,
        lastUpdatedAt: getNullableText(unwrapped.last_updated_at),
        history,
        paymentHistory,
        paygLimitState
    }
}

export function openWorkspacePaymentStatusDialog() {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_PAYMENT_STATUS_DIALOG_EVENT))
}

export function openWorkspaceExtraDaysDialog() {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_EXTRA_DAYS_DIALOG_EVENT))
}

export function getWorkspacePaymentAlertKind(
    summary?: WorkspacePaymentSummary | null
): WorkspacePaymentAlertKind | null {
    if (!summary) return null

    if (summary.configuration?.paygEnabled && summary.eligibility.usageRenewalDue) {
        return 'payg_renewal_due'
    }
    if (summary.eligibility.usageExhausted || summary.eligibility.alertReason === 'usage_exhausted') {
        return 'usage_exhausted'
    }
    if (summary.eligibility.usageRenewalDue || summary.eligibility.alertReason === 'usage_renewal_due') {
        return 'usage_renewal_due'
    }
    if (summary.eligibility.subscriptionExpired || summary.eligibility.alertReason === 'subscription_expired') {
        return 'subscription_expired'
    }

    return null
}

export function shouldWorkspacePaymentLockAccess(summary?: WorkspacePaymentSummary | null): boolean {
    return getWorkspacePaymentAlertKind(summary) !== null
}

export function getWorkspaceBillingMode(
    summary: WorkspacePaymentSummary | null | undefined,
    hasUsageLimits: boolean,
    paygEnabled = false
): WorkspaceBillingMode {
    const configuration = summary?.configuration

    if (configuration) {
        if (configuration.paygEnabled) return 'payg'
        if (configuration.billingInterval === 'prepaid_term') return 'prepaidTerm'
        return configuration.usageEnabled ? 'usage' : 'subscription'
    }

    if (paygEnabled) return 'payg'
    if (hasUsageLimits) return 'usage'
    return 'subscription'
}

export function getWorkspacePaymentExpiryDate(options: {
    renewalDueAt?: string | null
    summary?: WorkspacePaymentSummary | null
}): string | null {
    // Every configured billing mode exposes its deadline through the central
    // configuration; monthly subscriptions no longer use workspace metadata.
    if (options.summary?.configuration) {
        return options.summary.configuration.renewalDueAt
    }
    return options.renewalDueAt ?? null
}

export function isWorkspacePaymentAccessExpired(options: {
    renewalDueAt?: string | null
    summary?: WorkspacePaymentSummary | null
    billingMode?: WorkspaceBillingMode
    now?: Date
}): boolean {
    const billingMode = options.billingMode ?? getWorkspaceBillingMode(options.summary, false)
    if (billingMode === 'payg') return false

    const expiryDate = getWorkspacePaymentExpiryDate(options)
    if (!expiryDate) return false

    const expiryMs = Date.parse(expiryDate)
    if (Number.isNaN(expiryMs)) return false

    return expiryMs <= (options.now ?? new Date()).getTime()
}

export function hasWorkspacePaymentAccessStateUpdate(
    current: {
        lockedWorkspace: boolean
    },
    incoming: {
        locked_workspace?: unknown
    }
): boolean {
    return typeof incoming.locked_workspace === 'boolean'
        && incoming.locked_workspace !== current.lockedWorkspace
}

export function hasNewlyApprovedWorkspacePayment(
    previousSummary: WorkspacePaymentSummary | null,
    nextSummary: WorkspacePaymentSummary | null
): boolean {
    if (!previousSummary || !nextSummary) return false

    const previousStatuses = new Map(
        previousSummary.transactions.map((transaction) => [transaction.id, transaction.status])
    )
    if (previousSummary.pendingTransaction) {
        previousStatuses.set(previousSummary.pendingTransaction.id, previousSummary.pendingTransaction.status)
    }

    return nextSummary.transactions.some((transaction) => (
        transaction.status === 'approved'
        && previousStatuses.get(transaction.id) === 'pending'
    ))
}

export function hasWorkspacePaymentAccessBeenRestored(
    previousSummary: WorkspacePaymentSummary | null,
    nextSummary: WorkspacePaymentSummary | null
): boolean {
    return Boolean(
        getWorkspacePaymentAlertKind(previousSummary)
        && !getWorkspacePaymentAlertKind(nextSummary)
    )
}

export function canSubmitWorkspacePayment(options: {
    provider: WorkspacePaymentProvider | null
    accountHolderName?: string
    isSubmitting: boolean
    hasWorkspacePendingTransaction?: boolean
    pendingTransaction?: WorkspacePaymentTransaction | null
}) {
    return Boolean(
        options.provider
        && (options.provider === 'free' || isValidWorkspacePaymentAccountHolderName(options.accountHolderName ?? ''))
        && !options.isSubmitting
        && !options.hasWorkspacePendingTransaction
        && !options.pendingTransaction
    )
}

export async function getWorkspacePaymentSummary(): Promise<WorkspacePaymentSummary> {
    const result = await runSupabaseAction(
        'workspacePayments.getSummary',
        () => supabase.rpc('get_workspace_payment_summary'),
        { timeoutMs: 12_000, platform: 'all' }
    ) as { data: unknown; error?: unknown }

    if (result.error) {
        throw normalizeSupabaseActionError(result.error)
    }

    return normalizeWorkspacePaymentSummary(result.data)
}

export async function getWorkspacePaygSummary(): Promise<WorkspacePaygSummary> {
    const result = await runSupabaseAction(
        'workspacePayments.getPaygSummary',
        () => supabase.rpc('get_workspace_payg_summary_with_limit'),
        { timeoutMs: 12_000, platform: 'all' }
    ) as { data: unknown; error?: unknown }
    if (result.error) throw normalizeSupabaseActionError(result.error)
    return normalizeWorkspacePaygSummary(result.data)
}

export async function saveWorkspacePaygLimit(
    metric: WorkspacePaygLimitMetric,
    threshold: string
): Promise<WorkspacePaygSummary> {
    const normalizedThreshold = threshold.trim().replace(/,/g, '')
    if (!Number.isFinite(Number(normalizedThreshold)) || Number(normalizedThreshold) <= 0) {
        throw new Error('invalid_workspace_payg_limit_threshold')
    }
    const result = await runSupabaseAction(
        'workspacePayments.savePaygLimit',
        () => supabase.rpc('admin_upsert_workspace_payg_limit', {
            p_metric: metric,
            p_threshold: normalizedThreshold
        }),
        { timeoutMs: 12_000, platform: 'all' }
    ) as { data: unknown; error?: unknown }
    if (result.error) throw normalizeSupabaseActionError(result.error)
    return normalizeWorkspacePaygSummary(result.data)
}

export async function removeWorkspacePaygLimit(): Promise<WorkspacePaygSummary> {
    const result = await runSupabaseAction(
        'workspacePayments.removePaygLimit',
        () => supabase.rpc('admin_delete_workspace_payg_limit'),
        { timeoutMs: 12_000, platform: 'all' }
    ) as { data: unknown; error?: unknown }
    if (result.error) throw normalizeSupabaseActionError(result.error)
    return normalizeWorkspacePaygSummary(result.data)
}

export async function submitWorkspacePaygPayment(
    provider: Exclude<WorkspacePaymentProvider, 'free'>,
    accountHolderName: string
): Promise<WorkspacePaymentTransaction> {
    const normalizedName = normalizeWorkspacePaymentAccountHolderName(accountHolderName)
    if (!isValidWorkspacePaymentAccountHolderName(normalizedName)) {
        throw new Error('Account holder name must contain at least three words')
    }
    const result = await runSupabaseAction(
        'workspacePayments.submitPayg',
        () => supabase.rpc('submit_workspace_payg_payment', {
            p_provider: provider,
            p_account_holder_name: normalizedName
        }),
        { timeoutMs: 12_000, platform: 'all' }
    ) as { data: unknown; error?: unknown }
    if (result.error) throw normalizeSupabaseActionError(result.error)
    const transaction = normalizeWorkspacePaymentTransaction(unwrapRpcJson(result.data))
    if (!transaction) throw new Error('Workspace PAYG payment transaction is invalid')
    return transaction
}

export async function getSavedWorkspacePaymentAccountHolderNames(): Promise<string[]> {
    const result = await runSupabaseAction(
        'workspacePayments.getSavedAccountHolderNames',
        () => supabase.rpc('list_workspace_payment_account_holder_names'),
        { timeoutMs: 12_000, platform: 'all' }
    ) as { data: unknown; error?: unknown }

    if (result.error) {
        throw normalizeSupabaseActionError(result.error)
    }

    // This RPC returns a JSONB array directly. Unlike the summary response,
    // an array here represents the saved names themselves rather than rows to unwrap.
    const names = typeof result.data === 'string'
        ? unwrapRpcJson(result.data)
        : result.data
    if (!Array.isArray(names)) return []

    return [...new Set(names.flatMap((name) => {
        if (typeof name !== 'string') return []
        const normalized = normalizeWorkspacePaymentAccountHolderName(name)
        return isValidWorkspacePaymentAccountHolderName(normalized) ? [normalized] : []
    }))]
}

async function performWorkspaceSubscriptionExtraDaysGrant(
    extraDays: number
): Promise<WorkspaceSubscriptionExtraDays> {
    const result = await runSupabaseAction(
        'workspacePayments.grantExtraDays',
        () => supabase.rpc('grant_workspace_subscription_extra_days', {
            p_extra_days: extraDays
        }),
        { timeoutMs: 12_000, platform: 'all' }
    ) as { data: unknown; error?: unknown }

    if (result.error) {
        throw normalizeSupabaseActionError(result.error)
    }

    const grant = normalizeWorkspaceSubscriptionExtraDays(unwrapRpcJson(result.data))
    if (!grant) {
        throw new Error('Workspace extra-days grant is invalid')
    }

    return grant
}

export function grantWorkspaceSubscriptionExtraDays(
    extraDays: number
): Promise<WorkspaceSubscriptionExtraDays> {
    if (!Number.isInteger(extraDays) || extraDays < 1 || extraDays > 6) {
        return Promise.reject(new Error('Extra days must be between 1 and 6'))
    }

    if (grantExtraDaysInFlight) {
        return grantExtraDaysInFlight
    }

    const request = performWorkspaceSubscriptionExtraDaysGrant(extraDays)
    const guardedRequest = request.finally(() => {
        grantExtraDaysInFlight = null
    })
    grantExtraDaysInFlight = guardedRequest
    return guardedRequest
}

async function performWorkspacePaymentSubmission(
    provider: WorkspacePaymentProvider,
    accountHolderName: string
): Promise<WorkspacePaymentTransaction> {
    const result = await runSupabaseAction(
        'workspacePayments.submit',
        () => supabase.rpc('submit_workspace_payment', {
            p_provider: provider,
            p_account_holder_name: accountHolderName || null
        }),
        { timeoutMs: 12_000, platform: 'all' }
    ) as { data: unknown; error?: unknown }

    if (result.error) {
        throw normalizeSupabaseActionError(result.error)
    }

    const transaction = normalizeWorkspacePaymentTransaction(unwrapRpcJson(result.data))
    if (!transaction) {
        throw new Error('Workspace payment transaction is invalid')
    }

    return transaction
}

export function submitWorkspacePayment(
    provider: WorkspacePaymentProvider,
    accountHolderName = ''
): Promise<WorkspacePaymentTransaction> {
    if (!isWorkspacePaymentProvider(provider)) {
        return Promise.reject(new Error('Unsupported payment provider'))
    }

    const normalizedAccountHolderName = normalizeWorkspacePaymentAccountHolderName(accountHolderName)
    if (provider !== 'free' && !isValidWorkspacePaymentAccountHolderName(normalizedAccountHolderName)) {
        return Promise.reject(new Error('Account holder name must contain at least three words'))
    }

    if (submitPaymentInFlight) {
        return submitPaymentInFlight
    }

    const request = performWorkspacePaymentSubmission(provider, normalizedAccountHolderName)
    const guardedRequest = request.finally(() => {
        submitPaymentInFlight = null
    })
    submitPaymentInFlight = guardedRequest
    return guardedRequest
}

export const workspacePaymentTestInternals = {
    resetSubmissionGuard() {
        submitPaymentInFlight = null
        grantExtraDaysInFlight = null
    }
}
