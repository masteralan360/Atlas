import { describe, expect, it } from 'vitest'
import { createPartnerProductMovementsTemplateConfiguration, DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION, getPartnerProductMovementsVisibleColumns,
  PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS, readPartnerProductMovementsTemplate, serializePartnerProductMovementsTemplate } from './partnerProductMovementsTemplates'

describe('product movement templates', () => {
  it('defaults accumulation off and only shows commission columns for applicable sales', () => {
    expect(DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION.accumulateProducts).toBe(false)
    expect(getPartnerProductMovementsVisibleColumns(DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION, { showProductCommissionColumns: false })).toEqual(['reference', 'description', 'item', 'quantity'])
    expect(getPartnerProductMovementsVisibleColumns(DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION, { showProductCommissionColumns: true })).toEqual(PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS)
  })
  it('round trips accumulation, column visibility and order independently of account templates', () => {
    const configuration = createPartnerProductMovementsTemplateConfiguration({ columnOrder: ['quantity', 'item'], hiddenColumns: ['description'], accumulateProducts: true })
    expect(readPartnerProductMovementsTemplate({ id: 'template', label: 'Products', layout_json: serializePartnerProductMovementsTemplate(configuration) })?.configuration).toEqual(configuration)
    expect(readPartnerProductMovementsTemplate({ id: 'wrong', layout_json: { kind: 'partner-account-statement-template' } })).toBeNull()
  })
  it('repairs corrupt layouts and supplies an audit column if all applicable columns are hidden', () => {
    const config = createPartnerProductMovementsTemplateConfiguration({ hiddenColumns: [...PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS] })
    expect(getPartnerProductMovementsVisibleColumns(config, { showProductCommissionColumns: false })).toEqual(['reference'])
    const commissionsOnly = createPartnerProductMovementsTemplateConfiguration({ hiddenColumns: ['reference', 'description', 'item', 'quantity'] })
    expect(getPartnerProductMovementsVisibleColumns(commissionsOnly, { showProductCommissionColumns: false })).toEqual(['reference'])
  })
})
