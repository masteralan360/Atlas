import { supabase } from '@/auth/supabase'
import { useLiveQuery } from 'dexie-react-hooks'
import { QUANTITY_EPSILON, roundQuantity } from '@/lib/quantity'
import { generateId } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { assertInventoryMutationConnectivity, getInventoryQuantityForProductStorage, putInventoryQuantity, syncProductStockSnapshot } from './inventory'
import { fetchTableFromSupabase, syncSalesFromSupabase } from './hooks'
import { refreshStockBatchesFromSupabase, getStockBatchSalePlan, splitStockBatchAllocationsForReturn } from './stockBatches'
import { resolveReturnStorageId } from './storageUtils'
import {
    assertPaymentAccountTransactionCanBeAppliedLocally,
    mirrorPaymentAccountTransactionLocally,
} from './paymentAccounts'
import type {
    Loan,
    LoanInstallment,
    LoanPayment,
    PaymentTransaction,
    Sale,
    SaleItem,
    SaleProductExchange,
    SaleReturn,
    SaleReturnItem,
    StockBatch,
    StockBatchAllocation,
    WorkspacePaymentMethod,
} from './models'

export interface ProcessSaleProductExchangeInput {
    workspaceId: string
    saleId: string
    returnSaleItemId: string
    returnQuantity: number
    replacementProductId: string
    replacementStorageId: string
    replacementQuantity: number
    /** Must be expressed in the original sale's settlement currency. */
    replacementUnitAmount: number
    settlementMethod?: WorkspacePaymentMethod | null
    note?: string | null
    returnReason?: string | null
    createdBy?: string | null
    accountId?: string | null
    accountNameSnapshot?: string | null
}

export interface ProcessSaleProductExchangeResult {
    exchangeId: string
    returnId: string
    returnAmount: number
    replacementAmount: number
    differenceAmount: number
    cashSettlementAmount: number
    loanCreditAmount: number
    idempotentReplay: boolean
}

type ExchangeIds = { exchangeId: string, returnId: string }

function getSyncMetadata(workspaceId: string, timestamp: string) {
    return isLocalWorkspaceMode(workspaceId)
        ? { syncStatus: 'synced' as const, lastSyncedAt: timestamp }
        : { syncStatus: 'pending' as const, lastSyncedAt: null }
}

function normalizeAmount(value: number, label: string) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${label} must be zero or greater`)
    }
    return parsed
}

function normalizeQuantity(value: number, label: string) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be greater than zero`)
    }
    return roundQuantity(parsed)
}

function getLoanStatus(loan: Loan, balanceAmount: number): Loan['status'] {
    if (balanceAmount <= QUANTITY_EPSILON) return 'completed'
    const dueDate = loan.nextDueDate
    return dueDate && dueDate < new Date().toISOString().slice(0, 10) ? 'overdue' : 'active'
}

function getInstallmentStatus(installment: LoanInstallment, balanceAmount: number): LoanInstallment['status'] {
    if (balanceAmount <= QUANTITY_EPSILON) return 'paid'
    if (installment.dueDate && installment.dueDate < new Date().toISOString().slice(0, 10)) return 'overdue'
    return installment.paidAmount > 0 ? 'partial' : 'unpaid'
}

async function restoreReturnedBatchAllocations(input: {
    workspaceId: string
    productId: string
    storageId: string
    allocations: StockBatchAllocation[]
    timestamp: string
}) {
    for (const allocation of input.allocations) {
        const direct = await db.stock_batches.get(allocation.batchId)
        let target = direct && !direct.isDeleted
            && direct.productId === input.productId
            && direct.storageId === input.storageId
            ? direct
            : null
        if (!target) {
            target = await db.stock_batches
                .where('[productId+storageId]')
                .equals([input.productId, input.storageId])
                .filter((row) => row.batchNumber.trim().toLowerCase() === allocation.batchNumber.trim().toLowerCase())
                .first() ?? null
        }

        if (target) {
            await db.stock_batches.put({
                ...target,
                quantity: roundQuantity(target.quantity + allocation.quantity),
                isDeleted: false,
                updatedAt: input.timestamp,
                version: target.version + 1,
                ...getSyncMetadata(input.workspaceId, input.timestamp),
            })
            continue
        }

        const batch: StockBatch = {
            id: direct ? generateId() : allocation.batchId,
            workspaceId: input.workspaceId,
            productId: input.productId,
            storageId: input.storageId,
            batchNumber: allocation.batchNumber,
            quantity: allocation.quantity,
            price: allocation.price ?? 0,
            costPrice: allocation.costPrice ?? 0,
            currency: allocation.currency ?? 'usd',
            expiryDate: allocation.expiryDate ?? null,
            manufacturingDate: allocation.manufacturingDate ?? null,
            notes: null,
            createdAt: input.timestamp,
            updatedAt: input.timestamp,
            version: 1,
            isDeleted: false,
            ...getSyncMetadata(input.workspaceId, input.timestamp),
        }
        await db.stock_batches.put(batch)
    }
}

