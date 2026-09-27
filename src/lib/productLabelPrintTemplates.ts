import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'
import type { StoredCustomTemplateRow } from '@/lib/customTemplates'
import { LABEL_PRINT_TEMPLATE_KEY } from '@/lib/labelPrint'

export type ProductLabelPrintTemplateLoadResult = {
    templates: StoredCustomTemplateRow[]
    failed: boolean
    error?: unknown
}

export async function loadProductLabelPrintTemplates(workspaceId: string): Promise<ProductLabelPrintTemplateLoadResult> {
    try {
        const rows = await fetchCachedCustomTemplates(workspaceId, {
            moduleTypeKey: LABEL_PRINT_TEMPLATE_KEY,
            activeOnly: true
        })
        return { templates: rows as StoredCustomTemplateRow[], failed: false }
    } catch (error) {
        return { templates: [], failed: true, error }
    }
}
