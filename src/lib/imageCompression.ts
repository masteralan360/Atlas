import { getImageUploadProfile, isImageUploadSource, type ImageUploadProfile, type ImageUploadSource } from '@/lib/imageUploadProfiles'

export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif'

export type ImageCompressionErrorCode =
    | 'empty_image'
    | 'image_too_large'
    | 'unsupported_image'
    | 'animated_image'
    | 'image_decode_failed'
    | 'image_processing_failed'

export class ImageCompressionError extends Error {
    constructor(public readonly code: ImageCompressionErrorCode) {
        super(code)
        this.name = 'ImageCompressionError'
    }
}

export interface CompressedImageArtifact {
    readonly kind: 'atlas-compressed-image'
    readonly file: File
    readonly source: ImageUploadSource
    readonly profileVersion: 1
    readonly width: number
    readonly height: number
    readonly originalBytes: number
    readonly outputBytes: number
    readonly attempts: number
}

const HEADER_READ_BYTES = 64 * 1024

function matches(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
    return expected.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
    const expected = Array.from(needle, (char) => char.charCodeAt(0))
    outer: for (let offset = 0; offset <= bytes.length - expected.length; offset += 1) {
        for (let index = 0; index < expected.length; index += 1) {
            if (bytes[offset + index] !== expected[index]) continue outer
        }
        return true
    }
    return false
}

export function detectSupportedImageMime(bytes: Uint8Array): SupportedImageMime | null {
    if (matches(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
    if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
    if (matches(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || matches(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
    if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
    if (matches(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
        const brands = ascii(bytes, 8, Math.min(32, Math.max(0, bytes.length - 8)))
        if (brands.includes('avif') || brands.includes('avis')) return 'image/avif'
    }
    return null
}

export function looksLikeUnsupportedImage(bytes: Uint8Array, declaredType = '', fileName = ''): boolean {
    const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).replace(/^\uFEFF?\s*/i, '').toLowerCase()
    if (prefix.startsWith('<svg') || prefix.startsWith('<?xml') && prefix.includes('<svg')) return true

    if (matches(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
        const brands = ascii(bytes, 8, Math.min(40, Math.max(0, bytes.length - 8))).toLowerCase()
        if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].some((brand) => brands.includes(brand))) return true
    }

    return declaredType.toLowerCase().startsWith('image/')
        || /\.(?:svg|heic|heif|bmp|tiff?|ico)$/i.test(fileName)
}

export function isAnimatedImage(bytes: Uint8Array, mime: SupportedImageMime): boolean {
    if (mime === 'image/gif') {
        if (bytes.length < 13) return false
        let offset = 13
        const globalColorTable = (bytes[10] & 0x80) !== 0
        if (globalColorTable) offset += 3 * (2 ** ((bytes[10] & 0x07) + 1))
        let frames = 0
        const skipSubBlocks = () => {
            while (offset < bytes.length) {
                const size = bytes[offset++]
                if (size === 0) return
                offset += size
            }
        }
        while (offset < bytes.length) {
            const marker = bytes[offset++]
            if (marker === 0x3b) break
            if (marker === 0x21) {
                offset += 1
                skipSubBlocks()
                continue
            }
            if (marker !== 0x2c || offset + 9 > bytes.length) break
            frames += 1
            if (frames > 1) return true
            const packed = bytes[offset + 8]
            offset += 9
            if ((packed & 0x80) !== 0) offset += 3 * (2 ** ((packed & 0x07) + 1))
            offset += 1
            skipSubBlocks()
        }
        return false
    }
    if (mime === 'image/webp') {
        return containsAscii(bytes, 'ANIM') || containsAscii(bytes, 'ANMF')
    }
    if (mime === 'image/avif') {
        const brands = ascii(bytes, 8, Math.min(48, Math.max(0, bytes.length - 8)))
        return brands.includes('avis')
    }
    return false
}

export function calculateConstrainedDimensions(width: number, height: number, maxDimension: number): { width: number; height: number } {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || maxDimension <= 0) {
        throw new ImageCompressionError('image_decode_failed')
    }
    const scale = Math.min(1, maxDimension / Math.max(width, height))
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    }
}

export function calculateReducedDimensions(width: number, height: number, outputBytes: number, targetBytes: number): { width: number; height: number } {
    if (outputBytes <= targetBytes) return { width, height }
    const scale = Math.max(0.72, Math.min(0.92, Math.sqrt(targetBytes / outputBytes) * 0.96))
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    }
}

async function readHeader(file: Blob): Promise<Uint8Array> {
    return new Uint8Array(await file.slice(0, HEADER_READ_BYTES).arrayBuffer())
}

async function canvasSupportsWebpEncoding(): Promise<boolean> {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8))
    return blob?.type.toLowerCase() === 'image/webp'
}

export async function isImageUploadCandidate(file: File): Promise<boolean> {
    const bytes = await readHeader(file)
    return Boolean(detectSupportedImageMime(bytes) || looksLikeUnsupportedImage(bytes, file.type, file.name))
}

