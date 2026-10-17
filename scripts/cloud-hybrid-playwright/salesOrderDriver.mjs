import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

const REQUIRED_WORKSPACE_FEATURE_FLAGS = Object.freeze([
  'orders',
  'crm',
  'products',
  'storages',
  'services',
  'loans'
])

export function isReadyForSalesOrderApplicationSnapshot(snapshot, { workspaceId, userId }) {
  const workspace = snapshot?.workspace
  return Boolean(
    workspace
    && workspace.id === workspaceId
    && snapshot.activeWorkspaceId === workspaceId
    && snapshot.activeUserId === userId
    && typeof workspace.data_mode === 'string'
    && typeof workspace.is_configured === 'boolean'
    && typeof workspace.locked_workspace === 'boolean'
    && REQUIRED_WORKSPACE_FEATURE_FLAGS.every((key) => typeof workspace[key] === 'boolean')
  )
}

function applicationSnapshotReadinessIssue(snapshot, target) {
  if (!snapshot) return 'no application snapshot was returned'
  if (snapshot.readError) return `the application snapshot could not be read: ${safeText(snapshot.readError)}`
  if (!snapshot.workspace) return 'the workspace feature row is not available in the application cache yet'
  if (snapshot.workspace.id !== target.workspaceId) return 'the application cache returned a different workspace'
  if (snapshot.activeWorkspaceId !== target.workspaceId || snapshot.activeUserId !== target.userId) {
    return 'the verified workspace and authenticated user are not both active in the application yet'
  }
  if (typeof snapshot.workspace.data_mode !== 'string'
    || typeof snapshot.workspace.is_configured !== 'boolean'
    || typeof snapshot.workspace.locked_workspace !== 'boolean') {
    return 'the workspace mode or testing configuration is still loading'
  }
  const missingFlags = REQUIRED_WORKSPACE_FEATURE_FLAGS.filter((key) => typeof snapshot.workspace[key] !== 'boolean')
  if (missingFlags.length) return `workspace feature flags are still loading: ${missingFlags.join(', ')}`
  return 'the application workspace snapshot is not ready'
}

