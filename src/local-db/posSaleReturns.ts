import i18n from '@/i18n/config'
import type { Sale } from '@/types'
import type { CurrencyCode, PaymentAccount, SaleReturn as LocalSaleReturn, SaleReturnItem as LocalSaleReturnItem, StockBatchAllocation, WorkspacePaymentMethod } from './models'
import { db } from './database'
import { appendPaymentTransaction } from './payments'
import { getPaymentTransactionReversalState } from '@/lib/paymentReversals'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

/** A converted price of zero remains zero, including after currency rounding. */
export function calculateSaleReturnAmount(items: ReadonlyArray<{ converted_unit_price?: number | null; unit_price?: number | null }>, quantities: number[]) {
    return items.reduce((sum, item, index) => sum + (item.converted_unit_price ?? item.unit_price ?? 0) * quantities[index], 0)
}

/** Keep Local stock restoration, return records, refunds and loan changes inseparable. */
export async function commitLocalSaleReturn<T>(
    workspaceId: string,
    operation: () => Promise<T>,
    options: { reorderProductIds?: string[] } = {}
) {
    if (!isLocalWorkspaceMode(workspaceId)) throw new Error(i18n.t('inventory.errors.onlineRequired'))
    const result = await db.transaction('rw', db.tables, operation)
    const productIds = Array.from(new Set(options.reorderProductIds?.filter(Boolean) ?? []))
    if (productIds.length > 0) {
        try {
            const { evaluateReorderTransferRulesForProduct } = await import('./reorderTransferRules')
            for (const productId of productIds) {
                try {
                    await evaluateReorderTransferRulesForProduct(workspaceId, productId)
                } catch (error) {
                    console.error('[Sales] Failed to evaluate reorder rules after sale return:', error)
                }
            }
        } catch (error) {
            console.error('[Sales] Failed to load reorder rules after sale return:', error)
        }
    }
    return result
}

