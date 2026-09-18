import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd'
import { GripVertical, ImagePlus, Images, LoaderCircle, Package, X } from 'lucide-react'

import { supabase } from '@/auth/supabase'
import { assetManager } from '@/lib/assetManager'
import { getProductImageDisplayUrl, isProductImagePath, storeProductImageFile } from '@/lib/productImageStorage'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { cn, generateId } from '@/lib/utils'
import { ReorderablePickerGrid } from '@/ui/components/ReorderablePickerGrid'
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    useToast
} from '@/ui/components'

const MAX_ADDITIONAL_IMAGES = 9
const EMPTY_DRAFT_FILES: File[] = []

type StoredProductImage = {
    id: string
    imageUrl: string
    position: number
}

type ProductImageDraft = {
    clientId: string
    id?: string
    imageUrl?: string
    previewUrl: string
    file?: File
}

type ProductImageRow = {
    id: string
    image_url: string
    position: number
}

function toStoredProductImage(row: ProductImageRow): StoredProductImage {
    return {
        id: row.id,
        imageUrl: row.image_url,
        position: row.position
    }
}

function createDraftFromStoredImage(image: StoredProductImage): ProductImageDraft {
    return {
        clientId: image.id,
        id: image.id,
        imageUrl: image.imageUrl,
        previewUrl: image.imageUrl
    }
}

