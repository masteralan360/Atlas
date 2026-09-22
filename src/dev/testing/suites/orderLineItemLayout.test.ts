import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readOrderForm = (name: 'SalesOrderFormPage' | 'PurchaseOrderFormPage') => readFileSync(
  fileURLToPath(new URL(`../../../ui/components/orders/${name}.tsx`, import.meta.url)),
  'utf8',
)

describe('order line-item responsive layout contract', () => {
  const salesForm = readOrderForm('SalesOrderFormPage')
  const purchaseForm = readOrderForm('PurchaseOrderFormPage')
  const forms = [salesForm, purchaseForm]

  it.each(forms)('uses a shrink-safe grid that adapts before fields can overlap', (source) => {
    expect(source).toContain('sm:grid-cols-2 lg:grid-cols-[repeat(24,minmax(0,1fr))]')
    expect(source).toContain('flex min-w-0 flex-wrap items-center gap-2')
    expect(source).toContain('min-w-20 flex-1 basis-20')
    expect(source).toContain('min-w-28 flex-1 basis-28')
    expect(source).not.toContain('md:grid-cols-[minmax(0,1.4fr)')
  })

  it.each(forms)('keeps summaries and action controls inside the line-item grid', (source) => {
    expect(source).toContain('sm:col-span-2 lg:col-span-2 lg:justify-center')
    expect(source).toContain('sm:col-span-2 lg:col-span-full')
    expect(source).toContain('flex flex-wrap items-center justify-between')
  })

  it.each(forms)('labels ordinary quantities without implying that their fixed unit is selectable', (source) => {
    expect(source).toContain("? t('orders.form.quantityAndUnit', { defaultValue: 'Quantity and unit' })")
    expect(source).toContain(": t('common.quantity', { defaultValue: 'Quantity' })")
  })

  it('keeps purchase batch fields responsive and full-width', () => {
    expect(purchaseForm).toContain('sm:col-span-2 sm:grid-cols-2 lg:col-span-full xl:grid-cols-4')
  })
})
