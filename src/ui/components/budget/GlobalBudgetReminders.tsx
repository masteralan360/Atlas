import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useToast } from '@/ui/components'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { db } from '@/local-db/database'
import {
    fetchTableFromSupabase,
    recordObligationSettlement,
    useEmployees,
    usePayrollStatuses,
    useDividendStatuses,
    useSales,
    toUISale,
    updateExpenseItem,
    upsertPayrollStatus,
    upsertDividendStatus
} from '@/local-db'
import type { CurrencyCode, ExpenseItem, PaymentObligation, WorkspacePaymentMethod } from '@/local-db/models'
import { convertToStoreBase } from '@/lib/currency'
import {
    buildConversionRates,
    calculateNetProfitForMonth,
    buildPayrollItems,
    buildDividendItems,
    monthKeyFromDate
} from '@/lib/budget'
import type { BudgetReminderItem } from './types'
import { BudgetReminderModal } from './BudgetReminderModal'
import { BudgetSnoozeModal, type BudgetSnoozeOption } from './BudgetSnoozeModal'
import { BudgetLockPromptModal } from './BudgetLockPromptModal'
import { useUnifiedSnooze, type SnoozedItem } from '@/context/UnifiedSnoozeContext'
import { SettlementDialog } from '@/ui/components'

function isCurrentlySnoozed(item: BudgetReminderItem, now: Date) {
    if (item.status !== 'snoozed') return false
    if (item.snoozedIndefinite) return true
    if (!item.snoozedUntil) return false
    return new Date(item.snoozedUntil).getTime() > now.getTime()
}

function isDue(item: { dueDate: string }, todayKey: string) {
    return item.dueDate <= todayKey
}

function buildExpenseReminderObligation(workspaceId: string, item: BudgetReminderItem): PaymentObligation {
    return {
        id: `expense-item:${item.sourceId}`,
        workspaceId,
        sourceModule: 'budget',
        sourceType: 'expense_item',
        sourceRecordId: item.sourceId,
        sourceSubrecordId: item.seriesId || null,
        direction: 'outgoing',
        amount: item.amount,
        currency: item.currency,
        dueDate: item.dueDate,
        counterpartyName: null,
        referenceLabel: item.title,
        title: item.title,
        subtitle: item.subtitle,
        status: 'open',
        routePath: '/budget',
        metadata: {
            month: item.month,
            seriesId: item.seriesId || null
        }
    }
}

function buildPayrollReminderObligation(
    workspaceId: string,
    item: BudgetReminderItem,
    existingStatusId?: string | null
): PaymentObligation {
    return {
        id: `payroll-status:${item.employeeId}:${item.month}`,
        workspaceId,
        sourceModule: 'budget',
        sourceType: 'payroll_status',
        sourceRecordId: existingStatusId || `${item.employeeId}:${item.month}`,
        sourceSubrecordId: item.employeeId || null,
        direction: 'outgoing',
        amount: item.amount,
        currency: item.currency,
        dueDate: item.dueDate,
        counterpartyName: item.title,
        referenceLabel: `Payroll ${item.month}`,
        title: item.title,
        subtitle: item.subtitle,
        status: 'open',
        routePath: '/budget',
        metadata: {
            employeeId: item.employeeId,
            month: item.month
        }
    }
}

