import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/services/pdfGenerator', () => ({ generateTemplatePdf: vi.fn(async () => new Blob(['pdf'], { type: 'application/pdf' })) }))
vi.mock('@/services/platformService', () => ({ platformService: { convertFileSrc: (src: string) => src } }))
vi.mock('@/local-db', () => ({ getOrderBalanceAmount: () => 0, getOrderPaidAmount: () => 0, getOrderPaymentStatus: () => 'unpaid' }))
vi.mock('@/ui/components/SaleReceipt', () => ({ SaleReceiptBase: () => null, SALE_RECEIPT_TEMPLATE_FIELD_KEYS: {}, RECEIPT_MOVABLE_COMPONENT_KEYS: {} }))
vi.mock('@hello-pangea/dnd', () => ({ DragDropContext: () => null, Droppable: () => null, Draggable: () => null }))
// Other registered invoice targets import the application's entire UI barrel.
// The movement print template uses its own real table and does not need those workflows.
vi.mock('@/ui/components', () => new Proxy({}, {
  has: () => true,
  get: (_, key) => key === 'then' ? undefined : key === '__esModule' ? true : () => null
}))
vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  vi.stubGlobal('window', { location: { hash: '' }, addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('document', { dir: 'ltr', visibilityState: 'visible', documentElement: { lang: 'en', dir: 'ltr' } })
})
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { buildCustomTemplateLayoutPdf, createCustomTemplatePreview, getCustomTemplateTarget, PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY } from './customTemplates'
import type { CustomTemplateLayout } from './printPreviewEditorStore'
import { PartnerProductMovementsPrintTemplate } from '@/ui/components/crm/PartnerProductMovementsPrintTemplate'
import { buildWorkspaceNavigation } from '@/ui/navigation/workspaceNavigation'
import type { WorkspaceFeatures } from '@/workspace'
import type { TFunction } from 'i18next'

describe('product movement module integration', () => {
  it('registers its own editable A4 target under the Business Partners plan feature', () => {
    const target = getCustomTemplateTarget(PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY)!
    expect(target).toMatchObject({ workspaceModuleKey: 'crm', printFormat: 'a4', nativeTemplateAvailable: true, page: { widthMm: 210, heightMm: 297 } })
    const preview = createCustomTemplatePreview(target, { printLang: 'ku' })
    expect(preview.createElement({}, 'statement', 'ku').type).toBe(PartnerProductMovementsPrintTemplate)
    expect(preview.fixedPrintLang).toBe('ku')
  })
  it('builds the final PDF using the current edited layout and print language', async () => {
    const target = getCustomTemplateTarget(PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_KEY)!
    const layout: CustomTemplateLayout = { version: 1, label: 'Edited statement', moduleTypeKey: target.moduleTypeKey, nativeTemplateKey: target.nativeTemplateKey,
      page: target.page, fields: {}, fieldOrders: {}, fieldLabelOverrides: {}, annotations: [], images: [], shapes: [],
      texts: [{ id: 'edit', text: 'Current edited footer', x: 10, y: 230, width: 150, rotation: 0 }], updatedAt: '2026-09-16T10:00:00Z' }
    const blob = await buildCustomTemplateLayoutPdf({ target, layout, values: {}, options: { printLang: 'en' }, fieldMode: 'layoutOverrides' })
    expect(blob.type).toBe('application/pdf')
    const exported = vi.mocked(generateTemplatePdf).mock.calls[0][0]
    expect(exported.format).toBe('a4')
    expect(renderToStaticMarkup(exported.element)).toContain('Current edited footer')
  })
  it('shows the sub-tab only with the CRM plan and Business Partners access', () => {
    const contains = (crm: boolean, partners: boolean) => buildWorkspaceNavigation({
      t: ((key: string) => key) as TFunction, role: 'staff', hasFeature: feature => feature === 'crm' && crm,
      hasPermission: permission => permission !== 'businessPartners.access' || partners, features: { allowed_currencies: ['usd'] } as WorkspaceFeatures, isDesktopDevice: true
    }).flatMap(group => group.items).flatMap(item => item.children || []).some(item => item.href === '/business-partners/product-movements-statement')
    expect(contains(true, true)).toBe(true)
    expect(contains(true, false)).toBe(false)
    expect(contains(false, true)).toBe(false)
  })
})
