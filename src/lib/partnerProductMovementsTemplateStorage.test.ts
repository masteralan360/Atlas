import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ from: vi.fn(), local: vi.fn(), list: vi.fn(), save: vi.fn(), delete: vi.fn(), cache: vi.fn(), online: vi.fn(), cached: vi.fn(), prune: vi.fn() }))
vi.mock('@/auth', () => ({ supabase: { from: mocks.from } }))
vi.mock('@/local-db', () => ({ db: { transaction: (_mode: string, _table: unknown, action: () => unknown) => action(), app_settings: { bulkPut: mocks.cache, bulkDelete: mocks.prune, filter: () => ({ toArray: mocks.cached }) } }, listLocalCustomTemplates: mocks.list, saveLocalCustomTemplate: mocks.save, deleteLocalCustomTemplate: mocks.delete }))
vi.mock('@/lib/network', () => ({ isOnline: mocks.online }))
vi.mock('@/workspace/workspaceMode', () => ({ isLocalWorkspaceMode: mocks.local }))
vi.mock('@/lib/supabaseRequest', () => ({ runSupabaseAction: (_: string, action: () => unknown) => action(), normalizeSupabaseActionError: () => new Error('Could not save the template. Please retry.') }))
import { loadPartnerProductMovementsTemplates, savePartnerProductMovementsTemplate, setDefaultPartnerProductMovementsTemplate, deletePartnerProductMovementsTemplate } from './partnerProductMovementsTemplateStorage'
import { createPartnerProductMovementsTemplateConfiguration } from './partnerProductMovementsTemplates'
import { readWorkspaceDataHydration } from '@/workspace/workspaceDataFreshness'

