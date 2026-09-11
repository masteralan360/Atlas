import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import type { AgentCommissionEntry, SalesOrder, SalesOrderAgentAssignment, RealEstateTransaction } from './models'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

let createBusinessPartner: typeof import('./businessPartners').createBusinessPartner
let createManualLoan: typeof import('./hooks').createManualLoan
let getPartnerSettlementBalance: typeof import('./payments').getPartnerSettlementBalance
let settlePartnerBalance: typeof import('./payments').settlePartnerBalance

function installBrowserStorage() {
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
        configurable: true,
        value: () => 'blob:vitest'
    })
    const values = new Map<string, string>()
    const documentHead = { appendChild: () => undefined }
    const storage = {
        get length() {
            return values.size
        },
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: (index: number) => Array.from(values.keys())[index] ?? null
    }

    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: storage,
            sessionStorage: storage,
            URL: globalThis.URL,
            location: { origin: 'http://localhost', hash: '', pathname: '/' },
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, value: class DOMMatrix {} })
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: class Element {} })
    Object.defineProperty(globalThis, 'HTMLElement', {
        configurable: true,
        value: class HTMLElement extends (globalThis.Element as typeof Element) {}
    })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible',
            dir: 'ltr',
            documentElement: { lang: 'en', dir: 'ltr' },
            head: documentHead,
            getElementsByTagName: () => [documentHead],
            createElement: () => ({
                setAttribute: () => undefined,
                appendChild: () => undefined
            }),
            createTextNode: () => ({}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
}

function commissionTransaction(overrides: Partial<RealEstateTransaction>): RealEstateTransaction {
    const now = new Date().toISOString()
    return {
        id: 'commission-default',
        workspaceId: WORKSPACE_ID,
        transactionNo: 'RT-001',
        transactionType: 'sell',
        propertyType: 'house',
        location: 'Erbil',
        landAreaM2: 200,
        currency: 'iqd',
        totalAmount: 100000,
        paidAmount: 0,
        balanceAmount: 100000,
        profitAmount: 40000,
        buyerName: 'Buyer A',
        buyerBusinessPartnerId: null,
        sellerName: 'Seller A',
        sellerBusinessPartnerId: null,
        isInstallmentBased: false,
        installmentCount: 0,
        status: 'completed',
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: now,
        ...overrides
    }
}

