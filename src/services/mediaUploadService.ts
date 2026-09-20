import { compressImage, ImageCompressionError, type CompressedImageArtifact, type ImageCompressionErrorCode } from '@/lib/imageCompression'
import { IMAGE_UPLOAD_STORAGE_ROOTS, type ImageUploadSource } from '@/lib/imageUploadProfiles'
import { isTauri } from '@/lib/platform'
import { isDemoWorkspaceMode, isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { platformService } from '@/services/platformService'
import { r2Service } from '@/services/r2Service'

export type MediaUploadErrorCode = 'cloud_required' | 'upload_failed'

export class MediaUploadError extends Error {
    constructor(public readonly code: MediaUploadErrorCode) {
        super(code)
        this.name = 'MediaUploadError'
    }
}

export function getMediaUploadErrorCode(error: unknown): ImageCompressionErrorCode | MediaUploadErrorCode | null {
    if (error instanceof ImageCompressionError || error instanceof MediaUploadError) return error.code
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    if (['empty_image', 'image_too_large', 'unsupported_image', 'animated_image', 'image_decode_failed', 'image_processing_failed', 'cloud_required', 'upload_failed'].includes(code)) {
        return code as ImageCompressionErrorCode | MediaUploadErrorCode
    }
    return null
}

export interface StoredImage {
    readonly path: string
    readonly r2Key: string | null
    readonly artifact: CompressedImageArtifact
}

async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new MediaUploadError('upload_failed'))
        reader.readAsDataURL(blob)
    })
}

class MediaUploadService {
    async storeImageFile(file: File, workspaceId: string, folder: string, source: ImageUploadSource): Promise<StoredImage> {
        const artifact = await compressImage(file, source)
        return this.storeCompressedImage(artifact, workspaceId, folder)
    }

    async storeCompressedImage(artifact: CompressedImageArtifact, workspaceId: string, folder: string): Promise<StoredImage> {
        const normalizedFolder = folder.replace(/^\/+|\/+$/g, '')
        if (normalizedFolder.split('/')[0] !== IMAGE_UPLOAD_STORAGE_ROOTS[artifact.source]) {
            throw new MediaUploadError('upload_failed')
        }
        const relativePath = `${normalizedFolder}/${workspaceId}/${artifact.file.name}`
        const r2Key = `${workspaceId}/${normalizedFolder}/${artifact.file.name}`
        const localOnly = isLocalWorkspaceMode(workspaceId) || isDemoWorkspaceMode(workspaceId)

        if (localOnly && !isTauri()) {
            return { path: await blobToDataUrl(artifact.file), r2Key: null, artifact }
        }

        let localPath: string | null = null
        if (isTauri()) {
            localPath = await platformService.persistImageFile(artifact.file, workspaceId, normalizedFolder)
            if (!localPath) throw new MediaUploadError('upload_failed')
        }

        if (localOnly) return { path: localPath || relativePath, r2Key: null, artifact }
        if (!r2Service.isConfigured()) {
            if (localPath) await platformService.removeFile(localPath).catch(() => false)
            throw new MediaUploadError('cloud_required')
        }

        try {
            await r2Service.uploadCompressedImage(r2Key, artifact)
        } catch (error) {
            if (localPath) await platformService.removeFile(localPath).catch(() => false)
            console.error('[MediaUploadService] Compressed image upload failed:', error)
            throw new MediaUploadError('upload_failed')
        }
        return { path: localPath || relativePath, r2Key, artifact }
    }
}

export const mediaUploadService = new MediaUploadService()
