import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index.js'

const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  MY_BUCKET: {},
}

const pngPrefix = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

afterEach(() => vi.unstubAllGlobals())

describe('product image import worker endpoint', () => {
  it('requires authentication before attempting an external fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request('https://worker.example/__product-image-import__', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://images.example.com/item.png' }),
      headers: { 'Content-Type': 'application/json' },
    }), env)

    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches a valid public image only after authentication and streams it back', async () => {
    const fetchMock = vi.fn(async (input) => {
      if (String(input).includes('/auth/v1/user')) return Response.json({ id: 'user-1' })
      return new Response(pngPrefix, { headers: { 'Content-Length': String(pngPrefix.byteLength) } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request('https://worker.example/__product-image-import__', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://images.example.com/item.png' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
    }), env)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngPrefix)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a private target without fetching it', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'user-1' }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request('https://worker.example/__product-image-import__', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://127.0.0.1/image.png' }),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
    }), env)

    expect(response.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
