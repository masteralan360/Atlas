import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderCog, Loader2, Pencil, Plus, Tags, Trash2 } from 'lucide-react'
import { createCategory, deleteCategory, updateCategory, useCategories } from '@/local-db'
import type { Category } from '@/local-db/models'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Label,
  Textarea,
  useToast,
} from '@/ui/components'

interface ProductCategoryManagerDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
}

export function ProductCategoryManagerDialog({
    open,
    onOpenChange,
    workspaceId
}: ProductCategoryManagerDialogProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const categories = useCategories(workspaceId)
    const [editingCategory, setEditingCategory] = useState<Category | null>(null)
    const [categoryName, setCategoryName] = useState('')
    const [categoryDescription, setCategoryDescription] = useState('')
    const [categoryToDelete, setCategoryToDelete] = useState<Category | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const isProcessing = isSaving || isDeleting
    const normalizedName = categoryName.trim()

    const resetForm = () => {
        setEditingCategory(null)
        setCategoryName('')
        setCategoryDescription('')
    }

    const handleOpenChange = (nextOpen: boolean) => {
        if (isProcessing) {
            return
        }

        if (!nextOpen) {
            resetForm()
        }
        onOpenChange(nextOpen)
    }

    const startEditing = (category: Category) => {
        if (isProcessing) {
            return
        }

        setEditingCategory(category)
        setCategoryName(category.name)
        setCategoryDescription(category.description || '')
    }

    const handleSave = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!normalizedName || isSaving) {
            return
        }

        const hasDuplicateName = categories.some((category) =>
            category.id !== editingCategory?.id
            && category.name.trim().toLocaleLowerCase() === normalizedName.toLocaleLowerCase()
        )
        if (hasDuplicateName) {
            toast({
                title: t('common.error'),
                description: t('categories.messages.duplicateName'),
                variant: 'destructive'
            })
            return
        }

        setIsSaving(true)
        try {
            const categoryData = {
                name: normalizedName,
                description: categoryDescription.trim()
            }
            if (editingCategory) {
                await updateCategory(editingCategory.id, categoryData)
                toast({
                    title: t('common.success'),
                    description: t('categories.manager.updated')
                })
            } else {
                await createCategory(workspaceId, categoryData)
                toast({
                    title: t('common.success'),
                    description: t('categories.manager.created')
                })
            }
            resetForm()
        } catch {
            toast({
                title: t('common.error'),
                description: t('categories.manager.saveFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    const handleDelete = async () => {
        if (!categoryToDelete || isDeleting) {
            return
        }

        setIsDeleting(true)
        try {
            await deleteCategory(categoryToDelete.id)
            if (editingCategory?.id === categoryToDelete.id) {
                resetForm()
            }
            setCategoryToDelete(null)
            toast({
                title: t('common.success'),
                description: t('categories.manager.deleted')
            })
        } catch {
            toast({
                title: t('common.error'),
                description: t('categories.manager.deleteFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <>
            <AppDialog open={open} onOpenChange={handleOpenChange}>
                <AppDialogContent className="max-w-2xl" showCloseButton={!isProcessing}>
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <FolderCog className="h-5 w-5 text-primary" />
                            {t('categories.manager.title')}
                        </AppDialogTitle>
                        <p className="text-sm text-muted-foreground">
                            {t('categories.manager.description')}
                        </p>
                    </AppDialogHeader>

                    <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
                        <AppDialogBody className="space-y-6">
                            <section className="rounded-xl border border-border/70 bg-muted/20 p-4">
                                <div className="mb-4 flex items-center gap-2">
                                    <Tags className="h-4 w-4 text-primary" />
                                    <h3 className="font-semibold">
                                        {editingCategory
                                            ? t('categories.manager.editTitle')
                                            : t('categories.manager.addTitle')}
                                    </h3>
                                </div>
                                <div className="grid gap-4">
                                    <div className="grid gap-2">
                                        <Label htmlFor="product-category-name">
                                            {t('categories.form.name')} <span className="text-destructive">*</span>
                                        </Label>
                                        <Input
                                            id="product-category-name"
                                            value={categoryName}
                                            onChange={(event) => setCategoryName(event.target.value)}
                                            placeholder={t('categories.manager.namePlaceholder')}
                                            disabled={isProcessing}
                                            autoFocus={open}
                                        />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="product-category-description">
                                            {t('categories.form.description')}
                                        </Label>
                                        <Textarea
                                            id="product-category-description"
                                            value={categoryDescription}
                                            onChange={(event) => setCategoryDescription(event.target.value)}
                                            placeholder={t('categories.manager.descriptionPlaceholder')}
                                            disabled={isProcessing}
                                            rows={3}
                                        />
                                    </div>
                                </div>
                            </section>

                            <section className="space-y-3">
                                <div className="flex items-center gap-2">
                                    <Tags className="h-4 w-4 text-muted-foreground" />
                                    <h3 className="font-semibold">{t('categories.manager.title')}</h3>
                                </div>
                                {categories.length === 0 ? (
                                    <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                                        {t('categories.manager.empty')}
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {categories.map((category) => (
                                            <div
                                                key={category.id}
                                                className="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5"
                                            >
                                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                                                    <Tags className="h-4 w-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate font-medium">{category.name}</div>
                                                    {category.description ? (
                                                        <div className="truncate text-xs text-muted-foreground">{category.description}</div>
                                                    ) : null}
                                                </div>
                                                <div className="flex shrink-0 items-center gap-1">
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8"
                                                        aria-label={t('common.edit')}
                                                        onClick={() => startEditing(category)}
                                                        disabled={isProcessing}
                                                    >
                                                        <Pencil className="h-4 w-4" />
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 text-destructive hover:text-destructive"
                                                        aria-label={t('common.delete')}
                                                        onClick={() => setCategoryToDelete(category)}
                                                        disabled={isProcessing}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </section>
                        </AppDialogBody>
                        <AppDialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={resetForm}
                                disabled={isProcessing || (!editingCategory && !categoryName && !categoryDescription)}
                            >
                                {t('common.cancel')}
                            </Button>
                            <Button type="submit" disabled={!normalizedName || isProcessing}>
                                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                                {editingCategory
                                    ? t('categories.manager.save')
                                    : t('categories.manager.create')}
                            </Button>
                        </AppDialogFooter>
                    </form>
                </AppDialogContent>
            </AppDialog>

            <DeleteConfirmationModal
                isOpen={!!categoryToDelete}
                onClose={() => {
                    if (!isDeleting) {
                        setCategoryToDelete(null)
                    }
                }}
                onConfirm={() => { void handleDelete() }}
                title={t('categories.manager.deleteTitle')}
                description={t('categories.manager.deleteDescription')}
                itemName={categoryToDelete?.name}
                isLoading={isDeleting}
            />
        </>
    )
}