export function GlobalBudgetReminders() {
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { t } = useTranslation()
    const { toast } = useToast()
    const isOnline = useNetworkStatus()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()

    const workspaceId = user?.workspaceId
    const isAdmin = user?.role === 'admin'
    const baseCurrency = (features.default_currency || 'usd') as CurrencyCode

    const employees = useEmployees(workspaceId)
    const payrollStatuses = usePayrollStatuses(workspaceId)
    const dividendStatuses = useDividendStatuses(workspaceId)
    const rawSales = useSales(workspaceId)
    const sales = useMemo(() => rawSales.map(toUISale), [rawSales])

    const expenseSeries = useLiveQuery(
        () => workspaceId
            ? db.expense_series.where('workspaceId').equals(workspaceId).and(s => !s.isDeleted).toArray()
            : [],
        [workspaceId]
    ) ?? []

    const expenseItems = useLiveQuery(
        () => workspaceId
            ? db.expense_items.where('workspaceId').equals(workspaceId).and(i => !i.isDeleted).toArray()
            : [],
        [workspaceId]
    ) ?? []

    const [sessionHandledIds, setSessionHandledIds] = useState<string[]>([])
    const [currentReminderId, setCurrentReminderId] = useState<string | null>(null)
    const [isReminderActionLoading, setIsReminderActionLoading] = useState(false)
    const [snoozeTarget, setSnoozeTarget] = useState<BudgetReminderItem | null>(null)
    const [lockTarget, setLockTarget] = useState<BudgetReminderItem | null>(null)
    const [settlementTarget, setSettlementTarget] = useState<PaymentObligation | null>(null)
    const [settlementSourceItem, setSettlementSourceItem] = useState<BudgetReminderItem | null>(null)
    const [isSubmittingSettlement, setIsSubmittingSettlement] = useState(false)
    const [isHydrating, setIsHydrating] = useState(true)

    const rates = useMemo(() => buildConversionRates(exchangeData, eurRates, tryRates), [exchangeData, eurRates, tryRates])

    useEffect(() => {
        if (!isOnline || !workspaceId || !isAdmin) {
            setIsHydrating(false)
            return
        }

        let cancelled = false

        const hydrate = async () => {
            try {
                await Promise.all([
                    fetchTableFromSupabase('expense_series', db.expense_series, workspaceId),
                    fetchTableFromSupabase('expense_items', db.expense_items, workspaceId, { includeDeleted: true }),
                    fetchTableFromSupabase('payroll_statuses', db.payroll_statuses, workspaceId),
                    fetchTableFromSupabase('dividend_statuses', db.dividend_statuses, workspaceId),
                    fetchTableFromSupabase('employees', db.employees, workspaceId)
                ])
            } catch (error) {
                if (!cancelled) {
                    console.error('[GlobalBudgetReminders] Failed to hydrate reminder data:', error)
                }
            } finally {
                if (!cancelled) {
                    setIsHydrating(false)
                }
            }
        }

        void hydrate()
        window.addEventListener('focus', hydrate)

        return () => {
            cancelled = true
            window.removeEventListener('focus', hydrate)
        }
    }, [isOnline, isAdmin, workspaceId])

    const reminderItems = useMemo<BudgetReminderItem[]>(() => {
        if (!workspaceId) return []

        const now = new Date()
        const todayKey = now.toISOString().slice(0, 10)

        const seriesById = new Map(expenseSeries.map(series => [series.id, series] as const))

        const monthSet = new Set<string>()
        monthSet.add(monthKeyFromDate(now))
        expenseItems.forEach(item => monthSet.add(item.month))
        payrollStatuses.forEach(status => monthSet.add(status.month))
        dividendStatuses.forEach(status => monthSet.add(status.month))

        const operationalTotalsByMonth = new Map<string, number>()
        expenseItems.forEach(item => {
            const amountBase = convertToStoreBase(item.amount, item.currency, baseCurrency, rates)
            operationalTotalsByMonth.set(item.month, (operationalTotalsByMonth.get(item.month) || 0) + amountBase)
        })

        const payrollItemsByMonth = new Map<string, ReturnType<typeof buildPayrollItems>>()
        const payrollTotalsByMonth = new Map<string, number>()

        Array.from(monthSet).forEach(month => {
            const payrollItems = buildPayrollItems(employees, payrollStatuses, month as any)
            payrollItemsByMonth.set(month, payrollItems)
            const totalBase = payrollItems.reduce((sum, item) => (
                sum + convertToStoreBase(item.amount, item.currency, baseCurrency, rates)
            ), 0)
            payrollTotalsByMonth.set(month, totalBase)
        })

        const result: BudgetReminderItem[] = []

        expenseItems.forEach(item => {
            if (item.status === 'paid') return
            if (!isDue(item, todayKey)) return

            const series = seriesById.get(item.seriesId)
            const title = series?.name || t('budget.reminder.category.expense') || 'Expense'
            const subtitle = series?.subcategory || series?.category || undefined

            result.push({
                id: `expense-${item.id}`,
                type: 'expense',
                month: item.month,
                title,
                subtitle,
                dueDate: item.dueDate,
                amount: item.amount,
                currency: item.currency,
                status: item.status,
                snoozedUntil: item.snoozedUntil ?? null,
                snoozedIndefinite: item.snoozedIndefinite ?? false,
                snoozeCount: item.snoozeCount ?? 0,
                paidAt: item.paidAt ?? null,
                isLocked: item.isLocked ?? false,
                sourceId: item.id,
                seriesId: item.seriesId
            })
        })

        Array.from(monthSet).forEach(month => {
            const payrollItems = payrollItemsByMonth.get(month) || []
            payrollItems.forEach(item => {
                if (item.amount <= 0) return
                if (item.status === 'paid') return
                if (!isDue(item, todayKey)) return

                result.push({
                    id: `payroll-${item.employee.id}-${month}`,
                    type: 'payroll',
                    month,
                    title: item.employee.name,
                    subtitle: item.employee.role,
                    dueDate: item.dueDate,
                    amount: item.amount,
                    currency: item.currency,
                    status: item.status,
                    snoozedUntil: item.snoozedUntil ?? null,
                    snoozedIndefinite: item.snoozedIndefinite ?? false,
                    snoozeCount: item.snoozeCount ?? 0,
                    paidAt: item.paidAt ?? null,
                    isLocked: item.isLocked ?? false,
                    sourceId: item.employee.id,
                    employeeId: item.employee.id
                })
            })

            const netProfitBase = calculateNetProfitForMonth(sales, month as any, baseCurrency, rates)
            const operationalBase = operationalTotalsByMonth.get(month) || 0
            const payrollBase = payrollTotalsByMonth.get(month) || 0
            const surplusPool = netProfitBase - operationalBase - payrollBase

            const dividendResult = buildDividendItems(
                employees,
                dividendStatuses,
                month as any,
                baseCurrency,
                rates,
                surplusPool
            )

            dividendResult.items.forEach(item => {
                if (item.baseAmount <= 0) return
                if (item.status === 'paid') return
                if (!isDue(item, todayKey)) return

                result.push({
                    id: `dividend-${item.employee.id}-${month}`,
                    type: 'dividend',
                    month,
                    title: item.employee.name,
                    subtitle: item.employee.role,
                    dueDate: item.dueDate,
                    amount: item.amount,
                    currency: item.currency,
                    status: item.status,
                    snoozedUntil: item.snoozedUntil ?? null,
                    snoozedIndefinite: item.snoozedIndefinite ?? false,
                    snoozeCount: item.snoozeCount ?? 0,
                    paidAt: item.paidAt ?? null,
                    isLocked: item.isLocked ?? false,
                    sourceId: item.employee.id,
                    employeeId: item.employee.id
                })
            })
        })

        return result
    }, [workspaceId, expenseItems, expenseSeries, employees, payrollStatuses, dividendStatuses, sales, baseCurrency, rates, t])

    const handledSet = useMemo(() => new Set(sessionHandledIds), [sessionHandledIds])
    const now = new Date()

    useEffect(() => {
        const resetExpiredSnoozes = async () => {
            const currentTime = new Date()
            const expired = reminderItems.filter(item => {
                if (item.status !== 'snoozed') return false
                if (item.snoozedIndefinite) return false
                if (!item.snoozedUntil) return false
                return new Date(item.snoozedUntil).getTime() <= currentTime.getTime()
            })

            for (const item of expired) {
                try {
                    await applyStatusUpdate(item, {
                        status: 'pending',
                        snoozedUntil: null,
                        snoozedIndefinite: false
                    })
                } catch (error) {
                    console.error('[GlobalBudgetReminders] Failed to reset expired snooze:', error)
                }
            }
        }

        void resetExpiredSnoozes()
        const interval = setInterval(() => { void resetExpiredSnoozes() }, 30_000)
        return () => clearInterval(interval)
    }, [reminderItems])

    const snoozedReminderItems = useMemo(
        () => reminderItems.filter(item => isCurrentlySnoozed(item, now)),
        [reminderItems, now]
    )

    const activeReminderItems = useMemo(
        () => reminderItems.filter(item => !isCurrentlySnoozed(item, now) && !handledSet.has(item.id)),
        [reminderItems, now, handledSet]
    )

    const currentReminder = useMemo(
        () => currentReminderId
            ? activeReminderItems.find(item => item.id === currentReminderId) ?? null
            : null,
        [activeReminderItems, currentReminderId]
    )

    const currentReminderIndex = currentReminder
        ? activeReminderItems.findIndex(item => item.id === currentReminder.id)
        : -1

    useEffect(() => {
        const validIds = new Set(reminderItems.map(item => item.id))
        setSessionHandledIds(prev => {
            const next = prev.filter(id => validIds.has(id))
            return next.length === prev.length ? prev : next
        })

        if (currentReminderId && !validIds.has(currentReminderId)) {
            setCurrentReminderId(null)
        }
    }, [currentReminderId, reminderItems])

    useEffect(() => {
        if (
            !isAdmin
            || isHydrating
            || isReminderActionLoading
            || settlementTarget
            || snoozeTarget
            || lockTarget
            || isSubmittingSettlement
        ) return

        if (activeReminderItems.length === 0) {
            if (currentReminderId) setCurrentReminderId(null)
            return
        }

        const stillValid = currentReminderId
            ? activeReminderItems.some(item => item.id === currentReminderId)
            : false

        if (!stillValid) {
            setCurrentReminderId(activeReminderItems[0].id)
        }
    }, [
        activeReminderItems,
        currentReminderId,
        isAdmin,
        isHydrating,
        isReminderActionLoading,
        settlementTarget,
        snoozeTarget,
        lockTarget,
        isSubmittingSettlement
    ])

    const markReminderHandledForSession = (id: string) => {
        setSessionHandledIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    }

    const applyStatusUpdate = async (item: BudgetReminderItem, data: Partial<ExpenseItem>) => {
        if (!workspaceId) return

        if (item.type === 'expense') {
            await updateExpenseItem(item.sourceId, data)
            return
        }

        if (!item.employeeId) return

        if (item.type === 'payroll') {
            await upsertPayrollStatus(workspaceId, item.employeeId, item.month, data as any)
        } else if (item.type === 'dividend') {
            await upsertDividendStatus(workspaceId, item.employeeId, item.month, data as any)
        }
    }

    const handleReminderSnooze = async (item: BudgetReminderItem, option: BudgetSnoozeOption) => {
        setIsReminderActionLoading(true)
        const now = new Date()
        const snoozedUntil = option.indefinite
            ? null
            : new Date(now.getTime() + (option.minutes || 0) * 60 * 1000).toISOString()

        try {
            await applyStatusUpdate(item, {
                status: 'snoozed',
                snoozedUntil,
                snoozedIndefinite: option.indefinite ?? false,
                snoozeCount: (item.snoozeCount || 0) + 1,
                paidAt: null
            })
            setCurrentReminderId(null)
            markReminderHandledForSession(item.id)
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.reminder.snoozed') || 'Reminder snoozed.'
            })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || (t('budget.reminder.snoozeFailed') || 'Failed to snooze reminder.'),
                variant: 'destructive'
            })
        } finally {
            setIsReminderActionLoading(false)
        }
    }

    const handleReminderUnsnooze = async (item: BudgetReminderItem) => {
        setIsReminderActionLoading(true)
        try {
            await applyStatusUpdate(item, {
                status: 'pending',
                snoozedUntil: null,
                snoozedIndefinite: false
            })
            setCurrentReminderId(null)
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.reminder.unsnoozed') || 'Reminder un-snoozed.'
            })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || (t('budget.reminder.unsnoozeFailed') || 'Failed to un-snooze reminder.'),
                variant: 'destructive'
            })
        } finally {
            setIsReminderActionLoading(false)
        }
    }

    const handleMarkPaid = async (item: BudgetReminderItem) => {
        if (!workspaceId) {
            return
        }

        if (item.type === 'expense') {
            setCurrentReminderId(null)
            setSettlementSourceItem(item)
            setSettlementTarget(buildExpenseReminderObligation(workspaceId, item))
            return
        }

        if (item.type === 'payroll') {
            const existingStatus = payrollStatuses.find(
                (entry) => entry.employeeId === item.employeeId && entry.month === item.month && !entry.isDeleted
            )
            setCurrentReminderId(null)
            setSettlementSourceItem(item)
            setSettlementTarget(buildPayrollReminderObligation(workspaceId, item, existingStatus?.id))
            return
        }

        setIsReminderActionLoading(true)
        try {
            const paidAt = new Date().toISOString()
            await applyStatusUpdate(item, {
                status: 'paid',
                paidAt,
                snoozedUntil: null,
                snoozedIndefinite: false
            })
            setCurrentReminderId(null)
            markReminderHandledForSession(item.id)
            setLockTarget(item)
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.reminder.paid') || 'Marked as paid.'
            })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || (t('budget.reminder.payFailed') || 'Failed to update payment.'),
                variant: 'destructive'
            })
        } finally {
            setIsReminderActionLoading(false)
        }
    }

    const handleReminderSettlement = async (input: { paymentMethod: WorkspacePaymentMethod; paidAt: string; note?: string }) => {
        if (!workspaceId || !settlementTarget) {
            return
        }

        setIsSubmittingSettlement(true)
        try {
            await recordObligationSettlement(workspaceId, settlementTarget, {
                paymentMethod: input.paymentMethod,
                paidAt: input.paidAt,
                note: input.note,
                createdBy: user?.id || null
            })

            if (settlementSourceItem) {
                markReminderHandledForSession(settlementSourceItem.id)
                setLockTarget(settlementSourceItem)
            }

            toast({
                title: t('common.success') || 'Success',
                description: settlementTarget.sourceType === 'payroll_status'
                    ? 'Payroll payment recorded.'
                    : 'Expense payment recorded.'
            })
            setSettlementTarget(null)
            setSettlementSourceItem(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to record settlement.',
                variant: 'destructive'
            })
        } finally {
            setIsSubmittingSettlement(false)
        }
    }

    const handleLockConfirm = async () => {
        if (!lockTarget) return
        setIsReminderActionLoading(true)
        try {
            await applyStatusUpdate(lockTarget, { isLocked: true })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || (t('budget.reminder.lockFailed') || 'Failed to lock payment.'),
                variant: 'destructive'
            })
        } finally {
            setIsReminderActionLoading(false)
            setLockTarget(null)
        }
    }

    if (!workspaceId || !isAdmin) {
        return null
    }

    const { registerItems, unregisterItems } = useUnifiedSnooze()

    const unifiedSnoozedItems = useMemo<SnoozedItem[]>(() => {
        return snoozedReminderItems.map(item => ({
            id: item.id,
            type: 'budget',
            title: item.title,
            subtitle: item.subtitle || item.month,
            amount: item.amount,
            currency: item.currency,
            priority: item.month === monthKeyFromDate(new Date()) ? 'warning' : 'info',
            onAction: () => {
                void handleMarkPaid(item)
            },
            onUnsnooze: () => {
                void handleReminderUnsnooze(item)
            }
        }))
    }, [snoozedReminderItems, handleReminderUnsnooze, handleMarkPaid])

    useEffect(() => {
        if (unifiedSnoozedItems.length > 0) {
            registerItems('budget', unifiedSnoozedItems)
        } else {
            unregisterItems('budget')
        }
    }, [unifiedSnoozedItems, registerItems, unregisterItems])

    return (
        <>

            <BudgetReminderModal
                isOpen={!!currentReminder}
                item={currentReminder}
                queuePosition={currentReminderIndex >= 0 ? currentReminderIndex + 1 : 1}
                queueTotal={activeReminderItems.length}
                iqdPreference={features.iqd_display_preference}
                onPaid={() => {
                    if (!currentReminder) return
                    void handleMarkPaid(currentReminder)
                }}
                onRemindTomorrow={() => {
                    if (!currentReminder) return
                    void handleReminderSnooze(currentReminder, { id: 'tomorrow', label: 'Tomorrow', minutes: 24 * 60 })
                }}
                onSnooze={() => {
                    if (!currentReminder) return
                    setCurrentReminderId(null)
                    setSnoozeTarget(currentReminder)
                }}
                onOpenChange={(open) => {
                    if (!open && currentReminder) {
                        markReminderHandledForSession(currentReminder.id)
                        setCurrentReminderId(null)
                    }
                }}
            />

            <SettlementDialog
                open={!!settlementTarget}
                obligation={settlementTarget}
                isSubmitting={isSubmittingSettlement}
                onSubmit={handleReminderSettlement}
                onOpenChange={(open) => {
                    if (!open) {
                        setSettlementTarget(null)
                        setSettlementSourceItem(null)
                    }
                }}
            />

            <BudgetSnoozeModal
                open={!!snoozeTarget}
                onOpenChange={(open) => {
                    if (!open) setSnoozeTarget(null)
                }}
                onSelect={(option) => {
                    if (!snoozeTarget) return
                    void handleReminderSnooze(snoozeTarget, option)
                    setSnoozeTarget(null)
                }}
            />

            <BudgetLockPromptModal
                open={!!lockTarget}
                onConfirm={() => { void handleLockConfirm() }}
                onSkip={() => setLockTarget(null)}
            />
        </>
    )
}
