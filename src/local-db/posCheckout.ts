import i18n from '@/i18n/config'
import { supabase } from '@/auth/supabase'
import { generateId } from '@/lib/utils'
import { isOnline } from '@/lib/network'
import { normalizeSupabaseActionError, isRetriableWebRequestError, runSupabaseAction } from '@/lib/supabaseRequest'
import { createVerificationSale, verifySale } from '@/lib/saleVerification'
import { isService } from '@/lib/catalogItem'
import type { SalesExchangePayload } from '@/lib/salesExchange'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { db } from './database'
import type { CurrencyCode, ExchangeRateSnapshot, StockBatchAllocation } from './models'
import { createLoanFromPosSale, generateLocalSaleSequenceId } from './hooks'
import { appendPaymentTransaction } from './payments'
import { adjustInventoryQuantity } from './inventory'
import { commitStockBatchAllocations, refreshStockBatchesFromSupabase } from './stockBatches'
import { applyOfflinePosStockEffects } from './offlinePosStock'
import { persistLoanAggregateRpcResult } from './loanTransactions'

export interface PosCheckoutItem {
    product_id: string
    storage_id: string | null
    product_name: string
    product_sku: string
    created_at: string
    updated_at: string
    quantity: number
    selling_unit_ref?: string | null
    selling_unit_code?: string | null
    base_unit_ref?: string | null
    base_unit_code?: string | null
    unit_factor?: number
    inventory_quantity?: number
    unit_price: number
    total_price: number
    cost_price: number
    converted_cost_price: number
    original_currency: CurrencyCode
    original_unit_price: number
    converted_unit_price: number
    settlement_currency: CurrencyCode
    negotiated_price?: number
    price_book_id: string | null
    total: number
    inventory_snapshot: number | null
    batch_allocations: {
        batch_id: string; batch_number: string; quantity: number
        price: number | null; cost_price: number | null; currency: CurrencyCode | null
        expiry_date: string | null; manufacturing_date: string | null
    }[] | null
}

export interface PosCheckoutPayload {
    id: string
    workspace_id: string
    items: PosCheckoutItem[]
    total_amount: number
    settlement_currency: CurrencyCode
    currency_conversion_applied: boolean
    sales_exchange: SalesExchangePayload[]
    origin: 'pos'
    payment_method: 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'loan'
}

export interface PosLoanRegistration {
    linkedPartyType?: 'business_partner' | null
    linkedPartyId?: string | null
    linkedPartyName?: string | null
    borrowerName: string; borrowerPhone: string; borrowerAddress: string; borrowerNationalId: string
    installmentCount: number
    installmentFrequency: 'daily' | 'weekly' | 'biweekly' | 'monthly'
    firstDueDate: string | null
    notes?: string
}

export interface PosCheckoutInput {
    payload: PosCheckoutPayload
    user: { id: string; name: string }
    timestamp: string
    exchangeRates: ExchangeRateSnapshot[] | null
    primaryRate: { rate: number; source: string } | null
    maxDiscountPercent: number
    batchPlans: { productId: string; storageId: string; allocations: StockBatchAllocation[] }[]
    loanRegistration?: PosLoanRegistration
    atomicLoanPayload: Record<string, unknown> | null
    account: { id: string; name: string } | null
}

/** A confirmed remote commit must never be resubmitted as a new sale. */
export class PosCheckoutError extends Error {
    readonly cause: unknown
    constructor(public readonly committed: boolean, public readonly saleId: string, cause: unknown) {
        super(committed ? i18n.t('pos.checkoutCommittedRecovery', { saleId }) : normalizeSupabaseActionError(cause).message)
        this.cause = cause
        this.name = 'PosCheckoutError'
    }
}

export async function loadPosCurrencyConversionPolicy(workspaceId: string): Promise<boolean> {
    const { data, error } = await runSupabaseAction('pos.getCurrencyConversionPolicy', () => supabase
        .from('workspaces').select('pos_convert_to_workspace_currency').eq('id', workspaceId).maybeSingle())
    if (error || !data) throw normalizeSupabaseActionError(error ?? new Error(i18n.t('pos.currencyConversionSaveFailed')))
    return data.pos_convert_to_workspace_currency !== false
}