function equalNumber(actual, expected, label, tolerance = 0.000001) {
  ensure(Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}.`)
}

function safeText(value, secrets = []) {
  let text = String(value ?? '')
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]')
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-token]')
    .replace(/(?:access_token|refresh_token|token|apikey|api_key|password)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [redacted]')
    .slice(0, 1200)
}

function itemValue(item, ...keys) {
  for (const key of keys) if (item?.[key] !== undefined) return item[key]
  return undefined
}

export function assertPersistedServiceDraft(order, { businessPartnerId, customerId, storageId, expectedLines }) {
  ensure(order?.status === 'draft', `Expected an unpaid draft, received status ${order?.status}.`)
  ensure(itemValue(order, 'is_paid', 'isPaid') !== true, 'A service draft unexpectedly persisted as paid.')
  ensure(itemValue(order, 'business_partner_id', 'businessPartnerId') === businessPartnerId,
    'The saved service draft does not reference the run-owned business partner.')
  ensure(itemValue(order, 'customer_id', 'customerId') === customerId,
    'The saved service draft does not reference the run-owned customer facet.')
  const items = Array.isArray(order.items) ? order.items : []
  ensure(items.length === expectedLines.length, `Expected ${expectedLines.length} persisted order lines, received ${items.length}.`)
  const expectedTotal = expectedLines.reduce((sum, expected) => sum + expected.quantity * expected.unitPrice, 0)
  for (const expected of expectedLines) {
    const matches = items.filter((line) => itemValue(line, 'productId', 'product_id') === expected.productId)
    ensure(matches.length === 1, `Expected exactly one persisted line for run-owned ${expected.isService ? 'service' : 'product'} ${expected.productId}.`)
    const line = matches[0]
    equalNumber(itemValue(line, 'quantity', 'qty'), expected.quantity, 'persisted line quantity')
    equalNumber(itemValue(line, 'convertedUnitPrice', 'converted_unit_price'), expected.unitPrice, 'persisted converted unit price')
    equalNumber(itemValue(line, 'lineTotal', 'line_total'), expected.quantity * expected.unitPrice, 'persisted line total')
    const persistedStorageId = itemValue(line, 'storageId', 'storage_id') ?? null
    if (expected.isService) {
      ensure(persistedStorageId === null, 'The service line persisted a physical or virtual storage reference.')
    } else {
      ensure(persistedStorageId === storageId, 'The physical product line does not reference the run-selected storage.')
    }
  }
  equalNumber(order.total, expectedTotal, 'persisted service-order total')
  return items
}

export class SalesOrderHybridDriver {
  constructor({ baseUrl, email, password, expectedSupabaseHost, diagnosticSecrets = [], artifactDirectory, onDiagnostic }) {
    this.baseUrl = baseUrl
    this.email = email
    this.password = password
    this.expectedSupabaseHost = expectedSupabaseHost
    this.diagnosticSecrets = diagnosticSecrets.filter(Boolean)
    this.artifactDirectory = artifactDirectory
    this.onDiagnostic = onDiagnostic
    this.browser = null
    this.context = null
    this.page = null
    this.authHosts = new Set()
    this.workspaceId = null
    this.userId = null
    this.capabilities = null
    this.fixtures = null
    this.orders = new Map()
    this.diagnostics = []
    this.pendingRequests = new Map()
    this.loggedIn = false
  }

  appUrl(route) {
    const url = new URL('/', this.baseUrl)
    url.hash = `/en${route.startsWith('/') ? route : `/${route}`}`
    return url.toString()
  }

  record(message, details) {
    const entry = { at: new Date().toISOString(), message: safeText(message, this.diagnosticSecrets), ...(details ? { details } : {}) }
    this.diagnostics.push(entry)
    this.onDiagnostic?.(entry)
  }

  async open({ workspaceId, userId }) {
    this.workspaceId = workspaceId
    this.userId = userId
    await mkdir(this.artifactDirectory, { recursive: true })
    try {
      this.browser = await chromium.launch({ headless: false, args: ['--start-maximized'] })
    } catch (error) {
      if (process.platform !== 'win32' || !String(error?.message ?? error).includes('Executable doesn\'t exist')) throw error
      this.browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--start-maximized'] })
    }
    this.context = await this.browser.newContext({ viewport: null, serviceWorkers: 'block' })
    await this.context.tracing.start({ screenshots: false, snapshots: false, sources: false })
    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(20_000)
    this.page.setDefaultNavigationTimeout(60_000)
    await this.page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'en')
      localStorage.setItem('atlas_first_time_done', 'true')
    })
    this.observePage()
    await this.page.goto(this.appUrl('/login'), { waitUntil: 'commit', timeout: 60_000 })
    await this.page.locator('#email').waitFor({ state: 'visible', timeout: 60_000 })
    await this.page.locator('#email').fill(this.email)
    await this.page.locator('#password').fill(this.password)
    await this.page.locator('form button[type="submit"]').click()
    await this.page.waitForFunction(() => !window.location.hash.includes('/login'), null, { timeout: 45_000 })
    this.loggedIn = true
    if (this.expectedSupabaseHost && !this.authHosts.has(this.expectedSupabaseHost)) {
      throw new Error('The Atlas UI did not authenticate against the configured live-test Supabase host.')
    }
    await this.page.goto(this.appUrl('/orders/sales'), { waitUntil: 'domcontentloaded' })
    this.capabilities = await this.readApplicationCapabilities({ workspaceId, userId })
    ensure(this.capabilities.workspaceId === workspaceId, 'The Atlas application is active in a different workspace than the verified Hybrid target.')
    return this
  }

  observePage() {
    this.page.on('request', (request) => {
      try {
        const url = new URL(request.url())
        if (url.pathname.endsWith('/auth/v1/token')) this.authHosts.add(url.host)
        const pathname = url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[id]')
        this.pendingRequests.set(request, {
          method: request.method(),
          host: url.host,
          pathname,
          startedAt: Date.now()
        })
      } catch { /* ignore malformed request URLs */ }
    })
    const clearPendingRequest = (request) => this.pendingRequests.delete(request)
    this.page.on('requestfinished', clearPendingRequest)
    this.page.on('requestfailed', (request) => {
      const pending = this.pendingRequests.get(request)
      clearPendingRequest(request)
      const failure = request.failure()?.errorText ?? 'unknown'
      if (pending && failure !== 'net::ERR_ABORTED') this.record('http.request-failed', {
        method: pending.method,
        host: pending.host,
        pathname: pending.pathname,
        failure: safeText(failure, this.diagnosticSecrets)
      })
    })
    this.page.on('console', (message) => {
      if (message.type() === 'error') this.record('console.error', { message: safeText(message.text(), this.diagnosticSecrets) })
    })
    this.page.on('pageerror', (error) => this.record('page.error', { message: safeText(error.message, this.diagnosticSecrets) }))
    this.page.on('response', (response) => {
      if (response.status() < 400) return
      let pathname = '[unavailable]'
      try { pathname = new URL(response.url()).pathname } catch { /* sanitized fallback */ }
      this.record('http.error', { status: response.status(), method: response.request().method(), pathname })
    })
  }

  async readApplicationCapabilities(target = { workspaceId: this.workspaceId, userId: this.userId }) {
    const deadline = Date.now() + 45_000
    let snapshot = null
    while (Date.now() < deadline) {
      try {
        snapshot = await this.page.evaluate(async (workspaceId) => {
          try {
            const databaseModulePath = '/src/local-db/database.ts'
            const networkModulePath = '/src/lib/network.ts'
            const [{ db }, network] = await Promise.all([
              import(databaseModulePath),
              import(networkModulePath)
            ])
            const workspace = await db.workspaces.get(workspaceId)
            return {
              workspace: workspace ? {
                id: workspace.id,
                data_mode: workspace.data_mode,
                is_configured: workspace.is_configured,
                locked_workspace: workspace.locked_workspace,
                orders: workspace.orders,
                crm: workspace.crm,
                products: workspace.products,
                storages: workspace.storages,
                services: workspace.services,
                loans: workspace.loans,
                installments: workspace.installments,
                allowed_currencies: workspace.allowed_currencies,
                default_currency: workspace.default_currency
              } : null,
              activeWorkspaceId: network.getActiveBusinessWorkspaceId(),
              activeUserId: network.getActiveBusinessUserId()
            }
          } catch (error) {
            return { readError: String(error?.message ?? error) }
          }
        }, target.workspaceId)
      } catch (error) {
        snapshot = { readError: String(error?.message ?? error) }
      }
      if (isReadyForSalesOrderApplicationSnapshot(snapshot, target)) break
      await sleep(250)
    }
    ensure(
      isReadyForSalesOrderApplicationSnapshot(snapshot, target),
      `The Atlas workspace feature snapshot did not finish loading after login: ${applicationSnapshotReadinessIssue(snapshot, target)}. Confirm the verified Hybrid workspace is active and retry after its workspace features have loaded.`
    )
    const workspace = snapshot.workspace
    const capabilities = {
        workspaceId: workspace.id,
        dataMode: workspace.data_mode,
        isConfigured: workspace.is_configured === true,
        isLocked: workspace.locked_workspace === true,
        orders: workspace.orders === true,
        businessPartners: workspace.crm === true,
        customers: workspace.crm === true,
        products: workspace.products === true,
        storages: workspace.storages === true,
        services: workspace.services === true,
        loans: workspace.loans === true,
        installments: workspace.installments === true,
        multiCurrency: Array.isArray(workspace.allowed_currencies) && workspace.allowed_currencies.length > 1,
        allowedCurrencies: Array.isArray(workspace.allowed_currencies) ? workspace.allowed_currencies : [],
        defaultCurrency: workspace.default_currency ?? null
      }
    ensure(String(capabilities.dataMode).toLowerCase() === 'hybrid', 'The Atlas application workspace snapshot is not in Hybrid mode.')
    ensure(capabilities.isConfigured, 'The Atlas Hybrid workspace is not configured for testing.')
    ensure(!capabilities.isLocked, 'The Atlas Hybrid workspace is locked.')
    capabilities.paymentMethods = []
    capabilities.paymentMethodSelectorEnabled = false
    if (capabilities.orders) {
      await this.page.goto(this.appUrl('/orders/new/sales'), { waitUntil: 'domcontentloaded' })
      try {
        await this.page.getByPlaceholder('Select Customer', { exact: true }).waitFor({ state: 'visible', timeout: 45_000 })
      } catch {
        const state = await this.page.evaluate(() => ({
          route: window.location.hash,
          title: document.title,
          headings: Array.from(document.querySelectorAll('h1,h2,[role="alert"]'))
            .slice(0, 8).map((element) => element.textContent?.trim()).filter(Boolean),
          placeholders: Array.from(document.querySelectorAll('input[placeholder]'))
            .map((input) => input.getAttribute('placeholder')).filter(Boolean).slice(0, 20),
          loadingIndicators: document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-loading="true"]').length
        })).catch(() => ({ route: '[unavailable]', title: '[unavailable]', headings: [], placeholders: [], loadingIndicators: 0 }))
        this.record('sales-order-form.readiness.failed', state)
        const visibleIssue = state.headings.length ? ` Visible page messages: ${state.headings.join(' | ')}.` : ''
        throw new Error(`The authenticated Atlas Sales Order form did not expose its customer selector at ${safeText(state.route)}.${visibleIssue} Verify the user's Sales Order access and retry after the form data is ready.`)
      }
      const paymentSelect = this.page.locator('#sales-payment')
      if (await paymentSelect.count()) {
        capabilities.paymentMethodSelectorEnabled = await paymentSelect.isEnabled()
        if (capabilities.paymentMethodSelectorEnabled) {
          await paymentSelect.click()
          capabilities.paymentMethods = await this.page.locator('[role="option"]').evaluateAll((options) => options
            .map((option) => option.getAttribute('data-value'))
            .filter((value) => Boolean(value)))
          await this.page.keyboard.press('Escape')
        } else {
          this.record('payment-method-discovery.skipped', {
            reason: 'The Payment Method selector is disabled in the authenticated Atlas UI; no methods were reported as available.'
          })
        }
      }
    }
    capabilities.payments = capabilities.paymentMethods.length > 0
    return capabilities
  }

  async prepareFixtures(runId, supabase, currency) {
    ensure(this.loggedIn, 'Fixture setup requires an authenticated Atlas browser session.')
    const namePrefix = `Atlas SO Hybrid ${runId.slice(0, 8)}`
    this.fixtures = { runId, namePrefix, customer: null, product: null, service: null, storage: null, orderIds: [] }
    const journalKey = `atlas_sales_order_hybrid_fixtures_${runId}`
    const includeService = this.capabilities?.services === true
    const storageLookup = await supabase.from('storages')
      .select('id,workspace_id,name,created_at,updated_at,is_deleted,is_system,is_protected,is_primary,is_marketplace')
      .eq('workspace_id', this.workspaceId).eq('is_deleted', false)
      .order('is_primary', { ascending: false }).order('name', { ascending: true }).limit(25)
    if (storageLookup.error) throw new Error('Could not discover authorized active Sales Order storage candidates in Supabase.')
    const storageCandidates = storageLookup.data ?? []
    let names = null
    let setupError = null
    try { names = await this.page.evaluate(async ({ workspaceId, userId, namePrefix, currency, runId, journalKey, includeService, storageCandidates }) => {
      const partnerModulePath = '/src/local-db/businessPartners.ts'
      const hooksModulePath = '/src/local-db/hooks.ts'
      const databaseModulePath = '/src/local-db/database.ts'
      const storagePermissionsPath = '/src/local-db/storagePermissions.ts'
      const [{ createBusinessPartner }, hooks, { db }, storagePermissions] = await Promise.all([
        import(partnerModulePath), import(hooksModulePath), import(databaseModulePath), import(storagePermissionsPath)
      ])
      const journal = { storage: null, customer: null, product: null, service: null }
      const saveJournal = () => localStorage.setItem(journalKey, JSON.stringify(journal))
      const existingStorages = await db.storages.where('workspaceId').equals(workspaceId).and((storage) => !storage.isDeleted).toArray()
      let storage = null
      let storageAccessError = null
      for (const candidate of storageCandidates) {
        try {
          await storagePermissions.assertCurrentUserCanAccessStorage(workspaceId, candidate.id)
          const cached = existingStorages.find((item) => item.id === candidate.id)
          const syncedAt = new Date().toISOString()
          storage = {
            ...(cached ?? {}),
            id: candidate.id,
            workspaceId,
            name: candidate.name,
            isSystem: candidate.is_system === true,
            isProtected: candidate.is_protected === true,
            isPrimary: candidate.is_primary === true,
            isMarketplace: candidate.is_marketplace === true,
            createdAt: candidate.created_at || cached?.createdAt || syncedAt,
            updatedAt: candidate.updated_at || cached?.updatedAt || syncedAt,
            version: Number(cached?.version ?? 1),
            isDeleted: false,
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
          }
          await db.storages.put(storage)
          break
        } catch (error) {
          storageAccessError = error
        }
      }
      if (!storage && storageCandidates.length > 0) {
        throw new Error(storageAccessError
          ? 'No discovered storage is authorized for this Sales Order test user.'
          : 'No active storage candidate could be hydrated into the Atlas cache.')
      }
      if (!storage) {
        storage = await hooks.createStorage(workspaceId, { name: `${namePrefix} Storage` })
        journal.storage = { id: storage.id, name: storage.name, created: true }
        saveJournal()
      } else {
        journal.storage = { id: storage.id, name: storage.name, created: false }
        saveJournal()
      }
      const customer = await createBusinessPartner(workspaceId, {
        partnerName: `${namePrefix} Customer`, phone: '', defaultCurrency: currency,
        creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer'
      })
      journal.customer = { id: customer.id, customerFacetId: customer.customerFacetId, name: customer.partnerName }
      saveJournal()
      const product = await hooks.createProduct(workspaceId, {
        sku: `SOHYB-${runId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
        name: `${namePrefix} Product`, description: `${namePrefix} owned fixture`, categoryId: null, category: null,
        storageId: storage.id, storageName: storage.name, price: 100, costPrice: 40, quantity: 100,
        minStockLevel: 0, unit: 'pcs', currency, barcode: '', barcodes: [], imageUrl: '',
        canBeReturned: true, returnRules: '', createdBy: userId
      })
      journal.product = { id: product.id, name: product.name }
      saveJournal()
      if (includeService) {
        const service = await hooks.createProduct(workspaceId, {
          sku: `SOHYBSVC-${runId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
          name: `${namePrefix} Service`, description: `${namePrefix} run-owned service fixture`, categoryId: null, category: null,
          storageId: null, storageName: undefined, price: 70, costPrice: 0, quantity: 0,
          minStockLevel: 0, unit: '', currency, barcode: '', barcodes: [], imageUrl: '',
          canBeReturned: false, returnRules: '', createdBy: userId, isService: true
        })
        journal.service = { id: service.id, name: service.name }
        saveJournal()
      }
      return journal
    }, { workspaceId: this.workspaceId, userId: this.userId, namePrefix, currency, runId, journalKey, includeService, storageCandidates }) }
    catch (error) { setupError = error }

    const journal = await this.page.evaluate((key) => {
      try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
    }, journalKey).catch(() => null)
    const ids = {
      customer: names?.customer?.id ?? journal?.customer?.id ?? null,
      product: names?.product?.id ?? journal?.product?.id ?? null,
      service: names?.service?.id ?? journal?.service?.id ?? null,
      storage: names?.storage?.id ?? journal?.storage?.id ?? null
    }
    const recovered = await Promise.all([
      ids.customer ? Promise.resolve({ data: null, error: null }) : supabase.schema('crm').rpc('list_visible_business_partners', { p_workspace_id: this.workspaceId }).eq('workspace_id', this.workspaceId).eq('name', `${namePrefix} Customer`).limit(1),
      ids.product ? Promise.resolve({ data: null, error: null }) : supabase.from('products').select('id').eq('workspace_id', this.workspaceId).eq('created_by', this.userId).eq('description', `${namePrefix} owned fixture`).eq('is_deleted', false).limit(1),
      ids.service || !includeService ? Promise.resolve({ data: null, error: null }) : supabase.from('products').select('id').eq('workspace_id', this.workspaceId).eq('created_by', this.userId).eq('description', `${namePrefix} run-owned service fixture`).eq('is_service', true).eq('is_deleted', false).limit(1),
      ids.storage ? Promise.resolve({ data: null, error: null }) : supabase.from('storages').select('id').eq('workspace_id', this.workspaceId).eq('name', `${namePrefix} Storage`).eq('is_deleted', false).limit(1)
    ])
    ids.customer ??= recovered[0].data?.[0]?.id ?? null
    ids.product ??= recovered[1].data?.[0]?.id ?? null
    ids.service ??= recovered[2].data?.[0]?.id ?? null
    ids.storage ??= recovered[3].data?.[0]?.id ?? null
    const [customer, product, service, storage] = await Promise.all([
      ids.customer ? supabase.schema('crm').rpc('list_visible_business_partners', { p_workspace_id: this.workspaceId }).eq('id', ids.customer).eq('workspace_id', this.workspaceId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      ids.product ? supabase.from('products').select('id,workspace_id,created_by,name,description,created_at,is_deleted,storage_id,is_service').eq('id', ids.product).eq('workspace_id', this.workspaceId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      ids.service ? supabase.from('products').select('id,workspace_id,created_by,name,description,created_at,is_deleted,storage_id,is_service').eq('id', ids.service).eq('workspace_id', this.workspaceId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      ids.storage ? supabase.from('storages').select('id,workspace_id,name,created_at,is_deleted').eq('id', ids.storage).eq('workspace_id', this.workspaceId).maybeSingle() : Promise.resolve({ data: null, error: null })
    ])
    if (customer.data) this.fixtures.customer = {
      id: customer.data.id,
      customerFacetId: names?.customer?.customerFacetId ?? journal?.customer?.customerFacetId ?? customer.data.customer_facet_id ?? null,
      name: customer.data.name,
      createdAt: customer.data.created_at
    }
    if (product.data) this.fixtures.product = { id: product.data.id, name: product.data.name, description: product.data.description, createdAt: product.data.created_at }
    if (service.data) this.fixtures.service = { id: service.data.id, name: service.data.name, description: service.data.description, createdAt: service.data.created_at }
    if (storage.data) this.fixtures.storage = { id: storage.data.id, name: storage.data.name, createdAt: storage.data.created_at, created: journal?.storage?.created ?? names?.storage?.created ?? false }
    if (setupError) throw new Error(`Fixture setup stopped after an application error: ${safeText(setupError.message ?? setupError, this.diagnosticSecrets)}`)
    if (customer.error || product.error || (includeService && (service.error || !service.data)) || storage.error || !customer.data || !product.data || !storage.data) {
      throw new Error('A run-owned Sales Order fixture did not verify in Supabase after setup; any discovered partial fixtures will be cleaned.')
    }
    ensure(customer.data.name === `${namePrefix} Customer`, 'The customer fixture did not match its run-owned name.')
    ensure(product.data.description === `${namePrefix} owned fixture` && product.data.created_by === this.userId && product.data.is_service !== true, 'The product fixture ownership could not be proven.')
    if (includeService) {
      ensure(service.data.description === `${namePrefix} run-owned service fixture` && service.data.created_by === this.userId && service.data.is_service === true, 'The service fixture ownership or service classification could not be proven.')
    }
    ensure(storage.data.name === `${namePrefix} Storage` || !journal?.storage?.created, 'The storage fixture did not match the setup result.')
    return this.fixtures
  }

  async readBaselines(supabase, productIds) {
    const ids = [...new Set((Array.isArray(productIds) ? productIds : [productIds]).filter(Boolean))]
    ensure(ids.length > 0, 'At least one run-owned product is required for an inventory baseline.')
    const [inventory, movements] = await Promise.all([
      supabase.from('inventory').select('id,product_id,quantity,version,is_deleted').eq('workspace_id', this.workspaceId).in('product_id', ids).order('id'),
      supabase.from('inventory_transactions').select('id,product_id,quantity_delta,transaction_type,is_deleted').eq('workspace_id', this.workspaceId).in('product_id', ids).order('id')
    ])
    if (inventory.error || movements.error) throw new Error('Could not capture the run-owned product inventory baseline.')
    return { inventory: inventory.data ?? [], movements: movements.data ?? [] }
  }

  async createDraft(supabase, scenario, baseline, runId) {
    const fixture = this.fixtures
    const marker = `${fixture.namePrefix} ${scenario.id} ${runId}`
    await this.page.goto(this.appUrl('/orders/new/sales'), { waitUntil: 'domcontentloaded' })
    const customerInput = this.page.getByPlaceholder('Select Customer', { exact: true })
    await customerInput.waitFor({ state: 'visible' })
    await customerInput.fill(fixture.customer.name)
    await this.page.getByRole('button').filter({ hasText: fixture.customer.name }).first().click()
    await this.page.getByRole('button', { name: 'Clear Link', exact: true }).waitFor({ state: 'visible' })

    const storageTrigger = this.page.getByRole('combobox').filter({ hasText: 'Select Storage' }).first()
    if (await storageTrigger.count()) {
      await storageTrigger.click()
      await this.page.getByRole('option', { name: fixture.storage.name, exact: true }).click()
    }
    const productInput = this.page.getByPlaceholder('Select Product', { exact: true }).first()
    await productInput.fill(fixture.product.name)
    await this.page.getByRole('button').filter({ hasText: fixture.product.name }).first().click()
    await this.page.getByPlaceholder('Order notes, special instructions...').fill(marker)

    const quantity = scenario.preparedDimensions?.savedQuantity ?? scenario.preparedDimensions?.quantity ?? 1
    if (quantity !== 1) await this.page.locator('input[placeholder="Quantity"]').first().fill(String(quantity))
    const save = this.page.getByRole('button', { name: 'Save Order', exact: true })
    await save.waitFor({ state: 'visible' })
    ensure(await save.isEnabled(), 'The Sales Order save action is disabled before submission; check required form data and workspace policy.')
    const submittedButton = await save.elementHandle()
    if (scenario.id === 'SO-HYB-004') await save.dblclick({ delay: 30 })
    else await save.click()
    await submittedButton?.waitForElementState('disabled', { timeout: 5_000 }).catch(() => undefined)

    const order = await this.waitForOrder(supabase, marker, 30_000)
    if (scenario.id === 'SO-HYB-004') {
      await sleep(1_500)
      const duplicateCheck = await supabase.schema('crm').from('sales_orders').select('id')
        .eq('workspace_id', this.workspaceId).eq('notes', marker).eq('is_deleted', false)
      if (duplicateCheck.error) throw new Error('Could not verify duplicate-submit persistence after the UI retry window.')
      ensure((duplicateCheck.data ?? []).length === 1, `Repeated save created ${(duplicateCheck.data ?? []).length} active Sales Orders for one scenario marker.`)
    }
    this.fixtures.orderIds.push(order.id)
    ensure(order.status === 'draft', `Expected an unpaid draft, received status ${order.status}.`)
    ensure(order.is_paid !== true, 'A draft-only workflow unexpectedly persisted as paid.')
    const items = Array.isArray(order.items) ? order.items : []
    ensure(items.length === 1, `Expected one saved Sales Order line, received ${items.length}.`)
    const line = items[0]
    ensure((itemValue(line, 'productId', 'product_id') ?? null) === fixture.product.id, 'The saved order line does not reference the run-owned product.')
    equalNumber(itemValue(line, 'quantity', 'qty'), quantity, 'persisted line quantity')
    equalNumber(order.total, quantity * 100, 'persisted order total')
    ensure(order.customer_id === fixture.customer.id || order.business_partner_id === fixture.customer.id, 'The saved order does not reference the run-owned customer.')

    if (scenario.id === 'SO-HYB-001') {
      await this.page.goto(this.appUrl(`/orders/edit/sales/${order.id}`), { waitUntil: 'domcontentloaded' })
      const notes = this.page.getByPlaceholder('Order notes, special instructions...')
      await notes.waitFor({ state: 'visible' })
      await this.page.reload({ waitUntil: 'domcontentloaded' })
      await notes.waitFor({ state: 'visible' })
      ensure(await notes.inputValue() === marker, 'The draft marker did not survive reloading the Sales Order form.')
      equalNumber(await this.page.locator('input[placeholder="Quantity"]').first().inputValue(), quantity, 'reloaded draft quantity')
    }

    const cached = await this.readCachedOrder(order.id)
    ensure(cached && cached.workspaceId === this.workspaceId && cached.status === 'draft', 'The Atlas Dexie cache did not contain the persisted draft.')
    const [payments, inventoryAfter] = await Promise.all([
      supabase.from('payment_transactions').select('id').eq('workspace_id', this.workspaceId).eq('source_record_id', order.id),
      this.readBaselines(supabase, fixture.product.id)
    ])
    if (payments.error) throw new Error('Could not verify payment side effects for the draft.')
    ensure((payments.data ?? []).length === 0, 'The draft-only workflow created a payment transaction.')
    ensure(JSON.stringify(inventoryAfter) === JSON.stringify(baseline), 'The draft-only workflow changed inventory or created a stock movement.')

    if (scenario.id === 'SO-HYB-002') {
      await this.page.goto(this.appUrl(`/orders/edit/sales/${order.id}`), { waitUntil: 'domcontentloaded' })
      await this.page.getByPlaceholder('Order notes, special instructions...').waitFor({ state: 'visible' })
      await this.page.locator('input[placeholder="Quantity"]').first().fill('2')
      await this.page.getByRole('button', { name: 'Save', exact: true }).click()
      await this.waitForOrder(supabase, marker, 30_000, (current) => Number(current.items?.[0]?.quantity ?? current.items?.[0]?.qty) === 2)
      await this.page.goto(this.appUrl(`/orders/edit/sales/${order.id}`), { waitUntil: 'domcontentloaded' })
      await this.page.reload({ waitUntil: 'domcontentloaded' })
      await this.page.getByPlaceholder('Order notes, special instructions...').waitFor({ state: 'visible' })
      equalNumber(await this.page.locator('input[placeholder="Quantity"]').first().inputValue(), 2, 'reloaded quantity')
      const updated = await this.readOrder(supabase, marker)
      ensure(updated.id === order.id, 'Editing the draft created a second order instead of updating the original.')
      equalNumber(updated.total, 200, 'edited persisted order total')
      const cacheAfterEdit = await this.readCachedOrder(order.id)
      ensure(cacheAfterEdit?.items?.[0]?.quantity === 2, 'The edited order was not reflected in the Dexie cache.')
      return { orderId: order.id, marker, orderNumber: order.order_number, total: updated.total, status: updated.status, persistedItems: updated.items, cacheVerified: true }
    }

    if (scenario.id === 'SO-HYB-003') {
      await this.page.goto(this.appUrl('/orders/sales'), { waitUntil: 'domcontentloaded' })
      const row = this.page.getByRole('row').filter({ hasText: fixture.customer.name }).filter({ hasText: order.order_number }).first()
      await row.getByRole('button', { name: 'More options' }).click()
      await this.page.getByRole('menuitem', { name: 'Cancel', exact: true }).click()
      const dialog = this.page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      const cancelled = await this.waitForOrder(supabase, marker, 30_000, (current) => current.status === 'cancelled')
      ensure(cancelled.id === order.id, 'Cancellation changed a different order than the run-owned draft.')
      const afterCancel = await this.readBaselines(supabase, fixture.product.id)
      ensure(JSON.stringify(afterCancel) === JSON.stringify(baseline), 'Cancelling the unpaid draft changed inventory.')
      return { orderId: order.id, marker, orderNumber: order.order_number, status: cancelled.status, inventoryUnchanged: true, paymentTransactions: 0 }
    }

    return { orderId: order.id, marker, orderNumber: order.order_number, total: order.total, status: order.status, cacheVerified: true, inventoryUnchanged: true, paymentTransactions: 0 }
  }

  async createServiceDrafts(supabase, scenario, baseline, runId, shouldCancel = () => false) {
    const fixture = this.fixtures
    ensure(fixture?.service?.id, 'The run-owned service fixture is unavailable; the workspace service capability may have changed.')
    ensure(fixture.customer?.customerFacetId, 'The run-owned customer facet is unavailable; re-prepare the Sales Order test fixtures.')
    const dimensions = scenario.preparedDimensions
    const actions = dimensions?.actions
    ensure(Array.isArray(actions) && actions.length === 2
      && actions[0] === 'service-only-draft' && actions[1] === 'mixed-product-service-draft',
    'The prepared service scenario dimensions are invalid. Prepare the timeline again before running this scenario.')
    const serviceQuantity = Number(dimensions.serviceQuantity)
    const serviceUnitPrice = Number(dimensions.serviceUnitPrice)
    const productQuantity = Number(dimensions.productQuantity)
    const productUnitPrice = Number(dimensions.productUnitPrice)
    for (const [label, value] of Object.entries({ serviceQuantity, serviceUnitPrice, productQuantity, productUnitPrice })) {
      ensure(Number.isFinite(value) && value > 0, `The prepared ${label} is invalid; prepare the scenario again.`)
    }

    const results = []
    const productIds = [fixture.product.id, fixture.service.id]
    for (const action of actions) {
      if (shouldCancel()) break
      const mixed = action === 'mixed-product-service-draft'
      const marker = `${fixture.namePrefix} ${scenario.id} ${action} ${runId}`
      await this.page.goto(this.appUrl('/orders/sales'), { waitUntil: 'domcontentloaded' })
      await this.page.goto(this.appUrl('/orders/new/sales'), { waitUntil: 'domcontentloaded' })
      await this.page.reload({ waitUntil: 'domcontentloaded' })
      const customerInput = this.page.getByPlaceholder('Select Customer', { exact: true })
      await customerInput.waitFor({ state: 'visible' })
      await customerInput.fill(fixture.customer.name)
      await this.page.getByRole('button').filter({ hasText: fixture.customer.name }).first().click()
      await this.page.getByRole('button', { name: 'Clear Link', exact: true }).waitFor({ state: 'visible' })

      if (mixed) {
        await this.selectSalesOrderStorage(0, fixture.storage.name)
        await this.selectSalesOrderProduct(0, fixture.product)
        await this.page.getByRole('button', { name: 'Add Item', exact: true }).click()
      }

      // Services has its own virtual catalog source. Select it to expose the
      // service catalog; selecting a service then removes stock storage from
      // the line and Atlas persists the line without an inventory location.
      await this.selectSalesOrderStorage(0, 'Services')
      await this.selectSalesOrderProduct(0, fixture.service)
      if (mixed) {
        const quantities = this.page.locator('input[placeholder="Quantity"]')
        await quantities.nth(0).fill(String(serviceQuantity))
        await quantities.nth(1).fill(String(productQuantity))
      } else {
        await this.page.locator('input[placeholder="Quantity"]').first().fill(String(serviceQuantity))
      }
      await this.page.getByPlaceholder('Order notes, special instructions...').fill(marker)
      if (shouldCancel()) break

      const save = this.page.getByRole('button', { name: 'Save Order', exact: true })
      await save.waitFor({ state: 'visible' })
      ensure(await save.isEnabled(), 'The service Sales Order save action is disabled; check the prepared customer, product, and workspace policy.')
      await save.click()

      const order = await this.waitForOrder(supabase, marker, 30_000)
      this.fixtures.orderIds.push(order.id)
      const expectedLines = [
        { productId: fixture.service.id, isService: true, quantity: serviceQuantity, unitPrice: serviceUnitPrice },
        ...(mixed ? [{ productId: fixture.product.id, isService: false, quantity: productQuantity, unitPrice: productUnitPrice }] : [])
      ]
      const expectedOrderRelationships = {
        businessPartnerId: fixture.customer.id,
        customerId: fixture.customer.customerFacetId,
        storageId: fixture.storage.id,
        expectedLines
      }
      assertPersistedServiceDraft(order, expectedOrderRelationships)

      const cached = await this.readCachedOrder(order.id)
      ensure(cached && cached.workspaceId === this.workspaceId, 'The Atlas Dexie cache did not contain the persisted service draft.')
      assertPersistedServiceDraft(cached, expectedOrderRelationships)
      const [payments, inventoryAfter] = await Promise.all([
        supabase.from('payment_transactions').select('id').eq('workspace_id', this.workspaceId).eq('source_record_id', order.id),
        this.readBaselines(supabase, productIds)
      ])
      if (payments.error) throw new Error('Could not verify payment side effects for the service draft.')
      ensure((payments.data ?? []).length === 0, 'The draft-only service workflow created a payment transaction.')
      ensure(JSON.stringify(inventoryAfter) === JSON.stringify(baseline), 'Saving a service-only or mixed draft changed inventory or created a stock movement.')
      ensure(!(inventoryAfter.inventory ?? []).some((row) => row.product_id === fixture.service.id)
        && !(inventoryAfter.movements ?? []).some((row) => row.product_id === fixture.service.id),
      'The run-owned service unexpectedly has an inventory record or stock movement.')

      await this.page.goto(this.appUrl(`/orders/edit/sales/${order.id}`), { waitUntil: 'domcontentloaded' })
      const notes = this.page.getByPlaceholder('Order notes, special instructions...')
      await notes.waitFor({ state: 'visible' })
      await this.page.reload({ waitUntil: 'domcontentloaded' })
      await notes.waitFor({ state: 'visible' })
      const expectedProductNames = expectedLines.map((line) => line.isService ? fixture.service.name : fixture.product.name)
      try {
        await this.page.waitForFunction(({ expectedMarker, productNames }) => {
          const markerField = document.querySelector('textarea[placeholder="Order notes, special instructions..."]')
          const productFields = Array.from(document.querySelectorAll('[data-order-product-input="true"]'))
          return markerField instanceof HTMLTextAreaElement
            && markerField.value === expectedMarker
            && productFields.length === productNames.length
            && productFields.every((field, index) => field instanceof HTMLInputElement && field.value === productNames[index])
        }, { expectedMarker: marker, productNames: expectedProductNames }, { timeout: 60_000 })
      } catch {
        const state = await this.page.evaluate(() => ({
          route: window.location.hash,
          notes: document.querySelector('textarea[placeholder="Order notes, special instructions..."]')?.value ?? null,
          products: Array.from(document.querySelectorAll('[data-order-product-input="true"]')).map((field) => field.value),
          loading: Array.from(document.querySelectorAll('body *')).some((element) => element.textContent?.trim() === 'Preparing this section')
        })).catch(() => ({ route: '[unavailable]', notes: null, products: [], loading: true }))
        this.record('sales-order-form.reload-hydration.failed', state)
        throw new Error('The Sales Order editor did not finish reloading the saved customer, products, and notes. See the sanitized reload diagnostics and retry after workspace data finishes loading.')
      }
      ensure(await notes.inputValue() === marker, 'The service draft marker did not survive a browser reload.')
      ensure(await this.page.locator('input[placeholder="Quantity"]').count() === expectedLines.length,
        'The service draft line count did not survive a browser reload.')
      results.push({
        action,
        orderId: order.id,
        marker,
        orderNumber: order.order_number,
        status: order.status,
        total: order.total,
        lines: expectedLines,
        persistedItems: order.items,
        cacheVerified: true,
        reloadVerified: true,
        paymentTransactions: 0,
        inventoryUnchanged: true
      })
    }

    return {
      orders: results,
      completedActions: results.map((result) => result.action),
      cancelled: shouldCancel(),
      inventoryUnchanged: true,
      serviceInventoryRows: 0,
      paymentTransactions: 0
    }
  }

  async selectSalesOrderStorage(index, storageName) {
    const trigger = this.page.locator(`#sales-storage-${index}`).getByRole('combobox')
    await trigger.waitFor({ state: 'visible' })
    await trigger.click()
    await this.page.getByRole('option', { name: storageName, exact: true }).click()
  }

  async selectSalesOrderProduct(index, product) {
    const input = this.page.locator(`[data-order-product-input="true"][data-order-product-index="${index}"]`)
    await input.waitFor({ state: 'visible' })
    await input.fill(product.name)
    const result = this.page.getByRole('button').filter({ hasText: product.name }).first()
    await result.waitFor({ state: 'visible', timeout: 20_000 })
    await result.click()
    await this.page.waitForFunction(({ index, expectedName }) => {
      const selectedInput = document.querySelector(`[data-order-product-input="true"][data-order-product-index="${index}"]`)
      return selectedInput instanceof HTMLInputElement && selectedInput.value === expectedName
    }, { index, expectedName: product.name })
  }

  async waitForOrder(supabase, marker, timeoutMs, predicate = () => true) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const result = await supabase.schema('crm').from('sales_orders').select('*')
          .eq('workspace_id', this.workspaceId).eq('notes', marker).eq('is_deleted', false)
        if (result.error) throw result.error
        const rows = result.data ?? []
        ensure(rows.length <= 1, `The scenario created ${rows.length} active orders for one unique marker.`)
        if (rows.length === 1 && predicate(rows[0])) return rows[0]
      } catch (error) { lastError = error }
      await sleep(350)
    }
    if (lastError) throw new Error(`Timed out waiting for the Sales Order to persist: ${safeText(lastError.message ?? lastError, this.diagnosticSecrets)}`)
    const pending = Array.from(this.pendingRequests.values())
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-12)
      .map(({ method, host, pathname, startedAt }) => ({ method, host, pathname, elapsedMs: Date.now() - startedAt }))
    const pendingDetail = pending.length ? ` Browser requests still pending: ${JSON.stringify(pending)}.` : ' No browser requests remain pending.'
    throw new Error(`Timed out waiting for the expected Sales Order state to persist in Supabase.${pendingDetail}`)
  }

  async readOrder(supabase, marker) {
    const result = await supabase.schema('crm').from('sales_orders').select('*')
      .eq('workspace_id', this.workspaceId).eq('notes', marker).eq('is_deleted', false).maybeSingle()
    if (result.error || !result.data) throw new Error('Could not read the run-owned persisted Sales Order.')
    return result.data
  }

  async readCachedOrder(orderId) {
    return this.page.evaluate(async (id) => {
      const databaseModulePath = '/src/local-db/database.ts'
      const { db } = await import(databaseModulePath)
      return await db.sales_orders.get(id) ?? null
    }, orderId)
  }

  async captureScreenshot(name) {
    if (!this.loggedIn || !this.page) return null
    const path = `${this.artifactDirectory}/${name}.png`
    const mask = [
      this.page.locator('header'),
      this.page.locator('input[type="email"], input[type="password"]'),
      this.page.getByText(this.email, { exact: true })
    ]
    try {
      await this.page.screenshot({ path, fullPage: true, mask, maskColor: '#000000' })
      return path
    } catch {
      return null
    }
  }

  async cleanup(supabase) {
    const fixture = this.fixtures
    if (!fixture) return { completed: true, errors: [], removed: [] }
    const errors = []
    const removed = []
    let ordersClean = true
    let productClean = true
    const discoveredOrders = await supabase.schema('crm').from('sales_orders')
      .select('id').eq('workspace_id', this.workspaceId).like('notes', `${fixture.namePrefix} %`).eq('is_deleted', false)
    if (discoveredOrders.error) {
      ordersClean = false
      errors.push('Could not enumerate run-owned Sales Orders before cleanup.')
    } else {
      fixture.orderIds.push(...(discoveredOrders.data ?? []).map((order) => order.id))
    }
    if (this.page && this.loggedIn) {
      try {
        for (const id of new Set(fixture.orderIds)) {
          const ownership = await supabase.schema('crm').from('sales_orders').select('id,workspace_id,created_by,notes,status,is_paid,is_deleted,version')
            .eq('workspace_id', this.workspaceId).eq('id', id).maybeSingle()
          if (ownership.error) throw new Error(`Could not verify order ownership before cleanup: ${ownership.error.message}`)
          const order = ownership.data
          if (!order || order.is_deleted) { removed.push(`order:${id}`); continue }
          ensure(order.notes?.startsWith(`${fixture.namePrefix} `) && order.workspace_id === this.workspaceId
            && (!order.created_by || order.created_by === this.userId), 'Order cleanup ownership check failed; the record was preserved.')
          ensure(order.status === 'draft' || order.status === 'cancelled', 'A non-draft Sales Order was preserved during cleanup.')
          ensure(!order.is_paid, 'A paid Sales Order was preserved during cleanup to avoid hiding financial audit records.')
          const [payments, inventoryMovements] = await Promise.all([
            supabase.from('payment_transactions').select('id').eq('workspace_id', this.workspaceId).eq('source_record_id', id).limit(1),
            supabase.from('inventory_transactions').select('id').eq('workspace_id', this.workspaceId).eq('reference_id', id).limit(1)
          ])
          if (payments.error || inventoryMovements.error) throw new Error('Could not independently verify financial and inventory effects before order cleanup.')
          ensure(!(payments.data?.length) && !(inventoryMovements.data?.length),
            'The run-owned draft has payment or inventory effects and was preserved during cleanup.')
          const retired = await supabase.schema('crm').from('sales_orders').update({
            is_deleted: true,
            updated_at: new Date().toISOString(),
            version: Number(order.version ?? 0) + 1
          }).eq('workspace_id', this.workspaceId).eq('id', id).eq('created_by', this.userId)
            .eq('notes', order.notes).eq('status', order.status).eq('is_paid', false).eq('is_deleted', false)
            .select('is_deleted').maybeSingle()
          if (retired.error || !retired.data?.is_deleted) throw new Error('The run-owned unpaid draft did not verify as deleted through the authorized workspace API.')
          const check = await supabase.schema('crm').from('sales_orders').select('is_deleted').eq('workspace_id', this.workspaceId).eq('id', id).maybeSingle()
          if (check.error || !check.data?.is_deleted) throw new Error('The run-owned Sales Order did not verify as deleted after cleanup.')
          removed.push(`order:${id}`)
        }
      } catch (error) { ordersClean = false; errors.push(safeText(error?.message ?? error, this.diagnosticSecrets)) }
    } else if (fixture.orderIds.length) { ordersClean = false; errors.push('The browser session closed before run-owned orders could be cleaned through the application order service.') }

    if (ordersClean) {
      for (const [kind, ownedFixture] of [['product', fixture.product], ['service', fixture.service]]) {
        if (!ownedFixture?.id) continue
        try {
          const product = await supabase.from('products').select('id,workspace_id,created_by,description,is_deleted,is_service')
            .eq('id', ownedFixture.id).eq('workspace_id', this.workspaceId).maybeSingle()
          if (product.error) throw new Error(`Could not inspect the run-owned ${kind} before cleanup.`)
          if (product.data && !product.data.is_deleted) {
            ensure(product.data.created_by === this.userId && product.data.description === ownedFixture.description
              && (kind === 'service' ? product.data.is_service === true : product.data.is_service !== true),
            `${kind} cleanup ownership check failed; the record was preserved.`)
            await this.page.evaluate(async (productId) => {
              const hooksModulePath = '/src/local-db/hooks.ts'
              const { deleteProduct } = await import(hooksModulePath)
              await deleteProduct(productId)
            }, ownedFixture.id)
            const verify = await supabase.from('products').select('is_deleted').eq('workspace_id', this.workspaceId).eq('id', ownedFixture.id).maybeSingle()
            if (verify.error || !verify.data?.is_deleted) throw new Error(`The run-owned ${kind} did not verify as deleted after cleanup.`)
          }
          removed.push(`${kind}:${ownedFixture.id}`)
        } catch (error) { productClean = false; errors.push(safeText(error?.message ?? error, this.diagnosticSecrets)) }
      }
    }

    if (ordersClean && productClean && fixture.customer?.id) {
      try {
        const customer = await supabase.schema('crm').rpc('list_visible_business_partners', { p_workspace_id: this.workspaceId })
          .eq('id', fixture.customer.id).eq('workspace_id', this.workspaceId).eq('is_deleted', false).maybeSingle()
        if (customer.error) throw new Error('Could not inspect the run-owned customer before cleanup.')
        if (customer.data) {
          ensure(customer.data.name === fixture.customer.name && customer.data.created_at === fixture.customer.createdAt, 'Customer cleanup ownership check failed; the record was preserved.')
        }
        const customerFacetId = fixture.customer.customerFacetId ?? customer.data?.customer_facet_id ?? null
        const [salesByPartner, salesByFacet, purchasesByPartner, loansByPartner] = await Promise.all([
          supabase.schema('crm').from('sales_orders').select('id').eq('workspace_id', this.workspaceId).eq('business_partner_id', fixture.customer.id).eq('is_deleted', false).limit(1),
          customerFacetId
            ? supabase.schema('crm').from('sales_orders').select('id').eq('workspace_id', this.workspaceId).eq('customer_id', customerFacetId).eq('is_deleted', false).limit(1)
            : Promise.resolve({ data: [], error: null }),
          supabase.schema('crm').from('purchase_orders').select('id').eq('workspace_id', this.workspaceId).eq('business_partner_id', fixture.customer.id).eq('is_deleted', false).limit(1),
          supabase.from('loans').select('id').eq('workspace_id', this.workspaceId).eq('linked_party_type', 'business_partner').eq('linked_party_id', fixture.customer.id).eq('is_deleted', false).limit(1)
        ])
        const dependencies = [salesByPartner, salesByFacet, purchasesByPartner, loansByPartner]
        if (dependencies.some((result) => result.error)) throw new Error('Could not inspect run-owned customer dependencies before cleanup.')
        ensure(dependencies.every((result) => (result.data ?? []).length === 0), 'Run-owned customer has active orders or loans and was preserved during cleanup.')
        if (customerFacetId) {
          const facetDelete = await supabase.schema('crm').rpc('sync_customer', {
            p_operation: 'soft_delete', p_entity_id: customerFacetId, p_workspace_id: this.workspaceId, p_payload: { id: customerFacetId }
          })
          if (facetDelete.error) throw new Error('Could not retire the run-owned customer facet through the authorized Atlas sync API.')
          removed.push(`customer-facet:${customerFacetId}`)
        }
        const partnerDelete = await supabase.schema('crm').rpc('sync_business_partner', {
          p_operation: 'soft_delete', p_entity_id: fixture.customer.id, p_workspace_id: this.workspaceId, p_payload: { id: fixture.customer.id }
        })
        if (partnerDelete.error) throw new Error('Could not retire the run-owned customer through the authorized Atlas sync API.')
        const verify = await supabase.schema('crm').rpc('list_visible_business_partners', { p_workspace_id: this.workspaceId })
          .eq('workspace_id', this.workspaceId).eq('id', fixture.customer.id).eq('is_deleted', false).maybeSingle()
        if (verify.error || verify.data) throw new Error('The run-owned customer remained visible after cleanup.')
        removed.push(`customer:${fixture.customer.id}`)
      } catch (error) { errors.push(safeText(error?.message ?? error, this.diagnosticSecrets)) }
    }

    if (ordersClean && productClean && fixture.storage?.created) {
      try {
        const [ownedStorage, activeProduct] = await Promise.all([
          supabase.from('storages').select('id,workspace_id,name,created_at,is_deleted,is_system,is_protected').eq('workspace_id', this.workspaceId).eq('id', fixture.storage.id).maybeSingle(),
          supabase.from('products').select('id').eq('workspace_id', this.workspaceId).eq('storage_id', fixture.storage.id).eq('is_deleted', false)
        ])
        if (ownedStorage.error || activeProduct.error) throw new Error('Could not verify the owned storage dependencies during cleanup.')
        if (ownedStorage.data && !ownedStorage.data.is_deleted) {
          ensure(ownedStorage.data.name === fixture.storage.name && ownedStorage.data.created_at === fixture.storage.createdAt
            && !ownedStorage.data.is_system && !ownedStorage.data.is_protected && !(activeProduct.data?.length),
          'Storage cleanup ownership or dependency check failed; the record was preserved.')
          const retired = await supabase.from('storages').update({ is_deleted: true, is_primary: false, is_marketplace: false, updated_at: new Date().toISOString() })
            .eq('id', fixture.storage.id).eq('workspace_id', this.workspaceId).eq('name', fixture.storage.name)
            .eq('created_at', fixture.storage.createdAt).eq('is_system', false).eq('is_protected', false).select('is_deleted').maybeSingle()
          if (retired.error || !retired.data?.is_deleted) throw new Error('The run-owned storage did not verify as retired after cleanup.')
        }
        removed.push(`storage:${fixture.storage.id}`)
      } catch (error) { errors.push(safeText(error?.message ?? error, this.diagnosticSecrets)) }
    }
    if (errors.length === 0) this.fixtures = null
    return { completed: errors.length === 0, errors, removed }
  }

  async close(tracePath) {
    if (this.context) {
      try { await this.context.tracing.stop({ path: tracePath }) } catch { /* diagnostics may already be complete */ }
      await this.context.close().catch(() => undefined)
    }
    await this.browser?.close().catch(() => undefined)
    this.page = null
    this.context = null
    this.browser = null
  }
}
