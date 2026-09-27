import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Plus, RefreshCw, Store, Trash2 } from 'lucide-react'

import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import type { PriceBook } from '@/local-db'
import type { Storage } from '@/local-db/models'
import {
    Button,
    DeleteConfirmationModal,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    useToast
} from '@/ui/components'
import { cn } from '@/lib/utils'
import {
    canAddAdditionalMarketplaceStorefront,
    createAdditionalMarketplaceStorefront,
    fetchAdditionalMarketplaceStorefronts,
    isAdditionalMarketplaceStorefrontSlugAvailable,
    MAX_ADDITIONAL_STOREFRONTS,
    removeAdditionalMarketplaceStorefront,
    saveAdditionalMarketplaceStorefront,
    type AdditionalMarketplaceStorefront,
    type AdditionalMarketplaceStorefrontDraft
} from '@/services/marketplaceStorefrontRequests'
import {
    getRetriableActionToast,
    isRetriableWebRequestError,
    normalizeSupabaseActionError,
    runSupabaseAction
} from '@/lib/supabaseRequest'
import { StorefrontCatalogRulesEditor } from './StorefrontCatalogRulesEditor'

type AdditionalStorefrontsManagerProps = {
    workspaceId: string | null
    marketplaceBaseOrigin: string
    canManage: boolean
    priceBooks: PriceBook[]
    storages: Storage[]
    disabled?: boolean
}

type SlugStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid'

const storefrontSlugPattern = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function isStorefrontLimitError(error: unknown) {
    const normalized = normalizeSupabaseActionError(error)
    return normalized.message.toLowerCase().includes('five additional storefronts')
}

