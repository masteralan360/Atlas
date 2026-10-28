import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/auth/supabase'
import { queryClient } from '@/query/queryClient'
import { queryKeys } from '@/query/queryKeys'
import { tracked, type PostalScope } from './postal'
import { canReadPostalStatement, normalizePostalOrganization, normalizePostalStatement, postalStatementTables, type PostalStatementInput } from './postalStatementData'
export * from './postalStatementData'
const invalid = () => new Error('postal_invalid_result')

export async function searchPostalStatementOrganizations(scope: PostalScope, search: string) {
  if (!canReadPostalStatement(scope)) throw new Error('postal_not_authorized')
  const normalized = search.trim()
  if (normalized.length < 3) return []
  return queryClient.fetchQuery({
    queryKey: queryKeys.postal.statementOrganizations(scope, normalized),
    queryFn: ({ signal }) => tracked(scope, 'postal_organizations', signal, async () => {
      const { data, error } = await supabase.rpc('postal_statement_organizations', {
        p_workspace_id: scope.workspaceId, p_search: normalized,
      }).abortSignal(signal)
      if (error) throw error
      if (!Array.isArray(data) || data.length > 8) throw invalid()
      return { data: data.map((row) => normalizePostalOrganization(row, scope.workspaceId)), error: null }
    }, (rows) => rows.length),
  })
}
export function usePostalStatement(input: PostalStatementInput) {
  return useQuery({
    queryKey: queryKeys.postal.statement(input),
    enabled: canReadPostalStatement(input) && !!input.organizationId,
    queryFn: ({ signal }) => tracked(input, postalStatementTables, signal, async () => {
      if (!canReadPostalStatement(input)) throw new Error('postal_not_authorized')
      const { data, error } = await supabase.rpc('postal_organization_statement', {
        p_workspace_id: input.workspaceId, p_organization_id: input.organizationId,
        p_page: input.page, p_page_size: input.pageSize, p_start: input.start ?? null,
        p_end: input.end ?? null, p_search: input.search, p_kind: input.kind,
      }).abortSignal(signal)
      if (error) throw error
      // Derived balances are Query state, never canonical Dexie business rows.
      return { data: normalizePostalStatement(data, input.workspaceId, input.organizationId), error: null }
    }, (data, table) => table === 'postal_organizations' ? 1 : data.entries.length),
  })
}
