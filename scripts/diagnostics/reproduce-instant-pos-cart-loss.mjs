// Investigation reproducer for v0.16.9. This intentionally confirms the defect;
// it is not a regression test asserting the behavior that Atlas should retain.
// Defaults to that historical release; the fixed checkout has no cleanup effect.
// Runs exact source slices with injected network/React boundaries and a disposable
// in-memory IndexedDB. It cannot open the app's database or contact Supabase.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import vm from 'node:vm'
import { transform } from 'esbuild'
import Dexie from 'dexie'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'

const root = new URL('../../', import.meta.url)
const reference = process.argv.find((arg) => arg.startsWith('--ref='))?.slice('--ref='.length) ?? '2ed18604'
const compareReference = process.argv.find((arg) => arg.startsWith('--compare-ref='))?.slice('--compare-ref='.length)
const run = promisify(execFile)
const read = async (path) => {
  const source = reference
    ? (await run('git', ['show', `${reference}:${path}`], { cwd: fileURLToPath(root), maxBuffer: 4 * 1024 * 1024 })).stdout
    : await readFile(new URL(path, root), 'utf8')
  return source.replace(/\r\n/g, '\n')
}
const [accessSource, posSource, repositorySource, selectionSource, storageSource] = await Promise.all([
  read('src/local-db/serviceAccess.ts'),
  read('src/ui/pages/InstantPOS.tsx'),
  read('src/local-db/restaurantTables.ts'),
  read('src/local-db/businessPartners.ts'),
  read('src/local-db/storagePermissions.ts'),
])

function slice(source, start, end) {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first + start.length)
  assert(first >= 0 && last > first, `Source markers changed: ${start}`)
  return source.slice(first, last).replace(/^export /gm, '')
}

async function evaluate(source, bindings, result) {
  const { code } = await transform(`${source}\n;globalThis.__result = (${result});`, { loader: 'ts' })
  const context = vm.createContext({ ...bindings, console })
  vm.runInContext(code, context, { timeout: 5_000 })
  return context.__result
}

const hookSource = slice(accessSource, 'export function useServiceAccessIds(', 'export async function listServiceAccessCategories(')
const servicePredicateSource = slice(selectionSource, '  const canSelectServiceId = useCallback(', '  const inventoryLoading =')
const cleanupSource = slice(posSource, '    useEffect(() => {\n        if (!serviceAccessReady', '    const activeTicketTotals =')
const persistenceSource = slice(posSource, '    const persistRestaurantTickets = useCallback(', '    const setTickets = useCallback(')
const conversionSource = slice(posSource, 'function instantTicketToRestaurantTicket(', 'const STATUS_FLOW:')
const saveSource = slice(repositorySource, 'async function saveRestaurantRow<', 'export async function saveRestaurantTableSettings(')
const wrapperSource = slice(repositorySource, 'export async function saveRestaurantPosTicket(', 'export async function closeRestaurantPosTicket(')
const storageFilterSource = slice(storageSource, 'export function filterProductsByStorageAccess<', 'function roundVisibleAmount(')
const storagePredicateSource = slice(storageSource, 'export function canAccessStorage(', '/**')
const results = []

async function hookHarness({ role = 'staff', online = true, failInitially = false } = {}) {
  let state
  let effect
  let interval
  let fail = failInitially
  const requests = []
  const useServiceAccessIds = await evaluate(hookSource, {
    useState(initial) {
      if (state === undefined) state = initial()
      return [state, (next) => { state = typeof next === 'function' ? next(state) : next }]
    },
    useEffect(callback) { effect = callback },
    useNetworkStatus: () => online,
    getActiveBusinessWorkspaceId: () => 'investigation-workspace',
    getActiveBusinessUserRole: () => role,
    getAccessCacheKey: () => `investigation-workspace:${role}`,
    isLocalWorkspaceMode: () => false,
    isOnline: () => online,
    async fetchAccessibleServiceIds(_workspaceId, forceRefresh) {
      requests.push({ forceRefresh: Boolean(forceRefresh) })
      if (fail) throw new Error('Simulated permission request failure')
      return new Set(['service-a'])
    },
    ACCESS_ID_CACHE_MS: 10_000,
    ACCESS_REFRESH_EVENT: 'atlas:service-access-invalidated',
    window: {
      setInterval(callback) { interval = callback; return 1 },
      clearInterval() {}, addEventListener() {}, removeEventListener() {},
    },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  }, 'useServiceAccessIds')
  const render = () => useServiceAccessIds('investigation-workspace')
  render()
  const unmount = effect()
  await new Promise(setImmediate)
  return {
    render, requests, unmount,
    async failPeriodicRefresh() {
      fail = true
      assert.equal(typeof interval, 'function')
      interval()
      await new Promise(setImmediate)
      return render()
    },
  }
}

