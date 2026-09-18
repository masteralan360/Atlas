import { db } from '@/local-db/database'
import type { Agent, BusinessPartner, CurrencyCode } from '@/local-db/models'
import type { CreateDeliveryShipmentInput } from '@/local-db/postService'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'

export const POST_WORKSPACE = 'a7300000-0000-4000-8000-000000000001'
export const POST_OTHER_WORKSPACE = 'a7300000-0000-4000-8000-000000000099'
export const POST_MERCHANT = 'a7300000-0000-4000-8000-000000000002'
export const POST_COURIER_PARTNER = 'a7300000-0000-4000-8000-000000000003'
export const POST_COURIER = 'a7300000-0000-4000-8000-000000000004'
export const POST_SECOND_COURIER = 'a7300000-0000-4000-8000-000000000005'
export const POST_ADMIN = 'a7300000-0000-4000-8000-000000000006'
export const POST_TIME = '2026-09-18T09:00:00.000Z'
export const POST_CURRENCIES = ['usd', 'iqd', 'eur', 'try'] as const
export const POST_METHODS = STANDARD_PAYMENT_METHODS
let unrelatedBaseline: BusinessPartner | undefined

export function postUnrelatedBaseline() { return unrelatedBaseline }

export function postPartner(id: string, workspaceId = POST_WORKSPACE): BusinessPartner {
    return { id, workspaceId, partnerName: `Test partner ${id}`, role: 'customer', defaultCurrency: 'usd',
        creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null,
        customerFacetId: null, supplierFacetId: null, agentFacetId: null,
        totalSalesOrders: 0, totalSalesValue: 0, receivableBalance: 0,
        totalPurchaseOrders: 0, totalPurchaseValue: 0, payableBalance: 0,
        totalLoanCount: 0, loanOutstandingBalance: 0, netExposure: 0, mergedIntoBusinessPartnerId: null,
        createdAt: POST_TIME, updatedAt: POST_TIME, version: 1, isDeleted: false,
        syncStatus: 'synced', lastSyncedAt: POST_TIME }
}

export function postCourier(id = POST_COURIER): Agent {
    return { id, workspaceId: POST_WORKSPACE, businessPartnerId: POST_COURIER_PARTNER,
        zone: 'Baghdad', agentType: 'courier', courierDeliveryFee: 5,
        carModel: null, plateNumber: null, linkedUserId: null, status: 'active',
        createdAt: POST_TIME, updatedAt: POST_TIME, version: 1, isDeleted: false,
        syncStatus: 'synced', lastSyncedAt: POST_TIME }
}

export async function seedPostParties() {
    await db.business_partners.bulkPut([postPartner(POST_MERCHANT), { ...postPartner(POST_COURIER_PARTNER), agentFacetId: POST_COURIER },
        postPartner('unrelated-partner', POST_OTHER_WORKSPACE)])
    await db.agents.bulkPut([postCourier(), postCourier(POST_SECOND_COURIER)])
    // Local database hooks stamp sync metadata on insert. Compare later reads
    // with the persisted seed, including that metadata, rather than the input.
    unrelatedBaseline = await db.business_partners.get('unrelated-partner')
}

export function postInput(merchantProfileId: string, overrides: Partial<CreateDeliveryShipmentInput> = {}): CreateDeliveryShipmentInput {
    return { merchantProfileId, recipientPhone: '07500000000', recipientAddress: 'Test Baghdad address',
        currency: 'usd', codAmount: 100, deliveryFee: 10, feePayer: 'merchant',
        recipientPayoutAmount: 0, recipientPayoutFunding: 'courier_advance', ...overrides }
}

/** Additional bounded lifecycle samples; fixed matrices own mandatory coverage. */
export function seededPostCases(seed: number, count: number) {
    let state = seed >>> 0
    const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8 }
    return Array.from({ length: count }, (_, index) => ({ index,
        currency: POST_CURRENCIES[next() % POST_CURRENCIES.length], method: POST_METHODS[next() % POST_METHODS.length],
        prepaid: next() % 2 === 0, recipientFee: next() % 2 === 0, workspaceFunded: next() % 2 === 0,
        cod: (next() % 10000 + 10000) / 100, fee: (next() % 1000 + 100) / 100,
        payout: (next() % 3000 + 100) / 100, courierFee: (next() % 400 + 100) / 100,
        account: next() % 2 === 0, collective: next() % 2 === 0, partial: next() % 2 === 0,
        redispatch: next() % 2 === 0, correct: next() % 2 === 0 }))
}

export async function fundedPostAccount(currency: CurrencyCode, amount = 10000) {
    const { savePaymentAccount } = await import('@/local-db/paymentAccounts')
    return savePaymentAccount(POST_WORKSPACE, { name: 'Post test account', accountType: 'cash_drawer',
        openingBalances: [{ currency, amount }] })
}
