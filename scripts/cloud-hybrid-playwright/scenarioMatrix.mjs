import { randomInt } from 'node:crypto'

const PAYMENT_METHODS = [
  { id: 'cash', ui: 'cash', label: 'Cash', accountTypes: ['cash_drawer'] },
  { id: 'fib', ui: 'digital', label: 'FIB', accountTypes: null },
  { id: 'qicard', ui: 'digital', label: 'QiCard', accountTypes: null },
  { id: 'zaincash', ui: 'digital', label: 'ZainCash', accountTypes: null },
  { id: 'fastpay', ui: 'digital', label: 'FastPay', accountTypes: null },
  { id: 'loan', ui: 'loan', label: 'Loan', accountTypes: [] }
]

const NO_ACCOUNT = Object.freeze({ id: null, name: 'No Account' })

export function selectPaymentMethodsForCloudHybridRun(paymentMethods = PAYMENT_METHODS, preferredDigitalMethodId = null) {
  const digitalMethods = paymentMethods.filter((method) => method.ui === 'digital')
  const selectedDigitalPaymentMethod = digitalMethods.length
    ? digitalMethods.find((method) => method.id === preferredDigitalMethodId)
      ?? digitalMethods[randomInt(digitalMethods.length)]
    : null

  return {
    paymentMethods: paymentMethods.filter((method) => method.ui !== 'digital'
      || method.id === selectedDigitalPaymentMethod?.id),
    selectedDigitalPaymentMethod
  }
}

function compatibleAccount(method, accounts) {
  if (method.accountTypes?.length === 0) return null
  return accounts.find((account) => !method.accountTypes || method.accountTypes.includes(account.accountType)) ?? null
}

function lineFor(source, fixture, overrides = {}) {
  return {
    fixtureId: fixture.id,
    itemName: fixture.name,
    itemType: fixture.itemType,
    storageId: source.id,
    storageName: source.name,
    currency: String(fixture.currency).toLowerCase(),
    basePrice: fixture.price,
    quantity: 1,
    price: 'original',
    customName: false,
    additionalName: null,
    ...overrides
  }
}

function labelCart(items, discount) {
  const types = [...new Set(items.map((item) => item.itemType))].join(' + ')
  const storages = [...new Set(items.map((item) => item.storageName))].join(' + ')
  const names = [...new Set(items.map((item) => item.itemName))].join(' + ')
  const currencies = [...new Set(items.map((item) => String(item.currency).toUpperCase()))].join(' + ')
  const modifiers = items.map((item) => [
    item.quantity > 1 ? `Quantity ${item.quantity}` : null,
    item.price === 'modified' ? 'Modified Price' : null,
    item.customName ? 'Additional Name' : null
  ].filter(Boolean).join(' + ') || 'Original Price').join(' / ')
  const discountLabel = discount?.percent ? `Cart Discount ${discount.percent}%`
    : discount?.amount ? `Cart Discount ${discount.amount} fixed` : null
  return [storages, names, currencies, types, modifiers, discountLabel].filter(Boolean).join(' | ')
}

function discountOptions(maxDiscountPercent, items, settlementCurrency) {
  const percent = Math.min(10, Math.max(0, Number(maxDiscountPercent) || 0))
  const subtotal = items.reduce((sum, item) => sum + Number(item.basePrice) * item.quantity, 0)
  const fixedPercent = subtotal > 0 ? 5 / subtotal * 100 : Infinity
  const fixedEligible = items.every((item) => item.currency === settlementCurrency)
    && fixedPercent <= Number(maxDiscountPercent)
  return [
    ...(percent > 0 ? [{ id: `percent-${percent}`, percent, amount: 0 }] : []),
    ...(fixedEligible ? [{ id: 'fixed-5', percent: 0, amount: 5 }] : [])
  ]
}

function preferredFixture(fixtures, preferredCurrency) {
  return fixtures.find((fixture) => String(fixture.currency).toLowerCase() === preferredCurrency)
    ?? fixtures[0]
    ?? null
}

function scenarioKey({ items, payment, account, discount, domain }) {
  return JSON.stringify({
    items: items.map(({ fixtureId, quantity, price, customName, additionalName }) => ({ fixtureId, quantity, price, customName, additionalName })),
    payment: payment.id,
    account: account?.id ?? null,
    discount: discount?.id ?? 'none',
    domain: domain ?? 'sale'
  })
}

/**
 * Build a constrained coverage matrix from live POS choices and test-owned
 * fixtures. This intentionally covers business rules instead of taking a
 * Cartesian product of fixture aliases, line modifiers, tenders, and accounts.
 */
