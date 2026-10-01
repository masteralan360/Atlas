import type { CurrencyCode, SalesOrder } from '@/local-db/models'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'

export const CURRENCIES: CurrencyCode[] = ['usd', 'eur', 'iqd', 'try']

export function variantsFor(caseId: string): Array<{ key: string; [key: string]: any }> {
    if (caseId === 'SO-H07-01') return CURRENCIES.map(currency => ({ key: currency, from: currency, to: currency }))
    if (caseId === 'SO-H07-02' || caseId === 'SO-H07-04') return CURRENCIES.flatMap(from => CURRENCIES.map(to => ({ key: `${from}/${to}`, from, to })))
    if (caseId === 'SO-H07-07') return ['manual', 'xeiqd', 'forexfy', 'dolardinar', 'pmcgroup'].flatMap(source => ['buy', 'sell', 'mid'].map(side => ({ key: `${source}/${side}`, from: 'eur', to: 'usd', source, side })))
    if (caseId === 'SO-H08-02' || caseId === 'SO-H08-03') return [0, 0.001, 50, 199.999, 200, 200.001].map(value => ({ key: `amount-${value}`, value }))
    if (caseId === 'SO-H11-05') return [99, 100, 101].map(count => ({ key: `stock-demand-${count}`, count }))
    if (caseId === 'SO-H15-04') return CURRENCIES.flatMap(currency => STANDARD_PAYMENT_METHODS.map(method => ({ key: `${currency}/${method}`, currency, method })))
    if (caseId === 'SO-H16-07') return CURRENCIES.map(currency => ({ key: currency, currency }))
    if (caseId === 'SO-H17-01') return ['weekly', 'biweekly', 'monthly'].map(frequency => ({ key: frequency, frequency, count: 2 }))
    if (caseId === 'SO-H17-02') return ['weekly', 'biweekly', 'monthly'].flatMap(frequency => Array.from({ length: 120 }, (_, i) => ({ key: `${frequency}/count-${i + 1}`, frequency, count: i + 1 })))
    if (caseId === 'SO-H17-04') return ['weekly', 'biweekly', 'monthly'].flatMap(frequency => ['2028-02-29', '2027-01-31', '2027-12-31'].map(due => ({ key: `${frequency}/${due}`, frequency, due: `${due}T12:00:00.000Z`, count: 2 })))
    if (caseId === 'SO-H17-05') return [3, 7, 9, 11].map(count => ({ key: `division-${count}`, count, frequency: 'monthly' }))
    if (caseId === 'SO-H17-13') return [-1, 0, 1].map(offset => ({ key: `due-offset-${offset}`, offset, frequency: 'monthly', count: 2 }))
    if (caseId === 'SO-H21-04') return CURRENCIES.flatMap(orderCurrency => CURRENCIES.flatMap(adjustmentCurrency => ['addition', 'deduction'].map(type => ({ key: `${orderCurrency}/${adjustmentCurrency}/${type}`, orderCurrency, adjustmentCurrency, type }))))
    if (caseId === 'SO-H22-03') return [0, 0.001, 10].map(amount => ({ key: `fixed-${amount}`, amount }))
    if (caseId === 'SO-H22-05') return ['percentage', 'fixed_amount'].map(commissionType => ({ key: commissionType, commissionType, amount: 5 }))
    if (caseId === 'SO-H26-03') return ['draft', 'pending', 'completed', 'cancelled', 'returned'].flatMap(status => ['unpaid', 'partial', 'paid'].flatMap(paymentStatus => ['none', 'partial', 'full'].map(returnStatus => ({ key: `${status}/${paymentStatus}/${returnStatus}`, status, paymentStatus, returnStatus }))))
    if (caseId === 'SO-H26-05') return [0, 1, 199, 200, 201, 501, 1001].map(count => ({ key: `rows-${count}`, count }))
    if (caseId === 'SO-H28-05') return [
        { chain: 'save', paths: ['/payment_transactions', '/sales_orders', '/rpc/sync_business_partner'] },
        { chain: 'approve', paths: ['/payment_transactions', '/sales_orders'] },
        { chain: 'cancel', paths: ['/rpc/cancel_order_with_financing'] },
        { chain: 'settle', paths: ['/payment_transactions', '/sales_orders'] },
        { chain: 'return', paths: ['/rpc/apply_inventory_snapshot_changes', '/payment_transactions', '/order_returns', '/order_return_items', '/sales_orders'] }
    ].flatMap(({ chain, paths }) => paths.flatMap(path => ['before', 'after'].map(mode => ({ key: `${chain}/${path}/${mode}`, chain, path, mode }))))
    return []
}

export interface QuickTuple { method: NonNullable<SalesOrder['paymentMethod']>; target: 'draft' | 'pending' | 'completed'; currency: CurrencyCode; paid: boolean; initial: number; lines: 'physical' | 'service' | 'mixed' | 'free'; unit: 'base' | 'carton' | 'custom'; account: boolean; approval: boolean }
/** Full applicable product, never pairwise or a seeded sample. Unsupported tuples remain negative cases. */
export function quickTuples(family: number): QuickTuple[] {
    const methods = family <= 6 || family === 10 ? STANDARD_PAYMENT_METHODS : family === 7 ? ['loan'] as const : family === 8 ? ['installments'] as const : ['installments', 'loan', ...STANDARD_PAYMENT_METHODS] as const
    const targets = family === 1 ? ['draft'] as const : family === 2 ? ['pending'] as const : family === 3 ? ['completed'] as const : ['draft', 'pending', 'completed'] as const
    const result: QuickTuple[] = []
    for (const method of methods) for (const target of targets) for (const currency of CURRENCIES)
        for (const lines of family === 11 ? ['physical', 'service', 'mixed', 'free'] as const : family === 10 ? ['free'] as const : ['physical'] as const)
            for (const unit of family === 11 && lines !== 'service' ? ['base', 'carton', 'custom'] as const : ['base'] as const)
            for (const paid of family === 5 || family === 6 || family === 7 || family === 8 ? [false] : family === 9 ? [true] : [false, true])
                for (const account of [false, true]) for (const approval of [false, true])
                    for (const initial of method === 'loan' || method === 'installments' ? [0, 25] : [0]) {
                        if (family === 9 && !['loan', 'installments'].includes(method)) continue
                        if (family === 4 && !paid || family === 5 && paid) continue
                        if (family === 2 || family === 3 || family === 6) { if (method !== 'cash') continue }
                        if ((family === 4 || family === 5) && (method === 'cash' || target === 'draft')) continue
                        result.push({ method, target, currency, paid, initial, lines, unit, account, approval })
                    }
    return result
}
