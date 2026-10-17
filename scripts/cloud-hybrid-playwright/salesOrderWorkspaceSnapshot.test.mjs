import test from 'node:test'
import assert from 'node:assert/strict'
import { isReadyForSalesOrderApplicationSnapshot } from './salesOrderDriver.mjs'

const target = { workspaceId: 'workspace-1', userId: 'user-1' }
const snapshot = {
  workspace: {
    id: target.workspaceId,
    data_mode: 'hybrid',
    is_configured: true,
    locked_workspace: false,
    orders: true,
    crm: true,
    products: true,
    storages: true,
    services: false,
    loans: false
  },
  activeWorkspaceId: target.workspaceId,
  activeUserId: target.userId
}

test('workspace snapshot readiness waits for the complete feature row and matching active identity', () => {
  assert.equal(isReadyForSalesOrderApplicationSnapshot(null, target), false)
  assert.equal(isReadyForSalesOrderApplicationSnapshot({ ...snapshot, workspace: { id: target.workspaceId } }, target), false)
  assert.equal(isReadyForSalesOrderApplicationSnapshot(snapshot, target), true)
})

test('workspace snapshot readiness accepts disabled capabilities but rejects a stale workspace or user', () => {
  assert.equal(isReadyForSalesOrderApplicationSnapshot(snapshot, target), true)
  assert.equal(isReadyForSalesOrderApplicationSnapshot({ ...snapshot, workspace: { ...snapshot.workspace, services: undefined } }, target), false)
  assert.equal(isReadyForSalesOrderApplicationSnapshot({ ...snapshot, workspace: { ...snapshot.workspace, id: 'workspace-2' } }, target), false)
  assert.equal(isReadyForSalesOrderApplicationSnapshot({ ...snapshot, activeWorkspaceId: 'workspace-2' }, target), false)
  assert.equal(isReadyForSalesOrderApplicationSnapshot({ ...snapshot, activeUserId: 'user-2' }, target), false)
})
