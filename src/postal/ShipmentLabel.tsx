import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import {
  formatPostalShipmentId,
  locationLabel,
  postalShipmentSizeTranslationKey,
  shipmentQr,
  type PostalShipment,
} from './domain'

export function ShipmentQr({
  qrId,
  size = 240,
}: {
  qrId: string
  size?: number
}) {
  const { t } = useTranslation()
  return (
    <ReactQRCode
      value={shipmentQr(qrId)}
      size={size}
      level="M"
      marginSize={4}
      svgProps={{
        role: 'img',
        'aria-label': t('postal.shipmentQr'),
        style: { maxWidth: '100%', height: 'auto', background: 'white' },
      }}
    />
  )
}

function LabelRow({
  label,
  children,
  prominent = false,
  compact = false,
}: {
  label: string
  children: ReactNode
  prominent?: boolean
  compact?: boolean
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '32% minmax(0, 1fr)',
        borderBottom: '1px solid #777',
        minHeight: compact ? '4mm' : '5mm',
        breakInside: 'avoid',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: compact ? '0.15mm 1mm' : '0.35mm 1.5mm',
          borderInlineEnd: '1px solid #777',
          fontSize: compact ? (prominent ? 8 : 7) : (prominent ? 10.5 : 9.5),
          fontWeight: 700,
          lineHeight: 1.25,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0,
          padding: compact ? '0.15mm 1mm' : '0.35mm 1.5mm',
          textAlign: 'center',
          fontSize: compact ? (prominent ? 8 : 7) : (prominent ? 13.5 : 10.5),
          fontWeight: prominent ? 700 : 500,
          lineHeight: 1.3,
          overflowWrap: 'anywhere',
        }}
      >
        {children}
      </div>
    </div>
  )
}

function LabelSectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3
      style={{
        margin: '1.2mm 0 0.6mm',
        textAlign: 'center',
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {children}
    </h3>
  )
}

