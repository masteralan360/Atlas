import { BadgePercent, Coins, Plus, Trash2, UsersRound } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { CommissionPlanType, CurrencyCode, IQDDisplayPreference, ProductCommissionRecipientScope } from '@/local-db'
import { cn, formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import { Input } from '@/ui/components/input'
import {
  Button,
  CurrencySelector,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@/ui/components'
import { useCommissionAgentDirectory } from './useCommissionAgentDirectory'

export type ProductCommissionRuleDraft = {
    enabled: boolean
    commissionType: CommissionPlanType
    amount: string
    currency: CurrencyCode
    recipientScope: ProductCommissionRecipientScope
    agentIds: string[]
}

export function emptyProductCommissionRuleDraft(currency: CurrencyCode): ProductCommissionRuleDraft {
    return {
        enabled: false,
        commissionType: 'fixed_amount',
        amount: '',
        currency,
        recipientScope: 'all_assigned',
        agentIds: []
    }
}

export function ProductCommissionRuleEditor({
    workspaceId,
    draft,
    onChange,
    iqdDisplayPreference,
    validationMessage,
    disabled = false
}: {
    workspaceId: string
    draft: ProductCommissionRuleDraft
    onChange: (draft: ProductCommissionRuleDraft) => void
    iqdDisplayPreference: IQDDisplayPreference
    validationMessage?: string | null
    disabled?: boolean
}) {
    const { t } = useTranslation()
    const directory = useCommissionAgentDirectory(workspaceId)
    const selectedIds = new Set(draft.agentIds)
    const availableAgents = useMemo(() => directory.eligibleAgents.filter((entry) => !selectedIds.has(entry.agent.id)), [directory.eligibleAgents, selectedIds])
    const set = (changes: Partial<ProductCommissionRuleDraft>) => onChange({ ...draft, ...changes })
    const addAgent = () => {
        const next = availableAgents[0]
        if (next) set({ agentIds: [...draft.agentIds, next.agent.id] })
    }

    return (
        <section className="space-y-4 border-t border-border/60 pt-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-violet-600 dark:text-violet-300">
                        <Coins className="h-4 w-4" />
                        {t('salesAgentCommissions.productCommission.title')}
                    </div>
                    <p className="max-w-2xl text-sm text-muted-foreground">
                        {t('salesAgentCommissions.productCommission.description')}
                    </p>
                </div>
                <div className="flex items-center gap-3 rounded-xl border bg-background/70 px-3 py-2">
                    <Label htmlFor="product-commission-enabled" className="text-sm font-semibold">
                        {t('salesAgentCommissions.productCommission.enable')}
                    </Label>
                    <Switch
                        id="product-commission-enabled"
                        checked={draft.enabled}
                        onCheckedChange={(enabled) => set({ enabled })}
                        disabled={disabled}
                    />
                </div>
            </div>

            {!draft.enabled ? (
                <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('salesAgentCommissions.productCommission.empty')}
                </div>
            ) : (
                <div className="space-y-5 rounded-2xl border border-violet-500/25 bg-violet-500/[0.035] p-4 sm:p-5">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label>{t('salesAgentCommissions.productCommission.type')}</Label>
                            <Select
                                value={draft.commissionType}
                                onValueChange={(value) => set({ commissionType: value as CommissionPlanType, amount: '' })}
                                disabled={disabled}
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="fixed_amount">{t('salesAgentCommissions.fixedAmount')}</SelectItem>
                                    <SelectItem value="percentage">{t('salesAgentCommissions.percentage')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="product-commission-amount">
                                {draft.commissionType === 'percentage'
                                    ? t('salesAgentCommissions.productCommission.percentage')
                                    : t('salesAgentCommissions.productCommission.amount')}
                            </Label>
                            <div className={cn('grid gap-2', draft.commissionType === 'fixed_amount' && 'sm:grid-cols-[1fr_150px]')}>
                                <Input
                                    id="product-commission-amount"
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="0"
                                    value={formatNumericInput(draft.amount)}
                                    onChange={(event) => set({ amount: sanitizeNumericInput(event.target.value, { maxFractionDigits: 6 }) })}
                                    disabled={disabled}
                                    aria-invalid={Boolean(validationMessage)}
                                    className={validationMessage ? 'border-destructive focus-visible:ring-destructive/30' : undefined}
                                />
                                {draft.commissionType === 'fixed_amount' ? (
                                    <CurrencySelector
                                        value={draft.currency}
                                        onChange={(currency) => set({ currency })}
                                        iqdDisplayPreference={iqdDisplayPreference}
                                        disabled={disabled}
                                    />
                                ) : null}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-3 rounded-2xl border bg-background/70 p-4">
                        <div className="flex items-start gap-2">
                            <UsersRound className="mt-0.5 h-4 w-4 text-violet-600" />
                            <div>
                                <Label>{t('salesAgentCommissions.productCommission.recipients')}</Label>
                                <p className="mt-1 text-xs text-muted-foreground">{t('salesAgentCommissions.productCommission.recipientsHint')}</p>
                            </div>
                        </div>
                        <Select
                            value={draft.recipientScope}
                            onValueChange={(value) => set({ recipientScope: value as ProductCommissionRecipientScope, agentIds: value === 'all_assigned' ? [] : draft.agentIds })}
                            disabled={disabled}
                        >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all_assigned">{t('salesAgentCommissions.productCommission.allAssigned')}</SelectItem>
                                <SelectItem value="selected_assigned">{t('salesAgentCommissions.productCommission.selectedAssigned')}</SelectItem>
                            </SelectContent>
                        </Select>
                        {draft.recipientScope === 'selected_assigned' ? (
                            <div className="space-y-2">
                                {draft.agentIds.map((agentId) => {
                                    const agent = directory.agentById.get(agentId)
                                    const choices = directory.eligibleAgents.filter((candidate) => candidate.agent.id === agentId || !selectedIds.has(candidate.agent.id))
                                    return (
                                        <div key={agentId} className="grid grid-cols-[1fr_auto] gap-2">
                                            <Select value={agentId} onValueChange={(nextId) => set({ agentIds: draft.agentIds.map((value) => value === agentId ? nextId : value) })} disabled={disabled}>
                                                <SelectTrigger><SelectValue>{agent?.name}</SelectValue></SelectTrigger>
                                                <SelectContent>{choices.map((candidate) => <SelectItem key={candidate.agent.id} value={candidate.agent.id}>{candidate.name}</SelectItem>)}</SelectContent>
                                            </Select>
                                            <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => set({ agentIds: draft.agentIds.filter((value) => value !== agentId) })} disabled={disabled}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    )
                                })}
                                <Button type="button" variant="outline" className="w-full gap-2" onClick={addAgent} disabled={disabled || availableAgents.length === 0}>
                                    <Plus className="h-4 w-4" /> {t('salesAgentCommissions.productCommission.addAgent')}
                                </Button>
                            </div>
                        ) : null}
                    </div>
                    <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                        <BadgePercent className="h-4 w-4 shrink-0" />
                        {t('salesAgentCommissions.productCommission.replacementHint')}
                    </div>
                    {validationMessage ? (
                        <p className="text-sm font-medium text-destructive">{validationMessage}</p>
                    ) : null}
                </div>
            )}
        </section>
    )
}
