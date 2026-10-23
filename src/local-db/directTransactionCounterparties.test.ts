import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from './database'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setActiveBusinessUser, setNetworkStatus } from '@/lib/network'
import { writeWorkspaceCache } from '@/workspace/workspaceCache'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { writeCachedPermissions } from '@/permissions/workspacePermissionCache'
import { generateId } from '@/lib/utils'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent, AgentMode, BusinessPartner } from './models'
import { getDirectTransactionAccess } from './directTransactionAccess'

const workspaceId = '00000000-0000-4000-8000-000000000811'
const userId = '00000000-0000-4000-8000-000000000812'
const agentGrant = { id: 'agent-grant', workspace_id: workspaceId, created_by: userId, created_at: '2026-10-23T00:00:00.000Z',
  type: 'module' as const, key: 'agents', value: 'grant' }
const crmRevoke = { ...agentGrant, id: 'crm-revoke', key: 'business_partners', value: 'revoke' }
let counterparties: typeof import('./directTransactionCounterparties')
let payments: typeof import('./payments')
let pages: typeof import('./directTransactions')
let accounts: typeof import('./paymentAccounts')
let statements: typeof import('@/lib/partnerAccountStatement')

async function seedAgent(mode: AgentMode = 'field_agent', name = 'Agent Alpha') {
  const now = new Date().toISOString()
  const base = { workspaceId, createdAt: now, updatedAt: now, lastSyncedAt: now, version: 1, isDeleted: false, syncStatus: 'synced' as const }
  const partner: BusinessPartner = { ...base, id: generateId(), partnerName: name, role: 'agent', defaultCurrency: 'usd',
    agentFacetId: generateId(), creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null,
    totalSalesOrders: 0, totalSalesValue: 0, receivableBalance: 0, totalPurchaseOrders: 0, totalPurchaseValue: 0,
    payableBalance: 0, totalLoanCount: 0, loanOutstandingBalance: 0, netExposure: 0 }
  const agent: Agent = { ...base, id: partner.agentFacetId!, businessPartnerId: partner.id, zone: 'North',
    agentType: mode, status: 'active', salesAccountEnabled: false }
  await db.business_partners.put(partner)
  await db.agents.put(agent)
  return { partner, agent }
}

