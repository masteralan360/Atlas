import { describe, expect, it } from 'vitest'

import {
    calculateConstrainedDimensions,
    calculateReducedDimensions,
    detectSupportedImageMime,
    ImageCompressionError,
    isAnimatedImage,
    looksLikeUnsupportedImage,
} from '@/lib/imageCompression'
import { IMAGE_UPLOAD_PROFILES } from '@/lib/imageUploadProfiles'

describe('central image compression policy', () => {
    it('uses source-specific quality and size targets', () => {
        expect(IMAGE_UPLOAD_PROFILES['product-primary']).toMatchObject({
            maxDimension: 2048,
            startQuality: 0.90,
            softTargetBytes: 700 * 1024,
        })
        expect(IMAGE_UPLOAD_PROFILES['workspace-logo']).toMatchObject({
            maxDimension: 512,
            startQuality: 1,
            softTargetBytes: 120 * 1024,
        })
        expect(IMAGE_UPLOAD_PROFILES['print-attachment'].softTargetBytes)
            .toBeGreaterThan(IMAGE_UPLOAD_PROFILES['product-primary'].softTargetBytes)
    })

    it('rounds proportional dimensions and never upscales', () => {
        expect(calculateConstrainedDimensions(4000, 2001, 2048)).toEqual({ width: 2048, height: 1025 })
        expect(calculateConstrainedDimensions(320, 200, 512)).toEqual({ width: 320, height: 200 })
        expect(calculateConstrainedDimensions(1, 1, 512)).toEqual({ width: 1, height: 1 })
    })

    it('rejects invalid dimension boundaries', () => {
        expect(() => calculateConstrainedDimensions(0, 100, 512)).toThrowError(ImageCompressionError)
        expect(() => calculateConstrainedDimensions(Number.POSITIVE_INFINITY, 100, 512)).toThrowError(ImageCompressionError)
    })

    it('reduces dimensions predictably when the byte target is missed', () => {
        expect(calculateReducedDimensions(2000, 1000, 4000, 1000)).toEqual({ width: 1440, height: 720 })
        expect(calculateReducedDimensions(2000, 1000, 1001, 1000)).toEqual({ width: 1840, height: 920 })
        expect(calculateReducedDimensions(2000, 1000, 1000, 1000)).toEqual({ width: 2000, height: 1000 })
    })

    it('recognizes supported image signatures without trusting MIME labels', () => {
        expect(detectSupportedImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
        expect(detectSupportedImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
        expect(detectSupportedImageMime(new TextEncoder().encode('RIFF1234WEBP'))).toBe('image/webp')
        expect(detectSupportedImageMime(new Uint8Array([1, 2, 3]))).toBeNull()
    })

    it('rejects animated GIF, WebP, and AVIF markers while accepting static GIF', () => {
        const header = [...new TextEncoder().encode('GIF89a'), 1, 0, 1, 0, 0, 0, 0]
        const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0, 0]
        const staticGif = new Uint8Array([...header, ...frame, 0x3b])
        const animatedGif = new Uint8Array([...header, ...frame, ...frame, 0x3b])
        expect(isAnimatedImage(staticGif, 'image/gif')).toBe(false)
        expect(isAnimatedImage(animatedGif, 'image/gif')).toBe(true)
        expect(isAnimatedImage(new TextEncoder().encode('RIFF1234WEBPxxxxANIM'), 'image/webp')).toBe(true)
        expect(isAnimatedImage(new TextEncoder().encode('0000ftypavis'), 'image/avif')).toBe(true)
    })

    it('classifies SVG and HEIC as image inputs that must be rejected centrally', () => {
        expect(looksLikeUnsupportedImage(new TextEncoder().encode('<svg viewBox="0 0 1 1">'), 'text/plain', 'logo.txt')).toBe(true)
        expect(looksLikeUnsupportedImage(new TextEncoder().encode('0000ftypheic'), 'application/octet-stream', 'photo.heic')).toBe(true)
    })
})
