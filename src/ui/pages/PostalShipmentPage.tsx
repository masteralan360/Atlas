import { usePostalScope, usePostalAction } from '@/postal/usePostalAccess'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  CircleX,
  Clock3,
  Copy,
  Loader2,
  MapPin,
  PackageCheck,
  Pencil,
  Phone,
  Printer,
  QrCode,
  Receipt,
  ShieldCheck,
  Trash2,
  Truck,
  Wallet,
  Warehouse,
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
  usePostalDeliveryFeeHistory,
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

function PostalAmountMetric({
  label,
  value,
  language,
  currency,
  highlighted = false,
}: {
  label: string
  value: number
  language: string
  currency: string
  highlighted?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${highlighted ? 'border-primary/30 bg-primary/5' : 'bg-muted/20'}`}
    >
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-lg font-semibold tabular-nums">
          {value.toLocaleString(language)}
        </span>
        <span className="text-xs font-medium text-muted-foreground">
          {currency}
        </span>
      </dd>
    </div>
  )
}

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
  const deliveryFeeHistory = usePostalDeliveryFeeHistory(scope, shipmentUuid)
  const [edit, setEdit] = useState(false)
  const [copy, setCopy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [print, setPrint] = useState(false)
  const [qr, setQr] = useState(false)
  const [contact, setContact] = useState(false)
  const [operation, setOperation] = useState('')
  const [payment, setPayment] = useState<
    'collection' | 'settlement' | 'delivery_fee' | null
  >(null)
  const action = usePostalAction()
  if (detail.isPending) return <PostalLoading />
  if (detail.error || !detail.data)
    return <PostalError retry={() => void detail.refetch()} />
  const { shipment, transfer, summary } = detail.data
  const cod = codHistory.data?.pages.flat() ?? []
  const deliveryFeeRecords = deliveryFeeHistory.data?.pages.flat() ?? []
  const operations = availableOperations(shipment, transfer, scope.role)
  const operationIcons: Record<string, typeof PackageCheck> = {
    receive: PackageCheck,
    dispatch: Truck,
    out_for_delivery: Truck,
    arrive: Warehouse,
    deliver: CheckCircle2,
    authorize_transfer: ShieldCheck,
    cancel_transfer: CircleX,
    cancel: Ban,
  }
  const canEdit =
    shipment.state !== 'cancelled' &&
    (scope.role === 'admin' ||
      (scope.role === 'merchant' && shipment.state === 'draft'))
  const collected = summary.collected
  const settled = summary.settled
  const deliveryFeeCollected = summary.deliveryFeeCollected
  const deliveryFeeRemaining = Math.max(
    0,
    Number(shipment.delivery_fee ?? 0) - deliveryFeeCollected,
  )
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
                'postal_delivery_fee_records',
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
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <div className="space-y-4">
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
                ...(shipment.shipment_size
                  ? [[
                      'shipmentSize',
                      t(`postal.shipmentSizes.${shipment.shipment_size}`),
                    ]]
                  : []),
                ...(shipment.tariff_zone
                  ? [[
                      'tariffZone',
                      t(`postal.tariffZones.${shipment.tariff_zone}`),
                    ]]
                  : []),
                [
                  'codAmount',
                  `${shipment.cod_amount.toLocaleString(i18n.language)} ${t('postal.iqd')}`,
                ],
                ...(shipment.delivery_fee !== null &&
                shipment.delivery_fee !== undefined
                  ? [
                      [
                        'deliveryFee',
                        `${shipment.delivery_fee.toLocaleString(i18n.language)} ${t('postal.iqd')}`,
                      ],
                      [
                        'totalAtDelivery',
                        `${(shipment.cod_amount + shipment.delivery_fee).toLocaleString(i18n.language)} ${t('postal.iqd')}`,
                      ],
                    ]
                  : []),
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
          <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Wallet className="h-5 w-5" />
              </span>
              <h2 className="font-semibold">{t('postal.cod')}</h2>
            </div>
            <div className="space-y-4 p-4">
              <dl className="grid gap-3 sm:grid-cols-3">
                <PostalAmountMetric
                  label={t('postal.collected')}
                  value={collected}
                  language={i18n.language}
                  currency={t('postal.iqd')}
                />
                <PostalAmountMetric
                  label={t('postal.settled')}
                  value={settled}
                  language={i18n.language}
                  currency={t('postal.iqd')}
                />
                <PostalAmountMetric
                  label={t('postal.remaining')}
                  value={shipment.cod_amount - settled}
                  language={i18n.language}
                  currency={t('postal.iqd')}
                  highlighted
                />
              </dl>
              {shipment.state === 'delivered' && scope.role !== 'merchant' && (
                <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                  <Button
                    className="w-full gap-2 shadow-sm sm:w-auto"
                    disabled={collected === shipment.cod_amount}
                    onClick={() => setPayment('collection')}
                  >
                    <ArrowDownLeft className="h-4 w-4" />
                    {t('postal.collection')}
                  </Button>
                  {scope.role === 'admin' && (
                    <Button
                      variant="outline"
                      className="w-full gap-2 sm:w-auto"
                      disabled={collected === settled}
                      onClick={() => setPayment('settlement')}
                    >
                      <ArrowUpRight className="h-4 w-4" />
                      {t('postal.settlement')}
                    </Button>
                  )}
                </div>
              )}
              {cod.length > 0 && (
                <div className="divide-y rounded-lg border">
                  {cod.map((record) => {
                    const Icon =
                      record.kind === 'collection' ? ArrowDownLeft : ArrowUpRight
                    return (
                      <div
                        key={record.id}
                        className="flex flex-wrap items-center justify-between gap-3 p-3"
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                            <Icon className="h-4 w-4" />
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {t(`postal.${record.kind}`)}
                            </p>
                            <time
                              className="text-xs text-muted-foreground"
                              dateTime={record.created_at}
                            >
                              {new Date(record.created_at).toLocaleString(
                                i18n.language,
                              )}
                            </time>
                          </div>
                        </div>
                        <strong className="text-sm tabular-nums">
                          {Number(record.signed_amount).toLocaleString(
                            i18n.language,
                          )}{' '}
                          <span className="font-medium text-muted-foreground">
                            {t('postal.iqd')}
                          </span>
                        </strong>
                      </div>
                    )
                  })}
                </div>
              )}
              {codHistory.isLoading && <PostalLoading />}
              {codHistory.error && (
                <PostalError retry={() => void codHistory.refetch()} />
              )}
              {codHistory.hasNextPage && (
                <Button
                  variant="outline"
                  className="gap-2"
                  disabled={codHistory.isFetchingNextPage}
                  onClick={() => void codHistory.fetchNextPage()}
                >
                  {codHistory.isFetchingNextPage ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                  {t('postal.loadMore')}
                </Button>
              )}
            </div>
          </section>
        </div>
        <aside className="space-y-4">
          {!!operations.length && (
            <section
              aria-labelledby="shipment-operations-heading"
              className="overflow-hidden rounded-xl border bg-card shadow-sm"
            >
              <div className="flex items-center gap-3 border-b bg-muted/30 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <MapPin className="h-5 w-5" />
                </span>
                <h2
                  id="shipment-operations-heading"
                  className="font-semibold"
                >
                  {t('postal.operationsTitle')}
                </h2>
              </div>
              <div className="grid gap-2 p-3">
                {operations.map((op, index) => {
                  const Icon = operationIcons[op] ?? ShieldCheck
                  const destructive = ['cancel', 'cancel_transfer'].includes(op)
                  return (
                    <Button
                      key={op}
                      variant={
                        destructive
                          ? 'destructive'
                          : index === 0
                            ? 'default'
                            : 'outline'
                      }
                      className="group h-auto min-h-12 w-full justify-start gap-3 whitespace-normal px-3 py-2.5 text-start"
                      onClick={() => setOperation(op)}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        {t(`postal.operations.${op}`)}
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 opacity-60 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
                    </Button>
                  )
                })}
              </div>
            </section>
          )}
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 p-4">
              <ShipmentQr qrId={shipment.qr_id} />
              <p className="text-center text-xs text-muted-foreground">
                {t('postal.qrHint')}
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
      {shipment.delivery_fee !== null && shipment.delivery_fee !== undefined && (
        <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Receipt className="h-5 w-5" />
            </span>
            <h2 className="font-semibold">{t('postal.deliveryFeeTitle')}</h2>
          </div>
          <div className="space-y-4 p-4">
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <PostalAmountMetric
                label={t('postal.deliveryFee')}
                value={shipment.delivery_fee}
                language={i18n.language}
                currency={t('postal.iqd')}
              />
              <PostalAmountMetric
                label={t('postal.deliveryFeeCollected')}
                value={deliveryFeeCollected}
                language={i18n.language}
                currency={t('postal.iqd')}
              />
              <PostalAmountMetric
                label={t('postal.deliveryFeeRemaining')}
                value={deliveryFeeRemaining}
                language={i18n.language}
                currency={t('postal.iqd')}
                highlighted
              />
              <PostalAmountMetric
                label={t('postal.totalAtDelivery')}
                value={shipment.cod_amount + shipment.delivery_fee}
                language={i18n.language}
                currency={t('postal.iqd')}
              />
            </dl>
            {shipment.state !== 'delivered' && (
              <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{t('postal.deliveryFeeCollectedOnDelivery')}</p>
              </div>
            )}
            {shipment.state === 'delivered' &&
              scope.role !== 'merchant' &&
              deliveryFeeRemaining > 0 && (
                <div className="flex justify-end border-t pt-4">
                  <Button
                    className="w-full gap-2 shadow-sm sm:w-auto"
                    onClick={() => setPayment('delivery_fee')}
                  >
                    <CircleDollarSign className="h-4 w-4" />
                    {t('postal.recordDeliveryFee')}
                  </Button>
                </div>
              )}
            {deliveryFeeRecords.length > 0 && (
              <div className="divide-y rounded-lg border">
                {deliveryFeeRecords.map((record) => (
                  <div
                    key={record.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <ArrowDownLeft className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {t('postal.deliveryFeeCollection')}
                        </p>
                        <time
                          className="text-xs text-muted-foreground"
                          dateTime={record.created_at}
                        >
                          {new Date(record.created_at).toLocaleString(
                            i18n.language,
                          )}
                        </time>
                      </div>
                    </div>
                    <strong className="text-sm tabular-nums">
                      {record.signed_amount.toLocaleString(i18n.language)}{' '}
                      <span className="font-medium text-muted-foreground">
                        {t('postal.iqd')}
                      </span>
                    </strong>
                  </div>
                ))}
              </div>
            )}
            {deliveryFeeHistory.isLoading && <PostalLoading />}
            {deliveryFeeHistory.error && (
              <PostalError retry={() => void deliveryFeeHistory.refetch()} />
            )}
            {deliveryFeeHistory.hasNextPage && (
              <Button
                variant="outline"
                className="gap-2"
                disabled={deliveryFeeHistory.isFetchingNextPage}
                onClick={() => void deliveryFeeHistory.fetchNextPage()}
              >
                {deliveryFeeHistory.isFetchingNextPage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
                {t('postal.loadMore')}
              </Button>
            )}
          </div>
        </section>
      )}
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
