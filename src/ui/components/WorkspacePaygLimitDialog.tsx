import { useEffect, useMemo, useState } from 'react'
import { Activity, CircleDollarSign, Gauge, Loader2, Save, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import {
    removeWorkspacePaygLimit,
    saveWorkspacePaygLimit,
    type WorkspacePaygLimitMetric,
    type WorkspacePaygSummary
} from '@/lib/workspacePayments'
import {
    getWorkspacePaygMetricCurrentValue,
    isWorkspacePaygLimitThresholdValid
} from '@/lib/workspacePaygLimit'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Button,
    DeleteConfirmationModal,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    useToast
} from '@/ui/components'

type WorkspacePaygLimitDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    summary: WorkspacePaygSummary | null
    canManage: boolean
    onSaved?: (summary: WorkspacePaygSummary) => void | Promise<void>
}

const PAYG_LIMIT_SLIDER_SCALES: Record<WorkspacePaygLimitMetric, { max: number; step: number }> = {
    accrued_charge: { max: 100_000, step: 1_000 },
    changed_usage: { max: 101, step: 1 }
}

export function WorkspacePaygLimitDialog({
    open,
    onOpenChange,
    summary,
    canManage,
    onSaved
}: WorkspacePaygLimitDialogProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const [metric, setMetric] = useState<WorkspacePaygLimitMetric>('accrued_charge')
    const [threshold, setThreshold] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const [isRemoving, setIsRemoving] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)

    const existingLimit = summary?.paygLimitState?.limit ?? null
    const isBusy = isSaving || isRemoving
    const currentMetricValue = getWorkspacePaygMetricCurrentValue(summary?.paygLimitState, metric)
    const sliderScale = PAYG_LIMIT_SLIDER_SCALES[metric]
    const firstAllowedSliderValue = (Math.floor(currentMetricValue / sliderScale.step) + 1)
        * sliderScale.step
    const canUseSlider = firstAllowedSliderValue <= sliderScale.max
    const numericThreshold = Number(threshold.replace(/,/g, ''))
    const sliderValue = canUseSlider
        ? Math.min(sliderScale.max, Math.max(
            firstAllowedSliderValue,
            Number.isFinite(numericThreshold) && numericThreshold > 0
                ? Math.round(numericThreshold / sliderScale.step) * sliderScale.step
                : firstAllowedSliderValue
        ))
        : sliderScale.max
    const currentMetricLabel = t(metric === 'accrued_charge'
        ? 'workspaceUsage.payg.accruedCharge'
        : 'workspaceUsage.payg.limit.changedUsage')
    const currentMetricValueLabel = formatNumericInput(String(currentMetricValue))
    const sliderMaxLabel = formatNumericInput(String(sliderScale.max))
    const sliderStepLabel = formatNumericInput(String(sliderScale.step))

    useEffect(() => {
        if (!open) return
        setMetric(existingLimit?.metric ?? 'accrued_charge')
        setThreshold(existingLimit?.threshold ?? '')
        setErrorMessage(null)
        setDeleteOpen(false)
    }, [existingLimit?.metric, existingLimit?.threshold, open])

    const thresholdIsValid = useMemo(() => isWorkspacePaygLimitThresholdValid({
        value: threshold,
        metric,
        state: summary?.paygLimitState
    }), [metric, summary?.paygLimitState, threshold])

    if (!canManage) return null

    const handleSave = async () => {
        if (!thresholdIsValid || isBusy) return
        setIsSaving(true)
        setErrorMessage(null)
        try {
            const updatedSummary = await saveWorkspacePaygLimit(metric, threshold)
            await onSaved?.(updatedSummary)
            toast({
                title: t('workspaceUsage.payg.limit.savedTitle'),
                description: t('workspaceUsage.payg.limit.savedDescription')
            })
            onOpenChange(false)
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            setErrorMessage(message.includes('workspace_payg_limit_must_exceed_current_usage')
                ? t('workspaceUsage.payg.limit.mustExceedCurrent')
                : t('workspaceUsage.payg.limit.saveError'))
        } finally {
            setIsSaving(false)
        }
    }

    const handleRemove = async () => {
        if (isBusy) return
        setIsRemoving(true)
        setErrorMessage(null)
        try {
            const updatedSummary = await removeWorkspacePaygLimit()
            await onSaved?.(updatedSummary)
            toast({
                title: t('workspaceUsage.payg.limit.removedTitle'),
                description: t('workspaceUsage.payg.limit.removedDescription')
            })
            setDeleteOpen(false)
            onOpenChange(false)
        } catch {
            setErrorMessage(t('workspaceUsage.payg.limit.removeError'))
        } finally {
            setIsRemoving(false)
        }
    }

    const metricUnit = metric === 'accrued_charge' ? 'IQD' : 'GB'

    return (
        <>
            <AppDialog
                open={open}
                onOpenChange={(nextOpen) => {
                    if (!isBusy) onOpenChange(nextOpen)
                }}
            >
                <AppDialogContent className="max-w-lg" showCloseButton={!isBusy}>
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <Gauge className="h-5 w-5 text-amber-600 dark:text-amber-300" />
                            {t('workspaceUsage.payg.limit.title')}
                        </AppDialogTitle>
                    </AppDialogHeader>
                    <AppDialogBody className="space-y-5">
                        <p className="text-sm leading-relaxed text-muted-foreground">
                            {t('workspaceUsage.payg.limit.description')}
                        </p>
                        {summary?.paygLimitState?.locked && (
                            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-100">
                                <Activity className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>{t('workspaceUsage.payg.limit.mustExceedCurrent')}</p>
                            </div>
                        )}
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="grid gap-2">
                                <Label htmlFor="workspace-payg-limit-metric">
                                    {t('workspaceUsage.payg.limit.metricLabel')}{' '}
                                    <span className="text-destructive">*</span>
                                </Label>
                                <Select
                                    value={metric}
                                    onValueChange={(value: WorkspacePaygLimitMetric) => {
                                        setMetric(value)
                                        setErrorMessage(null)
                                        const nextScale = PAYG_LIMIT_SLIDER_SCALES[value]
                                        const nextCurrentValue = getWorkspacePaygMetricCurrentValue(
                                            summary?.paygLimitState,
                                            value
                                        )
                                        const nextThreshold = (
                                            Math.floor(nextCurrentValue / nextScale.step) + 1
                                        ) * nextScale.step
                                        setThreshold(String(nextThreshold))
                                    }}
                                    disabled={isBusy}
                                >
                                    <SelectTrigger id="workspace-payg-limit-metric">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="accrued_charge">
                                            <span className="flex items-center gap-2">
                                                <CircleDollarSign className="h-4 w-4" />
                                                {t('workspaceUsage.payg.accruedCharge')}
                                            </span>
                                        </SelectItem>
                                        <SelectItem value="changed_usage">
                                            <span className="flex items-center gap-2">
                                                <Activity className="h-4 w-4" />
                                                {t('workspaceUsage.payg.limit.changedUsage')}
                                            </span>
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="workspace-payg-limit-threshold">
                                    {t('workspaceUsage.payg.limit.thresholdLabel')}{' '}
                                    <span className="text-destructive">*</span>
                                </Label>
                                <div className="relative">
                                    <Input
                                        id="workspace-payg-limit-threshold"
                                        inputMode="decimal"
                                        value={formatNumericInput(threshold)}
                                        onChange={(event) => {
                                            setThreshold(sanitizeNumericInput(event.target.value, {
                                                allowDecimal: true,
                                                maxFractionDigits: 6
                                            }))
                                            setErrorMessage(null)
                                        }}
                                        placeholder="0"
                                        disabled={isBusy}
                                        className="pe-14 tabular-nums"
                                        aria-invalid={!thresholdIsValid && threshold.length > 0}
                                    />
                                    <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">
                                        {metricUnit}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div className="grid gap-2">
                            <label htmlFor="workspace-payg-limit-slider" className="sr-only">
                                {t('workspaceUsage.payg.limit.thresholdLabel')}
                            </label>
                            <input
                                id="workspace-payg-limit-slider"
                                type="range"
                                min={Math.min(firstAllowedSliderValue, sliderScale.max)}
                                max={sliderScale.max}
                                step={sliderScale.step}
                                value={sliderValue}
                                disabled={!canUseSlider || isBusy}
                                aria-label={t('workspaceUsage.payg.limit.thresholdLabel')}
                                aria-describedby="workspace-payg-limit-slider-help"
                                onChange={(event) => {
                                    setThreshold(String(Number(event.target.value)))
                                    setErrorMessage(null)
                                }}
                                className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                            />
                            <div className="flex items-center justify-between gap-3 text-xs tabular-nums text-muted-foreground">
                                <span>{formatNumericInput('0')} {metricUnit}</span>
                                <span>{sliderMaxLabel} {metricUnit}</span>
                            </div>
                            <p id="workspace-payg-limit-slider-help" className="text-xs leading-relaxed text-muted-foreground">
                                {t('workspaceUsage.payg.limit.sliderHint', {
                                    step: sliderStepLabel,
                                    maximum: sliderMaxLabel,
                                    metric: currentMetricLabel,
                                    current: currentMetricValueLabel,
                                    unit: metricUnit
                                })}
                            </p>
                            {!canUseSlider && (
                                <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                                    {t('workspaceUsage.payg.limit.sliderUnavailable', {
                                        metric: currentMetricLabel,
                                        current: currentMetricValueLabel,
                                        unit: metricUnit
                                    })}
                                </p>
                            )}
                        </div>
                        {errorMessage && (
                            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                {errorMessage}
                            </p>
                        )}
                    </AppDialogBody>
                    <AppDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                        <div>
                            {existingLimit && (
                                <Button
                                    type="button"
                                    variant="destructive"
                                    className="gap-2"
                                    onClick={() => setDeleteOpen(true)}
                                    disabled={isBusy}
                                >
                                    <Trash2 className="h-4 w-4" />
                                    {t('workspaceUsage.payg.limit.removeButton')}
                                </Button>
                            )}
                        </div>
                        <div className="flex flex-col-reverse gap-2 sm:flex-row">
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
                                {t('common.cancel')}
                            </Button>
                            <Button type="button" onClick={() => void handleSave()} disabled={!thresholdIsValid || isBusy} className="gap-2">
                                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                {isSaving
                                    ? t('common.saving')
                                    : t('workspaceUsage.payg.limit.saveButton')}
                            </Button>
                        </div>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>

            <DeleteConfirmationModal
                isOpen={deleteOpen}
                onClose={() => {
                    if (!isRemoving) setDeleteOpen(false)
                }}
                onConfirm={() => void handleRemove()}
                isLoading={isRemoving}
                simpleConfirmation
                title={t('workspaceUsage.payg.limit.removeTitle')}
                description={t('workspaceUsage.payg.limit.removeDescription')}
                confirmLabel={t('workspaceUsage.payg.limit.removeButton')}
            />
        </>
    )
}
