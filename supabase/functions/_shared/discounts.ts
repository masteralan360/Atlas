export type ResolvedWorkspaceDiscountRow = {
  product_id: string
  discount_type: 'percentage' | 'fixed_amount'
  discount_value: number
  starts_at: string
  ends_at: string
  min_stock_threshold: number | null
  source: 'product' | 'category'
  is_stock_ok: boolean
}

export function computeDiscountPrice(
  price: number,
  discountType: 'percentage' | 'fixed_amount',
  discountValue: number,
) {
  const basePrice = Number.isFinite(price) ? price : 0
  const normalizedValue = Number.isFinite(discountValue) ? discountValue : 0

  if (discountType === 'percentage') {
    const percentage = Math.min(Math.max(normalizedValue, 0), 100)
    return Math.max(Math.round(basePrice * (1 - percentage / 100) * 100) / 100, 0)
  }

  return Math.max(Math.round((basePrice - Math.max(normalizedValue, 0)) * 100) / 100, 0)
}
