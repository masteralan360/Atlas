import i18n from '@/i18n/config'

export interface StockReservationConflict {
  workspaceId: string
  productId: string
  storageId: string
  productName?: string
  onHand: number
  reserved: number
  required: number
  available: number
}

export const STOCK_RESERVATION_CONFLICT_EVENT = 'atlas:stock-reservation-conflict'

export class StockReservationConflictError extends Error {
  readonly code = 'STOCK_RESERVED'
  constructor(readonly conflict: StockReservationConflict) {
    super(i18n.t(conflict.reserved > 0 ? 'stockReservations.conflictMessage' : 'stockReservations.stockShortageMessage', {
      available: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 6 }).format(conflict.available),
      required: new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 6 }).format(conflict.required),
    }))
    this.name = 'StockReservationConflictError'
  }
}

let lastPublished = ''
let lastPublishedAt = 0

export function reportStockReservationConflict(conflict: StockReservationConflict) {
  const signature = JSON.stringify(conflict)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined'
    && (signature !== lastPublished || Date.now() - lastPublishedAt > 1000)) {
    lastPublished = signature
    lastPublishedAt = Date.now()
    window.dispatchEvent(new CustomEvent(STOCK_RESERVATION_CONFLICT_EVENT, { detail: conflict }))
  }
  return new StockReservationConflictError(conflict)
}

/** Database errors contain quantities only; restricted order/customer identities never travel in errors. */
export function normalizeStockReservationError(error: unknown): StockReservationConflictError | null {
  if (error instanceof StockReservationConflictError) return error
  if (!error || typeof error !== 'object' || !('message' in error) || error.message !== 'stock_reserved') return null
  try {
    const value = JSON.parse(String('details' in error ? error.details : '')) as StockReservationConflict
    if (![value.workspaceId, value.productId, value.storageId].every(value => typeof value === 'string' && value.length > 0)
      || ![value.onHand, value.reserved, value.required, value.available].every(Number.isFinite)) return null
    return reportStockReservationConflict(value)
  } catch { return null }
}