async function consumeReplacementBatchAllocations(
    workspaceId: string,
    allocations: StockBatchAllocation[],
    timestamp: string,
) {
    for (const allocation of allocations) {
        const batch = await db.stock_batches.get(allocation.batchId)
        if (!batch || batch.isDeleted || batch.quantity + QUANTITY_EPSILON < allocation.quantity) {
            throw new Error(`Replacement batch ${allocation.batchNumber} is no longer available`)
        }
        const quantity = roundQuantity(batch.quantity - allocation.quantity)
        await db.stock_batches.put({
            ...batch,
            quantity,
            isDeleted: quantity <= QUANTITY_EPSILON,
            updatedAt: timestamp,
            version: batch.version + 1,
            ...getSyncMetadata(workspaceId, timestamp),
        })
    }
}

async function applyLocalSaleProductExchange(input: ProcessSaleProductExchangeInput, ids: ExchangeIds) {
    const timestamp = new Date().toISOString()
    const returnQuantity = normalizeQuantity(input.returnQuantity, 'Return quantity')
    const replacementQuantity = normalizeQuantity(input.replacementQuantity, 'Replacement quantity')
    const replacementUnitAmount = normalizeAmount(input.replacementUnitAmount, 'Replacement unit amount')
    const sale = await db.sales.get(input.saleId)
    const returnItem = await db.sale_items.get(input.returnSaleItemId)
    const replacementProduct = await db.products.get(input.replacementProductId)
    if (!sale || sale.workspaceId !== input.workspaceId || sale.isDeleted) throw new Error('Sale not found')
    if (sale.origin.trim().toLowerCase() !== 'pos') throw new Error('Product exchange is available only for POS sales')
    if (!returnItem || returnItem.saleId !== sale.id) throw new Error('Original sale item not found')
    if (!replacementProduct || replacementProduct.workspaceId !== input.workspaceId || replacementProduct.isDeleted) throw new Error('Replacement product not found')
    if (replacementProduct.currency.toLowerCase() !== sale.settlementCurrency.toLowerCase()) {
        throw new Error('Replacement product currency must match the sale settlement currency')
    }
    let replacementUnitPrice = replacementProduct.price
    if (returnItem.priceBookId) {
        const priceBook = await db.price_books.get(returnItem.priceBookId)
        const priceBookItem = priceBook && !priceBook.isDeleted
            ? await db.price_book_items.where('priceBookId').equals(returnItem.priceBookId)
                .and((row) => row.productId === input.replacementProductId && !row.isDeleted)
                .first()
            : undefined
        if (priceBookItem
            && priceBookItem.currency.toLowerCase() === sale.settlementCurrency.toLowerCase()) {
            replacementUnitPrice = priceBookItem.price
        }
    }
    if (Math.abs(replacementUnitAmount - replacementUnitPrice) > 0.000001) {
        throw new Error('Replacement unit amount must match the current product price')
    }
    if ((returnItem.returnedQuantity || 0) + returnQuantity - returnItem.quantity > QUANTITY_EPSILON) {
        throw new Error('Return quantity exceeds the remaining quantity for this sale item')
    }

    const returnStorageId = await resolveReturnStorageId({
        workspaceId: input.workspaceId,
        productId: returnItem.productId,
        saleStorageId: returnItem.storageId,
    })
    if (!returnStorageId) throw new Error('No active storage is available for the returned product')
    const replacementInventory = await getInventoryQuantityForProductStorage(input.replacementProductId, input.replacementStorageId)
    if (replacementInventory + QUANTITY_EPSILON < replacementQuantity) {
        throw new Error('Insufficient inventory in the selected replacement storage')
    }
    const replacementBatchPlan = await getStockBatchSalePlan(
        input.replacementProductId,
        input.replacementStorageId,
        replacementQuantity,
    )
    const returnSplit = splitStockBatchAllocationsForReturn(returnItem.batchAllocations || [], returnQuantity)
    const returnUnitAmount = Number(returnItem.convertedUnitPrice ?? returnItem.unitPrice ?? 0)
    const returnAmount = returnUnitAmount * returnQuantity
    const replacementAmount = replacementUnitPrice * replacementQuantity
    const differenceAmount = replacementAmount - returnAmount
    const sync = getSyncMetadata(input.workspaceId, timestamp)
    const reason = input.returnReason?.trim() || 'Product exchange'

    let result: ProcessSaleProductExchangeResult = {
        exchangeId: ids.exchangeId,
        returnId: ids.returnId,
        returnAmount,
        replacementAmount,
        differenceAmount,
        cashSettlementAmount: 0,
        loanCreditAmount: 0,
        idempotentReplay: false,
    }

    await db.transaction('rw', [
        db.sales, db.sale_items, db.sale_returns, db.sale_return_items,
        db.sale_product_exchanges, db.inventory, db.products, db.stock_batches,
        db.storages, db.loans, db.loan_installments, db.loan_payments, db.payment_transactions,
    ], async () => {
        const existingExchange = await db.sale_product_exchanges.get(ids.exchangeId)
        if (existingExchange) {
            result = {
                exchangeId: existingExchange.id,
                returnId: existingExchange.returnId,
                returnAmount: existingExchange.returnAmount,
                replacementAmount: existingExchange.replacementAmount,
                differenceAmount: existingExchange.differenceAmount,
                cashSettlementAmount: existingExchange.cashSettlementAmount,
                loanCreditAmount: existingExchange.loanCreditAmount,
                idempotentReplay: true,
            }
            return
        }

        const currentReplacementQuantity = await getInventoryQuantityForProductStorage(input.replacementProductId, input.replacementStorageId)
        if (currentReplacementQuantity + QUANTITY_EPSILON < replacementQuantity) {
            throw new Error('Insufficient inventory in the selected replacement storage')
        }

        await putInventoryQuantity(
            input.workspaceId,
            returnItem.productId,
            returnStorageId,
            roundQuantity(await getInventoryQuantityForProductStorage(returnItem.productId, returnStorageId) + returnQuantity),
            timestamp,
        )
        await putInventoryQuantity(
            input.workspaceId,
            input.replacementProductId,
            input.replacementStorageId,
            roundQuantity(currentReplacementQuantity - replacementQuantity),
            timestamp,
        )
        await restoreReturnedBatchAllocations({
            workspaceId: input.workspaceId,
            productId: returnItem.productId,
            storageId: returnStorageId,
            allocations: returnSplit.restoredAllocations,
            timestamp,
        })
        await consumeReplacementBatchAllocations(input.workspaceId, replacementBatchPlan.allocations, timestamp)

        const nextReturnedQuantity = roundQuantity((returnItem.returnedQuantity || 0) + returnQuantity)
        const updatedReturnItem: SaleItem = {
            ...returnItem,
            updatedAt: timestamp,
            originalBatchAllocations: returnItem.originalBatchAllocations || returnItem.batchAllocations || null,
            batchAllocations: returnSplit.remainingAllocations.length > 0 ? returnSplit.remainingAllocations : null,
            returnedQuantity: nextReturnedQuantity,
            storageId: returnItem.storageId || returnStorageId,
        }
        updatedReturnItem.isReturned = nextReturnedQuantity + QUANTITY_EPSILON >= returnItem.quantity
        updatedReturnItem.returnReason = reason
        updatedReturnItem.returnedAt = timestamp
        updatedReturnItem.returnedBy = input.createdBy || null
        await db.sale_items.put(updatedReturnItem)

        const allItems = await db.sale_items.where('saleId').equals(sale.id).toArray()
        const allReturned = allItems.every((item) => {
            const itemReturnedQuantity = item.id === updatedReturnItem.id ? nextReturnedQuantity : (item.returnedQuantity || 0)
            return itemReturnedQuantity + QUANTITY_EPSILON >= item.quantity
        })
        const updatedSale: Sale = {
            ...sale,
            originalTotalAmount: sale.originalTotalAmount ?? sale.totalAmount,
            totalAmount: Math.max(0, sale.totalAmount - returnAmount),
            returnedAmount: (sale.returnedAmount || 0) + returnAmount,
            returnStatus: allReturned ? 'full' : 'partial',
            isReturned: allReturned,
            returnReason: allReturned ? reason : sale.returnReason,
            returnedAt: allReturned ? timestamp : sale.returnedAt,
            returnedBy: allReturned ? (input.createdBy || null) : sale.returnedBy,
            updatedAt: timestamp,
            version: sale.version + 1,
            ...sync,
        }
        await db.sales.put(updatedSale)

        const saleReturn: SaleReturn = {
            id: ids.returnId,
            workspaceId: input.workspaceId,
            saleId: sale.id,
            reason,
            status: 'posted',
            refundMethod: null,
            refundAmount: returnAmount,
            returnedBy: input.createdBy || null,
            returnedAt: timestamp,
            source: 'exchange',
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
            isDeleted: false,
            ...sync,
        }
        const saleReturnItem: SaleReturnItem = {
            id: generateId(),
            workspaceId: input.workspaceId,
            returnId: ids.returnId,
            saleId: sale.id,
            saleItemId: returnItem.id,
            quantity: returnQuantity,
            unitRefundAmount: returnUnitAmount,
            refundAmount: returnAmount,
            restoredStorageId: returnStorageId,
            restoredBatchAllocations: returnSplit.restoredAllocations,
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
            isDeleted: false,
            ...sync,
        }
        await db.sale_returns.put(saleReturn)
        await db.sale_return_items.put(saleReturnItem)

        let cashSettlementAmount = sale.payment_method === 'loan' ? 0 : Math.abs(differenceAmount)
        let settlementDirection: PaymentTransaction['direction'] | null = cashSettlementAmount > 0
            ? (differenceAmount > 0 ? 'incoming' : 'outgoing')
            : null
        let settlementTransactionId: string | null = null
        let loanId: string | null = null
        let loanCreditAmount = 0

        if (sale.payment_method === 'loan') {
            const loan = await db.loans.where('saleId').equals(sale.id).and((item) => !item.isDeleted && item.source === 'pos').first()
            if (loan) {
                loanId = loan.id
                const installments = await db.loan_installments.where('loanId').equals(loan.id).and((item) => !item.isDeleted).sortBy('installmentNo')
                const updatedInstallments = installments.map((item) => ({ ...item }))
                if (differenceAmount < 0) {
                    loanCreditAmount = Math.min(-differenceAmount, loan.balanceAmount)
                    let remainingCredit = loanCreditAmount
                    for (const installment of updatedInstallments) {
                        if (remainingCredit <= QUANTITY_EPSILON || installment.balanceAmount <= 0) continue
                        const applied = Math.min(remainingCredit, installment.balanceAmount)
                        installment.paidAmount = roundQuantity(installment.paidAmount + applied)
                        installment.balanceAmount = roundQuantity(installment.balanceAmount - applied)
                        installment.status = getInstallmentStatus(installment, installment.balanceAmount)
                        installment.paidAt = installment.balanceAmount <= QUANTITY_EPSILON ? timestamp : installment.paidAt
                        installment.updatedAt = timestamp
                        installment.version += 1
                        Object.assign(installment, sync)
                        remainingCredit = roundQuantity(remainingCredit - applied)
                    }
                    cashSettlementAmount = roundQuantity(-differenceAmount - loanCreditAmount)
                    settlementDirection = cashSettlementAmount > 0 ? 'outgoing' : null
                } else if (differenceAmount > 0) {
                    const target = updatedInstallments.find((item) => item.balanceAmount > QUANTITY_EPSILON)
                        || updatedInstallments[updatedInstallments.length - 1]
                    if (target) {
                        target.plannedAmount = roundQuantity(target.plannedAmount + differenceAmount)
                        target.balanceAmount = roundQuantity(target.balanceAmount + differenceAmount)
                        target.status = getInstallmentStatus(target, target.balanceAmount)
                        target.paidAt = null
                        target.updatedAt = timestamp
                        target.version += 1
                        Object.assign(target, sync)
                    }
                }
                const balanceAmount = roundQuantity(Math.max(0, loan.balanceAmount + differenceAmount))
                const nextDueDate = updatedInstallments.find((item) => item.balanceAmount > QUANTITY_EPSILON)?.dueDate || null
                const updatedLoan: Loan = {
                    ...loan,
                    principalAmount: roundQuantity(loan.principalAmount + Math.max(0, differenceAmount)),
                    totalPaidAmount: roundQuantity(loan.totalPaidAmount + loanCreditAmount),
                    balanceAmount,
                    nextDueDate,
                    status: getLoanStatus({ ...loan, nextDueDate }, balanceAmount),
                    updatedAt: timestamp,
                    version: loan.version + 1,
                    ...sync,
                }
                await db.loans.put(updatedLoan)
                if (updatedInstallments.length > 0) await db.loan_installments.bulkPut(updatedInstallments)
                if (loanCreditAmount > 0) {
                    const loanPayment: LoanPayment = {
                        id: generateId(), workspaceId: input.workspaceId, loanId: loan.id,
                        amount: loanCreditAmount, paymentMethod: 'loan_adjustment', paidAt: timestamp,
                        note: `Product exchange credit ${ids.exchangeId}`, createdBy: input.createdBy || undefined,
                        createdAt: timestamp, updatedAt: timestamp, version: 1, isDeleted: false, ...sync,
                    }
                    await db.loan_payments.put(loanPayment)
                    const loanLedger: PaymentTransaction = {
                        id: generateId(), workspaceId: input.workspaceId,
                        sourceModule: 'loans',
                        sourceType: loan.loanCategory === 'simple' ? 'simple_loan' : 'loan_installment',
                        sourceRecordId: loan.id, sourceSubrecordId: loanPayment.id,
                        direction: loan.direction === 'borrowed' ? 'outgoing' : 'incoming',
                        amount: loanCreditAmount, currency: loan.settlementCurrency,
                        paymentMethod: 'loan_adjustment', paidAt: timestamp,
                        counterpartyName: loan.borrowerName, referenceLabel: loan.loanNo,
                        note: 'Product exchange credit', createdBy: input.createdBy || null,
                        accountId: null, accountNameSnapshot: null,
                        metadata: {
                            saleId: sale.id,
                            saleProductExchangeId: ids.exchangeId,
                            loanPaymentId: loanPayment.id,
                        },
                        reversalOfTransactionId: null, createdAt: timestamp, updatedAt: timestamp,
                        version: 1, isDeleted: false, ...sync,
                    }
                    await db.payment_transactions.put(loanLedger)
                    await mirrorPaymentAccountTransactionLocally(loanLedger)
                }
            } else {
                cashSettlementAmount = Math.abs(differenceAmount)
                settlementDirection = cashSettlementAmount > 0 ? (differenceAmount > 0 ? 'incoming' : 'outgoing') : null
            }
        }

        if (cashSettlementAmount > QUANTITY_EPSILON) {
            if (!input.settlementMethod) throw new Error('A settlement method is required for the cash difference')
            settlementTransactionId = generateId()
            const transaction: PaymentTransaction = {
                id: settlementTransactionId, workspaceId: input.workspaceId,
                sourceModule: 'sales', sourceType: 'sale_exchange', sourceRecordId: ids.exchangeId,
                sourceSubrecordId: null, direction: settlementDirection || 'outgoing',
                amount: cashSettlementAmount, currency: sale.settlementCurrency,
                paymentMethod: input.settlementMethod, paidAt: timestamp,
                counterpartyName: null, referenceLabel: ids.exchangeId,
                note: 'Product exchange settlement', createdBy: input.createdBy || null,
                accountId: input.accountId ?? null,
                accountNameSnapshot: input.accountNameSnapshot ?? null,
                metadata: { saleId: sale.id, saleProductExchangeId: ids.exchangeId },
                reversalOfTransactionId: null, createdAt: timestamp, updatedAt: timestamp,
                version: 1, isDeleted: false, ...sync,
            }
            await assertPaymentAccountTransactionCanBeAppliedLocally(transaction)
            await db.payment_transactions.put(transaction)
            await mirrorPaymentAccountTransactionLocally(transaction)
        }

        const exchange: SaleProductExchange = {
            id: ids.exchangeId, workspaceId: input.workspaceId, saleId: sale.id, returnId: ids.returnId,
            returnSaleItemId: returnItem.id, returnProductId: returnItem.productId,
            returnQuantity, returnUnitAmount, returnAmount, returnStorageId,
            replacementProductId: input.replacementProductId, replacementStorageId: input.replacementStorageId,
            replacementQuantity, replacementUnitAmount: replacementProduct.price, replacementAmount,
            replacementBatchAllocations: replacementBatchPlan.allocations.length ? replacementBatchPlan.allocations : null,
            settlementCurrency: sale.settlementCurrency, differenceAmount, cashSettlementAmount,
            settlementDirection, settlementMethod: input.settlementMethod || null,
            settlementTransactionId, loanId, loanCreditAmount, reason, notes: input.note?.trim() || null,
            exchangedBy: input.createdBy || null, exchangedAt: timestamp, status: 'posted',
            createdAt: timestamp, updatedAt: timestamp, version: 1, isDeleted: false, ...sync,
        }
        await db.sale_product_exchanges.put(exchange)
        await syncProductStockSnapshot(returnItem.productId, timestamp)
        if (input.replacementProductId !== returnItem.productId) {
            await syncProductStockSnapshot(input.replacementProductId, timestamp)
        }
        result = { ...result, cashSettlementAmount, loanCreditAmount }
    })

    return result
}

