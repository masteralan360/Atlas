import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import {
  buildCustomTemplateLayoutPdf,
  createCustomTemplatePreview,
  getStoredCustomTemplateLabel,
  getCustomTemplateTarget,
  readCustomTemplateLayout,
  type StoredCustomTemplateRow,
} from '@/lib/customTemplates'
import { setPrintPreviewEditorSource } from '@/lib/printPreviewEditorStore'
import type { CustomTemplateLayout, TemplatePreview } from '@/lib/printPreviewEditorStore'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { PostalQrBatchQrLabel, PostalQrBatchShipmentLabel, ShipmentLabel, SmallShipmentLabel } from './ShipmentLabel'
import { formatPostalShipmentId, type PostalShipment } from './domain'

export type PostalShipmentLabelSize = 'standard' | 'small'
export type PostalQrBatchLabelSize = 'standard' | 'small-qr'

function replaceBatchQrId(node: ReactNode, qrId: string): ReactNode {
  if (!isValidElement<{ children?: ReactNode; qrId?: string }>(node)) return node
  if (node.type === PostalQrBatchShipmentLabel || node.type === PostalQrBatchQrLabel) {
    return cloneElement(node as ReactElement<{ qrId: string }>, { qrId })
  }
  if (node.props.children === undefined) return node
  return cloneElement(node, {}, Children.map(node.props.children, (child) => replaceBatchQrId(child, qrId)))
}

export function preparePostalQrBatchLabel(
  qrIds: string[],
  workspaceId: string,
  t: TFunction,
  workspaceName: string,
  labelSize: PostalQrBatchLabelSize = 'standard',
) {
  if (!qrIds.length) throw new Error('The QR batch has no printable labels.')

  const isQrOnlyLabel = labelSize === 'small-qr'
  const pageSizeMm = isQrOnlyLabel
    ? { widthMm: 40, heightMm: 58 }
    : { widthMm: 100, heightMm: 100 }
  const title = t(isQrOnlyLabel ? 'postal.smallShipmentQrLabel' : 'postal.shipmentLabel')
  const render = (qrId: string) => isQrOnlyLabel
    ? <PostalQrBatchQrLabel qrId={qrId} />
    : <PostalQrBatchShipmentLabel qrId={qrId} workspaceName={workspaceName} />
  const templatePreview: TemplatePreview = {
    page: pageSizeMm,
    bulkPageIds: qrIds,
    measurementRoundingToleranceMm: 0.5,
    fields: [],
    createElement: (_fields, effectiveId) => render(effectiveId || qrIds[0]),
    buildPdf: (element, printLangOverride) =>
      generateTemplatePdf({
        pages: qrIds.map((qrId) => replaceBatchQrId(element, qrId) as ReactElement),
        format: 'label',
        pageSizeMm,
        printLang: printLangOverride,
      }),
  }

  setPrintPreviewEditorSource({
    title,
    workspaceId,
    printFormat: 'label',
    effectiveId: qrIds[0],
    templatePreview,
    onPrint: (blob) => printPdfBlob(blob, { title }),
  })
}

export function preparePostalQrBatchCustomLabel(
  qrIds: string[],
  workspaceId: string,
  workspaceName: string,
  template: StoredCustomTemplateRow,
  printLang: string,
) {
  if (!qrIds.length) throw new Error('The QR batch has no printable labels.')
  const target = getCustomTemplateTarget(template.module_type_key)
  const layout = readCustomTemplateLayout(template)
  if (!target || target.printFormat !== 'label' || !target.page || !layout) {
    throw new Error('The saved shipment label template is unavailable.')
  }

  const title = getStoredCustomTemplateLabel(template)
  const options = {
    workspaceId,
    workspaceName,
    postalQrBatchLabel: true,
    postalQrId: qrIds[0],
    postalQrIds: qrIds,
    postalOrganizationName: '',
    printLang,
  }

  setPrintPreviewEditorSource({
    title,
    workspaceId,
    printFormat: 'label',
    effectiveId: qrIds[0],
    templatePreview: createCustomTemplatePreview(target, options),
    customTemplate: {
      moduleTypeKey: target.moduleTypeKey,
      nativeTemplateKey: target.nativeTemplateKey,
      templateId: template.id,
      label: title,
    },
    initialTemplateLayout: layout,
    allowTemplateFieldEditing: true,
    generateTemplateLayoutBlob: (
      nextLayout: CustomTemplateLayout,
      printLangOverride?: string,
      effectiveId?: string,
    ) => buildCustomTemplateLayoutPdf({
      target,
      layout: {
        ...nextLayout,
        page: target.page!,
      },
      values: nextLayout.fields || {},
      options: {
        ...options,
        printLang: printLangOverride || printLang,
        labelPageSizeMm: target.page,
      },
      effectiveId,
      postalQrIds: qrIds,
      fieldMode: 'layoutOverrides',
    }),
    onPrint: (blob) => printPdfBlob(blob, { title }),
  })
}

