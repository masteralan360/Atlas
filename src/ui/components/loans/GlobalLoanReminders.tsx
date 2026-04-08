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

const LOAN_REMINDER_COOLDOWN_STORAGE_KEY = 'loan_reminder_popup_cooldowns'
const LOAN_REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000

interface LoanReminderCooldownEntry {
    dueDate: string
    cooldownUntil: string
}

type LoanReminderCooldownMap = Record<string, LoanReminderCooldownEntry>

function readLoanReminderCooldowns(): LoanReminderCooldownMap {
    if (typeof window === 'undefined') {
        return {}
    }

    try {
        const raw = window.localStorage.getItem(LOAN_REMINDER_COOLDOWN_STORAGE_KEY)
        if (!raw) {
            return {}
        }

        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {}
        }

        const next: LoanReminderCooldownMap = {}
        for (const [loanId, value] of Object.entries(parsed)) {
            if (
                typeof loanId === 'string' &&
                value &&
                typeof value === 'object' &&
                typeof value.dueDate === 'string' &&
                typeof value.cooldownUntil === 'string'
            ) {
                next[loanId] = {
                    dueDate: value.dueDate,
                    cooldownUntil: value.cooldownUntil
                }
            }
        }

        return next
    } catch {
        return {}
    }
}

function persistLoanReminderCooldowns(cooldowns: LoanReminderCooldownMap) {
    if (typeof window === 'undefined') {
        return
    }

    if (Object.keys(cooldowns).length === 0) {
        window.localStorage.removeItem(LOAN_REMINDER_COOLDOWN_STORAGE_KEY)
        return
    }

    window.localStorage.setItem(
        LOAN_REMINDER_COOLDOWN_STORAGE_KEY,
        JSON.stringify(cooldowns)
    )
}

function cleanupLoanReminderCooldowns(
    cooldowns: LoanReminderCooldownMap,
    items: LoanReminderItem[],
    now: number = Date.now()
): LoanReminderCooldownMap {
    const dueDateByLoanId = new Map(items.map(item => [item.loanId, item.dueDate] as const))
    let changed = false
    const next: LoanReminderCooldownMap = {}

    for (const [loanId, entry] of Object.entries(cooldowns)) {
        const activeDueDate = dueDateByLoanId.get(loanId)
        const cooldownEndsAt = Date.parse(entry.cooldownUntil)

        if (
            !activeDueDate ||
            entry.dueDate !== activeDueDate ||
            !Number.isFinite(cooldownEndsAt) ||
            cooldownEndsAt <= now
        ) {
            changed = true
            continue
        }

        next[loanId] = entry
    }

    return changed ? next : cooldowns
}

function isLoanReminderCoolingDown(
    item: LoanReminderItem,
    cooldowns: LoanReminderCooldownMap,
    now: number
): boolean {
    const entry = cooldowns[item.loanId]
    if (!entry || entry.dueDate !== item.dueDate) {
        return false
    }

    const cooldownEndsAt = Date.parse(entry.cooldownUntil)
    return Number.isFinite(cooldownEndsAt) && cooldownEndsAt > now
}

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
    const [reminderCooldowns, setReminderCooldowns] = useState<LoanReminderCooldownMap>(() => readLoanReminderCooldowns())
    const [currentReminderLoanId, setCurrentReminderLoanId] = useState<string | null>(null)
    const [isReminderActionLoading, setIsReminderActionLoading] = useState(false)
    const [isHydrating, setIsHydrating] = useState(true)

    const overdueReminderItems = useMemo(
        () => buildOverdueLoanReminderItems(loans, installments),
        [loans, installments]
    )
    const snoozedReminderItems = useMemo(
        () => overdueReminderItems.filter(item => Boolean(item.snoozedAt)),
        [overdueReminderItems]
    )
    const activeReminderItems = useMemo(
        () => overdueReminderItems.filter(item =>
            !item.snoozedAt && !isLoanReminderCoolingDown(item, reminderCooldowns, Date.now())
        ),
        [overdueReminderItems, reminderCooldowns]
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
        setReminderCooldowns(prev => cleanupLoanReminderCooldowns(prev, overdueReminderItems))

        const validLoanIds = new Set(overdueReminderItems.map(item => item.loanId))

        if (currentReminderLoanId && !validLoanIds.has(currentReminderLoanId)) {
            setCurrentReminderLoanId(null)
        }
    }, [currentReminderLoanId, overdueReminderItems])

    useEffect(() => {
        persistLoanReminderCooldowns(reminderCooldowns)
    }, [reminderCooldowns])

    useEffect(() => {
        const now = Date.now()
        let nextCooldownEndsAt = Number.POSITIVE_INFINITY

        for (const entry of Object.values(reminderCooldowns)) {
            const cooldownEndsAt = Date.parse(entry.cooldownUntil)
            if (Number.isFinite(cooldownEndsAt) && cooldownEndsAt > now && cooldownEndsAt < nextCooldownEndsAt) {
                nextCooldownEndsAt = cooldownEndsAt
            }
        }

        if (!Number.isFinite(nextCooldownEndsAt)) {
            return
        }

        const timeoutId = window.setTimeout(() => {
            setReminderCooldowns(prev => cleanupLoanReminderCooldowns(prev, overdueReminderItems))
        }, Math.max(0, nextCooldownEndsAt - now + 100))

        return () => window.clearTimeout(timeoutId)
    }, [overdueReminderItems, reminderCooldowns])

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

    const applyReminderCooldown = (item: LoanReminderItem) => {
        const nextEntry: LoanReminderCooldownEntry = {
            dueDate: item.dueDate,
            cooldownUntil: new Date(Date.now() + LOAN_REMINDER_COOLDOWN_MS).toISOString()
        }

        setReminderCooldowns(prev => {
            const currentEntry = prev[item.loanId]
            if (
                currentEntry?.dueDate === nextEntry.dueDate &&
                currentEntry.cooldownUntil === nextEntry.cooldownUntil
            ) {
                return prev
            }

            return {
                ...prev,
                [item.loanId]: nextEntry
            }
        })
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
                    applyReminderCooldown(item)
                    openLoanPayment(item.loanId, {
                        installmentId: item.installmentId
                    })
                })()
            },
            onUnsnooze: () => {
                void handleReminderUnsnooze(item)
            }
        }))
    }, [snoozedReminderItems, handleReminderUnsnooze, openLoanPayment])

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
                    applyReminderCooldown(currentReminder)
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
                        applyReminderCooldown(currentReminder)
                        setCurrentReminderLoanId(null)
                    }
                }}
            />
        </>
    )
}
