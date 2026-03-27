import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownLeft, ArrowUpRight, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Wallet } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { buildConversionRates } from '@/lib/budget'
import { convertToStoreBase } from '@/lib/currency'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import {
    getPaymentTransactionRoutePath,
    useLoans,
    usePaymentTransactions,
    useSales,
    type CurrencyCode,
    type IQDDisplayPreference,
    type Loan,
    type PaymentTransaction,
    type Sale
} from '@/local-db'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DateRangeFilters,
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
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/ui/components'
import { useWorkspace } from '@/workspace'

type LedgerDirection = 'incoming' | 'outgoing'
type LedgerSourceModule = 'pos' | 'instant_pos' | 'orders' | 'expenses' | 'payroll' | 'loans'
type LedgerEntryType =
    | 'pos_sale'
    | 'instant_pos_sale'
    | 'sales_order_payment'
    | 'purchase_order_payment'
    | 'expense'
    | 'payroll_payment'
    | 'loan_given'
    | 'loan_taken'
    | 'loan_repayment_received'
    | 'loan_repayment_paid'
    | 'installment_received'
    | 'installment_paid'

interface LedgerEntry {
    id: string
    transactionId: string
    date: string
    type: LedgerEntryType
    direction: LedgerDirection
    amount: number
    currency: CurrencyCode
    sourceModule: LedgerSourceModule
    referenceId: string
    partner: string | null
    paymentMethod: string | null
    notes: string | null
    description: string | null
    routePath: string
}

type LedgerDirectionFilter = 'all' | LedgerDirection
type LedgerCurrencyFilter = 'all' | CurrencyCode
type LedgerNotesFilter = 'all' | 'with_notes' | 'without_notes'
type LedgerSortOption = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'

interface LedgerFilterState {
    search: string
    direction: LedgerDirectionFilter
    type: 'all' | LedgerEntryType
    source: 'all' | LedgerSourceModule
    partner: string
    currency: LedgerCurrencyFilter
    paymentMethod: string
    notes: LedgerNotesFilter
    minAmount: string
    maxAmount: string
    sort: LedgerSortOption
}

const DEFAULT_LEDGER_FILTERS: LedgerFilterState = {
    search: '',
    direction: 'all',
    type: 'all',
    source: 'all',
    partner: 'all',
    currency: 'all',
    paymentMethod: 'all',
    notes: 'all',
    minAmount: '',
    maxAmount: '',
    sort: 'date_desc'
}

function countActiveLedgerFilters(filters: LedgerFilterState) {
    return [
        !!filters.search.trim(),
        filters.direction !== 'all',
        filters.type !== 'all',
        filters.source !== 'all',
        filters.partner !== 'all',
        filters.currency !== 'all',
        filters.paymentMethod !== 'all',
        filters.notes !== 'all',
        !!filters.minAmount,
        !!filters.maxAmount,
        filters.sort !== 'date_desc'
    ].filter(Boolean).length
}

function getStartOfToday(now: Date) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
}

function getStartOfMonth(now: Date) {
    return new Date(now.getFullYear(), now.getMonth(), 1)
}

function isEntryInDateRange(
    date: string,
    dateRange: 'today' | 'month' | 'allTime' | 'custom',
    customDates: { start: string; end: string },
    now = new Date()
) {
    const value = new Date(date)

    if (dateRange === 'today') {
        return value >= getStartOfToday(now)
    }

    if (dateRange === 'month') {
        return value >= getStartOfMonth(now)
    }

    if (dateRange === 'custom' && customDates.start && customDates.end) {
        const start = new Date(customDates.start)
        start.setHours(0, 0, 0, 0)
        const end = new Date(customDates.end)
        end.setHours(23, 59, 59, 999)
        return value >= start && value <= end
    }

    return true
}

function paymentMethodLabel(value?: string | null) {
    switch (value) {
        case 'bank_transfer':
            return 'Bank Transfer'
        case 'loan_adjustment':
            return 'Loan Adjustment'
        case 'qicard':
            return 'QiCard'
        case 'zaincash':
            return 'ZainCash'
        case 'fastpay':
            return 'FastPay'
        case 'fib':
            return 'FIB'
        case 'cash':
            return 'Cash'
        case 'loan':
            return 'Loan'
        case 'unknown':
            return 'Unknown'
        default:
            return value
                ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
                : 'Unknown'
    }
}

function ledgerTypeLabel(type: LedgerEntryType) {
    switch (type) {
        case 'pos_sale':
            return 'POS Sale'
        case 'instant_pos_sale':
            return 'Instant POS Sale'
        case 'sales_order_payment':
            return 'Sales Order Payment'
        case 'purchase_order_payment':
            return 'Purchase Order Payment'
        case 'expense':
            return 'Expense'
        case 'payroll_payment':
            return 'Payroll Payment'
        case 'loan_given':
            return 'Loan Given'
        case 'loan_taken':
            return 'Loan Taken'
        case 'loan_repayment_received':
            return 'Loan Repayment Received'
        case 'loan_repayment_paid':
            return 'Loan Repayment Paid'
        case 'installment_received':
            return 'Installment Received'
        case 'installment_paid':
            return 'Installment Paid'
        default:
            return type
    }
}

