import { usePostalAction } from './usePostalAccess'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ShieldCheck } from 'lucide-react'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Label,
  Textarea,
} from '@/ui/components'
import { postalCommand, type PostalScope } from '@/local-db/postal'
/* Driver selection is temporarily disabled together with its field below.
import { searchPostalDrivers } from '@/local-db/postal'
import type { BusinessPartner } from '@/local-db/models'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { useWorkspace } from '@/workspace'
import { useWorkspacePermissions } from '@/permissions'
*/
import type { PostalShipment, PostalBranch, PostalTransfer } from './domain'
import { BranchPicker } from './shared'

export function OperationDialog({
  scope,
  shipment,
  transfer,
  operation,
  onClose,
}: {
  scope: PostalScope
  shipment: PostalShipment
  transfer?: PostalTransfer
  operation: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [branch, setBranch] = useState<PostalBranch | null>(
    operation === 'arrive' && transfer
      ? {
          id: transfer.destination_id,
          name: transfer.destination_name ?? transfer.destination_id,
          workspace_id: scope.workspaceId,
          governorate: '',
          area: '',
          address: null,
          active: true,
        }
      : null,
  )
  const [notes, setNotes] = useState('')
  /* Restore with the driver selector when driver assignment is enabled again.
  const [driver, setDriver] = useState<BusinessPartner | null>(null)
  const [driverText, setDriverText] = useState('')
  const { hasFeature } = useWorkspace()
  const { hasPermission } = useWorkspacePermissions()
  const canAssignDriver =
    operation === 'out_for_delivery' &&
    hasFeature('agents') &&
    hasPermission('agents.access')
  */
  const action = usePostalAction()
  const needsBranch =
    operation === 'receive' ||
    operation === 'authorize_transfer' ||
    operation === 'arrive'
  const validBranch =
    !!branch?.active &&
    (operation !== 'authorize_transfer' ||
      branch.id !== shipment.current_branch_id) &&
    (operation !== 'arrive' || branch.id === transfer?.destination_id)
  const valid =
    // Driver selection is disabled and must not block confirmation.
    // (!driverText || !!driver) &&
    (!needsBranch || validBranch) &&
    (operation !== 'cancel' || notes.trim().length > 0)
  const payload = {
    id: shipment.id,
    revision: shipment.revision,
    branch_id: branch?.id,
    notes: notes.trim(),
    // driver_id: driver?.agentFacetId,
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
          <AppDialogTitle>{t(`postal.operations.${operation}`)}</AppDialogTitle>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('postal.operationHint')}
          </p>
          {needsBranch && (
            <BranchPicker
              scope={scope}
              value={branch}
              label={t('postal.branch')}
              disabled={action.busy}
              onChange={setBranch}
            />
          )}
          {operation === 'arrive' && (
            <p className="break-all text-sm">
              {t('postal.authorizedDestination')}:{' '}
              {transfer?.destination_name ?? transfer?.destination_id}
            </p>
          )}
          {/* Driver selection is temporarily hidden.
          {canAssignDriver && (
            <div className="space-y-2">
              <Label htmlFor="postal-driver">{t('postal.driver')}</Label>
              <PartnerAutocompleteInput
                id="postal-driver"
                workspaceId={scope.workspaceId}
                value={driverText}
                disabled={action.busy}
                onChange={(value) => {
                  setDriverText(value)
                  setDriver(null)
                }}
                onSelectPartner={(value) => {
                  setDriver(value)
                  setDriverText(value.partnerName)
                }}
                includeAgentRoles
                searchProvider={(search) => searchPostalDrivers(scope, search)}
              />
              {driver && (
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-primary/10 px-2 py-1 text-xs">
                    {t('postal.linked')}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() => {
                      setDriver(null)
                      setDriverText('')
                    }}
                  >
                    {t('postal.unlink')}
                  </Button>
                </div>
              )}
            </div>
          )}
          */}
          <Label htmlFor="postal-operation-notes">
            {t(
              operation === 'cancel'
                ? 'postal.correctionReason'
                : 'postal.notes',
            )}
            {operation === 'cancel' && ' *'}
          </Label>
          <Textarea
            id="postal-operation-notes"
            maxLength={2000}
            value={notes}
            disabled={action.busy}
            onChange={(e) => setNotes(e.target.value)}
          />
        </AppDialogBody>
        <AppDialogFooter>
          <Button variant="outline" disabled={action.busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={action.busy || !valid}
            onClick={() =>
              void action.run(
                operation + JSON.stringify(payload),
                async (id) => {
                  await postalCommand(scope, operation, payload, id)
                  onClose()
                },
              )
            }
          >
            {action.busy ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="me-2 h-4 w-4" />
            )}
            {t('postal.confirm')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
