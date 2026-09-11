import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestJumlaKhaleejInquiryPdf } from './jumlaKhaleejInquiryPdf'

describe('requestJumlaKhaleejInquiryPdf', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads PDF bytes from the authenticated Atlas endpoint', async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45])
    const fetchMock = vi.fn().mockResolvedValue(new Response(pdf, {
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.byteLength) }
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'https://atlaserp.dev' } })

    await expect(requestJumlaKhaleejInquiryPdf({
      accessToken: 'atlas-session-token',
      orderId: '123e4567-e89b-42d3-a456-426614174000'
    })).resolves.toEqual(pdf)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-ecommerce/inquiries/123e4567-e89b-42d3-a456-426614174000/pdf',
      expect.objectContaining({
        cache: 'no-store',
        headers: { Authorization: 'Bearer atlas-session-token' }
      })
    )
  })

  it('rejects a successful non-PDF response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      headers: { 'Content-Type': 'application/json' }
    })))

    await expect(requestJumlaKhaleejInquiryPdf({
      accessToken: 'atlas-session-token',
      orderId: '123e4567-e89b-42d3-a456-426614174000'
    })).rejects.toThrow('unexpected response')
  })

  it('uses the hosted Atlas endpoint outside the production web origin', async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45])
    const fetchMock = vi.fn().mockResolvedValue(new Response(pdf, {
      headers: { 'Content-Type': 'application/pdf' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'http://localhost:1420' } })

    await requestJumlaKhaleejInquiryPdf({
      accessToken: 'atlas-session-token',
      orderId: '123e4567-e89b-42d3-a456-426614174000'
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://atlaserp.dev/api-ecommerce/inquiries/123e4567-e89b-42d3-a456-426614174000/pdf',
      expect.anything()
    )
  })
})
