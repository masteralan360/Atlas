/**
 * A statement presentation template is deliberately stored separately from
 * the existing print-layout template. Both use the shared custom-template
 * persistence layer, but one controls the live activity table while the
 * other controls the freeform A4 canvas.
 */
export const PARTNER_ACCOUNT_STATEMENT_ACTIVITY_TEMPLATE_KEY =
  'businessPartners.AccountStatementActivity'

export const PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS = [
  'date',
  'reference',
  'type',
  'description',
  'item',
  'quantity',
  'commissionPerProduct',
  'totalProductCommission',
  'debit',
  'credit',
  'balance'
] as const

export type PartnerAccountStatementColumnId =
  (typeof PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS)[number]

export type PartnerAccountStatementTemplateConfiguration = {
  version: 1
  columnOrder: PartnerAccountStatementColumnId[]
  hiddenColumns: PartnerAccountStatementColumnId[]
  showOrderItems: boolean
  showPosSaleItems: boolean
}

export type PartnerAccountStatementTemplate = {
  id: string
  label: string
  primary: boolean
  active: boolean
  version: number
  configuration: PartnerAccountStatementTemplateConfiguration
}

type PartnerAccountStatementTemplateRow = {
  id: string
  label?: string | null
  layout_json: unknown
  active?: boolean
  primary?: boolean
  version?: number
}

export const DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION: PartnerAccountStatementTemplateConfiguration = {
  version: 1,
  columnOrder: [...PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS],
  hiddenColumns: [],
  showOrderItems: false,
  showPosSaleItems: false
}

function isColumnId(value: unknown): value is PartnerAccountStatementColumnId {
  return typeof value === 'string'
    && (PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS as readonly string[]).includes(value)
}

function readColumnIds(value: unknown) {
  if (!Array.isArray(value)) return []
  const seen = new Set<PartnerAccountStatementColumnId>()
  return value.flatMap((columnId) => {
    if (!isColumnId(columnId) || seen.has(columnId)) return []
    seen.add(columnId)
    return [columnId]
  })
}

/**
 * Accept only the current schema, repair partial/old payloads, and ensure a
 * malicious or corrupted payload cannot produce a table with no columns.
 */
export function normalizePartnerAccountStatementTemplateConfiguration(
  value: unknown
): PartnerAccountStatementTemplateConfiguration {
  const candidate = value && typeof value === 'object'
    ? value as Partial<PartnerAccountStatementTemplateConfiguration>
    : {}
  const requestedOrder = readColumnIds(candidate.columnOrder)
  const columnOrder = requestedOrder.length > 0
    ? [
      ...requestedOrder,
      ...PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS.filter((columnId) => !requestedOrder.includes(columnId))
    ]
    : [...PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS]
  const requestedHiddenColumns = readColumnIds(candidate.hiddenColumns)
  const hiddenColumns = requestedHiddenColumns.length === columnOrder.length
    ? requestedHiddenColumns.filter((columnId) => columnId !== columnOrder[0])
    : requestedHiddenColumns

  return {
    version: 1,
    columnOrder,
    hiddenColumns,
    showOrderItems: candidate.showOrderItems === true,
    showPosSaleItems: candidate.showPosSaleItems === true
  }
}

export function createPartnerAccountStatementTemplateConfiguration(
  source?: Partial<PartnerAccountStatementTemplateConfiguration> | null
) {
  return normalizePartnerAccountStatementTemplateConfiguration(source)
}

export function isPartnerAccountStatementColumnVisible(
  configuration: PartnerAccountStatementTemplateConfiguration,
  columnId: PartnerAccountStatementColumnId
) {
  return !configuration.hiddenColumns.includes(columnId)
}

export function getPartnerAccountStatementVisibleColumns(
  configuration: PartnerAccountStatementTemplateConfiguration,
  options: { showItemColumns: boolean; showProductCommissionColumns: boolean }
) {
  const visibleColumns = configuration.columnOrder.filter((columnId) => {
    if (!isPartnerAccountStatementColumnVisible(configuration, columnId)) return false
    if ((columnId === 'item' || columnId === 'quantity') && !options.showItemColumns) return false
    if (
      (columnId === 'commissionPerProduct' || columnId === 'totalProductCommission')
      && !options.showProductCommissionColumns
    ) return false
    return true
  })

  // A template may intentionally retain only dynamic columns. Keep a usable
  // audit table when those dynamic columns are not applicable to this partner.
  return visibleColumns.length > 0
    ? visibleColumns
    : configuration.columnOrder.filter((columnId) => isPartnerAccountStatementColumnVisible(configuration, columnId)).slice(0, 1)
}

export function getPartnerAccountStatementSummaryLabelColumn(
  columns: PartnerAccountStatementColumnId[]
) {
  const preferredColumns: PartnerAccountStatementColumnId[] = [
    'description',
    'reference',
    'type',
    'item',
    'date',
    'quantity',
    'commissionPerProduct',
    'totalProductCommission'
  ]
  return preferredColumns.find((columnId) => columns.includes(columnId)) || columns[0]
}

export function readPartnerAccountStatementTemplate(
  row: PartnerAccountStatementTemplateRow
): PartnerAccountStatementTemplate | null {
  if (!row.layout_json || typeof row.layout_json !== 'object') return null
  const payload = row.layout_json as { kind?: unknown; configuration?: unknown }
  if (payload.kind !== 'partner-account-statement-template') return null

  return {
    id: row.id,
    label: row.label?.trim() || 'Partner Account Statement',
    primary: row.primary === true,
    active: row.active !== false,
    version: Number(row.version || 1),
    configuration: normalizePartnerAccountStatementTemplateConfiguration(payload.configuration)
  }
}

export function serializePartnerAccountStatementTemplate(
  configuration: PartnerAccountStatementTemplateConfiguration
) {
  return {
    kind: 'partner-account-statement-template' as const,
    configuration: normalizePartnerAccountStatementTemplateConfiguration(configuration)
  }
}
