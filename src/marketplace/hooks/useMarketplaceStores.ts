import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
    getMarketplaceStores,
    type MarketplaceStoreSummary,
    type MarketplaceLanguage
} from '../lib/marketplaceApi'

export function useMarketplaceStores(search = '') {
    const { i18n } = useTranslation()
    const [stores, setStores] = useState<MarketplaceStoreSummary[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
    const loadMoreInFlight = useRef(false)
    const requestGeneration = useRef(0)
    const language = (i18n.language || 'en') as MarketplaceLanguage
    const normalizedSearch = search.trim()

    useEffect(() => {
        let isCancelled = false
        const generation = ++requestGeneration.current

        const load = async () => {
            setIsLoading(true)
            setError(null)

            try {
                const result = await getMarketplaceStores({
                    language,
                    search: normalizedSearch,
                    signal: controller.signal
                })
                if (!isCancelled && generation === requestGeneration.current) {
                    setStores(result.stores)
                    setHasMore(result.has_more)
                    setNextCursor(result.next_cursor)
                }
            } catch (fetchError) {
                if (!isCancelled && generation === requestGeneration.current && !(fetchError instanceof DOMException && fetchError.name === 'AbortError')) {
                    setError(fetchError instanceof Error ? fetchError.message : 'Failed to load marketplace stores')
                }
            } finally {
                if (!isCancelled && generation === requestGeneration.current) {
                    setIsLoading(false)
                }
            }
        }

        const controller = new AbortController()
        setStores([])
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
    }, [language, normalizedSearch])

    const loadMore = useCallback(async () => {
        if (!hasMore || !nextCursor || loadMoreInFlight.current) {
            return
        }

        loadMoreInFlight.current = true
        const generation = requestGeneration.current
        setIsLoadingMore(true)
        setLoadMoreError(null)

        try {
            const result = await getMarketplaceStores({
                language,
                search: normalizedSearch,
                cursor: nextCursor
            })
            if (generation !== requestGeneration.current) return
            setStores((currentStores) => {
                const knownSlugs = new Set(currentStores.map((store) => store.slug))
                return [...currentStores, ...result.stores.filter((store) => !knownSlugs.has(store.slug))]
            })
            setHasMore(result.has_more)
            setNextCursor(result.next_cursor)
        } catch (fetchError) {
            if (generation === requestGeneration.current) {
                setLoadMoreError(fetchError instanceof Error ? fetchError.message : 'Failed to load more marketplace stores')
            }
        } finally {
            if (generation === requestGeneration.current) {
                loadMoreInFlight.current = false
                setIsLoadingMore(false)
            }
        }
    }, [hasMore, language, nextCursor, normalizedSearch])

    return {
        stores,
        isLoading,
        isLoadingMore,
        hasMore,
        error,
        loadMoreError,
        loadMore
    }
}
