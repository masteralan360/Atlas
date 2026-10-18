import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useLocation, useRoute } from 'wouter'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import CountryFlag from 'react-native-country-flag'
import { ArrowLeft, ArrowRightLeft, CalendarClock, ClipboardList, HelpCircle, History, Lock, Plus, Search, Trash2, Undo2, Unlock, Vault } from 'lucide-react'

import { useAuth } from '@/auth/AuthContext'
import { cn, formatCurrency, formatDateTime, formatNumberWithCommas, formatNumericInput, parseFormattedNumber, parseLocalDateTimeValue, sanitizeNumericInput } from '@/lib/utils'
import { CASH_AND_DIGITAL_PAYMENT_METHODS } from '@/lib/paymentMethods'
import {
    buildExchangeFeeRuleSnapshot,
    buildExchangePairOptions,
    calculateExchangeProfit,
    calculateExchangeTransaction,
    createExchangeFeeRule,
    createExchangeSafe,
    createExchangeSafeAdjustment,
    createExchangeTransaction,
    deleteExchangeFeeRule,
    DEFAULT_EXCHANGE_PAIR_PRICE_BASIS,
    EXCHANGE_SAFE_CURRENCIES,
    findExchangePairPrice,
    reverseExchangeTransaction,
    findLatestSafeBuyForAcquisitionRate,
    getExchangeFeeRuleTemporalStatus,
    getDefaultExchangeFeeBasisAmount,
    getExchangeFeeBasisAmount,
    getExchangePairKey,
    getExchangePairLabel,
    getExchangePairSidePrice,
    getExchangePairTransactionCurrencies,
    getExchangeRateBasisAmount,
    isExchangeFeeRuleEffectiveForTransaction,
    parseExchangePairKey,
    resolveEffectiveExchangeFeeRule,
    updateExchangeFeeRule,
    upsertExchangePairPrice,
    useExchangeFeeRules,
    useExchangePairPrices,
    useExchangeSafeBalances,
    useExchangeSafeMovements,
    useExchangeSafes,
    useExchangeTransactions,
    type ExchangeAcquisitionRateSource,
    type CurrencyCode,
    type ExchangeFeeRule,
    type ExchangeFeeRuleTransactionScope,
    type ExchangeFeeType,
    type ExchangePaymentMethod,
    type ExchangePairPrice,
    type ExchangeRateSnapshot,
    type ExchangeSafeBalance,
    type ExchangeSafeMovement,
    type ExchangeTransaction,
    type ExchangeTransactionType,
    type ExchangeFeeRuleTemporalStatus,
    type IQDDisplayPreference
} from '@/local-db'
import { Button } from '@/ui/components/button'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Input } from '@/ui/components/input'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CurrencySelector,
  DateTimePicker,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useToast,
} from '@/ui/components'
import { PaymentMethodSelect } from '@/ui/components/payments/PaymentMethodSelect'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useWorkspacePermissions } from '@/permissions'

type FeeRuleFormState = {
    name: string
    transactionScope: ExchangeFeeRuleTransactionScope
    feeType: ExchangeFeeType
    currency: CurrencyCode
    value: string
    customerGivesBasisAmount: string
    effectiveStartDate: string
    effectiveEndDate: string
    isActive: boolean
    isLocked: boolean
    notes: string
}

type ExchangeRelationRange = {
    firstIndex: number
    lastIndex: number
}

type ExchangeRateCardSlot = string | null

const EXCHANGE_RATE_CARD_SLOT_COUNT = 4
const EMPTY_EXCHANGE_RATE_CARD_SLOTS: ExchangeRateCardSlot[] = Array.from({ length: EXCHANGE_RATE_CARD_SLOT_COUNT }, () => null)
const EXCHANGE_RATE_CARD_CLEAR_VALUE = '__clear'
const EXCHANGE_RATE_CARD_STORAGE_KEY_PREFIX = 'currency_exchange_rate_card_slots'
const fallbackCurrencyNames: Record<CurrencyCode, string> = {
    iqd: 'Iraqi Dinar',
    usd: 'US Dollar',
    eur: 'Euro',
    try: 'Turkish Lira'
}

function currentTimestamp() {
    return new Date().toISOString()
}

function toTimestampValue(value: Date | undefined) {
    return value ? value.toISOString() : ''
}

function calculateRulePreviewFeeAmount(feeType: ExchangeFeeType, customerGivesAmount: number, feeValue: number) {
    if (feeType === 'percentage') {
        return customerGivesAmount * feeValue / 100
    }

    return feeValue
}

function getExchangeRateCardStorageKey(workspaceId: string) {
    return `${EXCHANGE_RATE_CARD_STORAGE_KEY_PREFIX}:${workspaceId || 'default'}`
}

function isExchangeRateCardPair(value: unknown): value is string {
    return typeof value === 'string' && parseExchangePairKey(value) !== null
}

function normalizeExchangeRateCardSlots(value: unknown): ExchangeRateCardSlot[] {
    const next = [...EMPTY_EXCHANGE_RATE_CARD_SLOTS]
    const seen = new Set<string>()

    if (!Array.isArray(value)) {
        return next
    }

    for (let index = 0; index < EXCHANGE_RATE_CARD_SLOT_COUNT; index += 1) {
        const pairKey = value[index]
        if (isExchangeRateCardPair(pairKey) && !seen.has(pairKey)) {
            next[index] = pairKey
            seen.add(pairKey)
        }
    }

    return next
}

function readExchangeRateCardSlots(storageKey: string) {
    if (typeof window === 'undefined') {
        return [...EMPTY_EXCHANGE_RATE_CARD_SLOTS]
    }

    try {
        const rawValue = window.localStorage.getItem(storageKey)
        return rawValue ? normalizeExchangeRateCardSlots(JSON.parse(rawValue)) : [...EMPTY_EXCHANGE_RATE_CARD_SLOTS]
    } catch {
        return [...EMPTY_EXCHANGE_RATE_CARD_SLOTS]
    }
}

function writeExchangeRateCardSlots(storageKey: string, slots: ExchangeRateCardSlot[]) {
    if (typeof window === 'undefined') {
        return
    }

    try {
        window.localStorage.setItem(storageKey, JSON.stringify(normalizeExchangeRateCardSlots(slots)))
    } catch {
        // Ignore local storage failures; the display cards still work for this session.
    }
}

function getLocalizedCurrencyName(currency: CurrencyCode, language: string | undefined) {
    const locale = language?.replace('_', '-') || 'en'

    try {
        const displayNames = new Intl.DisplayNames([locale], { type: 'currency' })
        return displayNames.of(currency.toUpperCase()) || fallbackCurrencyNames[currency]
    } catch {
        return fallbackCurrencyNames[currency]
    }
}

function formatExchangeRateDisplay(value: number | null) {
    return value && value > 0 ? formatNumberWithCommas(value) : '-'
}

function makeDefaultRuleForm(currency: CurrencyCode): FeeRuleFormState {
    return {
        name: '',
        transactionScope: 'both',
        feeType: 'fixed',
        currency,
        value: '',
        customerGivesBasisAmount: String(getDefaultExchangeFeeBasisAmount(currency)),
        effectiveStartDate: currentTimestamp(),
        effectiveEndDate: '',
        isActive: true,
        isLocked: false,
        notes: ''
    }
}

function transactionTypeLabel(type: ExchangeTransactionType, t: TFunction) {
    return t(`currencyExchange.transactionTypes.${type}`)
}

function feeScopeLabel(scope: ExchangeFeeRuleTransactionScope, t: TFunction) {
    return t(`currencyExchange.ruleScopes.${scope}`)
}

function getSafeBalanceAmount(balances: ExchangeSafeBalance[], safeId: string | null | undefined, currency: CurrencyCode) {
    if (!safeId) return 0
    return Number(balances.find((balance) => balance.safeId === safeId && balance.currency === currency && !balance.isDeleted)?.balanceAmount || 0)
}

function sanitizeSignedNumericInput(value: string, options?: { allowDecimal?: boolean; maxFractionDigits?: number }) {
    const trimmed = value.trim()
    const sign = trimmed.startsWith('-') ? '-' : ''
    const sanitized = sanitizeNumericInput(trimmed.replace(/-/g, ''), options)
    return sanitized ? `${sign}${sanitized}` : sign
}

function movementTypeLabel(type: ExchangeSafeMovement['movementType'], t: TFunction) {
    return t(`currencyExchange.movementTypes.${type}`)
}

function feeTypeLabel(type: ExchangeFeeType | null | undefined, t: TFunction) {
    if (!type) return '-'
    return t(`currencyExchange.feeTypes.${type}`)
}

function rateSourceLabel(source: string | null | undefined, t: TFunction) {
    if (source === 'manual_pair_price') {
        return t('currencyExchange.rateSources.manualPairPrice', { defaultValue: 'Manual pair price' })
    }
    return source === 'manual'
        ? t('currencyExchange.rateSources.manual')
        : t('currencyExchange.rateSources.live')
}

function acquisitionSourceLabel(source: ExchangeAcquisitionRateSource | null | undefined, t: TFunction) {
    return source === 'last_buy'
        ? t('currencyExchange.acquisitionSources.last_buy')
        : t('currencyExchange.acquisitionSources.manual')
}

function safeStatusLabel(isActive: boolean, t: TFunction) {
    return isActive ? t('currencyExchange.status.active') : t('currencyExchange.status.inactive')
}

function feeRuleTemporalStatusLabel(status: ExchangeFeeRuleTemporalStatus, t: TFunction) {
    switch (status) {
        case 'pending':
            return t('currencyExchange.status.pending', { defaultValue: 'Pending' })
        case 'effective':
            return t('currencyExchange.status.activeNow', { defaultValue: 'Active now' })
        case 'ended':
            return t('currencyExchange.status.ended', { defaultValue: 'Ended' })
        case 'inactive':
        default:
            return t('currencyExchange.status.inactive')
    }
}

function feeRuleTemporalBadgeClass(status: ExchangeFeeRuleTemporalStatus) {
    switch (status) {
        case 'pending':
            return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        case 'effective':
            return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
        case 'ended':
            return 'bg-slate-500/15 text-slate-700 dark:text-slate-300'
        case 'inactive':
        default:
            return 'bg-muted text-muted-foreground'
    }
}

function feeRuleTemporalHelperText(
    rule: Pick<ExchangeFeeRule, 'isActive' | 'effectiveStartDate' | 'effectiveEndDate'>,
    status: ExchangeFeeRuleTemporalStatus,
    t: TFunction
) {
    switch (status) {
        case 'pending':
            return t('currencyExchange.help.feeRulePending', {
                defaultValue: 'Active is on, but this rule will not apply until {{start}}.',
                start: formatDateTime(rule.effectiveStartDate)
            })
        case 'effective':
            return rule.effectiveEndDate
                ? t('currencyExchange.help.feeRuleEffectiveUntil', {
                    defaultValue: 'This rule can apply to matching transactions until {{end}}.',
                    end: formatDateTime(rule.effectiveEndDate)
                })
                : t('currencyExchange.help.feeRuleEffectiveOpenEnded', {
                    defaultValue: 'This rule can apply to matching transactions now and has no end time.'
                })
        case 'ended':
            return t('currencyExchange.help.feeRuleEnded', {
                defaultValue: 'Active is on, but the effective end time passed at {{end}}.',
                end: rule.effectiveEndDate ? formatDateTime(rule.effectiveEndDate) : '-'
            })
        case 'inactive':
        default:
            return rule.isActive
                ? t('currencyExchange.help.feeRuleUnavailable', {
                    defaultValue: 'This rule is not currently available for new matching transactions.'
                })
                : t('currencyExchange.help.feeRuleInactive', {
                    defaultValue: 'The active switch is off, so this rule will not apply.'
                })
    }
}

function feeRuleMatchesTransactionContext(rule: ExchangeFeeRule, transactionType: ExchangeTransactionType, feeCurrency: CurrencyCode) {
    return !rule.isDeleted
        && rule.isActive
        && (rule.transactionScope === 'both' || rule.transactionScope === transactionType)
        && rule.currency === feeCurrency
}

function getRuleDateSortValue(value?: string | null) {
    const parsed = value ? new Date(value).getTime() : 0
    return Number.isNaN(parsed) ? 0 : parsed
}

function getExchangeReversalRelationKey(transaction: ExchangeTransaction) {
    if (transaction.reversedTransactionId) {
        return `exchange-reversal:${transaction.reversedTransactionId}`
    }

    if (transaction.isReversed) {
        return `exchange-reversal:${transaction.id}`
    }

    return null
}

function buildExchangeReversalRelationMaps(transactions: ExchangeTransaction[]) {
    const counts = new Map<string, number>()
    const ranges = new Map<string, ExchangeRelationRange>()

    transactions.forEach((transaction, index) => {
        const relationKey = getExchangeReversalRelationKey(transaction)
        if (!relationKey) {
            return
        }

        counts.set(relationKey, (counts.get(relationKey) || 0) + 1)

        const existingRange = ranges.get(relationKey)
        if (!existingRange) {
            ranges.set(relationKey, { firstIndex: index, lastIndex: index })
            return
        }

        existingRange.lastIndex = index
    })

    return { counts, ranges }
}

function getExchangeMovementRelationKey(movement: ExchangeSafeMovement) {
    if (movement.sourceType !== 'exchange_transaction' || !movement.sourceId) {
        return null
    }

    return `exchange-movement:${movement.sourceId}`
}

function buildExchangeMovementRelationMaps(movements: ExchangeSafeMovement[]) {
    const counts = new Map<string, number>()
    const ranges = new Map<string, ExchangeRelationRange>()

    movements.forEach((movement, index) => {
        const relationKey = getExchangeMovementRelationKey(movement)
        if (!relationKey) {
            return
        }

        counts.set(relationKey, (counts.get(relationKey) || 0) + 1)

        const existingRange = ranges.get(relationKey)
        if (!existingRange) {
            ranges.set(relationKey, { firstIndex: index, lastIndex: index })
            return
        }

        existingRange.lastIndex = index
    })

    return { counts, ranges }
}

