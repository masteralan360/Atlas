import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createLiveFetch, loadLiveConfig, preflightLive } from './live.mjs'

export function loadResilienceConfig(root) {
  const bootstrap = loadLiveConfig(root)
  let source
  try { source = readFileSync(`${root}/.env.atlas-resilience.local`, 'utf8') }
  catch { throw new Error('live_resilience_provisioning_missing') }
  const values = Object.fromEntries(source.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const index = line.indexOf('=')
    if (index < 1) throw new Error('live_resilience_config_invalid')
    return [line.slice(0, index), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]
  }))
  if (Object.keys(values).some(key => !['SORL_SUPABASE_URL', 'SORL_PROVISIONING_KEY'].includes(key))
    || values.SORL_SUPABASE_URL !== bootstrap.origin || !values.SORL_PROVISIONING_KEY) throw new Error('live_resilience_config_invalid')
  return { bootstrap, provisioningKey: values.SORL_PROVISIONING_KEY }
}
export function assertOwnedWorkspace(workspace, namespace, ids) {
  if (!/^DEV TEST SORL [0-9a-f-]{36}$/.test(namespace) || !ids.includes(workspace?.id)
    || !workspace.name.startsWith(`${namespace} `)) throw new Error('live_resilience_cleanup_refused')
}
const requireData = (result, label) => {
  if (result.error || result.data === null) throw new Error(`${label}:${result.error?.code ?? result.error?.status ?? 'missing'}:${result.error?.message ?? 'No data'}`)
  return result.data
}

