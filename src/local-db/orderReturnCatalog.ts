import i18n from '@/i18n/config'
import { isService } from '@/lib/catalogItem'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { toCamelCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { db } from './database'
import type { Product } from './models'

export async function readOrderCatalogProducts(workspaceId: string, productIds: readonly string[]) {
  const ids = [...new Set(productIds)]
  const products = new Map<string, Product>()
  if (!ids.length) return products
  if (isLocalWorkspaceMode(workspaceId)) {
    const cached = await db.products.bulkGet(ids)
    for (const product of cached) if (product?.workspaceId === workspaceId) products.set(product.id, product)
  } else {
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
        if (product && product.id === row.id && product.workspace_id === workspaceId && typeof product.is_service === 'boolean') {
          const normalized = toCamelCase(product) as unknown as Product
          products.set(normalized.id, normalized)
        }
      }
    }
  }
  if (ids.some(id => !products.has(id))) throw new Error(i18n.t('orders.form.errors.productNotFound'))
  return products
}

/** Classify only the selected return lines. */
export async function readOrderReturnStockProductIds(workspaceId: string, productIds: readonly string[]) {
  const products = await readOrderCatalogProducts(workspaceId, productIds)
  return new Set([...products].filter(([, product]) => !isService(product)).map(([id]) => id))
}