function sourceModuleLabel(module: LedgerSourceModule) {
    switch (module) {
        case 'pos':
            return 'POS'
        case 'instant_pos':
            return 'Instant POS'
        case 'orders':
            return 'Orders'
        case 'expenses':
            return 'Expenses'
        case 'payroll':
            return 'Payroll'
        case 'loans':
            return 'Loans'
        default:
            return module
    }
}

function directionFilterLabel(direction: LedgerDirectionFilter) {
    switch (direction) {
        case 'incoming':
            return 'Inflow'
        case 'outgoing':
            return 'Outflow'
        default:
            return 'All Directions'
    }
}

function notesFilterLabel(value: LedgerNotesFilter) {
    switch (value) {
        case 'with_notes':
            return 'With Notes'
        case 'without_notes':
            return 'Without Notes'
        default:
            return 'Any Notes State'
    }
}

function sortOptionLabel(value: LedgerSortOption) {
    switch (value) {
        case 'date_asc':
            return 'Date: Oldest First'
        case 'amount_desc':
            return 'Amount: Highest First'
        case 'amount_asc':
            return 'Amount: Lowest First'
        default:
            return 'Date: Newest First'
    }
}

function sortLedgerEntries(entries: LedgerEntry[], sort: LedgerSortOption) {
    return [...entries].sort((left, right) => {
        if (sort === 'date_asc') {
            return left.date.localeCompare(right.date) || left.transactionId.localeCompare(right.transactionId)
        }

        if (sort === 'amount_desc') {
            return right.amount - left.amount || right.date.localeCompare(left.date)
        }

        if (sort === 'amount_asc') {
            return left.amount - right.amount || right.date.localeCompare(left.date)
        }

        return right.date.localeCompare(left.date) || right.transactionId.localeCompare(left.transactionId)
    })
}

function applyLedgerFilters(entries: LedgerEntry[], filters: LedgerFilterState) {
    const normalizedSearch = filters.search.trim().toLowerCase()
    const minAmount = filters.minAmount ? Number(filters.minAmount) : null
    const maxAmount = filters.maxAmount ? Number(filters.maxAmount) : null

    const filtered = entries.filter((entry) => {
        if (filters.direction !== 'all' && entry.direction !== filters.direction) {
            return false
        }

        if (filters.type !== 'all' && entry.type !== filters.type) {
            return false
        }

        if (filters.source !== 'all' && entry.sourceModule !== filters.source) {
            return false
        }

        if (filters.partner !== 'all' && (entry.partner || '') !== filters.partner) {
            return false
        }

        if (filters.currency !== 'all' && entry.currency !== filters.currency) {
            return false
        }

        if (filters.paymentMethod !== 'all' && (entry.paymentMethod || 'unknown') !== filters.paymentMethod) {
            return false
        }

        if (filters.notes === 'with_notes' && !entry.notes?.trim()) {
            return false
        }

        if (filters.notes === 'without_notes' && !!entry.notes?.trim()) {
            return false
        }

        if (minAmount !== null && Number.isFinite(minAmount) && entry.amount < minAmount) {
            return false
        }

        if (maxAmount !== null && Number.isFinite(maxAmount) && entry.amount > maxAmount) {
            return false
        }

        if (!normalizedSearch) {
            return true
        }

        return [
            entry.transactionId,
            entry.referenceId,
            entry.partner,
            entry.notes,
            entry.description,
            entry.paymentMethod,
            ledgerTypeLabel(entry.type),
            sourceModuleLabel(entry.sourceModule)
        ].some((value) => value?.toLowerCase().includes(normalizedSearch))
    })

    return sortLedgerEntries(filtered, filters.sort)
}

function formatAmountSummary(
    rows: Array<{ amount: number; currency: CurrencyCode }>,
    iqdPreference: IQDDisplayPreference
) {
    if (rows.length === 0) {
        return '0'
    }

    const totals = new Map<string, number>()
    rows.forEach((row) => {
        totals.set(row.currency, (totals.get(row.currency) || 0) + row.amount)
    })

    return Array.from(totals.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => formatCurrency(amount, currency as CurrencyCode, iqdPreference))
        .join(' | ')
}

function formatNetSummary(entries: LedgerEntry[], iqdPreference: IQDDisplayPreference) {
    if (entries.length === 0) {
        return '0'
    }

    const totals = new Map<string, number>()
    entries.forEach((entry) => {
        const signedAmount = entry.direction === 'incoming' ? entry.amount : -entry.amount
        totals.set(entry.currency, (totals.get(entry.currency) || 0) + signedAmount)
    })

    return Array.from(totals.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => {
            const sign = amount < 0 ? '-' : ''
            return `${sign}${formatCurrency(Math.abs(amount), currency as CurrencyCode, iqdPreference)}`
        })
        .join(' | ')
}

interface LedgerTrendPoint {
    dateKey: string
    inflow: number
    outflow: number
    net: number
}