function validate(input: PosCheckoutInput) {
    const { payload: p } = input
    if (!p.id || !p.workspace_id || p.origin !== 'pos' || !p.items.length
        || !['cash', 'fib', 'qicard', 'zaincash', 'fastpay', 'loan'].includes(p.payment_method)
        || !['usd', 'iqd', 'eur', 'try'].includes(p.settlement_currency)
        || !Number.isFinite(p.total_amount) || p.total_amount < 0) {
        throw new Error(i18n.t('messages.checkoutFailed'))
    }
    for (const item of p.items) {
        const unitFactor = item.unit_factor ?? 1
        const inventoryQuantity = item.inventory_quantity ?? item.quantity
        if (!item.product_id || !Number.isFinite(item.quantity) || item.quantity <= 0
            || !Number.isFinite(unitFactor) || unitFactor <= 0
            || !Number.isFinite(inventoryQuantity) || inventoryQuantity <= 0
            || Math.abs(inventoryQuantity - item.quantity * unitFactor) > 0.000001
            || !Number.isFinite(item.unit_price) || item.unit_price < 0
            || !Number.isFinite(item.converted_unit_price) || item.converted_unit_price < 0
            || !Number.isFinite(item.total) || !Number.isFinite(item.cost_price) || item.cost_price < 0
            || !Number.isFinite(item.converted_cost_price) || item.converted_cost_price < 0
            || item.settlement_currency !== p.settlement_currency
            || Math.abs(item.total - item.converted_unit_price * item.quantity) > 0.001) {
            throw new Error(i18n.t('pos.stockMismatch'))
        }
    }
    if (Math.abs(p.items.reduce((sum, item) => sum + item.total, 0) - p.total_amount) > 0.001) {
        throw new Error(i18n.t('messages.checkoutFailed'))
    }
    if (!p.currency_conversion_applied && (new Set(p.items.map(item => item.original_currency)).size !== 1
        || p.items[0].original_currency !== p.settlement_currency || p.sales_exchange.length)) {
        throw new Error(i18n.t('pos.currencyConversionSingleCurrencyCart'))
    }
    if (p.payment_method === 'loan' && (!input.loanRegistration || !input.atomicLoanPayload
        || !Number.isInteger(input.loanRegistration.installmentCount) || input.loanRegistration.installmentCount < 1
        || input.loanRegistration.installmentCount > 120)) {
        throw new Error(i18n.t('loans.messages.loanCreateFailed'))
    }
}

async function postPayment(input: PosCheckoutInput, referenceLabel: string) {
    const { payload: p } = input
    if (p.payment_method === 'loan' || p.total_amount === 0) return
    await appendPaymentTransaction(p.workspace_id, {
        // Stable even when a committed sale's payment posting is retried.
        id: p.id,
        idempotent: true, requireRemoteConfirmation: true,
        sourceModule: 'sales', sourceType: 'pos_sale', sourceRecordId: p.id,
        sourceSubrecordId: null, direction: 'incoming', amount: p.total_amount,
        currency: p.settlement_currency, paymentMethod: p.payment_method,
        paidAt: input.timestamp, counterpartyName: null, referenceLabel, note: null,
        createdBy: input.user.id, accountId: input.account?.id ?? null,
        accountNameSnapshot: input.account?.name ?? null, metadata: { saleId: p.id, origin: 'pos' }
    })
}

