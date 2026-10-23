import i18n from '@/i18n/config'
import { toCamelCase } from '@/lib/utils'
import { db } from './database'
import type { Agent, BusinessPartner, CustomAgentType } from './models'
import { filterBusinessPartnersByGroupPrivacy } from './businessPartnerAccess'
import { getDirectTransactionAccess } from './directTransactionAccess'
import { readDirectTransactionRpc, usesRemoteDirectTransactions } from './directTransactionReads'

export type DirectCounterpartyScope = 'all' | 'partners' | 'agents'
export interface DirectCounterparty {
  partner: BusinessPartner
  agent: Agent | null
  customType: CustomAgentType | null
}
export interface DirectCounterpartyQuery {
  scope: DirectCounterpartyScope
  search?: string
  page: number
  pageSize: number
  selectedPartnerId?: string
}
export interface DirectCounterpartyPage { items: DirectCounterparty[]; totalCount: number }

export function isEligibleDirectAgent(partner: BusinessPartner, agent: Agent | null | undefined, workspaceId: string) {
  return Boolean(partner.workspaceId === workspaceId && !partner.isDeleted && !partner.mergedIntoBusinessPartnerId
    && partner.role === 'agent' && agent && agent.workspaceId === workspaceId && !agent.isDeleted
    && agent.businessPartnerId === partner.id && agent.id === partner.agentFacetId && agent.status === 'active')
}

export async function cacheDirectCounterparties(items: DirectCounterparty[]) {
  await db.transaction('rw', db.business_partners, db.agents, db.agent_types, async () => {
    for (const item of items) {
      for (const [table, row] of [[db.business_partners, item.partner], [db.agents, item.agent], [db.agent_types, item.customType]] as const) {
        if (!row) continue
        const previous = await table.get(row.id)
        if (previous?.syncStatus === 'pending' || previous?.syncStatus === 'conflict'
          || (previous && previous.version > row.version)) continue
        await table.put(row as never)
      }
    }
  })
}

export async function readLocalDirectCounterparties(workspaceId: string, query: DirectCounterpartyQuery): Promise<DirectCounterpartyPage> {
  const access = getDirectTransactionAccess(workspaceId)
  if (!access.canPost) return { items: [], totalCount: 0 }
  const search = query.search?.trim().toLocaleLowerCase() ?? ''
  const size = Math.min(100, Math.max(1, query.pageSize))
  const start = (Math.max(1, query.page) - 1) * size
  const items: DirectCounterparty[] = []
  let totalCount = 0
  const source = () => query.selectedPartnerId
    ? db.business_partners.where('id').equals(query.selectedPartnerId)
    : db.business_partners.where('[workspaceId+partnerName+id]')
      .between([workspaceId, '', ''], [workspaceId, '\uffff', '\uffff'])
  // Count and page with bounded batches; retain only the requested page.
  for (let offset = 0; ; offset += 100) {
    const batch = await source().offset(offset).limit(100).toArray()
    const visible = await filterBusinessPartnersByGroupPrivacy(workspaceId, batch)
    for (const partner of visible) {
      if (partner.workspaceId !== workspaceId || partner.isDeleted || partner.mergedIntoBusinessPartnerId) continue
      const isAgent = partner.role === 'agent'
      if (isAgent ? !access.agents || query.scope === 'partners' : !access.partners || query.scope === 'agents'
        || !['customer', 'supplier', 'both', 'online_customer'].includes(partner.role)) continue
      const agent = isAgent && partner.agentFacetId ? await db.agents.get(partner.agentFacetId) : null
      if (isAgent && !isEligibleDirectAgent(partner, agent, workspaceId)) continue
      const customType = agent?.customAgentTypeId ? await db.agent_types.get(agent.customAgentTypeId) : null
      const validType = customType?.workspaceId === workspaceId && !customType.isDeleted ? customType : null
      if (search && ![partner.partnerName, partner.phone, partner.city, agent?.zone, agent?.agentType, validType?.name]
        .some(value => value?.toLocaleLowerCase().includes(search))) continue
      if (totalCount >= start && items.length < size) items.push({ partner, agent: agent ?? null, customType: validType })
      totalCount += 1
    }
    if (batch.length < 100) break
  }
  return { items, totalCount }
}

export async function fetchDirectCounterparties(workspaceId: string, query: DirectCounterpartyQuery, signal?: AbortSignal): Promise<DirectCounterpartyPage> {
  if (!usesRemoteDirectTransactions(workspaceId)) return readLocalDirectCounterparties(workspaceId, query)
  return readDirectTransactionRpc<{ items: Array<Record<string, unknown>>; totalCount: number }, DirectCounterpartyPage>(workspaceId,
    'list_direct_transaction_counterparties_page', {
      p_scope: query.scope, p_search: query.search?.trim() || null, p_page: query.page,
      p_page_size: query.pageSize, p_selected_partner_id: query.selectedPartnerId ?? null,
    }, ['business_partners', 'agents', 'agent_types'], signal, async raw => {
    if (!Array.isArray(raw.items) || !Number.isSafeInteger(Number(raw.totalCount)) || Number(raw.totalCount) < 0) throw new Error('Invalid counterparty page')
    const items = raw.items.map(row => {
      const map = <T>(value: unknown) => value ? { ...toCamelCase(value as Record<string, unknown>),
        syncStatus: 'synced', lastSyncedAt: new Date().toISOString() } as T : null
      const partner = map<BusinessPartner>(row.partner)
      const agent = map<Agent>(row.agent)
      const customType = map<CustomAgentType>(row.customType)
      if (!partner || partner.workspaceId !== workspaceId || !partner.id || !partner.partnerName
        || (partner.role === 'agent' && !isEligibleDirectAgent(partner, agent, workspaceId))) throw new Error('Invalid counterparty')
      return { partner, agent, customType }
  })
  signal?.throwIfAborted()
  await cacheDirectCounterparties(items)
  return { items, totalCount: Number(raw.totalCount) }
  })
}

export async function resolveDirectCounterparty(workspaceId: string, partnerId: string, agentId?: string | null) {
  const page = await fetchDirectCounterparties(workspaceId, { scope: 'all', selectedPartnerId: partnerId, page: 1, pageSize: 1 })
  const item = page.items[0]
  if (!item || (agentId && item.agent?.id !== agentId)) throw new Error(i18n.t('directTransactionModal.counterparties.unavailable'))
  return item
}