export function preparePostalLabel(
  shipment: PostalShipment,
  workspaceId: string,
  t: TFunction,
  sender: { organizationName: string; workspaceName: string },
  labelSize: PostalShipmentLabelSize = 'standard',
) {
  const isSmallLabel = labelSize === 'small'
  const pageSizeMm = isSmallLabel
    ? { widthMm: 40, heightMm: 58 }
    : { widthMm: 100, heightMm: 100 }
  const title = t(
    isSmallLabel ? 'postal.smallShipmentLabel' : 'postal.shipmentLabel',
  )

  setPrintPreviewEditorSource({
    title,
    workspaceId,
    printFormat: 'label',
    effectiveId: formatPostalShipmentId(shipment),
    templatePreview: {
      page: pageSizeMm,
      measurementRoundingToleranceMm: 0.5,
      fields: isSmallLabel
        ? []
        : [{ key: 'note', label: t('postal.notes'), value: '', type: 'text' }],
      createElement: (fields) =>
        isSmallLabel ? (
          <SmallShipmentLabel
            shipment={shipment}
            workspaceName={sender.workspaceName}
          />
        ) : (
          <ShipmentLabel
            shipment={shipment}
            organizationName={sender.organizationName}
            workspaceName={sender.workspaceName}
            note={fields.note}
          />
        ),
      buildPdf: (element) =>
        generateTemplatePdf({
          element,
          format: 'label',
          pageSizeMm,
        }),
    },
    onPrint: (blob) => printPdfBlob(blob, { title }),
  })
}

export function preparePostalCustomLabel(
  shipment: PostalShipment,
  workspaceId: string,
  sender: { organizationName: string; workspaceName: string },
  template: StoredCustomTemplateRow,
  printLang: string,
) {
  const target = getCustomTemplateTarget(template.module_type_key)
  const layout = readCustomTemplateLayout(template)
  if (!target || target.printFormat !== 'label' || !target.page || !layout) {
    throw new Error('The saved shipment label template is unavailable.')
  }

  const title = getStoredCustomTemplateLabel(template)
  const options = {
    workspaceId,
    workspaceName: sender.workspaceName,
    postalShipment: shipment,
    postalOrganizationName: sender.organizationName,
    printLang,
  }

  setPrintPreviewEditorSource({
    title,
    workspaceId,
    printFormat: 'label',
    effectiveId: formatPostalShipmentId(shipment),
    templatePreview: createCustomTemplatePreview(target, options),
    customTemplate: {
      moduleTypeKey: target.moduleTypeKey,
      nativeTemplateKey: target.nativeTemplateKey,
      templateId: template.id,
      label: title,
    },
    initialTemplateLayout: layout,
    allowTemplateFieldEditing: true,
    generateTemplateLayoutBlob: (
      nextLayout: CustomTemplateLayout,
      printLangOverride?: string,
      effectiveId?: string,
    ) => buildCustomTemplateLayoutPdf({
      target,
      layout: {
        ...nextLayout,
        page: target.page!,
      },
      values: nextLayout.fields || {},
      options: {
        ...options,
        printLang: printLangOverride || printLang,
        labelPageSizeMm: target.page,
      },
      effectiveId,
      fieldMode: 'layoutOverrides',
    }),
    onPrint: (blob) => printPdfBlob(blob, { title }),
  })
}
