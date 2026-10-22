import i18n from '@/i18n/config'
import { isService } from '@/lib/catalogItem'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { db } from './database'

type ReturnCatalogItem = { id: string; workspaceId: string; isService: boolean }

/** Classify only the selected return lines; a missing cache row is not a stock item. */
export async function readOrderReturnStockProductIds(workspaceId: string, productIds: readonly string[]) {
  const ids = [...new Set(productIds)]
  if (!ids.length) return new Set<string>()
  const products = new Map<string, ReturnCatalogItem>()
  if (isLocalWorkspaceMode(workspaceId)) {
    const cached = await db.products.bulkGet(ids)
    for (const product of cached) {
      if (product?.workspaceId === workspaceId) products.set(product.id, {
        id: product.id, workspaceId, isService: isService(product),
      })
    }
  } else {
    // Cloud/Hybrid returns already require connectivity. Read the authoritative
    // type even when the local catalog is cold or contains an older service flag.
    for (let offset = 0; offset < ids.length; offset += 100) {
      const result = await runSupabaseAction('orders.returnCatalog', () => (getSupabaseClientForTable('products') as any)
        .rpc('get_visible_products_for_current_user', {
          p_workspace_id: workspaceId,
          p_product_ids: ids.slice(offset, offset + 100),
          p_offset: 0,
          p_limit: 100
        }))
      if (result.error) throw normalizeSupabaseActionError(result.error)
      for (const row of result.data ?? []) {
        const product = row.product as Record<string, unknown> | null
        if (product?.workspace_id === workspaceId && typeof product.is_service === 'boolean') {
          products.set(row.id, { id: row.id, workspaceId, isService: product.is_service })
        }
      }
    }
  }
  if (ids.some(id => !products.has(id))) throw new Error(i18n.t('orders.form.errors.productNotFound'))
  return new Set(ids.filter(id => !isService(products.get(id))))
}
