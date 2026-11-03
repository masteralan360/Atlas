import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ShipmentQr } from './ShipmentLabel'
import { useFitPostalLabel } from './useFitPostalLabel'

function EmptyLabelRow({
  label,
  children,
  prominent = false,
  compact = false,
  large = false,
}: {
  label: string
  children: ReactNode
  prominent?: boolean
  compact?: boolean
  large?: boolean
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: large ? '46% minmax(0, 1fr)' : '32% minmax(0, 1fr)',
        borderBottom: '1px solid #000',
        minHeight: large ? (compact ? '8mm' : '10mm') : compact ? '4mm' : '5mm',
        breakInside: 'avoid',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: large ? '0.7mm 1.5mm' : compact ? '0.15mm 1mm' : '0.35mm 1.5mm',
          borderInlineEnd: '1px solid #000',
          fontSize: large ? (compact ? 9 : 10.5) : compact ? (prominent ? 8 : 7) : (prominent ? 10.5 : 9.5),
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
          padding: large ? '0.7mm 1.5mm' : compact ? '0.15mm 1mm' : '0.35mm 1.5mm',
          textAlign: 'center',
          fontSize: large ? (compact ? 12 : 18) : compact ? (prominent ? 8 : 7) : (prominent ? 13.5 : 10.5),
          fontWeight: 700,
          lineHeight: 1.3,
          overflowWrap: 'anywhere',
        }}
      >
        {children}
      </div>
    </div>
  )
}

function EmptyLabelSectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3
      style={{
        margin: '0.2mm 0 0.2mm',
        textAlign: 'center',
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {children}
    </h3>
  )
}

/** Blank-data labels used by QR batches, with a unique QR for each page. */
export function EmptyShipmentLabel({
  qrId,
  workspaceName,
  small = false,
}: {
  qrId: string
  workspaceName: string
  small?: boolean
}) {
  const { t, i18n } = useTranslation()
  const { labelRef, fitTransform } = useFitPostalLabel(small ? 58 : 100)
  const empty = ''

  if (small) {
    const row = (label: string, prominent = false, large = false) => (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '45% minmax(0, 1fr)',
          minHeight: large ? '6.4mm' : '3.2mm',
          borderBottom: '0.5px solid #000',
          fontSize: large ? 8 : prominent ? 6.3 : 5.7,
          fontWeight: 700,
          lineHeight: 1.05,
          textAlign: 'start',
        }}
      >
        <span style={{ padding: '0.1mm 0.5mm', borderInlineEnd: '0.5px solid #000', overflow: 'hidden', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ minWidth: 0, padding: '0.1mm 0.5mm' }}>{empty}</span>
      </div>
    )

    return (
      <div
        ref={labelRef}
        data-testid="postal-qr-batch-small-label"
        dir={i18n.dir()}
        style={{
          width: '40mm',
          height: '58mm',
          boxSizing: 'border-box',
          padding: '1mm',
          transform: fitTransform,
          transformOrigin: 'top left',
          border: '0.5px solid #000',
          borderRadius: '1.5mm',
          background: '#fff',
          color: '#000',
          fontFamily: 'Arial, sans-serif',
          overflow: 'hidden',
          fontWeight: 700,
        }}
      >
        <div style={{ height: '3mm', overflow: 'hidden', textAlign: 'center', fontSize: 7, fontWeight: 700, lineHeight: '3mm', whiteSpace: 'nowrap' }}>
          {workspaceName}
        </div>
        <div style={{ display: 'grid', placeItems: 'center', width: '20mm', height: '20mm', margin: '0 auto', background: '#fff' }}>
          <ShipmentQr qrId={qrId} size={240} />
        </div>
        <div style={{ border: '0.5px solid #000' }}>
          {row(t('postal.shipmentId'))}
          {row(t('postal.merchant'))}
          {row(t('postal.recipient_name'), true)}
          {row(t('postal.primary_phone'))}
          {row(t('postal.destination'))}
          {row(t('postal.shipmentDetails'))}
          {row(t('postal.codAmount'), true)}
          {row(t('postal.deliveryFee'))}
          {row(t('postal.recipientTotalAmount'), true, true)}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={labelRef}
      data-testid="postal-qr-batch-label"
      dir={i18n.dir()}
      style={{
        width: '100mm',
        minHeight: '100mm',
        boxSizing: 'border-box',
        padding: '0.5mm 2mm 2mm',
        transform: fitTransform,
        transformOrigin: 'top left',
        border: '1px solid #000',
        borderRadius: '2mm',
        background: '#fff',
        color: '#000',
        fontFamily: 'Arial, sans-serif',
        overflowWrap: 'anywhere',
        fontWeight: 700,
      }}
    >
      <header style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 28mm', alignItems: 'center', gap: '2mm', minHeight: '28mm' }}>
        <div style={{ minWidth: 0, textAlign: 'center' }}>
          <div style={{ display: 'inline-block', maxWidth: '100%', paddingBottom: '0.5mm', borderBottom: '1px solid #000', fontSize: 17, fontWeight: 800, lineHeight: 1.2 }}>
            {workspaceName}
          </div>
        </div>
        <div style={{ display: 'grid', placeItems: 'center', width: '28mm', height: '28mm', background: '#fff' }}>
          <ShipmentQr qrId={qrId} size={210} />
        </div>
      </header>
      <div style={{ margin: '0.2mm 0 0.1mm', textAlign: 'center', fontSize: 13, fontWeight: 800 }}>
        {t('postal.shipmentId')}: <bdi dir="ltr" style={{ whiteSpace: 'nowrap' }}>{empty}</bdi>
      </div>
      <section aria-label={t('postal.recipient_name')} style={{ border: '1px solid #000' }}>
        <EmptyLabelRow label={t('postal.merchant')} compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.recipient_name')} prominent compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.primary_phone')} compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.destination')} compact>{empty}</EmptyLabelRow>
      </section>
      <EmptyLabelSectionTitle>{t('postal.shipmentDetails')}</EmptyLabelSectionTitle>
      <section aria-label={t('postal.shipmentDetails')} style={{ border: '1px solid #000' }}>
        <EmptyLabelRow label={t('postal.shipmentLabelSize')} compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.pieces')} compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.fragility')} compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.codAmount')} prominent compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.deliveryFee')} compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.recipientTotalAmount')} prominent compact large>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.createdAt')} compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.deliveryNotes')} compact>{empty}</EmptyLabelRow>
        <EmptyLabelRow label={t('postal.notes')} compact>{empty}</EmptyLabelRow>
      </section>
    </div>
  )
}

/** Compact QR-only label used for generated QR batches. */
export function EmptyShipmentQrLabel({ qrId }: { qrId: string }) {
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
