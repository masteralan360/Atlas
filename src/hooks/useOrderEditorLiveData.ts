import { useCallback, useEffect, useMemo, useState } from 'react'

import {
    db,
    fetchInventoryWorkspaceFromSupabase,
    fetchTableFromSupabase,
    refreshStockBatchesFromSupabase
} from '@/local-db'
import {
    getOrderEditorLiveDataProgress,
    getOrderEditorLiveDataSources,
    shouldHydrateOrderEditorLiveData,
    shouldKeepOrderEditorSectionsLoading,
    type OrderEditorKind,
    type OrderEditorLiveDataSource
} from '@/lib/orderEditorLiveData'

type CatalogState = {
    isReady: boolean
    error: unknown
    retry?: () => void
}

type OrderEditorLiveDataOptions = {
    workspaceId: string
    editingOrderId?: string
    kind: OrderEditorKind
    priceBooksEnabled: boolean
    salesAgentCommissionsEnabled?: boolean
    agentSalesAccountsEnabled?: boolean
    priceBookCatalog?: CatalogState
    productCommissionCatalog?: CatalogState
}

type LoadState = {
    completedSourceIds: OrderEditorLiveDataSource[]
    isInitialFetchComplete: boolean
    failure: { source: OrderEditorLiveDataSource; error: Error } | null
}

const PASSIVE_SOURCES = new Set<OrderEditorLiveDataSource>([
    'priceBooks',
    'productCommissionCatalog'
])

type ActiveOrderEditorLiveDataSource = Exclude<
    OrderEditorLiveDataSource,
    'priceBooks' | 'productCommissionCatalog'
>

function toLoadError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error))
}

function getFailureSource(error: unknown): OrderEditorLiveDataSource | null {
    if (!error || typeof error !== 'object' || !('source' in error)) return null
    return error.source as OrderEditorLiveDataSource
}

function getFailureError(error: unknown) {
    if (error && typeof error === 'object' && 'error' in error) {
        return toLoadError(error.error)
    }
    return toLoadError(error)
}

async function requireSuccessfulHydration(request: Promise<boolean>) {
    if (!await request) {
        throw new Error('order_editor_source_failed')
    }
}

async function hydrateSource(
    source: Exclude<OrderEditorLiveDataSource, 'priceBooks' | 'productCommissionCatalog'>,
    workspaceId: string,
    kind: OrderEditorKind
) {
    switch (source) {
        case 'order':
            await requireSuccessfulHydration(fetchTableFromSupabase(
                kind === 'sales' ? 'sales_orders' : 'purchase_orders',
                kind === 'sales' ? db.sales_orders : db.purchase_orders,
                workspaceId
            ))
            return
        case 'businessPartners':
            await requireSuccessfulHydration(fetchTableFromSupabase('business_partners', db.business_partners, workspaceId))
            return
        case 'products':
            await requireSuccessfulHydration(fetchTableFromSupabase('products', db.products, workspaceId))
            return
        case 'productBarcodes':
            await requireSuccessfulHydration(fetchTableFromSupabase('product_barcodes', db.product_barcodes, workspaceId))
            return
        case 'storages':
            await requireSuccessfulHydration(fetchTableFromSupabase('storages', db.storages, workspaceId))
            return
        case 'units':
            await requireSuccessfulHydration(fetchTableFromSupabase('units', db.units, workspaceId))
            return
        case 'inventory':
            await requireSuccessfulHydration(fetchInventoryWorkspaceFromSupabase(workspaceId))
            return
        case 'stockBatches':
            await requireSuccessfulHydration(refreshStockBatchesFromSupabase(workspaceId))
            return
        case 'discounts':
            await Promise.all([
                requireSuccessfulHydration(fetchTableFromSupabase('product_discounts', db.product_discounts, workspaceId)),
                requireSuccessfulHydration(fetchTableFromSupabase('category_discounts', db.category_discounts, workspaceId))
            ])
            return
        case 'agents':
            await requireSuccessfulHydration(fetchTableFromSupabase('agents', db.agents, workspaceId))
            return
        case 'salesOrderAgentAssignments':
            await requireSuccessfulHydration(fetchTableFromSupabase(
                'sales_order_agent_assignments',
                db.sales_order_agent_assignments,
                workspaceId
            ))
            return
        case 'agentCommissionMemberships':
            await requireSuccessfulHydration(fetchTableFromSupabase(
                'agent_commission_memberships',
                db.agent_commission_memberships,
                workspaceId
            ))
            return
        case 'agentCommissionPlans':
            await requireSuccessfulHydration(fetchTableFromSupabase(
                'agent_commission_plans',
                db.agent_commission_plans,
                workspaceId
            ))
            return
    }
}

