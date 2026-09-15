import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface AutocompleteLoadingIndicatorProps {
    isLoading: boolean
}

export function AutocompleteLoadingIndicator({ isLoading }: AutocompleteLoadingIndicatorProps) {
    const { t } = useTranslation()

    if (!isLoading) return null

    return (
        <span className="inline-flex items-center" role="status">
            <span className="sr-only">{t('common.loading')}</span>
            <span className="inline-flex animate-spin" aria-hidden="true">
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
        </span>
    )
}
