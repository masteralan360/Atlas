import type { MarketplaceOrderStatus } from './MarketplaceOrderTypes'

export type MarketplaceOrderRefreshDisposition = 'ignore' | 'defer' | 'load'

export interface MarketplaceOrderAdvancementProgressMetrics {
    completedCount: number
    totalCount: number
    progressPercent: number
    activeStepIndex: number | null
}

export const MARKETPLACE_ORDER_WORKFLOW = [
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered'
] as const satisfies readonly MarketplaceOrderStatus[]

export function getNextMarketplaceOrderStatus(status: MarketplaceOrderStatus): MarketplaceOrderStatus | null {
    const currentIndex = MARKETPLACE_ORDER_WORKFLOW.indexOf(status as (typeof MARKETPLACE_ORDER_WORKFLOW)[number])
    if (currentIndex < 0 || currentIndex >= MARKETPLACE_ORDER_WORKFLOW.length - 1) return null
    return MARKETPLACE_ORDER_WORKFLOW[currentIndex + 1]
}

export function getLaterMarketplaceOrderStatuses(status: MarketplaceOrderStatus): MarketplaceOrderStatus[] {
    const currentIndex = MARKETPLACE_ORDER_WORKFLOW.indexOf(status as (typeof MARKETPLACE_ORDER_WORKFLOW)[number])
    if (currentIndex < 0) return []
    return MARKETPLACE_ORDER_WORKFLOW.slice(currentIndex + 1)
}

export function getMarketplaceOrderAdvancementPath(
    currentStatus: MarketplaceOrderStatus,
    targetStatus: MarketplaceOrderStatus
): MarketplaceOrderStatus[] | null {
    const laterStatuses = getLaterMarketplaceOrderStatuses(currentStatus)
    const targetIndex = laterStatuses.indexOf(targetStatus)
    if (targetIndex < 0) return null
    return laterStatuses.slice(0, targetIndex + 1)
}

export function getMarketplaceOrderAdvancementProgressMetrics(
    completedSteps: number,
    totalSteps: number
): MarketplaceOrderAdvancementProgressMetrics {
    const totalCount = Number.isFinite(totalSteps)
        ? Math.max(0, Math.trunc(totalSteps))
        : 0
    const normalizedCompleted = Number.isFinite(completedSteps)
        ? Math.max(0, Math.trunc(completedSteps))
        : 0
    const completedCount = Math.min(normalizedCompleted, totalCount)

    return {
        completedCount,
        totalCount,
        progressPercent: totalCount === 0
            ? 0
            : Math.round((completedCount / totalCount) * 100),
        activeStepIndex: completedCount < totalCount ? completedCount : null
    }
}

export function getMarketplaceOrderRefreshDisposition({
    eventWorkspaceId,
    activeWorkspaceId,
    source,
    isTransitioning
}: {
    eventWorkspaceId?: string
    activeWorkspaceId?: string
    source?: 'local' | 'realtime' | 'reconnected'
    isTransitioning: boolean
}): MarketplaceOrderRefreshDisposition {
    if (!eventWorkspaceId || eventWorkspaceId !== activeWorkspaceId || source === 'local') return 'ignore'
    return isTransitioning ? 'defer' : 'load'
}

export async function runMarketplaceOrderAdvancement<Result>({
    currentStatus,
    targetStatus,
    advanceStep,
    afterStep
}: {
    currentStatus: MarketplaceOrderStatus
    targetStatus: MarketplaceOrderStatus
    advanceStep: (status: MarketplaceOrderStatus) => Promise<Result>
    afterStep: (status: MarketplaceOrderStatus, result: Result) => Promise<void>
}): Promise<Result[] | null> {
    const path = getMarketplaceOrderAdvancementPath(currentStatus, targetStatus)
    if (!path) return null

    const results: Result[] = []
    for (const status of path) {
        const result = await advanceStep(status)
        await afterStep(status, result)
        results.push(result)
    }
    return results
}
