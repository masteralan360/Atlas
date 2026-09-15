import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
    getActiveSalesOrderAgentAssignments,
    replaceSalesOrderAgentAssignments,
    type CurrencyCode,
    type ExchangeRateSnapshot,
    type SalesOrder,
    type SalesOrderAgentAssignment,
    useSalesOrderAgentAssignments
} from '@/local-db'
import { getAppliedCurrencyConversion } from '@/lib/orderCurrency'
import { Button, Card, CardContent, CardHeader, CardTitle } from '@/ui/components'
import {
    SalesAgentAssignmentFields,
    type SalesAgentAssignmentFieldValue
} from './SalesAgentAssignmentFields'
import { formatCommissionPlanTerms } from './agentCommissionPresentation'
import {
    summarizeSalesOrderAgentCommissions,
    type SalesOrderCommissionAssignmentSummary
} from './salesOrderCommissionSummary'
import { useCommissionAgentDirectory } from './useCommissionAgentDirectory'

export interface SalesOrderCommissionAssignmentHandle {
    validate: () => {
        hasManualCommissionCurrencyConversion: boolean
        hasCommissionPlanCurrencyConversion: boolean
    }
    save: (order: Pick<SalesOrder, 'id' | 'currency' | 'total' | 'exchangeRates'>) => Promise<void>
}

export type { SalesOrderCommissionAssignmentSummary } from './salesOrderCommissionSummary'

interface SalesOrderCommissionAssignmentSectionProps {
    workspaceId: string
    editingOrderId?: string
    salesAccountAgentId?: string | null
    customerCity?: string
    assignedBy?: string | null
    orderCurrency: CurrencyCode
    orderTotal: number
    exchangeRates: ExchangeRateSnapshot[]
    availableCurrencies: CurrencyCode[]
    iqdDisplayPreference?: 'IQD' | 'د.ع'
    /** Locks this guided flow to the selected customer or sales-account agent. */
    fixedRecipientAgentId?: string | null
    fixedRecipientAssignmentSource?: AssignmentDraft['assignmentSource']
    showOperationalFields?: boolean
    requireManualCommissionWhenNoPlan?: boolean
    /** Lets the Sales Order form override a fixed plan's amount for this order only. */
    allowPlanCommissionAmountOverride?: boolean
    /** Receives the live, order-currency commission preview for selected beneficiaries. */
    onCommissionSummaryChange?: (summaries: SalesOrderCommissionAssignmentSummary[]) => void
    compact?: boolean
    disabled?: boolean
}

type AssignmentDraft = SalesAgentAssignmentFieldValue & {
    key: string
    assignmentId?: string
    assignmentSource: 'manual' | 'sales_account'
}

function createDraft(
    orderCurrency: CurrencyCode,
    assignment?: SalesOrderAgentAssignment,
    customerCity = '',
    assignmentSource: AssignmentDraft['assignmentSource'] = assignment?.assignmentSource === 'sales_account'
        ? 'sales_account'
        : 'manual'
): AssignmentDraft {
    return {
        key: assignment?.id || crypto.randomUUID(),
        assignmentId: assignment?.id,
        assignmentSource,
        agentId: assignment?.agentId || '',
        customerCity: assignment?.customerCitySnapshot || customerCity,
        deliveryChargeAmount: assignment?.deliveryChargeAmount ? String(assignment.deliveryChargeAmount) : '',
        internalDeliveryCostAmount: assignment?.internalDeliveryCostAmount ? String(assignment.internalDeliveryCostAmount) : '',
        reassignmentReason: '',
        manualCommissionType: assignment?.manualCommissionType || 'fixed_amount',
        manualCommissionAmount: assignment?.manualCommissionSourceAmount ? String(assignment.manualCommissionSourceAmount) : '',
        manualCommissionCurrency: assignment?.manualCommissionSourceCurrency || orderCurrency
    }
}

export const SalesOrderCommissionAssignmentSection = forwardRef<
    SalesOrderCommissionAssignmentHandle,
    SalesOrderCommissionAssignmentSectionProps