function profitSummary(transactions: ExchangeTransaction[], iqdPreference: IQDDisplayPreference) {
    const totals = new Map<CurrencyCode, number>()

    for (const transaction of transactions) {
        if (!transaction.profitCurrency) {
            continue
        }

        const amount = Number(transaction.profitAmount || 0)
        if (!Number.isFinite(amount) || amount === 0) {
            continue
        }

        totals.set(transaction.profitCurrency, (totals.get(transaction.profitCurrency) || 0) + amount)
    }

    const orderedCurrencies = [
        ...EXCHANGE_SAFE_CURRENCIES,
        ...Array.from(totals.keys()).filter((currency) => !EXCHANGE_SAFE_CURRENCIES.includes(currency))
    ]
    const entries = orderedCurrencies
        .map((currency) => [currency, totals.get(currency) || 0] as const)
        .filter(([, amount]) => amount !== 0)

    if (entries.length === 0) {
        return '-'
    }

    return entries
        .map(([currency, amount]) => formatCurrency(amount, currency, iqdPreference))
        .join(' / ')
}

export function CurrencyExchange() {
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { hasPermission } = useWorkspacePermissions()
    const [, navigate] = useLocation()
    const [createMatch] = useRoute('/currency-exchange/new')
    const [rulesMatch] = useRoute('/currency-exchange/rules')
    const [safesMatch] = useRoute('/currency-exchange/safes')
    const workspaceId = user?.workspaceId
    const canAccessRules = user?.role === 'admin' || hasPermission('currencyExchangeFeeRules.access')

    if (!workspaceId) {
        return null
    }

    if (createMatch) {
        return (
            <CreateCurrencyExchangeTransactionPage
                workspaceId={workspaceId}
                onCancel={() => navigate('/currency-exchange')}
                onCreated={() => navigate('/currency-exchange')}
            />
        )
    }

    if (rulesMatch) {
        return (
            <ExchangeFeeRulesPage
                workspaceId={workspaceId}
                onBack={() => navigate('/currency-exchange')}
            />
        )
    }

    if (safesMatch) {
        return (
            <ExchangeSafesPage
                workspaceId={workspaceId}
                iqdDisplayPreference={features.iqd_display_preference}
                onBack={() => navigate('/currency-exchange')}
            />
        )
    }

    return (
        <ExchangeTransactionsPage
            workspaceId={workspaceId}
            iqdDisplayPreference={features.iqd_display_preference}
            canAccessRules={canAccessRules}
            onCreate={() => navigate('/currency-exchange/new')}
            onRules={() => navigate('/currency-exchange/rules')}
            onSafes={() => navigate('/currency-exchange/safes')}
        />
    )
}

function ExchangeTransactionsPage({
    workspaceId,
    iqdDisplayPreference,
    canAccessRules,
    onCreate,
    onRules,
    onSafes
}: {
    workspaceId: string
    iqdDisplayPreference: IQDDisplayPreference
    canAccessRules: boolean
    onCreate: () => void
    onRules: () => void
    onSafes: () => void
}) {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { hasPermission } = useWorkspacePermissions()
    const transactions = useExchangeTransactions(workspaceId)
    const pairPrices = useExchangePairPrices(workspaceId)
    const safes = useExchangeSafes(workspaceId)
    const [search, setSearch] = useState('')
    const rateCardStorageKey = getExchangeRateCardStorageKey(workspaceId)
    const rateCardStorageKeyRef = useRef(rateCardStorageKey)
    const skipNextRateCardSaveRef = useRef(false)
    const [rateCardPairs, setRateCardPairs] = useState<ExchangeRateCardSlot[]>(() => readExchangeRateCardSlots(rateCardStorageKey))
    const [reverseTargetId, setReverseTargetId] = useState<string | null>(null)
    const [hoveredReversalRelationKey, setHoveredReversalRelationKey] = useState<string | null>(null)
    const [isReversing, setIsReversing] = useState(false)
    const canReverse = user?.role === 'admin' || hasPermission('currencyExchange.reverse')
    const canManagePrices = user?.role === 'admin' || hasPermission('currencyExchange.managePrices')
    const exchangePairOptions = useMemo(() => buildExchangePairOptions(EXCHANGE_SAFE_CURRENCIES), [])
    const selectedRateCardPairs = useMemo(() => new Set(rateCardPairs.filter(Boolean) as string[]), [rateCardPairs])
    const activeLanguage = i18n.resolvedLanguage || i18n.language

    const filteredTransactions = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return transactions
        return transactions.filter((transaction) => [
            transaction.transactionNo,
            transaction.transactionType,
            transaction.fromCurrency,
            transaction.toCurrency,
            transaction.paymentMethod,
            transaction.employeeName,
            transaction.notes
        ].some((value) => value ? String(value).toLowerCase().includes(query) : false))
    }, [search, transactions])

    const reversalRelationMaps = useMemo(
        () => buildExchangeReversalRelationMaps(filteredTransactions),
        [filteredTransactions]
    )
    const hoveredReversalRange = hoveredReversalRelationKey
        ? (reversalRelationMaps.ranges.get(hoveredReversalRelationKey) ?? null)
        : null
    const hasVisibleReversalRelations = Array.from(reversalRelationMaps.counts.values()).some((count) => count > 1)

    const metrics = useMemo(() => {
        const reportableTransactions = transactions.filter((transaction) => !transaction.isReversed && !transaction.reversedTransactionId)

        return {
            totalCount: transactions.length,
            manualRates: reportableTransactions.filter((transaction) => transaction.exchangeRateSource === 'manual_pair_price' || transaction.exchangeRateManuallyEdited).length,
            realizedProfit: profitSummary(reportableTransactions, iqdDisplayPreference),
            activeSafes: safes.filter((safe) => safe.isActive).length
        }
    }, [iqdDisplayPreference, safes, transactions])

    useEffect(() => {
        if (rateCardStorageKeyRef.current === rateCardStorageKey) {
            return
        }

        rateCardStorageKeyRef.current = rateCardStorageKey
        skipNextRateCardSaveRef.current = true
        setRateCardPairs(readExchangeRateCardSlots(rateCardStorageKey))
    }, [rateCardStorageKey])

    useEffect(() => {
        if (skipNextRateCardSaveRef.current) {
            skipNextRateCardSaveRef.current = false
            return
        }

        writeExchangeRateCardSlots(rateCardStorageKey, rateCardPairs)
    }, [rateCardPairs, rateCardStorageKey])

    const handleRateCardPairChange = (slotIndex: number, value: string) => {
        setRateCardPairs((current) => {
            const next = current.slice(0, EXCHANGE_RATE_CARD_SLOT_COUNT)
            while (next.length < EXCHANGE_RATE_CARD_SLOT_COUNT) {
                next.push(null)
            }

            if (value === EXCHANGE_RATE_CARD_CLEAR_VALUE) {
                next[slotIndex] = null
                return next
            }

            const pairKey = parseExchangePairKey(value) ? value : null
            return next.map((slot, index) => {
                if (index === slotIndex) return pairKey
                return slot === pairKey ? null : slot
            })
        })
    }

    const handleRateCardPriceSave = async (
        pair: { baseCurrency: CurrencyCode; quoteCurrency: CurrencyCode },
        side: 'buy' | 'sell',
        price: number
    ) => {
        try {
            const existing = findExchangePairPrice(pairPrices, pair.baseCurrency, pair.quoteCurrency)
            await upsertExchangePairPrice(workspaceId, {
                baseCurrency: pair.baseCurrency,
                quoteCurrency: pair.quoteCurrency,
                buyPrice: side === 'buy' ? price : existing?.buyPrice ?? 0,
                sellPrice: side === 'sell' ? price : existing?.sellPrice ?? 0,
                priceBasisAmount: existing?.priceBasisAmount ?? DEFAULT_EXCHANGE_PAIR_PRICE_BASIS,
                createdBy: user?.id ?? null,
                updatedBy: user?.id ?? null
            })
            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: t('currencyExchange.messages.priceUpdated', { defaultValue: 'Exchange price updated.' })
            })
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('currencyExchange.messages.priceUpdateFailed', { defaultValue: 'Failed to update exchange price.' }),
                variant: 'destructive'
            })
        }
    }

    const handleReverse = async () => {
        if (!reverseTargetId) return
        setIsReversing(true)
        try {
            await reverseExchangeTransaction(reverseTargetId, user?.id || null)
            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: t('currencyExchange.messages.transactionReversed')
            })
            setReverseTargetId(null)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('currencyExchange.messages.transactionReverseFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsReversing(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
                        <ArrowRightLeft className="h-7 w-7" />
                        {t('currencyExchange.serviceTitle')}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t('currencyExchange.serviceDescription')} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="button" variant="outline" onClick={onSafes} className="gap-2">
                        <Vault className="h-4 w-4" />
                        {t('currencyExchange.safes.title')}
                    </Button>
                    {canAccessRules ? (
                        <Button type="button" variant="outline" onClick={onRules} className="gap-2">
                            <ClipboardList className="h-4 w-4" />
                            {t('currencyExchange.feeRules.title')}
                        </Button>
                    ) : null}
                    <Button type="button" onClick={onCreate} className="gap-2">
                        <Plus className="h-4 w-4" />
                        {t('currencyExchange.buttons.createTransaction')}
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-4">
                <MetricCard title={t('currencyExchange.metrics.transactions')} value={String(metrics.totalCount)} />
                <MetricCard title={t('currencyExchange.metrics.manualRates')} value={String(metrics.manualRates)} />
                <MetricCard title={t('currencyExchange.metrics.realizedProfit')} value={metrics.realizedProfit} />
                <MetricCard title={t('currencyExchange.metrics.activeSafes')} value={String(metrics.activeSafes)} />
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {rateCardPairs.map((pairKey, slotIndex) => {
                    const parsedPair = parseExchangePairKey(pairKey)
                    const pairPrice = parsedPair
                        ? findExchangePairPrice(pairPrices, parsedPair.baseCurrency, parsedPair.quoteCurrency)
                        : null
                    const pairOptions = exchangePairOptions.filter((option) => (
                        option.key === pairKey || !selectedRateCardPairs.has(option.key)
                    ))

                    return (
                        <ExchangeRateDisplaySelectCard
                            key={slotIndex}
                            slotIndex={slotIndex}
                            pair={parsedPair}
                            pairKey={pairKey}
                            pairPrice={pairPrice}
                            pairOptions={pairOptions}
                            language={activeLanguage}
                            canManagePrices={canManagePrices}
                            onPairChange={handleRateCardPairChange}
                            onPriceSave={handleRateCardPriceSave}
                            t={t}
                        />
                    )
                })}
            </div>

            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <CardTitle>{t('currencyExchange.transactions.title')}</CardTitle>
                        <div className="relative w-full md:w-80">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                className="pl-9"
                                placeholder={t('currencyExchange.transactions.searchPlaceholder')}
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <Table className={cn(hasVisibleReversalRelations && 'ms-6 w-[calc(100%-1.5rem)]')}>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('currencyExchange.table.transaction')}</TableHead>
                                <TableHead>{t('currencyExchange.table.type')}</TableHead>
                                <TableHead>{t('currencyExchange.table.customerGives')}</TableHead>
                                <TableHead>{t('currencyExchange.table.customerReceives')}</TableHead>
                                <TableHead>{t('currencyExchange.table.rate')}</TableHead>
                                <TableHead>{t('currencyExchange.table.fee')}</TableHead>
                                <TableHead>{t('currencyExchange.table.payment')}</TableHead>
                                <TableHead className="text-end">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredTransactions.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                                        {t('currencyExchange.empty.transactions')}
                                    </TableCell>
                                </TableRow>
                            ) : filteredTransactions.map((transaction, rowIndex) => {
                                const reversalRelationKey = getExchangeReversalRelationKey(transaction)
                                const isRelationHovered = !!hoveredReversalRelationKey && reversalRelationKey === hoveredReversalRelationKey
                                const relatedVisibleCount = reversalRelationKey ? (reversalRelationMaps.counts.get(reversalRelationKey) || 0) : 0
                                const hasVisibleLinkedPeer = relatedVisibleCount > 1
                                const showHierarchyLine = !!hoveredReversalRange
                                    && hoveredReversalRange.firstIndex !== hoveredReversalRange.lastIndex
                                    && rowIndex >= hoveredReversalRange.firstIndex
                                    && rowIndex <= hoveredReversalRange.lastIndex
                                const showHierarchyTurn = isRelationHovered && hasVisibleLinkedPeer
                                const hierarchyVerticalClass = hoveredReversalRange && rowIndex === hoveredReversalRange.firstIndex
                                    ? 'top-1/2 bottom-0'
                                    : hoveredReversalRange && rowIndex === hoveredReversalRange.lastIndex
                                        ? 'top-0 bottom-1/2'
                                        : 'top-0 bottom-0'

                                return (
                                <TableRow
                                    key={transaction.id}
                                    className={cn(
                                        transaction.isReversed ? 'bg-destructive/5' : transaction.reversedTransactionId ? 'bg-amber-500/5' : '',
                                        reversalRelationKey && 'transition-colors duration-150',
                                        isRelationHovered && hasVisibleLinkedPeer && 'bg-yellow-500/10'
                                    )}
                                    onMouseEnter={() => {
                                        if (reversalRelationKey) {
                                            setHoveredReversalRelationKey(reversalRelationKey)
                                        }
                                    }}
                                    onMouseLeave={() => {
                                        if (reversalRelationKey) {
                                            setHoveredReversalRelationKey((current) => current === reversalRelationKey ? null : current)
                                        }
                                    }}
                                >
                                    <TableCell className="relative">
                                        {showHierarchyLine ? (
                                            <div className="pointer-events-none absolute inset-y-0 -start-6 w-5">
                                                <span
                                                    className={cn(
                                                        'absolute start-1.5 w-px bg-yellow-500',
                                                        hierarchyVerticalClass
                                                    )}
                                                />
                                                {showHierarchyTurn ? (
                                                    <span className="absolute start-1.5 top-1/2 h-px w-3 -translate-y-1/2 bg-yellow-500" />
                                                ) : null}
                                            </div>
                                        ) : null}
                                        <div className="font-medium">{transaction.transactionNo}</div>
                                        <div className="text-xs text-muted-foreground">{formatDateTime(transaction.transactionDate)}</div>
                                        {transaction.safeNameSnapshot ? (
                                            <div className="text-xs text-muted-foreground">{transaction.safeNameSnapshot}</div>
                                        ) : null}
                                        {transaction.employeeName ? (
                                            <div className="text-xs text-muted-foreground">{transaction.employeeName}</div>
                                        ) : null}
                                    </TableCell>
                                    <TableCell>{transactionTypeLabel(transaction.transactionType, t)}</TableCell>
                                    <TableCell>{formatCurrency(transaction.customerGivesAmount, transaction.fromCurrency, iqdDisplayPreference as any)}</TableCell>
                                    <TableCell>{formatCurrency(transaction.customerReceivesAmount, transaction.toCurrency, iqdDisplayPreference as any)}</TableCell>
                                    <TableCell>
                                        <div>{formatNumberWithCommas(transaction.exchangeRateUsed)}</div>
                                        <div className={cn(
                                            'mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium',
                                            transaction.exchangeRateSource === 'manual_pair_price' || transaction.exchangeRateManuallyEdited
                                                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                                : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                        )}>
                                            {rateSourceLabel(transaction.exchangeRateSource, t)}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <div>{transaction.feeType ? `${feeTypeLabel(transaction.feeType, t)} / ${formatCurrency(transaction.feeAmount, transaction.feeCurrency || transaction.fromCurrency, iqdDisplayPreference as any)}` : '-'}</div>
                                        {transaction.profitCurrency ? (
                                            <div className={cn(
                                                'text-xs',
                                                transaction.isReversed || transaction.reversedTransactionId
                                                    ? 'text-foreground line-through decoration-current'
                                                    : (transaction.profitAmount || 0) >= 0
                                                        ? 'text-emerald-700 dark:text-emerald-300'
                                                        : 'text-destructive'
                                            )}>
                                                {t('currencyExchange.labels.profit')}: {formatCurrency(transaction.profitAmount || 0, transaction.profitCurrency, iqdDisplayPreference as any)}
                                            </div>
                                        ) : null}
                                        {transaction.feeEdited ? (
                                            <div className="text-xs text-amber-700 dark:text-amber-300">{t('currencyExchange.labels.editedFromRule')}</div>
                                        ) : null}
                                    </TableCell>
                                    <TableCell className="capitalize">{transaction.paymentMethod}</TableCell>
                                    <TableCell className="text-end">
                                        {canReverse && !transaction.isReversed && !transaction.reversedTransactionId ? (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="text-destructive hover:text-destructive"
                                                onClick={() => setReverseTargetId(transaction.id)}
                                                aria-label={t('currencyExchange.reverse.action')}
                                            >
                                                <Undo2 className="h-4 w-4" />
                                            </Button>
                                        ) : transaction.isReversed ? (
                                            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2.5 py-0.5 text-xs font-semibold text-destructive">
                                                {t('currencyExchange.status.reversed')}
                                            </span>
                                        ) : transaction.reversedTransactionId ? (
                                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                                                {t('currencyExchange.status.reversal')}
                                            </span>
                                        ) : null}
                                    </TableCell>
                                </TableRow>
                                )
                            })}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <ReverseTransactionModal
                isOpen={!!reverseTargetId}
                onClose={() => setReverseTargetId(null)}
                onConfirm={handleReverse}
                transaction={transactions.find((transaction) => transaction.id === reverseTargetId)}
                isLoading={isReversing}
            />
        </div>
    )
}

