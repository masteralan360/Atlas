
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    CalendarDays,
    CheckCircle2,
    Clock,
    Lock,
    Unlock,
    Plus,
    Wallet,
    Users,
    Receipt,
    User,
    Trash2
} from 'lucide-react'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import {
    findLatestUnreversedPaymentTransaction,
    recordObligationSettlement,
    reversePaymentTransaction,
    useBudgetSettings,
    setBudgetSettings,
    useBudgetAllocations,
    setBudgetAllocation,
    useExpenseSeries,
    useExpenseItems,
    createExpenseSeries,
    updateExpenseSeries,
    updateExpenseItem,
    deleteExpenseItem,
    hardDeleteExpenseSeries,
    ensureExpenseItemsForMonth,
    useEmployees,
    usePayrollStatuses,
    useDividendStatuses,
    upsertPayrollStatus,
    upsertDividendStatus,
    useSales,
    useSalesOrders,
    useTravelAgencySales,
    toUISale,
    toUISaleFromTravelAgency
} from '@/local-db'
import { db } from '@/local-db/database'
import type { BudgetStatus, CurrencyCode, ExpenseItem, ExpenseRecurrence, ExpenseSeries, IQDDisplayPreference, PaymentObligation, WorkspacePaymentMethod } from '@/local-db/models'
import {
    buildConversionRates,
    buildPayrollItems,
    buildDividendItems,
    type PayrollItem,
    monthKeyFromDate,
    addMonths,
    formatMonthLabel,
    buildDueDate
} from '@/lib/budget'
import { buildRevenueAnalysisRecords, calculateRevenueAnalysisNetProfitBase } from '@/lib/revenueAnalysis'
import { convertToStoreBase } from '@/lib/currency'
import { formatCurrency, formatDate, formatNumberWithCommas, parseFormattedNumber, cn } from '@/lib/utils'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    useToast,
    Progress,
    CurrencySelector,
    DeleteConfirmationModal,
    SettlementDialog
} from '@/ui/components'
import { BudgetSnoozeModal, type BudgetSnoozeOption } from '@/ui/components/budget/BudgetSnoozeModal'
import { BudgetLockPromptModal } from '@/ui/components/budget/BudgetLockPromptModal'
import { MonthlyBudgetAllocationModal } from '@/ui/components/budget/MonthlyBudgetAllocationModal'

interface ExpenseRow {
    item: ExpenseItem
    series: ExpenseSeries | null
}

interface SnoozeTarget {
    type: 'expense' | 'payroll' | 'dividend'
    item: ExpenseItem | ReturnType<typeof buildPayrollItems>[number] | ReturnType<typeof buildDividendItems>['items'][number]
}

interface LockTarget {
    type: 'expense' | 'payroll' | 'dividend'
    item: ExpenseItem | ReturnType<typeof buildPayrollItems>[number] | ReturnType<typeof buildDividendItems>['items'][number]
}

function buildExpensePaymentObligation(item: ExpenseItem, series: ExpenseSeries | null): PaymentObligation {
    return {
        id: `expense-item:${item.id}`,
        workspaceId: item.workspaceId,
        sourceModule: 'budget',
        sourceType: 'expense_item',
        sourceRecordId: item.id,
        sourceSubrecordId: item.seriesId,
        direction: 'outgoing',
        amount: item.amount,
        currency: item.currency,
        dueDate: item.dueDate,
        counterpartyName: null,
        referenceLabel: series?.name || 'Expense',
        title: series?.name || 'Expense',
        subtitle: series?.category || item.month,
        status: 'open',
        routePath: '/budget',
        metadata: {
            month: item.month,
            seriesId: item.seriesId
        }
    }
}

function buildPayrollPaymentObligation(
    workspaceId: string,
    month: string,
    item: PayrollItem,
    existingStatusId?: string | null
): PaymentObligation {
    return {
        id: `payroll-status:${item.employee.id}:${month}`,
        workspaceId,
        sourceModule: 'budget',
        sourceType: 'payroll_status',
        sourceRecordId: existingStatusId || `${item.employee.id}:${month}`,
        sourceSubrecordId: item.employee.id,
        direction: 'outgoing',
        amount: item.amount,
        currency: item.currency,
        dueDate: item.dueDate,
        counterpartyName: item.employee.name,
        referenceLabel: `Payroll ${month}`,
        title: item.employee.name,
        subtitle: item.employee.role,
        status: 'open',
        routePath: '/budget',
        metadata: {
            employeeId: item.employee.id,
            month
        }
    }
}


interface BudgetItemRowProps {
    title: string
    subtitle?: string
    amount: number
    currency: CurrencyCode
    status: BudgetStatus
    dueDate: string
    type: 'expense' | 'payroll' | 'dividend'
    isLocked: boolean
    iqdPreference: IQDDisplayPreference
    onPay: () => void
    onUnpay: () => void
    onSnooze: () => void
    onLock: () => void
    onEdit?: () => void
    onDelete?: () => void
    canEdit?: boolean
}

