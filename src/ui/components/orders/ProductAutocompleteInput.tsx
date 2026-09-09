import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, GitBranch, Package } from 'lucide-react'

import { useProductSelectionAccess, type Product } from '@/local-db'
import { useOptionalAuth } from '@/auth'
import { Input, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/components'
import { cn } from '@/lib/utils'
import { platformService } from '@/services/platformService'

interface ProductAutocompleteInputProps {
    value: string
    onChange: (value: string) => void
    onSelectProduct: (product: Product) => void
    products: Product[]
    placeholder?: string
    className?: string
    inputClassName?: string
    disabled?: boolean
    hasSelection?: boolean
    linkedLabel?: string
    linkedTooltip?: string
    showLinkedIndicator?: boolean
    skuLabel?: string
    storageMissing?: boolean
    onStorageMissingClick?: () => void
    storageMissingLabel?: string
    scannerTargetIndex?: number
}

function getDisplayImageUrl(url?: string): string {
    if (!url) return ''
    if (url.startsWith('http')) return url
    if (url.startsWith('data:')) return url
    return platformService.convertFileSrc(url)
}

function ProductThumbnail({ url, name }: { url?: string; name: string }) {
    const [loadError, setLoadError] = useState(false)

    if (!url || loadError) {
        return (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted/40">
                <Package className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="h-7 w-7 shrink-0 overflow-hidden rounded bg-muted/30">
            <img
                src={getDisplayImageUrl(url)}
                alt={name}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
                onError={() => setLoadError(true)}
            />
        </div>
    )
}

export function ProductAutocompleteInput({
    value,
    onChange,
    onSelectProduct,
    products,
    placeholder,
    className,
    inputClassName,
    disabled,
    hasSelection,
    linkedLabel = 'Linked',
    linkedTooltip,
    showLinkedIndicator = true,
    skuLabel = 'SKU',
    storageMissing,
    onStorageMissingClick,
    storageMissingLabel = 'Select Storage',
    scannerTargetIndex
}: ProductAutocompleteInputProps) {
    const { i18n, t } = useTranslation()
    const user = useOptionalAuth()?.user
    const { canSelectProduct, filterProducts } = useProductSelectionAccess(user?.workspaceId, user?.id)
    const [isFocused, setIsFocused] = useState(false)
    const [justSelected, setJustSelected] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    const query = value.trim().toLowerCase()
    const selectableProducts = useMemo(
        () => filterProducts(products),
        [filterProducts, products]
    )
    const productById = useMemo(
        () => new Map(products.map((product) => [product.id, product] as const)),
        [products]
    )

    const filtered = useMemo(() => {
        if (!query || query.length < 1) return []

        const families = new Map<string, Product[]>()
        for (const product of selectableProducts) {
            const familyId = product.parentProductId || product.id
            const members = families.get(familyId) ?? []
            members.push(product)
            families.set(familyId, members)
        }

        return Array.from(families.entries())
            .filter(([, members]) => members.some((product) => (
                product.name.toLowerCase().includes(query)
                || (product.sku && product.sku.toLowerCase().includes(query))
            )))
            .flatMap(([familyId, members]) => {
                const primaryIndex = members.findIndex((product) => product.id === familyId)
                if (primaryIndex <= 0) {
                    return members
                }

                return [
                    members[primaryIndex],
                    ...members.slice(0, primaryIndex),
                    ...members.slice(primaryIndex + 1)
                ]
            })
    }, [query, selectableProducts])

    const showDropdown = isFocused && !justSelected && filtered.length > 0
    const shouldShowLinkedIndicator = Boolean(hasSelection && !storageMissing && showLinkedIndicator)

    const handleSelect = useCallback((product: Product) => {
        if (!canSelectProduct(product)) {
            return
        }
        setJustSelected(true)
        onChange(product.name)
        onSelectProduct(product)
    }, [canSelectProduct, onChange, onSelectProduct])

    useEffect(() => {
        if (justSelected) {
            const timeout = setTimeout(() => setJustSelected(false), 200)
            return () => clearTimeout(timeout)
        }
    }, [justSelected])

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsFocused(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const handleFocus = () => {
        if (storageMissing) {
            onStorageMissingClick?.()
            return
        }
        setIsFocused(true)
    }

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (storageMissing) {
            onStorageMissingClick?.()
            return
        }
        setJustSelected(false)
        setIsFocused(true)
        onChange(e.target.value)
    }

    const linkedIndicator = (
        <div
            tabIndex={linkedTooltip ? 0 : undefined}
            aria-label={linkedLabel}
            className={cn(
                'absolute right-2 top-1/2 max-w-24 -translate-y-1/2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
                linkedTooltip && 'cursor-help'
            )}
        >
            <span className="flex min-w-0 items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
                <Check className="h-3 w-3 shrink-0" />
                <span className="truncate">{linkedLabel}</span>
            </span>
        </div>
    )

    return (
        <div ref={containerRef} className={cn('relative w-full group', className)}>
            <div className="relative">
                <Input
                    value={value}
                    onChange={handleInputChange}
                    onFocus={handleFocus}
                    data-order-product-input={scannerTargetIndex === undefined ? undefined : 'true'}
                    data-order-product-index={scannerTargetIndex}
                    placeholder={placeholder}
                    disabled={disabled}
                    className={cn(
                        'flex-1',
                        inputClassName,
                        shouldShowLinkedIndicator && 'pr-28',
                        hasSelection && !storageMissing && 'border-green-500/50 bg-green-50/30 dark:bg-green-950/10',
                        storageMissing && 'border-red-500/50 bg-red-50/30 dark:bg-red-950/10'
                    )}
                />
                {shouldShowLinkedIndicator && (
                    linkedTooltip ? (
                        <TooltipProvider delayDuration={150}>
                            <Tooltip>
                                <TooltipTrigger asChild>{linkedIndicator}</TooltipTrigger>
                                <TooltipContent side="top" align="end" className="max-w-xs break-words text-xs">
                                    {linkedTooltip}
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    ) : linkedIndicator
                )}
                {storageMissing && (
                    <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                            <AlertTriangle className="h-3 w-3" />
                            {i18n.language?.startsWith('ar') || i18n.language?.startsWith('ku') ? null : storageMissingLabel}
                        </span>
                    </div>
                )}
            </div>
            {showDropdown ? (
                <div className="absolute start-0 top-full z-[100] mt-1 max-h-56 w-max min-w-full overflow-y-auto rounded-xl border bg-popover shadow-lg">
                    {filtered.map((product) => (
                        <button
                            key={product.id}
                            type="button"
                            className="flex w-full min-w-[18rem] items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
                            onMouseDown={(e) => {
                                e.preventDefault()
                                handleSelect(product)
                            }}
                        >
                            <ProductThumbnail url={product.imageUrl} name={product.name} />
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5"><span className="break-words font-medium">{product.name}</span>{product.parentProductId && <span className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary"><GitBranch className="h-3 w-3" />{t('products.variants.variant', { defaultValue: 'Variant' })}</span>}</div>
                                {product.sku ? (
                                    <div className="break-words text-xs text-muted-foreground">{skuLabel}: {product.sku}</div>
                                ) : null}
                                {product.parentProductId && productById.get(product.parentProductId) && (
                                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{t('products.variants.variantOf', { defaultValue: 'Variant of' })}: {productById.get(product.parentProductId)?.name}</div>
                                )}
                            </div>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
