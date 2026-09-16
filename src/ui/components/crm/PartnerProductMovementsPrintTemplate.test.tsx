import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getProductMovementPrintRows } from '@/lib/partnerProductMovementsPresentation'
import { PartnerProductMovementsPrintTemplate, type PartnerProductMovementsPrintData } from './PartnerProductMovementsPrintTemplate'
import i18n from '@/i18n/config'
import { PartnerProductMovementsTable } from './PartnerProductMovementsTable'
vi.stubGlobal('localStorage', { getItem: () => null })
vi.mock('@/services/platformService', () => ({ platformService: { convertFileSrc: (src: string) => src } }))
const data: PartnerProductMovementsPrintData = {
  statement: { entries: [{ id: 'sale', date: '2026-09-10T10:00:00Z', productId: 'a', item: 'Product A', unit: 'Box', quantity: 5, direction: 'sold',
    kind: 'sale', note: null, currency: 'usd', commissionPerProduct: 2, totalProductCommission: 10,
    references: Array.from({ length: 60 }, (_, i) => ({ label: `SO-2026-${String(i).padStart(4, '0')}`, path: `/orders/${i}` })) }],
    quantityTotals: [{ direction: 'sold', unit: 'Box', quantity: 5 }], commissionTotals: [{ currency: 'usd', amount: 10 }], hasCommission: true, undatedCount: 0 },
  period: { type: 'allTime' }, partner: { partnerName: 'Partner' }, generatedAt: '2026-09-10T10:00:00Z'
}
describe('product movement A4 tables', () => {
  it.each(['en', 'ar', 'ku'])('labels bonus commissions as free in on-screen and printed rows (%s)', language => {
    const paid = { ...data.statement.entries[0], references: [] }
    const statement = { ...data.statement, entries: [paid,
      { ...paid, id: 'bonus', kind: 'bonus' as const, quantity: 2, commissionPerProduct: null, totalProductCommission: null },
      { ...paid, id: 'ordinary', quantity: 1, commissionPerProduct: null, totalProductCommission: null },
    ], quantityTotals: [{ direction: 'sold' as const, unit: 'Box', quantity: 8 }] }
    const label = i18n.getFixedT(language)('businessPartners.productMovements.freeCommissionNotCounted')
    expect(label).not.toContain('businessPartners.')
    if (language === 'en') expect(label).toBe('Free (Not Counted)')
    const outputs = [
      renderToStaticMarkup(<PartnerProductMovementsTable statement={statement} columns={['item', 'quantity', 'commissionPerProduct', 'totalProductCommission']} language={language} />),
      renderToStaticMarkup(<PartnerProductMovementsPrintTemplate printLang={language} data={{ ...data, statement }} />),
    ]
    for (const html of outputs) {
      const body = html.split('<tbody>')[1].split('</tbody>')[0]
      const rows = body.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)!
      expect(rows).toHaveLength(3)
      expect(rows[0]).not.toContain(label)
      expect(rows[1].split(label)).toHaveLength(3)
      expect(rows[2]).not.toContain(label)
      expect(rows[2].match(/>—<\/td>/g)).toHaveLength(2)
      expect(statement.entries[1]).toMatchObject({ commissionPerProduct: null, totalProductCommission: null })
      expect(statement.commissionTotals).toEqual([{ currency: 'usd', amount: 10 }])
    }
  })
  it('keeps accumulated products in one row and summarizes reference overflow', () => {
    const rows = getProductMovementPrintRows(data.statement.entries)
    expect(rows).toHaveLength(1)
    expect(rows.flatMap(row => row.references)).toHaveLength(60)
    const html = renderToStaticMarkup(<PartnerProductMovementsPrintTemplate printLang="en" data={data} />)
    expect(html.match(/data-pdf-page-chunk/g)).toHaveLength(1)
    expect(html).toContain('data-order-items-paginated')
    expect(html).not.toContain('data-centered-table')
    expect(html.match(/<thead>/g)).toHaveLength(1)
    expect(html.match(/<tfoot>/g)).toHaveLength(1)
    expect(html.match(/<tbody><tr /g)).toHaveLength(1)
    expect(html).toContain('+57 More')
    expect(html).not.toContain('(continued)')
    expect(html).toContain('5 box')
    expect(html).toContain('SO-2026-0059')
    expect(html.slice(html.indexOf('<tfoot>'))).toContain(i18n.getFixedT('en')('businessPartners.productMovements.footerNote'))
  })
  it('keeps a single row per product when references are hidden', () => {
    expect(getProductMovementPrintRows(data.statement.entries, false)).toHaveLength(1)
    expect(getProductMovementPrintRows(data.statement.entries, false)[0].references).toEqual([])
    expect(getProductMovementPrintRows([])).toEqual([])
    const html = renderToStaticMarkup(<PartnerProductMovementsPrintTemplate printLang="en" data={{ ...data, statement: { ...data.statement, entries: [] } }} />)
    expect(html.match(/<table /g)).toHaveLength(1)
    expect(html).toContain(i18n.getFixedT('en')('businessPartners.noActivity'))
  })
  it('uses the localized more-reference label without adding rows', () => {
    for (const language of ['ar', 'ku']) {
      const html = renderToStaticMarkup(<PartnerProductMovementsPrintTemplate printLang={language} data={data} />)
      expect(html).toContain(i18n.getFixedT(language)('businessPartners.productMovements.moreReferences', { additionalCount: new Intl.NumberFormat(language).format(57) }))
      expect(html.match(/<tbody><tr /g)).toHaveLength(1)
    }
  })
  it('keeps totals even when quantity and commission columns are hidden', () => {
    const html = renderToStaticMarkup(<PartnerProductMovementsPrintTemplate printLang="ar" data={{ ...data, tableColumns: ['item'] }} />)
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('5 صندوق')
    expect(html).toContain(i18n.getFixedT('ar')('businessPartners.productMovements.sold'))
    expect(html).toContain(i18n.getFixedT('ar')('salesAgentCommissions.productCommission.lineTotal'))
  })
})
