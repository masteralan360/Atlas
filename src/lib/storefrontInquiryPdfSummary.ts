export type StorefrontInquiryPdfTotalLabel =
  | 'orderTotal'
  | 'orderTotalWithDeliveryFee'
  | 'orderTotalAfterDiscount'
  | 'orderTotalWithDeliveryFeeAfterDiscount'

export type StorefrontInquiryPdfSummaryInput = {
  subtotal: number
  deliveryFee: number
  discountAmount: number
  orderCurrency: string
  deliveryCurrency: string
}

export function calculateStorefrontInquiryPdfSummary(input: StorefrontInquiryPdfSummaryInput) {
  const roundAmount = (value: number) => Math.round((value + Number.EPSILON) * 1_000) / 1_000
  const nonNegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0
  const subtotal = roundAmount(nonNegative(input.subtotal))
  const deliveryFee = roundAmount(nonNegative(input.deliveryFee))
  const discountAmount = roundAmount(Math.min(subtotal, nonNegative(input.discountAmount)))
  const deliveryCanBeIncluded = deliveryFee > 0
    && input.orderCurrency.trim().toLowerCase() === input.deliveryCurrency.trim().toLowerCase()
  const total = roundAmount(Math.max(0, subtotal - discountAmount) + (deliveryCanBeIncluded ? deliveryFee : 0))
  const totalLabel: StorefrontInquiryPdfTotalLabel = deliveryCanBeIncluded
    ? discountAmount > 0 ? 'orderTotalWithDeliveryFeeAfterDiscount' : 'orderTotalWithDeliveryFee'
    : discountAmount > 0 ? 'orderTotalAfterDiscount' : 'orderTotal'

  return { subtotal, deliveryFee, discountAmount, deliveryCanBeIncluded, total, totalLabel }
}