function BudgetItemRow({
    title,
    subtitle,
    amount,
    currency,
    status,
    dueDate,
    type,
    isLocked,
    iqdPreference,
    onPay,
    onUnpay,
    onSnooze,
    onLock,
    onEdit,
    onDelete,
    canEdit = true
}: BudgetItemRowProps) {
    const isPaid = status === 'paid'
    const isSnoozed = status === 'snoozed'

    // Background color logic correctly matches the user's request:
    // Unpaid payroll/dividends -> blue
    // Unpaid expenses -> orange
    // Paid -> green
    // Snoozed -> yellow
    const bgClass = isPaid
        ? 'bg-emerald-50/50 border-emerald-100/50 dark:bg-emerald-500/10 dark:border-emerald-500/20 hover:bg-emerald-50/80 dark:hover:bg-emerald-500/15'
        : isSnoozed
            ? 'bg-amber-50/50 border-amber-100/50 dark:bg-amber-500/10 dark:border-amber-500/20 hover:bg-amber-50/80 dark:hover:bg-amber-500/15'
            : type === 'expense'
                ? 'bg-orange-50/50 border-orange-100/50 dark:bg-orange-500/10 dark:border-orange-500/20 hover:bg-orange-50/80 dark:hover:bg-orange-500/15'
                : 'bg-blue-50/50 border-blue-100/50 dark:bg-blue-500/10 dark:border-blue-500/20 hover:bg-blue-50/80 dark:hover:bg-blue-500/15'

    const accentColor = isPaid
        ? 'text-emerald-600 dark:text-emerald-400'
        : isSnoozed
            ? 'text-amber-600 dark:text-amber-400'
            : type === 'expense'
                ? 'text-orange-600 dark:text-orange-400'
                : 'text-blue-600 dark:text-blue-400'

    const iconBg = isPaid
        ? 'bg-emerald-100/80 dark:bg-emerald-500/20'
        : isSnoozed
            ? 'bg-amber-100/80 dark:bg-amber-500/20'
            : type === 'expense'
                ? 'bg-orange-100/80 dark:bg-orange-500/20'
                : 'bg-blue-100/80 dark:bg-blue-500/20'

    const Icon = type === 'payroll' ? User : type === 'dividend' ? Wallet : Receipt

    return (
        <div className={cn(
            "group flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 rounded-2xl border p-4 transition-all duration-200",
            bgClass
        )}>
            <div className="flex items-start sm:items-center justify-between sm:justify-start w-full sm:w-auto">
                <div className="flex items-center gap-4">
                    <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl transition-colors shrink-0", iconBg)}>
                        <Icon className={cn("h-5 w-5", accentColor)} />
                    </div>
                    <div className="space-y-0.5">
                        <p className="text-base font-bold tracking-tight text-foreground">{title}</p>
                        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-xs font-bold text-muted-foreground/80 uppercase tracking-tight">
                            <span>{type}</span>
                            {subtitle && (
                                <>
                                    <span>/</span>
                                    <span className="calendar-icon-inline flex items-center gap-1 whitespace-nowrap">
                                        <CalendarDays className="h-3 w-3" />
                                        {formatDate(dueDate)}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                <div className="text-right sm:hidden ml-4 pt-0.5">
                    <p className={cn("text-lg font-black tracking-tight leading-tight", accentColor)}>
                        {formatCurrency(amount, currency, iqdPreference)}
                    </p>
                </div>
            </div>

            <div className="flex items-center justify-end gap-6 pt-3 sm:pt-0 border-t sm:border-t-0 border-border/50 sm:border-transparent w-full sm:w-auto mt-1 sm:mt-0">
                <div className="text-right hidden sm:block">
                    <p className={cn("text-lg font-black tracking-tight", accentColor)}>
                        {formatCurrency(amount, currency, iqdPreference)}
                    </p>
                </div>

                <div className="flex items-center justify-end w-full sm:w-auto gap-1.5">
                    {onEdit && canEdit && !isLocked && !isPaid && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full text-muted-foreground/40 hover:text-foreground hover:bg-background/80"
                            onClick={onEdit}
                        >
                            <Plus className="h-4 w-4 rotate-45" />
                        </Button>
                    )}

                    {!isPaid && canEdit && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                                "h-8 w-8 rounded-full transition-colors",
                                isSnoozed ? "bg-amber-100 text-amber-600" : "text-muted-foreground/40 hover:text-foreground hover:bg-background/80"
                            )}
                            onClick={onSnooze}
                            disabled={isLocked}
                        >
                            <Clock className="h-4 w-4" />
                        </Button>
                    )}

                    {isPaid && canEdit && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                                "h-8 w-8 rounded-full transition-colors",
                                isLocked ? "bg-blue-50 text-blue-600" : "text-muted-foreground/40 hover:text-foreground hover:bg-background/80"
                            )}
                            onClick={onLock}
                        >
                            {isLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                        </Button>
                    )}

                    {onDelete && canEdit && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10"
                            onClick={onDelete}
                        >
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    )}

                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                            "ml-2 h-9 w-9 rounded-full border-2 transition-all duration-300",
                            isPaid
                                ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600"
                                : "border-slate-200 text-slate-200 hover:border-emerald-400 hover:text-emerald-400"
                        )}
                        onClick={isPaid ? onUnpay : onPay}
                        disabled={isLocked || !canEdit}
                    >
                        {isPaid ? <CheckCircle2 className="h-5 w-5" /> : <div className="h-5 w-5 rounded-full" />}
                    </Button>
                </div>
            </div>
        </div>
    )
}

