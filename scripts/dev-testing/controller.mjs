import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveChildEnv, loadLiveConfig, preflightLive, redactLiveText } from './live.mjs'

const registryUrl = new URL('../../src/dev/testing/suites.json', import.meta.url)
export const suites = JSON.parse(readFileSync(registryUrl, 'utf8'))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PREFIX = '/__atlas-dev-testing'

function stopChild(child) {
  if (!child) return
  // On Windows, killing just the Vitest parent can strand its worker forks.
  // Target only the PID created by this controller, including its descendants.
  if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore'
    })
    killer.once('error', () => child.kill('SIGTERM'))
    killer.once('close', (code) => { if (code !== 0) child.kill('SIGTERM') })
  } else child.kill('SIGTERM')
}

export function validateRunOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_options')
  const suite = typeof input.suiteId === 'string' && Object.hasOwn(suites, input.suiteId) && suites[input.suiteId]
  if (!suite) throw new Error('invalid_suite')
  const environment = input.environment ?? 'isolated'
  if (!['isolated', 'hosted-supabase'].includes(environment)) throw new Error('invalid_options')
  const availableGroups = environment === 'isolated' ? suite.groups : suite.liveGroups ?? []
  if (!availableGroups.length) throw new Error('live_suite_unavailable')
  const groups = input.groupIds ?? availableGroups.map((group) => group.id)
  if (!Array.isArray(groups) || !groups.length || groups.length > availableGroups.length
    || groups.some((id) => typeof id !== 'string' || !availableGroups.some((group) => group.id === id))
    || new Set(groups).size !== groups.length) throw new Error('invalid_groups')
  const seed = input.seed ?? 20260918
  const samples = input.samples ?? 16
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
    || !Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error('invalid_options')
  return { suiteId: input.suiteId, environment, groups: availableGroups.filter((group) => groups.includes(group.id)), seed, samples }
}

export function isolatedChildEnv(seed, samples) {
  // Do not inherit credentials, NODE_OPTIONS, or VITE_* settings from the developer app.
  const env = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return { ...env, NODE_ENV: 'test', FORCE_COLOR: '0', ATLAS_TEST_SEED: String(seed), ATLAS_TEST_SAMPLES: String(samples) }
}

export function isLocalRequest(req) {
  const address = req.socket.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false
  try {
    const host = new URL(`http://${req.headers.host}`)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false
    if (req.headers.origin && new URL(req.headers.origin).host !== host.host) return false
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false
    return true
  } catch { return false }
}

export class TestController {
  constructor({ root = ROOT, spawnChild = spawn, preflight = preflightLive, timeoutMs = 180_000, onGroupResult = () => {} } = {}) {
    this.root = root
    this.spawnChild = spawnChild
    this.preflight = preflight
    this.timeoutMs = timeoutMs
    this.onGroupResult = onGroupResult
    this.token = randomBytes(32).toString('hex')
    this.run = null
    this.child = null
    this.disposed = false
    this.preflighting = false
    this.completion = Promise.resolve()
  }

  start(input) {
    if (this.disposed) throw new Error('runner_closed')
    if (this.run?.status === 'running' || this.preflighting) throw new Error('run_busy')
    const options = validateRunOptions(input)
    if (options.environment !== 'isolated') throw new Error('live_preflight_required')
    return this.startValidated(options)
  }

  async startLive(input) {
    if (this.disposed) throw new Error('runner_closed')
    if (this.run?.status === 'running' || this.preflighting) throw new Error('run_busy')
    const options = validateRunOptions(input)
    if (options.environment !== 'hosted-supabase') throw new Error('invalid_options')
    this.preflighting = true
    try {
      const config = loadLiveConfig(this.root)
      let readiness
      try { readiness = await this.preflight(config, { suiteId: options.suiteId }) }
      catch (error) { throw new Error(String(error.message || error).startsWith('live_') ? error.message : 'live_preflight_failed') }
      if (this.disposed) throw new Error('runner_closed')
      return this.startValidated(options, { config, readiness })
    } finally { this.preflighting = false }
  }

  async liveReadiness(suiteId = 'sale-orders') {
    try {
      if (!suites[suiteId]?.liveGroups?.length) throw new Error('live_suite_unavailable')
      const config = loadLiveConfig(this.root)
      const readiness = await this.preflight(config, { suiteId })
      return { status: 'ready', target: readiness.target, mode: readiness.mode }
    } catch (error) {
      return { status: 'blocked', reason: String(error.message || error).startsWith('live_') ? error.message : 'live_preflight_failed' }
    }
  }