export function ShipmentLabel({
  shipment,
  organizationName,
  workspaceName,
  note = '',
}: {
  shipment: PostalShipment
  organizationName: string
  workspaceName: string
  note?: string
}) {
  const { t, i18n } = useTranslation()
  const formattedId = formatPostalShipmentId(shipment)
  const createdAt = new Date(shipment.created_at)
  const createdDate = Number.isNaN(createdAt.getTime())
    ? shipment.created_at
    : createdAt.toLocaleDateString(i18n.language)

  return (
    <div
      data-testid="postal-label"
      dir={i18n.dir()}
      style={{
        width: '100mm',
        minHeight: '100mm',
        boxSizing: 'border-box',
        padding: '2mm',
        border: '1px solid #b8b8b8',
        borderRadius: '2mm',
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, sans-serif',
        overflowWrap: 'anywhere',
      }}
    >
      <header
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 28mm',
          alignItems: 'center',
          gap: '2mm',
          minHeight: '28mm',
        }}
      >
        <div style={{ minWidth: 0, textAlign: 'center' }}>
          <div
            style={{
              display: 'inline-block',
              maxWidth: '100%',
              paddingBottom: '0.5mm',
              borderBottom: '1px solid #111',
              fontSize: 17,
              fontWeight: 800,
              lineHeight: 1.2,
            }}
          >
            {workspaceName}
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            placeItems: 'center',
            width: '28mm',
            height: '28mm',
            background: '#fff',
          }}
        >
          <ShipmentQr qrId={shipment.qr_id} size={210} />
        </div>
      </header>

      <div
        style={{
          margin: '0.2mm 0 0.8mm',
          textAlign: 'center',
          fontSize: 13,
          fontWeight: 800,
        }}
      >
        {t('postal.shipmentId')}:{' '}
        <bdi dir="ltr" style={{ whiteSpace: 'nowrap' }}>
          {formattedId}
        </bdi>
      </div>

      <section
        aria-label={t('postal.recipient_name')}
        style={{ border: '1px solid #777' }}
      >
        <LabelRow label={t('postal.merchant')}>
          {organizationName}
        </LabelRow>
        <LabelRow label={t('postal.recipient_name')} prominent>
          {shipment.recipient_name}
        </LabelRow>
        <LabelRow label={t('postal.primary_phone')}>
          <div>
            <bdi dir="ltr" style={{ whiteSpace: 'nowrap' }}>
              {shipment.primary_phone}
            </bdi>
            {shipment.backup_phone && (
              <div dir="ltr" style={{ fontSize: 7.5 }}>
                {shipment.backup_phone}
              </div>
            )}
          </div>
        </LabelRow>
        <LabelRow label={t('postal.destination')}>
          <div>
            <div>
              {locationLabel(shipment.governorate, i18n.language)} /{' '}
              {locationLabel(
                shipment.area,
                i18n.language,
                shipment.governorate,
              )}
            </div>
            {shipment.address && (
              <div style={{ marginTop: '0.4mm', fontSize: 9 }}>
                {shipment.address}
              </div>
            )}
          </div>
        </LabelRow>
      </section>

      <LabelSectionTitle>{t('postal.shipmentDetails')}</LabelSectionTitle>
      <section
        aria-label={t('postal.shipmentDetails')}
        style={{ border: '1px solid #777' }}
      >
        {shipment.shipment_size && (
          <LabelRow label={t('postal.shipmentSize')}>
            <span>
              {t(
                postalShipmentSizeTranslationKey(
                  shipment.governorate,
                  shipment.shipment_size,
                  shipment.delivery_fee,
                ),
              )}
              {shipment.pieces !== null && (
                <>
                  {' · '}
                  {shipment.pieces.toLocaleString(i18n.language)}{' '}
                  {t('postal.pieces')}
                </>
              )}
            </span>
          </LabelRow>
        )}
        {!shipment.shipment_size && shipment.pieces !== null && (
          <LabelRow label={t('postal.pieces')}>
            {shipment.pieces.toLocaleString(i18n.language)}
          </LabelRow>
        )}
        <LabelRow label={t('postal.fragility')}>
          {t(shipment.fragile ? 'postal.fragile' : 'postal.nonFragile')}
        </LabelRow>
        {shipment.delivery_fee !== null &&
          shipment.delivery_fee !== undefined && (
            <>
              <LabelRow label={t('postal.totalAtDelivery')} prominent>
                <bdi dir="ltr">
                  {(shipment.cod_amount + shipment.delivery_fee).toLocaleString(
                    i18n.language,
                  )}{' '}
                  {t('postal.iqd')}
                </bdi>
              </LabelRow>
              <LabelRow label={t('postal.deliveryFee')}>
                <bdi dir="ltr">
                  {shipment.delivery_fee.toLocaleString(i18n.language)}{' '}
                  {t('postal.iqd')}
                </bdi>
              </LabelRow>
            </>
          )}
        <LabelRow label={t('postal.createdAt')}>
          <bdi dir="ltr">{createdDate}</bdi>
        </LabelRow>
      </section>

      {(shipment.delivery_notes || note) && (
        <div
          style={{
            marginTop: '1mm',
            padding: '0.7mm 1mm',
            border: '1px solid #aaa',
            fontSize: 7.5,
            lineHeight: 1.15,
          }}
        >
          {shipment.delivery_notes && (
            <div>
              <strong>{t('postal.deliveryNotes')}: </strong>
              {shipment.delivery_notes}
            </div>
          )}
          {note && (
            <div style={{ marginTop: shipment.delivery_notes ? '0.4mm' : 0 }}>
              <strong>{t('postal.notes')}: </strong>
              {note}
            </div>
          )}
        </div>
      )}

    </div>
  )
}