function ExchangeSafesPage({
    workspaceId,
    iqdDisplayPreference,
    onBack
}: {
    workspaceId: string
    iqdDisplayPreference: IQDDisplayPreference
    onBack: () => void
}) {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { toast } = useToast()
    const safes = useExchangeSafes(workspaceId)
    const balances = useExchangeSafeBalances(workspaceId)
    const [selectedSafeId, setSelectedSafeId] = useState('')
    const selectedSafe = safes.find((safe) => safe.id === selectedSafeId) || safes[0] || null
    const movements = useExchangeSafeMovements(workspaceId, selectedSafe?.id)
    const isAdmin = user?.role === 'admin'
    const [createOpen, setCreateOpen] = useState(false)
    const [adjustOpen, setAdjustOpen] = useState(false)
    const [safeName, setSafeName] = useState('')
    const [safeNotes, setSafeNotes] = useState('')
    const [openingBalances, setOpeningBalances] = useState<Record<CurrencyCode, string>>({ iqd: '', usd: '', eur: '', try: '' })
    const [adjustCurrency, setAdjustCurrency] = useState<CurrencyCode>('iqd')
    const [adjustAmount, setAdjustAmount] = useState('')
    const [adjustNotes, setAdjustNotes] = useState('')
    const [isSavingSafe, setIsSavingSafe] = useState(false)
    const [hoveredMovementRelationKey, setHoveredMovementRelationKey] = useState<string | null>(null)

    const visibleMovements = useMemo(() => movements.slice(0, 50), [movements])
    const movementRelationMaps = useMemo(
        () => buildExchangeMovementRelationMaps(visibleMovements),
        [visibleMovements]
    )
    const hoveredMovementRange = hoveredMovementRelationKey
        ? (movementRelationMaps.ranges.get(hoveredMovementRelationKey) ?? null)
        : null
    const hasVisibleMovementRelations = Array.from(movementRelationMaps.counts.values()).some((count) => count > 1)

    useEffect(() => {
        if (!selectedSafeId && safes[0]) {
            setSelectedSafeId(safes[0].id)
        }
    }, [safes, selectedSafeId])

    const resetCreateForm = () => {
        setSafeName('')
        setSafeNotes('')
        setOpeningBalances({ iqd: '', usd: '', eur: '', try: '' })
    }

    const handleCreateSafe = async () => {
        setIsSavingSafe(true)
        try {
            const safe = await createExchangeSafe(workspaceId, {
                name: safeName,
                notes: safeNotes,
                openingBalances: Object.fromEntries(
                    EXCHANGE_SAFE_CURRENCIES.map((currency) => [currency, parseFormattedNumber(openingBalances[currency] || '0')])
                ) as Partial<Record<CurrencyCode, number>>,
                createdBy: user?.id ?? null,
                isAdmin
            })
            setSelectedSafeId(safe.id)
            setCreateOpen(false)
            resetCreateForm()
            toast({
                title: t('currencyExchange.messages.safeCreatedTitle'),
                description: t('currencyExchange.messages.safeCreatedDescription', { name: safe.name })
            })
        } catch (error: any) {
            toast({
                title: t('currencyExchange.messages.safeCreateFailedTitle'),
                description: error?.message || t('currencyExchange.messages.safeCreateFailedDescription'),
                variant: 'destructive'
            })
        } finally {
            setIsSavingSafe(false)
        }
    }

    const handleAdjustment = async () => {
        if (!selectedSafe) return
        setIsSavingSafe(true)
        try {
            const userName = user?.name || user?.email || 'Unknown'
            const adjustmentNotes = adjustNotes
                ? `${adjustNotes} (by ${userName})`
                : `Adjusted by ${userName}`
            await createExchangeSafeAdjustment(workspaceId, {
                safeId: selectedSafe.id,
                currency: adjustCurrency,
                amount: parseFormattedNumber(adjustAmount || '0'),
                notes: adjustmentNotes,
                createdBy: user?.id ?? null,
                isAdmin
            })
            setAdjustOpen(false)
            setAdjustAmount('')
            setAdjustNotes('')
            toast({
                title: t('currencyExchange.messages.adjustmentSavedTitle'),
                description: t('currencyExchange.messages.adjustmentSavedDescription', { name: selectedSafe.name })
            })
        } catch (error: any) {
            toast({
                title: t('currencyExchange.messages.adjustmentFailedTitle'),
                description: error?.message || t('currencyExchange.messages.adjustmentFailedDescription'),
                variant: 'destructive'
            })
        } finally {
            setIsSavingSafe(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <Button
                        type="button"
                        variant="ghost"
                        className="h-auto gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                        onClick={onBack}
                    >
                        <ArrowLeft className="h-4 w-4" />
                        {t('currencyExchange.serviceTitle')}
                    </Button>
                    <h1 className="mt-1 flex items-center gap-2 text-3xl font-bold tracking-tight">
                        <Vault className="h-7 w-7" />
                        {t('currencyExchange.safes.pageTitle')}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t('currencyExchange.safes.description')}
                    </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                    {isAdmin && selectedSafe ? (
                        <Button type="button" variant="outline" onClick={() => setAdjustOpen(true)}>
                            {t('currencyExchange.buttons.adjustment')}
                        </Button>
                    ) : null}
                    <Button type="button" onClick={() => setCreateOpen(true)} className="gap-2">
                        <Plus className="h-4 w-4" />
                        {t('currencyExchange.buttons.createSafe')}
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('currencyExchange.safes.title')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {safes.length === 0 ? (
                            <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                                {t('currencyExchange.empty.safes')}
                            </div>
                        ) : safes.map((safe) => (
                            <button
                                key={safe.id}
                                type="button"
                                className={cn(
                                    'w-full rounded-xl border px-3 py-3 text-start transition-colors',
                                    selectedSafe?.id === safe.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                                )}
                                onClick={() => setSelectedSafeId(safe.id)}
                            >
                                <div className="font-semibold">{safe.name}</div>
                                <div className="text-xs text-muted-foreground">{safeStatusLabel(safe.isActive, t)}</div>
                            </button>
                        ))}
                    </CardContent>
                </Card>

                <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        {EXCHANGE_SAFE_CURRENCIES.map((currency) => (
                            <SafeCurrencyCard
                                key={currency}
                                currency={currency}
                                balance={formatCurrency(getSafeBalanceAmount(balances, selectedSafe?.id, currency), currency, iqdDisplayPreference)}
                            />
                        ))}
                    </div>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <History className="h-5 w-5" />
                                {t('currencyExchange.safes.movementAudit')}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <Table className={cn(hasVisibleMovementRelations && 'ms-6 w-[calc(100%-1.5rem)]')}>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('currencyExchange.table.date')}</TableHead>
                                        <TableHead>{t('currencyExchange.table.type')}</TableHead>
                                        <TableHead>{t('currencyExchange.table.currency')}</TableHead>
                                        <TableHead>{t('currencyExchange.table.delta')}</TableHead>
                                        <TableHead>{t('currencyExchange.table.before')}</TableHead>
                                        <TableHead>{t('currencyExchange.table.after')}</TableHead>
                                        <TableHead>{t('currencyExchange.table.notes')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {movements.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                                                {t('currencyExchange.empty.movements')}
                                            </TableCell>
                                        </TableRow>
                                    ) : visibleMovements.map((movement, rowIndex) => {
                                        const movementRelationKey = getExchangeMovementRelationKey(movement)
                                        const isRelationHovered = !!hoveredMovementRelationKey && movementRelationKey === hoveredMovementRelationKey
                                        const relatedVisibleCount = movementRelationKey ? (movementRelationMaps.counts.get(movementRelationKey) || 0) : 0
                                        const hasVisibleLinkedPeer = relatedVisibleCount > 1
                                        const showHierarchyLine = !!hoveredMovementRange
                                            && hoveredMovementRange.firstIndex !== hoveredMovementRange.lastIndex
                                            && rowIndex >= hoveredMovementRange.firstIndex
                                            && rowIndex <= hoveredMovementRange.lastIndex
                                        const showHierarchyTurn = isRelationHovered && hasVisibleLinkedPeer
                                        const hierarchyVerticalClass = hoveredMovementRange && rowIndex === hoveredMovementRange.firstIndex
                                            ? 'top-1/2 bottom-0'
                                            : hoveredMovementRange && rowIndex === hoveredMovementRange.lastIndex
                                                ? 'top-0 bottom-1/2'
                                                : 'top-0 bottom-0'

                                        return (
                                        <TableRow
                                            key={movement.id}
                                            className={cn(
                                                movementRelationKey && 'transition-colors duration-150',
                                                isRelationHovered && hasVisibleLinkedPeer && 'bg-yellow-500/10'
                                            )}
                                            onMouseEnter={() => {
                                                if (movementRelationKey) {
                                                    setHoveredMovementRelationKey(movementRelationKey)
                                                }
                                            }}
                                            onMouseLeave={() => {
                                                if (movementRelationKey) {
                                                    setHoveredMovementRelationKey((current) => current === movementRelationKey ? null : current)
                                                }
                                            }}
                                        >
                                            <TableCell className="relative">
                                                {showHierarchyLine ? (
                                                    <div className="pointer-events-none absolute inset-y-0 -start-6 w-5">
                                                        <span
                                                            className={cn(
                                                                'absolute start-1.5 w-px bg-yellow-500',
                                                                hierarchyVerticalClass
                                                            )}
                                                        />
                                                        {showHierarchyTurn ? (
                                                            <span className="absolute start-1.5 top-1/2 h-px w-3 -translate-y-1/2 bg-yellow-500" />
                                                        ) : null}
                                                    </div>
                                                ) : null}
                                                {formatDateTime(movement.createdAt)}
                                            </TableCell>
                                            <TableCell>{movementTypeLabel(movement.movementType, t)}</TableCell>
                                            <TableCell>{movement.currency.toUpperCase()}</TableCell>
                                            <TableCell className={movement.deltaAmount < 0 ? 'text-destructive' : 'text-emerald-700'}>
                                                {formatCurrency(movement.deltaAmount, movement.currency, iqdDisplayPreference)}
                                            </TableCell>
                                            <TableCell>{formatCurrency(movement.balanceBefore, movement.currency, iqdDisplayPreference)}</TableCell>
                                            <TableCell>{formatCurrency(movement.balanceAfter, movement.currency, iqdDisplayPreference)}</TableCell>
                                            <TableCell>{movement.notes || '-'}</TableCell>
                                        </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogContent className="max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{t('currencyExchange.safes.createTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('currencyExchange.safes.createDescription')}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4">
                        <div className="grid gap-2">
                            <Label>{t('currencyExchange.labels.safeName')}</Label>
                            <Input value={safeName} onChange={(event) => setSafeName(event.target.value)} placeholder={t('currencyExchange.placeholders.safeName')} />
                        </div>
                        {isAdmin ? (
                            <div className="grid gap-3 sm:grid-cols-2">
                                {EXCHANGE_SAFE_CURRENCIES.map((currency) => (
                                    <div key={currency} className="grid gap-2">
                                        <Label>{t('currencyExchange.labels.openingCurrency', { currency: currency.toUpperCase() })}</Label>
                                        <Input
                                            type="text"
                                            inputMode="decimal"
                                            value={formatNumericInput(openingBalances[currency])}
                                            onChange={(event) => setOpeningBalances((prev) => ({
                                                ...prev,
                                                [currency]: sanitizeNumericInput(event.target.value, { allowDecimal: currency !== 'iqd' })
                                            }))}
                                            placeholder="0"
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="rounded-xl border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                                {t('currencyExchange.safes.adminOpeningOnly')}
                            </div>
                        )}
                        <div className="grid gap-2">
                            <Label>{t('currencyExchange.labels.notes')}</Label>
                            <Textarea value={safeNotes} onChange={(event) => setSafeNotes(event.target.value)} rows={3} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
                        <Button type="button" onClick={handleCreateSafe} disabled={isSavingSafe || !safeName.trim()}>
                            {t('currencyExchange.buttons.createSafe')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={adjustOpen} onOpenChange={setAdjustOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('currencyExchange.safes.adjustmentTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('currencyExchange.safes.adjustmentDescription', { name: selectedSafe?.name || t('currencyExchange.labels.selectedSafe') })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4">
                        <div className="grid gap-2">
                            <Label>{t('common.currency', { defaultValue: 'Currency' })}</Label>
                            <Select value={adjustCurrency} onValueChange={(value: CurrencyCode) => setAdjustCurrency(value)}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {EXCHANGE_SAFE_CURRENCIES.map((currency) => (
                                        <SelectItem key={currency} value={currency}>{currency.toUpperCase()}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="grid gap-2">
                            <Label>{t('currencyExchange.labels.amountDelta')}</Label>
                            <Input
                                type="text"
                                inputMode="decimal"
                                value={adjustAmount.startsWith('-') ? `-${formatNumericInput(adjustAmount.slice(1))}` : formatNumericInput(adjustAmount)}
                                onChange={(event) => setAdjustAmount(sanitizeSignedNumericInput(event.target.value, { allowDecimal: adjustCurrency !== 'iqd' }))}
                                placeholder={t('currencyExchange.placeholders.negativeDecrease')}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label>{t('currencyExchange.labels.notes')}</Label>
                            <Textarea value={adjustNotes} onChange={(event) => setAdjustNotes(event.target.value)} rows={3} />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setAdjustOpen(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
                        <Button type="button" onClick={handleAdjustment} disabled={isSavingSafe || !adjustAmount}>
                            {t('currencyExchange.buttons.saveAdjustment')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

function CreateCurrencyExchangeTransactionPage({
    workspaceId,
    onCancel,
    onCreated
}: {
    workspaceId: string
    onCancel: () => void
    onCreated: () => void
}) {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const rules = useExchangeFeeRules(workspaceId)
    const pairPrices = useExchangePairPrices(workspaceId)
    const safes = useExchangeSafes(workspaceId)
    const safeBalances = useExchangeSafeBalances(workspaceId)
    const [isSaving, setIsSaving] = useState(false)
    const [transactionType, setTransactionType] = useState<ExchangeTransactionType>('buy')
    const [selectedPairKey, setSelectedPairKey] = useState(getExchangePairKey('usd', 'iqd'))
    const [selectedSafeId, setSelectedSafeId] = useState('')
    const [customerGivesAmount, setCustomerGivesAmount] = useState('')
    const [transactionDate, setTransactionDate] = useState(currentTimestamp())
    const [paymentMethod, setPaymentMethod] = useState<ExchangePaymentMethod>('cash')
    const [notes, setNotes] = useState('')
    const [acquisitionRateValue, setAcquisitionRateValue] = useState('')
    const [acquisitionRateSource, setAcquisitionRateSource] = useState<ExchangeAcquisitionRateSource | null>(null)
    const [selectedRuleId, setSelectedRuleId] = useState<string>('none')
    const [feeValue, setFeeValue] = useState('')
    const prevAcquisitionKeyRef = useRef('')

    const exchangePairOptions = useMemo(() => buildExchangePairOptions(EXCHANGE_SAFE_CURRENCIES), [])
    const selectedPair = useMemo(() => (
        parseExchangePairKey(selectedPairKey) || { baseCurrency: 'usd' as CurrencyCode, quoteCurrency: 'iqd' as CurrencyCode }
    ), [selectedPairKey])
    const selectedPairPrice = useMemo(() => (
        findExchangePairPrice(pairPrices, selectedPair.baseCurrency, selectedPair.quoteCurrency)
    ), [pairPrices, selectedPair.baseCurrency, selectedPair.quoteCurrency])
    const { fromCurrency, toCurrency } = getExchangePairTransactionCurrencies(selectedPair, transactionType)
    const parsedRate = selectedPairPrice ? getExchangePairSidePrice(selectedPairPrice, transactionType) : 0
    const exchangeRateSource = 'manual_pair_price'
    const activeSafes = useMemo(() => safes.filter((safe) => safe.isActive), [safes])
    const selectedSafe = activeSafes.find((safe) => safe.id === selectedSafeId) || null

    useEffect(() => {
        if (!selectedSafeId && activeSafes[0]) {
            setSelectedSafeId(activeSafes[0].id)
        } else if (selectedSafeId && activeSafes.length > 0 && !activeSafes.some((safe) => safe.id === selectedSafeId)) {
            setSelectedSafeId(activeSafes[0].id)
        }
    }, [activeSafes, selectedSafeId])

    const activeRule = useMemo(() => (
        resolveEffectiveExchangeFeeRule(rules, transactionType, transactionDate, fromCurrency)
    ), [fromCurrency, rules, transactionDate, transactionType])
    const effectiveRulesForSelectedDate = useMemo(() => (
        rules.filter((rule) =>
            isExchangeFeeRuleEffectiveForTransaction(rule, transactionType, transactionDate, fromCurrency)
        )
    ), [fromCurrency, rules, transactionDate, transactionType])
    const pendingRulesForSelectedDate = useMemo(() => (
        rules
            .filter((rule) =>
                feeRuleMatchesTransactionContext(rule, transactionType, fromCurrency)
                && getExchangeFeeRuleTemporalStatus(rule, transactionDate) === 'pending'
            )
            .sort((left, right) => getRuleDateSortValue(left.effectiveStartDate) - getRuleDateSortValue(right.effectiveStartDate))
    ), [fromCurrency, rules, transactionDate, transactionType])

    useEffect(() => {
        if (!activeRule) {
            setSelectedRuleId('none')
            setFeeValue('')
            return
        }

        setSelectedRuleId(activeRule.id)
        setFeeValue(String(activeRule.value))
    }, [activeRule?.id])

    const selectedRule = selectedRuleId === 'none'
        ? null
        : rules.find((rule) => rule.id === selectedRuleId) || null
    const feeType = selectedRule?.feeType ?? null
    const feeCurrency = selectedRule?.currency ?? fromCurrency
    const feeBasisAmount = selectedRule ? getExchangeFeeBasisAmount(selectedRule, feeCurrency) : getDefaultExchangeFeeBasisAmount(feeCurrency)
    const parsedFeeValue = parseFormattedNumber(feeValue || '0')
    const parsedCustomerGives = parseFormattedNumber(customerGivesAmount || '0')
    const parsedAcquisitionRate = parseFormattedNumber(acquisitionRateValue || '0')
    const canEditFee = !selectedRule || !selectedRule.isLocked

    const calculation = useMemo(() => {
        if (!parsedCustomerGives || !selectedPairPrice || parsedRate <= 0) {
            return null
        }

        try {
            return calculateExchangeTransaction({
                transactionType,
                pairPrice: selectedPairPrice,
                customerGivesAmount: parsedCustomerGives,
                feeType,
                feeCurrency,
                feeValue: parsedFeeValue,
                feeBasisAmount
            })
        } catch {
            return null
        }
    }, [feeBasisAmount, feeCurrency, feeType, parsedCustomerGives, parsedFeeValue, parsedRate, selectedPairPrice, transactionType])

    useEffect(() => {
        const acquisitionKey = `${transactionType}:${selectedSafeId}:${fromCurrency}:${toCurrency}:${transactionDate}`
        const contextChanged = prevAcquisitionKeyRef.current !== acquisitionKey
        if (contextChanged) {
            prevAcquisitionKeyRef.current = acquisitionKey
        }
        if (transactionType !== 'sell' || !selectedSafeId || fromCurrency === toCurrency) {
            setAcquisitionRateValue('')
            setAcquisitionRateSource(null)
            return
        }
        if (!contextChanged && acquisitionRateSource === 'manual') {
            return
        }

        let cancelled = false
        findLatestSafeBuyForAcquisitionRate({
            workspaceId,
            safeId: selectedSafeId,
            soldCurrency: toCurrency,
            profitCurrency: fromCurrency,
            beforeTransactionDate: transactionDate
        }).then((latestBuy) => {
            if (cancelled) return
            if (latestBuy) {
                setAcquisitionRateValue(formatNumberWithCommas(latestBuy.acquisitionRate))
                setAcquisitionRateSource('last_buy')
            } else {
                setAcquisitionRateValue('')
                setAcquisitionRateSource('manual')
            }
        })

        return () => {
            cancelled = true
        }
    }, [acquisitionRateSource, fromCurrency, selectedSafeId, toCurrency, transactionDate, transactionType, workspaceId])

    const profitPreview = useMemo(() => {
        if (transactionType !== 'sell' || !calculation || parsedAcquisitionRate <= 0) {
            return null
        }
        try {
            return calculateExchangeProfit({
                transactionType,
                fromCurrency,
                toCurrency,
                customerGivesAmount: parsedCustomerGives,
                customerReceivesAmount: calculation.customerReceivesAmount,
                acquisitionRate: parsedAcquisitionRate
            })
        } catch {
            return null
        }
    }, [calculation, fromCurrency, parsedAcquisitionRate, parsedCustomerGives, toCurrency, transactionType])

    const marketRateSnapshot = useMemo<ExchangeRateSnapshot[]>(() => {
        if (!selectedPairPrice || parsedRate <= 0) return []
        return [{
            pair: getExchangePairLabel(selectedPair.baseCurrency, selectedPair.quoteCurrency),
            rate: parsedRate,
            source: exchangeRateSource,
            timestamp: new Date().toISOString(),
            side: transactionType,
            priceBasisAmount: selectedPairPrice.priceBasisAmount,
            priceRowId: selectedPairPrice.id,
            priceUpdatedAt: selectedPairPrice.updatedAt
        }]
    }, [exchangeRateSource, parsedRate, selectedPair.baseCurrency, selectedPair.quoteCurrency, selectedPairPrice, transactionType])

    const outgoingSafeBalance = getSafeBalanceAmount(safeBalances, selectedSafeId, toCurrency)
    const hasInsufficientSafeBalance = Boolean(
        calculation
        && selectedSafeId
        && outgoingSafeBalance + 0.000001 < calculation.customerReceivesAmount
    )
    const acquisitionRateRequired = transactionType === 'sell'

    const canSubmit = Boolean(selectedPairPrice) &&
        parsedRate > 0 &&
        Boolean(selectedSafeId) &&
        parsedCustomerGives > 0 &&
        Boolean(calculation) &&
        marketRateSnapshot.length > 0 &&
        !hasInsufficientSafeBalance &&
        (!acquisitionRateRequired || parsedAcquisitionRate > 0)

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!canSubmit || isSaving || !calculation || !selectedPairPrice) return

        setIsSaving(true)
        try {
            await createExchangeTransaction(workspaceId, {
                transactionType,
                transactionDate,
                safeId: selectedSafeId,
                pairPrice: selectedPairPrice,
                customerGivesAmount: parsedCustomerGives,
                exchangeRateUsed: parsedRate,
                exchangeRateSource,
                exchangeRateManuallyEdited: false,
                marketRateSnapshot,
                feeRuleId: selectedRule?.id ?? null,
                feeRuleSnapshot: selectedRule ? buildExchangeFeeRuleSnapshot(selectedRule) : null,
                feeType,
                feeCurrency,
                originalFeeValue: selectedRule?.value ?? null,
                finalFeeValue: parsedFeeValue,
                feeBasisAmount,
                acquisitionRate: transactionType === 'sell' ? parsedAcquisitionRate : null,
                acquisitionRateSource: transactionType === 'sell' ? (acquisitionRateSource || 'manual') : null,
                acquisitionRateSnapshot: transactionType === 'sell' ? marketRateSnapshot : null,
                paymentMethod,
                employeeUserId: user?.id ?? null,
                employeeName: user?.name ?? null,
                notes,
                createdBy: user?.id ?? null
            })

            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: t('currencyExchange.messages.transactionCreated')
            })
            onCreated()
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('currencyExchange.messages.transactionCreateFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    const switchPairCurrencies = () => {
        setSelectedPairKey(getExchangePairKey(selectedPair.quoteCurrency, selectedPair.baseCurrency))
        setCustomerGivesAmount('')
    }

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background">
            <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-4 lg:p-6 custom-scrollbar">
                    <div className="grid gap-5 pb-5 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
                        <div className="space-y-5">
                        <div className="space-y-1">
                            <Button
                                type="button"
                                variant="ghost"
                                className="h-auto gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                                onClick={onCancel}
                            >
                                <ArrowLeft className="h-4 w-4" />
                                {t('currencyExchange.serviceTitle')}
                            </Button>
                            <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
                                <ArrowRightLeft className="h-7 w-7" />
                                {t('currencyExchange.create.title')}
                            </h1>
                            <p className="text-sm text-muted-foreground">
                                {t('currencyExchange.create.description')}
                            </p>
                        </div>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('currencyExchange.create.transactionDetails')}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="grid gap-4">
                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                                        <div className="grid gap-2">
                                            <FieldLabelWithTooltip
                                                label={t('currencyExchange.labels.transactionType')}
                                                tooltip={t('currencyExchange.tooltips.transactionType')}
                                            />
                                            <Select value={transactionType} onValueChange={(value: ExchangeTransactionType) => setTransactionType(value)}>
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="buy">{t('currencyExchange.transactionTypes.buy')}</SelectItem>
                                                    <SelectItem value="sell">{t('currencyExchange.transactionTypes.sell')}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="grid gap-2">
                                            <Label>{t('currencyExchange.labels.transactionDate')}</Label>
                                            <DateTimePicker
                                                id="currency-exchange-transaction-date"
                                                mode="date-time"
                                                date={parseLocalDateTimeValue(transactionDate)}
                                                setDate={(value) => setTransactionDate(toTimestampValue(value))}
                                                placeholder={t('currencyExchange.labels.transactionDate')}
                                            />
                                        </div>
                                        <div className="grid gap-2">
                                            <Label>{t('currencyExchange.labels.employee')}</Label>
                                            <Input value={user?.name || ''} readOnly className="bg-muted/40" />
                                        </div>
                                        <div className="grid gap-2">
                                            <FieldLabelWithTooltip
                                                label={t('currencyExchange.labels.safe')}
                                                tooltip={t('currencyExchange.tooltips.safe')}
                                            />
                                            <Select value={selectedSafeId} onValueChange={setSelectedSafeId}>
                                                <SelectTrigger><SelectValue placeholder={t('currencyExchange.placeholders.selectSafe')} /></SelectTrigger>
                                                <SelectContent>
                                                    {activeSafes.map((safe) => (
                                                        <SelectItem key={safe.id} value={safe.id}>{safe.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    {activeSafes.length === 0 ? (
                                        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                            {t('currencyExchange.messages.createSafeFirst')}
                                        </div>
                                    ) : null}

                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto_1fr] md:items-end">
                                        <div className="grid gap-2 md:col-span-2">
                                            <FieldLabelWithTooltip
                                                label={t('currencyExchange.labels.currencyPair')}
                                                tooltip={t('currencyExchange.tooltips.currencyPair', { defaultValue: 'Select the ordered pair. USD/EUR and EUR/USD are separate manual price rows.' })}
                                            />
                                            <Select value={selectedPairKey} onValueChange={(value) => {
                                                setSelectedPairKey(value)
                                                setCustomerGivesAmount('')
                                            }}>
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    {exchangePairOptions.map((option) => (
                                                        <SelectItem key={option.key} value={option.key}>
                                                            {getExchangePairLabel(option.baseCurrency, option.quoteCurrency)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <Button type="button" variant="outline" size="icon" className="mb-0.5" onClick={switchPairCurrencies} aria-label={t('currencyExchange.buttons.swapCurrencies')}>
                                            <ArrowRightLeft className="h-4 w-4" />
                                        </Button>
                                        <div className="rounded-xl border bg-muted/20 p-3 md:col-span-3">
                                            <div className="grid gap-3 text-sm sm:grid-cols-2">
                                                <div>
                                                    <div className="text-xs font-medium uppercase text-muted-foreground">{t('currencyExchange.labels.customerGives')}</div>
                                                    <div className="mt-1 font-semibold">{fromCurrency.toUpperCase()} - {getLocalizedCurrencyName(fromCurrency, i18n.resolvedLanguage || i18n.language)}</div>
                                                </div>
                                                <div>
                                                    <div className="text-xs font-medium uppercase text-muted-foreground">{t('currencyExchange.labels.customerReceives')}</div>
                                                    <div className="mt-1 font-semibold">{toCurrency.toUpperCase()} - {getLocalizedCurrencyName(toCurrency, i18n.resolvedLanguage || i18n.language)}</div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {!selectedPairPrice || parsedRate <= 0 ? (
                                        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                            {t('currencyExchange.messages.missingPairPrice', {
                                                defaultValue: 'Set a non-zero {{side}} price for {{pair}} before creating this transaction.',
                                                side: transactionTypeLabel(transactionType, t),
                                                pair: getExchangePairLabel(selectedPair.baseCurrency, selectedPair.quoteCurrency)
                                            })}
                                        </div>
                                    ) : null}

                                    {hasInsufficientSafeBalance && calculation ? (
                                        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                            {t('currencyExchange.messages.insufficientSafeBalance', {
                                                safe: selectedSafe?.name || t('currencyExchange.labels.selectedSafe'),
                                                available: formatCurrency(outgoingSafeBalance, toCurrency, features.iqd_display_preference),
                                                pays: formatCurrency(calculation.customerReceivesAmount, toCurrency, features.iqd_display_preference)
                                            })}
                                        </div>
                                    ) : null}

                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                        <div className="grid gap-2">
                                            <FieldLabelWithTooltip
                                                label={t('currencyExchange.labels.customerGives')}
                                                tooltip={t('currencyExchange.tooltips.customerGives')}
                                            />
                                            <div className="relative">
                                                <Input
                                                    type="text"
                                                    inputMode={fromCurrency === 'iqd' ? 'numeric' : 'decimal'}
                                                    placeholder="0"
                                                    className="pr-12"
                                                    value={formatNumericInput(customerGivesAmount)}
                                                    onChange={(event) => setCustomerGivesAmount(sanitizeNumericInput(event.target.value, { allowDecimal: fromCurrency !== 'iqd' }))}
                                                />
                                                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">
                                                    {fromCurrency === 'iqd' ? features.iqd_display_preference : fromCurrency === 'usd' ? '$' : fromCurrency.toUpperCase()}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="grid gap-2">
                                            <Label>{t('currencyExchange.labels.paymentMethod')}</Label>
                                            <PaymentMethodSelect
                                                value={paymentMethod}
                                                onValueChange={(value) => setPaymentMethod(value as ExchangePaymentMethod)}
                                                workspaceId={workspaceId}
                                                methods={CASH_AND_DIGITAL_PAYMENT_METHODS}
                                            />
                                        </div>
                                        <div className="grid gap-2">
                                            <FieldLabelWithTooltip
                                                label={t('currencyExchange.labels.customerReceives')}
                                                tooltip={t('currencyExchange.tooltips.customerReceives')}
                                            />
                                            <div className="flex h-10 items-center rounded-md border border-input bg-muted/40 px-3 text-sm font-semibold">
                                                {calculation
                                                    ? formatCurrency(calculation.customerReceivesAmount, toCurrency, features.iqd_display_preference)
                                                    : formatCurrency(0, toCurrency, features.iqd_display_preference)}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('currencyExchange.create.manualPriceSnapshot', { defaultValue: 'Manual Price Snapshot' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="text-sm font-semibold">{t('currencyExchange.labels.exchangeRate')}</div>
                                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                                            {rateSourceLabel(exchangeRateSource, t)}
                                        </span>
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="grid gap-2">
                                            <Label>{t('currencyExchange.labels.currencyPair')}</Label>
                                            <div className="flex h-10 w-full items-center rounded-md border border-input bg-background px-3 py-2 text-sm">
                                                {getExchangePairLabel(selectedPair.baseCurrency, selectedPair.quoteCurrency)}
                                            </div>
                                        </div>
                                        <div className="grid gap-2">
                                            <Label>{transactionType === 'buy' ? t('currencyExchange.labels.buyPrice', { defaultValue: 'Buy price' }) : t('currencyExchange.labels.sellPrice', { defaultValue: 'Sell price' })}</Label>
                                            <div className="flex h-10 w-full items-center rounded-md border border-input bg-muted/40 px-3 py-2 text-sm font-semibold">
                                                {parsedRate > 0 ? formatNumberWithCommas(parsedRate) : '-'}
                                            </div>
                                            <p className="text-xs text-muted-foreground">
                                                {t('currencyExchange.help.pairPriceBasis', {
                                                    defaultValue: 'Price is per {{basis}} {{base}} in {{quote}}.',
                                                    basis: formatNumberWithCommas(selectedPairPrice?.priceBasisAmount ?? DEFAULT_EXCHANGE_PAIR_PRICE_BASIS),
                                                    base: selectedPair.baseCurrency.toUpperCase(),
                                                    quote: selectedPair.quoteCurrency.toUpperCase()
                                                })}
                                            </p>
                                        </div>
                                        {transactionType === 'sell' ? (
                                            <div className="grid gap-2 sm:col-span-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <Label>{t('currencyExchange.labels.acquisitionRate')}</Label>
                                                    <span className={cn(
                                                        'rounded-full px-2 py-0.5 text-xs font-medium',
                                                        acquisitionRateSource === 'last_buy' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                                                    )}>
                                                        {acquisitionSourceLabel(acquisitionRateSource, t)}
                                                    </span>
                                                </div>
                                                <Input
                                                    type="text"
                                                    inputMode="decimal"
                                                    value={formatNumericInput(acquisitionRateValue)}
                                                    onChange={(event) => {
                                                        setAcquisitionRateValue(sanitizeNumericInput(event.target.value, { allowDecimal: fromCurrency !== 'iqd', maxFractionDigits: 6 }))
                                                        setAcquisitionRateSource('manual')
                                                    }}
                                                    placeholder={t('currencyExchange.placeholders.acquisitionRate', {
                                                        basis: formatNumberWithCommas(getExchangeRateBasisAmount(toCurrency)),
                                                        to: toCurrency.toUpperCase(),
                                                        from: fromCurrency.toUpperCase()
                                                    })}
                                                />
                                                <p className="text-xs text-muted-foreground">
                                                    {t('currencyExchange.help.acquisitionRate', {
                                                        to: toCurrency.toUpperCase(),
                                                        from: fromCurrency.toUpperCase()
                                                    })}
                                                </p>
                                            </div>
                                        ) : null}
                                    </div>
                                    {profitPreview?.profitCurrency ? (
                                        <div className="rounded-xl border bg-muted/20 px-3 py-2 text-sm">
                                            {t('currencyExchange.labels.estimatedProfit')}: <span className="font-semibold">{formatCurrency(profitPreview.profitAmount || 0, profitPreview.profitCurrency, features.iqd_display_preference)}</span>
                                        </div>
                                    ) : null}
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('currencyExchange.feeRules.sectionTitle')}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="grid gap-4">
                                    <div className={cn(
                                        'rounded-2xl border p-4',
                                        activeRule
                                            ? 'border-emerald-500/25 bg-emerald-500/10'
                                            : 'border-muted bg-muted/20'
                                    )}>
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="flex gap-3">
                                                <div className={cn(
                                                    'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                                                    activeRule
                                                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                                        : 'bg-muted text-muted-foreground'
                                                )}>
                                                    <CalendarClock className="h-4 w-4" />
                                                </div>
                                                <div>
                                                    <div className="text-sm font-semibold">
                                                        {t('currencyExchange.feeRules.selectedDateRule', { defaultValue: 'Rule for selected transaction date' })}
                                                    </div>
                                                    <p className="mt-1 text-sm text-muted-foreground">
                                                        {activeRule
                                                            ? t('currencyExchange.feeRules.selectedDateRuleApplies', {
                                                                defaultValue: '{{rule}} is effective for {{date}} and is the default rule for this transaction.',
                                                                rule: activeRule.name,
                                                                date: formatDateTime(transactionDate)
                                                            })
                                                            : t('currencyExchange.feeRules.selectedDateRuleNone', {
                                                                defaultValue: 'No fee rule is effective for {{date}}.',
                                                                date: formatDateTime(transactionDate)
                                                            })}
                                                    </p>
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        {t('currencyExchange.feeRules.selectedDateRuleSelectionHelp', {
                                                            defaultValue: 'The rule dropdown only includes rules effective for the selected transaction date.'
                                                        })}
                                                    </p>
                                                </div>
                                            </div>
                                            <span className={cn(
                                                'inline-flex w-fit rounded-full px-2.5 py-1 text-xs font-medium',
                                                activeRule
                                                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                                    : 'bg-muted text-muted-foreground'
                                            )}>
                                                {activeRule
                                                    ? t('currencyExchange.status.applies', { defaultValue: 'Applies' })
                                                    : t('currencyExchange.labels.noFee')}
                                            </span>
                                        </div>
                                        {pendingRulesForSelectedDate.length > 0 ? (
                                            <div className="mt-3 grid gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                                                <div className="font-semibold">
                                                    {t('currencyExchange.feeRules.pendingRulesForDate', {
                                                        defaultValue: 'Scheduled rules are pending for this transaction date.'
                                                    })}
                                                </div>
                                                {pendingRulesForSelectedDate.slice(0, 3).map((rule) => (
                                                    <div key={rule.id}>
                                                        {t('currencyExchange.feeRules.pendingRuleStarts', {
                                                            defaultValue: '{{rule}} starts at {{start}} and is not active for {{date}}.',
                                                            rule: rule.name,
                                                            start: formatDateTime(rule.effectiveStartDate),
                                                            date: formatDateTime(transactionDate)
                                                        })}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>

                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                        <div className="grid gap-2">
                                            <Label>{t('currencyExchange.labels.rule')}</Label>
                                            <Select value={selectedRuleId} onValueChange={(value) => {
                                                setSelectedRuleId(value)
                                                const rule = rules.find((item) => item.id === value)
                                                setFeeValue(rule ? String(rule.value) : '')
                                            }}>
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">{t('currencyExchange.labels.noFee')}</SelectItem>
                                                    {effectiveRulesForSelectedDate.map((rule) => (
                                                        <SelectItem key={rule.id} value={rule.id}>{rule.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="grid gap-2">
                                            <Label>{t('currencyExchange.labels.feeType')}</Label>
                                            <div className="flex h-10 items-center rounded-md border border-input bg-muted/40 px-3 text-sm capitalize">
                                                {feeTypeLabel(selectedRule?.feeType, t)}
                                            </div>
                                        </div>
                                        <div className="grid gap-2">
                                            <Label>{selectedRule?.feeType === 'percentage' ? t('currencyExchange.labels.percentageRate') : t('currencyExchange.labels.fixedFee')}</Label>
                                            <Input
                                                type="text"
                                                inputMode="decimal"
                                                value={formatNumericInput(feeValue)}
                                                onChange={(event) => setFeeValue(sanitizeNumericInput(event.target.value, { allowDecimal: selectedRule?.feeType !== 'fixed' || feeCurrency !== 'iqd' }))}
                                                placeholder="0"
                                                readOnly={!canEditFee}
                                                className={!canEditFee ? 'bg-muted/40' : undefined}
                                            />
                                            {selectedRule ? (
                                                <p className="text-xs text-muted-foreground">
                                                    {t('currencyExchange.help.originalRuleValue', {
                                                        value: selectedRule.value.toLocaleString(),
                                                        unit: selectedRule.feeType === 'percentage' ? '%' : selectedRule.currency.toUpperCase()
                                                    })}
                                                    {selectedRule.isLocked ? ` / ${t('currencyExchange.status.locked')}` : ''}
                                                </p>
                                            ) : null}
                                        </div>
                                        <div className="grid gap-2">
                                            <Label>{t('currencyExchange.labels.customerGivesBasis')}</Label>
                                            <div className="flex h-10 items-center rounded-md border border-input bg-muted/40 px-3 text-sm font-semibold">
                                                {selectedRule
                                                    ? formatCurrency(feeBasisAmount, feeCurrency, features.iqd_display_preference)
                                                    : '-'}
                                            </div>
                                            {selectedRule ? (
                                                <p className="text-xs text-muted-foreground">
                                                    {selectedRule.feeType === 'fixed'
                                                        ? t('currencyExchange.help.fixedFeeBasis')
                                                        : t('currencyExchange.help.percentageBasis')}
                                                </p>
                                            ) : null}
                                        </div>
                                    </div>

                                    {calculation ? (
                                        <div className="grid gap-3 rounded-2xl border bg-muted/20 p-4 sm:grid-cols-4">
                                            <InfoBlock label={t('currencyExchange.labels.beforeFee')} value={formatCurrency(calculation.baseReceivesAmount, toCurrency, features.iqd_display_preference)} />
                                            <InfoBlock label={t('currencyExchange.labels.ruleBasis')} value={selectedRule ? formatCurrency(feeBasisAmount, feeCurrency, features.iqd_display_preference) : '-'} />
                                            <InfoBlock label={t('currencyExchange.labels.feeApplied')} value={formatCurrency(calculation.feeAmount, feeCurrency, features.iqd_display_preference)} />
                                            <InfoBlock label={t('currencyExchange.labels.finalReceives')} value={formatCurrency(calculation.customerReceivesAmount, toCurrency, features.iqd_display_preference)} />
                                        </div>
                                    ) : null}
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t('currencyExchange.labels.notes')}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Textarea
                                    rows={4}
                                    value={notes}
                                    onChange={(event) => setNotes(event.target.value)}
                                    placeholder={t('currencyExchange.placeholders.transactionNotes')}
                                />
                            </CardContent>
                        </Card>
                        </div>

                        <ExchangeTransactionSummary
                            transactionType={transactionType}
                            transactionDate={transactionDate}
                            fromCurrency={fromCurrency}
                            toCurrency={toCurrency}
                            customerGivesAmount={parsedCustomerGives}
                            paymentMethod={paymentMethod}
                            employeeName={user?.name || '-'}
                            safeName={selectedSafe?.name || '-'}
                            exchangeRate={parsedRate}
                            exchangeRateSource={exchangeRateSource}
                            acquisitionRate={transactionType === 'sell' ? parsedAcquisitionRate : null}
                            acquisitionRateSource={transactionType === 'sell' ? acquisitionRateSource : null}
                            profitAmount={profitPreview?.profitAmount ?? null}
                            profitCurrency={profitPreview?.profitCurrency ?? null}
                            feeRuleName={selectedRule?.name || t('currencyExchange.labels.noFee')}
                            feeType={feeType}
                            feeCurrency={feeCurrency}
                            originalFeeValue={selectedRule?.value ?? null}
                            finalFeeValue={parsedFeeValue}
                            feeBasisAmount={selectedRule ? feeBasisAmount : null}
                            feeEdited={Boolean(selectedRule && parsedFeeValue !== Number(selectedRule.value || 0))}
                            calculation={calculation}
                            iqdDisplayPreference={features.iqd_display_preference}
                            marketRateSnapshot={marketRateSnapshot}
                        />
                    </div>
                </div>
                <div className="flex-shrink-0 border-t bg-background/95 px-4 py-2 backdrop-blur lg:px-6">
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                        <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onCancel} disabled={isSaving}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button type="submit" className="w-full sm:w-auto" disabled={!canSubmit || isSaving}>
                            {t('common.create', { defaultValue: 'Create' })}
                        </Button>
                    </div>
                </div>
            </form>
        </div>
    )
}

function ExchangeTransactionSummary({
    transactionType,
    transactionDate,
    fromCurrency,
    toCurrency,
    customerGivesAmount,
    paymentMethod,
    employeeName,
    safeName,
    exchangeRate,
    exchangeRateSource,
    acquisitionRate,
    acquisitionRateSource,
    profitAmount,
    profitCurrency,
    feeRuleName,
    feeType,
    feeCurrency,
    originalFeeValue,
    finalFeeValue,
    feeBasisAmount,
    feeEdited,
    calculation,
    iqdDisplayPreference,
    marketRateSnapshot
}: {
    transactionType: ExchangeTransactionType
    transactionDate: string
    fromCurrency: CurrencyCode
    toCurrency: CurrencyCode
    customerGivesAmount: number
    paymentMethod: ExchangePaymentMethod
    employeeName: string
    safeName: string
    exchangeRate: number
    exchangeRateSource: string
    acquisitionRate: number | null
    acquisitionRateSource: ExchangeAcquisitionRateSource | null
    profitAmount: number | null
    profitCurrency: CurrencyCode | null
    feeRuleName: string
    feeType: ExchangeFeeType | null
    feeCurrency: CurrencyCode
    originalFeeValue: number | null
    finalFeeValue: number
    feeBasisAmount: number | null
    feeEdited: boolean
    calculation: ReturnType<typeof calculateExchangeTransaction> | null
    iqdDisplayPreference: IQDDisplayPreference
    marketRateSnapshot: ExchangeRateSnapshot[]
}) {
    const { t } = useTranslation()
    const customerGivesLabel = formatCurrency(customerGivesAmount || 0, fromCurrency, iqdDisplayPreference)
    const beforeFeeLabel = calculation
        ? formatCurrency(calculation.baseReceivesAmount, toCurrency, iqdDisplayPreference)
        : formatCurrency(0, toCurrency, iqdDisplayPreference)
    const feeAppliedLabel = calculation
        ? formatCurrency(calculation.feeAmount, feeCurrency, iqdDisplayPreference)
        : formatCurrency(0, feeCurrency, iqdDisplayPreference)
    const finalReceivesLabel = calculation
        ? formatCurrency(calculation.customerReceivesAmount, toCurrency, iqdDisplayPreference)
        : formatCurrency(0, toCurrency, iqdDisplayPreference)
    const finalFeeValueLabel = feeType === 'percentage'
        ? `${formatNumberWithCommas(finalFeeValue || 0)}%`
        : formatCurrency(finalFeeValue || 0, feeCurrency, iqdDisplayPreference)
    const originalFeeValueLabel = originalFeeValue === null
        ? '-'
        : feeType === 'percentage'
            ? `${formatNumberWithCommas(originalFeeValue)}%`
            : formatCurrency(originalFeeValue, feeCurrency, iqdDisplayPreference)
    const feeBasisAmountLabel = feeBasisAmount === null
        ? '-'
        : formatCurrency(feeBasisAmount, feeCurrency, iqdDisplayPreference)

    return (
        <aside className="xl:sticky xl:top-4">
            <Card className="border-primary/20">
                <CardHeader className="space-y-2">
                    <CardTitle className="flex items-center gap-2 text-lg">
                        <ClipboardList className="h-5 w-5" />
                        {t('currencyExchange.summary.title')}
                    </CardTitle>
                    <div className="rounded-xl border bg-muted/20 px-3 py-3">
                        <div className="text-xs font-medium uppercase text-muted-foreground">{t('currencyExchange.summary.draftExchange')}</div>
                        <div className="mt-1 text-lg font-bold tracking-tight">{t('currencyExchange.labels.currencyToCurrency', { from: fromCurrency.toUpperCase(), to: toCurrency.toUpperCase() })}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{transactionTypeLabel(transactionType, t)}</div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="grid gap-2">
                        <SummaryRow label={t('currencyExchange.labels.transactionDate')} value={formatDateTime(transactionDate)} />
                        <SummaryRow label={t('currencyExchange.table.type')} value={transactionTypeLabel(transactionType, t)} />
                        <SummaryRow label={t('currencyExchange.labels.customerGives')} value={customerGivesLabel} />
                        <SummaryRow label={t('currencyExchange.labels.beforeFee')} value={beforeFeeLabel} />
                        <SummaryRow label={t('currencyExchange.labels.paymentMethod')} value={paymentMethod} valueClassName="capitalize" />
                        <SummaryRow label={t('currencyExchange.labels.employee')} value={employeeName || '-'} />
                        <SummaryRow label={t('currencyExchange.labels.safe')} value={safeName || '-'} />
                    </div>

                    <div className="h-px bg-border" />

                    <div className="grid gap-2">
                        <div className="text-xs font-semibold uppercase text-muted-foreground">{t('currencyExchange.summary.rateSnapshot')}</div>
                        <SummaryRow label={t('currencyExchange.labels.pair')} value={marketRateSnapshot[0]?.pair || t('currencyExchange.labels.currencyToCurrency', { from: fromCurrency.toUpperCase(), to: toCurrency.toUpperCase() })} />
                        <SummaryRow label={t('currencyExchange.labels.rateUsed')} value={exchangeRate > 0 ? formatNumberWithCommas(exchangeRate) : '-'} />
                        <SummaryRow
                            label={t('currencyExchange.labels.source')}
                            value={rateSourceLabel(exchangeRateSource, t)}
                            valueClassName={exchangeRateSource === 'manual_pair_price' || exchangeRateSource === 'manual' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}
                        />
                        {acquisitionRate !== null ? (
                            <>
                                <SummaryRow label={t('currencyExchange.labels.acquisitionRate')} value={acquisitionRate > 0 ? formatNumberWithCommas(acquisitionRate) : '-'} />
                                <SummaryRow label={t('currencyExchange.labels.acquisitionSource')} value={acquisitionSourceLabel(acquisitionRateSource, t)} />
                            </>
                        ) : null}
                        {profitCurrency ? (
                            <SummaryRow
                                label={t('currencyExchange.labels.estimatedProfit')}
                                value={formatCurrency(profitAmount || 0, profitCurrency, iqdDisplayPreference)}
                                valueClassName={(profitAmount || 0) >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'}
                            />
                        ) : null}
                        <div className="rounded-lg border bg-muted/20 p-3">
                            {marketRateSnapshot.length > 0 ? (
                                <div className="grid gap-2">
                                    {marketRateSnapshot.map((snapshot) => (
                                        <div key={`${snapshot.pair}:${snapshot.timestamp}`} className="flex items-center justify-between gap-3 text-xs">
                                            <span className="text-muted-foreground">{snapshot.pair}</span>
                                            <span className="font-medium">{formatNumberWithCommas(Number(snapshot.rate || 0))}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-xs text-muted-foreground">{t('currencyExchange.empty.rateSnapshot')}</div>
                            )}
                        </div>
                    </div>

                    <div className="h-px bg-border" />

                    <div className="grid gap-2">
                        <div className="text-xs font-semibold uppercase text-muted-foreground">{t('currencyExchange.feeRules.sectionTitle')}</div>
                        <SummaryRow label={t('currencyExchange.labels.rule')} value={feeRuleName} />
                        <SummaryRow label={t('currencyExchange.labels.feeType')} value={feeTypeLabel(feeType, t)} valueClassName="capitalize" />
                        <SummaryRow label={t('currencyExchange.labels.originalValue')} value={originalFeeValueLabel} />
                        <SummaryRow label={t('currencyExchange.labels.finalValue')} value={finalFeeValueLabel} />
                        <SummaryRow label={t('currencyExchange.labels.customerGivesBasis')} value={feeBasisAmountLabel} />
                        <SummaryRow label={t('currencyExchange.labels.feeApplied')} value={feeAppliedLabel} />
                        {feeEdited ? (
                            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                                {t('currencyExchange.help.feeEdited')}
                            </div>
                        ) : null}
                    </div>

                    <div className="h-px bg-border" />

                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
                        <div className="text-xs font-semibold uppercase text-muted-foreground">{t('currencyExchange.summary.finalSummary')}</div>
                        <div className="mt-3 rounded-lg border border-primary/20 bg-background/70 p-3">
                            <div className="text-xs font-medium uppercase text-muted-foreground">{t('currencyExchange.labels.customerReceives')}</div>
                            <div className="mt-1 text-2xl font-bold tracking-tight">{finalReceivesLabel}</div>
                        </div>
                        <div className="mt-3 grid gap-2">
                            <SummaryRow label={t('currencyExchange.labels.customerGives')} value={customerGivesLabel} />
                            <SummaryRow label={t('currencyExchange.labels.beforeFee')} value={beforeFeeLabel} />
                            <SummaryRow label={t('currencyExchange.labels.feeDeducted')} value={feeAppliedLabel} />
                            <SummaryRow label={t('currencyExchange.labels.rateUsed')} value={exchangeRate > 0 ? formatNumberWithCommas(exchangeRate) : '-'} />
                            <SummaryRow label={t('currencyExchange.labels.paymentMethod')} value={paymentMethod} valueClassName="capitalize" />
                        </div>
                    </div>
                </CardContent>
            </Card>
        </aside>
    )
}

function SummaryRow({
    label,
    value,
    valueClassName
}: {
    label: string
    value: string
    valueClassName?: string
}) {
    return (
        <div className="flex items-start justify-between gap-4 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className={cn('max-w-[190px] text-right font-medium', valueClassName)}>{value}</span>
        </div>
    )
}

function ExchangeFeeRulesPage({
    workspaceId,
    onBack
}: {
    workspaceId: string
    onBack: () => void
}) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const rules = useExchangeFeeRules(workspaceId)
    const [form, setForm] = useState<FeeRuleFormState>(() => makeDefaultRuleForm(features.default_currency))
    const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const isAdmin = user?.role === 'admin'

    const availableCurrencies = useMemo(() => {
        const values = new Set<CurrencyCode>([...features.allowed_currencies, features.default_currency, 'iqd', 'usd'])
        return Array.from(values)
    }, [features.allowed_currencies, features.default_currency])

    const resetForm = () => {
        setEditingRuleId(null)
        setForm(makeDefaultRuleForm(features.default_currency))
    }

    const startEditing = (rule: ExchangeFeeRule) => {
        setEditingRuleId(rule.id)
        setForm({
            name: rule.name,
            transactionScope: rule.transactionScope,
            feeType: rule.feeType,
            currency: rule.currency,
            value: String(rule.value),
            customerGivesBasisAmount: String(getExchangeFeeBasisAmount(rule)),
            effectiveStartDate: rule.effectiveStartDate,
            effectiveEndDate: rule.effectiveEndDate || '',
            isActive: rule.isActive,
            isLocked: rule.isLocked,
            notes: rule.notes || ''
        })
    }

    const parsedFeeRuleValue = parseFormattedNumber(form.value || '0')
    const parsedCustomerGivesBasisAmount = parseFormattedNumber(form.customerGivesBasisAmount || '0')
    const previewFeeAmount = calculateRulePreviewFeeAmount(form.feeType, parsedCustomerGivesBasisAmount, parsedFeeRuleValue)
    const formattedCustomerGivesBasisAmount = formatCurrency(parsedCustomerGivesBasisAmount, form.currency, features.iqd_display_preference)
    const formattedPreviewFeeAmount = formatCurrency(previewFeeAmount, form.currency, features.iqd_display_preference)
    const feeRuleFormula = form.feeType === 'percentage'
        ? t('currencyExchange.feeRules.percentageFormula', {
            basis: formattedCustomerGivesBasisAmount,
            value: formatNumberWithCommas(parsedFeeRuleValue || 0),
            fee: formattedPreviewFeeAmount
        })
        : t('currencyExchange.feeRules.fixedFormula', {
            fee: formattedPreviewFeeAmount,
            basis: formattedCustomerGivesBasisAmount
        })
    const formTemporalStatus = getExchangeFeeRuleTemporalStatus({
        isActive: form.isActive,
        isDeleted: false,
        effectiveStartDate: form.effectiveStartDate,
        effectiveEndDate: form.effectiveEndDate || null
    }, currentTimestamp())
    const formTemporalHelper = feeRuleTemporalHelperText({
        isActive: form.isActive,
        effectiveStartDate: form.effectiveStartDate,
        effectiveEndDate: form.effectiveEndDate || null
    }, formTemporalStatus, t)
    const ruleStatusReferenceDate = currentTimestamp()

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setIsSaving(true)
        try {
            const payload = {
                name: form.name,
                transactionScope: form.transactionScope,
                feeType: form.feeType,
                currency: form.currency,
                value: parseFormattedNumber(form.value || '0'),
                customerGivesBasisAmount: parseFormattedNumber(form.customerGivesBasisAmount || '0'),
                effectiveStartDate: form.effectiveStartDate,
                effectiveEndDate: form.effectiveEndDate || null,
                isActive: form.isActive,
                isLocked: form.isLocked,
                notes: form.notes,
                createdBy: user?.id ?? null
            }

            if (editingRuleId) {
                await updateExchangeFeeRule(editingRuleId, payload)
            } else {
                await createExchangeFeeRule(workspaceId, payload)
            }

            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: editingRuleId ? t('currencyExchange.messages.feeRuleUpdated') : t('currencyExchange.messages.feeRuleCreated')
            })
            resetForm()
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('currencyExchange.messages.feeRuleSaveFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    const handleToggleLock = async (rule: ExchangeFeeRule) => {
        if (!isAdmin) return
        try {
            await updateExchangeFeeRule(rule.id, { isLocked: !rule.isLocked })
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('currencyExchange.messages.lockUpdateFailed'),
                variant: 'destructive'
            })
        }
    }

    const handleDelete = async () => {
        if (!deleteTargetId) return
        setIsDeleting(true)
        try {
            await deleteExchangeFeeRule(deleteTargetId)
            toast({ title: t('common.success', { defaultValue: 'Success' }), description: t('currencyExchange.messages.feeRuleDeleted') })
            setDeleteTargetId(null)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('currencyExchange.messages.feeRuleDeleteFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="space-y-1">
                <Button
                    type="button"
                    variant="ghost"
                    className="h-auto gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                    onClick={onBack}
                >
                    <ArrowLeft className="h-4 w-4" />
                    {t('currencyExchange.serviceTitle')}
                </Button>
                <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
                    <ClipboardList className="h-7 w-7" />
                    {t('currencyExchange.feeRules.title')}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {t('currencyExchange.feeRules.description')}
                </p>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(320px,420px)_1fr]">
                <Card>
                    <CardHeader>
                        <CardTitle>{editingRuleId ? t('currencyExchange.feeRules.editRule') : t('currencyExchange.feeRules.createRule')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSubmit} className="grid gap-4">
                            <div className="grid gap-2">
                                <Label>{t('common.name', { defaultValue: 'Name' })}</Label>
                                <Input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
                            </div>
                            <div className="grid gap-2">
                                <Label>{t('currencyExchange.labels.validFor')}</Label>
                                <Select value={form.transactionScope} onValueChange={(value: ExchangeFeeRuleTransactionScope) => setForm((current) => ({ ...current, transactionScope: value }))}>
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="both">{t('currencyExchange.ruleScopes.both')}</SelectItem>
                                        <SelectItem value="buy">{t('currencyExchange.ruleScopes.buy')}</SelectItem>
                                        <SelectItem value="sell">{t('currencyExchange.ruleScopes.sell')}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label>{t('currencyExchange.labels.feeType')}</Label>
                                    <Select value={form.feeType} onValueChange={(value: ExchangeFeeType) => setForm((current) => ({
                                        ...current,
                                        feeType: value,
                                        value: sanitizeNumericInput(current.value, { allowDecimal: value === 'percentage' || current.currency !== 'iqd' })
                                    }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="fixed">{t('currencyExchange.feeTypes.fixed')}</SelectItem>
                                            <SelectItem value="percentage">{t('currencyExchange.feeTypes.percentage')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <CurrencySelector
                                    value={form.currency}
                                    onChange={(value) => setForm((current) => ({
                                        ...current,
                                        currency: value,
                                        value: sanitizeNumericInput(current.value, { allowDecimal: current.feeType === 'percentage' || value !== 'iqd' }),
                                        customerGivesBasisAmount: sanitizeNumericInput(current.customerGivesBasisAmount, { allowDecimal: value !== 'iqd' })
                                    }))}
                                    label={t('common.currency', { defaultValue: 'Currency' })}
                                    iqdDisplayPreference={features.iqd_display_preference}
                                    allowedCurrencies={availableCurrencies}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label>{form.feeType === 'percentage' ? t('currencyExchange.labels.percentageRate') : t('currencyExchange.labels.fixedFeeAmount')}</Label>
                                <Input
                                    type="text"
                                    inputMode="decimal"
                                    value={formatNumericInput(form.value)}
                                    onChange={(event) => setForm((current) => ({
                                        ...current,
                                        value: sanitizeNumericInput(event.target.value, { allowDecimal: form.feeType === 'percentage' || form.currency !== 'iqd' })
                                    }))}
                                    placeholder="0"
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label>{t('currencyExchange.labels.customerGivesBasis')}</Label>
                                <Input
                                    type="text"
                                    inputMode={form.currency === 'iqd' ? 'numeric' : 'decimal'}
                                    value={formatNumericInput(form.customerGivesBasisAmount)}
                                    onChange={(event) => setForm((current) => ({
                                        ...current,
                                        customerGivesBasisAmount: sanitizeNumericInput(event.target.value, { allowDecimal: form.currency !== 'iqd' })
                                    }))}
                                    placeholder="0"
                                />
                            </div>
                            <div className="grid gap-3 rounded-xl border bg-muted/20 p-3">
                                <div className="grid gap-3 sm:grid-cols-3">
                                    <InfoBlock label={t('currencyExchange.labels.customerGivesBasis')} value={formattedCustomerGivesBasisAmount} />
                                    <InfoBlock
                                        label={form.feeType === 'percentage' ? t('currencyExchange.labels.percentageRate') : t('currencyExchange.labels.fixedFee')}
                                        value={form.feeType === 'percentage'
                                            ? `${formatNumberWithCommas(parsedFeeRuleValue || 0)}%`
                                            : formatCurrency(parsedFeeRuleValue || 0, form.currency, features.iqd_display_preference)}
                                    />
                                    <InfoBlock label={t('currencyExchange.labels.calculatedFee')} value={formattedPreviewFeeAmount} />
                                </div>
                                <div className="rounded-lg border bg-background/60 px-3 py-2 text-xs font-medium text-muted-foreground">
                                    {feeRuleFormula}
                                </div>
                            </div>
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div className="grid gap-2">
                                    <Label>{t('currencyExchange.labels.effectiveStart')}</Label>
                                    <DateTimePicker
                                        id="currency-exchange-fee-effective-start"
                                        mode="date-time"
                                        date={parseLocalDateTimeValue(form.effectiveStartDate)}
                                        setDate={(value) => setForm((current) => ({ ...current, effectiveStartDate: toTimestampValue(value) }))}
                                        placeholder={t('currencyExchange.labels.effectiveStart')}
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label>{t('currencyExchange.labels.effectiveEnd')}</Label>
                                    <DateTimePicker
                                        id="currency-exchange-fee-effective-end"
                                        mode="date-time"
                                        date={parseLocalDateTimeValue(form.effectiveEndDate)}
                                        setDate={(value) => setForm((current) => ({ ...current, effectiveEndDate: toTimestampValue(value) }))}
                                        placeholder={t('currencyExchange.labels.effectiveEnd')}
                                    />
                                </div>
                            </div>
                            <div className="rounded-xl border bg-muted/20 px-3 py-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="text-sm font-medium">
                                        {t('currencyExchange.feeRules.effectiveStatus', { defaultValue: 'Effective status' })}
                                    </div>
                                    <span className={cn(
                                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                        feeRuleTemporalBadgeClass(formTemporalStatus)
                                    )}>
                                        {feeRuleTemporalStatusLabel(formTemporalStatus, t)}
                                    </span>
                                </div>
                                <p className="mt-2 text-xs text-muted-foreground">
                                    {formTemporalHelper}
                                </p>
                            </div>
                            <div className="grid gap-3 rounded-xl border bg-muted/20 p-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">{t('currencyExchange.status.active')}</div>
                                        <div className="text-xs text-muted-foreground">{t('currencyExchange.help.activeRule')}</div>
                                    </div>
                                    <Switch checked={form.isActive} onCheckedChange={(value) => setForm((current) => ({ ...current, isActive: value }))} />
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">{t('currencyExchange.status.locked')}</div>
                                        <div className="text-xs text-muted-foreground">{t('currencyExchange.help.lockedRule')}</div>
                                    </div>
                                    <Switch
                                        checked={form.isLocked}
                                        disabled={!isAdmin}
                                        onCheckedChange={(value) => setForm((current) => ({ ...current, isLocked: value }))}
                                    />
                                </div>
                            </div>
                            <div className="grid gap-2">
                                <Label>{t('currencyExchange.labels.notes')}</Label>
                                <Textarea rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
                            </div>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                                <Button type="button" variant="outline" onClick={resetForm}>{t('currencyExchange.buttons.clear')}</Button>
                                <Button type="submit" disabled={isSaving}>{isSaving ? t('currencyExchange.buttons.saving') : editingRuleId ? t('currencyExchange.buttons.saveRule') : t('currencyExchange.buttons.createRule')}</Button>
                            </div>
                        </form>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>{t('currencyExchange.feeRules.configuredRules')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('currencyExchange.labels.rule')}</TableHead>
                                    <TableHead>{t('currencyExchange.labels.scope')}</TableHead>
                                    <TableHead>{t('currencyExchange.table.fee')}</TableHead>
                                    <TableHead>{t('currencyExchange.labels.effectivePeriod')}</TableHead>
                                    <TableHead>{t('common.status', { defaultValue: 'Status' })}</TableHead>
                                    <TableHead className="text-end">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rules.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                                            {t('currencyExchange.empty.feeRules')}
                                        </TableCell>
                                    </TableRow>
                                ) : rules.map((rule) => {
                                    const basisAmount = getExchangeFeeBasisAmount(rule)
                                    const temporalStatus = getExchangeFeeRuleTemporalStatus(rule, ruleStatusReferenceDate)
                                    return (
                                    <TableRow key={rule.id}>
                                        <TableCell>
                                            <div className="font-medium">{rule.name}</div>
                                            {rule.notes ? <div className="text-xs text-muted-foreground">{rule.notes}</div> : null}
                                        </TableCell>
                                        <TableCell>{feeScopeLabel(rule.transactionScope, t)}</TableCell>
                                        <TableCell>
                                            <div>
                                                {rule.feeType === 'percentage'
                                                    ? `${rule.value.toLocaleString()}%`
                                                    : formatCurrency(rule.value, rule.currency, features.iqd_display_preference)}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                {rule.feeType === 'fixed'
                                                    ? t('currencyExchange.feeRules.perBasis', { basis: formatCurrency(basisAmount, rule.currency, features.iqd_display_preference) })
                                                    : t('currencyExchange.feeRules.exampleBasis', { basis: formatCurrency(basisAmount, rule.currency, features.iqd_display_preference) })}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            {formatDateTime(rule.effectiveStartDate)}
                                            {rule.effectiveEndDate ? ` - ${formatDateTime(rule.effectiveEndDate)}` : ` - ${t('currencyExchange.status.open')}`}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-1.5">
                                                <span className={cn(
                                                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                                    feeRuleTemporalBadgeClass(temporalStatus)
                                                )}>
                                                    {feeRuleTemporalStatusLabel(temporalStatus, t)}
                                                </span>
                                                <span className={cn(
                                                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                                    rule.isActive ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-muted text-muted-foreground'
                                                )}>
                                                    {safeStatusLabel(rule.isActive, t)}
                                                </span>
                                                <span className={cn(
                                                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                                    rule.isLocked ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                                                )}>
                                                    {rule.isLocked ? t('currencyExchange.status.locked') : t('currencyExchange.status.unlocked')}
                                                </span>
                                            </div>
                                            <div className="mt-1 text-xs text-muted-foreground">
                                                {feeRuleTemporalHelperText(rule, temporalStatus, t)}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-end">
                                            <div className="flex justify-end gap-1">
                                                {isAdmin ? (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => handleToggleLock(rule)}
                                                        aria-label={rule.isLocked ? t('currencyExchange.buttons.unlockFeeRule') : t('currencyExchange.buttons.lockFeeRule')}
                                                    >
                                                        {rule.isLocked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                                                    </Button>
                                                ) : null}
                                                <Button type="button" variant="ghost" onClick={() => startEditing(rule)}>{t('common.edit', { defaultValue: 'Edit' })}</Button>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    className="text-destructive hover:text-destructive"
                                                    onClick={() => setDeleteTargetId(rule.id)}
                                                    aria-label={t('currencyExchange.buttons.deleteFeeRule')}
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            </div>

            <DeleteConfirmationModal
                isOpen={!!deleteTargetId}
                onClose={() => setDeleteTargetId(null)}
                onConfirm={handleDelete}
                itemName={rules.find((rule) => rule.id === deleteTargetId)?.name}
                isLoading={isDeleting}
                title={t('currencyExchange.feeRules.deleteTitle')}
                description={t('currencyExchange.feeRules.deleteDescription')}
            />
        </div>
    )
}

const currencyFlagIsoCode: Record<CurrencyCode, string> = {
    iqd: 'IQ',
    usd: 'US',
    eur: 'EU',
    try: 'TR'
}

function ExchangeRateDisplaySelectCard({
    slotIndex,
    pair,
    pairKey,
    pairPrice,
    pairOptions,
    language,
    canManagePrices,
    onPairChange,
    onPriceSave,
    t
}: {
    slotIndex: number
    pair: { baseCurrency: CurrencyCode; quoteCurrency: CurrencyCode } | null
    pairKey: ExchangeRateCardSlot
    pairPrice: ExchangePairPrice | null
    pairOptions: Array<{ baseCurrency: CurrencyCode; quoteCurrency: CurrencyCode; key: string }>
    language: string | undefined
    canManagePrices: boolean
    onPairChange: (slotIndex: number, value: string) => void
    onPriceSave: (pair: { baseCurrency: CurrencyCode; quoteCurrency: CurrencyCode }, side: 'buy' | 'sell', price: number) => Promise<void>
    t: TFunction
}) {
    const [isPickerOpen, setIsPickerOpen] = useState(false)
    const [editingSide, setEditingSide] = useState<'buy' | 'sell' | null>(null)
    const [draftPrice, setDraftPrice] = useState('')
    const [isSavingPrice, setIsSavingPrice] = useState(false)
    const baseName = pair ? getLocalizedCurrencyName(pair.baseCurrency, language) : ''
    const quoteName = pair ? getLocalizedCurrencyName(pair.quoteCurrency, language) : ''
    const buyingRate = formatExchangeRateDisplay(pairPrice ? Number(pairPrice.buyPrice || 0) : null)
    const sellingRate = formatExchangeRateDisplay(pairPrice ? Number(pairPrice.sellPrice || 0) : null)
    const hasPair = Boolean(pair && pairKey)

    const startEditing = (side: 'buy' | 'sell') => {
        if (!canManagePrices || !pair) return
        setEditingSide(side)
        setDraftPrice(String(side === 'buy' ? pairPrice?.buyPrice ?? 0 : pairPrice?.sellPrice ?? 0))
    }

    const cancelEditing = () => {
        setEditingSide(null)
        setDraftPrice('')
    }

    const saveEditing = async () => {
        if (!pair || !editingSide) return
        const price = parseFormattedNumber(draftPrice || '0')
        setIsSavingPrice(true)
        try {
            await onPriceSave(pair, editingSide, price)
            cancelEditing()
        } finally {
            setIsSavingPrice(false)
        }
    }

    const handlePickerOpenChange = (open: boolean) => {
        setIsPickerOpen(open)
    }

    const renderPricePanel = (side: 'buy' | 'sell', value: string) => {
        const isEditing = editingSide === side
        const tone = side === 'buy'
            ? 'border-red-500/15 bg-red-500/10 text-red-700 dark:text-red-300'
            : 'border-emerald-500/15 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        const valueTone = side === 'buy' ? 'text-red-600 dark:text-red-300' : 'text-emerald-600 dark:text-emerald-300'

        return (
            <div
                data-price-control="true"
                className={cn('min-w-0 rounded-lg border p-3', tone)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="text-xs font-semibold uppercase">
                    {t(`currencyExchange.transactionTypes.${side}`)}
                </div>
                {isEditing ? (
                    <div className="mt-2 grid gap-2">
                        <Input
                            autoFocus
                            type="text"
                            inputMode="decimal"
                            value={formatNumericInput(draftPrice)}
                            onChange={(event) => setDraftPrice(sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 6 }))}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void saveEditing()
                                } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    cancelEditing()
                                }
                            }}
                            className="h-9 bg-background text-base font-bold tabular-nums"
                        />
                        <div className="flex gap-2">
                            <div
                                role="button"
                                tabIndex={0}
                                className={cn(
                                    'inline-flex h-8 flex-1 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors',
                                    isSavingPrice ? 'pointer-events-none opacity-50' : 'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring'
                                )}
                                onClick={saveEditing}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        void saveEditing()
                                    }
                                }}
                            >
                                {t('common.save', { defaultValue: 'Save' })}
                            </div>
                            <div
                                role="button"
                                tabIndex={0}
                                className={cn(
                                    'inline-flex h-8 flex-1 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium transition-colors',
                                    isSavingPrice ? 'pointer-events-none opacity-50' : 'hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring'
                                )}
                                onClick={cancelEditing}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        cancelEditing()
                                    }
                                }}
                            >
                                {t('common.cancel', { defaultValue: 'Cancel' })}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div
                        role={canManagePrices ? 'button' : undefined}
                        tabIndex={canManagePrices ? 0 : -1}
                        className={cn(
                            'mt-2 block min-h-9 w-full rounded-md text-start text-2xl font-black leading-tight tabular-nums transition-colors',
                            valueTone,
                            canManagePrices ? 'hover:bg-background/60 focus:outline-none focus:ring-2 focus:ring-ring' : 'cursor-default'
                        )}
                        onClick={() => startEditing(side)}
                        onKeyDown={(event) => {
                            if (!canManagePrices) return
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                startEditing(side)
                            }
                        }}
                    >
                        {value}
                    </div>
                )}
            </div>
        )
    }

    return (
        <Select
            open={isPickerOpen}
            onOpenChange={handlePickerOpenChange}
            value={pairKey ?? undefined}
            onValueChange={(value) => {
                onPairChange(slotIndex, value)
                setIsPickerOpen(false)
            }}
        >
            <div className="relative">
                <div
                    role={hasPair ? undefined : 'button'}
                    tabIndex={hasPair ? undefined : 0}
                    aria-label={pair
                        ? getExchangePairLabel(pair.baseCurrency, pair.quoteCurrency)
                        : t('currencyExchange.placeholders.selectPair', { defaultValue: 'Select pair' })}
                    className={cn(
                        'group min-h-[260px] rounded-xl border border-border/80 bg-card p-0 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md',
                        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2'
                    )}
                    onClick={() => {
                        if (!hasPair) {
                            setIsPickerOpen(true)
                        }
                    }}
                    onContextMenu={(event) => {
                        event.preventDefault()
                        if (hasPair) {
                            setIsPickerOpen(true)
                        }
                    }}
                    onKeyDown={(event) => {
                        if ((event.key === 'Enter' || event.key === ' ') && !hasPair) {
                            event.preventDefault()
                            setIsPickerOpen(true)
                        }
                    }}
                >
                    {pair ? (
                        <div className="flex w-full min-w-0 flex-col overflow-hidden rounded-xl">
                            <div className="flex min-w-0 items-start justify-between gap-3 border-b bg-muted/20 p-4">
                                <div className="min-w-0">
                                    <div className="text-4xl font-black leading-none tracking-normal text-foreground">
                                        {getExchangePairLabel(pair.baseCurrency, pair.quoteCurrency)}
                                    </div>
                                    <div className="mt-1 line-clamp-2 text-sm font-semibold leading-tight text-muted-foreground">
                                        {baseName} / {quoteName}
                                    </div>
                                </div>
                                <div className="flex shrink-0 -space-x-2">
                                    <span className="overflow-hidden rounded-md bg-background shadow-sm ring-1 ring-border/60">
                                        <CurrencyFlag currency={pair.baseCurrency} size={38} />
                                    </span>
                                    <span className="overflow-hidden rounded-md bg-background shadow-sm ring-1 ring-border/60">
                                        <CurrencyFlag currency={pair.quoteCurrency} size={38} />
                                    </span>
                                </div>
                            </div>

                            <div className="grid flex-1 content-end gap-3 p-4">
                                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-1 2xl:grid-cols-2">
                                    {renderPricePanel('buy', buyingRate)}
                                    {renderPricePanel('sell', sellingRate)}
                                </div>
                                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                    <span>{t('currencyExchange.labels.priceBasis', { defaultValue: 'Price basis' })}</span>
                                    <span className="font-semibold text-foreground">
                                        {formatNumberWithCommas(pairPrice?.priceBasisAmount ?? DEFAULT_EXCHANGE_PAIR_PRICE_BASIS)} {pair.baseCurrency.toUpperCase()}
                                    </span>
                                </div>
                                {!canManagePrices ? (
                                    <div className="text-xs text-muted-foreground">
                                        {t('currencyExchange.help.priceReadOnly', { defaultValue: 'Price editing requires permission.' })}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    ) : (
                        <div className="flex min-h-[258px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-muted-foreground/30 bg-muted/10 p-5 text-center transition-colors group-hover:border-primary/40 group-hover:bg-primary/5">
                            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm ring-1 ring-border group-hover:text-primary">
                                <Plus className="h-7 w-7" />
                            </div>
                            <div className="text-sm font-semibold text-foreground">
                                {t('currencyExchange.placeholders.selectPair', { defaultValue: 'Select pair' })}
                            </div>
                        </div>
                    )}
                </div>
                <SelectTrigger
                    allowViewer
                    aria-hidden="true"
                    tabIndex={-1}
                    className="pointer-events-none absolute right-4 top-4 h-1 w-1 border-0 bg-transparent p-0 opacity-0 shadow-none focus:ring-0 focus:ring-offset-0"
                >
                    <SelectValue />
                </SelectTrigger>
            </div>
            <SelectContent>
                {pair ? (
                    <SelectItem value={EXCHANGE_RATE_CARD_CLEAR_VALUE}>
                        {t('currencyExchange.buttons.clear')}
                    </SelectItem>
                ) : null}
                {pairOptions.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                        {getExchangePairLabel(option.baseCurrency, option.quoteCurrency)} - {getLocalizedCurrencyName(option.baseCurrency, language)} / {getLocalizedCurrencyName(option.quoteCurrency, language)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}

function CurrencyFlag({ currency, size = 20 }: { currency: CurrencyCode; size?: number }) {
    return <CountryFlag isoCode={currencyFlagIsoCode[currency]} size={size} />
}

function SafeCurrencyCard({ currency, balance }: { currency: CurrencyCode; balance: string }) {
    return (
        <Card>
            <CardContent className="relative min-w-0 p-4">
                <div
                    className="absolute right-5 top-4 overflow-hidden rounded-[2px] shadow-sm ring-1 ring-border/20"
                    aria-label={`${currency.toUpperCase()} flag`}
                >
                    <CurrencyFlag currency={currency} />
                </div>
                <div className="text-sm text-muted-foreground">{currency.toUpperCase()}</div>
                <div className="mt-1 break-words pr-14 text-2xl font-bold leading-tight">{balance}</div>
            </CardContent>
        </Card>
    )
}

function MetricCard({ title, value }: { title: string; value: string }) {
    return (
        <Card>
            <CardContent className="min-w-0 p-4">
                <div className="text-sm text-muted-foreground">{title}</div>
                <div className="mt-1 break-words text-2xl font-bold leading-tight">{value}</div>
            </CardContent>
        </Card>
    )
}

function FieldLabelWithTooltip({ label, tooltip }: { label: string; tooltip: string }) {
    return (
        <div className="flex items-center gap-1.5">
            <Label>{label}</Label>
            <TooltipProvider delayDuration={150}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={tooltip}
                        >
                            <HelpCircle className="h-3.5 w-3.5" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="start" className="max-w-xs text-xs leading-relaxed">
                        {tooltip}
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        </div>
    )
}

function ReverseTransactionModal({
    isOpen,
    onClose,
    onConfirm,
    transaction,
    isLoading
}: {
    isOpen: boolean
    onClose: () => void
    onConfirm: () => void
    transaction: ExchangeTransaction | undefined
    isLoading: boolean
}) {
    const { t } = useTranslation()
    if (!transaction) return null

    const reversedType = transaction.transactionType === 'buy' ? 'sell' : 'buy'
    const givesLabel = formatCurrency(transaction.customerReceivesAmount, transaction.toCurrency, 'IQD' as any)
    const receivesLabel = formatCurrency(transaction.customerGivesAmount, transaction.fromCurrency, 'IQD' as any)

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('currencyExchange.reverse.title')}</DialogTitle>
                    <DialogDescription>
                        {t('currencyExchange.reverse.description', { transactionNo: transaction.transactionNo })}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
                    <div className="text-sm font-medium">{t('currencyExchange.reverse.originalTransaction')}</div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                        <span className="text-muted-foreground">{t('currencyExchange.table.type')}</span>
                        <span>{transactionTypeLabel(transaction.transactionType, t)}</span>
                        <span className="text-muted-foreground">{t('currencyExchange.labels.gave')}</span>
                        <span>{formatCurrency(transaction.customerGivesAmount, transaction.fromCurrency, 'IQD' as any)}</span>
                        <span className="text-muted-foreground">{t('currencyExchange.labels.received')}</span>
                        <span>{formatCurrency(transaction.customerReceivesAmount, transaction.toCurrency, 'IQD' as any)}</span>
                    </div>
                    <div className="h-px bg-border" />
                    <div className="text-sm font-medium">{t('currencyExchange.status.reversal')}</div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                        <span className="text-muted-foreground">{t('currencyExchange.table.type')}</span>
                        <span>{transactionTypeLabel(reversedType, t)}</span>
                        <span className="text-muted-foreground">{t('currencyExchange.labels.customerGives')}</span>
                        <span>{givesLabel}</span>
                        <span className="text-muted-foreground">{t('currencyExchange.labels.customerReceives')}</span>
                        <span>{receivesLabel}</span>
                    </div>
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                        {t('currencyExchange.reverse.warning')}
                    </div>
                </div>
                <DialogFooter className="gap-2 sm:space-x-0">
                    <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
                        {t('common.cancel', { defaultValue: 'Cancel' })}
                    </Button>
                    <Button type="button" variant="destructive" onClick={onConfirm} disabled={isLoading}>
                        {isLoading ? t('currencyExchange.buttons.reversing') : t('currencyExchange.buttons.reverseTransaction')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

function InfoBlock({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className="text-xs uppercase text-muted-foreground">{label}</div>
            <div className="mt-1 text-sm font-semibold">{value}</div>
        </div>
    )
}
