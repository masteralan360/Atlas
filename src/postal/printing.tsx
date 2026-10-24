import type { TFunction } from 'i18next'
import { setPrintPreviewEditorSource } from '@/lib/printPreviewEditorStore'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { ShipmentLabel } from './ShipmentLabel'
import { formatPostalShipmentId, type PostalShipment } from './domain'

export function preparePostalLabel(
  shipment: PostalShipment,
  workspaceId: string,
  t: TFunction,
) {
  setPrintPreviewEditorSource({
    title: t('postal.shipmentLabel'),
    workspaceId,
    printFormat: 'label',
    effectiveId: formatPostalShipmentId(shipment),
    templatePreview: {
      page: { widthMm: 100, heightMm: 150 },
      fields: [
        { key: 'note', label: t('postal.notes'), value: '', type: 'text' },
      ],
      createElement: (fields) => (
        <ShipmentLabel shipment={shipment} note={fields.note} />
      ),
      buildPdf: (element) =>
        generateTemplatePdf({
          element,
          format: 'label',
          pageSizeMm: { widthMm: 100, heightMm: 150 },
        }),
    },
    onPrint: (blob) => printPdfBlob(blob, { title: t('postal.shipmentLabel') }),
  })
}
