import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const RPC_PATHS = ['/rpc/complete_pos_checkout', '/rpc/complete_sale_with_loan', '/rpc/complete_sale']

function displayedAmount(text, label) {
  const value = String(text ?? '').replace(label, '').match(/-?\d[\d,]*(?:\.\d+)?/)?.[0]
  return value ? Number(value.replace(/,/g, '')) : Number.NaN
}

function closeUiAmount(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 0.001
}

function quickOrderOptionId(row) {
  const value = row.getAttribute('data-value')
  if (value) return value
  const label = String(row.innerText ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const known = new Map([
    ['cash', 'cash'], ['bank transfer', 'bank_transfer'], ['loan', 'loan'], ['loans', 'loan'], ['installments', 'installments'],
    ['fib', 'fib'], ['qicard', 'qicard'], ['qi card', 'qicard'], ['zaincash', 'zaincash'], ['zain cash', 'zaincash'],
    ['fastpay', 'fastpay'], ['fast pay', 'fastpay'], ['paid', 'paid'], ['unpaid', 'unpaid'],
    ['partial', 'partial'], ['partially paid', 'partial'], ['pending', 'pending'], ['draft', 'draft'], ['completed', 'completed'],
    ['weekly', 'weekly'], ['every two weeks', 'biweekly'], ['biweekly', 'biweekly'], ['monthly', 'monthly']
  ])
  return known.get(label) ?? null
}

export class CloudHybridPosDriver {
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
    this.consoleDiagnostics = []
    this.networkDiagnostics = new Map()
    this.consoleDiagnosticIndex = new Map()
    this.rpcRequests = []
    this.loanPaymentRequests = []
    this.activityRequests = []
    this.quickOrderWrites = []
    this.quickOrderPreparedFixtureId = null
    this.authHosts = new Set()
    this.completedScenarios = 0
    // The POS retains enough renderer and request state that long sessions can
    // run out of Chromium resources. Keep the visible browser session short;
    // this also makes selected runs reliable when they begin late in the suite.
    this.browserRestartInterval = 3
  }

  appUrl(route) {
    const url = new URL('/', this.baseUrl)
    url.hash = `/en${route.startsWith('/') ? route : `/${route}`}`
    return url.toString()
  }

  async open() {
    await mkdir(this.artifactDirectory, { recursive: true })
    try {
      this.browser = await chromium.launch({ headless: false, args: ['--start-maximized'] })
    } catch (error) {
      if (process.platform !== 'win32' || !String(error?.message ?? error).includes('Executable doesn\'t exist')) throw error
      // Development machines commonly have Chrome installed without Playwright's
      // separately downloaded Chromium bundle. Keep the standalone runner usable
      // there, while preserving the bundled browser as the default.
      this.browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--start-maximized'] })
    }
    this.context = await this.browser.newContext({
      // Let Chromium's maximized native window determine the page viewport.
      viewport: null,
      // The headed live test verifies server-backed Hybrid behavior; a stale
      // PWA worker must not serve old development chunks into its clean context.
      serviceWorkers: 'block'
    })
    await this.context.tracing.start({ screenshots: false, snapshots: false, sources: false })
    await this.installPage()

    // The loading shell can remain active while IndexedDB/WASM initializes.
    // Wait for the document to commit, then wait for the concrete login control.
    await this.page.goto(this.appUrl('/login'), { waitUntil: 'commit', timeout: 60000 })
    const emailInput = this.page.locator('#email')
    await emailInput.waitFor({ state: 'visible', timeout: 60000 })
    await emailInput.fill(this.email)
    await this.page.locator('#password').fill(this.password)
    await this.page.locator('form button[type="submit"]').click()
    await this.page.waitForFunction(() => !window.location.hash.includes('/login'), null, { timeout: 30000 })
    if (this.expectedSupabaseHost && !this.authHosts.size) {
      throw new Error('The Atlas UI completed login without issuing an observable Supabase authentication request.')
    }
    if (this.expectedSupabaseHost && !this.authHosts.has(this.expectedSupabaseHost)) {
      throw new Error(`The Atlas UI authenticated against ${[...this.authHosts].join(', ')}, which does not match the configured live-test Supabase host.`)
    }
    const posNavigation = this.page.getByText('Point of Sale', { exact: true }).first()
    await posNavigation.waitFor({ state: 'visible', timeout: 60000 })
    // The web shell may reload once while recovering a transient failed chunk
    // request after login. Give that observable navigation control time to
    // become stable before starting the POS workflow.
    await posNavigation.click({ timeout: 60000 })
    await this.waitForPosReady()
    return this
  }

  async installPage() {
    await this.context.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'en')
      localStorage.setItem('atlas_first_time_done', 'true')
      localStorage.setItem('pos_show_quantity_indicator', 'true')
    })
    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(15000)
    this.page.setDefaultNavigationTimeout(60000)
    this.observePage()
  }

  observePage() {
    this.page.on('console', (message) => {
      if (message.type() === 'error') this.recordConsoleDiagnostic('console.error', message.text())
    })
    this.page.on('pageerror', (error) => this.recordConsoleDiagnostic('pageerror', error.message))
    this.page.on('response', (response) => {
      if (response.status() < 400) return
      const request = response.request()
      this.recordNetworkDiagnostic({
        kind: 'http-response',
        status: response.status(),
        method: request.method(),
        resourceType: request.resourceType(),
        url: this.safeDiagnosticUrl(response.url())
      })
    })
    this.page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'Unknown network failure'
      const aborted = /ERR_ABORTED/i.test(failure)
      this.recordNetworkDiagnostic({
        kind: aborted ? 'request-aborted' : 'request-failed',
        method: request.method(),
        resourceType: request.resourceType(),
        url: this.safeDiagnosticUrl(request.url()),
        failure: this.sanitizeDiagnostic(failure).slice(0, 300)
      })
    })
    this.page.on('request', (request) => {
      let pathname = ''
      try {
        const url = new URL(request.url())
        pathname = url.pathname
        if (pathname.endsWith('/auth/v1/token')) this.authHosts.add(url.host)
      } catch { return }
      if (!RPC_PATHS.some((path) => pathname.endsWith(path))) return
      let payload = null
      try { payload = request.postDataJSON() } catch { /* malformed payload is reported by the response */ }
      const saleId = payload?.payload?.id ?? payload?.id ?? null
      this.rpcRequests.push({ pathname, saleId, payload: payload?.payload ?? payload, method: request.method(), at: new Date().toISOString(), request })
    })
    this.page.on('request', (request) => {
      let url
      try { url = new URL(request.url()) } catch { return }
      const pathname = url.pathname
      if (!['POST', 'PATCH', 'PUT'].includes(request.method())) return
      let body = null
      try { body = request.postDataJSON() } catch { /* correlation remains available through Quick Order route */ }
      if (pathname.endsWith('/rpc/complete_quick_sales_order')) {
        const payload = body?.payload ?? body
        const order = payload?.order ?? {}
        this.quickOrderWrites.push({ kind: 'quick-order-completion', pathname, method: request.method(), orderId: order.id ?? null, payload, request, at: new Date().toISOString() })
        return
      }
      if (pathname.endsWith('/rpc/activate_financed_order')) {
        this.quickOrderWrites.push({ kind: 'quick-order-financing', pathname, method: request.method(), orderId: body?.p_order_id ?? null, payload: body, request, at: new Date().toISOString() })
        return
      }
      if (!pathname.endsWith('/sales_orders')) return
      const rows = Array.isArray(body) ? body : body ? [body] : []
      for (const row of rows) if (row?.id) this.quickOrderWrites.push({ kind: 'quick-order-row', pathname, method: request.method(), orderId: row.id, payload: row, request, at: new Date().toISOString() })
    })
    this.page.on('request', (request) => {
      let url
      try { url = new URL(request.url()) } catch { return }
      if (!url.pathname.endsWith('/rpc/post_loan_payment') || request.method() !== 'POST') return
      let body = null
      try { body = request.postDataJSON() } catch { /* validation below reports an unreadable RPC payload */ }
      const payload = body?.p_payload ?? body
      this.loanPaymentRequests.push({
        pathname: url.pathname,
        method: request.method(),
        at: new Date().toISOString(),
        payload: payload && typeof payload === 'object' ? {
          workspace_id: payload.workspace_id ?? null,
          loan_id: payload.loan_id ?? null,
          id: payload.id ?? null,
          payment_transaction_id: payload.payment_transaction_id ?? null,
          installment_id: payload.installment_id ?? null,
          amount: payload.amount ?? null,
          payment_method: payload.payment_method ?? null,
          account_id: payload.account_id ?? null,
          account_name_snapshot: payload.account_name_snapshot ?? null,
          created_by: payload.created_by ?? null
        } : null,
        request
      })
    })
    this.page.on('request', (request) => {
      let url
      try { url = new URL(request.url()) } catch { return }
      if (!url.pathname.endsWith('/rest/v1/activity_transactions') || !['POST', 'PATCH'].includes(request.method())) return
      let body = null
      try { body = request.postDataJSON() } catch { /* the persisted row query will diagnose malformed payloads */ }
      const rows = Array.isArray(body) ? body : body ? [body] : []
      for (const row of rows) if (row?.id) this.activityRequests.push({ transactionId: row.id, payload: row, method: request.method(), at: new Date().toISOString() })
    })
  }

  async waitForPosReady() {
    const timeout = 60000
    const search = this.searchInput()
    await search.waitFor({ state: 'visible', timeout })
    await this.storageSelect().waitFor({ state: 'visible', timeout })
  }

  searchInput() {
    const englishSearch = this.page.getByPlaceholder(/search products/i).first()
    return englishSearch
  }

  storageSelect() {
    return this.page.getByTestId('pos-storage-selector')
  }

  async storageOptions(expectedStorageIds = []) {
    const select = this.storageSelect()
    await select.click()
    if (expectedStorageIds.length) {
      await this.page.waitForFunction((expectedIds) => {
        const availableIds = [...document.querySelectorAll('[role="option"][data-storage-id]')]
          .map((row) => row.getAttribute('data-storage-id'))
        return expectedIds.some((id) => availableIds.includes(id))
      }, expectedStorageIds, { timeout: 60000 })
    } else {
      await this.page.getByRole('option').first().waitFor({ state: 'visible' })
    }
    const options = await this.page.getByRole('option').evaluateAll((rows) => rows.map((row) => ({
      id: row.getAttribute('data-storage-id'),
      label: row.innerText.trim()
    })))
    await this.page.keyboard.press('Escape')
    return options.filter((option) => option.id)
  }

  async discoverPaymentMethods() {
    const available = []
    const cash = this.page.getByRole('button', { name: /^Cash$/i }).first()
    if (await cash.isVisible().catch(() => false) && !await cash.isDisabled()) available.push({ id: 'cash', ui: 'cash', label: 'Cash', accountTypes: ['cash_drawer'] })
    const digital = this.page.getByRole('button', { name: /^Digital$/i }).first()
    if (await digital.isVisible().catch(() => false) && !await digital.isDisabled()) {
      await digital.click()
      const providers = { FIB: 'fib', QiCard: 'qicard', ZainCash: 'zaincash', FastPay: 'fastpay' }
      for (const [title, id] of Object.entries(providers)) {
        if (await this.page.locator(`button[title="${title}"]`).isVisible().catch(() => false)) {
          available.push({ id, ui: 'digital', label: title, accountTypes: null })
        }
      }
    }
    const loan = this.page.getByRole('button', { name: /^Loan$/i }).first()
    if (await loan.isVisible().catch(() => false) && !await loan.isDisabled()) available.push({ id: 'loan', ui: 'loan', label: 'Loan', accountTypes: [] })
    if (await cash.isVisible().catch(() => false)) await cash.click()
    return available
  }

  sanitizeDiagnostic(value) {
    let result = String(value ?? '')
    for (const secret of this.diagnosticSecrets) result = result.split(secret).join('[redacted]')
    return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
  }

  safeDiagnosticUrl(value) {
    try {
      const url = new URL(value)
      return `${url.origin}${url.pathname}`
    } catch {
      return '[unparseable URL]'
    }
  }

  recordConsoleDiagnostic(type, message) {
    const safeMessage = this.sanitizeDiagnostic(message).slice(0, 500)
    const key = `${type}:${safeMessage}`
    const prior = this.consoleDiagnosticIndex.get(key)
    if (prior) {
      prior.count += 1
      return
    }
    const entry = { type, message: safeMessage, count: 1 }
    this.consoleDiagnostics.push(entry)
    this.consoleDiagnosticIndex.set(key, entry)
    this.onDiagnostic?.({ level: 'error', message: `Browser ${type}`, details: entry })
  }

  recordNetworkDiagnostic(diagnostic) {
    const key = JSON.stringify(diagnostic)
    const existing = this.networkDiagnostics.get(key)
    if (existing) {
      existing.count += 1
      return
    }
    const entry = { ...diagnostic, count: 1 }
    this.networkDiagnostics.set(key, entry)
    const cancelled = diagnostic.kind === 'request-aborted'
    this.onDiagnostic?.({
      level: cancelled ? 'info' : 'error',
      message: cancelled ? 'Browser request cancelled during navigation' : 'Browser network error',
      details: entry
    })
  }

  getNetworkDiagnostics() {
    return [...this.networkDiagnostics.values()]
  }

  async selectStorage(storageId) {
    const select = this.storageSelect()
    await select.click()
    await this.page.waitForFunction((expectedId) => [...document.querySelectorAll('[role="option"][data-storage-id]')]
      .some((row) => row.getAttribute('data-storage-id') === expectedId), storageId, { timeout: 60000 })
    const option = this.page.locator(`[role="option"][data-storage-id="${storageId}"]`)
    await option.waitFor({ state: 'visible' })
    await option.click()
  }

  async verifyCatalogFixtureVisible(fixture, storageId) {
    await this.selectStorage(storageId)
    await this.searchInput().fill(fixture.name)
    await this.page.getByText(fixture.name, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 })
    await this.searchInput().fill('')
  }

  async findServiceSource(serviceName, physicalStorageIds) {
    const options = await this.storageOptions()
    for (const option of options) {
      if (physicalStorageIds.has(option.id)) continue
      await this.selectStorage(option.id)
      const visibleService = this.page.getByText(serviceName, { exact: true }).first()
      if (await visibleService.isVisible().catch(() => false)) return { id: option.id, name: option.label.replace(/\s*\(System\)\s*/i, '').trim() }
    }
    return null
  }

  async selectablePaymentAccounts(accountRows) {
    const accountSelector = this.paymentAccountSelector()
    await accountSelector.waitFor({ state: 'visible' })
    await accountSelector.click()
    const visibleOptions = await this.page.getByRole('option').evaluateAll((rows) => rows.map((row) => row.innerText.trim()))
    await this.page.keyboard.press('Escape')
    return accountRows.filter((account) => visibleOptions.some((label) => label.includes(account.name)))
  }

  async selectAccount(account) {
    const accountSelector = this.paymentAccountSelector()
    await accountSelector.waitFor({ state: 'visible' })
    await accountSelector.click()
    const option = account?.id
      ? this.page.getByRole('option').filter({ hasText: account.name }).first()
      : this.page.getByRole('option').filter({ hasText: /no account/i }).first()
    await option.waitFor({ state: 'visible' })
    await option.click()
  }

  paymentAccountSelector() {
    const label = this.page.getByText('Payment Account (optional)', { exact: true }).first()
    return label.locator('..').getByRole('combobox')
  }

  async choosePaymentMethod(method, account) {
    if (method.ui === 'cash') {
      await this.page.getByRole('button', { name: /^Cash$/i }).first().click()
    } else if (method.ui === 'digital') {
      await this.page.getByRole('button', { name: /Digital/i }).first().click()
      const providerTitles = { fib: 'FIB', qicard: 'QiCard', zaincash: 'ZainCash', fastpay: 'FastPay' }
      const provider = this.page.locator(`button[title="${providerTitles[method.id]}"]`)
      await provider.waitFor({ state: 'visible' })
      await provider.click()
    } else if (method.ui === 'loan') {
      // Quick Order can be selected by default in a workspace. Loan is a
      // separate payment option that the POS only exposes after leaving that
      // order flow, so switch into the cash payment family before selecting it.
      await this.page.getByRole('button', { name: /^Cash$/i }).first().click()
      await this.page.getByRole('button', { name: /^Loan$/i }).first().click()
    }
    if (method.ui !== 'loan') await this.selectAccount(account)
  }

  async addItem(fixture, sourceId, item) {
    await this.selectStorage(sourceId)
    await this.searchInput().fill(fixture.name)
    const catalogItem = this.page.getByText(fixture.name, { exact: true }).first()
    await catalogItem.waitFor({ state: 'visible' })
    await catalogItem.click()
    const cart = this.page.locator('.contents-container')
    const cartItem = cart.getByText(fixture.name, { exact: true }).first()
    await cartItem.waitFor({ state: 'visible' })
    const card = cartItem.locator('xpath=ancestor::div[contains(@class,"group")][1]')
    if (fixture.itemType === 'Service' || item.dynamicQuantity) {
      const quantityInput = card.locator('input[inputmode="decimal"]').first()
      await quantityInput.fill(String(item.quantity))
      await quantityInput.press('Tab')
    } else {
      for (let count = 1; count < item.quantity; count++) {
        await card.locator('button:has(svg.lucide-plus)').click()
      }
    }
    if (item.price === 'modified' || item.customName) {
      await card.locator('button:has(svg.lucide-pencil)').click()
      const dialog = this.page.getByRole('dialog').last()
      if (item.customName) await dialog.locator('#pos-service-name-suffix').fill(item.additionalName)
      if (item.price === 'modified') await dialog.locator('#pos-negotiated-price').fill(String(fixture.modifiedPrice))
      const save = dialog.getByRole('button', { name: /save|apply|confirm/i }).last()
      await save.waitFor({ state: 'visible' })
      if (await save.isDisabled()) throw new Error('The POS item modification could not be saved because its confirmation action remained disabled.')
      await save.click()
      await dialog.waitFor({ state: 'hidden' })
    }
  }

  async applyDiscount(discount) {
    if (!discount || (!discount.percent && !discount.amount)) return
    await this.page.locator('button[title="Total Discount"]').click()
    // The production POS uses a popover rather than a dialog for the total
    // discount control. Locate its numeric field by its accessible placeholder.
    const input = this.page.getByPlaceholder(/total discount/i).last()
    await input.waitFor({ state: 'visible' })
    if (discount.amount) await this.page.getByRole('button', { name: '$', exact: true }).last().click()
    else await this.page.getByRole('button', { name: '%', exact: true }).last().click()
    await input.fill(String(discount.percent || discount.amount))
    await input.press('Tab')
    await this.page.keyboard.press('Escape')
  }

  checkoutButton(method = null) {
    return method?.ui === 'loan'
      ? this.page.getByRole('button', { name: /process loan/i }).last()
      : this.page.getByRole('button', { name: /checkout/i }).last()
  }

  async openPosLoanDetails(loan) {
    const route = loan.loan_category === 'simple' ? `/loans/${loan.id}` : `/installments/${loan.id}`
    await this.page.goto(this.appUrl(route), { waitUntil: 'commit' })
    await this.page.getByText('Total Principal', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
    const collectButton = this.page.getByRole('button', { name: /^(record collection|record payment|record repayment)$/i }).first()
    await collectButton.waitFor({ state: 'visible', timeout: 20000 })
    const initial = await this.readLoanDetailsState()
    const errors = []
    if (!closeUiAmount(initial.totalRepaid, Number(loan.total_paid_amount))) {
      errors.push(`Loan details showed Total Repaid ${initial.totalRepaid}; expected ${loan.total_paid_amount}.`)
    }
    if (!closeUiAmount(initial.balance, Number(loan.balance_amount))) {
      errors.push(`Loan details showed Balance Due ${initial.balance}; expected ${loan.balance_amount}.`)
    }
    if (!/unpaid|overdue/i.test(initial.installmentText)) {
      errors.push(`The POS loan installment did not begin unpaid/overdue: ${initial.installmentText}`)
    }
    return { passed: errors.length === 0, route, initial, errors }
  }

  async openQuickOrderLoanDetails(loan, orderId, expected) {
    const route = loan.loan_category === 'simple' ? `/loans/${loan.id}` : `/installments/${loan.id}`
    await this.page.goto(this.appUrl(route), { waitUntil: 'commit' })
    await this.page.getByText('Total Principal', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
    const linkedOrder = this.page.getByRole('button', { name: /open order details/i }).first()
    await linkedOrder.waitFor({ state: 'visible', timeout: 20000 })
    await linkedOrder.click()
    await this.page.waitForFunction((expectedId) => decodeURIComponent(window.location.hash).includes(`/orders/${expectedId}`), orderId, { timeout: 30000 })
    const linkedOrderRoute = decodeURIComponent(new URL(this.page.url()).hash)
    await this.page.goto(this.appUrl(route), { waitUntil: 'commit' })
    await this.page.getByText('Total Principal', { exact: true }).waitFor({ state: 'visible', timeout: 30000 })
    const collectButton = this.page.getByRole('button', { name: /^(record collection|record payment|record repayment)$/i }).first()
    await collectButton.waitFor({ state: 'visible', timeout: 20000 })
    const initial = await this.readLoanDetailsState()
    const errors = []
    if (!linkedOrderRoute.includes(`/orders/${orderId}`)) errors.push(`Quick Order loan details linked to ${linkedOrderRoute}; expected order ${orderId}.`)
    if (!closeUiAmount(initial.totalRepaid, Number(expected.totalRepaid))) errors.push(`Quick Order loan details showed Total Repaid ${initial.totalRepaid}; expected ${expected.totalRepaid}.`)
    if (!closeUiAmount(initial.balance, Number(expected.balance))) errors.push(`Quick Order loan details showed Balance Due ${initial.balance}; expected ${expected.balance}.`)
    if (initial.paymentActivityCount !== expected.paymentActivityCount) errors.push(`Quick Order loan details showed ${initial.paymentActivityCount} repayments; expected ${expected.paymentActivityCount}.`)
    if (expected.installmentStatus && !initial.installmentText.toLowerCase().includes(expected.installmentStatus)) {
      errors.push(`Quick Order loan schedule did not show ${expected.installmentStatus}: ${initial.installmentText}`)
    }
    return { passed: errors.length === 0, route, linkedOrderRoute, initial, errors }
  }

  async returnQuickOrderForCleanup(orderId) {
    await this.page.goto(this.appUrl(`/orders/${orderId}`), { waitUntil: 'commit' })
    const returnButton = this.page.getByRole('button', { name: /^Return Order$/i }).first()
    await returnButton.waitFor({ state: 'visible', timeout: 30000 })
    const orderUpdate = this.page.waitForResponse((response) => {
      const request = response.request()
      let url
      try { url = new URL(response.url()) } catch { return false }
      if (!url.pathname.endsWith('/sales_orders') || !['POST', 'PATCH', 'PUT'].includes(request.method())) return false
      if (url.searchParams.get('id') === `eq.${orderId}`) return true
      let payload
      try { payload = request.postDataJSON() } catch { return false }
      return (Array.isArray(payload) ? payload : [payload]).some((row) => row?.id === orderId)
    }, { timeout: 45000 })

    await returnButton.click()
    let dialog = this.page.getByRole('dialog').last()
    await dialog.getByRole('button', { name: /^Continue$/i }).click()
    dialog = this.page.getByRole('dialog').last()
    await dialog.getByRole('button', { name: /^Confirm Return$/i }).click()
    const response = await orderUpdate
    if (!response.ok()) throw new Error(`The POS rejected the full return for test cleanup (HTTP ${response.status()}).`)
    await this.page.getByRole('dialog').last().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
    return {
      orderId,
      returnedThroughPos: true,
      responseStatus: response.status(),
      pageText: (await this.page.locator('body').innerText().catch(() => '')).slice(-1800)
    }
  }

  async readLoanDetailsState() {
    const metric = async (label) => {
      const text = await this.page.getByText(label, { exact: true }).first().locator('xpath=..').innerText().catch(() => '')
      return { value: displayedAmount(text, label), text }
    }
    const [repaid, balance] = await Promise.all([metric('Total Repaid'), metric('Balance Due')])
    const installmentText = await this.page.locator('tbody tr').first().innerText().catch(() => '')
    const paymentActivityCount = await this.page.getByText('Payment Received', { exact: true }).count().catch(() => 0)
    return {
      totalRepaid: repaid.value,
      totalRepaidText: repaid.text,
      balance: balance.value,
      balanceText: balance.text,
      installmentText,
      paymentActivityCount
    }
  }

  async removeCartFixture(fixture) {
    const cart = this.page.locator('.contents-container')
    const item = cart.getByText(fixture.name, { exact: true }).last()
    if (!await item.count()) return
    const card = item.locator('xpath=ancestor::div[contains(@class,"group")][1]')
    const remove = card.locator('button').last()
    await remove.waitFor({ state: 'visible' })
    await remove.click()
    await item.waitFor({ state: 'detached', timeout: 15000 })
    if (await cart.getByText(fixture.name, { exact: true }).count()) {
      throw new Error(`Quick Order discovery did not remove its test-owned cart probe ${fixture.name}.`)
    }
  }

  async submitLoanPayment(amount, currency, loanId) {
    this.loanPaymentRequests = []
    const openButton = this.page.getByRole('button', { name: /^(record collection|record payment|record repayment)$/i }).first()
    await openButton.click()
    const dialog = this.page.getByRole('dialog').last()
    await dialog.waitFor({ state: 'visible' })
    const amountInput = dialog.locator('#loan-payment-amount')
    await amountInput.waitFor({ state: 'visible' })
    await amountInput.fill(String(amount))
    const assertRequestedAmountRemains = async () => {
      const inputValue = await amountInput.inputValue()
      const submittedValue = Number(inputValue.replace(/,/g, ''))
      if (!Number.isFinite(submittedValue) || !closeUiAmount(submittedValue, amount)) {
        throw new Error(`Loan payment form showed ${JSON.stringify(inputValue)} after requesting ${amount} ${currency}; refusing to submit a different amount.`)
      }
    }
    await assertRequestedAmountRemains()

    // The payment dialog defaults to Cash and no account. The observed RPC
    // verifies these real UI defaults rather than setting database state.
    const save = dialog.getByRole('button', { name: /^Save$/i })
    await save.waitFor({ state: 'visible' })
    if (await save.isDisabled()) throw new Error(`Loan payment dialog disabled Save for valid amount ${amount} ${currency}.`)
    await assertRequestedAmountRemains()
    const requestPromise = this.page.waitForRequest((request) => {
      try { return new URL(request.url()).pathname.endsWith('/rpc/post_loan_payment') } catch { return false }
    }, { timeout: 30000 })
    await save.click()
    const request = await requestPromise
    const response = await request.response()
    const responseText = response ? await response.text().catch(() => '') : ''
    const dialogClosed = response?.ok()
      ? await dialog.waitFor({ state: 'hidden', timeout: 30000 }).then(() => true).catch(() => false)
      : false
    const observation = this.loanPaymentRequests.find((entry) => entry.request === request) ?? this.loanPaymentRequests.at(-1) ?? null
    const payload = observation?.payload ?? null
    const errors = []
    if (!response?.ok()) errors.push(`post_loan_payment returned ${response?.status() ?? 'no response'}: ${responseText.slice(0, 800)}`)
    if (response?.ok() && !dialogClosed) errors.push('Loan payment RPC succeeded but the payment dialog did not close.')
    if (this.loanPaymentRequests.length !== 1) errors.push(`Expected exactly one loan payment RPC request; observed ${this.loanPaymentRequests.length}.`)
    if (!payload) errors.push('The loan repayment RPC payload could not be observed safely.')
    else {
      for (const [field, expected, actual] of [
        ['loan_id', loanId, payload.loan_id],
        ['amount', amount, Number(payload.amount)],
        ['payment_method', 'cash', payload.payment_method],
        ['account_id', null, payload.account_id],
        ['account_name_snapshot', null, payload.account_name_snapshot]
      ]) if (actual !== expected) errors.push(`Loan payment UI submitted ${field}=${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`)
      if (payload.id == null) errors.push('Loan payment RPC omitted its client-generated payment ID.')
    }
    return {
      passed: errors.length === 0,
      requestedAmount: amount,
      currency,
      payload,
      httpStatus: response?.status() ?? null,
      response: this.sanitizeDiagnostic(responseText).slice(0, 500),
      uiFeedback: { dialogClosed },
      visibleDialogText: dialogClosed ? null : this.sanitizeDiagnostic(await dialog.innerText().catch(() => '')).slice(0, 800),
      errors
    }
  }

  async waitForLoanDetailsState(expected) {
    await this.page.waitForFunction(({ expectedState }) => {
      const readAmount = (label) => {
        const node = [...document.querySelectorAll('*')].find((element) => element.children.length === 0 && element.textContent?.trim() === label)
        const text = node?.parentElement?.innerText?.replace(label, '') ?? ''
        const value = text.match(/-?\d[\d,]*(?:\.\d+)?/)?.[0]
        return value ? Number(value.replace(/,/g, '')) : Number.NaN
      }
      const repaid = readAmount('Total Repaid')
      const balance = readAmount('Balance Due')
      const payments = [...document.querySelectorAll('*')].filter((element) => element.children.length === 0 && element.textContent?.trim() === 'Payment Received').length
      const installmentText = document.querySelector('tbody tr')?.innerText?.toLowerCase() ?? ''
      const same = (actual, target) => Number.isFinite(actual) && Math.abs(actual - Number(target)) <= 0.001
      return same(repaid, expectedState.totalRepaid)
        && same(balance, expectedState.balance)
        && payments === expectedState.paymentActivityCount
        && (!expectedState.installmentStatus || installmentText.includes(expectedState.installmentStatus))
    }, { expectedState: expected }, { timeout: 30000 }).catch(() => {})
    const actual = await this.readLoanDetailsState()
    const errors = []
    if (!closeUiAmount(actual.totalRepaid, Number(expected.totalRepaid))) errors.push(`Total Repaid UI amount ${actual.totalRepaid} did not equal ${expected.totalRepaid}.`)
    if (!closeUiAmount(actual.balance, Number(expected.balance))) errors.push(`Balance Due UI amount ${actual.balance} did not equal ${expected.balance}.`)
    if (actual.paymentActivityCount !== expected.paymentActivityCount) errors.push(`Loan details showed ${actual.paymentActivityCount} Payment Received activity rows; expected ${expected.paymentActivityCount}.`)
    if (expected.installmentStatus && !actual.installmentText.toLowerCase().includes(expected.installmentStatus)) {
      errors.push(`Loan installment UI did not show ${expected.installmentStatus}: ${actual.installmentText}`)
    }
    return { passed: errors.length === 0, expected, actual, errors }
  }

  async fillLoanRegistration() {
    const dialog = this.page.getByRole('dialog').last()
    await dialog.waitFor({ state: 'visible' })
    const fieldInput = (label) => dialog.getByText(label, { exact: false })
      .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " gap-2 ")][1]')
      .locator('input:visible').first()
    const borrowerName = fieldInput('Borrower Name')
    const borrowerPhone = fieldInput('Borrower Phone')
    const borrowerAddress = fieldInput('Borrower Address')
    const repaymentCount = fieldInput('Repayment Count')
    for (const [label, input] of [
      ['Borrower Name', borrowerName],
      ['Borrower Phone', borrowerPhone],
      ['Borrower Address', borrowerAddress],
      ['Repayment Count', repaymentCount]
    ]) {
      if (await input.count() !== 1) throw new Error(`Could not resolve exactly one visible POS Loan field for ${label}.`)
    }
    await borrowerName.fill('Atlas POS test borrower')
    await borrowerPhone.fill('0000000000')
    await borrowerAddress.fill('Cloud Hybrid Playwright test address')
    await repaymentCount.fill('1')
    const submit = dialog.getByRole('button', { name: /create sale loan/i })
    await submit.waitFor({ state: 'visible' })
    if (await submit.isDisabled()) throw new Error('The POS loan confirmation stayed disabled after the required borrower fields were filled.')
    return submit
  }

  async performCheckout(scenario, fixtures) {
    this.rpcRequests = []
    await this.page.keyboard.press('Escape')
    for (const item of scenario.items) {
      const fixture = fixtures.get(item.fixtureId)
      await this.addItem(fixture, item.storageId ?? scenario.source.id, item)
    }
    await this.applyDiscount(scenario.discount)
    await this.choosePaymentMethod(scenario.payment, scenario.account ?? null)
    const cartTextBeforeCheckout = await this.page.locator('.contents-container').innerText().catch(() => '')
    for (const item of scenario.items) {
      const fixture = fixtures.get(item.fixtureId)
      if (!cartTextBeforeCheckout.includes(fixture.name)) throw new Error(`The POS cart UI did not display the selected test item ${fixture.name}.`)
      if (item.customName && !cartTextBeforeCheckout.includes(item.additionalName)) throw new Error(`The POS cart UI did not display the selected custom name ${item.additionalName}.`)
    }
    const totalLabel = this.page.getByText(/^Total$/i).first()
    const displayedTotalText = await totalLabel.locator('xpath=..').innerText().catch(() => '')

    const checkout = this.checkoutButton(scenario.payment)
    await checkout.waitFor({ state: 'visible' })
    if (await checkout.isDisabled()) throw new Error('POS checkout is disabled for a generated valid scenario.')

    if (scenario.duplicateSubmit) {
      await checkout.click()
      await checkout.evaluate((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })))
    } else {
      await checkout.click()
    }

    if (scenario.payment.ui === 'loan') {
      const submitLoan = await this.fillLoanRegistration()
      // Register request observation before the final user action can submit.
      await submitLoan.click()
    }

    await this.page.getByText('Cart is empty', { exact: true }).waitFor({ state: 'visible', timeout: 20000 })
    const successDialog = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('button', { name: /continue sale/i })
    }).last()
    await successDialog.waitFor({ state: 'visible' })
    const successDialogText = await successDialog.innerText().catch(() => '')
    if (!/sale successful/i.test(successDialogText)) {
      throw new Error(`The POS did not show its successful-checkout state: ${successDialogText.slice(0, 500)}`)
    }
    const requestRecords = this.rpcRequests.filter((entry) => entry.request)
    const responses = await Promise.all(requestRecords.map((entry) => entry.request.response().catch(() => null)))
    const successfulResponseIndex = responses.findIndex((candidate) => candidate?.ok())
    const requestIndex = successfulResponseIndex >= 0 ? successfulResponseIndex : requestRecords.length - 1
    const requestRecord = requestRecords[requestIndex] ?? this.rpcRequests.at(-1) ?? null
    const saleRequest = requestRecord?.request ?? null
    const response = requestIndex >= 0 ? responses[requestIndex] : null
    if (saleRequest && successfulResponseIndex < 0) {
      const responseBody = response ? await response.text().catch(() => '') : ''
      throw new Error(`POS checkout request failed with ${response?.status() ?? 'no response'}: ${responseBody.slice(0, 1000)}`)
    }
    const rpcBody = response ? await response.json().catch(() => null) : null
    const saleId = requestRecord?.saleId ?? rpcBody?.sale_id ?? rpcBody?.payment_transaction?.source_record_id ?? null
    await successDialog.getByRole('button', { name: /continue sale/i }).click()
    await successDialog.waitFor({ state: 'hidden' })
    const saveBorrowerPrompt = this.page.getByRole('dialog').filter({ hasText: /save as business partner/i }).last()
    if (await saveBorrowerPrompt.isVisible().catch(() => false)) {
      await saveBorrowerPrompt.getByRole('button', { name: /^skip$/i }).click()
      await saveBorrowerPrompt.waitFor({ state: 'hidden' })
    }
    return {
      saleId, rpcPath: requestRecord?.pathname ?? null, rpcBody,
      requestPayload: requestRecord?.payload ?? null,
      requestCount: this.rpcRequests.length,
      checkoutRequestObserved: !!requestRecord,
      cartTextBeforeCheckout, displayedTotalText, successDialogText, uiSuccess: true
    }
  }

  async performActivityCheckout(scenario, fixtures) {
    this.activityRequests = []
    for (const item of scenario.items) {
      const fixture = fixtures.get(item.fixtureId)
      await this.addItem(fixture, item.storageId ?? scenario.source.id, item)
    }
    await this.choosePaymentMethod(scenario.payment, scenario.account ?? null)
    const cartTextBeforeCheckout = await this.page.locator('.contents-container').innerText().catch(() => '')
    for (const item of scenario.items) {
      const fixture = fixtures.get(item.fixtureId)
      if (!cartTextBeforeCheckout.includes(fixture.name)) throw new Error(`The POS cart UI did not display selected activity ${fixture.name}.`)
    }
    const totalLabel = this.page.getByText(/^Total$/i).first()
    const displayedTotalText = await totalLabel.locator('xpath=..').innerText().catch(() => '')
    const checkout = this.checkoutButton()
    await checkout.waitFor({ state: 'visible' })
    if (await checkout.isDisabled()) throw new Error('Activity checkout is disabled for a generated valid scenario.')
    await checkout.click()
    await this.page.getByText('Cart is empty', { exact: true }).waitFor({ state: 'visible', timeout: 20000 })
    const successDialogs = this.page.getByRole('dialog')
    const successDialog = successDialogs.last()
    await successDialog.waitFor({ state: 'visible' })
    const successDialogText = await successDialog.innerText().catch(() => '')
    const continueSale = successDialog.getByRole('button', { name: /continue sale/i })
    if (await continueSale.isVisible().catch(() => false)) {
      await continueSale.click()
      await successDialog.waitFor({ state: 'hidden' })
    }
    const transactionId = this.activityRequests.at(-1)?.transactionId ?? null
    if (!transactionId) throw new Error('Activity checkout completed in the UI without a correlated transaction write.')
    return {
      saleId: transactionId, transactionId, requestCount: this.activityRequests.length,
      cartTextBeforeCheckout, displayedTotalText, successDialogText, uiSuccess: true
    }
  }

  async openQuickOrderModal() {
    const orderButtons = this.page.getByRole('button', { name: /^Order$/i })
    await orderButtons.first().waitFor({ state: 'visible' })
    // The first Order button selects the Quick Order checkout mode; the last
    // is its primary action. Selecting the mode twice is harmless when the
    // dedicated workspace already defaults to Order.
    await orderButtons.first().click()
    await orderButtons.last().click()
    const dialog = this.page.getByRole('dialog').filter({ has: this.page.locator('#quick-order-payment') }).last()
    await dialog.waitFor({ state: 'visible', timeout: 20000 })
    // QuickOrderModal initializes its controlled fields in an effect when it
    // opens. Let that commit settle before the driver types; otherwise the
    // effect can clear the first keystroke/value and prevent submission.
    await this.page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))
    return dialog
  }

  async prepareQuickOrderDiscovery(fixture, storageId, customer) {
    await this.addItem(fixture, storageId, {
      fixtureId: fixture.id, itemType: fixture.itemType, storageId,
      quantity: 1, price: 'original', customName: false
    })
    const dialog = await this.openQuickOrderModal()
    if (customer) {
      // Create the run-owned customer through the cashier-facing compact form
      // inside Quick Order, and ensure the new partner is selected on the order.
      await dialog.getByRole('button', { name: /^Add Customer$/i }).click()
      const compactDialog = this.page.getByRole('dialog').filter({ has: this.page.locator('#compact-business-partner-name') }).last()
      await compactDialog.waitFor({ state: 'visible', timeout: 20000 })
      await compactDialog.locator('#compact-business-partner-name').fill(customer.name)
      await compactDialog.locator('#compact-business-partner-phone').fill(customer.phone)
      await compactDialog.locator('#compact-business-partner-address').fill(customer.address)
      const createCustomer = compactDialog.getByRole('button', { name: /^Create$/i })
      await createCustomer.waitFor({ state: 'visible' })
      if (await createCustomer.isDisabled()) throw new Error('The Quick Order compact customer form did not enable Create after its required fields were filled.')
      await createCustomer.click()
      await compactDialog.waitFor({ state: 'hidden', timeout: 30000 })
      await dialog.getByText(customer.name, { exact: true }).waitFor({ state: 'visible', timeout: 20000 })
    }
    const methodTrigger = dialog.locator('#quick-order-payment')
    await methodTrigger.click()
    await this.page.locator('[role="option"]:visible').first().waitFor({ state: 'visible' })
    const visibleMethodOptions = this.page.locator('[role="option"]:visible')
    const options = await visibleMethodOptions.evaluateAll((rows) => rows.map((row) => ({
      id: row.getAttribute('data-value'),
      label: row.innerText.trim()
    })).filter((row) => row.id !== '__none__' && row.label && row.label.toLowerCase() !== 'none'))
    for (const option of options) option.id ??= quickOrderOptionId({ getAttribute: () => null, innerText: option.label })
    await this.page.keyboard.press('Escape')

    const readAccounts = async () => {
      const label = dialog.locator('label').filter({ hasText: /Payment Account/i }).last()
      if (!await label.count()) return []
      await label.waitFor({ state: 'visible', timeout: 20000 })
      const selector = label.locator('xpath=..').getByRole('combobox').last()
      await selector.waitFor({ state: 'visible', timeout: 20000 })
      await selector.click()
      await this.page.locator('[role="option"]:visible').first().waitFor({ state: 'visible', timeout: 20000 })
      const choices = await this.page.locator('[role="option"]:visible').evaluateAll((rows) => rows.map((row) => ({
        id: row.getAttribute('data-value'),
        label: row.innerText.trim()
      })).filter((row) => row.id && row.id !== '__none__'))
      await this.page.keyboard.press('Escape')
      return choices
    }
    if (!options.some((option) => option.id === 'cash')) {
      throw new Error(`Quick Order payment method list did not expose Cash: ${JSON.stringify(options)}`)
    }
    await this.quickOrderSelectValue(dialog, '#quick-order-payment', 'cash')
    const selectedCash = (await methodTrigger.innerText()).trim()
    if (!/cash/i.test(selectedCash)) throw new Error(`Quick Order did not retain the Cash method after selection: ${selectedCash}`)
    const cashAccounts = await readAccounts()
    const generalMethod = options.find((option) => option.id === 'bank_transfer')
      ?? options.find((option) => option.id && option.id !== 'cash' && option.id !== 'loan' && option.id !== 'installments')
    if (generalMethod) {
      await this.quickOrderSelectValue(dialog, '#quick-order-payment', generalMethod.id)
    }
    const generalAccounts = await readAccounts()
    await dialog.getByRole('button', { name: /^Cancel$/i }).click()
    await dialog.waitFor({ state: 'hidden' })
    // Canceling Quick Order leaves the POS cart intact by design. Remove the
    // dedicated discovery item through the cashier-facing cart control so it
    // cannot contaminate later scenarios.
    await this.removeCartFixture(fixture)
    this.quickOrderPreparedFixtureId = null
    await this.returnToPos()
    return { options, cashAccounts, generalAccounts }
  }

  async quickOrderSelectValue(dialog, selector, value) {
    const trigger = dialog.locator(selector)
    await trigger.click()
    const visibleOptions = this.page.locator('[role="option"]:visible')
    await visibleOptions.first().waitFor({ state: 'visible' })
    const optionRows = await visibleOptions.evaluateAll((rows) => rows.map((row) => ({
      id: row.getAttribute('data-value'), label: row.innerText.trim()
    })))
    const optionIndex = optionRows.findIndex((row) => (row.id ?? quickOrderOptionId({ getAttribute: () => null, innerText: row.label })) === value)
    if (optionIndex < 0) throw new Error(`Quick Order selector ${selector} did not expose ${value}: ${JSON.stringify(optionRows)}`)
    await visibleOptions.nth(optionIndex).click()
    const expectedText = ({
      cash: 'cash', bank_transfer: 'bank transfer', loan: 'loan', installments: 'installments',
      paid: 'paid', unpaid: 'unpaid', partial: 'partial', pending: 'pending', draft: 'draft', completed: 'completed'
    })[value] ?? value
    await this.page.waitForFunction(({ selector: triggerSelector, expected }) => {
      const element = document.querySelector(triggerSelector)
      return Boolean(element?.innerText?.toLowerCase().includes(expected.toLowerCase()))
    }, { selector, expected: expectedText }, { timeout: 10000 })
  }

  async selectQuickOrderDueDate(dialog, selector, dateValue) {
    const trigger = dialog.locator(selector)
    await trigger.click()
    const direct = this.page.locator(`[data-day="${dateValue}"]`)
    if (await direct.count()) {
      await direct.first().click()
      return
    }
    const [year, month, day] = dateValue.split('-').map(Number)
    const monthName = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(year, month - 1, day))
    const accessibleDate = new RegExp(`${monthName}\\s+${day}(?:st|nd|rd|th)?[,]?\\s+${year}`, 'i')
    const dateButton = this.page.getByRole('button').filter({ hasText: accessibleDate }).last()
    await dateButton.waitFor({ state: 'visible' })
    await dateButton.click()
  }

  async performQuickOrder(scenario, fixtures) {
    this.quickOrderWrites = []
    const fixture = fixtures.get(scenario.fixtureId)
    if (!fixture) throw new Error(`Quick Order test fixture ${scenario.fixtureId} is unavailable.`)
    if (this.quickOrderPreparedFixtureId !== fixture.id) {
      await this.addItem(fixture, scenario.source.id, {
        fixtureId: fixture.id, itemType: fixture.itemType, storageId: scenario.source.id,
        quantity: 1, price: 'original', customName: false
      })
    }
    this.quickOrderPreparedFixtureId = null
    const dialog = await this.openQuickOrderModal()
    const customerInput = dialog.getByPlaceholder(/^Select Customer$/i)
    if (scenario.negativeKind !== 'missing-customer') {
      const customerName = scenario.customer.name
      await customerInput.fill(customerName)
      await this.page.waitForFunction(({ expectedName }) => {
        const input = document.querySelector('[role="dialog"] input[placeholder="Select Customer"]')
        return input instanceof HTMLInputElement && input.value === expectedName
      }, { expectedName: customerName }, { timeout: 5000 })
      // PartnerAutocompleteInput renders a button in a Radix popover portal
      // outside the Quick Order dialog. Match its exact visible partner-name
      // node, then click the owning button; that avoids depending on the
      // combined accessible name that also includes phone and role labels.
      const customerNameNode = this.page.getByText(customerName, { exact: true }).last()
      const customerOption = customerNameNode.locator('xpath=ancestor::button[1]')
      try {
        await customerOption.waitFor({ state: 'visible', timeout: 20000 })
      } catch (cause) {
        const inputValue = await customerInput.inputValue().catch(() => '')
        const matchingButtons = await this.page.locator('button').evaluateAll((buttons, name) => buttons
          .filter((button) => {
            const rect = button.getBoundingClientRect()
            const style = window.getComputedStyle(button)
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          })
          .map((button) => (button.innerText ?? '').replace(/\s+/g, ' ').trim())
          .filter((text) => text.includes(name))
          .slice(-5), customerName).catch(() => [])
        throw new Error(`Quick Order customer suggestion did not appear after entering ${JSON.stringify(customerName)} (input value: ${JSON.stringify(inputValue)}; matching visible text: ${JSON.stringify(matchingButtons)}): ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      await customerOption.click()
      await dialog.getByText(scenario.customer.name, { exact: true }).waitFor({ state: 'visible' })
    }

    if (scenario.orderStatus !== 'completed') await this.quickOrderSelectValue(dialog, '#quick-order-status', scenario.orderStatus)
    if (scenario.method) await this.quickOrderSelectValue(dialog, '#quick-order-payment', scenario.method.id)
    if (scenario.paymentStatus) {
      const status = dialog.locator('#quick-order-payment-status')
      if (!await status.isDisabled()) {
        const current = await status.getAttribute('data-value')
        if (current !== scenario.paymentStatus) await this.quickOrderSelectValue(dialog, '#quick-order-payment-status', scenario.paymentStatus)
      }
    }

    if (scenario.method?.id === 'loan' && scenario.paymentStatus === 'partial') {
      await dialog.locator('#quick-order-loan-initial-payment').fill(String(scenario.initialPaymentAmount))
    }
    if (scenario.method?.id === 'loan' && scenario.firstDueDate) {
      await this.selectQuickOrderDueDate(dialog, '#quick-order-loan-first-due', scenario.firstDueDate)
    }
    if (scenario.method?.id === 'installments') {
      await dialog.locator('#quick-order-installment-count').fill(String(scenario.installmentCount ?? 3))
      await this.quickOrderSelectValue(dialog, '#quick-order-installment-frequency', scenario.installmentFrequency ?? 'monthly')
      await dialog.locator('#quick-order-initial-payment').fill(String(scenario.initialPaymentAmount ?? 0))
      if (scenario.firstDueDate) await this.selectQuickOrderDueDate(dialog, '#quick-order-first-due', scenario.firstDueDate)
    }

    const paymentAccountLabel = dialog.locator('label').filter({ hasText: /Payment Account/i }).last()
    if (await paymentAccountLabel.count()) {
      const accountTrigger = paymentAccountLabel.locator('xpath=..').getByRole('combobox')
      await accountTrigger.waitFor({ state: 'visible' })
      const selectedAccountText = (await accountTrigger.innerText()).trim()
      if (scenario.account?.id && !selectedAccountText.includes(scenario.account.name)) {
        await accountTrigger.click()
        const accountOption = this.page.locator(`[role="option"][data-value="${scenario.account.id}"]:visible`)
        await accountOption.waitFor({ state: 'visible' })
        await accountOption.click()
      } else if (!scenario.account?.id && !/no account|ledger only/i.test(selectedAccountText)) {
        await accountTrigger.click()
        let noAccountOption = this.page.locator('[role="option"][data-value="__none__"]:visible')
        if (!await noAccountOption.count()) {
          noAccountOption = this.page.getByRole('option').filter({ hasText: /no account|ledger only/i }).last()
        }
        await noAccountOption.waitFor({ state: 'visible' })
        await noAccountOption.click()
      }
    } else if (scenario.account?.id) {
      throw new Error(`Quick Order did not expose the required payment account ${scenario.account.name}.`)
    }

    const submit = dialog.getByRole('button', { name: /Save Order/i })
    await submit.waitFor({ state: 'visible' })
    if (scenario.negative) {
      const disabled = await submit.isDisabled()
      const alert = await dialog.getByRole('alert').innerText().catch(() => '')
      return {
        passed: disabled,
        expected: scenario.expectedUi,
        actual: {
          saveOrderDisabled: disabled,
          validationMessage: alert || null,
          orderModalVisible: await dialog.isVisible(),
          selectedMethod: await dialog.locator('#quick-order-payment').innerText().catch(() => ''),
          selectedOrderStatus: await dialog.locator('#quick-order-status').innerText().catch(() => ''),
          selectedPaymentStatus: await dialog.locator('#quick-order-payment-status').innerText().catch(() => '')
        },
        orderId: null,
        disabled
      }
    }
    if (await submit.isDisabled()) {
      await this.page.waitForFunction(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .reverse()
          .find((element) => element.querySelector('#quick-order-payment'))
        const button = [...(dialog?.querySelectorAll('button') ?? [])]
          .find((element) => /save order/i.test(element.textContent ?? ''))
        return button instanceof HTMLButtonElement && !button.disabled
      }, null, { timeout: 5000 }).catch(() => {})
    }
    if (await submit.isDisabled()) {
      const alert = await dialog.getByRole('alert').innerText().catch(() => '')
      const formState = await dialog.evaluate((element) => {
        const field = (selector) => {
          const control = element.querySelector(selector)
          return control ? {
            text: control.textContent?.trim() ?? '',
            disabled: control instanceof HTMLButtonElement ? control.disabled : null
          } : null
        }
        const customerInput = element.querySelector('[placeholder="Select Customer"]')
        const save = [...element.querySelectorAll('button')].find((button) => /save order/i.test(button.textContent ?? ''))
        return {
          customerValue: customerInput instanceof HTMLInputElement ? customerInput.value : null,
          linkedCounterparty: [...element.querySelectorAll('div')]
            .find((node) => /linked business partners/i.test(node.textContent ?? '') && node.children.length > 1)
            ?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
          orderStatus: field('#quick-order-status'),
          paymentStatus: field('#quick-order-payment-status'),
          paymentMethod: field('#quick-order-payment'),
          saveOrderDisabled: save instanceof HTMLButtonElement ? save.disabled : null,
          disabledControls: [...element.querySelectorAll('button[disabled]')]
            .map((button) => ({ id: button.id || null, label: button.textContent?.trim() ?? '' }))
            .slice(0, 12)
        }
      }).catch(() => null)
      throw new Error(`The valid Quick Order form remained disabled${alert ? `: ${alert}` : ''}${formState ? `; form state: ${JSON.stringify(formState)}` : '.'}`)
    }

    const selectedMethod = await dialog.locator('#quick-order-payment').innerText().catch(() => '')
    const selectedOrderStatus = await dialog.locator('#quick-order-status').innerText().catch(() => '')
    const selectedPaymentStatus = await dialog.locator('#quick-order-payment-status').innerText().catch(() => '')
    const accountLabel = dialog.locator('label').filter({ hasText: /Payment Account/i }).last()
    let selectedAccount = 'No Account'
    if (await accountLabel.count()) selectedAccount = await accountLabel.locator('xpath=..').getByRole('combobox').last().innerText().catch(() => 'No Account')
    const expectedMethodLabel = scenario.method.label
    if (!selectedMethod.toLowerCase().includes(expectedMethodLabel.toLowerCase())) {
      throw new Error(`Quick Order UI selected payment method ${selectedMethod}; expected ${expectedMethodLabel}.`)
    }
    if (!selectedOrderStatus.toLowerCase().includes(scenario.orderStatus)) {
      throw new Error(`Quick Order UI selected order status ${selectedOrderStatus}; expected ${scenario.orderStatus}.`)
    }
    const expectedPaymentLabel = scenario.paymentStatus === 'partial' ? /partial/i
      : new RegExp(scenario.paymentStatus, 'i')
    if (!expectedPaymentLabel.test(selectedPaymentStatus)) {
      throw new Error(`Quick Order UI selected payment status ${selectedPaymentStatus}; expected ${scenario.paymentStatus}.`)
    }
    if (scenario.account?.name && !selectedAccount.includes(scenario.account.name)) {
      throw new Error(`Quick Order UI selected account ${selectedAccount}; expected ${scenario.account.name}.`)
    }
    if (!scenario.account?.name && await accountLabel.count() && !/no account|ledger only/i.test(selectedAccount)) {
      throw new Error(`Quick Order UI retained payment account ${selectedAccount} for a No Account scenario.`)
    }

    await submit.click()
    const successDialog = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('button', { name: /Open Order Details/i })
    }).last()
    await successDialog.waitFor({ state: 'visible', timeout: 45000 })
    const successText = await successDialog.innerText().catch(() => '')
    const orderNumber = successText.match(/SO-[A-Z0-9-]+/i)?.[0] ?? null
    const statusMatches = scenario.orderStatus === 'completed'
      ? /Order Completed/i.test(successText)
      : /Order Saved/i.test(successText)
    if (!statusMatches) throw new Error(`Quick Order success UI did not reflect ${scenario.orderStatus}: ${successText.slice(0, 700)}`)
    const detailsButton = successDialog.getByRole('button', { name: /Open Order Details/i })
    await detailsButton.click()
    await this.page.waitForFunction(() => /\/orders\/[0-9a-f-]{36}/i.test(decodeURIComponent(window.location.hash)), null, { timeout: 30000 })
    const hash = decodeURIComponent(new URL(this.page.url()).hash)
    const orderId = hash.match(/\/orders\/([0-9a-f-]{36})/i)?.[1] ?? null
    if (!orderId) throw new Error(`Quick Order details UI did not expose an order id: ${hash}`)
    await this.page.getByText(orderNumber ?? orderId, { exact: false }).first().waitFor({ state: 'visible', timeout: 30000 })
    const detailsText = await this.page.locator('body').innerText().catch(() => '')
    const missingDetails = [scenario.customer.name, fixture.name].filter((text) => !detailsText.includes(text))
    const formattedTotal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(Number(fixture.price))
    if (!detailsText.includes(formattedTotal)) missingDetails.push(`total ${formattedTotal}`)
    if (missingDetails.length) throw new Error(`Quick Order Details omitted expected persisted UI detail(s): ${missingDetails.join(', ')}.`)
    await this.page.reload({ waitUntil: 'domcontentloaded' })
    await this.page.getByText(fixture.name, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 })
    const detailsAfterReload = await this.page.locator('body').innerText().catch(() => '')
    const reloadMissing = [scenario.customer.name, fixture.name, formattedTotal].filter((text) => !detailsAfterReload.includes(text))
    if (reloadMissing.length) throw new Error(`Reloaded Quick Order Details omitted expected value(s): ${reloadMissing.join(', ')}.`)
    return {
      orderId,
      orderNumber,
      uiSuccess: true,
      successText,
      detailsText: detailsText.slice(-2200),
      detailsAfterReload: detailsAfterReload.slice(-2200),
      formState: { selectedMethod, selectedPaymentStatus, selectedOrderStatus, selectedAccount },
      orderDetailsPassed: true,
      requestCount: this.quickOrderWrites.length,
      writes: this.quickOrderWrites.map(({ kind, pathname, method, orderId: requestOrderId, payload }) => ({ kind, pathname, method, orderId: requestOrderId, payload }))
    }
  }

  async prepareRejectedCheckout(scenario, fixture) {
    await this.addItem(fixture, scenario.storage.id, {
      fixtureId: fixture.id, itemType: fixture.itemType, storageId: scenario.storage.id,
      quantity: 1, price: 'original', customName: false
    })
    await this.choosePaymentMethod({ ui: 'cash' }, null)
    const checkout = this.checkoutButton()
    await checkout.waitFor({ state: 'visible' })
    return { buttonDisabled: await checkout.isDisabled() }
  }

  async attemptRejectedCheckout() {
    this.rpcRequests = []
    const checkout = this.checkoutButton()
    if (await checkout.isDisabled()) return { passed: false, error: 'The POS blocked the stale cart before it could reach the server.' }
    const requestPromise = this.page.waitForRequest((request) => {
      let pathname = ''
      try { pathname = new URL(request.url()).pathname } catch { return false }
      return RPC_PATHS.some((path) => pathname.endsWith(path))
    }, { timeout: 20000 }).then(
      (request) => ({ request }),
      (error) => ({ error })
    )
    // Atlas toasts are short-lived and may be removed before the RPC response
    // body is read. Observe the actual toast viewport before submit and retain
    // the rendered text as soon as Radix inserts its open toast node.
    const toastObservation = this.page.evaluate(() => {
      const key = '__cloudHybridPlaywrightToastObservation'
      const state = { text: '', observer: null }
      const capture = () => {
      const roots = [...document.querySelectorAll('[role="region"][aria-label^="Notifications"] [data-state="open"]')]
        const text = roots.map((root) => root.innerText?.trim()).filter(Boolean).join('\n')
        if (text) {
          state.text = text
          state.observer?.disconnect()
        }
      }
      state.observer = new MutationObserver(capture)
      window[key] = state
      state.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
      capture()
    }).then(() => this.page.waitForFunction(() => window.__cloudHybridPlaywrightToastObservation?.text || false, null, { timeout: 15000 })
      .then((handle) => handle.jsonValue())
      .catch(() => ''))
    await checkout.click()
    const requestObservation = await requestPromise
    if (requestObservation.error) {
      throw new Error(`The POS did not submit its rejected checkout request: ${requestObservation.error.message}`)
    }
    const request = requestObservation.request
    const response = await request.response()
    const responseBody = response ? await response.text().catch(() => '') : ''
    const toastText = await toastObservation
    const pageText = await this.page.locator('body').innerText().catch(() => '')
    const errorFeedback = toastText ? [toastText] : []
    const cartStillPresent = await this.page.locator('.contents-container').getByText(/CHPW/i).count().catch(() => 0)
    const successDialogCount = await this.page.getByRole('dialog').count().catch(() => 0)
    const passed = !!response && !response.ok() && cartStillPresent > 0 && this.rpcRequests.length === 1 && errorFeedback.length > 0 && successDialogCount === 0
    const requestRecord = this.rpcRequests.find((entry) => entry.saleId)
    return {
      passed,
      expected: 'Server rejects stale stock or unavailable product; cart remains and no success dialog appears.',
      actual: { httpStatus: response?.status() ?? null, response: responseBody.slice(0, 1000), cartStillPresent, requestCount: this.rpcRequests.length, errorFeedback, successDialogCount, pageErrorVisible: pageText.slice(-1200) },
      saleId: requestRecord?.saleId ?? null
    }
  }

  async verifyReloadedInventory(source, fixture, expectedQuantity) {
    await this.returnToPos()
    await this.selectStorage(source.id)
    await this.searchInput().fill(fixture.name)
    const item = this.page.locator(`[data-testid="pos-product-card"][data-product-id="${fixture.id}"]`)
    await item.waitFor({ state: 'visible' })
    const quantity = item.getByTestId('pos-product-quantity')
    const actualQuantityText = (await quantity.innerText()).trim()
    const quantityValue = actualQuantityText.match(/[\d,]+(?:\.\d+)?/)?.[0] ?? ''
    const actualQuantity = Number(quantityValue.replace(/,/g, ''))
    return { passed: actualQuantity === expectedQuantity, expectedQuantity, actualQuantity, actualQuantityText }
  }

  async verifyReloadedActivityAvailability(source, fixture, expectedQuantity) {
    await this.selectStorage(source.id)
    await this.searchInput().fill(fixture.name)
    const item = this.page.getByText(fixture.name, { exact: true }).first()
    await item.waitFor({ state: 'visible' })
    const card = item.locator('xpath=ancestor::div[contains(@class,"group")][1]')
    const cardText = (await card.innerText()).replace(/\s+/g, ' ').trim()
    const containsQuantity = new RegExp(`(?:^|\\D)${expectedQuantity}(?:\\D|$)`).test(cardText)
    return { passed: containsQuantity, expectedQuantity, actualCardText: cardText }
  }

  async verifySaleHistory(saleId, expected, fixtures, scenario) {
    await this.page.getByText('Sales History', { exact: true }).first().click()
    await this.page.waitForFunction(() => window.location.hash.includes('/sales'), null, { timeout: 30000 })
    await this.page.getByText(/Recent Sales/i).first().waitFor({ state: 'visible', timeout: 20000 })
    await this.page.getByRole('button', { name: /Filters/i }).first().click()
    const filters = this.page.getByRole('dialog').last()
    const search = filters.getByPlaceholder(/Search ID, invoice, name/i)
    await search.waitFor({ state: 'visible' })
    await search.fill(saleId)
    await filters.getByRole('button', { name: /Apply Filters/i }).click()
    await this.page.getByText(/1 Sales Found/i).waitFor({ state: 'visible', timeout: 20000 })
    const saleRow = this.page.locator('tbody tr').first()
    await saleRow.waitFor({ state: 'visible', timeout: 20000 })
    const view = saleRow.locator('button[title*="detail" i]').first()
    await view.waitFor({ state: 'visible', timeout: 20000 })
    const listText = await this.page.locator('body').innerText()
    const totalText = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(expected.total)
    const errors = []
    if (!listText.includes(totalText)) errors.push(`Sales History did not display expected total ${totalText}.`)
    let detailText = ''
    if (scenario.domain === 'activity') {
      await view.click()
      await this.page.waitForFunction(() => window.location.hash.includes('/activities'), null, { timeout: 30000 })
      detailText = await this.page.locator('body').innerText()
      if (!detailText.includes(saleId) && !detailText.includes(expected.transactionNo ?? '')) {
        // The route may identify activity records by their printable transaction number.
        if (expected.transactionNo) errors.push('The Activities detail route did not show the correlated transaction reference.')
      }
    } else {
      await view.click()
      const details = this.page.getByRole('dialog').last()
      await details.waitFor({ state: 'visible' })
      detailText = await details.innerText()
      const missingItems = scenario.items
        .map((item) => fixtures.get(item.fixtureId))
        .filter((fixture) => !detailText.includes(fixture.name))
        .map((fixture) => fixture.name)
      if (missingItems.length) errors.push(`Sales History details omitted test item(s): ${missingItems.join(', ')}.`)
      if (!detailText.includes(totalText)) errors.push(`Sales History details did not display expected total ${totalText}.`)
      await this.page.keyboard.press('Escape')
      await details.waitFor({ state: 'hidden' })
    }
    await this.returnToPos()
    return { passed: errors.length === 0, saleId, itemNames: scenario.items.map((item) => fixtures.get(item.fixtureId).name), expectedTotal: expected.total, actualDetailsText: detailText.slice(0, 1800), errors }
  }

  async returnToPos() {
    await this.dismissCompletedSaleDialog()
    await this.page.goto(this.appUrl('/pos'), { waitUntil: 'commit' })
    await this.waitForPosReady()
  }

  async dismissCompletedSaleDialog() {
    const successDialog = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('button', { name: /continue sale/i })
    }).last()
    if (!await successDialog.isVisible().catch(() => false)) return
    const continueSale = successDialog.getByRole('button', { name: /continue sale/i })
    if (await continueSale.isVisible().catch(() => false) && !await continueSale.isDisabled().catch(() => true)) {
      await continueSale.click()
      await successDialog.waitFor({ state: 'hidden', timeout: 10000 })
    }
  }

  async resetPosContext(scenarioId = null, expectedInventoryRows = [], fixtures = new Map()) {
    let tracePath = null
    const nextScenarioNumber = this.completedScenarios + 1
    const scheduledRestart = nextScenarioNumber % this.browserRestartInterval === 0
    if (scenarioId) {
      const traceName = scenarioId.replace(/[^a-zA-Z0-9_-]/g, '_')
      tracePath = `${this.artifactDirectory}/${traceName}-trace.zip`
    } else if (scheduledRestart) {
      const sessionNumber = Math.floor(nextScenarioNumber / this.browserRestartInterval)
      tracePath = `${this.artifactDirectory}/headed-session-${sessionNumber}-trace.zip`
    }
    if (!this.isBrowserSessionClosed()) {
      try {
        if (tracePath) await this.context.tracing.stop({ path: tracePath })
        else await this.context.tracing.stop()
      } catch (error) {
        if (!this.isBrowserSessionClosed()) throw error
        this.onDiagnostic?.({
          level: 'warning',
          message: 'The headed browser closed before its trace could be finalized; reopening it after cleanup.',
          details: { completedScenarios: nextScenarioNumber }
        })
      }
    }
    let inventoryVerification
    let tracingStartedByRestart = false
    try {
      this.completedScenarios = nextScenarioNumber
      if (scheduledRestart || this.isBrowserSessionClosed()) {
        const reason = this.isBrowserSessionClosed()
          ? 'headed browser closed during a scenario'
          : `scheduled after ${this.completedScenarios} scenarios`
        await this.restartBrowserSession(reason)
        tracingStartedByRestart = true
      } else {
        try {
          await this.reloadPosForCleanup()
        } catch (error) {
          if (!this.hasBrowserResourceExhaustion() && !this.isBrowserSessionClosed()) throw error
          this.onDiagnostic?.({
            level: 'warning',
            message: 'Restarting the headed browser after Chromium closed or reported resource exhaustion while reloading POS.',
            details: { completedScenarios: this.completedScenarios, error: error instanceof Error ? error.message : String(error) }
          })
          const reason = this.isBrowserSessionClosed()
            ? 'headed browser closed during POS reload'
            : 'Chromium resource exhaustion during POS reload'
          await this.restartBrowserSession(reason)
          tracingStartedByRestart = true
        }
      }
      inventoryVerification = await this.verifyCleanupInventory(expectedInventoryRows, fixtures)
      return { tracePath, inventoryVerification }
    } finally {
      // open() starts tracing for the replacement browser context.
      if (!tracingStartedByRestart && this.context) {
        await this.context.tracing.start({ screenshots: false, snapshots: false, sources: false })
      }
    }
  }

  async reloadPosForCleanup() {
    await this.dismissCompletedSaleDialog()
    const destination = new URL(this.appUrl('/pos'))
    const current = new URL(this.page.url())
    const alreadyOnPos = current.origin === destination.origin
      && decodeURIComponent(current.hash).replace(/\/$/, '').endsWith('/pos')
    if (alreadyOnPos) await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
    else await this.page.goto(destination.toString(), { waitUntil: 'commit' })
    // Use one fresh document load after cleanup, then compare the rendered
    // inventory quantities with the independently verified database baseline.
    await this.dismissCompletedSaleDialog()
    await this.waitForPosReady()
  }

  hasBrowserResourceExhaustion() {
    const networkFailure = [...this.networkDiagnostics.values()]
      .some((entry) => entry.kind === 'request-failed' && /ERR_INSUFFICIENT_RESOURCES/i.test(entry.failure ?? ''))
    const consoleFailure = this.consoleDiagnostics
      .some((entry) => /ERR_INSUFFICIENT_RESOURCES/i.test(entry.message ?? ''))
    return networkFailure || consoleFailure
  }

  isBrowserSessionClosed() {
    return !this.browser?.isConnected()
      || !this.context || this.context.isClosed()
      || !this.page || this.page.isClosed()
  }

  async restartBrowserSession(reason) {
    this.onDiagnostic?.({
      level: 'info',
      message: 'Opening a fresh headed browser session to keep repeated POS reloads isolated.',
      details: { reason }
    })
    await this.context?.close().catch(() => {})
    await this.browser?.close().catch(() => {})
    this.context = null
    this.browser = null
    this.page = null
    await this.open()
  }

  async verifyCleanupInventory(rows, fixtures) {
    const checked = []
    for (const row of rows ?? []) {
      const fixture = fixtures.get(row.product_id)
      if (!fixture || fixture.itemType !== 'Product') continue
      await this.selectStorage(row.storage_id)
      await this.searchInput().fill(fixture.name)
      const card = this.page.locator(`[data-testid="pos-product-card"][data-product-id="${fixture.id}"]`)
      await card.waitFor({ state: 'visible', timeout: 30000 })
      await this.page.waitForFunction(({ selector, expected }) => {
        const badge = document.querySelector(selector)?.querySelector('[data-testid="pos-product-quantity"]')
        const value = badge?.textContent?.match(/[\d,]+(?:\.\d+)?/)?.[0]?.replace(/,/g, '')
        return value != null && Number(value) === Number(expected)
      }, { selector: `[data-testid="pos-product-card"][data-product-id="${fixture.id}"]`, expected: row.quantity }, { timeout: 30000 })
      const actualText = (await card.getByTestId('pos-product-quantity').innerText()).trim()
      checked.push({ productId: fixture.id, storageId: row.storage_id, expectedQuantity: Number(row.quantity), actualQuantityText: actualText })
      await this.searchInput().fill('')
    }
    return { passed: true, checked }
  }

  async attemptEmptyCart() {
    this.rpcRequests = []
    // Workspaces may open POS in Quick Order mode, whose action is labelled
    // "Order". Cash mode exposes the standard checkout action used for sales.
    await this.page.getByRole('button', { name: /^Cash$/i }).first().click()
    const checkout = this.checkoutButton()
    await checkout.waitFor({ state: 'visible' })
    const blocked = await checkout.isDisabled()
    if (!blocked) await checkout.click()
    return { passed: blocked, expected: 'checkout disabled for an empty cart', actual: blocked ? 'disabled' : 'enabled', requestCount: this.rpcRequests.length }
  }

  async pageScreenshot(scenarioId) {
    const fileName = `${scenarioId.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`
    const path = `${this.artifactDirectory}/${fileName}`
    await this.page.screenshot({ path, fullPage: true }).catch(() => {})
    return path
  }

  async saveTrace() {
    const path = `${this.artifactDirectory}/playwright-trace.zip`
    await this.context?.tracing.stop({ path }).catch(() => {})
    return path
  }

  async close() {
    await this.context?.close().catch(() => {})
    await this.browser?.close().catch(() => {})
  }
}
