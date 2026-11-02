import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'
import {
  POSTAL_SHIPMENT_LABEL_TEMPLATE_KEY,
  POSTAL_SMALL_SHIPMENT_LABEL_TEMPLATE_KEY,
  POSTAL_SMALL_SHIPMENT_QR_LABEL_TEMPLATE_KEY,
  type StoredCustomTemplateRow,
} from '@/lib/customTemplates'

export type PostalShipmentLabelTemplateLoadResult = {
  templates: StoredCustomTemplateRow[]
  failed: boolean
  error?: unknown
}

export async function loadPostalShipmentLabelTemplates(
  workspaceId: string,
): Promise<PostalShipmentLabelTemplateLoadResult> {
  try {
    const [standard, small] = await Promise.all([
      fetchCachedCustomTemplates(workspaceId, {
        moduleTypeKey: POSTAL_SHIPMENT_LABEL_TEMPLATE_KEY,
        activeOnly: true,
      }),
      fetchCachedCustomTemplates(workspaceId, {
        moduleTypeKey: POSTAL_SMALL_SHIPMENT_LABEL_TEMPLATE_KEY,
        activeOnly: true,
      }),
    ])

    return {
      templates: [...standard, ...small] as StoredCustomTemplateRow[],
      failed: false,
    }
  } catch (error) {
    return { templates: [], failed: true, error }
  }
}

/** Templates available for generated QR batches: standard shipment labels and QR-only compact labels. */
export async function loadPostalQrBatchLabelTemplates(
  workspaceId: string,
): Promise<PostalShipmentLabelTemplateLoadResult> {
  try {
    const [standard, qrOnly] = await Promise.all([
      fetchCachedCustomTemplates(workspaceId, {
        moduleTypeKey: POSTAL_SHIPMENT_LABEL_TEMPLATE_KEY,
        activeOnly: true,
      }),
      fetchCachedCustomTemplates(workspaceId, {
        moduleTypeKey: POSTAL_SMALL_SHIPMENT_QR_LABEL_TEMPLATE_KEY,
        activeOnly: true,
      }),
    ])

    return {
      templates: [...standard, ...qrOnly] as StoredCustomTemplateRow[],
      failed: false,
    }
  } catch (error) {
    return { templates: [], failed: true, error }
  }
}
