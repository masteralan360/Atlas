import { useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, RotateCcw, Search } from 'lucide-react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import {
    getPaymentSourceKey,
    getPaymentTransactionRoutePath,
    isReversiblePaymentSourceType,
    recordObligationSettlement,
    reversePaymentTransaction,
    useLockedPaymentSourceKeys,
    usePaymentObligations,
    usePaymentTransactions,
    type PaymentObligation,
    type PaymentTransaction
} from '@/local-db'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
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
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    useToast
} from '@/ui/components'
import { SettlementDialog } from '@/ui/components/payments/SettlementDialog'
import { useWorkspace } from '@/workspace'

type DirectionFilter = 'all' | 'incoming' | 'outgoing'
type SourceFilter = 'all' | 'loans' | 'orders' | 'budget' | 'payments'
type OpenStatusFilter = 'all' | 'open' | 'overdue'

function sourceTypeLabel(value: PaymentObligation['sourceType'] | PaymentTransaction['sourceType'], t: any) {
    switch (value) {
        case 'loan_origination':
            return t('payments.sourceType.loanOrigination', { defaultValue: 'Loan Origination' })
        case 'loan_installment':
            return t('payments.sourceType.loanInstallment', { defaultValue: 'Loan Installment' })
        case 'simple_loan':
            return t('payments.sourceType.simpleLoan', { defaultValue: 'Simple Loan' })
        case 'loan_payment':
            return t('payments.sourceType.loanPayment', { defaultValue: 'Loan Payment' })
        case 'sales_order':
            return t('payments.sourceType.salesOrder', { defaultValue: 'Sales Order' })
        case 'purchase_order':
            return t('payments.sourceType.purchaseOrder', { defaultValue: 'Purchase Order' })
        case 'expense_item':
            return t('payments.sourceType.expense', { defaultValue: 'Expense' })
        case 'payroll_status':
            return t('payments.sourceType.payroll', { defaultValue: 'Payroll' })
        case 'direct_transaction':
            return t('payments.sourceType.directTransaction', { defaultValue: 'Direct Transaction' })
        default:
            return value
    }
}

function paymentMethodLabel(value: PaymentTransaction['paymentMethod'], t: any) {
    switch (value) {
        case 'bank_transfer':
            return t('ledger.paymentMethod.bankTransfer', { defaultValue: 'Bank Transfer' })
        case 'loan_adjustment':
            return t('ledger.paymentMethod.loanAdjustment', { defaultValue: 'Loan Adjustment' })
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
        default:
            return value.charAt(0).toUpperCase() + value.slice(1).replace('_', ' ')
    }
}

function collapseTransactionsBySource(items: PaymentTransaction[]) {
    const seen = new Set<string>()

    return items.filter((item) => {
        const key = getPaymentSourceKey(item)
        if (seen.has(key)) {
            return false
        }

        seen.add(key)
        return true
    })
}

function formatAmountSummary(
    rows: Array<{ amount: number; currency: string }>,
    iqdPreference: 'IQD' | 'د.ع'
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
        .map(([currency, amount]) => formatCurrency(amount, currency, iqdPreference))
        .join(' • ')
}

