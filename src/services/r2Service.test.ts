import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/auth/supabase', () => ({
    refreshSupabaseSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } } })),
    supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } } })) } },
}))
vi.mock('@/workspace/workspaceMode', () => ({ isLocalWorkspaceMode: vi.fn(() => false) }))
vi.mock('@/lib/workspaceUsage', () => ({
    getTransferBodySize: vi.fn((value: Blob) => value.size),
    recordWorkspaceDataTransfer: vi.fn(async () => undefined),
}))

describe('R2 image upload boundary', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.stubEnv('VITE_R2_WORKER_URL', 'https://r2.example')
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })))
    })

    it('rejects raw image bytes from the generic object transport', async () => {
        const { r2Service } = await import('@/services/r2Service')
        const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'application/octet-stream' })
        await expect(r2Service.uploadObject('workspace/uploads/photo.bin', jpeg))
            .rejects.toThrow('centralized compressed-image upload pipeline')
        expect(fetch).not.toHaveBeenCalled()
    })

    it('sends profile metadata with branded compressed artifacts', async () => {
        const { r2Service } = await import('@/services/r2Service')
        const file = new File([new TextEncoder().encode('RIFF1234WEBP')], 'photo.webp', { type: 'image/webp' })
        await r2Service.uploadCompressedImage('workspace/product-images/photo.webp', {
            kind: 'atlas-compressed-image',
            file,
            source: 'product-primary',
            profileVersion: 1,
            width: 800,
            height: 600,
            originalBytes: 1000,
            outputBytes: file.size,
            attempts: 2,
        })

        expect(fetch).toHaveBeenCalledWith(expect.stringContaining('usage_client_recorded=1'), expect.objectContaining({ method: 'PUT' }))
        const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Headers
        expect(headers.get('Content-Type')).toBe('image/webp')
        expect(headers.get('X-Atlas-Image-Compressed')).toBe('1')
        expect(headers.get('X-Atlas-Image-Source')).toBe('product-primary')
        expect(headers.get('X-Atlas-Image-Profile')).toBe('1')
        expect(headers.get('X-Atlas-Image-Width')).toBe('800')
        expect(headers.get('X-Atlas-Image-Height')).toBe('600')
        expect(headers.get('X-Atlas-Image-Original-Bytes')).toBe('1000')
    })
})
