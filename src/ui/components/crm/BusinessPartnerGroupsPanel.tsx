import { useEffect, useMemo, useState } from 'react'
import { Building2, Pencil, Plus, ShieldCheck, Trash2, Users, UsersRound, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  createBusinessPartnerGroup,
  deleteBusinessPartnerGroup,
  saveBusinessPartnerGroupMembers,
  updateBusinessPartnerGroup,
  useBusinessPartnerGroups,
  useBusinessPartners,
  useWorkspaceUsers,
  type BusinessPartner,
  type BusinessPartnerGroup,
  type BusinessPartnerGroupAccessType,
} from '@/local-db'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Card,
  CardContent,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@/ui/components'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { getActiveAssignedBusinessPartners } from '@/lib/businessPartnerGroupPrivacy'

interface BusinessPartnerGroupsPanelProps {
  workspaceId: string
  featureEnabled: boolean
}

export function BusinessPartnerGroupsPanel({ workspaceId, featureEnabled }: BusinessPartnerGroupsPanelProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const groupsState = useBusinessPartnerGroups(workspaceId, featureEnabled)
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  const partnersState = useBusinessPartners(workspaceId, { includeAgentRoles: true, includeRealEstateRoles: true })
  const eligibleUsers = useMemo(
    () => workspaceUsers
      .filter((workspaceUser) => !workspaceUser.isDeleted && workspaceUser.role !== 'admin')
      .sort((left, right) => left.name.localeCompare(right.name)),
    [workspaceUsers],
  )

  const [createOpen, setCreateOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<BusinessPartnerGroup | null>(null)
  const [name, setName] = useState('')
  const [accessType, setAccessType] = useState<BusinessPartnerGroupAccessType>('non_grouped')
  const [isSavingGroup, setIsSavingGroup] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [memberGroupId, setMemberGroupId] = useState('')
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [selectedAutoAssignUserIds, setSelectedAutoAssignUserIds] = useState<string[]>([])
  const [selectedPartnerIds, setSelectedPartnerIds] = useState<string[]>([])
  const [partnerSearch, setPartnerSearch] = useState('')
  const [memberTab, setMemberTab] = useState<'users' | 'partners'>('users')
  const [isSavingMembers, setIsSavingMembers] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<BusinessPartnerGroup | null>(null)
  const [isDeletingGroup, setIsDeletingGroup] = useState(false)

  const selectedGroup = groupsState.groups.find((group) => group.id === memberGroupId)
  const partnerById = useMemo(
    () => new Map<string, BusinessPartner>(partnersState.map((partner) => [partner.id, partner])),
    [partnersState],
  )

  useEffect(() => {
    if (!membersOpen || !selectedGroup) return
    setSelectedUserIds(groupsState.groupUsers
      .filter((membership) => membership.groupId === selectedGroup.id)
      .map((membership) => membership.userId))
    setSelectedAutoAssignUserIds(groupsState.groupUsers
      .filter((membership) => membership.groupId === selectedGroup.id && membership.autoAssignOnCreate !== false)
      .map((membership) => membership.userId))
    setSelectedPartnerIds(groupsState.groupPartners
      .filter((assignment) => assignment.groupId === selectedGroup.id)
      .map((assignment) => assignment.businessPartnerId))
  }, [membersOpen, selectedGroup?.id, groupsState.groupUsers, groupsState.groupPartners])

  function openCreate() {
    setEditingGroup(null)
    setName('')
    setAccessType('non_grouped')
    setCreateOpen(true)
  }

  function openEdit(group: BusinessPartnerGroup) {
    setEditingGroup(group)
    setName(group.name)
    setAccessType(group.accessType)
    setCreateOpen(true)
  }

  function openMembers(groupId?: string) {
    setMemberGroupId(groupId ?? '')
    setSelectedUserIds([])
    setSelectedAutoAssignUserIds([])
    setSelectedPartnerIds([])
    setPartnerSearch('')
    setMemberTab('users')
    setMembersOpen(true)
  }

  async function handleSaveGroup(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setIsSavingGroup(true)
    try {
      if (editingGroup) {
        await updateBusinessPartnerGroup(workspaceId, editingGroup.id, { name, accessType })
        toast({ title: t('businessPartners.groupPrivacy.groupUpdated') })
      } else {
        await createBusinessPartnerGroup(workspaceId, name, accessType)
        toast({ title: t('businessPartners.groupPrivacy.groupCreated') })
      }
      setCreateOpen(false)
    } catch {
      toast({
        title: t('common.error'),
        description: t('businessPartners.groupPrivacy.saveFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsSavingGroup(false)
    }
  }

  async function handleSaveMembers() {
    if (!selectedGroup) return
    setIsSavingMembers(true)
    try {
      await saveBusinessPartnerGroupMembers(
        workspaceId,
        selectedGroup.id,
        selectedUserIds,
        selectedPartnerIds,
        selectedAutoAssignUserIds,
      )
      toast({ title: t('businessPartners.groupPrivacy.membersUpdated') })
      setMembersOpen(false)
    } catch {
      toast({
        title: t('common.error'),
        description: t('businessPartners.groupPrivacy.saveFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsSavingMembers(false)
    }
  }

  async function handleDeleteGroup() {
    if (!deleteTarget) return
    setIsDeletingGroup(true)
    try {
      await deleteBusinessPartnerGroup(workspaceId, deleteTarget.id)
      toast({ title: t('businessPartners.groupPrivacy.groupDeleted') })
      setDeleteTarget(null)
    } catch {
      toast({
        title: t('common.error'),
        description: t('businessPartners.groupPrivacy.saveFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsDeletingGroup(false)
    }
  }

  const selectedPartnerChips = getActiveAssignedBusinessPartners(
    selectedPartnerIds,
    [...partnerById.values()],
  )
    .sort((left, right) => left.partnerName.localeCompare(right.partnerName))

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {t('businessPartners.groupPrivacy.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('businessPartners.groupPrivacy.description')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => openMembers()}>
            <UsersRound className="me-2 h-4 w-4" />
            {t('businessPartners.groupPrivacy.manageGroupMembers')}
          </Button>
          <Button onClick={openCreate}>
            <Plus className="me-2 h-4 w-4" />
            {t('businessPartners.groupPrivacy.createGroup')}
          </Button>
        </div>
      </div>

      {groupsState.groups.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-36 flex-col items-center justify-center gap-2 p-6 text-center">
            <Users className="h-8 w-8 text-muted-foreground" />
            <p className="font-semibold">{t('businessPartners.groupPrivacy.noGroups')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groupsState.groups.map((group) => {
            const userCount = groupsState.groupUsers.filter((row) => row.groupId === group.id).length
            const partnerCount = getActiveAssignedBusinessPartners(
              groupsState.groupPartners
                .filter((row) => row.groupId === group.id)
                .map((row) => row.businessPartnerId),
              [...partnerById.values()],
            ).length
            const isNonGrouped = group.accessType === 'non_grouped'
            return (
              <Card key={group.id}>
                <CardContent className="space-y-4 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <h3 className="break-words font-bold">{group.name}</h3>
                      <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium">
                        {isNonGrouped ? <Users className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                        {t(isNonGrouped
                          ? 'businessPartners.groupPrivacy.nonGroupedAccess'
                          : 'businessPartners.groupPrivacy.protectedGroup')}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="icon" aria-label={t('businessPartners.groupPrivacy.editGroup')} onClick={() => openEdit(group)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="text-destructive" aria-label={t('businessPartners.groupPrivacy.deleteGroup')} onClick={() => setDeleteTarget(group)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4" />{t('businessPartners.groupPrivacy.userCount', { count: userCount })}</span>
                    <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4" />{t('businessPartners.groupPrivacy.partnerCount', { count: partnerCount })}</span>
                  </div>
                  <Button variant="outline" className="w-full" onClick={() => openMembers(group.id)}>
                    <UsersRound className="me-2 h-4 w-4" />
                    {t('businessPartners.groupPrivacy.manageMembers')}
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <AppDialog open={createOpen} onOpenChange={(open) => !isSavingGroup && setCreateOpen(open)}>
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!isSavingGroup}
          onPointerDownOutside={(event) => { if (isSavingGroup) event.preventDefault() }}
          onEscapeKeyDown={(event) => { if (isSavingGroup) event.preventDefault() }}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t(editingGroup ? 'businessPartners.groupPrivacy.editGroup' : 'businessPartners.groupPrivacy.createGroup')}</AppDialogTitle>
          </AppDialogHeader>
          <form onSubmit={handleSaveGroup} className="flex min-h-0 flex-1 flex-col">
            <AppDialogBody className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="business-partner-group-name">{t('businessPartners.groupPrivacy.groupName')} <span className="text-destructive">*</span></Label>
                <Input id="business-partner-group-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="business-partner-group-access">{t('businessPartners.groupPrivacy.accessType')} <span className="text-destructive">*</span></Label>
                <Select value={accessType} onValueChange={(value) => setAccessType(value as BusinessPartnerGroupAccessType)}>
                  <SelectTrigger id="business-partner-group-access"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="non_grouped">{t('businessPartners.groupPrivacy.nonGroupedAccess')}</SelectItem>
                    <SelectItem value="protected">{t('businessPartners.groupPrivacy.protectedGroup')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {t(accessType === 'non_grouped'
                    ? 'businessPartners.groupPrivacy.nonGroupedDescription'
                    : 'businessPartners.groupPrivacy.protectedDescription')}
                </p>
              </div>
            </AppDialogBody>
            <AppDialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={isSavingGroup}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={!name.trim() || isSavingGroup}>
                {isSavingGroup ? t('common.saving') : t(editingGroup ? 'common.save' : 'common.create')}
              </Button>
            </AppDialogFooter>
          </form>
        </AppDialogContent>
      </AppDialog>

      <AppDialog open={membersOpen} onOpenChange={(open) => !isSavingMembers && setMembersOpen(open)}>
        <AppDialogContent
          className="max-w-4xl"
          showCloseButton={!isSavingMembers}
          onPointerDownOutside={(event) => { if (isSavingMembers) event.preventDefault() }}
          onEscapeKeyDown={(event) => { if (isSavingMembers) event.preventDefault() }}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('businessPartners.groupPrivacy.manageGroupMembers')}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="business-partner-group-select">{t('businessPartners.groupPrivacy.selectGroup')} <span className="text-destructive">*</span></Label>
              <Select value={memberGroupId} onValueChange={setMemberGroupId}>
                <SelectTrigger id="business-partner-group-select"><SelectValue placeholder={t('businessPartners.groupPrivacy.selectGroup')} /></SelectTrigger>
                <SelectContent>
                  {groupsState.groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {selectedGroup ? (
              <Tabs value={memberTab} onValueChange={(value) => setMemberTab(value as 'users' | 'partners')}>
                <TabsList className="grid w-full grid-cols-2 sm:w-fit">
                  <TabsTrigger value="users">{t('businessPartners.groupPrivacy.usersTab', { count: selectedUserIds.length })}</TabsTrigger>
                  <TabsTrigger value="partners">{t('businessPartners.groupPrivacy.partnersTab', { count: selectedPartnerChips.length })}</TabsTrigger>
                </TabsList>
                <TabsContent value="users" className="mt-4">
                  <p className="mb-3 text-sm text-muted-foreground">
                    {t('businessPartners.groupPrivacy.creatorAssignmentDescription')}
                  </p>
                  {eligibleUsers.length ? (
                    <div className="max-h-[45vh] space-y-1 overflow-y-auto rounded-xl border p-2">
                      {eligibleUsers.map((workspaceUser) => (
                        <div key={workspaceUser.id} className="flex flex-col gap-2 rounded-lg px-3 py-2 hover:bg-muted/60 sm:flex-row sm:items-center sm:gap-3">
                          <div className="flex min-w-0 items-center gap-3 sm:flex-1">
                            <Checkbox
                              id={`business-partner-group-user-${workspaceUser.id}`}
                              checked={selectedUserIds.includes(workspaceUser.id)}
                              disabled={isSavingMembers}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedUserIds((current) => [...new Set([...current, workspaceUser.id])])
                                  setSelectedAutoAssignUserIds((current) => [...new Set([...current, workspaceUser.id])])
                                } else {
                                  setSelectedUserIds((current) => current.filter((id) => id !== workspaceUser.id))
                                  setSelectedAutoAssignUserIds((current) => current.filter((id) => id !== workspaceUser.id))
                                }
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <Label htmlFor={`business-partner-group-user-${workspaceUser.id}`} className="cursor-pointer truncate font-medium">
                                {workspaceUser.name}
                              </Label>
                              <p className="truncate text-xs text-muted-foreground">{workspaceUser.email}</p>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-3 border-t pt-2 sm:justify-end sm:border-t-0 sm:pt-0">
                            <Label htmlFor={`business-partner-group-auto-assign-${workspaceUser.id}`} className="cursor-pointer text-xs text-muted-foreground">
                              {t('businessPartners.groupPrivacy.autoAssignNewPartners')}
                            </Label>
                            <Switch
                              id={`business-partner-group-auto-assign-${workspaceUser.id}`}
                              checked={selectedAutoAssignUserIds.includes(workspaceUser.id)}
                              disabled={!selectedUserIds.includes(workspaceUser.id) || isSavingMembers}
                              onCheckedChange={(checked) => setSelectedAutoAssignUserIds((current) => checked
                                ? [...new Set([...current, workspaceUser.id])]
                                : current.filter((id) => id !== workspaceUser.id))}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <p className="py-8 text-center text-sm text-muted-foreground">{t('businessPartners.groupPrivacy.noUsers')}</p>}
                </TabsContent>
                <TabsContent value="partners" className="mt-4 space-y-4">
                  <PartnerAutocompleteInput
                    value={partnerSearch}
                    onChange={setPartnerSearch}
                    onSelectPartner={(partner) => {
                      setSelectedPartnerIds((current) => current.includes(partner.id) ? current : [...current, partner.id])
                      setPartnerSearch('')
                    }}
                    workspaceId={workspaceId}
                    includeAgentRoles
                    includeRealEstateRoles
                    placeholder={t('businessPartners.groupPrivacy.searchPartners')}
                    disabled={partnersState.isLoading}
                  />
                  {selectedPartnerChips.length ? (
                    <div className="flex max-h-[36vh] flex-wrap content-start gap-2 overflow-y-auto rounded-xl border p-3">
                      {selectedPartnerChips.map((partner) => (
                        <span key={partner.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-3 py-1.5 text-sm">
                          <span className="max-w-[min(70vw,26rem)] truncate">{partner.partnerName}</span>
                          <button
                            type="button"
                            className="ms-1 rounded-full p-0.5 hover:bg-background"
                            aria-label={t('businessPartners.groupPrivacy.removePartner', { name: partner.partnerName })}
                            onClick={() => setSelectedPartnerIds((current) => current.filter((id) => id !== partner.id))}
                          ><X className="h-3.5 w-3.5" /></button>
                        </span>
                      ))}
                    </div>
                  ) : <p className="py-8 text-center text-sm text-muted-foreground">{t('businessPartners.groupPrivacy.noPartners')}</p>}
                </TabsContent>
              </Tabs>
            ) : null}
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setMembersOpen(false)} disabled={isSavingMembers}>{t('common.cancel')}</Button>
            <Button onClick={() => void handleSaveMembers()} disabled={!selectedGroup || isSavingMembers}>
              {isSavingMembers ? t('common.saving') : t('businessPartners.groupPrivacy.saveMemberships')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <DeleteConfirmationModal
        isOpen={Boolean(deleteTarget)}
        onClose={() => !isDeletingGroup && setDeleteTarget(null)}
        onConfirm={() => void handleDeleteGroup()}
        title={t('businessPartners.groupPrivacy.deleteGroup')}
        description={t('businessPartners.groupPrivacy.deleteDescription')}
        itemName={deleteTarget?.name ?? ''}
        isLoading={isDeletingGroup}
        simpleConfirmation
      />
    </section>
  )
}
