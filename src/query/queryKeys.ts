import type { OrdersListPageQuery } from '@/local-db/ordersList'
import type { MarketplaceOrderPageQuery, MarketplaceOrderSummaryQuery } from '@/local-db/marketplaceOrders'
import type { StockAdjustmentPageQuery } from '@/local-db/stockAdjustments'
import type { StockBatchGroupPageQuery } from '@/local-db/stockBatches'
import type { Beauty3AppointmentPageQuery } from '@/local-db/beauty3Appointments'
import type { NotificationInboxPageQuery } from '@/local-db/notificationInbox'

export const queryKeys = {
  notificationInbox: {
    all: (workspaceId?: string, userId?: string | null) => [
      'atlas', 'workspace', workspaceId ?? 'unscoped', 'notification-inbox', userId ?? null,
    ] as const,
    page: (query: NotificationInboxPageQuery) => [
      ...queryKeys.notificationInbox.all(query.workspaceId, query.userId),
      'page',
      query.tab,
      query.page,
      query.pageSize,
      'createdAt:desc,id:desc',
    ] as const,
  },
  beauty3Appointments: {
    all: (workspaceId?: string) => ['atlas', 'workspace', workspaceId ?? 'unscoped', 'beauty3-appointments'] as const,
    page: (query: Beauty3AppointmentPageQuery, viewer?: { userId?: string | null }) => [
      ...queryKeys.beauty3Appointments.all(query.workspaceId),
      'page',
      query.page,
      query.pageSize,
      query.search.trim(),
      query.dateFrom ?? null,
      query.dateTo ?? null,
      query.sourceMode,
      query.sort,
      viewer?.userId ?? null,
    ] as const,
    profitPayments: (
      workspaceId: string,
      appointmentIds: readonly string[],
      sourceMode: 'local' | 'remote',
      viewer?: { userId?: string | null },
    ) => [
      ...queryKeys.beauty3Appointments.all(workspaceId),
      'profit-payments',
      [...appointmentIds].sort(),
      sourceMode,
      viewer?.userId ?? null,
    ] as const,
    clients: (workspaceId: string, search: string, sourceMode: 'local' | 'remote', viewerId?: string | null) => [
      ...queryKeys.beauty3Appointments.all(workspaceId),
      'clients',
      search.trim().toLocaleLowerCase(),
      sourceMode,
      viewerId ?? null,
    ] as const,
  },
  stockReservations: {
    all: (workspaceId?: string) => ['atlas', 'workspace', workspaceId ?? 'unscoped', 'stock-reservations'] as const,
    availability: (workspaceId: string | undefined, positions: readonly { productId: string; storageId: string }[], excludeOrderId?: string, userId?: string, role?: string) =>
      [...queryKeys.stockReservations.all(workspaceId), 'availability', positions, excludeOrderId ?? null, userId ?? null, role ?? null] as const,
    details: (workspaceId: string, productId: string, storageId: string, page: number, userId?: string, role?: string) =>
      [...queryKeys.stockReservations.all(workspaceId), 'details', productId, storageId, page, userId ?? null, role ?? null] as const,
  },
  postal: {
    locationCatalog: (scope: import('@/local-db/postal').PostalScope) => [
      ...queryKeys.postal.all(scope.workspaceId),
      'location-catalog',
      scope.userId,
      scope.role,
      scope.permissionScope,
    ] as const,
    qrBatches: (workspaceId: string) => [...queryKeys.postal.all(workspaceId), 'qr-batches'] as const,
    qrBatchPage: (input: import('@/local-db/postalQrBatches').PostalQrPageInput) => [...queryKeys.postal.qrBatches(input.workspaceId), 'page', input] as const,
    qrBatch: (scope: import('@/local-db/postal').PostalScope, id: string) => [...queryKeys.postal.qrBatches(scope.workspaceId), 'detail', scope, id] as const,
    generatedQrPage: (input: import('@/local-db/postalQrBatches').PostalQrPageInput) => [...queryKeys.postal.qrBatches(input.workspaceId), 'codes', input] as const,
    all: (workspaceId: string) => ['atlas', 'workspace', workspaceId, 'postal'] as const,
    primaryBranch: (scope: import('@/local-db/postal').PostalScope) => [...queryKeys.postal.all(scope.workspaceId), 'primary-branch', scope.userId, scope.role, scope.permissionScope] as const,
    statement: (input: import('@/local-db/postalStatement').PostalStatementInput) => [...queryKeys.postal.all(input.workspaceId), 'statement', input] as const,
    statementOrganizations: (scope: import('@/local-db/postal').PostalScope, search: string) => [...queryKeys.postal.all(scope.workspaceId), 'statement-organizations', scope, search] as const,
    page: (input: import('@/local-db/postal').PostalPageInput) => [...queryKeys.postal.all(input.workspaceId), 'page', input] as const,
    summary: (input: import('@/local-db/postal').PostalSummaryInput) => [...queryKeys.postal.all(input.workspaceId), 'summary', input] as const,
    detail: (scope: import('@/local-db/postal').PostalScope, id: string) => [...queryKeys.postal.all(scope.workspaceId), 'detail', scope, id] as const,
    events: (scope: import('@/local-db/postal').PostalScope, id: string) => [...queryKeys.postal.all(scope.workspaceId), 'events', scope, id] as const,
    members: (scope: import('@/local-db/postal').PostalScope, id: string) => [...queryKeys.postal.all(scope.workspaceId), 'members', scope, id] as const,
  },
  directTransactions: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'direct-transactions'] as const,
  },
  tieredPerformanceCommissions: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'tiered-performance-commissions'] as const,
    dashboard: (input: {
      workspaceId: string
      monthStart: string | null
      page: number
      pageSize: number
      userId: string
    }) => [
      ...queryKeys.tieredPerformanceCommissions.all(input.workspaceId),
      'dashboard', input.monthStart, input.page, input.pageSize, input.userId,
    ] as const,
    productConfiguration: (workspaceId: string, productId: string | null, userId: string) => [
      ...queryKeys.tieredPerformanceCommissions.all(workspaceId),
      'product-configuration', productId, userId,
    ] as const,
    orderPreview: (input: {
      workspaceId: string
      orderId: string | null
      userId: string
      permissionScope: 'view-all' | 'view-own' | 'none'
      sourceMode: 'local' | 'remote'
    }) => [
      ...queryKeys.tieredPerformanceCommissions.all(input.workspaceId),
      'order-preview', input.orderId, input.userId, input.permissionScope, input.sourceMode,
    ] as const,
    draftOrderEstimate: (input: {
      workspaceId: string
      agentId: string | null
      occurredAt: string
      itemsKey: string
      userId: string
      permissionScope: 'view-all' | 'view-own' | 'none'
    }) => [
      ...queryKeys.tieredPerformanceCommissions.all(input.workspaceId),
      'draft-order-estimate', input.agentId, input.occurredAt, input.itemsKey,
      input.userId, input.permissionScope,
    ] as const,
  },
  coachData: {
    all: (workspaceId?: string) => ['atlas', 'workspace', workspaceId ?? 'unscoped', 'coach-data'] as const,
    own: (workspaceId: string, userId: string) => [
      ...queryKeys.coachData.all(workspaceId), 'own', userId,
    ] as const,
    directory: (workspaceId: string, viewerId: string) => [
      ...queryKeys.coachData.all(workspaceId), 'directory', viewerId,
    ] as const,
    selected: (workspaceId: string, viewerId: string, coachUserId: string) => [
      ...queryKeys.coachData.all(workspaceId), 'selected', viewerId, coachUserId,
    ] as const,
  },
  inventoryTransactions: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'inventory-transactions'] as const,
    page: (query: {
      workspaceId?: string
      page: number
      pageSize: number
      startAt?: string
      endBefore?: string
      productId?: string | null
      direction: string
      source: string
      storageId?: string | null
      snapshot: string
      sort: 'createdAt:desc,id:desc'
      sourceMode: 'remote' | 'local'
      viewer: { userId?: string | null; role?: string | null; storageScope: string }
    }) => [
      ...queryKeys.inventoryTransactions.all(query.workspaceId),
      'page',
      query.page,
      query.pageSize,
      query.startAt ?? null,
      query.endBefore ?? null,
      query.productId ?? null,
      query.direction,
      query.source,
      query.storageId ?? null,
      query.snapshot,
      query.sort,
      query.sourceMode,
      query.viewer.userId ?? null,
      query.viewer.role ?? null,
      query.viewer.storageScope,
    ] as const,
    productSummaryPage: (query: {
      workspaceId?: string
      page: number
      pageSize: number
      startAt?: string
      endBefore?: string
      productId?: string | null
      direction: string
      source: string
      storageId?: string | null
      snapshot: string
      sort: 'productId:asc'
      viewer: { userId?: string | null; role?: string | null; storageScope: string }
      sourceMode: 'remote' | 'local'
    }) => [
      ...queryKeys.inventoryTransactions.all(query.workspaceId),
      'product-summary',
      query.page,
      query.pageSize,
      query.startAt ?? null,
      query.endBefore ?? null,
      query.productId ?? null,
      query.direction,
      query.source,
      query.storageId ?? null,
      query.snapshot,
      query.sort,
      query.sourceMode,
      query.viewer.userId ?? null,
      query.viewer.role ?? null,
      query.viewer.storageScope,
    ] as const,
  },
  stockAdjustments: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'stock-adjustments'] as const,
    page: (
      query: StockAdjustmentPageQuery,
      sourceMode: 'remote' | 'local',
      viewer: { userId?: string | null; role?: string | null; storageScope: string },
    ) => [
      ...queryKeys.stockAdjustments.all(query.workspaceId),
      'page',
      query.page,
      query.pageSize,
      query.startAt ?? null,
      query.endBefore ?? null,
      query.productId ?? null,
      query.storageId ?? null,
      query.adjustmentType ?? null,
      query.reason ?? null,
      sourceMode,
      viewer.userId ?? null,
      viewer.role ?? null,
      viewer.storageScope,
    ] as const,
  },
  stockBatches: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'stock-batches'] as const,
    groupPage: (
      query: StockBatchGroupPageQuery,
      sourceMode: 'remote' | 'local',
      viewer: { userId?: string | null; role?: string | null; storageScope: string },
    ) => [
      ...queryKeys.stockBatches.all(query.workspaceId),
      'group-page',
      query.page,
      query.pageSize,
      query.search.trim(),
      query.searchProductIds,
      query.searchStorageIds,
      sourceMode,
      viewer.userId ?? null,
      viewer.role ?? null,
      viewer.storageScope,
    ] as const,
  },
  orders: {
    all: (workspaceId: string | undefined, orderType: OrdersListPageQuery['orderType']) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'orders', orderType] as const,
    page: (query: OrdersListPageQuery, viewer?: { isRestricted?: boolean; userId?: string }) => {
      const { refreshToken: _refreshToken, ...dataQuery } = query
      return [
        ...queryKeys.orders.all(query.workspaceId, query.orderType),
        'page',
        dataQuery,
        viewer?.isRestricted ?? false,
        viewer?.userId ?? null,
      ] as const
    },
    commissionPreview: (query: OrdersListPageQuery, viewer?: { isRestricted?: boolean; userId?: string }) => {
      const { refreshToken: _refreshToken, ...dataQuery } = query
      return [
        ...queryKeys.orders.all(query.workspaceId, query.orderType),
        'commission-preview',
        dataQuery,
        viewer?.isRestricted ?? false,
        viewer?.userId ?? null,
      ] as const
    },
  },
  ecommerce: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'ecommerce-orders'] as const,
    page: (query: MarketplaceOrderPageQuery, viewer: { userId?: string | null; role?: string | null }) => [
      ...queryKeys.ecommerce.all(query.workspaceId),
      'page',
      query.page,
      query.pageSize,
      query.search.trim(),
      query.status,
      query.createdFrom ?? null,
      query.createdBefore ?? null,
      query.sortBy,
      query.sortDirection,
      viewer.userId ?? null,
      viewer.role ?? null,
    ] as const,
    summary: (query: MarketplaceOrderSummaryQuery, viewer: { userId?: string | null; role?: string | null }) => [
      ...queryKeys.ecommerce.all(query.workspaceId),
      'summary',
      query.createdFrom ?? null,
      query.createdBefore ?? null,
      query.previousFrom ?? null,
      query.previousBefore ?? null,
      viewer.userId ?? null,
      viewer.role ?? null,
    ] as const,
    detail: (workspaceId: string | undefined, orderId: string | undefined, viewer: { userId?: string | null; role?: string | null }) => [
      ...queryKeys.ecommerce.all(workspaceId),
      'detail',
      orderId ?? null,
      viewer.userId ?? null,
      viewer.role ?? null,
    ] as const,
  },
  invoiceHistory: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'invoice-history'] as const,
    page: (query: {
      workspaceId?: string
      createdFrom?: string
      createdTo?: string
      search?: string
      page: number
      pageSize: number
      sortDirection?: 'asc' | 'desc'
      origin?: 'history' | 'upload'
      viewOwn: boolean
      userId?: string
    }) => [
      ...queryKeys.invoiceHistory.all(query.workspaceId),
      query.createdFrom ?? null,
      query.createdTo ?? null,
      query.search?.trim() ?? '',
      query.page,
      query.pageSize,
      query.sortDirection ?? 'desc',
      query.origin ?? 'history',
      query.viewOwn,
      query.userId ?? null,
    ] as const,
  },
  businessPartners: {
    all: (workspaceId: string | undefined) =>
      ['atlas', 'workspace', workspaceId ?? 'unscoped', 'business-partners'] as const,
    summary: (workspaceId: string | undefined, partnerId: string | undefined, viewer: {
      userId?: string | null; role?: string | null; featureEnabled: boolean; groupVisibilityScope?: string
    }) => [
      ...queryKeys.businessPartners.all(workspaceId), 'summary', partnerId ?? null,
      viewer.userId ?? null, viewer.role ?? null, viewer.featureEnabled, viewer.groupVisibilityScope ?? null,
    ] as const,
    duplicates: (
      workspaceId: string | undefined,
      input: { name: string; phone: string; excludeBusinessPartnerId?: string },
      viewer: { featureEnabled: boolean; role?: string | null; userId?: string | null },
    ) => [
      ...queryKeys.businessPartners.all(workspaceId),
      'duplicates',
      input.name,
      input.phone,
      input.excludeBusinessPartnerId ?? null,
      viewer.featureEnabled,
      viewer.role ?? null,
      viewer.userId ?? null,
    ] as const,
    directoryPage: (
      workspaceId: string | undefined,
      options: Record<string, unknown>,
      viewer: { featureEnabled: boolean; role?: string | null; userId?: string | null; groupVisibilityScope?: string },
    ) => [
      ...queryKeys.businessPartners.all(workspaceId),
      'directory-page',
      options,
      viewer.featureEnabled,
      viewer.role ?? null,
      viewer.userId ?? null,
      viewer.groupVisibilityScope ?? null,
    ] as const,
  },
} as const

