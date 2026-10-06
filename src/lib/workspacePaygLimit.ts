import type { WorkspacePaygLimitMetric, WorkspacePaygLimitState } from './workspacePayments'

export function getWorkspacePaygMetricCurrentValue(
    state: WorkspacePaygLimitState | null | undefined,
    metric: WorkspacePaygLimitMetric
): number {
    const value = Number(state?.metrics[metric] ?? 0)
    return Number.isFinite(value) ? value : 0
}

export function isWorkspacePaygLimitThresholdValid(options: {
    value: string
    metric: WorkspacePaygLimitMetric
    state?: WorkspacePaygLimitState | null
}): boolean {
    const thresholdText = options.value.trim().replace(/,/g, '')
    if (!thresholdText) return false

    const threshold = Number(thresholdText)
    if (!Number.isFinite(threshold) || threshold <= 0) return false
    if (options.state?.locked) {
        return threshold > getWorkspacePaygMetricCurrentValue(options.state, options.metric)
    }

    return true
}
