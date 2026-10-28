import { usePostalAction } from './usePostalAccess'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Package, ShieldCheck } from 'lucide-react'
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
import { postalTariffOptions } from './domain'
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
  const tariffs =
    operation === 'receive'
      ? postalTariffOptions(shipment.governorate, shipment.area)
      : []
  const [selectedTariff, setSelectedTariff] = useState<string | null>(null)
  const tariff = tariffs.find(
    (option) => `${option.size}:${option.fee}` === selectedTariff,
  )
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
    (operation !== 'receive' || !!tariff) &&
    (operation !== 'cancel' || notes.trim().length > 0)
  const payload = {
    id: shipment.id,
    revision: shipment.revision,
    branch_id: branch?.id,
    tariff_size: tariff?.size,
    delivery_fee: tariff?.fee,
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
          {operation === 'receive' && (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('postal.shipmentSize')} *
              </label>
              <p className="text-sm text-muted-foreground">
                {t('postal.tariffAssignmentHint')}
              </p>
              <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={t('postal.shipmentSize')}>
                {tariffs.map((option) => {
                  const value = `${option.size}:${option.fee}`
                  const selected = selectedTariff === value
                  return (
                    <Button
                      key={value}
                      type="button"
                      variant={selected ? 'default' : 'outline'}
                      className="h-auto min-h-20 justify-between gap-3 p-4 text-start"
                      disabled={action.busy}
                      aria-pressed={selected}
                      onClick={() => setSelectedTariff(value)}
                    >
                      <span className="flex items-start gap-3">
                        <Package className="mt-0.5 h-5 w-5 shrink-0" />
                        <span className="space-y-1">
                          <span className="block font-semibold">
                            {t(`postal.shipmentSizes.${option.size}`)}
                          </span>
                          {option.zone && (
                            <span className="block text-xs opacity-80">
                              {t(`postal.tariffZones.${option.zone}`)}
                            </span>
                          )}
                          <span className="block text-sm">
                            {option.fee.toLocaleString()} {t('postal.iqd')}
                          </span>
                        </span>
                      </span>
                      {selected && <Check className="h-5 w-5 shrink-0" />}
                    </Button>
                  )
                })}
              </div>
            </div>
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
