import { useState } from 'react'
import { Layers3, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type {
  TieredProductCommissionConfiguration,
  TieredProductCommissionRateDraft,
} from '@/local-db/tieredPerformanceCommissions'
import { Badge } from '@/ui/components/ui/badge'
import { Button } from '@/ui/components/button'
import { Input } from '@/ui/components/input'
import { Label } from '@/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components/select'
import { Switch } from '@/ui/components/switch'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'

export type ProductTierCommissionDraft = {
  enabled: boolean
  rates: TieredProductCommissionRateDraft[]
}

export function ProductTierCommissionEditor({
  configuration,
  draft,
  onChange,
  disabled,
  validationMessage,
}: {
  configuration: TieredProductCommissionConfiguration
  draft: ProductTierCommissionDraft
  onChange: (draft: ProductTierCommissionDraft) => void
  disabled: boolean
  validationMessage: string | null
}) {
  const { t } = useTranslation()
  const [rateIndexToRemove, setRateIndexToRemove] = useState<number | null>(null)
  const updateRate = (index: number, changes: Partial<TieredProductCommissionRateDraft>) => onChange({
    ...draft,
    rates: draft.rates.map((rate, rateIndex) => rateIndex === index ? { ...rate, ...changes } : rate),
  })

  return (
    <section className="space-y-4 border-t border-border/60 pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Layers3 className="h-5 w-5" /></span>
          <div>
            <h3 className="font-bold">{t('salesAgentCommissions.tiered.productSectionTitle')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.productSectionDescription')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="product-tier-commission-enabled" className="text-sm font-semibold">{t('salesAgentCommissions.tiered.productEnable')}</Label>
          <Switch id="product-tier-commission-enabled" checked={draft.enabled} onCheckedChange={(enabled) => onChange({ ...draft, enabled })} disabled={disabled} />
        </div>
      </div>

      {draft.enabled ? (
        <div className="space-y-3 rounded-xl border bg-muted/10 p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.productRatesHint')}</p>
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => onChange({ ...draft, rates: [...draft.rates, { programId: '', tierId: '', amountIqd: '' }] })} disabled={disabled || !configuration.programs.length}>
              <Plus className="h-3.5 w-3.5" />{t('salesAgentCommissions.tiered.addProductTierRate')}
            </Button>
          </div>

          {!configuration.programs.length ? <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.productNoPrograms')}</p> : null}

          {draft.rates.map((rate, index) => {
            const program = configuration.programs.find((item) => item.id === rate.programId)
            const tierOptions = program?.tiers ?? []
            const isDuplicate = draft.rates.some((candidate, candidateIndex) => (
              candidateIndex !== index && candidate.programId === rate.programId && candidate.tierId === rate.tierId
              && Boolean(rate.programId && rate.tierId)
            ))
            return (
              <div key={`${rate.programId}-${rate.tierId}-${index}`} className="grid gap-3 rounded-lg border bg-background p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(145px,0.7fr)_auto] sm:items-end">
                <div className="space-y-2">
                  <Label>{t('salesAgentCommissions.tiered.productProgram')} *</Label>
                  <Select value={rate.programId || '__none__'} onValueChange={(value) => updateRate(index, { programId: value === '__none__' ? '' : value, tierId: '' })} disabled={disabled}>
                    <SelectTrigger><SelectValue placeholder={t('salesAgentCommissions.tiered.selectProgram')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" disabled>{t('salesAgentCommissions.tiered.selectProgram')}</SelectItem>
                      {rate.programId && !program ? <SelectItem value={rate.programId} disabled>{t('salesAgentCommissions.tiered.unavailableSavedProgram')}</SelectItem> : null}
                      {configuration.programs.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}{option.isActive ? '' : ` · ${t('salesAgentCommissions.tiered.inactive')}`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t('salesAgentCommissions.tiered.productTier')} *</Label>
                  <Select value={rate.tierId || '__none__'} onValueChange={(value) => updateRate(index, { tierId: value === '__none__' ? '' : value })} disabled={disabled || !program}>
                    <SelectTrigger><SelectValue placeholder={t('salesAgentCommissions.tiered.selectTier')} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" disabled>{t('salesAgentCommissions.tiered.selectTier')}</SelectItem>
                      {rate.tierId && !tierOptions.some((tier) => tier.id === rate.tierId) ? <SelectItem value={rate.tierId} disabled>{t('salesAgentCommissions.tiered.unavailableSavedTier')}</SelectItem> : null}
                      {tierOptions.map((tier, tierIndex) => <SelectItem key={tier.id} value={tier.id}>{tier.name} · {formatTierRange(tier.minimumSales, tierOptions[tierIndex + 1]?.minimumSales)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`product-tier-rate-${index}`}>{t('salesAgentCommissions.tiered.commissionPerUnit')} *</Label>
                  <div className="relative">
                    <Input id={`product-tier-rate-${index}`} inputMode="decimal" value={rate.amountIqd} placeholder="0" onChange={(event) => updateRate(index, { amountIqd: event.target.value.replace(/[^\d.,]/g, '') })} onBlur={() => {
                      const amount = Number(rate.amountIqd.replace(/,/g, ''))
                      if (rate.amountIqd.trim() && Number.isFinite(amount) && amount > 0) updateRate(index, { amountIqd: new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(amount) })
                    }} disabled={disabled} />
                    <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">IQD</span>
                  </div>
                  {isDuplicate ? <p className="text-xs text-destructive">{t('salesAgentCommissions.tiered.duplicateProductTier')}</p> : null}
                </div>
                <Button type="button" size="icon" variant="ghost" aria-label={t('salesAgentCommissions.tiered.removeProductTierRate')} onClick={() => setRateIndexToRemove(index)} disabled={disabled}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            )
          })}
          {validationMessage ? <p role="alert" className="text-sm text-destructive">{validationMessage}</p> : null}
          {draft.rates.length ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">IQD</Badge>{t('salesAgentCommissions.tiered.productCurrencyHint')}</div> : null}
        </div>
      ) : null}
      <DeleteConfirmationModal
        isOpen={rateIndexToRemove !== null}
        onClose={() => { if (!disabled) setRateIndexToRemove(null) }}
        isLoading={disabled}
        onConfirm={() => {
          if (rateIndexToRemove !== null) onChange({ ...draft, rates: draft.rates.filter((_, index) => index !== rateIndexToRemove) })
          setRateIndexToRemove(null)
        }}
        itemName={rateIndexToRemove === null ? '' : [
          configuration.programs.find((program) => program.id === draft.rates[rateIndexToRemove]?.programId)?.name,
          configuration.programs.find((program) => program.id === draft.rates[rateIndexToRemove]?.programId)?.tiers.find((tier) => tier.id === draft.rates[rateIndexToRemove]?.tierId)?.name,
        ].filter(Boolean).join(' · ')}
        simpleConfirmation
        confirmLabel={t('salesAgentCommissions.tiered.removeProductTierRate')}
        title={t('salesAgentCommissions.tiered.confirmRemoveProductTierRate')}
        description={t('salesAgentCommissions.tiered.confirmRemoveProductTierRateDescription')}
      />
    </section>
  )
}

function formatTierRange(minimum: number, nextMinimum: number | undefined) {
  return nextMinimum === undefined
    ? `${minimum.toLocaleString()}+`
    : `${minimum.toLocaleString()}–${Math.max(0, nextMinimum - 1).toLocaleString()}`
}
