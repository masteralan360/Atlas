export type OrderEditorKind = 'sales' | 'purchase'

export type OrderEditorLiveDataOptions = {
    kind: OrderEditorKind
    priceBooksEnabled: boolean
    salesAgentCommissionsEnabled?: boolean
    agentSalesAccountsEnabled?: boolean
}

export type OrderEditorLiveDataSource =
    | 'order'
    | 'businessPartners'
    | 'products'
    | 'productBarcodes'
    | 'storages'
    | 'units'
    | 'priceBooks'
    | 'inventory'
    | 'stockBatches'
    | 'discounts'
    | 'agents'
    | 'salesOrderAgentAssignments'
    | 'agentCommissionMemberships'
    | 'agentCommissionPlans'
    | 'productCommissionCatalog'

const PURCHASE_SOURCES: readonly OrderEditorLiveDataSource[] = [
    'order',
    'businessPartners',
    'products',
    'productBarcodes',
    'storages',
    'units'
]

const SALES_SOURCES: readonly OrderEditorLiveDataSource[] = [
    'order',
    'businessPartners',
    'products',
    'productBarcodes',
    'storages',
    'units',
    'inventory',
    'stockBatches',
    'discounts'
]

export function getOrderEditorLiveDataSources({
    kind,
    priceBooksEnabled,
    salesAgentCommissionsEnabled = false,
    agentSalesAccountsEnabled = false
}: OrderEditorLiveDataOptions): OrderEditorLiveDataSource[] {
    const sources = [...(kind === 'sales' ? SALES_SOURCES : PURCHASE_SOURCES)]

    if (priceBooksEnabled) {
        sources.push('priceBooks')
    }

    if (kind === 'sales' && (agentSalesAccountsEnabled || salesAgentCommissionsEnabled)) {
        sources.push('agents')
    }

    if (kind === 'sales' && salesAgentCommissionsEnabled) {
        sources.push(
            'salesOrderAgentAssignments',
            'agentCommissionMemberships',
            'agentCommissionPlans',
            'productCommissionCatalog'
        )
    }

    return sources
}

export function getOrderEditorLiveDataProgress(completedSources: number, totalSources: number) {
    if (totalSources <= 0) return 100

    const completed = Math.min(Math.max(completedSources, 0), totalSources)
    return Math.round((completed / totalSources) * 100)
}

export function shouldHydrateOrderEditorLiveData(editingOrderId?: string) {
    return Boolean(editingOrderId)
}

export function shouldKeepOrderEditorSectionsLoading(
    editingOrderId: string | undefined,
    isReady: boolean,
    hasError: boolean
) {
    return shouldHydrateOrderEditorLiveData(editingOrderId) && !isReady && !hasError
}
