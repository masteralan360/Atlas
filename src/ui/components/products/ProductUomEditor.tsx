import { useMemo, useState } from 'react'
import { Archive, Boxes, Check, PackagePlus, Star, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { CurrencyCode, IQDDisplayPreference } from '@/local-db/models'
import { formatCurrency, formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { ProductUnitIcon } from '@/ui/components/ProductUnitIcon'
import { Button, DeleteConfirmationModal, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/ui/components'

export type ProductUomDraft = {
  unitRef: string
  unitCode: string
  coefficient: string
  sellingPrice: string
  costPrice: string
  minimumSellingPrice: string
  isDefaultSelling: boolean
  isActive: boolean
  sku: string
  barcode: string
}

type UomBaseRow = {
  unitCode: string
  sellingPrice: number
  costPrice: number | null
  minimumSellingPrice: number | null
  currency: CurrencyCode
}

export function createEmptyProductUomDraft(): ProductUomDraft {
  return {
    unitRef: '',
    unitCode: '',
    coefficient: '',
    sellingPrice: '',
    costPrice: '',
    minimumSellingPrice: '',
    isDefaultSelling: false,
    isActive: true,
    sku: '',
    barcode: '',
  }
}

export function ProductUomEditor({
  base,
  rows,
  units,
  currency,
  iqdDisplayPreference,
  disabled,
  hideCosts,
  hideMinimumPrice,
  allowRemovingUnits,
  defaultSku,
  defaultBarcode,
  onChange,
  onAdd,
}: {
  base: UomBaseRow
  rows: ProductUomDraft[]
  units: Array<{ value: string; isDynamic: boolean; icon: string | null; ref: string }>
  currency: CurrencyCode
  iqdDisplayPreference: IQDDisplayPreference
  disabled?: boolean
  hideCosts?: boolean
  hideMinimumPrice?: boolean
  allowRemovingUnits?: boolean
  defaultSku: string
  defaultBarcode?: string
  onChange: (rows: ProductUomDraft[]) => void
  onAdd: () => void
}) {
  const { t } = useTranslation()
  const [removeIndex, setRemoveIndex] = useState<number | null>(null)
  const usedCodes = useMemo(() => new Set([
    base.unitCode,
    ...rows.map((row) => row.unitCode),
  ].filter(Boolean).map((code) => code.trim().toLocaleLowerCase())), [base.unitCode, rows])

  const update = (index: number, changes: Partial<ProductUomDraft>) => {
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row))
  }
  const setDefault = (index: number) => {
    onChange(rows.map((row, rowIndex) => ({ ...row, isDefaultSelling: rowIndex === index })))
  }
  const name = (code: string) => t(`products.units.${code}`, { defaultValue: code })
  const money = (value: number | null) => value == null ? '—' : formatCurrency(value, currency, iqdDisplayPreference)
  const baseIsDefault = !rows.some((row) => row.isActive && row.isDefaultSelling)
  const columnCount = 7 + (hideCosts ? 0 : 1) + (hideMinimumPrice ? 0 : 1)
  const rowToRemove = removeIndex === null ? null : rows[removeIndex] ?? null

  const confirmRemove = () => {
    if (removeIndex === null) return
    onChange(rows.filter((_, index) => index !== removeIndex))
    setRemoveIndex(null)
  }

  return (
    <section className="space-y-4 border-t border-border/60 pt-6" aria-labelledby="product-uom-heading">
      <div className="space-y-1">
        <h2 id="product-uom-heading" className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-primary/80">
          <Boxes className="h-4 w-4" />
          {t('products.uom.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('products.uom.description')}</p>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-border/80 bg-card shadow-sm">
        <table className="w-full min-w-[1040px] border-collapse text-sm">
          <thead className="bg-muted/70 text-start text-xs font-extrabold uppercase tracking-wider text-foreground">
            <tr>
              <th className="border-b border-border/80 px-3 py-3 text-start">{t('products.uom.unit')} *</th>
              <th className="border-b border-border/80 px-3 py-3 text-end">{t('products.uom.coefficient')} *</th>
              <th className="border-b border-border/80 px-3 py-3 text-end">{t('products.uom.sellingPrice')} *</th>
              {!hideCosts ? <th className="border-b border-border/80 px-3 py-3 text-end">{t('products.form.cost')}</th> : null}
              {!hideMinimumPrice ? <th className="border-b border-border/80 px-3 py-3 text-end">{t('products.uom.minimumSellingPrice')}</th> : null}
              <th className="border-b border-border/80 px-3 py-3 text-start">{t('products.form.sku', { defaultValue: 'SKU' })}</th>
              <th className="border-b border-border/80 px-3 py-3 text-start">{t('products.uom.barcode')}</th>
              <th className="border-b border-border/80 px-3 py-3 text-center">{t('products.uom.default')}</th>
              <th className="border-b border-border/80 px-3 py-3 text-center">{t('common.status', { defaultValue: 'Status' })}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            <tr className="bg-primary/[0.045]">
              <td className="px-3 py-3">
                <div className="flex items-center gap-2 font-bold"><Check className="h-4 w-4 text-primary" />{name(base.unitCode)}</div>
                <div className="mt-0.5 text-[11px] font-bold uppercase text-primary">{t('products.uom.baseUnit')}</div>
              </td>
              <td className="px-3 py-3 text-end font-mono font-bold">1</td>
              <td className="px-3 py-3 text-end font-bold">{money(base.sellingPrice)}</td>
              {!hideCosts ? <td className="px-3 py-3 text-end">{money(base.costPrice)}</td> : null}
              {!hideMinimumPrice ? <td className="px-3 py-3 text-end">{money(base.minimumSellingPrice)}</td> : null}
              <td className="px-3 py-3">{defaultSku || '—'}</td>
              <td className="px-3 py-3">{defaultBarcode || '—'}</td>
              <td className="px-3 py-3 text-center"><Button type="button" variant={baseIsDefault ? 'secondary' : 'ghost'} size="sm"
                className="h-auto min-h-8 whitespace-nowrap px-2 text-xs" disabled={disabled || baseIsDefault}
                onClick={() => onChange(rows.map((row) => ({ ...row, isDefaultSelling: false })))}>
                <Star className={cn('me-1 h-3.5 w-3.5', baseIsDefault && 'fill-current')} />
                {baseIsDefault ? t('products.uom.baseDefault') : t('products.uom.setBaseDefault')}
              </Button></td>
              <td className="px-3 py-3 text-center"><span className="text-xs font-semibold text-emerald-700">{t('products.uom.active')}</span></td>
            </tr>
            {rows.map((row, index) => {
              const coefficient = Number(row.coefficient)
              const costPrice = row.costPrice.trim() === '' ? null : Number(row.costPrice)
              const minPrice = row.minimumSellingPrice.trim() === '' ? null : Number(row.minimumSellingPrice)
              const effectiveCost = costPrice ?? (base.costPrice == null || !Number.isFinite(coefficient) ? null : base.costPrice * coefficient)
              const effectiveMinimum = minPrice ?? (base.minimumSellingPrice == null || !Number.isFinite(coefficient) ? null : base.minimumSellingPrice * coefficient)
              const selectedUnit = units.find((unit) => unit.ref === row.unitRef)
              const selectedUnitCode = selectedUnit?.value ?? row.unitCode
              return (
                <tr key={`${row.unitRef}:${index}`} className={cn('transition-colors hover:bg-muted/30', !row.isActive && 'bg-muted/30 text-muted-foreground')}>
                  <td className="min-w-48 px-3 py-2">
                    <Label className="sr-only" htmlFor={`product-uom-unit-${index}`}>{t('products.uom.unit')} *</Label>
                    <div className="flex items-center gap-1.5">
                      <Select value={row.unitRef} onValueChange={(ref) => {
                        const unit = units.find((option) => option.ref === ref)
                        if (unit) update(index, { unitRef: unit.ref, unitCode: unit.value })
                      }} disabled={disabled}>
                        <SelectTrigger id={`product-uom-unit-${index}`} className="h-10 min-w-0 flex-1">
                          <SelectValue placeholder={t('units.selectPlaceholder')}>
                            {selectedUnitCode ? (
                              <span className="flex min-w-0 items-center gap-2">
                                <ProductUnitIcon unit={selectedUnitCode} iconName={selectedUnit?.icon} className="h-4 w-4 shrink-0 text-primary/70" />
                                <span className="truncate">{name(selectedUnitCode)}</span>
                              </span>
                            ) : null}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>{units.filter((unit) => unit.ref === row.unitRef || !usedCodes.has(unit.value.trim().toLocaleLowerCase())).map((unit) => (
                          <SelectItem key={unit.ref} value={unit.ref}>
                            <span className="flex items-center gap-2">
                              <ProductUnitIcon unit={unit.value} iconName={unit.icon} className="h-4 w-4 shrink-0 text-primary/70" />
                              {name(unit.value)}
                            </span>
                          </SelectItem>
                        ))}</SelectContent>
                      </Select>
                      {allowRemovingUnits ? (
                        <Button type="button" size="icon" variant="ghost"
                          className="h-9 w-9 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          aria-label={t('products.uom.removeUnit')}
                          title={t('products.uom.removeUnit')}
                          disabled={disabled}
                          onClick={() => setRemoveIndex(index)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  </td>
                  <td className="min-w-32 px-3 py-2 text-end">
                    <Label className="sr-only" htmlFor={`product-uom-coefficient-${index}`}>{t('products.uom.coefficient')} *</Label>
                    <Input id={`product-uom-coefficient-${index}`} inputMode="decimal" value={formatNumericInput(row.coefficient)}
                      onChange={(event) => update(index, { coefficient: sanitizeNumericInput(event.target.value, { maxFractionDigits: 6 }) })}
                      placeholder="0" disabled={disabled || !row.isActive} className="text-end" />
                    <p className="mt-1 text-[11px] text-muted-foreground">{selectedUnitCode && Number.isFinite(coefficient) && coefficient > 0
                      ? t('products.uom.conversionExample', { count: coefficient, selectedUnit: name(selectedUnitCode), unit: name(base.unitCode) })
                      : t('products.uom.coefficientHint')}</p>
                  </td>
                  <td className="min-w-36 px-3 py-2 text-end">
                    <Label className="sr-only" htmlFor={`product-uom-price-${index}`}>{t('products.uom.sellingPrice')} *</Label>
                    <Input id={`product-uom-price-${index}`} inputMode="decimal" value={formatNumericInput(row.sellingPrice)}
                      onChange={(event) => update(index, { sellingPrice: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 }) })}
                      placeholder="0" disabled={disabled || !row.isActive} className="text-end" />
                  </td>
                  {!hideCosts ? <td className="min-w-36 px-3 py-2 text-end">
                    <Label className="sr-only" htmlFor={`product-uom-cost-${index}`}>{t('products.form.cost')}</Label>
                    <Input id={`product-uom-cost-${index}`} inputMode="decimal" value={formatNumericInput(row.costPrice)}
                      onChange={(event) => update(index, { costPrice: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 }) })}
                      placeholder="0" disabled={disabled || !row.isActive} className="text-end" />
                    <p className="mt-1 text-[11px] text-muted-foreground">{row.costPrice.trim() ? t('products.uom.manual') : t('products.uom.derivedFromBase', { value: money(effectiveCost) })}</p>
                  </td> : null}
                  {!hideMinimumPrice ? <td className="min-w-36 px-3 py-2 text-end">
                    <Label className="sr-only" htmlFor={`product-uom-minimum-${index}`}>{t('products.uom.minimumSellingPrice')}</Label>
                    <Input id={`product-uom-minimum-${index}`} inputMode="decimal" value={formatNumericInput(row.minimumSellingPrice)}
                      onChange={(event) => update(index, { minimumSellingPrice: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 }) })}
                      placeholder="0" disabled={disabled || !row.isActive} className="text-end" />
                    <p className="mt-1 text-[11px] text-muted-foreground">{row.minimumSellingPrice.trim() ? t('products.uom.manual') : t('products.uom.derivedFromBase', { value: money(effectiveMinimum) })}</p>
                  </td> : null}
                  <td className="min-w-32 px-3 py-2"><Label className="sr-only" htmlFor={`product-uom-sku-${index}`}>{t('products.form.sku', { defaultValue: 'SKU' })}</Label><Input id={`product-uom-sku-${index}`} value={row.sku} onChange={(event) => update(index, { sku: event.target.value })} placeholder="—" disabled={disabled || !row.isActive} /></td>
                  <td className="min-w-32 px-3 py-2"><Label className="sr-only" htmlFor={`product-uom-barcode-${index}`}>{t('products.uom.barcode')}</Label><Input id={`product-uom-barcode-${index}`} value={row.barcode} onChange={(event) => update(index, { barcode: event.target.value })} placeholder="—" disabled={disabled || !row.isActive} /></td>
                  <td className="px-3 py-2 text-center"><Button type="button" size="icon" variant={row.isDefaultSelling ? 'secondary' : 'ghost'} aria-label={t('products.uom.setDefault')}
                    disabled={disabled || !row.isActive} onClick={() => setDefault(index)}><Star className={cn('h-4 w-4', row.isDefaultSelling && 'fill-current')} /></Button></td>
                  <td className="px-3 py-2 text-center"><div className="inline-flex items-center gap-2"><Switch checked={row.isActive} disabled={disabled} onCheckedChange={(isActive) => update(index, { isActive, isDefaultSelling: isActive ? row.isDefaultSelling : false })} aria-label={t('products.uom.toggleActive')} />
                    {!row.isActive ? <Archive className="h-4 w-4" /> : null}</div></td>
                </tr>
              )
            })}
            {rows.length === 0 ? <tr><td colSpan={columnCount} className="px-4 py-7 text-center text-sm text-muted-foreground">{t('products.uom.empty')}</td></tr> : null}
            <tr>
              <td colSpan={columnCount} className="p-2">
                <Button type="button" variant="outline"
                  disabled={disabled || units.every((unit) => usedCodes.has(unit.value.trim().toLocaleLowerCase()))}
                  onClick={onAdd}
                  className="h-11 w-full border-dashed border-primary/40 bg-primary/[0.025] text-primary hover:border-primary/60 hover:bg-primary/[0.07]">
                  <PackagePlus className="me-2 h-4 w-4" />
                  {t('products.uom.addUnit')}
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {rows.some((row) => row.isDefaultSelling) ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Star className="h-3.5 w-3.5" />{t('products.uom.defaultHint')}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('products.uom.historyHint')}</p>
      <DeleteConfirmationModal
        isOpen={rowToRemove !== null}
        onClose={() => setRemoveIndex(null)}
        onConfirm={confirmRemove}
        simpleConfirmation
        title={t('products.uom.removeUnitTitle')}
        description={t('products.uom.removeUnitDescription')}
        confirmLabel={t('products.uom.removeUnit')}
        itemName={rowToRemove?.unitCode ? name(rowToRemove.unitCode) : ''}
      />
    </section>
  )
}
