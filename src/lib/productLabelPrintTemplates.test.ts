import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchTemplates = vi.hoisted(() => vi.fn())

vi.mock('@/lib/cachedCustomTemplates', () => ({
    fetchCachedCustomTemplates: fetchTemplates
}))

import { LABEL_PRINT_TEMPLATE_KEY } from '@/lib/labelPrint'
import { loadProductLabelPrintTemplates } from './productLabelPrintTemplates'

describe('Products Label Print template loading', () => {
    beforeEach(() => vi.clearAllMocks())

    it('requests active Label Print templates for the current workspace and returns them', async () => {
        const rows = [{
            id: 'label-template-1',
            module_type_key: LABEL_PRINT_TEMPLATE_KEY,
            active: true,
            layout_json: { page: { widthMm: 70, heightMm: 40 } }
        }]
        fetchTemplates.mockResolvedValue(rows)

        const result = await loadProductLabelPrintTemplates('workspace-1')

        expect(fetchTemplates).toHaveBeenCalledWith('workspace-1', {
            moduleTypeKey: LABEL_PRINT_TEMPLATE_KEY,
            activeOnly: true
        })
        expect(result).toEqual({ templates: rows, failed: false })
    })

    it('returns an empty, non-technical failure result if loading fails', async () => {
        const remoteError = new Error('Supabase request details')
        fetchTemplates.mockRejectedValue(remoteError)

        const result = await loadProductLabelPrintTemplates('workspace-1')

        expect(result).toEqual({ templates: [], failed: true, error: remoteError })
    })
})