export function ProductAdditionalImagesModal({
    open,
    onOpenChange,
    workspaceId,
    productId,
    productName,
    primaryImageUrl,
    canManage,
    draftFiles = EMPTY_DRAFT_FILES,
    onDraftFilesChange
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    productId?: string
    productName?: string
    primaryImageUrl?: string
    canManage: boolean
    draftFiles?: File[]
    onDraftFilesChange?: (files: File[]) => void
}) {
    const { toast } = useToast()
    const inputRef = useRef<HTMLInputElement>(null)
    const previewUrlsRef = useRef(new Set<string>())
    const [savedImages, setSavedImages] = useState<StoredProductImage[]>([])
    const [draftImages, setDraftImages] = useState<ProductImageDraft[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const isDraftMode = !productId && Boolean(onDraftFilesChange)

    const imageCount = draftImages.length + (primaryImageUrl ? 1 : 0)
    const canAddImages = canManage && draftImages.length < MAX_ADDITIONAL_IMAGES && !isSaving

    const revokePreviewUrl = useCallback((url?: string) => {
        if (!url || !previewUrlsRef.current.delete(url)) return
        URL.revokeObjectURL(url)
    }, [])

    const revokeAllPreviewUrls = useCallback(() => {
        for (const url of previewUrlsRef.current) {
            URL.revokeObjectURL(url)
        }
        previewUrlsRef.current.clear()
    }, [])

    const applyStoredImages = useCallback((images: StoredProductImage[]) => {
        const normalized = [...images].sort((left, right) => left.position - right.position)
        setSavedImages(normalized)
        setDraftImages(normalized.map(createDraftFromStoredImage))
    }, [])

    const applyDraftFiles = useCallback((files: File[]) => {
        revokeAllPreviewUrls()
        setSavedImages([])
        setDraftImages(files.map((file) => {
            const previewUrl = URL.createObjectURL(file)
            previewUrlsRef.current.add(previewUrl)
            return {
                clientId: `new-${generateId()}`,
                previewUrl,
                file
            }
        }))
    }, [revokeAllPreviewUrls])

    const loadImages = useCallback(async () => {
        if (!workspaceId || !productId) {
            applyStoredImages([])
            return
        }

        setIsLoading(true)
        try {
            const { data, error } = await runSupabaseAction('product_images.fetch', () =>
                supabase
                    .from('product_images')
                    .select('id, image_url, position')
                    .eq('workspace_id', workspaceId)
                    .eq('product_id', productId)
                    .order('position', { ascending: true })
            )

            if (error) throw error
            revokeAllPreviewUrls()
            applyStoredImages(((data || []) as ProductImageRow[]).map(toStoredProductImage))
        } catch (error) {
            console.error('[ProductImages] Failed to load additional images:', error)
            toast({
                variant: 'destructive',
                title: 'Unable to load images',
                description: normalizeSupabaseActionError(error).message
            })
        } finally {
            setIsLoading(false)
        }
    }, [applyStoredImages, productId, revokeAllPreviewUrls, toast, workspaceId])

    useEffect(() => {
        if (open) {
            if (isDraftMode) {
                applyDraftFiles(draftFiles)
                return
            }
            void loadImages()
        }
    }, [applyDraftFiles, draftFiles, isDraftMode, loadImages, open])

    useEffect(() => () => revokeAllPreviewUrls(), [revokeAllPreviewUrls])

    const discardChanges = () => {
        if (isSaving) return
        revokeAllPreviewUrls()
        if (!isDraftMode) {
            applyStoredImages(savedImages)
        }
        onOpenChange(false)
    }

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) {
            discardChanges()
            return
        }
        onOpenChange(true)
    }

    const handleFilesAdded = (files: FileList | File[]) => {
        if (!canAddImages) return

        const remainingSlots = MAX_ADDITIONAL_IMAGES - draftImages.length
        const selected = Array.from(files)
        const validFiles = selected.slice(0, remainingSlots)

        if (validFiles.length !== selected.length) {
            toast({
                variant: 'destructive',
                title: 'Some images were not added',
                description: `A product can have up to ${MAX_ADDITIONAL_IMAGES} additional images.`
            })
        }

        if (validFiles.length === 0) return

        const newDrafts = validFiles.map((file) => {
            const previewUrl = URL.createObjectURL(file)
            previewUrlsRef.current.add(previewUrl)
            return {
                clientId: `new-${generateId()}`,
                previewUrl,
                file
            }
        })
        setDraftImages((current) => [...current, ...newDrafts])
    }

    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files) {
            handleFilesAdded(event.target.files)
        }
        event.target.value = ''
    }

    const removeDraftImage = (clientId: string) => {
        if (!canManage || isSaving) return
        setDraftImages((current) => {
            const image = current.find((item) => item.clientId === clientId)
            revokePreviewUrl(image?.file ? image.previewUrl : undefined)
            return current.filter((item) => item.clientId !== clientId)
        })
    }

    const handleSave = async () => {
        if (isDraftMode) {
            onDraftFilesChange?.(draftImages.flatMap((image) => image.file ? [image.file] : []))
            revokeAllPreviewUrls()
            onOpenChange(false)
            return
        }

        if (!workspaceId || !productId || !canManage || isSaving) return

        setIsSaving(true)
        const uploadedImageUrls: string[] = []
        try {
            const finalImagePayload: Array<{ id?: string; image_url: string }> = []

            for (const draft of draftImages) {
                if (draft.id && draft.imageUrl && isProductImagePath(draft.imageUrl)) {
                    finalImagePayload.push({ id: draft.id, image_url: draft.imageUrl })
                    continue
                }

                if (!draft.file) {
                    throw new Error('An additional image is missing its file.')
                }

                const imageUrl = await storeProductImageFile(draft.file, workspaceId)
                if (!imageUrl) {
                    throw new Error(`Unable to store ${draft.file.name}.`)
                }

                uploadedImageUrls.push(imageUrl)
                finalImagePayload.push({ image_url: imageUrl })
            }

            const { data, error } = await runSupabaseAction('product_images.replace', () =>
                supabase.rpc('replace_product_images', {
                    p_workspace_id: workspaceId,
                    p_product_id: productId,
                    p_images: finalImagePayload
                })
            )

            if (error) throw error

            const nextSavedImages = ((data || []) as ProductImageRow[]).map(toStoredProductImage)
            const retainedIds = new Set(draftImages.flatMap((image) => image.id ? [image.id] : []))
            const removedImages = savedImages.filter((image) => !retainedIds.has(image.id))

            revokeAllPreviewUrls()
            applyStoredImages(nextSavedImages)

            // The database row is already hard-deleted at this point. Storage
            // cleanup intentionally follows the same best-effort behavior as
            // primary-image removal and never rolls back a successful row save.
            await Promise.all(removedImages.map((image) => assetManager.deleteAsset(image.imageUrl)))

            toast({ title: 'Images saved', description: 'The additional image order has been updated.' })
        } catch (error) {
            // No row collection is committed when the RPC fails. Files uploaded
            // in this attempt are cleaned up and drafts stay visible for retry.
            await Promise.all(uploadedImageUrls.map((imageUrl) => assetManager.deleteAsset(imageUrl)))
            console.error('[ProductImages] Failed to save additional images:', error)
            toast({
                variant: 'destructive',
                title: 'Unable to save images',
                description: normalizeSupabaseActionError(error).message
            })
        } finally {
            setIsSaving(false)
        }
    }

    const renderAdditionalImage = (
        image: ProductImageDraft,
        dragHandleProps: DraggableProvidedDragHandleProps | null,
        isDragging: boolean
    ) => (
        <div className={cn(
            'group relative aspect-square overflow-hidden rounded-2xl border bg-muted shadow-sm transition-shadow',
            isDragging && 'rotate-2 shadow-xl ring-2 ring-primary/40'
        )}>
            <img
                // Object URLs exist only for unsaved local drafts. Persisted
                // product images always go through the strict R2/file resolver.
                src={image.file ? image.previewUrl : getProductImageDisplayUrl(image.previewUrl)}
                alt="Additional product image"
                className="h-full w-full object-cover"
            />
            {canManage && (
                <>
                    <button
                        type="button"
                        aria-label="Reorder image"
                        className="absolute bottom-2 left-2 inline-flex h-8 w-8 touch-none items-center justify-center rounded-full bg-black/65 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100 focus:opacity-100"
                        {...dragHandleProps}
                    >
                        <GripVertical className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        aria-label="Remove image"
                        onClick={() => removeDraftImage(image.clientId)}
                        className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity hover:bg-destructive/90 group-hover:opacity-100 focus:opacity-100"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </>
            )}
        </div>
    )

    const modalDescription = useMemo(() => {
        if (isDraftMode) return 'Add or reorder images now. They will be saved when the product is created.'
        if (canManage) return 'Upload, remove, or drag additional images to set their display order.'
        return 'The primary image stays first. Additional images are view-only for your role.'
    }, [canManage, isDraftMode])

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-3xl overflow-hidden rounded-3xl p-0 sm:max-w-4xl">
                <DialogHeader className="border-b bg-muted/25 px-6 py-5 sm:px-8">
                    <div className="flex items-start justify-between gap-4 pr-8">
                        <div className="min-w-0">
                            <DialogTitle className="flex items-center gap-2 text-xl font-black">
                                <Images className="h-5 w-5 text-primary" />
                                Additional Images
                            </DialogTitle>
                            <DialogDescription className="mt-1.5 max-w-xl text-sm">
                                {modalDescription}
                            </DialogDescription>
                        </div>
                        <div className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-sm font-black text-primary">
                            {imageCount}/10
                        </div>
                    </div>
                </DialogHeader>

                <div className="max-h-[65vh] space-y-6 overflow-y-auto px-6 py-6 sm:px-8">
                    {productName ? (
                        <p className="-mb-2 truncate text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                            {productName}
                        </p>
                    ) : null}

                    <section className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-black">Primary image</h3>
                            <span className="text-xs font-medium text-muted-foreground">Always first · position 0</span>
                        </div>
                        <div className="relative aspect-square w-36 overflow-hidden rounded-2xl border-2 border-primary/30 bg-muted shadow-sm sm:w-40">
                            {primaryImageUrl ? (
                                <img
                                    src={getProductImageDisplayUrl(primaryImageUrl)}
                                    alt="Primary product image"
                                    className="h-full w-full object-cover"
                                />
                            ) : (
                                <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-muted-foreground">
                                    <Package className="h-8 w-8" />
                                    <span className="text-xs font-semibold">No primary image</span>
                                </div>
                            )}
                            <span className="absolute left-2 top-2 rounded-full bg-primary px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-primary-foreground shadow-sm">
                                Primary
                            </span>
                        </div>
                    </section>

                    <section className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <h3 className="text-sm font-black">Additional images</h3>
                                <p className="text-xs text-muted-foreground">Drag images to reorder. The primary image cannot be moved.</p>
                            </div>
                            <span className="text-xs font-semibold text-muted-foreground">{draftImages.length}/{MAX_ADDITIONAL_IMAGES} additional</span>
                        </div>

                        {isLoading ? (
                            <div className="flex min-h-44 items-center justify-center rounded-2xl border border-dashed bg-muted/20 text-sm text-muted-foreground">
                                <LoaderCircle className="mr-2 h-5 w-5 animate-spin" />
                                Loading images…
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                                {canManage ? (
                                    <ReorderablePickerGrid
                                        droppableId={`product-images-${productId || 'new'}`}
                                        items={draftImages}
                                        getItemId={(image) => image.clientId}
                                        onItemsSwap={setDraftImages}
                                        className="contents"
                                        renderItem={renderAdditionalImage}
                                    />
                                ) : draftImages.map((image) => (
                                    <div key={image.clientId}>
                                        {renderAdditionalImage(image, null, false)}
                                    </div>
                                ))}
                                {canAddImages ? (
                                    <button
                                        type="button"
                                        onClick={() => inputRef.current?.click()}
                                        className="flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/25 bg-primary/[0.03] p-4 text-center text-primary transition-colors hover:border-primary/60 hover:bg-primary/[0.07]"
                                    >
                                        <ImagePlus className="h-7 w-7" />
                                        <span className="text-xs font-black">Add images</span>
                                    </button>
                                ) : null}
                            </div>
                        )}
                        <input
                            ref={inputRef}
                            type="file"
                            className="hidden"
                            accept="image/*"
                            multiple
                            disabled={!canAddImages}
                            onChange={handleInputChange}
                        />
                    </section>
                </div>

                <DialogFooter className="border-t bg-muted/15 px-6 py-4 sm:px-8">
                    <Button type="button" variant="outline" onClick={discardChanges} disabled={isSaving}>
                        Cancel
                    </Button>
                    {canManage ? (
                        <Button type="button" onClick={() => void handleSave()} disabled={isLoading || isSaving} className="min-w-32">
                            {isSaving ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
                            {isDraftMode ? 'Apply Images' : 'Save Images'}
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
