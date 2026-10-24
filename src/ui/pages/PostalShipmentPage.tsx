import { usePostalScope, usePostalAction } from '@/postal/usePostalAccess'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  Printer,
  Phone,
  Pencil,
  Trash2,
  QrCode,
  PackageCheck,
  Wallet,
  MapPin,
  Copy,
  ShieldCheck,
} from 'lucide-react'
import { Button, Card, CardContent } from '@/ui/components'
import {
  SmallDialog,
  SmallDialogContent,
  SmallDialogBody,
  SmallDialogHeader,
  SmallDialogTitle,
} from '@/ui/components/small-dialog'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { PrintSelectionModal } from '@/ui/components/PrintSelectionModal'
import { useWorkspacePermissions } from '@/permissions'
import {
  usePostalDetail,
  usePostalEvents,
  usePostalCodHistory,
  postalCommand,
} from '@/local-db/postal'
import {
  availableOperations,
  formatPostalShipmentId,
  locationLabel,
} from '@/postal/domain'
import { PostalError, PostalLoading } from '@/postal/shared'
import { preparePostalLabel } from '@/postal/printing'
import { RecipientContactFlow } from '@/postal/RecipientContactFlow'
import { ShipmentForm } from '@/postal/ShipmentForm'
import { CreateShipmentFlow } from '@/postal/CreateShipmentFlow'
import { ShipmentTimeline } from '@/postal/ShipmentTimeline'
import { OperationDialog } from '@/postal/OperationDialog'
import { CodPaymentDialog } from '@/postal/CodPaymentDialog'
import { ShipmentQr } from '@/postal/ShipmentLabel'

