import { beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
    rpc: vi.fn()
}))

vi.mock('@/auth/supabase', () => ({
    supabase: {
        rpc: testState.rpc
    }
}))

vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: vi.fn((_label: string, action: () => PromiseLike<unknown>) => action()),
    normalizeSupabaseActionError: (error: unknown) => error instanceof Error ? error : new Error(String(error))
}))

import {
    WORKSPACE_PAYMENT_CURRENCY,
    canSubmitWorkspacePayment,
    formatWorkspacePaymentDecimal,
    grantWorkspaceSubscriptionExtraDays,
    getWorkspacePaymentAlertKind,
    getWorkspacePaymentExpiryDate,
    getWorkspacePaymentQrPath,
    isWorkspacePaymentAccessExpired,
    getSavedWorkspacePaymentAccountHolderNames,
    hasWorkspacePaymentAccessStateUpdate,
    hasNewlyApprovedWorkspacePayment,
    hasWorkspacePaymentAccessBeenRestored,
    isWorkspacePaymentProvider,
    isValidWorkspacePaymentAccountHolderName,
    normalizeWorkspacePaymentAccountHolderName,
    normalizeWorkspacePaymentSummary,
    normalizeWorkspacePaygSummary,
    normalizeWorkspaceSubscriptionExtraDays,
    shouldApplyWorkspaceSubscriptionExpiry,
    shouldWorkspacePaymentLockAccess,
    submitWorkspacePayment,
    submitWorkspacePaygPayment,
    workspacePaymentTestInternals,
    type WorkspacePaymentSummary
} from './workspacePayments'

const transaction = (overrides: Record<string, unknown> = {}) => ({
    id: 'transaction-1',
    provider: 'fib',
    amount: 25_000,
    currency: 'IQD',
    gb_added: 10,
    payment_type: 'usage',
    status: 'pending',
    expires_at: '2026-07-16T12:00:00.000Z',
    paid_at: null,
    review_note: null,
    created_at: '2026-07-15T12:00:00.000Z',
    ...overrides
})

const summary = (overrides: Record<string, unknown> = {}) => normalizeWorkspacePaymentSummary({
    workspace_id: 'workspace-1',
    billing_workspace_id: 'workspace-1',
    workspace_name: 'Atlas Shop',
    configuration: {
        id: 'configuration-1',
        workspace_id: 'workspace-1',
        subscription_amount: 30_000,
        currency: 'USD',
        is_payment_enabled: true,
        usage_enabled: true,
        gb_per_payment: 15,
        renewal_due_at: '2026-07-15T00:00:00.000Z'
    },
    eligibility: {
        subscription_expired: false,
        usage_exhausted: true,
        usage_renewal_due: false,
        alert_reason: 'usage_exhausted',
        payment_enabled: true
    },
    pending_transaction: transaction(),
    has_workspace_pending_transaction: true,
    transactions: [transaction()],
    ...overrides
})