/** Sales return records and POS refund audit entries. Inventory and loan returns use their existing adapters. */
export async function persistSaleReturnLedger(input: {
    userId?: string | null
    returnId: string
    sale: Sale
    reason: string
    timestamp: string
    refundAmount: number
    linePayloads: Array<{ id: string; sale_item_id: string; quantity: number }>
    restoredPlans: Array<{
        storageId: string | null
        restoredBatchAllocations: StockBatchAllocation[]
    }>
    pendingSync: boolean
    paymentAccount?: PaymentAccount | null
    hasPaymentAccountSelection?: boolean
}) {
    if (!Number.isFinite(input.refundAmount) || input.refundAmount < 0 || !input.linePayloads.length) throw new Error(i18n.t('sales.return.failed'))
    const persist = async () => {
        const existingReturn = await db.sale_returns.get(input.returnId)
        if (existingReturn && (existingReturn.workspaceId !== input.sale.workspace_id || existingReturn.saleId !== input.sale.id
            || Math.abs(existingReturn.refundAmount - input.refundAmount) > 0.001)) throw new Error(i18n.t('sales.return.failed'))
        const syncStatus = input.pendingSync ? 'pending' : 'synced'
        const saleReturn: LocalSaleReturn = {
            id: input.returnId,
            workspaceId: input.sale.workspace_id,
            saleId: input.sale.id,
            reason: input.reason || 'Return',
            status: 'posted',
            refundMethod: null,
            refundAmount: input.refundAmount,
            returnedBy: input.userId ?? null,
            returnedAt: input.timestamp,
            source: 'app',
            createdAt: input.timestamp,
            updatedAt: input.timestamp,
            syncStatus,
            lastSyncedAt: input.pendingSync ? null : input.timestamp,
            version: 1,
            isDeleted: false
        }
        const saleReturnItems: LocalSaleReturnItem[] = input.linePayloads.map((line, index) => {
            const saleItem = input.sale.items?.find((item) => item.id === line.sale_item_id)
            const unitRefundAmount = saleItem?.converted_unit_price ?? saleItem?.unit_price ?? 0

            return {
                id: line.id,
                workspaceId: input.sale.workspace_id,
                returnId: input.returnId,
                saleId: input.sale.id,
                saleItemId: line.sale_item_id,
                quantity: line.quantity,
                unitRefundAmount,
                refundAmount: unitRefundAmount * line.quantity,
                restoredStorageId: input.restoredPlans[index]?.storageId ?? null,
                restoredBatchAllocations: input.restoredPlans[index]?.restoredBatchAllocations ?? null,
                createdAt: input.timestamp,
                updatedAt: input.timestamp,
                syncStatus,
                lastSyncedAt: input.pendingSync ? null : input.timestamp,
                version: 1,
                isDeleted: false
            }
        })

        for (const line of input.linePayloads) {
            const item = input.sale.items?.find(item => item.id === line.sale_item_id)
            if (!item || !Number.isFinite(line.quantity) || line.quantity <= 0
                || line.quantity - (item.quantity - (item.returned_quantity || 0)) > 0.000001) throw new Error(i18n.t('sales.return.failed'))
        }
        if (Math.abs(saleReturnItems.reduce((sum, line) => sum + line.refundAmount, 0) - input.refundAmount) > 0.01) throw new Error(i18n.t('sales.return.failed'))
        await db.transaction('rw', [db.sale_returns, db.sale_return_items], async () => {
            await db.sale_returns.put(saleReturn)
            await db.sale_return_items.bulkPut(saleReturnItems)
        })

        if (input.sale.origin !== 'pos' || input.sale.payment_method === 'loan' || input.refundAmount <= 0) {
            return
        }

        const salePayments = await db.payment_transactions
            .where('[workspaceId+sourceType+sourceRecordId]')
            .equals([input.sale.workspace_id, 'pos_sale', input.sale.id])
            .toArray()
        const originalPayment = salePayments
            .filter((payment) => !payment.isDeleted && !payment.reversalOfTransactionId)
            .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))[0]
        const saleCurrency = input.sale.settlement_currency?.toLowerCase()
        const paymentCurrency: CurrencyCode = saleCurrency === 'usd' || saleCurrency === 'eur' || saleCurrency === 'iqd' || saleCurrency === 'try'
            ? saleCurrency
            : 'usd'

        const existingPayment = await db.payment_transactions.get(input.returnId)
        if (existingPayment && existingPayment.sourceRecordId !== input.sale.id) throw new Error(i18n.t('sales.return.failed'))
        if (originalPayment && !existingPayment && input.refundAmount - getPaymentTransactionReversalState(originalPayment, salePayments).remainingAmount > 0.001) throw new Error(i18n.t('sales.return.failed'))
        await appendPaymentTransaction(input.sale.workspace_id, {
            id: input.returnId, idempotent: true, requireRemoteConfirmation: true,
            sourceModule: 'sales',
            sourceType: 'pos_sale',
            sourceRecordId: input.sale.id,
            sourceSubrecordId: input.returnId,
            direction: 'incoming',
            amount: -Math.abs(input.refundAmount),
            currency: paymentCurrency,
            paymentMethod: (input.sale.payment_method || 'cash') as WorkspacePaymentMethod,
            paidAt: input.timestamp,
            counterpartyName: input.sale._counterpartyName || null,
            referenceLabel: input.sale._orderNumber || input.sale.id,
            note: `Sale return ${input.returnId}: ${input.reason || 'Return'}`,
            createdBy: input.userId || null,
            reversalOfTransactionId: originalPayment?.id ?? null,
            ...(input.hasPaymentAccountSelection
                ? {
                    accountId: input.paymentAccount?.id ?? null,
                    accountNameSnapshot: input.paymentAccount?.name ?? null
                }
                : {}),
            metadata: { saleReturnId: input.returnId, returnReason: input.reason || 'Return' }
        })
    }
    if (isLocalWorkspaceMode(input.sale.workspace_id)) return db.transaction('rw', db.tables, persist)
    return persist().catch(cause => { throw Object.assign(new Error(i18n.t('sales.return.failed')), { cause }) })
}
