import { usePostalAction } from './usePostalAccess'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Loader2, MapPin, ShieldCheck, Users } from 'lucide-react'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  Checkbox,
  useToast,
} from '@/ui/components'
import {
  postalAddGovernorateBranches,
  postalCommand,
  postalSaveBranch,
  usePostalLocationCatalog,
  usePostalMembers,
  type PostalScope,
} from '@/local-db/postal'
import { emptyPostalLocationCatalog, type PostalBranch, type PostalOrganization } from './domain'
import { MembershipDialog } from './MembershipDialog'
import { OrganizationCode } from './OrganizationCode'
import { GovernoratePicker, PostalLoading, PostalError } from './shared'

type BranchNameLocale = 'en' | 'ar' | 'ku'

export function AddAllGovernoratesDialog({
  scope,
  onClose,
}: {
  scope: PostalScope
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [locale, setLocale] = useState<BranchNameLocale | ''>('')
  const action = usePostalAction()
  const locationCatalogQuery = usePostalLocationCatalog(scope)
  const locationCatalog = locationCatalogQuery.data ?? emptyPostalLocationCatalog
  const governorates = locationCatalog.governorates.filter((governorate) => governorate.isActive)

  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose()
      }}
    >
      <AppDialogContent className="max-w-xl" showCloseButton={!action.busy}>
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            {t('postal.bulkBranchesTitle')}
          </AppDialogTitle>
          <AppDialogDescription>
            {t('postal.bulkBranchesDescription', {
              count: governorates.length,
            })}
          </AppDialogDescription>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          {locationCatalogQuery.error && (
            <PostalError retry={() => void locationCatalogQuery.refetch()} />
          )}
          {locationCatalogQuery.isPending && <PostalLoading />}
          <div className="space-y-2">
            <Label htmlFor="postal-branch-name-locale">
              {t('postal.branchNameLocale')} *
            </Label>
            <Select
              value={locale}
              onValueChange={(value) => setLocale(value as BranchNameLocale)}
              disabled={action.busy}
            >
              <SelectTrigger id="postal-branch-name-locale">
                <SelectValue placeholder={t('postal.selectBranchNameLocale')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">
                  {t('settings.monthDisplay.english')}
                </SelectItem>
                <SelectItem value="ar">
                  {t('settings.monthDisplay.arabic')}
                </SelectItem>
                <SelectItem value="ku">
                  {t('settings.monthDisplay.kurdish')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
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
            type="button"
            disabled={action.busy || !locale || locationCatalogQuery.isPending || governorates.length === 0}
            onClick={() => {
              if (!locale) return
              const branches = governorates.map(
                (governorate) => ({
                  name: governorate[locale],
                  governorate: governorate.id,
                }),
              )
              const signature = JSON.stringify({ locale, branches })
              void action.run(signature, async (requestId) => {
                await postalAddGovernorateBranches(
                  scope,
                  locale,
                  branches,
                  requestId,
                )
                toast({
                  title: t('postal.bulkBranchesAddedTitle'),
                  description: t('postal.bulkBranchesAdded', {
                    count: branches.length,
                  }),
                })
                onClose()
              })
            }}
          >
            {action.busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('postal.addAllGovernorates')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}

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
  const [address, setAddress] = useState(branch?.address ?? '')
  const [active, setActive] = useState(branch?.active ?? true)
  const [isPrimary, setIsPrimary] = useState(branch?.is_primary ?? false)
  const action = usePostalAction()
  const locationCatalogQuery = usePostalLocationCatalog(scope)
  const locationCatalog = locationCatalogQuery.data ?? emptyPostalLocationCatalog
  const selectedGovernorate = locationCatalog.governorates.find((entry) => entry.id === governorate)
  const validGovernorate = Boolean(
    selectedGovernorate?.isActive || (branch && branch.governorate === governorate),
  )
  const payload = {
    id: branch?.id,
    name: name.trim(),
    governorate,
    address: address.trim(),
    active,
    is_primary: active && isPrimary,
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
            if (!name.trim() || !validGovernorate) return
            void action.run(JSON.stringify(payload), async (id) => {
              await postalSaveBranch(scope, payload, id)
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
            {locationCatalogQuery.error && (
              <PostalError retry={() => void locationCatalogQuery.refetch()} />
            )}
            {locationCatalogQuery.isPending && <PostalLoading />}
            <GovernoratePicker
              governorate={governorate}
              catalog={locationCatalog}
              disabled={action.busy || locationCatalogQuery.isPending || !locationCatalogQuery.data}
              onChange={setGovernorate}
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
                onCheckedChange={(checked) => {
                  const nextActive = checked === true
                  setActive(nextActive)
                  if (!nextActive) setIsPrimary(false)
                }}
              />
              {t('postal.active')}
            </Label>
            <Label className="flex gap-2">
              <Checkbox
                checked={isPrimary && active}
                disabled={action.busy || !active}
                onCheckedChange={(checked) => setIsPrimary(checked === true)}
              />
              <span className="space-y-1">
                <span className="block">{t('postal.setPrimary')}</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {t('postal.setPrimaryHint')}
                </span>
              </span>
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
              disabled={action.busy || !name.trim() || !validGovernorate}
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
  const [phone, setPhone] = useState(organization.phone ?? '')
  const [leader, setLeader] = useState(organization.leader_id ?? '')
  const [movingMember, setMovingMember] = useState('')
  const members = usePostalMembers(scope, organization.id)
  const choices = members.data?.pages.flat() ?? []
  const action = usePostalAction()
  const payload = {
    id: organization.id,
    name: name.trim(),
    phone: phone.trim(),
    leader_id: leader || null,
  }
  if (movingMember)
    return (
      <MembershipDialog
        scope={scope}
        userId={movingMember}
        leaderId={organization.leader_id ?? ''}
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
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <OrganizationCode code={organization.code} />
          <div className="space-y-2">
            <Label htmlFor="postal-org-name">
              {t('postal.organizationName')} *
            </Label>
            <Input
              id="postal-org-name"
              value={name}
              maxLength={120}
              required
              disabled={action.busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="postal-org-phone">
              {t('postal.organizationPhoneNumber')} *
            </Label>
            <Input
              id="postal-org-phone"
              type="tel"
              autoComplete="tel"
              dir="ltr"
              value={phone}
              maxLength={32}
              required
              disabled={action.busy}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          {members.isLoading ? (
            <PostalLoading />
          ) : members.error ? (
            <PostalError retry={() => void members.refetch()} />
          ) : choices.length > 0 ? (
            <div className="grid gap-2">
              <Label>{t('postal.leader')} *</Label>
              <p className="text-sm text-muted-foreground">
                {t('postal.leaderHint')}
              </p>
              {leader && !choices.some((x) => x.user_id === leader) && (
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
          ) : (
            <p className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              <Users className="h-4 w-4 shrink-0" />
              {t('postal.noOrganizationMembers')}
            </p>
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
              !phone.trim() ||
              phone.trim().length > 32 ||
              members.isLoading ||
              Boolean(members.error) ||
              (choices.length > 0 &&
                !choices.some((x) => x.user_id === leader)) ||
              (choices.length === 0 && Boolean(organization.leader_id))
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
