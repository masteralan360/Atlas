import { useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, RotateCcw, Search } from 'lucide-react'
import { useLocation } from 'wouter'

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

function sourceTypeLabel(value: PaymentObligation['sourceType'] | PaymentTransaction['sourceType']) {
    switch (value) {
        case 'loan_origination':
            return 'Loan Origination'
        case 'loan_installment':
            return 'Loan Installment'
        case 'simple_loan':
            return 'Simple Loan'
        case 'loan_payment':
            return 'Loan Payment'
        case 'sales_order':
            return 'Sales Order'
        case 'purchase_order':
            return 'Purchase Order'
        case 'expense_item':
            return 'Expense'
        case 'payroll_status':
            return 'Payroll'
        case 'direct_transaction':
            return 'Direct Transaction'
        default:
            return value
    }
}

function paymentMethodLabel(value: PaymentTransaction['paymentMethod']) {
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
            toast({ title: 'Settlement recorded' })
            setSelectedObligation(null)
        } catch (error: any) {
            toast({
                title: 'Error',
                description: error?.message || 'Failed to record settlement.',
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
            toast({ title: 'Transaction reversed' })
        } catch (error: any) {
            toast({
                title: 'Error',
                description: error?.message || 'Failed to reverse transaction.',
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
                        <CardTitle>Payments is not available in this workspace</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Enable Loans, CRM, Accounting, or HR to use the central payments surface.
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-3">
                    <h1 className="text-3xl font-bold tracking-tight">Payments</h1>
                    <p className="text-sm text-muted-foreground">
                        Unified open obligations and central transaction history across loans, orders, payroll, and expenses.
                    </p>
                    <Button type="button" variant="outline" onClick={() => setLocation('/direct-transactions')} className="w-fit">
                        Direct Transactions
                    </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Open</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.totalOpen}</CardContent>
                    </Card>
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Overdue</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.overdue}</CardContent>
                    </Card>
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Receivable</CardTitle>
                        </CardHeader>
                        <CardContent className="text-lg font-semibold">{kpis.receivable}</CardContent>
                    </Card>
                    <Card className="min-w-[180px]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-medium">Payable</CardTitle>
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
                                placeholder="Search payments"
                                className="pl-9"
                            />
                        </div>
                        <Select value={directionFilter} onValueChange={(value: DirectionFilter) => setDirectionFilter(value)}>
                            <SelectTrigger>
                                <SelectValue placeholder="Direction" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Directions</SelectItem>
                                <SelectItem value="incoming">Incoming</SelectItem>
                                <SelectItem value="outgoing">Outgoing</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={sourceFilter} onValueChange={(value: SourceFilter) => setSourceFilter(value)}>
                            <SelectTrigger>
                                <SelectValue placeholder="Source" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Sources</SelectItem>
                                <SelectItem value="loans">Loans</SelectItem>
                                <SelectItem value="orders">Orders</SelectItem>
                                <SelectItem value="budget">Accounting / HR</SelectItem>
                                <SelectItem value="payments">Direct / Manual</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={statusFilter} onValueChange={(value: OpenStatusFilter) => setStatusFilter(value)}>
                            <SelectTrigger>
                                <SelectValue placeholder="Status" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Open Statuses</SelectItem>
                                <SelectItem value="open">Open</SelectItem>
                                <SelectItem value="overdue">Overdue</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'open-items' | 'transactions')}>
                <TabsList>
                    <TabsTrigger value="open-items">Open Items</TabsTrigger>
                    <TabsTrigger value="transactions">Transactions</TabsTrigger>
                </TabsList>

                <TabsContent value="open-items">
                    <Card>
                        <CardHeader>
                            <CardTitle>Open Items</CardTitle>
                        </CardHeader>
                        <CardContent className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Source</TableHead>
                                        <TableHead>Reference</TableHead>
                                        <TableHead>Counterparty</TableHead>
                                        <TableHead>Due Date</TableHead>
                                        <TableHead>Direction</TableHead>
                                        <TableHead>Amount</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead className="text-right">Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {obligations.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                                                No open items match the current filters.
                                            </TableCell>
                                        </TableRow>
                                    ) : obligations.map((item) => (
                                        <TableRow key={item.id}>
                                            {(() => {
                                                const isLockedSource = lockedSourceKeys.has(getPaymentSourceKey(item))
                                                return (
                                                    <>
                                            <TableCell>{sourceTypeLabel(item.sourceType)}</TableCell>
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
                                                    {item.direction === 'incoming' ? 'Incoming' : 'Outgoing'}
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
                                                    {isLockedSource ? 'locked' : item.status}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex justify-end gap-2">
                                                    <Button variant="outline" size="sm" onClick={() => setLocation(item.routePath)}>
                                                        View
                                                    </Button>
                                                    <Button size="sm" disabled={isLockedSource} onClick={() => setSelectedObligation(item)}>
                                                        {item.direction === 'incoming' ? 'Collect' : 'Pay'}
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
                            <CardTitle>Transactions</CardTitle>
                        </CardHeader>
                        <CardContent className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Time</TableHead>
                                        <TableHead>Source</TableHead>
                                        <TableHead>Reference</TableHead>
                                        <TableHead>Counterparty</TableHead>
                                        <TableHead>Direction</TableHead>
                                        <TableHead>Amount</TableHead>
                                        <TableHead>Method</TableHead>
                                        <TableHead>Note</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead className="text-right">Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {visibleTransactions.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                                                No transactions match the current filters.
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
                                                <TableCell>{sourceTypeLabel(item.sourceType)}</TableCell>
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
                                                        {item.direction}
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    {displayAmount < 0 ? '-' : ''}
                                                    {formatCurrency(Math.abs(displayAmount), item.currency, features.iqd_display_preference)}
                                                </TableCell>
                                                <TableCell>{paymentMethodLabel(item.paymentMethod)}</TableCell>
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
                                                        {isReversal ? 'Reversal' : isLockedSource ? 'Locked' : isReversed ? 'Reversed' : 'Posted'}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <div className="flex justify-end gap-2">
                                                        <Button variant="outline" size="sm" onClick={() => setLocation(getPaymentTransactionRoutePath(item))}>
                                                            View
                                                        </Button>
                                                        {canReverse ? (
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                onClick={() => handleReverse(item)}
                                                                disabled={reversingTransactionId === item.id}
                                                            >
                                                                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                                                                Reverse
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