const config = createPartnerProductMovementsTemplateConfiguration({ accumulateProducts: true })
const context = { workspaceId: 'workspace', userId: 'admin', isLocalMode: false }
const templates = [{ id: 'default', label: 'Default', active: true, primary: true, version: 1, configuration: config }, { id: 'custom', label: 'Custom', active: true, primary: false, version: 1, configuration: config }]
function client(results: { data: unknown; error: unknown }[]) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const method of ['select', 'eq', 'like', 'order', 'range', 'abortSignal', 'insert', 'update', 'delete']) chain[method] = vi.fn(() => chain)
  chain.single = vi.fn(() => Promise.resolve(results.shift()))
  chain.then = vi.fn((resolve: (value: unknown) => void) => resolve(results.shift()))
  mocks.from.mockReturnValue(chain)
  return chain
}
beforeEach(() => { vi.clearAllMocks(); mocks.local.mockReturnValue(false); mocks.online.mockReturnValue(true); mocks.cached.mockResolvedValue([]) })
describe('product movement template storage', () => {
  it('paginates active templates with a workspace and module filter and caches successful rows', async () => {
    const rows = Array.from({ length: 100 }, (_, id) => ({ id: String(id), workspace_id: 'workspace', module_type_key: 'businessPartners.ProductMovements', active: true }))
    const chain = client([{ data: rows, error: null }, { data: [], error: null }])
    const result = await loadPartnerProductMovementsTemplates('workspace')
    expect(result).toHaveLength(100)
    expect(mocks.from).toHaveBeenCalledWith('custom_templates')
    expect(chain.eq).toHaveBeenCalledWith('workspace_id', 'workspace')
    expect(chain.like).toHaveBeenCalledWith('module_type_key', 'businessPartners.ProductMovements%')
    expect(chain.range.mock.calls).toEqual([[0, 99], [100, 199]])
    expect(mocks.cache).toHaveBeenCalledOnce()
    expect(readWorkspaceDataHydration('workspace', 'supabase', ['partner_product_movements_templates'])?.lastResult?.state).toBe('complete')
  })
  it('reports a friendly loading failure and never caches an incomplete result', async () => {
    client([{ data: null, error: { message: 'technical database error' } }])
    await expect(loadPartnerProductMovementsTemplates('failure')).rejects.toThrow('Unable to load statement templates. Please retry.')
    expect(mocks.cache).not.toHaveBeenCalled()
    expect(readWorkspaceDataHydration('failure', 'supabase', ['partner_product_movements_templates'])?.lastResult?.state).toBe('error')
  })
  it('prunes remotely deleted templates so they do not reappear offline', async () => {
    mocks.cached.mockResolvedValue([{ value: JSON.stringify({ id: 'deleted', workspace_id: 'workspace', module_type_key: 'businessPartners.ProductMovementsActivity', active: true }) }])
    client([{ data: [], error: null }])
    await loadPartnerProductMovementsTemplates('workspace')
    expect(mocks.prune).toHaveBeenCalledWith(['custom_template_cache:workspace:deleted'])
  })
  it('uses the SQLite-owned template service in Local mode without any Supabase reads or writes', async () => {
    mocks.local.mockReturnValue(true); mocks.list.mockResolvedValue([]); mocks.save.mockResolvedValue({ id: 'local' })
    expect(await loadPartnerProductMovementsTemplates('local')).toEqual([])
    expect(await savePartnerProductMovementsTemplate({ ...context, isLocalMode: true }, [], { label: 'Products', configuration: config })).toBe('local')
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ moduleTypeKey: 'businessPartners.ProductMovementsActivity', primary: true, layoutJson: { kind: 'partner-product-movements-template', configuration: config } }))
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it('reads cached workspace templates offline without claiming remote freshness', async () => {
    mocks.online.mockReturnValue(false)
    mocks.cached.mockResolvedValue([{ value: JSON.stringify({ id: 'cached', workspace_id: 'offline', module_type_key: 'businessPartners.ProductMovementsActivity', active: true }) },
      { value: JSON.stringify({ id: 'foreign', workspace_id: 'other', module_type_key: 'businessPartners.ProductMovementsActivity', active: true }) }])
    expect(await loadPartnerProductMovementsTemplates('offline')).toMatchObject([{ id: 'cached' }])
    expect(mocks.from).not.toHaveBeenCalled()
    expect(readWorkspaceDataHydration('offline', 'supabase', ['partner_product_movements_templates'])?.lastResult).toBeNull()
  })
  it('creates and updates only this workspace and template kind, preserving accumulation', async () => {
    const chain = client([{ data: { id: 'created' }, error: null }, { data: { id: 'custom' }, error: null }])
    expect(await savePartnerProductMovementsTemplate(context, [], { label: 'Products', configuration: config })).toBe('created')
    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: 'workspace', module_type_key: 'businessPartners.ProductMovementsActivity', primary: true, created_by: 'admin' }))
    expect(await savePartnerProductMovementsTemplate(context, templates, { id: 'custom', label: 'Updated', configuration: config })).toBe('custom')
    expect(chain.eq).toHaveBeenCalledWith('workspace_id', 'workspace')
    expect(chain.eq).toHaveBeenCalledWith('module_type_key', 'businessPartners.ProductMovementsActivity')
  })
  it('handles permission failures and missing returned rows as failed saves', async () => {
    client([{ data: null, error: { code: '42501' } }, { data: {}, error: null }])
    await expect(savePartnerProductMovementsTemplate(context, [], { label: 'Products', configuration: config })).rejects.toThrow('Could not save the template. Please retry.')
    await expect(savePartnerProductMovementsTemplate(context, [], { label: 'Products', configuration: config })).rejects.toThrow('Could not save the template. Please retry.')
  })
  it('requires a name and an existing update target before sending requests', async () => {
    await expect(savePartnerProductMovementsTemplate(context, [], { label: ' ', configuration: config })).rejects.toThrow('required')
    await expect(savePartnerProductMovementsTemplate(context, [], { id: 'missing', label: 'Products', configuration: config })).rejects.toThrow('not found')
    expect(mocks.from).not.toHaveBeenCalled()
  })
  it('sets defaults through the existing database default-enforcement workflow and verifies deletion', async () => {
    const chain = client([{ data: { id: 'custom' }, error: null }, { data: [{ id: 'custom' }], error: null }])
    await setDefaultPartnerProductMovementsTemplate(context, templates[1])
    expect(chain.update).toHaveBeenCalledWith({ primary: true, updated_by: 'admin' })
    await deletePartnerProductMovementsTemplate(context, templates, 'custom')
    expect(chain.delete).toHaveBeenCalledOnce()
    expect(chain.eq).toHaveBeenCalledWith('workspace_id', 'workspace')
    await expect(deletePartnerProductMovementsTemplate(context, templates, 'default')).rejects.toThrow('another default')
  })
})
