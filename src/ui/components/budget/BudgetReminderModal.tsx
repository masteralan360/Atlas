import { CalendarClock, Wallet, Receipt, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import type { IQDDisplayPreference } from '@/local-db/models'
import type { BudgetReminderItem } from './types'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Button } from '@/ui/components'

interface BudgetReminderModalProps {
    isOpen: boolean
    item: BudgetReminderItem | null
    queuePosition?: number
    queueTotal?: number
    iqdPreference: IQDDisplayPreference
    onPaid: () => void
    onRemindTomorrow: () => void
    onSnooze: () => void
    onOpenChange: (open: boolean) => void
}

function getDueLabel(t: any, dueDate: string) {
    const today = new Date()
    const todayKey = today.toISOString().slice(0, 10)
    if (dueDate < todayKey) return t('budget.reminder.overdue') || 'Overdue'
    if (dueDate === todayKey) return t('budget.reminder.dueToday') || 'Due Today'
    const due = new Date(dueDate)
    const diffDays = Math.ceil((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
    if (diffDays === 1) return t('budget.reminder.dueTomorrow') || 'Due Tomorrow'
    return t('budget.reminder.dueIn', { days: diffDays }) || `In ${diffDays} days`
}

function getTypeLabel(t: any, type: BudgetReminderItem['type']) {
    if (type === 'payroll') return t('budget.reminder.category.salary') || 'Salary'
    if (type === 'dividend') return t('budget.reminder.category.dividend') || 'Dividend'
    return t('budget.reminder.category.expense') || 'Expense'
}

export function BudgetReminderModal({
    isOpen,
    item,
    queuePosition,
    queueTotal,
    iqdPreference,
    onPaid,
    onRemindTomorrow,
    onSnooze,
    onOpenChange
}: BudgetReminderModalProps) {
    const { t } = useTranslation()

    if (!item) {
        return null
    }

    const Icon = item.type === 'dividend' ? Wallet : item.type === 'payroll' ? Users : Receipt
    const dueLabel = getDueLabel(t, item.dueDate)

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader className="space-y-3">
                    <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                            <Icon className="h-6 w-6" />
                        </div>
                        <div className="space-y-1">
                            <DialogTitle>{t('budget.reminder.didYouPay') || 'Did you pay?'}</DialogTitle>
                            <DialogDescription>
                                {getTypeLabel(t, item.type)} · {dueLabel}
                            </DialogDescription>
                        </div>
                    </div>
                    {queueTotal && queueTotal > 1 && (
                        <div className="text-xs font-medium text-muted-foreground">
                            {t('budget.reminder.queueProgress', {
                                current: queuePosition || 1,
                                total: queueTotal
                            }) || `${queuePosition || 1} of ${queueTotal}`}
                        </div>
                    )}
                </DialogHeader>

                <div className="rounded-2xl border bg-muted/20 p-4">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <div className="text-lg font-bold">{item.title}</div>
                            {item.subtitle && (
                                <div className="text-sm text-muted-foreground">{item.subtitle}</div>
                            )}
                        </div>
                        <div className={cn(
                            'rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide',
                            dueLabel === (t('budget.reminder.overdue') || 'Overdue') ? 'bg-destructive/10 text-destructive'
                                : 'bg-amber-500/10 text-amber-600'
                        )}>
                            {dueLabel}
                        </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border bg-background/80 p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                <Wallet className="h-4 w-4" />
                                {t('common.amount') || 'Amount'}
                            </div>
                            <div className="mt-1 text-lg font-bold">
                                {formatCurrency(item.amount, item.currency, iqdPreference)}
                            </div>
                            {item.snoozeCount && item.snoozeCount > 0 && (
                                <div className="mt-1 text-xs text-muted-foreground">
                                    {t('budget.reminder.snoozedTimes', { count: item.snoozeCount }) || `Snoozed ${item.snoozeCount} time(s)`}
                                </div>
                            )}
                        </div>

                        <div className="rounded-xl border bg-background/80 p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                <CalendarClock className="h-4 w-4" />
                                {t('common.date') || 'Date'}
                            </div>
                            <div className="mt-1 text-lg font-bold">{formatDate(item.dueDate)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {getTypeLabel(t, item.type)}
                            </div>
                        </div>
                    </div>
                </div>

                <DialogFooter className="grid gap-2 sm:grid-cols-3">
                    <Button variant="outline" onClick={onSnooze}>
                        {t('budget.reminder.snoozeNow') || 'Snooze for now'}
                    </Button>
                    <Button variant="outline" onClick={onRemindTomorrow}>
                        {t('budget.reminder.noSnooze') || 'No (Remind me tomorrow)'}
                    </Button>
                    <Button onClick={onPaid}>
                        {t('budget.reminder.yesPaid') || 'Yes, I Paid'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
