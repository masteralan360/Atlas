import type { BudgetStatus, CurrencyCode } from '@/local-db/models'

export type BudgetReminderType = 'expense' | 'payroll' | 'dividend'

export interface BudgetReminderItem {
    id: string
    type: BudgetReminderType
    month: string
    title: string
    subtitle?: string
    dueDate: string
    amount: number
    currency: CurrencyCode
    status: BudgetStatus
    snoozedUntil?: string | null
    snoozedIndefinite?: boolean
    snoozeCount?: number
    paidAt?: string | null
    isLocked?: boolean
    sourceId: string
    seriesId?: string
    employeeId?: string
}
