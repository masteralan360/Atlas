import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

export const LIVE_CONFIG_FILE = '.env.atlas-live-tests.local'
const required = ['ATLAS_LIVE_SUPABASE_URL', 'ATLAS_LIVE_SUPABASE_KEY', 'ATLAS_LIVE_TEST_EMAIL', 'ATLAS_LIVE_TEST_PASSWORD', 'ATLAS_LIVE_WORKSPACE_ID', 'ATLAS_LIVE_WORKSPACE_NAME']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseLiveConfig(source) {
  const values = {}
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match || !required.includes(match[1]) || Object.hasOwn(values, match[1])) throw new Error('live_config_invalid')
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values[match[1]] = value
  }
  if (required.some((key) => !values[key])) throw new Error('live_config_missing')
  let url
  try { url = new URL(values.ATLAS_LIVE_SUPABASE_URL) } catch { throw new Error('live_config_invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('live_config_invalid')
  if (!uuid.test(values.ATLAS_LIVE_WORKSPACE_ID)
    || !/^DEV TEST(?:\b|\s|[-_:])/i.test(values.ATLAS_LIVE_WORKSPACE_NAME)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.ATLAS_LIVE_TEST_EMAIL)) throw new Error('live_config_invalid')
  const key = values.ATLAS_LIVE_SUPABASE_KEY
  if (key.startsWith('sb_secret_')) throw new Error('live_service_key_forbidden')
  if (!key.startsWith('sb_publishable_')) {
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'))
      if (payload.role !== 'anon') throw new Error('live_service_key_forbidden')
    } catch (error) {
      if (error.message === 'live_service_key_forbidden') throw error
      throw new Error('live_config_invalid')
    }
  }
  return { ...values, origin: url.origin }
}

export function loadLiveConfig(root) {
  let source
  try { source = readFileSync(join(root, LIVE_CONFIG_FILE), 'utf8') }
  catch { throw new Error('live_config_missing') }
  return parseLiveConfig(source)
}

export function liveTarget(config) {
  return { host: new URL(config.origin).host, workspaceId: config.ATLAS_LIVE_WORKSPACE_ID, workspaceName: config.ATLAS_LIVE_WORKSPACE_NAME }
}

export function liveChildEnv(config, baseEnv, runId) {
  return {
    ...baseEnv,
    ATLAS_LIVE_SUPABASE_URL: config.origin,
    ATLAS_LIVE_SUPABASE_KEY: config.ATLAS_LIVE_SUPABASE_KEY,
    ATLAS_LIVE_TEST_EMAIL: config.ATLAS_LIVE_TEST_EMAIL,
    ATLAS_LIVE_TEST_PASSWORD: config.ATLAS_LIVE_TEST_PASSWORD,
    ATLAS_LIVE_WORKSPACE_ID: config.ATLAS_LIVE_WORKSPACE_ID,
    ATLAS_LIVE_WORKSPACE_NAME: config.ATLAS_LIVE_WORKSPACE_NAME,
    ATLAS_LIVE_RUN_ID: runId
  }
}

export function redactLiveText(value, config) {
  let result = String(value)
  for (const secret of [config.ATLAS_LIVE_SUPABASE_KEY, config.ATLAS_LIVE_TEST_PASSWORD, config.ATLAS_LIVE_TEST_EMAIL]) {
    if (secret) result = result.replaceAll(secret, '[redacted]')
  }
  return result.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
}

export function createLiveFetch(origin, fetchImpl = globalThis.fetch) {
  return async (input, init = {}) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (target.origin !== origin || target.protocol !== 'https:') throw new Error('live_network_blocked')
    const timeout = AbortSignal.timeout(15_000)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const response = await fetchImpl(input, { ...init, redirect: 'manual', signal })
    if (response.status >= 300 && response.status < 400) throw new Error('live_network_redirect_blocked')
    return response
  }
}

export async function preflightLive(config, { fetchImpl = globalThis.fetch } = {}) {
  const client = createClient(config.origin, config.ATLAS_LIVE_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: createLiveFetch(config.origin, fetchImpl) }
  })
  try {
    const { data: signIn, error: signInError } = await client.auth.signInWithPassword({
      email: config.ATLAS_LIVE_TEST_EMAIL, password: config.ATLAS_LIVE_TEST_PASSWORD
    })
    if (signInError || !signIn.user || signIn.user.email?.toLowerCase() !== config.ATLAS_LIVE_TEST_EMAIL.toLowerCase()) throw new Error('live_auth_failed')
    const { data: profile, error: profileError } = await client.from('profiles')
      .select('id,current_workspace,role').eq('id', signIn.user.id).single()
    if (profileError || !profile || profile.current_workspace !== config.ATLAS_LIVE_WORKSPACE_ID
      || profile.role !== 'admin') throw new Error('live_workspace_mismatch')
    const { data: workspace, error: workspaceError } = await client.from('workspaces')
      .select('id,name,data_mode').eq('id', config.ATLAS_LIVE_WORKSPACE_ID).single()
    if (workspaceError || !workspace || workspace.name !== config.ATLAS_LIVE_WORKSPACE_NAME
      || !['cloud', 'hybrid'].includes(workspace.data_mode)) throw new Error('live_workspace_mismatch')
    const { data: accessible, error: accessError } = await client.from('workspaces')
      .select('id').limit(2)
    if (accessError || !Array.isArray(accessible) || accessible.length !== 1
      || accessible[0].id !== config.ATLAS_LIVE_WORKSPACE_ID) throw new Error('live_workspace_mismatch')
    const { error: crmError } = await client.schema('crm').from('sales_orders')
      .select('id').eq('workspace_id', config.ATLAS_LIVE_WORKSPACE_ID).limit(1)
    if (crmError) throw new Error('live_schema_unavailable')
    return { target: liveTarget(config), mode: workspace.data_mode, userId: signIn.user.id }
  } finally { await client.auth.signOut().catch(() => undefined) }
}
