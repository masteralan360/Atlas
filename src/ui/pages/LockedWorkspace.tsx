import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CalendarPlus, Clock, CreditCard, Copy, Gauge, HardDrive, Lock, LogOut, Mail, Phone } from 'lucide-react'
import { Button } from '@/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/components/dialog'
import { useAuth } from '@/auth'
import { useLocation } from 'wouter'
import { useWorkspace } from '@/workspace'
import { WorkspacePaygLimitDialog } from '@/ui/components/WorkspacePaygLimitDialog'
import {
    OPEN_WORKSPACE_PAYMENT_DIALOG_EVENT,
    OPEN_WORKSPACE_PAYMENT_STATUS_DIALOG_EVENT,
    getWorkspaceBillingMode,
    getWorkspacePaymentAlertKind,
    isWorkspacePaymentAccessExpired,
    openWorkspaceExtraDaysDialog,
    openWorkspacePaymentDialog,
    openWorkspacePaymentStatusDialog,
} from '@/lib/workspacePayments'

const ADMIN_PHONE_NUMBER = '0770 199 0012'
const ADMIN_PHONE_HREF = 'tel:07701990012'
const RENEWAL_AUTO_OPEN_COUNTDOWN_SECONDS = 10

export function LockedWorkspace() {
    const { t, i18n } = useTranslation()
    const { signOut, user } = useAuth()
    const {
        activeWorkspace,
        features,
        isLocked,
        isLoading,
        paymentSummary,
        isPaymentSummaryLoading,
        paygSummary,
        refreshPaygSummary
    } = useWorkspace()
    const [, setLocation] = useLocation()
    const [contactAdminOpen, setContactAdminOpen] = useState(false)
    const [paygLimitDialogOpen, setPaygLimitDialogOpen] = useState(false)
    const [copied, setCopied] = useState(false)
    const [renewalCountdownSeconds, setRenewalCountdownSeconds] = useState<number | null>(null)
    const renewalCountdownIntervalRef = useRef<number | null>(null)
    const handledRenewalPromptKeysRef = useRef(new Set<string>())

    const isExpired = isWorkspacePaymentAccessExpired({
        renewalDueAt: features.renewal_due_at,
        summary: paymentSummary,
        billingMode: features.billing_mode ?? getWorkspaceBillingMode(paymentSummary, features.has_usage_limits, Boolean(paygSummary?.enabled))
    })
    const paymentAlertKind = getWorkspacePaymentAlertKind(paymentSummary)
    const billingMode = features.billing_mode ?? getWorkspaceBillingMode(paymentSummary, features.has_usage_limits, Boolean(paygSummary?.enabled))
    const pendingTransaction = paymentSummary?.pendingTransaction ?? null
    const showPaymentAction = Boolean(paymentAlertKind || isExpired || pendingTransaction)
    const canRenewSubscription = user?.role === 'admin' && showPaymentAction
    const showsBillingActionLabel = !(isPaymentSummaryLoading && !paymentSummary) && !pendingTransaction
    const shouldAutoOpenRenewalDialog = Boolean(!isLoading && canRenewSubscription && showsBillingActionLabel)
    const renewalWorkspaceId = activeWorkspace?.id || user?.workspaceId || user?.sourceWorkspaceId
    const renewalPromptKey = renewalWorkspaceId
        ? [
            renewalWorkspaceId,
            user?.id ?? 'unknown-user',
            features.renewal_due_at ?? 'current-cycle'
        ].join(':')
        : null
    const formattedRenewalCountdown = renewalCountdownSeconds === null
        ? null
        : new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language || 'en').format(renewalCountdownSeconds)
    const canAddExtraDays = Boolean(canRenewSubscription && billingMode === 'subscription')
    const pendingExtraDays = paymentSummary?.pendingExtraDays ?? null
    const paygLimit = paygSummary?.paygLimitState?.limit ?? null
    const isPaygLimitLocked = Boolean(paygSummary?.paygLimitState?.locked && paygLimit)
    const canChangePaygLimit = Boolean(isPaygLimitLocked && user?.role === 'admin' && paygSummary?.canSubmitPayment)
    const paygLimitMetricLabel = paygLimit?.metric === 'accrued_charge'
        ? t('workspaceUsage.payg.accruedCharge')
        : t('workspaceUsage.payg.limit.changedUsage')
    const formatPaygMetric = (value: string, metric: 'accrued_charge' | 'changed_usage') => {
        const formatted = new Intl.NumberFormat(i18n.language || 'en', {
            maximumFractionDigits: 6
        }).format(Number(value))
        return `${formatted} ${metric === 'accrued_charge' ? 'IQD' : 'GB'}`
    }
    const paygLimitCopy = isPaygLimitLocked && paygLimit
        ? {
            title: t('workspaceUsage.payg.limitLockedTitle'),
            description: t('workspaceUsage.payg.limitLockedDescription', {
                metric: paygLimitMetricLabel,
                current: formatPaygMetric(paygLimit.currentValue, paygLimit.metric),
                threshold: formatPaygMetric(paygLimit.threshold, paygLimit.metric)
            }),
            icon: Gauge
        }
        : null

    const expiredPaymentCopy = (() => {
        switch (billingMode) {
            case 'usage':
                return {
                    title: t('workspacePayments.usageRenewalDueTitle'),
                    description: t('workspacePayments.usageRenewalDueDescription'),
                    icon: Clock
                }
            case 'prepaidTerm':
                return {
                    title: t('workspacePayments.prepaidTerm.renewalDueTitle'),
                    description: t('workspacePayments.prepaidTerm.renewalDueDescription'),
                    icon: Clock
                }
            case 'payg':
                return {
                    title: t('workspacePayments.payg.renewalDueTitle'),
                    description: t('workspacePayments.payg.renewalDueDescription'),
                    icon: CreditCard
                }
            default:
                return {
                    title: t('workspacePayments.subscriptionExpiredTitle'),
                    description: t('workspacePayments.subscriptionExpiredDescription'),
                    icon: Clock
                }
        }
    })()
    const paymentCopy = paygLimitCopy ?? (() => {
        switch (paymentAlertKind) {
            case 'payg_renewal_due':
                return {
                    title: t('workspacePayments.payg.renewalDueTitle'),
                    description: t('workspacePayments.payg.renewalDueDescription'),
                    icon: CreditCard
                }
            case 'usage_exhausted':
                return {
                    title: t('workspacePayments.usageExhaustedTitle'),
                    description: t('workspacePayments.usageExhaustedDescription'),
                    icon: HardDrive
                }
            case 'usage_renewal_due':
                return billingMode === 'prepaidTerm'
                    ? {
                        title: t('workspacePayments.prepaidTerm.renewalDueTitle'),
                        description: t('workspacePayments.prepaidTerm.renewalDueDescription'),
                        icon: Clock
                    }
                    : billingMode === 'payg'
                        ? expiredPaymentCopy
                        : {
                            title: t('workspacePayments.usageRenewalDueTitle'),
                            description: t('workspacePayments.usageRenewalDueDescription'),
                            icon: Clock
                        }
            case 'subscription_expired':
                return expiredPaymentCopy
            default:
                if (isExpired) return expiredPaymentCopy
                return {
                    title: t('lockedWorkspace.title'),
                    description: t('lockedWorkspace.message'),
                    icon: Lock
                }
        }
    })()
    const LockIcon = paymentCopy.icon
    const paymentActionLabelKey = pendingTransaction
        ? 'workspacePayments.viewPaymentStatus'
        : billingMode === 'prepaidTerm'
            ? 'workspacePayments.viewPaymentStatus'
            : billingMode === 'usage'
                ? 'workspacePayments.renewUsageCredit'
                : billingMode === 'payg'
                    ? 'workspacePayments.payg.renewalAction'
                    : 'workspacePayments.renewSubscription'

    const handleOpenBillingAction = useCallback(() => {
        if (renewalPromptKey) {
            handledRenewalPromptKeysRef.current.add(renewalPromptKey)
        }
        if (renewalCountdownIntervalRef.current !== null) {
            window.clearInterval(renewalCountdownIntervalRef.current)
            renewalCountdownIntervalRef.current = null
        }
        setRenewalCountdownSeconds(null)

        if (billingMode === 'prepaidTerm') {
            openWorkspacePaymentStatusDialog()
            return
        }
        openWorkspacePaymentDialog()
    }, [billingMode, renewalPromptKey])

    useEffect(() => {
        if (!shouldAutoOpenRenewalDialog || !renewalPromptKey) {
            setRenewalCountdownSeconds(null)
            return
        }

        if (
            handledRenewalPromptKeysRef.current.has(renewalPromptKey)
            || renewalCountdownIntervalRef.current !== null
        ) {
            return
        }

        let remainingSeconds = RENEWAL_AUTO_OPEN_COUNTDOWN_SECONDS
        setRenewalCountdownSeconds(remainingSeconds)
        const intervalId = window.setInterval(() => {
            remainingSeconds -= 1
            if (remainingSeconds <= 0) {
                window.clearInterval(intervalId)
                renewalCountdownIntervalRef.current = null
                handledRenewalPromptKeysRef.current.add(renewalPromptKey)
                setRenewalCountdownSeconds(null)
                handleOpenBillingAction()
                return
            }

            setRenewalCountdownSeconds(remainingSeconds)
        }, 1000)
        renewalCountdownIntervalRef.current = intervalId

        return () => {
            window.clearInterval(intervalId)
            if (renewalCountdownIntervalRef.current === intervalId) {
                renewalCountdownIntervalRef.current = null
            }
        }
    }, [handleOpenBillingAction, renewalPromptKey, shouldAutoOpenRenewalDialog])

    useEffect(() => {
        const handleBillingDialogOpen = () => {
            if (renewalPromptKey) {
                handledRenewalPromptKeysRef.current.add(renewalPromptKey)
            }
            if (renewalCountdownIntervalRef.current !== null) {
                window.clearInterval(renewalCountdownIntervalRef.current)
                renewalCountdownIntervalRef.current = null
            }
            setRenewalCountdownSeconds(null)
        }

        window.addEventListener(OPEN_WORKSPACE_PAYMENT_DIALOG_EVENT, handleBillingDialogOpen)
        window.addEventListener(OPEN_WORKSPACE_PAYMENT_STATUS_DIALOG_EVENT, handleBillingDialogOpen)
        return () => {
            window.removeEventListener(OPEN_WORKSPACE_PAYMENT_DIALOG_EVENT, handleBillingDialogOpen)
            window.removeEventListener(OPEN_WORKSPACE_PAYMENT_STATUS_DIALOG_EVENT, handleBillingDialogOpen)
        }
    }, [renewalPromptKey])

    useEffect(() => {
        if (!isLoading && !isLocked) {
            setLocation('/')
        }
    }, [isLoading, isLocked, setLocation])

    const handleContactAdmin = () => {
        setCopied(false)
        setContactAdminOpen(true)
    }

    const handleCopyNumber = async () => {
        try {
            await navigator.clipboard.writeText(ADMIN_PHONE_NUMBER.replace(/\s/g, ''))
            setCopied(true)
        } catch {
            // Clipboard unavailable, ignore
        }
    }

    const handleSignOut = async () => {
        await signOut()
        setLocation('/login')
    }

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-background dark:bg-slate-950">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-muted-foreground dark:text-slate-300">Loading...</p>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/30 p-4 dark:from-slate-950 dark:via-[#0b1422] dark:to-[#172235]">
            <div className="max-w-md w-full text-center space-y-8">
                {/* Lock Icon */}
                <div className="mx-auto w-24 h-24 rounded-full bg-destructive/10 flex items-center justify-center relative dark:bg-rose-500/15">
                    <LockIcon className={`w-12 h-12 text-destructive dark:text-rose-400 ${showPaymentAction ? 'animate-pulse' : ''}`} />
                    {canRenewSubscription && (
                        <div className="absolute -top-1 -right-1">
                            <AlertCircle className="w-6 h-6 text-destructive fill-background dark:text-rose-400 dark:fill-slate-950" />
                        </div>
                    )}
                </div>

                {/* Title */}
                <div className="space-y-2">
                    <h1 className="text-3xl font-bold text-foreground dark:text-slate-50">
                        {paymentCopy.title}
                    </h1>
                    <p className="text-muted-foreground text-lg dark:text-slate-200">
                        {paymentCopy.description}
                    </p>
                    {pendingTransaction && (
                        <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-800 dark:text-amber-200">
                            {t('workspacePayments.submittedMessage')}
                        </p>
                    )}
                </div>

                {/* Buttons Container */}
                <div className="flex flex-col gap-3 items-center">
                    {canChangePaygLimit && (
                        <Button
                            allowViewer={true}
                            size="lg"
                            onClick={() => setPaygLimitDialogOpen(true)}
                            className="gap-2 w-full max-w-[280px]"
                        >
                            <Gauge className="w-5 h-5" />
                            {t('workspaceUsage.payg.limit.openButton')}
                        </Button>
                    )}
                    {canRenewSubscription && (
                        <>
                            <Button
                                allowViewer={true}
                                size="lg"
                                onClick={handleOpenBillingAction}
                                className="h-auto min-h-12 w-full max-w-[320px] gap-2 whitespace-normal px-3 py-2 text-sm"
                            >
                                <CreditCard className="h-5 w-5 shrink-0" />
                                <span className="min-w-0 flex-1 whitespace-normal text-center leading-snug">
                                    {isPaymentSummaryLoading && !paymentSummary
                                        ? t('workspacePayments.loading')
                                            : t(paymentActionLabelKey)}
                                </span>
                                {shouldAutoOpenRenewalDialog && renewalCountdownSeconds !== null && formattedRenewalCountdown !== null && (
                                    <span
                                        role="timer"
                                        aria-label={t('lockedWorkspace.renewalAutoOpensIn', { seconds: formattedRenewalCountdown })}
                                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-background/80 px-2 py-1 text-xs font-bold tabular-nums text-foreground shadow-sm ring-1 ring-border/50"
                                    >
                                        <Clock className="h-3.5 w-3.5" />
                                        {t('lockedWorkspace.renewalCountdownShort', { seconds: formattedRenewalCountdown })}
                                    </span>
                                )}
                            </Button>
                            {canAddExtraDays && (
                                <Button
                                    allowViewer={true}
                                    size="lg"
                                    variant="outline"
                                    disabled={Boolean(pendingExtraDays)}
                                    onClick={openWorkspaceExtraDaysDialog}
                                    className="gap-2 w-full max-w-[240px] dark:border-slate-700 dark:bg-slate-950/60 dark:text-slate-100 dark:hover:bg-slate-900"
                                >
                                    <CalendarPlus className="w-5 h-5" />
                                    {t('workspacePayments.addExtraDays')}
                                </Button>
                            )}
                        </>
                    )}

                    <Button
                        allowViewer={true}
                        size="lg"
                        onClick={handleContactAdmin}
                        variant={canRenewSubscription ? 'outline' : 'default'}
                        className={`gap-2 w-full max-w-[240px] ${canRenewSubscription
                            ? 'dark:border-slate-700 dark:bg-slate-950/60 dark:text-slate-100 dark:hover:bg-slate-900'
                            : ''}`}
                    >
                        <Mail className="w-5 h-5" />
                        {t('lockedWorkspace.contactAdmin') || 'Contact an Admin'}
                    </Button>

                    <Button
                        allowViewer={true}
                        variant="outline"
                        size="lg"
                        onClick={handleSignOut}
                        className="gap-2 w-full max-w-[240px] dark:border-slate-700 dark:bg-slate-950/60 dark:text-slate-100 dark:hover:bg-slate-900"
                    >
                        <LogOut className="w-5 h-5" />
                        {t('common.signOut') || 'Sign Out'}
                    </Button>
                </div>

                {/* Additional Info */}
                <p className="text-xs text-muted-foreground opacity-70 dark:text-slate-400 dark:opacity-100">
                    {t('lockedWorkspace.additionalInfo') || 'If you believe this is an error, please reach out to your workspace administrator.'}
                </p>
            </div>

            {/* Contact Admin Modal */}
            <Dialog open={contactAdminOpen} onOpenChange={(open) => {
                setContactAdminOpen(open)
                if (!open) setCopied(false)
            }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <div className="flex items-center gap-3">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 dark:bg-primary/20">
                                <Phone className="h-6 w-6 text-primary" />
                            </div>
                            <div>
                                <DialogTitle className="text-lg">
                                    {t('lockedWorkspace.contactAdminModalTitle') || 'Contact an Admin'}
                                </DialogTitle>
                                <DialogDescription className="mt-1 text-sm leading-relaxed">
                                    {t('lockedWorkspace.contactAdminModalDescription') || 'Call us at the number below to get help and regain access to your workspace.'}
                                </DialogDescription>
                            </div>
                        </div>
                    </DialogHeader>

                    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 p-4 dark:bg-slate-800/60">
                        <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">
                                {t('lockedWorkspace.contactAdminNumberLabel') || 'Phone Number'}
                            </p>
                            <a
                                href={ADMIN_PHONE_HREF}
                                className="mt-0.5 block text-xl font-bold tracking-wide text-foreground hover:text-primary dark:text-slate-50"
                                dir="ltr"
                            >
                                {ADMIN_PHONE_NUMBER}
                            </a>
                        </div>
                    </div>

                    <DialogFooter className="flex-col gap-2 sm:flex-row">
                        <Button variant="outline" className="w-full gap-2 sm:w-auto" onClick={handleCopyNumber}>
                            <Copy className="h-4 w-4" />
                            {copied
                                ? (t('lockedWorkspace.contactAdminCopied') || 'Copied!')
                                : (t('lockedWorkspace.contactAdminCopy') || 'Copy Number')}
                        </Button>
                        <Button asChild className="w-full gap-2 sm:w-auto" allowViewer={true}>
                            <a href={ADMIN_PHONE_HREF}>
                                <Phone className="h-4 w-4" />
                                {t('lockedWorkspace.contactAdminCall') || 'Call Now'}
                            </a>
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <WorkspacePaygLimitDialog
                open={paygLimitDialogOpen}
                onOpenChange={setPaygLimitDialogOpen}
                summary={paygSummary}
                canManage={canChangePaygLimit}
                onSaved={async () => { await refreshPaygSummary() }}
            />
        </div>
    )
}