function toLedgerDateKey(date: string) {
    if (/^\d{4}-\d{2}-\d{2}/.test(date)) {
        return date.slice(0, 10)
    }

    return new Date(date).toISOString().slice(0, 10)
}

function LedgerSparkline({
    data,
    dataKey,
    color,
    gradientId
}: {
    data: LedgerTrendPoint[]
    dataKey: 'inflow' | 'outflow' | 'net'
    color: string
    gradientId: string
}) {
    return (
        <div className="mt-4 h-12 w-full -mx-2">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data}>
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <Area
                        type="monotone"
                        dataKey={dataKey}
                        stroke={color}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill={`url(#${gradientId})`}
                        isAnimationActive={true}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    )
}

function LedgerMetricCard({
    title,
    value,
    hint,
    valueClassName,
    trendData,
    trendKey,
    trendColor,
    gradientId
}: {
    title: string
    value: string
    hint: string
    valueClassName?: string
    trendData: LedgerTrendPoint[]
    trendKey: 'inflow' | 'outflow' | 'net'
    trendColor: string
    gradientId: string
}) {
    return (
        <Card className="min-w-[180px] rounded-3xl border border-border/60 bg-card/70">
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{title}</CardTitle>
            </CardHeader>
            <CardContent className="pb-0">
                <div className={cn('text-lg font-semibold leading-tight', valueClassName)}>{value}</div>
                <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {hint}
                </p>
                <LedgerSparkline
                    data={trendData}
                    dataKey={trendKey}
                    color={trendColor}
                    gradientId={gradientId}
                />
            </CardContent>
        </Card>
    )
}

function buildReferenceId(prefix: string, id: string, sequenceId?: number) {
    return sequenceId ? `${prefix}-${sequenceId}` : `${prefix}-${id.slice(0, 8).toUpperCase()}`
}

function buildSaleLedgerEntry(sale: Sale): LedgerEntry | null {
    if (sale.isDeleted || sale.isReturned) {
        return null
    }

    if (sale.origin !== 'pos' && sale.origin !== 'instant_pos') {
        return null
    }

    if ((sale.payment_method || 'cash') === 'loan') {
        return null
    }

    const isInstantPos = sale.origin === 'instant_pos'
    const descriptionParts = [
        `Paid via ${paymentMethodLabel(sale.payment_method || 'cash')}`,
        sale.notes?.trim() || null
    ].filter(Boolean)

    return {
        id: `sale:${sale.id}`,
        transactionId: sale.id,
        date: sale.createdAt,
        type: isInstantPos ? 'instant_pos_sale' : 'pos_sale',
        direction: 'incoming',
        amount: sale.totalAmount,
        currency: sale.settlementCurrency,
        sourceModule: isInstantPos ? 'instant_pos' : 'pos',
        referenceId: buildReferenceId(isInstantPos ? 'IPOS' : 'POS', sale.id, sale.sequenceId),
        partner: null,
        paymentMethod: sale.payment_method || 'cash',
        notes: sale.notes?.trim() || null,
        description: descriptionParts.length > 0 ? descriptionParts.join(' | ') : null,
        routePath: '/sales'
    }
}

function buildTransactionReference(transaction: PaymentTransaction) {
    if (transaction.referenceLabel?.trim()) {
        return transaction.referenceLabel.trim()
    }

    switch (transaction.sourceType) {
        case 'sales_order':
            return buildReferenceId('SO', transaction.sourceRecordId)
        case 'purchase_order':
            return buildReferenceId('PO', transaction.sourceRecordId)
        case 'expense_item':
            return buildReferenceId('EXP', transaction.sourceRecordId)
        case 'payroll_status':
            return buildReferenceId('PAY', transaction.sourceRecordId)
        default:
            return buildReferenceId('LOAN', transaction.sourceRecordId)
    }
}

function buildTransactionDescription(transaction: PaymentTransaction) {
    const details: string[] = []

    if (transaction.note?.trim()) {
        details.push(transaction.note.trim())
    }

    if (transaction.paymentMethod && transaction.paymentMethod !== 'unknown') {
        details.push(`Via ${paymentMethodLabel(transaction.paymentMethod)}`)
    }

    if (transaction.sourceType === 'expense_item') {
        const category = typeof transaction.metadata?.category === 'string' ? transaction.metadata.category : null
        const subcategory = typeof transaction.metadata?.subcategory === 'string' ? transaction.metadata.subcategory : null
        if (category) {
            details.push(subcategory ? `${category} / ${subcategory}` : category)
        }
    }

    if (transaction.sourceType === 'payroll_status') {
        const month = typeof transaction.metadata?.month === 'string' ? transaction.metadata.month : null
        if (month) {
            details.push(`Payroll ${month}`)
        }
    }

    return details.length > 0 ? details.join(' | ') : null
}

