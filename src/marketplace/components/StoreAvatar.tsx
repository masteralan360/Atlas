import { useEffect, useState } from 'react'
import { Store } from 'lucide-react'

import { cn } from '@/lib/utils'

import { getMarketplaceAssetUrl } from '../lib/assets'

type StoreAvatarProps = {
    logoUrl?: string | null
    name: string
    className?: string
    imageClassName?: string
    iconClassName?: string
}

export function StoreAvatar({
    logoUrl,
    name,
    className,
    imageClassName,
    iconClassName
}: StoreAvatarProps) {
    const resolvedLogoUrl = getMarketplaceAssetUrl(logoUrl)
    const [hasImageError, setHasImageError] = useState(false)

    useEffect(() => {
        setHasImageError(false)
    }, [resolvedLogoUrl])

    return (
        <div className={cn('flex items-center justify-center overflow-hidden rounded-3xl bg-primary/10 text-primary ring-1 ring-primary/15', className)}>
            {resolvedLogoUrl && !hasImageError ? (
                <img
                    src={resolvedLogoUrl}
                    alt={`${name} logo`}
                    className={cn('h-full w-full object-contain p-3', imageClassName)}
                    loading="lazy"
                    onError={() => setHasImageError(true)}
                />
            ) : (
                <Store className={cn('h-7 w-7', iconClassName)} />
            )}
        </div>
    )
}