  startValidated(options, live = null) {
    this.run = {
      id: randomUUID(), suiteId: options.suiteId, environment: options.environment,
      ...(live ? { target: live.readiness.target, mode: live.readiness.mode } : {}),
      seed: options.seed, samples: options.samples,
      startedAt: new Date().toISOString(), status: 'running', cancelRequested: false,
      fixtures: [],
      groups: options.groups.map((group) => ({ id: group.id, status: 'pending', tests: [], errors: [] })),
      unavailable: suites[options.suiteId].unavailable
    }
    const run = this.run
    this.completion = this.execute(run, options, live).catch((error) => {
      run.status = 'failed'
      run.finishedAt = new Date().toISOString()
      run.groups[0].errors.push(live ? redactLiveText(error.message || error, live.config) : String(error.message || error))
    })
    return run
  }

  cancel(id) {
    if (this.run?.id !== id) throw new Error('run_not_found')
    if (this.run.status === 'running') this.run.cancelRequested = true
    return this.run
  }

  async execute(run, options, live) {
    for (const group of options.groups) {
      const result = run.groups.find((row) => row.id === group.id)
      if (run.cancelRequested || this.disposed) { result.status = 'cancelled'; continue }
      if (live && group.isolatedGroupId) {
        const isolatedGroup = suites[options.suiteId].groups.find((row) => row.id === group.isolatedGroupId)
        if (!isolatedGroup) {
          result.status = 'failed'
          result.errors.push('invalid_isolated_group')
          this.onGroupResult(result)
          continue
        }
        await this.executeGroup(run, isolatedGroup, result, null)
        if (run.cancelRequested || this.disposed) {
          result.status = 'cancelled'
          this.onGroupResult(result)
          continue
        }
      }
      // A hosted selection can include a local-only group. Preserve the isolated
      // labels and result instead of running an empty live child or implying a
      // database assertion that the group does not have.
      if (live && group.isolatedOnly) {
        this.onGroupResult(result)
        continue
      }
      if (live) {
        try { await this.preflight(live.config, { suiteId: options.suiteId }) }
        catch (error) {
          result.status = 'failed'
          result.errors.push(String(error.message || error).startsWith('live_') ? error.message : 'live_preflight_failed')
          this.onGroupResult(result)
          continue
        }
      }
      await this.executeGroup(run, group, result, live)
      this.onGroupResult(result)
    }
    run.status = run.cancelRequested || this.disposed ? 'cancelled'
      : run.groups.some((group) => group.status === 'failed') ? 'failed' : 'passed'
    run.finishedAt = new Date().toISOString()
    const directory = join(this.root, '.atlas-test-runs', run.id)
    try {
      await mkdir(directory, { recursive: true })
      run.reportPath = join(directory, 'report.json')
      await writeFile(run.reportPath, JSON.stringify(run, null, 2))
    } catch {
      run.groups[0].errors.push('report_write_failed')
      run.status = 'failed'
      delete run.reportPath
    }
  }

