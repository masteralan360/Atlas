import { useState, useMemo } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthContext'
import { createClinicalPreset, updateClinicalPreset, deleteClinicalPreset, useClinicalPresets } from '@/local-db/clinicalPresets'
import type { ClinicalPresetCategory } from '@/local-db/models'
import { Button } from '@/ui/components/button'
import { Input } from '@/ui/components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Label,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/ui/components'
import { Plus, Pencil, Trash2, X, Check, ChevronUp, ChevronDown } from 'lucide-react'
import { formatNumberWithCommas } from '@/lib/utils'
import { useWorkspace } from '@/workspace/WorkspaceContext'

const APPOINTMENT_TYPE_OPTIONS = ['consultation', 'follow_up', 'emergency', 'checkup', 'procedure', 'treatment']

function formatTypeLabel(type: string) {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const CATEGORY_META: Record<string, { label: string; color: string }> = {
  reason_for_visit: { label: 'Reason for Visit', color: 'text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-950' },
  appointment_type: { label: 'Appointment Type', color: 'text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950' },
}

export function ClinicalPresets() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { features } = useWorkspace()
  const workspaceId = user?.workspaceId ?? ''
  const presets = useClinicalPresets(workspaceId)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editFee, setEditFee] = useState(0)
  const [editCategory, setEditCategory] = useState<ClinicalPresetCategory>('reason_for_visit')
  const [adding, setAdding] = useState(false)
  const [newCategory, setNewCategory] = useState<ClinicalPresetCategory>('reason_for_visit')
  const [newName, setNewName] = useState('')
  const [newFee, setNewFee] = useState(0)
  const [feeSort, setFeeSort] = useState<'asc' | 'desc' | null>(null)

  if (!workspaceId) return null

  const sortedPresets = useMemo(() => {
    const items = (presets || []).filter((p) => !p.isDeleted).sort((a, b) => a.sortOrder - b.sortOrder)
    if (feeSort === 'asc') return [...items].sort((a, b) => a.consultationFee - b.consultationFee)
    if (feeSort === 'desc') return [...items].sort((a, b) => b.consultationFee - a.consultationFee)
    return items
  }, [presets, feeSort])

  const handleAdd = async () => {
    if (!newName.trim()) return
    await createClinicalPreset(
      {
        name: newName.trim(),
        consultationFee: newFee,
        category: newCategory as ClinicalPresetCategory,
        sortOrder: (presets || []).length,
        isActive: true,
      },
      workspaceId,
    )
    setNewName('')
    setNewFee(0)
    setAdding(false)
  }

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return
    await updateClinicalPreset(id, { name: editName.trim(), consultationFee: editFee, category: editCategory as ClinicalPresetCategory }, workspaceId)
    setEditingId(null)
    setEditName('')
    setEditFee(0)
    setEditCategory('reason_for_visit')
  }

  const handleDelete = async (id: string) => {
    await deleteClinicalPreset(id, workspaceId)
  }

  const moveUp = async (index: number) => {
    if (index <= 0) return
    const current = sortedPresets[index]
    const above = sortedPresets[index - 1]
    await updateClinicalPreset(current.id, { sortOrder: above.sortOrder }, workspaceId)
    await updateClinicalPreset(above.id, { sortOrder: current.sortOrder }, workspaceId)
  }

  const moveDown = async (index: number) => {
    if (index >= sortedPresets.length - 1) return
    const current = sortedPresets[index]
    const below = sortedPresets[index + 1]
    await updateClinicalPreset(current.id, { sortOrder: below.sortOrder }, workspaceId)
    await updateClinicalPreset(below.id, { sortOrder: current.sortOrder }, workspaceId)
  }

  const startEdit = (preset: NonNullable<typeof presets>[number]) => {
    setEditingId(preset.id)
    setEditName(preset.name)
    setEditFee(preset.consultationFee)
    setEditCategory(preset.category)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditName('')
    setEditFee(0)
    setEditCategory('reason_for_visit')
  }

  const catOptions = Object.entries(CATEGORY_META).map(([key, meta]) => ({ key, label: t(`clinicalPresets.${key === 'reason_for_visit' ? 'reasonForVisit' : 'appointmentType'}`, { defaultValue: meta.label }) }))

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 custom-scrollbar">
        <div className="space-y-5 pb-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">{t('clinicalPresets.title', { defaultValue: 'Clinical Presets' })}</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('clinicalPresets.subtitle', { defaultValue: 'Configure reusable appointment presets.' })} <ModulePageFreshness className="ms-2" />
            </p>
          </div>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg">{t('clinicalPresets.title', { defaultValue: 'Presets' })}</CardTitle>
              {!adding && (
                <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                  <Plus className="mr-1 h-4 w-4" />
                  {t('clinicalPresets.add', { defaultValue: 'Add' })}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {adding && (
                <div className="mb-4 flex items-end gap-3 rounded-lg border p-4">
                  <div className="grid gap-1.5">
                    <Label>{t('clinicalPresets.type', { defaultValue: 'Type' })}</Label>
                    <Select value={newCategory} onValueChange={(v) => setNewCategory(v as ClinicalPresetCategory)}>
                      <SelectTrigger className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {catOptions.map((opt) => (
                          <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid flex-1 gap-1.5">
                    <Label>{t('clinicalPresets.name', { defaultValue: 'Name' })}</Label>
                    {newCategory === 'appointment_type' ? (
                      <Select value={newName} onValueChange={setNewName}>
                        <SelectTrigger>
                          <SelectValue placeholder={t('clinicalPresets.namePlaceholder', { defaultValue: 'Select type...' })} />
                        </SelectTrigger>
                        <SelectContent>
                          {APPOINTMENT_TYPE_OPTIONS
                            .filter((type) => !sortedPresets.some((p) => p.category === 'appointment_type' && p.name === type))
                            .map((type) => (
                              <SelectItem key={type} value={type}>{formatTypeLabel(type)}</SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder={t('clinicalPresets.namePlaceholder', { defaultValue: 'Enter name...' })}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
                      />
                    )}
                  </div>
                  <div className="grid gap-1.5">
                    <Label>{t('clinicalPresets.consultationFee', { defaultValue: 'Fee' })}</Label>
                    <div className="relative">
                      <Input
                        className="w-32 pr-10"
                        value={newFee ? formatNumberWithCommas(newFee) : ''}
                        onChange={(e) => setNewFee(Number(e.target.value.replace(/,/g, '')))}
                        placeholder="0"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{features.iqd_display_preference}</span>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" onClick={handleAdd} disabled={!newName.trim()}>
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => { setAdding(false); setNewName(''); setNewFee(0) }}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              {sortedPresets.length === 0 ? (
                !adding && <p className="py-4 text-center text-sm text-muted-foreground">
                  {t('clinicalPresets.empty', { defaultValue: 'No presets configured.' })}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">{t('clinicalPresets.sort', { defaultValue: 'Sort' })}</TableHead>
                      <TableHead>{t('clinicalPresets.name', { defaultValue: 'Name' })}</TableHead>
                      <TableHead>{t('clinicalPresets.type', { defaultValue: 'Type' })}</TableHead>
                      <TableHead>
                        <div className="flex items-center gap-1">
                          <span>{t('clinicalPresets.consultationFee', { defaultValue: 'Consultation Fee' })}</span>
                          <div className="flex flex-col gap-0">
                            <button className="leading-none text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={feeSort === 'asc'} onClick={() => setFeeSort(feeSort === 'asc' ? null : 'asc')}>
                              <ChevronUp className="h-3 w-3" />
                            </button>
                            <button className="leading-none text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={feeSort === 'desc'} onClick={() => setFeeSort(feeSort === 'desc' ? null : 'desc')}>
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      </TableHead>
                      <TableHead className="w-24">{t('clinicalPresets.actions', { defaultValue: 'Actions' })}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedPresets.map((preset, index) => {
                      const meta = CATEGORY_META[preset.category]
                      return (
                        <TableRow key={preset.id}>
                          <TableCell>
                            <div className="flex items-center gap-0.5">
                              <Button size="icon" variant="ghost" className="h-7 w-7" disabled={index === 0} onClick={() => moveUp(index)}>
                                <ChevronUp className="h-4 w-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7" disabled={index === sortedPresets.length - 1} onClick={() => moveDown(index)}>
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                          {editingId === preset.id ? (
                            <>
                              <TableCell>
                                {preset.category === 'appointment_type' ? (
                                  <Select value={editName} onValueChange={setEditName}>
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {APPOINTMENT_TYPE_OPTIONS.map((type) => (
                                        <SelectItem key={type} value={type}>{formatTypeLabel(type)}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : (
                                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleEdit(preset.id) }} />
                                )}
                              </TableCell>
                              <TableCell>
                                <Select value={editCategory} onValueChange={(v) => setEditCategory(v as ClinicalPresetCategory)}>
                                  <SelectTrigger className="w-44">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {catOptions.map((opt) => (
                                      <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell>
                                <div className="relative">
                                  <Input className="w-32 pr-10" value={editFee ? formatNumberWithCommas(editFee) : ''} onChange={(e) => setEditFee(Number(e.target.value.replace(/,/g, '')))} />
                                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{features.iqd_display_preference}</span>
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex gap-1">
                                  <Button size="icon" variant="ghost" onClick={() => handleEdit(preset.id)} disabled={!editName.trim()}>
                                    <Check className="h-4 w-4" />
                                  </Button>
                                  <Button size="icon" variant="ghost" onClick={cancelEdit}>
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                              </TableCell>
                            </>
                          ) : (
                            <>
                              <TableCell>{preset.category === 'appointment_type' ? formatTypeLabel(preset.name) : preset.name}</TableCell>
                              <TableCell>
                                <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${meta?.color || ''}`}>
                                  {meta?.label || preset.category}
                                </span>
                              </TableCell>
                              <TableCell>
                                {preset.consultationFee > 0 ? `${formatNumberWithCommas(preset.consultationFee)} ${features.iqd_display_preference}` : '-'}
                              </TableCell>
                              <TableCell>
                                <div className="flex gap-1">
                                  <Button size="icon" variant="ghost" onClick={() => startEdit(preset)}>
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button size="icon" variant="ghost" onClick={() => handleDelete(preset.id)}>
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </TableCell>
                            </>
                          )}
                        </TableRow>
                      )}
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
