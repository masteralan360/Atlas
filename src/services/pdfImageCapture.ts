import { isTauri } from '@/lib/platform'
import { platformService } from '@/services/platformService'

// iOS can terminate a large burst of image reads while the print DOM is being
// prepared. Keep the pre-capture data-URL conversion deliberately small and
// bounded, especially for templates with several attached photos.
const PDF_IMAGE_INLINE_CONCURRENCY = 4

async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error || new Error('Failed to read image data.'))
        reader.readAsDataURL(blob)
    })
}

const TAURI_ASSET_PREFIXES = [
    'asset://localhost/',
    'https://asset.localhost/',
    'http://localhost/'
]

function extractTauriAssetFsPath(source: string): string | null {
    for (const prefix of TAURI_ASSET_PREFIXES) {
        if (!source.startsWith(prefix)) continue

        let filePath = decodeURIComponent(source.slice(prefix.length))
        if (/^\/[A-Za-z]:[\\/]/.test(filePath)) {
            filePath = filePath.slice(1)
        }
        return filePath || null
    }
    return null
}

function imageMimeFromPath(filePath: string): string | null {
    const withoutQuery = filePath.split(/[?#]/, 1)[0]
    const ext = withoutQuery.split('.').pop()?.toLowerCase() || ''
    if (ext === 'png') return 'image/png'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'svg') return 'image/svg+xml'
    if (ext === 'heic') return 'image/heic'
    if (ext === 'heif') return 'image/heif'
    return null
}

export async function waitForPdfImageReady(image: HTMLImageElement, timeoutMs = 10_000) {
    await new Promise<void>((resolve) => {
        if (image.complete) {
            resolve()
            return
        }

        const cleanup = () => {
            image.removeEventListener('load', cleanup)
            image.removeEventListener('error', cleanup)
            resolve()
        }

        image.addEventListener('load', cleanup)
        image.addEventListener('error', cleanup)
        setTimeout(cleanup, timeoutMs)
    })

    // iOS WebKit can fire `load` before the image is fully decoded. Waiting for
    // decode prevents html-to-image from capturing an empty custom-template image.
    if (image.naturalWidth > 0 && typeof image.decode === 'function') {
        await Promise.race([
            image.decode().catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
        ])
    }
}

export async function waitForPdfImages(container: HTMLElement) {
    await Promise.all(Array.from(container.querySelectorAll('img')).map((image) => waitForPdfImageReady(image)))
}

/**
 * Resolves every printable image into a data URL before html-to-image clones
 * the template. This prevents iOS PWA WebKit from losing the second R2 fetch
 * that html-to-image performs inside its SVG foreignObject capture.
 */
export async function inlineCaptureableImages(container: HTMLElement) {
    const images = Array.from(container.querySelectorAll('img'))
    let nextImageIndex = 0

    const inlineImage = async (image: HTMLImageElement) => {
        const source = image.currentSrc || image.src
        if (!source || source.startsWith('data:')) return

        const originalSrc = image.getAttribute('src')
        const originalSrcSet = image.getAttribute('srcset')
        const originalSizes = image.getAttribute('sizes')

        const setInlineSource = async (dataUrl: string) => {
            // Decode the data URL on a separate image before replacing the
            // rendered source. iOS WebKit can report the old image as complete
            // immediately after `src` changes, then capture the old or empty
            // resource in html-to-image's SVG clone.
            const decodedImage = image.ownerDocument.createElement('img')
            decodedImage.src = dataUrl
            await waitForPdfImageReady(decodedImage)
            if (decodedImage.naturalWidth <= 0 || decodedImage.naturalHeight <= 0) {
                throw new Error('The image could not be decoded for PDF capture.')
            }

            image.removeAttribute('srcset')
            image.removeAttribute('sizes')
            image.loading = 'eager'
            image.src = dataUrl
            await waitForPdfImageReady(image)
            if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
                throw new Error('The inline image could not be decoded for PDF capture.')
            }
        }

        // Tauri asset-protocol URLs (asset://localhost/... on iOS,
        // https://asset.localhost/... on desktop) cannot be fetched from the
        // webview, so html-to-image cannot embed them in its SVG foreignObject
        // clone. Read the file through the fs plugin and inline it first.
        const tauriFilePath = isTauri() ? extractTauriAssetFsPath(source) : null
        try {
            if (tauriFilePath) {
                const bytes = await platformService.readFile(tauriFilePath)
                await setInlineSource(await blobToDataUrl(new Blob([bytes], { type: imageMimeFromPath(tauriFilePath) || 'application/octet-stream' })))
            } else if (/^(https?:|blob:)/i.test(source)) {
                // PWA media is persisted as a relative path and displayed from
                // R2. html-to-image fetches that URL again while serializing its
                // SVG foreignObject; WebKit can drop that second request and
                // replace it with the transparent image placeholder. Inline the
                // source before capture so the clone contains pixels rather
                // than another network dependency.
                const response = await fetch(source, {
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer'
                })
                if (!response.ok) {
                    throw new Error(`Image request failed with status ${response.status}.`)
                }

                const blob = await response.blob()
                const mimeType = blob.type.startsWith('image/')
                    ? blob.type
                    : imageMimeFromPath(source)
                if (!mimeType) {
                    throw new Error(`Expected an image response but received ${blob.type || 'an unknown content type'}.`)
                }
                await setInlineSource(await blobToDataUrl(blob.type === mimeType ? blob : new Blob([blob], { type: mimeType })))
            } else {
                return
            }
        } catch (error) {
            // A failed replacement should not make a previously loaded image
            // disappear from the best-effort capture fallback.
            if (originalSrc === null) image.removeAttribute('src')
            else image.setAttribute('src', originalSrc)
            if (originalSrcSet === null) image.removeAttribute('srcset')
            else image.setAttribute('srcset', originalSrcSet)
            if (originalSizes === null) image.removeAttribute('sizes')
            else image.setAttribute('sizes', originalSizes)

            // Preserve the loaded source as a best-effort fallback for an
            // external image. Workspace media normally takes the R2 branch
            // above, so its PDF capture no longer depends on html-to-image
            // making a second WebKit network request.
            console.warn('[pdfGenerator] Failed to inline image for PDF capture:', source, error)
        }
    }

    await Promise.all(Array.from(
        { length: Math.min(PDF_IMAGE_INLINE_CONCURRENCY, images.length) },
        async () => {
            while (nextImageIndex < images.length) {
                const image = images[nextImageIndex]
                nextImageIndex += 1
                await inlineImage(image)
            }
        }
    ))
}