>(function SalesOrderCommissionAssignmentSection({
    workspaceId,
    editingOrderId,
    salesAccountAgentId = null,
    customerCity = '',
    assignedBy,
    orderCurrency,
    orderTotal,
    exchangeRates,
    availableCurrencies,
    iqdDisplayPreference,
    fixedRecipientAgentId,
    fixedRecipientAssignmentSource = 'manual',
    showOperationalFields = true,
    requireManualCommissionWhenNoPlan = false,
    allowPlanCommissionAmountOverride = false,
    onCommissionSummaryChange,
    compact = false,
    disabled = false
}, ref) {
    const { t } = useTranslation()
    const directory = useCommissionAgentDirectory(workspaceId)
    const assignments = useSalesOrderAgentAssignments(workspaceId)
    const activeAssignments = useMemo(
        () => editingOrderId ? getActiveSalesOrderAgentAssignments(assignments, editingOrderId) : [],
        [assignments, editingOrderId]
    )
    const [drafts, setDrafts] = useState<AssignmentDraft[]>(() => {
        if (fixedRecipientAgentId) {
            const assignmentSource = salesAccountAgentId === fixedRecipientAgentId
                ? 'sales_account'
                : fixedRecipientAssignmentSource
            return [{
                ...createDraft(orderCurrency, undefined, customerCity, assignmentSource),
                agentId: fixedRecipientAgentId
            }]
        }
        return []
    })
    const initializedPlanCommissionDraftKeys = useRef(new Set<string>())

    useEffect(() => {
        if (!editingOrderId) return
        const editableAssignments = activeAssignments.filter((assignment) => (
            assignment.assignmentSource !== 'order_creator_product'
            && assignment.assignmentSource !== 'marketplace_delivery_product'
        ))
        setDrafts(editableAssignments.length > 0
            ? editableAssignments.map((assignment) => createDraft(orderCurrency, assignment, customerCity))
            : [])
    }, [activeAssignments, customerCity, editingOrderId, orderCurrency])

    useEffect(() => {
        if (fixedRecipientAgentId !== undefined) return
        setDrafts((current) => {
            const manualDrafts = current.filter((draft) => draft.assignmentSource !== 'sales_account')
            const currentSalesAccountDraft = current.find((draft) => draft.assignmentSource === 'sales_account')
            if (!salesAccountAgentId) {
                return currentSalesAccountDraft ? manualDrafts : current
            }
            // An existing manual assignment for the same person is already a
            // beneficiary. Do not create a duplicate draft just because that
            // person was also selected as the order's sales account.
            if (manualDrafts.some((draft) => draft.agentId === salesAccountAgentId)) {
                return currentSalesAccountDraft ? manualDrafts : current
            }
            if (currentSalesAccountDraft?.agentId === salesAccountAgentId) return current
            return [
                {
                    ...createDraft(orderCurrency, undefined, customerCity, 'sales_account'),
                    agentId: salesAccountAgentId
                },
                ...manualDrafts
            ]
        })
    }, [customerCity, fixedRecipientAgentId, orderCurrency, salesAccountAgentId])

    useEffect(() => {
        if (fixedRecipientAgentId === undefined) return
        setDrafts((current) => {
            if (!fixedRecipientAgentId) return []
            const assignmentSource = salesAccountAgentId === fixedRecipientAgentId
                ? 'sales_account'
                : fixedRecipientAssignmentSource
            const currentDraft = current[0]
            if (
                current.length === 1
                && currentDraft?.agentId === fixedRecipientAgentId
                && currentDraft.assignmentSource === assignmentSource
            ) return current
            return [{
                ...createDraft(orderCurrency, undefined, customerCity, assignmentSource),
                agentId: fixedRecipientAgentId
            }]
        })
    }, [customerCity, fixedRecipientAgentId, fixedRecipientAssignmentSource, orderCurrency, salesAccountAgentId])

    useEffect(() => {
        if (editingOrderId || !customerCity) return
        setDrafts((current) => current.map((draft) => draft.customerCity
            ? draft
            : { ...draft, customerCity }))
    }, [customerCity, editingOrderId])

    useEffect(() => {
        setDrafts((current) => current.map((draft) => draft.manualCommissionType === 'percentage'
            && draft.manualCommissionCurrency !== orderCurrency
            ? { ...draft, manualCommissionCurrency: orderCurrency }
            : draft))
    }, [orderCurrency])

    const selectedAgentIds = useMemo(
        () => new Set(drafts.map((draft) => draft.agentId).filter(Boolean)),
        [drafts]
    )
    const updateDraft = useCallback((key: string, value: SalesAgentAssignmentFieldValue) => {
        setDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...value } : draft))
    }, [])
    const removeDraft = useCallback((key: string) => {
        setDrafts((current) => current.filter((draft) => draft.key !== key))
    }, [])
    const addDraft = useCallback(() => {
        setDrafts((current) => [...current, createDraft(orderCurrency, undefined, customerCity)])
    }, [customerCity, orderCurrency])

    const resolveSelectedAgent = useCallback((draft: Pick<AssignmentDraft, 'agentId'>) => (
        directory.eligibleAgents.find((entry) => entry.agent.id === draft.agentId)
        || directory.agentById.get(draft.agentId)
    ), [directory.agentById, directory.eligibleAgents])

    useEffect(() => {
        setDrafts((current) => {
            const draftsToInitialize = new Set<string>()
            for (const draft of current) {
                if (initializedPlanCommissionDraftKeys.current.has(draft.key)) continue
                const selectedAgent = resolveSelectedAgent(draft)
                if (!selectedAgent) continue
                initializedPlanCommissionDraftKeys.current.add(draft.key)
                const plan = selectedAgent.plan
                if (plan?.commissionType === 'fixed_amount' && !draft.manualCommissionAmount.trim()) {
                    draftsToInitialize.add(draft.key)
                }
            }
            if (draftsToInitialize.size === 0) return current
            return current.map((draft) => {
                if (!draftsToInitialize.has(draft.key)) return draft
                const plan = resolveSelectedAgent(draft)!.plan!
                return {
                    ...draft,
                    manualCommissionType: 'fixed_amount',
                    manualCommissionAmount: Number(plan.fixedAmount ?? 0) === 0 ? '' : String(plan.fixedAmount),
                    manualCommissionCurrency: plan.fixedCurrency || orderCurrency
                }
            })
        })
    }, [drafts, orderCurrency, resolveSelectedAgent])

    const getManualCommissionInput = useCallback((
        draft: AssignmentDraft,
        order: Pick<SalesOrder, 'currency' | 'total' | 'exchangeRates'>
    ) => {
        const selectedAgent = resolveSelectedAgent(draft)
        const fixedPlan = selectedAgent?.plan?.commissionType === 'fixed_amount'
            ? selectedAgent.plan
            : null
        if (!draft.agentId || (selectedAgent?.plan && !fixedPlan)) return null
        if (!draft.manualCommissionAmount.trim()) {
            if (fixedPlan) throw new Error(t('salesAgentCommissions.errors.planCommissionAmountRequired'))
            return null
        }
        const amount = Number(draft.manualCommissionAmount)
        if (!Number.isFinite(amount) || amount < 0 || (!fixedPlan && amount <= 0)) {
            throw new Error(t('salesAgentCommissions.errors.manualCommissionPositive'))
        }
        const commissionType = fixedPlan ? 'fixed_amount' : draft.manualCommissionType
        if (commissionType === 'percentage') {
            if (amount > 100) throw new Error(t('salesAgentCommissions.errors.manualCommissionPercentageMax'))
            return {
                type: 'percentage' as const,
                amount,
                currency: order.currency,
                exchangeRates: []
            }
        }
        const conversion = getAppliedCurrencyConversion(
            amount,
            fixedPlan?.fixedCurrency || draft.manualCommissionCurrency,
            order.currency,
            order.exchangeRates ?? exchangeRates
        )
        if (!conversion) throw new Error(t('salesAgentCommissions.errors.commissionExchangeRateUnavailable'))
        return {
            type: 'fixed_amount' as const,
            amount,
            currency: fixedPlan?.fixedCurrency || draft.manualCommissionCurrency,
            exchangeRates: conversion.exchangeRates
        }
    }, [exchangeRates, resolveSelectedAgent, t])

    const commissionSummaries = useMemo(() => summarizeSalesOrderAgentCommissions({
        drafts,
        resolveAgent: (agentId) => {
            const selectedAgent = resolveSelectedAgent({ agentId })
            return selectedAgent ? {
                id: selectedAgent.agent.id,
                name: selectedAgent.name,
                plan: selectedAgent.plan ?? null
            } : undefined
        },
        orderCurrency,
        orderTotal,
        exchangeRates
    }), [drafts, exchangeRates, orderCurrency, orderTotal, resolveSelectedAgent])

    useEffect(() => {
        onCommissionSummaryChange?.(commissionSummaries)
    }, [commissionSummaries, onCommissionSummaryChange])

    const validate = useCallback(() => {
        let hasManualCommissionCurrencyConversion = false
        let hasCommissionPlanCurrencyConversion = false
        const seenAgentIds = new Set<string>()
        for (const draft of drafts) {
            if (!draft.agentId) continue
            if (seenAgentIds.has(draft.agentId)) {
                throw new Error(t('salesAgentCommissions.errors.duplicateSalesAgent'))
            }
            seenAgentIds.add(draft.agentId)
            const selectedAgent = resolveSelectedAgent(draft)
            if (
                requireManualCommissionWhenNoPlan
                && selectedAgent
                && !selectedAgent.plan
                && !draft.manualCommissionAmount.trim()
            ) {
                throw new Error(t('salesAgentCommissions.errors.manualCommissionPositive'))
            }
            const manual = getManualCommissionInput(draft, {
                currency: orderCurrency,
                total: orderTotal,
                exchangeRates
            })
            const fixedPlanCurrency = selectedAgent?.plan?.commissionType === 'fixed_amount'
                ? selectedAgent.plan.fixedCurrency
                : null
            const requiresPlanConversion = Boolean(
                fixedPlanCurrency
                && fixedPlanCurrency !== orderCurrency
                && !draft.manualCommissionAmount.trim()
            )
            if (requiresPlanConversion && !getAppliedCurrencyConversion(
                1,
                fixedPlanCurrency!,
                orderCurrency,
                exchangeRates
            )) {
                throw new Error(t('salesAgentCommissions.errors.commissionExchangeRateUnavailable'))
            }
            hasManualCommissionCurrencyConversion ||= Boolean(
                manual?.type === 'fixed_amount' && manual.currency !== orderCurrency
            )
            hasCommissionPlanCurrencyConversion ||= requiresPlanConversion
        }
        return { hasManualCommissionCurrencyConversion, hasCommissionPlanCurrencyConversion }
    }, [drafts, exchangeRates, getManualCommissionInput, orderCurrency, orderTotal, requireManualCommissionWhenNoPlan, resolveSelectedAgent, t])

    const save = useCallback(async (order: Pick<SalesOrder, 'id' | 'currency' | 'total' | 'exchangeRates'>) => {
        validate()
        const selectedDrafts = drafts.filter((draft) => draft.agentId)
        await replaceSalesOrderAgentAssignments(workspaceId, {
            orderId: order.id,
            assignedBy: assignedBy || undefined,
            assignments: selectedDrafts.map((draft) => ({
                agentId: draft.agentId,
                assignmentSource: draft.assignmentSource,
                reason: draft.reassignmentReason.trim() || undefined,
                customerCitySnapshot: draft.customerCity.trim() || undefined,
                deliveryChargeAmount: Math.max(0, Number(draft.deliveryChargeAmount) || 0),
                internalDeliveryCostAmount: Math.max(0, Number(draft.internalDeliveryCostAmount) || 0),
                manualCommission: getManualCommissionInput(draft, order)
            }))
        })
    }, [assignedBy, drafts, getManualCommissionInput, validate, workspaceId])

    useImperativeHandle(ref, () => ({ validate, save }), [save, validate])

    return (
        <Card className={compact ? 'border-0 bg-transparent shadow-none' : 'border-violet-500/20 bg-violet-500/[0.02]'}>
            {!compact ? (
                <CardHeader className="space-y-1">
                    <CardTitle className="flex items-center gap-2">
                        <UsersRound className="h-5 w-5 text-violet-600" />
                        {t('salesAgentCommissions.salesAgentBeneficiaries')}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                        {t('salesAgentCommissions.salesAgentBeneficiariesDescription')}
                    </p>
                </CardHeader>
            ) : null}
            <CardContent className={compact ? 'space-y-0 p-0' : 'space-y-4'}>
                {drafts.map((draft, index) => {
                    const currentAgent = resolveSelectedAgent(draft)
                    const isSalesAccountBeneficiary = draft.assignmentSource === 'sales_account'
                    const manualAgentNumber = drafts
                        .slice(0, index + 1)
                        .filter((entry) => entry.assignmentSource !== 'sales_account')
                        .length
                    const availableAgents = directory.eligibleAgents.filter((entry) => (
                        fixedRecipientAgentId !== undefined
                            ? entry.agent.id === fixedRecipientAgentId
                            : entry.agent.id === draft.agentId || !selectedAgentIds.has(entry.agent.id)
                    ))
                    return (
                        <div key={draft.key} className={compact ? 'space-y-0' : 'space-y-4 rounded-2xl border bg-background/70 p-4 sm:p-5'}>
                            {!compact ? (
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-2 text-sm font-semibold">
                                        {isSalesAccountBeneficiary
                                            ? t('salesAgentCommissions.salesAccountBeneficiary')
                                            : `${t('salesAgentCommissions.salesAgent')} ${manualAgentNumber}`}
                                        {isSalesAccountBeneficiary ? (
                                            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                                                {t('agentSalesAccounts.salesAccount')}
                                            </span>
                                        ) : null}
                                    </div>
                                    {!isSalesAccountBeneficiary && fixedRecipientAgentId === undefined ? (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            className="gap-1.5 text-muted-foreground hover:text-destructive"
                                            onClick={() => removeDraft(draft.key)}
                                            disabled={disabled}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            {t('salesAgentCommissions.removeSalesAgent')}
                                        </Button>
                                    ) : null}
                                </div>
                            ) : null}
                            {compact && currentAgent?.plan ? (
                                <div className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.05] p-4">
                                    <p className="text-xs font-medium text-muted-foreground">{t('salesAgentCommissions.commissionPlan')}</p>
                                    <p className="mt-1 font-semibold">{formatCommissionPlanTerms(currentAgent.plan, iqdDisplayPreference || 'IQD')}</p>
                                </div>
                            ) : (
                                <SalesAgentAssignmentFields
                                    idPrefix={`sales-order-agent-${draft.key}`}
                                    value={draft}
                                    onChange={(value) => updateDraft(draft.key, value)}
                                    agents={availableAgents}
                                    currentAgent={currentAgent}
                                    orderCurrency={orderCurrency}
                                    orderTotal={orderTotal}
                                    exchangeRates={exchangeRates}
                                    availableCurrencies={availableCurrencies}
                                    iqdDisplayPreference={iqdDisplayPreference}
                                    showAgentSelection={!compact}
                                    showAgentSummary={!compact}
                                    showReason={Boolean(draft.assignmentId)}
                                    showOperationalFields={showOperationalFields}
                                    allowPlanCommissionAmountOverride={allowPlanCommissionAmountOverride}
                                    lockAgentSelection={isSalesAccountBeneficiary || fixedRecipientAgentId !== undefined}
                                    disabled={disabled}
                                />
                            )}
                        </div>
                    )
                })}
                {!compact && fixedRecipientAgentId === undefined ? (
                    <Button type="button" variant="outline" className="w-full gap-2" onClick={addDraft} disabled={disabled}>
                        <Plus className="h-4 w-4" />
                        {t('salesAgentCommissions.addSalesAgent')}
                    </Button>
                ) : null}
            </CardContent>
        </Card>
    )
})
