import { supabase } from '@/auth'
import { db, deleteLocalCustomTemplate, listLocalCustomTemplates, saveLocalCustomTemplate } from '@/local-db'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import type { StoredCustomTemplateRow } from '@/lib/customTemplates'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { isOnline } from '@/lib/network'
import {
  cancelWorkspaceDataHydration, completeWorkspaceDataHydration, failWorkspaceDataHydration,
  recordWorkspaceDataFetch, startWorkspaceDataHydration, updateWorkspaceDataHydrationProgress
} from '@/workspace/workspaceDataFreshness'
import { PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY, serializePartnerProductMovementsTemplate, type PartnerProductMovementsTemplate, type PartnerProductMovementsTemplateConfiguration } from './partnerProductMovementsTemplates'

export const PRODUCT_MOVEMENTS_TEMPLATE_FRESHNESS_TABLE = 'partner_product_movements_templates'
const PREFIX = 'businessPartners.ProductMovements'
const SELECT = 'id, workspace_id, module_type_key, label, layout_json, active, primary, version, created_by, updated_by, created_at, updated_at'

async function readCachedTemplates(workspaceId: string) {
  const settings = await db.app_settings.filter(row => row.key.startsWith(`custom_template_cache:${workspaceId}:`)).toArray()
  return settings.flatMap(setting => {
    try {
      const row = JSON.parse(setting.value) as StoredCustomTemplateRow & { workspace_id: string }
      return row.workspace_id === workspaceId && row.module_type_key?.startsWith(PREFIX) && row.active ? [row] : []
    } catch { return [] }
  })
}

export async function loadPartnerProductMovementsTemplates(workspaceId: string, signal?: AbortSignal): Promise<StoredCustomTemplateRow[]> {
  if (isLocalWorkspaceMode(workspaceId)) return listLocalCustomTemplates(workspaceId, { moduleTypePrefix: PREFIX, activeOnly: true })
  if (!isOnline(workspaceId)) return readCachedTemplates(workspaceId)
  const operationId = crypto.randomUUID()
  const table = PRODUCT_MOVEMENTS_TEMPLATE_FRESHNESS_TABLE
  const checkCancelled = () => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError') }
  checkCancelled()
  startWorkspaceDataHydration(workspaceId, 'supabase', table, operationId)
  const cancel = () => cancelWorkspaceDataHydration(workspaceId, 'supabase', table, operationId)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const rows: StoredCustomTemplateRow[] = []
    for (let from = 0; ; from += 100) {
      checkCancelled()
      const { data, error } = await runSupabaseAction('partnerProductMovementsTemplates.list', () => {
        let query = supabase.from('custom_templates').select(SELECT).eq('workspace_id', workspaceId)
          .like('module_type_key', `${PREFIX}%`).eq('active', true).order('id').range(from, from + 99)
        if (signal) query = query.abortSignal(signal)
        return query
      })
      checkCancelled()
      if (error || !data) throw new Error('Unable to load statement templates. Please retry.')
      rows.push(...data)
      updateWorkspaceDataHydrationProgress(workspaceId, 'supabase', table, rows.length, operationId)
      if (data.length < 100) break
    }
    const cached = await readCachedTemplates(workspaceId)
    const remoteIds = new Set(rows.map(row => row.id))
    const staleKeys = cached.filter(row => !remoteIds.has(row.id)).map(row => `custom_template_cache:${workspaceId}:${row.id}`)
    await db.transaction('rw', db.app_settings, async () => {
      if (staleKeys.length) await db.app_settings.bulkDelete(staleKeys)
      await db.app_settings.bulkPut(rows.map(row => ({ key: `custom_template_cache:${workspaceId}:${row.id}`, value: JSON.stringify(row) })))
    })
    checkCancelled()
    recordWorkspaceDataFetch(workspaceId, 'supabase', undefined, table)
    completeWorkspaceDataHydration(workspaceId, 'supabase', table, undefined, operationId)
    return rows
  } catch (error) {
    if (signal?.aborted) cancel()
    else failWorkspaceDataHydration(workspaceId, 'supabase', table, undefined, operationId)
    throw error
  } finally { signal?.removeEventListener('abort', cancel) }
}

type Context = { workspaceId: string; userId: string; isLocalMode: boolean }
export async function savePartnerProductMovementsTemplate(context: Context, templates: PartnerProductMovementsTemplate[], input: { id?: string; label: string; configuration: PartnerProductMovementsTemplateConfiguration }) {
  if (!input.label.trim()) throw new Error('A template name is required.')
  const existing = input.id ? templates.find(template => template.id === input.id) : undefined
  if (input.id && !existing) throw new Error('Statement template not found.')
  const layoutJson = serializePartnerProductMovementsTemplate(input.configuration)
  if (context.isLocalMode) return (await saveLocalCustomTemplate({ id: existing?.id, workspaceId: context.workspaceId,
    moduleTypeKey: PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY, label: input.label.trim(), layoutJson,
    active: true, primary: existing?.primary ?? templates.length === 0, userId: context.userId })).id
  const payload = { workspace_id: context.workspaceId, module_type_key: PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY,
    label: input.label.trim(), layout_json: layoutJson, updated_by: context.userId }
  const { data, error } = existing
    ? await runSupabaseAction('partnerProductMovementsTemplates.update', () => supabase.from('custom_templates').update(payload)
      .eq('id', existing.id).eq('workspace_id', context.workspaceId).eq('module_type_key', PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY).select('id').single())
    : await runSupabaseAction('partnerProductMovementsTemplates.create', () => supabase.from('custom_templates')
      .insert({ ...payload, created_by: context.userId, active: true, primary: templates.length === 0 }).select('id').single())
  if (error) throw normalizeSupabaseActionError(error)
  if (!data?.id) throw new Error('Could not save the template. Please retry.')
  return data.id
}

export async function setDefaultPartnerProductMovementsTemplate(context: Context, template: PartnerProductMovementsTemplate) {
  if (context.isLocalMode) await saveLocalCustomTemplate({ id: template.id, workspaceId: context.workspaceId,
    moduleTypeKey: PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY, label: template.label,
    layoutJson: serializePartnerProductMovementsTemplate(template.configuration), active: true, primary: true, userId: context.userId })
  else {
    const { data, error } = await runSupabaseAction('partnerProductMovementsTemplates.setDefault', () => supabase.from('custom_templates')
      .update({ primary: true, updated_by: context.userId }).eq('id', template.id).eq('workspace_id', context.workspaceId)
      .eq('module_type_key', PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY).select('id').single())
    if (error) throw normalizeSupabaseActionError(error)
    if (!data?.id) throw new Error('Could not set the default template. Please retry.')
  }
}

export async function deletePartnerProductMovementsTemplate(context: Context, templates: PartnerProductMovementsTemplate[], templateId: string) {
  const template = templates.find(row => row.id === templateId)
  if (!template || template.primary || templates.length <= 1) throw new Error('Choose another default template before deleting this template.')
  if (context.isLocalMode) await deleteLocalCustomTemplate(context.workspaceId, template.id, context.userId)
  else {
    const { data, error } = await runSupabaseAction('partnerProductMovementsTemplates.delete', () => supabase.from('custom_templates')
      .delete().eq('id', template.id).eq('workspace_id', context.workspaceId).eq('module_type_key', PARTNER_PRODUCT_MOVEMENTS_ACTIVITY_TEMPLATE_KEY).select('id'))
    if (error) throw normalizeSupabaseActionError(error)
    if (!data?.some(row => row.id === template.id)) throw new Error('Could not delete the template. Please retry.')
  }
}
