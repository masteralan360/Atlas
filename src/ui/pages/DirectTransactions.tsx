import { useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Plus, RotateCcw, Search } from 'lucide-react'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import {
    getPaymentSourceKey,
    getPaymentTransactionRoutePath,
    recordDirectTransaction,
    reversePaymentTransaction,
    usePaymentTransactions,
    type PaymentTransaction
} from '@/local-db'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
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
    useToast
} from '@/ui/components'
import { DirectTransactionDialog } from '@/ui/components/payments/DirectTransactionDialog'
import { useWorkspace } from '@/workspace'

type DirectionFilter = 'all' | 'incoming' | 'outgoing'

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

export function DirectTransactions() {
    const { user } = useAuth()
    const { toast } = useToast()
    const { features } = useWorkspace()
    const [, setLocation] = useLocation()
    const workspaceId = user?.workspaceId
    const hasPaymentsSurface = features.loans || features.crm || features.budget || features.hr

    const [search, setSearch] = useState('')
    const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all')
    const [isDirectDialogOpen, setIsDirectDialogOpen] = useState(false)
    const [isSubmittingDirectTransaction, setIsSubmittingDirectTransaction] = useState(false)
    const [reversingTransactionId, setReversingTransactionId] = useState<string | null>(null)

    const allTransactions = usePaymentTransactions(workspaceId, { includeReversals: true })
    const directTransactions = useMemo(() => {
        const normalizedSearch = search.trim().toLowerCase()

        return allTransactions
            .filter((item) => {
                if (item.sourceType !== 'direct_transaction') {
                    return false
                }

                if (directionFilter !== 'all' && item.direction !== directionFilter) {
                    return false
                }

                if (!normalizedSearch) {
                    return true
                }

                return [
                    item.referenceLabel,
                    item.counterpartyName,
                    item.note,
                    item.paymentMethod
                ].some((value) => value?.toLowerCase().includes(normalizedSearch))
            })
            .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))
    }, [allTransactions, directionFilter, search])
    const visibleDirectTransactions = useMemo(() => collapseTransactionsBySource(directTransactions), [directTransactions])

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

    const handleCreateDirectTransaction = async (input: {
        direction: 'incoming' | 'outgoing'
        amount: number
        currency: 'usd' | 'iqd' | 'eur' | 'try'
        paymentMethod: PaymentTransaction['paymentMethod']
        paidAt: string
        reason: string
        note?: string
        counterpartyName?: string
        businessPartnerId?: string | null
    }) => {
        if (!workspaceId) {
            return
        }

        setIsSubmittingDirectTransaction(true)
        try {
            await recordDirectTransaction(workspaceId, {
                ...input,
                createdBy: user?.id || null
            })
            toast({ title: 'Direct transaction recorded' })
            setIsDirectDialogOpen(false)
        } catch (error: any) {
            toast({
                title: 'Error',
                description: error?.message || 'Failed to record direct transaction.',
                variant: 'destructive'
            })
        } finally {
            setIsSubmittingDirectTransaction(false)
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
                        <CardTitle>Direct Transactions is not available in this workspace</CardTitle>
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
                    <h1 className="text-3xl font-bold tracking-tight">Direct Transactions</h1>
                    <p className="text-sm text-muted-foreground">
                        Manual incoming and outgoing money for activity outside the tracked modules. Payroll stays out of this page.
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <Button type="button" variant="outline" onClick={() => setLocation('/payments')} className="w-fit">
                            Payments
                        </Button>
                        <Button type="button" onClick={() => setIsDirectDialogOpen(true)} className="w-fit">
                            <Plus className="mr-2 h-4 w-4" />
                            New Direct Transaction
                        </Button>
                    </div>
                </div>
            </div>

            <Card>
                <CardContent className="pt-6">
                    <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_180px_auto]">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search direct transactions"
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
                        {(search.trim() || directionFilter !== 'all') ? (
                            <Button type="button" variant="ghost" onClick={() => {
                                setSearch('')
                                setDirectionFilter('all')
                            }} className="justify-self-start lg:justify-self-end">
                                <RotateCcw className="mr-2 h-4 w-4" />
                                Clear Filters
                            </Button>
                        ) : null}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                    <div className="space-y-1">
                        <CardTitle>Direct Transactions</CardTitle>
                        <p className="text-sm text-muted-foreground">
                            Posted direct transactions stay separate from tracked module settlements but still support reversals.
                        </p>
                    </div>
                    <div className="text-sm text-muted-foreground">
                        {visibleDirectTransactions.length} matching entries
                    </div>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Time</TableHead>
                                <TableHead>Reason</TableHead>
                                <TableHead>Counterparty</TableHead>
                                <TableHead>Linked</TableHead>
                                <TableHead>Direction</TableHead>
                                <TableHead>Amount</TableHead>
                                <TableHead>Method</TableHead>
                                <TableHead>Note</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {visibleDirectTransactions.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                                        No direct transactions match the current filters.
                                    </TableCell>
                                </TableRow>
                            ) : visibleDirectTransactions.map((item) => {
                                const isReversal = !!item.reversalOfTransactionId
                                const isReversed = reversedIds.has(item.id)
                                const isLatestUnreversed = latestUnreversedBySource.get(getPaymentSourceKey(item))?.id === item.id
                                const canReverse = !isReversal && !isReversed && isLatestUnreversed
                                const displayAmount = isReversal ? 0 : item.amount

                                return (
                                    <TableRow key={item.id}>
                                        <TableCell>{formatDateTime(item.paidAt)}</TableCell>
                                        <TableCell className="font-medium">{item.referenceLabel || 'Direct transaction'}</TableCell>
                                        <TableCell>{item.counterpartyName || '-'}</TableCell>
                                        <TableCell>
                                            {typeof item.metadata?.businessPartnerId === 'string' && item.metadata.businessPartnerId ? 'Business Partner' : 'External'}
                                        </TableCell>
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
                                        <TableCell className="max-w-[240px] truncate">{item.note || '-'}</TableCell>
                                        <TableCell>
                                            <span className={cn(
                                                'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                isReversal
                                                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                                                    : isReversed
                                                        ? 'border-slate-200 bg-slate-50 text-slate-700'
                                                        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                            )}>
                                                {isReversal ? 'Reversal' : isReversed ? 'Reversed' : 'Posted'}
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

            {workspaceId ? (
                <DirectTransactionDialog
                    open={isDirectDialogOpen}
                    onOpenChange={setIsDirectDialogOpen}
                    workspaceId={workspaceId}
                    isSubmitting={isSubmittingDirectTransaction}
                    onSubmit={handleCreateDirectTransaction}
                />
            ) : null}
        </div>
    )
}
