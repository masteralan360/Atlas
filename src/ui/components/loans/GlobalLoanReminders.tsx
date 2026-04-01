import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { db } from '@/local-db/database'
import { fetchTableFromSupabase, updateLoanReminderSnooze, useLoans } from '@/local-db'
import { buildOverdueLoanReminderItems, type LoanReminderItem } from '@/lib/loanReminders'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { useWorkspace } from '@/workspace'
import { useToast } from '@/ui/components'
import { LoanOverdueReminderModal } from './LoanOverdueReminderModal'
import { useLoanPaymentModal } from './LoanPaymentModalProvider'
import { useUnifiedSnooze, type SnoozedItem } from '@/context/UnifiedSnoozeContext'

export function GlobalLoanReminders() {
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { t } = useTranslation()
    const { toast } = useToast()
    const { isPaymentModalOpen, openLoanPayment } = useLoanPaymentModal()
    const workspaceId = user?.workspaceId
    const isReadOnly = user?.role === 'viewer'
    const isOnline = useNetworkStatus()
    const loans = useLoans(workspaceId)
    const installments = useLiveQuery(
        () => workspaceId
            ? db.loan_installments.where('workspaceId').equals(workspaceId).and(item => !item.isDeleted).toArray()
            : [],
        [workspaceId]
    ) ?? []
    const [sessionHandledReminderLoanIds, setSessionHandledReminderLoanIds] = useState<string[]>([])
    const [currentReminderLoanId, setCurrentReminderLoanId] = useState<string | null>(null)
    const [isReminderActionLoading, setIsReminderActionLoading] = useState(false)
    const [isHydrating, setIsHydrating] = useState(true)

    const overdueReminderItems = useMemo(
        () => buildOverdueLoanReminderItems(loans, installments),
        [loans, installments]
    )
    const handledReminderLoanIdSet = useMemo(
        () => new Set(sessionHandledReminderLoanIds),
        [sessionHandledReminderLoanIds]
    )
    const snoozedReminderItems = useMemo(
        () => overdueReminderItems.filter(item => Boolean(item.snoozedAt)),
        [overdueReminderItems]
    )
    const activeReminderItems = useMemo(
        () => overdueReminderItems.filter(item =>
            !item.snoozedAt && !handledReminderLoanIdSet.has(item.loanId)
        ),
        [overdueReminderItems, handledReminderLoanIdSet]
    )
    const currentReminder = useMemo(
        () => currentReminderLoanId
            ? activeReminderItems.find(item => item.loanId === currentReminderLoanId) ?? null
            : null,
        [activeReminderItems, currentReminderLoanId]
    )
    const currentReminderIndex = currentReminder
        ? activeReminderItems.findIndex(item => item.loanId === currentReminder.loanId)
        : -1

    useEffect(() => {
        if (!isOnline || !workspaceId || isReadOnly) {
            setIsHydrating(false)
            return
        }

        let cancelled = false

        const hydrateLoanReminderData = async () => {
            try {
                await Promise.all([
                    fetchTableFromSupabase('loans', db.loans, workspaceId),
                    fetchTableFromSupabase('loan_installments', db.loan_installments, workspaceId)
                ])
            } catch (error) {
                if (!cancelled) {
                    console.error('[GlobalLoanReminders] Failed to hydrate reminder data:', error)
                }
            } finally {
                if (!cancelled) {
                    setIsHydrating(false)
                }
            }
        }

        void hydrateLoanReminderData()
        window.addEventListener('focus', hydrateLoanReminderData)

        return () => {
            cancelled = true
            window.removeEventListener('focus', hydrateLoanReminderData)
        }
    }, [isOnline, isReadOnly, workspaceId])

    useEffect(() => {
        const validLoanIds = new Set(overdueReminderItems.map(item => item.loanId))

        setSessionHandledReminderLoanIds(prev => {
            const next = prev.filter(loanId => validLoanIds.has(loanId))
            return next.length === prev.length ? prev : next
        })

        if (currentReminderLoanId && !validLoanIds.has(currentReminderLoanId)) {
            setCurrentReminderLoanId(null)
        }
    }, [currentReminderLoanId, overdueReminderItems])

    useEffect(() => {
        if (isReadOnly || isHydrating || isPaymentModalOpen || isReminderActionLoading) {
            return
        }

        if (activeReminderItems.length === 0) {
            if (currentReminderLoanId) {
                setCurrentReminderLoanId(null)
            }
            return
        }

        const stillValid = currentReminderLoanId
            ? activeReminderItems.some(item => item.loanId === currentReminderLoanId)
            : false

        if (!stillValid) {
            setCurrentReminderLoanId(activeReminderItems[0].loanId)
        }
    }, [
        activeReminderItems,
        currentReminderLoanId,
        isPaymentModalOpen,
        isReadOnly,
        isReminderActionLoading
    ])

    const markReminderHandledForSession = (loanId: string) => {
        setSessionHandledReminderLoanIds(prev =>
            prev.includes(loanId) ? prev : [...prev, loanId]
        )
    }

    const handleReminderSnooze = async (item: LoanReminderItem): Promise<boolean> => {
        setIsReminderActionLoading(true)
        try {
            await updateLoanReminderSnooze(item.loanId, {
                snoozedAt: new Date().toISOString(),
                snoozedForDueDate: item.dueDate
            })
            setCurrentReminderLoanId(null)
            toast({
                title: t('common.success') || 'Success',
                description: t('loans.messages.reminderSnoozed') || 'Loan reminder snoozed.'
            })
            return true
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || (t('loans.messages.reminderSnoozeFailed') || 'Failed to snooze reminder.'),
                variant: 'destructive'
            })
            return false
        } finally {
            setIsReminderActionLoading(false)
        }
    }

    const handleReminderUnsnooze = async (
        item: LoanReminderItem,
        options?: { silent?: boolean }
    ): Promise<boolean> => {
        setIsReminderActionLoading(true)
        try {
            await updateLoanReminderSnooze(item.loanId, {
                snoozedAt: null,
                snoozedForDueDate: null
            })
            setCurrentReminderLoanId(null)
            if (!options?.silent) {
                toast({
                    title: t('common.success') || 'Success',
                    description: t('loans.messages.reminderUnsnoozed') || 'Loan reminder un-snoozed.'
                })
            }
            return true
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || (t('loans.messages.reminderUnsnoozeFailed') || 'Failed to un-snooze reminder.'),
                variant: 'destructive'
            })
            return false
        } finally {
            setIsReminderActionLoading(false)
        }
    }

    const unifiedSnoozedItems = useMemo<SnoozedItem[]>(() => {
        return snoozedReminderItems.map(item => ({
            id: `loan-${item.loanId}`,
            type: 'loan',
            title: item.borrowerName,
            subtitle: item.loanNo,
            amount: item.overdueAmount,
            currency: item.settlementCurrency,
            priority: 'warning',
            onAction: () => {
                void (async () => {
                    const didUnsnooze = await handleReminderUnsnooze(item, { silent: true })
                    if (!didUnsnooze) {
                        return
                    }
                    markReminderHandledForSession(item.loanId)
                    openLoanPayment(item.loanId, {
                        installmentId: item.installmentId
                    })
                })()
            },
            onUnsnooze: () => {
                void handleReminderUnsnooze(item)
            }
        }))
    }, [snoozedReminderItems, handleReminderUnsnooze, openLoanPayment, markReminderHandledForSession])

    const { registerItems, unregisterItems } = useUnifiedSnooze()

    useEffect(() => {
        if (unifiedSnoozedItems.length > 0) {
            registerItems('loans', unifiedSnoozedItems)
        } else {
            unregisterItems('loans')
        }
    }, [unifiedSnoozedItems, registerItems, unregisterItems])

    if (!workspaceId || isReadOnly) {
        return null
    }

    return (
        <>

            <LoanOverdueReminderModal
                isOpen={!!currentReminder}
                item={currentReminder}
                queuePosition={currentReminderIndex >= 0 ? currentReminderIndex + 1 : 1}
                queueTotal={activeReminderItems.length}
                iqdPreference={features.iqd_display_preference}
                isLoading={isReminderActionLoading}
                onPayNow={() => {
                    if (!currentReminder) {
                        return
                    }
                    markReminderHandledForSession(currentReminder.loanId)
                    setCurrentReminderLoanId(null)
                    openLoanPayment(currentReminder.loanId, {
                        installmentId: currentReminder.installmentId
                    })
                }}
                onSnooze={() => {
                    if (!currentReminder) {
                        return
                    }
                    void handleReminderSnooze(currentReminder)
                }}
                onOpenChange={(open) => {
                    if (!open && currentReminder) {
                        markReminderHandledForSession(currentReminder.loanId)
                        setCurrentReminderLoanId(null)
                    }
                }}
            />
        </>
    )
}
