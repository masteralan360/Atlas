import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ArchiveRestore, ArrowRight, Edit, GitBranch, Plus, Trash2 } from 'lucide-react'

import {
  deleteUnitRelationship,
  saveUnitRelationship,
  setUnitRelationshipArchived,
  UnitRelationshipEndpointInUseError,
  UnitRelationshipInUseError,
  UnitRelationshipVerificationRequiredError,
  useProductUnitConversions,
  useProducts,
  useUnitRelationships,
  type Unit,
  type UnitRelationship,
  type UnitRef,
} from '@/local-db'
import {
  countActiveProductsByRelationship,
  getUnitDescriptors,
  getUnitRefsUsedByProducts,
} from '@/lib/unitRelationships'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
} from '@/ui/components/dialog'
import { Button } from '@/ui/components/button'
import { Input } from '@/ui/components/input'
import { Label } from '@/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components/select'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { useToast } from '@/ui/components/use-toast'

type Draft = {
  name: string
  parentUnitRef: UnitRef | ''
  childUnitRef: UnitRef | ''
}

const EMPTY_DRAFT: Draft = { name: '', parentUnitRef: '', childUnitRef: '' }

export function UnitRelationshipsDialog({
  open,
  onOpenChange,
  workspaceId,
  units,
  canEdit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  units: Unit[]
  canEdit: boolean
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const relationships = useUnitRelationships(workspaceId)
  const conversions = useProductUnitConversions(workspaceId)
  const products = useProducts(workspaceId, { syncBarcodeCache: false })
  const descriptors = useMemo(() => getUnitDescriptors(units), [units])
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<UnitRelationship | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<UnitRelationship | null>(null)
  const [busyRelationshipId, setBusyRelationshipId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const usageByRelationship = useMemo(
    () => countActiveProductsByRelationship(products, conversions),
    [conversions, products],
  )
  const usedUnitRefs = useMemo(
    () => getUnitRefsUsedByProducts(products, conversions, relationships, descriptors),
    [conversions, descriptors, products, relationships],
  )

  const sortedRelationships = useMemo(() => [...relationships].sort((left, right) => (
    Number(left.isArchived) - Number(right.isArchived)
    || left.parentUnitCode.localeCompare(right.parentUnitCode)
    || left.childUnitCode.localeCompare(right.childUnitCode)
  )), [relationships])

  const openCreate = () => {
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setShowForm(true)
  }

  const openEdit = (relationship: UnitRelationship) => {
    setEditing(relationship)
    setDraft({
      name: relationship.name ?? '',
      parentUnitRef: relationship.parentUnitRef,
      childUnitRef: relationship.childUnitRef,
    })
    setShowForm(true)
  }

  const save = async () => {
    if (!workspaceId || !draft.parentUnitRef || !draft.childUnitRef || saving) return
    const parent = descriptors.find((unit) => unit.ref === draft.parentUnitRef)
    const child = descriptors.find((unit) => unit.ref === draft.childUnitRef)
    if (!parent || !child) return

    setSaving(true)
    try {
      await saveUnitRelationship(workspaceId, {
        name: draft.name,
        parentUnitRef: parent.ref,
        parentUnitCode: parent.code,
        childUnitRef: child.ref,
        childUnitCode: child.code,
      }, editing?.id)
      toast({ description: t('units.relationships.messages.saved') })
      setShowForm(false)
      setEditing(null)
      setDraft(EMPTY_DRAFT)
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const key = code === 'unit_relationship_duplicate'
        ? 'duplicate'
        : code === 'unit_relationship_reverse'
          ? 'reverse'
          : code === 'unit_relationship_cycle'
            ? 'cycle'
            : code === 'unit_relationship_same_unit'
            ? 'sameUnit'
              : error instanceof UnitRelationshipEndpointInUseError
                ? 'endpointInUse'
              : error instanceof UnitRelationshipInUseError
                ? 'inUse'
                : error instanceof UnitRelationshipVerificationRequiredError
                  ? 'verificationRequired'
                : 'saveFailed'
      toast({ variant: 'destructive', description: t(`units.relationships.messages.${key}`) })
    } finally {
      setSaving(false)
    }
  }

  const toggleArchived = async (relationship: UnitRelationship) => {
    if (!canEdit || busyRelationshipId) return
    setBusyRelationshipId(relationship.id)
    try {
      await setUnitRelationshipArchived(relationship.id, !relationship.isArchived)
      toast({
        description: relationship.isArchived
          ? t('units.relationships.messages.restored')
          : t('units.relationships.messages.archived'),
      })
    } catch (error) {
      const key = error instanceof UnitRelationshipEndpointInUseError
        ? 'endpointInUse'
        : error instanceof UnitRelationshipInUseError
          ? relationship.isArchived ? 'inUse' : 'archiveInUse'
          : error instanceof UnitRelationshipVerificationRequiredError
            ? 'verificationRequired'
            : 'saveFailed'
      toast({ variant: 'destructive', description: t(`units.relationships.messages.${key}`) })
    } finally {
      setBusyRelationshipId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleting || isDeleting) return
    setIsDeleting(true)
    try {
      await deleteUnitRelationship(deleting.id)
      setDeleting(null)
      toast({ description: t('units.relationships.messages.deleted') })
    } catch (error) {
      setDeleting(null)
      toast({
        variant: 'destructive',
        description: error instanceof UnitRelationshipInUseError
          ? t('units.relationships.messages.inUse')
          : error instanceof UnitRelationshipVerificationRequiredError
            ? t('units.relationships.messages.verificationRequired')
          : t('units.relationships.messages.deleteFailed'),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  const selectedParent = descriptors.find((unit) => unit.ref === draft.parentUnitRef)
  const selectedChild = descriptors.find((unit) => unit.ref === draft.childUnitRef)
  const endpointsLocked = Boolean(editing && (usageByRelationship.get(editing.id) ?? 0) > 0)
  const isValid = Boolean(
    draft.parentUnitRef
    && draft.childUnitRef
    && draft.parentUnitRef !== draft.childUnitRef,
  )

  return (
    <>
      <AppDialog open={open} onOpenChange={(next) => { if (!saving && !busyRelationshipId && !isDeleting) onOpenChange(next) }}>
        <AppDialogContent className="max-w-3xl" showCloseButton={!saving && !busyRelationshipId && !isDeleting}>
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-primary" />
              {t('units.relationships.title')}
            </AppDialogTitle>
          </AppDialogHeader>

          <AppDialogBody>
            {showForm ? (
              <div className="space-y-5">
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-sm font-semibold">
                    {editing ? t('units.relationships.editTitle') : t('units.relationships.addTitle')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('units.relationships.formHint')}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="unit-relationship-name">{t('units.relationships.name')}</Label>
                  <Input
                    id="unit-relationship-name"
                    value={draft.name}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    placeholder={t('units.relationships.namePlaceholder')}
                    disabled={saving}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
                  <div className="space-y-2">
                    <Label>{t('units.relationships.parent')} *</Label>
                    <Select
                      value={draft.parentUnitRef}
                      disabled={saving || endpointsLocked}
                      onValueChange={(value) => setDraft((current) => ({ ...current, parentUnitRef: value as UnitRef }))}
                    >
                      <SelectTrigger><SelectValue placeholder={t('units.relationships.selectUnit')} /></SelectTrigger>
                      <SelectContent>
                        {descriptors.map((unit) => (
                          <SelectItem key={unit.ref} value={unit.ref} disabled={usedUnitRefs.has(unit.ref)}>
                            {t(`products.units.${unit.code}`, { defaultValue: unit.code })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex h-10 items-center justify-center text-primary"><ArrowRight className="h-5 w-5 rtl:rotate-180" /></div>
                  <div className="space-y-2">
                    <Label>{t('units.relationships.child')} *</Label>
                    <Select
                      value={draft.childUnitRef}
                      disabled={saving || endpointsLocked}
                      onValueChange={(value) => setDraft((current) => ({ ...current, childUnitRef: value as UnitRef }))}
                    >
                      <SelectTrigger><SelectValue placeholder={t('units.relationships.selectUnit')} /></SelectTrigger>
                      <SelectContent>
                        {descriptors.map((unit) => (
                          <SelectItem key={unit.ref} value={unit.ref} disabled={usedUnitRefs.has(unit.ref)}>
                            {t(`products.units.${unit.code}`, { defaultValue: unit.code })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {selectedParent && selectedChild && selectedParent.ref !== selectedChild.ref && (
                  <div className="flex items-center justify-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 font-bold">
                    <span>{t(`products.units.${selectedParent.code}`, { defaultValue: selectedParent.code })}</span>
                    <ArrowRight className="h-4 w-4 text-primary rtl:rotate-180" />
                    <span>{t(`products.units.${selectedChild.code}`, { defaultValue: selectedChild.code })}</span>
                  </div>
                )}

                {endpointsLocked && <p className="text-xs text-amber-700 dark:text-amber-300">{t('units.relationships.endpointsLocked')}</p>}
                {!endpointsLocked && usedUnitRefs.size > 0 && (
                  <p className="text-xs text-muted-foreground">{t('units.relationships.usedUnitHint')}</p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {sortedRelationships.length === 0 ? (
                  <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed text-center text-muted-foreground">
                    <GitBranch className="mb-3 h-10 w-10 opacity-40" />
                    <p className="font-semibold">{t('units.relationships.empty')}</p>
                    <p className="mt-1 max-w-md text-xs">{t('units.relationships.emptyHint')}</p>
                  </div>
                ) : sortedRelationships.map((relationship) => {
                  const usage = usageByRelationship.get(relationship.id) ?? 0
                  return (
                    <div key={relationship.id} className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold">{relationship.name || t('units.relationships.unnamed')}</span>
                          {relationship.isArchived && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">{t('units.relationships.archived')}</span>}
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-sm">
                          <span>{t(`products.units.${relationship.parentUnitCode}`, { defaultValue: relationship.parentUnitCode })}</span>
                          <ArrowRight className="h-4 w-4 text-primary rtl:rotate-180" />
                          <span>{t(`products.units.${relationship.childUnitCode}`, { defaultValue: relationship.childUnitCode })}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{t('units.relationships.productsUsing', { count: usage })}</p>
                      </div>
                      {canEdit && (
                        <div className="flex items-center gap-1 self-end sm:self-auto">
                          <Button variant="ghost" size="icon" disabled={Boolean(busyRelationshipId)} title={t('common.edit')} onClick={() => openEdit(relationship)}><Edit className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="icon" disabled={Boolean(busyRelationshipId) || (!relationship.isArchived && usage > 0)} title={relationship.isArchived ? t('units.relationships.restore') : t('units.relationships.archive')} onClick={() => void toggleArchived(relationship)}>
                            {relationship.isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                          </Button>
                          <Button variant="ghost" size="icon" className="text-destructive" title={t('common.delete')} disabled={usage > 0 || Boolean(busyRelationshipId)} onClick={() => setDeleting(relationship)}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </AppDialogBody>

          <AppDialogFooter>
            {showForm ? (
              <>
                <Button variant="outline" disabled={saving} onClick={() => { setShowForm(false); setEditing(null); setDraft(EMPTY_DRAFT) }}>{t('common.back')}</Button>
                <Button disabled={!isValid || saving} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={Boolean(busyRelationshipId)} onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
                {canEdit && <Button disabled={Boolean(busyRelationshipId)} onClick={openCreate}><Plus className="me-2 h-4 w-4" />{t('units.relationships.add')}</Button>}
              </>
            )}
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <DeleteConfirmationModal
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        isLoading={isDeleting}
        title={t('units.relationships.deleteTitle')}
        description={t('units.relationships.deleteHint')}
      />
    </>
  )
}
