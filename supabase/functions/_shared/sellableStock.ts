import type { createAdminClient } from './supabase.ts'

/** Keep public catalogs and order allocation on the same unreserved quantities. */
export async function withSellableStock<T extends { product_id: string; storage_id: string; quantity: number | string | null }>(
  client: ReturnType<typeof createAdminClient>, workspaceId: string, inventory: T[],
): Promise<T[]> {
  const productIds = [...new Set(inventory.map(row => row.product_id))]
  const storageIds = [...new Set(inventory.map(row => row.storage_id))]
  const quantities = new Map<string, number>()
  for (let offset = 0; offset < productIds.length; offset += 200) {
    const { data, error } = await client.rpc('get_storefront_sellable_quantities', {
      p_workspace_id: workspaceId, p_product_ids: productIds.slice(offset, offset + 200), p_storage_ids: storageIds,
    })
    if (error) throw error
    for (const row of data ?? []) quantities.set(`${row.product_id}:${row.storage_id}`, Number(row.quantity))
  }
  return inventory.map(row => ({ ...row, quantity: quantities.get(`${row.product_id}:${row.storage_id}`) ?? 0 }))
}
