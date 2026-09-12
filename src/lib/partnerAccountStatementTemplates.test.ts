import { describe, expect, it } from 'vitest'

import {
  createPartnerAccountStatementTemplateConfiguration,
  DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION,
  getPartnerAccountStatementSummaryLabelColumn,
  getPartnerAccountStatementVisibleColumns,
  normalizePartnerAccountStatementTemplateConfiguration,
  PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS,
  readPartnerAccountStatementTemplate,
  serializePartnerAccountStatementTemplate
} from './partnerAccountStatementTemplates'

describe('Partner Account Statement templates', () => {
  it('keeps the current statement behavior as the built-in default', () => {
    expect(DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION).toMatchObject({
      showOrderItems: false,
      showPosSaleItems: false,
      hiddenColumns: []
    })

    expect(getPartnerAccountStatementVisibleColumns(
      DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION,
      { showItemColumns: false, showProductCommissionColumns: false }
    )).toEqual(['date', 'reference', 'type', 'description', 'debit', 'credit', 'balance'])

    expect(getPartnerAccountStatementVisibleColumns(
      DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION,
      { showItemColumns: true, showProductCommissionColumns: true }
    )).toEqual(PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS)
  })

  it('preserves a saved column order and hides only the requested columns', () => {
    const configuration = createPartnerAccountStatementTemplateConfiguration({
      columnOrder: ['balance', 'description', 'debit'],
      hiddenColumns: ['debit'],
      showOrderItems: true,
      showPosSaleItems: true
    })

    expect(configuration.columnOrder.slice(0, 3)).toEqual(['balance', 'description', 'debit'])
    expect(getPartnerAccountStatementVisibleColumns(configuration, {
      showItemColumns: true,
      showProductCommissionColumns: false
    })).not.toContain('debit')
    expect(getPartnerAccountStatementVisibleColumns(configuration, {
      showItemColumns: true,
      showProductCommissionColumns: false
    }).slice(0, 2)).toEqual(['balance', 'description'])
  })

  it('repairs invalid layouts so at least one column remains visible', () => {
    const configuration = normalizePartnerAccountStatementTemplateConfiguration({
      columnOrder: ['description', 'description', 'unknown'],
      hiddenColumns: [...PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS],
      showOrderItems: 'true'
    })

    expect(configuration.columnOrder).toEqual([
      'description',
      ...PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS.filter((columnId) => columnId !== 'description')
    ])
    expect(configuration.hiddenColumns).not.toHaveLength(PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS.length)
    expect(getPartnerAccountStatementVisibleColumns(configuration, {
      showItemColumns: false,
      showProductCommissionColumns: false
    })).not.toHaveLength(0)
  })

  it('serializes only recognized statement-template payloads', () => {
    const configuration = createPartnerAccountStatementTemplateConfiguration({
      hiddenColumns: ['reference'],
      showPosSaleItems: true
    })
    const saved = readPartnerAccountStatementTemplate({
      id: 'template-1',
      label: 'Collections',
      layout_json: serializePartnerAccountStatementTemplate(configuration),
      active: true,
      primary: true,
      version: 4
    })

    expect(saved).toMatchObject({
      id: 'template-1',
      label: 'Collections',
      primary: true,
      configuration: { showPosSaleItems: true, hiddenColumns: ['reference'] }
    })
    expect(readPartnerAccountStatementTemplate({
      id: 'not-a-statement-template',
      label: 'Print layout',
      layout_json: {},
      active: true,
      primary: true,
      version: 1
    })).toBeNull()
  })

  it('puts the total label in a descriptive column before an amount when possible', () => {
    expect(getPartnerAccountStatementSummaryLabelColumn(['date', 'debit', 'credit', 'balance'])).toBe('date')
    expect(getPartnerAccountStatementSummaryLabelColumn(['debit', 'description', 'credit'])).toBe('description')
    expect(getPartnerAccountStatementSummaryLabelColumn(['date', 'description', 'debit', 'credit'])).toBe('description')
  })
})
