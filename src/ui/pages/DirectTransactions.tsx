import { useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Plus, RotateCcw, Search } from 'lucide-react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'

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

function paymentMethodLabel(value: PaymentTransaction['paymentMethod'], t: any) {
    switch (value) {
        case 'bank_transfer':
            return t('directTransactions.paymentMethod.bankTransfer', { defaultValue: 'Bank Transfer' })
        case 'loan_adjustment':
            return t('directTransactions.paymentMethod.loanAdjustment', { defaultValue: 'Loan Adjustment' })
        case 'qicard':
            return t('directTransactions.paymentMethod.qicard', { defaultValue: 'QiCard' })
        case 'zaincash':
            return t('directTransactions.paymentMethod.zaincash', { defaultValue: 'ZainCash' })
        case 'fastpay':
            return t('directTransactions.paymentMethod.fastpay', { defaultValue: 'FastPay' })
        case 'fib':
            return t('directTransactions.paymentMethod.fib', { defaultValue: 'FIB' })
        case 'cash':
            return t('directTransactions.paymentMethod.cash', { defaultValue: 'Cash' })
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
    const { t } = useTranslation()
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
            toast({ title: t('directTransactions.recorded', { defaultValue: 'Direct transaction recorded' }) })
            setIsDirectDialogOpen(false)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('directTransactions.recordFailed', { defaultValue: 'Failed to record direct transaction.' }),
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
            toast({ title: t('directTransactions.reversed', { defaultValue: 'Transaction reversed' }) })
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('directTransactions.reverseFailed', { defaultValue: 'Failed to reverse transaction.' }),
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
                        <CardTitle>{t('directTransactions.notAvailable', { defaultValue: 'Direct Transactions is not available in this workspace' })}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        {t('directTransactions.enableModules', { defaultValue: 'Enable Loans, CRM, Accounting, or HR to use the central payments surface.' })}
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-3">
                    <h1 className="text-3xl font-bold tracking-tight">{t('directTransactions.title', { defaultValue: 'Direct Transactions' })}</h1>
                    <p className="text-sm text-muted-foreground">
                        {t('directTransactions.subtitle', { defaultValue: 'Manual incoming and outgoing money for activity outside the tracked modules. Payroll stays out of this page.' })}
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <Button type="button" variant="outline" onClick={() => setLocation('/payments')} className="w-fit">
                            {t('payments.title', { defaultValue: 'Payments' })}
                        </Button>
                        <Button type="button" onClick={() => setIsDirectDialogOpen(true)} className="w-fit">
                            <Plus className="mr-2 h-4 w-4" />
                            {t('directTransactions.newTransaction', { defaultValue: 'New Direct Transaction' })}
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
                                placeholder={t('directTransactions.searchPlaceholder', { defaultValue: 'Search direct transactions' })}
                                className="pl-9"
                            />
                        </div>
                        <Select value={directionFilter} onValueChange={(value: DirectionFilter) => setDirectionFilter(value)}>
                            <SelectTrigger>
                                <SelectValue placeholder={t('directTransactions.filters.direction', { defaultValue: 'Direction' })} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">{t('directTransactions.filters.allDirections', { defaultValue: 'All Directions' })}</SelectItem>
                                <SelectItem value="incoming">{t('directTransactions.filters.incoming', { defaultValue: 'Incoming' })}</SelectItem>
                                <SelectItem value="outgoing">{t('directTransactions.filters.outgoing', { defaultValue: 'Outgoing' })}</SelectItem>
                            </SelectContent>
                        </Select>
                        {(search.trim() || directionFilter !== 'all') ? (
                            <Button type="button" variant="ghost" onClick={() => {
                                setSearch('')
                                setDirectionFilter('all')
                            }} className="justify-self-start lg:justify-self-end">
                                <RotateCcw className="mr-2 h-4 w-4" />
                                {t('directTransactions.clearFilters', { defaultValue: 'Clear Filters' })}
                            </Button>
                        ) : null}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                    <div className="space-y-1">
                        <CardTitle>{t('directTransactions.title', { defaultValue: 'Direct Transactions' })}</CardTitle>
                        <p className="text-sm text-muted-foreground">
                            {t('directTransactions.tableSubtitle', { defaultValue: 'Posted direct transactions stay separate from tracked module settlements but still support reversals.' })}
                        </p>
                    </div>
                    <div className="text-sm text-muted-foreground">
                        {t('directTransactions.matchingEntries', { count: visibleDirectTransactions.length, defaultValue: '{{count}} matching entries' })}
                    </div>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('directTransactions.table.time', { defaultValue: 'Time' })}</TableHead>
                                <TableHead>{t('directTransactions.table.reason', { defaultValue: 'Reason' })}</TableHead>
                                <TableHead>{t('directTransactions.table.counterparty', { defaultValue: 'Counterparty' })}</TableHead>
                                <TableHead>{t('directTransactions.table.linked', { defaultValue: 'Linked' })}</TableHead>
                                <TableHead>{t('directTransactions.table.direction', { defaultValue: 'Direction' })}</TableHead>
                                <TableHead>{t('directTransactions.table.amount', { defaultValue: 'Amount' })}</TableHead>
                                <TableHead>{t('directTransactions.table.method', { defaultValue: 'Method' })}</TableHead>
                                <TableHead>{t('directTransactions.table.note', { defaultValue: 'Note' })}</TableHead>
                                <TableHead>{t('directTransactions.table.status', { defaultValue: 'Status' })}</TableHead>
                                <TableHead className="text-right">{t('directTransactions.table.actions', { defaultValue: 'Actions' })}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {visibleDirectTransactions.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                                        {t('directTransactions.noMatch', { defaultValue: 'No direct transactions match the current filters.' })}
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
                                        <TableCell className="font-medium">{item.referenceLabel || t('directTransactions.defaultReason', { defaultValue: 'Direct transaction' })}</TableCell>
                                        <TableCell>{item.counterpartyName || '-'}</TableCell>
                                        <TableCell>
                                            {typeof item.metadata?.businessPartnerId === 'string' && item.metadata.businessPartnerId 
                                                ? t('directTransactions.businessPartnerLink', { defaultValue: 'Business Partner' }) 
                                                : t('directTransactions.external', { defaultValue: 'External' })}
                                        </TableCell>
                                        <TableCell>
                                            <span className={cn(
                                                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                item.direction === 'incoming'
                                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                    : 'border-amber-200 bg-amber-50 text-amber-700'
                                            )}>
                                                {item.direction === 'incoming' ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                                                {item.direction === 'incoming' 
                                                    ? t('directTransactions.filters.incoming', { defaultValue: 'Incoming' })
                                                    : t('directTransactions.filters.outgoing', { defaultValue: 'Outgoing' })}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            {displayAmount < 0 ? '-' : ''}
                                            {formatCurrency(Math.abs(displayAmount), item.currency, features.iqd_display_preference)}
                                        </TableCell>
                                        <TableCell>{paymentMethodLabel(item.paymentMethod, t)}</TableCell>
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
                                                {isReversal 
                                                    ? t('directTransactions.status.reversal', { defaultValue: 'Reversal' }) 
                                                    : isReversed 
                                                        ? t('directTransactions.status.reversed', { defaultValue: 'Reversed' }) 
                                                        : t('directTransactions.status.posted', { defaultValue: 'Posted' })}
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
