import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useReactToPrint } from 'react-to-print'

import { useTranslation } from 'react-i18next'
import {
    Calendar,
    Plus,
    CheckCircle2,
    Clock,
    ChevronLeft,
    ChevronRight,
    Trash2,
    TrendingUp,
    BarChart3,
    ArrowRight,
    User,
    AlertTriangle,
    Repeat,
    Circle,
    Lock,
    BellOff,
    RotateCcw,
    Printer
} from 'lucide-react'
import { useWorkspace } from '@/workspace'
import { useExpenses, createExpense, deleteExpense, updateExpense, useBudgetAllocationState, useBudgetAllocations, useMonthlyRevenueState, setBudgetAllocation, useEmployees, useWorkspaceUsers, fetchTableFromSupabase } from '@/local-db'
import { db } from '@/local-db/database'
import { connectionManager } from '@/lib/connectionManager'
import { platformService } from '@/services/platformService'
import { Button } from '@/ui/components/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { Input } from '@/ui/components/input'
import { CurrencyCode } from '@/local-db'
import { formatCurrency, formatDate, formatNumberWithCommas, parseFormattedNumber, cn } from '@/lib/utils'
import { convertToStoreBase as convertToStoreBaseUtil } from '@/lib/currency'
import { buildDividendReminderMetaMap } from '@/lib/dividendReminderMeta'
// sonner removed
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    useToast
} from '@/ui/components'
import type { DividendRecipient } from '@/ui/components/budget/DividendDistributionPanel'
import { Label } from '@/ui/components/label'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/ui/components/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/components/tabs'

import { useExchangeRate } from '@/context/ExchangeRateContext'
import { scanDueItems, getSnoozedItems, getReminderConfig, getVirtualSnooze, setVirtualSnooze, getVirtualPaid, setVirtualPaid, type BudgetReminderItem, INDEFINITE_SNOOZE_DATE, isIndefiniteSnooze, isSnoozeActive } from '@/lib/budgetReminders'
import { BudgetReminderModal } from '@/ui/components/budget/BudgetReminderModal'
import { BudgetLockModal } from '@/ui/components/budget/BudgetLockModal'
import { BudgetSnoozeModal } from '@/ui/components/budget/BudgetSnoozeModal'
import { SnoozedBudgetItemsBell } from '@/ui/components/budget/SnoozedBudgetItemsBell'
import { BudgetPrintTemplate } from '@/ui/components/budget/BudgetPrintTemplate'
import { DividendDistributionPanel } from '@/ui/components/budget/DividendDistributionPanel'

const normalizeExpenseField = (value?: string | null) => (value || '').trim().toLowerCase()

const PRESET_SUBCATEGORIES: Record<string, string[]> = {
    utility: ['Internet', 'Electricity', 'Water', 'Fuel', 'Gas', 'Phone', 'Maintenance'],
    marketing: ['Ads', 'Sponsorship', 'Events', 'Print', 'Social Media', 'Consulting'],
    payroll: ['Salary', 'Bonus', 'Commission', 'Allowance', 'Overtime'],
    rent: ['Office', 'Warehouse', 'Equipment', 'Vehicle', 'Server'],
    other: ['Office Supplies', 'Software', 'Hardware', 'Travel', 'Meals', 'Legal', 'Insurance', 'Taxes', 'Miscellaneous']
}

const isRecurringOccurrenceMatch = (
    recurringTemplate: any,
    expenseRecord: any,
    monthStart: Date,
    monthEnd: Date
): boolean => {
    if (!recurringTemplate || !expenseRecord || expenseRecord.type !== 'one-time') return false

    const expenseDueDate = new Date(expenseRecord.dueDate)
    if (isNaN(expenseDueDate.getTime()) || expenseDueDate < monthStart || expenseDueDate > monthEnd) return false

    if (expenseRecord.category !== recurringTemplate.category) return false
    if (normalizeExpenseField(expenseRecord.description) !== normalizeExpenseField(recurringTemplate.description)) return false
    if (normalizeExpenseField(expenseRecord.subcategory) !== normalizeExpenseField(recurringTemplate.subcategory)) return false

    const recurringDay = new Date(recurringTemplate.dueDate).getDate()
    if (isNaN(recurringDay)) return false

    const projectedDay = Math.min(
        recurringDay,
        new Date(expenseDueDate.getFullYear(), expenseDueDate.getMonth() + 1, 0).getDate()
    )

    return expenseDueDate.getDate() === projectedDay
}

type DividendWithdrawalStatus = 'paid' | 'snoozed' | 'overdue' | 'dueToday' | 'upcoming'

interface DividendWithdrawalRow {
    employeeId: string
    employeeName: string
    formula: string
    dueDate: Date
    amount: number
    currency: string
    status: DividendWithdrawalStatus
    snoozeUntil: string | null
    snoozeCount: number
    isAmountLoading: boolean
}

const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

