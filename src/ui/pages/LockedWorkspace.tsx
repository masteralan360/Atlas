import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CalendarPlus, Clock, CreditCard, Copy, HardDrive, Lock, LogOut, Mail, Phone, RefreshCw, WifiOff } from 'lucide-react'
import { Button } from '@/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/components/dialog'
import { useAuth } from '@/auth'
import { useLocation } from 'wouter'
import { useWorkspace } from '@/workspace'
import {
    getWorkspacePaymentAlertKind,
    isWorkspacePaymentAccessExpired,
    openWorkspaceExtraDaysDialog,
    openWorkspacePaymentDialog,
} from '@/lib/workspacePayments'

const ADMIN_PHONE_NUMBER = '0770 199 0012'
const ADMIN_PHONE_HREF = 'tel:07701990012'

export function LockedWorkspace() {
    const { t } = useTranslation()
    const { signOut, user } = useAuth()
    const {
        features,
        isLocked,
        isLoading,
        paymentSummary,
        isPaymentSummaryLoading,
        requiresOnlineEntitlementRevalidation,
        refreshFeatures
    } = useWorkspace()
    const [, setLocation] = useLocation()
    const [contactAdminOpen, setContactAdminOpen] = useState(false)
    const [copied, setCopied] = useState(false)
    const [isRetryingVerification, setIsRetryingVerification] = useState(false)

    const isExpired = isWorkspacePaymentAccessExpired({
        subscriptionExpiresAt: features.subscription_expires_at,
        renewalDueAt: features.renewal_due_at,
        hasUsageLimits: features.has_usage_limits,
        summary: paymentSummary
    })
    const paymentAlertKind = getWorkspacePaymentAlertKind(paymentSummary)
    const pendingTransaction = paymentSummary?.pendingTransaction ?? null
    const showPaymentAction = !requiresOnlineEntitlementRevalidation
        && Boolean(paymentAlertKind || isExpired || pendingTransaction)
    const canRenewSubscription = user?.role === 'admin' && showPaymentAction
    const canAddExtraDays = Boolean(
        canRenewSubscription
        && paymentSummary?.configuration
        && !paymentSummary.configuration.usageEnabled
        && !paymentSummary.configuration.paygEnabled
    )
    const pendingExtraDays = paymentSummary?.pendingExtraDays ?? null

    const paymentCopy = (() => {
        if (requiresOnlineEntitlementRevalidation) {
            return {
                title: t('lockedWorkspace.offlineEntitlementTitle'),
                description: t('lockedWorkspace.offlineEntitlementMessage'),
                icon: WifiOff
            }
        }

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
            case 'subscription_expired':
                return {
                    title: t('workspacePayments.subscriptionExpiredTitle'),
                    description: t('workspacePayments.subscriptionExpiredDescription'),
                    icon: Clock
                }
            default:
                if (isExpired) {
                    return {
                        title: t('workspacePayments.subscriptionExpiredTitle'),
                        description: t('workspacePayments.subscriptionExpiredDescription'),
                        icon: Clock
                    }
                }
                return {
                    title: t('lockedWorkspace.title'),
                    description: t('lockedWorkspace.message'),
                    icon: Lock
                }
        }
    })()
    const LockIcon = paymentCopy.icon

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

    const handleRetryVerification = async () => {
        if (isRetryingVerification) return
        setIsRetryingVerification(true)
        try {
            await refreshFeatures()
        } finally {
            setIsRetryingVerification(false)
        }
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
                    {requiresOnlineEntitlementRevalidation && (
                        <Button
                            allowViewer={true}
                            size="lg"
                            disabled={isRetryingVerification}
                            onClick={handleRetryVerification}
                            className="gap-2 w-full max-w-[240px]"
                        >
                            <RefreshCw className={`w-5 h-5 ${isRetryingVerification ? 'animate-spin' : ''}`} />
                            {isRetryingVerification
                                ? t('lockedWorkspace.offlineEntitlementRetrying')
                                : t('lockedWorkspace.offlineEntitlementRetry')}
                        </Button>
                    )}

                    {canRenewSubscription && (
                        <>
                            <Button
                                allowViewer={true}
                                size="lg"
                                onClick={openWorkspacePaymentDialog}
                                className="gap-2 w-full max-w-[240px]"
                            >
                                <CreditCard className="w-5 h-5" />
                                {isPaymentSummaryLoading && !paymentSummary
                                    ? t('workspacePayments.loading')
                                    : pendingTransaction
                                        ? t('workspacePayments.viewPaymentStatus')
                                        : t('workspacePayments.renewSubscription')}
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
                        variant={canRenewSubscription || requiresOnlineEntitlementRevalidation ? 'outline' : 'default'}
                        className={`gap-2 w-full max-w-[240px] ${canRenewSubscription || requiresOnlineEntitlementRevalidation
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
                    {requiresOnlineEntitlementRevalidation
                        ? t('lockedWorkspace.offlineEntitlementAdditionalInfo')
                        : (t('lockedWorkspace.additionalInfo') || 'If you believe this is an error, please reach out to your workspace administrator.')}
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
        </div>
    )
}
