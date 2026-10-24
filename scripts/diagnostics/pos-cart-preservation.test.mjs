import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import Dexie from 'dexie'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'

// Execute the real page callbacks, without booting an authenticated app. Source
// extraction lets these regressions exercise both large POS pages with zero
// browser-profile access, network traffic, or replacement implementation logic.
const root = new URL('../../', import.meta.url)
async function source(path) {
  return ts.createSourceFile(path, await readFile(new URL(path, root), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
const [instant, regular, repository] = await Promise.all([
  source('src/ui/pages/InstantPOS.tsx'), source('src/ui/pages/POS.tsx'), source('src/local-db/restaurantTables.ts'),
])
function find(tree, predicate) {
  if (predicate(tree)) return tree
  return ts.forEachChild(tree, (node) => find(node, predicate))
}
function namedFunction(tree, name) {
  const node = find(tree, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!node) throw new Error(`Missing production function ${name}`)
  return node.getText(tree).replace(/^export /, '')
}
function callback(tree, name) {
  const node = find(tree, (node) => ts.isVariableDeclaration(node) && node.name.getText(tree) === name)
  if (!node?.initializer) throw new Error(`Missing production callback ${name}`)
  return (ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer).getText(tree)
}
function evaluate(code, bindings, result) {
  const js = ts.transpileModule(`${code}\n;globalThis.result = (${result});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const context = vm.createContext({ ...bindings, console })
  vm.runInContext(js, context, { timeout: 5_000 })
  return context.result
}

let sequence = 0
let database
afterEach(async () => { await database?.delete(); database = undefined })

function ticketRows() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `ticket-${index + 1}`, workspaceId: 'isolated-cart-workspace', tableNumber: index + 1,
    number: `R-${index + 1}`, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
    version: 1, status: 'pending', isDeleted: false, syncStatus: 'synced', lastSyncedAt: null,
    items: [
      { productId: 'service-a', storageId: '__atlas_services__', quantity: 2, unitPrice: 5_000 },
      { productId: 'stock-a', storageId: 'main', quantity: 1, unitPrice: 2_000 },
    ],
  }))
}
async function persistence() {
  database = new Dexie(`pos-preservation-${++sequence}`, { indexedDB, IDBKeyRange })
  database.version(1).stores({ restaurant_pos_tickets: 'id' })
  const rows = ticketRows()
  await database.restaurant_pos_tickets.bulkPut(rows)
  const writes = []
  const savedIds = []
  const functions = evaluate([
    'saveRestaurantRow', 'saveRestaurantPosTicket', 'createRestaurantPosTicket', 'closeRestaurantPosTicket',
  ].map((name) => namedFunction(repository, name)).join('\n'), {
    db: database, now: () => new Date().toISOString(), isLocalWorkspaceMode: () => false, isOnline: () => true,
    queueRestaurantMutation: () => { throw new Error('Unexpected mutation queue write') },
    supabase: { from() { throw new Error('Unexpected network operation') } },
  }, '({ saveRestaurantPosTicket, createRestaurantPosTicket, closeRestaurantPosTicket })')
  const track = (name) => (...args) => {
    savedIds.push(args[0].id)
    const write = functions[name](...args)
    writes.push(write)
    return write
  }
  const tickets = rows.map((row) => ({ ...row, tableNumber: String(row.tableNumber) }))
  const persist = evaluate(namedFunction(instant, 'instantTicketToRestaurantTicket'), {
    user: { id: 'cashier', workspaceId: 'isolated-cart-workspace' },
    restaurantPosTickets: rows, restaurantTickets: tickets, restaurantLiveSyncEnabled: false,
    saveRestaurantPosTicket: track('saveRestaurantPosTicket'),
    createRestaurantPosTicket: track('createRestaurantPosTicket'),
    closeRestaurantPosTicket: track('closeRestaurantPosTicket'),
  }, callback(instant, 'persistRestaurantTickets'))
  return { rows, tickets, persist, savedIds, flush: () => Promise.all(writes) }
}

describe('restaurant order writes', () => {
  it('saves only the edited table and preserves independent rapid edits from the same rendered snapshot', async () => {
    const state = await persistence()
    const change = (index, quantity) => state.tickets.map((ticket, i) => i === index
      ? { ...ticket, items: ticket.items.map((item) => ({ ...item, quantity })) } : ticket)
    state.persist(change(0, 3))
    state.persist(change(1, 5))
    await state.flush()
    expect(state.savedIds).toEqual(['ticket-1', 'ticket-2'])
    expect((await database.restaurant_pos_tickets.get('ticket-1')).items[0].quantity).toBe(3)
    expect((await database.restaurant_pos_tickets.get('ticket-2')).items[0].quantity).toBe(5)
    expect(await database.restaurant_pos_tickets.get('ticket-3')).toEqual(state.rows[2])
  })

  it('still persists an explicit item removal without rewriting other tables', async () => {
    const state = await persistence()
    state.persist(state.tickets.map((ticket, index) => index === 0 ? { ...ticket, items: [] } : ticket))
    await state.flush()
    expect(state.savedIds).toEqual(['ticket-1'])
    expect((await database.restaurant_pos_tickets.get('ticket-1')).items).toEqual([])
    expect(await database.restaurant_pos_tickets.get('ticket-2')).toEqual(state.rows[1])
  })

  it('still creates and closes explicit tickets without updating unchanged tables', async () => {
    const state = await persistence()
    state.persist([{ ...state.tickets[0], id: 'ticket-new', tableNumber: '13' }, ...state.tickets.slice(1)])
    await state.flush()
    expect(state.savedIds).toEqual(['ticket-new', 'ticket-1'])
    expect((await database.restaurant_pos_tickets.get('ticket-1')).isDeleted).toBe(true)
    expect((await database.restaurant_pos_tickets.get('ticket-new')).items).toEqual(state.rows[0].items)
    expect(await database.restaurant_pos_tickets.get('ticket-2')).toEqual(state.rows[1])
  })
})

function permissionEffects(tree, componentName) {
  const component = find(tree, (node) => ts.isFunctionDeclaration(node) && node.name?.text === componentName)
  return component.body.statements.filter(ts.isExpressionStatement).map((statement) => statement.expression)
    .filter((call) => ts.isCallExpression(call) && call.expression.getText(tree) === 'useEffect')
    .filter((call) => /\b(canSelectServiceId|serviceAccessReady|canSelectProduct|storageAccess)\b/.test(call.getText(tree)))
    .map((call) => call.getText(tree)).join('\n')
}

describe('permission changes preserve active and held orders', () => {
  it.each([
    ['loading', false, false], ['request failed', false, true], ['offline staff', false, true],
    ['successful denial or revoked access', true, true], ['storage boundary unresolved', true, false],
  ])('%s never removes or persists lines from any cart', async (_label, serviceAccessReady, storageReady) => {
    const state = await persistence()
    let localTickets = structuredClone(state.tickets)
    let cart = state.rows[0].items.map((item) => ({ ...item, product_id: item.productId }))
    let heldSales = state.rows.map((row) => ({ ...row, items: structuredClone(cart) }))
    const before = structuredClone({ localTickets, cart, heldSales })
    const bindings = {
      useEffect: (effect) => effect(), serviceAccessReady,
      storageAccess: { isReady: storageReady, canAccessStorage: () => false },
      canSelectServiceId: () => false, canSelectProduct: () => false,
      products: [{ id: 'stock-a' }], ticketProducts: [{ id: 'stock-a' }],
      SERVICES_VIRTUAL_STORAGE_ID: '__atlas_services__', ACTIVITIES_STORAGE_ID: '__atlas_activities__',
      selectedStorageId: 'main', restaurantTickets: state.tickets, cart, heldSales,
      persistRestaurantTickets: state.persist,
      setLocalTickets: (next) => { localTickets = typeof next === 'function' ? next(localTickets) : next },
      setCart: (next) => { cart = typeof next === 'function' ? next(cart) : next },
      setHeldSales: (next) => { heldSales = typeof next === 'function' ? next(heldSales) : next },
      t: (key) => key, toast: () => undefined,
    }
    for (const restaurantMode of [true, false]) {
      evaluate(permissionEffects(instant, 'InstantPOS'), { ...bindings, restaurantMode }, 'null')
    }
    evaluate(permissionEffects(regular, 'POS'), bindings, 'null')
    await state.flush()
    database.close()
    await database.open()
    expect((await database.restaurant_pos_tickets.toArray()).sort((a, b) => a.tableNumber - b.tableNumber)).toEqual(state.rows)
    expect({ localTickets, cart, heldSales }).toEqual(before)
    expect(state.savedIds).toEqual([])
  })
})

describe('retained service lines still require authorization at checkout', () => {
  it.each([false, true])('blocks service checkout with ready=%s and no granted access', async (serviceAccessReady) => {
    const state = await persistence()
    const messages = []
    let loading = false
    const bindings = {
      user: { id: 'cashier', workspaceId: 'isolated-cart-workspace' },
      SERVICES_VIRTUAL_STORAGE_ID: '__atlas_services__',
      serviceAccessReady, canSelectServiceId: () => false,
      t: (key) => key, toast: (message) => messages.push(message),
    }
    const instantCheckout = evaluate('', {
      ...bindings, activeTicket: state.tickets[0], isCheckoutLoading: false, isLocalMode: false,
      setIsCheckoutPaymentAccountSelectorOpen: () => undefined,
      setIsCheckoutLoading: (value) => { loading = value },
    }, callback(instant, 'confirmCheckoutTicket'))
    await instantCheckout()
    expect(loading).toBe(false)
    expect(messages.pop().description).toBe('services.access.serviceUnavailable')

    const regularCheckout = evaluate('', {
      ...bindings, checkoutSubmissionInProgress: { current: false }, isLoading: false,
      cart: state.rows[0].items.map((item) => ({ ...item, product_id: item.productId })),
      getCartMinimumPriceViolation: () => null,
      setIsLoading: (value) => { loading = value },
      unavailableServiceCartItem: { product_id: 'service-a' },
    }, callback(regular, 'handleCheckout'))
    await regularCheckout()
    expect(loading).toBe(false)
    expect(messages.pop().description).toBe('services.access.serviceUnavailable')
    expect(await database.restaurant_pos_tickets.get('ticket-1')).toEqual(state.rows[0])
    expect(state.savedIds).toEqual([])
  })
})