function SummaryCard({
    title,
    value,
    secondaryValue,
    icon: Icon,
    subtitle,
    progress,
    tone
}: {
    title: string
    value: string
    secondaryValue?: string
    icon: React.ComponentType<{ className?: string }>
    subtitle?: string
    progress?: number
    tone?: 'emerald' | 'amber' | 'blue' | 'orange' | 'sky' | 'cyan' | 'purple' | 'rose'
}) {
    const toneClass = tone === 'emerald'
        ? 'text-emerald-600'
        : tone === 'amber'
            ? 'text-amber-600'
            : tone === 'blue'
                ? 'text-blue-600'
                : tone === 'sky'
                    ? 'text-sky-600'
                    : tone === 'cyan'
                        ? 'text-cyan-600'
                        : tone === 'purple'
                            ? 'text-purple-600'
                            : tone === 'rose'
                                ? 'text-rose-600'
                                : 'text-orange-600'

    const indicatorClass = tone === 'emerald'
        ? 'bg-emerald-500'
        : tone === 'amber'
            ? 'bg-amber-500'
            : tone === 'blue'
                ? 'bg-blue-500'
                : tone === 'sky'
                    ? 'bg-sky-500'
                    : tone === 'cyan'
                        ? 'bg-cyan-500'
                        : tone === 'purple'
                            ? 'bg-purple-500'
                            : tone === 'rose'
                                ? 'bg-rose-500'
                                : 'bg-orange-500'

    return (
        <Card className="rounded-2xl border border-border/40 shadow-sm bg-card/40 backdrop-blur-sm">
            <CardContent className="p-5 space-y-2.5">
                <div className="flex items-center gap-2">
                    <Icon className={cn("h-4 w-4", toneClass)} />
                    <p className={cn("text-xs font-black uppercase tracking-[0.1em]", toneClass)}>{title}</p>
                </div>

                <div className="flex items-baseline gap-2">
                    <p className={cn("text-3xl font-black tracking-tight", toneClass)}>{value}</p>
                    {secondaryValue && (
                        <p className="text-xs font-bold text-muted-foreground">{secondaryValue}</p>
                    )}
                </div>

                {typeof progress === 'number' ? (
                    <Progress
                        value={Math.max(0, Math.min(progress, 100))}
                        className="h-1.5 bg-muted/30"
                        indicatorClassName={indicatorClass}
                    />
                ) : (
                    <div className="h-1.5" /> /* Spacer to keep height consistent */
                )}

                {subtitle && <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{subtitle}</p>}
            </CardContent>
        </Card>
    )
}

