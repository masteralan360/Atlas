import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import { Building2, Search } from 'lucide-react'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import {
    type RealEstateInstallment,
    type RealEstateTransaction,
    useRealEstateTransactions,
    useRealEstateWorkspaceInstallments
} from '@/local-db'
import { Input } from '@/ui/components/input'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { RecordRealEstatePaymentModal } from './RecordRealEstatePaymentModal'

function statusClass(status: string) {
    if (status === 'paid') {
        return 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
    }
    if (status === 'overdue') {
        return 'bg-red-500/15 text-red-700 dark:text-red-300'
    }
    if (status === 'partial') {
        return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
    }
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
}

export function RealEstateInstallmentsMirror({ workspaceId }: { workspaceId: string }) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const { user } = useAuth()
    const { dateRange, customDates } = useDateRange()
    const installments = useRealEstateWorkspaceInstallments(workspaceId)
    const transactions = useRealEstateTransactions(workspaceId)
    const [search, setSearch] = useState('')
    const [paymentTarget, setPaymentTarget] = useState<{
        transaction: RealEstateTransaction
        installment: RealEstateInstallment
    } | null>(null)

    const transactionById = useMemo(
        () => new Map(transactions.map((transaction) => [transaction.id, transaction])),
        [transactions]
    )

    const rows = useMemo(() => {
        const query = search.trim().toLowerCase()
        return installments
            .filter((installment) => isDateInDateRange(installment.dueDate, dateRange, customDates))
            .map((installment) => ({
                installment,
                transaction: transactionById.get(installment.transactionId)
            }))
            .filter((row): row is { installment: RealEstateInstallment; transaction: RealEstateTransaction } => !!row.transaction)
            .filter(({ installment, transaction }) => {
                if (!query) {
                    return true
                }

                return [
                    transaction.transactionNo,
                    transaction.location,
                    transaction.buyerName,
                    transaction.sellerName,
                    installment.status
                ].some((value) => value.toLowerCase().includes(query))
            })
    }, [customDates, dateRange, installments, search, transactionById])

    const openRows = rows.filter(({ installment }) => installment.balanceAmount > 0)
    const overdueRows = openRows.filter(({ installment }) => installment.status === 'overdue')

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <MetricCard title={t('realEstate.installments', { defaultValue: 'Real Estate Installments' })} value={String(rows.length)} />
                <MetricCard title={t('payments.kpis.open', { defaultValue: 'Open' })} value={String(openRows.length)} />
                <MetricCard title={t('payments.kpis.overdue', { defaultValue: 'Overdue' })} value={String(overdueRows.length)} />
            </div>

            <Card>
                <CardHeader className="gap-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <Building2 className="h-5 w-5" />
                            {t('realEstate.installmentMirrorTitle', { defaultValue: 'Real Estate Installments' })}
                        </CardTitle>
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-end">
                            <DateRangeFilters />
                            <div className="relative w-full lg:w-80">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder={t('realEstate.searchInstallments', { defaultValue: 'Search property installments...' })}
                                    className="pl-9"
                                />
                            </div>
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="rounded-md border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('realEstate.table.transaction', { defaultValue: 'Transaction' })}</TableHead>
                                    <TableHead>{t('realEstate.location', { defaultValue: 'Location' })}</TableHead>
                                    <TableHead>{t('loans.dueDate', { defaultValue: 'Due Date' })}</TableHead>
                                    <TableHead className="text-end">{t('loans.installmentPlannedAmount', { defaultValue: 'Planned' })}</TableHead>
                                    <TableHead className="text-end">{t('loans.balance', { defaultValue: 'Balance' })}</TableHead>
                                    <TableHead>{t('loans.status', { defaultValue: 'Status' })}</TableHead>
                                    <TableHead className="text-end">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                                            {t('realEstate.noInstallmentRows', { defaultValue: 'No real estate installment rows are available.' })}
                                        </TableCell>
                                    </TableRow>
                                ) : rows.map(({ installment, transaction }) => (
                                    <TableRow key={installment.id}>
                                        <TableCell>
                                            <Link href={`/real-estate/${transaction.id}`} className="font-semibold hover:underline">
                                                {transaction.transactionNo}
                                            </Link>
                                            <div className="text-xs text-muted-foreground">#{String(installment.installmentNo).padStart(2, '0')}</div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="max-w-[16rem] truncate">{transaction.location}</div>
                                            <div className="text-xs text-muted-foreground">{transaction.buyerName}</div>
                                        </TableCell>
                                        <TableCell>{formatDate(installment.dueDate)}</TableCell>
                                        <TableCell className="text-end">{formatCurrency(installment.plannedAmount, transaction.currency, features.iqd_display_preference)}</TableCell>
                                        <TableCell className="text-end font-semibold">{formatCurrency(installment.balanceAmount, transaction.currency, features.iqd_display_preference)}</TableCell>
                                        <TableCell>
                                            <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', statusClass(installment.status))}>
                                                {t(`loans.installmentStatuses.${installment.status}`, { defaultValue: installment.status })}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-end">
                                            {installment.balanceAmount > 0 && user?.role !== 'viewer' ? (
                                                <Button variant="ghost" size="sm" onClick={() => setPaymentTarget({ transaction, installment })}>
                                                    {t('loans.pay', { defaultValue: 'Pay' })}
                                                </Button>
                                            ) : null}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>

            <RecordRealEstatePaymentModal
                isOpen={paymentTarget !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setPaymentTarget(null)
                    }
                }}
                transaction={paymentTarget?.transaction ?? null}
                installment={paymentTarget?.installment ?? null}
            />
        </div>
    )
}

function MetricCard({ title, value }: { title: string; value: string }) {
    return (
        <Card>
            <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">{title}</div>
                <div className="mt-1 text-2xl font-bold">{value}</div>
            </CardContent>
        </Card>
    )
}