/** Parent-only capability. A business driver never receives this client or its key. */
export async function provisionResilience(root, { entitlements = false, services = false, mode = 'cloud', runId = randomUUID() } = {}) {
  const config = loadResilienceConfig(root)
  await preflightLive(config.bootstrap, { suiteId: 'business-partners' })
  const admin = createClient(config.bootstrap.origin, config.provisioningKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createLiveFetch(config.bootstrap.origin) }
  })
  const namespace = `DEV TEST SORL ${runId}`
  const manifest = { runId, namespace, url: config.bootstrap.origin, key: config.bootstrap.ATLAS_LIVE_SUPABASE_KEY, workspaces: [], actors: {} }
  const createdUsers = []
  async function workspace(label, plan, override, roles = ['admin', 'observer']) {
    const row = requireData(await admin.from('workspaces').insert({ id: randomUUID(), name: `${namespace} ${label}`,
      plan: entitlements && plan === 'basic' ? 'business' : plan, data_mode: mode, is_configured: true, locked_workspace: false, default_currency: plan === 'basic' ? 'iqd' : 'usd',
      coordination: '33.3152, 44.3661', subscription_expires_at: new Date(Date.now() + 365 * 86400000).toISOString() }).select('*').single(), 'provision.workspace')
    manifest.workspaces.push({ id: row.id, name: row.name, plan, mode, label, override: override ?? null })
    if (override) requireData(await admin.from('workspace_access_overrides').insert({ workspace_id: row.id, type: 'module', key: 'orders', value: override }).select('id').single(), 'provision.override')
    if (entitlements) {
      // Catalog data can predate a plan change. Provision it without granting unrelated modules.
      const partnerId = randomUUID(), customerId = randomUUID(), name = `${namespace} access customer`
      requireData(await admin.schema('crm').from('business_partners').insert({ id: partnerId, workspace_id: row.id,
        name, partner_name: name, role: 'customer', default_currency: 'iqd', customer_facet_id: customerId }).select('id').single(), 'provision.accessPartner')
      requireData(await admin.schema('crm').from('customers').insert({ id: customerId, workspace_id: row.id,
        name, partner_name: name, business_partner_id: partnerId, default_currency: 'iqd' }).select('id').single(), 'provision.accessCustomer')
      if (plan === 'basic') requireData(await admin.from('workspaces').update({ plan }).eq('id', row.id).select('id').single(), 'provision.finalPlan')
    }
    for (const roleName of roles) {
      const email = `sorl-${runId}-${label}-${roleName}@example.com`
      const password = `SORL-${randomBytes(24).toString('hex')}!`
      const role = ['observer', 'admin'].includes(roleName) ? 'admin' : roleName === 'viewer' ? 'viewer' : 'staff'
      const userId = randomUUID()
      const permit = await admin.rpc('register_resilience_actor_permit', { p_user_id: userId, p_workspace_id: row.id, p_run_id: runId, p_email: email, p_role: role })
      if (permit.error) throw new Error(`provision.permit:${permit.error.code}`)
      const auth = requireData(await admin.auth.admin.createUser({ id: userId, email, password, email_confirm: true,
        app_metadata: { sorl_run_id: runId, sorl_workspace_id: row.id },
        user_metadata: { name: `${namespace} ${roleName}`, role, workspace_id: row.id } }), 'provision.actor')
      createdUsers.push(auth.user.id)
      requireData(await admin.from('profiles').upsert({ id: auth.user.id, name: `${namespace} ${roleName}`, role,
        workspace_id: row.id, current_workspace: row.id }).select('id').single(), 'provision.profile')
      manifest.actors[`${label}.${roleName}`] = { userId: auth.user.id, email, password, workspaceId: row.id, workspaceName: row.name, role }
      if (['allowed', 'viewer'].includes(roleName)) requireData(await admin.from('workspace_permissions').insert({ workspace_id: row.id,
        user_uuid: auth.user.id, key: 'orders.saleOrdersAccess', module: 'orders' }).select('id').single(), 'provision.permission')
    }
  }
  async function cleanup(passed = true) {
    if (!passed) { console.log(`SORL cleanup: retained-failure-fixture; namespace: ${namespace}`); return }
    const ids = manifest.workspaces.map(row => row.id)
    const retained = []
    const pending = []
    for (const fixture of [...manifest.workspaces].reverse()) {
      const stored = requireData(await admin.from('workspaces').select('id,name').eq('id', fixture.id).single(), 'cleanup.guard')
      assertOwnedWorkspace(stored, namespace, ids)
      const result = await admin.rpc('delete_demo_cascade', { p_workspace_id: fixture.id })
      if (result.error?.code === '23514' && result.error.message.includes('Account-linked payment transactions cannot be hard deleted')) {
        retained.push(fixture.id)
        console.log(`SORL cleanup: retained-audit-fixture; namespace: ${namespace}; workspace: ${fixture.id}`)
        continue
      }
      if (result.error?.code === '57014') {
        // The server rolled back a timed-out cascade. Preserve its exact namespace
        // and disable the actors below; never loosen audit guards to force deletion.
        retained.push(fixture.id); pending.push({ workspaceId: fixture.id, reason: 'cleanup-statement-timeout' })
        console.log(`SORL cleanup: retained-timeout-fixture; namespace: ${namespace}; workspace: ${fixture.id}`)
        continue
      }
      if (result.error) throw new Error(`live_resilience_cleanup_failed:${fixture.id}:${result.error.code}`)
      const remaining = requireData(await admin.from('workspaces').select('id').eq('id', fixture.id), 'cleanup.verify')
      if (remaining.length) throw new Error('live_resilience_cleanup_incomplete')
    }
    for (const id of createdUsers) {
      const actor = Object.values(manifest.actors).find(actor => actor.userId === id)
      if (!actor || !actor.email.startsWith(`sorl-${runId}-`)) throw new Error('live_resilience_cleanup_refused')
      // Soft deletion disables sign-in while preserving immutable audit foreign keys.
      const result = await admin.auth.admin.deleteUser(id, true)
      if (result.error) throw new Error(`live_resilience_actor_cleanup_failed:${result.error.code}`)
    }
    const directory = `${root}/.atlas-dev-testing/resilience/${runId}`
    mkdirSync(directory, { recursive: true })
    writeFileSync(`${directory}/cleanup.json`, JSON.stringify({ namespace, passed, retained, pending, actorsRemoved: createdUsers.length }))
    console.log(`SORL cleanup: ${pending.length ? 'users-removed-cleanup-pending' : retained.length ? 'users-removed-history-retained' : 'removed'}; namespace: ${namespace}`)
  }
  try {
    await workspace('business', 'business')
    if (services) requireData(await admin.from('workspace_access_overrides').insert([
      { workspace_id: manifest.workspaces[0].id, type: 'module', key: 'services', value: 'grant' },
      { workspace_id: manifest.workspaces[0].id, type: 'module', key: 'agents', value: 'grant' },
      { workspace_id: manifest.workspaces[0].id, type: 'module', key: 'agent_sales_accounts', value: 'grant' },
      { workspace_id: manifest.workspaces[0].id, type: 'capability', key: 'quickOrder', value: 'grant' }
    ]).select('id'), 'provision.focusedContracts')
    await workspace('foreign', 'business', null, ['admin'])
    if (entitlements) {
      await workspace('enterprise', 'enterprise', null, ['admin', 'allowed', 'denied', 'viewer'])
      await workspace('basic', 'basic', null, ['admin'])
      await workspace('grant', 'basic', 'grant', ['admin'])
      await workspace('revoke', 'business', 'revoke', ['admin'])
    }
    mkdirSync(`${root}/.atlas-dev-testing/resilience/${runId}`, { recursive: true })
    writeFileSync(`${root}/.atlas-dev-testing/resilience/${runId}/actors.private.json`, JSON.stringify(manifest), { mode: 0o600 })
    return { manifest, cleanup }
  } catch (error) {
    console.log(`SORL provisioning failed; retained namespace: ${namespace}; created workspaces: ${manifest.workspaces.map(row => row.id).join(', ')}`)
    await cleanup(true).catch(cleanupError => console.log(cleanupError.message))
    throw error
  }
}
