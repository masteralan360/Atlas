import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Button } from '@/ui/components'

export interface BudgetSnoozeOption {
    id: string
    label: string
    minutes?: number
    indefinite?: boolean
}

interface BudgetSnoozeModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSelect: (option: BudgetSnoozeOption) => void
}

export function BudgetSnoozeModal({ open, onOpenChange, onSelect }: BudgetSnoozeModalProps) {
    const { t } = useTranslation()

    const options = useMemo<BudgetSnoozeOption[]>(() => [
        { id: '30m', label: t('budget.reminder.snooze.30m') || '30 minutes', minutes: 30 },
        { id: '12h', label: t('budget.reminder.snooze.12h') || '12 hours', minutes: 12 * 60 },
        { id: '24h', label: t('budget.reminder.snooze.24h') || '24 hours', minutes: 24 * 60 },
        { id: '2d', label: t('budget.reminder.snooze.2d') || '2 days', minutes: 2 * 24 * 60 },
        { id: '4d', label: t('budget.reminder.snooze.4d') || '4 days', minutes: 4 * 24 * 60 },
        { id: 'none', label: t('budget.reminder.snooze.none') || 'No reminder', indefinite: true }
    ], [t])

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('budget.reminder.snoozeTitle') || 'Snooze Reminder'}</DialogTitle>
                    <DialogDescription>{t('budget.reminder.snoozeDesc') || 'When should we remind you about this again?'}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-2">
                    {options.map(option => (
                        <Button
                            key={option.id}
                            variant={option.indefinite ? 'outline' : 'default'}
                            onClick={() => onSelect(option)}
                            className="justify-start"
                        >
                            {option.label}
                        </Button>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    )
}