function buildPaymentLedgerEntry(transaction: PaymentTransaction): LedgerEntry | null {
    if (transaction.isDeleted || transaction.reversalOfTransactionId || transaction.sourceType === 'direct_transaction') {
        return null
    }

    switch (transaction.sourceType) {
        case 'sales_order':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: 'sales_order_payment',
                direction: 'incoming',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'orders',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction),
                routePath: getPaymentTransactionRoutePath(transaction)
            }
        case 'purchase_order':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: 'purchase_order_payment',
                direction: 'outgoing',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'orders',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction),
                routePath: getPaymentTransactionRoutePath(transaction)
            }
        case 'expense_item':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: 'expense',
                direction: 'outgoing',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'expenses',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction),
                routePath: getPaymentTransactionRoutePath(transaction)
            }
        case 'payroll_status':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: 'payroll_payment',
                direction: 'outgoing',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'payroll',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction),
                routePath: getPaymentTransactionRoutePath(transaction)
            }
        case 'loan_installment':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: transaction.direction === 'incoming' ? 'installment_received' : 'installment_paid',
                direction: transaction.direction,
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'loans',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction),
                routePath: getPaymentTransactionRoutePath(transaction)
            }
        case 'loan_payment':
        case 'simple_loan':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: transaction.direction === 'incoming' ? 'loan_repayment_received' : 'loan_repayment_paid',
                direction: transaction.direction,
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'loans',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction),
                routePath: getPaymentTransactionRoutePath(transaction)
            }
        default:
            return null
    }
}

function buildLoanOriginationEntry(loan: Loan): LedgerEntry | null {
    if (loan.isDeleted || loan.source !== 'manual') {
        return null
    }

    return {
        id: `loan-origin:${loan.id}`,
        transactionId: loan.id,
        date: loan.createdAt,
        type: loan.direction === 'borrowed' ? 'loan_taken' : 'loan_given',
        direction: loan.direction === 'borrowed' ? 'incoming' : 'outgoing',
        amount: loan.principalAmount,
        currency: loan.settlementCurrency,
        sourceModule: 'loans',
        referenceId: loan.loanNo,
        partner: loan.linkedPartyName || loan.borrowerName || null,
        paymentMethod: null,
        notes: loan.notes?.trim() || null,
        description: loan.notes?.trim() || 'Loan originated',
        routePath: `/loans/${loan.id}`
    }
}

