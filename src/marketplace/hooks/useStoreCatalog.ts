import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
    getStoreCatalog,
    type MarketplaceLanguage,
    type MarketplaceCatalogQuery,
    type MarketplaceStoreCatalog
} from '../lib/marketplaceApi'

function mergeCatalogPage(current: MarketplaceStoreCatalog | null, incoming: MarketplaceStoreCatalog) {
    if (!current) {
        return incoming
    }

    const knownProductIds = new Set(current.products.map((product) => product.id))
    return {
        ...incoming,
        categories: incoming.categories.length > 0 ? incoming.categories : current.categories,
        products: [...current.products, ...incoming.products.filter((product) => !knownProductIds.has(product.id))]
    }
}

export function useStoreCatalog(slug: string, query: MarketplaceCatalogQuery = {}) {
    const { i18n } = useTranslation()
    const [catalog, setCatalog] = useState<MarketplaceStoreCatalog | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
    const loadMoreInFlight = useRef(false)
    const requestGeneration = useRef(0)
    const language = (i18n.language || 'en') as MarketplaceLanguage
    const queryKey = JSON.stringify({
        search: query.search?.trim() || '',
        categoryId: query.categoryId || null,
        sort: query.sort || 'featured',
        priceMax: query.priceMax ?? null,
        currency: query.currency?.toLowerCase() || null,
        includeProducts: query.includeProducts !== false
    })

    useEffect(() => {
        if (!slug) {
            setCatalog(null)
            setIsLoading(false)
            setIsLoadingMore(false)
            setHasMore(false)
            setNextCursor(null)
            setError(null)
            return
        }

        let isCancelled = false
        const generation = ++requestGeneration.current
        const controller = new AbortController()
        const parsedQuery = JSON.parse(queryKey) as MarketplaceCatalogQuery

        const load = async () => {
            setIsLoading(true)
            setError(null)

            try {
                const result = await getStoreCatalog({
                    slug,
                    language,
                    query: parsedQuery,
                    signal: controller.signal
                })
                if (!isCancelled && generation === requestGeneration.current) {
                    setCatalog(result)
                    setHasMore(result.has_more)
                    setNextCursor(result.next_cursor)
                }
            } catch (fetchError) {
                if (!isCancelled && generation === requestGeneration.current && !(fetchError instanceof DOMException && fetchError.name === 'AbortError')) {
                    setCatalog(null)
                    setError(fetchError instanceof Error ? fetchError.message : 'Failed to load store catalog')
                }
            } finally {
                if (!isCancelled && generation === requestGeneration.current) {
                    setIsLoading(false)
                }
            }
        }

        setCatalog(null)
        setHasMore(false)
        setNextCursor(null)
        setLoadMoreError(null)
        setIsLoadingMore(false)
        loadMoreInFlight.current = false
        load()

        return () => {
            isCancelled = true
            controller.abort()
        }
    }, [language, queryKey, slug])

    const loadMore = useCallback(async () => {
        if (!hasMore || !nextCursor || loadMoreInFlight.current || !slug) {
            return
        }

        loadMoreInFlight.current = true
        const generation = requestGeneration.current
        setIsLoadingMore(true)
        setLoadMoreError(null)

        try {
            const result = await getStoreCatalog({
                slug,
                language,
                cursor: nextCursor,
                query: JSON.parse(queryKey) as MarketplaceCatalogQuery
            })
            if (generation !== requestGeneration.current) return
            setCatalog((current) => mergeCatalogPage(current, result))
            setHasMore(result.has_more)
            setNextCursor(result.next_cursor)
        } catch (fetchError) {
            if (generation === requestGeneration.current) {
                setLoadMoreError(fetchError instanceof Error ? fetchError.message : 'Failed to load more products')
            }
        } finally {
            if (generation === requestGeneration.current) {
                loadMoreInFlight.current = false
                setIsLoadingMore(false)
            }
        }
    }, [hasMore, language, nextCursor, queryKey, slug])

    return {
        catalog,
        isLoading,
        isLoadingMore,
        hasMore,
        error,
        loadMoreError,
        loadMore
    }
}
