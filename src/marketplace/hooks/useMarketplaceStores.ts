import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
    getMarketplaceStores,
    type MarketplaceStoreSummary,
    type MarketplaceLanguage
} from '../lib/marketplaceApi'

export function useMarketplaceStores() {
    const { i18n } = useTranslation()
    const [stores, setStores] = useState<MarketplaceStoreSummary[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let isCancelled = false

        const load = async () => {
            setIsLoading(true)
            setError(null)

            try {
                const result = await getMarketplaceStores((i18n.language || 'en') as MarketplaceLanguage)
                if (!isCancelled) {
                    setStores(result)
                }
            } catch (fetchError) {
                if (!isCancelled) {
                    setError(fetchError instanceof Error ? fetchError.message : 'Failed to load marketplace stores')
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false)
                }
            }
        }

        load()

        return () => {
            isCancelled = true
        }
    }, [i18n.language])

    return {
        stores,
        isLoading,
        error
    }
}
