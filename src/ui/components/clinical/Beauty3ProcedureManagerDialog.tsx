import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderCog, Loader2, Pencil, Plus, Tags, Trash2 } from 'lucide-react'
import { formatCurrency, formatNumericInput, parseFormattedNumber, sanitizeNumericInput } from '@/lib/utils'
import {
  createClinicalPreset,
  deleteClinicalPreset,
  Beauty3ProcedureInUseError,
  Beauty3ProcedureUsageCheckError,
  updateClinicalPreset,
  useClinicalPresetsByCategory,
} from '@/local-db/clinicalPresets'
import {
  BEAUTY3_PROCEDURE_PRESET_CATEGORY,
  BEAUTY3_BUILT_IN_PROCEDURES,
  getBeauty3BuiltInProcedurePriceIqd,
  getBeauty3ProcedureDisplayNameOverride,
  getBeauty3ProcedureFaceAreas,
  isBeauty3BuiltInProcedureType,
  isReservedBeauty3ProcedureName,
} from '@/local-db/beauty3Procedures'
import type { Beauty3ProcedureFaceArea, ClinicalPreset, ClinicalPresetCategory, IQDDisplayPreference } from '@/local-db/models'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Beauty3ProcedureAreaPicker } from './Beauty3ProcedureFaceMap'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Input,
  Label,
  useToast,
} from '@/ui/components'

interface Beauty3ProcedureManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  iqdPreference: IQDDisplayPreference
}