export function SmallShipmentLabel({
  shipment,
  workspaceName,
}: {
  shipment: PostalShipment
  workspaceName: string
}) {
  const { t, i18n } = useTranslation()
  const formattedId = formatPostalShipmentId(shipment)
  const location = `${locationLabel(shipment.governorate, i18n.language)} / ${locationLabel(
    shipment.area,
    i18n.language,
    shipment.governorate,
  )}`
  const shipmentSize = shipment.shipment_size
    ? t(
        postalShipmentSizeTranslationKey(
          shipment.governorate,
          shipment.shipment_size,
          shipment.delivery_fee,
        ),
      )
    : null
  const shipmentDetails = [
    shipmentSize,
    shipment.pieces !== null
      ? `× ${shipment.pieces.toLocaleString(i18n.language)}`
      : null,
    shipment.fragile ? t('postal.fragile') : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const hasDeliveryFee =
    shipment.delivery_fee !== null && shipment.delivery_fee !== undefined

  return (
    <div
      data-testid="postal-small-label"
      dir={i18n.dir()}
      style={{
        width: '40mm',
        height: '58mm',
        boxSizing: 'border-box',
        padding: '1mm',
        border: '0.5px solid #aaa',
        borderRadius: '1.5mm',
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, sans-serif',
        overflow: 'hidden',
        textAlign: 'center',
      }}
    >
      <div
        title={workspaceName}
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 8,
          fontWeight: 700,
          lineHeight: 1.15,
        }}
      >
        {workspaceName}
      </div>
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          width: '28mm',
          height: '28mm',
          margin: '0.4mm auto 0',
          background: '#fff',
        }}
      >
        <ShipmentQr qrId={shipment.qr_id} size={280} />
      </div>
      <div
        dir="ltr"
        style={{
          marginTop: '0.3mm',
          fontFamily: 'monospace',
          fontSize: 7,
          lineHeight: 1.1,
        }}
      >
        {formattedId}
      </div>
      <div
        title={shipment.recipient_name}
        style={{
          marginTop: '0.5mm',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 9,
          fontWeight: 800,
          lineHeight: 1.15,
        }}
      >
        {shipment.recipient_name}
      </div>
      <div
        dir="ltr"
        style={{ marginTop: '0.2mm', fontSize: 7.5, lineHeight: 1.1 }}
      >
        {shipment.primary_phone}
      </div>
      <div
        style={{
          maxHeight: '5mm',
          marginTop: '0.3mm',
          overflow: 'hidden',
          fontSize: 7,
          lineHeight: 1.15,
        }}
      >
        <div>{location}</div>
        {shipment.address && <div>{shipment.address}</div>}
      </div>
      {shipmentDetails && (
        <div
          style={{
            marginTop: '0.4mm',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 6.8,
            lineHeight: 1.1,
          }}
        >
          {shipmentDetails}
        </div>
      )}
      {hasDeliveryFee && (
        <div
          style={{
            marginTop: '0.5mm',
            paddingTop: '0.4mm',
            borderTop: '1px solid #777',
            fontSize: 6.5,
            lineHeight: 1.1,
          }}
        >
          <div>{t('postal.totalAtDelivery')}:</div>
          <div dir="ltr" style={{ fontSize: 9, fontWeight: 800 }}>
            {(shipment.cod_amount + shipment.delivery_fee!).toLocaleString(
              i18n.language,
            )}{' '}
            {t('postal.iqd')}
          </div>
          <div style={{ marginTop: '0.2mm' }}>
            {t('postal.deliveryFee')}: {shipment.delivery_fee!.toLocaleString(i18n.language)}{' '}
            {t('postal.iqd')}
          </div>
        </div>
      )}
    </div>
  )
}