function tickets(serviceOnly = true) {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `investigation-ticket-${index + 1}`,
    workspaceId: 'investigation-workspace', tableNumber: index + 1,
    number: `R-${index + 1}`, createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    status: 'pending', version: 1, isDeleted: false, syncStatus: 'synced', lastSyncedAt: null,
    items: [
      { productId: 'service-a', storageId: '__atlas_services__', quantity: 2, unitPrice: 5_000 },
      ...serviceOnly ? [] : [{ productId: 'stock-a', storageId: 'main', quantity: 1, unitPrice: 2_000 }],
    ],
  }))
}

async function runCleanup(label, serviceAccess, { serviceOnly = true, excludedStock = false, storageReady = true, cleanupOverride = cleanupSource } = {}) {
  const database = new Dexie(`atlas-cart-loss-investigation-${results.length}`, { indexedDB, IDBKeyRange })
  database.version(1).stores({ restaurant_pos_tickets: 'id' })
  const rows = tickets(serviceOnly)
  await database.restaurant_pos_tickets.bulkPut(rows)
  const pending = []
  let remoteCalls = 0
  let queueCalls = 0
  try {
    const save = await evaluate(`${saveSource}\n${wrapperSource}`, {
      db: database, now: () => new Date().toISOString(),
      isLocalWorkspaceMode: () => false, isOnline: () => true,
      queueRestaurantMutation: async () => { queueCalls++ },
      supabase: { from() { remoteCalls++; throw new Error('Unexpected network operation') } },
    }, 'saveRestaurantPosTicket')
    const persist = await evaluate(`${conversionSource}\n${persistenceSource}`, {
      user: { workspaceId: 'investigation-workspace', id: 'cashier' },
      useCallback: (fn) => fn, restaurantPosTickets: rows, restaurantLiveSyncEnabled: false,
      saveRestaurantPosTicket(row, live) {
        const request = save(row, live)
        pending.push(request)
        return request
      },
      createRestaurantPosTicket: () => { throw new Error('Unexpected ticket creation') },
      closeRestaurantPosTicket: () => { throw new Error('Unexpected ticket closure') },
      refreshRestaurantPosTicketsFromSupabase: () => { throw new Error('Unexpected remote refresh') },
    }, 'persistRestaurantTickets')
    const canSelectServiceId = await evaluate(servicePredicateSource, {
      useCallback: (fn) => fn, serviceAccess,
    }, 'canSelectServiceId')
    let effect
    await evaluate(cleanupOverride, {
      useEffect: (callback) => { effect = callback },
      serviceAccessReady: serviceAccess.isReady,
      storageAccess: { isReady: storageReady, canAccessStorage: () => true },
      products: excludedStock ? [{ id: 'stock-a' }] : [],
      ticketProducts: excludedStock ? [{ id: 'stock-a' }] : [],
      canSelectProduct: () => !excludedStock, canSelectServiceId,
      SERVICES_VIRTUAL_STORAGE_ID: '__atlas_services__',
      selectedStorageId: 'main', restaurantMode: true, restaurantTickets: rows,
      persistRestaurantTickets: persist,
      setLocalTickets: () => { throw new Error('Wrong cart store') },
    }, 'null')
    effect()
    await Promise.all(pending)
    database.close()
    await database.open()
    const saved = await database.restaurant_pos_tickets.toArray()
    const result = {
      scenario: label, tables: saved.length, savedWrites: pending.length,
      emptyCartsAfterReopen: saved.filter((row) => row.items.length === 0).length,
      firstTableTotal: saved[0].items.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0),
      allStillPending: saved.every((row) => row.status === 'pending' && !row.isDeleted),
      remoteCalls, queueCalls,
    }
    results.push(result)
    assert.equal(remoteCalls, 0)
    assert.equal(queueCalls, 0)
    return result
  } finally {
    await database.delete()
  }
}

