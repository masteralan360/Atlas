import { BadgePercent, MapPin, RotateCcw, Truck, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { getAppliedCurrencyConversion } from '@/lib/orderCurrency'
import { formatCurrency, formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import type { CurrencyCode, ExchangeRateSnapshot, ManualSalesAgentCommissionType } from '@/local-db'
import type { CommissionAgentDirectoryEntry } from './useCommissionAgentDirectory'
import { formatCommissionPlanTerms } from './agentCommissionPresentation'
import { Input } from '@/ui/components/input'
import {
  Badge,
  Button,
  CurrencySelector,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/ui/components'

const UNASSIGNED_VALUE = '__unassigned__'

export interface SalesAgentAssignmentFieldValue {
    agentId: string
    customerCity: string
    deliveryChargeAmount: string
    internalDeliveryCostAmount: string
    reassignmentReason: string
    manualCommissionType: ManualSalesAgentCommissionType
    manualCommissionAmount: string
    manualCommissionCurrency: CurrencyCode
}

interface SalesAgentAssignmentFieldsProps {
    idPrefix?: string
    value: SalesAgentAssignmentFieldValue
    onChange: (value: SalesAgentAssignmentFieldValue) => void
    agents: CommissionAgentDirectoryEntry[]
    currentAgent?: CommissionAgentDirectoryEntry
    orderCurrency: CurrencyCode
    orderTotal: number
    exchangeRates: ExchangeRateSnapshot[]
    availableCurrencies: CurrencyCode[]
    iqdDisplayPreference?: Parameters<typeof CurrencySelector>[0]['iqdDisplayPreference']
    showAgentSelection?: boolean
    showAgentSummary?: boolean
    showReason?: boolean
    showOperationalFields?: boolean
    allowPlanCommissionAmountOverride?: boolean
    lockAgentSelection?: boolean
    disabled?: boolean
}

export function SalesAgentAssignmentFields({
    idPrefix = 'sales-agent-assignment',
    value,
    onChange,
    agents,
    currentAgent,
    orderCurrency,
    orderTotal,
    exchangeRates,
    availableCurrencies,
    iqdDisplayPreference,
    showAgentSelection = true,
    showAgentSummary = true,
    showReason = false,
    showOperationalFields = true,
    allowPlanCommissionAmountOverride = false,
    lockAgentSelection = false,
    disabled = false
}: SalesAgentAssignmentFieldsProps) {
    const { t } = useTranslation()
    const selectedAgent = agents.find((entry) => entry.agent.id === value.agentId)
        || (currentAgent?.agent.id === value.agentId ? currentAgent : undefined)
    const selectableAgents = currentAgent && !agents.some((entry) => entry.agent.id === currentAgent.agent.id)
        ? [currentAgent, ...agents]
        : agents

    const update = <Key extends keyof SalesAgentAssignmentFieldValue>(
        key: Key,
        nextValue: SalesAgentAssignmentFieldValue[Key]
    ) => onChange({ ...value, [key]: nextValue })
    const fieldId = (name: string) => `${idPrefix}-${name}`
    const selectAgent = (agentId: string) => {
        const nextAgentId = agentId === UNASSIGNED_VALUE ? '' : agentId
        if (nextAgentId === value.agentId) return
        const nextPlan = selectableAgents.find((entry) => entry.agent.id === nextAgentId)?.plan
        onChange({
            ...value,
            agentId: nextAgentId,
            manualCommissionType: 'fixed_amount',
            manualCommissionAmount: nextPlan?.commissionType === 'fixed_amount'
                ? Number(nextPlan.fixedAmount ?? 0) === 0 ? '' : String(nextPlan.fixedAmount)
                : '',
            manualCommissionCurrency: nextPlan?.commissionType === 'fixed_amount'
                ? nextPlan.fixedCurrency || orderCurrency
                : orderCurrency
        })
    }
    const usesManualCommission = Boolean(selectedAgent && !selectedAgent.plan)
    const hasFixedCommissionPlan = selectedAgent?.plan?.commissionType === 'fixed_amount'
    const planCommissionAmount = Number(selectedAgent?.plan?.fixedAmount ?? 0)
    const planCommissionAmountValue = planCommissionAmount === 0 ? '' : String(planCommissionAmount)
    const hasPlanCommissionOverride = hasFixedCommissionPlan
        && value.manualCommissionAmount !== planCommissionAmountValue
    const planCommissionCurrency = selectedAgent?.plan?.fixedCurrency || value.manualCommissionCurrency
    const manualAmount = Number(value.manualCommissionAmount)
    const manualConversion = usesManualCommission && value.manualCommissionType === 'fixed_amount'
        ? getAppliedCurrencyConversion(manualAmount, value.manualCommissionCurrency, orderCurrency, exchangeRates)
        : null
    const percentageCommission = usesManualCommission && value.manualCommissionType === 'percentage'
        && Number.isFinite(manualAmount) && manualAmount > 0
        ? Math.max(0, orderTotal) * manualAmount / 100
        : null

    return (
        <div className="space-y-4">
            {showAgentSelection ? (
                <div className="space-y-2">
                <Label htmlFor={fieldId('agent')}>{t('salesAgentCommissions.assignedSalesAgent')}</Label>
                <Select
                    value={value.agentId || UNASSIGNED_VALUE}
                    onValueChange={selectAgent}
                    disabled={disabled || lockAgentSelection}
                >
                    <SelectTrigger id={fieldId('agent')} className="min-h-11">
                        <SelectValue placeholder={t('salesAgentCommissions.noSalesAgentAssigned')} />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={UNASSIGNED_VALUE}>{t('salesAgentCommissions.noSalesAgentAssigned')}</SelectItem>
                        {selectableAgents.map((entry) => (
                            <SelectItem
                                key={entry.agent.id}
                                value={entry.agent.id}
                                disabled={!entry.isEligible && entry.agent.id !== currentAgent?.agent.id}
                            >
                                {entry.name}{entry.plan ? ` · ${entry.plan.name} (${formatCommissionPlanTerms(entry.plan, iqdDisplayPreference || 'IQD')})` : ` · ${t('salesAgentCommissions.noCommissionPlan')}`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                    {t('salesAgentCommissions.assignmentHelp')}
                </p>
                </div>
            ) : null}

            {showAgentSummary && selectedAgent ? (
                <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className="gap-1.5">
                        <UserRound className="h-3.5 w-3.5" />
                        {selectedAgent.name}
                    </Badge>
                    {selectedAgent.plan ? (
                        <Badge variant="outline" className="gap-1.5 border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                            <BadgePercent className="h-3.5 w-3.5" />
                            {selectedAgent.plan.name} · {formatCommissionPlanTerms(selectedAgent.plan, iqdDisplayPreference || 'IQD')}
                        </Badge>
                    ) : (
                        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                            {t('salesAgentCommissions.assignmentOnlyNoPlan')}
                        </Badge>
                    )}
                </div>
            ) : null}

            {usesManualCommission ? (
                <div className="space-y-4 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
                    <div>
                        <h3 className="font-semibold text-amber-950 dark:text-amber-100">{t('salesAgentCommissions.manualOrderCommission')}</h3>
                        <p className="mt-1 text-sm text-amber-900/80 dark:text-amber-100/80">
                            {t('salesAgentCommissions.manualOrderCommissionDescription')}
                        </p>
                    </div>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor={fieldId('manual-commission-type')}>{t('salesAgentCommissions.commissionType')}</Label>
                            <Select
                                value={value.manualCommissionType}
                                onValueChange={(type) => onChange({
                                    ...value,
                                    manualCommissionType: type as ManualSalesAgentCommissionType,
                                    manualCommissionAmount: '',
                                    manualCommissionCurrency: orderCurrency
                                })}
                                disabled={disabled}
                            >
                                <SelectTrigger id={fieldId('manual-commission-type')} className="min-h-11">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="fixed_amount">{t('salesAgentCommissions.fixedAmount')}</SelectItem>
                                    <SelectItem value="percentage">{t('salesAgentCommissions.percentage')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        {value.manualCommissionType === 'fixed_amount' ? (
                            <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor={fieldId('manual-commission-amount')}>{t('salesAgentCommissions.commissionAmount')}</Label>
                                    <Input
                                        id={fieldId('manual-commission-amount')}
                                        inputMode="decimal"
                                        value={formatNumericInput(value.manualCommissionAmount)}
                                        onChange={(event) => update('manualCommissionAmount', sanitizeNumericInput(event.target.value, {
                                            allowDecimal: true,
                                            maxFractionDigits: 3
                                        }))}
                                        disabled={disabled}
                                        placeholder="0"
                                    />
                                </div>
                                <CurrencySelector
                                    value={value.manualCommissionCurrency}
                                    onChange={(currency) => update('manualCommissionCurrency', currency)}
                                    label={t('salesAgentCommissions.commissionCurrency')}
                                    iqdDisplayPreference={iqdDisplayPreference}
                                    allowedCurrencies={availableCurrencies}
                                    disabled={disabled}
                                />
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <Label htmlFor={fieldId('manual-commission-amount')}>{t('salesAgentCommissions.commissionPercentage')}</Label>
                                <Input
                                    id={fieldId('manual-commission-amount')}
                                    inputMode="decimal"
                                    value={formatNumericInput(value.manualCommissionAmount)}
                                    onChange={(event) => update('manualCommissionAmount', sanitizeNumericInput(event.target.value, {
                                        allowDecimal: true,
                                        maxFractionDigits: 6
                                    }))}
                                    disabled={disabled}
                                    placeholder="0%"
                                />
                            </div>
                        )}
                        <div className="space-y-2 rounded-xl border bg-background/70 p-3">
                            <div className="text-xs font-medium text-muted-foreground">
                                {value.manualCommissionType === 'fixed_amount' ? t('salesAgentCommissions.appliedCommission') : t('salesAgentCommissions.commissionOnOrderTotal')}
                            </div>
                            <div className="text-base font-bold">
                                {value.manualCommissionType === 'fixed_amount'
                                    ? manualConversion
                                        ? formatCurrency(manualConversion.convertedAmount, orderCurrency, iqdDisplayPreference)
                                        : manualAmount > 0
                                            ? t('salesAgentCommissions.exchangeRateUnavailable')
                                            : formatCurrency(0, orderCurrency, iqdDisplayPreference)
                                    : percentageCommission !== null
                                        ? formatCurrency(percentageCommission, orderCurrency, iqdDisplayPreference)
                                        : formatCurrency(0, orderCurrency, iqdDisplayPreference)}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {value.manualCommissionType === 'fixed_amount'
                                    ? t('salesAgentCommissions.convertedCommissionHint', { currency: orderCurrency.toUpperCase() })
                                    : t('salesAgentCommissions.percentageCommissionHint', { total: formatCurrency(orderTotal, orderCurrency, iqdDisplayPreference) })}
                            </p>
                        </div>
                    </div>
                </div>
            ) : null}

            {hasFixedCommissionPlan && allowPlanCommissionAmountOverride ? (
                <div className="space-y-4 rounded-2xl border border-violet-500/30 bg-violet-500/[0.06] p-4">
                    <div>
                        <h3 className="font-semibold text-violet-950 dark:text-violet-100">{t('salesAgentCommissions.orderCommissionAmount')}</h3>
                        <p className="mt-1 text-sm text-violet-900/80 dark:text-violet-100/80">
                            {t('salesAgentCommissions.orderCommissionAmountDescription')}
                        </p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <div className="space-y-2">
                            <Label htmlFor={fieldId('plan-commission-amount')}>{t('salesAgentCommissions.commissionAmount')}</Label>
                            <Input
                                id={fieldId('plan-commission-amount')}
                                inputMode="decimal"
                                value={formatNumericInput(value.manualCommissionAmount)}
                                onChange={(event) => update('manualCommissionAmount', sanitizeNumericInput(event.target.value, {
                                    allowDecimal: true,
                                    maxFractionDigits: 3
                                }))}
                                disabled={disabled}
                                placeholder="0"
                                aria-invalid={!value.manualCommissionAmount.trim()}
                                className={!value.manualCommissionAmount.trim() ? 'border-destructive' : undefined}
                            />
                        </div>
                        <div className="rounded-xl border bg-background/70 px-3 py-2 text-sm font-semibold">
                            {planCommissionCurrency.toUpperCase()}
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/70 p-3">
                        <div>
                            <div className="text-xs font-medium text-muted-foreground">{t('salesAgentCommissions.appliedCommission')}</div>
                            <div className="mt-1 text-base font-bold">
                                {Number(value.manualCommissionAmount) > 0
                                    ? formatCurrency(Number(value.manualCommissionAmount), planCommissionCurrency, iqdDisplayPreference)
                                    : formatCurrency(0, planCommissionCurrency, iqdDisplayPreference)}
                            </div>
                        </div>
                        {hasPlanCommissionOverride ? (
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="gap-1.5"
                                onClick={() => update('manualCommissionAmount', planCommissionAmountValue)}
                                disabled={disabled}
                            >
                                <RotateCcw className="h-3.5 w-3.5" />
                                {t('salesAgentCommissions.usePlanCommissionAmount')}
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {showOperationalFields ? (
                <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor={fieldId('customer-city')} className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        {t('salesAgentCommissions.customerCitySnapshot')}
                    </Label>
                    <Input
                        id={fieldId('customer-city')}
                        value={value.customerCity}
                        onChange={(event) => update('customerCity', event.target.value)}
                        disabled={disabled || !value.agentId}
                        placeholder={t('salesAgentCommissions.customerCityPlaceholder')}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={fieldId('delivery-charge')} className="flex items-center gap-2">
                        <Truck className="h-4 w-4 text-muted-foreground" />
                        {t('salesAgentCommissions.customerDeliveryCharge')}
                    </Label>
                    <Input
                        id={fieldId('delivery-charge')}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={value.deliveryChargeAmount}
                        onChange={(event) => update('deliveryChargeAmount', event.target.value)}
                        disabled={disabled || !value.agentId}
                        placeholder="0"
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={fieldId('internal-delivery-cost')}>{t('salesAgentCommissions.internalDeliveryCost')}</Label>
                    <Input
                        id={fieldId('internal-delivery-cost')}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={value.internalDeliveryCostAmount}
                        onChange={(event) => update('internalDeliveryCostAmount', event.target.value)}
                        disabled={disabled || !value.agentId}
                        placeholder="0"
                    />
                </div>
                </div>
            ) : null}

            {showReason ? (
                <div className="space-y-2">
                    <Label htmlFor={fieldId('reassignment-reason')}>{t('salesAgentCommissions.reassignmentReason')}</Label>
                    <Textarea
                        id={fieldId('reassignment-reason')}
                        value={value.reassignmentReason}
                        onChange={(event) => update('reassignmentReason', event.target.value)}
                        disabled={disabled}
                        rows={3}
                        placeholder={t('salesAgentCommissions.optionalAuditNote')}
                    />
                </div>
            ) : null}
        </div>
    )
}
