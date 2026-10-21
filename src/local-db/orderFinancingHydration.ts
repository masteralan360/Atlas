import type { Table } from 'dexie'

import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { toCamelCase } from '@/lib/utils'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'
import { db } from './database'
import type { BaseEntity, Loan, LoanInstallment, LoanPayment, PaymentTransaction } from './models'

const PAGE_SIZE = 500

/** Read only this activation's records; never hydrate an entire workspace. */
async function readFinancingRows<T extends BaseEntity>(
    tableName: string,
    workspaceId: string,
    column: string,
    ids: string[],
): Promise<T[]> {
    const rows: T[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
        const query = getSupabaseClientForTable(tableName).from(tableName)
            .select('*')
            .eq('workspace_id', workspaceId)
            .in(column, ids)
            .order('id')
            .range(from, from + PAGE_SIZE - 1)
        const { data, error } = await runSupabaseAction(`orders.financing.${tableName}`, () => query)
        if (error) throw normalizeSupabaseActionError(error)
        if (!Array.isArray(data)) throw new Error('Invalid order financing response')
        for (const value of data) {
            if (!value || typeof value.id !== 'string' || value.workspace_id !== workspaceId
                || !ids.includes(value[column])) {
                throw new Error('Invalid order financing response')
            }
            rows.push(toCamelCase(value) as unknown as T)
        }
        if (data.length < PAGE_SIZE) return rows
    }
}

async function cacheFinancingRows<T extends BaseEntity>(
    table: Pick<Table<T, string>, 'bulkGet' | 'bulkPut'>,
    rows: T[],
    fetchedAt: string,
) {
    if (rows.length === 0) return
    const localRows = await table.bulkGet(rows.map((row) => row.id))
    const confirmed = rows.flatMap((row, index) => {
        const local = localRows[index]
        // Keep queued/conflicting changes and results of a newer concurrent
        // payment or hydration. This pull only updates the responsive cache.
        if (local && (local.workspaceId !== row.workspaceId
            || local.syncStatus !== 'synced'
            || local.version > row.version
            || (local.version === row.version
                && Date.parse(local.lastSyncedAt ?? local.updatedAt) > Date.parse(fetchedAt)))) return []
        return [{ ...row, syncStatus: 'synced' as const, lastSyncedAt: fetchedAt }]
    })
    if (confirmed.length > 0) await table.bulkPut(confirmed)
}

export async function hydrateOrderFinancingFromSupabase(workspaceId: string, orderId: string, loanId: string) {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) return
    const fetchedAt = new Date().toISOString()
    const [loans, installments, payments, transactions] = await Promise.all([
        readFinancingRows<Loan>('loans', workspaceId, 'id', [loanId]),
        readFinancingRows<LoanInstallment>('loan_installments', workspaceId, 'loan_id', [loanId]),
        readFinancingRows<LoanPayment>('loan_payments', workspaceId, 'loan_id', [loanId]),
        readFinancingRows<PaymentTransaction>('payment_transactions', workspaceId, 'source_record_id', [loanId, orderId]),
    ])
    if (loans.length !== 1 || loans[0].orderId !== orderId) {
        throw new Error('Linked loan was not found')
    }
    if (!await canReconcileCloudWorkspaceData(workspaceId)) return
    await db.transaction('rw', [db.loans, db.loan_installments, db.loan_payments, db.payment_transactions], async () => {
        await cacheFinancingRows<Loan>(db.loans, loans, fetchedAt)
        await cacheFinancingRows<LoanInstallment>(db.loan_installments, installments, fetchedAt)
        await cacheFinancingRows<LoanPayment>(db.loan_payments, payments, fetchedAt)
        await cacheFinancingRows<PaymentTransaction>(db.payment_transactions, transactions, fetchedAt)
    })
}
