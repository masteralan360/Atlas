import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import {
  formatPostalShipmentId,
  locationLabel,
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
export function ShipmentLabel({
  shipment,
  note = '',
}: {
  shipment: PostalShipment
  note?: string
}) {
  const { t, i18n } = useTranslation()
  return (
    <div
      data-testid="postal-label"
      dir={i18n.dir()}
      style={{
        width: '100mm',
        minHeight: '150mm',
        boxSizing: 'border-box',
        padding: '6mm',
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, sans-serif',
        overflowWrap: 'anywhere',
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
        {t('postal.shipmentLabel')}
      </h1>
      <div
        style={{ display: 'flex', justifyContent: 'center', margin: '3mm 0' }}
      >
        <ShipmentQr qrId={shipment.qr_id} size={220} />
      </div>
      <p
        style={{ margin: '1mm 0', fontFamily: 'monospace', fontSize: 9 }}
        dir="ltr"
      >
        {t('postal.shipmentId')}: {formatPostalShipmentId(shipment)}
      </p>
      <h2 style={{ fontSize: 18, margin: '2mm 0' }}>
        {shipment.recipient_name}
      </h2>
      <p style={{ margin: '1mm 0', fontSize: 15 }} dir="ltr">
        {shipment.primary_phone} / {shipment.backup_phone}
      </p>
      <p style={{ margin: '2mm 0', fontSize: 15 }}>
        {locationLabel(shipment.governorate, i18n.language)} —{' '}
        {locationLabel(shipment.area, i18n.language, shipment.governorate)}
      </p>
      {shipment.address && (
        <p style={{ margin: '1mm 0', fontSize: 13 }}>{shipment.address}</p>
      )}
      <p
        style={{
          borderTop: '1px solid #000',
          paddingTop: '2mm',
          margin: '2mm 0',
          fontSize: 18,
          fontWeight: 700,
        }}
      >
        {t('postal.codAmount')}:{' '}
        {shipment.cod_amount.toLocaleString(i18n.language)} {t('postal.iqd')}
      </p>
      <p style={{ margin: '1mm 0', fontSize: 13 }}>
        {t(shipment.fragile ? 'postal.fragile' : 'postal.nonFragile')}
        {shipment.pieces !== null &&
          ` · ${t('postal.pieces')}: ${shipment.pieces.toLocaleString(i18n.language)}`}
      </p>
      {shipment.delivery_notes && (
        <p style={{ margin: '1mm 0', fontSize: 12 }}>
          {shipment.delivery_notes}
        </p>
      )}
      {note && <p style={{ margin: '1mm 0', fontSize: 12 }}>{note}</p>}
    </div>
  )
}
