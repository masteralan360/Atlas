import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Edit, GitBranch, Package, Plus, Search, Sparkles, Trash2 } from 'lucide-react'

import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { createUnit, deleteUnit, updateUnit, useUnits, UnitInUseError, UnitReservedCodeError, type Unit } from '@/local-db'
import { DEFAULT_UNITS } from '@/local-db/models'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { CUSTOM_UNIT_ICON_CHOICES, ProductUnitIcon } from '@/ui/components/ProductUnitIcon'
import { Button } from '@/ui/components/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { Input } from '@/ui/components/input'
import { Label } from '@/ui/components/label'
import { Switch } from '@/ui/components/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/table'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/components/dialog'
import { useToast } from '@/ui/components/use-toast'
import { cn } from '@/lib/utils'
import { UnitRelationshipsDialog } from '@/ui/components/units/UnitRelationshipsDialog'

type UnitDraft = {
    code: string
    icon: string
    isDynamic: boolean
}

const emptyDraft: UnitDraft = { code: '', icon: 'Package', isDynamic: false }

export default function UnitsPage() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { activeWorkspace } = useWorkspace()
    const { toast } = useToast()
    const units = useUnits(activeWorkspace?.id)

    const [searchQuery, setSearchQuery] = useState('')
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingUnit, setEditingUnit] = useState<Unit | undefined>(undefined)
    const [draft, setDraft] = useState<UnitDraft>(emptyDraft)
    const [deletingUnit, setDeletingUnit] = useState<Unit | undefined>(undefined)
    const [isSaving, setIsSaving] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const [relationshipsOpen, setRelationshipsOpen] = useState(false)

    const canEdit = user?.role === 'admin' || user?.role === 'staff'

    const filteredUnits = useMemo(() => {
        const query = searchQuery.trim().toLowerCase()
        const list = [...units].sort((left, right) => left.code.localeCompare(right.code))
        if (!query) return list
        return list.filter((unit) => unit.code.toLowerCase().includes(query))
    }, [units, searchQuery])

    const openCreateDialog = () => {
        setEditingUnit(undefined)
        setDraft(emptyDraft)
        setIsDialogOpen(true)
    }

    const openEditDialog = (unit: Unit) => {
        setEditingUnit(unit)
        setDraft({ code: unit.code, icon: unit.icon ?? 'Package', isDynamic: unit.isDynamic })
        setIsDialogOpen(true)
    }

    const handleSave = async () => {
        const workspaceId = activeWorkspace?.id
        if (!workspaceId || !canEdit) return

        const code = draft.code.trim()
        if (!code) {
            toast({ variant: 'destructive', description: t('units.messages.codeRequired', { defaultValue: 'Unit name is required.' }) })
            return
        }

        const isBuiltIn = DEFAULT_UNITS.some((def) => def.code.trim().toLowerCase() === code.toLowerCase())
        if (isBuiltIn) {
            toast({ variant: 'destructive', description: t('units.messages.reservedCode', { defaultValue: 'This is a built-in unit and cannot be recreated as a custom unit.' }) })
            return
        }

        const duplicate = units.find(
            (unit) => unit.id !== editingUnit?.id && unit.code.toLowerCase().trim() === code.toLowerCase(),
        )
        if (duplicate) {
            toast({ variant: 'destructive', description: t('units.messages.duplicateCode', { defaultValue: 'A unit with this name already exists.' }) })
            return
        }

        setIsSaving(true)
        try {
            if (editingUnit) {
                await updateUnit(editingUnit.id, { code, icon: draft.icon, isDynamic: draft.isDynamic })
                toast({ description: t('units.messages.updated', { defaultValue: 'Unit updated.' }) })
            } else {
                await createUnit(workspaceId, { code, icon: draft.icon, isDynamic: draft.isDynamic })
                toast({ description: t('units.messages.created', { defaultValue: 'Unit created.' }) })
            }
            setIsDialogOpen(false)
        } catch (error) {
            if (error instanceof UnitReservedCodeError) {
                toast({ variant: 'destructive', description: t('units.messages.reservedCode', { defaultValue: 'This is a built-in unit and cannot be recreated as a custom unit.' }) })
            } else {
                toast({ variant: 'destructive', description: t('units.messages.saveFailed', { defaultValue: 'Could not save unit. Please try again.' }) })
            }
        } finally {
            setIsSaving(false)
        }
    }

    const handleDelete = async () => {
        if (!deletingUnit || isDeleting) return
        setIsDeleting(true)
        try {
            await deleteUnit(deletingUnit.id)
            toast({ description: t('units.messages.deleted', { defaultValue: 'Unit deleted.' }) })
            setDeletingUnit(undefined)
        } catch (error) {
            setDeletingUnit(undefined)
            if (error instanceof UnitInUseError) {
                toast({ variant: 'destructive', description: t('units.messages.inUse', { defaultValue: 'This unit is used by a product or unit relationship and cannot be deleted.' }) })
            } else {
                toast({ variant: 'destructive', description: t('units.messages.deleteFailed', { defaultValue: 'Could not delete unit. Please try again.' }) })
            }
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Package className="w-6 h-6 text-primary" />
                        {t('units.title', 'Units')}
                    </h1>
                    <p className="text-muted-foreground">
                        {t('units.subtitle', 'Manage the units used by your products.')} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" onClick={() => setRelationshipsOpen(true)} className="rounded-xl">
                        <GitBranch className="mr-2 h-4 w-4" /> {t('units.relationships.button')}
                    </Button>
                    {canEdit && (
                        <Button onClick={openCreateDialog} className="rounded-xl shadow-lg transition-all active:scale-95" data-tour-id="tutorial-units-new-button">
                            <Plus className="mr-2 h-4 w-4" /> {t('units.addUnit', 'New Unit')}
                        </Button>
                    )}
                </div>
            </div>

            <div className="flex items-center justify-between gap-4">
                <div className="relative w-full max-w-sm">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder={t('units.searchPlaceholder', 'Search units...')}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        allowViewer={true}
                        className="pl-10 rounded-xl bg-card border-none shadow-sm focus-visible:ring-1 focus-visible:ring-primary/50 transition-all"
                    />
                </div>
            </div>

            <Card className="rounded-2xl overflow-hidden border-2 shadow-sm">
                <CardHeader className="bg-muted/30 border-b">
                    <CardTitle className="text-lg font-bold flex items-center gap-2">
                        <Package className="w-5 h-5 text-primary/70" />
                        {t('units.listTitle', 'Units')}
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <Table data-tour-id="tutorial-units-list">
                        <TableHeader className="bg-muted/20">
                            <TableRow className="hover:bg-transparent border-b">
                                <TableHead className="font-bold py-4 pl-6 text-primary/80">{t('units.table.unit', 'Unit')}</TableHead>
                                <TableHead className="font-bold">{t('units.table.behavior', 'Behavior')}</TableHead>
                                <TableHead className="text-right font-bold pr-6">{t('units.table.actions', 'Actions')}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredUnits.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={3} className="h-48 text-center bg-muted/5">
                                        <div className="flex flex-col items-center justify-center gap-2 opacity-30">
                                            <Package className="w-12 h-12" />
                                            <p className="text-sm font-medium">{t('common.noData', 'No results found.')}</p>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredUnits.map((unit) => (
                                    <TableRow key={unit.id} className="group hover:bg-muted/30 transition-colors border-b last:border-0 text-foreground/80">
                                        <TableCell className="font-bold pl-6 text-foreground">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <ProductUnitIcon unit={unit.code} iconName={unit.icon} className="h-4 w-4 text-primary/70" />
                                                {unit.code}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            {unit.isDynamic ? (
                                                <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                                                    {t('units.dynamicBadge', 'Dynamic')}
                                                </span>
                                            ) : (
                                                <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-muted text-muted-foreground">
                                                    {t('units.staticBadge', 'Static')}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right pr-6">
                                            {canEdit && (
                                                <div className="flex items-center justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 rounded-lg"
                                                        title={t('units.edit', 'Edit')}
                                                        onClick={() => openEditDialog(unit)}
                                                    >
                                                        <Edit className="h-4 w-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 rounded-lg text-destructive"
                                                        title={t('units.delete', 'Delete')}
                                                        onClick={() => setDeletingUnit(unit)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!isSaving) setIsDialogOpen(open) }}>
                <DialogContent className="max-w-md" showCloseButton={!isSaving}>
                    <DialogHeader>
                        <DialogTitle>
                            {editingUnit
                                ? t('units.editTitle', 'Edit Unit')
                                : t('units.addTitle', 'New Unit')}
                        </DialogTitle>
                    </DialogHeader>

                    <div className="space-y-5 py-2">
                        <div className="space-y-2">
                            <Label htmlFor="unit-code" className="font-bold">
                                {t('units.code', 'Unit name')} *
                            </Label>
                            <Input
                                id="unit-code"
                                value={draft.code}
                                onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value }))}
                                placeholder={t('units.codePlaceholder', 'e.g. kg, bottle, box')}
                                allowViewer={true}
                                disabled={isSaving}
                                required
                                className="h-11 rounded-lg border-border/40 bg-muted/10"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label className="font-bold">{t('units.icon', 'Icon')}</Label>
                            <div className="grid grid-cols-8 gap-1.5 max-h-40 overflow-y-auto rounded-lg border border-border/40 bg-muted/10 p-2">
                                {CUSTOM_UNIT_ICON_CHOICES.map((iconName) => (
                                    <button
                                        key={iconName}
                                        type="button"
                                        disabled={isSaving}
                                        onClick={() => setDraft((current) => ({ ...current, icon: iconName }))}
                                        className={cn(
                                            'flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-primary/10',
                                            draft.icon === iconName && 'bg-primary/15 ring-1 ring-primary/40',
                                        )}
                                        title={iconName}
                                    >
                                        <ProductUnitIcon unit={draft.code} iconName={iconName} className="h-4 w-4 text-primary/70" />
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/10 p-3">
                            <div className="space-y-0.5">
                                <Label className="flex items-center gap-1.5 font-bold">
                                    <Sparkles className="h-4 w-4 text-primary/70" />
                                    {t('units.dynamic', 'Dynamic unit')}
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                    {t('units.dynamicHint', 'Allows fractional quantities and a quantity adjuster in POS.')}
                                </p>
                            </div>
                            <Switch
                                checked={draft.isDynamic}
                                disabled={isSaving}
                                onCheckedChange={(checked) => setDraft((current) => ({ ...current, isDynamic: checked }))}
                            />
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" disabled={isSaving} onClick={() => setIsDialogOpen(false)}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button onClick={handleSave} disabled={isSaving || !draft.code.trim()}>
                            {isSaving
                                ? t('common.saving', 'Saving...')
                                : t('common.save', 'Save')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={!!deletingUnit}
                onClose={() => setDeletingUnit(undefined)}
                onConfirm={handleDelete}
                title={t('units.confirmDelete', 'Delete Unit')}
                description={t('units.deleteHint', 'This unit will be permanently deleted. Products using it cannot be deleted this way.')}
                isLoading={isDeleting}
            />

            <UnitRelationshipsDialog
                open={relationshipsOpen}
                onOpenChange={setRelationshipsOpen}
                workspaceId={activeWorkspace?.id}
                units={units}
                canEdit={canEdit}
            />
        </div>
    )
}
