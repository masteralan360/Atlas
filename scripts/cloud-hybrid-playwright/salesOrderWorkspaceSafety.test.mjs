import test from 'node:test'
import assert from 'node:assert/strict'
import { salesOrderRunTerminalStatus, verifyHybridWorkspace } from './salesOrderRun.mjs'

function contextFor(dataMode) {
  const workspace = { id: 'workspace-hybrid', name: 'DEV TEST Sales Orders', data_mode: dataMode }
  return {
    workspace,
    config: { configuredWorkspaceName: workspace.name },
    profile: { role: 'staff' },
    supabase: {
      from(table) {
        assert.equal(table, 'workspaces')
        return {
          select() { return this },
          eq(column, value) {
            assert.equal(column, 'id')
            assert.equal(value, workspace.id)
            return this
          },
          async maybeSingle() {
            return { data: { ...workspace, is_configured: true, locked_workspace: false }, error: null }
          }
        }
      }
    }
  }
}

test('Sales Order workspace verification rejects Cloud and Local before remote readiness checks', async () => {
  for (const mode of ['cloud', 'local']) {
    const context = contextFor(mode)
    context.supabase.from = () => { throw new Error('Remote verification must not run for the wrong mode.') }
    await assert.rejects(verifyHybridWorkspace(context), /Hybrid mode is required/)
  }
})

test('Sales Order workspace verification requires the dedicated test name, configured unlocked Hybrid mode, and an authorized role', async () => {
  const accepted = await verifyHybridWorkspace(contextFor('hybrid'))
  assert.equal(accepted.id, 'workspace-hybrid')
  assert.equal(accepted.profileRole, 'staff')

  const wrongName = contextFor('hybrid')
  wrongName.workspace.name = 'Production'
  await assert.rejects(verifyHybridWorkspace(wrongName), /must start with DEV TEST/)

  const viewer = contextFor('hybrid')
  viewer.profile.role = 'viewer'
  await assert.rejects(verifyHybridWorkspace(viewer), /authorized admin or staff/)

  const locked = contextFor('hybrid')
  locked.supabase.from = () => ({
    select() { return this },
    eq() { return this },
    async maybeSingle() { return { data: { ...locked.workspace, is_configured: true, locked_workspace: true }, error: null } }
  })
  await assert.rejects(verifyHybridWorkspace(locked), /configured or is locked/)
})

test('overall run status does not label incomplete coverage as a full pass', () => {
  assert.equal(salesOrderRunTerminalStatus({ cancelled: false, scenarioFailures: false, cleanupFailure: false, blockedCount: 0 }), 'passed')
  assert.equal(salesOrderRunTerminalStatus({ cancelled: false, scenarioFailures: false, cleanupFailure: false, blockedCount: 2 }), 'blocked')
  assert.equal(salesOrderRunTerminalStatus({ cancelled: false, scenarioFailures: true, cleanupFailure: false, blockedCount: 0 }), 'failed')
  assert.equal(salesOrderRunTerminalStatus({ cancelled: true, scenarioFailures: false, cleanupFailure: true, blockedCount: 2 }), 'cancelled')
})
