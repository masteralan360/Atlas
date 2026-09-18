import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isolatedChildEnv, isLocalRequest, suites, TestController, testingMiddleware, validateRunOptions } from './controller.mjs'
import AtlasTestReporter from './reporter.mjs'

const controllers = []
const directories = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function arrangeController() {
  const root = await mkdtemp(join(tmpdir(), 'atlas-runner-'))
  directories.push(root)
  const children = []
  const spawnChild = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
    children.push(child)
    return child
  })
  const controller = new TestController({ root, spawnChild, timeoutMs: 1000 })
  controllers.push(controller)
  return { controller, children, spawnChild }
}

function finishChild(child, { state = 'passed', errors = [], code = 0, finished = true } = {}) {
  const test = { id: 'test-1', name: 'scenario', file: 'allowlisted.test.ts', status: state, durationMs: 1, errors: [] }
  child.stdout.write(`ATLAS_TEST_EVENT ${JSON.stringify({ type: 'test', test })}\n`)
  if (finished) child.stdout.write(`ATLAS_TEST_EVENT ${JSON.stringify({ type: 'finished', errors })}\n`)
  child.stdout.end()
  child.stderr.end()
  child.emit('close', code)
}

const input = { suiteId: 'sale-orders', groupIds: ['matrix'], seed: 0, samples: 1 }

describe('developer runner boundaries', () => {
  it('accepts only registered suites, groups, and bounded numeric inputs', () => {
    expect(validateRunOptions(input).seed).toBe(0)
    for (const options of [null, {}, { ...input, suiteId: ['sale-orders'] }, { ...input, suiteId: '__proto__' }, { ...input, suiteId: 'toString' }, { ...input, groupIds: ['../../arbitrary'] }, { ...input, groupIds: [] }, { ...input, groupIds: ['matrix', 'matrix'] }, { ...input, seed: -1 }, { ...input, seed: 0x100000000 }, { ...input, seed: '1' }, { ...input, samples: 0 }, { ...input, samples: 101 }]) {
      expect(() => validateRunOptions(options)).toThrow()
    }
    expect(validateRunOptions({ suiteId: 'sale-orders' }).groups.length).toBe(suites['sale-orders'].groups.length)
    expect(validateRunOptions({ suiteId: 'pos' }).groups.length).toBe(10)
    expect(validateRunOptions({ suiteId: 'pos', groupIds: ['checkout', 'remote-contract'] }).groups.map((group) => group.id)).toEqual(['checkout', 'remote-contract'])
    expect(() => validateRunOptions({ suiteId: 'instant-pos' })).toThrow('invalid_suite')
  })

  it('does not pass application credentials or arbitrary Node injection settings to tests', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://production.example')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'secret')
    vi.stubEnv('NODE_OPTIONS', '--require arbitrary.js')
    const env = isolatedChildEnv(7, 8)
    expect(env.ATLAS_TEST_SEED).toBe('7')
    expect(env).not.toHaveProperty('VITE_SUPABASE_URL')
    expect(env).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY')
    expect(env).not.toHaveProperty('NODE_OPTIONS')
    vi.unstubAllEnvs()
  })

  it('rejects LAN callers, DNS rebinding, and cross-origin requests', () => {
    const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:1420' } }
    expect(isLocalRequest(local)).toBe(true)
    expect(isLocalRequest({ ...local, socket: { remoteAddress: '192.168.1.2' } })).toBe(false)
    expect(isLocalRequest({ ...local, headers: { host: 'evil.example:1420' } })).toBe(false)
    expect(isLocalRequest({ ...local, headers: { ...local.headers, origin: 'http://evil.example' } })).toBe(false)
    expect(isLocalRequest({ ...local, headers: { ...local.headers, 'sec-fetch-site': 'cross-site' } })).toBe(false)
  })

  it('requires the current session token before a mutation', async () => {
    const { controller, spawnChild } = await arrangeController()
    const req = Object.assign(Readable.from([JSON.stringify(input)]), {
      method: 'POST', url: '/__atlas-dev-testing/runs', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:1420' }
    })
    const res = { writeHead: vi.fn(), end: vi.fn() }
    await testingMiddleware(controller)(req, res, vi.fn())
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything())
    expect(spawnChild).not.toHaveBeenCalled()
  })
})

describe('developer runner execution and reports', () => {
  it('streams results, runs allowlisted files without a shell, and saves a reproducible report', async () => {
    const { controller, children, spawnChild } = await arrangeController()
    const run = controller.start(input)
    expect(() => controller.start(input)).toThrow('run_busy')
    expect(spawnChild.mock.calls[0][1]).toContain('src/dev/testing/suites/saleOrders.test.ts')
    expect(spawnChild.mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true })
    finishChild(children[0])
    await controller.completion
    expect(run.status).toBe('passed')
    expect(run.groups[0].tests[0].status).toBe('passed')
    const saved = JSON.parse(await readFile(run.reportPath, 'utf8'))
    expect(saved).toMatchObject({ seed: 0, samples: 1, status: 'passed' })
    expect(saved.unavailable).toContain('local-native')
  })

  it.each([
    { state: 'failed', code: 1 },
    { state: 'skipped' },
    { errors: ['beforeAll failed'] },
    { finished: false },
    { code: 1 }
  ])('does not turn failures, skips, or an incomplete run into a pass: %j', async (options) => {
    const { controller, children } = await arrangeController()
    const run = controller.start(input)
    finishChild(children[0], options)
    await controller.completion
    expect(run.status).toBe('failed')
  })

  it('cancels after the active group settles and never spawns remaining groups', async () => {
    const { controller, children, spawnChild } = await arrangeController()
    const run = controller.start({ ...input, groupIds: ['matrix', 'lifecycle'] })
    controller.cancel(run.id)
    expect(children[0].kill).not.toHaveBeenCalled()
    finishChild(children[0])
    await controller.completion
    expect(run.status).toBe('cancelled')
    expect(run.groups[1].status).toBe('cancelled')
    expect(spawnChild).toHaveBeenCalledTimes(1)
  })

  it('fails an empty run even when the child exits successfully', async () => {
    const { controller, children } = await arrangeController()
    const run = controller.start(input)
    children[0].stdout.write('ATLAS_TEST_EVENT {"type":"finished","errors":[]}\n')
    children[0].emit('close', 0)
    await controller.completion
    expect(run.status).toBe('failed')
  })

  it('terminates a stalled child and reports the group timeout as a failure', async () => {
    const { controller, children } = await arrangeController()
    vi.useFakeTimers()
    const run = controller.start(input)
    await vi.advanceTimersByTimeAsync(1000)
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    children[0].emit('close', 1)
    vi.useRealTimers()
    await controller.completion
    expect(run.status).toBe('failed')
    expect(run.groups[0].errors).toContain('group_timeout')
  })

  it('records nested suite hook failures even when all child tests were skipped', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const reporter = new AtlasTestReporter()
    reporter.onTestRunEnd([{ errors: () => [], children: { allSuites: () => [{ errors: () => [{ message: 'fixture failed' }] }] } }], [])
    const output = JSON.parse(write.mock.calls[0][0].slice(17))
    expect(output.errors).toContain('fixture failed')
  })
})