describe('Agent counterparties and financial effects in Local mode', () => {
  beforeAll(async () => {
    installTestBrowser()
    counterparties = await import('./directTransactionCounterparties')
    payments = await import('./payments')
    pages = await import('./directTransactions')
    accounts = await import('./paymentAccounts')
    statements = await import('@/lib/partnerAccountStatement')
  }, 90_000)
  beforeEach(async () => {
    installTestBrowser()
    await db.delete(); await db.open()
    setNetworkStatus(false)
    setActiveBusinessUser(userId, 'admin', workspaceId)
    writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'local' })
    writeWorkspaceCache({ workspaceId, workspaceName: 'Test', features: { plan: 'enterprise', agents: true, crm: false }, overrides: [agentGrant, crmRevoke] })
  })
  afterAll(async () => { setActiveBusinessUser(null); await db.delete() })

  it('supports every operational mode and custom types with no sales account or CRM', async () => {
    for (const mode of ['driver', 'field_agent', 'courier', 'seller'] as AgentMode[]) await seedAgent(mode)
    const first = await db.agents.toCollection().first()
    const typeId = generateId()
    await db.agent_types.put({ id: typeId, workspaceId, name: 'Distributor', mode: first!.agentType,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString(), version: 1, isDeleted: false, syncStatus: 'synced' })
    await db.agents.update(first!.id, { customAgentTypeId: typeId })
    const page = await counterparties.readLocalDirectCounterparties(workspaceId, { scope: 'agents', page: 1, pageSize: 2 })
    expect(page.totalCount).toBe(4)
    expect(page.items).toHaveLength(2)
    const custom = await counterparties.readLocalDirectCounterparties(workspaceId, { scope: 'all', search: 'Distributor', page: 1, pageSize: 10 })
    expect(custom.items).toHaveLength(1)
    for (const row of (await counterparties.readLocalDirectCounterparties(workspaceId, { scope: 'agents', page: 1, pageSize: 10 })).items) {
      const saved = await payments.recordDirectTransaction(workspaceId, { id: generateId(), amount: 100, direction: 'outgoing', currency: 'usd',
        paymentMethod: 'cash', reason: 'Advance', businessPartnerId: row.partner.id, agentId: row.agent!.id, partnerAccountEffect: 'increase_receivable' })
      expect(saved.metadata).toMatchObject({ counterpartyKind: 'agent', agentId: row.agent!.id,
        agentTypeSnapshot: row.agent!.agentType, businessPartnerId: row.partner.id })
      expect(saved.sourceSubrecordId).toBe(row.partner.id)
    }
  })

  it('rechecks status, workspace, facet identity, grants and member permissions at selection and save', async () => {
    const { partner, agent } = await seedAgent()
    const input = { amount: 20, direction: 'outgoing' as const, currency: 'usd' as const, paymentMethod: 'cash' as const,
      reason: 'Advance', businessPartnerId: partner.id, agentId: agent.id }
    for (const status of ['inactive', 'blocked'] as const) {
      await db.agents.update(agent.id, { status })
      expect((await counterparties.readLocalDirectCounterparties(workspaceId, { scope: 'agents', page: 1, pageSize: 20 })).totalCount).toBe(0)
      await expect(payments.recordDirectTransaction(workspaceId, input)).rejects.toThrow()
    }
    await db.agents.update(agent.id, { status: 'active', workspaceId: generateId() })
    await expect(payments.recordDirectTransaction(workspaceId, input)).rejects.toThrow()
    await db.agents.update(agent.id, { workspaceId })
    await expect(payments.recordDirectTransaction(workspaceId, { ...input, agentId: partner.id })).rejects.toThrow()
    writeWorkspaceCache({ workspaceId, workspaceName: 'Test', features: { plan: 'enterprise', agents: false, crm: true } })
    await expect(payments.recordDirectTransaction(workspaceId, input)).rejects.toThrow()
    writeWorkspaceCache({ workspaceId, workspaceName: 'Test', features: { plan: 'enterprise', agents: true, crm: true },
      overrides: [agentGrant, { id: generateId(), workspace_id: workspaceId, created_by: userId, created_at: new Date().toISOString(),
        type: 'capability', key: 'workspaceManagementPermissions', value: 'grant' }] })
    setActiveBusinessUser(userId, 'staff', workspaceId)
    writeCachedPermissions(workspaceId, userId, ['directTransaction.access'])
    expect(getDirectTransactionAccess(workspaceId).agents).toBe(false)
    await expect(payments.recordDirectTransaction(workspaceId, input)).rejects.toThrow()
    writeCachedPermissions(workspaceId, userId, ['directTransaction.access', 'agents.access'])
    expect(getDirectTransactionAccess(workspaceId).agents).toBe(true)
    expect(await payments.recordDirectTransaction(workspaceId, input)).toMatchObject({ amount: 20 })
  })

  it('keeps immutable identity, exact reversal portions, account movements and retry uniqueness', async () => {
    const { partner, agent } = await seedAgent('courier')
    const account = await accounts.savePaymentAccount(workspaceId, { name: 'Drawer', accountType: 'cash_drawer',
      openingBalances: [{ currency: 'usd', amount: 1000 }] })
    const input = { id: generateId(), amount: 100, direction: 'outgoing' as const, currency: 'usd' as const, paymentMethod: 'cash' as const,
      reason: 'Agent advance', businessPartnerId: partner.id, agentId: agent.id, partnerAccountEffect: 'increase_receivable' as const,
      accountId: account.id, accountNameSnapshot: account.name }
    const [saved, retry] = await Promise.all([payments.recordDirectTransaction(workspaceId, input), payments.recordDirectTransaction(workspaceId, input)])
    expect(saved.id).toBe(retry.id)
    expect(await db.payment_transactions.where('sourceType').equals('direct_transaction').count()).toBe(1)
    await db.payment_transactions.update(saved.id, { paidAt: saved.paidAt.replace('Z', '+00:00') })
    expect((await payments.recordDirectTransaction(workspaceId, { ...input, paidAt: saved.paidAt })).id).toBe(saved.id)
    await expect(payments.recordDirectTransaction(workspaceId, { ...input, amount: 101 })).rejects.toThrow()
    await db.business_partners.update(partner.id, { partnerName: 'Renamed' })
    await db.agents.update(agent.id, { status: 'blocked' })
    const reversal = await payments.reversePaymentTransaction(workspaceId, saved.id, { amount: 30, paidAt: '2027-01-01T00:00:00.000Z' })
    expect(reversal.counterpartyName).toBe('Agent Alpha')
    expect(reversal.metadata).toMatchObject({ agentId: agent.id, counterpartyKind: 'agent' })
    const page = await pages.readLocalDirectTransactions(workspaceId, { page: 1, pageSize: 1, search: '', direction: 'all', end: '2026-12-31T00:00:00.000Z' })
    expect(page.totalCount).toBe(1)
    expect(pages.directTransactionReversalState(page.items[0])).toMatchObject({ remainingAmount: 70, reversedAmount: 30 })
    const ledger = statements.buildPartnerAccountStatementLedger({ partnerId: partner.id, period: { type: 'allTime' },
      salesOrders: [], purchaseOrders: [], loans: [], settlementTransactions: [saved, reversal] })
    expect(ledger.flatMap(currency => currency.entries).reduce((total, entry) => total + entry.delta, 0)).toBe(70)
    const balance = await db.payment_account_balances.where('accountId').equals(account.id).first()
    expect(balance?.balanceAmount).toBe(930)
    const { DirectTransactionVoucherPrintTemplate } = await import('@/ui/components/payments/DirectTransactionVoucherPrintTemplate')
    const voucher = await payments.loadDirectTransactionVoucher(workspaceId, saved.id)
    const html = renderToStaticMarkup(createElement(DirectTransactionVoucherPrintTemplate, {
      data: voucher, workspaceName: 'Test', printLang: 'en', iqdPreference: 'IQD',
    }))
    expect(html).toContain('Agent Alpha · Courier')
    expect(html).not.toContain('Renamed')
    await payments.reversePaymentTransaction(workspaceId, saved.id, { amount: 70 })
    const rows = await db.payment_transactions.where('sourceType').equals('direct_transaction').toArray()
    expect(rows).toHaveLength(3)
    expect(rows.reduce((total, row) => total + row.amount, 0)).toBe(0)
  })

  it('preserves cash-only semantics, duplicate-name identity and cache conflicts', async () => {
    const first = await seedAgent('seller', 'Same name')
    await seedAgent('driver', 'Same name')
    const selected = await counterparties.resolveDirectCounterparty(workspaceId, first.partner.id)
    expect(selected.agent?.id).toBe(first.agent.id)
    const saved = await payments.recordDirectTransaction(workspaceId, { amount: 25, direction: 'incoming', currency: 'usd',
      paymentMethod: 'cash', reason: 'Cash-only', businessPartnerId: first.partner.id, partnerAccountEffect: 'none' })
    const ledger = statements.buildPartnerAccountStatementLedger({ partnerId: first.partner.id, period: { type: 'allTime' },
      salesOrders: [], purchaseOrders: [], loans: [], settlementTransactions: [saved] })
    expect(ledger.flatMap(currency => currency.entries)).toHaveLength(0)
    writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'hybrid' })
    await db.agents.update(first.agent.id, { syncStatus: 'conflict', zone: 'Local edit' })
    await counterparties.cacheDirectCounterparties([{ ...selected, agent: { ...first.agent, zone: 'Remote' } }])
    expect((await db.agents.get(first.agent.id))?.zone).toBe('Local edit')
  })

  it('queues Agent payments offline in Cloud and Hybrid without assigning a server voucher', async () => {
    const { partner, agent } = await seedAgent('seller')
    for (const dataMode of ['cloud', 'hybrid'] as const) {
      writeWorkspaceModeSnapshot({ workspaceId, dataMode })
      const saved = await payments.recordDirectTransaction(workspaceId, { id: generateId(), amount: 40,
        direction: 'incoming', currency: 'usd', paymentMethod: 'cash', reason: 'Offline receipt',
        businessPartnerId: partner.id, agentId: agent.id, partnerAccountEffect: 'decrease_receivable' })
      expect(saved.syncStatus).toBe('pending')
      expect(saved.voucherNumber).toBeUndefined()
      expect(saved.metadata).toMatchObject({ businessPartnerId: partner.id, agentId: agent.id, counterpartyKind: 'agent' })
      expect(await db.offline_mutations.where('entityId').equals(saved.id).count()).toBe(1)
      await expect(payments.loadDirectTransactionVoucher(workspaceId, saved.id)).rejects.toThrow('synchronization')
    }
  })

  it('includes an older offset-formatted timestamp at the exact date-filter boundary', async () => {
    const saved = await payments.recordDirectTransaction(workspaceId, { amount: 10, direction: 'incoming', currency: 'usd',
      paymentMethod: 'cash', reason: 'Boundary', counterpartyName: 'External', paidAt: '2026-10-23T00:00:00.000Z' })
    await db.payment_transactions.update(saved.id, { paidAt: '2026-10-23T00:00:00+00:00' })
    const page = await pages.readLocalDirectTransactions(workspaceId, { page: 1, pageSize: 10, search: '', direction: 'all',
      start: '2026-10-23T00:00:00.000Z', end: '2026-10-24T00:00:00.000Z' })
    expect(page.items.map(row => row.transaction.id)).toEqual([saved.id])
    expect(page.totalCount).toBe(1)
  })
})