function AdditionalStorefrontCard({
    workspaceId,
    storefront,
    index,
    priceBooks,
    storages,
    marketplaceBaseOrigin,
    disabled,
    onSaved,
    onRemoved
}: {
    workspaceId: string
    storefront: AdditionalMarketplaceStorefront
    index: number
    priceBooks: PriceBook[]
    storages: Storage[]
    marketplaceBaseOrigin: string
    disabled: boolean
    onSaved: (storefront: AdditionalMarketplaceStorefront) => void
    onRemoved: (storefrontId: string) => void
}) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const [visibility, setVisibility] = useState<AdditionalMarketplaceStorefront['visibility']>(storefront.visibility)
    const [slug, setSlug] = useState(storefront.slug)
    const [description, setDescription] = useState(storefront.description ?? '')
    const [slugStatus, setSlugStatus] = useState<SlugStatus>('idle')
    const [isActionPending, setIsActionPending] = useState(false)
    const [isRemoveConfirmOpen, setIsRemoveConfirmOpen] = useState(false)

    const normalizedSlug = useMemo(() => slug
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .slice(0, 40), [slug])

    const storefrontPreviewUrl = normalizedSlug && marketplaceBaseOrigin
        ? `${marketplaceBaseOrigin}/s/${normalizedSlug}`
        : ''

    const showActionError = useCallback((error: unknown, fallbackDescription: string) => {
        const normalized = normalizeSupabaseActionError(error)
        if (isRetriableWebRequestError(normalized)) {
            const message = getRetriableActionToast(normalized)
            toast({ title: message.title, description: message.description, variant: 'destructive' })
            return
        }

        toast({
            title: t('common.error') || 'Error',
            description: fallbackDescription || normalized.message,
            variant: 'destructive'
        })
    }, [t, toast])

    useEffect(() => {
        setVisibility(storefront.visibility)
        setSlug(storefront.slug)
        setDescription(storefront.description ?? '')
    }, [storefront.description, storefront.id, storefront.slug, storefront.visibility])

    useEffect(() => {
        if (disabled || !workspaceId) {
            setSlugStatus('idle')
            return
        }
        if (!normalizedSlug) {
            setSlugStatus('idle')
            return
        }
        if (!storefrontSlugPattern.test(normalizedSlug)) {
            setSlugStatus('invalid')
            return
        }
        if (normalizedSlug === storefront.slug) {
            setSlugStatus('available')
            return
        }

        let cancelled = false
        setSlugStatus('checking')
        const timer = setTimeout(async () => {
            try {
                const available = await runSupabaseAction('settings.checkStorefrontSlug', () =>
                    isAdditionalMarketplaceStorefrontSlugAvailable(normalizedSlug, storefront.id, supabase),
                { timeoutMs: 12000, platform: 'all' })
                if (!cancelled) setSlugStatus(available ? 'available' : 'taken')
            } catch {
                if (!cancelled) setSlugStatus('idle')
            }
        }, 350)

        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [disabled, normalizedSlug, storefront.id, storefront.slug, workspaceId])

    const handleSave = async () => {
        if (disabled || isActionPending) return
        if ((visibility === 'public' || visibility === 'link_only') && !normalizedSlug) {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.secondaryStorefrontSlugRequired', {
                    defaultValue: 'Set a store slug before publishing this storefront'
                }),
                variant: 'destructive'
            })
            return
        }
        if (normalizedSlug && !storefrontSlugPattern.test(normalizedSlug)) {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.slugInvalid', {
                    defaultValue: 'Only lowercase letters, numbers, and hyphens allowed'
                }),
                variant: 'destructive'
            })
            return
        }
        if (normalizedSlug && slugStatus === 'taken') {
            toast({
                title: t('common.error') || 'Error',
                description: t('settings.marketplace.slugTaken', { defaultValue: 'This slug is already taken' }),
                variant: 'destructive'
            })
            return
        }

        setIsActionPending(true)
        try {
            const draft: AdditionalMarketplaceStorefrontDraft = {
                visibility,
                slug: normalizedSlug,
                description: description.trim() || null
            }
            const savedStorefront = await runSupabaseAction('settings.saveSecondaryStorefront', () =>
                saveAdditionalMarketplaceStorefront(workspaceId, storefront.id, draft, supabase),
            { timeoutMs: 12000, platform: 'all' })
            onSaved(savedStorefront)
            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.secondaryStorefrontSaved', {
                    defaultValue: 'Storefront updated successfully.'
                })
            })
        } catch (error) {
            showActionError(error, t('settings.marketplace.secondaryStorefrontSaveError', {
                defaultValue: 'Failed to update the additional storefront.'
            }))
        } finally {
            setIsActionPending(false)
        }
    }

    const handleRemove = async () => {
        if (disabled || isActionPending) return
        setIsActionPending(true)
        try {
            await runSupabaseAction('settings.removeSecondaryStorefront', () =>
                removeAdditionalMarketplaceStorefront(workspaceId, storefront.id, supabase),
            { timeoutMs: 12000, platform: 'all' })
            setIsRemoveConfirmOpen(false)
            onRemoved(storefront.id)
            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.secondaryStorefrontRemoved', { defaultValue: 'Storefront removed.' })
            })
        } catch (error) {
            showActionError(error, t('settings.marketplace.secondaryStorefrontRemoveError', {
                defaultValue: 'Failed to remove the additional storefront.'
            }))
        } finally {
            setIsActionPending(false)
        }
    }

    const slugIsInvalid = Boolean(normalizedSlug) && (
        !storefrontSlugPattern.test(normalizedSlug) || slugStatus === 'taken'
    )
    const publishedSlugMissing = (visibility === 'public' || visibility === 'link_only') && !normalizedSlug

    return (
        <section className="space-y-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <Label className="text-sm font-semibold">
                        {t('settings.marketplace.secondaryStorefrontNumbered', {
                            count: index,
                            defaultValue: 'Additional Storefront {{count}}'
                        })}
                    </Label>
                </div>
                <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setIsRemoveConfirmOpen(true)}
                    disabled={disabled || isActionPending}
                    className="gap-2"
                >
                    <Trash2 className="h-4 w-4" />
                    {t('settings.marketplace.secondaryStorefrontRemove', { defaultValue: 'Remove Storefront' })}
                </Button>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                    <Label>{t('settings.marketplace.visibility', { defaultValue: 'Store Visibility' })}</Label>
                    <Select
                        value={visibility}
                        onValueChange={(value: AdditionalMarketplaceStorefront['visibility']) => setVisibility(value)}
                        disabled={disabled || isActionPending}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="private">{t('settings.marketplace.private', { defaultValue: 'Private' })}</SelectItem>
                            <SelectItem value="public">{t('settings.marketplace.public', { defaultValue: 'Public' })}</SelectItem>
                            <SelectItem value="link_only">{t('settings.marketplace.linkOnly', { defaultValue: 'Public (By link)' })}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <Label>{t('settings.marketplace.slug', { defaultValue: 'Store URL Slug' })}</Label>
                    <Input
                        value={slug}
                        onChange={(event) => setSlug(event.target.value)}
                        placeholder="baghdad-tools"
                        disabled={disabled || isActionPending}
                    />
                    <div className="text-xs text-muted-foreground">
                        {storefrontPreviewUrl || t('settings.marketplace.slugDesc', { defaultValue: 'Your store will be available at /s/your-slug' })}
                    </div>
                    {!disabled && normalizedSlug && (
                        <div className={cn(
                            'text-xs',
                            (slugStatus === 'taken' || slugStatus === 'invalid') && 'text-destructive',
                            slugStatus === 'available' && 'text-emerald-600 dark:text-emerald-300',
                            slugStatus === 'checking' && 'text-muted-foreground'
                        )}>
                            {slugStatus === 'checking' && (
                                <span className="inline-flex items-center gap-2">
                                    <RefreshCw className="h-3 w-3 animate-spin" />
                                    {t('settings.marketplace.slugChecking', { defaultValue: 'Checking availability...' })}
                                </span>
                            )}
                            {slugStatus === 'taken' && t('settings.marketplace.slugTaken', { defaultValue: 'This slug is already taken' })}
                            {slugStatus === 'invalid' && t('settings.marketplace.slugInvalid', { defaultValue: 'Only lowercase letters, numbers, and hyphens allowed' })}
                            {slugStatus === 'available' && t('settings.marketplace.slugAvailable', { defaultValue: 'This slug is available' })}
                        </div>
                    )}
                </div>
            </div>

            <div className="space-y-2">
                <Label>{t('settings.marketplace.description', { defaultValue: 'Store Description' })}</Label>
                <Textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t('settings.marketplace.descriptionDesc', { defaultValue: 'Shown on the marketplace gallery page.' })}
                    rows={3}
                    disabled={disabled || isActionPending}
                />
            </div>

            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={disabled || isActionPending || slugStatus === 'checking' || slugIsInvalid || publishedSlugMissing}
                    className="gap-2"
                >
                    {isActionPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Store className="h-4 w-4" />}
                    {isActionPending ? t('common.loading', { defaultValue: 'Loading...' }) : t('common.save', { defaultValue: 'Save' })}
                </Button>
                {storefrontPreviewUrl && (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => window.open(storefrontPreviewUrl, '_blank', 'noopener,noreferrer')}
                        className="gap-2"
                    >
                        <ExternalLink className="h-4 w-4" />
                        {t('settings.marketplace.preview', { defaultValue: 'Preview Store' })}
                    </Button>
                )}
            </div>

            <div className="border-t border-border/50 pt-4">
                <StorefrontCatalogRulesEditor
                    workspaceId={workspaceId}
                    storefrontId={storefront.id}
                    priceBooks={priceBooks}
                    storages={storages}
                    disabled={disabled}
                />
            </div>

            <DeleteConfirmationModal
                isOpen={isRemoveConfirmOpen}
                onClose={() => !isActionPending && setIsRemoveConfirmOpen(false)}
                onConfirm={() => void handleRemove()}
                title={t('settings.marketplace.secondaryStorefrontRemove', { defaultValue: 'Remove Storefront' })}
                description={t('settings.marketplace.secondaryStorefrontRemoveConfirm', {
                    defaultValue: 'Remove this storefront? Its URL, visibility, and catalog rules will be deleted as well.'
                })}
                itemName={storefront.slug || t('settings.marketplace.secondaryStorefrontNumbered', {
                    count: index,
                    defaultValue: 'Additional Storefront {{count}}'
                })}
                isLoading={isActionPending}
                simpleConfirmation
            />
        </section>
    )
}