async function refreshAfterCloudExchange(workspaceId: string) {
    await Promise.all([
        syncSalesFromSupabase(workspaceId),
        fetchTableFromSupabase('inventory', db.inventory, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('loans', db.loans, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('loan_installments', db.loan_installments, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('loan_payments', db.loan_payments, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, { includeDeleted: true }),
        refreshStockBatchesFromSupabase(workspaceId),
    ])
}

export async function processSaleProductExchange(input: ProcessSaleProductExchangeInput): Promise<ProcessSaleProductExchangeResult> {
    const ids: ExchangeIds = { exchangeId: generateId(), returnId: generateId() }
    const localMode = isLocalWorkspaceMode(input.workspaceId)

    if (!localMode) {
        assertInventoryMutationConnectivity(input.workspaceId)
        const { data, error } = await supabase.rpc('process_sale_product_exchange_with_account', {
            p_exchange_id: ids.exchangeId,
            p_return_id: ids.returnId,
            p_sale_id: input.saleId,
            p_return_sale_item_id: input.returnSaleItemId,
            p_return_quantity: normalizeQuantity(input.returnQuantity, 'Return quantity'),
            p_replacement_product_id: input.replacementProductId,
            p_replacement_storage_id: input.replacementStorageId,
            p_replacement_quantity: normalizeQuantity(input.replacementQuantity, 'Replacement quantity'),
            p_replacement_unit_amount: normalizeAmount(input.replacementUnitAmount, 'Replacement unit amount'),
            p_settlement_method: input.settlementMethod || null,
            p_account_id: input.accountId || null,
            p_account_name_snapshot: input.accountNameSnapshot || null,
            p_note: input.note?.trim() || null,
            p_return_reason: input.returnReason?.trim() || 'Product exchange',
        })
        if (!error && data) {
            await refreshAfterCloudExchange(input.workspaceId)
            return {
                exchangeId: data.exchange_id, returnId: data.return_id,
                returnAmount: Number(data.return_amount || 0), replacementAmount: Number(data.replacement_amount || 0),
                differenceAmount: Number(data.difference_amount || 0), cashSettlementAmount: Number(data.cash_settlement_amount || 0),
                loanCreditAmount: Number(data.loan_credit_amount || 0), idempotentReplay: !!data.idempotent_replay,
            }
        }
        if (error) throw error
    }

    const result = await applyLocalSaleProductExchange(input, ids)
    return result
}

export function useSaleProductExchanges(workspaceId: string | undefined, saleId?: string) {
    return useLiveQuery(
        () => !workspaceId
            ? []
            : saleId
                ? db.sale_product_exchanges.where('saleId').equals(saleId).toArray()
                : db.sale_product_exchanges.where('workspaceId').equals(workspaceId).toArray(),
        [workspaceId, saleId],
    ) || []
}
