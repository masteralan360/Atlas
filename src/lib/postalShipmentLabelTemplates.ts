import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'
import {
  POSTAL_SHIPMENT_LABEL_TEMPLATE_KEY,
  POSTAL_SMALL_SHIPMENT_LABEL_TEMPLATE_KEY,
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
