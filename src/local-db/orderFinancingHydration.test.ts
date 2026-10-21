import 'fake-indexeddb/auto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from './database'
import type { Loan, LoanInstallment, LoanPayment, PaymentTransaction } from './models'
import { hydrateOrderFinancingFromSupabase } from './orderFinancingHydration'

const remote = vi.hoisted(() => ({
    rows: {} as Record<string, Record<string, unknown>[]>,
    calls: [] as Array<{ table: string; workspaceId: string; column: string; ids: string[]; from: number; to: number }>,
    failure: '',
}))

vi.mock('@/lib/supabaseSchema', () => ({
    getSupabaseClientForTable: () => ({
        from: (table: string) => {
            const request = { table, workspaceId: '', column: '', ids: [] as string[], from: 0, to: 0 }
            const query = {
                select: () => query,
                eq: (_column: string, value: string) => { request.workspaceId = value; return query },
                in: (column: string, ids: string[]) => { request.column = column; request.ids = ids; return query },
                order: () => query,
                range: async (from: number, to: number) => {
                    remote.calls.push({ ...request, from, to })
                    if (remote.failure === table) return { data: null, error: new Error('Read failed') }
                    return {
                        data: (remote.rows[table] ?? []).filter((row) => row.workspace_id === request.workspaceId
                            && request.ids.includes(String(row[request.column])))
                            .sort((left, right) => String(left.id).localeCompare(String(right.id)))
                            .slice(from, to + 1),
                        error: null,
                    }
                },
            }
            return query
        },
    }),
}))

vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: (_label: string, action: () => unknown) => action(),
    normalizeSupabaseActionError: (error: unknown) => error,
}))

const workspaceId = 'financing-workspace'
const orderId = 'activating-order'
const loanId = 'activated-loan'
const timestamp = '2026-10-01T09:00:00.000Z'
const base = { workspace_id: workspaceId, version: 2, is_deleted: false, created_at: timestamp, updated_at: timestamp }

