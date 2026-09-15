import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react'
import { ArrowLeft, Check, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button, Progress } from '@/ui/components'

type OrderEditorLoadingOverlayProps = {
    completedSources: number
    totalSources: number
    percentage: number
    isComplete: boolean
    error: Error | null
    onRetry: () => void
    onBack: () => void
}

export type OrderEditorLoadingSectionState = Pick<
    OrderEditorLoadingOverlayProps,
    'completedSources' | 'totalSources' | 'percentage' | 'isComplete' | 'error'
> & {
    isLoading: boolean
}

type OrderEditorLoadingSectionProps = {
    state: OrderEditorLoadingSectionState
    onRetry: () => void
    onBack: () => void
    children: ReactNode
}

type OrderEditorReadOnlyContextValue = {
    isReadOnly: boolean
    statusLabel: string
}

const OrderEditorReadOnlyContext = createContext<OrderEditorReadOnlyContextValue>({
    isReadOnly: false,
    statusLabel: ''
})

type OrderEditorReadOnlyScopeProps = OrderEditorReadOnlyContextValue & {
    children: ReactNode
}

export function OrderEditorReadOnlyScope({ isReadOnly, statusLabel, children }: OrderEditorReadOnlyScopeProps) {
    const value = useMemo(() => ({ isReadOnly, statusLabel }), [isReadOnly, statusLabel])

    return (
        <OrderEditorReadOnlyContext.Provider value={value}>
            {children}
        </OrderEditorReadOnlyContext.Provider>
    )
}

export function OrderEditorLoadingSection({ state, onRetry, onBack, children }: OrderEditorLoadingSectionProps) {
    const contentRef = useRef<HTMLDivElement>(null)
    const { isReadOnly, statusLabel } = useContext(OrderEditorReadOnlyContext)
    const isLoadingBlocked = state.isLoading || Boolean(state.error)
    const isBlocked = isLoadingBlocked || isReadOnly

    useEffect(() => {
        const content = contentRef.current
        if (!content) return

        if (isBlocked) {
            content.setAttribute('inert', '')
        } else {
            content.removeAttribute('inert')
        }

        return () => content.removeAttribute('inert')
    }, [isBlocked])

    return (
        <div className="relative">
            <div ref={contentRef}>{children}</div>
            {isLoadingBlocked ? (
                <OrderEditorLoadingOverlay
                    completedSources={state.completedSources}
                    totalSources={state.totalSources}
                    percentage={state.percentage}
                    isComplete={state.isComplete}
                    error={state.error}
                    onRetry={onRetry}
                    onBack={onBack}
                />
            ) : isReadOnly ? (
                <OrderEditorReadOnlyOverlay statusLabel={statusLabel} />
            ) : null}
        </div>
    )
}

function OrderEditorReadOnlyOverlay({ statusLabel }: Pick<OrderEditorReadOnlyContextValue, 'statusLabel'>) {
    const { t } = useTranslation()

    return (
        <div
            className="absolute inset-0 z-20 flex min-h-80 items-center justify-center rounded-2xl bg-emerald-500/5 p-4 backdrop-blur-[1px]"
            role="status"
            aria-live="polite"
            aria-busy={false}
        >
            <div className="w-full max-w-sm rounded-2xl border border-emerald-500/30 bg-background/95 p-5 text-center shadow-lg">
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 shadow-sm dark:text-emerald-400">
                    <LockKeyhole className="h-3.5 w-3.5" />
                    {t('orders.form.editorReadOnly')}
                </span>
                <p className="mt-3 text-sm font-medium text-foreground">
                    {t('orders.form.editorReadOnlyStatus', { status: statusLabel })}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                    {t('orders.form.editorReadOnlyDescription')}
                </p>
            </div>
        </div>
    )
}

export function OrderEditorLoadingOverlay({
    completedSources,
    totalSources,
    percentage,
    isComplete,
    error,
    onRetry,
    onBack
}: OrderEditorLoadingOverlayProps) {
    const { t } = useTranslation()
    const isError = Boolean(error)

    return (
        <div
            className="absolute inset-0 z-20 flex min-h-80 items-center justify-center rounded-2xl bg-primary/5 p-4 backdrop-blur-[1px]"
            role={isError ? 'alert' : 'status'}
            aria-live="polite"
            aria-busy={!isError}
        >
            <div className="w-full max-w-sm rounded-2xl border border-primary/30 bg-background/95 p-5 text-center shadow-lg">
                <span className={isError
                    ? 'inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-700 shadow-sm dark:text-amber-400'
                    : 'inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary shadow-sm'}
                >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {isError
                        ? t('orders.form.editorLoadingFailed')
                        : t('orders.form.editorLoading')}
                </span>

                {isError ? (
                    <>
                        <p className="mt-3 text-sm text-muted-foreground">
                            {t('orders.form.editorLoadingFailedDescription')}
                        </p>
                        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-center">
                            <Button type="button" variant="outline" className="gap-2" onClick={onBack}>
                                <ArrowLeft className="h-4 w-4" />
                                {t('common.back')}
                            </Button>
                            <Button type="button" className="gap-2" onClick={onRetry}>
                                <RefreshCw className="h-4 w-4" />
                                {t('common.retry')}
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="mt-4 flex items-baseline justify-between gap-3 text-xs font-semibold text-primary">
                            {isComplete ? (
                                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t('orders.form.editorLoadingComplete')}
                                </span>
                            ) : (
                                <span>{t('orders.form.editorLoadingProgress', {
                                    completed: completedSources,
                                    total: totalSources,
                                    percentage
                                })}</span>
                            )}
                            <span className="shrink-0 tabular-nums">{percentage}%</span>
                        </div>
                        <Progress
                            value={percentage}
                            className="mt-2 h-2.5 bg-primary/15"
                            indicatorClassName="bg-primary"
                        />
                    </>
                )}
            </div>
        </div>
    )
}