export function buildCloudHybridScenarioMatrix({
  storages,
  serviceSource,
  productsByStorage,
  services,
  service,
  activitySource,
  activities = [],
  paymentAccounts = [],
  paymentMethods: discoveredPaymentMethods = PAYMENT_METHODS,
  maxDiscountPercent = 100,
  settlementCurrency = 'usd',
  currencyConversionEnabled = true
}) {
  // Keep all generated cases on one randomly selected digital provider so a
  // provider-specific failure does not cascade across the rest of the matrix.
  const { paymentMethods } = selectPaymentMethodsForCloudHybridRun(discoveredPaymentMethods)
  const settlement = String(settlementCurrency).toLowerCase()
  const scenarios = []
  const byKey = new Map()
  const add = ({ items, payment, account = NO_ACCOUNT, discount = null, domain = 'sale', coverage }) => {
    if (!items.length || !payment) return null
    const key = scenarioKey({ items, payment, account, discount, domain })
    const existing = byKey.get(key)
    if (existing) {
      for (const tag of coverage) if (!existing.coverage.includes(tag)) existing.coverage.push(tag)
      return existing
    }
    const name = `${labelCart(items, discount)} | ${payment.label} | ${account?.name ?? 'No Account'} | Checkout`
    const scenario = {
      id: `${domain === 'activity' ? 'activity' : 'checkout'}-${String(scenarios.length + 1).padStart(3, '0')}`,
      name,
      domain,
      source: {
        id: items.length === 1 ? items[0].storageId : null,
        name: [...new Set(items.map((item) => item.storageName))].join(' + ')
      },
      itemTypes: [...new Set(items.map((item) => item.itemType))],
      items: items.map((item) => ({ ...item })),
      payment,
      account: account ?? NO_ACCOUNT,
      discount,
      duplicateSubmit: false,
      coverage: [...new Set(coverage)]
    }
    scenarios.push(scenario)
    byKey.set(key, scenario)
    return scenario
  }

  const storageFixtures = storages.map((storage) => ({
    storage,
    fixtures: productsByStorage.get(storage.id) ?? []
  })).filter(({ fixtures }) => fixtures.length)
  const primaryStorage = storageFixtures[0]
  const productFor = (storageEntry, currency = settlement) => preferredFixture(storageEntry?.fixtures ?? [], currency)
  const sourceFor = (storage, fixture) => ({ id: storage.id, name: storage.name, fixture })
  const productBase = primaryStorage ? productFor(primaryStorage) : null
  const serviceFixtures = services?.length ? services : (service ? [service] : [])
  const serviceBase = preferredFixture(serviceFixtures, settlement)
  const activityBase = activities.find((fixture) => !fixture.isInfinite) ?? activities[0] ?? null

  const getNoAccountOrRequired = (method) => {
    if (!method.requiresAccount) return NO_ACCOUNT
    return compatibleAccount(method, paymentAccounts)
  }

  // Every selectable tender is exercised against each supported POS item
  // domain using the default workspace currency and no account where allowed.
  if (productBase && primaryStorage) {
    const source = sourceFor(primaryStorage.storage, productBase)
    for (const method of paymentMethods) {
      const account = getNoAccountOrRequired(method)
      if (!account) continue
      add({ items: [lineFor(source, productBase)], payment: method, account, coverage: ['payment-method', 'product-checkout'] })
    }
  }
  if (serviceBase && serviceSource) {
    const source = { id: serviceSource.id, name: serviceSource.name, fixture: serviceBase }
    for (const method of paymentMethods) {
      const account = getNoAccountOrRequired(method)
      if (!account) continue
      add({ items: [lineFor(source, serviceBase)], payment: method, account, coverage: ['payment-method', 'service-checkout'] })
    }
  }

  const cash = paymentMethods.find((method) => method.id === 'cash') ?? paymentMethods[0]
  const accountlessCash = cash && !cash.requiresAccount ? cash : null

  // Storage coverage is linear: one baseline sale per POS-selectable stock
  // storage verifies its own inventory path without generating every pair.
  if (accountlessCash) for (const entry of storageFixtures.slice(1)) {
    const fixture = productFor(entry)
    if (!fixture) continue
    add({
      items: [lineFor(sourceFor(entry.storage, fixture), fixture)], payment: accountlessCash,
      coverage: ['storage-inventory']
    })
  }

  if (productBase && primaryStorage && accountlessCash) {
    const productSource = sourceFor(primaryStorage.storage, productBase)
    const productLine = (overrides = {}) => lineFor(productSource, productBase, overrides)

    // Product modifiers are covered as rule cases, including the meaningful
    // quantity × negotiated-price interaction, without all pairwise variants.
    add({ items: [productLine({ quantity: 2 })], payment: accountlessCash, coverage: ['product-quantity'] })
    add({ items: [productLine({ price: 'modified' })], payment: accountlessCash, coverage: ['product-modified-price'] })
    add({ items: [productLine({ quantity: 2, price: 'modified' })], payment: accountlessCash, coverage: ['quantity-modified-price-interaction'] })

    const percentDiscount = discountOptions(maxDiscountPercent, [productLine()], settlement)[0]
    if (percentDiscount) add({ items: [productLine()], payment: accountlessCash, discount: percentDiscount, coverage: ['percentage-discount'] })
    const fixedDiscount = discountOptions(maxDiscountPercent, [productLine()], settlement).find((discount) => discount.amount)
    if (fixedDiscount) add({ items: [productLine()], payment: accountlessCash, discount: fixedDiscount, coverage: ['fixed-discount'] })

    // Same-source two-product checkout is included only when setup deliberately
    // created the second default-currency catalog fixture.
    const companion = primaryStorage.fixtures.find((fixture) => fixture.id !== productBase.id
      && String(fixture.currency).toLowerCase() === settlement)
    if (companion) add({
      items: [productLine(), lineFor(productSource, companion)], payment: accountlessCash,
      coverage: ['multi-product-cart']
    })

    // One representative cross-storage cart checks preservation of each line's
    // inventory source; individual storages still receive their own baseline.
    const secondaryStorage = storageFixtures.slice(1).find((entry) => productFor(entry)?.currency?.toLowerCase() === settlement)
    if (secondaryStorage) {
      const secondProduct = productFor(secondaryStorage)
      add({
        items: [productLine(), lineFor(sourceFor(secondaryStorage.storage, secondProduct), secondProduct)],
        payment: accountlessCash,
        coverage: ['cross-storage-cart']
      })
    }
  }

  if (serviceBase && serviceSource && accountlessCash) {
    const source = { id: serviceSource.id, name: serviceSource.name, fixture: serviceBase }
    const serviceLine = (overrides = {}) => lineFor(source, serviceBase, overrides)
    add({ items: [serviceLine({ quantity: 2 })], payment: accountlessCash, coverage: ['service-quantity'] })
    add({ items: [serviceLine({ price: 'modified' })], payment: accountlessCash, coverage: ['service-modified-price'] })
    add({ items: [serviceLine({ customName: true, additionalName: 'Cloud Hybrid visit' })], payment: accountlessCash, coverage: ['service-additional-name'] })
    add({
      items: [serviceLine({ price: 'modified', customName: true, additionalName: 'Cloud Hybrid visit' })],
      payment: accountlessCash,
      coverage: ['service-modified-price-and-name']
    })
    const percentDiscount = discountOptions(maxDiscountPercent, [serviceLine()], settlement)[0]
    if (percentDiscount) add({ items: [serviceLine()], payment: accountlessCash, discount: percentDiscount, coverage: ['service-discount'] })
  }

  if (productBase && serviceBase && primaryStorage && serviceSource && accountlessCash) {
    add({
      items: [
        lineFor(sourceFor(primaryStorage.storage, productBase), productBase),
        lineFor({ id: serviceSource.id, name: serviceSource.name }, serviceBase)
      ],
      payment: accountlessCash,
      coverage: ['mixed-product-service-cart']
    })
  }

  // Currency behavior is tested once per source currency and item domain.
  // A single multi-currency basket additionally verifies one transaction can
  // reconcile multiple exchange snapshots together.
  if (currencyConversionEnabled && accountlessCash) {
    const currencies = [...new Set([
      ...storageFixtures.flatMap((entry) => entry.fixtures.map((fixture) => String(fixture.currency).toLowerCase())),
      ...serviceFixtures.map((fixture) => String(fixture.currency).toLowerCase())
    ])].sort()
    for (const currency of currencies.filter((value) => value !== settlement)) {
      const entry = storageFixtures.find((candidate) => candidate.fixtures.some((fixture) => String(fixture.currency).toLowerCase() === currency))
      const fixture = entry && productFor(entry, currency)
      if (fixture) add({
        items: [lineFor(sourceFor(entry.storage, fixture), fixture)], payment: accountlessCash,
        coverage: ['product-currency-conversion']
      })
      const serviceFixture = serviceFixtures.find((candidate) => String(candidate.currency).toLowerCase() === currency)
      if (serviceFixture && serviceSource) add({
        items: [lineFor({ id: serviceSource.id, name: serviceSource.name }, serviceFixture)],
        payment: accountlessCash,
        coverage: ['service-currency-conversion']
      })
    }

    const currencyFixtures = [...new Set(currencies)].map((currency) => {
      const entry = storageFixtures.find((candidate) => candidate.fixtures.some((fixture) => String(fixture.currency).toLowerCase() === currency))
      const fixture = entry && productFor(entry, currency)
      return entry && fixture ? lineFor(sourceFor(entry.storage, fixture), fixture) : null
    }).filter(Boolean)
    if (currencyFixtures.length > 1) add({
      items: currencyFixtures, payment: accountlessCash,
      coverage: ['mixed-currency-cart', 'exchange-snapshot-reconciliation']
    })
  }

  // Each selectable account is exercised once on a compatible tender. Account
  // choices are not multiplied across every item, modifier, and payment method.
  if (productBase && primaryStorage) for (const account of paymentAccounts) {
    const method = paymentMethods.find((candidate) => candidate.accountTypes?.length !== 0
      && (!candidate.accountTypes || candidate.accountTypes.includes(account.accountType)))
    if (!method) continue
    add({
      items: [lineFor(sourceFor(primaryStorage.storage, productBase), productBase)],
      payment: method,
      account,
      coverage: ['payment-account-selection']
    })
  }

  // Activities use their own POS route and tables. Exercise every visible
  // non-loan tender on the finite activity type, then the unlimited behavior
  // and one finite/unlimited mixed cart.
  if (activitySource && activities.length) {
    const activityMethods = paymentMethods.filter((method) => method.ui === 'cash' || method.ui === 'digital')
    const finite = activities.find((fixture) => !fixture.isInfinite) ?? activities[0]
    const unlimited = activities.find((fixture) => fixture.isInfinite)
    if (finite) {
      for (const method of activityMethods) {
        const account = getNoAccountOrRequired(method)
        if (!account) continue
        add({
          items: [lineFor(activitySource, finite)], payment: method, account, domain: 'activity',
          coverage: ['activity-payment-method', 'finite-activity']
        })
      }
      const activityLine = (fixture, overrides = {}) => lineFor(activitySource, fixture, overrides)
      add({ items: [activityLine(finite, { quantity: 2 })], payment: accountlessCash ?? activityMethods[0], domain: 'activity', coverage: ['activity-quantity'] })
      add({ items: [activityLine(finite, { price: 'modified' })], payment: accountlessCash ?? activityMethods[0], domain: 'activity', coverage: ['activity-modified-price'] })
      if (unlimited) add({
        items: [activityLine(unlimited, { quantity: 2 })], payment: accountlessCash ?? activityMethods[0],
        domain: 'activity', coverage: ['unlimited-activity']
      })
      if (unlimited && unlimited.id !== finite.id) add({
        items: [activityLine(finite), activityLine(unlimited)], payment: accountlessCash ?? activityMethods[0],
        domain: 'activity', coverage: ['mixed-activity-cart']
      })
    }
  }

  for (const method of paymentMethods) {
    for (const [tag, available] of [
      ['product-checkout', !!productBase],
      ['service-checkout', !!(serviceBase && serviceSource)]
    ]) {
      if (available && !scenarios.some((scenario) => scenario.payment.id === method.id && scenario.coverage.includes(tag))) {
        throw new Error(`Scenario matrix omitted ${method.label} × ${tag}; check required-account compatibility and fixture setup.`)
      }
    }
  }

  return scenarios
}