async function decodeImage(file: File): Promise<HTMLImageElement> {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
        throw new ImageCompressionError('image_processing_failed')
    }
    const url = URL.createObjectURL(file)
    try {
        return await new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image()
            image.decoding = 'async'
            image.onload = () => resolve(image)
            image.onerror = () => reject(new ImageCompressionError('image_decode_failed'))
            image.src = url
        })
    } finally {
        URL.revokeObjectURL(url)
    }
}

async function encodeWebp(
    image: CanvasImageSource,
    width: number,
    height: number,
    quality: number,
    nativeWebpSupported: boolean,
): Promise<Blob> {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new ImageCompressionError('image_processing_failed')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, width, height)
    if (nativeWebpSupported) {
        try {
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
            if (blob?.type.toLowerCase() === 'image/webp') return blob
        } catch {
            // Fall back to WebAssembly if native encoding fails for this image.
        }
    }

    try {
        const { default: encode } = await import('@jsquash/webp/encode')
        const encoded = await encode(context.getImageData(0, 0, width, height), { quality: quality * 100 })
        return new Blob([encoded], { type: 'image/webp' })
    } catch {
        throw new ImageCompressionError('image_processing_failed')
    }
}

function nextQuality(current: number, profile: ImageUploadProfile): number | null {
    if (current <= profile.minimumQuality) return null
    return Math.max(profile.minimumQuality, Number((current - profile.qualityStep).toFixed(2)))
}

export async function compressImage(file: File, source: ImageUploadSource): Promise<CompressedImageArtifact> {
    const profile = getImageUploadProfile(source)
    if (file.size <= 0) throw new ImageCompressionError('empty_image')
    if (file.size > profile.maxInputBytes) throw new ImageCompressionError('image_too_large')

    const header = await readHeader(file)
    const mime = detectSupportedImageMime(header)
    if (!mime) throw new ImageCompressionError('unsupported_image')
    const animationBytes = mime === 'image/jpeg' || mime === 'image/png'
        ? header
        : new Uint8Array(await file.arrayBuffer())
    if (isAnimatedImage(animationBytes, mime)) throw new ImageCompressionError('animated_image')

    const image = await decodeImage(file)
    if (image.naturalWidth * image.naturalHeight > profile.maxInputPixels) {
        throw new ImageCompressionError('image_too_large')
    }

    let nativeWebpSupported = false
    try {
        nativeWebpSupported = await canvasSupportsWebpEncoding()
    } catch {
        // Use the browser-side encoder when the canvas capability probe fails.
    }

    let dimensions = calculateConstrainedDimensions(image.naturalWidth, image.naturalHeight, profile.maxDimension)
    let quality = profile.startQuality
    let output: Blob | null = null
    let attempts = 0

    for (let resizePass = 0; resizePass < 4; resizePass += 1) {
        quality = profile.startQuality
        while (true) {
            output = await encodeWebp(image, dimensions.width, dimensions.height, quality, nativeWebpSupported)
            attempts += 1
            if (output.size <= profile.softTargetBytes) break
            const reducedQuality = nextQuality(quality, profile)
            if (reducedQuality === null) break
            quality = reducedQuality
        }
        if (output.size <= profile.softTargetBytes || Math.max(dimensions.width, dimensions.height) <= 384) break
        const nextDimensions = calculateReducedDimensions(dimensions.width, dimensions.height, output.size, profile.softTargetBytes)
        if (nextDimensions.width === dimensions.width && nextDimensions.height === dimensions.height) break
        dimensions = nextDimensions
    }

    if (!output) throw new ImageCompressionError('image_processing_failed')
    const fileName = `${crypto.randomUUID()}--atlas-${source}-v${profile.version}.webp`
    const compressedFile = new File([output], fileName, { type: 'image/webp', lastModified: Date.now() })
    return {
        kind: 'atlas-compressed-image',
        file: compressedFile,
        source,
        profileVersion: profile.version,
        width: dimensions.width,
        height: dimensions.height,
        originalBytes: file.size,
        outputBytes: compressedFile.size,
        attempts,
    }
}

export async function restoreCompressedImageArtifact(file: File): Promise<CompressedImageArtifact> {
    const match = file.name.match(/--atlas-([a-z-]+)-v1\.webp$/i)
    if (!match) throw new ImageCompressionError('unsupported_image')
    if (!isImageUploadSource(match[1])) throw new ImageCompressionError('unsupported_image')
    const source = match[1]
    const header = await readHeader(file)
    if (detectSupportedImageMime(header) !== 'image/webp' || isAnimatedImage(header, 'image/webp')) {
        throw new ImageCompressionError('unsupported_image')
    }
    const image = await decodeImage(file)
    return {
        kind: 'atlas-compressed-image', file, source, profileVersion: 1,
        width: image.naturalWidth, height: image.naturalHeight,
        originalBytes: file.size, outputBytes: file.size, attempts: 0,
    }
}
