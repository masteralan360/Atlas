import { beforeEach, describe, expect, it, vi } from 'vitest'
const sources = vi.hoisted(() => ({ fetch: vi.fn(), sales: vi.fn() }))
vi.mock('@/local-db', () => ({ db: new Proxy({}, { get: (_, name) => ({ name }) }), fetchTableFromSupabase: sources.fetch, syncSalesFromSupabase: sources.sales }))
import { PARTNER_PRODUCT_MOVEMENTS_LIVE_TABLE_NAMES, refreshPartnerProductMovementsLiveData } from './partnerProductMovementsLiveData'
import { readWorkspaceDataHydration } from '@/workspace/workspaceDataFreshness'

beforeEach(() => { vi.clearAllMocks(); sources.fetch.mockResolvedValue(true); sources.sales.mockResolvedValue(undefined) })
describe('product movement remote sources', () => {
  it('scopes every shared paginated reader to the workspace and completes only all sources', async () => {
    const progress = vi.fn()
    await refreshPartnerProductMovementsLiveData('success', { onProgress: progress })
    for (const name of PARTNER_PRODUCT_MOVEMENTS_LIVE_TABLE_NAMES) expect(sources.fetch).toHaveBeenCalledWith(name, { name }, 'success')
    expect(sources.sales).toHaveBeenCalledWith('success')
    expect(progress).toHaveBeenLastCalledWith({ completedSources: 12, totalSources: 12 })
    expect(readWorkspaceDataHydration('success', 'supabase', ['partner_product_movements_statement'])?.lastResult?.state).toBe('complete')
    expect(PARTNER_PRODUCT_MOVEMENTS_LIVE_TABLE_NAMES).not.toContain('payment_transactions')
  })
  it('treats a shared reader returning false as a failure, even if other sources succeed', async () => {
    sources.fetch.mockImplementation((table: string) => Promise.resolve(table !== 'purchase_orders'))
    await expect(refreshPartnerProductMovementsLiveData('failure')).rejects.toThrow('Movement sources unavailable')
    expect(readWorkspaceDataHydration('failure', 'supabase', ['partner_product_movements_statement'])).toMatchObject({ isLoading: false, lastResult: { state: 'error' } })
  })
  it('cancels abandoned module hydration without marking it complete', async () => {
    const controller = new AbortController()
    sources.fetch.mockImplementation(async () => { controller.abort(); return true })
    await expect(refreshPartnerProductMovementsLiveData('cancelled', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(readWorkspaceDataHydration('cancelled', 'supabase', ['partner_product_movements_statement'])).toMatchObject({ isLoading: false, lastResult: null })
  })
})