export function summarizeScenarioCoverage(scenarios) {
  const coverage = {}
  for (const scenario of scenarios) for (const tag of scenario.coverage ?? []) coverage[tag] = (coverage[tag] ?? 0) + 1
  return {
    total: scenarios.length,
    byDomain: Object.fromEntries([...new Set(scenarios.map((scenario) => scenario.domain ?? 'sale'))]
      .map((domain) => [domain, scenarios.filter((scenario) => (scenario.domain ?? 'sale') === domain).length])),
    coverage,
    accountsExercised: scenarios.filter((scenario) => scenario.coverage?.includes('payment-account-selection')).length
  }
}

export function buildNegativeScenarioMatrix({ storages, productsByStorage }) {
  const firstStorage = storages[0]
  const firstProduct = firstStorage ? (productsByStorage.get(firstStorage.id) ?? [])[0] : null
  return [
    { id: 'negative-empty-cart', name: 'POS | Empty Cart | Checkout blocked | Supabase unchanged', kind: 'empty-cart' },
    ...(firstStorage && firstProduct ? [
      { id: 'negative-insufficient-stock', name: `${firstStorage.name} | ${firstProduct.currency.toUpperCase()} | Product | Stale cart after stock reaches zero | Cash | No Account | Checkout blocked`, kind: 'insufficient-stock', storage: firstStorage, fixtureId: firstProduct.id },
      { id: 'negative-unavailable-product', name: `${firstStorage.name} | ${firstProduct.currency.toUpperCase()} | Product | Unavailable after add to cart | Cash | No Account | Checkout rejected`, kind: 'unavailable-product', storage: firstStorage, fixtureId: firstProduct.id }
    ] : [])
  ]
}

export const cloudHybridPaymentMethods = PAYMENT_METHODS.map(({ id, label, ui }) => ({ id, label, ui, accountTypes: PAYMENT_METHODS.find((method) => method.id === id)?.accountTypes ?? null }))
