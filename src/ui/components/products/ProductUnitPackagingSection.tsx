import { ArrowRight, Boxes, GitBranch, PackageOpen } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { CurrencyCode, IQDDisplayPreference, Unit, UnitRelationship } from '@/local-db'
import { getUnitDescriptors } from '@/lib/unitRelationships'
import { formatCurrency, formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import { Input } from '@/ui/components/input'
import { Label } from '@/ui/components/label'
import type { ProductUnitPackagingDraft } from './productUnitPackaging'

export function ProductUnitPackagingSection({
  relationship,
  units,
  draft,
  childPrice,
  currency,
  iqdDisplayPreference,
  disabled,
  onChange,
}: {
  relationship: UnitRelationship
  units: Unit[]
  draft: ProductUnitPackagingDraft
  childPrice: string
  currency: CurrencyCode
  iqdDisplayPreference: IQDDisplayPreference
  disabled?: boolean
  onChange: (draft: ProductUnitPackagingDraft) => void
}) {
  const { t } = useTranslation()
  const descriptors = useMemo(() => getUnitDescriptors(units), [units])
  const child = descriptors.find((unit) => unit.ref === relationship.childUnitRef)
  const factor = Number(draft.factor)
  const parentPrice = draft.parentPrice.trim() === '' ? Number.NaN : Number(draft.parentPrice)
  const childPriceValue = childPrice.trim() === '' ? Number.NaN : Number(childPrice)

  return (
    <section className="space-y-4 border-t border-border/60 pt-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-primary/80">
          <GitBranch className="h-4 w-4" />
          {t('products.packaging.title')}
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('products.packaging.description')}</p>
      </div>

      <div className="space-y-2">
        <Label>{t('products.packaging.relationship')}</Label>
        <div className="flex min-h-11 items-center gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-2 font-semibold">
          <GitBranch className="h-4 w-4 shrink-0 text-primary" />
          <span>{t(`products.units.${relationship.parentUnitCode}`, { defaultValue: relationship.parentUnitCode })}</span>
          <ArrowRight className="h-4 w-4 shrink-0 text-primary rtl:rotate-180" />
          <span>{t(`products.units.${relationship.childUnitCode}`, { defaultValue: relationship.childUnitCode })}</span>
        </div>
      </div>

      <div className="space-y-5 rounded-2xl border border-primary/15 bg-primary/[0.03] p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="product-unit-factor" className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-primary/60" />
                {t('products.packaging.factor')} *
              </Label>
              <Input
                id="product-unit-factor"
                type="text"
                inputMode="decimal"
                value={formatNumericInput(draft.factor)}
                onChange={(event) => onChange({ ...draft, factor: sanitizeNumericInput(event.target.value, { maxFractionDigits: child?.isDynamic ? 6 : 0 }) })}
                placeholder="0"
                readOnly={disabled}
                required
              />
              <p className="text-xs text-muted-foreground">
                {t('products.packaging.factorExample', {
                  parent: t(`products.units.${relationship.parentUnitCode}`, { defaultValue: relationship.parentUnitCode }),
                  child: t(`products.units.${relationship.childUnitCode}`, { defaultValue: relationship.childUnitCode }),
                  quantity: Number.isFinite(factor) && factor > 0 ? formatNumericInput(draft.factor) : '—',
                })}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="product-parent-unit-price" className="flex items-center gap-2">
                <PackageOpen className="h-4 w-4 text-primary/60" />
                {t('products.packaging.parentPrice', {
                  unit: t(`products.units.${relationship.parentUnitCode}`, { defaultValue: relationship.parentUnitCode }),
                })} *
              </Label>
              <Input
                id="product-parent-unit-price"
                type="text"
                inputMode="decimal"
                value={formatNumericInput(draft.parentPrice)}
                onChange={(event) => onChange({ ...draft, parentPrice: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 }) })}
                placeholder="0"
                readOnly={disabled}
                required
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <div className="rounded-xl border bg-background p-3 text-center">
              <div className="text-xs text-muted-foreground">{t(`products.units.${relationship.parentUnitCode}`, { defaultValue: relationship.parentUnitCode })}</div>
              <div className="mt-1 font-black">{Number.isFinite(parentPrice) ? formatCurrency(parentPrice, currency, iqdDisplayPreference) : '—'}</div>
            </div>
            <ArrowRight className="mx-auto h-5 w-5 text-primary rtl:rotate-180" />
            <div className="rounded-xl border bg-background p-3 text-center">
              <div className="text-xs text-muted-foreground">{t(`products.units.${relationship.childUnitCode}`, { defaultValue: relationship.childUnitCode })}</div>
              <div className="mt-1 font-black">{Number.isFinite(childPriceValue) ? formatCurrency(childPriceValue, currency, iqdDisplayPreference) : '—'}</div>
            </div>
          </div>
          <p className="text-xs font-medium text-muted-foreground">{t('products.packaging.independentPrices')}</p>
      </div>
    </section>
  )
}
