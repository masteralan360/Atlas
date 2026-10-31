import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, CheckCircle2, Loader2 } from 'lucide-react'
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
} from '@/ui/components'
import { postalCommand, type PostalScope } from '@/local-db/postal'
import { normalizePostalOrganizationName, type PostalOrganization } from './domain'
import { usePostalAction } from './usePostalAccess'
import { OrganizationCode } from './OrganizationCode'

export function CreateOrganizationDialog({
  open,
  scope,
  onClose,
}: {
  open: boolean
  scope: PostalScope
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [createdOrganization, setCreatedOrganization] =
    useState<PostalOrganization | null>(null)
  const action = usePostalAction()
  const normalizedName = normalizePostalOrganizationName(name)

  const close = () => {
    if (!action.busy) onClose()
  }

  const createOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!normalizedName || createdOrganization || action.busy) return

    void action.run(normalizedName, async (requestId) => {
      const organization = await postalCommand<PostalOrganization>(
        scope,
        'create_organization',
        { name: normalizedName },
        requestId,
      )
      setCreatedOrganization(organization)
    })
  }

  if (scope.role !== 'admin') return null

  return (
    <AppDialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <AppDialogContent className="max-w-xl" showCloseButton={!action.busy}>
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            {createdOrganization ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : (
              <Building2 className="h-5 w-5" />
            )}
            {t(
              createdOrganization
                ? 'postal.organizationCreatedTitle'
                : 'postal.createOrganization',
            )}
          </AppDialogTitle>
        </AppDialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={createOrganization}
        >
          <AppDialogBody className="space-y-4">
            {createdOrganization ? (
              <>
                <p className="text-sm text-muted-foreground" role="status">
                  {t('postal.organizationCreatedHint')}
                </p>
                <OrganizationCode code={createdOrganization.code} />
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="postal-create-organization-name">
                  {t('postal.organizationName')} *
                </Label>
                <Input
                  id="postal-create-organization-name"
                  value={name}
                  maxLength={120}
                  required
                  disabled={action.busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            )}
          </AppDialogBody>
          <AppDialogFooter>
            {createdOrganization ? (
              <Button type="button" onClick={close}>
                {t('common.close')}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={action.busy}
                  onClick={close}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={action.busy || !normalizedName}
                >
                  {action.busy && (
                    <Loader2 className="me-2 h-4 w-4 animate-spin" />
                  )}
                  {t('postal.createOrganization')}
                </Button>
              </>
            )}
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  )
}
