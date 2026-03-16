import { useState } from 'react'
import { Bell, BellOff, CalendarClock, RotateCcw, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { IQDDisplayPreference } from '@/local-db/models'
import { Button } from '@/ui/components'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/ui/components/dialog'
import { formatCurrency, formatDate, formatDateTime, cn } from '@/lib/utils'
import type { BudgetReminderItem } from './types'

function getTypeLabel(t: any, type: BudgetReminderItem['type']) {
    if (type === 'payroll') return t('budget.reminder.category.salary') || 'Salary'
    if (type === 'dividend') return t('budget.reminder.category.dividend') || 'Dividend'
    return t('budget.reminder.category.expense') || 'Expense'
}

interface SnoozedBudgetRemindersBellProps {
    items: BudgetReminderItem[]
    iqdPreference: IQDDisplayPreference
    variant?: 'warning' | 'info'
    title?: string
    description?: string
    isProcessing?: boolean
    onMarkPaid: (item: BudgetReminderItem) => void
    onUnsnooze: (item: BudgetReminderItem) => void
}

export function SnoozedBudgetRemindersBell({
    items,
    iqdPreference,
    variant = 'warning',
    title,
    description,
    isProcessing = false,
    onMarkPaid,
    onUnsnooze
}: SnoozedBudgetRemindersBellProps) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)

    if (items.length === 0) {
        return null
    }

    const tone = variant === 'info' ? 'blue' : 'yellow'

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className={cn(
                    'relative h-8 w-8',
                    tone === 'blue' ? 'hover:bg-blue-500/10' : 'hover:bg-yellow-500/10'
                )}>
                    <Bell className={cn(
                        'h-4 w-4 animate-pulse',
                        tone === 'blue' ? 'fill-blue-500 text-blue-500' : 'fill-yellow-500 text-yellow-500'
                    )} />
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white ring-1 ring-background">
                        {items.length}
                    </span>
                </Button>
            </DialogTrigger>

            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className={cn(
                        'flex items-center gap-2',
                        tone === 'blue' ? 'text-blue-600 dark:text-blue-400' : 'text-yellow-600 dark:text-yellow-500'
                    )}>
                        <BellOff className="h-5 w-5" />
                        {title || t('budget.snoozedItems') || 'Snoozed Reminders'} ({items.length})
                    </DialogTitle>
                    <p className="text-sm text-muted-foreground">
                        {description || t('budget.snoozedItemsDesc') || 'These items are currently snoozed. Un-snooze to be reminded again.'}
                    </p>
                </DialogHeader>

                <div className="mt-2 max-h-[60vh] space-y-3 overflow-y-auto pr-2">
                    {items.map(item => (
                        <div
                            key={item.id}
                            className={cn(
                                'rounded-2xl border p-4',
                                tone === 'blue' ? 'bg-blue-500/5 border-blue-500/20' : 'bg-yellow-500/5 border-yellow-500/20'
                            )}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <div className="font-bold">{item.title}</div>
                                    {item.subtitle && (
                                        <div className="text-sm text-muted-foreground">{item.subtitle}</div>
                                    )}
                                </div>
                                <div className="text-right">
                                    <div className="text-base font-bold">
                                        {formatCurrency(item.amount, item.currency, iqdPreference)}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {t('common.amount') || 'Amount'}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
                                <div className="flex items-center gap-2">
                                    <CalendarClock className="h-4 w-4" />
                                    <span>
                                        {t('budget.reminder.overdue') || 'Overdue'}: {formatDate(item.dueDate)}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Wallet className="h-4 w-4" />
                                    <span>
                                        {getTypeLabel(t, item.type)}
                                    </span>
                                </div>
                                {item.snoozedIndefinite && (
                                    <div className="text-xs">
                                        {t('budget.snoozedIndefinitely') || 'Snoozed Until Un-snoozed'}
                                    </div>
                                )}
                                {!item.snoozedIndefinite && item.snoozedUntil && (
                                    <div className="text-xs">
                                        {t('budget.snoozedUntil') || 'Snoozed until'}: {formatDateTime(item.snoozedUntil)}
                                    </div>
                                )}
                            </div>

                            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                                <Button
                                    className="flex-1"
                                    onClick={() => {
                                        setOpen(false)
                                        onMarkPaid(item)
                                    }}
                                    disabled={isProcessing}
                                >
                                    {t('budget.reminder.yesPaid') || 'Yes, I Paid'}
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
                                    {t('budget.unsnooze') || 'Un-snooze'}
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    )
}
