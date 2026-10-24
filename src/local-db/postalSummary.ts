export interface PostalDashboardSummary {
  total_shipments: number
  active_shipments: number
  delivered_shipments: number
  in_transit_shipments: number
  cod_balance: string
  collection_records: number
}

export function sanitizePostalSearch(search: string) {
  return search
    .trim()
    .replace(/[٠-٩۰-۹]/g, (digit) =>
      String.fromCharCode(
        digit.charCodeAt(0) >= 0x06f0
          ? digit.charCodeAt(0) - 0x06f0 + 48
          : digit.charCodeAt(0) - 0x0660 + 48,
      ),
    )
    .replace(/[%_,().\\\u066c\u066b]/g, '')
}

export function normalizePostalDashboardSummary(
  value: unknown,
): PostalDashboardSummary {
  if (!value || typeof value !== 'object')
    throw new Error('postal_invalid_result')
  const row = value as Record<string, unknown>
  const counts = [
    'total_shipments',
    'active_shipments',
    'delivered_shipments',
    'in_transit_shipments',
    'collection_records',
  ] as const
  for (const field of counts) {
    if (
      typeof row[field] !== 'number' ||
      !Number.isSafeInteger(row[field]) ||
      (row[field] as number) < 0
    ) {
      throw new Error('postal_invalid_result')
    }
  }
  if (typeof row.cod_balance !== 'string' || !/^-?\d+$/.test(row.cod_balance))
    throw new Error('postal_invalid_result')
  const summary = row as unknown as PostalDashboardSummary
  if (
    summary.active_shipments + summary.delivered_shipments >
      summary.total_shipments ||
    summary.in_transit_shipments > summary.active_shipments
  ) {
    throw new Error('postal_invalid_result')
  }
  return summary
}
