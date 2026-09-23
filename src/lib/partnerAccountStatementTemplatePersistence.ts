import { supabase } from '@/auth'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import {
  PARTNER_ACCOUNT_STATEMENT_ACTIVITY_TEMPLATE_KEY,
  serializePartnerAccountStatementTemplate,
  type PartnerAccountStatementTemplateConfiguration
} from '@/lib/partnerAccountStatementTemplates'

export function getPartnerAccountStatementTemplateSaveFailure(
  t: (key: string) => string
) {
  return {
    title: t('businessPartners.accountStatement.templateSaveFailedTitle'),
    description: t('businessPartners.accountStatement.templateSaveFailedDescription'),
    variant: 'destructive' as const
  }
}

export async function saveRemotePartnerAccountStatementTemplate(input: {
  workspaceId: string
  userId: string
  existingTemplateId?: string
  label: string
  configuration: PartnerAccountStatementTemplateConfiguration
  isFirstTemplate: boolean
}): Promise<string> {
  const payload = {
    workspace_id: input.workspaceId,
    module_type_key: PARTNER_ACCOUNT_STATEMENT_ACTIVITY_TEMPLATE_KEY,
    label: input.label,
    layout_json: serializePartnerAccountStatementTemplate(input.configuration),
    updated_by: input.userId
  }
  const existingTemplateId = input.existingTemplateId
  const { data, error } = existingTemplateId
    ? await runSupabaseAction('partnerAccountStatementTemplates.update', () =>
      supabase
        .from('custom_templates')
        .update(payload)
        .eq('id', existingTemplateId)
        .eq('workspace_id', input.workspaceId)
        .select('id')
        .single()
    )
    : await runSupabaseAction('partnerAccountStatementTemplates.create', () =>
      supabase
        .from('custom_templates')
        .insert({
          ...payload,
          created_by: input.userId,
          active: true,
          primary: input.isFirstTemplate
        })
        .select('id')
        .single()
    )
  if (error) throw normalizeSupabaseActionError(error)
  if (!data?.id) throw new Error('Template was saved without an identifier.')
  return data.id
}