const onlineStaff = await hookHarness()
assert.equal(onlineStaff.render().ids.has('service-a'), true)
const failedPeriodic = await onlineStaff.failPeriodicRefresh()
assert.equal(failedPeriodic.isReady, true)
assert.equal(failedPeriodic.ids.size, 0)
assert.equal((await runCleanup('Staff: successful lookup, then failed periodic refresh', failedPeriodic)).emptyCartsAfterReopen, 12)
assert.equal((await runCleanup('Mixed carts: failure removes services, preserves stock', failedPeriodic, { serviceOnly: false })).firstTableTotal, 2_000)
onlineStaff.unmount?.()

const onlineAdmin = await hookHarness({ role: 'admin', failInitially: true })
assert.equal((await runCleanup('Admin: online permission request fails', onlineAdmin.render())).emptyCartsAfterReopen, 12)
onlineAdmin.unmount?.()

const offlineStaff = await hookHarness({ online: false })
assert.equal((await runCleanup('Staff: Cloud/Hybrid workspace offline, ticket live sync off', offlineStaff.render())).emptyCartsAfterReopen, 12)
assert.equal(offlineStaff.requests.length, 0)

const offlineAdmin = await hookHarness({ role: 'admin', online: false })
assert.equal((await runCleanup('Control: offline admin bypass', offlineAdmin.render())).emptyCartsAfterReopen, 0)
assert.equal((await runCleanup('Control: successful service lookup', { ids: new Set(['service-a']), isReady: true })).savedWrites, 0)
assert.equal((await runCleanup('Control: permission lookup still loading', { ids: new Set(), isReady: false })).savedWrites, 0)
assert.equal((await runCleanup('Control: storage boundary unresolved', failedPeriodic, { storageReady: false })).savedWrites, 0)
assert.equal((await runCleanup('Separate stock risk: category exclusion rewrites shared carts', { ids: new Set(['service-a']), isReady: true }, { serviceOnly: false, excludedStock: true })).firstTableTotal, 10_000)

if (compareReference) {
  const priorSource = (await run('git', ['show', `${compareReference}:src/ui/pages/InstantPOS.tsx`], {
    cwd: fileURLToPath(root), maxBuffer: 4 * 1024 * 1024,
  })).stdout.replace(/\r\n/g, '\n')
  const priorCleanup = slice(priorSource, '    useEffect(() => {\n        if (!serviceAccessReady', '    const activeTicketTotals =')
  const prior = await runCleanup(`Historical control: ${compareReference} cleanup, same failed permission snapshot`, failedPeriodic, { cleanupOverride: priorCleanup })
  assert.equal(prior.savedWrites, 0)
  assert.equal(prior.emptyCartsAfterReopen, 0)
}

const storageFilter = await evaluate(`${storagePredicateSource}\n${storageFilterSource}`, {}, 'filterProductsByStorageAccess')
const legacyProduct = { id: 'stock-a', storageId: 'main', quantity: 1 }
const staffAccess = { isAdmin: false, isReady: true, excludedStorageIds: new Set(['restricted']) }
const stock = [
  { productId: 'stock-a', storageId: 'main', quantity: 1 },
  { productId: 'stock-a', storageId: 'restricted', quantity: 1 },
]
assert.equal(storageFilter([legacyProduct], stock, staffAccess).length, 0)
assert.equal(storageFilter([legacyProduct], [], staffAccess).length, 1)
results.push({ scenario: 'Separate stock risk: legacy product allowed before inventory load, denied after restricted position loads', beforeLoad: 'selectable', afterLoad: 'excluded' })

console.log(JSON.stringify({
  sourceRoot: fileURLToPath(root),
  sourceReference: reference ?? 'current checkout',
  mode: 'Investigation only: exact source slices, injected React/network boundaries, disposable fake IndexedDB',
  results,
}, null, 2))
