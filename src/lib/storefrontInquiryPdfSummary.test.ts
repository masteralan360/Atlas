import { describe, expect, it } from 'vitest'

import { calculateStorefrontInquiryPdfSummary } from './storefrontInquiryPdfSummary'

describe('storefront inquiry PDF summary', () => {
  it('uses the plain total label when neither delivery nor a discount applies', () => {
    expect(calculateStorefrontInquiryPdfSummary({
      subtotal: 100,
      deliveryFee: 0,
      discountAmount: 0,
      orderCurrency: 'iqd',
      deliveryCurrency: 'iqd'
    })).toMatchObject({ total: 100, totalLabel: 'orderTotal', deliveryCanBeIncluded: false })
  })

  it('selects a localized label and final amount for each applied component', () => {
    const deliveryOnly = calculateStorefrontInquiryPdfSummary({
      subtotal: 100,
      deliveryFee: 10,
      discountAmount: 0,
      orderCurrency: 'iqd',
      deliveryCurrency: 'iqd'
    })
    const discountOnly = calculateStorefrontInquiryPdfSummary({
      subtotal: 100,
      deliveryFee: 0,
      discountAmount: 15,
      orderCurrency: 'iqd',
      deliveryCurrency: 'iqd'
    })
    const both = calculateStorefrontInquiryPdfSummary({
      subtotal: 100,
      deliveryFee: 10,
      discountAmount: 15,
      orderCurrency: 'iqd',
      deliveryCurrency: 'iqd'
    })

    expect(deliveryOnly).toMatchObject({ total: 110, totalLabel: 'orderTotalWithDeliveryFee' })
    expect(discountOnly).toMatchObject({ total: 85, totalLabel: 'orderTotalAfterDiscount' })
    expect(both).toMatchObject({ total: 95, totalLabel: 'orderTotalWithDeliveryFeeAfterDiscount' })
  })

  it('caps discounts and keeps delivery separate when its currency differs', () => {
    expect(calculateStorefrontInquiryPdfSummary({
      subtotal: 100,
      deliveryFee: 10,
      discountAmount: 150,
      orderCurrency: 'usd',
      deliveryCurrency: 'iqd'
    })).toMatchObject({
      subtotal: 100,
      discountAmount: 100,
      deliveryCanBeIncluded: false,
      total: 0,
      totalLabel: 'orderTotalAfterDiscount'
    })
  })
})
