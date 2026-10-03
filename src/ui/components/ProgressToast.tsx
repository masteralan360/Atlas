import { useTranslation } from 'react-i18next'
import { Progress } from './ui/progress'
import { LoaderCircle } from 'lucide-react'

export type ProgressToastProps = {
    fraction?: number
    stageKey?: string
    page?: number
    total?: number
    indeterminate?: boolean
}

/**
 * Persistent toast content for workflows that report incremental progress,
 * such as saving and printing a PDF.
 */
export function ProgressToast({ fraction = 0, stageKey, page, total, indeterminate = false }: ProgressToastProps) {
    const { t } = useTranslation()
    const percent = Math.min(100, Math.max(0, Math.round(fraction * 100)))
    const stage = stageKey
        ? t(stageKey, { defaultValue: '', page, total })
        : ''

    return (
        <div className="w-full space-y-1.5" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {indeterminate && <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />}
                    <span className="truncate">{stage}</span>
                </span>
                {!indeterminate && <span className="text-xs font-medium tabular-nums">{percent}%</span>}
            </div>
            {indeterminate ? (
                <div
                    role="progressbar"
                    aria-label={stage || 'Workflow progress'}
                    aria-valuetext={stage || t('common.loading', { defaultValue: 'In progress' })}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15"
                >
                    <div className="h-full w-1/3 rounded-full bg-primary/70 animate-pulse" />
                </div>
            ) : (
                <Progress
                    value={percent}
                    className="h-1.5 bg-primary/15"
                    aria-label={stage || 'Workflow progress'}
                />
            )}
        </div>
    )
}
