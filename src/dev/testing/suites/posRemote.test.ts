import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import type { Sale } from '@/types'
import { getLedgerPaymentTransactions, getLedgerPaymentTransactionEffect } from '@/lib/ledgerPaymentTransactions'
import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { assertNoPosCommit, assertPosPayment } from '../assertions/pos'
import { POS_BATCH, POS_INVENTORY, POS_PRODUCT, POS_STORAGE, POS_TIME, POS_WORKSPACE,
    financePosInput, posCheckoutInput, seedPosStock } from '../fixtures/pos'

const remote = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), payment: vi.fn(), policy: { enabled: true, error: null as unknown },
    queries: [] as { table: string; select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn> }[],
    batches: [] as Record<string, unknown>[] }))
vi.mock('@/auth/supabase', () => ({ supabase: {
    rpc: remote.rpc, from: remote.from, schema: () => ({ from: remote.from })
} }))

let checkout: typeof import('@/local-db/posCheckout')
let returns: typeof import('@/local-db/posSaleReturns')

describe('POS Cloud / Hybrid request contracts and committed-sale recovery', () => {
    beforeAll(async () => { installTestBrowser(); checkout = await import('@/local-db/posCheckout'); returns = await import('@/local-db/posSaleReturns') }, 30_000)
    beforeEach(async () => {
        await db.delete(); await db.open(); await seedPosStock()
        remote.queries.length = 0
        remote.policy = { enabled: true, error: null }
        remote.rpc.mockReset().mockResolvedValue({ data: { sequence_id: 42 }, error: null })
        remote.payment.mockReset().mockResolvedValue({ data: null, error: null })
        remote.batches = [{ id: POS_BATCH, workspace_id: POS_WORKSPACE, product_id: POS_PRODUCT,
            storage_id: POS_STORAGE, batch_number: 'POS-1', quantity: 19, price: 100, cost_price: 40, currency: 'usd',
            created_at: POS_TIME, updated_at: POS_TIME, is_deleted: false, version: 1 }]
        remote.from.mockReset().mockImplementation((table: string) => {
            const query = {
                select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), range: vi.fn(() => query),
                maybeSingle: vi.fn(async () => ({ data: remote.policy.error ? null : { pos_convert_to_workspace_currency: remote.policy.enabled }, error: remote.policy.error })),
                upsert: remote.payment, insert: remote.payment,
                then: (fulfilled: (value: unknown) => unknown) => Promise.resolve({ data: table === 'stock_batches' ? remote.batches : [], error: null }).then(fulfilled)
            }
            remote.queries.push({ table, select: query.select, eq: query.eq })
            return query
        })
        writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: 'cloud' })
        setNetworkStatus(true)
    })
    afterEach(() => { vi.restoreAllMocks(); clearWorkspaceModeSnapshot(POS_WORKSPACE); setNetworkStatus(false) })
    afterAll(async () => { await db.delete(); setNetworkStatus(true) })

    for (const mode of ['cloud', 'hybrid'] as const) it(`${mode}: complete_sale owns the sale; cache, inventory, payment, account and ledger reflect its result`, async () => {
        writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: mode })
        const base = { workspaceId: POS_WORKSPACE, createdAt: POS_TIME, updatedAt: POS_TIME, version: 1,
            isDeleted: false, syncStatus: 'synced' as const, lastSyncedAt: POS_TIME }
        await db.payment_accounts.put({ id: 'a7200000-0000-4000-8000-000000000010', ...base, name: 'POS remote account', accountType: 'cash_drawer', isActive: true })
        const input = posCheckoutInput()
        input.account = { id: 'a7200000-0000-4000-8000-000000000010', name: 'POS remote account' }
        const result = await checkout.commitPosCheckout(input)
        expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('complete_sale', { payload: input.payload })
        expect(result).toEqual({ sequenceId: 42, loanId: null })
        expect(await db.invoices.get(input.payload.id)).toMatchObject({ sequenceId: 42, totalAmount: 100, origin: 'pos', syncStatus: 'synced' })
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
        expect(await db.stock_batches.get(POS_BATCH)).toMatchObject({ quantity: 19 })
        const [payment] = await assertPosPayment(input.payload.id, 100)
        expect(payment).toMatchObject({ accountId: input.account.id, syncStatus: 'synced' })
        expect(await db.payment_account_movements.where('accountId').equals(input.account.id).count()).toBe(1)
        expect(await db.payment_account_balances.where('accountId').equals(input.account.id).first()).toMatchObject({ balanceAmount: 100 })
        expect(remote.payment).toHaveBeenCalledWith(expect.objectContaining({ id: input.payload.id, source_record_id: input.payload.id, amount: 100 }), { onConflict: 'id' })
        // The server's replay returns the same sale; its completed cache projection isn't applied twice.
        await checkout.commitPosCheckout(input)
        await assertPosPayment(input.payload.id, 100)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
        expect(await db.offline_mutations.count()).toBe(0)
    })

    it('retries a transient RPC using exactly the same sale and loan identities', async () => {
        const input = financePosInput(posCheckoutInput(), 3)
        const loanId = input.atomicLoanPayload!.id
        remote.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch', status: 503 } })
            .mockResolvedValueOnce({ data: { sequence_id: 42, loan_aggregate: {
                loan: { ...input.atomicLoanPayload, principal_amount: 100, total_paid_amount: 0, balance_amount: 100,
                    status: 'active', created_at: POS_TIME, updated_at: POS_TIME, version: 1, is_deleted: false },
                installments: (input.atomicLoanPayload!.installments as { id: string }[]).map((row, index) => ({
                    ...row, loan_id: loanId, workspace_id: POS_WORKSPACE, installment_no: index + 1,
                    planned_amount: index === 2 ? 33.34 : 33.33, paid_amount: 0,
                    balance_amount: index === 2 ? 33.34 : 33.33, status: 'pending'
                })), payments: [], transactions: []
            } }, error: null })
        const result = await checkout.commitPosCheckout(input)
        expect(remote.rpc).toHaveBeenCalledTimes(2)
        expect(remote.rpc.mock.calls[0]).toEqual(remote.rpc.mock.calls[1])
        expect(remote.rpc.mock.calls[0]).toEqual(['complete_sale_with_loan', { payload: input.payload, p_loan: input.atomicLoanPayload }])
        expect(result.loanId).toBe(loanId)
        expect(await db.loans.get(result.loanId!)).toMatchObject({ source: 'pos', saleId: input.payload.id, balanceAmount: 100 })
        expect(await db.loan_installments.where('loanId').equals(result.loanId!).count()).toBe(3)
        await assertPosPayment(input.payload.id, 0)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
    })

    it('loads the workspace-scoped authoritative conversion setting', async () => {
        remote.policy.enabled = false
        expect(await checkout.loadPosCurrencyConversionPolicy(POS_WORKSPACE)).toBe(false)
        const query = remote.queries.find(row => row.table === 'workspaces')!
        expect(query.select).toHaveBeenCalledWith('pos_convert_to_workspace_currency')
        expect(query.eq).toHaveBeenCalledWith('id', POS_WORKSPACE)
        remote.policy.enabled = true
        expect(await checkout.loadPosCurrencyConversionPolicy(POS_WORKSPACE)).toBe(true)
    })

    it('turns currency-policy network errors into a localized retry message', async () => {
        remote.policy.error = new TypeError('Failed to fetch')
        await expect(checkout.loadPosCurrencyConversionPolicy(POS_WORKSPACE)).rejects.toThrow('request did not finish')
        expect(remote.rpc).not.toHaveBeenCalled()
        await assertNoPosCommit()
    })

    for (const mode of ['cloud', 'hybrid'] as const) it(`${mode}: offline POS completion is blocked with no local sale or mutation queue`, async () => {
        writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: mode }); setNetworkStatus(false)
        await expect(checkout.commitPosCheckout(posCheckoutInput())).rejects.toThrow('Connect to the internet')
        await assertNoPosCommit()
        expect(remote.rpc).not.toHaveBeenCalled()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('a rejected RPC leaves payments, cache and stock untouched', async () => {
        remote.rpc.mockResolvedValue({ data: null, error: { message: 'Insufficient inventory in source storage', code: 'P0001' } })
        await expect(checkout.commitPosCheckout(posCheckoutInput())).rejects.toMatchObject({ committed: false })
        await assertNoPosCommit()
        expect(await db.invoices.count()).toBe(0)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
        expect(remote.payment).not.toHaveBeenCalled()
    })

    it('two transport failures never create an offline sale or payment', async () => {
        remote.rpc.mockResolvedValue({ data: null, error: new TypeError('Failed to fetch') })
        await expect(checkout.commitPosCheckout(posCheckoutInput())).rejects.toThrow('request did not finish')
        expect(remote.rpc).toHaveBeenCalledTimes(2)
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('a payment fault after server success reports committed recovery without local fallback', async () => {
        const input = posCheckoutInput()
        remote.payment.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } })
        await expect(checkout.commitPosCheckout(input)).rejects.toMatchObject({ committed: true, saleId: input.payload.id })
        expect(remote.rpc).toHaveBeenCalledTimes(1)
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })

    it('a cache failure retains the confirmed payment and does not create a Local sale', async () => {
        const input = posCheckoutInput()
        vi.spyOn(db.invoices, 'put').mockRejectedValueOnce(new Error('disk full'))
        await expect(checkout.commitPosCheckout(input)).rejects.toMatchObject({ committed: true, saleId: input.payload.id })
        expect(await db.sales.count()).toBe(0)
        expect(await db.offline_mutations.count()).toBe(0)
        await assertPosPayment(input.payload.id, 100)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
        await checkout.commitPosCheckout(input)
        await assertPosPayment(input.payload.id, 100)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
    })

    for (const mode of ['cloud', 'hybrid'] as const) it(`${mode}: refund posting uses a stable upsert, saved return records and a linked negative ledger entry`, async () => {
        writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: mode })
        const input = posCheckoutInput()
        await checkout.commitPosCheckout(input)
        const returnId = crypto.randomUUID()
        const sale = { id: input.payload.id, workspace_id: POS_WORKSPACE, cashier_id: input.user.id,
        total_amount: input.payload.total_amount, created_at: POS_TIME, origin: 'pos', payment_method: 'cash',
            settlement_currency: 'usd', items: [{ ...input.payload.items[0], id: crypto.randomUUID(), sale_id: input.payload.id }] } as Sale
        await returns.persistSaleReturnLedger({ returnId, sale, reason: 'Customer returned item', timestamp: POS_TIME,
            refundAmount: 50, linePayloads: [{ id: crypto.randomUUID(), sale_item_id: sale.items![0].id, quantity: 0.5 }],
            restoredPlans: [{ storageId: POS_STORAGE, restoredBatchAllocations: [] }], pendingSync: false })
        expect(remote.payment).toHaveBeenLastCalledWith(expect.objectContaining({ id: returnId, amount: -50,
            source_record_id: input.payload.id, source_subrecord_id: returnId, reversal_of_transaction_id: input.payload.id }), { onConflict: 'id' })
        expect(await db.sale_returns.get(returnId)).toMatchObject({ status: 'posted', refundAmount: 50, syncStatus: 'synced' })
        const ledger = getLedgerPaymentTransactions(await db.payment_transactions.where('sourceRecordId').equals(input.payload.id).toArray())
        expect(ledger).toHaveLength(2)
        expect(ledger.reduce((sum, row) => {
            const effect = getLedgerPaymentTransactionEffect(row)
            return sum + (effect.direction === 'incoming' ? effect.amount : -effect.amount)
        }, 0)).toBe(50)
    })

    it('refund posting failure is friendly and does not create a ghost cash counter-entry', async () => {
        const input = posCheckoutInput()
        await checkout.commitPosCheckout(input)
        const sale = { id: input.payload.id, workspace_id: POS_WORKSPACE, cashier_id: input.user.id,
        total_amount: input.payload.total_amount, created_at: POS_TIME, origin: 'pos', payment_method: 'cash',
            settlement_currency: 'usd', items: [{ ...input.payload.items[0], id: crypto.randomUUID(), sale_id: input.payload.id }] } as Sale
        remote.payment.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } })
        await expect(returns.persistSaleReturnLedger({ returnId: crypto.randomUUID(), sale, reason: 'Returned', timestamp: POS_TIME,
            refundAmount: 50, linePayloads: [{ id: crypto.randomUUID(), sale_item_id: sale.items![0].id, quantity: 0.5 }],
            restoredPlans: [{ storageId: POS_STORAGE, restoredBatchAllocations: [] }], pendingSync: false })).rejects.toThrow("We couldn't return the sale")
        await assertPosPayment(input.payload.id, 100)
    })

    for (const data of [null, {}, { sequence_id: -1 }, { sequence_id: '42' }]) it(`malformed success ${JSON.stringify(data)} cannot be displayed as a completed sale`, async () => {
        remote.rpc.mockResolvedValue({ data, error: null })
        await expect(checkout.commitPosCheckout(posCheckoutInput())).rejects.toMatchObject({ committed: true })
        await assertNoPosCommit()
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 20 })
    })
})