export default function PostalShipmentPage({
  shipmentId,
}: {
  shipmentId: string
}) {
  const { t, i18n } = useTranslation()
  const scope = usePostalScope()
  const { permissionKeys } = useWorkspacePermissions()
  const canPrint = !permissionKeys.includes('global.NOprint')
  const [, navigate] = useLocation()
  const detail = usePostalDetail(scope, shipmentId)
  const shipmentUuid = detail.data?.shipment.id ?? ''
  const history = usePostalEvents(scope, shipmentUuid)
  const codHistory = usePostalCodHistory(scope, shipmentUuid)
  const [edit, setEdit] = useState(false)
  const [copy, setCopy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [print, setPrint] = useState(false)
  const [qr, setQr] = useState(false)
  const [contact, setContact] = useState(false)
  const [operation, setOperation] = useState('')
  const [payment, setPayment] = useState<'collection' | 'settlement' | null>(
    null,
  )
  const action = usePostalAction()
  if (detail.isPending) return <PostalLoading />
  if (detail.error || !detail.data)
    return <PostalError retry={() => void detail.refetch()} />
  const { shipment, transfer, summary } = detail.data
  const cod = codHistory.data?.pages.flat() ?? []
  const operations = availableOperations(shipment, transfer, scope.role)
  const canEdit =
    shipment.state !== 'cancelled' &&
    (scope.role === 'admin' ||
      (scope.role === 'merchant' && shipment.state === 'draft'))
  const collected = summary.collected
  const settled = summary.settled
  const events = history.data?.pages.flat() ?? []
  const openPrint = () => {
    setPrint(false)
    preparePostalLabel(shipment, scope.workspaceId, t)
    navigate('/print-preview-editor')
  }
  return (
    <div className="w-full min-w-0 space-y-5 p-3 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            aria-label={t('postal.back')}
            onClick={() => navigate('/post-service')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
              <PackageCheck className="h-6 w-6 text-primary" />
              {t('postal.shipmentDetails')}
            </h1>
            <ModulePageFreshness
              tableNames={[
                'postal_shipments',
                'postal_events',
                'postal_cod_records',
                'postal_transfers',
              ]}
            />
          </div>
        </div>
        <Button
          size="lg"
          className="w-full gap-2 shadow-sm sm:w-auto"
          disabled={!canPrint}
          onClick={() => setPrint(true)}
        >
          <Printer className="h-5 w-5" />
          {t('postal.printQr')}
        </Button>
      </header>
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center rounded-full bg-primary/10 px-3 text-sm font-semibold">
          {t(`postal.states.${shipment.state}`)}
        </span>
        {canEdit && (
          <Button variant="outline" onClick={() => setEdit(true)}>
            <Pencil className="me-2 h-4 w-4" />
            {t('postal.editShipment')}
          </Button>
        )}
        {shipment.state === 'draft' && scope.role !== 'office' && (
          <Button
            variant="outline"
            disabled={action.busy}
            onClick={() => setDeleting(true)}
          >
            <Trash2 className="me-2 h-4 w-4" />
            {t('common.delete')}
          </Button>
        )}
        <Button variant="outline" onClick={() => setQr(true)}>
          <QrCode className="me-2 h-4 w-4" />
          {t('postal.shipmentQr')}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('postal.contactRecipient')}
          title={t('postal.contactRecipient')}
          onClick={() => setContact(true)}
        >
          <Phone className="h-4 w-4" />
        </Button>
        {scope.role === 'merchant' && (
          <Button variant="outline" onClick={() => setCopy(true)}>
            <Copy className="me-2 h-4 w-4" />
            {t('postal.createShipment')}
          </Button>
        )}
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[1fr_300px]">
        <Card>
          <CardContent className="grid gap-5 p-5 sm:grid-cols-2">
            {[
              ['shipmentId', formatPostalShipmentId(shipment)],
              ['recipient_name', shipment.recipient_name],
              ['primary_phone', shipment.primary_phone],
              ['backup_phone', shipment.backup_phone],
              [
                'governorate',
                locationLabel(shipment.governorate, i18n.language),
              ],
              [
                'area',
                locationLabel(
                  shipment.area,
                  i18n.language,
                  shipment.governorate,
                ),
              ],
              ['address', shipment.address],
              [
                'codAmount',
                `${shipment.cod_amount.toLocaleString(i18n.language)} ${t('postal.iqd')}`,
              ],
              ['pieces', shipment.pieces?.toLocaleString(i18n.language)],
              [
                'fragility',
                t(shipment.fragile ? 'postal.fragile' : 'postal.nonFragile'),
              ],
              ['driver', shipment.driver_name],
              ['deliveryNotes', shipment.delivery_notes],
              [
                'createdAt',
                new Date(shipment.created_at).toLocaleString(i18n.language),
              ],
            ]
              .filter(
                ([, value]) =>
                  value !== null && value !== undefined && value !== '',
              )
              .map(([key, value]) => (
                <div className="min-w-0" key={key}>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t(`postal.${key}`)}
                  </p>
                  <p
                    className="mt-1 break-words text-sm font-semibold"
                    dir={
                      key?.includes('phone') || key === 'shipmentId'
                        ? 'ltr'
                        : undefined
                    }
                  >
                    {value}
                  </p>
                </div>
              ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 p-4">
            <ShipmentQr qrId={shipment.qr_id} />
            <p className="text-center text-xs text-muted-foreground">
              {t('postal.qrHint')}
            </p>
          </CardContent>
        </Card>
      </div>
      {!!operations.length && (
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <h2 className="flex items-center gap-2 font-semibold">
            <MapPin className="h-5 w-5" />
            {t('postal.operationsTitle')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {operations.map((op) => (
              <Button
                key={op}
                variant="outline"
                onClick={() => setOperation(op)}
              >
                <ShieldCheck className="me-2 h-4 w-4" />
                {t(`postal.operations.${op}`)}
              </Button>
            ))}
          </div>
        </section>
      )}
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <Wallet className="h-5 w-5" />
          {t('postal.cod')}
        </h2>
        <div className="flex flex-wrap gap-6 text-sm">
          <p>
            {t('postal.collected')}:{' '}
            <strong>
              {collected.toLocaleString(i18n.language)} {t('postal.iqd')}
            </strong>
          </p>
          <p>
            {t('postal.settled')}:{' '}
            <strong>
              {settled.toLocaleString(i18n.language)} {t('postal.iqd')}
            </strong>
          </p>
          <p>
            {t('postal.remaining')}:{' '}
            <strong>
              {(shipment.cod_amount - settled).toLocaleString(i18n.language)}{' '}
              {t('postal.iqd')}
            </strong>
          </p>
        </div>
        {shipment.state === 'delivered' && scope.role !== 'merchant' && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={collected === shipment.cod_amount}
              onClick={() => setPayment('collection')}
            >
              {t('postal.collection')}
            </Button>
            {scope.role === 'admin' && (
              <Button
                variant="outline"
                disabled={collected === settled}
                onClick={() => setPayment('settlement')}
              >
                {t('postal.settlement')}
              </Button>
            )}
          </div>
        )}
        <div className="grid gap-2">
          {cod.map((record) => (
            <div
              key={record.id}
              className="flex flex-wrap justify-between gap-2 border-t pt-2 text-sm"
            >
              <span>
                {t(`postal.${record.kind}`)} ·{' '}
                {new Date(record.created_at).toLocaleString(i18n.language)}
              </span>
              <strong>
                {Number(record.signed_amount).toLocaleString(i18n.language)}{' '}
                {t('postal.iqd')}
              </strong>
            </div>
          ))}
        </div>
        {codHistory.isLoading && <PostalLoading />}
        {codHistory.error && (
          <PostalError retry={() => void codHistory.refetch()} />
        )}
        {codHistory.hasNextPage && (
          <Button
            variant="outline"
            disabled={codHistory.isFetchingNextPage}
            onClick={() => void codHistory.fetchNextPage()}
          >
            {t('postal.loadMore')}
          </Button>
        )}
      </section>
      {history.isLoading ? (
        <PostalLoading />
      ) : history.error ? (
        <PostalError retry={() => void history.refetch()} />
      ) : (
        <>
          <ShipmentTimeline
            events={events}
            state={shipment.state}
            complete={!history.hasNextPage}
          />
          {history.hasNextPage && (
            <Button
              variant="outline"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {t('postal.loadMore')}
            </Button>
          )}
        </>
      )}
      {edit && (
        <ShipmentForm
          scope={scope}
          editing
          source={shipment}
          onClose={() => setEdit(false)}
          onSaved={() => setEdit(false)}
        />
      )}
      {copy && (
        <CreateShipmentFlow
          scope={scope}
          onClose={() => setCopy(false)}
          onSaved={(s) => {
            setCopy(false)
            navigate(`/post-service/shipments/${formatPostalShipmentId(s)}`)
          }}
        />
      )}
      {operation && (
        <OperationDialog
          scope={scope}
          shipment={shipment}
          transfer={transfer}
          operation={operation}
          onClose={() => setOperation('')}
        />
      )}
      {payment && (
        <CodPaymentDialog
          scope={scope}
          shipment={shipment}
          summary={summary}
          kind={payment}
          onClose={() => setPayment(null)}
        />
      )}
      <DeleteConfirmationModal
        isOpen={deleting}
        isLoading={action.busy}
        onClose={() => {
          if (!action.busy) setDeleting(false)
        }}
        itemName={shipment.recipient_name}
        onConfirm={() =>
          void action.run(
            `delete:${shipment.id}:${shipment.revision}`,
            async (request) => {
              await postalCommand(
                scope,
                'delete_draft',
                { id: shipment.id, revision: shipment.revision },
                request,
              )
              navigate('/post-service')
            },
          )
        }
      />
      <PrintSelectionModal
        isOpen={print}
        onClose={() => setPrint(false)}
        nativeOptions={[
          {
            format: 'label',
            label: t('postal.shipmentLabel'),
            description: t('postal.labelSize'),
          },
        ]}
        onSelect={openPrint}
      />
      <SmallDialog open={qr} onOpenChange={setQr}>
        <SmallDialogContent>
          <SmallDialogHeader>
            <SmallDialogTitle>{t('postal.shipmentQr')}</SmallDialogTitle>
          </SmallDialogHeader>
          <SmallDialogBody className="flex flex-col items-center gap-4">
            <ShipmentQr qrId={shipment.qr_id} />
            <Button
              className="w-full"
              disabled={!canPrint}
              onClick={() => {
                setQr(false)
                setPrint(true)
              }}
            >
              <Printer className="me-2 h-4 w-4" />
              {t('postal.printQr')}
            </Button>
          </SmallDialogBody>
        </SmallDialogContent>
      </SmallDialog>
      {contact && (
        <RecipientContactFlow
          primary={shipment.primary_phone}
          backup={shipment.backup_phone}
          onClose={() => setContact(false)}
        />
      )}
    </div>
  )
}
