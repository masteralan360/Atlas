import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import {
  buildCustomTemplateLayoutPdf,
  createCustomTemplatePreview,
  getStoredCustomTemplateLabel,
  getCustomTemplateTarget,
  POSTAL_EMPTY_SHIPMENT_LABEL_TEMPLATE_KEY,
  POSTAL_SMALL_SHIPMENT_QR_LABEL_TEMPLATE_KEY,
  readCustomTemplateLayout,
  type StoredCustomTemplateRow,
} from '@/lib/customTemplates'
import { setPrintPreviewEditorSource } from '@/lib/printPreviewEditorStore'
import type { CustomTemplateLayout, TemplatePreview } from '@/lib/printPreviewEditorStore'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { EmptyShipmentLabel, EmptyShipmentQrLabel } from './EmptyShipmentLabel'
import { ShipmentLabel, SmallShipmentLabel } from './ShipmentLabel'
import {
  emptyPostalLocationCatalog,
  formatPostalShipmentId,
  type PostalLocationCatalog,
  type PostalShipment,
} from './domain'

export type PostalShipmentLabelSize = 'standard' | 'small'
export type PostalQrBatchLabelSize = 'standard' | 'small-qr'

function replaceBatchQrId(node: ReactNode, qrId: string): ReactNode {
  if (!isValidElement<{ children?: ReactNode; qrId?: string }>(node)) return node
  if (node.type === EmptyShipmentLabel || node.type === EmptyShipmentQrLabel) {
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
  const title = t(isQrOnlyLabel ? 'postal.smallShipmentQrLabel' : 'postal.emptyShipmentLabel')
  const render = (qrId: string) => isQrOnlyLabel
    ? <EmptyShipmentQrLabel qrId={qrId} />
    : <EmptyShipmentLabel qrId={qrId} workspaceName={workspaceName} />
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
  if (!target
    || (target.moduleTypeKey !== POSTAL_EMPTY_SHIPMENT_LABEL_TEMPLATE_KEY
      && target.moduleTypeKey !== POSTAL_SMALL_SHIPMENT_QR_LABEL_TEMPLATE_KEY)
    || target.printFormat !== 'label'
    || !target.page
    || !layout) {
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
  locationCatalog: PostalLocationCatalog = emptyPostalLocationCatalog,
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
            locationCatalog={locationCatalog}
          />
        ) : (
          <ShipmentLabel
            shipment={shipment}
            organizationName={sender.organizationName}
            workspaceName={sender.workspaceName}
            note={fields.note}
            locationCatalog={locationCatalog}
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

/** Builds the same saved primary custom label, or standard shipment label, used by the shipment print flow. */
export async function buildPostalLabelPdf(
  shipment: PostalShipment,
  workspaceId: string,
  sender: { organizationName: string; workspaceName: string },
  printLang: string,
  template?: StoredCustomTemplateRow,
  locationCatalog: PostalLocationCatalog = emptyPostalLocationCatalog,
): Promise<Blob> {
  if (template) {
    const target = getCustomTemplateTarget(template.module_type_key)
    const layout = readCustomTemplateLayout(template)
    if (!target || target.printFormat !== 'label' || !target.page || !layout) {
      throw new Error('The saved shipment label template is unavailable.')
    }

    return buildCustomTemplateLayoutPdf({
      target,
      layout: {
        ...layout,
        page: target.page,
      },
      values: layout.fields || {},
      options: {
        workspaceId,
        workspaceName: sender.workspaceName,
        postalShipment: shipment,
        postalOrganizationName: sender.organizationName,
        printLang,
        labelPageSizeMm: target.page,
        postalLocationCatalog: locationCatalog,
      },
      effectiveId: formatPostalShipmentId(shipment),
      fieldMode: 'layoutOverrides',
    })
  }

  return generateTemplatePdf({
    element: (
      <ShipmentLabel
        shipment={shipment}
        organizationName={sender.organizationName}
        workspaceName={sender.workspaceName}
        locationCatalog={locationCatalog}
      />
    ),
    format: 'label',
    printLang,
    pageSizeMm: { widthMm: 100, heightMm: 100 },
  })
}

export function preparePostalCustomLabel(
  shipment: PostalShipment,
  workspaceId: string,
  sender: { organizationName: string; workspaceName: string },
  template: StoredCustomTemplateRow,
  printLang: string,
  locationCatalog: PostalLocationCatalog = emptyPostalLocationCatalog,
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
    postalLocationCatalog: locationCatalog,
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
