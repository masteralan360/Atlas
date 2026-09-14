import 'fake-indexeddb/auto'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '@/local-db/database'
import {
  deleteLocalCustomTemplate,
  listLocalCustomTemplates,
  saveLocalCustomTemplate,
} from '@/local-db/customTemplates'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import {
  captureDemoBrowserState,
  clearLocalDemoWorkspaceData,
} from './demoCleanup'

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

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage, sessionStorage: storage },
  })
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage,
  })
}

async function clearAllTables() {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()))
  })
}

describe('demo workspace cleanup', () => {
  beforeEach(async () => {
    installBrowserStorage()
    await clearAllTables()
  })

  afterAll(async () => {
    await db.delete()
  })

  it('removes only records owned by the demo workspace', async () => {
    const now = new Date().toISOString()

    await db.workspaces.bulkPut([
      {
        id: 'demo-workspace',
        workspaceId: 'demo-workspace',
        name: 'Demo',
        code: 'demo.market.15.abc123',
        plan: 'enterprise',
        data_mode: 'demo',
        is_configured: true,
        syncStatus: 'synced',
        lastSyncedAt: now,
        version: 1,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      } as any,
      {
        id: 'normal-workspace',
        workspaceId: 'normal-workspace',
        name: 'Normal',
        code: 'NORMAL',
        plan: 'basic',
        data_mode: 'hybrid',
        is_configured: true,
        syncStatus: 'synced',
        lastSyncedAt: now,
        version: 1,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
      } as any,
    ])

    await db.products.bulkPut([
      {
        id: 'demo-product',
        workspaceId: 'demo-workspace',
        name: 'Demo product',
        syncStatus: 'synced',
        isDeleted: false,
      } as any,
      {
        id: 'normal-product',
        workspaceId: 'normal-workspace',
        name: 'Normal product',
        syncStatus: 'synced',
        isDeleted: false,
      } as any,
    ])

    await db.sales.add({
      id: 'demo-sale',
      workspaceId: 'demo-workspace',
      cashierId: 'demo-user',
      syncStatus: 'synced',
      isDeleted: false,
    } as any)
    await db.sale_items.add({
      id: 'demo-sale-item',
      saleId: 'demo-sale',
      productId: 'demo-product',
    } as any)
    await db.offline_mutations.add({
      id: 'demo-mutation',
      workspaceId: 'demo-workspace',
      entityType: 'products',
      entityId: 'demo-product',
      operation: 'update',
      payload: {},
      status: 'pending',
      createdAt: now,
    })
    await db.syncQueue.bulkPut([
      {
        id: 'demo-queue',
        entityType: 'products',
        entityId: 'demo-product',
        operation: 'update',
        timestamp: now,
      } as any,
      {
        id: 'normal-queue',
        entityType: 'products',
        entityId: 'normal-product',
        operation: 'update',
        timestamp: now,
      } as any,
    ])
    await db.app_settings.put({
      key: 'notebook_document:demo-workspace:demo-user',
      value: 'demo notes',
    })

    localStorage.setItem('atlas_workspace_cache:v2:demo-workspace', 'cached')
    localStorage.setItem('normal-preference', 'keep')
    localStorage.setItem('pos_held_sales', 'normal held sales')
    localStorage.setItem('sb-project-auth-token', 'pre-demo-auth')
    await captureDemoBrowserState('demo-workspace')
    localStorage.setItem('pos_held_sales', 'demo held sales')
    localStorage.setItem('demo-only-preference', 'remove')
    localStorage.setItem('atlas_session_recovery', 'demo recovery')
    localStorage.setItem('sb-project-auth-token', 'demo-auth')

    await clearLocalDemoWorkspaceData('demo-workspace')

    expect(await db.workspaces.get('demo-workspace')).toBeUndefined()
    expect(await db.products.get('demo-product')).toBeUndefined()
    expect(await db.sales.get('demo-sale')).toBeUndefined()
    expect(await db.sale_items.get('demo-sale-item')).toBeUndefined()
    expect(await db.offline_mutations.get('demo-mutation')).toBeUndefined()
    expect(await db.syncQueue.get('demo-queue')).toBeUndefined()
    expect(await db.app_settings.get('notebook_document:demo-workspace:demo-user')).toBeUndefined()

    expect(await db.workspaces.get('normal-workspace')).toBeDefined()
    expect(await db.products.get('normal-product')).toBeDefined()
    expect(await db.syncQueue.get('normal-queue')).toBeDefined()
    expect(localStorage.getItem('normal-preference')).toBe('keep')
    expect(localStorage.getItem('pos_held_sales')).toBe('normal held sales')
    expect(localStorage.getItem('demo-only-preference')).toBeNull()
    expect(localStorage.getItem('atlas_session_recovery')).toBeNull()
    expect(localStorage.getItem('sb-project-auth-token')).toBe('demo-auth')
  })

  it('stores demo custom templates in Dexie instead of SQLite', async () => {
    writeWorkspaceModeSnapshot({
      workspaceId: 'demo-workspace',
      dataMode: 'demo',
    })

    await saveLocalCustomTemplate({
      workspaceId: 'demo-workspace',
      moduleTypeKey: 'sales.receipt',
      label: 'Demo receipt',
      layoutJson: { title: 'Demo' },
      userId: 'demo-user',
    })

    const templates = await listLocalCustomTemplates('demo-workspace')

    expect(templates).toHaveLength(1)
    expect(templates[0]).toMatchObject({
      workspace_id: 'demo-workspace',
      label: 'Demo receipt',
      layout_json: { title: 'Demo' },
    })
    expect(
      await db.app_settings
        .filter((setting) => setting.key.startsWith('demo_custom_template:demo-workspace:'))
        .count(),
    ).toBe(1)
  })

  it('promotes another active demo template when deleting the primary template', async () => {
    writeWorkspaceModeSnapshot({
      workspaceId: 'demo-workspace',
      dataMode: 'demo',
    })

    const primaryTemplate = await saveLocalCustomTemplate({
      workspaceId: 'demo-workspace',
      moduleTypeKey: 'sales.receipt',
      label: 'Primary receipt',
      layoutJson: { title: 'Primary' },
      userId: 'demo-user',
    })
    const replacementTemplate = await saveLocalCustomTemplate({
      workspaceId: 'demo-workspace',
      moduleTypeKey: 'sales.receipt',
      label: 'Replacement receipt',
      layoutJson: { title: 'Replacement' },
      userId: 'demo-user',
    })

    await deleteLocalCustomTemplate(
      'demo-workspace',
      primaryTemplate.id,
      'demo-user',
    )

    const templates = await listLocalCustomTemplates('demo-workspace')
    expect(templates).toHaveLength(1)
    expect(templates[0]).toMatchObject({
      id: replacementTemplate.id,
      active: true,
      primary: true,
    })
  })

  it('allows deleting the final demo custom template', async () => {
    writeWorkspaceModeSnapshot({
      workspaceId: 'demo-workspace',
      dataMode: 'demo',
    })

    const onlyTemplate = await saveLocalCustomTemplate({
      workspaceId: 'demo-workspace',
      moduleTypeKey: 'sales.receipt',
      label: 'Only receipt',
      layoutJson: { title: 'Only' },
      userId: 'demo-user',
    })

    await deleteLocalCustomTemplate(
      'demo-workspace',
      onlyTemplate.id,
      'demo-user',
    )

    expect(await listLocalCustomTemplates('demo-workspace')).toHaveLength(0)
  })
})
