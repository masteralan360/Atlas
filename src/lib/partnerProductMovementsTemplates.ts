/**
 * A statement presentation template is deliberately stored separately from
 * the existing print-layout template. Both use the shared custom-template
 * persistence layer, but one controls the live activity table while the
 * other controls the freeform A4 canvas.
 */
export const PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY =
  'businessPartners.ProductMovementsActivity'

export const PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS = [
  'reference',
  'description',
  'item',
  'quantity',
  'commissionPerProduct',
  'totalProductCommission',
] as const

export type PartnerProductMovementsColumnId =
  (typeof PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS)[number]

export type PartnerProductMovementsTemplateConfiguration = {
  version: 1
  columnOrder: PartnerProductMovementsColumnId[]
  hiddenColumns: PartnerProductMovementsColumnId[]
  accumulateProducts: boolean
}

export type PartnerProductMovementsTemplate = {
  id: string
  label: string
  primary: boolean
  active: boolean
  version: number
  configuration: PartnerProductMovementsTemplateConfiguration
}

type PartnerProductMovementsTemplateRow = {
  id: string
  label?: string | null
  layout_json: unknown
  active?: boolean
  primary?: boolean
  version?: number
}

export const DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION: PartnerProductMovementsTemplateConfiguration = {
  version: 1,
  columnOrder: [...PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS],
  hiddenColumns: [],
  accumulateProducts: false
}

function isColumnId(value: unknown): value is PartnerProductMovementsColumnId {
  return typeof value === 'string'
    && (PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS as readonly string[]).includes(value)
}

function readColumnIds(value: unknown) {
  if (!Array.isArray(value)) return []
  const seen = new Set<PartnerProductMovementsColumnId>()
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
export function normalizePartnerProductMovementsTemplateConfiguration(
  value: unknown
): PartnerProductMovementsTemplateConfiguration {
  const candidate = value && typeof value === 'object'
    ? value as Partial<PartnerProductMovementsTemplateConfiguration>
    : {}
  const requestedOrder = readColumnIds(candidate.columnOrder)
  const columnOrder = requestedOrder.length > 0
    ? [
      ...requestedOrder,
      ...PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS.filter((columnId) => !requestedOrder.includes(columnId))
    ]
    : [...PARTNER_PRODUCT_MOVEMENTS_COLUMN_IDS]
  const requestedHiddenColumns = readColumnIds(candidate.hiddenColumns)
  const hiddenColumns = requestedHiddenColumns.length === columnOrder.length
    ? requestedHiddenColumns.filter((columnId) => columnId !== columnOrder[0])
    : requestedHiddenColumns

  return {
    version: 1,
    columnOrder,
    hiddenColumns,
    accumulateProducts: candidate.accumulateProducts === true
  }
}

export function createPartnerProductMovementsTemplateConfiguration(
  source?: Partial<PartnerProductMovementsTemplateConfiguration> | null
) {
  return normalizePartnerProductMovementsTemplateConfiguration(source)
}

export function isPartnerProductMovementsColumnVisible(
  configuration: PartnerProductMovementsTemplateConfiguration,
  columnId: PartnerProductMovementsColumnId
) {
  return !configuration.hiddenColumns.includes(columnId)
}

export function getPartnerProductMovementsVisibleColumns(
  configuration: PartnerProductMovementsTemplateConfiguration,
  options: { showProductCommissionColumns: boolean }
) {
  const visibleColumns = configuration.columnOrder.filter((columnId) => {
    if (!isPartnerProductMovementsColumnVisible(configuration, columnId)) return false
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
    : ['reference'] as PartnerProductMovementsColumnId[]
}

export function getPartnerProductMovementsSummaryLabelColumn(
  columns: PartnerProductMovementsColumnId[]
) {
  const preferredColumns: PartnerProductMovementsColumnId[] = [
    'description',
    'reference',
    'item',
    'quantity',
    'commissionPerProduct',
    'totalProductCommission'
  ]
  return preferredColumns.find((columnId) => columns.includes(columnId)) || columns[0]
}

export function readPartnerProductMovementsTemplate(
  row: PartnerProductMovementsTemplateRow
): PartnerProductMovementsTemplate | null {
  if (!row.layout_json || typeof row.layout_json !== 'object') return null
  const payload = row.layout_json as { kind?: unknown; configuration?: unknown }
  if (payload.kind !== 'partner-product-movements-template') return null

  return {
    id: row.id,
    label: row.label?.trim() || '',
    primary: row.primary === true,
    active: row.active !== false,
    version: Number(row.version || 1),
    configuration: normalizePartnerProductMovementsTemplateConfiguration(payload.configuration)
  }
}

export function serializePartnerProductMovementsTemplate(
  configuration: PartnerProductMovementsTemplateConfiguration
) {
  return {
    kind: 'partner-product-movements-template' as const,
    configuration: normalizePartnerProductMovementsTemplateConfiguration(configuration)
  }
}