export function Budget() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const { features } = useWorkspace()
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()

    const workspaceId = user?.workspaceId
    const baseCurrency = (features.default_currency || 'usd') as CurrencyCode
    const iqdPreference = features.iqd_display_preference

    const budgetSettingsList = useBudgetSettings(workspaceId)
    const budgetSettings = budgetSettingsList?.[0]
    const isBudgetLoading = budgetSettingsList === undefined

    const budgetAllocations = useBudgetAllocations(workspaceId)
    const expenseSeries = useExpenseSeries(workspaceId)
    const employees = useEmployees(workspaceId)
    const payrollStatuses = usePayrollStatuses(workspaceId)
    const dividendStatuses = useDividendStatuses(workspaceId)
    const rawSales = useSales(workspaceId)
    const salesOrders = useSalesOrders(workspaceId)
    const rawTravelSales = useTravelAgencySales(workspaceId)
    const sales = useMemo(() => rawSales.map(toUISale), [rawSales])
    const travelSales = useMemo(
        () => (rawTravelSales || [])
            .filter(sale => sale.isPaid && !sale.isDeleted)
            .map(toUISaleFromTravelAgency),
        [rawTravelSales]
    )
    const revenueRecords = useMemo(
        () => buildRevenueAnalysisRecords(sales, salesOrders, travelSales),
        [sales, salesOrders, travelSales]
    )

    const rates = useMemo(() => buildConversionRates(exchangeData, eurRates, tryRates), [exchangeData, eurRates, tryRates])

    const currentMonthKey = monthKeyFromDate(new Date())
    const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthKey)

    const [isStartMonthModalOpen, setIsStartMonthModalOpen] = useState(false)
    const [startMonthInput, setStartMonthInput] = useState(currentMonthKey)

    const [isAllocationModalOpen, setIsAllocationModalOpen] = useState(false)

    const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false)
    const [editingSeries, setEditingSeries] = useState<ExpenseSeries | null>(null)
    const [editingItem, setEditingItem] = useState<ExpenseItem | null>(null)
    const [expenseName, setExpenseName] = useState('')
    const [expenseAmount, setExpenseAmount] = useState('')
    const [expenseCurrency, setExpenseCurrency] = useState<CurrencyCode>(baseCurrency)
    const [expenseDueDay, setExpenseDueDay] = useState(1)
    const [expenseRecurrence, setExpenseRecurrence] = useState<ExpenseRecurrence>('monthly')
    const [expenseCategory, setExpenseCategory] = useState('')
    const [expenseSubcategory, setExpenseSubcategory] = useState('')

    const [deleteTarget, setDeleteTarget] = useState<{
        type: 'series' | 'occurrence';
        series?: ExpenseSeries | null;
        item?: ExpenseItem | null
    } | null>(null)

    const [snoozeTarget, setSnoozeTarget] = useState<SnoozeTarget | null>(null)
    const [lockTarget, setLockTarget] = useState<LockTarget | null>(null)
    const [settlementTarget, setSettlementTarget] = useState<PaymentObligation | null>(null)
    const [isSubmittingSettlement, setIsSubmittingSettlement] = useState(false)

    const expenseItems = useExpenseItems(workspaceId, selectedMonth)

    // Only open modal if we're not loading and settings are explicitly missing
    useEffect(() => {
        if (!isBudgetLoading && !budgetSettings && workspaceId) {
            setIsStartMonthModalOpen(true)
        }
    }, [isBudgetLoading, budgetSettings, workspaceId])

    // Update form and AUTO-CLOSE modal if settings arrive
    useEffect(() => {
        if (budgetSettings?.startMonth) {
            setStartMonthInput(budgetSettings.startMonth as any)
            setIsStartMonthModalOpen(false) // Auto-close precisely if settings arrive
            if (selectedMonth < budgetSettings.startMonth) {
                setSelectedMonth(budgetSettings.startMonth as any)
            }
        }
    }, [budgetSettings, selectedMonth])

    useEffect(() => {
        if (!workspaceId) return
        void ensureExpenseItemsForMonth(workspaceId, selectedMonth).catch((error) => {
            console.error('[Budget] ensureExpenseItemsForMonth failed', error)
        })
    }, [workspaceId, selectedMonth, expenseSeries.length])


    useEffect(() => {
        if (!editingSeries) return
        setExpenseName(editingSeries.name)
        setExpenseAmount(formatNumberWithCommas(editingSeries.amount || 0))
        setExpenseCurrency(editingSeries.currency)
        setExpenseDueDay(editingSeries.dueDay)
        setExpenseRecurrence(editingSeries.recurrence)
        setExpenseCategory(editingSeries.category || '')
        setExpenseSubcategory(editingSeries.subcategory || '')
    }, [editingSeries])

    const monthOptions = useMemo(() => {
        const startMonth = budgetSettings?.startMonth || currentMonthKey
        const candidates = [currentMonthKey, addMonths(currentMonthKey as any, 6)]

        budgetAllocations.forEach(entry => candidates.push(entry.month as any))
        expenseSeries.forEach(series => {
            candidates.push(series.startMonth as any)
            if (series.endMonth) candidates.push(series.endMonth as any)
        })

        let maxMonth = candidates.reduce((max, value) => value > max ? value : max, candidates[0])

        const options: Array<{ value: string; label: string }> = []
        let cursor = startMonth
        while (cursor <= maxMonth) {
            options.push({
                value: cursor,
                label: formatMonthLabel(cursor as any, i18n.language)
            })
            cursor = addMonths(cursor as any, 1)
        }
        return options
    }, [budgetSettings?.startMonth, currentMonthKey, budgetAllocations, expenseSeries, i18n.language])

    const seriesById = useMemo(() => new Map(expenseSeries.map(series => [series.id, series] as const)), [expenseSeries])

    const expenseRows = useMemo<ExpenseRow[]>(() => {
        return expenseItems.map(item => ({
            item,
            series: seriesById.get(item.seriesId) || null
        }))
    }, [expenseItems, seriesById])

    const operationalTotals = useMemo(() => {
        let totalBase = 0
        let paidBase = 0
        const outstandingBase: number[] = []

        expenseRows.forEach(({ item }) => {
            const base = convertToStoreBase(item.amount, item.currency, baseCurrency, rates)
            totalBase += base
            if (item.status === 'paid') {
                paidBase += base
            } else {
                outstandingBase.push(base)
            }
        })

        return {
            totalBase,
            paidBase,
            outstandingBase: outstandingBase.reduce((sum, value) => sum + value, 0)
        }
    }, [expenseRows, baseCurrency, rates])

    const payrollItems = useMemo(
        () => buildPayrollItems(employees, payrollStatuses, selectedMonth as any),
        [employees, payrollStatuses, selectedMonth]
    )

    const payrollTotals = useMemo(() => {
        let totalBase = 0
        let paidBase = 0
        payrollItems.forEach(item => {
            const base = convertToStoreBase(item.amount, item.currency, baseCurrency, rates)
            totalBase += base
            if (item.status === 'paid') {
                paidBase += base
            }
        })
        return { totalBase, paidBase }
    }, [payrollItems, baseCurrency, rates])

    const monthRevenueRecords = useMemo(
        () => revenueRecords.filter(record => monthKeyFromDate(record.date) === selectedMonth),
        [revenueRecords, selectedMonth]
    )

    const netProfitBase = useMemo(
        () => calculateRevenueAnalysisNetProfitBase(monthRevenueRecords, baseCurrency, rates),
        [monthRevenueRecords, baseCurrency, rates]
    )

    const surplusPoolBase = netProfitBase - operationalTotals.totalBase - payrollTotals.totalBase

    const dividendResult = useMemo(
        () => buildDividendItems(employees, dividendStatuses, selectedMonth as any, baseCurrency, rates, surplusPoolBase),
        [employees, dividendStatuses, selectedMonth, baseCurrency, rates, surplusPoolBase]
    )

    const totalItemsCount = expenseRows.length + payrollItems.length
    const totalAllocatedBase = operationalTotals.totalBase + payrollTotals.totalBase
    const totalPaidBase = operationalTotals.paidBase + payrollTotals.paidBase
    const totalOutstandingBase = totalAllocatedBase - totalPaidBase
    const surplusRemainderBase = netProfitBase - operationalTotals.totalBase - payrollTotals.totalBase - dividendResult.totalBase


    const currentBudgetAllocation = useMemo(() => {
        return (budgetAllocations as any[]).find(a => a.month === selectedMonth)
    }, [budgetAllocations, selectedMonth])

    const calculatedBudgetLimitBase = useMemo(() => {
        if (!currentBudgetAllocation) return netProfitBase
        const value = currentBudgetAllocation.allocationValue || 0
        const isPercent = currentBudgetAllocation.allocationType === 'percentage'
        const limitInCurrency = isPercent ? (netProfitBase * value / 100) : value
        return convertToStoreBase(limitInCurrency, currentBudgetAllocation.currency, baseCurrency, rates)
    }, [currentBudgetAllocation, netProfitBase, baseCurrency, rates])

    const budgetUsageRatio = calculatedBudgetLimitBase > 0 ? (totalAllocatedBase / calculatedBudgetLimitBase) * 100 : 0

    const handleSaveStartMonth = async () => {
        if (!workspaceId) return
        try {
            await setBudgetSettings(workspaceId, startMonthInput)
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.startPoint') || 'Budget start month updated.'
            })
            setIsStartMonthModalOpen(false)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to save budget settings.',
                variant: 'destructive'
            })
        }
    }

    const handleSaveAllocation = async (type: 'fixed' | 'percentage', value: number, currency: CurrencyCode) => {
        if (!workspaceId) return
        try {
            await setBudgetAllocation(workspaceId, selectedMonth, currency, type, value)
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.allocationSaved') || 'Budget allocation updated.'
            })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to save budget allocation.',
                variant: 'destructive'
            })
        }
    }

    const resetExpenseForm = () => {
        setExpenseName('')
        setExpenseAmount('')
        setExpenseCurrency(baseCurrency)
        setExpenseDueDay(1)
        setExpenseRecurrence('monthly')
        setExpenseCategory('')
        setExpenseSubcategory('')
        setEditingSeries(null)
        setEditingItem(null)
    }

    const handleSaveExpense = async () => {
        if (!workspaceId) return

        const amountValue = parseFormattedNumber(expenseAmount || '0')
        if (!expenseName.trim() || amountValue <= 0) {
            toast({
                title: t('common.error') || 'Error',
                description: t('budget.expenseInvalid') || 'Enter a name and amount.'
            })
            return
        }

        const dueDay = Math.min(Math.max(Number(expenseDueDay) || 1, 1), 31)

        try {
            if (editingSeries) {
                await updateExpenseSeries(editingSeries.id, {
                    name: expenseName.trim(),
                    amount: amountValue,
                    currency: expenseCurrency,
                    dueDay,
                    recurrence: expenseRecurrence,
                    category: expenseCategory.trim() || null,
                    subcategory: expenseSubcategory.trim() || null
                })

                if (editingItem) {
                    await updateExpenseItem(editingItem.id, {
                        amount: amountValue,
                        currency: expenseCurrency,
                        dueDate: buildDueDate(selectedMonth as any, dueDay)
                    })
                }
            } else {
                await createExpenseSeries(workspaceId, {
                    name: expenseName.trim(),
                    amount: amountValue,
                    currency: expenseCurrency,
                    dueDay,
                    recurrence: expenseRecurrence,
                    startMonth: selectedMonth,
                    endMonth: null,
                    category: expenseCategory.trim() || null,
                    subcategory: expenseSubcategory.trim() || null
                })
                await ensureExpenseItemsForMonth(workspaceId, selectedMonth)
            }

            toast({
                title: t('common.success') || 'Success',
                description: t('budget.expenseSaved') || 'Expense saved.'
            })
            setIsExpenseModalOpen(false)
            resetExpenseForm()
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to save expense.',
                variant: 'destructive'
            })
        }
    }

    const handleBudgetSettlement = async (input: { paymentMethod: WorkspacePaymentMethod; paidAt: string; note?: string }) => {
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
            toast({
                title: t('common.success') || 'Success',
                description: settlementTarget.sourceType === 'payroll_status'
                    ? 'Payroll payment recorded.'
                    : 'Expense payment recorded.'
            })
            setSettlementTarget(null)
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

    const handleMarkPaid = async (target: LockTarget) => {
        try {
            if (!workspaceId) return
            if (target.type === 'expense') {
                const item = target.item as ExpenseItem
                const series = expenseSeries.find((entry) => entry.id === item.seriesId) || null
                setSettlementTarget(buildExpensePaymentObligation(item, series))
                return
            } else if (target.type === 'payroll') {
                const item = target.item as ReturnType<typeof buildPayrollItems>[number]
                const existingStatus = payrollStatuses.find(
                    (entry) => entry.employeeId === item.employee.id && entry.month === selectedMonth && !entry.isDeleted
                )
                setSettlementTarget(buildPayrollPaymentObligation(workspaceId, selectedMonth, item, existingStatus?.id))
                return
            } else if (target.type === 'dividend') {
                const now = new Date().toISOString()
                const item = target.item as ReturnType<typeof buildDividendItems>['items'][number]
                await upsertDividendStatus(workspaceId, item.employee.id, selectedMonth, {
                    status: 'paid',
                    paidAt: now,
                    snoozedUntil: null,
                    snoozedIndefinite: false
                })
            }
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.reminder.paid') || 'Marked as paid.'
            })
            setLockTarget(target)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to mark paid.',
                variant: 'destructive'
            })
        }
    }

    const handleMarkUnpaid = async (target: LockTarget) => {
        try {
            if (!workspaceId) return
            if (Boolean((target.item as { isLocked?: boolean }).isLocked)) {
                return
            }
            if (target.type === 'expense') {
                const item = target.item as ExpenseItem
                const transaction = await findLatestUnreversedPaymentTransaction(workspaceId, {
                    sourceType: 'expense_item',
                    sourceRecordId: item.id,
                    sourceSubrecordId: item.seriesId
                })
                if (!transaction) {
                    throw new Error('No posted payment was found for this expense.')
                }
                await reversePaymentTransaction(workspaceId, transaction.id, {
                    createdBy: user?.id || null
                })
            } else if (target.type === 'payroll') {
                const item = target.item as ReturnType<typeof buildPayrollItems>[number]
                const existingStatus = payrollStatuses.find(
                    (entry) => entry.employeeId === item.employee.id && entry.month === selectedMonth && !entry.isDeleted
                )
                const transaction = await findLatestUnreversedPaymentTransaction(workspaceId, {
                    sourceType: 'payroll_status',
                    sourceRecordId: existingStatus?.id || `${item.employee.id}:${selectedMonth}`,
                    sourceSubrecordId: item.employee.id,
                    metadata: {
                        employeeId: item.employee.id,
                        month: selectedMonth
                    }
                })
                if (!transaction) {
                    throw new Error('No posted payment was found for this payroll entry.')
                }
                await reversePaymentTransaction(workspaceId, transaction.id, {
                    createdBy: user?.id || null
                })
            } else if (target.type === 'dividend') {
                const item = target.item as ReturnType<typeof buildDividendItems>['items'][number]
                await upsertDividendStatus(workspaceId, item.employee.id, selectedMonth, {
                    status: 'pending',
                    paidAt: null,
                    snoozedUntil: null,
                    snoozedIndefinite: false
                })
            }
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.reminder.unpaid') || 'Marked as unpaid.'
            })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || (t('budget.reminder.payFailed') || 'Failed to update payment.'),
                variant: 'destructive'
            })
        }
    }

    const handleLockConfirm = async (target: LockTarget | null) => {
        if (!target || !workspaceId) return
        try {
            if (target.type === 'expense') {
                await updateExpenseItem((target.item as ExpenseItem).id, { isLocked: true })
            } else if (target.type === 'payroll') {
                const item = target.item as ReturnType<typeof buildPayrollItems>[number]
                await upsertPayrollStatus(workspaceId, item.employee.id, selectedMonth, { isLocked: true })
            } else if (target.type === 'dividend') {
                const item = target.item as ReturnType<typeof buildDividendItems>['items'][number]
                await upsertDividendStatus(workspaceId, item.employee.id, selectedMonth, { isLocked: true })
            }
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to lock item.',
                variant: 'destructive'
            })
        } finally {
            setLockTarget(null)
        }
    }

    const handleSnooze = async (target: SnoozeTarget, option: BudgetSnoozeOption) => {
        if (!workspaceId) return
        const now = new Date()
        const snoozedUntil = option.indefinite
            ? null
            : new Date(now.getTime() + (option.minutes || 0) * 60 * 1000).toISOString()

        try {
            if (target.type === 'expense') {
                const item = target.item as ExpenseItem
                await updateExpenseItem(item.id, {
                    status: 'snoozed',
                    snoozedUntil,
                    snoozedIndefinite: option.indefinite ?? false,
                    snoozeCount: (item.snoozeCount || 0) + 1,
                    paidAt: null
                })
            } else if (target.type === 'payroll') {
                const item = target.item as ReturnType<typeof buildPayrollItems>[number]
                await upsertPayrollStatus(workspaceId, item.employee.id, selectedMonth, {
                    status: 'snoozed',
                    snoozedUntil,
                    snoozedIndefinite: option.indefinite ?? false,
                    snoozeCount: (item.snoozeCount || 0) + 1,
                    paidAt: null
                })
            } else if (target.type === 'dividend') {
                const item = target.item as ReturnType<typeof buildDividendItems>['items'][number]
                await upsertDividendStatus(workspaceId, item.employee.id, selectedMonth, {
                    status: 'snoozed',
                    snoozedUntil,
                    snoozedIndefinite: option.indefinite ?? false,
                    snoozeCount: (item.snoozeCount || 0) + 1,
                    paidAt: null
                })
            }
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to snooze item.',
                variant: 'destructive'
            })
        }
    }

    const handleDeleteSeries = async (series: ExpenseSeries) => {
        try {
            if (series.recurrence === 'one_time') {
                await hardDeleteExpenseSeries(series.id)
                toast({
                    title: t('common.success') || 'Success',
                    description: t('budget.expenseDeleted') || 'Expense deleted.'
                })
                return
            }

            await updateExpenseSeries(series.id, { isDeleted: true })
            const relatedItems = await db.expense_items.where('seriesId').equals(series.id).toArray()
            for (const item of relatedItems) {
                if (!item.isDeleted) {
                    await deleteExpenseItem(item.id)
                }
            }
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.deleteSeries') || 'Series deleted.'
            })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to delete series.',
                variant: 'destructive'
            })
        }
    }

    const handleDeleteOccurrence = async (item: ExpenseItem) => {
        try {
            await deleteExpenseItem(item.id)
            toast({
                title: t('common.success') || 'Success',
                description: t('budget.deletedOccurrenceKeepsSeries') || 'Deleted this month item. Recurring series is still active.'
            })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to delete expense.',
                variant: 'destructive'
            })
        }
    }

    if (!workspaceId) {
        return null
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-4xl font-bold tracking-tight">{t('budget.title') || 'Accounting'}</h1>
                    <p className="text-base font-medium text-muted-foreground">{t('budget.subtitle') || 'Track and manage your expenses'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                        <SelectTrigger className="min-w-[180px]" allowViewer={true}>
                            <SelectValue placeholder={t('budget.startPoint') || 'Select month'} />
                        </SelectTrigger>
                        <SelectContent>
                            {monthOptions.map(option => (
                                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button 
                        variant="outline" 
                        onClick={() => setIsAllocationModalOpen(true)} 
                        className="h-10 rounded-xl border-slate-200 px-4 font-semibold text-slate-600 hover:bg-slate-50"
                        disabled={!canEdit}
                    >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {t('budget.setBudget') || 'Set Budget'}
                    </Button>
                    <Button 
                        variant="outline" 
                        onClick={() => setIsStartMonthModalOpen(true)} 
                        className="h-10 rounded-xl"
                        disabled={!canEdit}
                    >
                        <CalendarDays className="mr-2 h-4 w-4 text-muted-foreground" />
                        {t('budget.startPoint') || 'Start'}
                    </Button>
                </div>
            </div>

            <MonthlyBudgetAllocationModal
                open={isAllocationModalOpen}
                onOpenChange={setIsAllocationModalOpen}
                revenue={netProfitBase}
                baseCurrency={baseCurrency}
                iqdPreference={iqdPreference ? "د.ع" : "IQD"}
                onSave={handleSaveAllocation}
                currentAllocation={(() => {
                    const alloc = (budgetAllocations as any[]).find(a => a.month === selectedMonth)
                    if (!alloc) return undefined
                    return {
                        type: alloc.allocationType || 'fixed',
                        value: alloc.allocationValue || 0,
                        currency: alloc.currency
                    }
                })()}
            />


            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <SummaryCard
                    title={t('budget.totalAllocated') || 'Total Allocated'}
                    value={formatCurrency(totalAllocatedBase, baseCurrency, iqdPreference)}
                    secondaryValue={`/ ${formatCurrency(calculatedBudgetLimitBase, baseCurrency, iqdPreference)}`}
                    subtitle={`${totalItemsCount} items · ${(budgetUsageRatio).toFixed(0)}% of budget used`}
                    icon={Wallet}
                    tone={budgetUsageRatio > 100 ? 'rose' : 'blue'}
                    progress={budgetUsageRatio}
                />
                <SummaryCard
                    title={t('budget.paid') || 'Total Paid for the Month'}
                    value={formatCurrency(totalPaidBase, baseCurrency, iqdPreference)}
                    subtitle={`${(totalAllocatedBase > 0 ? (totalPaidBase / totalAllocatedBase) * 100 : 100).toFixed(1)}% paid`}
                    icon={CheckCircle2}
                    tone="emerald"
                    progress={totalAllocatedBase > 0 ? (totalPaidBase / totalAllocatedBase) * 100 : 0}
                />
                <SummaryCard
                    title={t('budget.pending') || 'Outstanding'}
                    value={formatCurrency(totalOutstandingBase, baseCurrency, iqdPreference)}
                    subtitle="due by end of month"
                    icon={Clock}
                    tone="orange"
                    progress={totalAllocatedBase > 0 ? (totalOutstandingBase / totalAllocatedBase) * 100 : 0}
                />
                <SummaryCard
                    title={t('budget.dividends') || 'Dividends'}
                    value={formatCurrency(dividendResult.totalBase, baseCurrency, iqdPreference)}
                    subtitle="profit share distribution"
                    icon={Users}
                    tone="sky"
                />
                <SummaryCard
                    title={t('budget.netProfit') || 'Surplus'}
                    value={formatCurrency(surplusRemainderBase, baseCurrency, iqdPreference)}
                    subtitle="projected surplus"
                    icon={Wallet}
                    tone="purple"
                />
            </div>

            <Tabs defaultValue="expenses" className="space-y-4">
                <TabsList className="grid w-full max-w-[400px] grid-cols-2 rounded-2xl bg-secondary/50 p-1">
                    <TabsTrigger value="expenses" className="rounded-xl text-sm font-bold uppercase">
                        {t('budget.tabs.monthlyExpenses') || 'Monthly Expenses'}
                    </TabsTrigger>
                    <TabsTrigger value="dividends" className="rounded-xl text-sm font-bold uppercase">
                        {t('budget.tabs.dividendsWithdrawal') || 'Dividends Withdrawal'}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="expenses" className="space-y-6">
                    <Card className="rounded-2xl border border-border/60">
                        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <CardTitle className="text-xl">{t('budget.expenseList') || 'Monthly Expenses'}</CardTitle>
                                <p className="text-sm font-medium text-muted-foreground">{t('budget.addExpenseSubtitle') || 'Add a manual cost to your monthly tracks'}</p>
                            </div>
                            {canEdit && (
                                <Button onClick={() => { resetExpenseForm(); setIsExpenseModalOpen(true) }}>
                                    <Plus className="mr-2 h-4 w-4" />
                                    {t('budget.addExpense') || 'New Expense'}
                                </Button>
                            )}
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {expenseRows.length === 0 && (
                                <div className="text-base font-medium text-muted-foreground">{t('budget.emptyExpenses') || 'No expenses for this month.'}</div>
                            )}
                            {expenseRows.map(({ item, series }) => (
                                <BudgetItemRow
                                    key={item.id}
                                    title={series?.name || t('budget.deletedSeries') || 'Deleted Series'}
                                    subtitle={series?.category || t('monthlyComparison.fallback.uncategorized')}
                                    amount={item.amount}
                                    currency={item.currency}
                                    status={item.status}
                                    dueDate={item.dueDate}
                                    type="expense"
                                    isLocked={!!item.isLocked}
                                    iqdPreference={iqdPreference}
                                    canEdit={canEdit}
                                    onPay={() => handleMarkPaid({ type: 'expense', item })}
                                    onUnpay={() => handleMarkUnpaid({ type: 'expense', item })}
                                    onSnooze={() => setSnoozeTarget({ type: 'expense', item })}
                                    onLock={() => { void handleLockConfirm({ type: 'expense', item }) }}
                                    onEdit={series ? () => {
                                        setEditingSeries(series)
                                        setEditingItem(item)
                                        setIsExpenseModalOpen(true)
                                    } : undefined}
                                    onDelete={item.status === 'pending' ? () => {
                                        setDeleteTarget({
                                            type: series?.recurrence === 'one_time' ? 'series' : 'occurrence',
                                            item,
                                            series
                                        })
                                    } : undefined}
                                />
                            ))}
                        </CardContent>
                    </Card>

                    <Card className="rounded-2xl border border-border/60">
                        <CardHeader>
                            <CardTitle className="text-xl">{t('monthlyComparison.fallback.payroll') || 'Payroll'}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {payrollItems.length === 0 && (
                                <div className="text-base font-medium text-muted-foreground">{t('budget.emptyPayroll') || 'No payroll entries for this month.'}</div>
                            )}
                            {payrollItems.map(item => (
                                <BudgetItemRow
                                    key={item.employee.id}
                                    title={item.employee.name}
                                    subtitle={item.employee.role}
                                    amount={item.amount}
                                    currency={item.currency}
                                    status={item.status}
                                    dueDate={item.dueDate}
                                    type="payroll"
                                    isLocked={!!item.isLocked}
                                    iqdPreference={iqdPreference}
                                    onPay={() => handleMarkPaid({ type: 'payroll', item })}
                                    onUnpay={() => handleMarkUnpaid({ type: 'payroll', item })}
                                    onSnooze={() => setSnoozeTarget({ type: 'payroll', item })}
                                    onLock={() => { void handleLockConfirm({ type: 'payroll', item }) }}
                                />
                            ))}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="dividends" className="space-y-6">
                    <Card className="rounded-2xl border border-border/60">
                        <CardHeader>
                            <CardTitle className="text-xl">{t('budget.dividendsWithdrawal.title') || 'Dividends Withdrawal'}</CardTitle>
                            <p className="text-sm font-medium text-muted-foreground">{t('budget.dividendsWithdrawal.subtitle') || 'Review and distribute this month dividends'}</p>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="flex flex-wrap gap-4 text-base font-medium text-muted-foreground">
                                <span>{t('budget.totalPool') || 'Total Distribution Pool'}: {formatCurrency(surplusPoolBase, baseCurrency, iqdPreference)}</span>
                                <span>{t('budget.dividends') || 'Dividends'}: {formatCurrency(dividendResult.totalBase, baseCurrency, iqdPreference)}</span>
                                <span>{t('budget.remainingAfterDivs') || 'Remaining After Distribution'}: {formatCurrency(surplusRemainderBase, baseCurrency, iqdPreference)}</span>
                            </div>
                            {dividendResult.items.length === 0 && (
                                <div className="text-base font-medium text-muted-foreground">{t('budget.dividend.empty') || 'No dividend withdrawals for this month'}</div>
                            )}
                            {dividendResult.items.map(item => (
                                <BudgetItemRow
                                    key={item.employee.id}
                                    title={item.employee.name}
                                    subtitle={item.type === 'percentage' ? `${item.employee.dividendAmount || 0}%` : t('budget.fixedDividend') || 'Fixed'}
                                    amount={item.amount}
                                    currency={item.currency}
                                    status={item.status}
                                    dueDate={item.dueDate}
                                    type="dividend"
                                    isLocked={!!item.isLocked}
                                    iqdPreference={iqdPreference}
                                    onPay={() => handleMarkPaid({ type: 'dividend', item })}
                                    onUnpay={() => handleMarkUnpaid({ type: 'dividend', item })}
                                    onSnooze={() => setSnoozeTarget({ type: 'dividend', item })}
                                    onLock={() => { void handleLockConfirm({ type: 'dividend', item }) }}
                                />
                            ))}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            <Dialog open={isExpenseModalOpen} onOpenChange={(open) => { if (!open) resetExpenseForm(); setIsExpenseModalOpen(open) }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{editingSeries ? t('common.edit') : t('budget.addExpense') || 'New Expense'}</DialogTitle>
                        <DialogDescription>{t('budget.addExpenseSubtitle') || 'Add a manual cost to your monthly tracks'}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4">
                        <div className="grid gap-2">
                            <Label>{t('common.description') || 'Description'}</Label>
                            <Input value={expenseName} onChange={(e) => setExpenseName(e.target.value)} />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                            <div className="grid gap-2">
                                <Label>{t('common.amount') || 'Amount'}</Label>
                                <Input value={expenseAmount} onChange={(e) => setExpenseAmount(formatNumberWithCommas(e.target.value))} />
                            </div>
                            <CurrencySelector value={expenseCurrency} onChange={setExpenseCurrency} iqdDisplayPreference={iqdPreference} />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="grid gap-2">
                                <Label>{t('budget.dueDay') || 'Due Day (1-31)'}</Label>
                                <Input type="number" min={1} max={31} value={expenseDueDay} onChange={(e) => setExpenseDueDay(Number(e.target.value))} />
                            </div>
                            <div className="flex items-center justify-between rounded-xl border border-border/60 px-3 py-2">
                                <div>
                                    <Label className="text-xs uppercase">{t('budget.recurring') || 'Recurring'}</Label>
                                    <p className="text-xs text-muted-foreground">{t('budget.recurringDesc') || 'Repeat every month'}</p>
                                </div>
                                <Switch checked={expenseRecurrence === 'monthly'} onCheckedChange={(checked) => setExpenseRecurrence(checked ? 'monthly' : 'one_time')} />
                            </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="grid gap-2">
                                <Label>{t('common.category') || 'Category'}</Label>
                                <Input value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)} />
                            </div>
                            <div className="grid gap-2">
                                <Label>{t('budget.form.subcategory') || 'Subcategory'}</Label>
                                <Input value={expenseSubcategory} onChange={(e) => setExpenseSubcategory(e.target.value)} />
                            </div>
                        </div>
                    </div>
                    <DialogFooter className="mt-4">
                        <Button variant="outline" onClick={() => setIsExpenseModalOpen(false)}>
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button onClick={handleSaveExpense}>{t('common.save') || 'Save'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={isStartMonthModalOpen} onOpenChange={setIsStartMonthModalOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('budget.startPoint') || 'Start Month'}</DialogTitle>
                        <DialogDescription>{t('budget.startMonthDesc') || 'Choose the first month you want to track budgets.'}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2">
                        <Label>{t('budget.startPoint') || 'Start Month'}</Label>
                        <Input type="month" value={startMonthInput} onChange={(e) => setStartMonthInput(e.target.value as any)} />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsStartMonthModalOpen(false)}>{t('common.cancel') || 'Cancel'}</Button>
                        <Button onClick={handleSaveStartMonth}>{t('common.save') || 'Save'}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <SettlementDialog
                open={!!settlementTarget}
                onOpenChange={(open) => {
                    if (!open) {
                        setSettlementTarget(null)
                    }
                }}
                obligation={settlementTarget}
                isSubmitting={isSubmittingSettlement}
                onSubmit={handleBudgetSettlement}
            />

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onConfirm={() => {
                    if (!deleteTarget) return
                    if (deleteTarget.type === 'series' && deleteTarget.series) {
                        void handleDeleteSeries(deleteTarget.series)
                    }
                    if (deleteTarget.type === 'occurrence' && deleteTarget.item) {
                        void handleDeleteOccurrence(deleteTarget.item)
                    }
                    setDeleteTarget(null)
                }}
                title={deleteTarget?.type === 'series' ? t('budget.deleteSeries') : t('budget.deleteOccurrence')}
                itemName={deleteTarget?.series?.name || deleteTarget?.item?.id || ''}
            />

            <BudgetSnoozeModal
                open={!!snoozeTarget}
                onOpenChange={(open) => { if (!open) setSnoozeTarget(null) }}
                onSelect={(option) => {
                    if (!snoozeTarget) return
                    void handleSnooze(snoozeTarget, option)
                    setSnoozeTarget(null)
                }}
            />

            <BudgetLockPromptModal
                open={!!lockTarget}
                onConfirm={() => { void handleLockConfirm(lockTarget) }}
                onSkip={() => setLockTarget(null)}
            />
        </div>
    )
}