describe('partner settlement', () => {
    beforeAll(async () => {
        installBrowserStorage()
        const businessPartners = await import('./businessPartners')
        const hookModule = await import('./hooks')
        const payments = await import('./payments')
        createBusinessPartner = businessPartners.createBusinessPartner
        createManualLoan = hookModule.createManualLoan
        getPartnerSettlementBalance = payments.getPartnerSettlementBalance
        settlePartnerBalance = payments.settlePartnerBalance
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        setNetworkStatus(true)
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    })

    afterEach(async () => {
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        setNetworkStatus(true)
    })

    afterAll(async () => {
        await db.delete()
        await db.open()
    })

    async function seedPartnerWithCommissions() {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Master Alan',
            phone: '07500000001',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'both'
        })

        await db.real_estate_transactions.put(commissionTransaction({
            id: 'commission-old',
            transactionNo: 'RT-0001',
            profitAmount: 40000,
            buyerName: 'Master Alan',
            buyerBusinessPartnerId: partner.id,
            createdAt: '2026-06-01T10:00:00.000Z',
            updatedAt: '2026-06-01T10:00:00.000Z'
        }))
        await db.real_estate_transactions.put(commissionTransaction({
            id: 'commission-new',
            transactionNo: 'RT-0002',
            profitAmount: 25000,
            buyerName: 'Master Alan',
            buyerBusinessPartnerId: partner.id,
            createdAt: '2026-07-01T10:00:00.000Z',
            updatedAt: '2026-07-01T10:00:00.000Z'
        }))
        await db.real_estate_transactions.put(commissionTransaction({
            id: 'commission-other-partner',
            transactionNo: 'RT-0003',
            profitAmount: 50000,
            buyerName: 'Someone Else',
            createdAt: '2026-06-15T10:00:00.000Z',
            updatedAt: '2026-06-15T10:00:00.000Z'
        }))

        return partner
    }

    it('computes the collectable balance for a partner across open commissions', async () => {
        const partner = await seedPartnerWithCommissions()

        const collect = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')

        expect(collect.total).toBeCloseTo(65000, 6)
        expect(collect.items).toBe(2)
        expect(collect.groups).toEqual([{ currency: 'iqd', total: 65000, items: 2 }])
        expect(collect.eligibleObligations.map((item) => item.sourceRecordId)).toEqual(['commission-old', 'commission-new'])

        const pay = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'outgoing')
        expect(pay.total).toBe(0)
        expect(pay.items).toBe(0)
        expect(pay.eligibleObligations).toHaveLength(0)
    })

    it('settles the full collectable balance oldest-due-first with per-obligation transactions', async () => {
        const partner = await seedPartnerWithCommissions()

        const result = await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            paidAt: '2026-08-01T12:00:00.000Z'
        })

        expect(result).toMatchObject({
            partnerId: partner.id,
            partnerName: 'Master Alan',
            direction: 'incoming',
            totalSettled: 65000,
            items: 2
        })
        expect(result.groups).toEqual([{ currency: 'iqd', total: 65000, items: 2 }])

        const transactions = await db.payment_transactions
            .where('workspaceId')
            .equals(WORKSPACE_ID)
            .and((item) => item.sourceType === 'real_estate_commission' && !item.isDeleted)
            .toArray()

        expect(transactions).toHaveLength(2)
        expect(transactions.map((item) => item.amount).sort((left, right) => left - right)).toEqual([25000, 40000])
        expect(transactions.every((item) => item.direction === 'incoming')).toBe(true)
        expect(transactions.every((item) => item.metadata?.businessPartnerId === partner.id)).toBe(true)
        expect(transactions.every((item) => item.paidAt === '2026-08-01T12:00:00.000Z')).toBe(true)

        const remaining = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(remaining.total).toBe(0)
        expect(remaining.items).toBe(0)

        await expect(settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash'
        })).rejects.toThrow(/no outstanding collectable balance/)
    })

    it('applies a partial settlement to the oldest obligation first', async () => {
        const partner = await seedPartnerWithCommissions()

        const result = await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amount: 30000
        })

        expect(result).toMatchObject({ totalSettled: 30000, items: 1 })

        const payments = await db.payment_transactions
            .where('workspaceId')
            .equals(WORKSPACE_ID)
            .and((item) => item.sourceType === 'real_estate_commission' && !item.isDeleted)
            .toArray()

        expect(payments).toHaveLength(1)
        expect(payments[0]).toMatchObject({ sourceRecordId: 'commission-old', amount: 30000 })

        const remaining = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(remaining.total).toBeCloseTo(35000, 6)
        expect(remaining.items).toBe(2)
        expect(remaining.eligibleObligations.map((item) => item.sourceRecordId)).toEqual(['commission-old', 'commission-new'])
        expect(remaining.eligibleObligations[0].amount).toBeCloseTo(10000, 6)
    })

    it('rejects settling a partner with no eligible balance', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Empty Partner',
            phone: '07500000002',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'both'
        })

        const balance = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(balance.total).toBe(0)
        expect(balance.items).toBe(0)

        await expect(settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash'
        })).rejects.toThrow(/no outstanding collectable balance/)
    })

    it('does not include obligations of another business partner', async () => {
        const partnerA = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Partner A',
            phone: '07500000003',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'both'
        })

        await db.real_estate_transactions.put(commissionTransaction({
            id: 'commission-a',
            profitAmount: 10000,
            buyerBusinessPartnerId: partnerA.id,
            createdAt: '2026-06-01T10:00:00.000Z',
            updatedAt: '2026-06-01T10:00:00.000Z'
        }))

        const balance = await getPartnerSettlementBalance(WORKSPACE_ID, partnerA.id, 'incoming')
        expect(balance.total).toBeCloseTo(10000, 6)
        expect(balance.items).toBe(1)

        await expect(settlePartnerBalance(WORKSPACE_ID, {
            partnerId: '00000000-0000-4000-8000-0000000000aa',
            direction: 'incoming',
            paymentMethod: 'cash'
        })).rejects.toThrow(/Business partner not found/)
    })

    it('reports per-obligation progress while settling', async () => {
        const partner = await seedPartnerWithCommissions()

        const progress: Array<{ settledItems: number; totalItems: number }> = []
        await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            onProgress: (entry) => progress.push(entry)
        })

        expect(progress).toEqual([
            { settledItems: 0, totalItems: 2 },
            { settledItems: 1, totalItems: 2 },
            { settledItems: 2, totalItems: 2 }
        ])
    })

    it('settles a per-currency partial amount oldest-due-first', async () => {
        const partner = await seedPartnerWithCommissions()

        const result = await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amountsByCurrency: [{ currency: 'iqd', amount: 30000 }]
        })

        expect(result).toMatchObject({ totalSettled: 30000, items: 1 })

        const payments = await db.payment_transactions
            .where('workspaceId')
            .equals(WORKSPACE_ID)
            .and((item) => item.sourceType === 'real_estate_commission' && !item.isDeleted)
            .toArray()

        expect(payments).toHaveLength(1)
        expect(payments[0]).toMatchObject({ sourceRecordId: 'commission-old', amount: 30000 })

        const remaining = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(remaining.total).toBeCloseTo(35000, 6)
        expect(remaining.eligibleObligations[0].amount).toBeCloseTo(10000, 6)
    })

    it('settles per-currency amounts independently and reports touched-obligation progress', async () => {
        const partner = await seedPartnerWithCommissions()

        await db.real_estate_transactions.put(commissionTransaction({
            id: 'commission-usd',
            transactionNo: 'RT-0004',
            currency: 'usd',
            totalAmount: 200,
            balanceAmount: 200,
            profitAmount: 100,
            buyerName: 'Master Alan',
            buyerBusinessPartnerId: partner.id,
            createdAt: '2026-05-01T10:00:00.000Z',
            updatedAt: '2026-05-01T10:00:00.000Z'
        }))

        const progress: Array<{ settledItems: number; totalItems: number }> = []
        const result = await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amountsByCurrency: [{ currency: 'iqd', amount: 30000 }],
            onProgress: (entry) => progress.push(entry)
        })

        expect(result).toMatchObject({ totalSettled: 30000, items: 1 })
        expect(progress).toEqual([
            { settledItems: 0, totalItems: 1 },
            { settledItems: 1, totalItems: 1 }
        ])

        const usdBalance = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(usdBalance.groups.map((group) => ({ currency: group.currency, total: group.total }))).toEqual([
            { currency: 'iqd', total: 35000 },
            { currency: 'usd', total: 100 }
        ])

        const fullResult = await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amountsByCurrency: [
                { currency: 'iqd', amount: 35000 },
                { currency: 'usd', amount: 100 }
            ]
        })

        expect(fullResult).toMatchObject({ totalSettled: 35100, items: 3 })

        const settled = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(settled.total).toBe(0)
        expect(settled.items).toBe(0)
    })

    it('rejects per-currency amounts exceeding the group balance', async () => {
        const partner = await seedPartnerWithCommissions()

        await expect(settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amountsByCurrency: [{ currency: 'iqd', amount: 70000 }]
        })).rejects.toThrow(/cannot exceed the outstanding balance/)

        await expect(settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amountsByCurrency: [{ currency: 'usd', amount: 500 }]
        })).rejects.toThrow(/cannot exceed the outstanding balance/)
    })

    it('rejects zero-sum per-currency amounts', async () => {
        const partner = await seedPartnerWithCommissions()

        await expect(settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amountsByCurrency: [{ currency: 'iqd', amount: 0 }]
        })).rejects.toThrow(/could not be allocated to any open obligation/)
    })

    it('allocates by source-record creation date when due dates are missing', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Master Alan',
            phone: '07500000001',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'both'
        })

        const loanSpecs = [
            { label: 'Loan A', amount: 100000, createdAt: '2026-03-01T10:00:00.000Z' },
            { label: 'Loan B', amount: 200000, createdAt: '2026-07-01T10:00:00.000Z' },
            { label: 'Loan C', amount: 300000, createdAt: '2026-05-01T10:00:00.000Z' }
        ]
        const loanIds: string[] = []

        for (const spec of loanSpecs) {
            const { loan } = await createManualLoan(WORKSPACE_ID, {
                loanCategory: 'simple',
                installmentCount: 1,
                borrowerName: 'Master Alan',
                borrowerPhone: '07500000001',
                borrowerAddress: '',
                borrowerNationalId: '',
                principalAmount: spec.amount,
                settlementCurrency: 'iqd',
                direction: 'lent',
                linkedPartyType: 'business_partner',
                linkedPartyId: partner.id,
                firstDueDate: null,
                installmentFrequency: 'monthly',
                createdAt: spec.createdAt
            })
            loanIds.push(loan.id)
            await db.loans.update(loan.id, { loanNo: spec.label })
        }
        const [loanAId, loanBId, loanCId] = loanIds

        const balance = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(balance.total).toBeCloseTo(600000, 6)
        expect(balance.items).toBe(3)
        expect(balance.eligibleObligations.map((item) => item.sourceRecordId)).toEqual([loanAId, loanCId, loanBId])

        const result = await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amountsByCurrency: [{ currency: 'iqd', amount: 550000 }]
        })

        expect(result).toMatchObject({ totalSettled: 550000, items: 3 })

        const loanPayments = await db.loan_payments.toArray()
        expect(loanPayments.filter((item) => !item.isDeleted).map((item) => item.amount).sort((left, right) => left - right))
            .toEqual([100000, 150000, 300000])

        const loans = await db.loans
            .where('workspaceId')
            .equals(WORKSPACE_ID)
            .and((item) => !item.isDeleted)
            .toArray()
        const loanById = new Map(loans.map((item) => [item.id, item]))

        expect(loans).toHaveLength(3)
        expect(loanById.get(loanAId)?.balanceAmount).toBe(0)
        expect(loanById.get(loanCId)?.balanceAmount).toBe(0)
        expect(loanById.get(loanBId)?.balanceAmount).toBe(50000)

        const remaining = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(remaining.total).toBeCloseTo(50000, 6)
        expect(remaining.eligibleObligations.map((item) => item.sourceRecordId)).toEqual([loanBId])
    })

    it('pays a standard sales-agent commission through the partner settlement flow and records the account movement', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Commission Agent',
            phone: '07500000011',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'Baghdad',
                agentType: 'field_agent',
                status: 'active',
                salesAccountEnabled: false
            }
        }, { allowAgentRole: true })
        const agent = await db.agents.get(partner.agentFacetId!)
        expect(agent).toBeTruthy()

        const occurredAt = '2026-08-01T10:00:00.000Z'
        const order: SalesOrder = {
            id: 'sales-account-agent-order',
            workspaceId: WORKSPACE_ID,
            orderNumber: 'SO-AGENT-001',
            businessPartnerId: null,
            customerId: 'sales-account-agent-customer',
            customerName: 'Commission Customer',
            sourceStorageId: null,
            items: [],
            subtotal: 500,
            discount: 0,
            tax: 0,
            total: 500,
            currency: 'usd',
            exchangeRate: null,
            exchangeRateSource: null,
            exchangeRateTimestamp: null,
            status: 'completed',
            actualDeliveryDate: occurredAt,
            expectedDeliveryDate: null,
            isPaid: false,
            paymentStatus: 'unpaid',
            paidAmount: 0,
            balanceAmount: 500,
            paidAt: null,
            paymentMethod: 'cash',
            initialPaymentAmount: 0,
            linkedLoanId: null,
            isInstallmentBased: false,
            installmentCount: 0,
            installmentFrequency: null,
            firstDueDate: null,
            nextDueDate: null,
            reservedAt: occurredAt,
            returnStatus: 'none',
            returnedAmount: 0,
            createdBy: null,
            createdAt: occurredAt,
            updatedAt: occurredAt,
            syncStatus: 'synced',
            lastSyncedAt: occurredAt,
            version: 1,
            isDeleted: false
        }
        const assignment: SalesOrderAgentAssignment = {
            id: 'sales-account-agent-assignment',
            workspaceId: WORKSPACE_ID,
            orderId: order.id,
            agentId: agent!.id,
            assignmentSource: 'sales_account',
            assignedAt: occurredAt,
            unassignedAt: null,
            assignedBy: null,
            unassignedBy: null,
            customerCitySnapshot: 'Baghdad',
            deliveryChargeAmount: 0,
            internalDeliveryCostAmount: 0,
            createdAt: occurredAt,
            updatedAt: occurredAt,
            syncStatus: 'synced',
            lastSyncedAt: occurredAt,
            version: 1,
            isDeleted: false
        }
        const accrual: AgentCommissionEntry = {
            id: 'sales-account-agent-accrual',
            workspaceId: WORKSPACE_ID,
            orderId: order.id,
            assignmentId: assignment.id,
            agentId: agent!.id,
            membershipId: null,
            planId: null,
            orderReturnId: null,
            relatedEntryId: null,
            kind: 'accrual',
            status: 'earned',
            currency: 'usd',
            calculationBasis: 'net_profit',
            includeTax: false,
            includeDeliveryCharge: false,
            basisAmount: 500,
            revenueAmount: 500,
            costAmount: 0,
            taxAmount: 0,
            deliveryChargeAmount: 0,
            ratePercent: 16,
            amount: 80,
            occurredAt,
            payoutReference: null,
            settlementSource: 'manual',
            notes: 'Commission earned for the sales account',
            createdBy: null,
            createdAt: occurredAt,
            updatedAt: occurredAt,
            syncStatus: 'synced',
            lastSyncedAt: occurredAt,
            version: 1,
            isDeleted: false
        }
        await db.transaction('rw', db.sales_orders, db.sales_order_agent_assignments, db.agent_commission_entries, async () => {
            await db.sales_orders.put(order)
            await db.sales_order_agent_assignments.put(assignment)
            await db.agent_commission_entries.put(accrual)
        })

        const payable = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'outgoing')
        expect(payable).toMatchObject({ total: 80, items: 1 })
        expect(payable.eligibleObligations).toEqual([
            expect.objectContaining({
                sourceType: 'agent_commission_payout',
                sourceRecordId: order.id,
                sourceSubrecordId: assignment.id,
                direction: 'outgoing',
                amount: 80,
                currency: 'usd'
            })
        ])
        expect((await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')).total).toBe(0)

        await expect(settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'outgoing',
            paymentMethod: 'cash',
            amount: 81
        })).rejects.toThrow(/cannot exceed the outstanding balance/)

        const { savePaymentAccount } = await import('./paymentAccounts')
        const account = await savePaymentAccount(WORKSPACE_ID, {
            name: 'Commission drawer',
            accountType: 'cash_drawer',
            openingBalances: [{ currency: 'usd', amount: 100 }]
        })
        const result = await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'outgoing',
            paymentMethod: 'cash',
            paidAt: '2026-08-02T12:00:00.000Z',
            amountsByCurrency: [{ currency: 'usd', amount: 30 }],
            note: 'Partial commission payout',
            accountId: account.id,
            accountNameSnapshot: account.name
        })
        expect(result).toMatchObject({ totalSettled: 30, items: 1 })

        const payoutEntry = await db.agent_commission_entries
            .where('[workspaceId+agentId]')
            .equals([WORKSPACE_ID, agent!.id])
            .and((entry) => entry.kind === 'payout' && !entry.isDeleted)
            .first()
        expect(payoutEntry).toMatchObject({
            orderId: order.id,
            assignmentId: assignment.id,
            amount: -30,
            settlementSource: 'manual',
            occurredAt: '2026-08-02T12:00:00.000Z'
        })

        const payment = await db.payment_transactions
            .where('[workspaceId+sourceType+sourceRecordId]')
            .equals([WORKSPACE_ID, 'agent_commission_payout', agent!.id])
            .first()
        expect(payment).toMatchObject({
            sourceSubrecordId: payoutEntry?.id,
            direction: 'outgoing',
            amount: 30,
            currency: 'usd',
            accountId: account.id,
            accountNameSnapshot: account.name,
            counterpartyName: partner.partnerName,
            metadata: expect.objectContaining({ businessPartnerId: partner.id, automaticSettlement: false })
        })
        expect(await db.payment_account_movements.get(payment!.id)).toMatchObject({
            accountId: account.id,
            direction: 'outgoing',
            deltaAmount: -30,
            currency: 'usd'
        })
        expect((await db.payment_account_balances.where('[accountId+currency]').equals([account.id, 'usd']).first())?.balanceAmount).toBe(70)

        const remaining = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'outgoing')
        expect(remaining).toMatchObject({ total: 50, items: 1 })
        await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'outgoing',
            paymentMethod: 'cash',
            amountsByCurrency: [{ currency: 'usd', amount: 50 }]
        })
        expect((await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'outgoing')).total).toBe(0)

        await db.agent_commission_entries.put({
            ...accrual,
            id: 'sales-account-agent-reversal',
            kind: 'reversal',
            status: 'reversed',
            amount: -20,
            relatedEntryId: accrual.id,
            occurredAt: '2026-08-03T12:00:00.000Z',
            createdAt: '2026-08-03T12:00:00.000Z',
            updatedAt: '2026-08-03T12:00:00.000Z'
        })
        const recoverable = await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')
        expect(recoverable).toMatchObject({ total: 20, items: 1 })
        expect(recoverable.eligibleObligations).toEqual([
            expect.objectContaining({
                sourceType: 'agent_commission_recovery',
                sourceRecordId: order.id,
                sourceSubrecordId: assignment.id,
                direction: 'incoming',
                amount: 20,
                currency: 'usd'
            })
        ])

        await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash',
            amountsByCurrency: [{ currency: 'usd', amount: 20 }]
        })
        const recoveryPayment = await db.payment_transactions
            .where('[workspaceId+sourceType+sourceRecordId]')
            .equals([WORKSPACE_ID, 'agent_commission_recovery', agent!.id])
            .first()
        expect(recoveryPayment).toMatchObject({ direction: 'incoming', amount: 20, currency: 'usd' })
        expect((await getPartnerSettlementBalance(WORKSPACE_ID, partner.id, 'incoming')).total).toBe(0)
    })

    it('refreshes the partner summary after settling without error', async () => {
        const partner = await seedPartnerWithCommissions()

        const result = await settlePartnerBalance(WORKSPACE_ID, {
            partnerId: partner.id,
            direction: 'incoming',
            paymentMethod: 'cash'
        })

        const refreshed = await db.business_partners.get(partner.id)
        expect(refreshed).toBeTruthy()
        expect(refreshed?.id).toBe(partner.id)
        expect(result.partnerName).toBe(refreshed?.partnerName)
    })
})
