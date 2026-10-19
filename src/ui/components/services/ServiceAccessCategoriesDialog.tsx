import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FolderKey, Loader2, Pencil, Plus, Save, Shield, Trash2, Users, X } from 'lucide-react'

import {
  createServiceAccessCategory,
  deleteServiceAccessCategory,
  listServiceAccessCategories,
  listServiceAccessCategoryMembers,
  listServiceAccessWorkspaceMembers,
  renameServiceAccessCategory,
  setServiceAccessCategoryMembers,
  type ServiceAccessCategorySummary,
  type ServiceAccessCategoryMemberAssignment,
  type ServiceAccessWorkspaceMember,
} from '@/local-db'
import { Button, Checkbox, Label, AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle, useToast } from '@/ui/components'
import { Input } from '@/ui/components/input'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'

interface ServiceAccessCategoriesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
}

function normalizeMembersByCategory(rows: ServiceAccessCategoryMemberAssignment[]) {
  const result = new Map<string, Set<string>>()
  for (const row of rows) {
    const userIds = result.get(row.categoryId) ?? new Set<string>()
    userIds.add(row.userId)
    result.set(row.categoryId, userIds)
  }
  return result
}

export function ServiceAccessCategoriesDialog({ open, onOpenChange, workspaceId }: ServiceAccessCategoriesDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [categories, setCategories] = useState<ServiceAccessCategorySummary[]>([])
  const [membersByCategory, setMembersByCategory] = useState<Map<string, Set<string>>>(new Map())
  const [workspaceMembers, setWorkspaceMembers] = useState<ServiceAccessWorkspaceMember[]>([])
  const [activeCategoryId, setActiveCategoryId] = useState('')
  const [editingCategoryId, setEditingCategoryId] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [categoryToDelete, setCategoryToDelete] = useState<ServiceAccessCategorySummary | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const activeCategory = categories.find((category) => category.id === activeCategoryId) ?? null
  const isProcessing = isSaving || isDeleting
  const normalizedCategoryName = categoryName.trim()
  const activeMemberIds = useMemo(
    () => membersByCategory.get(activeCategoryId) ?? new Set<string>(),
    [activeCategoryId, membersByCategory],
  )
  const hasMembershipChanges = useMemo(() => {
    if (!activeCategoryId) return false
    if (selectedUserIds.length !== activeMemberIds.size) return true
    return selectedUserIds.some((id) => !activeMemberIds.has(id))
  }, [activeCategoryId, activeMemberIds, selectedUserIds])

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setLoadFailed(false)
    try {
      const [nextCategories, memberships, nextWorkspaceMembers] = await Promise.all([
        listServiceAccessCategories(workspaceId),
        listServiceAccessCategoryMembers(workspaceId),
        listServiceAccessWorkspaceMembers(workspaceId),
      ])
      const nextMemberships = normalizeMembersByCategory(memberships)
      setCategories(nextCategories)
      setMembersByCategory(nextMemberships)
      setWorkspaceMembers(nextWorkspaceMembers)
      setActiveCategoryId((current) => nextCategories.some((category) => category.id === current)
        ? current
        : nextCategories[0]?.id ?? '')
    } catch (error) {
      console.error('[ServiceAccessCategories] Failed to load access categories:', error)
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (open) void loadData()
  }, [loadData, open])

  useEffect(() => {
    setSelectedUserIds([...(membersByCategory.get(activeCategoryId) ?? new Set<string>())])
  }, [activeCategoryId, membersByCategory])

  const selectCategory = (categoryId: string) => {
    setActiveCategoryId(categoryId)
    setEditingCategoryId('')
    setCategoryName('')
  }

  const requestClose = (nextOpen: boolean) => {
    if (isProcessing) return
    if (!nextOpen) {
      setEditingCategoryId('')
      setCategoryName('')
      setCategoryToDelete(null)
    }
    onOpenChange(nextOpen)
  }

  const handleSaveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!normalizedCategoryName || isProcessing) return

    const duplicate = categories.some((category) => category.id !== editingCategoryId
      && category.name.trim().toLocaleLowerCase() === normalizedCategoryName.toLocaleLowerCase())
    if (duplicate) {
      toast({ title: t('common.error'), description: t('services.access.duplicateCategory'), variant: 'destructive' })
      return
    }

    setIsSaving(true)
    try {
      if (editingCategoryId) {
        await renameServiceAccessCategory(workspaceId, editingCategoryId, normalizedCategoryName)
        setCategories((current) => current.map((category) => category.id === editingCategoryId
          ? { ...category, name: normalizedCategoryName }
          : category))
        toast({ title: t('common.success'), description: t('services.access.categoryUpdated') })
      } else {
        await createServiceAccessCategory(workspaceId, normalizedCategoryName)
        await loadData()
        toast({ title: t('common.success'), description: t('services.access.categoryCreated') })
      }
      setEditingCategoryId('')
      setCategoryName('')
    } catch (error) {
      console.error('[ServiceAccessCategories] Failed to save access category:', error)
      toast({ title: t('common.error'), description: t('services.access.saveCategoryError'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveMembers = async () => {
    if (!activeCategoryId || !hasMembershipChanges || isProcessing) return
    setIsSaving(true)
    try {
      await setServiceAccessCategoryMembers(activeCategoryId, selectedUserIds, workspaceId)
      setMembersByCategory((current) => {
        const next = new Map(current)
        next.set(activeCategoryId, new Set(selectedUserIds))
        return next
      })
      toast({ title: t('common.success'), description: t('services.access.membersSaved') })
    } catch (error) {
      console.error('[ServiceAccessCategories] Failed to save category members:', error)
      toast({ title: t('common.error'), description: t('services.access.saveMembersError'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!categoryToDelete || isProcessing) return
    setIsDeleting(true)
    try {
      await deleteServiceAccessCategory(workspaceId, categoryToDelete.id)
      setCategoryToDelete(null)
      setEditingCategoryId('')
      setCategoryName('')
      setCategories((current) => current.filter((category) => category.id !== categoryToDelete.id))
      setMembersByCategory((current) => {
        const next = new Map(current)
        next.delete(categoryToDelete.id)
        return next
      })
      setActiveCategoryId((current) => current === categoryToDelete.id
        ? categories.find((category) => category.id !== categoryToDelete.id)?.id ?? ''
        : current)
      toast({ title: t('common.success'), description: t('services.access.categoryDeleted') })
    } catch (error) {
      console.error('[ServiceAccessCategories] Failed to delete access category:', error)
      toast({ title: t('common.error'), description: t('services.access.deleteCategoryError'), variant: 'destructive' })
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <AppDialog open={open} onOpenChange={requestClose}>
        <AppDialogContent
          className="max-w-4xl"
          showCloseButton={!isProcessing}
          onPointerDownOutside={(event) => { if (isProcessing) event.preventDefault() }}
          onEscapeKeyDown={(event) => { if (isProcessing) event.preventDefault() }}
        >
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2">
              <FolderKey className="h-5 w-5 text-primary" />
              {t('services.access.title')}
            </AppDialogTitle>
            <p className="text-sm text-muted-foreground">{t('services.access.description')}</p>
          </AppDialogHeader>

          <AppDialogBody className="space-y-5">
            <form onSubmit={handleSaveCategory} className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-2">
                <Label htmlFor="service-access-category-name">
                  {t('services.access.categoryName')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="service-access-category-name"
                  value={categoryName}
                  onChange={(event) => setCategoryName(event.target.value)}
                  placeholder={t('services.access.categoryPlaceholder')}
                  disabled={isProcessing}
                  maxLength={100}
                />
              </div>
              <div className="flex gap-2">
                {editingCategoryId && (
                  <Button type="button" variant="outline" onClick={() => { setEditingCategoryId(''); setCategoryName('') }} disabled={isProcessing}>
                    <X className="h-4 w-4" />{t('common.cancel')}
                  </Button>
                )}
                <Button type="submit" disabled={!normalizedCategoryName || isProcessing}>
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : editingCategoryId ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  {editingCategoryId ? t('services.access.rename') : t('services.access.create')}
                </Button>
              </div>
            </form>

            {loadFailed ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-center">
                <p className="text-sm text-muted-foreground">{t('services.access.loadError')}</p>
                <Button type="button" variant="outline" className="mt-3" onClick={() => void loadData()} disabled={isLoading}>
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{t('common.retry')}
                </Button>
              </div>
            ) : isLoading && categories.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
                <section className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold"><Shield className="h-4 w-4 text-primary" />{t('services.access.categories')}</h3>
                  {categories.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border px-4 py-7 text-center text-sm text-muted-foreground">{t('services.access.empty')}</div>
                  ) : (
                    <div className="max-h-80 space-y-2 overflow-y-auto pe-1">
                      {categories.map((category) => (
                        <div key={category.id} className={`flex items-center gap-2 rounded-xl border p-2 ${activeCategoryId === category.id ? 'border-primary/40 bg-primary/5' : 'border-border/70 bg-background'}`}>
                          <button type="button" onClick={() => selectCategory(category.id)} className="flex min-w-0 flex-1 items-center gap-3 p-1 text-start">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Users className="h-4 w-4" /></span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{category.name}</span>
                              <span className="block text-xs text-muted-foreground">{t('services.access.memberCount', { count: membersByCategory.get(category.id)?.size ?? 0 })}</span>
                            </span>
                          </button>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t('common.edit')} onClick={() => { setActiveCategoryId(category.id); setEditingCategoryId(category.id); setCategoryName(category.name) }} disabled={isProcessing}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" aria-label={t('common.delete')} onClick={() => setCategoryToDelete(category)} disabled={isProcessing}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="min-w-0 space-y-3 rounded-xl border border-border/70 p-3 sm:p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{activeCategory?.name ?? t('services.access.selectCategory')}</h3>
                      <p className="text-xs text-muted-foreground">{t('services.access.membersDescription')}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{selectedUserIds.length}</span>
                  </div>
                  {!activeCategory ? (
                    <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                      <Users className="h-5 w-5" />{t('services.access.selectCategory')}
                    </div>
                  ) : workspaceMembers.length === 0 ? (
                    <div className="rounded-lg bg-muted/30 p-4 text-center text-sm text-muted-foreground">{t('services.access.noWorkspaceMembers')}</div>
                  ) : (
                    <div className="max-h-72 space-y-1 overflow-y-auto pe-1">
                      {workspaceMembers.map((member) => {
                        const checked = selectedUserIds.includes(member.id)
                        return (
                          <Label key={member.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(value) => setSelectedUserIds((current) => value === true
                                ? current.includes(member.id) ? current : [...current, member.id]
                                : current.filter((id) => id !== member.id))}
                              disabled={isProcessing}
                            />
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">{member.name.trim().slice(0, 1).toLocaleUpperCase() || '?'}</span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{member.name || t('services.access.unnamedMember')}</span>
                            {checked ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
                          </Label>
                        )
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}
          </AppDialogBody>

          <AppDialogFooter>
            <Button type="button" variant="outline" onClick={() => requestClose(false)} disabled={isProcessing}>{t('common.close')}</Button>
            <Button type="button" onClick={() => void handleSaveMembers()} disabled={!activeCategory || !hasMembershipChanges || isProcessing}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t('services.access.saveMembers')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <DeleteConfirmationModal
        isOpen={Boolean(categoryToDelete)}
        onClose={() => { if (!isDeleting) setCategoryToDelete(null) }}
        onConfirm={() => { void handleDelete() }}
        title={t('services.access.deleteTitle')}
        description={t('services.access.deleteDescription')}
        itemName={categoryToDelete?.name}
        isLoading={isDeleting}
      />
    </>
  )
}
