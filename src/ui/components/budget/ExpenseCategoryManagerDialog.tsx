import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderCog, Loader2, Pencil, Plus, Tags, Trash2 } from 'lucide-react'
import {
    createExpenseCategory,
    deleteExpenseCategory,
    DuplicateExpenseCategoryNameError,
    ExpenseCategoryInUseError,
    updateExpenseCategory,
    useExpenseCategories
} from '@/local-db'
import type { ExpenseCategory } from '@/local-db/models'
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
  useToast,
} from '@/ui/components'

interface ExpenseCategoryManagerDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
}

export function ExpenseCategoryManagerDialog({
    open,
    onOpenChange,
    workspaceId
}: ExpenseCategoryManagerDialogProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const categories = useExpenseCategories(workspaceId)
    const [editingCategory, setEditingCategory] = useState<ExpenseCategory | null>(null)
    const [categoryName, setCategoryName] = useState('')
    const [categoryToDelete, setCategoryToDelete] = useState<ExpenseCategory | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const isProcessing = isSaving || isDeleting
    const normalizedName = categoryName.trim()

    const resetForm = () => {
        setEditingCategory(null)
        setCategoryName('')
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

    const handleSave = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!normalizedName || isSaving) {
            return
        }

        setIsSaving(true)
        try {
            if (editingCategory) {
                await updateExpenseCategory(editingCategory.id, normalizedName)
                toast({
                    title: t('common.success'),
                    description: t('budget.expenseCategories.updated')
                })
            } else {
                await createExpenseCategory(workspaceId, normalizedName)
                toast({
                    title: t('common.success'),
                    description: t('budget.expenseCategories.created')
                })
            }
            resetForm()
        } catch (error) {
            toast({
                title: t('common.error'),
                description: error instanceof DuplicateExpenseCategoryNameError
                    ? t('budget.expenseCategories.duplicate')
                    : t('budget.expenseCategories.saveFailed'),
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
            await deleteExpenseCategory(categoryToDelete.id)
            if (editingCategory?.id === categoryToDelete.id) {
                resetForm()
            }
            setCategoryToDelete(null)
            toast({
                title: t('common.success'),
                description: t('budget.expenseCategories.deleted')
            })
        } catch (error) {
            toast({
                title: t('common.error'),
                description: error instanceof ExpenseCategoryInUseError
                    ? t('budget.expenseCategories.inUse')
                    : t('budget.expenseCategories.deleteFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsDeleting(false)
        }
    }

    const startEditing = (category: ExpenseCategory) => {
        if (isProcessing) {
            return
        }
        setEditingCategory(category)
        setCategoryName(category.name)
    }

    return (
        <>
            <AppDialog open={open} onOpenChange={handleOpenChange}>
                <AppDialogContent className="max-w-2xl" showCloseButton={!isProcessing}>
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <FolderCog className="h-5 w-5 text-primary" />
                            {t('budget.expenseCategories.title')}
                        </AppDialogTitle>
                        <p className="text-sm text-muted-foreground">
                            {t('budget.expenseCategories.description')}
                        </p>
                    </AppDialogHeader>

                    <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
                        <AppDialogBody className="space-y-6">
                            <section className="rounded-xl border border-border/70 bg-muted/20 p-4">
                                <div className="mb-4 flex items-center gap-2">
                                    <Tags className="h-4 w-4 text-primary" />
                                    <h3 className="font-semibold">
                                        {editingCategory
                                            ? t('budget.expenseCategories.editTitle')
                                            : t('budget.expenseCategories.addTitle')}
                                    </h3>
                                </div>
                                <div className="grid gap-2">
                                    <Label htmlFor="expense-category-name">
                                        {t('budget.expenseCategories.name')} <span className="text-destructive">*</span>
                                    </Label>
                                    <Input
                                        id="expense-category-name"
                                        value={categoryName}
                                        onChange={(event) => setCategoryName(event.target.value)}
                                        placeholder={t('budget.expenseCategories.namePlaceholder')}
                                        disabled={isProcessing}
                                        autoFocus={open}
                                    />
                                </div>
                            </section>

                            <section className="space-y-3">
                                <div className="flex items-center gap-2">
                                    <Tags className="h-4 w-4 text-muted-foreground" />
                                    <h3 className="font-semibold">{t('budget.expenseCategories.title')}</h3>
                                </div>
                                {categories.length === 0 ? (
                                    <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                                        {t('budget.expenseCategories.empty')}
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
                                                <span className="min-w-0 flex-1 truncate font-medium">{category.name}</span>
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
                                disabled={isProcessing || (!editingCategory && !categoryName)}
                            >
                                {t('common.cancel')}
                            </Button>
                            <Button type="submit" disabled={!normalizedName || isProcessing}>
                                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                                {editingCategory
                                    ? t('budget.expenseCategories.save')
                                    : t('budget.expenseCategories.create')}
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
                title={t('budget.expenseCategories.deleteTitle')}
                description={t('budget.expenseCategories.deleteDescription')}
                itemName={categoryToDelete?.name}
                isLoading={isDeleting}
            />
        </>
    )
}
