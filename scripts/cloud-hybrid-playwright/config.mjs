import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ENV_FILE = '.env.atlas-live-playwright-tests.local'

function parseEnv(contents) {
  const values = new Map()
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values.set(match[1], value)
  }
  return values
}

export function loadLiveTestConfiguration(root = process.cwd()) {
  const path = resolve(root, ENV_FILE)
  let fileValues
  try {
    fileValues = parseEnv(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${ENV_FILE} is missing or unreadable.`)
  }
  // This standalone environment is intentionally bound to its own dedicated
  // live-test file; other shell variables must not redirect or fill it.
  const value = (name) => fileValues.get(name) ?? ''
  const config = {
    supabaseUrl: value('ATLAS_LIVE_SUPABASE_URL'),
    supabaseKey: value('ATLAS_LIVE_SUPABASE_KEY'),
    email: value('ATLAS_LIVE_TEST_EMAIL'),
    password: value('ATLAS_LIVE_TEST_PASSWORD'),
    workspaceId: value('ATLAS_LIVE_WORKSPACE_ID'),
    configuredWorkspaceName: value('ATLAS_LIVE_WORKSPACE_NAME'),
    envFilePath: path
  }
  const missing = Object.entries(config)
    .filter(([key, item]) => key !== 'configuredWorkspaceName' && key !== 'envFilePath' && !item)
    .map(([key]) => key)
  if (missing.length) throw new Error(`${ENV_FILE} is missing required settings: ${missing.join(', ')}.`)
  try {
    const url = new URL(config.supabaseUrl)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('Supabase URL must use HTTPS.')
    }
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${ENV_FILE} contains an invalid Supabase URL.`)
    throw error
  }
  return config
}

export function safeConfigurationSummary(config, workspace) {
  return {
    workspaceName: workspace.name,
    mode: workspace.data_mode,
    supabaseHost: new URL(config.supabaseUrl).host,
    workspaceId: workspace.id,
    account: 'configured live-test account'
  }
}
