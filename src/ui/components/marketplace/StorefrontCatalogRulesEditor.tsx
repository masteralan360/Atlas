import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'

import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { type PriceBook } from '@/local-db'
import type { Storage } from '@/local-db/models'
import {
    Button,
    DeleteConfirmationModal,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    useToast
} from '@/ui/components'
import { cn } from '@/lib/utils'
import {
    addStorefrontCatalogRule,
    fetchStorefrontCatalogRules,
    removeStorefrontCatalogRule,
    setStorefrontCatalogRulePriceOverride,
    type StorefrontCatalogRuleRecord,
    type StorefrontCatalogRuleTargetType
} from '@/services/storefrontCatalogRuleRequests'
import {
    getRetriableActionToast,
    isRetriableWebRequestError,
    normalizeSupabaseActionError,
    runSupabaseAction
} from '@/lib/supabaseRequest'

type StorefrontCatalogRulesEditorProps = {
    workspaceId: string | null
    storefrontId: string | null
    priceBooks: PriceBook[]
    storages: Storage[]
    disabled?: boolean
}

export function StorefrontCatalogRulesEditor({
    workspaceId,
    storefrontId,
    priceBooks,
    storages,
    disabled = false
}: StorefrontCatalogRulesEditorProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { isSupabaseConfigured } = useAuth()
    const [rules, setRules] = useState<StorefrontCatalogRuleRecord[]>([])
    const [ruleType, setRuleType] = useState<'inclusion' | 'exclusion'>('inclusion')
    const [targetType, setTargetType] = useState<StorefrontCatalogRuleTargetType>('native')
    const [targetId, setTargetId] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [isActionPending, setIsActionPending] = useState(false)
    const [ruleToRemove, setRuleToRemove] = useState<StorefrontCatalogRuleRecord | null>(null)

    const showActionError = useCallback((error: unknown, fallbackDescription: string) => {
        const normalized = normalizeSupabaseActionError(error)
        if (isRetriableWebRequestError(normalized)) {
            const message = getRetriableActionToast(normalized)
            toast({
                title: message.title,
                description: message.description,
                variant: 'destructive'
            })
            return
        }

        toast({
            title: t('common.error') || 'Error',
            description: fallbackDescription || normalized.message,
            variant: 'destructive'
        })
    }, [t, toast])

    const priceBookById = useMemo(
        () => new Map(priceBooks.map((priceBook) => [priceBook.id, priceBook] as const)),
        [priceBooks]
    )
    const storageById = useMemo(
        () => new Map(storages.map((storage) => [storage.id, storage] as const)),
        [storages]
    )

    const loadRules = useCallback(async () => {
        if (!workspaceId || disabled || !isSupabaseConfigured) {
            setRules([])
            return
        }

        setIsLoading(true)
        try {
            const loadedRules = await runSupabaseAction(
                'marketplace.fetchCatalogRules',
                () => fetchStorefrontCatalogRules(workspaceId, storefrontId, supabase),
                { timeoutMs: 10000, platform: 'all' }
            )
            setRules(loadedRules)
        } catch (error) {
            console.error('[StorefrontCatalogRules] Failed to load catalog rules:', error)
            showActionError(error, t('settings.marketplace.catalogRuleLoadError', {
                defaultValue: 'Failed to load storefront catalog rules.'
            }))
        } finally {
            setIsLoading(false)
        }
    }, [disabled, isSupabaseConfigured, showActionError, storefrontId, t, workspaceId])

    useEffect(() => {
        void loadRules()
    }, [loadRules])

    const handleAddRule = async () => {
        if (!workspaceId || isActionPending) return
        if (targetType === 'price_book' && !priceBookById.has(targetId)) return
        if (targetType === 'storage' && !storageById.has(targetId)) return

        setIsActionPending(true)
        try {
            await runSupabaseAction(
                'marketplace.addCatalogRule',
                () => addStorefrontCatalogRule({
                    workspaceId,
                    storefrontId,
                    ruleType,
                    targetType,
                    priceBookId: targetType === 'price_book' ? targetId : null,
                    storageId: targetType === 'storage' ? targetId : null
                }, supabase),
                { timeoutMs: 10000, platform: 'all' }
            )

            await loadRules()
            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.catalogRuleAdded', {
                    defaultValue: 'Catalog rule added.'
                })
            })
        } catch (error) {
            showActionError(error, t('settings.marketplace.catalogRuleAddError', {
                defaultValue: 'Failed to add storefront catalog rule.'
            }))
        } finally {
            setIsActionPending(false)
        }
    }

    const handleRemoveRule = async () => {
        if (!workspaceId || !ruleToRemove || isActionPending) return

        setIsActionPending(true)
        try {
            await runSupabaseAction(
                'marketplace.removeCatalogRule',
                () => removeStorefrontCatalogRule(ruleToRemove.id, workspaceId, supabase),
                { timeoutMs: 10000, platform: 'all' }
            )

            setRules((current) => current.filter((rule) => rule.id !== ruleToRemove.id))
            setRuleToRemove(null)
            toast({
                title: t('common.success') || 'Success',
                description: t('settings.marketplace.catalogRuleRemoved', {
                    defaultValue: 'Catalog rule removed.'
                })
            })
        } catch (error) {
            showActionError(error, t('settings.marketplace.catalogRuleRemoveError', {
                defaultValue: 'Failed to remove storefront catalog rule.'
            }))
        } finally {
            setIsActionPending(false)
        }
    }

    const handleToggleOverridePrices = async (rule: StorefrontCatalogRuleRecord, enabled: boolean) => {
        if (!workspaceId || rule.target_type !== 'price_book' || isActionPending) return

        setIsActionPending(true)
        try {
            await runSupabaseAction(
                'marketplace.toggleCatalogRulePriceOverride',
                () => setStorefrontCatalogRulePriceOverride(rule.id, workspaceId, enabled, supabase),
                { timeoutMs: 10000, platform: 'all' }
            )

            await loadRules()
            toast({
                title: t('common.success') || 'Success',
                description: enabled
                    ? t('settings.marketplace.catalogRuleOverrideEnabled', {
                        defaultValue: 'Price override enabled. The storefront will use this price book\'s prices.'
                    })
                    : t('settings.marketplace.catalogRuleOverrideDisabled', {
                        defaultValue: 'Price override disabled.'
                    })
            })
        } catch (error) {
            await loadRules()
            showActionError(error, t('settings.marketplace.catalogRuleOverrideError', {
                defaultValue: 'Failed to update the price override.'
            }))
        } finally {
            setIsActionPending(false)
        }
    }

    const getRuleTargetName = (rule: StorefrontCatalogRuleRecord) => {
        if (rule.target_type === 'storage') {
            return rule.storage_id
                ? storageById.get(rule.storage_id)?.name ?? t('settings.marketplace.catalogRuleUnavailableStorage', { defaultValue: 'Unavailable storage' })
                : t('settings.marketplace.catalogRuleUnavailableStorage', { defaultValue: 'Unavailable storage' })
        }
        if (rule.target_type === 'price_book') {
            return rule.price_book_id
                ? priceBookById.get(rule.price_book_id)?.name ?? t('settings.marketplace.catalogRuleUnavailablePriceBook', { defaultValue: 'Unavailable price book' })
                : t('settings.marketplace.catalogRuleUnavailablePriceBook', { defaultValue: 'Unavailable price book' })
        }
        return t('settings.marketplace.catalogRuleNative', { defaultValue: 'Native products (no price book)' })
    }

    const hasInvalidTarget = targetType === 'price_book'
        ? !priceBookById.has(targetId)
        : targetType === 'storage' && !storageById.has(targetId)

    return (
        <div className="space-y-3">
            <div className="flex flex-col gap-1">
                <Label className="text-sm font-semibold">
                    {t('settings.marketplace.catalogRules', { defaultValue: 'Storefront Catalog' })}
                </Label>
                <p className="text-xs text-muted-foreground">
                    {t('settings.marketplace.catalogRulesDesc', {
                        defaultValue: 'Include or exclude price books, native products, or workspace storages from this storefront. Storage rules control which locations supply products.'
                    })}
                </p>
                <p className="text-xs text-muted-foreground">
                    {t('settings.marketplace.catalogRuleOverrideHint', {
                        defaultValue: 'Price book rules can override storefront prices with the price book\'s prices. Only one rule per storefront can override prices.'
                    })}
                </p>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(9rem,0.8fr)_minmax(12rem,1.4fr)_auto]">
                <Select
                    value={ruleType}
                    onValueChange={(value) => setRuleType(value as 'inclusion' | 'exclusion')}
                    disabled={disabled || isActionPending}
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="inclusion">
                            {t('settings.marketplace.catalogRuleInclusion', { defaultValue: 'Include only' })}
                        </SelectItem>
                        <SelectItem value="exclusion">
                            {t('settings.marketplace.catalogRuleExclusion', { defaultValue: 'Exclude' })}
                        </SelectItem>
                    </SelectContent>
                </Select>

                <Select
                    value={targetType}
                    onValueChange={(value) => {
                        setTargetType(value as StorefrontCatalogRuleTargetType)
                        setTargetId('')
                    }}
                    disabled={disabled || isActionPending}
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="native">
                            {t('settings.marketplace.catalogRuleNative', { defaultValue: 'Native products' })}
                        </SelectItem>
                        {priceBooks.length > 0 && (
                            <SelectItem value="price_book">
                                {t('settings.marketplace.catalogRulePriceBookTarget', { defaultValue: 'Price book' })}
                            </SelectItem>
                        )}
                        <SelectItem value="storage">
                            {t('settings.marketplace.catalogRuleStorageTarget', { defaultValue: 'Storage' })}
                        </SelectItem>
                    </SelectContent>
                </Select>

                {targetType === 'price_book' ? (
                    <Select value={targetId} onValueChange={setTargetId} disabled={disabled || isActionPending}>
                        <SelectTrigger>
                            <SelectValue placeholder={t('settings.marketplace.catalogRuleSelectPriceBook', { defaultValue: 'Select a price book' })} />
                        </SelectTrigger>
                        <SelectContent>
                            {priceBooks.map((priceBook) => (
                                <SelectItem key={priceBook.id} value={priceBook.id}>{priceBook.name}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : targetType === 'storage' ? (
                    <Select value={targetId} onValueChange={setTargetId} disabled={disabled || isActionPending || storages.length === 0}>
                        <SelectTrigger>
                            <SelectValue placeholder={t('settings.marketplace.catalogRuleSelectStorage', { defaultValue: 'Select a storage' })} />
                        </SelectTrigger>
                        <SelectContent>
                            {storages.map((storage) => (
                                <SelectItem key={storage.id} value={storage.id}>{storage.name}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : (
                    <div className="flex min-h-10 items-center rounded-md border border-border/60 bg-muted/30 px-3 text-sm text-muted-foreground">
                        {t('settings.marketplace.catalogRuleNative', { defaultValue: 'Native products (no price book)' })}
                    </div>
                )}

                <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleAddRule()}
                    disabled={disabled || isActionPending || hasInvalidTarget}
                    className="gap-2"
                >
                    {isActionPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {isActionPending
                        ? t('common.loading', { defaultValue: 'Loading...' })
                        : t('settings.marketplace.catalogRuleAdd', { defaultValue: 'Add Rule' })}
                </Button>
            </div>

            {targetType === 'storage' && storages.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    {t('settings.marketplace.catalogRuleNoStorages', { defaultValue: 'No available storages were found in this workspace.' })}
                </p>
            )}

            {isLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    {t('common.loading', { defaultValue: 'Loading...' })}
                </div>
            )}

            {rules.length > 0 && (
                <div className="space-y-2">
                    {rules.map((rule) => (
                        <div
                            key={rule.id}
                            className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/70 px-3 py-2"
                        >
                            <div className="flex min-w-0 items-center gap-2">
                                <span className={cn(
                                    'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-bold',
                                    rule.rule_type === 'inclusion'
                                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                                        : 'bg-destructive/10 text-destructive'
                                )}>
                                    {rule.rule_type === 'inclusion'
                                        ? t('settings.marketplace.catalogRuleInclusion', { defaultValue: 'Include only' })
                                        : t('settings.marketplace.catalogRuleExclusion', { defaultValue: 'Exclude' })}
                                </span>
                                <span className="truncate text-sm font-medium">{getRuleTargetName(rule)}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                                {rule.target_type === 'price_book' && rule.price_book_id && (
                                    <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
                                        <Switch
                                            checked={rule.override_prices}
                                            onCheckedChange={(checked) => void handleToggleOverridePrices(rule, checked)}
                                            disabled={disabled || isActionPending}
                                        />
                                        {t('settings.marketplace.catalogRuleOverridePrices', { defaultValue: 'Override prices' })}
                                    </label>
                                )}
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setRuleToRemove(rule)}
                                    disabled={disabled || isActionPending}
                                    title={t('settings.marketplace.catalogRuleRemove', { defaultValue: 'Remove rule' })}
                                    className="h-8 w-8"
                                >
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <DeleteConfirmationModal
                isOpen={Boolean(ruleToRemove)}
                onClose={() => !isActionPending && setRuleToRemove(null)}
                onConfirm={() => void handleRemoveRule()}
                title={t('settings.marketplace.catalogRuleRemove', { defaultValue: 'Remove rule' })}
                description={t('settings.marketplace.catalogRuleRemoveConfirm', { defaultValue: 'Remove this catalog rule from the storefront?' })}
                itemName={ruleToRemove ? getRuleTargetName(ruleToRemove) : ''}
                isLoading={isActionPending}
                simpleConfirmation
            />
        </div>
    )
}
