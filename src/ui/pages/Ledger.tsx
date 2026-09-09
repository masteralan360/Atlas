import { useDeferredValue, useEffect, useMemo, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
    ArrowDownLeft,
    ArrowUpRight,
    BookOpen,
    FileSpreadsheet,
    Loader2,
    RotateCcw,
    Search,
    SlidersHorizontal,
    Wallet,
    TrendingUp,
    TrendingDown,
    DollarSign,
    Package,
    Percent,
    BarChart3,
    Clock,
    ChevronUp,
    ChevronDown,
    ChevronsUp,
    ChevronsDown,
    UsersRound,
    FileText,
} from 'lucide-react'
import { Area, AreaChart, Bar, BarChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis } from 'recharts'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { buildConversionRates } from '@/lib/budget'
import { convertToStoreBase } from '@/lib/currency'
import { getLedgerFlowSign, isLedgerCashFlowDirection, summarizeLedgerCashFlow, type LedgerReportingDirection } from '@/lib/ledgerFlow'
import {
    getLedgerCashBucketId,
    isLedgerCashDrilldownMatch,
    normalizeLedgerDashboardConfig,
    summarizeLedgerCashMovements,
    summarizeLedgerCashMovementsByCurrency,
    type LedgerCashDrilldownId,
    type LedgerCashGroupId,
    type LedgerDashboardConfig,
} from '@/lib/ledgerCashSummary'
import {
    LEDGER_MOVEMENT_CATEGORY_IDS,
    LEDGER_NO_COUNTERPARTY,
    LEDGER_UNASSIGNED_PAYMENT_ACCOUNT,
    applyGeneralLedgerFilters,
    canCompareLedgerAmounts,
    countActiveLedgerFilters,
    getLedgerCounterpartyFilterKey,
    getLedgerMovementCategory,
    getLedgerPaymentAccountFilterKey,
    getLedgerTransactionState,
    hasInvalidLedgerAmountRange,
    normalizeLedgerFiltersForCurrency,
    type GeneralLedgerFilterState,
    type LedgerMovementCategory,
    type LedgerSortOption,
    type LedgerTransactionState,
} from '@/lib/ledgerFilters'
import { getInstallmentSaleLedgerPayment } from '@/lib/installmentSaleLedger'
import { getLedgerCashMovementEntries } from '@/lib/ledgerCashMovementEntries'
import { getLedgerPaymentTransactionEffect, getLedgerPaymentTransactions } from '@/lib/ledgerPaymentTransactions'
import { classifySalesOrderLoanCash } from '@/lib/ledgerOrderLoan'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { setPendingSaleDetailsId } from '@/lib/saleNavigation'
import {
    getPaymentTransactionRoutePath,
    usePaymentTransactions,
    useLoans,
    useRealEstateTransactions,
    useSales,
    useSalesOrders,
    usePurchaseOrders,
    useBusinessPartners,
    useExchangeTransactions,
    useAgents,
    useDeliveryMerchantProfiles,
    useDeliverySettlements,
    useDeliveryShipments,
    type CurrencyCode,
    type IQDDisplayPreference,
    type Loan,
    type PaymentTransaction,
    type RealEstateTransaction,
    type Sale,
    type SalesOrder,
    type PurchaseOrder,
} from '@/local-db'
import { cn, formatCurrency, formatDate, formatDateTime, formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    AppPagination,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DateRangeFilters,
    Input,
    Label,
    Progress,
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
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
    ExportPreviewModal,
} from '@/ui/components'
import { useWorkspace } from '@/workspace'
import { useTheme } from '@/ui/components/theme-provider'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { LedgerCashSummaryDashboard } from '@/ui/components/ledger/LedgerCashSummaryDashboard'
import { getDateRangeBounds, isDateInDateRange } from '@/lib/dateRangeFilters'

type LedgerDirection = LedgerReportingDirection
type LedgerSourceModule =
    | 'pos'
    | 'instant_pos'
    | 'orders'
    | 'order_financing'
    | 'expenses'
    | 'payroll'
    | 'loans'
    | 'installment_sales'
    | 'real_estate'
    | 'activities'
    | 'clinical_appointments'
    | 'manual'
    | 'payment_accounts'
    | 'exchange'
    | 'post_service'
    | 'car_rental'
    | 'travel_transportation'
type LedgerRelationRole = 'origin' | 'repayment' | 'settlement'
type LedgerEntryType =
    | 'pos_sale'
    | 'instant_pos_sale'
    | 'ecommerce_receivable'
    | 'ecommerce_payment'
    | 'sales_order_payment'
    | 'order_loan_collection'
    | 'order_loan_refund'
    | 'purchase_order_payment'
    | 'expense'
    | 'payroll_payment'
    | 'loan_given'
    | 'loan_taken'
    | 'loan_repayment_received'
    | 'loan_repayment_paid'
    | 'installment_received'
    | 'installment_paid'
    | 'installment_sale_down_payment'
    | 'installment_sale_collection'
    | 'real_estate_commission'
    | 'agent_commission_payout'
    | 'activity_transaction'
    | 'activity_refund'
    | 'clinical_appointment_payment'
    | 'direct_inflow'
    | 'direct_outflow'
    | 'payment_account_opening_balance'
    | 'payment_account_deposit'
    | 'payment_account_withdrawal'
    | 'payment_account_adjustment'
    | 'exchange_profit'
    | 'delivery_courier_remittance'
    | 'delivery_courier_fee_payout'
    | 'delivery_courier_reimbursement'
    | 'delivery_merchant_payout'
    | 'delivery_recipient_payout'
    | 'delivery_merchant_repayment'
    | 'rental_payment'
    | 'rental_deposit'
    | 'rental_deposit_refund'
    | 'travel_booking_profit'

const LEDGER_FRESHNESS_TABLES = [
    'payment_transactions',
    'loans',
    'real_estate_transactions',
    'sales',
    'sales_orders',
    'purchase_orders',
    'business_partners',
    'agents',
    'delivery_merchant_profiles',
    'delivery_settlements',
    'delivery_shipments',
    'exchange_transactions',
] as const

// Set to true to restore the supplementary Ledger analytics and Gross Surplus widgets.
const SHOW_LEDGER_ANALYTICS_WIDGETS = false

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
    businessPartnerId: string | null
    paymentMethod: string | null
    paymentAccountId?: string | null
    paymentAccount?: string | null
    notes: string | null
    description: string | null
    routePath: string
    /** Present only for an immutable payment reversal and links its source payment. */
    reversalOfTransactionId?: string | null
    relationKey?: string | null
    relationRole?: LedgerRelationRole | null
    relationTitle?: string | null
    relationDescription?: string | null
    relationIsCompleted?: boolean
    /** Storage locations linked to the sale or sales order behind this entry. */
    storageIds?: string[]
}

type LedgerFilterState = GeneralLedgerFilterState<LedgerEntryType, LedgerSourceModule, CurrencyCode>

const DEFAULT_LEDGER_FILTERS: LedgerFilterState = {
    search: '',
    direction: [],
    category: [],
    transactionState: [],
    type: [],
    source: [],
    counterparty: [],
    currency: [],
    paymentMethods: [],
    paymentAccounts: [],
    minAmount: '',
    maxAmount: '',
    sort: 'date_desc',
}

function isEntryInDateRange(
    date: string,
    dateRange: 'today' | 'yesterday' | 'month' | 'lastMonth' | 'allTime' | 'custom',
    customDates: { start: string; end: string },
    now = new Date(),
) {
    return isDateInDateRange(date, dateRange, customDates, now)
}

function paymentMethodLabel(value: string | null | undefined, t: any) {
    switch (value) {
        case 'bank_transfer':
            return t('ledger.paymentMethod.bankTransfer', {
                defaultValue: 'Bank Transfer',
            })
        case 'credit':
            return t('ledger.paymentMethod.credit', { defaultValue: 'Credit' })
        case 'hawala':
            return t('ledger.paymentMethod.hawala', { defaultValue: 'Hawala' })
        case 'loan_adjustment':
            return t('ledger.paymentMethod.loanAdjustment', {
                defaultValue: 'Loan Adjustment',
            })
        case 'qicard':
            return t('ledger.paymentMethod.qicard', { defaultValue: 'QiCard' })
        case 'zaincash':
            return t('ledger.paymentMethod.zaincash', { defaultValue: 'ZainCash' })
        case 'fastpay':
            return t('ledger.paymentMethod.fastpay', { defaultValue: 'FastPay' })
        case 'fib':
            return t('ledger.paymentMethod.fib', { defaultValue: 'FIB' })
        case 'cash':
            return t('ledger.paymentMethod.cash', { defaultValue: 'Cash' })
        case 'loan':
            return t('ledger.paymentMethod.loan', { defaultValue: 'Loan' })
        case 'unknown':
            return t('ledger.paymentMethod.unknown', { defaultValue: 'Unknown' })
        default:
            return value
                ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
                : t('ledger.paymentMethod.unknown', { defaultValue: 'Unknown' })
    }
}

function resolveSalePaymentMethod(
    sale: Sale & {
        paymentMethod?: string | null
        paymentType?: string | null
        digitalProvider?: string | null
    },
) {
    const directMethod = typeof sale.payment_method === 'string' && sale.payment_method.trim() ? sale.payment_method.trim() : null
    if (directMethod) {
        return directMethod
    }

    const legacyMethod = typeof sale.paymentMethod === 'string' && sale.paymentMethod.trim() ? sale.paymentMethod.trim() : null
    if (legacyMethod) {
        return legacyMethod
    }

    if (sale.paymentType === 'digital') {
        return typeof sale.digitalProvider === 'string' && sale.digitalProvider.trim() ? sale.digitalProvider.trim() : null
    }

    if (sale.paymentType === 'cash' || sale.paymentType === 'loan') {
        return sale.paymentType
    }

    return null
}

function ledgerTypeLabel(type: LedgerEntryType, t: any) {
    switch (type) {
        case 'pos_sale':
            return t('ledger.type.posSale', { defaultValue: 'POS Sale' })
        case 'instant_pos_sale':
            return t('ledger.type.instantPosSale', {
                defaultValue: 'Instant POS Sale',
            })
        case 'ecommerce_receivable':
            return t('ledger.type.ecommerceReceivable', {
                defaultValue: 'E-Commerce Receivable',
            })
        case 'ecommerce_payment':
            return t('ledger.type.ecommercePayment', {
                defaultValue: 'E-Commerce Payment',
            })
        case 'sales_order_payment':
            return t('ledger.type.salesOrderPayment', {
                defaultValue: 'Sales Order Payment',
            })
        case 'order_loan_collection':
            return t('ledger.type.orderLoanCollection', {
                defaultValue: 'Order Loan Collection',
            })
        case 'order_loan_refund':
            return t('ledger.type.orderLoanRefund', {
                defaultValue: 'Order Loan Refund',
            })
        case 'purchase_order_payment':
            return t('ledger.type.purchaseOrderPayment', {
                defaultValue: 'Purchase Order Payment',
            })
        case 'expense':
            return t('ledger.type.expense', { defaultValue: 'Expense' })
        case 'payroll_payment':
            return t('ledger.type.payrollPayment', {
                defaultValue: 'Payroll Payment',
            })
        case 'loan_given':
            return t('ledger.type.loanGiven', { defaultValue: 'Loan Given' })
        case 'loan_taken':
            return t('ledger.type.loanTaken', { defaultValue: 'Loan Taken' })
        case 'loan_repayment_received':
            return t('ledger.type.loanRepaymentReceived', {
                defaultValue: 'Loan Repayment Received',
            })
        case 'loan_repayment_paid':
            return t('ledger.type.loanRepaymentPaid', {
                defaultValue: 'Loan Repayment Paid',
            })
        case 'installment_received':
            return t('ledger.type.installmentReceived', {
                defaultValue: 'Installment Received',
            })
        case 'installment_paid':
            return t('ledger.type.installmentPaid', {
                defaultValue: 'Installment Paid',
            })
        case 'installment_sale_down_payment':
            return t('ledger.type.installmentSaleDownPayment')
        case 'installment_sale_collection':
            return t('ledger.type.installmentSaleCollection')
        case 'real_estate_commission':
            return t('ledger.type.realEstateCommission', {
                defaultValue: 'Real Estate Commission',
            })
        case 'agent_commission_payout':
            return t('ledger.type.agentCommissionPayout')
        case 'activity_transaction':
            return t('ledger.type.activityTransaction', {
                defaultValue: 'Activity Transaction',
            })
        case 'activity_refund':
            return t('ledger.type.activityRefund', {
                defaultValue: 'Activity Refund',
            })
        case 'clinical_appointment_payment':
            return t('ledger.type.clinicalAppointmentPayment', {
                defaultValue: 'Appointment Payment',
            })
        case 'direct_inflow':
            return t('ledger.type.directInflow', { defaultValue: 'Direct Inflow' })
        case 'direct_outflow':
            return t('ledger.type.directOutflow', { defaultValue: 'Direct Outflow' })
        case 'payment_account_opening_balance':
            return t('paymentAccounts.openingBalance', {
                defaultValue: 'Opening Balance',
            })
        case 'payment_account_deposit':
            return t('paymentAccounts.deposit', { defaultValue: 'Deposit' })
        case 'payment_account_withdrawal':
            return t('paymentAccounts.withdraw', { defaultValue: 'Withdrawal' })
        case 'payment_account_adjustment':
            return t('paymentAccounts.adjustBalance', {
                defaultValue: 'Balance Adjustment',
            })
        case 'exchange_profit':
            return t('ledger.type.exchangeProfit', {
                defaultValue: 'Exchange Profit',
            })
        case 'delivery_courier_remittance':
            return t('ledger.type.deliveryCourierRemittance', {
                defaultValue: 'Courier Remittance',
            })
        case 'delivery_courier_fee_payout':
            return t('ledger.type.deliveryCourierFeePayout', {
                defaultValue: 'Courier Fee Payment',
            })
        case 'delivery_courier_reimbursement':
            return t('ledger.type.deliveryCourierReimbursement', {
                defaultValue: 'Courier Reimbursement',
            })
        case 'delivery_merchant_payout':
            return t('ledger.type.deliveryMerchantPayout', {
                defaultValue: 'Merchant Payout',
            })
        case 'delivery_recipient_payout':
            return t('ledger.type.deliveryRecipientPayout', {
                defaultValue: 'Recipient Payout',
            })
        case 'delivery_merchant_repayment':
            return t('ledger.type.deliveryMerchantRepayment', {
                defaultValue: 'Merchant Repayment',
            })
        case 'rental_payment':
            return t('ledger.type.rentalPayment')
        case 'rental_deposit':
            return t('ledger.type.rentalDeposit')
        case 'rental_deposit_refund':
            return t('ledger.type.rentalDepositRefund')
        case 'travel_booking_profit':
            return t('travelTransportation.recordProfitPayment')
        default:
            return type
    }
}

function sourceModuleLabel(module: LedgerSourceModule, t: any) {
    switch (module) {
        case 'pos':
            return t('ledger.sourceModule.pos', { defaultValue: 'POS' })
        case 'instant_pos':
            return t('ledger.sourceModule.instantPos', {
                defaultValue: 'Instant POS',
            })
        case 'orders':
            return t('ledger.sourceModule.orders', { defaultValue: 'Orders' })
        case 'order_financing':
            return t('ledger.sourceModule.orderFinancing', { defaultValue: 'Orders · Order Loan' })
        case 'expenses':
            return t('ledger.sourceModule.expenses', { defaultValue: 'Expenses' })
        case 'payroll':
            return t('ledger.sourceModule.payroll', { defaultValue: 'Payroll' })
        case 'loans':
            return t('ledger.sourceModule.loans', { defaultValue: 'Loans' })
        case 'installment_sales':
            return t('ledger.sourceModule.installmentSales')
        case 'real_estate':
            return t('ledger.sourceModule.realEstate', {
                defaultValue: 'Real Estate',
            })
        case 'activities':
            return t('ledger.sourceModule.activities', {
                defaultValue: 'Activities',
            })
        case 'clinical_appointments':
            return t('ledger.sourceModule.clinicalAppointments', {
                defaultValue: 'Appointments',
            })
        case 'manual':
            return t('ledger.sourceModule.manual', { defaultValue: 'Manual' })
        case 'payment_accounts':
            return t('paymentAccounts.title', { defaultValue: 'Payment Accounts' })
        case 'exchange':
            return t('ledger.sourceModule.exchange', { defaultValue: 'Exchange' })
        case 'post_service':
            return t('ledger.sourceModule.postService', {
                defaultValue: 'Post Service',
            })
        case 'car_rental':
            return t('ledger.sourceModule.carRental')
        case 'travel_transportation':
            return t('travelTransportation.title')
        default:
            return module
    }
}

function directionFilterLabel(direction: LedgerDirection, t: any) {
    switch (direction) {
        case 'incoming':
            return t('ledger.direction.inflow', { defaultValue: 'Inflow' })
        case 'outgoing':
            return t('ledger.direction.outflow', { defaultValue: 'Outflow' })
        case 'opening':
            return t('ledger.direction.opening', { defaultValue: 'Opening' })
        case 'adjustment':
            return t('ledger.direction.adjustment', { defaultValue: 'Adjustment' })
    }
}

function sortOptionLabel(value: LedgerSortOption, t: any) {
    switch (value) {
        case 'date_asc':
            return t('ledger.sortOption.dateAsc', {
                defaultValue: 'Date: Oldest First',
            })
        case 'amount_desc':
            return t('ledger.sortOption.amountDesc', {
                defaultValue: 'Amount: Highest First',
            })
        case 'amount_asc':
            return t('ledger.sortOption.amountAsc', {
                defaultValue: 'Amount: Lowest First',
            })
        default:
            return t('ledger.sortOption.dateDesc', {
                defaultValue: 'Date: Newest First',
            })
    }
}

function movementCategoryLabel(category: LedgerMovementCategory, t: any) {
    if (category === 'openingBalance') return t('ledger.filters.category.openingBalance')
    if (category === 'balanceAdjustment') return t('ledger.filters.category.balanceAdjustment')
    return t(`ledger.cashSummary.metrics.${category}.title`)
}

function transactionStateLabel(state: LedgerTransactionState, t: any) {
    return t(`ledger.filters.transactionState.${state}`)
}

function includeSelectedOptions<T extends string>(available: T[], selected: T[]) {
    return [...available, ...selected.filter((option) => !available.includes(option))]
}

function incrementFacetCount<T extends string>(counts: Map<T, number>, value: T) {
    counts.set(value, (counts.get(value) || 0) + 1)
}

interface LedgerMultiSelectProps<T extends string> {
    value: T[]
    options: T[]
    allLabel: string
    getOptionLabel: (option: T) => string
    getOptionCount?: (option: T) => number
    multipleLabel: string
    onChange: (value: T[]) => void
}