  executeGroup(run, group, result, live) {
    result.status = 'running'
    return new Promise((resolve) => {
      let stderr = ''
      let finished = false
      let timedOut = false
      let settled = false
      let child
      const finish = (code, error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        const sanitize = (value) => live ? redactLiveText(value, live.config) : String(value)
        if (error) result.errors.push(sanitize(error.message || error).slice(0, 4000))
        if (timedOut) result.errors.push('group_timeout')
        if (!finished) result.errors.push('runner_did_not_finish')
        if (code !== 0 && stderr) result.errors.push(sanitize(stderr).slice(-8000))
        for (const test of result.tests) {
          if (test.status === 'pending' || test.status === 'running') test.status = 'cancelled'
        }
        result.status = code === 0 && finished && !result.errors.length && result.tests.length > 0
          && result.tests.every((test) => test.status === 'passed') ? 'passed' : 'failed'
        resolve()
      }
      const timer = setTimeout(() => { timedOut = true; stopChild(child) }, live ? Math.max(this.timeoutMs, 900_000) : this.timeoutMs)
      try {
        child = this.spawnChild(process.execPath, [
          join(this.root, 'node_modules/vitest/vitest.mjs'), 'run',
          '--config', join(this.root, live ? 'scripts/dev-testing/vitest.live.config.mts' : 'scripts/dev-testing/vitest.config.mts'),
          '--reporter', join(this.root, 'scripts/dev-testing/reporter.mjs'),
          '--maxWorkers', '1', ...group.files
        ], { cwd: this.root, env: live
          ? liveChildEnv(live.config, isolatedChildEnv(run.seed, run.samples), run.id)
          : isolatedChildEnv(run.seed, run.samples), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        this.child = child
        createInterface({ input: child.stdout }).on('line', (line) => {
          if (!line.startsWith('ATLAS_TEST_EVENT ')) return
          try {
            const event = JSON.parse(line.slice(17))
            if (live && event.type === 'fixture') {
              const fixture = event.fixture
              if (fixture?.runId === run.id && fixture?.workspaceId === run.target.workspaceId
                && Object.values(fixture).every((value) => value === null || typeof value === 'string')) {
                run.fixtures.push(fixture)
              } else result.errors.push('invalid_fixture_event')
            }
            if (event.type === 'finished') { finished = true; result.errors.push(...event.errors.map((value) => live ? redactLiveText(value, live.config) : value)) }
            for (const test of event.tests ?? (event.test ? [event.test] : [])) {
              if (live) {
                test.name = redactLiveText(test.name, live.config)
                test.errors = test.errors.map((value) => redactLiveText(value, live.config))
              }
              test.id = `${live ? 'hosted-supabase' : 'isolated'}:${test.id}`
              test.environment = live ? 'hosted-supabase' : 'isolated'
              const index = result.tests.findIndex((row) => row.id === test.id)
              if (index === -1) result.tests.push(test)
              else result.tests[index] = test
            }
          } catch { result.errors.push('invalid_runner_event') }
        })
        child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-12_000) })
        child.once('error', (error) => finish(1, error))
        child.once('close', (code) => finish(code))
      } catch (error) { finish(1, error) }
    })
  }

  dispose() {
    this.disposed = true
    if (this.run?.status === 'running') this.run.cancelRequested = true
    stopChild(this.child)
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 4096) throw new Error('invalid_options')
  }
  return JSON.parse(body)
}

export function testingMiddleware(controller) {
  return async (req, res, next) => {
    const path = req.url?.split('?')[0]
    if (!path?.startsWith(PREFIX)) return next()
    if (!isLocalRequest(req)) return json(res, 403, { error: 'local_only' })
    if (req.method === 'GET' && path === `${PREFIX}/session`) {
      return json(res, 200, { token: controller.token, suites, run: controller.run })
    }
    if (req.headers['x-atlas-test-token'] !== controller.token) return json(res, 403, { error: 'invalid_session' })
    try {
      if (req.method === 'POST' && path === `${PREFIX}/runs`) return json(res, 202, controller.start(await readBody(req)))
      if (req.method === 'POST' && path === `${PREFIX}/live-runs`) return json(res, 202, await controller.startLive(await readBody(req)))
      if (req.method === 'GET' && path === `${PREFIX}/live-readiness`) {
        const suiteId = new URL(req.url, 'http://localhost').searchParams.get('suite') ?? 'sale-orders'
        return json(res, 200, await controller.liveReadiness(suiteId))
      }
      if (req.method === 'GET' && path === `${PREFIX}/run`) return json(res, 200, controller.run)
      if (req.method === 'POST' && path === `${PREFIX}/cancel`) return json(res, 200, controller.cancel((await readBody(req)).id))
      return json(res, 404, { error: 'not_found' })
    } catch (error) { return json(res, error.message === 'run_busy' ? 409 : 400, { error: error.message }) }
  }
}

export function atlasDevTestingPlugin(enabled) {
  return {
    name: 'atlas-dev-testing', apply: 'serve',
    configureServer(server) {
      if (!enabled) return
      // The registry is read with fs, so include it in Vite's watched inputs.
      const latestSuites = JSON.parse(readFileSync(registryUrl, 'utf8'))
      for (const key of Object.keys(suites)) delete suites[key]
      Object.assign(suites, latestSuites)
      const registryPath = fileURLToPath(registryUrl)
      const registryChanged = (path) => { if (path.replaceAll('\\', '/') === registryPath.replaceAll('\\', '/')) void server.restart() }
      server.watcher.add(registryPath)
      server.watcher.on('change', registryChanged)
      const controller = new TestController({ root: server.config.root })
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== `${PREFIX}/preview`) return next()
        if (!isLocalRequest(req)) return json(res, 403, { error: 'local_only' })
        try {
          const html = await server.transformIndexHtml(req.url, '<!doctype html><html class="theme-modern light"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/src/dev/testing/preview.tsx"></script></body></html>')
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
          res.end(html)
        } catch (error) { next(error) }
      })
      server.middlewares.use(testingMiddleware(controller))
      server.httpServer?.once('close', () => { controller.dispose(); server.watcher.off('change', registryChanged) })
    }
  }
}