export function AdditionalStorefrontsManager({
    workspaceId,
    canManage,
    priceBooks,
    storages,
    marketplaceBaseOrigin,
    disabled = false
}: AdditionalStorefrontsManagerProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { isSupabaseConfigured } = useAuth()
    const [storefronts, setStorefronts] = useState<AdditionalMarketplaceStorefront[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [isCreating, setIsCreating] = useState(false)

    const showActionError = useCallback((error: unknown, fallbackDescription: string) => {
        const normalized = normalizeSupabaseActionError(error)
        if (isRetriableWebRequestError(normalized)) {
            const message = getRetriableActionToast(normalized)
            toast({ title: message.title, description: message.description, variant: 'destructive' })
            return
        }
        toast({
            title: t('common.error') || 'Error',
            description: fallbackDescription || normalized.message,
            variant: 'destructive'
        })
    }, [t, toast])

    const loadStorefronts = useCallback(async () => {
        if (!canManage || !workspaceId || disabled || !isSupabaseConfigured) {
            setStorefronts([])
            return
        }

        setIsLoading(true)
        try {
            const rows = await runSupabaseAction('settings.fetchSecondaryStorefronts', () =>
                fetchAdditionalMarketplaceStorefronts(workspaceId, supabase),
            { timeoutMs: 12000, platform: 'all' })
            setStorefronts(rows)
        } catch (error) {
            console.error('[Settings] Failed to load additional storefronts:', error)
            showActionError(error, t('settings.marketplace.secondaryStorefrontLoadError', {
                defaultValue: 'Failed to load additional storefronts.'
            }))
        } finally {
            setIsLoading(false)
        }
    }, [canManage, disabled, isSupabaseConfigured, showActionError, t, workspaceId])

    useEffect(() => {
        void loadStorefronts()
    }, [loadStorefronts])

    const handleAddStorefront = async () => {
        if (!workspaceId || disabled || isCreating || !canAddAdditionalMarketplaceStorefront(storefronts.length)) return
        setIsCreating(true)
        try {
            const storefront = await runSupabaseAction('settings.addSecondaryStorefront', () =>
                createAdditionalMarketplaceStorefront(workspaceId, supabase),
            { timeoutMs: 12000, platform: 'all' })
            setStorefronts((current) => [...current, storefront].slice(0, MAX_ADDITIONAL_STOREFRONTS))
            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.secondaryStorefrontAdded', {
                    defaultValue: 'Additional storefront created.'
                })
            })
        } catch (error) {
            if (isStorefrontLimitError(error)) {
                await loadStorefronts()
                toast({
                    title: t('common.error') || 'Error',
                    description: t('settings.marketplace.secondaryStorefrontLimitReached', {
                        defaultValue: 'This workspace already has the maximum of five additional storefronts.'
                    }),
                    variant: 'destructive'
                })
            } else {
                showActionError(error, t('settings.marketplace.secondaryStorefrontAddError', {
                    defaultValue: 'Failed to add the additional storefront.'
                }))
            }
        } finally {
            setIsCreating(false)
        }
    }

    const handleSaved = (savedStorefront: AdditionalMarketplaceStorefront) => {
        setStorefronts((current) => current.map((storefront) =>
            storefront.id === savedStorefront.id ? savedStorefront : storefront
        ))
    }

    const handleRemoved = (storefrontId: string) => {
        setStorefronts((current) => current.filter((storefront) => storefront.id !== storefrontId))
    }

    if (!canManage) return null

    const limitReached = !canAddAdditionalMarketplaceStorefront(storefronts.length)

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-1">
                <Label className="text-sm font-semibold">
                    {t('settings.marketplace.secondaryStorefront', { defaultValue: 'Additional Storefronts' })}
                </Label>
                <p className="text-xs text-muted-foreground">
                    {t('settings.marketplace.secondaryStorefrontDesc', {
                        defaultValue: 'Add up to five additional storefronts, each with its own URL, visibility, description, and catalog.'
                    })}
                </p>
                <p className="text-xs text-muted-foreground">
                    {t('settings.marketplace.secondaryStorefrontCount', {
                        count: storefronts.length,
                        maximum: MAX_ADDITIONAL_STOREFRONTS,
                        defaultValue: '{{count}} of {{maximum}} additional storefronts in use'
                    })}
                </p>
            </div>

            {isLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    {t('common.loading', { defaultValue: 'Loading...' })}
                </div>
            ) : (
                <div className="space-y-4">
                    {storefronts.map((storefront, index) => (
                        <AdditionalStorefrontCard
                            key={storefront.id}
                            workspaceId={workspaceId!}
                            storefront={storefront}
                            index={index + 1}
                            priceBooks={priceBooks}
                            storages={storages}
                            marketplaceBaseOrigin={marketplaceBaseOrigin}
                            disabled={disabled}
                            onSaved={handleSaved}
                            onRemoved={handleRemoved}
                        />
                    ))}
                </div>
            )}

            {!isLoading && !limitReached && (
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleAddStorefront()}
                    disabled={disabled || isCreating || isLoading || !isSupabaseConfigured || !workspaceId}
                    className="gap-2"
                >
                    {isCreating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {isCreating
                        ? t('common.loading', { defaultValue: 'Loading...' })
                        : t('settings.marketplace.secondaryStorefrontAdd', { defaultValue: 'Add Storefront' })}
                </Button>
            )}

            {limitReached && (
                <p className="text-xs text-muted-foreground">
                    {t('settings.marketplace.secondaryStorefrontLimitReached', {
                        defaultValue: 'This workspace already has the maximum of five additional storefronts.'
                    })}
                </p>
            )}
        </div>
    )
}