function LedgerMultiSelect<T extends string>({
    value,
    options,
    allLabel,
    getOptionLabel,
    getOptionCount,
    multipleLabel,
    onChange,
}: LedgerMultiSelectProps<T>) {
    const selectionLabel = value.length === 0 ? allLabel : value.length === 1 ? getOptionLabel(value[0]) : multipleLabel

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" className="w-full justify-between font-normal" title={selectionLabel}>
                    <span className="truncate">{selectionLabel}</span>
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto">
                <DropdownMenuCheckboxItem
                    checked={value.length === 0}
                    onCheckedChange={() => onChange([])}
                    onSelect={(event) => event.preventDefault()}
                >
                    {allLabel}
                </DropdownMenuCheckboxItem>
                {options.map((option) => (
                    <DropdownMenuCheckboxItem
                        key={option}
                        checked={value.includes(option)}
                        onCheckedChange={(checked) =>
                            onChange(
                                checked
                                    ? value.includes(option)
                                        ? value
                                        : [...value, option]
                                    : value.filter((selectedOption) => selectedOption !== option),
                            )
                        }
                        onSelect={(event) => event.preventDefault()}
                    >
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                            <span className="truncate">{getOptionLabel(option)}</span>
                            {getOptionCount ? (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold tabular-nums text-muted-foreground">
                                    {getOptionCount(option)}
                                </span>
                            ) : null}
                        </span>
                    </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

function formatAmountSummary(rows: Array<{ amount: number; currency: CurrencyCode }>, iqdPreference: IQDDisplayPreference): string[] {
    if (rows.length === 0) {
        return ['0']
    }

    const totals = new Map<string, number>()
    rows.forEach((row) => {
        totals.set(row.currency, (totals.get(row.currency) || 0) + row.amount)
    })

    return Array.from(totals.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => formatCurrency(amount, currency as CurrencyCode, iqdPreference))
}

function formatNetSummary(entries: LedgerEntry[], iqdPreference: IQDDisplayPreference): string[] {
    if (entries.length === 0) {
        return ['0']
    }

    const totals = new Map<string, number>()
    entries.forEach((entry) => {
        const signedAmount = getLedgerFlowSign(entry.direction) * entry.amount
        if (signedAmount === 0) return
        totals.set(entry.currency, (totals.get(entry.currency) || 0) + signedAmount)
    })

    if (totals.size === 0) {
        return ['0']
    }

    return Array.from(totals.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => {
            const sign = amount < 0 ? '-' : ''
            return `${sign}${formatCurrency(Math.abs(amount), currency as CurrencyCode, iqdPreference)}`
        })
}

interface LedgerTrendPoint {
    dateKey: string
    inflow: number
    outflow: number
    net: number
}

interface LedgerRelationRange {
    firstIndex: number
    lastIndex: number
}

function toLedgerDateKey(date: string) {
    if (/^\d{4}-\d{2}-\d{2}/.test(date)) {
        return date.slice(0, 10)
    }

    return new Date(date).toISOString().slice(0, 10)
}

function buildVisibleRelationMaps(entries: LedgerEntry[]) {
    const counts = new Map<string, number>()
    const ranges = new Map<string, LedgerRelationRange>()

    entries.forEach((entry, index) => {
        if (!entry.relationKey) {
            return
        }

        counts.set(entry.relationKey, (counts.get(entry.relationKey) || 0) + 1)

        const existingRange = ranges.get(entry.relationKey)
        if (!existingRange) {
            ranges.set(entry.relationKey, { firstIndex: index, lastIndex: index })
            return
        }

        existingRange.lastIndex = index
    })

    return { counts, ranges }
}

function formatTransactionIdForDisplay(transactionId: string, _compactTransactionId: boolean) {
    const dashIndex = transactionId.indexOf('-')
    if (dashIndex === -1) return transactionId
    return (
        <span className="inline-flex items-center gap-0.5">
            {transactionId.slice(0, dashIndex)}
            <span className="text-muted-foreground/50 text-[10px] font-mono">...</span>
        </span>
    )
}

function shouldOpenSaleDetails(entry: LedgerEntry) {
    return entry.type === 'pos_sale' || entry.type === 'instant_pos_sale'
}

function LedgerSparkline({
    data,
    dataKey,
    color,
    gradientId,
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

function buildReferenceId(prefix: string, id: string, sequenceId?: number) {
    return sequenceId ? `${prefix}-${sequenceId}` : `${prefix}-${id.slice(0, 8).toUpperCase()}`
}

function buildExchangeLedgerEntry(tx: any): LedgerEntry | null {
    if (tx.isDeleted || tx.isReversed || tx.transactionType !== 'sell' || tx.profitAmount == null || tx.profitAmount <= 0) {
        return null
    }
    return {
        id: `exchange:${tx.id}`,
        transactionId: tx.id,
        date: tx.transactionDate || tx.createdAt,
        type: 'exchange_profit',
        direction: 'incoming',
        amount: tx.profitAmount,
        currency: tx.profitCurrency || tx.fromCurrency || 'usd',
        sourceModule: 'exchange',
        referenceId: buildReferenceId('FX', tx.id, tx.transactionNo),
        partner: tx.employeeName || null,
        businessPartnerId: null,
        paymentMethod: tx.paymentMethod || null,
        notes: tx.notes || null,
        description:
            tx.notes || `${tx.customerGivesAmount} ${tx.fromCurrency} → ${tx.customerReceivesAmount} ${tx.toCurrency} @ ${tx.exchangeRateUsed}`,
        routePath: '/currency-exchange',
    }
}

function buildSaleReferenceId(sale: Pick<Sale, 'id' | 'origin' | 'sequenceId'>) {
    return buildReferenceId(sale.origin === 'instant_pos' ? 'IPOS' : 'POS', sale.id, sale.sequenceId)
}

function ledgerRelationRoleLabel(role: LedgerRelationRole, t: any) {
    switch (role) {
        case 'origin':
            return t('ledger.relationRole.origin', { defaultValue: 'Origin' })
        case 'repayment':
            return t('ledger.relationRole.repayment', { defaultValue: 'Repayment' })
        case 'settlement':
            return t('ledger.relationRole.settlement', {
                defaultValue: 'Settlement',
            })
        default:
            return t('ledger.relationRole.linked', { defaultValue: 'Linked' })
    }
}

interface LedgerBuildContext {
    loanById: Map<string, Loan>
    saleById: Map<string, Sale>
    loanOriginationIds: Set<string>
    realEstateTransactionById: Map<string, RealEstateTransaction>
    salesOrderById: Map<string, SalesOrder>
    purchaseOrderById: Map<string, PurchaseOrder>
    businessPartnerByName: Map<string, string>
    deliverySettlementById: Map<
        string,
        {
            agentId?: string | null
            merchantProfileId?: string | null
            businessPartnerId?: string | null
            shipmentId?: string | null
        }
    >
    deliveryShipmentById: Map<string, { trackingNumber: string; recipientPhone: string }>
    agentNameById: Map<string, string>
    agentBusinessPartnerIdById: Map<string, string>
    merchantNameByProfileId: Map<string, string>
    merchantBusinessPartnerIdByProfileId: Map<string, string>
}

function getSaleStorageIds(sale: Sale | undefined) {
    const enrichedItems =
        (
            sale as
                | (Sale & {
                      _enrichedItems?: Array<{ storage_id?: string | null }>
                  })
                | undefined
        )?._enrichedItems ?? []

    return Array.from(new Set(enrichedItems.map((item) => item.storage_id).filter((storageId): storageId is string => !!storageId)))
}

function getSalesOrderStorageIds(order: SalesOrder | undefined) {
    if (!order) return []

    return Array.from(
        new Set(
            (order.items || []).map((item) => item.storageId || order.sourceStorageId).filter((storageId): storageId is string => !!storageId),
        ),
    )
}

function buildSaleLedgerEntry(sale: Sale, t: any): LedgerEntry | null {
    if (sale.isDeleted || sale.isReturned) {
        return null
    }

    if (sale.origin !== 'pos' && sale.origin !== 'instant_pos') {
        return null
    }

    const paymentMethod = resolveSalePaymentMethod(sale)

    if (paymentMethod === 'loan') {
        return null
    }

    const isInstantPos = sale.origin === 'instant_pos'
    const descriptionParts = [paymentMethod ? `Paid via ${paymentMethodLabel(paymentMethod, t)}` : null, sale.notes?.trim() || null].filter(
        Boolean,
    )

    return {
        id: `sale:${sale.id}`,
        transactionId: sale.id,
        date: sale.createdAt,
        type: isInstantPos ? 'instant_pos_sale' : 'pos_sale',
        direction: 'incoming',
        amount: sale.totalAmount || 0,
        currency: sale.settlementCurrency,
        sourceModule: isInstantPos ? 'instant_pos' : 'pos',
        referenceId: buildSaleReferenceId(sale),
        partner: null,
        businessPartnerId: null,
        paymentMethod,
        notes: sale.notes?.trim() || null,
        description: descriptionParts.length > 0 ? descriptionParts.join(' | ') : null,
        routePath: '/sales',
        storageIds: getSaleStorageIds(sale),
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
        case 'real_estate_commission':
            return buildReferenceId('RE', transaction.sourceRecordId)
        case 'activity_transaction':
        case 'activity_refund':
            return buildReferenceId('ACT', transaction.sourceRecordId)
        case 'clinical_appointment':
            return buildReferenceId('APT', transaction.sourceRecordId)
        case 'delivery_courier_remittance':
            return buildReferenceId('CR', transaction.sourceRecordId)
        case 'delivery_courier_fee_payout':
            return buildReferenceId('CF', transaction.sourceRecordId)
        case 'delivery_courier_reimbursement':
            return buildReferenceId('CP', transaction.sourceRecordId)
        case 'delivery_merchant_payout':
            return buildReferenceId('MP', transaction.sourceRecordId)
        case 'delivery_recipient_payout':
            return buildReferenceId('RP', transaction.sourceRecordId)
        case 'delivery_merchant_repayment':
            return buildReferenceId('MR', transaction.sourceRecordId)
        case 'rental_payment':
        case 'rental_deposit':
        case 'rental_deposit_refund':
            return buildReferenceId('RNT', transaction.sourceRecordId)
        case 'travel_booking_payment':
            return buildReferenceId('TT', transaction.sourceRecordId)
        case 'payment_account_opening_balance':
            return buildReferenceId('PA', transaction.sourceRecordId)
        case 'payment_account_deposit':
            return buildReferenceId('PAD', transaction.sourceRecordId)
        case 'payment_account_withdrawal':
            return buildReferenceId('PAW', transaction.sourceRecordId)
        case 'payment_account_adjustment':
            return buildReferenceId('PAA', transaction.sourceRecordId)
        default:
            return buildReferenceId('LOAN', transaction.sourceRecordId)
    }
}

function buildTransactionDescription(transaction: PaymentTransaction, t: any) {
    const details: string[] = []

    if (transaction.note?.trim()) {
        details.push(transaction.note.trim())
    }

    if (transaction.paymentMethod && transaction.paymentMethod !== 'unknown') {
        details.push(`Via ${paymentMethodLabel(transaction.paymentMethod, t)}`)
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

    if (transaction.sourceType === 'real_estate_commission') {
        const location = typeof transaction.metadata?.propertyLocation === 'string' ? transaction.metadata.propertyLocation : null
        if (location) {
            details.push(location)
        }
    }

    if (transaction.sourceType === 'clinical_appointment') {
        const requestedService = typeof transaction.metadata?.requestedService === 'string' ? transaction.metadata.requestedService.trim() : null
        if (requestedService) {
            details.push(requestedService)
        }
    }

    return details.length > 0 ? details.join(' | ') : null
}

function buildLedgerRelationDescriptor(
    transaction: PaymentTransaction,
    context: LedgerBuildContext,
    t: any,
): Pick<LedgerEntry, 'relationKey' | 'relationRole' | 'relationTitle' | 'relationDescription' | 'relationIsCompleted'> {
    const reference = buildTransactionReference(transaction)
    const sourceLoan = context.loanById.get(transaction.sourceRecordId)
    const orderLoanCash = classifySalesOrderLoanCash(transaction, sourceLoan)

    if (orderLoanCash) {
        const salesOrder = context.salesOrderById.get(orderLoanCash.orderId)
        const linkedLoan =
            sourceLoan || (salesOrder?.linkedLoanId ? context.loanById.get(salesOrder.linkedLoanId) : undefined)
        const orderReference = salesOrder?.orderNumber || transaction.referenceLabel || orderLoanCash.orderId
        const loanReference = linkedLoan?.loanNo || reference
        const isRefund = orderLoanCash.type === 'order_loan_refund'

        return {
            relationKey: `loan:${linkedLoan?.id || transaction.sourceRecordId}`,
            relationRole: 'settlement',
            relationTitle: t(isRefund ? 'ledger.type.orderLoanRefund' : 'ledger.type.orderLoanCollection'),
            relationDescription: t(
                isRefund
                    ? 'ledger.description.orderLoanRefundRelation'
                    : 'ledger.description.orderLoanCollectionRelation',
                { orderReference, loanReference },
            ),
            relationIsCompleted: linkedLoan ? linkedLoan.balanceAmount <= 0 : false,
        }
    }

    switch (transaction.sourceType) {
        case 'loan_origination': {
            const loan = context.loanById.get(transaction.sourceRecordId)
            const relationIsCompleted = loan ? loan.balanceAmount <= 0 : false
            const movementLabel = transaction.direction === 'incoming' ? 'Original loan cash receipt' : 'Original loan cash disbursement'

            return {
                relationKey: `loan:${transaction.sourceRecordId}`,
                relationRole: 'origin',
                relationTitle: movementLabel,
                relationDescription: `${reference} is the opening cash movement for this loan. Hover a linked repayment to trace the full chain.`,
                relationIsCompleted,
            }
        }

        case 'loan_payment':
        case 'simple_loan':
        case 'loan_installment': {
            const loan = context.loanById.get(transaction.sourceRecordId)
            const relationIsCompleted = loan ? loan.balanceAmount <= 0 : false
            const sourceLoanReference = loan?.loanNo || reference
            const hasManualOrigination = context.loanOriginationIds.has(transaction.sourceRecordId)
            const repaymentLabel =
                transaction.sourceType === 'loan_installment'
                    ? 'Installment repayment'
                    : transaction.sourceType === 'simple_loan'
                      ? 'Simple loan repayment'
                      : 'Loan repayment'

            if (hasManualOrigination) {
                return {
                    relationKey: `loan:${transaction.sourceRecordId}`,
                    relationRole: 'repayment',
                    relationTitle: repaymentLabel,
                    relationDescription: `Original source: ${(loan?.direction || 'lent') === 'borrowed' ? 'Loan Taken' : 'Loan Given'} ${sourceLoanReference}. The matching origination row links to this repayment when it is visible in the ledger.`,
                    relationIsCompleted,
                }
            }

            if (loan?.source === 'pos') {
                const sourceSale = loan.saleId ? context.saleById.get(loan.saleId) : undefined
                const saleReference = sourceSale ? buildSaleReferenceId(sourceSale) : null

                return {
                    relationKey: `loan:${transaction.sourceRecordId}`,
                    relationRole: 'repayment',
                    relationTitle: repaymentLabel,
                    relationDescription: saleReference
                        ? `Original source: ${saleReference} credit sale. This loan started from a sale, so there is no separate cash origination row in the ledger.`
                        : 'Original source: POS credit sale. This loan started from a sale, so there is no separate cash origination row in the ledger.',
                    relationIsCompleted,
                }
            }

            return {
                relationKey: `loan:${transaction.sourceRecordId}`,
                relationRole: 'repayment',
                relationTitle: repaymentLabel,
                relationDescription: `Original source: ${sourceLoanReference}.`,
                relationIsCompleted,
            }
        }

        case 'real_estate_commission': {
            const realEstateTransaction = context.realEstateTransactionById.get(transaction.sourceRecordId)
            return {
                relationKey: `real-estate:${transaction.sourceRecordId}`,
                relationRole: 'settlement',
                relationTitle: 'Real estate commission',
                relationDescription: `Original source: ${realEstateTransaction?.transactionNo || reference}.`,
                relationIsCompleted: false,
            }
        }

        case 'activity_transaction':
        case 'activity_refund':
            return {
                relationKey: `activities:${transaction.sourceRecordId}`,
                relationRole: 'settlement',
                relationTitle: transaction.sourceType === 'activity_refund' ? 'Activity refund' : 'Activity transaction',
                relationDescription: `Original source: ${reference}.`,
                relationIsCompleted: transaction.sourceType === 'activity_refund',
            }

        case 'clinical_appointment':
            return {
                relationKey: `clinical-appointment:${transaction.sourceRecordId}`,
                relationRole: 'settlement',
                relationTitle: 'Appointment payment',
                relationDescription: `Original source: Appointment ${reference}.`,
            }

        case 'rental_payment':
        case 'rental_deposit':
        case 'rental_deposit_refund':
            return {
                relationKey: `rental-contract:${transaction.sourceRecordId}`,
                relationRole: 'settlement',
                relationTitle:
                    transaction.sourceType === 'rental_payment'
                        ? t('ledger.type.rentalPayment')
                        : transaction.sourceType === 'rental_deposit'
                          ? t('ledger.type.rentalDeposit')
                          : t('ledger.type.rentalDepositRefund'),
                relationDescription: t('ledger.description.carRentalRelation', {
                    reference,
                }),
            }

        case 'travel_booking_payment':
            return {
                relationKey: `travel-booking:${transaction.sourceRecordId}`,
                relationRole: 'settlement',
                relationTitle: t('travelTransportation.recordProfitPayment'),
                relationDescription: `${t('travelTransportation.bookingDetails')} ${reference}.`,
            }

        case 'sales_order': {
            const isReceivable = Boolean(transaction.metadata?.receivable)
            const sourceChannel =
                typeof transaction.metadata?.sourceChannel === 'string' ? transaction.metadata.sourceChannel.trim().toLowerCase() : null

            return {
                relationKey: `sales-order:${transaction.sourceRecordId}`,
                relationRole: isReceivable ? 'origin' : 'settlement',
                relationTitle: isReceivable ? 'Order receivable source' : 'Order settlement',
                relationDescription: `Original source: ${sourceChannel === 'marketplace' ? 'E-Commerce order' : 'Sales order'} ${reference}.`,
            }
        }

        case 'purchase_order':
            return {
                relationKey: `purchase-order:${transaction.sourceRecordId}`,
                relationRole: 'settlement',
                relationTitle: 'Purchase order settlement',
                relationDescription: `Original source: Purchase Order ${reference}.`,
            }

        case 'expense_item':
            return {
                relationKey: `expense:${transaction.sourceRecordId}`,
                relationRole: 'settlement',
                relationTitle: 'Expense settlement',
                relationDescription: `Original source: Expense ${reference}.`,
            }

        case 'payroll_status': {
            const month = typeof transaction.metadata?.month === 'string' ? transaction.metadata.month : null

            return {
                relationKey: `payroll:${transaction.sourceRecordId}`,
                relationRole: 'settlement',
                relationTitle: 'Payroll settlement',
                relationDescription: month ? `Original source: Payroll ${month}.` : `Original source: ${reference}.`,
            }
        }

        default:
            return {}
    }
}

function applyPaymentReversalToLedgerEntry(entry: LedgerEntry, transaction: PaymentTransaction, t: any): LedgerEntry {
    if (!transaction.reversalOfTransactionId) {
        return entry
    }

    const effect = getLedgerPaymentTransactionEffect(transaction)
    const reversalDescription = t('ledger.description.paymentReversal', {
        transactionId: transaction.reversalOfTransactionId,
    })

    return {
        ...entry,
        direction: effect.direction,
        amount: effect.amount,
        reversalOfTransactionId: transaction.reversalOfTransactionId,
        description: [reversalDescription, entry.description].filter(Boolean).join(' | ') || null,
    }
}

function buildPaymentLedgerEntry(transaction: PaymentTransaction, context: LedgerBuildContext, t: any): LedgerEntry | null {
    if (transaction.isDeleted) {
        return null
    }

    if (transaction.paymentMethod === 'loan' || transaction.paymentMethod === 'loan_adjustment') {
        return null
    }

    if (transaction.sourceType === 'direct_transaction') {
        const descriptionParts = [transaction.referenceLabel?.trim() || null, transaction.note?.trim() || null].filter(Boolean)

        return {
            id: `direct:${transaction.id}`,
            transactionId: transaction.id,
            date: transaction.paidAt,
            type: transaction.direction === 'incoming' ? 'direct_inflow' : 'direct_outflow',
            direction: transaction.direction,
            amount: transaction.amount,
            currency: transaction.currency,
            sourceModule: 'manual',
            referenceId: (transaction.referenceLabel || 'DIR').slice(0, 10).toUpperCase(),
            partner: transaction.counterpartyName || null,
            businessPartnerId: context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ?? null,
            paymentMethod: transaction.paymentMethod,
            notes: transaction.note?.trim() || null,
            description: descriptionParts.length > 0 ? descriptionParts.join(' | ') : null,
            routePath: '/direct-transactions',
        }
    }

    if (transaction.sourceType === 'payment_account_opening_balance') {
        return {
            id: `payment:${transaction.id}`,
            transactionId: transaction.id,
            date: transaction.paidAt,
            type: 'payment_account_opening_balance',
            // It increases the payment account, but it is an opening position
            // rather than cash received during this reporting period.
            direction: 'opening',
            amount: transaction.amount,
            currency: transaction.currency,
            sourceModule: 'payment_accounts',
            referenceId: buildTransactionReference(transaction),
            partner: null,
            businessPartnerId: null,
            paymentMethod: transaction.paymentMethod,
            paymentAccount: transaction.accountNameSnapshot || null,
            notes: transaction.note?.trim() || null,
            description: t('paymentAccounts.openingBalanceDescription', {
                defaultValue: 'Opening amount recorded when this payment account was created.',
            }),
            routePath: '/payment-accounts',
        }
    }

    if (
        transaction.sourceType === 'payment_account_deposit' ||
        transaction.sourceType === 'payment_account_withdrawal' ||
        transaction.sourceType === 'payment_account_adjustment'
    ) {
        return {
            id: `payment:${transaction.id}`,
            transactionId: transaction.id,
            date: transaction.paidAt,
            type: transaction.sourceType,
            direction: transaction.sourceType === 'payment_account_adjustment' ? 'adjustment' : transaction.direction,
            amount: transaction.amount,
            currency: transaction.currency,
            sourceModule: 'payment_accounts',
            referenceId: buildTransactionReference(transaction),
            partner: null,
            businessPartnerId: null,
            paymentMethod: transaction.paymentMethod,
            paymentAccount: transaction.accountNameSnapshot || null,
            notes: transaction.note?.trim() || null,
            description:
                transaction.sourceType === 'payment_account_adjustment'
                    ? t('paymentAccounts.adjustmentLedgerDescription', {
                          defaultValue: 'Audited balance adjustment.',
                      })
                    : t('paymentAccounts.manualOperationLedgerDescription', {
                          defaultValue: 'Manual payment-account movement.',
                      }),
            routePath: '/payment-accounts',
        }
    }

    const installmentSalePayment = getInstallmentSaleLedgerPayment(transaction)
    if (installmentSalePayment) {
        const description = [
            t(`ledger.description.${installmentSalePayment.descriptionKey}`, {
                reference: installmentSalePayment.referenceId,
            }),
            buildTransactionDescription(transaction, t),
        ]
            .filter(Boolean)
            .join(' | ')

        return {
            id: `payment:${transaction.id}`,
            transactionId: transaction.id,
            date: transaction.paidAt,
            type: installmentSalePayment.type,
            direction: 'incoming',
            amount: transaction.amount,
            currency: transaction.currency,
            sourceModule: 'installment_sales',
            referenceId: installmentSalePayment.referenceId,
            partner: installmentSalePayment.partner,
            businessPartnerId:
                installmentSalePayment.businessPartnerId ||
                context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ||
                null,
            paymentMethod: transaction.paymentMethod || 'unknown',
            notes: transaction.note?.trim() || null,
            description: description || null,
            routePath: getPaymentTransactionRoutePath(transaction),
            relationKey: installmentSalePayment.relationKey,
            relationRole: 'settlement',
            relationTitle: ledgerTypeLabel(installmentSalePayment.type, t),
            relationDescription: description || null,
        }
    }

    const relation = buildLedgerRelationDescriptor(transaction, context, t)

    switch (transaction.sourceType) {
        case 'delivery_courier_remittance':
        case 'delivery_courier_fee_payout':
        case 'delivery_courier_reimbursement':
        case 'delivery_merchant_payout':
        case 'delivery_recipient_payout':
        case 'delivery_merchant_repayment': {
            const isCourierRemittance = transaction.sourceType === 'delivery_courier_remittance'
            const isCourierFeePayout = transaction.sourceType === 'delivery_courier_fee_payout'
            const isCourierReimbursement = transaction.sourceType === 'delivery_courier_reimbursement'
            const isRecipientPayout = transaction.sourceType === 'delivery_recipient_payout'
            const isMerchantRepayment = transaction.sourceType === 'delivery_merchant_repayment'
            const settlement = context.deliverySettlementById.get(transaction.sourceRecordId)
            const metadataAgentId = typeof transaction.metadata?.deliveryAgentId === 'string' ? transaction.metadata.deliveryAgentId : null
            const metadataProfileId =
                typeof transaction.metadata?.deliveryMerchantProfileId === 'string' ? transaction.metadata.deliveryMerchantProfileId : null
            const metadataShipmentId =
                typeof transaction.metadata?.deliveryShipmentId === 'string' ? transaction.metadata.deliveryShipmentId : null
            const agentId = settlement?.agentId || metadataAgentId
            const merchantProfileId = settlement?.merchantProfileId || metadataProfileId
            const shipmentId = settlement?.shipmentId || metadataShipmentId
            const shipment = shipmentId ? context.deliveryShipmentById.get(shipmentId) : null
            const linkedBusinessPartnerId = isRecipientPayout
                ? null
                : settlement?.businessPartnerId ||
                  (typeof transaction.metadata?.businessPartnerId === 'string' ? transaction.metadata.businessPartnerId : null) ||
                  (agentId ? context.agentBusinessPartnerIdById.get(agentId) : null) ||
                  (merchantProfileId ? context.merchantBusinessPartnerIdByProfileId.get(merchantProfileId) : null) ||
                  null
            const partner =
                transaction.counterpartyName ||
                (agentId ? context.agentNameById.get(agentId) : null) ||
                (merchantProfileId ? context.merchantNameByProfileId.get(merchantProfileId) : null) ||
                null
            const relation = shipmentId
                ? {
                      // The two real cash movements for one post belong to the
                      // same visual chain in Ledger, even when each is settled
                      // in several partial payments.
                      relationKey: `delivery-shipment:${shipmentId}`,
                      relationRole: isCourierRemittance || isRecipientPayout ? ('origin' as const) : ('settlement' as const),
                      relationTitle: isCourierRemittance
                          ? t('ledger.type.deliveryCourierRemittance', {
                                defaultValue: 'Courier Remittance',
                            })
                          : isCourierFeePayout
                            ? t('ledger.type.deliveryCourierFeePayout', {
                                  defaultValue: 'Courier Fee Payment',
                              })
                            : isCourierReimbursement
                              ? t('ledger.type.deliveryCourierReimbursement', {
                                    defaultValue: 'Courier Reimbursement',
                                })
                              : isRecipientPayout
                                ? t('ledger.type.deliveryRecipientPayout', {
                                      defaultValue: 'Recipient Payout',
                                  })
                                : isMerchantRepayment
                                  ? t('ledger.type.deliveryMerchantRepayment', {
                                        defaultValue: 'Merchant Repayment',
                                    })
                                  : t('ledger.type.deliveryMerchantPayout', {
                                        defaultValue: 'Merchant Payout',
                                    }),
                      relationDescription: isCourierRemittance
                          ? t('ledger.description.deliveryPostCourierRelation', {
                                defaultValue: 'Post {{tracking}} · courier cash handover for {{recipient}}.',
                                tracking: shipment?.trackingNumber || shipmentId,
                                recipient: shipment?.recipientPhone || t('common.unknown', { defaultValue: 'Unknown recipient' }),
                            })
                          : isCourierFeePayout
                            ? t('ledger.description.deliveryPostCourierFeePayoutRelation', {
                                  defaultValue: 'Post {{tracking}} · courier fee paid to {{recipient}}.',
                                  tracking: shipment?.trackingNumber || shipmentId,
                                  recipient:
                                      shipment?.recipientPhone ||
                                      t('common.unknown', {
                                          defaultValue: 'Unknown recipient',
                                      }),
                              })
                            : isCourierReimbursement
                              ? t('ledger.description.deliveryPostCourierReimbursementRelation', {
                                    defaultValue: 'Post {{tracking}} · courier reimbursed for their advance to {{recipient}}.',
                                    tracking: shipment?.trackingNumber || shipmentId,
                                    recipient:
                                        shipment?.recipientPhone ||
                                        t('common.unknown', {
                                            defaultValue: 'Unknown recipient',
                                        }),
                                })
                              : isRecipientPayout
                                ? t('ledger.description.deliveryPostRecipientPayoutRelation', {
                                      defaultValue: 'Post {{tracking}} · payout made to {{recipient}}.',
                                      tracking: shipment?.trackingNumber || shipmentId,
                                      recipient:
                                          shipment?.recipientPhone ||
                                          t('common.unknown', {
                                              defaultValue: 'Unknown recipient',
                                          }),
                                  })
                                : isMerchantRepayment
                                  ? t('ledger.description.deliveryPostMerchantRepaymentRelation', {
                                        defaultValue: 'Post {{tracking}} · payment received from the merchant for {{recipient}}.',
                                        tracking: shipment?.trackingNumber || shipmentId,
                                        recipient:
                                            shipment?.recipientPhone ||
                                            t('common.unknown', {
                                                defaultValue: 'Unknown recipient',
                                            }),
                                    })
                                  : t('ledger.description.deliveryPostMerchantRelation', {
                                        defaultValue: 'Post {{tracking}} · merchant payout for {{recipient}}.',
                                        tracking: shipment?.trackingNumber || shipmentId,
                                        recipient:
                                            shipment?.recipientPhone ||
                                            t('common.unknown', {
                                                defaultValue: 'Unknown recipient',
                                            }),
                                    }),
                  }
                : {
                      // A party-level settlement has no truthful per-post
                      // relation, so retain an isolated settlement descriptor.
                      relationKey: `delivery-settlement:${transaction.sourceRecordId}`,
                      relationRole: 'settlement' as const,
                      relationTitle: isCourierRemittance
                          ? t('ledger.type.deliveryCourierRemittance', {
                                defaultValue: 'Courier Remittance',
                            })
                          : isCourierFeePayout
                            ? t('ledger.type.deliveryCourierFeePayout', {
                                  defaultValue: 'Courier Fee Payment',
                              })
                            : isCourierReimbursement
                              ? t('ledger.type.deliveryCourierReimbursement', {
                                    defaultValue: 'Courier Reimbursement',
                                })
                              : isRecipientPayout
                                ? t('ledger.type.deliveryRecipientPayout', {
                                      defaultValue: 'Recipient Payout',
                                  })
                                : isMerchantRepayment
                                  ? t('ledger.type.deliveryMerchantRepayment', {
                                        defaultValue: 'Merchant Repayment',
                                    })
                                  : t('ledger.type.deliveryMerchantPayout', {
                                        defaultValue: 'Merchant Payout',
                                    }),
                      relationDescription: t('ledger.description.deliverySettlementRelation', {
                          defaultValue: 'Post Service settlement {{reference}}.',
                          reference: buildTransactionReference(transaction),
                      }),
                  }

            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: transaction.sourceType,
                direction: transaction.direction,
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'post_service',
                referenceId: buildTransactionReference(transaction),
                partner,
                businessPartnerId: linkedBusinessPartnerId,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description:
                    buildTransactionDescription(transaction, t) ||
                    (isCourierRemittance
                        ? t('ledger.description.deliveryCourierRemittance', {
                              defaultValue: 'Courier cash handover',
                          })
                        : isCourierFeePayout
                          ? t('ledger.description.deliveryCourierFeePayout', {
                                defaultValue: 'Courier fee payment',
                            })
                          : isCourierReimbursement
                            ? t('ledger.description.deliveryCourierReimbursement', {
                                  defaultValue: 'Courier reimbursement',
                              })
                            : isRecipientPayout
                              ? t('ledger.description.deliveryRecipientPayout', {
                                    defaultValue: 'Recipient payout',
                                })
                              : isMerchantRepayment
                                ? t('ledger.description.deliveryMerchantRepayment', {
                                      defaultValue: 'Merchant repayment received',
                                  })
                                : t('ledger.description.deliveryMerchantPayout', {
                                      defaultValue: 'Merchant payout',
                                  })),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        }
        case 'loan_origination': {
            const originationLoan = context.loanById.get(transaction.sourceRecordId)
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: transaction.direction === 'incoming' ? 'loan_taken' : 'loan_given',
                direction: transaction.direction,
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'loans',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId:
                    originationLoan?.linkedPartyId ??
                    context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ??
                    null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description:
                    buildTransactionDescription(transaction, t) || (transaction.direction === 'incoming' ? 'Loan received' : 'Loan disbursed'),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        }
        case 'sales_order': {
            const sourceChannel =
                typeof transaction.metadata?.sourceChannel === 'string' ? transaction.metadata.sourceChannel.trim().toLowerCase() : null
            const isMarketplace = sourceChannel === 'marketplace'
            const isReceivable = Boolean(transaction.metadata?.receivable)
            // Marketplace delivery can create a synthetic credit transaction to
            // register a receivable. Ledger is a completed-cash surface, so the
            // obligation stays in CRM/Payments until a real collection posts.
            if (isReceivable) return null
            const salesOrder = context.salesOrderById.get(transaction.sourceRecordId)
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: isMarketplace ? 'ecommerce_payment' : 'sales_order_payment',
                direction: 'incoming',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'orders',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId:
                    salesOrder?.businessPartnerId ??
                    context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ??
                    null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                storageIds: getSalesOrderStorageIds(salesOrder),
                ...relation,
            }
        }
        case 'purchase_order': {
            const purchaseOrder = context.purchaseOrderById.get(transaction.sourceRecordId)
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
                businessPartnerId:
                    purchaseOrder?.businessPartnerId ??
                    context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ??
                    null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
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
                businessPartnerId: context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ?? null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
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
                businessPartnerId: context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ?? null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        case 'real_estate_payment':
        case 'real_estate_installment':
            return null
        case 'rental_payment':
        case 'rental_deposit':
        case 'rental_deposit_refund': {
            const linkedBusinessPartnerId =
                typeof transaction.metadata?.businessPartnerId === 'string' ? transaction.metadata.businessPartnerId : null
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: transaction.sourceType,
                direction: transaction.direction,
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'car_rental',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId:
                    linkedBusinessPartnerId ||
                    context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ||
                    null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        }
        case 'travel_booking_payment':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: 'travel_booking_profit',
                direction: 'incoming',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'travel_transportation',
                referenceId: buildTransactionReference(transaction),
                partner: null,
                businessPartnerId: null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        case 'real_estate_commission': {
            const realEstateTransaction = context.realEstateTransactionById.get(transaction.sourceRecordId)
            const linkedBusinessPartnerId =
                typeof transaction.metadata?.businessPartnerId === 'string' && transaction.metadata.businessPartnerId
                    ? transaction.metadata.businessPartnerId
                    : null
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: 'real_estate_commission',
                direction: 'incoming',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'real_estate',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId:
                    linkedBusinessPartnerId ??
                    realEstateTransaction?.buyerBusinessPartnerId ??
                    realEstateTransaction?.sellerBusinessPartnerId ??
                    context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ??
                    null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        }
        case 'activity_transaction':
        case 'activity_refund':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: transaction.sourceType,
                direction: transaction.direction,
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'activities',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId: context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ?? null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        case 'clinical_appointment':
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: 'clinical_appointment_payment',
                direction: 'incoming',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'clinical_appointments',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId: context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ?? null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        case 'loan_installment': {
            const installmentLoan = context.loanById.get(transaction.sourceRecordId)
            const orderLoanCash = classifySalesOrderLoanCash(transaction, installmentLoan)
            const salesOrder = orderLoanCash ? context.salesOrderById.get(orderLoanCash.orderId) : undefined
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: orderLoanCash?.type || (transaction.direction === 'incoming' ? 'installment_received' : 'installment_paid'),
                direction: orderLoanCash?.direction || transaction.direction,
                amount: orderLoanCash?.amount ?? transaction.amount,
                currency: transaction.currency,
                sourceModule: orderLoanCash ? 'order_financing' : 'loans',
                referenceId: salesOrder?.orderNumber || buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId:
                    installmentLoan?.linkedPartyId ??
                    context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ??
                    null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: orderLoanCash ? `/orders/${orderLoanCash.orderId}` : getPaymentTransactionRoutePath(transaction),
                storageIds: getSaleStorageIds(installmentLoan?.saleId ? context.saleById.get(installmentLoan.saleId) : undefined),
                ...relation,
            }
        }
        case 'loan_payment':
        case 'simple_loan': {
            const loanPaymentLoan = context.loanById.get(transaction.sourceRecordId)
            const orderLoanCash = classifySalesOrderLoanCash(transaction, loanPaymentLoan)
            const salesOrder = orderLoanCash ? context.salesOrderById.get(orderLoanCash.orderId) : undefined
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: orderLoanCash?.type || (transaction.direction === 'incoming' ? 'loan_repayment_received' : 'loan_repayment_paid'),
                direction: orderLoanCash?.direction || transaction.direction,
                amount: orderLoanCash?.amount ?? transaction.amount,
                currency: transaction.currency,
                sourceModule: orderLoanCash ? 'order_financing' : 'loans',
                referenceId: salesOrder?.orderNumber || buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId:
                    loanPaymentLoan?.linkedPartyId ??
                    context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ??
                    null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: orderLoanCash ? `/orders/${orderLoanCash.orderId}` : getPaymentTransactionRoutePath(transaction),
                storageIds: getSaleStorageIds(loanPaymentLoan?.saleId ? context.saleById.get(loanPaymentLoan.saleId) : undefined),
                ...relation,
            }
        }
        case 'order_return': {
            const orderLoanCash = classifySalesOrderLoanCash(transaction)
            if (!orderLoanCash) return null
            const salesOrder = context.salesOrderById.get(orderLoanCash.orderId)
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: orderLoanCash.type,
                direction: orderLoanCash.direction,
                amount: orderLoanCash.amount,
                currency: transaction.currency,
                sourceModule: 'order_financing',
                referenceId: salesOrder?.orderNumber || buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId:
                    salesOrder?.businessPartnerId ??
                    context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ??
                    null,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: `/orders/${orderLoanCash.orderId}`,
                storageIds: getSalesOrderStorageIds(salesOrder),
                ...relation,
            }
        }
        case 'agent_commission_payout': {
            const metadataAgentId = typeof transaction.metadata?.agentId === 'string' ? transaction.metadata.agentId : null
            const linkedBusinessPartnerId = metadataAgentId
                ? (context.agentBusinessPartnerIdById.get(metadataAgentId) ?? null)
                : (context.businessPartnerByName.get(transaction.counterpartyName?.trim().toLowerCase() ?? '') ?? null)
            return {
                id: `payment:${transaction.id}`,
                transactionId: transaction.id,
                date: transaction.paidAt,
                type: 'agent_commission_payout',
                direction: 'outgoing',
                amount: transaction.amount,
                currency: transaction.currency,
                sourceModule: 'orders',
                referenceId: buildTransactionReference(transaction),
                partner: transaction.counterpartyName || null,
                businessPartnerId: linkedBusinessPartnerId,
                paymentMethod: transaction.paymentMethod || 'unknown',
                notes: transaction.note?.trim() || null,
                description: buildTransactionDescription(transaction, t),
                routePath: getPaymentTransactionRoutePath(transaction),
                ...relation,
            }
        }
        default:
            return null
    }
}

export function Ledger() {
    const { user } = useAuth()
    const { t, i18n } = useTranslation()
    const { dateRange, customDates } = useDateRange()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()

    const scrollToRow = (id: string) => {
        const element = document.getElementById(`ledger-row-${id}`)
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' })
            element.classList.add('bg-accent/40', 'transition-colors', 'duration-500')
            setTimeout(() => {
                if (element) {
                    element.classList.remove('bg-accent/40', 'transition-colors', 'duration-500')
                }
            }, 1500)
        }
    }
    const { features, hasCapability, updateSettings } = useWorkspace()
    const { style } = useTheme()
    const [, setLocation] = useLocation()
    const workspaceId = user?.workspaceId
    const baseCurrency = (features.default_currency || 'usd') as CurrencyCode
    const hasLedgerSurface =
        features.pos ||
        features.instant_pos ||
        features.sales_history ||
        features.crm ||
        features.budget ||
        features.hr ||
        features.loans ||
        features.real_estate ||
        features.activities ||
        features.clinical_appointments ||
        features.post_service ||
        features.car_rental ||
        features.travel_transportation

    const dateBounds = useMemo<{ startDate?: string; endDate?: string }>(() => {
        const { start, end } = getDateRangeBounds(dateRange, customDates)
        return {
            startDate: start?.toISOString(),
            endDate: end ? new Date(end.getTime() - 1).toISOString() : undefined,
        }
    }, [dateRange, customDates])

    const loans = useLoans(workspaceId)
    const realEstateTransactions = useRealEstateTransactions(workspaceId)
    const sales = useSales(workspaceId, dateBounds.startDate, dateBounds.endDate)
    // Ledger already subscribes to every source table it needs below. Avoid the
    // generic payment hook's full source-table hydration here: it fans out into
    // many remote reads and Dexie writes during route entry, delaying the first
    // Ledger paint without adding data this page has not requested itself.
    const paymentTransactions = usePaymentTransactions(workspaceId, { includeReversals: true }, { hydrateSourceTables: false })
    const salesOrders = useSalesOrders(workspaceId, dateBounds.startDate, dateBounds.endDate)
    const purchaseOrders = usePurchaseOrders(workspaceId)
    const businessPartners = useBusinessPartners(workspaceId, {
        includeAgentRoles: true,
    })
    const agents = useAgents(workspaceId)
    const deliveryMerchantProfiles = useDeliveryMerchantProfiles(workspaceId)
    const deliverySettlements = useDeliverySettlements(workspaceId)
    const deliveryShipments = useDeliveryShipments(workspaceId)
    const rawExchangeTransactions = useExchangeTransactions(workspaceId)
    const ledgerPaymentTransactions = useMemo(() => getLedgerPaymentTransactions(paymentTransactions), [paymentTransactions])
    const ledgerCashMovementEntries = useMemo(
        () =>
            getLedgerCashMovementEntries({
                sales,
                paymentTransactions: ledgerPaymentTransactions,
                loans,
                exchangeTransactions: rawExchangeTransactions || [],
            }),
        [ledgerPaymentTransactions, loans, rawExchangeTransactions, sales],
    )
    const rates = useMemo(() => buildConversionRates(exchangeData, eurRates, tryRates), [eurRates, exchangeData, tryRates])

    const [filters, setFilters] = useState<LedgerFilterState>(DEFAULT_LEDGER_FILTERS)
    const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
    const [draftFilters, setDraftFilters] = useState<LedgerFilterState>(DEFAULT_LEDGER_FILTERS)
    const [hoveredRelationKey, setHoveredRelationKey] = useState<string | null>(null)
    const [isDirectionSplitView, setIsDirectionSplitView] = useState(false)
    const [isExportModalOpen, setIsExportModalOpen] = useState(false)
    const [summaryDrilldown, setSummaryDrilldown] = useState<LedgerCashDrilldownId | null>(null)

    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(() => {
        return Number(localStorage.getItem('ledger_page_size')) || 50
    })

    useEffect(() => {
        localStorage.setItem('ledger_page_size', String(pageSize))
    }, [pageSize])

    const deferredSearch = useDeferredValue(filters.search)
    const loanById = useMemo(() => new Map(loans.map((loan) => [loan.id, loan])), [loans])
    const realEstateTransactionById = useMemo(
        () => new Map(realEstateTransactions.map((transaction) => [transaction.id, transaction])),
        [realEstateTransactions],
    )
    const saleById = useMemo(() => new Map(sales.map((sale) => [sale.id, sale])), [sales])
    const loanOriginationIds = useMemo(
        () =>
            new Set(
                ledgerPaymentTransactions
                    .filter((transaction) => transaction.sourceType === 'loan_origination')
                    .map((transaction) => transaction.sourceRecordId),
            ),
        [ledgerPaymentTransactions],
    )
    const salesOrderById = useMemo(() => new Map(salesOrders.map((order) => [order.id, order])), [salesOrders])
    const purchaseOrderById = useMemo(() => new Map(purchaseOrders.map((order) => [order.id, order])), [purchaseOrders])
    const businessPartnerByName = useMemo(
        () => new Map(businessPartners.filter((bp) => bp.partnerName.trim()).map((bp) => [bp.partnerName.trim().toLowerCase(), bp.id])),
        [businessPartners],
    )
    const businessPartnerNameById = useMemo(
        () => new Map(businessPartners.map((partner) => [partner.id, partner.partnerName] as const)),
        [businessPartners],
    )
    const agentNameById = useMemo(
        () => new Map(agents.map((agent) => [agent.id, businessPartnerNameById.get(agent.businessPartnerId) || ''] as const)),
        [agents, businessPartnerNameById],
    )
    const agentBusinessPartnerIdById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.businessPartnerId] as const)), [agents])
    const merchantNameByProfileId = useMemo(
        () =>
            new Map(
                deliveryMerchantProfiles.map((profile) => [profile.id, businessPartnerNameById.get(profile.businessPartnerId) || ''] as const),
            ),
        [businessPartnerNameById, deliveryMerchantProfiles],
    )
    const merchantBusinessPartnerIdByProfileId = useMemo(
        () => new Map(deliveryMerchantProfiles.map((profile) => [profile.id, profile.businessPartnerId] as const)),
        [deliveryMerchantProfiles],
    )
    const deliverySettlementById = useMemo(
        () => new Map(deliverySettlements.map((settlement) => [settlement.id, settlement] as const)),
        [deliverySettlements],
    )
    const deliveryShipmentById = useMemo(
        () => new Map(deliveryShipments.map((shipment) => [shipment.id, shipment] as const)),
        [deliveryShipments],
    )

    const allEntries = useMemo(() => {
        const context: LedgerBuildContext = {
            loanById,
            saleById,
            loanOriginationIds,
            realEstateTransactionById,
            salesOrderById,
            purchaseOrderById,
            businessPartnerByName,
            deliverySettlementById,
            deliveryShipmentById,
            agentNameById,
            agentBusinessPartnerIdById,
            merchantNameByProfileId,
            merchantBusinessPartnerIdByProfileId,
        }
        const paymentEntries: LedgerEntry[] = ledgerPaymentTransactions
            .map<LedgerEntry | null>((transaction) => {
                const entry = buildPaymentLedgerEntry(transaction, context, t)
                return entry
                      ? {
                          ...applyPaymentReversalToLedgerEntry(entry, transaction, t),
                          paymentAccountId: transaction.accountId || null,
                          paymentAccount: transaction.accountNameSnapshot || null,
                      }
                    : null
            })
            .filter((entry): entry is LedgerEntry => entry !== null)

        const rows: LedgerEntry[] = [
            ...sales.map((s) => buildSaleLedgerEntry(s, t)).filter((entry): entry is LedgerEntry => !!entry),
            ...paymentEntries,
            ...(rawExchangeTransactions || []).map((tx) => buildExchangeLedgerEntry(tx)).filter((entry): entry is LedgerEntry => !!entry),
        ]

        return rows.sort((left, right) => right.date.localeCompare(left.date) || right.transactionId.localeCompare(left.transactionId))
    }, [
        ledgerPaymentTransactions,
        loanById,
        loanOriginationIds,
        realEstateTransactionById,
        saleById,
        sales,
        salesOrderById,
        purchaseOrderById,
        businessPartnerByName,
        deliverySettlementById,
        deliveryShipmentById,
        agentNameById,
        agentBusinessPartnerIdById,
        merchantNameByProfileId,
        merchantBusinessPartnerIdByProfileId,
        rawExchangeTransactions,
        t,
    ])

    const isLoading = sales === undefined
    const [isDateLoading, setIsDateLoading] = useState(false)
    const prevDateBoundsRef = useRef(dateBounds)

    useEffect(() => {
        const prev = prevDateBoundsRef.current
        prevDateBoundsRef.current = dateBounds
        if (dateRange !== 'allTime' && (prev.startDate !== dateBounds.startDate || prev.endDate !== dateBounds.endDate)) {
            setIsDateLoading(true)
        }
    }, [dateBounds, dateRange])

    useEffect(() => {
        if (isDateLoading && !isLoading && allEntries.length > 0) {
            setIsDateLoading(false)
        }
    }, [isDateLoading, isLoading, allEntries])

    const dateScopedEntries = useMemo(
        () => allEntries.filter((entry) => isEntryInDateRange(entry.date, dateRange, customDates)),
        [allEntries, customDates, dateRange],
    )
    const dateScopedCashMovementEntries = useMemo(
        () => ledgerCashMovementEntries.filter((entry) => isEntryInDateRange(entry.date, dateRange, customDates)),
        [customDates, dateRange, ledgerCashMovementEntries],
    )

    const filterFacets = useMemo(() => {
        const directionCounts = new Map<LedgerDirection, number>()
        const categoryCounts = new Map<LedgerMovementCategory, number>()
        const transactionStateCounts = new Map<LedgerTransactionState, number>()
        const typeCounts = new Map<LedgerEntryType, number>()
        const sourceCounts = new Map<LedgerSourceModule, number>()
        const counterpartyCounts = new Map<string, number>()
        const currencyCounts = new Map<CurrencyCode, number>()
        const paymentMethodCounts = new Map<string, number>()
        const paymentAccountCounts = new Map<string, number>()
        const counterpartyLabels = new Map<string, string>()
        const paymentAccountLabels = new Map<string, string>()

        allEntries.forEach((entry) => {
            const counterpartyKey = getLedgerCounterpartyFilterKey(entry)
            const paymentAccountKey = getLedgerPaymentAccountFilterKey(entry)
            counterpartyLabels.set(
                counterpartyKey,
                counterpartyKey === LEDGER_NO_COUNTERPARTY
                    ? t('ledger.filters.noCounterparty')
                    : entry.partner?.trim() ||
                          (entry.businessPartnerId ? businessPartnerNameById.get(entry.businessPartnerId) : null) ||
                          t('ledger.filters.unknownCounterparty'),
            )
            paymentAccountLabels.set(
                paymentAccountKey,
                paymentAccountKey === LEDGER_UNASSIGNED_PAYMENT_ACCOUNT
                    ? t('ledger.filters.unassignedPaymentAccount')
                    : entry.paymentAccount?.trim() || t('ledger.filters.unknownPaymentAccount'),
            )
        })

        dateScopedEntries.forEach((entry) => {
            incrementFacetCount(directionCounts, entry.direction)
            const category = getLedgerMovementCategory(entry)
            if (category) incrementFacetCount(categoryCounts, category)
            incrementFacetCount(transactionStateCounts, getLedgerTransactionState(entry))
            incrementFacetCount(typeCounts, entry.type)
            incrementFacetCount(sourceCounts, entry.sourceModule)
            incrementFacetCount(counterpartyCounts, getLedgerCounterpartyFilterKey(entry))
            incrementFacetCount(currencyCounts, entry.currency)
            incrementFacetCount(paymentMethodCounts, entry.paymentMethod || 'unknown')
            incrementFacetCount(paymentAccountCounts, getLedgerPaymentAccountFilterKey(entry))
        })

        const byLabel = (left: string, right: string) => left.localeCompare(right, i18n.language)

        return {
            direction: (['incoming', 'outgoing', 'opening', 'adjustment'] as LedgerDirection[]).filter((value) =>
                directionCounts.has(value),
            ),
            category: LEDGER_MOVEMENT_CATEGORY_IDS.filter((value) => categoryCounts.has(value)),
            transactionState: (['standard', 'reversal'] as LedgerTransactionState[]).filter((value) =>
                transactionStateCounts.has(value),
            ),
            type: Array.from(typeCounts.keys()).sort((left, right) => byLabel(ledgerTypeLabel(left, t), ledgerTypeLabel(right, t))),
            source: Array.from(sourceCounts.keys()).sort((left, right) =>
                byLabel(sourceModuleLabel(left, t), sourceModuleLabel(right, t)),
            ),
            counterparty: Array.from(counterpartyCounts.keys()).sort((left, right) =>
                byLabel(counterpartyLabels.get(left) || left, counterpartyLabels.get(right) || right),
            ),
            currency: Array.from(currencyCounts.keys()).sort((left, right) => left.localeCompare(right)),
            paymentMethods: Array.from(paymentMethodCounts.keys()).sort((left, right) =>
                byLabel(paymentMethodLabel(left, t), paymentMethodLabel(right, t)),
            ),
            paymentAccounts: Array.from(paymentAccountCounts.keys()).sort((left, right) =>
                byLabel(paymentAccountLabels.get(left) || left, paymentAccountLabels.get(right) || right),
            ),
            counts: {
                direction: directionCounts,
                category: categoryCounts,
                transactionState: transactionStateCounts,
                type: typeCounts,
                source: sourceCounts,
                counterparty: counterpartyCounts,
                currency: currencyCounts,
                paymentMethods: paymentMethodCounts,
                paymentAccounts: paymentAccountCounts,
            },
            counterpartyLabels,
            paymentAccountLabels,
        }
    }, [allEntries, businessPartnerNameById, dateScopedEntries, i18n.language, t])

    const effectiveFilters = useMemo(() => ({ ...filters, search: deferredSearch }), [deferredSearch, filters])

    const baseFilteredEntries = useMemo(
        () =>
            applyGeneralLedgerFilters(dateScopedEntries, effectiveFilters, (entry) => {
                const category = getLedgerMovementCategory(entry)
                return [
                    ledgerTypeLabel(entry.type, t),
                    sourceModuleLabel(entry.sourceModule, t),
                    category ? movementCategoryLabel(category, t) : null,
                    transactionStateLabel(getLedgerTransactionState(entry), t),
                ]
            }),
        [dateScopedEntries, effectiveFilters, t],
    )
    const filteredEntries = useMemo(
        () => baseFilteredEntries.filter((entry) => isLedgerCashDrilldownMatch(entry, summaryDrilldown)),
        [baseFilteredEntries, summaryDrilldown],
    )
    const ledgerExportData = useMemo(() => {
        return filteredEntries.map((entry) => ({
            [t('ledger.table.date') || 'Date']: formatDateTime(entry.date),
            [t('ledger.table.type') || 'Type']: ledgerTypeLabel(entry.type, t),
            [t('ledger.table.direction') || 'Direction']: directionFilterLabel(entry.direction, t),
            [t('ledger.table.amount') || 'Amount']: entry.amount,
            [t('common.currency') || 'Currency']: entry.currency?.toUpperCase() || '',
            [t('ledger.table.partner') || 'Partner']: entry.partner || '',
            [t('ledger.filters.paymentMethod') || 'Payment Method']: entry.paymentMethod || '',
            [t('ledger.table.paymentAccount') || 'Payment Account']: entry.paymentAccount || '',
            [t('ledger.table.descriptionNotes') || 'Description / Notes']: [entry.notes, entry.description].filter(Boolean).join(' | '),
            [t('ledger.table.sourceModule') || 'Source Module']: sourceModuleLabel(entry.sourceModule, t),
            [t('ledger.table.transactionId') || 'Transaction ID']: entry.transactionId,
        }))
    }, [filteredEntries, t])
    const visibleEntries = useMemo(
        () => filteredEntries.slice((currentPage - 1) * pageSize, currentPage * pageSize),
        [currentPage, filteredEntries, pageSize],
    )
    const visibleIncomingEntries = useMemo(() => visibleEntries.filter((entry) => entry.direction === 'incoming'), [visibleEntries])
    const visibleOutgoingEntries = useMemo(() => visibleEntries.filter((entry) => entry.direction === 'outgoing'), [visibleEntries])
    const visibleOpeningEntries = useMemo(() => visibleEntries.filter((entry) => entry.direction === 'opening'), [visibleEntries])
    const visibleAdjustmentEntries = useMemo(() => visibleEntries.filter((entry) => entry.direction === 'adjustment'), [visibleEntries])

    const draftPreviewEntries = useMemo(
        () =>
            applyGeneralLedgerFilters(dateScopedEntries, draftFilters, (entry) => {
                const category = getLedgerMovementCategory(entry)
                return [
                    ledgerTypeLabel(entry.type, t),
                    sourceModuleLabel(entry.sourceModule, t),
                    category ? movementCategoryLabel(category, t) : null,
                    transactionStateLabel(getLedgerTransactionState(entry), t),
                ]
            }),
        [dateScopedEntries, draftFilters, t],
    )
    const isDraftAmountRangeInvalid = hasInvalidLedgerAmountRange(draftFilters)

    const dateDisplay = useMemo(() => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }

        if (dateRange === 'month') {
            return formatLocalizedMonthYear(new Date(), i18n.language)
        }

        if (dateRange === 'lastMonth') {
            const now = new Date()
            return formatLocalizedMonthYear(new Date(now.getFullYear(), now.getMonth() - 1, 1), i18n.language)
        }

        if (dateRange === 'custom') {
            if (dateScopedEntries.length > 0) {
                const dates = dateScopedEntries.map((entry) => new Date(entry.date).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }

            if (customDates.start || customDates.end) {
                const parts = []
                if (customDates.start) parts.push(`${t('performance.filters.from')} ${formatDate(customDates.start)}`)
                if (customDates.end) parts.push(`${t('performance.filters.to')} ${formatDate(customDates.end)}`)
                return parts.join(' ')
            }
        }

        if (dateRange === 'allTime') {
            if (dateScopedEntries.length > 0) {
                const dates = dateScopedEntries.map((entry) => new Date(entry.date).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }

            return t('performance.filters.allTime') || 'All Time'
        }

        return ''
    }, [customDates.end, customDates.start, dateRange, dateScopedEntries, i18n.language, t])

    useEffect(() => {
        setCurrentPage(1)
    }, [dateRange, customDates, filters, pageSize, summaryDrilldown])

    useEffect(() => {
        if (hoveredRelationKey && !visibleEntries.some((entry) => entry.relationKey === hoveredRelationKey)) {
            setHoveredRelationKey(null)
        }
    }, [hoveredRelationKey, visibleEntries])

    useEffect(() => {
        if (!isFilterDialogOpen) {
            return
        }

        setDraftFilters(filters)
    }, [filters, isFilterDialogOpen])

    const activeFilterChips = useMemo(() => {
        const chips: string[] = []

        if (summaryDrilldown) {
            chips.push(t(`ledger.cashSummary.drilldown.${summaryDrilldown}`))
        }

        if (filters.search.trim()) {
            chips.push(
                t('ledger.filters.chipSearch', {
                    term: filters.search.trim(),
                    defaultValue: `Search: ${filters.search.trim()}`,
                }),
            )
        }
        if (filters.direction.length > 0) {
            filters.direction.forEach((direction) => {
                chips.push(directionFilterLabel(direction, t))
            })
        }
        if (filters.category.length > 0) {
            filters.category.forEach((category) => {
                chips.push(movementCategoryLabel(category, t))
            })
        }
        if (filters.transactionState.length > 0) {
            filters.transactionState.forEach((state) => {
                chips.push(transactionStateLabel(state, t))
            })
        }
        if (filters.type.length > 0) {
            filters.type.forEach((type) => {
                chips.push(ledgerTypeLabel(type, t))
            })
        }
        if (filters.source.length > 0) {
            filters.source.forEach((source) => {
                chips.push(sourceModuleLabel(source, t))
            })
        }
        if (filters.counterparty.length > 0) {
            filters.counterparty.forEach((counterparty) => {
                chips.push(
                    t('ledger.filters.chipCounterparty', {
                        name: filterFacets.counterpartyLabels.get(counterparty) || counterparty,
                    }),
                )
            })
        }
        if (filters.currency.length > 0) {
            filters.currency.forEach((currency) => {
                chips.push(
                    t('ledger.filters.chipCurrency', {
                        code: currency.toUpperCase(),
                        defaultValue: `Currency: ${currency.toUpperCase()}`,
                    }),
                )
            })
        }
        if (filters.paymentMethods.length > 0) {
            filters.paymentMethods.forEach((method) => {
                chips.push(
                    t('ledger.filters.chipMethod', {
                        name: paymentMethodLabel(method, t),
                        defaultValue: `Method: ${paymentMethodLabel(method, t)}`,
                    }),
                )
            })
        }
        if (filters.paymentAccounts.length > 0) {
            filters.paymentAccounts.forEach((account) => {
                chips.push(
                    t('ledger.filters.chipPaymentAccount', {
                        name: filterFacets.paymentAccountLabels.get(account) || account,
                    }),
                )
            })
        }
        if (filters.minAmount) {
            chips.push(
                t('ledger.filters.chipMin', {
                    value: formatNumericInput(filters.minAmount),
                    currency: filters.currency[0]?.toUpperCase(),
                }),
            )
        }
        if (filters.maxAmount) {
            chips.push(
                t('ledger.filters.chipMax', {
                    value: formatNumericInput(filters.maxAmount),
                    currency: filters.currency[0]?.toUpperCase(),
                }),
            )
        }
        if (filters.sort !== 'date_desc') {
            chips.push(sortOptionLabel(filters.sort, t))
        }

        return chips
    }, [filterFacets.counterpartyLabels, filterFacets.paymentAccountLabels, filters, summaryDrilldown, t])

    const activeFilterCount = useMemo(() => countActiveLedgerFilters(filters) + (summaryDrilldown ? 1 : 0), [filters, summaryDrilldown])

    const handleResetAllFilters = () => {
        setFilters(DEFAULT_LEDGER_FILTERS)
        setSummaryDrilldown(null)
    }

    const handleResetDraftFilters = () => {
        setDraftFilters(DEFAULT_LEDGER_FILTERS)
    }

    const handleApplyFilters = () => {
        if (isDraftAmountRangeInvalid) return
        setFilters(normalizeLedgerFiltersForCurrency(draftFilters))
        setIsFilterDialogOpen(false)
        setCurrentPage(1)
    }

    const handleSummaryDrilldown = (drilldownId: LedgerCashDrilldownId) => {
        const isClearingActiveDrilldown = summaryDrilldown === drilldownId
        setSummaryDrilldown(isClearingActiveDrilldown ? null : drilldownId)
        setCurrentPage(1)
        if (!isClearingActiveDrilldown) {
            window.setTimeout(() => document.getElementById('ledger-entries')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
        }
    }

    const summarySourceEntries = useMemo(
        () =>
            dateScopedCashMovementEntries.filter(
                (entry) =>
                    isLedgerCashFlowDirection(entry.direction) &&
                    (filters.currency.length === 0 || filters.currency.includes(entry.currency)),
            ),
        [dateScopedCashMovementEntries, filters.currency],
    )
    const cashSummariesByCurrency = useMemo(() => {
        const currenciesWithMovements = new Set(summarySourceEntries.map((entry) => entry.currency))
        const availableCurrencyOrder = Array.from(
            new Set([baseCurrency, ...features.allowed_currencies, ...currenciesWithMovements]),
        ).filter((currency) => currenciesWithMovements.has(currency))
        const currencyOrder = filters.currency.length > 0 ? filters.currency : availableCurrencyOrder
        const separatedSummaries = summarizeLedgerCashMovementsByCurrency(
            summarySourceEntries,
            currencyOrder,
        )

        if (separatedSummaries.length > 0) return separatedSummaries

        return [{ currency: baseCurrency, summary: summarizeLedgerCashMovements([]) }]
    }, [baseCurrency, features.allowed_currencies, filters.currency, summarySourceEntries])
    const eligibleCashGroups = useMemo<LedgerCashGroupId[]>(() => {
        let hasBorrowing = false
        let hasLending = false

        ledgerCashMovementEntries.forEach((entry) => {
            const bucketId = getLedgerCashBucketId(entry)
            if (bucketId === 'loansReceived' || bucketId === 'loanRepaymentsPaid') hasBorrowing = true
            if (bucketId === 'repaymentsCollected' || bucketId === 'loansAdvanced') hasLending = true
        })

        return ['operating', ...(hasBorrowing ? (['borrowing'] as const) : []), ...(hasLending ? (['lending'] as const) : [])]
    }, [ledgerCashMovementEntries])
    const enabledCashGroups = useMemo<LedgerCashGroupId[]>(
        () => ['operating', ...(features.loans ? (['borrowing', 'lending'] as const) : [])],
        [features.loans],
    )
    const ledgerDashboardConfig = useMemo(
        () => normalizeLedgerDashboardConfig(features.ledger_dashboard_config),
        [features.ledger_dashboard_config],
    )
    const handleSaveLedgerDashboardConfig = async (config: LedgerDashboardConfig) => {
        await updateSettings({ ledger_dashboard_config: normalizeLedgerDashboardConfig(config) })
    }

    const cashFlowEntries = useMemo(() => filteredEntries.filter((entry) => isLedgerCashFlowDirection(entry.direction)), [filteredEntries])
    const inflowEntries = useMemo(() => filteredEntries.filter((entry) => entry.direction === 'incoming'), [filteredEntries])
    const outflowEntries = useMemo(() => filteredEntries.filter((entry) => entry.direction === 'outgoing'), [filteredEntries])
    const totalInflow = useMemo(
        () => formatAmountSummary(inflowEntries, features.iqd_display_preference),
        [features.iqd_display_preference, inflowEntries],
    )
    const totalOutflow = useMemo(
        () => formatAmountSummary(outflowEntries, features.iqd_display_preference),
        [features.iqd_display_preference, outflowEntries],
    )
    const netFlow = useMemo(
        () => formatNetSummary(cashFlowEntries, features.iqd_display_preference),
        [cashFlowEntries, features.iqd_display_preference],
    )
    const totalInflowInBaseCurrency = useMemo(
        () => inflowEntries.reduce((total, entry) => total + convertToStoreBase(entry.amount, entry.currency, baseCurrency, rates), 0),
        [baseCurrency, inflowEntries, rates],
    )
    const totalOutflowInBaseCurrency = useMemo(
        () => outflowEntries.reduce((total, entry) => total + convertToStoreBase(entry.amount, entry.currency, baseCurrency, rates), 0),
        [baseCurrency, outflowEntries, rates],
    )
    const netFlowInBaseCurrency = useMemo(
        () => summarizeLedgerCashFlow(cashFlowEntries, (entry) => convertToStoreBase(entry.amount, entry.currency, baseCurrency, rates)).net,
        [baseCurrency, cashFlowEntries, rates],
    )
    const hasMultipleInflowCurrencies = new Set(inflowEntries.map((entry) => entry.currency)).size > 1
    const hasMultipleOutflowCurrencies = new Set(outflowEntries.map((entry) => entry.currency)).size > 1
    const hasMultipleNetFlowCurrencies = new Set(cashFlowEntries.map((entry) => entry.currency)).size > 1

    const renderCurrencySummary = (values: string[], convertedTotal: number, hasMultipleCurrencies: boolean, valueClassName: string) => {
        const summary = (
            <div className={cn('space-y-1', hasMultipleCurrencies && 'cursor-help')}>
                {values.map((value, index) => (
                    <div key={index} className={valueClassName}>
                        {value}
                    </div>
                ))}
            </div>
        )

        if (!hasMultipleCurrencies) {
            return summary
        }

        return (
            <Tooltip>
                <TooltipTrigger asChild>{summary}</TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="space-y-1 p-3">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {t('common.totalIn', 'Total in')} {baseCurrency.toUpperCase()}
                    </div>
                    <div className="text-base font-black tabular-nums">
                        {formatCurrency(convertedTotal, baseCurrency, features.iqd_display_preference)}
                    </div>
                </TooltipContent>
            </Tooltip>
        )
    }

    const trendStats = useMemo(() => {
        const now = new Date()
        let periodStart = now
        let previousStart = now

        if (cashFlowEntries.length > 0) {
            const dates = cashFlowEntries.map((e) => new Date(e.date).getTime())
            const minDate = new Date(Math.min(...dates))
            const maxDate = new Date(Math.max(...dates))
            periodStart = minDate
            const periodDuration = maxDate.getTime() - minDate.getTime()
            previousStart = new Date(minDate.getTime() - periodDuration)
        } else {
            periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
            previousStart = new Date(periodStart.getTime() - 30 * 24 * 60 * 60 * 1000)
        }

        let currentInflow = 0
        let currentOutflow = 0
        let previousInflow = 0
        let previousOutflow = 0

        const moduleFlows = new Map<string, { in: number; out: number; count: number }>()
        const hourlyData = new Array(24).fill(0).map((_, i) => ({ hour: `${i}:00`, inflow: 0, outflow: 0, count: 0 }))

        allEntries.forEach((entry) => {
            if (!isLedgerCashFlowDirection(entry.direction)) return

            const date = new Date(entry.date)
            if (date > now) return

            // Check if current period
            const isCurrent = date >= periodStart && date <= now
            // Check if previous period
            const isPrevious = date >= previousStart && date < periodStart

            if (!isCurrent && !isPrevious) return

            const amount = entry.currency === baseCurrency ? entry.amount : convertToStoreBase(entry.amount, entry.currency, baseCurrency, rates)

            if (isCurrent) {
                if (entry.direction === 'incoming') {
                    currentInflow += amount
                } else {
                    currentOutflow += amount
                }

                // Compile module metrics
                const mod = moduleFlows.get(entry.sourceModule) || {
                    in: 0,
                    out: 0,
                    count: 0,
                }
                if (entry.direction === 'incoming') mod.in += amount
                else mod.out += amount
                mod.count++
                moduleFlows.set(entry.sourceModule, mod)

                // Compile hourly metrics
                const hour = date.getHours()
                if (entry.direction === 'incoming') {
                    hourlyData[hour].inflow += amount
                } else {
                    hourlyData[hour].outflow += amount
                }
                hourlyData[hour].count++
            } else if (isPrevious) {
                if (entry.direction === 'incoming') {
                    previousInflow += amount
                } else {
                    previousOutflow += amount
                }
            }
        })

        const currentSurplus = currentInflow - currentOutflow
        const previousSurplus = previousInflow - previousOutflow

        const calcOffset = (curr: number, prev: number) => {
            if (prev === 0) return curr > 0 ? 100 : 0
            return ((curr - prev) / prev) * 100
        }

        // Top Modules Array
        const topModulesData = Array.from(moduleFlows.entries())
            .map(([moduleName, stats]) => ({
                id: moduleName,
                name: moduleName,
                revenue: stats.in,
                cost: stats.out,
                profit: stats.in - stats.out,
                sold: stats.count,
            }))
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 3)

        return {
            inflow: currentInflow,
            inflowOffset: calcOffset(currentInflow, previousInflow),
            outflow: currentOutflow,
            outflowOffset: calcOffset(currentOutflow, previousOutflow),
            netFlow: currentSurplus,
            netFlowOffset: calcOffset(currentSurplus, previousSurplus),
            surplusRatio: currentInflow === 0 ? 0 : (currentSurplus / currentInflow) * 100,
            previousSurplusRatio: previousInflow === 0 ? 0 : (previousSurplus / previousInflow) * 100,
            topModulesData,
            hourlyData,
        }
    }, [allEntries, cashFlowEntries, baseCurrency, rates])
    const trendCurrencyMode = useMemo(() => {
        const currencies = Array.from(new Set(cashFlowEntries.map((entry) => entry.currency)))

        if (currencies.length <= 1) {
            return {
                currency: currencies[0] ?? baseCurrency,
                usesBaseEquivalent: false,
            }
        }

        return {
            currency: baseCurrency,
            usesBaseEquivalent: true,
        }
    }, [baseCurrency, cashFlowEntries])
    const ledgerTrendData = useMemo(() => {
        const points = new Map<string, LedgerTrendPoint>()

        cashFlowEntries.forEach((entry) => {
            const dateKey = toLedgerDateKey(entry.date)
            const point = points.get(dateKey) || {
                dateKey,
                inflow: 0,
                outflow: 0,
                net: 0,
            }
            const amount = trendCurrencyMode.usesBaseEquivalent
                ? convertToStoreBase(entry.amount, entry.currency, baseCurrency, rates)
                : entry.amount

            if (entry.direction === 'incoming') {
                point.inflow += amount
                point.net += amount
            } else if (entry.direction === 'outgoing') {
                point.outflow += amount
                point.net -= amount
            }

            points.set(dateKey, point)
        })

        return Array.from(points.values()).sort((left, right) => left.dateKey.localeCompare(right.dateKey))
    }, [baseCurrency, cashFlowEntries, rates, trendCurrencyMode.usesBaseEquivalent])
    const usesEquivalentTrend = trendCurrencyMode.usesBaseEquivalent
    const netFlowIsNegative = useMemo(() => ledgerTrendData.reduce((sum, point) => sum + point.net, 0) < 0, [ledgerTrendData])
    const renderEntriesTable = (
        rows: LedgerEntry[],
        emptyMessage: string,
        options?: {
            compactTransactionId?: boolean
            compactColumns?: boolean
            hideDescriptionNotes?: boolean
            hideActions?: boolean
        },
    ) => {
        const { counts: relationCounts, ranges: relationRanges } = buildVisibleRelationMaps(rows)
        const hoveredRange = hoveredRelationKey ? (relationRanges.get(hoveredRelationKey) ?? null) : null
        const compactTransactionId = options?.compactTransactionId ?? false
        const compactColumns = options?.compactColumns ?? false
        const showDescriptionNotes = !options?.hideDescriptionNotes
        const showActions = !options?.hideActions
        const columnCount = 9 + (showDescriptionNotes ? 1 : 0) + (showActions ? 1 : 0)
        const openEntry = (entry: LedgerEntry) => {
            if (shouldOpenSaleDetails(entry)) {
                setPendingSaleDetailsId(entry.transactionId)
            }

            setLocation(entry.routePath)
        }

        return (
            <TooltipProvider delayDuration={120}>
                <Table
                    className={cn(
                        'ms-6 w-[calc(100%-1.5rem)]',
                        compactColumns && 'ms-0 min-w-[760px] w-full table-fixed text-[11px] leading-tight',
                    )}
                >
                    <TableHeader>
                        <TableRow>
                            <TableHead className={cn(compactColumns && 'w-[92px] px-2 py-3')}>
                                {t('ledger.table.transactionId', {
                                    defaultValue: 'Transaction ID',
                                })}
                            </TableHead>
                            <TableHead className={cn(compactColumns && 'w-[78px] px-2 py-3')}>
                                {t('ledger.table.date', { defaultValue: 'Date' })}
                            </TableHead>
                            <TableHead className={cn(compactColumns && 'w-[120px] px-2 py-3')}>
                                {t('ledger.table.type', { defaultValue: 'Type' })}
                            </TableHead>
                            <TableHead className={cn(compactColumns && 'w-[74px] px-2 py-3')}>
                                {t('ledger.table.direction', { defaultValue: 'Direction' })}
                            </TableHead>
                            <TableHead className={cn(compactColumns && 'w-[92px] px-2 py-3')}>
                                {t('ledger.table.amount', { defaultValue: 'Amount' })}
                            </TableHead>
                            <TableHead className={cn(compactColumns && 'w-[72px] px-2 py-3')}>
                                {t('ledger.table.sourceModule', {
                                    defaultValue: 'Source Module',
                                })}
                            </TableHead>
                            <TableHead className={cn(compactColumns && 'w-[90px] px-2 py-3')}>
                                {t('ledger.table.referenceId', {
                                    defaultValue: 'Reference ID',
                                })}
                            </TableHead>
                            <TableHead className={cn(compactColumns && 'w-[90px] px-2 py-3')}>
                                {t('ledger.table.partner', { defaultValue: 'Partner' })}
                            </TableHead>
                            <TableHead className={cn(compactColumns && 'w-[100px] px-2 py-3')}>
                                {t('ledger.table.paymentAccount', {
                                    defaultValue: 'Payment Account',
                                })}
                            </TableHead>
                            {showDescriptionNotes ? (
                                <TableHead className={cn(compactColumns && 'min-w-[140px] px-2 py-3')}>
                                    {t('ledger.table.descriptionNotes', {
                                        defaultValue: 'Description / Notes',
                                    })}
                                </TableHead>
                            ) : null}
                            {showActions ? (
                                <TableHead className={cn('text-right', compactColumns ? 'w-[72px] px-2 py-3' : 'w-[84px]')}>
                                    {t('ledger.table.actions', { defaultValue: 'Actions' })}
                                </TableHead>
                            ) : null}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={columnCount} className="py-12 text-center text-muted-foreground">
                                    {emptyMessage}
                                </TableCell>
                            </TableRow>
                        ) : (
                            rows.map((entry, rowIndex) => {
                                const isRelationHovered = !!hoveredRelationKey && entry.relationKey === hoveredRelationKey
                                const relatedVisibleCount = entry.relationKey ? relationCounts.get(entry.relationKey) || 0 : 0
                                const hasVisibleLinkedPeer = relatedVisibleCount > 1
                                const hoveredRelationIsCompleted =
                                    hoveredRange && rows[hoveredRange.firstIndex] ? rows[hoveredRange.firstIndex].relationIsCompleted : undefined
                                const showHoverHierarchyLine =
                                    !!hoveredRange &&
                                    hoveredRange.firstIndex !== hoveredRange.lastIndex &&
                                    rowIndex >= hoveredRange.firstIndex &&
                                    rowIndex <= hoveredRange.lastIndex
                                const showHoverHierarchyTurn = isRelationHovered && hasVisibleLinkedPeer
                                const relationAccentClass =
                                    entry.relationRole === 'origin'
                                        ? 'bg-sky-500/5'
                                        : entry.relationRole === 'repayment'
                                          ? 'bg-amber-500/10'
                                          : 'bg-violet-500/5'
                                const hierarchyVerticalClass =
                                    hoveredRange && rowIndex === hoveredRange.firstIndex
                                        ? 'top-1/2 bottom-0'
                                        : hoveredRange && rowIndex === hoveredRange.lastIndex
                                          ? 'top-0 bottom-1/2'
                                          : 'top-0 bottom-0'

                                const relatedRows = entry.relationKey ? rows.filter((r) => r.relationKey === entry.relationKey) : []
                                const currentIndex = entry.relationKey ? relatedRows.findIndex((r) => r.id === entry.id) : -1
                                const nextPayment = currentIndex > 0 ? relatedRows[currentIndex - 1] : null
                                const previousPayment =
                                    currentIndex !== -1 && currentIndex < relatedRows.length - 1 ? relatedRows[currentIndex + 1] : null
                                const latestPayment = currentIndex > 0 ? relatedRows[0] : null
                                const firstPayment =
                                    currentIndex !== -1 && currentIndex < relatedRows.length - 1 ? relatedRows[relatedRows.length - 1] : null

                                const isRealEstateEntry = entry.sourceModule === 'real_estate'
                                const hasContextMenu = Boolean(
                                    nextPayment ||
                                    previousPayment ||
                                    latestPayment ||
                                    firstPayment ||
                                    entry.businessPartnerId ||
                                    isRealEstateEntry,
                                )

                                const rowContent = (
                                    <TableRow
                                        id={`ledger-row-${entry.id}`}
                                        key={entry.id}
                                        className={cn(
                                            entry.relationKey && 'transition-colors duration-150',
                                            isRelationHovered && relationAccentClass,
                                            isRelationHovered && hasVisibleLinkedPeer && 'shadow-[inset_0_0_0_1px_rgba(148,163,184,0.35)]',
                                        )}
                                        onMouseEnter={() => {
                                            if (entry.relationKey) {
                                                setHoveredRelationKey(entry.relationKey)
                                            }
                                        }}
                                        onMouseLeave={() => {
                                            if (entry.relationKey) {
                                                setHoveredRelationKey((current) => (current === entry.relationKey ? null : current))
                                            }
                                        }}
                                    >
                                        <TableCell
                                            className={cn(
                                                'relative font-mono text-xs text-muted-foreground',
                                                compactColumns ? 'max-w-[92px] px-2 py-3' : 'max-w-[170px]',
                                            )}
                                        >
                                            {showHoverHierarchyLine ? (
                                                <div className="pointer-events-none absolute inset-y-0 -start-6 w-5">
                                                    <span
                                                        className={cn(
                                                            'absolute start-1.5 w-px',
                                                            hoveredRelationIsCompleted === true
                                                                ? 'bg-emerald-500'
                                                                : hoveredRelationIsCompleted === false
                                                                  ? 'bg-amber-500'
                                                                  : 'bg-foreground/80',
                                                            hierarchyVerticalClass,
                                                        )}
                                                    />
                                                    {showHoverHierarchyTurn ? (
                                                        <span
                                                            className={cn(
                                                                'absolute start-1.5 top-1/2 h-px w-3 -translate-y-1/2',
                                                                hoveredRelationIsCompleted === true
                                                                    ? 'bg-emerald-500'
                                                                    : hoveredRelationIsCompleted === false
                                                                      ? 'bg-amber-500'
                                                                      : 'bg-foreground/80',
                                                            )}
                                                        />
                                                    ) : null}
                                                </div>
                                            ) : null}
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <span className="block truncate cursor-help">
                                                        {formatTransactionIdForDisplay(entry.transactionId, compactTransactionId)}
                                                    </span>
                                                </TooltipTrigger>
                                                <TooltipContent side="bottom" align="start" className="font-mono text-xs">
                                                    {entry.transactionId}
                                                </TooltipContent>
                                            </Tooltip>
                                        </TableCell>
                                        <TableCell className={cn(compactColumns && 'align-top px-2 py-3')}>
                                            {formatDateTime(entry.date)}
                                        </TableCell>
                                        <TableCell className={cn('font-medium', compactColumns && 'align-top px-2 py-3')}>
                                            {entry.relationTitle ? (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <div
                                                            className={cn(
                                                                'inline-flex max-w-full cursor-default items-center gap-2',
                                                                compactColumns && 'gap-1',
                                                            )}
                                                        >
                                                            <span className="truncate decoration-dotted underline-offset-4 hover:underline">
                                                                {ledgerTypeLabel(entry.type, t)}
                                                            </span>
                                                            {entry.relationRole ? (
                                                                <span
                                                                    className={cn(
                                                                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                                        entry.relationRole === 'origin'
                                                                            ? 'border-sky-200 bg-sky-50 text-sky-700'
                                                                            : entry.relationRole === 'repayment'
                                                                              ? 'border-amber-200 bg-amber-50 text-amber-700'
                                                                              : 'border-violet-200 bg-violet-50 text-violet-700',
                                                                    )}
                                                                >
                                                                    {ledgerRelationRoleLabel(entry.relationRole, t)}
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                    </TooltipTrigger>
                                                    <TooltipContent className="max-w-sm p-3">
                                                        <div className="space-y-1.5">
                                                            <div className="font-semibold">{entry.relationTitle}</div>
                                                            {entry.relationDescription ? (
                                                                <p className="text-xs leading-relaxed text-muted-foreground">
                                                                    {entry.relationDescription}
                                                                </p>
                                                            ) : null}
                                                            {hasVisibleLinkedPeer ? (
                                                                <p className="text-[11px] font-semibold text-primary">
                                                                    {t('ledger.relation.hoverHint', {
                                                                        defaultValue:
                                                                            'Related ledger rows on this page highlight together and reveal the linked hierarchy while you hover.',
                                                                    })}
                                                                </p>
                                                            ) : null}
                                                        </div>
                                                    </TooltipContent>
                                                </Tooltip>
                                            ) : (
                                                ledgerTypeLabel(entry.type, t)
                                            )}
                                        </TableCell>
                                        <TableCell className={cn(compactColumns && 'align-top px-2 py-3')}>
                                            <span
                                                className={cn(
                                                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                    compactColumns && 'gap-0.5 px-1.5 text-[9px]',
                                                    entry.direction === 'adjustment'
                                                        ? 'border-violet-200 bg-violet-50 text-violet-700'
                                                        : entry.direction === 'opening'
                                                          ? 'border-sky-200 bg-sky-50 text-sky-700'
                                                          : entry.direction === 'incoming'
                                                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                            : 'border-amber-200 bg-amber-50 text-amber-700',
                                                )}
                                            >
                                                {entry.direction === 'adjustment' ? (
                                                    <SlidersHorizontal className="h-3 w-3" />
                                                ) : entry.direction === 'opening' ? (
                                                    <Wallet className="h-3 w-3" />
                                                ) : entry.direction === 'incoming' ? (
                                                    <ArrowDownLeft className="h-3 w-3" />
                                                ) : (
                                                    <ArrowUpRight className="h-3 w-3" />
                                                )}
                                                {entry.direction === 'adjustment'
                                                    ? t('ledger.direction.adjust', {
                                                          defaultValue: 'ADJ',
                                                      })
                                                    : entry.direction === 'opening'
                                                      ? t('ledger.direction.open', {
                                                            defaultValue: 'OPEN',
                                                        })
                                                      : entry.direction === 'incoming'
                                                        ? t('ledger.direction.in', { defaultValue: 'IN' })
                                                        : t('ledger.direction.out', {
                                                              defaultValue: 'OUT',
                                                          })}
                                            </span>
                                        </TableCell>
                                        <TableCell className={cn(compactColumns && 'align-top px-2 py-3')}>
                                            {formatCurrency(entry.amount, entry.currency, features.iqd_display_preference)}
                                        </TableCell>
                                        <TableCell className={cn(compactColumns && 'align-top px-2 py-3')}>
                                            {sourceModuleLabel(entry.sourceModule, t)}
                                        </TableCell>
                                        <TableCell className={cn('font-medium', compactColumns && 'align-top px-2 py-3')}>
                                            <span className="block truncate" title={entry.referenceId}>
                                                {entry.referenceId}
                                            </span>
                                        </TableCell>
                                        <TableCell className={cn(compactColumns && 'align-top px-2 py-3')}>
                                            <span className="block truncate" title={entry.partner || undefined}>
                                                {entry.partner || '-'}
                                            </span>
                                        </TableCell>
                                        <TableCell className={cn(compactColumns && 'align-top px-2 py-3')}>
                                            <span className="block truncate" title={entry.paymentAccount || undefined}>
                                                {entry.paymentAccount || '-'}
                                            </span>
                                        </TableCell>
                                        {showDescriptionNotes ? (
                                            <TableCell className={cn(compactColumns ? 'max-w-[140px] px-2 py-3' : 'max-w-[280px]')}>
                                                <span
                                                    className={cn(
                                                        'block truncate text-muted-foreground',
                                                        compactColumns ? 'text-xs' : 'text-sm',
                                                    )}
                                                    title={entry.description || undefined}
                                                >
                                                    {entry.description || '-'}
                                                </span>
                                            </TableCell>
                                        ) : null}
                                        {showActions ? (
                                            <TableCell className={cn('text-right', compactColumns && 'px-2 py-3')}>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => openEntry(entry)}
                                                    className={cn(compactColumns && 'h-7 px-2 text-[10px]')}
                                                >
                                                    {t('ledger.table.open', { defaultValue: 'Open' })}
                                                </Button>
                                            </TableCell>
                                        ) : null}
                                    </TableRow>
                                )

                                if (!hasContextMenu) return rowContent

                                return (
                                    <ContextMenu key={entry.id}>
                                        <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
                                        <ContextMenuContent className="w-48">
                                            {latestPayment && (
                                                <ContextMenuItem onClick={() => scrollToRow(latestPayment.id)}>
                                                    <ChevronsUp className="mr-2 h-4 w-4" />
                                                    {t('ledger.context.scrollToLatest', {
                                                        defaultValue: 'Latest payment',
                                                    })}
                                                </ContextMenuItem>
                                            )}
                                            {nextPayment && (
                                                <ContextMenuItem onClick={() => scrollToRow(nextPayment.id)}>
                                                    <ChevronUp className="mr-2 h-4 w-4" />
                                                    {t('ledger.context.scrollToNext', {
                                                        defaultValue: 'Next payment',
                                                    })}
                                                </ContextMenuItem>
                                            )}
                                            {previousPayment && (
                                                <ContextMenuItem onClick={() => scrollToRow(previousPayment.id)}>
                                                    <ChevronDown className="mr-2 h-4 w-4" />
                                                    {t('ledger.context.scrollToPrevious', {
                                                        defaultValue: 'Previous payment',
                                                    })}
                                                </ContextMenuItem>
                                            )}
                                            {firstPayment && (
                                                <ContextMenuItem onClick={() => scrollToRow(firstPayment.id)}>
                                                    <ChevronsDown className="mr-2 h-4 w-4" />
                                                    {t('ledger.context.scrollToFirst', {
                                                        defaultValue: 'First payment',
                                                    })}
                                                </ContextMenuItem>
                                            )}
                                            {isRealEstateEntry ? (
                                                <ContextMenuItem onClick={() => openEntry(entry)}>
                                                    <FileText className="mr-2 h-4 w-4" />
                                                    {t('ledger.context.viewRealEstateContract', {
                                                        defaultValue: 'View Real Estate Contract',
                                                    })}
                                                </ContextMenuItem>
                                            ) : entry.businessPartnerId ? (
                                                <ContextMenuItem onClick={() => setLocation(`/business-partners/${entry.businessPartnerId}`)}>
                                                    <UsersRound className="mr-2 h-4 w-4" />
                                                    {t('ledger.context.viewBusinessPartner', {
                                                        defaultValue: 'View Business Partner',
                                                    })}
                                                </ContextMenuItem>
                                            ) : null}
                                        </ContextMenuContent>
                                    </ContextMenu>
                                )
                            })
                        )}
                    </TableBody>
                </Table>
            </TooltipProvider>
        )
    }

    if (!hasLedgerSurface && allEntries.length === 0) {
        return (
            <div className="p-6">
                <Card>
                    <CardHeader>
                        <CardTitle>
                            {t('ledger.notAvailable', {
                                defaultValue: 'Ledger is not available in this workspace',
                            })}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        {t('ledger.enableModules', {
                            defaultValue: 'Enable POS, CRM, Loans, Accounting, or HR to use the central ledger.',
                        })}
                    </CardContent>
                </Card>
            </div>
        )
    }

    if (isExportModalOpen) {
        return (
            <div className="space-y-6">
                <ExportPreviewModal
                    isOpen={isExportModalOpen}
                    onClose={() => setIsExportModalOpen(false)}
                    type="finance"
                    records={ledgerExportData}
                />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <div className="flex flex-wrap items-center gap-3">
                        <h1 className="flex items-center gap-2 text-2xl font-bold">
                            <BookOpen className="h-6 w-6 text-primary" />
                            {t('ledger.title')}
                            {(isLoading || isDateLoading) && <Loader2 className="ms-1 h-4 w-4 animate-spin text-primary/50" />}
                        </h1>
                        {dateDisplay && (
                            <div
                                className={cn(
                                    'animate-pop-in bg-primary px-3 py-1 text-sm font-bold text-primary-foreground shadow-sm',
                                    style === 'neo-orange' ? 'rounded-[var(--radius)] neo-border' : 'rounded-lg',
                                )}
                            >
                                {dateDisplay}
                            </div>
                        )}
                    </div>
                    <p className="text-muted-foreground">
                        {t('ledger.subtitle')} <ModulePageFreshness className="ms-2" tableNames={LEDGER_FRESHNESS_TABLES} />
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <DateRangeFilters />
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsFilterDialogOpen(true)}
                        className="h-11 rounded-2xl border-border/60 px-4"
                    >
                        <SlidersHorizontal className="me-2 h-4 w-4" />
                        {t('ledger.filters.title')}
                        {activeFilterCount > 0 ? (
                            <span className="ms-2 inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                                {activeFilterCount}
                            </span>
                        ) : null}
                    </Button>
                    {activeFilterCount > 0 ? (
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={handleResetAllFilters}
                            className="h-11 rounded-2xl px-4 text-muted-foreground"
                        >
                            <RotateCcw className="me-2 h-4 w-4" />
                            {t('ledger.filters.clearFilters')}
                        </Button>
                    ) : null}
                </div>
            </div>

            {activeFilterChips.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                    {activeFilterChips.map((chip, index) => (
                        <span
                            key={`${chip}-${index}`}
                            className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-[11px] font-semibold text-primary"
                        >
                            {chip}
                        </span>
                    ))}
                </div>
            ) : null}

            <LedgerCashSummaryDashboard
                summaries={cashSummariesByCurrency}
                iqdPreference={features.iqd_display_preference}
                activeDrilldown={summaryDrilldown}
                isLoading={isLoading || isDateLoading}
                config={ledgerDashboardConfig}
                eligibleGroups={eligibleCashGroups}
                enabledGroups={enabledCashGroups}
                onSaveConfig={handleSaveLedgerDashboardConfig}
                onDrilldown={handleSummaryDrilldown}
            />

            {SHOW_LEDGER_ANALYTICS_WIDGETS ? <TooltipProvider delayDuration={300}>
                <div className={cn('grid gap-4 sm:grid-cols-2', SHOW_LEDGER_ANALYTICS_WIDGETS ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
                    <Card className="rounded-3xl border border-border/50 bg-card/60 overflow-hidden relative group dark:bg-zinc-950">
                        <div className="absolute top-0 end-0 p-4 opacity-5 pointer-events-none group-hover:scale-110 transition-transform duration-500">
                            <ArrowDownLeft className="w-24 h-24 text-emerald-500" />
                        </div>
                        <CardHeader className="pb-2 flex flex-row items-center justify-between z-10 relative">
                            <CardTitle className="text-[13px] font-semibold tracking-tight text-emerald-600 uppercase">
                                {t('ledger.kpis.totalInflow', { defaultValue: 'Total Inflow' })}
                            </CardTitle>
                            <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                                <DollarSign className="h-4 w-4 text-emerald-600" />
                            </div>
                        </CardHeader>
                        <CardContent className="z-10 relative space-y-4">
                            <div className="space-y-1">
                                {renderCurrencySummary(
                                    totalInflow,
                                    totalInflowInBaseCurrency,
                                    hasMultipleInflowCurrencies,
                                    'text-2xl font-black tabular-nums tracking-tighter text-emerald-600 leading-none',
                                )}
                                <div className="flex items-center gap-2">
                                    <span
                                        className={cn(
                                            'flex items-center text-[11px] font-bold px-1.5 py-0.5 rounded-full border',
                                            trendStats.inflowOffset > 0
                                                ? 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20'
                                                : trendStats.inflowOffset < 0
                                                  ? 'text-rose-600 bg-rose-500/10 border-rose-500/20'
                                                  : 'text-muted-foreground bg-secondary/50 border-border',
                                        )}
                                    >
                                        {trendStats.inflowOffset > 0 ? (
                                            <TrendingUp className="w-3 h-3 me-1" />
                                        ) : trendStats.inflowOffset < 0 ? (
                                            <TrendingDown className="w-3 h-3 me-1" />
                                        ) : null}
                                        {trendStats.inflowOffset > 0 ? '+' : ''}
                                        {trendStats.inflowOffset.toFixed(1)}%
                                    </span>
                                    <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                                        {t('ledger.kpis.vsPriorPeriod', {
                                            defaultValue: 'vs prior period',
                                        })}
                                    </span>
                                </div>
                            </div>
                            <LedgerSparkline data={ledgerTrendData} dataKey="inflow" color="#10b981" gradientId="l-inflow" />
                        </CardContent>
                    </Card>

                    <Card className="rounded-3xl border border-border/50 bg-card/60 overflow-hidden relative group dark:bg-zinc-950">
                        <div className="absolute top-0 end-0 p-4 opacity-5 pointer-events-none group-hover:scale-110 transition-transform duration-500">
                            <ArrowUpRight className="w-24 h-24 text-amber-500" />
                        </div>
                        <CardHeader className="pb-2 flex flex-row items-center justify-between z-10 relative">
                            <CardTitle className="text-[13px] font-semibold tracking-tight text-amber-600 uppercase">
                                {t('ledger.kpis.totalOutflow', {
                                    defaultValue: 'Total Outflow',
                                })}
                            </CardTitle>
                            <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center border border-amber-500/20">
                                <Package className="h-4 w-4 text-amber-600" />
                            </div>
                        </CardHeader>
                        <CardContent className="z-10 relative space-y-4">
                            <div className="space-y-1">
                                {renderCurrencySummary(
                                    totalOutflow,
                                    totalOutflowInBaseCurrency,
                                    hasMultipleOutflowCurrencies,
                                    'text-2xl font-black tabular-nums tracking-tighter text-amber-600 leading-none',
                                )}
                                <div className="flex items-center gap-2">
                                    <span
                                        className={cn(
                                            'flex items-center text-[11px] font-bold px-1.5 py-0.5 rounded-full border',
                                            trendStats.outflowOffset > 0
                                                ? 'text-rose-600 bg-rose-500/10 border-rose-500/20'
                                                : trendStats.outflowOffset < 0
                                                  ? 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20'
                                                  : 'text-muted-foreground bg-secondary/50 border-border',
                                        )}
                                    >
                                        {trendStats.outflowOffset > 0 ? (
                                            <TrendingUp className="w-3 h-3 me-1" />
                                        ) : trendStats.outflowOffset < 0 ? (
                                            <TrendingDown className="w-3 h-3 me-1" />
                                        ) : null}
                                        {trendStats.outflowOffset > 0 ? '+' : ''}
                                        {trendStats.outflowOffset.toFixed(1)}%
                                    </span>
                                    <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                                        {t('ledger.kpis.vsPriorPeriod', {
                                            defaultValue: 'vs prior period',
                                        })}
                                    </span>
                                </div>
                            </div>
                            <LedgerSparkline data={ledgerTrendData} dataKey="outflow" color="#f59e0b" gradientId="l-outflow" />
                        </CardContent>
                    </Card>

                    <Card className="rounded-3xl border border-border/50 bg-card/60 overflow-hidden relative group dark:bg-zinc-950">
                        <div className="absolute top-0 end-0 p-4 opacity-5 pointer-events-none group-hover:scale-110 transition-transform duration-500">
                            <Wallet className={cn('w-24 h-24', netFlowIsNegative ? 'text-rose-500' : 'text-sky-500')} />
                        </div>
                        <CardHeader className="pb-2 flex flex-row items-center justify-between z-10 relative">
                            <CardTitle
                                className={cn(
                                    'text-[13px] font-semibold tracking-tight uppercase',
                                    netFlowIsNegative ? 'text-rose-600' : 'text-sky-600',
                                )}
                            >
                                {t('ledger.kpis.netFlow', { defaultValue: 'Net Flow' })}
                            </CardTitle>
                            <div
                                className={cn(
                                    'w-8 h-8 rounded-full flex items-center justify-center border',
                                    netFlowIsNegative ? 'bg-rose-500/10 border-rose-500/20' : 'bg-sky-500/10 border-sky-500/20',
                                )}
                            >
                                <BarChart3 className={cn('h-4 w-4', netFlowIsNegative ? 'text-rose-600' : 'text-sky-600')} />
                            </div>
                        </CardHeader>
                        <CardContent className="z-10 relative space-y-4">
                            <div className="space-y-1">
                                {renderCurrencySummary(
                                    netFlow,
                                    netFlowInBaseCurrency,
                                    hasMultipleNetFlowCurrencies,
                                    cn(
                                        'text-2xl font-black tabular-nums tracking-tighter leading-none',
                                        netFlowIsNegative ? 'text-rose-600' : 'text-sky-600',
                                    ),
                                )}
                                <div className="flex items-center gap-2">
                                    <span
                                        className={cn(
                                            'flex items-center text-[11px] font-bold px-1.5 py-0.5 rounded-full border',
                                            trendStats.netFlowOffset > 0
                                                ? 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20'
                                                : trendStats.netFlowOffset < 0
                                                  ? 'text-rose-600 bg-rose-500/10 border-rose-500/20'
                                                  : 'text-muted-foreground bg-secondary/50 border-border',
                                        )}
                                    >
                                        {trendStats.netFlowOffset > 0 ? (
                                            <TrendingUp className="w-3 h-3 me-1" />
                                        ) : trendStats.netFlowOffset < 0 ? (
                                            <TrendingDown className="w-3 h-3 me-1" />
                                        ) : null}
                                        {trendStats.netFlowOffset > 0 ? '+' : ''}
                                        {trendStats.netFlowOffset.toFixed(1)}%
                                    </span>
                                    <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                                        {t('ledger.kpis.vsPriorPeriod', {
                                            defaultValue: 'vs prior period',
                                        })}
                                    </span>
                                </div>
                            </div>
                            <LedgerSparkline
                                data={ledgerTrendData}
                                dataKey="net"
                                color={netFlowIsNegative ? '#ef4444' : '#0ea5e9'}
                                gradientId="l-net"
                            />
                        </CardContent>
                    </Card>

                    {SHOW_LEDGER_ANALYTICS_WIDGETS && (
                        <Card className="col-span-1 rounded-3xl border border-border/50 bg-card/60 overflow-hidden relative group dark:bg-zinc-950">
                            <div className="absolute top-0 end-0 p-4 opacity-5 pointer-events-none group-hover:scale-110 transition-transform duration-500">
                                <Percent className="w-24 h-24 text-indigo-500" />
                            </div>
                            <CardHeader className="pb-2 flex flex-row items-center justify-between z-10 relative">
                                <CardTitle className="text-[13px] font-semibold tracking-tight text-indigo-600 uppercase">
                                    {t('ledger.kpis.grossSurplus', {
                                        defaultValue: 'Gross Surplus',
                                    })}
                                </CardTitle>
                                <div className="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
                                    <Percent className="h-4 w-4 text-indigo-600" />
                                </div>
                            </CardHeader>
                            <CardContent className="z-10 relative space-y-4">
                                <div className="space-y-1">
                                    <div className="text-2xl font-black tabular-nums tracking-tighter text-indigo-600">
                                        {trendStats.surplusRatio.toFixed(1)}%
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="flex items-center text-[11px] font-bold px-1.5 py-0.5 rounded-full border text-muted-foreground bg-secondary/50 border-border">
                                            {(trendStats.surplusRatio - trendStats.previousSurplusRatio).toFixed(1)}%
                                        </span>
                                        <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                                            {t('ledger.kpis.pointsChange', {
                                                defaultValue: 'points change',
                                            })}
                                        </span>
                                    </div>
                                </div>
                                <div className="pt-4 h-12 flex flex-col justify-end">
                                    <Progress
                                        value={Math.max(0, trendStats.surplusRatio)}
                                        className="h-2 bg-secondary"
                                        indicatorClassName="bg-indigo-600"
                                    />
                                    <div className="flex justify-between mt-2 pt-1">
                                        <span className="text-[9px] font-bold uppercase text-muted-foreground tracking-wider">
                                            {t('ledger.kpis.entriesCount', {
                                                defaultValue: 'Entries Count',
                                            })}
                                        </span>
                                        <span className="text-[10px] font-black text-indigo-600">{filteredEntries.length}</span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </TooltipProvider> : null}

            {SHOW_LEDGER_ANALYTICS_WIDGETS && (
                <div className="grid gap-4 lg:grid-cols-4">
                    <Card className="col-span-1 rounded-3xl border border-border/50 bg-card/60 dark:bg-zinc-950 flex flex-col relative overflow-hidden">
                        <CardHeader className="border-b border-border/20 z-10 bg-background/50 backdrop-blur-sm relative">
                            <CardTitle className="text-sm tracking-tight font-bold flex items-center justify-between">
                                {t('ledger.charts.topSourcesSinks', {
                                    defaultValue: 'Top Sources/Sinks',
                                })}
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                                    {t('ledger.charts.byNetValue', {
                                        defaultValue: 'By Net Value',
                                    })}
                                </span>
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="p-0 z-10 relative flex-1">
                            {trendStats.topModulesData.length > 0 ? (
                                <div className="flex flex-col h-full divide-y divide-border/20">
                                    {trendStats.topModulesData.map((item, idx) => (
                                        <div
                                            key={item.id}
                                            className="p-4 flex items-center hover:bg-secondary/20 transition-colors duration-200"
                                        >
                                            <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-black text-sm shrink-0 me-4 border border-primary/20">
                                                {idx + 1}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="font-bold text-sm truncate uppercase tracking-tight">{item.name}</div>
                                                <div className="text-[10px] font-semibold text-muted-foreground tracking-wider uppercase">
                                                    {item.sold}{' '}
                                                    {t('ledger.charts.entries', {
                                                        defaultValue: 'entries',
                                                    })}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div
                                                    className={cn(
                                                        'text-sm font-black tabular-nums tracking-tighter',
                                                        item.profit > 0
                                                            ? 'text-emerald-600'
                                                            : item.profit < 0
                                                              ? 'text-rose-600'
                                                              : 'text-muted-foreground',
                                                    )}
                                                >
                                                    {formatCurrency(item.profit, baseCurrency, features.iqd_display_preference)}
                                                </div>
                                                <div className="text-[9px] font-bold text-muted-foreground tracking-wider flex items-center justify-end gap-1 uppercase">
                                                    {t('ledger.charts.netResult', {
                                                        defaultValue: 'Net Result',
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="h-48 flex items-center justify-center text-sm font-medium text-muted-foreground">
                                    {t('ledger.charts.noEntryData', {
                                        defaultValue: 'No entry data available.',
                                    })}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    <Card className="col-span-1 lg:col-span-2 rounded-3xl border border-border/50 bg-card/60 dark:bg-zinc-950 flex flex-col relative overflow-hidden">
                        <CardHeader className="border-b border-border/20 z-10 bg-background/50 backdrop-blur-sm relative">
                            <CardTitle className="text-sm font-bold tracking-tight">
                                {t('ledger.charts.movementOverview', {
                                    defaultValue: 'Ledger Movement Overview',
                                })}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="flex-1 p-6 relative z-10">
                            <div className="h-[240px] w-full">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={ledgerTrendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                        <XAxis
                                            dataKey="dateKey"
                                            tickLine={false}
                                            axisLine={false}
                                            tick={{ fontSize: 10, fill: '#888888', fontWeight: 600 }}
                                            tickMargin={10}
                                        />
                                        <RechartsTooltip
                                            cursor={{ fill: 'rgba(0,0,0,0.05)' }}
                                            content={({ active, payload }) => {
                                                if (active && payload && payload.length) {
                                                    return (
                                                        <div className="bg-background border border-border p-3 rounded-lg shadow-xl shadow-black/5 dark:shadow-black/20 text-xs text-foreground">
                                                            <div className="font-bold mb-2 uppercase tracking-wide text-[10px] text-muted-foreground">
                                                                {payload[0].payload.dateKey}
                                                            </div>
                                                            <div className="space-y-1">
                                                                <div className="flex justify-between gap-4 font-semibold text-emerald-600">
                                                                    <span>
                                                                        {t('ledger.tooltip.inflow', {
                                                                            defaultValue: 'Inflow:',
                                                                        })}
                                                                    </span>
                                                                    <span className="font-mono">
                                                                        {formatCurrency(
                                                                            payload[0].value as number,
                                                                            baseCurrency,
                                                                            features.iqd_display_preference,
                                                                        )}
                                                                    </span>
                                                                </div>
                                                                <div className="flex justify-between gap-4 font-semibold text-rose-600">
                                                                    <span>
                                                                        {t('ledger.tooltip.outflow', {
                                                                            defaultValue: 'Outflow:',
                                                                        })}
                                                                    </span>
                                                                    <span className="font-mono">
                                                                        {formatCurrency(
                                                                            payload[1].value as number,
                                                                            baseCurrency,
                                                                            features.iqd_display_preference,
                                                                        )}
                                                                    </span>
                                                                </div>
                                                                <div className="flex justify-between gap-4 font-bold border-t border-border mt-1 pt-1 text-foreground">
                                                                    <span>
                                                                        {t('ledger.tooltip.net', {
                                                                            defaultValue: 'Net:',
                                                                        })}
                                                                    </span>
                                                                    <span
                                                                        className={cn(
                                                                            'font-mono',
                                                                            (payload[0].payload.net as number) < 0
                                                                                ? 'text-rose-600'
                                                                                : 'text-sky-600',
                                                                        )}
                                                                    >
                                                                        {formatCurrency(
                                                                            payload[0].payload.net as number,
                                                                            baseCurrency,
                                                                            features.iqd_display_preference,
                                                                        )}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )
                                                }
                                                return null
                                            }}
                                        />
                                        <Bar dataKey="inflow" fill="#10b981" radius={[4, 4, 4, 4]} maxBarSize={40} />
                                        <Bar dataKey="outflow" fill="#f43f5e" radius={[4, 4, 4, 4]} maxBarSize={40} />
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="col-span-1 border border-border/50 bg-card/60 dark:bg-zinc-950 rounded-3xl overflow-hidden flex flex-col">
                        <CardHeader className="border-b border-border/20 z-10 bg-background/50 backdrop-blur-sm relative py-4">
                            <CardTitle className="text-sm tracking-tight font-bold flex items-center justify-between">
                                {t('ledger.charts.peakActivity', {
                                    defaultValue: 'Peak Activity',
                                })}
                                <Clock className="h-4 w-4 text-muted-foreground" />
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="flex-1 p-0 relative z-10 flex flex-col">
                            <div className="flex-1 flex flex-col justify-center px-4 pt-6 pb-2">
                                <div className="h-[180px] w-full">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={trendStats.hourlyData} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                                            <defs>
                                                <linearGradient id="ledger-peak-bg" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                                                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                                                </linearGradient>
                                            </defs>
                                            <XAxis
                                                dataKey="hour"
                                                tick={{ fontSize: 9, fill: '#888' }}
                                                axisLine={false}
                                                tickLine={false}
                                                interval={3}
                                            />
                                            <RechartsTooltip
                                                cursor={false}
                                                content={({ active, payload }) => {
                                                    if (active && payload && payload.length) {
                                                        const hour = payload[0].payload
                                                        return (
                                                            <div className="bg-background border border-border p-2 rounded-lg shadow-xl shadow-black/5 dark:shadow-black/20 text-xs">
                                                                <div className="font-bold mb-1 text-[10px] text-muted-foreground tracking-wide">
                                                                    {hour.hour} - {hour.hour.replace(':00', ':59')}
                                                                </div>
                                                                <div className="flex items-center justify-between gap-4">
                                                                    <span className="font-bold text-foreground">
                                                                        {t('ledger.charts.activityLevel', {
                                                                            defaultValue: 'Activity Level',
                                                                        })}
                                                                    </span>
                                                                    <span className="font-black text-indigo-500">{hour.count} tx</span>
                                                                </div>
                                                            </div>
                                                        )
                                                    }
                                                    return null
                                                }}
                                            />
                                            <Area
                                                type="monotone"
                                                dataKey="count"
                                                stroke="#6366f1"
                                                fillOpacity={1}
                                                fill="url(#ledger-peak-bg)"
                                                strokeWidth={2.5}
                                            />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                            <div className="p-3 bg-muted/30 border-t border-border/10 text-[11px] text-center font-semibold text-muted-foreground tracking-wide">
                                {t('ledger.charts.hourlyVolume', {
                                    defaultValue: 'Hourly transaction volume',
                                })}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}
            {usesEquivalentTrend ? (
                <p className="text-xs text-muted-foreground">
                    {t('ledger.charts.sparklineNote', {
                        currency: trendCurrencyMode.currency.toUpperCase(),
                        defaultValue: `Sparkline charts use ${trendCurrencyMode.currency.toUpperCase()} equivalent when multiple currencies are included.`,
                    })}
                </p>
            ) : null}

            <Card id="ledger-entries" className="scroll-mt-4">
                <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 gap-4">
                    <div className="space-y-1">
                        <CardTitle>{t('ledger.table.title', { defaultValue: 'Ledger Entries' })}</CardTitle>
                        <p className="text-sm text-muted-foreground">
                            {t('ledger.filters.matchingEntries', {
                                count: filteredEntries.length,
                            })}
                        </p>
                    </div>
                    <div className="flex flex-col sm:flex-row items-center gap-4">
                        {hasCapability('excelExportLedger') && (
                            <Button
                                onClick={() => setIsExportModalOpen(true)}
                                disabled={filteredEntries.length === 0}
                                className={cn(
                                    'h-10 px-6 font-black transition-all flex gap-3 items-center group relative overflow-hidden',
                                    style === 'neo-orange'
                                        ? 'rounded-[var(--radius)] bg-emerald-500 text-black border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none translate-y-[-2px] active:translate-y-0'
                                        : 'rounded-full bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] hover:scale-[1.02] active:scale-95',
                                    'uppercase tracking-widest text-[10px]',
                                )}
                            >
                                <FileSpreadsheet className="w-4 h-4 transition-transform group-hover:rotate-12" />
                                <span className="hidden sm:inline">{t('sales.export.button')}</span>
                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 dark:via-white/5 to-transparent -translate-x-full group-hover:animate-shimmer" />
                            </Button>
                        )}
                        <Button
                            type="button"
                            variant={isDirectionSplitView ? 'default' : 'outline'}
                            onClick={() => setIsDirectionSplitView((current) => !current)}
                            className="h-10 rounded-2xl px-4"
                        >
                            {isDirectionSplitView
                                ? t('ledger.table.combinedView', {
                                      defaultValue: 'Show Original Ledger View',
                                  })
                                : t('ledger.table.splitView', {
                                      defaultValue: 'Separate Inflows / Outflows',
                                  })}
                        </Button>
                        <AppPagination
                            currentPage={currentPage}
                            totalCount={filteredEntries.length}
                            pageSize={pageSize}
                            onPageChange={setCurrentPage}
                            onPageSizeChange={(newSize) => {
                                setPageSize(newSize)
                                setCurrentPage(1)
                            }}
                            className="w-auto"
                        />
                    </div>
                </CardHeader>
                <CardContent className={cn(isDirectionSplitView ? 'overflow-hidden' : 'overflow-x-auto')}>
                    {isLoading || isDateLoading ? (
                        <div className="flex justify-center py-8">
                            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : filteredEntries.length === 0 ? (
                        renderEntriesTable(
                            visibleEntries,
                            t('ledger.table.noMatch', {
                                defaultValue: 'No ledger entries match the current filters.',
                            }),
                        )
                    ) : isDirectionSplitView ? (
                        <div className="grid gap-6 xl:grid-cols-2">
                            <section className="min-w-0 overflow-x-auto rounded-3xl border border-emerald-500/15 bg-emerald-500/[0.03]">
                                <div className="flex items-center justify-between border-b border-emerald-500/15 px-5 py-4">
                                    <div>
                                        <div className="text-sm font-bold text-emerald-700">
                                            {t('ledger.direction.inflow', { defaultValue: 'Inflow' })}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {t('ledger.table.splitViewDescription', {
                                                defaultValue: 'Current page entries grouped by flow direction.',
                                            })}
                                        </p>
                                    </div>
                                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-700">
                                        {visibleIncomingEntries.length}
                                    </span>
                                </div>
                                {renderEntriesTable(
                                    visibleIncomingEntries,
                                    t('ledger.table.noIncoming', {
                                        defaultValue: 'No inflow entries on this page.',
                                    }),
                                    {
                                        compactTransactionId: true,
                                        compactColumns: true,
                                        hideDescriptionNotes: true,
                                        hideActions: true,
                                    },
                                )}
                            </section>

                            <section className="min-w-0 overflow-x-auto rounded-3xl border border-amber-500/15 bg-amber-500/[0.03]">
                                <div className="flex items-center justify-between border-b border-amber-500/15 px-5 py-4">
                                    <div>
                                        <div className="text-sm font-bold text-amber-700">
                                            {t('ledger.direction.outflow', {
                                                defaultValue: 'Outflow',
                                            })}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {t('ledger.table.splitViewDescription', {
                                                defaultValue: 'Current page entries grouped by flow direction.',
                                            })}
                                        </p>
                                    </div>
                                    <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-700">
                                        {visibleOutgoingEntries.length}
                                    </span>
                                </div>
                                {renderEntriesTable(
                                    visibleOutgoingEntries,
                                    t('ledger.table.noOutgoing', {
                                        defaultValue: 'No outflow entries on this page.',
                                    }),
                                    {
                                        compactTransactionId: true,
                                        compactColumns: true,
                                        hideDescriptionNotes: true,
                                        hideActions: true,
                                    },
                                )}
                            </section>

                            <section className="min-w-0 overflow-x-auto rounded-3xl border border-sky-500/15 bg-sky-500/[0.03]">
                                <div className="flex items-center justify-between border-b border-sky-500/15 px-5 py-4">
                                    <div>
                                        <div className="text-sm font-bold text-sky-700">
                                            {t('ledger.direction.opening', {
                                                defaultValue: 'Opening',
                                            })}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {t('ledger.table.openingBalanceDescription', {
                                                defaultValue: 'Opening balances are retained for audit but do not affect cash-flow totals.',
                                            })}
                                        </p>
                                    </div>
                                    <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1 text-xs font-bold text-sky-700">
                                        {visibleOpeningEntries.length}
                                    </span>
                                </div>
                                {renderEntriesTable(
                                    visibleOpeningEntries,
                                    t('ledger.table.noOpening', {
                                        defaultValue: 'No opening-balance entries on this page.',
                                    }),
                                    {
                                        compactTransactionId: true,
                                        compactColumns: true,
                                        hideDescriptionNotes: true,
                                        hideActions: true,
                                    },
                                )}
                            </section>

                            <section className="min-w-0 overflow-x-auto rounded-3xl border border-violet-500/15 bg-violet-500/[0.03]">
                                <div className="flex items-center justify-between border-b border-violet-500/15 px-5 py-4">
                                    <div>
                                        <div className="text-sm font-bold text-violet-700">
                                            {t('ledger.direction.adjustment', {
                                                defaultValue: 'Adjustment',
                                            })}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {t('ledger.table.adjustmentDescription', {
                                                defaultValue: 'Balance corrections are retained for audit but do not affect cash-flow totals.',
                                            })}
                                        </p>
                                    </div>
                                    <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1 text-xs font-bold text-violet-700">
                                        {visibleAdjustmentEntries.length}
                                    </span>
                                </div>
                                {renderEntriesTable(
                                    visibleAdjustmentEntries,
                                    t('ledger.table.noAdjustment', {
                                        defaultValue: 'No adjustment entries on this page.',
                                    }),
                                    {
                                        compactTransactionId: true,
                                        compactColumns: true,
                                        hideDescriptionNotes: true,
                                        hideActions: true,
                                    },
                                )}
                            </section>
                        </div>
                    ) : (
                        renderEntriesTable(
                            visibleEntries,
                            t('ledger.table.noMatch', {
                                defaultValue: 'No ledger entries match the current filters.',
                            }),
                        )
                    )}
                </CardContent>
            </Card>

            <AppDialog open={isFilterDialogOpen} onOpenChange={setIsFilterDialogOpen}>
                <AppDialogContent className="max-w-5xl">
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-3">
                            <span className="rounded-2xl bg-primary/10 p-2.5 text-primary">
                                <SlidersHorizontal className="h-5 w-5" />
                            </span>
                            {t('ledger.filters.dialogTitle')}
                        </AppDialogTitle>
                        <AppDialogDescription>{t('ledger.filters.dialogDescription')}</AppDialogDescription>
                    </AppDialogHeader>

                    <AppDialogBody className="space-y-6">
                        <div className="grid gap-3 md:grid-cols-3">
                            <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-700">
                                    {t('ledger.filters.preview')}
                                </div>
                                <div className="mt-2 text-2xl font-black tabular-nums text-emerald-700">{draftPreviewEntries.length}</div>
                                <div className="mt-1 text-xs text-muted-foreground">{t('ledger.filters.previewDescription')}</div>
                            </div>
                            <div className="rounded-2xl border border-border/60 bg-secondary/20 p-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                                    {t('ledger.filters.pageRange')}
                                </div>
                                <div className="mt-2 text-sm font-bold">{dateDisplay || t('performance.filters.allTime')}</div>
                                <div className="mt-1 text-xs text-muted-foreground">{t('ledger.filters.pageRangeDescription')}</div>
                            </div>
                            <div className="rounded-2xl border border-border/60 bg-secondary/20 p-4">
                                <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                                    {t('ledger.filters.activeConditions')}
                                </div>
                                <div className="mt-2 text-2xl font-black tabular-nums">{countActiveLedgerFilters(draftFilters)}</div>
                                <div className="mt-1 text-xs text-muted-foreground">{t('ledger.filters.activeConditionsDescription')}</div>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="ledger-filter-search">{t('ledger.filters.keywordSearch')}</Label>
                            <div className="relative">
                                <Search className="pointer-events-none absolute start-3 top-3.5 h-4 w-4 text-muted-foreground" />
                                <Input
                                    id="ledger-filter-search"
                                    value={draftFilters.search}
                                    onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
                                    placeholder={t('ledger.filters.searchPlaceholder')}
                                    className="ps-9"
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">{t('ledger.filters.searchHint')}</p>
                        </div>

                        <div className="grid gap-4 lg:grid-cols-2">
                            <section className="space-y-4 rounded-[1.5rem] border border-border/60 bg-background/80 p-5">
                                <div className="space-y-1">
                                    <h3 className="flex items-center gap-2 text-base font-black tracking-tight">
                                        <ArrowDownLeft className="h-4 w-4 text-primary" />
                                        {t('ledger.filters.movementMeaning')}
                                    </h3>
                                    <p className="text-sm text-muted-foreground">{t('ledger.filters.movementMeaningDescription')}</p>
                                </div>

                                <div className="space-y-2">
                                    <Label>{t('ledger.filters.cashCategory')}</Label>
                                    <LedgerMultiSelect
                                        value={draftFilters.category}
                                        options={includeSelectedOptions(filterFacets.category, draftFilters.category)}
                                        allLabel={t('ledger.filters.allCashCategories')}
                                        multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.category.length })}
                                        getOptionLabel={(category) => movementCategoryLabel(category, t)}
                                        getOptionCount={(category) => filterFacets.counts.category.get(category) || 0}
                                        onChange={(category) => setDraftFilters((current) => ({ ...current, category }))}
                                    />
                                </div>

                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>{t('ledger.filters.direction')}</Label>
                                        <LedgerMultiSelect
                                            value={draftFilters.direction}
                                            options={includeSelectedOptions(filterFacets.direction, draftFilters.direction)}
                                            allLabel={t('ledger.direction.allDirections')}
                                            multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.direction.length })}
                                            getOptionLabel={(direction) => directionFilterLabel(direction, t)}
                                            getOptionCount={(direction) => filterFacets.counts.direction.get(direction) || 0}
                                            onChange={(direction) => setDraftFilters((current) => ({ ...current, direction }))}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>{t('ledger.filters.entryState')}</Label>
                                        <LedgerMultiSelect
                                            value={draftFilters.transactionState}
                                            options={includeSelectedOptions(filterFacets.transactionState, draftFilters.transactionState)}
                                            allLabel={t('ledger.filters.allEntryStates')}
                                            multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.transactionState.length })}
                                            getOptionLabel={(state) => transactionStateLabel(state, t)}
                                            getOptionCount={(state) => filterFacets.counts.transactionState.get(state) || 0}
                                            onChange={(transactionState) =>
                                                setDraftFilters((current) => ({ ...current, transactionState }))
                                            }
                                        />
                                    </div>
                                </div>

                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>{t('ledger.filters.sourceModule')}</Label>
                                        <LedgerMultiSelect
                                            value={draftFilters.source}
                                            options={includeSelectedOptions(filterFacets.source, draftFilters.source)}
                                            allLabel={t('ledger.filters.allModules')}
                                            multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.source.length })}
                                            getOptionLabel={(source) => sourceModuleLabel(source, t)}
                                            getOptionCount={(source) => filterFacets.counts.source.get(source) || 0}
                                            onChange={(source) => setDraftFilters((current) => ({ ...current, source }))}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>{t('ledger.filters.exactEntryType')}</Label>
                                        <LedgerMultiSelect
                                            value={draftFilters.type}
                                            options={includeSelectedOptions(filterFacets.type, draftFilters.type)}
                                            allLabel={t('ledger.filters.allTypes')}
                                            multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.type.length })}
                                            getOptionLabel={(type) => ledgerTypeLabel(type, t)}
                                            getOptionCount={(type) => filterFacets.counts.type.get(type) || 0}
                                            onChange={(type) => setDraftFilters((current) => ({ ...current, type }))}
                                        />
                                    </div>
                                </div>
                            </section>

                            <section className="space-y-4 rounded-[1.5rem] border border-border/60 bg-background/80 p-5">
                                <div className="space-y-1">
                                    <h3 className="flex items-center gap-2 text-base font-black tracking-tight">
                                        <Wallet className="h-4 w-4 text-primary" />
                                        {t('ledger.filters.paymentTrail')}
                                    </h3>
                                    <p className="text-sm text-muted-foreground">{t('ledger.filters.paymentTrailDescription')}</p>
                                </div>

                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>{t('ledger.filters.counterparty')}</Label>
                                        <LedgerMultiSelect
                                            value={draftFilters.counterparty}
                                            options={includeSelectedOptions(filterFacets.counterparty, draftFilters.counterparty)}
                                            allLabel={t('ledger.filters.allCounterparties')}
                                            multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.counterparty.length })}
                                            getOptionLabel={(counterparty) =>
                                                filterFacets.counterpartyLabels.get(counterparty) || counterparty
                                            }
                                            getOptionCount={(counterparty) => filterFacets.counts.counterparty.get(counterparty) || 0}
                                            onChange={(counterparty) => setDraftFilters((current) => ({ ...current, counterparty }))}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>{t('ledger.filters.paymentAccount')}</Label>
                                        <LedgerMultiSelect
                                            value={draftFilters.paymentAccounts}
                                            options={includeSelectedOptions(filterFacets.paymentAccounts, draftFilters.paymentAccounts)}
                                            allLabel={t('ledger.filters.allPaymentAccounts')}
                                            multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.paymentAccounts.length })}
                                            getOptionLabel={(account) => filterFacets.paymentAccountLabels.get(account) || account}
                                            getOptionCount={(account) => filterFacets.counts.paymentAccounts.get(account) || 0}
                                            onChange={(paymentAccounts) =>
                                                setDraftFilters((current) => ({ ...current, paymentAccounts }))
                                            }
                                        />
                                    </div>
                                </div>

                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>{t('ledger.filters.paymentMethod')}</Label>
                                        <LedgerMultiSelect
                                            value={draftFilters.paymentMethods}
                                            options={includeSelectedOptions(filterFacets.paymentMethods, draftFilters.paymentMethods)}
                                            allLabel={t('ledger.filters.anyMethod')}
                                            multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.paymentMethods.length })}
                                            getOptionLabel={(method) => paymentMethodLabel(method, t)}
                                            getOptionCount={(method) => filterFacets.counts.paymentMethods.get(method) || 0}
                                            onChange={(paymentMethods) =>
                                                setDraftFilters((current) => ({ ...current, paymentMethods }))
                                            }
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>{t('ledger.filters.currency')}</Label>
                                        <LedgerMultiSelect
                                            value={draftFilters.currency}
                                            options={includeSelectedOptions(filterFacets.currency, draftFilters.currency)}
                                            allLabel={t('ledger.filters.allCurrencies')}
                                            multipleLabel={t('ledger.filters.selectedCount', { count: draftFilters.currency.length })}
                                            getOptionLabel={(currency) => currency.toUpperCase()}
                                            getOptionCount={(currency) => filterFacets.counts.currency.get(currency) || 0}
                                            onChange={(currency) =>
                                                setDraftFilters((current) =>
                                                    normalizeLedgerFiltersForCurrency({ ...current, currency }),
                                                )
                                            }
                                        />
                                    </div>
                                </div>

                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label htmlFor="ledger-filter-min-amount">{t('ledger.filters.minimumAmount')}</Label>
                                        <Input
                                            id="ledger-filter-min-amount"
                                            inputMode="decimal"
                                            disabled={!canCompareLedgerAmounts(draftFilters)}
                                            value={formatNumericInput(draftFilters.minAmount)}
                                            onChange={(event) =>
                                                setDraftFilters((current) => ({
                                                    ...current,
                                                    minAmount: sanitizeNumericInput(event.target.value, { allowDecimal: true }),
                                                }))
                                            }
                                            placeholder="0"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="ledger-filter-max-amount">{t('ledger.filters.maximumAmount')}</Label>
                                        <Input
                                            id="ledger-filter-max-amount"
                                            inputMode="decimal"
                                            disabled={!canCompareLedgerAmounts(draftFilters)}
                                            value={formatNumericInput(draftFilters.maxAmount)}
                                            onChange={(event) =>
                                                setDraftFilters((current) => ({
                                                    ...current,
                                                    maxAmount: sanitizeNumericInput(event.target.value, { allowDecimal: true }),
                                                }))
                                            }
                                            placeholder="0"
                                            aria-invalid={isDraftAmountRangeInvalid}
                                        />
                                    </div>
                                </div>
                                <p className={cn('text-xs', isDraftAmountRangeInvalid ? 'text-destructive' : 'text-muted-foreground')}>
                                    {isDraftAmountRangeInvalid
                                        ? t('ledger.filters.invalidAmountRange')
                                        : canCompareLedgerAmounts(draftFilters)
                                          ? t('ledger.filters.amountRangeCurrencyHint', {
                                                currency: draftFilters.currency[0].toUpperCase(),
                                            })
                                          : t('ledger.filters.selectSingleCurrencyHint')}
                                </p>

                                <div className="space-y-2">
                                    <Label>{t('ledger.filters.sortBy')}</Label>
                                    <Select
                                        value={draftFilters.sort}
                                        onValueChange={(value: LedgerSortOption) =>
                                            setDraftFilters((current) => ({ ...current, sort: value }))
                                        }
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="date_desc">{sortOptionLabel('date_desc', t)}</SelectItem>
                                            <SelectItem value="date_asc">{sortOptionLabel('date_asc', t)}</SelectItem>
                                            <SelectItem value="amount_desc" disabled={!canCompareLedgerAmounts(draftFilters)}>
                                                {sortOptionLabel('amount_desc', t)}
                                            </SelectItem>
                                            <SelectItem value="amount_asc" disabled={!canCompareLedgerAmounts(draftFilters)}>
                                                {sortOptionLabel('amount_asc', t)}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </section>
                        </div>
                    </AppDialogBody>

                    <AppDialogFooter className="justify-between sm:justify-between">
                        <Button type="button" variant="ghost" onClick={handleResetDraftFilters} className="rounded-2xl">
                            <RotateCcw className="me-2 h-4 w-4" />
                            {t('ledger.filters.resetDraft')}
                        </Button>
                        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                            <Button type="button" variant="outline" onClick={() => setIsFilterDialogOpen(false)} className="rounded-2xl">
                                {t('ledger.filters.cancel')}
                            </Button>
                            <Button
                                type="button"
                                onClick={handleApplyFilters}
                                disabled={isDraftAmountRangeInvalid}
                                className="rounded-2xl"
                            >
                                {t('ledger.filters.applyFilters', { count: draftPreviewEntries.length })}
                            </Button>
                        </div>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>
        </div>
    )
}
