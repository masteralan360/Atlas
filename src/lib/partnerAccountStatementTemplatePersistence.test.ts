import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  run: vi.fn(async (_name: string, action: () => PromiseLike<unknown>) => await action()),
  normalize: vi.fn((error: { message: string }) => new Error(error.message))
}))

vi.mock('@/auth', () => ({ supabase: { from: mocks.from } }))
vi.mock('@/lib/supabaseRequest', () => ({
  runSupabaseAction: mocks.run,
  normalizeSupabaseActionError: mocks.normalize
}))

import {
  getPartnerAccountStatementTemplateSaveFailure,
  saveRemotePartnerAccountStatementTemplate
} from './partnerAccountStatementTemplatePersistence'
import { createPartnerAccountStatementTemplateConfiguration } from './partnerAccountStatementTemplates'

function query(result: { data: { id: string } | null; error: { message: string } | null }) {
  const builder = {
    insert: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    select: vi.fn(),
    single: vi.fn().mockResolvedValue(result)
  }
  builder.insert.mockReturnValue(builder)
  builder.update.mockReturnValue(builder)
  builder.eq.mockReturnValue(builder)
  builder.select.mockReturnValue(builder)
  mocks.from.mockReturnValue(builder)
  return builder
}

const configuration = createPartnerAccountStatementTemplateConfiguration({
  dueFromBalanceColor: '#123456',
  dueToBalanceColor: '#abcdef'
})

describe('Partner Account Statement template Cloud / Hybrid save contract', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates the first workspace template with the two saved colors and returns its id', async () => {
    const builder = query({ data: { id: 'saved-1' }, error: null })

    await expect(saveRemotePartnerAccountStatementTemplate({
      workspaceId: 'workspace-1', userId: 'admin-1', label: 'Collections',
      configuration, isFirstTemplate: true
    })).resolves.toBe('saved-1')

    expect(mocks.run).toHaveBeenCalledWith('partnerAccountStatementTemplates.create', expect.any(Function))
    expect(mocks.from).toHaveBeenCalledWith('custom_templates')
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'workspace-1',
      module_type_key: 'businessPartners.AccountStatementActivity',
      label: 'Collections',
      created_by: 'admin-1',
      updated_by: 'admin-1',
      active: true,
      primary: true,
      layout_json: expect.objectContaining({
        kind: 'partner-account-statement-template',
        configuration: expect.objectContaining({
          dueFromBalanceColor: '#123456', dueToBalanceColor: '#abcdef'
        })
      })
    }))
    expect(builder.select).toHaveBeenCalledWith('id')
  })

  it('scopes an update to the workspace and existing template', async () => {
    const builder = query({ data: { id: 'saved-1' }, error: null })

    await expect(saveRemotePartnerAccountStatementTemplate({
      workspaceId: 'workspace-1', userId: 'admin-1', existingTemplateId: 'saved-1',
      label: 'Collections', configuration, isFirstTemplate: false
    })).resolves.toBe('saved-1')

    expect(mocks.run).toHaveBeenCalledWith('partnerAccountStatementTemplates.update', expect.any(Function))
    expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({
      layout_json: expect.objectContaining({ configuration: expect.objectContaining({
        dueFromBalanceColor: '#123456', dueToBalanceColor: '#abcdef'
      }) })
    }))
    expect(builder.eq).toHaveBeenCalledWith('id', 'saved-1')
    expect(builder.eq).toHaveBeenCalledWith('workspace_id', 'workspace-1')
  })

  it('rejects failed saves and exposes only localized friendly copy to the dialog', async () => {
    query({ data: null, error: { message: 'secret database constraint detail' } })

    await expect(saveRemotePartnerAccountStatementTemplate({
      workspaceId: 'workspace-1', userId: 'admin-1', label: 'Collections',
      configuration, isFirstTemplate: false
    })).rejects.toThrow('secret database constraint detail')
    expect(mocks.normalize).toHaveBeenCalledOnce()

    const messages: Record<string, string> = {
      'businessPartners.accountStatement.templateSaveFailedTitle': 'Could not save template',
      'businessPartners.accountStatement.templateSaveFailedDescription': 'Check your connection and try again.'
    }
    expect(getPartnerAccountStatementTemplateSaveFailure((key) => messages[key])).toEqual({
      title: 'Could not save template',
      description: 'Check your connection and try again.',
      variant: 'destructive'
    })
  })
})
