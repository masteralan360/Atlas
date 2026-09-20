import { supabase } from '@/auth/supabase'
import { assetManager } from '@/lib/assetManager'
import { storeProductImageFile } from '@/lib/productImageStorage'
import { runSupabaseAction } from '@/lib/supabaseRequest'

/**
 * Persists images selected while a product is still being created. The primary
 * image remains on the product record; these files become its ordered gallery.
 */
export async function saveInitialProductAdditionalImages(
    workspaceId: string,
    productId: string,
    files: File[]
) {
    if (!workspaceId || !productId || files.length === 0) return

    const uploadedImageUrls: string[] = []
    try {
        const images: Array<{ image_url: string }> = []

        for (const file of files) {
            const imageUrl = await storeProductImageFile(file, workspaceId, 'product-additional')
            if (!imageUrl) {
                throw new Error(`Unable to store ${file.name}.`)
            }

            uploadedImageUrls.push(imageUrl)
            images.push({ image_url: imageUrl })
        }

        const { error } = await runSupabaseAction('product_images.replace', () =>
            supabase.rpc('replace_product_images', {
                p_workspace_id: workspaceId,
                p_product_id: productId,
                p_images: images
            })
        )
        if (error) throw error
    } catch (error) {
        await Promise.all(uploadedImageUrls.map((imageUrl) => assetManager.deleteAsset(imageUrl)))
        throw error
    }
}