export function useOrderEditorLiveData({
    workspaceId,
    editingOrderId,
    kind,
    priceBooksEnabled,
    salesAgentCommissionsEnabled = false,
    agentSalesAccountsEnabled = false,
    priceBookCatalog,
    productCommissionCatalog
}: OrderEditorLiveDataOptions) {
    const [attempt, setAttempt] = useState(0)
    const [loadState, setLoadState] = useState<LoadState>({
        completedSourceIds: [],
        isInitialFetchComplete: !editingOrderId,
        failure: null
    })
    const sources = useMemo(() => getOrderEditorLiveDataSources({
        kind,
        priceBooksEnabled,
        salesAgentCommissionsEnabled,
        agentSalesAccountsEnabled
    }), [agentSalesAccountsEnabled, kind, priceBooksEnabled, salesAgentCommissionsEnabled])
    const activeSources = useMemo(
        () => sources.filter((source): source is ActiveOrderEditorLiveDataSource => !PASSIVE_SOURCES.has(source)),
        [sources]
    )
    const passiveSources = useMemo(
        () => sources.filter((source) => PASSIVE_SOURCES.has(source)),
        [sources]
    )

    useEffect(() => {
        if (!editingOrderId) {
            setLoadState({ completedSourceIds: [], isInitialFetchComplete: true, failure: null })
            return
        }

        const orderId = editingOrderId

        let cancelled = false
        setLoadState({ completedSourceIds: [], isInitialFetchComplete: false, failure: null })

        void Promise.all(activeSources.map(async (source) => {
            try {
                await hydrateSource(source, workspaceId, kind)
            } catch (error) {
                throw { source, error: toLoadError(error) }
            }
            if (!cancelled) {
                setLoadState((current) => current.failure
                    ? current
                    : current.completedSourceIds.includes(source)
                        ? current
                        : { ...current, completedSourceIds: [...current.completedSourceIds, source] })
            }
        })).then(async () => {
            const order = kind === 'sales'
                ? await db.sales_orders.get(orderId)
                : await db.purchase_orders.get(orderId)
            if (!order) {
                throw new Error('order_editor_order_not_found')
            }
            if (!cancelled) {
                setLoadState((current) => ({ ...current, isInitialFetchComplete: true }))
            }
        }).catch((error) => {
            if (!cancelled) {
                setLoadState((current) => ({
                    ...current,
                    failure: {
                        source: getFailureSource(error) ?? 'order',
                        error: getFailureError(error)
                    }
                }))
            }
        })

        return () => {
            cancelled = true
        }
    }, [activeSources, attempt, editingOrderId, kind, workspaceId])

    const passiveFailure = passiveSources.reduce<{ source: OrderEditorLiveDataSource; error: Error } | null>((failure, source) => {
        if (failure) return failure
        if (source === 'priceBooks' && priceBookCatalog?.error) {
            return { source, error: toLoadError(priceBookCatalog.error) }
        }
        if (source === 'productCommissionCatalog' && productCommissionCatalog?.error) {
            return { source, error: toLoadError(productCommissionCatalog.error) }
        }
        return null
    }, null)
    const completedSourceIds = useMemo(() => [
        ...loadState.completedSourceIds,
        ...passiveSources.filter((source) => (
            (source === 'priceBooks' && priceBookCatalog?.isReady)
            || (source === 'productCommissionCatalog' && productCommissionCatalog?.isReady)
        ))
    ], [
        loadState.completedSourceIds,
        passiveSources,
        priceBookCatalog?.isReady,
        productCommissionCatalog?.isReady
    ])
    const failure = loadState.failure ?? passiveFailure
    const error = failure?.error ?? null
    const completedSources = completedSourceIds.length
    const isReady = !shouldHydrateOrderEditorLiveData(editingOrderId)
        || (loadState.isInitialFetchComplete && completedSources === sources.length && !error)
    const retry = useCallback(() => {
        priceBookCatalog?.retry?.()
        productCommissionCatalog?.retry?.()
        setAttempt((value) => value + 1)
    }, [priceBookCatalog, productCommissionCatalog])
    const getSectionState = useCallback((sectionSources: readonly OrderEditorLiveDataSource[]) => {
        const relevantSources = sectionSources.filter((source) => sources.includes(source))
        const completed = relevantSources.filter((source) => completedSourceIds.includes(source)).length
        const sectionFailure = failure && relevantSources.includes(failure.source) ? failure.error : null

        return {
            completedSources: completed,
            totalSources: relevantSources.length,
            percentage: getOrderEditorLiveDataProgress(completed, relevantSources.length),
            isComplete: completed === relevantSources.length,
            isLoading: shouldKeepOrderEditorSectionsLoading(editingOrderId, isReady, Boolean(error)),
            error: sectionFailure
        }
    }, [completedSourceIds, editingOrderId, error, failure, isReady, sources])

    return {
        completedSources,
        totalSources: sources.length,
        percentage: getOrderEditorLiveDataProgress(completedSources, sources.length),
        isLoading: shouldKeepOrderEditorSectionsLoading(editingOrderId, isReady, Boolean(error)),
        error,
        retry,
        getSectionState
    }
}
