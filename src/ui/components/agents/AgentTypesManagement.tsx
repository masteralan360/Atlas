import { useMemo, useState } from 'react'
import { BriefcaseBusiness, Loader2, Pencil, Plus, Tag, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  createCustomAgentType,
  deleteCustomAgentType,
  updateCustomAgentType,
  useAgents,
  useCustomAgentTypes,
  type AgentMode,
  type CustomAgentType,
} from '@/local-db'
import { Button, Card, CardContent, CardHeader, CardTitle, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useToast } from '@/ui/components'
import { AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle } from '@/ui/components/dialog'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Input } from '@/ui/components/input'

const AGENT_MODES: AgentMode[] = ['driver', 'courier', 'field_agent', 'seller']

function agentModeLabel(mode: AgentMode, t: (key: string, options?: Record<string, unknown>) => string) {
  return t(`businessPartners.agent.types.${mode}`, { defaultValue: mode })
}

export function AgentTypesManagement({
  workspaceId,
  canEdit,
  canDelete,
}: {
  workspaceId?: string
  canEdit: boolean
  canDelete: boolean
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const agentTypes = useCustomAgentTypes(workspaceId)
  const agents = useAgents(workspaceId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingType, setEditingType] = useState<CustomAgentType | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CustomAgentType | null>(null)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<AgentMode | ''>('')
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const assignedCounts = useMemo(() => {
    const counts = new Map<string, number>()
    agents.forEach((agent) => {
      if (!agent.isDeleted && agent.customAgentTypeId) {
        counts.set(agent.customAgentTypeId, (counts.get(agent.customAgentTypeId) ?? 0) + 1)
      }
    })
    return counts
  }, [agents])

  function openCreate() {
    setEditingType(null)
    setName('')
    setMode('')
    setDialogOpen(true)
  }

  function openEdit(agentType: CustomAgentType) {
    setEditingType(agentType)
    setName(agentType.name)
    setMode(agentType.mode)
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!workspaceId || !name.trim() || !mode) return
    setIsSaving(true)
    try {
      if (editingType) {
        await updateCustomAgentType(editingType.id, { name: name.trim(), mode })
        toast({ title: t('agents.agentTypes.updateSuccess', { defaultValue: 'Agent type updated.' }) })
      } else {
        await createCustomAgentType(workspaceId, { name: name.trim(), mode })
        toast({ title: t('agents.agentTypes.createSuccess', { defaultValue: 'Agent type created.' }) })
      }
      setDialogOpen(false)
      setEditingType(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const isDuplicate = /23505|duplicate|unique/i.test(message)
      toast({
        title: t('common.error', { defaultValue: 'Error' }),
        description: isDuplicate
          ? t('agents.agentTypes.duplicateName', { defaultValue: 'An agent type with this name already exists in this workspace.' })
          : /assigned|reassign/i.test(message)
            ? t('agents.agentTypes.modeLocked', { defaultValue: 'Reassign agents before changing this type’s mode.' })
            : t('agents.agentTypes.saveFailed', { defaultValue: 'The agent type could not be saved.' }),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await deleteCustomAgentType(deleteTarget.id)
      toast({ title: t('agents.agentTypes.deleteSuccess', { defaultValue: 'Agent type deleted.' }) })
      setDeleteTarget(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      toast({
        title: t('common.error', { defaultValue: 'Error' }),
        description: /assigned|reassign/i.test(message)
          ? t('agents.agentTypes.assignedDeleteBlocked', { defaultValue: 'Reassign agents before deleting this agent type.' })
          : t('agents.agentTypes.deleteFailed', { defaultValue: 'The agent type could not be deleted.' }),
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Tag className="h-5 w-5 text-primary" />
              {t('agents.agentTypes.title', { defaultValue: 'Agent Types' })}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('agents.agentTypes.description', { defaultValue: 'Create workspace agent labels that use one of the supported agent modes.' })}
            </p>
          </div>
          {canEdit ? (
            <Button onClick={openCreate} className="gap-2 rounded-xl">
              <Plus className="h-4 w-4" />
              {t('agents.agentTypes.create', { defaultValue: 'Create Agent Type' })}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('agents.agentTypes.name', { defaultValue: 'Agent Type Name' })}</TableHead>
                  <TableHead>{t('agents.agentTypes.mode', { defaultValue: 'Mode' })}</TableHead>
                  <TableHead>{t('agents.agentTypes.assignedAgents', { defaultValue: 'Assigned Agents' })}</TableHead>
                  {canEdit || canDelete ? <TableHead className="text-right">{t('common.actions', { defaultValue: 'Actions' })}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {agentTypes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canEdit || canDelete ? 4 : 3} className="py-12 text-center text-muted-foreground">
                      {t('agents.agentTypes.empty', { defaultValue: 'No custom agent types have been created.' })}
                    </TableCell>
                  </TableRow>
                ) : agentTypes
                  .slice()
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map((agentType) => {
                    const assignedCount = assignedCounts.get(agentType.id) ?? 0
                    return (
                      <TableRow key={agentType.id}>
                        <TableCell className="font-semibold">
                          <span className="inline-flex items-center gap-2"><BriefcaseBusiness className="h-4 w-4 text-muted-foreground" />{agentType.name}</span>
                        </TableCell>
                        <TableCell>{agentModeLabel(agentType.mode, t)}</TableCell>
                        <TableCell>{assignedCount}</TableCell>
                        {canEdit || canDelete ? (
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              {canEdit ? (
                                <Button variant="ghost" size="icon" onClick={() => openEdit(agentType)} title={t('common.edit', { defaultValue: 'Edit' })}>
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              ) : null}
                              {canDelete ? (
                                <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget(agentType)} title={t('common.delete', { defaultValue: 'Delete' })}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              ) : null}
                            </div>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    )
                  })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <AppDialog open={dialogOpen} onOpenChange={(open) => { if (!isSaving) setDialogOpen(open) }}>
        <AppDialogContent className="max-w-xl">
          <AppDialogHeader>
            <AppDialogTitle>{editingType
              ? t('agents.agentTypes.edit', { defaultValue: 'Edit Agent Type' })
              : t('agents.agentTypes.create', { defaultValue: 'Create Agent Type' })}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="custom-agent-type-name">{t('agents.agentTypes.name', { defaultValue: 'Agent Type Name' })} <span className="text-destructive">*</span></Label>
                <Input id="custom-agent-type-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoFocus />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>{t('agents.agentTypes.mode', { defaultValue: 'Mode' })} <span className="text-destructive">*</span></Label>
                <Select value={mode} onValueChange={(value) => setMode(value as AgentMode)} disabled={Boolean(editingType && (assignedCounts.get(editingType.id) ?? 0) > 0)}>
                  <SelectTrigger><SelectValue placeholder={t('agents.agentTypes.selectMode', { defaultValue: 'Select a mode' })} /></SelectTrigger>
                  <SelectContent>
                    {AGENT_MODES.map((agentMode) => (
                      <SelectItem key={agentMode} value={agentMode}>{agentModeLabel(agentMode, t)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editingType && (assignedCounts.get(editingType.id) ?? 0) > 0 ? (
                  <p className="text-xs text-muted-foreground">{t('agents.agentTypes.modeLocked', { defaultValue: 'Reassign agents before changing this type’s mode.' })}</p>
                ) : null}
              </div>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" type="button" onClick={() => { if (!isSaving) setDialogOpen(false) }} disabled={isSaving}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="button" onClick={() => void handleSave()} disabled={isSaving || !name.trim() || !mode} className="gap-2">
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isSaving ? t('common.saving', { defaultValue: 'Saving...' }) : t('common.save', { defaultValue: 'Save' })}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <DeleteConfirmationModal
        isOpen={Boolean(deleteTarget)}
        onClose={() => { if (!isDeleting) setDeleteTarget(null) }}
        onConfirm={() => void handleDelete()}
        isLoading={isDeleting}
        itemName={deleteTarget?.name}
        title={t('agents.agentTypes.deleteTitle', { defaultValue: 'Delete Agent Type' })}
        description={t('agents.agentTypes.deleteDescription', { defaultValue: 'Agents must be reassigned before this type can be deleted.' })}
        simpleConfirmation
      />
    </>
  )
}