async function saveLocal(input: PosCheckoutInput) {
    const { payload: p } = input
    // Include nested stock, payment-account and loan writes in the same commit.
    // SQLite's existing transaction hook receives the complete write set.
    return db.transaction('rw', db.tables, async () => {
        const existing = await db.sales.get(p.id)
        if (existing) {
            if (existing.workspaceId !== p.workspace_id || existing.totalAmount !== p.total_amount
                || existing.settlementCurrency !== p.settlement_currency || existing.payment_method !== p.payment_method) {
                throw new Error(i18n.t('messages.checkoutFailed'))
            }
            const loan = await db.loans.where('saleId').equals(p.id).first()
            return { sequenceId: existing.sequenceId, loanId: loan?.id ?? null }
        }
        const sequenceId = await generateLocalSaleSequenceId(p.workspace_id)
        for (const item of p.items) {
            const product = await db.products.get(item.product_id)
            if (!product || product.isDeleted || product.workspaceId !== p.workspace_id
                || (isService(product) ? item.storage_id !== null : !item.storage_id)) {
                throw new Error(i18n.t('pos.stockMismatch'))
            }
            const unitFactor = item.unit_factor ?? 1
            const inventoryQuantity = item.inventory_quantity ?? item.quantity
            if (!item.selling_unit_ref) {
                if (item.base_unit_ref
                    || (item.selling_unit_code ?? null) !== (item.base_unit_code ?? null)
                    || unitFactor !== 1
                    || Math.abs(inventoryQuantity - item.quantity) > 0.000001) {
                    throw new Error(i18n.t('pos.stockMismatch'))
                }
                continue
            }
            const conversion = await db.product_unit_conversions
                .where('[workspaceId+productId]')
                .equals([p.workspace_id, item.product_id])
                .and((row) => !row.isDeleted)
                .first()
            const relationship = conversion
                ? await db.unit_relationships.get(conversion.relationshipId)
                : undefined
            if (!conversion || !relationship || relationship.isDeleted
                || product.unit.trim().toLocaleLowerCase() !== relationship.childUnitCode.trim().toLocaleLowerCase()
                || item.base_unit_ref !== relationship.childUnitRef
                || item.base_unit_code !== relationship.childUnitCode
                || (item.selling_unit_ref === relationship.parentUnitRef
                    ? item.selling_unit_code !== relationship.parentUnitCode || unitFactor !== conversion.factor
                    : item.selling_unit_ref === relationship.childUnitRef
                        ? item.selling_unit_code !== relationship.childUnitCode || unitFactor !== 1
                        : true)) {
                throw new Error(i18n.t('pos.stockMismatch'))
            }
        }
        const verification = verifySale(createVerificationSale(
            p.total_amount, p.settlement_currency, input.primaryRate?.rate ?? null,
            input.primaryRate?.source ?? null, p.items, input.exchangeRates
        ), { maxDiscountPercent: input.maxDiscountPercent })
        await db.sales.add({
            id: p.id, workspaceId: p.workspace_id, cashierId: input.user.id,
            totalAmount: p.total_amount, originalTotalAmount: p.total_amount, returnedAmount: 0,
            returnStatus: 'none', settlementCurrency: p.settlement_currency,
            currencyConversionApplied: p.currency_conversion_applied, origin: 'pos', payment_method: p.payment_method,
            sequenceId, createdAt: input.timestamp, updatedAt: input.timestamp,
            syncStatus: 'synced', lastSyncedAt: input.timestamp, version: 1, isDeleted: false,
            systemVerified: verification.verified, systemReviewStatus: verification.status, systemReviewReason: verification.reason
        })
        await db.sale_items.bulkAdd(p.items.map(item => {
            const allocations = item.batch_allocations?.map(a => ({
                batchId: a.batch_id, batchNumber: a.batch_number, quantity: a.quantity,
                price: a.price, costPrice: a.cost_price, currency: a.currency,
                expiryDate: a.expiry_date, manufacturingDate: a.manufacturing_date
            })) ?? null
            return {
                id: generateId(), workspaceId: p.workspace_id, saleId: p.id,
                createdAt: input.timestamp, updatedAt: input.timestamp,
                productId: item.product_id, storageId: item.storage_id, quantity: item.quantity,
                sellingUnitRef: item.selling_unit_ref as never, sellingUnitCode: item.selling_unit_code,
                baseUnitRef: item.base_unit_ref as never, baseUnitCode: item.base_unit_code,
                unitFactor: item.unit_factor ?? 1, inventoryQuantity: item.inventory_quantity ?? item.quantity,
                unitPrice: item.unit_price, totalPrice: item.total_price, costPrice: item.cost_price,
                convertedCostPrice: item.converted_cost_price, originalCurrency: item.original_currency,
                originalUnitPrice: item.original_unit_price, convertedUnitPrice: item.converted_unit_price,
                settlementCurrency: item.settlement_currency, negotiatedPrice: item.negotiated_price,
                priceBookId: item.price_book_id, inventorySnapshot: item.inventory_snapshot,
                batchAllocations: allocations, originalBatchAllocations: allocations
            }
        }))
        if (p.sales_exchange.length) await db.sales_exchange.bulkAdd(p.sales_exchange.map(row => ({
            id: generateId(), saleId: p.id, workspaceId: p.workspace_id,
            baseCurrency: row.base_currency, quoteCurrency: row.quote_currency,
            baseAmount: row.base_amount, quoteAmount: row.quote_amount, source: row.source,
            capturedAt: row.captured_at, rateSide: row.rate_side, sourcePriceId: row.source_price_id,
            sourcePriceUpdatedAt: row.source_price_updated_at, createdAt: input.timestamp
        })))
        await applyOfflinePosStockEffects({
            workspaceId: p.workspace_id,
            items: p.items.flatMap(item => item.storage_id ? [{ productId: item.product_id, storageId: item.storage_id, quantity: item.inventory_quantity ?? item.quantity }] : []),
            batchPlans: input.batchPlans, timestamp: input.timestamp, skipReorderCheck: true
        })
        await postPayment(input, `#${String(sequenceId).padStart(5, '0')}`)
        const r = input.loanRegistration
        const loan = p.payment_method === 'loan' && r ? await createLoanFromPosSale(p.workspace_id, {
            saleId: p.id, ...r, principalAmount: p.total_amount, settlementCurrency: p.settlement_currency,
            exchangeRateSnapshot: input.exchangeRates, createdBy: input.user.id, createdAt: input.timestamp
        }) : null
        return { sequenceId, loanId: loan?.loan.id ?? null }
    })
}

