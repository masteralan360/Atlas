import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isJumlaKhaleejInquirySnapshot,
  requestJumlaKhaleejInquirySnapshot
} from './jumlaKhaleejInquiryPdf'

const snapshot = {
  documentNumber: 'MKT-12345',
  createdAt: '2026-09-10T10:00:00.000Z',
  mode: 'wholesale',
  customer: {
    name: 'Sara',
    phone: '07700000000',
    email: '',
    city: 'kirkuk',
    cityLabel: 'کەرکووک',
    address: 'Kirkuk',
    notes: ''
  },
  items: [{
    product_id: 'product-1',
    name: 'Serum',
    image_url: null,
    price: 2500,
    currency: 'iqd',
    unit: 'pcs',
    quantity: 2,
    line_total: 5000
  }],
  deliveryFee: 3000,
  deliveryCurrency: 'iqd',
  store: {
    name: 'Jumla Khaleej',
    logo_url: null,
    contacts: [{ type: 'phone', value: '07714504323', is_primary: true }]
  }
} as const

describe('requestJumlaKhaleejInquirySnapshot', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads current inquiry data from the authenticated Atlas snapshot endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(snapshot))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'https://atlaserp.dev' } })

    await expect(requestJumlaKhaleejInquirySnapshot({
      accessToken: 'atlas-session-token',
      orderId: '123e4567-e89b-42d3-a456-426614174000'
    })).resolves.toEqual(snapshot)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-ecommerce/inquiries/123e4567-e89b-42d3-a456-426614174000/snapshot',
      expect.objectContaining({
        cache: 'no-store',
        headers: { Authorization: 'Bearer atlas-session-token' }
      })
    )
  })

  it('uses the hosted Atlas endpoint outside the production web origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(snapshot))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'http://localhost:1420' } })

    await requestJumlaKhaleejInquirySnapshot({
      accessToken: 'atlas-session-token',
      orderId: '123e4567-e89b-42d3-a456-426614174000'
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://atlaserp.dev/api-ecommerce/inquiries/123e4567-e89b-42d3-a456-426614174000/snapshot',
      expect.anything()
    )
  })

  it('rejects malformed snapshots instead of using another PDF path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...snapshot, items: [] })))

    await expect(requestJumlaKhaleejInquirySnapshot({
      accessToken: 'atlas-session-token',
      orderId: '123e4567-e89b-42d3-a456-426614174000'
    })).rejects.toThrow('snapshot is invalid')
  })
})

describe('isJumlaKhaleejInquirySnapshot', () => {
  it('accepts the canonical snapshot and rejects non-MKT documents', () => {
    expect(isJumlaKhaleejInquirySnapshot(snapshot)).toBe(true)
    expect(isJumlaKhaleejInquirySnapshot({ ...snapshot, documentNumber: 'ORD-12345' })).toBe(false)
  })
})