export function Payments() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { toast } = useToast()
    const { features } = useWorkspace()
    const [, setLocation] = useLocation()
    const workspaceId = user?.workspaceId
    const hasPaymentsSurface = features.loans || features.crm || features.budget || features.hr

    const [activeTab, setActiveTab] = useState<'open-items' | 'transactions'>('open-items')
    const [search, setSearch] = useState('')
    const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all')
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
    const [statusFilter, setStatusFilter] = useState<OpenStatusFilter>('all')
    const [selectedObligation, setSelectedObligation] = useState<PaymentObligation | null>(null)
    const [isSubmittingSettlement, setIsSubmittingSettlement] = useState(false)
    const [reversingTransactionId, setReversingTransactionId] = useState<string | null>(null)

    const obligations = usePaymentObligations(workspaceId, {
        direction: directionFilter,
        sourceModule: sourceFilter,
        status: statusFilter,
        search
    })
    const lockedSourceKeys = useLockedPaymentSourceKeys(workspaceId)

    const allTransactions = usePaymentTransactions(workspaceId, { includeReversals: true })
    const transactions = usePaymentTransactions(workspaceId, {
        direction: directionFilter,
        sourceModule: sourceFilter,
        search,
        includeReversals: true
    })
    const visibleTransactions = useMemo(() => collapseTransactionsBySource(transactions), [transactions])

    const reversedIds = useMemo(
        () => new Set(allTransactions.filter((item) => !!item.reversalOfTransactionId).map((item) => item.reversalOfTransactionId as string)),
        [allTransactions]
    )

    const latestUnreversedBySource = useMemo(() => {
        const map = new Map<string, PaymentTransaction>()
        const sourceRows = allTransactions
            .filter((item) => !item.isDeleted && !item.reversalOfTransactionId && !reversedIds.has(item.id))
            .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))

        sourceRows.forEach((item) => {
            const key = getPaymentSourceKey(item)
            if (!map.has(key)) {
                map.set(key, item)
            }
        })

        return map
    }, [allTransactions, reversedIds])

    const kpis = useMemo(() => ({
        totalOpen: formatAmountSummary(obligations, features.iqd_display_preference),
        overdue: formatAmountSummary(obligations.filter((item) => item.status === 'overdue'), features.iqd_display_preference),
        receivable: formatAmountSummary(obligations.filter((item) => item.direction === 'incoming'), features.iqd_display_preference),
        payable: formatAmountSummary(obligations.filter((item) => item.direction === 'outgoing'), features.iqd_display_preference)
    }), [obligations, features.iqd_display_preference])

    const handleSettle = async (input: { paymentMethod: PaymentTransaction['paymentMethod']; paidAt: string; note?: string }) => {
        if (!workspaceId || !selectedObligation) {
            return
        }

        setIsSubmittingSettlement(true)
        try {
            await recordObligationSettlement(workspaceId, selectedObligation, {
                paymentMethod: input.paymentMethod,
                paidAt: input.paidAt,
                note: input.note,
                createdBy: user?.id || null
            })
            toast({ title: t('payments.settlementRecorded', { defaultValue: 'Settlement recorded' }) })
            setSelectedObligation(null)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('payments.settlementFailed', { defaultValue: 'Failed to record settlement.' }),
                variant: 'destructive'
            })
        } finally {
            setIsSubmittingSettlement(false)
        }
    }

    const handleReverse = async (transaction: PaymentTransaction) => {
        if (!workspaceId) {
            return
        }

        setReversingTransactionId(transaction.id)
        try {
            await reversePaymentTransaction(workspaceId, transaction.id, {
                createdBy: user?.id || null
            })
            toast({ title: t('payments.reversed', { defaultValue: 'Transaction reversed' }) })
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('payments.reverseFailed', { defaultValue: 'Failed to reverse transaction.' }),
                variant: 'destructive'
            })
        } finally {
            setReversingTransactionId(null)
        }
    }

    if (!hasPaymentsSurface) {
        return (
            <div className="p-6">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('payments.notAvailable', { defaultValue: 'Payments is not available in this workspace' })}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        {t('payments.enableModules', { defaultValue: 'Enable Loans, CRM, Accounting, or HR to use the central payments surface.' })}
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-3">
                    <h1 className="text-3xl font-bold tracking-tight">{t('payments.title', { defaultValue: 'Payments' })}</h1>
                    <p className="text-sm text-muted-foreground">
                        {t('payments.subtitle', { defaultValue: 'Unified open obligations and central transaction history across loans, orders, payroll, and expenses.' })}
                    </p>
                    <Button type="button" variant="outline" onClick={() => setLocation('/direct-transactions')} className="w-fit">
                        {t('payments.directTransactions', { defaultValue: 'Direct Transactions' })}
                    </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">{t('payments.kpis.open', { defaultValue: 'Open' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.totalOpen}</CardContent>
                    </Card>
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">{t('payments.kpis.overdue', { defaultValue: 'Overdue' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.overdue}</CardContent>
                    </Card>
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">{t('payments.kpis.receivable', { defaultValue: 'Receivable' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.receivable}</CardContent>
                    </Card>
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">{t('payments.kpis.payable', { defaultValue: 'Payable' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.payable}</CardContent>
                    </Card>
                </div>
            </div>

            <Card>
                <CardContent className="pt-6">
                    <div className="grid gap-3 lg:grid-cols-[minmax(240px,1fr)_180px_180px_180px]">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={t('payments.searchPlaceholder', { defaultValue: 'Search payments' })}
                                className="pl-9"
                            />
                        </div>
                        <Select value={directionFilter} onValueChange={(value: DirectionFilter) => setDirectionFilter(value)}>
                            <SelectTrigger>
                                <SelectValue placeholder={t('payments.filters.allDirections', { defaultValue: 'All Directions' })} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">{t('payments.filters.allDirections', { defaultValue: 'All Directions' })}</SelectItem>
                                <SelectItem value="incoming">{t('payments.filters.incoming', { defaultValue: 'Incoming' })}</SelectItem>
                                <SelectItem value="outgoing">{t('payments.filters.outgoing', { defaultValue: 'Outgoing' })}</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={sourceFilter} onValueChange={(value: SourceFilter) => setSourceFilter(value)}>
                            <SelectTrigger>
                                <SelectValue placeholder={t('payments.filters.allSources', { defaultValue: 'All Sources' })} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">{t('payments.filters.allSources', { defaultValue: 'All Sources' })}</SelectItem>
                                <SelectItem value="loans">{t('payments.filters.loans', { defaultValue: 'Loans' })}</SelectItem>
                                <SelectItem value="orders">{t('payments.filters.orders', { defaultValue: 'Orders' })}</SelectItem>
                                <SelectItem value="budget">{t('payments.filters.accountingHr', { defaultValue: 'Accounting / HR' })}</SelectItem>
                                <SelectItem value="payments">{t('payments.filters.directManual', { defaultValue: 'Direct / Manual' })}</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={statusFilter} onValueChange={(value: OpenStatusFilter) => setStatusFilter(value)}>
                            <SelectTrigger>
                                <SelectValue placeholder={t('payments.filters.allStatuses', { defaultValue: 'All Open Statuses' })} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">{t('payments.filters.allStatuses', { defaultValue: 'All Open Statuses' })}</SelectItem>
                                <SelectItem value="open">{t('payments.filters.open', { defaultValue: 'Open' })}</SelectItem>
                                <SelectItem value="overdue">{t('payments.filters.overdue', { defaultValue: 'Overdue' })}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'open-items' | 'transactions')}>
                <TabsList>
                    <TabsTrigger value="open-items">{t('payments.tabs.openItems', { defaultValue: 'Open Items' })}</TabsTrigger>
                    <TabsTrigger value="transactions">{t('payments.tabs.transactions', { defaultValue: 'Transactions' })}</TabsTrigger>
                </TabsList>

                <TabsContent value="open-items">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('payments.tabs.openItems', { defaultValue: 'Open Items' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('payments.table.source', { defaultValue: 'Source' })}</TableHead>
                                        <TableHead>{t('payments.table.reference', { defaultValue: 'Reference' })}</TableHead>
                                        <TableHead>{t('payments.table.counterparty', { defaultValue: 'Counterparty' })}</TableHead>
                                        <TableHead>{t('payments.table.dueDate', { defaultValue: 'Due Date' })}</TableHead>
                                        <TableHead>{t('payments.table.direction', { defaultValue: 'Direction' })}</TableHead>
                                        <TableHead>{t('payments.table.amount', { defaultValue: 'Amount' })}</TableHead>
                                        <TableHead>{t('payments.table.status', { defaultValue: 'Status' })}</TableHead>
                                        <TableHead className="text-right">{t('payments.table.actions', { defaultValue: 'Actions' })}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {obligations.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                                                {t('payments.noOpenItems', { defaultValue: 'No open items match the current filters.' })}
                                            </TableCell>
                                        </TableRow>
                                    ) : obligations.map((item) => (
                                        <TableRow key={item.id}>
                                            {(() => {
                                                const isLockedSource = lockedSourceKeys.has(getPaymentSourceKey(item))
                                                return (
                                                    <>
                                            <TableCell>{sourceTypeLabel(item.sourceType, t)}</TableCell>
                                            <TableCell className="font-medium">{item.referenceLabel || item.title}</TableCell>
                                            <TableCell>
                                                <div>{item.counterpartyName || item.title}</div>
                                                {item.subtitle ? <div className="text-xs text-muted-foreground">{item.subtitle}</div> : null}
                                            </TableCell>
                                            <TableCell>{formatDate(item.dueDate)}</TableCell>
                                            <TableCell>
                                                <span className={cn(
                                                    'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                    item.direction === 'incoming'
                                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                        : 'border-amber-200 bg-amber-50 text-amber-700'
                                                )}>
                                                    {item.direction === 'incoming' 
                                                        ? t('payments.filters.incoming', { defaultValue: 'Incoming' }) 
                                                        : t('payments.filters.outgoing', { defaultValue: 'Outgoing' })}
                                                </span>
                                            </TableCell>
                                            <TableCell>{formatCurrency(item.amount, item.currency, features.iqd_display_preference)}</TableCell>
                                            <TableCell>
                                                <span className={cn(
                                                    'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                    isLockedSource
                                                        ? 'border-slate-300 bg-slate-100 text-slate-700'
                                                        : item.status === 'overdue'
                                                        ? 'border-rose-200 bg-rose-50 text-rose-700'
                                                        : 'border-slate-200 bg-slate-50 text-slate-700'
                                                )}>
                                                    {isLockedSource 
                                                        ? t('payments.status.locked', { defaultValue: 'Locked' }) 
                                                        : item.status === 'overdue' 
                                                            ? t('payments.filters.overdue', { defaultValue: 'Overdue' }) 
                                                            : t('payments.filters.open', { defaultValue: 'Open' })}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex justify-end gap-2">
                                                    <Button variant="outline" size="sm" onClick={() => setLocation(item.routePath)}>
                                                        {t('common.view', { defaultValue: 'View' })}
                                                    </Button>
                                                    <Button size="sm" disabled={isLockedSource} onClick={() => setSelectedObligation(item)}>
                                                        {item.direction === 'incoming' 
                                                            ? t('payments.collect', { defaultValue: 'Collect' }) 
                                                            : t('payments.pay', { defaultValue: 'Pay' })}
                                                    </Button>
                                                </div>
                                            </TableCell>
                                                    </>
                                                )
                                            })()}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="transactions">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('payments.tabs.transactions', { defaultValue: 'Transactions' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('payments.table.time', { defaultValue: 'Time' })}</TableHead>
                                        <TableHead>{t('payments.table.source', { defaultValue: 'Source' })}</TableHead>
                                        <TableHead>{t('payments.table.reference', { defaultValue: 'Reference' })}</TableHead>
                                        <TableHead>{t('payments.table.counterparty', { defaultValue: 'Counterparty' })}</TableHead>
                                        <TableHead>{t('payments.table.direction', { defaultValue: 'Direction' })}</TableHead>
                                        <TableHead>{t('payments.table.amount', { defaultValue: 'Amount' })}</TableHead>
                                        <TableHead>{t('payments.table.method', { defaultValue: 'Method' })}</TableHead>
                                        <TableHead>{t('payments.table.note', { defaultValue: 'Note' })}</TableHead>
                                        <TableHead>{t('payments.table.status', { defaultValue: 'Status' })}</TableHead>
                                        <TableHead className="text-right">{t('payments.table.actions', { defaultValue: 'Actions' })}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {visibleTransactions.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                                                {t('payments.noTransactions', { defaultValue: 'No transactions match the current filters.' })}
                                            </TableCell>
                                        </TableRow>
                                    ) : visibleTransactions.map((item) => {
                                        const isReversal = !!item.reversalOfTransactionId
                                        const isReversed = reversedIds.has(item.id)
                                        const isLockedSource = lockedSourceKeys.has(getPaymentSourceKey(item))
                                        const isLatestUnreversed = latestUnreversedBySource.get(getPaymentSourceKey(item))?.id === item.id
                                        const canReverse = !isReversal && !isReversed && !isLockedSource && isLatestUnreversed && isReversiblePaymentSourceType(item.sourceType)
                                        const displayAmount = isReversal ? 0 : item.amount

                                        return (
                                            <TableRow key={item.id}>
                                                <TableCell>{formatDateTime(item.paidAt)}</TableCell>
                                                <TableCell>{sourceTypeLabel(item.sourceType, t)}</TableCell>
                                                <TableCell className="font-medium">{item.referenceLabel || item.sourceRecordId}</TableCell>
                                                <TableCell>{item.counterpartyName || '—'}</TableCell>
                                                <TableCell>
                                                    <span className={cn(
                                                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                        item.direction === 'incoming'
                                                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                            : 'border-amber-200 bg-amber-50 text-amber-700'
                                                    )}>
                                                        {item.direction === 'incoming' ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                                                        {item.direction === 'incoming' 
                                                            ? t('payments.filters.incoming', { defaultValue: 'Incoming' }) 
                                                            : t('payments.filters.outgoing', { defaultValue: 'Outgoing' })}
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    {displayAmount < 0 ? '-' : ''}
                                                    {formatCurrency(Math.abs(displayAmount), item.currency, features.iqd_display_preference)}
                                                </TableCell>
                                                <TableCell>{paymentMethodLabel(item.paymentMethod, t)}</TableCell>
                                                <TableCell className="max-w-[240px] truncate">{item.note || '—'}</TableCell>
                                                <TableCell>
                                                    <span className={cn(
                                                        'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                        isReversal
                                                            ? 'border-amber-200 bg-amber-50 text-amber-700'
                                                            : isLockedSource
                                                                ? 'border-slate-300 bg-slate-100 text-slate-700'
                                                            : isReversed
                                                                ? 'border-slate-200 bg-slate-50 text-slate-700'
                                                                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                    )}>
                                                        {isReversal 
                                                            ? t('payments.status.reversal', { defaultValue: 'Reversal' }) 
                                                            : isLockedSource 
                                                                ? t('payments.status.locked', { defaultValue: 'Locked' }) 
                                                                : isReversed 
                                                                    ? t('payments.status.reversed', { defaultValue: 'Reversed' }) 
                                                                    : t('payments.status.posted', { defaultValue: 'Posted' })}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <div className="flex justify-end gap-2">
                                                        <Button variant="outline" size="sm" onClick={() => setLocation(getPaymentTransactionRoutePath(item))}>
                                                            {t('common.view', { defaultValue: 'View' })}
                                                        </Button>
                                                        {canReverse ? (
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                onClick={() => handleReverse(item)}
                                                                disabled={reversingTransactionId === item.id}
                                                            >
                                                                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                                                                {t('common.reverse', { defaultValue: 'Reverse' })}
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </TabsContent>

            </Tabs>

            <SettlementDialog
                open={!!selectedObligation}
                onOpenChange={(open) => {
                    if (!open) {
                        setSelectedObligation(null)
                    }
                }}
                obligation={selectedObligation}
                includeLoanAdjustment={selectedObligation?.sourceModule === 'loans'}
                isSubmitting={isSubmittingSettlement}
                onSubmit={handleSettle}
            />
        </div>
    )
}
