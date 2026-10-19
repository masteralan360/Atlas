import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'

export interface UsePaginationStateOptions {
  initialPage?: number
  initialPageSize?: number
  resetOn?: readonly unknown[]
  onPageSizeChange?: (pageSize: number) => void
}

/** Shared page and page-size state for Atlas list views. */
export function usePaginationState({
  initialPage = 1,
  initialPageSize = 20,
  resetOn = [],
  onPageSizeChange,
}: UsePaginationStateOptions = {}) {
  const resetKey = JSON.stringify(resetOn)
  const [state, setState] = useState(() => ({
    page: Math.max(1, Math.floor(initialPage)),
    pageSize: Math.max(1, Math.floor(initialPageSize)),
    resetKey,
  }))
  const hasReset = state.resetKey !== resetKey
  const currentPage = hasReset ? 1 : state.page

  useEffect(() => {
    if (!hasReset) return
    setState((current) => ({ ...current, page: 1, resetKey }))
  }, [hasReset, resetKey])

  const setCurrentPage = useCallback((nextPage: SetStateAction<number>) => {
    setState((current) => {
      const basePage = current.resetKey === resetKey ? current.page : 1
      const value = typeof nextPage === 'function' ? nextPage(basePage) : nextPage
      return { ...current, page: Math.max(1, Math.floor(value)), resetKey }
    })
  }, [resetKey])

  const setPageSize = useCallback((nextPageSize: number) => {
    const normalizedPageSize = Math.max(1, Math.floor(nextPageSize))
    onPageSizeChange?.(normalizedPageSize)
    setState((current) => ({
      ...current,
      page: 1,
      pageSize: normalizedPageSize,
      resetKey,
    }))
  }, [onPageSizeChange, resetKey])

  const resetPage = useCallback(() => setCurrentPage(1), [setCurrentPage])

  return {
    currentPage,
    pageSize: state.pageSize,
    setCurrentPage,
    setPageSize,
    resetPage,
  }
}

export interface UsePaginationPageMapOptions<TKey extends string> {
  initialPages: Record<TKey, number>
  initialPageSize?: number
  resetOn?: readonly unknown[]
  onPageSizeChange?: (pageSize: number) => void
}

/** Shared state for views that keep an independent page per tab or subsection. */
export function usePaginationPageMap<TKey extends string>({
  initialPages,
  initialPageSize = 20,
  resetOn = [],
  onPageSizeChange,
}: UsePaginationPageMapOptions<TKey>) {
  const resetKey = JSON.stringify(resetOn)
  const normalizedInitialPages = useMemo(() => Object.fromEntries(
    Object.entries(initialPages).map(([key, page]) => [key, Math.max(1, Math.floor(page as number))]),
  ) as Record<TKey, number>, [initialPages])
  const [state, setState] = useState(() => ({
    pages: normalizedInitialPages,
    pageSize: Math.max(1, Math.floor(initialPageSize)),
    resetKey,
  }))
  const hasReset = state.resetKey !== resetKey
  const pages = hasReset ? normalizedInitialPages : state.pages

  useEffect(() => {
    if (!hasReset) return
    setState((current) => ({ ...current, pages: normalizedInitialPages, resetKey }))
  }, [hasReset, normalizedInitialPages, resetKey])

  const setPage = useCallback((key: TKey, nextPage: SetStateAction<number>) => {
    setState((current) => {
      const currentPages = current.resetKey === resetKey ? current.pages : normalizedInitialPages
      const basePage = currentPages[key] ?? 1
      const value = typeof nextPage === 'function' ? nextPage(basePage) : nextPage
      return {
        ...current,
        pages: { ...currentPages, [key]: Math.max(1, Math.floor(value)) },
        resetKey,
      }
    })
  }, [normalizedInitialPages, resetKey])

  const setPageSize = useCallback((nextPageSize: number) => {
    const normalizedPageSize = Math.max(1, Math.floor(nextPageSize))
    onPageSizeChange?.(normalizedPageSize)
    setState((current) => ({
      ...current,
      pages: normalizedInitialPages,
      pageSize: normalizedPageSize,
      resetKey,
    }))
  }, [normalizedInitialPages, onPageSizeChange, resetKey])

  return { pages, pageSize: state.pageSize, setPage, setPageSize }
}

export interface UsePaginationBoundsOptions {
  currentPage: number
  setCurrentPage: (page: number | ((page: number) => number)) => void
  totalCount?: number
  pageSize?: number
  pageCount?: number
  isLoading?: boolean
  error?: unknown
}

export function clampPaginationPage(currentPage: number, pageCount: number) {
  return Math.min(Math.max(1, Math.floor(currentPage)), Math.max(1, Math.floor(pageCount)))
}

/**
 * Applies shared page-count and clamping behavior once a data source responds.
 * During a pending/error response it keeps the selected page and last known
 * page count, preventing remote pagination from snapping to page 1.
 */
export function usePaginationBounds({
  currentPage,
  setCurrentPage,
  totalCount = 0,
  pageSize = 20,
  pageCount: providedPageCount,
  isLoading = false,
  error = null,
}: UsePaginationBoundsOptions) {
  const calculatedPageCount = Math.max(1, Math.floor(providedPageCount ?? Math.ceil(Math.max(0, totalCount) / Math.max(1, pageSize))))
  const resultIsSettled = !isLoading && error == null
  const lastResolvedPageCount = useRef<number | null>(null)
  if (resultIsSettled) lastResolvedPageCount.current = calculatedPageCount

  const pageCount = resultIsSettled
    ? calculatedPageCount
    : lastResolvedPageCount.current ?? calculatedPageCount
  const activePage = resultIsSettled
    ? clampPaginationPage(currentPage, calculatedPageCount)
    : currentPage

  useEffect(() => {
    if (resultIsSettled && currentPage !== activePage) setCurrentPage(activePage)
  }, [activePage, currentPage, resultIsSettled, setCurrentPage])

  return { currentPage: activePage, pageCount }
}
