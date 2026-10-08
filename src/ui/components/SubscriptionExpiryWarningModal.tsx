import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, CalendarPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/components/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/ui/components/dialog'
import { useWorkspace } from '@/workspace'
import { useAuth } from '@/auth'
import { useSubscriptionExpiryWarning } from '@/hooks/useSubscriptionExpiryWarning'
import { getSubscriptionExpiryWarningSeenKey } from '@/lib/subscriptionExpiryWarning'
import { formatDate } from '@/lib/utils'
import {
    getWorkspaceBillingMode,
    getWorkspacePaymentExpiryDate,
    openWorkspaceExtraDaysDialog,
    openWorkspacePaymentDialog,
    openWorkspacePaymentStatusDialog
} from '@/lib/workspacePayments'

export function SubscriptionExpiryWarningModal() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { activeWorkspace, features, isDemoMode, isLoading, paymentSummary, isPaymentSummaryLoading, paygSummary } = useWorkspace()
    const billingMode = features.billing_mode ?? getWorkspaceBillingMode(paymentSummary, features.has_usage_limits, Boolean(paygSummary?.enabled))
    const billingDeadline = getWorkspacePaymentExpiryDate({
        renewalDueAt: features.renewal_due_at,
        summary: paymentSummary
    })
    const warning = useSubscriptionExpiryWarning(
        isDemoMode
            || (isPaymentSummaryLoading && !paymentSummary)
            ? null
            : billingDeadline
    )
    const [open, setOpen] = useState(false)
    const canRenewSubscription = user?.role === 'admin'
    const canAddExtraDays = Boolean(
        canRenewSubscription
        && paymentSummary?.configuration
        && billingMode === 'subscription'
    )
    const canOpenBillingAction = canRenewSubscription && (billingMode === 'subscription' || billingMode === 'usage' || billingMode === 'prepaidTerm')
    const hasPendingExtraDays = Boolean(paymentSummary?.pendingExtraDays)

    const seenKey = useMemo(() => {
        if (!activeWorkspace?.id || !warning) return null
        return getSubscriptionExpiryWarningSeenKey(activeWorkspace.id, warning.expiresAtIso, billingMode)
    }, [activeWorkspace?.id, billingMode, warning])

    const dismiss = useCallback(() => {
        if (seenKey) {
            try {
                window.localStorage.setItem(seenKey, new Date().toISOString())
            } catch (error) {
                console.warn('[SubscriptionExpiryWarning] Failed to save seen state:', error)
            }
        }
        setOpen(false)
    }, [seenKey])

    useEffect(() => {
        if (isLoading || !warning || !activeWorkspace?.id || !seenKey) {
            setOpen(false)
            return
        }

        try {
            if (window.localStorage.getItem(seenKey)) {
                setOpen(false)
                return
            }
        } catch (error) {
            console.warn('[SubscriptionExpiryWarning] Failed to read seen state:', error)
        }

        setOpen(true)
    }, [activeWorkspace?.id, isLoading, seenKey, warning])

    useEffect(() => {
        const handleOpen = () => {
            if (!warning || !activeWorkspace?.id) return
            setOpen(true)
        }

        window.addEventListener('open-subscription-expiry-warning', handleOpen)
        return () => window.removeEventListener('open-subscription-expiry-warning', handleOpen)
    }, [activeWorkspace?.id, warning])

    if (!warning) return null

    const daysRemaining = warning.daysRemaining
    const expiryDate = formatDate(warning.expiresAt)
    const openBillingAction = () => {
        dismiss()
        if (billingMode === 'prepaidTerm') {
            openWorkspacePaymentStatusDialog()
        } else {
            openWorkspacePaymentDialog()
        }
    }

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => {
            if (nextOpen) {
                setOpen(true)
            } else {
                dismiss()
            }
        }}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <div className="flex items-start gap-3">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                            <AlertTriangle className="h-6 w-6" />
                        </div>
                        <div className="min-w-0 space-y-2 text-start">
                            <DialogTitle>
                                {t(`subscriptionExpiryWarning.modes.${billingMode}.title`)}
                            </DialogTitle>
                            <DialogDescription className="leading-relaxed">
                                {t(`subscriptionExpiryWarning.modes.${billingMode}.description`, {
                                    count: daysRemaining
                                })}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-100">
                    <div className="flex items-center gap-2">
                        <CalendarClock className="h-4 w-4 shrink-0" />
                        <span className="font-medium">
                            {t(`subscriptionExpiryWarning.modes.${billingMode}.dateLabel`, {
                                date: expiryDate
                            })}
                        </span>
                    </div>
                </div>

                <DialogFooter className="gap-2 sm:items-end sm:space-x-0">
                    <Button allowViewer={true} variant="outline" onClick={dismiss}>
                        {t('subscriptionExpiryWarning.acknowledge', {
                            defaultValue: 'Got it'
                        })}
                    </Button>
                    {(canOpenBillingAction || canAddExtraDays) && (
                        <div className="flex flex-col gap-2">
                            {canOpenBillingAction && (
                                <Button allowViewer={true} onClick={openBillingAction}>
                                    {billingMode === 'prepaidTerm'
                                        ? t('workspacePayments.viewPaymentStatus')
                                        : t(billingMode === 'usage'
                                            ? 'workspacePayments.renewUsageCredit'
                                            : 'workspacePayments.renewSubscription')}
                                </Button>
                            )}
                            {canAddExtraDays && (
                                <Button
                                    allowViewer={true}
                                    variant="outline"
                                    disabled={hasPendingExtraDays}
                                    onClick={() => {
                                        dismiss()
                                        openWorkspaceExtraDaysDialog()
                                    }}
                                >
                                    <CalendarPlus className="h-4 w-4" />
                                    {t('workspacePayments.addExtraDays')}
                                </Button>
                            )}
                        </div>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
