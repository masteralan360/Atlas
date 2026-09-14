import 'fake-indexeddb/auto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }))

vi.mock('@/lib/supabaseSchema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabaseSchema')>()
  return {
    ...actual,
    getSupabaseClientForTable: () => ({ rpc: rpcMock })
  }
})

import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import type { CashierShiftAssignment } from './models'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000811'
const CASHIER_ID = '00000000-0000-4000-8000-000000000812'
const NOW = new Date('2026-08-30T12:00:00.000Z')

let startCashierShiftOccurrence: typeof import('./paymentAccounts').startCashierShiftOccurrence

function installBrowserStorage() {
  Object.defineProperty(globalThis.URL, 'createObjectURL', {
    configurable: true,
    value: () => 'blob:vitest'
  })
  Object.defineProperty(globalThis, 'DOMMatrix', {
    configurable: true,
    value: class DOMMatrix {}
  })
  const values = new Map<string, string>()
  const storage = {
    get length() {
      return values.size
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null
  }
  const documentHead = { appendChild: () => undefined }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  })
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      sessionStorage: storage,
      URL: globalThis.URL,
      location: { hash: '', origin: 'http://localhost', pathname: '/' },
      addEventListener: () => undefined
    }
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      dir: 'ltr',
      documentElement: { lang: 'en', dir: 'ltr', style: {} },
      head: documentHead,
      getElementsByTagName: () => [documentHead],
      createElement: () => ({
        setAttribute: () => undefined,
        appendChild: () => undefined,
        style: {}
      }),
      createTextNode: () => ({}),
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  })
  Object.defineProperty(globalThis, 'Element', {
    configurable: true,
    value: class Element {}
  })
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    value: class HTMLElement {}
  })
}

function manualAssignment(): CashierShiftAssignment {
  return {
    id: '00000000-0000-4000-8000-000000000813',
    workspaceId: WORKSPACE_ID,
    assignmentMode: 'manual',
    templateId: null,
    templateNameSnapshot: null,
    accountId: '00000000-0000-4000-8000-000000000814',
    accountNameSnapshot: 'Main Drawer',
    cashierUserId: CASHIER_ID,
    cashierNameSnapshot: 'Cashier One',
    startTime: null,
    endTime: null,
    workingDays: [NOW.getDay()],
    earlyFinishPolicy: null,
    earlyFinishOffsetMinutes: null,
    isActive: true,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    syncStatus: 'synced',
    lastSyncedAt: NOW.toISOString(),
    version: 1,
    isDeleted: false
  }
}

describe('Cloud Sync cashier-shift claims', () => {
  beforeAll(async () => {
    installBrowserStorage()
    ;({ startCashierShiftOccurrence } = await import('./paymentAccounts'))
  }, 60_000)

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    installBrowserStorage()
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({
      workspaceId: WORKSPACE_ID,
      dataMode: 'hybrid'
    })
    setNetworkStatus(true)
    rpcMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    setNetworkStatus(true)
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
  })

  it('uses the server claim before mirroring a Cloud Sync start locally', async () => {
    const assignment = manualAssignment()
    await db.cashier_shift_assignments.put(assignment)
    rpcMock.mockResolvedValue({ data: null, error: null })

    const occurrence = await startCashierShiftOccurrence(WORKSPACE_ID, {
      assignmentId: assignment.id,
      cashierUserId: CASHIER_ID,
      source: 'manual'
    })

    expect(rpcMock).toHaveBeenCalledWith(
      'claim_cashier_shift_occurrence',
      expect.objectContaining({
        p_occurrence: expect.objectContaining({
          assignment_mode: 'manual',
          scheduled_start_at: null,
          scheduled_end_at: null
        })
      })
    )
    expect(occurrence).toMatchObject({
      syncStatus: 'synced',
      assignmentMode: 'manual'
    })
    expect(await db.cashier_shift_occurrences.get(occurrence.id)).toMatchObject({
      id: occurrence.id,
      syncStatus: 'synced'
    })
  })

  it('does not mirror a failed atomic claim from another device', async () => {
    const assignment = manualAssignment()
    await db.cashier_shift_assignments.put(assignment)
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate active cashier' }
    })

    await expect(
      startCashierShiftOccurrence(WORKSPACE_ID, {
        assignmentId: assignment.id,
        cashierUserId: CASHIER_ID,
        source: 'manual'
      })
    ).rejects.toThrow('active shift')
    expect(await db.cashier_shift_occurrences.count()).toBe(0)
  })
})
