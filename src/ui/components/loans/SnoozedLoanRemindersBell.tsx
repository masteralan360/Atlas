import { useState } from 'react'
import { Bell, BellOff, CalendarClock, RotateCcw, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LoanReminderItem } from '@/lib/loanReminders'
import type { IQDDisplayPreference } from '@/local-db'
import { Button } from '@/ui/components'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/ui/components/dialog'
import { formatCurrency, formatDate, formatDateTime, cn } from '@/lib/utils'
import { LoanNoDisplay } from './LoanNoDisplay'

interface SnoozedLoanRemindersBellProps {
    items: LoanReminderItem[]
    iqdPreference: IQDDisplayPreference
    isProcessing?: boolean
    onPayNow: (item: LoanReminderItem) => void
    onUnsnooze: (item: LoanReminderItem) => void
}

export function SnoozedLoanRemindersBell({
    items,
    iqdPreference,
    isProcessing = false,
    onPayNow,
    onUnsnooze
}: SnoozedLoanRemindersBellProps) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)

    if (items.length === 0) {
        return null
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="relative h-10 w-10 hover:bg-yellow-500/10">
                    <Bell className="h-5 w-5 fill-yellow-500 text-yellow-500 animate-pulse" />
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white ring-2 ring-background">
                        {items.length}
                    </span>
                </Button>
            </DialogTrigger>

            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-yellow-600 dark:text-yellow-500">
                        <BellOff className="h-5 w-5" />
                        {t('loans.snoozedItems') || 'Snoozed Loan Reminders'} ({items.length})
                    </DialogTitle>
                    <p className="text-sm text-muted-foreground">
                        {t('loans.snoozedItemsDesc') || 'These overdue loan reminders are snoozed until you open them again.'}
                    </p>
                </DialogHeader>

                <div className="mt-2 max-h-[60vh] space-y-3 overflow-y-auto pr-2">
                    {items.map(item => (
                        <div
                            key={item.loanId}
                            className={cn(
                                'rounded-2xl border p-4',
                                'bg-yellow-500/5 border-yellow-500/20'
                            )}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <div className="font-bold">{item.borrowerName}</div>
                                    <LoanNoDisplay loanNo={item.loanNo} className="text-sm text-muted-foreground" />
                                </div>
                                <div className="text-right">
                                    <div className="text-base font-bold">
                                        {formatCurrency(item.overdueAmount, item.settlementCurrency, iqdPreference)}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {t('loans.reminder.overdueAmount') || 'Overdue Amount'}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
                                <div className="flex items-center gap-2">
                                    <CalendarClock className="h-4 w-4" />
                                    <span>
                                        {t('loans.reminder.oldestDueDate') || 'Oldest Due Date'}: {formatDate(item.dueDate)}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Wallet className="h-4 w-4" />
                                    <span>
                                        {t('loans.reminder.totalBalance') || 'Total balance'}: {formatCurrency(item.balanceAmount, item.settlementCurrency, iqdPreference)}
                                    </span>
                                </div>
                                {item.snoozedAt && (
                                    <div className="text-xs">
                                        {t('loans.snoozedAt') || 'Snoozed at'}: {formatDateTime(item.snoozedAt)}
                                    </div>
                                )}
                            </div>

                            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                                <Button
                                    className="flex-1"
                                    onClick={() => {
                                        setOpen(false)
                                        onPayNow(item)
                                    }}
                                    disabled={isProcessing}
                                >
                                    {t('loans.reminder.payNow') || 'Yes, Open Payment'}
                                </Button>
                                <Button
                                    variant="outline"
                                    className="flex-1"
                                    onClick={() => {
                                        setOpen(false)
                                        onUnsnooze(item)
                                    }}
                                    disabled={isProcessing}
                                >
                                    <RotateCcw className="mr-2 h-4 w-4" />
                                    {t('loans.unsnooze') || 'Un-snooze'}
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    )
}
