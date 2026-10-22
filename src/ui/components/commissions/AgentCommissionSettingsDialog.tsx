import { useEffect, useMemo, useState } from 'react'
import { Plus, ShieldCheck, Trash2, Truck, UserMinus, UserPlus, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatLocalDateValue, formatNumericInput, generateId, parseLocalDateValue, sanitizeNumericInput } from '@/lib/utils'

import { createAgentCommissionPlan, deleteAgentCommissionPlan, setAgentCommissionMembership, updateAgentCommissionPlan, type AgentCommissionPlan, type CommissionCalculationBasis, type CommissionPlanLevel, type CommissionPlanType, type CurrencyCode, type SalesAgentCommissionSheetType } from '@/local-db'
import { supportsSalesAgentWorkflows } from '@/local-db/models'
import { Button } from '@/ui/components/button'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CurrencySelector,
  DateTimePicker,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  useToast,
} from '@/ui/components'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { getCurrentCommissionPlanRevision } from './agentCommissionPresentation'
import { useCommissionAgentDirectory } from './useCommissionAgentDirectory'

const NO_PLAN_VALUE = '__no_plan__'
const COMMISSION_PLAN_CURRENCIES: CurrencyCode[] = ['usd', 'eur', 'iqd', 'try']

type PlanDraft = {
    id?: string
    level: CommissionPlanLevel
    name: string
    commissionType: CommissionPlanType
    ratePercent: string
    fixedAmount: string
    fixedCurrency: CurrencyCode
    tierName: string
    calculationBasis: CommissionCalculationBasis
    includeTax: boolean
    includeDeliveryCharge: boolean
    effectiveFrom: string
    effectiveTo: string
    isActive: boolean
    notes: string
}

function dateInputValue(value?: string | null) {
    return formatLocalDateValue(value)
}

function createPlanDraft(defaultCurrency: CurrencyCode, plan?: AgentCommissionPlan): PlanDraft {
    return {
        id: plan?.id,
        level: plan?.level || `commission-level-${generateId()}`,
        name: plan?.name || '',
        commissionType: plan ? plan.commissionType || 'percentage' : 'fixed_amount',
        ratePercent: String(plan?.ratePercent ?? 0),
        fixedAmount: String(plan?.fixedAmount ?? 0),
        fixedCurrency: plan?.fixedCurrency || defaultCurrency,
        tierName: plan?.tierName || '',
        calculationBasis: plan?.calculationBasis || 'net_profit',
        includeTax: plan?.includeTax || false,
        includeDeliveryCharge: plan?.includeDeliveryCharge || false,
        effectiveFrom: dateInputValue(plan?.effectiveFrom) || new Date().toISOString().slice(0, 10),
        effectiveTo: dateInputValue(plan?.effectiveTo),
        isActive: plan?.isActive ?? true,
        notes: plan?.notes || ''
    }
}

function planToken(draft: Pick<PlanDraft, 'id' | 'level'>) {
    return draft.id || draft.level
}

function commissionPlanDraftSummary(draft: Pick<PlanDraft, 'commissionType' | 'ratePercent' | 'fixedAmount' | 'fixedCurrency'>) {
    return draft.commissionType === 'fixed_amount'
        ? `${formatNumericInput(draft.fixedAmount)} ${draft.fixedCurrency.toUpperCase()}`
        : `${Number(draft.ratePercent) || 0}%`
}

interface AgentCommissionSettingsFormProps {
    workspaceId: string
    userId?: string | null
    onCancel?: () => void
}

