import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Button } from '@/ui/components'

interface BudgetLockPromptModalProps {
    open: boolean
    onConfirm: () => void
    onSkip: () => void
}

export function BudgetLockPromptModal({ open, onConfirm, onSkip }: BudgetLockPromptModalProps) {
    const { t } = useTranslation()

    return (
        <Dialog open={open} onOpenChange={(value) => { if (!value) onSkip() }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('budget.reminder.lockTitle') || 'Lock this payment?'}</DialogTitle>
                    <DialogDescription>{t('budget.reminder.lockDesc') || 'Locking prevents accidental edits. This action cannot be undone.'}</DialogDescription>
                </DialogHeader>
                <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
                    <Button variant="outline" onClick={onSkip}>{t('budget.reminder.lockSkip') || 'Skip'}</Button>
                    <Button onClick={onConfirm}>{t('budget.reminder.lockConfirm') || 'Lock'}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