/** Production checkout persistence, shared by /pos and isolated developer tests. */
export async function commitPosCheckout(input: PosCheckoutInput) {
    let committed = false
    try {
        validate(input)
        const { payload: p } = input
        if (isLocalWorkspaceMode(p.workspace_id)) {
            const result = await saveLocal(input)
            // Automatic reorder transfers are follow-up work, outside the sale.
            const { evaluateReorderTransferRulesForProduct } = await import('./reorderTransferRules')
            await Promise.allSettled([...new Set(p.items.filter(item => item.storage_id).map(item => item.product_id))]
                .map(id => evaluateReorderTransferRulesForProduct(p.workspace_id, id)))
            return result
        }
        if (!isOnline(p.workspace_id)) throw new Error(i18n.t('inventory.errors.onlineRequired'))
        const call = () => input.atomicLoanPayload
            ? supabase.rpc('complete_sale_with_loan', { payload: p, p_loan: input.atomicLoanPayload })
            : supabase.rpc('complete_sale', { payload: p })
        let response = await runSupabaseAction('pos.completeSale', call)
        if (response.error && isRetriableWebRequestError(response.error)) {
            response = await runSupabaseAction('pos.completeSale.verify', call)
        }
        if (response.error) throw response.error
        // A transport success with an invalid result is also an uncertain commit.
        committed = true
        const result = response.data as { sequence_id?: number; loan_aggregate?: unknown } | null
        if (!result || !Number.isInteger(result.sequence_id) || Number(result.sequence_id) < 1
            || (p.payment_method === 'loan' && !result.loan_aggregate)) throw new Error('Invalid checkout result')
        // A completed projection is safe to reattach after an idempotent replay.
        const existingInvoice = await db.invoices.get(p.id)
        if (existingInvoice?.workspaceId === p.workspace_id) {
            const loan = await db.loans.where('saleId').equals(p.id).first()
            return { sequenceId: result.sequence_id, loanId: loan?.id ?? null }
        }
        const aggregate = result.loan_aggregate ? await persistLoanAggregateRpcResult(result.loan_aggregate) : null
        await postPayment(input, `#${String(result.sequence_id).padStart(5, '0')}`)
        await db.transaction('rw', db.tables, async () => {
            if (await db.invoices.get(p.id)) return
            for (const item of p.items) if (item.storage_id) await adjustInventoryQuantity({
                workspaceId: p.workspace_id, productId: item.product_id, storageId: item.storage_id,
                quantityDelta: -(item.inventory_quantity ?? item.quantity), timestamp: input.timestamp, syncSource: 'remote', skipRemoteSync: true
            })
            for (const plan of input.batchPlans) await commitStockBatchAllocations(
                p.workspace_id, plan.productId, plan.storageId, plan.allocations,
                { timestamp: input.timestamp, syncSource: 'remote', skipRemoteSync: true }
            )
            await db.invoices.put({
                id: p.id, invoiceid: `#${String(result.sequence_id).padStart(5, '0')}`, sequenceId: result.sequence_id,
                workspaceId: p.workspace_id, customerId: '', status: 'paid', totalAmount: p.total_amount,
                settlementCurrency: p.settlement_currency, origin: 'pos', cashierName: input.user.name,
                createdByName: input.user.name, createdAt: input.timestamp, updatedAt: input.timestamp,
                syncStatus: 'synced', lastSyncedAt: input.timestamp, version: 1, isDeleted: false
            })
        })
        // Reconciliation is follow-up work; the projection transaction already
        // contains an invoice checkpoint preventing duplicate stock effects.
        await refreshStockBatchesFromSupabase(p.workspace_id)
        return { sequenceId: result.sequence_id, loanId: aggregate?.loan.id ?? null }
    } catch (cause) {
        throw new PosCheckoutError(committed, input.payload.id, cause)
    }
}
