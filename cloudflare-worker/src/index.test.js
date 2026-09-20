import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index.js'

const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  MY_BUCKET: {},
}

const pngPrefix = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const webpPrefix = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x08, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20])
const jpegPrefix = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])

function createUploadRequest(body, headers = {}) {
  return new Request('https://worker.example/123e4567-e89b-42d3-a456-426614174000/product-images/item.webp', {
    method: 'PUT',
    body,
    headers: { Authorization: 'Bearer session-token', ...headers },
  })
}

function createUploadEnv(overrides = {}) {
  const put = vi.fn(async (_path, body) => {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer())
    return { size: bytes.byteLength }
  })
  return { ...env, MY_BUCKET: { put }, ...overrides }
}

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

describe('R2 compressed image enforcement', () => {
  it('stores a marked WebP with auditable R2 custom metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'user-1' })))
    const uploadEnv = createUploadEnv()
    const response = await worker.fetch(createUploadRequest(webpPrefix, {
      'Content-Type': 'image/webp',
      'X-Atlas-Image-Compressed': '1',
      'X-Atlas-Image-Source': 'product-primary',
      'X-Atlas-Image-Profile': '1',
      'X-Atlas-Image-Width': '800',
      'X-Atlas-Image-Height': '600',
      'X-Atlas-Image-Original-Bytes': '2400000',
    }), uploadEnv)

    expect(response.status).toBe(200)
    expect(uploadEnv.MY_BUCKET.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(ReadableStream),
      expect.objectContaining({
        customMetadata: expect.objectContaining({
          atlasImageCompressed: '1',
          atlasImageSource: 'product-primary',
          atlasImageProfile: '1',
          atlasImageWidth: '800',
          atlasImageHeight: '600',
          atlasImageOriginalBytes: '2400000',
        }),
      }),
    )
  })

  it('rejects unmarked image bytes when strict enforcement is enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'user-1' })))
    const uploadEnv = createUploadEnv({ R2_REQUIRE_COMPRESSED_IMAGES: 'true' })
    const response = await worker.fetch(createUploadRequest(jpegPrefix, {
      'Content-Type': 'application/octet-stream',
    }), uploadEnv)

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('compressed-image pipeline')
  })

  it('warns but accepts an unmarked legacy image during the rollout window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'user-1' })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const uploadEnv = createUploadEnv()
    const response = await worker.fetch(createUploadRequest(jpegPrefix, {
      'Content-Type': 'image/jpeg',
    }), uploadEnv)

    expect(response.status).toBe(200)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('r2_legacy_unmarked_image_upload'))
    warn.mockRestore()
  })

  it('rejects invalid profile metadata and animated WebP bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'user-1' })))
    const baseHeaders = {
      'Content-Type': 'image/webp',
      'X-Atlas-Image-Compressed': '1',
      'X-Atlas-Image-Source': 'product-primary',
      'X-Atlas-Image-Profile': '1',
      'X-Atlas-Image-Width': '512',
      'X-Atlas-Image-Height': '512',
      'X-Atlas-Image-Original-Bytes': '500000',
    }
    const animated = new Uint8Array([...webpPrefix, 0x41, 0x4e, 0x49, 0x4d])
    const animatedResponse = await worker.fetch(createUploadRequest(animated, baseHeaders), createUploadEnv())
    expect(animatedResponse.status).toBe(400)
    expect(await animatedResponse.text()).toContain('Animated images')

    const invalidResponse = await worker.fetch(createUploadRequest(webpPrefix, {
      ...baseHeaders,
      'X-Atlas-Image-Source': 'unknown-source',
    }), createUploadEnv())
    expect(invalidResponse.status).toBe(400)
    expect(await invalidResponse.text()).toContain('metadata')
  })
})
