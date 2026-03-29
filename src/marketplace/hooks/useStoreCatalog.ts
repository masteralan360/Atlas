import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
    getStoreCatalog,
    type MarketplaceLanguage,
    type MarketplaceStoreCatalog
} from '../lib/marketplaceApi'

export function useStoreCatalog(slug: string) {
    const { i18n } = useTranslation()
    const [catalog, setCatalog] = useState<MarketplaceStoreCatalog | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!slug) {
            setCatalog(null)
            setIsLoading(false)
            setError(null)
            return
        }

        let isCancelled = false

        const load = async () => {
            setIsLoading(true)
            setError(null)

            try {
                const result = await getStoreCatalog(slug, (i18n.language || 'en') as MarketplaceLanguage)
                if (!isCancelled) {
                    setCatalog(result)
                }
            } catch (fetchError) {
                if (!isCancelled) {
                    setCatalog(null)
                    setError(fetchError instanceof Error ? fetchError.message : 'Failed to load store catalog')
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
    }, [i18n.language, slug])

    return {
        catalog,
        isLoading,
        error
    }
}
