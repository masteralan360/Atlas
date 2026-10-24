import { usePostalAction } from './usePostalAccess'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Loader2, ShieldCheck } from 'lucide-react'
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
  Textarea,
  Checkbox,
} from '@/ui/components'
import {
  postalCommand,
  usePostalMembers,
  type PostalScope,
} from '@/local-db/postal'
import type { PostalBranch, PostalOrganization } from './domain'
import { MembershipDialog } from './MembershipDialog'
import { LocationPicker, PostalLoading, PostalError } from './shared'

export function BranchDialog({
  scope,
  branch,
  onClose,
}: {
  scope: PostalScope
  branch?: PostalBranch
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(branch?.name ?? '')
  const [governorate, setGovernorate] = useState(branch?.governorate ?? '')
  const [area, setArea] = useState(branch?.area ?? '')
  const [address, setAddress] = useState(branch?.address ?? '')
  const [active, setActive] = useState(branch?.active ?? true)
  const action = usePostalAction()
  const payload = {
    id: branch?.id,
    name: name.trim(),
    governorate,
    area,
    address: address.trim(),
    active,
  }
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose()
      }}
    >
      <AppDialogContent className="max-w-xl" showCloseButton={!action.busy}>
        <AppDialogHeader>
          <AppDialogTitle className="flex gap-2">
            <Building2 className="h-5 w-5" />
            {t(branch ? 'postal.editBranch' : 'postal.createBranch')}
          </AppDialogTitle>
        </AppDialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || !area) return
            void action.run(JSON.stringify(payload), async (id) => {
              await postalCommand(scope, 'save_branch', payload, id)
              onClose()
            })
          }}
        >
          <AppDialogBody className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="postal-branch-name">
                {t('postal.branchName')} *
              </Label>
              <Input
                id="postal-branch-name"
                required
                maxLength={120}
                value={name}
                disabled={action.busy}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <LocationPicker
              governorate={governorate}
              area={area}
              disabled={action.busy}
              onChange={(g, a) => {
                setGovernorate(g)
                setArea(a)
              }}
            />
            <div className="space-y-2">
              <Label htmlFor="postal-branch-address">
                {t('postal.address')}
              </Label>
              <Textarea
                id="postal-branch-address"
                value={address}
                disabled={action.busy}
                maxLength={2000}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            <Label className="flex gap-2">
              <Checkbox
                checked={active}
                disabled={action.busy}
                onCheckedChange={setActive}
              />
              {t('postal.active')}
            </Label>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              disabled={action.busy}
              variant="outline"
              onClick={onClose}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={action.busy || !name.trim() || !area}
            >
              {action.busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  )
}
export function OrganizationDialog({
  scope,
  organization,
  onClose,
}: {
  scope: PostalScope
  organization: PostalOrganization
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(organization.name)
  const [leader, setLeader] = useState(organization.leader_id)
  const [movingMember, setMovingMember] = useState('')
  const members = usePostalMembers(scope, organization.id)
  const choices = members.data?.pages.flat() ?? []
  const action = usePostalAction()
  const payload = { id: organization.id, name: name.trim(), leader_id: leader }
  if (movingMember)
    return (
      <MembershipDialog
        scope={scope}
        userId={movingMember}
        leaderId={organization.leader_id}
        members={choices.map((x) => ({
          user_id: x.user_id,
          name: x.profiles?.name,
        }))}
        onClose={() => setMovingMember('')}
        onSaved={onClose}
      />
    )
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose()
      }}
    >
      <AppDialogContent className="max-w-xl" showCloseButton={!action.busy}>
        <AppDialogHeader>
          <AppDialogTitle>{t('postal.manageOrganization')}</AppDialogTitle>
          <p className="font-mono text-sm">
            {organization.code.slice(0, 4)}-{organization.code.slice(4)}
          </p>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <Label htmlFor="postal-org-name">
            {t('postal.organizationName')} *
          </Label>
          <Input
            id="postal-org-name"
            value={name}
            maxLength={120}
            disabled={action.busy}
            onChange={(e) => setName(e.target.value)}
          />
          <Label>{t('postal.leader')} *</Label>
          <p className="text-sm text-muted-foreground">
            {t('postal.leaderHint')}
          </p>
          {members.isLoading ? (
            <PostalLoading />
          ) : members.error ? (
            <PostalError retry={() => void members.refetch()} />
          ) : (
            <div className="grid gap-2">
              {!choices.some((x) => x.user_id === leader) && (
                <p className="break-all text-sm">{leader}</p>
              )}
              {choices.map((member) => (
                <Button
                  key={member.user_id}
                  variant={leader === member.user_id ? 'default' : 'outline'}
                  className="justify-start text-xs"
                  disabled={action.busy}
                  aria-pressed={leader === member.user_id}
                  onClick={() => setLeader(member.user_id)}
                >
                  <ShieldCheck className="me-2 h-4 w-4 shrink-0" />
                  <span className="truncate">
                    {member.profiles?.name || member.user_id}
                  </span>
                </Button>
              ))}
              <Label>{t('postal.moveMember')}</Label>
              {choices.map((member) => (
                <Button
                  key={`move:${member.user_id}`}
                  variant="outline"
                  disabled={action.busy}
                  onClick={() => setMovingMember(member.user_id)}
                >
                  {member.profiles?.name || member.user_id}
                </Button>
              ))}
              {members.hasNextPage && (
                <Button
                  disabled={members.isFetchingNextPage || action.busy}
                  variant="outline"
                  onClick={() => void members.fetchNextPage()}
                >
                  {t('postal.loadMore')}
                </Button>
              )}
            </div>
          )}
        </AppDialogBody>
        <AppDialogFooter>
          <Button variant="outline" disabled={action.busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={
              action.busy ||
              !name.trim() ||
              !leader ||
              !choices.some((x) => x.user_id === leader)
            }
            onClick={() =>
              void action.run(JSON.stringify(payload), async (id) => {
                await postalCommand(scope, 'save_organization', payload, id)
                onClose()
              })
            }
          >
            {action.busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('common.save')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
