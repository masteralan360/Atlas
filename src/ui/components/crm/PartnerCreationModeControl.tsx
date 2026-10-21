import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/ui/components/button'
import { cn } from '@/lib/utils'

interface PartnerCreationModeControlProps {
    active: boolean
    onStop: () => void
    disabled?: boolean
    className?: string
}

export function PartnerCreationModeControl({ active, onStop, disabled, className }: PartnerCreationModeControlProps) {
    const { t } = useTranslation()

    if (!active) return null

    return (
        <div className={cn('flex justify-end', className)}>
            <Button type="button" variant="ghost" size="sm" className="gap-2 text-muted-foreground" onClick={onStop} disabled={disabled}>
                <X className="h-4 w-4" />
                {t('businessPartners.stopPartnerCreation')}
            </Button>
        </div>
    )
}