export function AgentCommissionSettingsForm({ workspaceId, userId, onCancel }: AgentCommissionSettingsFormProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { features, updateSettings } = useWorkspace()
    const defaultCurrency = features.default_currency as CurrencyCode
    const directory = useCommissionAgentDirectory(workspaceId)
    const [planDrafts, setPlanDrafts] = useState<PlanDraft[]>([])
    const [membershipSelections, setMembershipSelections] = useState<Record<string, string>>({})
    const [commissionSheetType, setCommissionSheetType] = useState<SalesAgentCommissionSheetType>(features.sales_agent_commission_sheet_type)
    const [isSaving, setIsSaving] = useState(false)
    const [planToDelete, setPlanToDelete] = useState<PlanDraft | null>(null)
    const [isDeletingPlan, setIsDeletingPlan] = useState(false)
    const [planToManageAgents, setPlanToManageAgents] = useState<PlanDraft | null>(null)
    const [managedAgentIds, setManagedAgentIds] = useState<string[]>([])
    const fieldAgents = useMemo(() => directory.agents.filter((entry) => supportsSalesAgentWorkflows(entry.agent.agentType)), [directory.agents])

    useEffect(() => {
        const levels = Array.from(new Set(directory.plans
            .filter((plan) => !plan.isDeleted && (plan.isActive || !plan.effectiveTo))
            .map((plan) => plan.level)))
        const nextDrafts = levels
            .map((level) => getCurrentCommissionPlanRevision(directory.plans, level))
            .filter((plan): plan is AgentCommissionPlan => Boolean(plan))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((plan) => createPlanDraft(defaultCurrency, plan))
        setPlanDrafts(nextDrafts)
        setMembershipSelections(Object.fromEntries(fieldAgents.map((entry) => [entry.agent.id, entry.membership?.planId || NO_PLAN_VALUE])))
    }, [defaultCurrency, directory.plans, fieldAgents])

    useEffect(() => {
        setCommissionSheetType(features.sales_agent_commission_sheet_type)
    }, [features.sales_agent_commission_sheet_type])

    function updateDraft(level: CommissionPlanLevel, patch: Partial<PlanDraft>) {
        setPlanDrafts((current) => current.map((draft) => (draft.level === level ? { ...draft, ...patch } : draft)))
    }

    function addPlanDraft() {
        setPlanDrafts((current) => [...current, createPlanDraft(defaultCurrency)])
    }

    function removeUnsavedPlanDraft(level: CommissionPlanLevel) {
        setPlanDrafts((current) => current.filter((draft) => draft.id || draft.level !== level))
        setMembershipSelections((current) => Object.fromEntries(Object.entries(current).map(([agentId, planId]) => [agentId, planId === level ? NO_PLAN_VALUE : planId])))
    }

    function isSelectedForPlan(selection: string | undefined, plan: Pick<PlanDraft, 'id' | 'level'>) {
        return selection === planToken(plan) || Boolean(plan.id && selection === plan.id)
    }

    function openAgentManager(plan: PlanDraft) {
        setPlanToManageAgents(plan)
        setManagedAgentIds(fieldAgents
            .filter((entry) => isSelectedForPlan(membershipSelections[entry.agent.id], plan))
            .map((entry) => entry.agent.id))
    }

    function toggleManagedAgent(agentId: string) {
        setManagedAgentIds((current) => current.includes(agentId)
            ? current.filter((id) => id !== agentId)
            : [...current, agentId])
    }

    function applyManagedAgents() {
        const plan = planToManageAgents
        if (!plan) return
        const selectedAgentIds = new Set(managedAgentIds)
        const token = planToken(plan)
        setMembershipSelections((current) => Object.fromEntries(fieldAgents.map((entry) => {
            const agentId = entry.agent.id
            const selection = current[agentId] || NO_PLAN_VALUE
            if (selectedAgentIds.has(agentId)) return [agentId, token]
            return [agentId, isSelectedForPlan(selection, plan) ? NO_PLAN_VALUE : selection]
        })))
        setPlanToManageAgents(null)
    }

    async function handleDeletePlan() {
        const plan = planToDelete
        if (!plan?.id) return

        setIsDeletingPlan(true)
        try {
            await deleteAgentCommissionPlan(plan.id, { deletedBy: userId || null })
            setPlanToDelete(null)
            toast({ title: t('salesAgentCommissions.commissionLevelDeleted') })
        } catch (error: any) {
            toast({
                title: t('salesAgentCommissions.couldNotDeleteCommissionLevel'),
                description: error?.message || t('salesAgentCommissions.tryAgain'),
                variant: 'destructive'
            })
        } finally {
            setIsDeletingPlan(false)
        }
    }

    async function handleSave() {
        const invalidDraft = planDrafts.find((draft) => (
            !draft.name.trim()
            || (draft.commissionType === 'percentage'
                ? !Number.isFinite(Number(draft.ratePercent)) || Number(draft.ratePercent) < 0 || Number(draft.ratePercent) > 100
                : !Number.isFinite(Number(draft.fixedAmount)) || Number(draft.fixedAmount) < 0)
        ))
        if (invalidDraft) {
            toast({
                title: t('salesAgentCommissions.checkPlans'),
                description: t('salesAgentCommissions.invalidPlanDescription', {
                    level: invalidDraft.name.trim() || t('salesAgentCommissions.newCommissionLevel')
                }),
                variant: 'destructive'
            })
            return
        }
        if (commissionSheetType === 'tier_based') {
            const draftWithoutTier = planDrafts.find((draft) => !draft.tierName.trim())
            if (draftWithoutTier) {
                toast({
                    title: t('salesAgentCommissions.checkPlans'),
                    description: t('salesAgentCommissions.tierRequiredDescription', {
                        level: draftWithoutTier.name.trim() || t('salesAgentCommissions.newCommissionLevel')
                    }),
                    variant: 'destructive'
                })
                return
            }
        }

        setIsSaving(true)
        try {
            const savedPlans = await Promise.all(
                planDrafts.map(async (draft) => {
                    const input = {
                        name: draft.name.trim(),
                        level: draft.level,
                        commissionType: draft.commissionType,
                        ratePercent: draft.commissionType === 'percentage' ? Number(draft.ratePercent) : 0,
                        fixedAmount: draft.commissionType === 'fixed_amount' ? Number(draft.fixedAmount) : null,
                        fixedCurrency: draft.commissionType === 'fixed_amount' ? draft.fixedCurrency : null,
                        tierName: draft.tierName.trim() || null,
                        calculationBasis: draft.calculationBasis,
                        includeTax: draft.includeTax,
                        includeDeliveryCharge: draft.includeDeliveryCharge,
                        effectiveFrom: draft.effectiveFrom,
                        effectiveTo: draft.effectiveTo || null,
                        isActive: draft.isActive,
                        notes: draft.notes.trim() || null,
                        createdBy: userId || null
                    }
                    return draft.id ? updateAgentCommissionPlan(draft.id, input) : createAgentCommissionPlan(workspaceId, input)
                })
            )
            const savedPlanByToken = new Map(planDrafts.map((draft, index) => [planToken(draft), savedPlans[index]]))
            const planIdByToken = new Map<string, string | null>()
            for (const [token, plan] of savedPlanByToken) {
                const selectablePlanId = plan.isActive ? plan.id : null
                planIdByToken.set(token, selectablePlanId)
                planIdByToken.set(plan.id, selectablePlanId)
            }

            await Promise.all(
                fieldAgents.flatMap((entry) => {
                    const desiredToken = membershipSelections[entry.agent.id] || NO_PLAN_VALUE
                    const desiredPlanId = desiredToken === NO_PLAN_VALUE ? null : planIdByToken.has(desiredToken) ? (planIdByToken.get(desiredToken) ?? null) : desiredToken
                    const currentPlanId = entry.membership?.planId || null
                    if (desiredPlanId === currentPlanId) return []

                    return [
                        setAgentCommissionMembership(workspaceId, {
                            agentId: entry.agent.id,
                            planId: desiredPlanId,
                            assignedBy: userId || undefined
                        })
                    ]
                })
            )

            if (commissionSheetType !== features.sales_agent_commission_sheet_type) {
                await updateSettings({ sales_agent_commission_sheet_type: commissionSheetType })
            }

            toast({ title: t('salesAgentCommissions.settingsSaved') })
        } catch (error: any) {
            toast({
                title: t('salesAgentCommissions.couldNotSaveSettings'),
                description: error?.message || t('salesAgentCommissions.tryAgain'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <>
        <form
            onSubmit={(event) => {
                event.preventDefault()
                void handleSave()
            }}
            className="space-y-6"
        >
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(360px,0.72fr)]">
                <Card className="overflow-hidden border-violet-500/20 shadow-sm">
                    <CardHeader className="flex flex-col gap-4 border-b bg-violet-500/[0.035] px-6 py-5 sm:flex-row sm:items-start sm:justify-between lg:px-7">
                        <div className="space-y-1">
                            <CardTitle id="commission-plans-heading" className="text-xl">
                                {t('salesAgentCommissions.commissionPlans')}
                            </CardTitle>
                        </div>
                        <Button type="button" variant="outline" className="gap-2 self-start" onClick={addPlanDraft} disabled={isSaving}>
                            <Plus className="h-4 w-4" />
                            {t('salesAgentCommissions.addCommissionLevel')}
                        </Button>
                    </CardHeader>
                    <CardContent className="space-y-6 p-6 lg:p-7">
                        <section className="grid gap-4 rounded-2xl border bg-muted/15 p-5 md:grid-cols-[minmax(0,1fr)_minmax(19rem,0.8fr)] md:items-center">
                            <div className="space-y-1">
                                <Label htmlFor="sales-agent-commission-sheet-type" className="font-semibold">{t('salesAgentCommissions.commissionSheetType')}</Label>
                                <p className="text-sm text-muted-foreground">
                                    {commissionSheetType === 'tier_based'
                                        ? t('salesAgentCommissions.tierBasedCommissionSheetDescription')
                                        : t('salesAgentCommissions.normalCommissionSheetDescription')}
                                </p>
                            </div>
                            <Select
                                value={commissionSheetType}
                                onValueChange={(value) => setCommissionSheetType(value as SalesAgentCommissionSheetType)}
                                disabled={isSaving}
                            >
                                <SelectTrigger id="sales-agent-commission-sheet-type">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="normal">{t('salesAgentCommissions.normalCommissionSheet')}</SelectItem>
                                    <SelectItem value="tier_based">{t('salesAgentCommissions.tierBasedCommissionSheet')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </section>
                        <section aria-labelledby="commission-plans-heading">
                            {planDrafts.length === 0 ? (
                                <div className="rounded-2xl border border-dashed bg-muted/10 px-6 py-12 text-center text-sm text-muted-foreground">{t('salesAgentCommissions.noCommissionLevels')}</div>
                            ) : (
                                <div className="grid gap-6 xl:grid-cols-2 2xl:grid-cols-3">
                                    {planDrafts.map((draft) => (
                                        <section key={draft.level} className="flex h-full min-h-[32rem] flex-col space-y-5 rounded-2xl border bg-card p-5 shadow-sm lg:p-6">
                                            <div className="flex items-center justify-between gap-3">
                                                <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                                                    {draft.name.trim() || t('salesAgentCommissions.newCommissionLevel')}
                                                </Badge>
                                                <div className="flex items-center gap-2">
                                                    <Button
                                                        type="button"
                                                        size="icon"
                                                        variant="ghost"
                                                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                                        onClick={() => draft.id ? setPlanToDelete(draft) : removeUnsavedPlanDraft(draft.level)}
                                                        disabled={isSaving || isDeletingPlan}
                                                        title={draft.id ? t('salesAgentCommissions.deleteCommissionLevel') : t('salesAgentCommissions.removeLevel')}
                                                        aria-label={draft.id ? t('salesAgentCommissions.deleteCommissionLevel') : t('salesAgentCommissions.removeLevel')}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                    <Label htmlFor={`commission-active-${draft.level}`} className="text-xs">
                                                        {t('salesAgentCommissions.active')}
                                                    </Label>
                                                    <Switch id={`commission-active-${draft.level}`} checked={draft.isActive} onCheckedChange={(isActive) => updateDraft(draft.level, { isActive })} disabled={isSaving} />
                                                </div>
                                            </div>
                                            <div className="grid gap-5 lg:grid-cols-2">
                                                <div className="space-y-2 lg:col-span-2">
                                                    <Label htmlFor={`commission-name-${draft.level}`}>{t('salesAgentCommissions.levelName')}</Label>
                                                    <Input
                                                        id={`commission-name-${draft.level}`}
                                                        value={draft.name}
                                                        onChange={(event) =>
                                                            updateDraft(draft.level, {
                                                                name: event.target.value
                                                            })
                                                        }
                                                        disabled={isSaving}
                                                        placeholder={t('salesAgentCommissions.levelNamePlaceholder')}
                                                    />
                                                </div>
                                                {commissionSheetType === 'tier_based' ? (
                                                    <div className="space-y-2 lg:col-span-2">
                                                        <Label htmlFor={`commission-tier-${draft.level}`}>{t('salesAgentCommissions.tier')}</Label>
                                                        <Input
                                                            id={`commission-tier-${draft.level}`}
                                                            value={draft.tierName}
                                                            onChange={(event) => updateDraft(draft.level, { tierName: event.target.value })}
                                                            disabled={isSaving}
                                                            placeholder={t('salesAgentCommissions.tierPlaceholder')}
                                                        />
                                                    </div>
                                                ) : null}
                                                <div className="space-y-2 lg:col-span-2">
                                                    <Label htmlFor={`commission-type-${draft.level}`}>{t('salesAgentCommissions.commissionType')}</Label>
                                                    <Select
                                                        value={draft.commissionType}
                                                        onValueChange={(commissionType) =>
                                                            updateDraft(draft.level, {
                                                                commissionType: commissionType as CommissionPlanType
                                                            })
                                                        }
                                                        disabled={isSaving}
                                                    >
                                                        <SelectTrigger id={`commission-type-${draft.level}`}>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="fixed_amount">{t('salesAgentCommissions.fixedAmount')}</SelectItem>
                                                            <SelectItem value="percentage">{t('salesAgentCommissions.percentage')}</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                {draft.commissionType === 'fixed_amount' ? (
                                                    <div className="grid gap-5 sm:grid-cols-2 lg:col-span-2">
                                                        <div className="space-y-2">
                                                            <Label htmlFor={`commission-fixed-amount-${draft.level}`}>{t('salesAgentCommissions.commissionAmount')}</Label>
                                                            <Input
                                                                id={`commission-fixed-amount-${draft.level}`}
                                                                type="text"
                                                                inputMode="decimal"
                                                                value={formatNumericInput(draft.fixedAmount)}
                                                                onChange={(event) =>
                                                                    updateDraft(draft.level, {
                                                                        fixedAmount: sanitizeNumericInput(event.target.value, {
                                                                            allowDecimal: true,
                                                                            maxFractionDigits: 3
                                                                        })
                                                                    })
                                                                }
                                                                disabled={isSaving}
                                                                placeholder="0"
                                                            />
                                                        </div>
                                                        <CurrencySelector
                                                            value={draft.fixedCurrency}
                                                            onChange={(fixedCurrency) => updateDraft(draft.level, { fixedCurrency })}
                                                            label={t('salesAgentCommissions.commissionCurrency')}
                                                            iqdDisplayPreference={features.iqd_display_preference}
                                                            allowedCurrencies={COMMISSION_PLAN_CURRENCIES}
                                                            disabled={isSaving}
                                                        />
                                                    </div>
                                                ) : (
                                                <div className="grid gap-5 sm:grid-cols-2 lg:col-span-2">
                                                    <div className="space-y-2">
                                                        <Label htmlFor={`commission-rate-${draft.level}`}>{t('salesAgentCommissions.ratePercent')}</Label>
                                                        <Input
                                                            id={`commission-rate-${draft.level}`}
                                                            type="text"
                                                            inputMode="decimal"
                                                            value={formatNumericInput(draft.ratePercent)}
                                                            onChange={(event) =>
                                                                updateDraft(draft.level, {
                                                                    ratePercent: sanitizeNumericInput(event.target.value, {
                                                                        allowDecimal: true,
                                                                        maxFractionDigits: 2
                                                                    })
                                                                })
                                                            }
                                                            disabled={isSaving}
                                                        />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <Label>{t('salesAgentCommissions.basis')}</Label>
                                                        <Select
                                                            value={draft.calculationBasis}
                                                            onValueChange={(calculationBasis) =>
                                                                updateDraft(draft.level, {
                                                                    calculationBasis: calculationBasis as CommissionCalculationBasis
                                                                })
                                                            }
                                                            disabled={isSaving}
                                                        >
                                                            <SelectTrigger>
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="net_profit">{t('salesAgentCommissions.netProfit')}</SelectItem>
                                                                <SelectItem value="net_revenue">{t('salesAgentCommissions.netRevenue')}</SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                </div>
                                                )}
                                                <div className="grid gap-5 sm:grid-cols-2 lg:col-span-2">
                                                    <div className="space-y-2">
                                                        <Label htmlFor={`commission-start-${draft.level}`}>{t('salesAgentCommissions.effectiveFrom')}</Label>
                                                        <DateTimePicker
                                                            id={`commission-start-${draft.level}`}
                                                            mode="date"
                                                            date={parseLocalDateValue(draft.effectiveFrom)}
                                                            setDate={(date) =>
                                                                date &&
                                                                updateDraft(draft.level, {
                                                                    effectiveFrom: formatLocalDateValue(date)
                                                                })
                                                            }
                                                            disabled={isSaving}
                                                        />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <Label htmlFor={`commission-end-${draft.level}`}>{t('salesAgentCommissions.effectiveTo')}</Label>
                                                        <DateTimePicker
                                                            id={`commission-end-${draft.level}`}
                                                            mode="date"
                                                            date={parseLocalDateValue(draft.effectiveTo)}
                                                            setDate={(date) =>
                                                                updateDraft(draft.level, {
                                                                    effectiveTo: date ? formatLocalDateValue(date) : ''
                                                                })
                                                            }
                                                            disabled={isSaving}
                                                        />
                                                    </div>
                                                </div>
                                                {draft.commissionType === 'percentage' ? (
                                                <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
                                                    <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/15 p-4">
                                                        <div className="flex items-center justify-between gap-3">
                                                            <Label htmlFor={`commission-tax-${draft.level}`} className="text-sm">
                                                                {t('salesAgentCommissions.includeTax')}
                                                            </Label>
                                                            <Switch
                                                                id={`commission-tax-${draft.level}`}
                                                                checked={draft.includeTax}
                                                                onCheckedChange={(includeTax) =>
                                                                    updateDraft(draft.level, {
                                                                        includeTax
                                                                    })
                                                                }
                                                                disabled={isSaving}
                                                            />
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/15 p-4">
                                                        <div className="flex items-center justify-between gap-3">
                                                            <Label htmlFor={`commission-delivery-${draft.level}`} className="text-sm">
                                                                {t('salesAgentCommissions.includeCustomerDeliveryCharge')}
                                                            </Label>
                                                            <Switch
                                                                id={`commission-delivery-${draft.level}`}
                                                                checked={draft.includeDeliveryCharge}
                                                                onCheckedChange={(includeDeliveryCharge) =>
                                                                    updateDraft(draft.level, {
                                                                        includeDeliveryCharge
                                                                    })
                                                                }
                                                                disabled={isSaving}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                                ) : null}
                                                <div className="space-y-2 lg:col-span-2">
                                                    <Label htmlFor={`commission-notes-${draft.level}`}>{t('salesAgentCommissions.notes')}</Label>
                                                    <Textarea
                                                        id={`commission-notes-${draft.level}`}
                                                        value={draft.notes}
                                                        onChange={(event) =>
                                                            updateDraft(draft.level, {
                                                                notes: event.target.value
                                                            })
                                                        }
                                                        rows={2}
                                                        disabled={isSaving}
                                                    />
                                                </div>
                                                <div className="flex justify-end border-t pt-4 lg:col-span-2">
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        className="gap-2"
                                                        onClick={() => openAgentManager(draft)}
                                                        disabled={isSaving || isDeletingPlan || !draft.isActive}
                                                    >
                                                        <UsersRound className="h-4 w-4" />
                                                        {t('salesAgentCommissions.manageAgents')}
                                                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none">
                                                            {fieldAgents.filter((entry) => isSelectedForPlan(membershipSelections[entry.agent.id], draft)).length}
                                                        </span>
                                                    </Button>
                                                </div>
                                            </div>
                                        </section>
                                    ))}
                                </div>
                            )}
                        </section>
                    </CardContent>
                </Card>

                <aside className="space-y-6 self-start xl:sticky xl:top-6">
                    <Card className="overflow-hidden shadow-sm">
                        <CardHeader className="space-y-1 border-b bg-muted/20 px-6 py-5">
                            <CardTitle id="commission-memberships-heading" className="text-lg">
                                {t('salesAgentCommissions.fieldAgentMemberships')}
                            </CardTitle>
                            <CardDescription>{t('salesAgentCommissions.membershipDescription')}</CardDescription>
                        </CardHeader>
                        <CardContent className="p-0">
                            <section aria-labelledby="commission-memberships-heading">
                                {fieldAgents.length === 0 ? (
                                    <div className="p-6 text-center text-sm text-muted-foreground">{t('salesAgentCommissions.noFieldAgents')}</div>
                                ) : (
                                    <div className="divide-y">
                                        {fieldAgents.map((entry) => (
                                            <div key={entry.agent.id} className="space-y-3 p-5">
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="truncate font-semibold">{entry.name}</span>
                                                        <Badge variant="outline" className={entry.agent.status === 'active' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}>
                                                            {entry.agent.status === 'active' ? t('salesAgentCommissions.active') : t('salesAgentCommissions.inactive')}
                                                        </Badge>
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">{entry.agent.zone}</div>
                                                </div>
                                                <Select
                                                    value={membershipSelections[entry.agent.id] || NO_PLAN_VALUE}
                                                    onValueChange={(planId) =>
                                                        setMembershipSelections((current) => ({
                                                            ...current,
                                                            [entry.agent.id]: planId
                                                        }))
                                                    }
                                                    disabled={isSaving}
                                                >
                                                    <SelectTrigger>
                                                        <SelectValue placeholder={t('salesAgentCommissions.noCommissionPlan')} />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value={NO_PLAN_VALUE}>{t('salesAgentCommissions.noCommissionPlan')}</SelectItem>
                                                        {planDrafts.map((draft) => (
                                                            <SelectItem key={draft.level} value={planToken(draft)} disabled={!draft.isActive}>
                                                                {draft.name || t('salesAgentCommissions.unnamedCommissionLevel')} · {commissionPlanDraftSummary(draft)}{commissionSheetType === 'tier_based' ? ` · ${t('salesAgentCommissions.tier')}: ${draft.tierName || '—'}` : ''}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </section>
                        </CardContent>
                    </Card>

                    <div className="space-y-3">
                        <div className="flex gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 text-sm">
                            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-300" />
                            <div>
                                <div className="font-semibold">{t('salesAgentCommissions.workspaceOnly')}</div>
                                <p className="mt-1 text-muted-foreground">{t('salesAgentCommissions.workspaceOnlyDescription')}</p>
                            </div>
                        </div>
                        <div className="flex gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/[0.06] p-4 text-sm">
                            <Truck className="mt-0.5 h-5 w-5 shrink-0 text-sky-700 dark:text-sky-300" />
                            <div>
                                <div className="font-semibold">{t('salesAgentCommissions.postServiceIsOptional')}</div>
                                <p className="mt-1 text-muted-foreground">{t('salesAgentCommissions.postServiceSettingsDescription')}</p>
                            </div>
                        </div>
                    </div>

                    <Card className="shadow-sm">
                        <CardHeader className="space-y-1 px-6 py-5">
                            <CardTitle className="text-lg">
                                {t('common.actions', {
                                    defaultValue: 'Actions'
                                })}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 px-6 pb-6">
                            <Button type="submit" className="h-12 w-full rounded-xl font-bold" disabled={isSaving}>
                                {isSaving ? t('salesAgentCommissions.saving') : t('salesAgentCommissions.saveSettings')}
                            </Button>
                            {onCancel ? (
                                <Button type="button" variant="outline" className="h-12 w-full rounded-xl" onClick={onCancel} disabled={isSaving}>
                                    {t('salesAgentCommissions.cancel')}
                                </Button>
                            ) : null}
                        </CardContent>
                    </Card>
                </aside>
            </div>
        </form>
        <AppDialog
            open={Boolean(planToManageAgents)}
            onOpenChange={(open) => {
                if (!open && !isSaving) setPlanToManageAgents(null)
            }}
        >
            <AppDialogContent className="max-w-2xl">
                <AppDialogHeader>
                    <div className="flex items-start gap-3">
                        <div className="rounded-xl bg-violet-500/10 p-2 text-violet-700 dark:text-violet-300">
                            <UsersRound className="h-5 w-5" />
                        </div>
                        <div className="space-y-1">
                            <AppDialogTitle>
                                {t('salesAgentCommissions.manageAgentsTitle', {
                                    level: planToManageAgents?.name.trim() || t('salesAgentCommissions.newCommissionLevel')
                                })}
                            </AppDialogTitle>
                            <AppDialogDescription>{t('salesAgentCommissions.manageAgentsDescription')}</AppDialogDescription>
                        </div>
                    </div>
                </AppDialogHeader>
                <AppDialogBody className="space-y-4">
                    {planToManageAgents ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-violet-500/20 bg-violet-500/[0.05] p-4">
                            <div>
                                <div className="text-xs font-medium text-muted-foreground">{t('salesAgentCommissions.commissionLevel')}</div>
                                <div className="mt-1 font-semibold">{planToManageAgents.name.trim() || t('salesAgentCommissions.newCommissionLevel')}</div>
                            </div>
                            <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                                {t('salesAgentCommissions.managedAgentsCount', { count: managedAgentIds.length })}
                            </Badge>
                        </div>
                    ) : null}
                    {fieldAgents.length === 0 ? (
                        <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                            {t('salesAgentCommissions.noFieldAgents')}
                        </div>
                    ) : (
                        <div className="divide-y overflow-hidden rounded-2xl border">
                            {fieldAgents.map((entry) => {
                                const isManaged = managedAgentIds.includes(entry.agent.id)
                                return (
                                    <div key={entry.agent.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-semibold">{entry.name}</span>
                                                <Badge variant="outline" className={entry.agent.status === 'active' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}>
                                                    {entry.agent.status === 'active' ? t('salesAgentCommissions.active') : t('salesAgentCommissions.inactive')}
                                                </Badge>
                                                {isManaged ? (
                                                    <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                                                        {t('salesAgentCommissions.assignedToLevel')}
                                                    </Badge>
                                                ) : null}
                                            </div>
                                            <div className="mt-1 text-xs text-muted-foreground">{entry.agent.zone}</div>
                                        </div>
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant={isManaged ? 'outline' : 'default'}
                                            className="gap-1.5"
                                            onClick={() => toggleManagedAgent(entry.agent.id)}
                                            disabled={isSaving}
                                        >
                                            {isManaged ? <UserMinus className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                                            {isManaged ? t('salesAgentCommissions.removeAgentFromLevel') : t('salesAgentCommissions.addAgentToLevel')}
                                        </Button>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </AppDialogBody>
                <AppDialogFooter>
                    <Button type="button" variant="outline" onClick={() => setPlanToManageAgents(null)} disabled={isSaving}>
                        {t('salesAgentCommissions.cancel')}
                    </Button>
                    <Button type="button" onClick={applyManagedAgents} disabled={isSaving}>
                        {t('common.done', { defaultValue: 'Done' })}
                    </Button>
                </AppDialogFooter>
            </AppDialogContent>
        </AppDialog>
        <DeleteConfirmationModal
            isOpen={Boolean(planToDelete)}
            onClose={() => {
                if (!isDeletingPlan) setPlanToDelete(null)
            }}
            onConfirm={() => {
                void handleDeletePlan()
            }}
            isLoading={isDeletingPlan}
            itemName={planToDelete?.name || ''}
            title={t('salesAgentCommissions.deleteCommissionLevelTitle')}
            description={t('salesAgentCommissions.deleteCommissionLevelDescription')}
        />
        </>
    )
}
