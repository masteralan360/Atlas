import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000401'

let saveActivityCatalogItem: typeof import('./activities').saveActivityCatalogItem
let createActivityTransaction: typeof import('./activities').createActivityTransaction
let reverseActivityTransaction: typeof import('./activities').reverseActivityTransaction

function installBrowserStorage() {
  const rows = new Map<string, string>()
  const storage = {
    get length() {
      return rows.size
    },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  }

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      sessionStorage: storage,
      location: { origin: 'http://localhost', hash: '', pathname: '/' },
      URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      visibilityState: 'visible',
      dir: 'ltr',
      documentElement: { lang: 'en', dir: 'ltr' },
      head: { appendChild: () => undefined },
      getElementsByTagName: () => [{ appendChild: () => undefined }],
      createElement: () => ({ appendChild: () => undefined }),
      createTextNode: () => ({}),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
  Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, value: class DOMMatrix {} })
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class ImageData {} })
  Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: class Path2D {} })
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: class Element {} })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class HTMLElement {} })
}

describe('activity payment reversals', () => {
  beforeAll(async () => {
    installBrowserStorage()
    const activities = await import('./activities')
    saveActivityCatalogItem = activities.saveActivityCatalogItem
    createActivityTransaction = activities.createActivityTransaction
    reverseActivityTransaction = activities.reverseActivityTransaction
  })

  beforeEach(async () => {
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
  })

  afterEach(() => {
    clearWorkspaceModeSnapshot(WORKSPACE_ID)
  })

  afterAll(async () => {
    await db.delete()
  })

  it('requires a full remaining reversal and records the selected cash details', async () => {
    const catalogItem = await saveActivityCatalogItem(WORKSPACE_ID, {
      name: 'Pool session',
      defaultUnitPrice: 100,
      currency: 'usd',
      isInfinite: false,
      availableQuantity: 5,
    })
    const { transaction } = await createActivityTransaction(WORKSPACE_ID, {
      name: 'Two sessions',
      customerName: 'Test customer',
      occurredAt: '2026-09-01T10:00:00.000Z',
      currency: 'usd',
      paymentMethod: 'cash',
      lines: [{ activityId: catalogItem.id, quantity: 2, unitPrice: 100 }],
    })

    await expect(reverseActivityTransaction(
      WORKSPACE_ID,
      transaction.id,
      'refunded',
      null,
      { amount: 100, note: 'Invalid partial refund' },
    )).rejects.toThrow('full remaining amount')
    expect(await db.activity_transactions.get(transaction.id)).toMatchObject({ status: 'completed' })
    expect(await db.payment_transactions.where('sourceRecordId').equals(transaction.id).count()).toBe(1)

    await reverseActivityTransaction(WORKSPACE_ID, transaction.id, 'refunded', null, {
      amount: 200,
      paidAt: '2026-09-05T14:30:00.000Z',
      note: 'Customer refund',
      paymentMethod: 'bank_transfer',
      accountId: null,
      accountNameSnapshot: null,
    })

    expect(await db.activity_transactions.get(transaction.id)).toMatchObject({ status: 'refunded' })
    expect(await db.activity_catalog.get(catalogItem.id)).toMatchObject({ availableQuantity: 5 })

    const payments = await db.payment_transactions.where('sourceRecordId').equals(transaction.id).toArray()
    const original = payments.find((payment) => !payment.reversalOfTransactionId)
    const reversal = payments.find((payment) => !!payment.reversalOfTransactionId)
    expect(reversal).toMatchObject({
      sourceType: 'activity_refund',
      direction: 'outgoing',
      amount: 200,
      paidAt: '2026-09-05T14:30:00.000Z',
      note: 'Customer refund',
      paymentMethod: 'bank_transfer',
      accountId: null,
      reversalOfTransactionId: original?.id,
    })
  })
})