const getReminderMonth = (dateLike: string | Date): string | null => {
    const date = new Date(dateLike)
    if (isNaN(date.getTime())) return null

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

const getDividendReminderId = (employeeId: string, dateLike: string | Date) => {
    const reminderMonth = getReminderMonth(dateLike)
    return reminderMonth ? `dividend-${employeeId}-${reminderMonth}` : `dividend-${employeeId}`
}

function LoadingValue({ className }: { className?: string }) {
    return <span className={cn("inline-block animate-pulse rounded-full bg-black/10 dark:bg-white/10 align-middle", className)} aria-hidden="true" />
}


export default function Budget() {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { activeWorkspace, features, workspaceName } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const workspaceId = activeWorkspace?.id
    const baseCurrency = (features.default_currency || 'usd') as any
    const iqdPreference = features.iqd_display_preference
    const expenses = useExpenses(workspaceId)
    const employees = useEmployees(workspaceId)
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [isAllocationDialogOpen, setIsAllocationDialogOpen] = useState(false)
    const [selectedMonth, setSelectedMonth] = useState(new Date())
    const [allocAmountDisplay, setAllocAmountDisplay] = useState<string>('')
    const [allocType, setAllocType] = useState<'fixed' | 'percentage'>('fixed')
    const [allocCurrency, setAllocCurrency] = useState<CurrencyCode>(baseCurrency as any || 'usd')
    const [activeBudgetTab, setActiveBudgetTab] = useState<'expenses' | 'dividends'>('expenses')
    const [selectedCategory, setSelectedCategory] = useState<string>('utility')
    const printRef = useRef<HTMLDivElement>(null)
    const dividendsPrintRef = useRef<HTMLDivElement>(null)
    const workspaceUsers = useWorkspaceUsers(workspaceId)
    const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const handlePrintBudget = useReactToPrint({
        contentRef: printRef,
        documentTitle: `Budget_${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, '0')}`
    })
    const handlePrintDividends = useReactToPrint({
        contentRef: dividendsPrintRef,
        documentTitle: `Dividends_${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, '0')}`
    })

    const [reminderQueue, setReminderQueue] = useState<BudgetReminderItem[]>([])
    const [snoozedItems, setSnoozedItems] = useState<BudgetReminderItem[]>([])
    const [reminderIndex, setReminderIndex] = useState(0)
    const [reminderStep, setReminderStep] = useState<'idle' | 'reminder' | 'lock' | 'snooze'>('idle')

    const [isProcessing, setIsProcessing] = useState(false)
    const [dividendPaidMap, setDividendPaidMap] = useState<Map<string, boolean>>(new Map())
    const [dividendSnoozeMap, setDividendSnoozeMap] = useState<Map<string, { until: string | null; count: number }>>(new Map())
    const isCheckingReminders = useRef(false)
    const reminderStepRef = useRef(reminderStep)

    useEffect(() => {
        reminderStepRef.current = reminderStep
    }, [reminderStep])

    const monthStr = useMemo(() => {
        const year = selectedMonth.getFullYear()
        const month = String(selectedMonth.getMonth() + 1).padStart(2, '0')
        return `${year}-${month}`
    }, [selectedMonth])

    const currentAllocationState = useBudgetAllocationState(workspaceId, monthStr)
    const currentAllocation = currentAllocationState.data
    const allAllocations = useBudgetAllocations(workspaceId)
    const monthlyFinancialsState = useMonthlyRevenueState(workspaceId, monthStr)
    const monthlyFinancials = monthlyFinancialsState.data
    const isAllocationLoading = currentAllocationState.isLoading
    const isMonthlyFinancialsLoading = monthlyFinancialsState.isLoading
    const isBudgetLimitLoading = isAllocationLoading || (currentAllocation?.type === 'percentage' && isMonthlyFinancialsLoading)

    const startPointMonth = useMemo(() => {
        const sp = allAllocations.find(a => a.startPoint === true)
        return sp?.month ?? null // e.g. "2026-02"
    }, [allAllocations])

    const isAtStartPoint = useMemo(() => {
        if (!startPointMonth) return false
        return monthStr <= startPointMonth
    }, [monthStr, startPointMonth])

    useEffect(() => {
        const unsubscribe = connectionManager.subscribe((event) => {
            if (event === 'wake' && workspaceId) {
                fetchTableFromSupabase('expenses', db.expenses, workspaceId)
                fetchTableFromSupabase('employees', db.employees, workspaceId)
                fetchTableFromSupabase('budget_allocations', db.budgetAllocations, workspaceId)
            }
        })
        return unsubscribe
    }, [workspaceId])

    // Init allocation modal states
    useEffect(() => {
        if (isAllocationDialogOpen && !isAllocationLoading) {
            setAllocType(currentAllocation?.type || 'fixed')
            setAllocAmountDisplay(currentAllocation ? formatNumberWithCommas(currentAllocation.amount || 0) : '')
            setAllocCurrency(currentAllocation?.currency || baseCurrency as any || 'usd')
        } else if (isDialogOpen === false) {
            // setExpenseAmountDisplay('') // This line was commented out in the original, keeping it commented.
        }
    }, [isAllocationDialogOpen, isDialogOpen, currentAllocation, baseCurrency, isAllocationLoading])

    const convertToStoreBase = useCallback((amount: number | undefined | null, from: string | undefined | null) => {
        return convertToStoreBaseUtil(amount, from, baseCurrency, {
            usd_iqd: (exchangeData?.rate || 145000) / 100,
            eur_iqd: (eurRates.eur_iqd?.rate || 160000) / 100,
            try_iqd: (tryRates.try_iqd?.rate || 4500) / 100
        })
    }, [baseCurrency, exchangeData, eurRates, tryRates])

    const handlePrevMonth = () => {
        if (isAtStartPoint) return // Cannot go before start_point
        setSelectedMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
    }
    const handleNextMonth = () => setSelectedMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))

    useEffect(() => {
        // Only trigger if start_point exists (user has set at least one allocation)
        // and the current month has no allocation yet
        if (!isAllocationLoading && startPointMonth && !currentAllocation && monthStr > startPointMonth) {
            setIsAllocationDialogOpen(true)
        }
    }, [monthStr, startPointMonth, currentAllocation, isAllocationLoading])

    const [expenseAmountDisplay, setExpenseAmountDisplay] = useState<string>('')
    const [lockConfirmExpense, setLockConfirmExpense] = useState<any>(null)
    const [unsnoozeItem, setUnsnoozeItem] = useState<BudgetReminderItem | null>(null)
    const [dividendSnoozeItem, setDividendSnoozeItem] = useState<BudgetReminderItem | null>(null)

    const loadVirtualReminderMaps = useCallback(async () => {
        const virtualSnoozeMap = new Map<string, { until: string | null; count: number }>()
        const virtualPaidMap = new Map<string, boolean>()

        for (const emp of employees) {
            if (emp.salary && emp.salary > 0) {
                const vs = await getVirtualSnooze('salary', emp.id, monthStr)
                if (vs.until || vs.count > 0) virtualSnoozeMap.set(`salary_${emp.id}`, vs)
            }
            if (emp.hasDividends && emp.dividendAmount && emp.dividendAmount > 0) {
                const vd = await getVirtualSnooze('dividend', emp.id, monthStr)
                if (vd.until || vd.count > 0) virtualSnoozeMap.set(`dividend_${emp.id}`, vd)
                const paid = await getVirtualPaid('dividend', emp.id, monthStr)
                if (paid) virtualPaidMap.set(`dividend_${emp.id}`, true)
            }
        }

        return { virtualSnoozeMap, virtualPaidMap }
    }, [employees, monthStr])

    const dividendReminderMetaMap = useMemo(() => buildDividendReminderMetaMap({
        expenses,
        employees,
        selectedDate: selectedMonth,
        monthlyFinancials,
        baseCurrency,
        iqdPreference,
        convertToStoreBase
    }), [expenses, employees, selectedMonth, monthlyFinancials, baseCurrency, iqdPreference, convertToStoreBase])

    const enrichReminderItem = useCallback((item: BudgetReminderItem): BudgetReminderItem => {
        if (item.category !== 'dividend' || !item.employeeId) return item
        if (isMonthlyFinancialsLoading) return item
        if (getReminderMonth(item.dueDate) !== monthStr) return item

        const meta = dividendReminderMetaMap.get(item.employeeId)
        if (!meta) return item

        return {
            ...item,
            amount: meta.amount,
            currency: meta.currency,
            displayAmount: meta.displayAmount,
            formula: meta.formula
        }
    }, [dividendReminderMetaMap, monthStr, isMonthlyFinancialsLoading])

    useEffect(() => {
        setReminderQueue(prev => prev.map(enrichReminderItem))
        setSnoozedItems(prev => prev.map(enrichReminderItem))
        setUnsnoozeItem(prev => prev ? enrichReminderItem(prev) : prev)
        setDividendSnoozeItem(prev => prev ? enrichReminderItem(prev) : prev)
    }, [enrichReminderItem])

    const upsertSnoozedItem = useCallback((item: BudgetReminderItem) => {
        setSnoozedItems(prev => {
            const next = prev.filter(existing => existing.id !== item.id)
            next.push(item)
            next.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
            return next
        })
    }, [])

    const removeSnoozedItem = useCallback((itemId: string) => {
        setSnoozedItems(prev => prev.filter(existing => existing.id !== itemId))
    }, [])

    const runScan = useCallback(async () => {
        if (!workspaceId || isCheckingReminders.current || reminderStepRef.current !== 'idle' || (expenses.length === 0 && employees.length === 0)) return
        isCheckingReminders.current = true
        try {

            const config = await getReminderConfig()

            const { virtualSnoozeMap, virtualPaidMap } = await loadVirtualReminderMaps()

            // Scan for due items
            const dueItems = scanDueItems(expenses, employees, monthStr, config, virtualSnoozeMap, virtualPaidMap)
                .map(enrichReminderItem)

            // Scan for snoozed items
            const snoozed = getSnoozedItems(expenses, employees, monthStr, virtualSnoozeMap)
                .map(enrichReminderItem)
            const dividendSnoozes = new Map([...virtualSnoozeMap].filter(([key]) => key.startsWith('dividend_')))
            const dividendPaid = new Map([...virtualPaidMap].filter(([key]) => key.startsWith('dividend_')))

            setReminderQueue(dueItems)
            setSnoozedItems(snoozed)
            setDividendSnoozeMap(dividendSnoozes)
            setDividendPaidMap(dividendPaid)
            setReminderIndex(0)
            if (dueItems.length > 0) {
                setReminderStep('reminder')
            } else {
                setReminderStep('idle')
            }

        } catch (err) {
            console.error('[Budget] Reminder scan failed:', err)
        } finally {
            isCheckingReminders.current = false
        }
    }, [expenses, employees, workspaceId, monthStr, loadVirtualReminderMaps, enrichReminderItem])

    useEffect(() => {
        if (!workspaceId) return
        // Allow scan if there are expenses OR employees (for virtual salary reminders)
        if (expenses.length === 0 && employees.length === 0) return

        runScan()
    }, [expenses, employees, workspaceId, monthStr, runScan])

    // Reset scan when month changes
    useEffect(() => {

        setReminderQueue([])
        setSnoozedItems([])
        setDividendSnoozeMap(new Map())
        setDividendPaidMap(new Map())
        setReminderIndex(0)
        setReminderStep('idle')
    }, [monthStr])

    // Keep snoozed items in sync with data changes (reactive)
    useEffect(() => {
        if (!workspaceId) return
        // Allow refresh if we have either expenses OR employees (for virtual reminders)
        if (expenses.length === 0 && employees.length === 0) {
            setSnoozedItems([]) // Clear if no data
            setDividendSnoozeMap(new Map())
            setDividendPaidMap(new Map())
            return
        }

        async function refreshSnoozed() {
            const { virtualSnoozeMap, virtualPaidMap } = await loadVirtualReminderMaps()
            const snoozed = getSnoozedItems(expenses, employees, monthStr, virtualSnoozeMap).map(enrichReminderItem)
            setSnoozedItems(snoozed)
            setDividendSnoozeMap(new Map([...virtualSnoozeMap].filter(([key]) => key.startsWith('dividend_'))))
            setDividendPaidMap(new Map([...virtualPaidMap].filter(([key]) => key.startsWith('dividend_'))))
        }
        refreshSnoozed()
    }, [expenses, employees, workspaceId, monthStr, loadVirtualReminderMaps, enrichReminderItem])

    const currentReminder = reminderQueue[reminderIndex] || null
    const updateDividendPaidState = useCallback((employeeId: string, paid: boolean) => {
        setDividendPaidMap(prev => {
            const next = new Map(prev)
            if (paid) next.set(`dividend_${employeeId}`, true)
            else next.delete(`dividend_${employeeId}`)
            return next
        })
    }, [])
    const updateDividendSnoozeState = useCallback((employeeId: string, until: string | null, count: number) => {
        setDividendSnoozeMap(prev => {
            const next = new Map(prev)
            if (until && count > 0) {
                next.set(`dividend_${employeeId}`, { until, count })
            } else {
                next.delete(`dividend_${employeeId}`)
            }
            return next
        })
    }, [])
    const getReminderSubcategory = useCallback((item: BudgetReminderItem): string | null => {
        const templateId = item.originalTemplateId || item.expenseId
        if (!templateId) return null

        const template = expenses.find(exp => exp.id === templateId)
        const subcategory = template?.subcategory?.trim()
        return subcategory ? subcategory : null
    }, [expenses])

    const advanceReminder = () => {
        const next = reminderIndex + 1
        if (next < reminderQueue.length) {
            setReminderIndex(next)
            setReminderStep('reminder')
        } else {
            setReminderStep('idle')
        }
    }

    const handleReminderPaid = async () => {
        if (!currentReminder || !workspaceId || isProcessing) return
        setIsProcessing(true)

        try {
            if (currentReminder.expenseId && !currentReminder.isRecurringTemplate) {
                // Update existing record (real expense or snoozed salary/dividend marker)
                await updateExpense(currentReminder.expenseId, {
                    status: 'paid',
                    paidAt: new Date().toISOString(),
                    snoozeUntil: null,
                    snoozeCount: 0
                })
            } else if (currentReminder.category === 'expense') {
                if (currentReminder.isRecurringTemplate) {
                    const newExp = await createExpense(workspaceId, {
                        description: currentReminder.title,
                        type: 'one-time',
                        category: currentReminder.expenseCategory as any || 'operational',
                        subcategory: getReminderSubcategory(currentReminder),
                        amount: currentReminder.amount,
                        currency: currentReminder.currency as any,
                        status: 'paid',
                        dueDate: currentReminder.dueDate,
                        paidAt: new Date().toISOString(),
                        snoozeUntil: null,
                        snoozeCount: 0
                    })
                    if (newExp) currentReminder.expenseId = newExp.id
                }
            } else if (currentReminder.category === 'salary' && currentReminder.employeeId) {
                await createExpense(workspaceId, {
                    description: `${currentReminder.employeeName} (${t('hr.salary', 'Salary')})`,
                    type: 'one-time',
                    category: 'payroll',
                    amount: currentReminder.amount,
                    currency: currentReminder.currency as any,
                    status: 'paid',
                    dueDate: currentReminder.dueDate,
                    paidAt: new Date().toISOString(),
                    snoozeUntil: null,
                    snoozeCount: 0,
                    employeeId: currentReminder.employeeId
                })
            } else if (currentReminder.category === 'dividend' && currentReminder.employeeId) {
                const dueMonth = getReminderMonth(currentReminder.dueDate) || monthStr
                await setVirtualPaid('dividend', currentReminder.employeeId, dueMonth, true)
                await setVirtualSnooze('dividend', currentReminder.employeeId, dueMonth, '', 0)
                if (dueMonth === monthStr) {
                    updateDividendPaidState(currentReminder.employeeId, true)
                    updateDividendSnoozeState(currentReminder.employeeId, null, 0)
                }
                removeSnoozedItem(currentReminder.id)
                toast({ description: t('budget.dividend.paidPersisted', 'Dividend payment status saved') })
                advanceReminder()
                return
            }
            // After marking paid, show lock modal
            toast({ description: t('budget.statusUpdated', 'Status updated') })
            setReminderStep('lock')
        } catch {
            toast({ variant: 'destructive', description: t('common.error', 'Failed to update') })
            advanceReminder()
        } finally {
            setIsProcessing(false)
        }
    }

    const handleReminderLock = async () => {
        if (!currentReminder || isProcessing) return
        setIsProcessing(true)

        try {
            if (currentReminder.expenseId) {
                await updateExpense(currentReminder.expenseId, { isLocked: true })
            } else if (currentReminder.category === 'salary' && currentReminder.employeeId) {
                // Find the just-created payroll expense to lock it
                const monthStart = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1)
                const monthEnd = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 0, 23, 59, 59)
                const payrollExp = expenses.find(e =>
                    e.type === 'one-time' &&
                    e.category === 'payroll' &&
                    e.employeeId === currentReminder.employeeId &&
                    new Date(e.dueDate) >= monthStart &&
                    new Date(e.dueDate) <= monthEnd
                )
                if (payrollExp) await updateExpense(payrollExp.id, { isLocked: true })
            }
            toast({ description: t('budget.expenseLocked', 'Payment locked') })
        } catch {
            toast({ variant: 'destructive', description: t('budget.errorLocking', 'Error locking') })
        } finally {
            advanceReminder()
            setIsProcessing(false)
        }
    }

    const handleReminderLockSkip = () => advanceReminder()

    const handleReminderSnoozeOpen = () => setReminderStep('snooze')

    const handleReminderSnooze = async (minutes: number) => {
        if (!currentReminder || isProcessing) return
        setIsProcessing(true)

        const snoozeUntil = minutes === -1
            ? INDEFINITE_SNOOZE_DATE
            : new Date(Date.now() + minutes * 60000).toISOString()
        const newCount = (currentReminder.snoozeCount || 0) + 1

        try {
            if (currentReminder.category === 'expense') {
                if (currentReminder.isRecurringTemplate && workspaceId) {
                    // Create materialized snooze record instead of updating template
                    await createExpense(workspaceId, {
                        description: currentReminder.title,
                        type: 'one-time',
                        category: currentReminder.expenseCategory as any || 'other',
                        subcategory: getReminderSubcategory(currentReminder),
                        amount: currentReminder.amount,
                        currency: currentReminder.currency as any,
                        status: 'snoozed',
                        dueDate: currentReminder.dueDate,
                        paidAt: null,
                        snoozeUntil,
                        snoozeCount: newCount
                    })
                } else if (currentReminder.expenseId) {
                    await updateExpense(currentReminder.expenseId, {
                        snoozeUntil,
                        snoozeCount: newCount,
                        status: 'snoozed'
                    })
                }
            } else if (currentReminder.category === 'salary' && currentReminder.employeeId) {
                if (currentReminder.expenseId) {
                    await updateExpense(currentReminder.expenseId, {
                        snoozeUntil,
                        snoozeCount: newCount,
                        status: 'snoozed'
                    })
                } else if (workspaceId) {
                    await createExpense(workspaceId, {
                        description: `${currentReminder.employeeName} (${t('hr.salary', 'Salary')})`,
                        type: 'one-time',
                        category: 'payroll',
                        amount: currentReminder.amount,
                        currency: currentReminder.currency as any,
                        status: 'snoozed',
                        dueDate: currentReminder.dueDate || new Date().toISOString(),
                        paidAt: null,
                        snoozeUntil,
                        snoozeCount: newCount,
                        employeeId: currentReminder.employeeId
                    })
                }
                await setVirtualSnooze(
                    currentReminder.category,
                    currentReminder.employeeId || currentReminder.id,
                    getReminderMonth(currentReminder.dueDate) || monthStr,
                    snoozeUntil,
                    newCount
                )
            } else if (currentReminder.category === 'dividend' && currentReminder.employeeId) {
                const dueMonth = getReminderMonth(currentReminder.dueDate) || monthStr
                await setVirtualSnooze('dividend', currentReminder.employeeId, dueMonth, snoozeUntil, newCount)
                if (dueMonth === monthStr) {
                    updateDividendSnoozeState(currentReminder.employeeId, snoozeUntil, newCount)
                    upsertSnoozedItem({
                        ...currentReminder,
                        snoozeUntil,
                        snoozeCount: newCount
                    })
                }
            }
        } catch {
            toast({ variant: 'destructive', description: t('common.error', 'Failed to update') })
        } finally {
            advanceReminder()
            setIsProcessing(false)
        }
    }


    const handleConfirmLock = async () => {
        if (!lockConfirmExpense) return

        try {
            await updateExpense(lockConfirmExpense.expenseRecordId, { isLocked: true })
            toast({ description: t('budget.expenseLocked', 'Salary locked for this month') })
        } catch (error) {
            toast({ variant: 'destructive', description: t('budget.errorLocking', 'Error locking salary') })
        } finally {
            setLockConfirmExpense(null)
        }
    }

    const handleUnsnooze = async (item: BudgetReminderItem) => {
        if (isProcessing) return
        setIsProcessing(true)
        try {
            if (item.expenseId) {
                // For real expense records (expenses or snoozed salary/dividend markers)
                await updateExpense(item.expenseId, { snoozeUntil: null, status: 'pending' })
            }

            if (item.employeeId) {
                // Clear any virtual snooze record as well (covers dividends and virtual salaries)
                await setVirtualSnooze(item.category, item.employeeId, getReminderMonth(item.dueDate) || monthStr, '', 0)
            }

            if (item.category === 'dividend' && item.employeeId) {
                if ((getReminderMonth(item.dueDate) || monthStr) === monthStr) {
                    updateDividendSnoozeState(item.employeeId, null, 0)
                }
                removeSnoozedItem(item.id)

                const restoredItem = {
                    ...enrichReminderItem(item),
                    snoozeUntil: null,
                    snoozeCount: 0
                }

                setReminderQueue(prev => [
                    restoredItem,
                    ...prev.filter(existing => existing.id !== restoredItem.id)
                ])
                setReminderIndex(0)
                setReminderStep('reminder')
            }

            toast({ description: t('budget.unsnoozed', 'Reminder un-snoozed') })

            // Reactive Refresh: Reset scanned state to trigger the main useEffect.

        } catch (error) {
            console.error('[Budget] Failed to un-snooze:', error)
            toast({ variant: 'destructive', description: t('common.error', 'Failed to un-snooze reminder') })
        } finally {
            setIsProcessing(false)
            setUnsnoozeItem(null)
        }
    }


    const metrics = useMemo(() => {
        const year = selectedMonth.getFullYear()
        const month = selectedMonth.getMonth()
        const monthStart = new Date(year, month, 1)
        const monthEnd = new Date(year, month + 1, 0, 23, 59, 59)
        const recurringTemplates = expenses.filter(e => e.type === 'recurring')

        const monthExpenses = expenses.filter(e => {
            const date = new Date(e.dueDate)
            // One-time expenses ONLY in their month
            if (e.type === 'one-time') {
                if (e.category === 'payroll' && e.employeeId) return false
                return date >= monthStart && date <= monthEnd
            }
            return false
        }).map(e => {
            const recurringTemplate = recurringTemplates.find(template =>
                isRecurringOccurrenceMatch(template, e, monthStart, monthEnd)
            )

            return {
                ...e,
                isVirtual: false,
                isRecurringVirtual: false,
                isRecurringLinked: !!recurringTemplate,
                recurringTemplateId: recurringTemplate?.id
            }
        })

        // Process Recurring Templates
        const virtualRecurringExpenses: any[] = []

        recurringTemplates.forEach(template => {
            // Project to current month
            const templateDate = new Date(template.dueDate)
            const projectedDate = new Date(year, month, Math.min(templateDate.getDate(), new Date(year, month + 1, 0).getDate()))

            // Check if this recurring template has an occurrence materialized for this month.
            const hasMaterializedOccurrence = monthExpenses.some(e =>
                isRecurringOccurrenceMatch(template, e, monthStart, monthEnd)
            )

            if (!hasMaterializedOccurrence) {
                virtualRecurringExpenses.push({
                    ...template,
                    id: `v-recurring-${template.id}-${month}`, // Unique ID for key
                    originalTemplateId: template.id,
                    recurringTemplateId: template.id,
                    dueDate: projectedDate.toISOString(),
                    status: 'pending',
                    isVirtual: true,
                    isRecurringVirtual: true,
                    isRecurringLinked: true
                })
            }
        })

        // Combine for totals
        const operationalExpenses = [...monthExpenses, ...virtualRecurringExpenses]

        let operationalTotal = 0
        let operationalPaid = 0
        let operationalPending = 0

        operationalExpenses.forEach(exp => {
            const baseAmount = convertToStoreBase(exp.amount, exp.currency)
            operationalTotal += baseAmount
            if (exp.status === 'paid') operationalPaid += baseAmount
            else operationalPending += baseAmount
        })

        const totalProfitFromRevenue = Object.entries(monthlyFinancials.profit || {}).reduce((sum, [curr, amt]) => sum + convertToStoreBase(amt, curr), 0)

        const virtualExpenses: any[] = []
        let personnelPaid = 0
        let personnelPending = 0

        // Pass 1: Personnel Salaries (Base ONLY)
        employees.forEach(emp => {
            // Salary
            if (emp.salary && emp.salary > 0) {
                const amount = emp.salary
                const currency = (emp.salaryCurrency as any) || 'usd'
                const pDay = Number(emp.salaryPayday) || 30
                let payDate = new Date(year, month, Math.min(pDay, new Date(year, month + 1, 0).getDate()))
                const existingPayrollExpense = expenses.find(e =>
                    e.type === 'one-time' &&
                    e.category === 'payroll' &&
                    e.employeeId === emp.id &&
                    new Date(e.dueDate) >= monthStart &&
                    new Date(e.dueDate) <= monthEnd
                )

                const status = (existingPayrollExpense && existingPayrollExpense.status === 'paid') ? 'paid' : 'pending'
                const baseAmount = convertToStoreBase(amount, currency)

                if (status === 'paid') personnelPaid += baseAmount
                else personnelPending += baseAmount

                // Determine effective currency and amount from existing record if paid
                const finalAmount = existingPayrollExpense ? existingPayrollExpense.amount : amount
                const finalCurrency = existingPayrollExpense ? existingPayrollExpense.currency : currency

                virtualExpenses.push({
                    id: existingPayrollExpense ? existingPayrollExpense.id : `v-salary-${emp.id}`,
                    description: `${emp.name} (${t('hr.salary', 'Salary')})`,
                    amount: finalAmount,
                    currency: finalCurrency,
                    category: 'payroll',
                    status,
                    dueDate: existingPayrollExpense ? existingPayrollExpense.dueDate : payDate.toISOString(),
                    isVirtual: true,
                    type: 'recurring',
                    employeeId: emp.id,
                    expenseRecordId: existingPayrollExpense?.id,
                    isLocked: existingPayrollExpense?.isLocked || false
                })
            }
        })

        const totalOperational = operationalTotal + personnelPaid + personnelPending
        const referenceProfit = totalProfitFromRevenue

        // Pass 2: Profit Pool (Money after hard bills)
        const profitPool = Math.max(0, referenceProfit - totalOperational)

        // Pass 3: Dividends (Distribution from Profit Pool)
        let dividendTotal = 0
        let dividendPaid = 0
        let dividendPending = 0

        const dividendRecipients: DividendRecipient[] = []

        employees.forEach(emp => {
            if (emp.hasDividends && emp.dividendAmount && emp.dividendAmount > 0) {
                let amount = 0
                if (emp.dividendType === 'fixed') {
                    amount = emp.dividendAmount
                } else {
                    amount = profitPool * (emp.dividendAmount / 100)
                }

                const finalAmount = emp.isFired ? 0 : amount
                const currency = emp.dividendType === 'fixed' ? (emp.dividendCurrency as any || 'usd') : baseCurrency
                const status = dividendPaidMap.get(`dividend_${emp.id}`) ? 'paid' : 'pending'
                const baseAmount = convertToStoreBase(finalAmount, currency)

                dividendTotal += baseAmount
                if (status === 'paid') dividendPaid += baseAmount
                else dividendPending += baseAmount

                const linkedUser = emp.linkedUserId ? workspaceUsers.find(u => u.id === emp.linkedUserId) : null
                const avatarUrl = linkedUser?.profileUrl ? platformService.convertFileSrc(linkedUser.profileUrl) : undefined

                dividendRecipients.push({
                    name: emp.name,
                    amount: finalAmount,
                    currency,
                    formula: emp.dividendType === 'fixed' ? formatCurrency(emp.dividendAmount, currency as any, iqdPreference) : `${emp.dividendAmount}%`,
                    isLinked: !!emp.linkedUserId,
                    isFired: emp.isFired,
                    avatarUrl
                })

                // Dividends are NOT pushed to virtualExpenses anymore to exclude them from the main list
            }
        })

        const EPSILON = 0.01 // Ignore tiny floating point differences
        const roundedProfitPool = Math.round(profitPool * 100) / 100
        const roundedDividendTotal = Math.round(dividendTotal * 100) / 100
        const finalNetProfitValue = roundedProfitPool - roundedDividendTotal
        const isDeficit = finalNetProfitValue < -EPSILON
        const cleanNetProfit = Math.abs(finalNetProfitValue) < EPSILON ? 0 : finalNetProfitValue

        const hasMixedCurrencies = new Set([...monthExpenses, ...virtualExpenses].map(e => e.currency?.toLowerCase())).size > 1

        let budgetLimit = 0
        if (currentAllocation) {
            if (currentAllocation.type === 'fixed') {
                budgetLimit = convertToStoreBase(currentAllocation.amount, currentAllocation.currency)
            } else {
                budgetLimit = referenceProfit * (currentAllocation.amount / 100)
            }
        }

        return {
            operationalTotal: totalOperational,
            total: totalOperational,
            paid: operationalPaid + personnelPaid,
            pending: operationalPending + personnelPending,
            dividendTotal: roundedDividendTotal,
            dividendPaid,
            dividendPending,
            finalNetProfit: cleanNetProfit,
            profitPool: roundedProfitPool,
            isDeficit,
            count: monthExpenses.length + virtualExpenses.length,
            isMixed: hasMixedCurrencies,
            budgetLimit,
            referenceProfit,
            displayExpenses: [...monthExpenses, ...virtualRecurringExpenses, ...virtualExpenses],
            dividendRecipients
        }
    }, [expenses, employees, workspaceUsers, selectedMonth, convertToStoreBase, currentAllocation, monthlyFinancials, t, baseCurrency, iqdPreference, dividendPaidMap])

    const sortedDisplayExpenses = useMemo(
        () => [...metrics.displayExpenses].sort((a, b) => new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime()),
        [metrics.displayExpenses]
    )
    const isBudgetLimitExceeded = !isBudgetLimitLoading && metrics.budgetLimit > 0 && metrics.total > metrics.budgetLimit

    const dividendRows = useMemo<DividendWithdrawalRow[]>(() => {
        const year = selectedMonth.getFullYear()
        const month = selectedMonth.getMonth()
        const today = new Date()

        return employees
            .filter(emp => emp.hasDividends && emp.dividendAmount && emp.dividendAmount > 0 && !emp.isFired)
            .map(emp => {
                const dividendAmount = emp.dividendAmount ?? 0
                const isAmountLoading = emp.dividendType === 'percentage' && isMonthlyFinancialsLoading
                const amount = emp.dividendType === 'fixed'
                    ? dividendAmount
                    : (isAmountLoading ? 0 : metrics.profitPool * (dividendAmount / 100))
                const currency = emp.dividendType === 'fixed'
                    ? (emp.dividendCurrency as any || 'usd')
                    : baseCurrency

                const payday = Number(emp.dividendPayday) || 30
                const dueDate = new Date(year, month, Math.min(payday, new Date(year, month + 1, 0).getDate()))
                const virtualKey = `dividend_${emp.id}`
                const isPaid = dividendPaidMap.get(virtualKey) === true
                const virtualSnooze = dividendSnoozeMap.get(virtualKey)
                const snoozed = virtualSnooze ? isSnoozeActive(virtualSnooze.until) : false

                let status: DividendWithdrawalStatus = 'upcoming'
                if (isPaid) {
                    status = 'paid'
                } else if (snoozed) {
                    status = 'snoozed'
                } else if (isSameDay(dueDate, today)) {
                    status = 'dueToday'
                } else if (dueDate < today) {
                    status = 'overdue'
                }

                return {
                    employeeId: emp.id,
                    employeeName: emp.name,
                    formula: emp.dividendType === 'fixed'
                        ? formatCurrency(dividendAmount, currency as any, iqdPreference)
                        : `${dividendAmount}%`,
                    dueDate,
                    amount,
                    currency,
                    status,
                    snoozeUntil: virtualSnooze?.until || null,
                    snoozeCount: virtualSnooze?.count || 0,
                    isAmountLoading,
                }
            })
            .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
    }, [employees, selectedMonth, metrics.profitPool, baseCurrency, iqdPreference, dividendPaidMap, dividendSnoozeMap, isMonthlyFinancialsLoading])

    const openDividendSnooze = (row: DividendWithdrawalRow) => {
        if (row.isAmountLoading) return

        setDividendSnoozeItem({
            id: getDividendReminderId(row.employeeId, row.dueDate),
            category: 'dividend',
            title: row.employeeName,
            amount: row.amount,
            currency: row.currency,
            displayAmount: formatCurrency(row.amount, row.currency as any, iqdPreference),
            formula: row.formula,
            dueDate: row.dueDate.toISOString(),
            status: 'pending',
            employeeId: row.employeeId,
            employeeName: row.employeeName,
            snoozeUntil: row.snoozeUntil,
            snoozeCount: row.snoozeCount,
            isLocked: false
        })
    }

    const handleDividendMarkPaid = async (row: DividendWithdrawalRow) => {
        if (isProcessing) return
        setIsProcessing(true)
        try {
            const dueMonth = getReminderMonth(row.dueDate) || monthStr
            await setVirtualPaid('dividend', row.employeeId, dueMonth, true)
            await setVirtualSnooze('dividend', row.employeeId, dueMonth, '', 0)
            updateDividendPaidState(row.employeeId, true)
            updateDividendSnoozeState(row.employeeId, null, 0)
            removeSnoozedItem(getDividendReminderId(row.employeeId, row.dueDate))
            toast({ description: t('budget.dividend.paidPersisted', 'Dividend payment status saved') })

        } catch (error) {
            console.error('[Budget] Failed to mark dividend paid:', error)
            toast({ variant: 'destructive', description: t('common.error', 'Failed to update status') })
        } finally {
            setIsProcessing(false)
        }
    }

    const handleDividendMarkUnpaid = async (row: DividendWithdrawalRow) => {
        if (isProcessing) return
        setIsProcessing(true)
        try {
            await setVirtualPaid('dividend', row.employeeId, getReminderMonth(row.dueDate) || monthStr, false)
            updateDividendPaidState(row.employeeId, false)
            toast({ description: t('budget.statusUpdated', 'Status updated') })

        } catch (error) {
            console.error('[Budget] Failed to mark dividend unpaid:', error)
            toast({ variant: 'destructive', description: t('common.error', 'Failed to update status') })
        } finally {
            setIsProcessing(false)
        }
    }

    const handleDividendUnsnooze = async (row: DividendWithdrawalRow) => {
        if (isProcessing) return
        setIsProcessing(true)
        try {
            await setVirtualSnooze('dividend', row.employeeId, getReminderMonth(row.dueDate) || monthStr, '', 0)
            updateDividendSnoozeState(row.employeeId, null, 0)
            removeSnoozedItem(getDividendReminderId(row.employeeId, row.dueDate))
            toast({ description: t('budget.unsnoozed', 'Reminder un-snoozed') })

        } catch (error) {
            console.error('[Budget] Failed to un-snooze dividend:', error)
            toast({ variant: 'destructive', description: t('common.error', 'Failed to un-snooze reminder') })
        } finally {
            setIsProcessing(false)
        }
    }

    const handleDividendSnooze = async (minutes: number) => {
        if (!dividendSnoozeItem || !dividendSnoozeItem.employeeId || isProcessing) return
        setIsProcessing(true)

        const snoozeUntil = minutes === -1
            ? INDEFINITE_SNOOZE_DATE
            : new Date(Date.now() + minutes * 60000).toISOString()
        const newCount = (dividendSnoozeItem.snoozeCount || 0) + 1

        try {
            await setVirtualSnooze(
                'dividend',
                dividendSnoozeItem.employeeId,
                getReminderMonth(dividendSnoozeItem.dueDate) || monthStr,
                snoozeUntil,
                newCount
            )
            updateDividendSnoozeState(dividendSnoozeItem.employeeId, snoozeUntil, newCount)
            upsertSnoozedItem({
                ...dividendSnoozeItem,
                snoozeUntil,
                snoozeCount: newCount
            })

        } catch (error) {
            console.error('[Budget] Failed to snooze dividend:', error)
            toast({ variant: 'destructive', description: t('common.error', 'Failed to update') })
        } finally {
            setIsProcessing(false)
            setDividendSnoozeItem(null)
        }
    }

    const dividendStatusClass: Record<DividendWithdrawalStatus, string> = {
        paid: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
        snoozed: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
        overdue: 'bg-red-500/10 text-red-600 border-red-500/20',
        dueToday: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
        upcoming: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
    }

    const [isSaving, setIsSaving] = useState(false)

    const handleAddExpense = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (!workspaceId || isSaving) return

        const formData = new FormData(e.currentTarget)
        const subcategoryInput = (formData.get('subcategory') as string | null)?.trim()
        const subcategory = subcategoryInput ? subcategoryInput : null
        setIsSaving(true)
        // Optimistically close for better UX
        setIsDialogOpen(false)

        try {
            await createExpense(workspaceId, {
                description: formData.get('description') as string,
                type: formData.get('type') as any,
                category: formData.get('category') as any,
                subcategory,
                amount: parseFormattedNumber(expenseAmountDisplay),
                currency: (formData.get('currency') as any) || baseCurrency || 'usd',
                status: 'pending',
                dueDate: formData.get('dueDate') as string,
                paidAt: null,
                snoozeUntil: null,
                snoozeCount: 0
            })
            toast({ description: t('budget.expenseAdded', 'Expense added to tracker') })
        } catch (error) {
            toast({ variant: 'destructive', description: t('common.error', 'Failed to add expense') })
            setIsDialogOpen(true) // Re-open on error
        } finally {
            setIsSaving(false)
        }
    }

    const handleToggleStatus = async (expense: any) => {
        if (!workspaceId || expense.isLocked || isProcessing) return
        setIsProcessing(true)
        try {
            if (expense.isVirtual && expense.category === 'payroll' && expense.employeeId) {
                if (expense.status === 'paid' && expense.expenseRecordId) {
                    await deleteExpense(expense.expenseRecordId)
                    toast({ description: t('budget.expenseUnpaid', 'Salary marked as unpaid') })
                } else if (expense.expenseRecordId) {
                    // Update existing (e.g. was snoozed)
                    await updateExpense(expense.expenseRecordId, {
                        status: 'paid',
                        paidAt: new Date().toISOString(),
                        snoozeUntil: null,
                        snoozeCount: 0
                    })
                    toast({ description: t('budget.expensePaid', 'Salary marked as paid') })
                } else {
                    await createExpense(workspaceId, {
                        description: expense.description,
                        type: 'one-time',
                        category: 'payroll',
                        amount: expense.amount,
                        currency: expense.currency,
                        status: 'paid',
                        dueDate: expense.dueDate,
                        paidAt: new Date().toISOString(),
                        snoozeUntil: null,
                        snoozeCount: 0,
                        employeeId: expense.employeeId
                    })
                    toast({ description: t('budget.expensePaid', 'Salary marked as paid') })
                }
            } else if (expense.isRecurringVirtual) {
                // Determine due date from the virtual expense
                const dueDateObj = new Date(expense.dueDate)
                const monthStart = new Date(dueDateObj.getFullYear(), dueDateObj.getMonth(), 1)
                const monthEnd = new Date(dueDateObj.getFullYear(), dueDateObj.getMonth() + 1, 0, 23, 59, 59)
                const recurringTemplate =
                    expenses.find(e => e.id === (expense as any).originalTemplateId && e.type === 'recurring') || expense

                // Check if a record (like a snooze) already exists for this template in this month
                const existingRecord = expenses.find(e =>
                    isRecurringOccurrenceMatch(recurringTemplate, e, monthStart, monthEnd)
                )

                if (existingRecord) {
                    await updateExpense(existingRecord.id, {
                        status: 'paid',
                        paidAt: new Date().toISOString(),
                        snoozeUntil: null,
                        snoozeCount: 0
                    })
                } else {
                    await createExpense(workspaceId, {
                        description: expense.description,
                        type: 'one-time',
                        category: expense.category,
                        subcategory: expense.subcategory?.trim() ? expense.subcategory.trim() : null,
                        amount: expense.amount,
                        currency: expense.currency,
                        status: 'paid',
                        dueDate: expense.dueDate,
                        paidAt: new Date().toISOString(),
                        snoozeUntil: null,
                        snoozeCount: 0
                    })
                }
                toast({ description: t('budget.expensePaid', 'Expense marked as paid') })
            } else if (!expense.isVirtual || (expense.isVirtual && !expense.isRecurringVirtual)) {
                // Real expense (one-time)
                // Toggle status
                const newStatus = expense.status === 'paid' ? 'pending' : 'paid'
                await updateExpense(expense.id, {
                    status: newStatus,
                    paidAt: newStatus === 'paid' ? new Date().toISOString() : null,
                    snoozeUntil: null,
                    snoozeCount: 0
                })
                toast({ description: t('budget.statusUpdated', 'Status updated') })
            }
        } catch (error) {
            console.error(error)
            toast({ variant: 'destructive', description: t('common.error', 'Failed to update status') })
        } finally {
            setIsProcessing(false)
        }
    }

    const handleDeleteDisplayExpense = async (expense: any) => {
        if (expense.isLocked) return

        try {
            if ((expense as any).isRecurringVirtual && (expense as any).originalTemplateId) {
                await deleteExpense((expense as any).originalTemplateId)
                return
            }

            await deleteExpense(expense.id)

            if ((expense as any).isRecurringLinked && (expense as any).recurringTemplateId) {
                toast({
                    description: t(
                        'budget.deletedOccurrenceKeepsSeries',
                        'Deleted this month item. Recurring series is still active.'
                    )
                })
            }
        } catch (error) {
            console.error(error)
            toast({ variant: 'destructive', description: t('common.error', 'Failed to delete expense') })
        }
    }

    const isCurrentMonth = selectedMonth.getFullYear() === new Date().getFullYear() &&
        selectedMonth.getMonth() === new Date().getMonth()

    return (
        <div className="space-y-6 pb-10">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('nav.budget', 'Budget')}</h1>
                    <p className="text-muted-foreground">
                        {t('budget.subtitle', 'Financial health and expense management')}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={handlePrevMonth} disabled={isAtStartPoint}>
                        <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <div className="px-4 py-2 bg-secondary rounded-md font-bold text-sm flex items-center gap-2">
                        {selectedMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}
                        {isAtStartPoint && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-fuchsia-600 dark:text-fuchsia-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-500 animate-pulse" />
                                {t('budget.startPoint', 'Start')}
                            </span>
                        )}
                    </div>
                    <Button variant="outline" onClick={handleNextMonth}>
                        <ChevronRight className="w-4 h-4" />
                    </Button>
                    <Button variant="outline" onClick={() => setSelectedMonth(new Date())} disabled={isCurrentMonth}>
                        {t('common.current', 'Now')}
                    </Button>
                    {snoozedItems.length > 0 && (
                        <SnoozedBudgetItemsBell
                            items={snoozedItems}
                            onUnsnooze={handleUnsnooze}
                            iqdPreference={iqdPreference}
                            isLoading={isProcessing}
                        />
                    )}
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {/* Total Allocated (Operational) */}
                <Card
                    className={cn(
                        "cursor-pointer hover:scale-[1.02] transition-all hover:bg-opacity-10 dark:hover:bg-opacity-20 active:scale-95 group relative overflow-hidden rounded-[2rem]",
                        metrics.budgetLimit > 0
                            ? (isBudgetLimitExceeded
                                ? 'bg-red-500/5 dark:bg-red-500/10 border-red-500/20 hover:shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)]'
                                : 'bg-blue-500/5 dark:bg-blue-500/10 border-blue-500/20 hover:shadow-[0_0_20px_-5px_rgba(59,130,246,0.3)]')
                            : 'bg-blue-500/5 dark:bg-blue-500/10 border-blue-500/20 hover:shadow-[0_0_20px_-5px_rgba(59,130,246,0.3)]'
                    )}
                >
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <ArrowRight className={cn("w-4 h-4", isBudgetLimitExceeded ? "text-red-500" : "text-blue-500")} />
                    </div>
                    <CardHeader className="pb-2">
                        <CardTitle className={cn(
                            "text-xs font-black uppercase tracking-[0.2em] flex items-center gap-2",
                            isBudgetLimitExceeded ? "text-red-600 dark:text-red-400" : "text-blue-600 dark:text-blue-400"
                        )}>
                            <BarChart3 className="w-4 h-4" />
                            {t('budget.totalAllocated', 'Total Allocated')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-baseline gap-2">
                            <div className={cn(
                                "text-2xl font-black tracking-tighter tabular-nums",
                                isBudgetLimitExceeded ? "text-red-700 dark:text-red-300" : "text-blue-700 dark:text-blue-300"
                            )}>
                                {formatCurrency(metrics.total, baseCurrency, iqdPreference)}
                            </div>
                            {isBudgetLimitLoading ? (
                                <LoadingValue className="h-3 w-20" />
                            ) : metrics.budgetLimit > 0 && (
                                <div className="text-xs font-bold opacity-60">
                                    / {formatCurrency(metrics.budgetLimit, baseCurrency, iqdPreference)}
                                </div>
                            )}
                        </div>
                        {!isBudgetLimitLoading && metrics.budgetLimit > 0 && (
                            <div className="w-full bg-black/5 dark:bg-white/5 h-2 rounded-full mt-3 overflow-hidden border border-black/5 dark:border-white/5">
                                <div
                                    className={cn("h-full transition-all duration-1000", isBudgetLimitExceeded ? 'bg-red-500' : 'bg-blue-500')}
                                    style={{ width: `${Math.min((metrics.total / metrics.budgetLimit) * 100, 100)}%` }}
                                />
                            </div>
                        )}
                        <p className="text-[10px] font-bold uppercase tracking-wider mt-2 opacity-60">
                            {metrics.count} {t('budget.items', 'items')}
                            {!isBudgetLimitLoading && metrics.budgetLimit > 0 && ` / ${Math.round((metrics.total / metrics.budgetLimit) * 100)}% ${t('budget.limit', 'of budget')}`}
                            {!isMonthlyFinancialsLoading && metrics.referenceProfit > 0 && ` / ${Math.round((metrics.dividendTotal / metrics.referenceProfit) * 100)}% ${t('budget.dividends', 'Dividends')}`}
                        </p>
                    </CardContent>
                </Card>

                {/* Total Paid */}
                <Card
                    className="bg-emerald-500/5 dark:bg-emerald-500/10 border-emerald-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-emerald-500/10 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] active:scale-95 group relative overflow-hidden rounded-[2rem]"
                >
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <ArrowRight className="w-4 h-4 text-emerald-500" />
                    </div>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-xs font-black text-emerald-600 dark:text-emerald-400 flex items-center gap-2 uppercase tracking-[0.2em]">
                            <CheckCircle2 className="w-4 h-4" />
                            {t('budget.paid', 'Total Paid')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-black tracking-tighter tabular-nums text-emerald-700 dark:text-emerald-300">
                            {formatCurrency(metrics.paid, baseCurrency, iqdPreference)}
                        </div>
                        <div className="w-full bg-black/5 dark:bg-white/5 h-2 rounded-full mt-3 overflow-hidden border border-black/5 dark:border-white/5">
                            <div
                                className="bg-emerald-500 h-full transition-all duration-1000"
                                style={{ width: `${(metrics.paid / (metrics.total || 1)) * 100}%` }}
                            />
                        </div>
                        <p className="text-[10px] font-bold uppercase tracking-wider mt-2 opacity-60">
                            {((metrics.paid / (metrics.total || 1)) * 100).toFixed(1)}% {t('budget.status.paid', 'Paid')}
                        </p>
                    </CardContent>
                </Card>

                {/* Outstanding */}
                <Card
                    className="bg-amber-500/5 dark:bg-amber-500/10 border-amber-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-amber-500/10 hover:shadow-[0_0_20px_-5px_rgba(245,158,11,0.3)] active:scale-95 group relative overflow-hidden rounded-[2rem]"
                >
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <ArrowRight className="w-4 h-4 text-amber-500" />
                    </div>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-xs font-black text-amber-600 dark:text-amber-400 flex items-center gap-2 uppercase tracking-[0.2em]">
                            <Clock className="w-4 h-4" />
                            {t('budget.pending', 'Outstanding')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-black tracking-tighter tabular-nums text-amber-700 dark:text-amber-300">
                            {formatCurrency(metrics.pending, baseCurrency, iqdPreference)}
                        </div>
                        <p className="text-[10px] font-bold uppercase tracking-wider mt-2 opacity-60">
                            {t('budget.dueByEnd', 'Due by end of month')}
                        </p>
                    </CardContent>
                </Card>

                {/* Dividends Total */}
                <Card
                    className={cn(
                        "cursor-pointer hover:scale-[1.02] transition-all active:scale-95 group relative overflow-hidden rounded-[2rem]",
                        metrics.isDeficit
                            ? 'bg-red-500/5 dark:bg-red-500/10 border-red-500/20 hover:bg-red-500/10 hover:shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)]'
                            : 'bg-sky-500/5 dark:bg-sky-500/10 border-sky-500/20 hover:bg-sky-500/10 hover:shadow-[0_0_20px_-5px_rgba(14,165,233,0.3)]'
                    )}
                    onClick={() => setActiveBudgetTab('dividends')}
                >
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <User className="w-4 h-4 text-sky-500" />
                    </div>
                    <CardHeader className="pb-2">
                        <CardTitle className={cn(
                            "text-xs font-black flex items-center gap-2 uppercase tracking-[0.2em]",
                            metrics.isDeficit ? 'text-red-600 dark:text-red-400' : 'text-sky-600 dark:text-sky-400'
                        )}>
                            <User className="w-4 h-4" />
                            {t('budget.dividends', 'Dividends Total')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className={cn(
                            "text-2xl font-black tracking-tighter tabular-nums",
                            metrics.isDeficit ? 'text-red-700 dark:text-red-300' : 'text-sky-700 dark:text-sky-300'
                        )}>
                            {isMonthlyFinancialsLoading
                                ? <LoadingValue className="h-8 w-28" />
                                : formatCurrency(metrics.dividendTotal, baseCurrency, iqdPreference)
                            }
                        </div>
                        {!isMonthlyFinancialsLoading && metrics.isDeficit ? (
                            <div className="flex items-center gap-1 mt-2 text-[10px] font-bold text-red-600 dark:text-red-400">
                                <AlertTriangle className="w-3 h-3" />
                                {t('budget.dividendsExceedPool', 'Exceeds profit pool by')} {formatCurrency(Math.abs(metrics.finalNetProfit), baseCurrency, iqdPreference)}
                            </div>
                        ) : isMonthlyFinancialsLoading ? (
                            <LoadingValue className="mt-2 h-3 w-40" />
                        ) : (
                            <p className="text-[10px] font-bold uppercase tracking-wider mt-2 opacity-60">
                                {t('budget.profitDistribution', 'Profit share distribution')}
                            </p>
                        )}
                    </CardContent>
                </Card>

                {/* Surplus Projection */}
                <Card
                    className={cn(
                        "cursor-pointer hover:scale-[1.02] transition-all active:scale-95 group relative overflow-hidden rounded-[2rem]",
                        metrics.isDeficit
                            ? 'bg-red-500/5 dark:bg-red-500/10 border-red-500/20 hover:bg-red-500/10 hover:shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)]'
                            : 'bg-violet-500/5 dark:bg-violet-500/10 border-violet-500/20 hover:bg-violet-500/10 hover:shadow-[0_0_20px_-5px_rgba(139,92,246,0.3)]'
                    )}
                >
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        {metrics.finalNetProfit < 0
                            ? <AlertTriangle className="w-4 h-4 text-red-500" />
                            : <TrendingUp className="w-4 h-4 text-violet-500" />
                        }
                    </div>
                    <CardHeader className="pb-2">
                        <CardTitle className={cn(
                            "text-xs font-black flex items-center gap-2 uppercase tracking-[0.2em]",
                            metrics.isDeficit ? 'text-red-600 dark:text-red-400' : 'text-violet-600 dark:text-violet-400'
                        )}>
                            {metrics.isDeficit ? <AlertTriangle className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}
                            {metrics.isDeficit ? t('budget.deficit', 'Deficit') : t('budget.netProfit', 'Surplus')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className={cn(
                            "text-2xl font-black tracking-tighter tabular-nums",
                            metrics.isDeficit ? 'text-red-700 dark:text-red-300' : 'text-violet-700 dark:text-violet-300'
                        )}>
                            {isMonthlyFinancialsLoading
                                ? <LoadingValue className="h-8 w-28" />
                                : <>{metrics.isDeficit ? '-' : ''}{formatCurrency(Math.abs(metrics.finalNetProfit), baseCurrency, iqdPreference)}</>
                            }
                        </div>
                        <p className="text-[10px] font-bold uppercase tracking-wider mt-2 opacity-60">
                            {isMonthlyFinancialsLoading
                                ? <LoadingValue className="h-3 w-32" />
                                : metrics.isDeficit
                                    ? t('budget.projectedDeficit', 'Dividends exceed profit')
                                    : t('budget.projectedSurplus', 'Projected Surplus')
                            }
                        </p>
                    </CardContent>
                </Card>
            </div>

            <Tabs
                value={activeBudgetTab}
                onValueChange={(value) => setActiveBudgetTab(value as 'expenses' | 'dividends')}
                className="pt-4 space-y-4"
            >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <TabsList className="h-11">
                        <TabsTrigger value="expenses">
                            {t('budget.tabs.monthlyExpenses', 'Monthly Expenses')}
                        </TabsTrigger>
                        <TabsTrigger value="dividends">
                            {t('budget.tabs.dividendsWithdrawal', 'Dividends Withdrawal')}
                        </TabsTrigger>
                    </TabsList>
                    <div className="flex gap-2">
                        {activeBudgetTab === 'expenses' ? (
                            <>
                                <Button variant="outline" onClick={() => handlePrintBudget()} className="gap-2">
                                    <Printer className="w-4 h-4" />
                                    {t('common.print') || 'Print'}
                                </Button>
                                <Button variant="outline" onClick={() => setIsAllocationDialogOpen(true)} className="gap-2">
                                    <Calendar className="w-4 h-4" />
                                    {t('budget.setBudget', 'Set Budget')}
                                </Button>
                                <Button onClick={() => setIsDialogOpen(true)} className="gap-2">
                                    <Plus className="w-4 h-4" />
                                    {t('budget.addExpense', 'New Expense')}
                                </Button>
                            </>
                        ) : (
                            <Button variant="outline" onClick={() => handlePrintDividends()} className="gap-2">
                                <Printer className="w-4 h-4" />
                                {t('common.print') || 'Print'}
                            </Button>
                        )}
                    </div>
                </div>

                <TabsContent value="expenses" className="mt-0">
                    <div className="grid gap-4">
                        {sortedDisplayExpenses.map((expense) => (
                            <div
                                key={expense.id}
                                className={cn(
                                    "flex items-center justify-between p-4 rounded-xl border transition-shadow group",
                                    expense.isVirtual && !(expense as any).isRecurringVirtual && expense.status === 'paid'
                                        ? 'bg-emerald-500/5 border-emerald-500/20 hover:shadow-emerald-500/10'
                                        : expense.isVirtual && !(expense as any).isRecurringVirtual && expense.status === 'pending'
                                            ? 'bg-blue-500/5 border-blue-500/20 hover:shadow-blue-500/10'
                                            : 'bg-card border-border hover:shadow-md',
                                    (expense as any).isFired && "opacity-40 grayscale brightness-75 bg-muted/20"
                                )}
                            >
                                <div className="flex items-center gap-4">
                                    <div className={`p-2.5 rounded-lg ${expense.isVirtual && !(expense as any).isRecurringVirtual
                                        ? (expense.status === 'paid' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-blue-500/10 text-blue-500')
                                        : expense.status === 'paid' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                                        }`}>
                                        {expense.isVirtual && !(expense as any).isRecurringVirtual ? <User className="w-5 h-5" /> :
                                            expense.status === 'paid' ? <CheckCircle2 className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                                    </div>
                                    <div>
                                        <div className="font-semibold flex items-center gap-2">
                                            {expense.description || String(t(`budget.cat.${expense.category}`, { defaultValue: expense.category }))}
                                            {((expense as any).isRecurringVirtual || (expense as any).isRecurringLinked) && (
                                                <Repeat className="w-3 h-3 text-muted-foreground" />
                                            )}
                                        </div>
                                        <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                                            <span>
                                                {expense.subcategory?.trim()
                                                    ? `${String(t(`budget.cat.${expense.category}`, { defaultValue: expense.category }))} / ${String(t(`budget.subcat.${expense.subcategory.trim()}`, { defaultValue: expense.subcategory.trim() }))}`
                                                    : String(t(`budget.cat.${expense.category}`, { defaultValue: expense.category }))}
                                            </span>
                                            <span>/</span>
                                            <Calendar className="w-3 h-3" />
                                            {formatDate(expense.dueDate)}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-6">
                                    <div className="text-end">
                                        <div className={cn(
                                            "font-bold",
                                            (expense as any).isFired ? 'text-muted-foreground' : (
                                                expense.isVirtual && !(expense as any).isRecurringVirtual && expense.status === 'pending' ? 'text-blue-600' :
                                                    expense.status === 'paid' ? 'text-emerald-600' : 'text-amber-600'
                                            )
                                        )}>
                                            {(expense as any).isFired ? (
                                                <div className="flex flex-col items-end">
                                                    <span className="text-[10px] line-through opacity-50">
                                                        {formatCurrency((expense as any).originalAmount || 0, expense.currency, iqdPreference)}
                                                    </span>
                                                    <span>{formatCurrency(0, expense.currency, iqdPreference)}</span>
                                                </div>
                                            ) : (
                                                formatCurrency(expense.amount, expense.currency, iqdPreference)
                                            )}
                                        </div>
                                        <div className={cn(
                                            "text-[10px] font-bold uppercase tracking-wider flex items-center justify-end gap-1",
                                            (expense as any).isFired ? 'text-muted-foreground' : (
                                                expense.isVirtual && !(expense as any).isRecurringVirtual && expense.status === 'pending' ? 'text-blue-500' :
                                                    expense.status === 'paid' ? 'text-emerald-500' : 'text-amber-500'
                                            )
                                        )}>
                                            {(expense as any).isFired ? t('hr.personnel_fired', 'Staff (Fired/Suspended)') : (
                                                expense.isVirtual && !(expense as any).isRecurringVirtual ? (
                                                    <>
                                                        <span className="text-blue-500">{t('hr.personnel', 'Personnel')}</span> / {expense.status === 'paid' ? t('budget.status.paid', 'Paid') : t('budget.status.pending', 'Pending')}
                                                    </>
                                                ) : t(`budget.status.${expense.status}`)
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex gap-2 items-center">
                                        {(() => {
                                            const snoozed = snoozedItems.find(s =>
                                                (s.category === 'expense' && s.expenseId === expense.id) ||
                                                (s.category === 'salary' && s.employeeId === expense.employeeId && expense.category === 'payroll') ||
                                                (s.category === 'dividend' && s.employeeId === expense.employeeId && expense.category === 'dividend')
                                            )
                                            if (!snoozed) return null
                                            return (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-600 h-8 w-8"
                                                    onClick={() => setUnsnoozeItem(snoozed)}
                                                    title={t('budget.manageSnooze', 'Manage Snooze')}
                                                >
                                                    <BellOff className="w-4 h-4 fill-current animate-pulse" />
                                                </Button>
                                            )
                                        })()}

                                        {expense.isLocked ? (
                                            <Lock className="w-5 h-5 text-emerald-600 opacity-50 ml-2" />
                                        ) : (
                                            <>
                                                {expense.status === 'paid' && expense.category === 'payroll' && expense.expenseRecordId && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        title={t('budget.lockSalary', 'Lock Salary')}
                                                        onClick={() => setLockConfirmExpense(expense)}
                                                        className="hover:bg-amber-500/10 hover:text-amber-600 text-muted-foreground mr-1 h-8 w-8"
                                                    >
                                                        <Lock className="w-4 h-4" />
                                                    </Button>
                                                )}
                                                {(!expense.isVirtual || (expense.isVirtual && ((expense as any).isRecurringVirtual || expense.category === 'payroll'))) && !(expense as any).isFired && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className={cn(
                                                            "hover:bg-emerald-500/10 hover:text-emerald-600",
                                                            expense.status === 'paid' && "text-emerald-600"
                                                        )}
                                                        onClick={() => handleToggleStatus(expense)}
                                                        title={expense.status === 'paid' ? t('budget.markUnpaid', 'Mark as Unpaid') : t('budget.markPaid', 'Mark as Paid')}
                                                    >
                                                        {expense.status === 'paid' ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
                                                    </Button>
                                                )}
                                            </>
                                        )}
                                        {(!expense.isVirtual || (expense as any).isRecurringVirtual) && !expense.isLocked && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                                                onClick={() => handleDeleteDisplayExpense(expense)}
                                                title={(expense as any).isRecurringVirtual
                                                    ? t('budget.deleteSeries', 'Delete Recurring Series')
                                                    : (expense as any).isRecurringLinked
                                                        ? t('budget.deleteOccurrence', 'Delete This Month Only')
                                                        : t('common.delete', 'Delete')}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </TabsContent>

                <TabsContent value="dividends" className="mt-0 space-y-4">
                    <Card className="rounded-[2rem] border">
                        <CardHeader>
                            <CardTitle className="text-lg font-bold">
                                {t('budget.dividendsWithdrawal.title', 'Dividends Withdrawal')}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('budget.dividendsWithdrawal.subtitle', 'Review and distribute this month dividends')}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {dividendRows.length === 0 ? (
                                <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                                    {t('budget.dividend.empty', 'No dividend withdrawals for this month')}
                                </div>
                            ) : (
                                dividendRows.map((row) => (
                                    <div
                                        key={row.employeeId}
                                        className="rounded-xl border p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"
                                    >
                                        <div className="space-y-1">
                                            <div className="font-semibold">{row.employeeName}</div>
                                            <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-2">
                                                <span>{row.formula}</span>
                                                <span>/</span>
                                                <span>{t('budget.form.dueDate', 'Due Date')}: {formatDate(row.dueDate.toISOString())}</span>
                                            </div>
                                        </div>

                                        <div className="flex flex-col items-start gap-2 lg:items-end">
                                            <div className="font-black text-base">
                                                {row.isAmountLoading
                                                    ? <LoadingValue className="h-6 w-28" />
                                                    : formatCurrency(row.amount, row.currency, iqdPreference)
                                                }
                                            </div>
                                            <span className={cn(
                                                "text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full border",
                                                dividendStatusClass[row.status]
                                            )}>
                                                {t(`budget.dividend.status.${row.status}`, row.status)}
                                            </span>
                                            <div className="flex flex-wrap gap-2">
                                                {row.status === 'paid' ? (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        disabled={isProcessing || row.isAmountLoading}
                                                        onClick={() => handleDividendMarkUnpaid(row)}
                                                    >
                                                        {t('budget.dividend.action.markUnpaid', 'Mark Unpaid')}
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        size="sm"
                                                        disabled={isProcessing || row.isAmountLoading}
                                                        onClick={() => handleDividendMarkPaid(row)}
                                                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                                    >
                                                        {t('budget.dividend.action.markPaid', 'Mark Paid')}
                                                    </Button>
                                                )}

                                                {row.status === 'snoozed' ? (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        disabled={isProcessing || row.isAmountLoading}
                                                        onClick={() => handleDividendUnsnooze(row)}
                                                    >
                                                        {t('budget.dividend.action.unsnooze', 'Un-snooze')}
                                                    </Button>
                                                ) : row.status !== 'paid' ? (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        disabled={isProcessing || row.isAmountLoading}
                                                        onClick={() => openDividendSnooze(row)}
                                                    >
                                                        {t('budget.dividend.action.snooze', 'Snooze')}
                                                    </Button>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </CardContent>
                    </Card>

                    {isMonthlyFinancialsLoading ? (
                        <Card className="p-4 md:p-6 rounded-[2rem] border bg-card">
                            <div className="space-y-6 animate-pulse">
                                <div className="flex items-center justify-between gap-4">
                                    <div className="space-y-3">
                                        <div className="h-7 w-56 rounded-full bg-black/10 dark:bg-white/10" />
                                        <div className="h-4 w-72 rounded-full bg-black/10 dark:bg-white/10" />
                                    </div>
                                    <div className="h-10 w-10 rounded-xl bg-black/10 dark:bg-white/10" />
                                </div>
                                <div className="grid gap-6 md:grid-cols-2">
                                    <div className="h-[300px] rounded-[2rem] bg-black/10 dark:bg-white/10" />
                                    <div className="space-y-4">
                                        <div className="h-24 rounded-[2rem] bg-black/10 dark:bg-white/10" />
                                        <div className="h-24 rounded-[2rem] bg-black/10 dark:bg-white/10" />
                                    </div>
                                </div>
                                <div className="h-64 rounded-[2rem] bg-black/10 dark:bg-white/10" />
                            </div>
                        </Card>
                    ) : (
                        <DividendDistributionPanel
                            recipients={metrics.dividendRecipients}
                            surplus={metrics.finalNetProfit}
                            paidAmount={metrics.dividendPaid}
                            baseCurrency={baseCurrency}
                            iqdPreference={iqdPreference}
                            onPrint={handlePrintDividends}
                            className="p-4 md:p-6 rounded-[2rem] border bg-card"
                        />
                    )}
                </TabsContent>
            </Tabs>
            <div className="fixed left-[-10000px] top-0 pointer-events-none">
                <div ref={printRef}>
                    <BudgetPrintTemplate
                        workspaceName={workspaceName}
                        printLang={printLang}
                        month={monthStr}
                        baseCurrency={baseCurrency}
                        iqdPreference={iqdPreference}
                        metrics={metrics}
                        expenses={sortedDisplayExpenses}
                    />
                </div>
            </div>
            <div className="fixed left-[-10000px] top-0 pointer-events-none">
                <div ref={dividendsPrintRef}>
                    <DividendDistributionPanel
                        recipients={metrics.dividendRecipients}
                        surplus={metrics.finalNetProfit}
                        paidAmount={metrics.dividendPaid}
                        baseCurrency={baseCurrency}
                        iqdPreference={iqdPreference}
                        className="p-8 min-w-[950px] bg-background"
                    />
                </div>
            </div>

            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogContent className={cn(
                    "max-w-md w-[95vw] sm:w-full p-0 bg-background/95 backdrop-blur-3xl overflow-hidden rounded-[2.5rem] shadow-2xl transition-all duration-500",
                    "border-[3px] border-emerald-500/50 shadow-emerald-500/10"
                )}>
                    <div className="p-6 md:p-8 space-y-6">
                        <DialogHeader className="flex flex-row items-center gap-4 space-y-0">
                            <div className="p-3 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                <Plus className="w-6 h-6" />
                            </div>
                            <div>
                                <DialogTitle className="text-xl font-black tracking-tight">{t('budget.addExpense', 'Create New Expense')}</DialogTitle>
                                <DialogDescription className="text-xs font-semibold text-muted-foreground/80">
                                    {t('budget.addExpenseSubtitle', 'Add a manual cost to your monthly tracks')}
                                </DialogDescription>
                            </div>
                        </DialogHeader>
                        <form onSubmit={handleAddExpense} className="space-y-4 pt-4">
                            <div className="space-y-2">
                                <Label htmlFor="description">{t('budget.form.desc', 'Description')}</Label>
                                <Input id="description" name="description" placeholder="e.g. Monthly Rent" required />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label htmlFor="amount">{t('budget.form.amount', 'Amount')}</Label>
                                    <div className="flex gap-2">
                                        <Input
                                            id="amount"
                                            name="amount"
                                            value={expenseAmountDisplay}
                                            onChange={(e) => setExpenseAmountDisplay(formatNumberWithCommas(e.target.value))}
                                            placeholder="0"
                                            className="flex-1"
                                            required
                                        />
                                        <Select name="currency" defaultValue={baseCurrency || 'usd'}>
                                            <SelectTrigger className="w-[80px]">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="usd">USD</SelectItem>
                                                <SelectItem value="iqd">IQD</SelectItem>
                                                <SelectItem value="eur">EUR</SelectItem>
                                                <SelectItem value="try">TRY</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="category">{t('budget.form.category', 'Category')}</Label>
                                    <Select name="category" value={selectedCategory} onValueChange={setSelectedCategory}>
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="payroll">{t('budget.cat.payroll', 'Payroll')}</SelectItem>
                                            <SelectItem value="rent">{t('budget.cat.rent', 'Rent')}</SelectItem>
                                            <SelectItem value="utility">{t('budget.cat.utility', 'Utilities')}</SelectItem>
                                            <SelectItem value="marketing">{t('budget.cat.marketing', 'Marketing')}</SelectItem>
                                            <SelectItem value="other">{t('budget.cat.other', 'Other')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2 col-span-2">
                                    <Label htmlFor="subcategory">{t('budget.form.subcategory', 'Subcategory')}</Label>
                                    <Select name="subcategory" defaultValue={PRESET_SUBCATEGORIES[selectedCategory]?.[0] || ''} key={selectedCategory}>
                                        <SelectTrigger id="subcategory">
                                            <SelectValue placeholder={t('common.select', 'Select...')} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {PRESET_SUBCATEGORIES[selectedCategory]?.map((sub) => (
                                                <SelectItem key={sub} value={sub}>{t(`budget.subcat.${sub}`, { defaultValue: sub })}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="type">{t('budget.form.type', 'Type')}</Label>
                                    <Select name="type" defaultValue="recurring">
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="recurring">{t('budget.type.recurring', 'Recurring')}</SelectItem>
                                            <SelectItem value="one-time">{t('budget.type.one-time', 'One-time')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="dueDate">{t('budget.form.dueDate', 'Due Date')}</Label>
                                    <Input id="dueDate" name="dueDate" type="date" defaultValue={new Date().toISOString().split('T')[0]} required />
                                </div>
                            </div>
                            <DialogFooter className="pt-4">
                                <Button type="submit" className="w-full">{t('common.save', 'Create Expense')}</Button>
                            </DialogFooter>
                        </form>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={isAllocationDialogOpen} onOpenChange={setIsAllocationDialogOpen}>
                <DialogContent className={cn(
                    "max-w-md w-[95vw] sm:w-full p-0 bg-white dark:bg-zinc-950 overflow-hidden rounded-[2.5rem] shadow-2xl transition-all duration-500 border-none",
                )}>
                    <div className="p-8 space-y-8">
                        <DialogHeader className="flex flex-row items-center gap-4 space-y-0 relative">
                            <div className="p-4 rounded-3xl bg-orange-50 dark:bg-orange-500/10 text-orange-500">
                                <TrendingUp className="w-6 h-6" />
                            </div>
                            <div className="space-y-1">
                                <DialogTitle className="text-2xl tracking-tight text-slate-900 dark:text-white">
                                    {t('budget.setBudgetTitle', 'Monthly Budget Allocation')}
                                </DialogTitle>
                                <DialogDescription className="text-sm font-medium text-slate-400 dark:text-zinc-500">
                                    {t('budget.setBudgetSubtitle', 'define your spending limits for this month')}
                                </DialogDescription>
                            </div>
                        </DialogHeader>

                        <form
                            onSubmit={async (e) => {
                                e.preventDefault()
                                if (!workspaceId || isSaving) return

                                setIsSaving(true)
                                setIsAllocationDialogOpen(false)

                                try {
                                    await setBudgetAllocation(workspaceId, {
                                        month: monthStr,
                                        type: allocType,
                                        amount: parseFormattedNumber(allocAmountDisplay),
                                        currency: allocCurrency
                                    })
                                    toast({ description: t('budget.allocationSaved', 'Budget allocation updated') })
                                } catch (error) {
                                    toast({ variant: 'destructive', description: t('common.error', 'Failed to save budget') })
                                    setIsAllocationDialogOpen(true)
                                } finally {
                                    setIsSaving(false)
                                }
                            }}
                            className="space-y-6"
                        >
                            <div className="space-y-3">
                                <Label className="text-sm font-medium text-slate-900 dark:text-white">
                                    {t('budget.form.type', 'Allocation Type')}
                                </Label>
                                <Select value={allocType} onValueChange={(val: any) => {
                                    setAllocType(val)
                                    if (val === 'percentage') {
                                        const numeric = parseFormattedNumber(allocAmountDisplay)
                                        if (numeric > 100) setAllocAmountDisplay("100")
                                    }
                                }}>
                                    <SelectTrigger className="h-14 rounded-2xl border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/50 text-base font-medium px-6">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="rounded-2xl border-slate-100 dark:border-zinc-800">
                                        <SelectItem value="fixed" className="rounded-xl">{t('budget.type.fixed', 'Fixed Amount')}</SelectItem>
                                        <SelectItem value="percentage" className="rounded-xl">{t('budget.type.percentage', 'Percentage of Revenue')}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-3">
                                    <Label className="text-sm font-black text-slate-900 dark:text-white">
                                        {t('budget.form.amount', 'Amount / %')}
                                    </Label>
                                    <div className="relative">
                                        <Input
                                            value={allocAmountDisplay}
                                            onChange={(e) => {
                                                let val = e.target.value;
                                                if (allocType === 'percentage') {
                                                    const numeric = parseFormattedNumber(val);
                                                    if (numeric > 100) val = "100";
                                                }
                                                setAllocAmountDisplay(formatNumberWithCommas(val));
                                            }}
                                            placeholder="0"
                                            className={cn(
                                                "h-14 rounded-2xl border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/50 text-base font-bold px-6",
                                                allocType === 'percentage' && "pr-10"
                                            )}
                                            required
                                        />
                                        {allocType === 'percentage' && (
                                            <div className="absolute right-6 top-1/2 -translate-y-1/2 text-slate-400 font-bold pointer-events-none">
                                                %
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    <Label className="text-sm font-black text-slate-900 dark:text-white">
                                        {t('budget.payroll.currency', 'Currency')}
                                    </Label>
                                    <Select value={allocCurrency} onValueChange={(val: any) => setAllocCurrency(val)}>
                                        <SelectTrigger className="h-14 rounded-2xl border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/50 text-base font-medium px-6">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className="rounded-2xl border-slate-100 dark:border-zinc-800">
                                            <SelectItem value="usd" className="rounded-xl">USD</SelectItem>
                                            <SelectItem value="iqd" className="rounded-xl">IQD</SelectItem>
                                            <SelectItem value="eur" className="rounded-xl">EUR</SelectItem>
                                            <SelectItem value="try" className="rounded-xl">TRY</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="p-8 bg-slate-50/50 dark:bg-zinc-900/50 rounded-[2rem] border border-slate-100 dark:border-zinc-800 space-y-6">
                                <div className="flex justify-between items-center">
                                    <h4 className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-400 dark:text-zinc-500">
                                        {t('budget.estimatedBudgetLimit', 'Proposed Budget Limit')}
                                    </h4>
                                    <p className="text-xl font-black text-slate-900 dark:text-white tabular-nums">
                                        {allocType === 'percentage' && isMonthlyFinancialsLoading ? (
                                            <LoadingValue className="h-6 w-24 bg-slate-200 dark:bg-zinc-800" />
                                        ) : formatCurrency(
                                            allocType === 'fixed'
                                                ? convertToStoreBase(parseFormattedNumber(allocAmountDisplay), allocCurrency)
                                                : metrics.referenceProfit * (parseFormattedNumber(allocAmountDisplay) / 100),
                                            baseCurrency,
                                            iqdPreference
                                        )}
                                    </p>
                                </div>

                                <div className="h-px bg-slate-100 dark:bg-zinc-800 w-full" />

                                <div className="flex justify-between items-center">
                                    <h4 className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-400 dark:text-zinc-500">
                                        {t('budget.actualSurplus', 'Projected Surplus')}
                                    </h4>
                                    <p className={cn(
                                        "text-xl font-black tabular-nums",
                                        (metrics.referenceProfit - (
                                            allocType === 'fixed'
                                                ? convertToStoreBase(parseFormattedNumber(allocAmountDisplay), allocCurrency)
                                                : metrics.referenceProfit * (parseFormattedNumber(allocAmountDisplay) / 100)
                                        )) >= 0 ? "text-teal-500" : "text-red-500"
                                    )}>
                                        {isMonthlyFinancialsLoading ? (
                                            <LoadingValue className="h-6 w-24 bg-slate-200 dark:bg-zinc-800" />
                                        ) : formatCurrency(
                                            metrics.referenceProfit - (
                                                allocType === 'fixed'
                                                    ? convertToStoreBase(parseFormattedNumber(allocAmountDisplay), allocCurrency)
                                                    : metrics.referenceProfit * (parseFormattedNumber(allocAmountDisplay) / 100)
                                            ),
                                            baseCurrency,
                                            iqdPreference
                                        )}
                                    </p>
                                </div>
                                <p className="text-xs text-slate-400 dark:text-zinc-500 italic font-medium">
                                    {t('budget.surplusNote', 'Remaining revenue after the proposed budget limit')}
                                </p>
                            </div>

                            <DialogFooter>
                                <Button
                                    type="submit"
                                    className="w-full h-16 rounded-2xl bg-[#1DA185] hover:bg-[#198f76] text-white text-lg font-black shadow-xl shadow-teal-500/10 transition-all active:scale-[0.98] border-none"
                                >
                                    {t('common.save', 'Save Allocation')}
                                </Button>
                            </DialogFooter>
                        </form>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={!!lockConfirmExpense} onOpenChange={(open) => !open && setLockConfirmExpense(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('budget.confirmLockSalary', 'Confirm Lock Salary')}</DialogTitle>
                        <DialogDescription>
                            {t('budget.confirmLockSalaryDesc', 'Are you sure you want to lock this salary? Once locked, it cannot be undone or marked as pending again for this month.')}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setLockConfirmExpense(null)}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button
                            className="bg-amber-600 hover:bg-amber-700 text-white"
                            onClick={handleConfirmLock}
                        >
                            {t('common.confirm', 'Confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Manage Snooze Modal */}
            <Dialog open={!!unsnoozeItem} onOpenChange={(open) => !open && setUnsnoozeItem(null)}>
                <DialogContent className="max-w-sm rounded-[2rem]">
                    <DialogHeader className="items-center text-center">
                        <div className="w-12 h-12 rounded-full bg-yellow-500/10 flex items-center justify-center mb-2">
                            <BellOff className="w-6 h-6 text-yellow-500" />
                        </div>
                        <DialogTitle>{t('budget.manageSnooze', 'Manage Snooze')}</DialogTitle>
                        <DialogDescription>
                            {unsnoozeItem?.title}
                            {unsnoozeItem?.snoozeUntil && (
                                <div className="mt-2 text-xs font-bold text-yellow-600 dark:text-yellow-500 bg-yellow-500/10 px-3 py-1.5 rounded-full inline-flex items-center gap-1.5">
                                    <Clock className="w-3 h-3" />
                                    {isIndefiniteSnooze(unsnoozeItem.snoozeUntil)
                                        ? t('budget.snoozedIndefinitely', 'Snoozed Until Un-snoozed')
                                        : `${t('budget.snoozedUntil', 'Snoozed until')} ${formatDate(unsnoozeItem.snoozeUntil)}`}
                                </div>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="flex-col sm:flex-col gap-2 mt-4">
                        <Button
                            className="w-full bg-yellow-600 hover:bg-yellow-700 text-white font-black h-12 rounded-xl"
                            onClick={async () => {
                                if (unsnoozeItem) {
                                    await handleUnsnooze(unsnoozeItem)
                                    setUnsnoozeItem(null)
                                }
                            }}
                        >
                            <RotateCcw className="w-4 h-4 mr-2" />
                            {t('budget.unsnooze', 'Un-snooze')}
                        </Button>
                        <Button variant="ghost" onClick={() => setUnsnoozeItem(null)} className="rounded-xl h-11">
                            {t('common.close', 'Close')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <BudgetReminderModal
                isOpen={reminderStep === 'reminder'}
                onPaid={handleReminderPaid}
                onSnooze={handleReminderSnoozeOpen}
                item={currentReminder}
                queuePosition={reminderIndex + 1}
                queueTotal={reminderQueue.length}
                iqdPreference={iqdPreference}
                isLoading={isProcessing}
            />
            <BudgetLockModal
                isOpen={reminderStep === 'lock'}
                onLock={handleReminderLock}
                onSkip={handleReminderLockSkip}
                item={currentReminder}
                isLoading={isProcessing}
            />
            <BudgetSnoozeModal
                isOpen={reminderStep === 'snooze'}
                onSnooze={handleReminderSnooze}
                onDismiss={() => setReminderStep('reminder')}
                item={currentReminder}
                iqdPreference={iqdPreference}
                isLoading={isProcessing}
            />
            <BudgetSnoozeModal
                isOpen={!!dividendSnoozeItem}
                onSnooze={handleDividendSnooze}
                onDismiss={() => setDividendSnoozeItem(null)}
                item={dividendSnoozeItem}
                iqdPreference={iqdPreference}
                isLoading={isProcessing}
            />
        </div>
    )
}

