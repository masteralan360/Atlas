import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, CalendarPlus, CheckCircle2, LoaderCircle } from 'lucide-react'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Button } from '@/ui/components/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/ui/components/dialog'
import { cn } from '@/lib/utils'
import {
    grantWorkspaceSubscriptionExtraDays,
    OPEN_WORKSPACE_EXTRA_DAYS_DIALOG_EVENT
} from '@/lib/workspacePayments'

const EXTRA_DAY_OPTIONS = [1, 2, 3, 4, 5, 6] as const

function getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return 'Unable to add extra days. Please try again.'
}

export function WorkspaceExtraDaysDialog() {
    const { t } = useTranslation()
    const { isAuthenticated, user } = useAuth()
    const {
        activeWorkspace,
        isDemoMode,
        paymentSummary,
        refreshFeatures,
        refreshPaymentSummary
    } = useWorkspace()
    const [open, setOpen] = useState(false)
    const [selectedDays, setSelectedDays] = useState<number>(1)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const configuration = paymentSummary?.configuration ?? null
    const isSubscriptionWorkspace = Boolean(configuration && !configuration.usageEnabled)
    const pendingExtraDays = paymentSummary?.pendingExtraDays ?? null
    const selectedDaysLabel = useMemo(() => t('workspacePayments.extraDaysCount', {
        count: selectedDays,
        defaultValue: `${selectedDays} ${selectedDays === 1 ? 'day' : 'days'}`
    }), [selectedDays, t])

    useEffect(() => {
        const handleOpen = () => {
            if (isSubscriptionWorkspace) {
                setError(null)
                setSelectedDays(1)
                setOpen(true)
            }
        }

        window.addEventListener(OPEN_WORKSPACE_EXTRA_DAYS_DIALOG_EVENT, handleOpen)
        return () => window.removeEventListener(OPEN_WORKSPACE_EXTRA_DAYS_DIALOG_EVENT, handleOpen)
    }, [isSubscriptionWorkspace])

    useEffect(() => {
        setOpen(false)
        setSelectedDays(1)
        setIsSubmitting(false)
        setError(null)
    }, [activeWorkspace?.id])

    useEffect(() => {
        if (open && !isSubscriptionWorkspace) {
            setOpen(false)
        }
    }, [isSubscriptionWorkspace, open])

    if (!isAuthenticated || isDemoMode || user?.role !== 'admin' || !isSubscriptionWorkspace) return null

    const handleConfirm = async () => {
        if (isSubmitting || pendingExtraDays) return

        setIsSubmitting(true)
        setError(null)

        try {
            await grantWorkspaceSubscriptionExtraDays(selectedDays)
            await Promise.all([
                refreshPaymentSummary(),
                refreshFeatures()
            ])
            setOpen(false)
        } catch (nextError) {
            try {
                const refreshed = await refreshPaymentSummary()
                if (refreshed?.pendingExtraDays) {
                    // The server may have committed the grant even when this
                    // client lost the RPC response. Show the authoritative
                    // pending record rather than inviting a duplicate retry.
                    await refreshFeatures()
                    return
                }
            } catch {
                // Preserve the grant error if the recovery refresh also fails.
            }
            setError(getErrorMessage(nextError))
        } finally {
            setIsSubmitting(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => {
            if (!isSubmitting) setOpen(nextOpen)
        }}>
            <DialogContent className="max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto rounded-[28px] p-0 shadow-2xl">
                <div className="border-b border-border/60 bg-gradient-to-br from-primary/[0.12] via-background to-amber-500/[0.07] px-5 py-5 sm:px-8 sm:py-6">
                    <DialogHeader className="pe-10 text-start">
                        <div className="flex items-start gap-4">
                            <span className="flex h-[3.25rem] w-[3.25rem] shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
                                <CalendarPlus className="h-6 w-6" />
                            </span>
                            <div className="space-y-1.5">
                                <DialogTitle className="text-xl sm:text-2xl">
                                    {t('workspacePayments.addExtraDays')}
                                </DialogTitle>
                                <DialogDescription className="max-w-xl leading-relaxed">
                                    {t('workspacePayments.extraDaysDescription')}
                                </DialogDescription>
                            </div>
                        </div>
                    </DialogHeader>
                </div>

                <div className="space-y-6 px-5 py-5 sm:px-8 sm:py-7">
                    {pendingExtraDays ? (
                        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-5">
                            <div className="flex items-start gap-3">
                                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
                                <div>
                                    <p className="font-bold text-foreground">
                                        {t('workspacePayments.extraDaysAlreadyPending')}
                                    </p>
                                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                                        {t('workspacePayments.extraDaysPendingDescription', {
                                            count: pendingExtraDays.extraDays,
                                            consumedDays: Math.floor(pendingExtraDays.consumedDurationSeconds / 86_400),
                                            remainingDays: pendingExtraDays.remainingDurationSeconds / 86_400
                                        })}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <>
                            <section>
                                <h3 className="text-sm font-bold text-foreground">
                                    {t('workspacePayments.selectExtraDays')}
                                </h3>
                                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                                    {EXTRA_DAY_OPTIONS.map((days) => {
                                        const selected = days === selectedDays
                                        return (
                                            <button
                                                key={days}
                                                type="button"
                                                aria-pressed={selected}
                                                onClick={() => setSelectedDays(days)}
                                                className={cn(
                                                    'rounded-2xl border px-4 py-4 text-start transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                                    selected
                                                        ? 'border-primary bg-primary/[0.08] shadow-sm ring-1 ring-primary/20'
                                                        : 'border-border/70 bg-background hover:border-primary/40 hover:bg-accent/40'
                                                )}
                                            >
                                                <span className="block text-2xl font-black tabular-nums text-foreground">{days}</span>
                                                <span className="mt-1 block text-xs font-semibold text-muted-foreground">
                                                    {t('workspacePayments.extraDaysCount', {
                                                        count: days,
                                                        defaultValue: `${days} ${days === 1 ? 'day' : 'days'}`
                                                    })}
                                                </span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </section>

                            <section className="rounded-2xl border border-primary/20 bg-primary/[0.06] p-4">
                                <p className="text-sm font-bold text-foreground">
                                    {t('workspacePayments.extraDaysSelected', { count: selectedDays })}
                                </p>
                                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                                    {t('workspacePayments.extraDaysDeductionNotice', { count: selectedDays })}
                                </p>
                            </section>

                            {error && (
                                <div role="alert" className="flex items-start gap-3 rounded-2xl border border-destructive/25 bg-destructive/10 p-4 text-destructive">
                                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                                    <p className="text-sm leading-relaxed">{error}</p>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <DialogFooter className="border-t border-border/60 bg-muted/[0.12] px-5 py-4 sm:px-8">
                    <Button allowViewer={true} variant="outline" disabled={isSubmitting} onClick={() => setOpen(false)}>
                        {t('workspacePayments.close')}
                    </Button>
                    {!pendingExtraDays && (
                        <Button allowViewer={true} disabled={isSubmitting} onClick={() => void handleConfirm()}>
                            {isSubmitting ? (
                                <LoaderCircle className="h-4 w-4 animate-spin" />
                            ) : (
                                <CalendarPlus className="h-4 w-4" />
                            )}
                            {t('workspacePayments.confirmExtraDays', { days: selectedDaysLabel })}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