describe('order-scoped financing hydration', () => {
    beforeAll(() => {
        installTestBrowser()
        Object.assign(window, { dispatchEvent: vi.fn() })
    })
    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'cloud' })
        remote.calls = []
        remote.failure = ''
        remote.rows = {
            loans: [{ ...base, id: loanId, order_id: orderId, order_type: 'sales', balance_amount: 80 }],
            loan_installments: [{ ...base, id: 'installment', loan_id: loanId, balance_amount: 80 }],
            loan_payments: [{ ...base, id: 'repayment', loan_id: loanId, amount: 20, payment_transaction_id: 'transaction' }],
            payment_transactions: [{ ...base, id: 'transaction', source_record_id: loanId, source_type: 'simple_loan', amount: 20 }],
        }
    })
    afterEach(() => clearWorkspaceModeSnapshot(workspaceId))
    afterAll(async () => { await db.delete() })

    it.each(['cloud', 'hybrid'] as const)('loads only the activated order and loan in %s mode', async (dataMode) => {
        writeWorkspaceModeSnapshot({ workspaceId, dataMode })
        await db.loans.put({ id: 'unrelated', workspaceId, syncStatus: 'synced', version: 1 } as Loan)
        remote.rows.payment_transactions.push({ ...base, id: 'down-payment', source_record_id: orderId, amount: 5 })
        for (const rows of Object.values(remote.rows)) {
            rows.push({ ...base, id: 'other-record', loan_id: 'other-loan', source_record_id: 'other-loan' })
            rows.push({ ...rows[0], id: 'other-workspace-record', workspace_id: 'other-workspace' })
        }

        await hydrateOrderFinancingFromSupabase(workspaceId, orderId, loanId)

        expect(remote.calls).toEqual([
            { table: 'loans', workspaceId, column: 'id', ids: [loanId], from: 0, to: 499 },
            { table: 'loan_installments', workspaceId, column: 'loan_id', ids: [loanId], from: 0, to: 499 },
            { table: 'loan_payments', workspaceId, column: 'loan_id', ids: [loanId], from: 0, to: 499 },
            { table: 'payment_transactions', workspaceId, column: 'source_record_id', ids: [loanId, orderId], from: 0, to: 499 },
        ])
        expect(await db.loans.get(loanId)).toMatchObject({ orderId, balanceAmount: 80, syncStatus: 'synced' })
        expect(await db.loan_payments.get('repayment')).toMatchObject({ amount: 20, paymentTransactionId: 'transaction' })
        expect(await db.payment_transactions.get('transaction')).toMatchObject({ sourceRecordId: loanId, amount: 20 })
        expect(await db.payment_transactions.get('down-payment')).toMatchObject({ sourceRecordId: orderId })
        expect(await db.loans.count()).toBe(2)
        expect(await db.loan_installments.count()).toBe(1)
        expect(await db.loan_payments.count()).toBe(1)
        expect(await db.payment_transactions.count()).toBe(2)
        expect(await db.loans.get('unrelated')).toBeDefined()
    })

    it('preserves pending, conflicting and newer local records', async () => {
        await db.loans.put({ id: loanId, workspaceId, syncStatus: 'pending', version: 1, balanceAmount: 77 } as Loan)
        await db.loan_installments.put({ id: 'installment', workspaceId, syncStatus: 'conflict', version: 1, balanceAmount: 66 } as LoanInstallment)
        await db.payment_transactions.put({ id: 'transaction', workspaceId, syncStatus: 'synced', version: 3, amount: -20 } as PaymentTransaction)
        await db.loan_payments.put({ id: 'repayment', workspaceId, syncStatus: 'synced', version: 2,
            lastSyncedAt: '2099-01-01T00:00:00.000Z', amount: 99 } as LoanPayment)

        await hydrateOrderFinancingFromSupabase(workspaceId, orderId, loanId)

        expect(await db.loans.get(loanId)).toMatchObject({ syncStatus: 'pending', balanceAmount: 77 })
        expect(await db.loan_installments.get('installment')).toMatchObject({ syncStatus: 'conflict', balanceAmount: 66 })
        expect(await db.payment_transactions.get('transaction')).toMatchObject({ version: 3, amount: -20 })
        expect(await db.loan_payments.get('repayment')).toMatchObject({ version: 2, amount: 99 })
    })

    it('reads large installment schedules in scoped batches', async () => {
        remote.rows.loan_installments = Array.from({ length: 501 }, (_, index) => ({
            ...base, id: `installment-${String(index).padStart(4, '0')}`, loan_id: loanId,
        }))
        await hydrateOrderFinancingFromSupabase(workspaceId, orderId, loanId)
        expect(await db.loan_installments.count()).toBe(501)
        expect(remote.calls.filter((call) => call.table === 'loan_installments').map((call) => call.from)).toEqual([0, 500])
    })

    it('does not persist a partial financial projection when a request fails', async () => {
        remote.failure = 'loan_payments'
        await expect(hydrateOrderFinancingFromSupabase(workspaceId, orderId, loanId)).rejects.toThrow('Read failed')
        expect(await db.loans.count()).toBe(0)
        expect(await db.loan_installments.count()).toBe(0)
        expect(await db.payment_transactions.count()).toBe(0)
    })

    it('does not read or change Local mode data', async () => {
        writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'local' })
        await hydrateOrderFinancingFromSupabase(workspaceId, orderId, loanId)
        expect(remote.calls).toHaveLength(0)
    })

    it('rejects a loan belonging to a different order before writing the cache', async () => {
        remote.rows.loans[0].order_id = 'another-order'
        await expect(hydrateOrderFinancingFromSupabase(workspaceId, orderId, loanId)).rejects.toThrow('Linked loan was not found')
        expect(await db.loans.count()).toBe(0)
        expect(await db.loan_payments.count()).toBe(0)
    })
})
