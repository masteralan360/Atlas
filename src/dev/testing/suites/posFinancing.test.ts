import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { assertPosPayment } from '../assertions/pos'
import { POS_CURRENCIES, POS_INVENTORY, POS_WORKSPACE,
    financePosInput, posCheckoutInput, seedPosStock } from '../fixtures/pos'

vi.mock('@/auth/supabase', () => {
    const unexpected = () => { throw new Error('Unexpected remote call in isolated Local POS scenario') }
    return { supabase: { from: unexpected, rpc: unexpected, schema: () => ({ from: unexpected }) } }
})

let checkout: typeof import('@/local-db/posCheckout')

describe('POS financing (independent of Instant POS)', () => {
    beforeAll(async () => {
        installTestBrowser()
        checkout = await import('@/local-db/posCheckout')
    }, 30_000)
    beforeEach(async () => {
        await db.delete(); await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: POS_WORKSPACE, dataMode: 'local' })
    })
    afterEach(() => { vi.restoreAllMocks(); clearWorkspaceModeSnapshot(POS_WORKSPACE) })
    afterAll(async () => { await db.delete() })

    for (const currency of POS_CURRENCIES) for (const count of [1, 3]) it(`${currency}: ${count === 1 ? 'simple loan' : 'installments'} is an obligation with no checkout receipt`, async () => {
        await seedPosStock(currency)
        const input = financePosInput(posCheckoutInput({ currency }), count)
        const result = await checkout.commitPosCheckout(input)
        expect(await db.loans.get(result.loanId!)).toMatchObject({ saleId: input.payload.id, source: 'pos',
            principalAmount: 100, totalPaidAmount: 0, balanceAmount: 100, loanCategory: count > 1 ? 'standard' : 'simple' })
        const installments = await db.loan_installments.where('loanId').equals(result.loanId!).toArray()
        expect(installments.length).toBe(count)
        if (count > 1) expect(installments.reduce((sum, row) => sum + row.plannedAmount, 0)).toBeCloseTo(100, 3)
        await assertPosPayment(input.payload.id, 0)
        expect(await db.inventory.get(POS_INVENTORY)).toMatchObject({ quantity: 19 })
        await checkout.commitPosCheckout(input)
        expect(await db.loans.count()).toBe(1)
    })

})
