import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const supabaseMocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  from: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  single: vi.fn()
}))

vi.mock('@/lib/supabaseSchema', () => ({
  getSupabaseClientForTable: supabaseMocks.getClient
}))

import { db } from './database'
import {
  createPartnerSettlementOperation,
  finishPartnerSettlementOperation,
  linkPaymentTransactionToSettlement
} from './partnerSettlementOperations'
import type { PaymentTransaction } from './models'
import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000091'

function installSupabaseMock() {
  const request = {
    eq: supabaseMocks.eq,
    select: supabaseMocks.select,
    single: supabaseMocks.single
  }
  supabaseMocks.eq.mockReturnValue(request)
  supabaseMocks.select.mockReturnValue(request)
  supabaseMocks.single.mockResolvedValue({ data: { id: 'pt-1' }, error: null })
  supabaseMocks.update.mockReturnValue(request)
  supabaseMocks.from.mockReturnValue({
    upsert: supabaseMocks.upsert,
    update: supabaseMocks.update
  })
  supabaseMocks.upsert.mockResolvedValue({ error: null })
  supabaseMocks.getClient.mockReturnValue({ from: supabaseMocks.from })
}

function paymentTransaction(): PaymentTransaction {
  const now = new Date().toISOString()
  return {
    id: 'pt-1',
    workspaceId: WORKSPACE_ID,
    sourceModule: 'orders',
    sourceType: 'sales_order',
    sourceRecordId: 'order-1',
    direction: 'incoming',
    amount: 125,
    currency: 'usd',
    paymentMethod: 'cash',
    paidAt: now,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    syncStatus: 'pending',
    lastSyncedAt: null
  }
}

describe('partner settlement remote persistence', () => {
  beforeEach(async () => {
    await db.partner_settlement_operations.clear()
    await db.payment_transactions.clear()
    await db.offline_mutations.clear()
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'hybrid' })
    setNetworkStatus(true)
    vi.clearAllMocks()
    installSupabaseMock()
  })

  afterAll(async () => {
    setNetworkStatus(false)
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
    db.close()
  })

  it('upserts the operation header using the remote snake_case contract and marks it synced', async () => {
    const operation = await createPartnerSettlementOperation({
      id: 'settle-1',
      workspaceId: WORKSPACE_ID,
      partnerId: 'partner-1',
      partnerNameSnapshot: 'Customer A',
      direction: 'incoming',
      paidAt: '2026-09-28T09:00:00.000Z',
      paymentMethod: 'cash',
      status: 'in_progress'
    })

    expect(supabaseMocks.getClient).toHaveBeenCalledWith('partner_settlement_operations')
    expect(supabaseMocks.from).toHaveBeenCalledWith('partner_settlement_operations')
    expect(supabaseMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'settle-1',
        workspace_id: WORKSPACE_ID,
        partner_id: 'partner-1',
        partner_name_snapshot: 'Customer A',
        paid_at: '2026-09-28T09:00:00.000Z',
        payment_method: 'cash',
        status: 'in_progress'
      }),
      { onConflict: 'id' }
    )
    expect(operation?.syncStatus).toBe('synced')
    expect((await db.partner_settlement_operations.get('settle-1'))?.syncStatus).toBe('synced')
  })

  it('retains the operation locally and queues it when the header upsert fails', async () => {
    supabaseMocks.upsert.mockResolvedValue({ error: new Error('temporary remote error') })

    const operation = await createPartnerSettlementOperation({
      id: 'settle-pending',
      workspaceId: WORKSPACE_ID,
      partnerId: 'partner-1',
      partnerNameSnapshot: 'Customer A',
      direction: 'outgoing',
      paidAt: '2026-09-28T09:00:00.000Z',
      paymentMethod: 'cash',
      status: 'in_progress'
    })
    const queued = await db.offline_mutations.where('entityId').equals('settle-pending').first()

    expect(operation?.syncStatus).toBe('pending')
    expect(queued).toMatchObject({
      entityType: 'partner_settlement_operations',
      entityId: 'settle-pending',
      operation: 'create',
      status: 'pending',
      payload: expect.objectContaining({ status: 'in_progress' })
    })

    supabaseMocks.upsert.mockResolvedValue({ error: null })
    await finishPartnerSettlementOperation('settle-pending', 'completed')

    await expect(db.offline_mutations.get(queued!.id)).resolves.toMatchObject({ status: 'synced' })
    await expect(db.partner_settlement_operations.get('settle-pending')).resolves.toMatchObject({
      status: 'completed',
      syncStatus: 'synced'
    })
  })

  it('links an individual payment transaction through a workspace-scoped update', async () => {
    await db.payment_transactions.put(paymentTransaction())

    const linked = await linkPaymentTransactionToSettlement(WORKSPACE_ID, 'pt-1', 'settle-1')

    expect(supabaseMocks.getClient).toHaveBeenCalledWith('payment_transactions')
    expect(supabaseMocks.from).toHaveBeenCalledWith('payment_transactions')
    expect(supabaseMocks.update).toHaveBeenCalledWith(expect.objectContaining({
      settlement_operation_id: 'settle-1',
      version: 2
    }))
    expect(supabaseMocks.eq).toHaveBeenNthCalledWith(1, 'id', 'pt-1')
    expect(supabaseMocks.eq).toHaveBeenNthCalledWith(2, 'workspace_id', WORKSPACE_ID)
    expect(linked?.settlementOperationId).toBe('settle-1')
    expect((await db.payment_transactions.get('pt-1'))?.syncStatus).toBe('synced')
  })

  it('keeps the local link and queues an offline mutation when the remote update fails', async () => {
    await db.payment_transactions.put(paymentTransaction())
    supabaseMocks.single.mockResolvedValue({ data: null, error: new Error('temporary remote error') })

    const linked = await linkPaymentTransactionToSettlement(WORKSPACE_ID, 'pt-1', 'settle-1')
    const queued = await db.offline_mutations.where('entityId').equals('pt-1').first()

    expect(linked?.settlementOperationId).toBe('settle-1')
    expect(linked?.syncStatus).toBe('pending')
    expect(queued).toMatchObject({
      entityType: 'payment_transactions',
      entityId: 'pt-1',
      operation: 'update',
      status: 'pending',
      payload: expect.objectContaining({ settlementOperationId: 'settle-1' })
    })
  })
})
