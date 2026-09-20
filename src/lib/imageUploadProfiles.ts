export type ImageUploadSource =
    | 'product-primary'
    | 'product-additional'
    | 'product-variant'
    | 'service-image'
    | 'activity-image'
    | 'workspace-logo'
    | 'profile-image'
    | 'print-attachment'
    | 'print-watermark'
    | 'clinical-attachment'
    | 'generic-upload'

export interface ImageUploadProfile {
    readonly source: ImageUploadSource
    readonly version: 1
    readonly maxDimension: number
    readonly startQuality: number
    readonly minimumQuality: number
    readonly qualityStep: number
    readonly softTargetBytes: number
    readonly maxInputBytes: number
    readonly maxInputPixels: number
}

const MIB = 1024 * 1024
const KIB = 1024

function profile(
    source: ImageUploadSource,
    values: Omit<ImageUploadProfile, 'source' | 'version' | 'maxInputBytes' | 'maxInputPixels'>,
): ImageUploadProfile {
    return {
        source,
        version: 1,
        maxInputBytes: 25 * MIB,
        maxInputPixels: 40_000_000,
        ...values,
    }
}

/**
 * The registry is deliberately the only place where upload quality is tuned.
 * Callers choose a semantic source; they cannot provide arbitrary dimensions
 * or quality values and accidentally bypass the measured policy.
 */
export const IMAGE_UPLOAD_PROFILES: Readonly<Record<ImageUploadSource, ImageUploadProfile>> = {
    'product-primary': profile('product-primary', { maxDimension: 2048, startQuality: 0.90, minimumQuality: 0.84, qualityStep: 0.03, softTargetBytes: 700 * KIB }),
    'product-additional': profile('product-additional', { maxDimension: 2048, startQuality: 0.90, minimumQuality: 0.84, qualityStep: 0.03, softTargetBytes: 700 * KIB }),
    'product-variant': profile('product-variant', { maxDimension: 2048, startQuality: 0.90, minimumQuality: 0.84, qualityStep: 0.03, softTargetBytes: 700 * KIB }),
    'service-image': profile('service-image', { maxDimension: 2048, startQuality: 0.90, minimumQuality: 0.84, qualityStep: 0.03, softTargetBytes: 700 * KIB }),
    'activity-image': profile('activity-image', { maxDimension: 1600, startQuality: 0.86, minimumQuality: 0.80, qualityStep: 0.03, softTargetBytes: 450 * KIB }),
    'workspace-logo': profile('workspace-logo', { maxDimension: 512, startQuality: 1, minimumQuality: 0.78, qualityStep: 0.04, softTargetBytes: 120 * KIB }),
    'profile-image': profile('profile-image', { maxDimension: 512, startQuality: 0.84, minimumQuality: 0.78, qualityStep: 0.03, softTargetBytes: 120 * KIB }),
    'print-attachment': profile('print-attachment', { maxDimension: 2560, startQuality: 0.92, minimumQuality: 0.88, qualityStep: 0.02, softTargetBytes: 1536 * KIB }),
    'print-watermark': profile('print-watermark', { maxDimension: 2560, startQuality: 0.92, minimumQuality: 0.88, qualityStep: 0.02, softTargetBytes: 1536 * KIB }),
    'clinical-attachment': profile('clinical-attachment', { maxDimension: 2560, startQuality: 0.92, minimumQuality: 0.88, qualityStep: 0.02, softTargetBytes: 1536 * KIB }),
    'generic-upload': profile('generic-upload', { maxDimension: 2560, startQuality: 0.92, minimumQuality: 0.88, qualityStep: 0.02, softTargetBytes: 1536 * KIB }),
}

export const IMAGE_UPLOAD_STORAGE_ROOTS: Readonly<Record<ImageUploadSource, string>> = {
    'product-primary': 'product-images',
    'product-additional': 'product-images',
    'product-variant': 'product-images',
    'service-image': 'product-images',
    'activity-image': 'activity-images',
    'workspace-logo': 'workspace-logos',
    'profile-image': 'profile-images',
    'print-attachment': 'attached-images',
    'print-watermark': 'attached-images',
    'clinical-attachment': 'clinic-attachments',
    'generic-upload': 'uploads',
}

export function getImageUploadProfile(source: ImageUploadSource): ImageUploadProfile {
    return IMAGE_UPLOAD_PROFILES[source]
}

export function isImageUploadSource(value: string): value is ImageUploadSource {
    return Object.prototype.hasOwnProperty.call(IMAGE_UPLOAD_PROFILES, value)
}
