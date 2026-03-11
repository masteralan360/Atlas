import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { convertToStoreBase } from '@/lib/currency'
import type { Sale } from '@/types'
import type { CurrencyCode, Employee, BudgetStatus, PayrollStatus, DividendStatus } from '@/local-db/models'

export type MonthKey = `${number}-${string}`

export function monthKeyFromDate(date: Date | string): MonthKey {
    const d = new Date(date)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` as MonthKey
}

export function monthDateFromKey(month: MonthKey): Date {
    const [year, monthIndex] = month.split('-').map(Number)
    return new Date(year, monthIndex - 1, 1)
}

export function formatMonthLabel(month: MonthKey, language: string): string {
    return formatLocalizedMonthYear(monthDateFromKey(month), language)
}

export function getDaysInMonth(month: MonthKey): number {
    const [year, monthIndex] = month.split('-').map(Number)
    return new Date(year, monthIndex, 0).getDate()
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
    const base = monthDateFromKey(month)
    base.setMonth(base.getMonth() + delta)
    return monthKeyFromDate(base)
}

export function buildDueDate(month: MonthKey, day: number): string {
    const safeDay = Math.min(Math.max(day, 1), getDaysInMonth(month))
    return `${month}-${String(safeDay).padStart(2, '0')}`
}

export function isMonthOnOrAfter(month: MonthKey, compareTo: MonthKey): boolean {
    return month >= compareTo
}

export function isMonthOnOrBefore(month: MonthKey, compareTo: MonthKey): boolean {
    return month <= compareTo
}

export function buildConversionRates(
    exchangeData: { rate: number } | null,
    eurRates: { eur_iqd: { rate: number } | null } | null,
    tryRates: { try_iqd: { rate: number } | null } | null
) {
    return {
        usd_iqd: (exchangeData?.rate || 145000) / 100,
        eur_iqd: (eurRates?.eur_iqd?.rate || 160000) / 100,
        try_iqd: (tryRates?.try_iqd?.rate || 4500) / 100
    }
}

export function convertFromStoreBase(
    amount: number,
    to: CurrencyCode,
    baseCurrency: CurrencyCode,
    rates: { usd_iqd: number; eur_iqd: number; try_iqd: number }
) {
    if (to === baseCurrency) return amount

    const base = baseCurrency.toLowerCase() as CurrencyCode
    const target = to.toLowerCase() as CurrencyCode

    let inIQD = amount
    if (base === 'usd') inIQD = amount * rates.usd_iqd
    else if (base === 'eur') inIQD = amount * rates.eur_iqd
    else if (base === 'try') inIQD = amount * rates.try_iqd

    if (target === 'usd') return inIQD / rates.usd_iqd
    if (target === 'eur') return inIQD / rates.eur_iqd
    if (target === 'try') return inIQD / rates.try_iqd
    return inIQD
}

export function calculateNetProfitForMonth(
    sales: Sale[],
    month: MonthKey,
    baseCurrency: CurrencyCode,
    rates: { usd_iqd: number; eur_iqd: number; try_iqd: number }
): number {
    const convertToBase = (amount: number | undefined | null, from: string | undefined | null) =>
        convertToStoreBase(amount, from, baseCurrency, rates)

    let totalRevenue = 0
    let totalCost = 0

    sales.forEach(sale => {
        if (sale.is_returned) return
        if (monthKeyFromDate(sale.created_at) !== month) return

        const currency = sale.settlement_currency || baseCurrency
        let saleRevenueInCurrency = 0
        let saleCostInCurrency = 0

        sale.items?.forEach(item => {
            const netQuantity = item.quantity - (item.returned_quantity || 0)
            if (netQuantity <= 0) return

            saleRevenueInCurrency += (item.converted_unit_price || 0) * netQuantity
            saleCostInCurrency += (item.converted_cost_price || 0) * netQuantity
        })

        totalRevenue += convertToBase(saleRevenueInCurrency, currency)
        totalCost += convertToBase(saleCostInCurrency, currency)
    })

    return totalRevenue - totalCost
}

export interface PayrollItem {
    employee: Employee
    amount: number
    currency: CurrencyCode
    dueDate: string
    status: BudgetStatus
    snoozedUntil?: string | null
    snoozedIndefinite?: boolean
    snoozeCount?: number
    paidAt?: string | null
    isLocked?: boolean
}

export interface DividendItem {
    employee: Employee
    amount: number
    currency: CurrencyCode
    dueDate: string
    status: BudgetStatus
    snoozedUntil?: string | null
    snoozedIndefinite?: boolean
    snoozeCount?: number
    paidAt?: string | null
    isLocked?: boolean
    type: 'fixed' | 'percentage'
    baseAmount: number
}

export function buildPayrollItems(
    employees: Employee[],
    statuses: PayrollStatus[],
    month: MonthKey
): PayrollItem[] {
    return employees
        .filter(emp => !emp.isFired)
        .map(employee => {
            const status = statuses.find(entry => entry.employeeId === employee.id && entry.month === month)
            const dueDate = buildDueDate(month, employee.salaryPayday || 30)
            return {
                employee,
                amount: employee.salary || 0,
                currency: (employee.salaryCurrency || 'usd') as CurrencyCode,
                dueDate,
                status: (status?.status || 'pending') as BudgetStatus,
                snoozedUntil: status?.snoozedUntil ?? null,
                snoozedIndefinite: status?.snoozedIndefinite ?? false,
                snoozeCount: status?.snoozeCount ?? 0,
                paidAt: status?.paidAt ?? null,
                isLocked: status?.isLocked ?? false
            }
        })
}

export function buildDividendItems(
    employees: Employee[],
    statuses: DividendStatus[],
    month: MonthKey,
    baseCurrency: CurrencyCode,
    rates: { usd_iqd: number; eur_iqd: number; try_iqd: number },
    surplusPoolBase: number
): { items: DividendItem[]; totalBase: number } {
    const eligible = employees.filter(emp => emp.hasDividends && !emp.isFired)

    const fixed = eligible.filter(emp => emp.dividendType === 'fixed')
    const percentage = eligible.filter(emp => emp.dividendType === 'percentage')

    let remainingPool = surplusPoolBase
    const items: DividendItem[] = []
    let totalBase = 0

    fixed.forEach(emp => {
        const amount = emp.dividendAmount || 0
        const currency = (emp.dividendCurrency || baseCurrency) as CurrencyCode
        const baseAmount = convertToStoreBase(amount, currency, baseCurrency, rates)
        remainingPool -= baseAmount
        totalBase += baseAmount
        const status = statuses.find(entry => entry.employeeId === emp.id && entry.month === month)
        items.push({
            employee: emp,
            amount,
            currency,
            dueDate: buildDueDate(month, emp.dividendPayday || 30),
            status: (status?.status || 'pending') as BudgetStatus,
            snoozedUntil: status?.snoozedUntil ?? null,
            snoozedIndefinite: status?.snoozedIndefinite ?? false,
            snoozeCount: status?.snoozeCount ?? 0,
            paidAt: status?.paidAt ?? null,
            isLocked: status?.isLocked ?? false,
            type: 'fixed',
            baseAmount
        })
    })

    const distributablePool = remainingPool > 0 ? remainingPool : 0

    percentage.forEach(emp => {
        const percent = emp.dividendAmount || 0
        const payoutBase = percent > 0 ? (distributablePool * percent) / 100 : 0
        const currency = (emp.dividendCurrency || baseCurrency) as CurrencyCode
        const payoutInCurrency = convertFromStoreBase(payoutBase, currency, baseCurrency, rates)
        totalBase += payoutBase
        const status = statuses.find(entry => entry.employeeId === emp.id && entry.month === month)
        items.push({
            employee: emp,
            amount: payoutInCurrency,
            currency,
            dueDate: buildDueDate(month, emp.dividendPayday || 30),
            status: (status?.status || 'pending') as BudgetStatus,
            snoozedUntil: status?.snoozedUntil ?? null,
            snoozedIndefinite: status?.snoozedIndefinite ?? false,
            snoozeCount: status?.snoozeCount ?? 0,
            paidAt: status?.paidAt ?? null,
            isLocked: status?.isLocked ?? false,
            type: 'percentage',
            baseAmount: payoutBase
        })
    })

    return { items, totalBase }
}
