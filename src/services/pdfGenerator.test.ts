import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/platform', () => ({
    isTauri: () => false
}))

vi.mock('@/services/platformService', () => ({
    platformService: {
        readFile: vi.fn()
    }
}))

import { inlineCaptureableImages } from './pdfImageCapture'

class FileReaderStub {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    readAsDataURL(blob: Blob) {
        this.result = `data:${blob.type};base64,aW1hZ2U=`
        queueMicrotask(() => this.onload?.())
    }
}

function captureImage(source: string) {
    return {
        currentSrc: source,
        src: source,
        complete: true,
        naturalWidth: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
    } as unknown as HTMLImageElement
}

function captureContainer(images: HTMLImageElement[]) {
    return {
        querySelectorAll: vi.fn(() => images)
    } as unknown as HTMLElement
}

describe('PDF image capture preparation', () => {
    beforeEach(() => {
        vi.stubGlobal('FileReader', FileReaderStub)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('inlines a PWA R2 image before html-to-image captures the template', async () => {
        const source = 'https://media.example.test/workspace/attached-images/photo.jpg'
        const image = captureImage(source)
        const fetchMock = vi.fn().mockResolvedValue(new Response('image', {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' }
        }))
        vi.stubGlobal('fetch', fetchMock)

        await inlineCaptureableImages(captureContainer([image]))

        expect(fetchMock).toHaveBeenCalledWith(source, {
            credentials: 'omit',
            referrerPolicy: 'no-referrer'
        })
        expect(image.src).toBe('data:image/jpeg;base64,aW1hZ2U=')
    })

    it('uses the file extension when a legacy R2 image has a generic content type', async () => {
        const source = 'https://media.example.test/workspace/workspace-logos/logo.png'
        const image = captureImage(source)
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image', {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' }
        })))

        await inlineCaptureableImages(captureContainer([image]))

        expect(image.src).toBe('data:image/png;base64,aW1hZ2U=')
    })

    it('keeps an external source intact when it cannot be inlined', async () => {
        const source = 'https://media.example.test/workspace/attached-images/missing.jpg'
        const image = captureImage(source)
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })))
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await inlineCaptureableImages(captureContainer([image]))

        expect(image.src).toBe(source)
        expect(warning).toHaveBeenCalledWith(
            '[pdfGenerator] Failed to inline image for PDF capture:',
            source,
            expect.any(Error)
        )
    })
})