export function Ledger() {
    const { user } = useAuth()
    const { t, i18n } = useTranslation()
    const { dateRange, customDates } = useDateRange()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const { features } = useWorkspace()
    const [, setLocation] = useLocation()
    const workspaceId = user?.workspaceId
    const baseCurrency = (features.default_currency || 'usd') as CurrencyCode
    const hasLedgerSurface = features.pos
        || features.instant_pos
        || features.sales_history
        || features.crm
        || features.budget
        || features.hr
        || features.loans

    const sales = useSales(workspaceId)
    const loans = useLoans(workspaceId)
    const paymentTransactions = usePaymentTransactions(workspaceId, { includeReversals: false })
    const rates = useMemo(
        () => buildConversionRates(exchangeData, eurRates, tryRates),
        [eurRates, exchangeData, tryRates]
    )

    const [filters, setFilters] = useState<LedgerFilterState>(DEFAULT_LEDGER_FILTERS)
    const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
    const [draftFilters, setDraftFilters] = useState<LedgerFilterState>(DEFAULT_LEDGER_FILTERS)

    const deferredSearch = useDeferredValue(filters.search)

    const allEntries = useMemo(() => {
        const rows = [
            ...sales.map(buildSaleLedgerEntry).filter((entry): entry is LedgerEntry => !!entry),
            ...paymentTransactions.map(buildPaymentLedgerEntry).filter((entry): entry is LedgerEntry => !!entry),
            ...loans.map(buildLoanOriginationEntry).filter((entry): entry is LedgerEntry => !!entry)
        ]

        return rows.sort((left, right) => right.date.localeCompare(left.date) || right.transactionId.localeCompare(left.transactionId))
    }, [loans, paymentTransactions, sales])

    const typeOptions = useMemo(
        () => Array.from(new Set(allEntries.map((entry) => entry.type))).sort((left, right) => ledgerTypeLabel(left).localeCompare(ledgerTypeLabel(right))),
        [allEntries]
    )
    const currencyOptions = useMemo(
        () => Array.from(new Set(allEntries.map((entry) => entry.currency))).sort((left, right) => left.localeCompare(right)),
        [allEntries]
    )
    const paymentMethodOptions = useMemo(
        () => Array.from(new Set(allEntries.map((entry) => entry.paymentMethod).filter((value): value is string => !!value))).sort((left, right) => paymentMethodLabel(left).localeCompare(paymentMethodLabel(right))),
        [allEntries]
    )
    const partnerOptions = useMemo(
        () => Array.from(new Set(allEntries.map((entry) => entry.partner?.trim()).filter((value): value is string => !!value))).sort((left, right) => left.localeCompare(right)),
        [allEntries]
    )

    const dateScopedEntries = useMemo(
        () => allEntries.filter((entry) => isEntryInDateRange(entry.date, dateRange, customDates)),
        [allEntries, customDates, dateRange]
    )

    const effectiveFilters = useMemo(
        () => ({ ...filters, search: deferredSearch }),
        [deferredSearch, filters]
    )

    const filteredEntries = useMemo(
        () => applyLedgerFilters(dateScopedEntries, effectiveFilters),
        [dateScopedEntries, effectiveFilters]
    )

    const draftPreviewEntries = useMemo(
        () => applyLedgerFilters(dateScopedEntries, draftFilters),
        [dateScopedEntries, draftFilters]
    )

    const dateDisplay = useMemo(() => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }

        if (dateRange === 'month') {
            return formatLocalizedMonthYear(new Date(), i18n.language)
        }

        if (dateRange === 'custom') {
            if (dateScopedEntries.length > 0) {
                const dates = dateScopedEntries.map((entry) => new Date(entry.date).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }

            if (customDates.start && customDates.end) {
                return `${t('performance.filters.from')} ${formatDate(customDates.start)} ${t('performance.filters.to')} ${formatDate(customDates.end)}`
            }
        }

        if (dateRange === 'allTime') {
            if (dateScopedEntries.length > 0) {
                const dates = dateScopedEntries.map((entry) => new Date(entry.date).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.allTime') || 'All Time'}, ${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }

            return t('performance.filters.allTime') || 'All Time'
        }

        return ''
    }, [customDates.end, customDates.start, dateRange, dateScopedEntries, i18n.language, t])

    useEffect(() => {
        if (!isFilterDialogOpen) {
            return
        }

        setDraftFilters(filters)
    }, [filters, isFilterDialogOpen])

    const activeFilterChips = useMemo(() => {
        const chips: string[] = []

        if (filters.search.trim()) {
            chips.push(`Search: ${filters.search.trim()}`)
        }
        if (filters.direction !== 'all') {
            chips.push(directionFilterLabel(filters.direction))
        }
        if (filters.type !== 'all') {
            chips.push(ledgerTypeLabel(filters.type))
        }
        if (filters.source !== 'all') {
            chips.push(sourceModuleLabel(filters.source))
        }
        if (filters.partner !== 'all') {
            chips.push(`Partner: ${filters.partner}`)
        }
        if (filters.currency !== 'all') {
            chips.push(`Currency: ${filters.currency.toUpperCase()}`)
        }
        if (filters.paymentMethod !== 'all') {
            chips.push(`Method: ${paymentMethodLabel(filters.paymentMethod)}`)
        }
        if (filters.notes !== 'all') {
            chips.push(notesFilterLabel(filters.notes))
        }
        if (filters.minAmount) {
            chips.push(`Min: ${filters.minAmount}`)
        }
        if (filters.maxAmount) {
            chips.push(`Max: ${filters.maxAmount}`)
        }
        if (filters.sort !== 'date_desc') {
            chips.push(sortOptionLabel(filters.sort))
        }

        return chips
    }, [filters])

    const activeFilterCount = useMemo(
        () => countActiveLedgerFilters(filters),
        [filters]
    )

    const handleResetAllFilters = () => {
        setFilters(DEFAULT_LEDGER_FILTERS)
    }

    const handleResetDraftFilters = () => {
        setDraftFilters(DEFAULT_LEDGER_FILTERS)
    }

    const handleApplyFilters = () => {
        setFilters(draftFilters)
        setIsFilterDialogOpen(false)
    }

    const totalInflow = useMemo(
        () => formatAmountSummary(
            filteredEntries
                .filter((entry) => entry.direction === 'incoming')
                .map((entry) => ({ amount: entry.amount, currency: entry.currency })),
            features.iqd_display_preference
        ),
        [features.iqd_display_preference, filteredEntries]
    )
    const totalOutflow = useMemo(
        () => formatAmountSummary(
            filteredEntries
                .filter((entry) => entry.direction === 'outgoing')
                .map((entry) => ({ amount: entry.amount, currency: entry.currency })),
            features.iqd_display_preference
        ),
        [features.iqd_display_preference, filteredEntries]
    )
    const netFlow = useMemo(
        () => formatNetSummary(filteredEntries, features.iqd_display_preference),
        [features.iqd_display_preference, filteredEntries]
    )
    const trendCurrencyMode = useMemo(() => {
        const currencies = Array.from(new Set(filteredEntries.map((entry) => entry.currency)))

        if (currencies.length <= 1) {
            return {
                currency: currencies[0] ?? baseCurrency,
                usesBaseEquivalent: false
            }
        }

        return {
            currency: baseCurrency,
            usesBaseEquivalent: true
        }
    }, [baseCurrency, filteredEntries])
    const ledgerTrendData = useMemo(() => {
        const points = new Map<string, LedgerTrendPoint>()

        filteredEntries.forEach((entry) => {
            const dateKey = toLedgerDateKey(entry.date)
            const point = points.get(dateKey) || {
                dateKey,
                inflow: 0,
                outflow: 0,
                net: 0
            }
            const amount = trendCurrencyMode.usesBaseEquivalent
                ? convertToStoreBase(entry.amount, entry.currency, baseCurrency, rates)
                : entry.amount

            if (entry.direction === 'incoming') {
                point.inflow += amount
                point.net += amount
            } else {
                point.outflow += amount
                point.net -= amount
            }

            points.set(dateKey, point)
        })

        return Array.from(points.values()).sort((left, right) => left.dateKey.localeCompare(right.dateKey))
    }, [baseCurrency, filteredEntries, rates, trendCurrencyMode.usesBaseEquivalent])
    const usesEquivalentTrend = trendCurrencyMode.usesBaseEquivalent
    const netFlowIsNegative = useMemo(
        () => ledgerTrendData.reduce((sum, point) => sum + point.net, 0) < 0,
        [ledgerTrendData]
    )

    if (!hasLedgerSurface) {
        return (
            <div className="p-6">
                <Card>
                    <CardHeader>
                        <CardTitle>Ledger is not available in this workspace</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Enable POS, CRM, Loans, Accounting, or HR to use the central ledger.
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="space-y-3">
                    <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Read-only ledger
                    </div>
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-3">
                            <h1 className="text-3xl font-bold tracking-tight">Ledger</h1>
                            {dateDisplay && (
                                <div className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-bold text-white shadow-sm animate-in fade-in slide-in-from-left-2 duration-200">
                                    {dateDisplay}
                                </div>
                            )}
                        </div>
                        <p className="max-w-3xl text-sm text-muted-foreground">
                            Central ledger for posted financial movement only. Orders, expenses, payroll, and loan activity appear when payment happens,
                            while POS sales and manual loan origination are posted automatically by the system.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                        <span className="rounded-full border border-border bg-background px-3 py-1 font-medium">Posted movements only</span>
                        <span className="rounded-full border border-border bg-background px-3 py-1 font-medium">No manual ledger entries</span>
                        <span className="rounded-full border border-border bg-background px-3 py-1 font-medium">Totals preserve original currencies</span>
                    </div>
                    <DateRangeFilters className="pt-1" />
                </div>

                <Card className="xl:w-[320px]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Wallet className="h-4 w-4 text-primary" />
                            Current selection
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm text-muted-foreground">
                        <p>{filteredEntries.length} posted entries match the current selection.</p>
                        <p>Use the page date range with the general filter modal to refine direction, type, module, party, method, amount range, and sorting.</p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <LedgerMetricCard
                    title="Total Inflow"
                    value={totalInflow}
                    hint="Incoming posted movements"
                    valueClassName="text-emerald-600"
                    trendData={ledgerTrendData}
                    trendKey="inflow"
                    trendColor="#10b981"
                    gradientId="ledger-inflow-trend"
                />
                <LedgerMetricCard
                    title="Total Outflow"
                    value={totalOutflow}
                    hint="Outgoing posted movements"
                    valueClassName="text-amber-600"
                    trendData={ledgerTrendData}
                    trendKey="outflow"
                    trendColor="#f59e0b"
                    gradientId="ledger-outflow-trend"
                />
                <LedgerMetricCard
                    title="Net Flow"
                    value={netFlow}
                    hint="Inflow minus outflow"
                    valueClassName={netFlowIsNegative ? 'text-rose-600' : 'text-sky-600'}
                    trendData={ledgerTrendData}
                    trendKey="net"
                    trendColor={netFlowIsNegative ? '#ef4444' : '#2563eb'}
                    gradientId="ledger-net-trend"
                />
                <Card className="min-w-[180px] rounded-3xl border border-border/60 bg-card/70">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">Entries</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                        <div className="text-lg font-semibold">{filteredEntries.length}</div>
                        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            Posted movements in view
                        </p>
                    </CardContent>
                </Card>
            </div>
            {usesEquivalentTrend ? (
                <p className="text-xs text-muted-foreground">
                    Sparkline charts use {trendCurrencyMode.currency.toUpperCase()} equivalent when multiple currencies are included.
                </p>
            ) : null}

            <Card>
                <CardContent className="pt-6">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-3">
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setIsFilterDialogOpen(true)}
                                    className="h-11 rounded-2xl border-border/60 px-4"
                                >
                                    <SlidersHorizontal className="mr-2 h-4 w-4" />
                                    Filters
                                    {activeFilterCount > 0 ? (
                                        <span className="ml-2 inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                                            {activeFilterCount}
                                        </span>
                                    ) : null}
                                </Button>
                                {activeFilterCount > 0 ? (
                                    <Button type="button" variant="ghost" onClick={handleResetAllFilters} className="h-11 rounded-2xl px-4 text-muted-foreground">
                                        <RotateCcw className="mr-2 h-4 w-4" />
                                        Clear Filters
                                    </Button>
                                ) : null}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Draft orders, unpaid obligations, and manual direct transactions are intentionally excluded from the ledger.
                            </p>
                        </div>

                        <div className="rounded-2xl border border-border/60 bg-secondary/20 px-4 py-3 text-sm">
                            <div className="font-semibold">{filteredEntries.length} matching entries</div>
                            <div className="text-xs text-muted-foreground">General filters preview before opening any record.</div>
                        </div>
                    </div>

                    {activeFilterChips.length > 0 ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                            {activeFilterChips.map((chip) => (
                                <span
                                    key={chip}
                                    className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-[11px] font-semibold text-primary"
                                >
                                    {chip}
                                </span>
                            ))}
                        </div>
                    ) : (
                        <div className="mt-4 rounded-2xl border border-dashed border-border/60 bg-background/50 px-4 py-3 text-xs text-muted-foreground">
                            No advanced filters applied. Open the filter modal to narrow the ledger by direction, partner, method, amounts, or notes.
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle>Ledger Entries</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Transaction ID</TableHead>
                                <TableHead>Date</TableHead>
                                <TableHead>Type</TableHead>
                                <TableHead>Direction</TableHead>
                                <TableHead>Amount</TableHead>
                                <TableHead>Source Module</TableHead>
                                <TableHead>Reference ID</TableHead>
                                <TableHead>Partner</TableHead>
                                <TableHead>Description / Notes</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredEntries.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                                        No ledger entries match the current filters.
                                    </TableCell>
                                </TableRow>
                            ) : filteredEntries.map((entry) => (
                                <TableRow key={entry.id}>
                                    <TableCell className="max-w-[170px] font-mono text-xs text-muted-foreground">
                                        <span className="block truncate">{entry.transactionId}</span>
                                    </TableCell>
                                    <TableCell>{formatDateTime(entry.date)}</TableCell>
                                    <TableCell className="font-medium">{ledgerTypeLabel(entry.type)}</TableCell>
                                    <TableCell>
                                        <span className={cn(
                                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                            entry.direction === 'incoming'
                                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                : 'border-amber-200 bg-amber-50 text-amber-700'
                                        )}>
                                            {entry.direction === 'incoming' ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                                            {entry.direction === 'incoming' ? 'IN' : 'OUT'}
                                        </span>
                                    </TableCell>
                                    <TableCell>{formatCurrency(entry.amount, entry.currency, features.iqd_display_preference)}</TableCell>
                                    <TableCell>{sourceModuleLabel(entry.sourceModule)}</TableCell>
                                    <TableCell className="font-medium">{entry.referenceId}</TableCell>
                                    <TableCell>{entry.partner || '-'}</TableCell>
                                    <TableCell className="max-w-[280px]">
                                        <span className="block truncate text-sm text-muted-foreground">{entry.description || '-'}</span>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <Button variant="outline" size="sm" onClick={() => setLocation(entry.routePath)}>
                                            Open
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <Dialog open={isFilterDialogOpen} onOpenChange={setIsFilterDialogOpen}>
                <DialogContent className="top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] w-[calc(100vw-0.75rem)] max-w-5xl overflow-hidden rounded-[1.5rem] border border-border/60 p-0 sm:w-[calc(100vw-2rem)] sm:rounded-[2rem]">
                    <div className="flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-1rem)] flex-col">
                        <DialogHeader className="border-b border-border/60 bg-gradient-to-r from-primary/8 via-background to-emerald-500/5 px-6 py-5 text-left">
                            <DialogTitle className="flex items-center gap-3 text-xl font-black tracking-tight">
                                <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
                                    <SlidersHorizontal className="h-5 w-5" />
                                </div>
                                General Ledger Filters
                            </DialogTitle>
                            <DialogDescription className="max-w-3xl">
                                Refine the ledger with a richer filter set before you inspect entries. Date range stays on the page, and changes here stay in the modal until you apply them.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
                            <div className="grid gap-3 md:grid-cols-3">
                                <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4">
                                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-700">Preview</div>
                                    <div className="mt-2 text-2xl font-black text-emerald-700">{draftPreviewEntries.length}</div>
                                    <div className="mt-1 text-xs text-muted-foreground">entries match the draft filters inside the current page range</div>
                                </div>
                                <div className="rounded-2xl border border-border/60 bg-secondary/20 p-4">
                                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Page Range</div>
                                    <div className="mt-2 text-sm font-bold">{dateDisplay || 'All Time'}</div>
                                    <div className="mt-1 text-xs text-muted-foreground">Controlled directly from the ledger page header</div>
                                </div>
                                <div className="rounded-2xl border border-border/60 bg-secondary/20 p-4">
                                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Draft Filters</div>
                                    <div className="mt-2 text-2xl font-black">{countActiveLedgerFilters(draftFilters)}</div>
                                    <div className="mt-1 text-xs text-muted-foreground">advanced conditions configured</div>
                                </div>
                            </div>

                            <section className="grid gap-4 lg:grid-cols-2">
                                <div className="space-y-4 rounded-[1.5rem] border border-border/60 bg-background/80 p-5">
                                    <div className="space-y-1">
                                        <h3 className="text-base font-black tracking-tight">Search & Movement</h3>
                                        <p className="text-sm text-muted-foreground">Search by IDs, partner, notes, reference, or module.</p>
                                    </div>

                                    <div className="space-y-2">
                                        <Label htmlFor="ledger-filter-search">Keyword Search</Label>
                                        <div className="relative">
                                            <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                                            <Input
                                                id="ledger-filter-search"
                                                value={draftFilters.search}
                                                onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
                                                placeholder="Search reference, partner, note, or ID"
                                                className="pl-9"
                                            />
                                        </div>
                                    </div>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>Direction</Label>
                                            <Select value={draftFilters.direction} onValueChange={(value: LedgerDirectionFilter) => setDraftFilters((current) => ({ ...current, direction: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">All Directions</SelectItem>
                                                    <SelectItem value="incoming">Inflow</SelectItem>
                                                    <SelectItem value="outgoing">Outflow</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Sort By</Label>
                                            <Select value={draftFilters.sort} onValueChange={(value: LedgerSortOption) => setDraftFilters((current) => ({ ...current, sort: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="date_desc">Date: Newest First</SelectItem>
                                                    <SelectItem value="date_asc">Date: Oldest First</SelectItem>
                                                    <SelectItem value="amount_desc">Amount: Highest First</SelectItem>
                                                    <SelectItem value="amount_asc">Amount: Lowest First</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>Transaction Type</Label>
                                            <Select value={draftFilters.type} onValueChange={(value: 'all' | LedgerEntryType) => setDraftFilters((current) => ({ ...current, type: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="All Types" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">All Types</SelectItem>
                                                    {typeOptions.map((type) => (
                                                        <SelectItem key={type} value={type}>
                                                            {ledgerTypeLabel(type)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Source Module</Label>
                                            <Select value={draftFilters.source} onValueChange={(value: 'all' | LedgerSourceModule) => setDraftFilters((current) => ({ ...current, source: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="All Modules" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">All Modules</SelectItem>
                                                    <SelectItem value="pos">POS</SelectItem>
                                                    <SelectItem value="instant_pos">Instant POS</SelectItem>
                                                    <SelectItem value="orders">Orders</SelectItem>
                                                    <SelectItem value="expenses">Expenses</SelectItem>
                                                    <SelectItem value="payroll">Payroll</SelectItem>
                                                    <SelectItem value="loans">Loans</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-4 rounded-[1.5rem] border border-border/60 bg-background/80 p-5">
                                    <div className="space-y-1">
                                        <h3 className="text-base font-black tracking-tight">Parties, Method & Amount</h3>
                                        <p className="text-sm text-muted-foreground">Narrow the ledger to specific partners, currencies, methods, or ranges.</p>
                                    </div>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>Partner</Label>
                                            <Select value={draftFilters.partner} onValueChange={(value) => setDraftFilters((current) => ({ ...current, partner: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="All Partners" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">All Partners</SelectItem>
                                                    {partnerOptions.map((partner) => (
                                                        <SelectItem key={partner} value={partner}>
                                                            {partner}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Currency</Label>
                                            <Select value={draftFilters.currency} onValueChange={(value: LedgerCurrencyFilter) => setDraftFilters((current) => ({ ...current, currency: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="All Currencies" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">All Currencies</SelectItem>
                                                    {currencyOptions.map((currency) => (
                                                        <SelectItem key={currency} value={currency}>
                                                            {currency.toUpperCase()}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>Payment Method</Label>
                                            <Select value={draftFilters.paymentMethod} onValueChange={(value) => setDraftFilters((current) => ({ ...current, paymentMethod: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Any Method" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">Any Method</SelectItem>
                                                    {paymentMethodOptions.map((method) => (
                                                        <SelectItem key={method} value={method}>
                                                            {paymentMethodLabel(method)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Notes</Label>
                                            <Select value={draftFilters.notes} onValueChange={(value: LedgerNotesFilter) => setDraftFilters((current) => ({ ...current, notes: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Any Notes State" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">Any Notes State</SelectItem>
                                                    <SelectItem value="with_notes">With Notes</SelectItem>
                                                    <SelectItem value="without_notes">Without Notes</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label htmlFor="ledger-filter-min-amount">Minimum Amount</Label>
                                            <Input
                                                id="ledger-filter-min-amount"
                                                type="number"
                                                min="0"
                                                value={draftFilters.minAmount}
                                                onChange={(event) => setDraftFilters((current) => ({ ...current, minAmount: event.target.value }))}
                                                placeholder="0"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label htmlFor="ledger-filter-max-amount">Maximum Amount</Label>
                                            <Input
                                                id="ledger-filter-max-amount"
                                                type="number"
                                                min="0"
                                                value={draftFilters.maxAmount}
                                                onChange={(event) => setDraftFilters((current) => ({ ...current, maxAmount: event.target.value }))}
                                                placeholder="No cap"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </section>
                        </div>

                        <DialogFooter className="border-t border-border/60 bg-background/95 px-6 py-4 sm:justify-between">
                            <Button type="button" variant="ghost" onClick={handleResetDraftFilters} className="rounded-2xl">
                                <RotateCcw className="mr-2 h-4 w-4" />
                                Reset Draft
                            </Button>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                                <Button type="button" variant="outline" onClick={() => setIsFilterDialogOpen(false)} className="rounded-2xl">
                                    Cancel
                                </Button>
                                <Button type="button" onClick={handleApplyFilters} className="rounded-2xl">
                                    Apply Filters ({draftPreviewEntries.length})
                                </Button>
                            </div>
                        </DialogFooter>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