/** Blank-data batch labels keep every field title visible while carrying a unique QR. */
export function PostalQrBatchShipmentLabel({
  qrId,
  workspaceName,
  small = false,
}: {
  qrId: string
  workspaceName: string
  small?: boolean
}) {
  const { t, i18n } = useTranslation()
  const empty = ''

  if (small) {
    const row = (label: string, prominent = false) => (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '45% minmax(0, 1fr)',
          minHeight: '3.2mm',
          borderBottom: '0.5px solid #777',
          fontSize: prominent ? 6.3 : 5.7,
          fontWeight: prominent ? 700 : 500,
          lineHeight: 1.05,
          textAlign: 'start',
        }}
      >
        <span style={{ padding: '0.1mm 0.5mm', borderInlineEnd: '0.5px solid #777', overflow: 'hidden', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ minWidth: 0, padding: '0.1mm 0.5mm' }}>{empty}</span>
      </div>
    )

    return (
      <div
        data-testid="postal-qr-batch-small-label"
        dir={i18n.dir()}
        style={{
          width: '40mm',
          height: '58mm',
          boxSizing: 'border-box',
          padding: '1mm',
          border: '0.5px solid #aaa',
          borderRadius: '1.5mm',
          background: '#fff',
          color: '#000',
          fontFamily: 'Arial, sans-serif',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: '3mm', overflow: 'hidden', textAlign: 'center', fontSize: 7, fontWeight: 700, lineHeight: '3mm', whiteSpace: 'nowrap' }}>
          {workspaceName}
        </div>
        <div style={{ display: 'grid', placeItems: 'center', width: '20mm', height: '20mm', margin: '0 auto', background: '#fff' }}>
          <ShipmentQr qrId={qrId} size={240} />
        </div>
        <div style={{ border: '0.5px solid #777' }}>
          {row(t('postal.shipmentId'))}
          {row(t('postal.merchant'))}
          {row(t('postal.recipient_name'), true)}
          {row(t('postal.primary_phone'))}
          {row(t('postal.destination'))}
          {row(t('postal.shipmentDetails'))}
          {row(t('postal.totalAtDelivery'), true)}
          {row(t('postal.deliveryFee'))}
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="postal-qr-batch-label"
      dir={i18n.dir()}
      style={{
        width: '100mm',
        minHeight: '100mm',
        boxSizing: 'border-box',
        padding: '2mm',
        border: '1px solid #b8b8b8',
        borderRadius: '2mm',
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, sans-serif',
        overflowWrap: 'anywhere',
      }}
    >
      <header style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 28mm', alignItems: 'center', gap: '2mm', minHeight: '28mm' }}>
        <div style={{ minWidth: 0, textAlign: 'center' }}>
          <div style={{ display: 'inline-block', maxWidth: '100%', paddingBottom: '0.5mm', borderBottom: '1px solid #111', fontSize: 17, fontWeight: 800, lineHeight: 1.2 }}>
            {workspaceName}
          </div>
        </div>
        <div style={{ display: 'grid', placeItems: 'center', width: '28mm', height: '28mm', background: '#fff' }}>
          <ShipmentQr qrId={qrId} size={210} />
        </div>
      </header>
      <div style={{ margin: '0.2mm 0 0.8mm', textAlign: 'center', fontSize: 13, fontWeight: 800 }}>
        {t('postal.shipmentId')}: <bdi dir="ltr" style={{ whiteSpace: 'nowrap' }}>{empty}</bdi>
      </div>
      <section aria-label={t('postal.recipient_name')} style={{ border: '1px solid #777' }}>
        <LabelRow label={t('postal.merchant')} compact>{empty}</LabelRow>
        <LabelRow label={t('postal.recipient_name')} prominent compact>{empty}</LabelRow>
        <LabelRow label={t('postal.primary_phone')} compact>{empty}</LabelRow>
        <LabelRow label={t('postal.destination')} compact>{empty}</LabelRow>
      </section>
      <LabelSectionTitle>{t('postal.shipmentDetails')}</LabelSectionTitle>
      <section aria-label={t('postal.shipmentDetails')} style={{ border: '1px solid #777' }}>
        <LabelRow label={t('postal.shipmentSize')} compact>{empty}</LabelRow>
        <LabelRow label={t('postal.pieces')} compact>{empty}</LabelRow>
        <LabelRow label={t('postal.fragility')} compact>{empty}</LabelRow>
        <LabelRow label={t('postal.totalAtDelivery')} prominent compact>{empty}</LabelRow>
        <LabelRow label={t('postal.deliveryFee')} compact>{empty}</LabelRow>
        <LabelRow label={t('postal.createdAt')} compact>{empty}</LabelRow>
        <LabelRow label={t('postal.deliveryNotes')} compact>{empty}</LabelRow>
        <LabelRow label={t('postal.notes')} compact>{empty}</LabelRow>
      </section>
    </div>
  )
}

/** Compact QR-only label used for generated QR batches. */
export function PostalQrBatchQrLabel({ qrId }: { qrId: string }) {
  return (
    <div
      data-testid="postal-qr-batch-qr-only-label"
      style={{
        display: 'grid',
        placeItems: 'center',
        width: '40mm',
        height: '58mm',
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: '#fff',
      }}
    >
      <div style={{ display: 'grid', placeItems: 'center', width: '38mm', height: '38mm' }}>
        <ShipmentQr qrId={qrId} size={380} />
      </div>
    </div>
  )
}
