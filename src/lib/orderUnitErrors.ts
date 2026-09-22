const ORDER_UNIT_CONFIGURATION_ERROR = /(?:order item.*unit|product unit relationship|order unit selection)/i

/** Identifies authoritative database rejections caused by stale or invalid unit snapshots. */
export function isOrderUnitConfigurationError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : String(error ?? '')
  return ORDER_UNIT_CONFIGURATION_ERROR.test(message)
}
