import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isolatedChildEnv, stopChild } from './controller.mjs'
import { provisionResilience } from './resilienceProvision.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
function value(name) { const inline = args.find(arg => arg.startsWith(`${name}=`)); if (inline) return inline.slice(name.length + 1); const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const profile = value('--profile') ?? 'module'
if (!['module', 'integration', 'stress', 'entitlements', 'replay', 'e2e'].includes(profile)) throw new Error('invalid_resilience_profile')
const seed = Number(value('--seed') ?? 20261002)
const samples = Number(value('--runs') ?? value('--samples') ?? (profile === 'stress' ? 2000 : profile === 'integration' ? 100 : 100))
const maxCommands = value('--max-commands') === undefined ? undefined : Number(value('--max-commands'))
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isSafeInteger(samples) || samples < 1 || samples > 10000) throw new Error('invalid_resilience_options')
if (maxCommands !== undefined && (!Number.isSafeInteger(maxCommands) || maxCommands < 1 || maxCommands > 500)) throw new Error('invalid_resilience_options')
const boundary = value('--boundary') ?? (['integration', 'entitlements', 'e2e'].includes(profile) ? 'supabase' : 'module')
const mode = value('--mode') ?? 'cloud'
if (!['module', 'supabase'].includes(boundary) || !['cloud', 'hybrid'].includes(mode)) throw new Error('invalid_resilience_options')
const hosted = boundary === 'supabase'
const registry = JSON.parse(readFileSync(join(root, 'src/dev/testing/suites.json'), 'utf8'))['sales-order-resilience']
const requestedGroups = value('--groups')?.split(',') ?? (profile === 'entitlements' ? ['entitlements'] : profile === 'replay' ? ['generated'] : hosted ? ['generated', 'regressions', 'faults'] : ['generated', 'regressions', 'faults', 'entitlements'])
if (!requestedGroups.length || new Set(requestedGroups).size !== requestedGroups.length || requestedGroups.some(id => !registry.groups.some(group => group.id === id))) throw new Error('invalid_resilience_groups')
let provision
let code = 1
try {
  if (hosted) provision = await provisionResilience(root, { entitlements: profile === 'e2e' || requestedGroups.includes('entitlements') || requestedGroups.includes('domain-contracts'), services: requestedGroups.includes('domain-contracts'), mode })
  const actor = provision?.manifest.actors['business.admin']
  const environment = { ...isolatedChildEnv(seed, samples), SORL_PATH: value('--path') ?? '', SORL_REPLAY_PATH: value('--replay-path') ?? '', ...(maxCommands === undefined ? {} : { SORL_MAX_COMMANDS: String(maxCommands) }),
    ATLAS_LIVE_RUN_ID: provision?.manifest.runId ?? randomUUID(), ...(provision ? { SORL_MANIFEST: JSON.stringify(provision.manifest),
      ATLAS_LIVE_SUPABASE_URL: provision.manifest.url, ATLAS_LIVE_SUPABASE_KEY: provision.manifest.key,
      ATLAS_LIVE_TEST_EMAIL: actor.email, ATLAS_LIVE_TEST_PASSWORD: actor.password,
      ATLAS_LIVE_WORKSPACE_ID: actor.workspaceId, ATLAS_LIVE_WORKSPACE_NAME: actor.workspaceName,
      ATLAS_LIVE_SERVICES_ENABLED: String(requestedGroups.includes('domain-contracts')) } : {}) }
  const files = [...new Set((hosted ? registry.liveGroups : registry.groups).filter(group => requestedGroups.includes(group.id)).flatMap(group => group.files))]
  const runner = profile === 'e2e' ? ['node_modules/@playwright/test/cli.js', 'test', '--config', 'scripts/dev-testing/resilience.playwright.config.ts']
    : ['node_modules/vitest/vitest.mjs', 'run', '--config', hosted ? 'scripts/dev-testing/resilience.live.config.mts' : requestedGroups.includes('domain-contracts') ? 'scripts/dev-testing/resilience.domain.config.mts' : 'scripts/dev-testing/resilience.config.mts', '--maxWorkers', '1', ...files]
  const volume = profile === 'e2e' ? '3 journeys × desktop/mobile' : requestedGroups.includes('generated') ? `${samples} generated runs` : requestedGroups.join(', ')
  console.log(`Sales Order Resilience Lab · ${profile} · seed ${seed} · ${volume}`)
  if (profile === 'e2e') {
    const setup = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'scripts/dev-testing/resilience.live.config.mts', 'src/dev/testing/salesOrderResilience/fixtures/browserCatalog.setup.ts'], { cwd: root, env: environment, shell: false, windowsHide: true, stdio: 'inherit' })
    if (await new Promise(resolve => setup.once('close', resolve)) !== 0) throw new Error('browser_catalog_setup_failed')
  }
  const child = spawn(process.execPath, runner.map((arg, index) => index === 0 ? join(root, arg) : arg), { cwd: root, env: environment, shell: false, windowsHide: true, stdio: 'inherit' })
  process.once('SIGINT', () => stopChild(child))
  code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', result => resolve(result ?? 1)) })
} finally { if (provision) await provision.cleanup(code === 0) }
process.exitCode = code