describe('workspace payments', () => {
    beforeEach(() => {
        testState.rpc.mockReset()
        workspacePaymentTestInternals.resetSubmissionGuard()
    })

    it('normalizes server-owned configuration and transaction snapshots', () => {
        const result = summary({
            configuration: {
                id: 'configuration-1',
                workspace_id: 'workspace-1',
                subscription_amount: 99_000,
                currency: 'USD',
                is_payment_enabled: true,
                usage_enabled: true,
                gb_per_payment: 50
            },
            pending_transaction: transaction({ amount: 25_000, gb_added: 10 }),
            transactions: [transaction({ amount: 25_000, gb_added: 10 })]
        })

        expect(result.configuration).toMatchObject({
            subscriptionAmount: '99000',
            currency: WORKSPACE_PAYMENT_CURRENCY,
            gbPerPayment: '50'
        })
        expect(result.pendingTransaction).toMatchObject({
            amount: '25000',
            currency: 'IQD',
            gbAdded: '10'
        })
    })

    it('normalizes prepaid-term configuration and immutable payment snapshots', () => {
        const result = summary({
            configuration: {
                id: 'configuration-1',
                workspace_id: 'workspace-1',
                subscription_amount: '10000',
                monthly_list_price: '10000',
                monthly_allowance_gb: '15',
                prepaid_allowance_mode: 'term_pool',
                term_allowance_gb: '75',
                gb_per_payment: '15',
                currency: 'IQD',
                is_payment_enabled: true,
                usage_enabled: true,
                payg_enabled: false,
                billing_interval: 'prepaid_term',
                prepaid_cycles: 5,
                prepaid_amount: '50000',
                prepaid_term_started_at: '2026-08-01',
                renewal_due_at: '2027-01-01T00:00:00+00:00',
                rollover_enabled: false
            },
            pending_transaction: null,
            has_workspace_pending_transaction: false,
            transactions: [transaction({
                provider: 'manual',
                payment_type: 'prepaid_term',
                amount: '50000',
                gb_added: '0',
                monthly_list_price: '10000',
                monthly_allowance_gb: '15',
                prepaid_allowance_mode: 'term_pool',
                term_allowance_gb: '75',
                prepaid_cycles: 5,
                term_started_at: '2026-08-01',
                term_paid_through_at: '2027-01-01T00:00:00+00:00',
                status: 'approved'
            })]
        })

        expect(result.configuration).toMatchObject({
            billingInterval: 'prepaid_term',
            monthlyListPrice: '10000',
            monthlyAllowanceGb: '15',
            prepaidAllowanceMode: 'term_pool',
            termAllowanceGb: '75',
            prepaidCycles: 5,
            prepaidAmount: '50000',
            prepaidTermStartedAt: '2026-08-01',
            renewalDueAt: '2027-01-01T00:00:00+00:00',
            rolloverEnabled: false
        })
        expect(result.transactions[0]).toMatchObject({
            provider: 'manual',
            paymentType: 'prepaid_term',
            amount: '50000',
            monthlyListPrice: '10000',
            monthlyAllowanceGb: '15',
            prepaidAllowanceMode: 'term_pool',
            termAllowanceGb: '75',
            prepaidCycles: 5,
            termStartedAt: '2026-08-01',
            termPaidThroughAt: '2027-01-01T00:00:00+00:00'
        })
        expect(isWorkspacePaymentProvider('manual')).toBe(false)
    })

    it('preserves and losslessly formats the full supported decimal range', () => {
        const result = summary({
            configuration: {
                id: 'configuration-1',
                workspace_id: 'workspace-1',
                subscription_amount: '99999999999999999.125',
                currency: 'IQD',
                is_payment_enabled: true,
                usage_enabled: true,
                gb_per_payment: '99999999.123456'
            }
        })

        expect(result.configuration?.subscriptionAmount).toBe('99999999999999999.125')
        expect(formatWorkspacePaymentDecimal(
            result.configuration?.subscriptionAmount ?? '0',
            'en',
            3
        )).toBe('99,999,999,999,999,999.125')
        expect(formatWorkspacePaymentDecimal(
            result.configuration?.gbPerPayment ?? '0',
            'en',
            6
        )).toBe('99,999,999.123456')
    })

    it('selects only supported providers and their exact QR assets', () => {
        expect(isWorkspacePaymentProvider('fib')).toBe(true)
        expect(isWorkspacePaymentProvider('qicard')).toBe(true)
        expect(isWorkspacePaymentProvider('other')).toBe(false)
        expect(getWorkspacePaymentQrPath('fib')).toBe('/qr_code_fib.png')
        expect(getWorkspacePaymentQrPath('qicard')).toBe('/qr_code_qicard.png')
    })

    it('derives the usage and subscription alerts that lock access', () => {
        const exhausted = summary()
        const renewalDue = summary({
            eligibility: {
                subscription_expired: false,
                usage_exhausted: false,
                usage_renewal_due: true,
                alert_reason: 'subscription_expired',
                payment_enabled: true
            }
        })
        const expired = summary({
            eligibility: {
                subscription_expired: true,
                usage_exhausted: false,
                usage_renewal_due: false,
                alert_reason: 'subscription_expired',
                payment_enabled: true
            }
        })

        expect(getWorkspacePaymentAlertKind(exhausted)).toBe('usage_exhausted')
        expect(getWorkspacePaymentAlertKind(renewalDue)).toBe('subscription_expired')
        expect(getWorkspacePaymentAlertKind(expired)).toBe('subscription_expired')
        expect(shouldWorkspacePaymentLockAccess(expired)).toBe(true)
        expect(shouldWorkspacePaymentLockAccess(null)).toBe(false)
    })

    it('keeps a due PAYG cycle distinct from Monthly subscription and Prepaid usage alerts', () => {
        const paygDue = summary({
            configuration: {
                id: 'configuration-1',
                workspace_id: 'workspace-1',
                subscription_amount: 3_333,
                currency: 'IQD',
                is_payment_enabled: true,
                usage_enabled: false,
                payg_enabled: true,
                gb_per_payment: 0,
                renewal_due_at: '2026-09-01T00:00:00.000Z'
            },
            eligibility: {
                subscription_expired: false,
                usage_exhausted: false,
                usage_renewal_due: true,
                alert_reason: 'usage_renewal_due',
                payment_enabled: true
            }
        })

        expect(getWorkspacePaymentAlertKind(paygDue)).toBe('payg_renewal_due')
        expect(shouldWorkspacePaymentLockAccess(paygDue)).toBe(true)
    })

    it('normalizes a pending temporary extra-days record from the billing summary', () => {
        const result = summary({
            pending_extra_days: {
                id: 'extra-days-1',
                workspace_id: 'workspace-1',
                extra_days: 4,
                granted_at: '2026-07-18T12:00:00.000Z'
            }
        })

        expect(result.pendingExtraDays).toEqual({
            id: 'extra-days-1',
            workspaceId: 'workspace-1',
            extraDays: 4,
            grantedAt: '2026-07-18T12:00:00.000Z',
            temporaryPeriodStartsAt: '2026-07-18T12:00:00.000Z',
            consumedDurationSeconds: 0,
            remainingDurationSeconds: 345600
        })
        expect(normalizeWorkspaceSubscriptionExtraDays({
            id: 'extra-days-invalid',
            workspace_id: 'workspace-1',
            extra_days: 7,
            granted_at: '2026-07-18T12:00:00.000Z'
        })).toBeNull()
    })

    it('enforces a cached renewal due date while offline', () => {
        const renewalDueAt = '2026-07-15T00:00:00.000Z'
        const now = new Date('2026-07-15T00:00:00.000Z')

        expect(getWorkspacePaymentExpiryDate({
            subscriptionExpiresAt: '2026-08-01T00:00:00.000Z',
            renewalDueAt,
            hasUsageLimits: true,
            summary: null
        })).toBe(renewalDueAt)

        expect(isWorkspacePaymentAccessExpired({
            subscriptionExpiresAt: '2026-08-01T00:00:00.000Z',
            renewalDueAt,
            hasUsageLimits: true,
            summary: null,
            now
        })).toBe(true)
    })

    it('does not fall back to the legacy subscription expiry for usage billing', () => {
        const now = new Date('2026-07-15T00:00:00.000Z')

        expect(getWorkspacePaymentExpiryDate({
            subscriptionExpiresAt: '2026-07-01T00:00:00.000Z',
            renewalDueAt: null,
            hasUsageLimits: true,
            summary: null
        })).toBeNull()

        expect(isWorkspacePaymentAccessExpired({
            subscriptionExpiresAt: '2026-07-01T00:00:00.000Z',
            renewalDueAt: null,
            hasUsageLimits: true,
            summary: null,
            now
        })).toBe(false)
    })

    it('does not apply subscription expiry after the server enables usage billing', () => {
        const usageBilling = summary({
            eligibility: {
                subscription_expired: false,
                usage_exhausted: false,
                usage_renewal_due: false,
                alert_reason: null,
                payment_enabled: true
            }
        })
        const subscriptionBilling = summary({
            configuration: {
                id: 'configuration-1',
                workspace_id: 'workspace-1',
                subscription_amount: 30_000,
                currency: 'IQD',
                is_payment_enabled: true,
                usage_enabled: false,
                gb_per_payment: 0,
                renewal_due_at: null
            }
        })

        expect(shouldApplyWorkspaceSubscriptionExpiry({
            hasUsageLimits: false,
            summary: usageBilling
        })).toBe(true)
        expect(shouldApplyWorkspaceSubscriptionExpiry({
            hasUsageLimits: false,
            summary: subscriptionBilling
        })).toBe(true)
        expect(shouldApplyWorkspaceSubscriptionExpiry({
            hasUsageLimits: true,
            summary: null
        })).toBe(true)
        expect(shouldApplyWorkspaceSubscriptionExpiry({
            hasUsageLimits: false,
            summary: null
        })).toBe(true)
    })

    it('detects realtime access-state changes that require an immediate payment refresh', () => {
        const current = {
            lockedWorkspace: false,
            subscriptionExpiresAt: '2026-08-01T00:00:00.000Z'
        }

        expect(hasWorkspacePaymentAccessStateUpdate(current, {
            locked_workspace: true,
            subscription_expires_at: current.subscriptionExpiresAt
        })).toBe(true)
        expect(hasWorkspacePaymentAccessStateUpdate(current, {
            locked_workspace: false,
            subscription_expires_at: '2026-09-01T00:00:00.000Z'
        })).toBe(true)
        expect(hasWorkspacePaymentAccessStateUpdate(current, {
            locked_workspace: false,
            subscription_expires_at: current.subscriptionExpiresAt
        })).toBe(false)
    })

    it('blocks client submission while another payment is pending', () => {
        expect(canSubmitWorkspacePayment({
            provider: 'fib',
            accountHolderName: 'John Middle Doe',
            isSubmitting: false,
            hasWorkspacePendingTransaction: true,
            pendingTransaction: summary().pendingTransaction
        })).toBe(false)
        expect(canSubmitWorkspacePayment({
            provider: 'qicard',
            accountHolderName: 'Jane Middle Doe',
            isSubmitting: false,
            hasWorkspacePendingTransaction: false,
            pendingTransaction: null
        })).toBe(true)
        expect(canSubmitWorkspacePayment({
            provider: 'fib',
            accountHolderName: 'John Doe',
            isSubmitting: false,
            hasWorkspacePendingTransaction: false,
            pendingTransaction: null
        })).toBe(false)
    })

    it('normalizes account holder names before submitting them', () => {
        expect(normalizeWorkspacePaymentAccountHolderName('  John   doe  ')).toBe('JOHN DOE')
        expect(isValidWorkspacePaymentAccountHolderName('  John   Middle  Doe  ')).toBe(true)
        expect(isValidWorkspacePaymentAccountHolderName('John Doe')).toBe(false)
    })

    it('normalizes saved account holder name suggestions from the current user RPC', async () => {
        testState.rpc.mockResolvedValue({
            data: ['  John   Middle   Doe  ', 'JANE MIDDLE DOE', 'JOHN MIDDLE DOE', 'John Doe', null],
            error: null
        })

        await expect(getSavedWorkspacePaymentAccountHolderNames()).resolves.toEqual(['JOHN MIDDLE DOE', 'JANE MIDDLE DOE'])
        expect(testState.rpc).toHaveBeenCalledWith('list_workspace_payment_account_holder_names')
    })

    it('detects a pending transaction becoming approved', () => {
        const previous = summary()
        const next = summary({
            pending_transaction: null,
            transactions: [transaction({ status: 'approved', paid_at: '2026-07-15T13:00:00.000Z' })]
        })

        expect(hasNewlyApprovedWorkspacePayment(previous, next)).toBe(true)
        expect(hasNewlyApprovedWorkspacePayment(next, next)).toBe(false)
    })

    it('detects workspace access restoration even when another user paid', () => {
        const blocked = summary({
            pending_transaction: null,
            transactions: [],
            has_workspace_pending_transaction: true
        })
        const restored = summary({
            eligibility: {
                subscription_expired: false,
                usage_exhausted: false,
                usage_renewal_due: false,
                alert_reason: null,
                payment_enabled: true
            },
            pending_transaction: null,
            transactions: [],
            has_workspace_pending_transaction: false
        })

        expect(hasWorkspacePaymentAccessBeenRestored(blocked, restored)).toBe(true)
        expect(hasWorkspacePaymentAccessBeenRestored(restored, restored)).toBe(false)
    })

    it('deduplicates concurrent submission attempts in the client', async () => {
        let resolveRpc!: (value: { data: unknown; error: null }) => void
        testState.rpc.mockReturnValue(new Promise((resolve) => {
            resolveRpc = resolve
        }))

        const first = submitWorkspacePayment('fib', '  John   Middle  Doe ')
        const second = submitWorkspacePayment('qicard', 'Jane Middle Doe')

        expect(first).toBe(second)
        expect(testState.rpc).toHaveBeenCalledTimes(1)
        expect(testState.rpc).toHaveBeenCalledWith('submit_workspace_payment', {
            p_provider: 'fib',
            p_account_holder_name: 'JOHN MIDDLE DOE'
        })

        resolveRpc({ data: transaction(), error: null })
        await expect(first).resolves.toMatchObject({ id: 'transaction-1', status: 'pending' })
        await expect(second).resolves.toMatchObject({ id: 'transaction-1', provider: 'fib' })
    })

    it('rejects unsupported providers before calling the server', async () => {
        await expect(submitWorkspacePayment('cash' as never)).rejects.toThrow('Unsupported payment provider')
        expect(testState.rpc).not.toHaveBeenCalled()
    })

    it('requires at least three account holder name words for paid providers before calling the server', async () => {
        await expect(submitWorkspacePayment('fib', 'John Doe')).rejects.toThrow('Account holder name must contain at least three words')
        expect(testState.rpc).not.toHaveBeenCalled()
    })

    it('only submits one valid extra-days grant at a time', async () => {
        testState.rpc.mockResolvedValue({
            data: {
                id: 'extra-days-1',
                workspace_id: 'workspace-1',
                extra_days: 3,
                granted_at: '2026-07-18T12:00:00.000Z'
            },
            error: null
        })

        await expect(grantWorkspaceSubscriptionExtraDays(3)).resolves.toMatchObject({
            id: 'extra-days-1',
            extraDays: 3
        })
        expect(testState.rpc).toHaveBeenCalledWith('grant_workspace_subscription_extra_days', {
            p_extra_days: 3
        })

        await expect(grantWorkspaceSubscriptionExtraDays(0)).rejects.toThrow('Extra days must be between 1 and 6')
        await expect(grantWorkspaceSubscriptionExtraDays(7)).rejects.toThrow('Extra days must be between 1 and 6')
    })

    it('sorts transaction history newest first and derives pending from history', () => {
        const result: WorkspacePaymentSummary = summary({
            pending_transaction: null,
            transactions: [
                transaction({ id: 'older', created_at: '2026-07-14T10:00:00.000Z' }),
                transaction({ id: 'newer', status: 'rejected', created_at: '2026-07-15T10:00:00.000Z' })
            ]
        })

        expect(result.transactions.map(({ id }) => id)).toEqual(['newer', 'older'])
        expect(result.pendingTransaction?.id).toBe('older')
    })

    it('normalizes a server-confirmed PAYG cycle without recomputing its charge', () => {
        const result = normalizeWorkspacePaygSummary({
            enabled: true,
            workspace_id: 'branch-1',
            billing_workspace_id: 'source-1',
            is_inherited: true,
            can_submit_payment: false,
            cycle_id: 'cycle-1',
            cycle_status: 'open',
            cycle_started_at: '2026-09-01T00:00:00.000Z',
            renewal_due_at: '2026-10-01T00:00:00.000Z',
            charged_usage_bytes: 3_000_300_000,
            charged_usage_gb: '3.0003',
            amount_iqd: '3334',
            pricing_version_id: 'pricing-1',
            pricing_version: 4,
            pricing_checkpoints: [
                { gb: 100, amount_iqd: 40000, protected: true },
                { gb: 1, amount_iqd: 0, protected: true },
                { gb: 15, amount_iqd: 10000, protected: true }
            ],
            payg_limit_state: {
                workspace_id: 'branch-1',
                billing_workspace_id: 'source-1',
                enabled: true,
                has_limit: true,
                locked: true,
                limit: {
                    metric: 'changed_usage',
                    threshold: '3',
                    current_value: '3.0003',
                    locked: true,
                    created_at: '2026-09-01T00:00:00.000Z',
                    updated_at: '2026-09-01T00:00:00.000Z'
                },
                metrics: { accrued_charge: '3334', changed_usage: '3.0003' }
            },
            last_updated_at: '2026-09-01T01:00:00.000Z',
            history: []
        })

        expect(result).toMatchObject({
            enabled: true,
            isInherited: true,
            canSubmitPayment: false,
            chargedUsageBytes: 3_000_300_000,
            chargedUsageGb: '3.0003',
            amountIqd: '3334',
            pricingVersion: 4,
            paygLimitState: {
                enabled: true,
                hasLimit: true,
                locked: true,
                limit: {
                    metric: 'changed_usage',
                    threshold: '3',
                    currentValue: '3.0003',
                    locked: true
                },
                metrics: { accrued_charge: '3334', changed_usage: '3.0003' }
            }
        })
        expect(result.pricingCheckpoints.map(({ gb }) => gb)).toEqual([1, 15, 100])
    })

    it('submits only the provider and normalized account name for a frozen PAYG amount', async () => {
        testState.rpc.mockResolvedValue({
            data: transaction({ payment_type: 'payg', amount: 3333, gb_added: 0 }),
            error: null
        })

        await expect(submitWorkspacePaygPayment('fib', ' payg test admin ')).resolves.toMatchObject({
            paymentType: 'payg',
            amount: '3333'
        })
        expect(testState.rpc).toHaveBeenCalledWith('submit_workspace_payg_payment', {
            p_provider: 'fib',
            p_account_holder_name: 'PAYG TEST ADMIN'
        })
        await expect(submitWorkspacePaygPayment('qicard', 'two words')).rejects.toThrow(
            'Account holder name must contain at least three words'
        )
    })
})