export function Beauty3ProcedureManagerDialog({
  open,
  onOpenChange,
  workspaceId,
  iqdPreference,
}: Beauty3ProcedureManagerDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const presets = useClinicalPresetsByCategory(workspaceId, BEAUTY3_PROCEDURE_PRESET_CATEGORY)
  const procedures = useMemo(
    () => (presets ?? [])
      .filter((preset) => preset.isActive && !isBeauty3BuiltInProcedureType(preset.name))
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)),
    [presets],
  )
  const existingProcedures = (presets ?? []).filter((preset) => (
    !preset.isDeleted && !isBeauty3BuiltInProcedureType(preset.name)
  ))
  const [editingProcedure, setEditingProcedure] = useState<ClinicalPreset | null>(null)
  const [editingBuiltInProcedure, setEditingBuiltInProcedure] = useState<string | null>(null)
  const [procedureName, setProcedureName] = useState('')
  const [procedurePriceText, setProcedurePriceText] = useState('')
  const [faceMapAreas, setFaceMapAreas] = useState<Beauty3ProcedureFaceArea[]>([])
  const [procedureToDelete, setProcedureToDelete] = useState<ClinicalPreset | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const isProcessing = isSaving || isDeleting
  const normalizedName = procedureName.trim()
  const getBuiltInProcedureName = (procedureType: string) => {
    const procedure = BEAUTY3_BUILT_IN_PROCEDURES.find((item) => item.value === procedureType)
    return getBeauty3ProcedureDisplayNameOverride(procedureType, presets)
      ?? (procedure ? t(procedure.translationKey) : procedureType)
  }
  const parsedProcedurePrice = procedurePriceText.trim() === ''
    ? Number.NaN
    : parseFormattedNumber(procedurePriceText)
  const isProcedurePriceValid = Number.isFinite(parsedProcedurePrice) && parsedProcedurePrice >= 0
  const isEditingBuiltIn = editingBuiltInProcedure !== null
  const isEditing = editingProcedure !== null || isEditingBuiltIn
  const normalizedNameKey = normalizedName.toLocaleLowerCase()
  const isDuplicateName = Boolean(normalizedName && (
    (!isEditingBuiltIn && isReservedBeauty3ProcedureName(normalizedName))
    || existingProcedures.some((procedure) => (
      procedure.id !== editingProcedure?.id
      && procedure.name.trim().toLocaleLowerCase() === normalizedNameKey
    ))
    || BEAUTY3_BUILT_IN_PROCEDURES.some((procedure) => (
      procedure.value !== editingBuiltInProcedure
      && getBuiltInProcedureName(procedure.value).trim().toLocaleLowerCase() === normalizedNameKey
    ))
  ))

  const resetForm = () => {
    setEditingProcedure(null)
    setEditingBuiltInProcedure(null)
    setProcedureName('')
    setProcedurePriceText('')
    setFaceMapAreas([])
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (isProcessing) return
    if (!nextOpen) resetForm()
    onOpenChange(nextOpen)
  }

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!normalizedName
      || (isEditingBuiltIn && faceMapAreas.length === 0)
      || !isProcedurePriceValid
      || presets === undefined
      || isProcessing) return

    if (isDuplicateName) {
      toast({
        title: t('common.error'),
        description: t('beauty3Appointments.duplicateProcedure'),
        variant: 'destructive',
      })
      return
    }

    setIsSaving(true)
    try {
      if (editingBuiltInProcedure) {
        const existingPrice = (presets ?? []).find((preset) => preset.name === editingBuiltInProcedure)
        if (existingPrice) {
          await updateClinicalPreset(existingPrice.id, {
            displayName: normalizedName,
            consultationFee: parsedProcedurePrice,
            faceMapAreas,
          }, workspaceId)
        } else {
          const sortOrder = Math.max(-1, ...procedures.map((procedure) => procedure.sortOrder)) + 1
          await createClinicalPreset({
            category: BEAUTY3_PROCEDURE_PRESET_CATEGORY,
            name: editingBuiltInProcedure,
            displayName: normalizedName,
            consultationFee: parsedProcedurePrice,
            faceMapAreas,
            sortOrder,
            isActive: true,
          }, workspaceId)
        }
        toast({ title: t('beauty3Appointments.procedureUpdated') })
      } else if (editingProcedure) {
        await updateClinicalPreset(editingProcedure.id, {
          name: normalizedName,
          consultationFee: parsedProcedurePrice,
          faceMapAreas,
        }, workspaceId)
        toast({ title: t('beauty3Appointments.procedureUpdated') })
      } else {
        const sortOrder = Math.max(-1, ...procedures.map((procedure) => procedure.sortOrder)) + 1
        await createClinicalPreset({
          category: BEAUTY3_PROCEDURE_PRESET_CATEGORY as ClinicalPresetCategory,
          name: normalizedName,
          consultationFee: parsedProcedurePrice,
          faceMapAreas,
          sortOrder,
          isActive: true,
        }, workspaceId)
        toast({ title: t('beauty3Appointments.procedureAdded') })
      }
      resetForm()
    } catch (error) {
      console.error('[Beauty3ProcedureManagerDialog] Failed to save procedure:', error)
      toast({
        title: t('common.error'),
        description: t('beauty3Appointments.procedureSaveFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const startEditing = (procedure: ClinicalPreset) => {
    if (isProcessing) return
    setEditingProcedure(procedure)
    setEditingBuiltInProcedure(null)
    setProcedureName(procedure.name)
    setProcedurePriceText(formatNumericInput(String(procedure.consultationFee ?? 0)))
    setFaceMapAreas(getBeauty3ProcedureFaceAreas(procedure.name, procedure.faceMapAreas))
  }

  const startEditingBuiltIn = (procedureType: string) => {
    if (isProcessing) return
    setEditingProcedure(null)
    setEditingBuiltInProcedure(procedureType)
    const savedProcedure = presets?.find((preset) => preset.name === procedureType)
    const builtIn = BEAUTY3_BUILT_IN_PROCEDURES.find((procedure) => procedure.value === procedureType)
    setProcedureName(savedProcedure?.displayName?.trim() || (builtIn ? t(builtIn.translationKey) : ''))
    const savedPrice = savedProcedure?.consultationFee
    const defaultPrice = getBeauty3BuiltInProcedurePriceIqd(procedureType) ?? 0
    setProcedurePriceText(formatNumericInput(String(savedPrice ?? defaultPrice)))
    setFaceMapAreas(getBeauty3ProcedureFaceAreas(procedureType, savedProcedure?.faceMapAreas))
  }

  const handleDelete = async () => {
    if (!procedureToDelete || isDeleting) return
    setIsDeleting(true)
    try {
      await deleteClinicalPreset(procedureToDelete.id, workspaceId)
      if (editingProcedure?.id === procedureToDelete.id) resetForm()
      setProcedureToDelete(null)
      toast({ title: t('beauty3Appointments.procedureDeleted') })
    } catch (error) {
      console.error('[Beauty3ProcedureManagerDialog] Failed to delete procedure:', error)
      toast({
        title: t('common.error'),
        description: error instanceof Beauty3ProcedureInUseError
          ? t('beauty3Appointments.procedureInUse')
          : error instanceof Beauty3ProcedureUsageCheckError
            ? t('beauty3Appointments.procedureUsageCheckFailed')
            : t('beauty3Appointments.procedureDeleteFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <AppDialog open={open} onOpenChange={handleOpenChange}>
        <AppDialogContent
          className="max-w-2xl"
          showCloseButton={!isProcessing}
          onPointerDownOutside={(event) => {
            if (isProcessing) event.preventDefault()
          }}
          onEscapeKeyDown={(event) => {
            if (isProcessing) event.preventDefault()
          }}
        >
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2">
              <FolderCog className="size-5 text-primary" />
              {t('beauty3Appointments.procedureManagerTitle')}
            </AppDialogTitle>
            <p className="text-sm text-muted-foreground">
              {t('beauty3Appointments.procedureManagerDescription')}
            </p>
          </AppDialogHeader>

          <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
            <AppDialogBody className="space-y-6">
              <section className="rounded-xl border border-border/70 bg-muted/20 p-4">
                <div className="mb-4 flex items-center gap-2">
                  <Tags className="size-4 text-primary" />
                  <h3 className="font-semibold">
                    {isEditing
                      ? t('beauty3Appointments.editProcedure')
                      : t('beauty3Appointments.addProcedure')}
                  </h3>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="beauty3-procedure-name">
                      {t('beauty3Appointments.procedureName')} <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="beauty3-procedure-name"
                      value={procedureName}
                      onChange={(event) => setProcedureName(event.target.value)}
                      placeholder={t('beauty3Appointments.procedureNamePlaceholder')}
                      disabled={isProcessing}
                      required
                      autoFocus={open && !editingProcedure}
                    />
                    {isDuplicateName ? (
                      <p className="text-sm text-destructive" role="alert">
                        {t('beauty3Appointments.duplicateProcedure')}
                      </p>
                    ) : null}
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="beauty3-procedure-price">
                      {t('beauty3Appointments.procedurePrice')} <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="beauty3-procedure-price"
                      value={procedurePriceText}
                      onChange={(event) => {
                        const sanitized = sanitizeNumericInput(event.target.value, { allowDecimal: false })
                        setProcedurePriceText(formatNumericInput(sanitized))
                      }}
                      placeholder={t('beauty3Appointments.zeroPlaceholder')}
                      inputMode="numeric"
                      disabled={isProcessing}
                    />
                    <p className="text-xs text-muted-foreground">{t('beauty3Appointments.iqd')}</p>
                  </div>
                </div>
              </section>

              <Beauty3ProcedureAreaPicker
                selectedAreas={faceMapAreas}
                onChange={setFaceMapAreas}
                disabled={isProcessing}
                required={isEditingBuiltIn}
              />

              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Tags className="size-4 text-muted-foreground" />
                  <h3 className="font-semibold">{t('beauty3Appointments.builtInProcedures')}</h3>
                </div>
                <div className="space-y-2">
                  {BEAUTY3_BUILT_IN_PROCEDURES.map((procedure) => {
                    const savedPrice = presets?.find((preset) => preset.name === procedure.value)?.consultationFee
                    const price = savedPrice ?? procedure.defaultPriceIqd
                    return (
                      <div
                        key={procedure.value}
                        className="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5"
                      >
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Tags className="size-4" />
                        </div>
                        <span className="min-w-0 flex-1 truncate font-medium">{getBuiltInProcedureName(procedure.value)}</span>
                        <span className="shrink-0 text-sm text-muted-foreground">
                          {formatCurrency(price, 'iqd', iqdPreference, 0)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={t('common.edit')}
                          title={t('common.edit')}
                          onClick={() => startEditingBuiltIn(procedure.value)}
                          disabled={isProcessing || presets === undefined}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Tags className="size-4 text-muted-foreground" />
                  <h3 className="font-semibold">{t('beauty3Appointments.workspaceProcedures')}</h3>
                </div>
                {presets === undefined ? (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground" role="status">
                    <Loader2 className="size-4 animate-spin" />
                    {t('beauty3Appointments.loadingProcedures')}
                  </div>
                ) : procedures.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('beauty3Appointments.noCustomProcedures')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {procedures.map((procedure) => (
                      <div
                        key={procedure.id}
                        className="flex items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5"
                      >
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Tags className="size-4" />
                        </div>
                        <span className="min-w-0 flex-1 truncate font-medium">{procedure.name}</span>
                        <span className="shrink-0 text-sm text-muted-foreground">
                          {formatCurrency(procedure.consultationFee ?? 0, 'iqd', iqdPreference, 0)}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={t('common.edit')}
                            title={t('common.edit')}
                            onClick={() => startEditing(procedure)}
                            disabled={isProcessing}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 text-destructive hover:text-destructive"
                            aria-label={t('common.delete')}
                            title={t('common.delete')}
                            onClick={() => setProcedureToDelete(procedure)}
                            disabled={isProcessing}
                          >
                            <Trash2 className="size-4" />
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
                onClick={() => {
                  if (isEditing) resetForm()
                  else handleOpenChange(false)
                }}
                disabled={isProcessing}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={!normalizedName || (isEditingBuiltIn && faceMapAreas.length === 0) || !isProcedurePriceValid || presets === undefined || isDuplicateName || isProcessing}
              >
                {isSaving ? <Loader2 className="me-2 size-4 animate-spin" /> : <Plus className="me-2 size-4" />}
                {isSaving
                  ? t('beauty3Appointments.savingProcedure')
                  : isEditing
                    ? t('beauty3Appointments.updateProcedure')
                    : t('beauty3Appointments.addProcedure')}
              </Button>
            </AppDialogFooter>
          </form>
        </AppDialogContent>
      </AppDialog>

      <DeleteConfirmationModal
        isOpen={Boolean(procedureToDelete)}
        onClose={() => {
          if (!isDeleting) setProcedureToDelete(null)
        }}
        onConfirm={handleDelete}
        isLoading={isDeleting}
        itemName={procedureToDelete?.name}
        title={t('beauty3Appointments.deleteProcedureTitle')}
        description={t('beauty3Appointments.deleteProcedureDescription')}
      />
    </>
  )
}
