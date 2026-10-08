import { useEffect, useRef, useState } from 'react'
import { Package } from 'lucide-react'

import { cn } from '@/lib/utils'
import { getProductImageDisplayUrl } from '@/lib/productImageStorage'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/components/ui/tooltip'

export type ProductMosaicItem = {
    productId: string
    productName: string
    imageUrl?: string | null
}

function getProductImageSource(imageUrl?: string | null) {
    return getProductImageDisplayUrl(imageUrl)
}

export function ProductMosaic({ items }: { items: ProductMosaicItem[] }) {
    const [failedProductIds, setFailedProductIds] = useState<Set<string>>(() => new Set())
    const products = Array.from(new Map(items.map((item) => [item.productId, item])).values()).slice(0, 4)
    const layoutClass = products.length === 1
        ? 'grid-cols-1 grid-rows-1'
        : products.length === 2
            ? 'grid-cols-2 grid-rows-1'
            : 'grid-cols-2 grid-rows-2'

    return (
        <div
            className={cn('grid h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40', layoutClass)}
            title={products.map((item) => item.productName).join(', ')}
            aria-label={products.map((item) => item.productName).join(', ')}
        >
            {products.map((item, index) => {
                const imageSource = getProductImageSource(item.imageUrl)
                const hasImage = Boolean(imageSource && !failedProductIds.has(item.productId))
                const hasStartDivider = products.length === 2
                    ? index === 1
                    : products.length === 3
                        ? index > 0
                        : index === 1 || index === 3
                const hasTopDivider = products.length > 2 && index >= 2

                return (
                    <div
                        key={item.productId}
                        className={cn(
                            'relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-muted',
                            products.length === 3 && index === 0 && 'row-span-2',
                            hasStartDivider && 'border-s border-border',
                            hasTopDivider && 'border-t border-border'
                        )}
                    >
                        {hasImage ? (
                            <img
                                src={imageSource}
                                alt={item.productName}
                                loading="lazy"
                                decoding="async"
                                className="h-full w-full object-cover"
                                onError={() => setFailedProductIds((current) => new Set(current).add(item.productId))}
                            />
                        ) : (
                            <Package className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        )}
                    </div>
                )
            })}
        </div>
    )
}

export function ProductAvatar({
    productName,
    imageUrl,
    className,
    imageClassName,
    fallbackIconClassName,
    showImagePreviewOnHover = false,
    previewSide = 'right'
}: {
    productName: string
    imageUrl?: string | null
    className?: string
    imageClassName?: string
    fallbackIconClassName?: string
    showImagePreviewOnHover?: boolean
    previewSide?: 'left' | 'right'
}) {
    const [imageFailed, setImageFailed] = useState(false)
    const [collisionBoundary, setCollisionBoundary] = useState<HTMLElement | null>(null)
    const avatarRef = useRef<HTMLDivElement>(null)
    const imageSource = getProductImageSource(imageUrl)
    const hasImage = Boolean(imageSource && !imageFailed)

    useEffect(() => {
        if (!showImagePreviewOnHover) return

        const pageContent = avatarRef.current?.closest('main')
        setCollisionBoundary(pageContent instanceof HTMLElement ? pageContent : null)
    }, [showImagePreviewOnHover])

    const avatar = (
        <div
            ref={avatarRef}
            className={cn('relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40', className)}
            title={showImagePreviewOnHover && hasImage ? undefined : productName}
            aria-label={productName}
        >
            {hasImage ? (
                <img
                    src={imageSource}
                    alt={productName}
                    loading="lazy"
                    decoding="async"
                    className={cn('h-full w-full object-cover', imageClassName)}
                    onError={() => setImageFailed(true)}
                />
            ) : (
                <Package className={cn('h-3.5 w-3.5 text-muted-foreground', fallbackIconClassName)} aria-hidden="true" />
            )}
        </div>
    )

    if (!showImagePreviewOnHover || !hasImage || !imageSource) return avatar

    return (
        <TooltipProvider delayDuration={250}>
            <Tooltip>
                <TooltipTrigger asChild>{avatar}</TooltipTrigger>
                <TooltipContent
                    side={previewSide}
                    sideOffset={8}
                    collisionBoundary={collisionBoundary ?? undefined}
                    collisionPadding={12}
                    className="overflow-visible rounded-none border-0 bg-transparent p-0 shadow-none"
                >
                    <div className="overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
                        <img
                            src={imageSource}
                            alt={productName}
                            loading="lazy"
                            decoding="async"
                            className="h-52 w-52 rounded-lg object-cover"
                            onError={() => setImageFailed(true)}
                        />
                    </div>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    )
}
