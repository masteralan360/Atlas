import { AlertTriangle, CalendarClock, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import type { LoanReminderItem } from '@/lib/loanReminders'
import type { IQDDisplayPreference } from '@/local-db'
import { LoanNoDisplay } from './LoanNoDisplay'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Button
} from '@/ui/components'

interface LoanOverdueReminderModalProps {
    isOpen: boolean
    item: LoanReminderItem | null
    queuePosition?: number
    queueTotal?: number
    iqdPreference: IQDDisplayPreference
    isLoading?: boolean
    onPayNow: () => void
    onSnooze: () => void
    onOpenChange: (open: boolean) => void
}

export function LoanOverdueReminderModal({
    isOpen,
    item,
    queuePosition,
    queueTotal,
    iqdPreference,
    isLoading = false,
    onPayNow,
    onSnooze,
    onOpenChange
}: LoanOverdueReminderModalProps) {
    const { t } = useTranslation()

    if (!item) {
        return null
    }

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader className="space-y-3">
                    <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                            <AlertTriangle className="h-6 w-6" />
                        </div>
                        <div className="space-y-1">
                            <DialogTitle>{t('loans.reminder.title') || 'Overdue Loan Payment'}</DialogTitle>
                            <DialogDescription>
                                {t('loans.reminder.description') || 'This loan has an overdue payment. Do you want to record a payment now?'}
                            </DialogDescription>
                        </div>
                    </div>
                    {queueTotal && queueTotal > 1 && (
                        <div className="text-xs font-medium text-muted-foreground">
                            {t('loans.reminder.queueProgress', {
                                current: queuePosition || 1,
                                total: queueTotal
                            }) || `${queuePosition || 1} of ${queueTotal}`}
                        </div>
                    )}
                </DialogHeader>

                <div className="rounded-2xl border bg-muted/20 p-4">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <div className="text-lg font-bold">{item.borrowerName}</div>
                            <LoanNoDisplay loanNo={item.loanNo} className="text-sm text-muted-foreground" />
                        </div>
                        <div className={cn(
                            'rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide',
                            'bg-destructive/10 text-destructive'
                        )}>
                            {t('loans.statuses.overdue') || 'Overdue'}
                        </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border bg-background/80 p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                <Wallet className="h-4 w-4" />
                                {t('loans.reminder.overdueAmount') || 'Overdue Amount'}
                            </div>
                            <div className="mt-1 text-lg font-bold">
                                {formatCurrency(item.overdueAmount, item.settlementCurrency, iqdPreference)}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {t('loans.reminder.totalBalance') || 'Total balance'}: {formatCurrency(item.balanceAmount, item.settlementCurrency, iqdPreference)}
                            </div>
                        </div>

                        <div className="rounded-xl border bg-background/80 p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                <CalendarClock className="h-4 w-4" />
                                {t('loans.reminder.oldestDueDate') || 'Oldest Due Date'}
                            </div>
                            <div className="mt-1 text-lg font-bold">{formatDate(item.dueDate)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {t('loans.reminder.overdueInstallments', {
                                    count: item.overdueInstallmentCount
                                }) || `${item.overdueInstallmentCount} overdue installment(s)`}
                            </div>
                        </div>
                    </div>
                </div>

                <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
                    <Button variant="outline" onClick={onSnooze} disabled={isLoading}>
                        {t('loans.reminder.snooze') || 'Snooze'}
                    </Button>
                    <Button onClick={onPayNow} disabled={isLoading}>
                        {t('loans.reminder.payNow') || 'Yes, Open Payment'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
