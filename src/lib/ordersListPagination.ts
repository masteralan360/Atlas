export const ORDERS_PAGE_SIZE_STORAGE_KEY = 'orders_page_size'
export const ORDERS_PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100] as const
export const DEFAULT_ORDERS_PAGE_SIZE = 20

export type OrdersPaginationState = {
    currentPage: number
    pageSize: number
}

export type OrdersPage<T> = {
    currentPage: number
    totalPages: number
    rows: T[]
}

function normalizePageSize(pageSize: number): number {
    return ORDERS_PAGE_SIZE_OPTIONS.includes(pageSize as typeof ORDERS_PAGE_SIZE_OPTIONS[number])
        ? pageSize
        : DEFAULT_ORDERS_PAGE_SIZE
}

export function createOrdersPaginationState(storedPageSize: string | null): OrdersPaginationState {
    return {
        currentPage: 1,
        pageSize: normalizePageSize(Number(storedPageSize))
    }
}

export function resetOrdersPagination(state: OrdersPaginationState): OrdersPaginationState {
    return state.currentPage === 1 ? state : { ...state, currentPage: 1 }
}

export function setOrdersPage(state: OrdersPaginationState, page: number): OrdersPaginationState {
    const currentPage = Math.max(1, Math.floor(page) || 1)
    return state.currentPage === currentPage ? state : { ...state, currentPage }
}

export function setOrdersPageSize(state: OrdersPaginationState, pageSize: number): OrdersPaginationState {
    const nextPageSize = normalizePageSize(pageSize)
    if (state.currentPage === 1 && state.pageSize === nextPageSize) return state
    return {
        currentPage: 1,
        pageSize: nextPageSize
    }
}

export function clampOrdersPagination(state: OrdersPaginationState, totalCount: number): OrdersPaginationState {
    const totalPages = Math.max(1, Math.ceil(Math.max(0, totalCount) / state.pageSize))
    const currentPage = Math.min(state.currentPage, totalPages)
    return state.currentPage === currentPage ? state : { ...state, currentPage }
}

export function paginateOrders<T>(rows: readonly T[], state: OrdersPaginationState): OrdersPage<T> {
    const clampedState = clampOrdersPagination(state, rows.length)
    const totalPages = Math.ceil(rows.length / clampedState.pageSize)
    const from = (clampedState.currentPage - 1) * clampedState.pageSize

    return {
        currentPage: clampedState.currentPage,
        totalPages,
        rows: rows.slice(from, from + clampedState.pageSize)
    }
}
