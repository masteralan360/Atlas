function roundCurrency(amount, currency) {
  return currency === 'iqd' ? Math.round(amount) : Math.round((amount + Number.EPSILON) * 100) / 100
}

function conversionRate(exchangeRows, fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return 1
  const graph = new Map()
  for (const row of exchangeRows) {
    const baseCurrency = String(row.base_currency).toLowerCase()
    const quoteCurrency = String(row.quote_currency).toLowerCase()
    const base = Number(row.base_amount)
    const quote = Number(row.quote_amount)
    if (!baseCurrency || !quoteCurrency || !(base > 0 && quote > 0)) continue
    const add = (from, to, rate) => graph.set(from, [...(graph.get(from) ?? []), { currency: to, rate }])
    add(baseCurrency, quoteCurrency, quote / base)
    add(quoteCurrency, baseCurrency, base / quote)
  }
  const queue = [{ currency: fromCurrency, rate: 1 }]
  const visited = new Set([fromCurrency])
  while (queue.length) {
    const current = queue.shift()
    for (const edge of graph.get(current.currency) ?? []) {
      if (visited.has(edge.currency)) continue
      const rate = current.rate * edge.rate
      if (edge.currency === toCurrency) return rate
      visited.add(edge.currency)
      queue.push({ currency: edge.currency, rate })
    }
  }
  return null
}

export function calculateExpectedCheckout(scenario, fixtures, {
  settlementCurrency,
  exchangeRows = [],
  conversionApplied = false,
  checkoutTimestamp = null
}) {
  const lines = scenario.items.map((item) => {
    const fixture = fixtures.get(item.fixtureId)
    if (!fixture) throw new Error(`Scenario references missing test fixture ${item.fixtureId}.`)
    const sourceUnitPrice = item.price === 'modified' ? fixture.modifiedPrice : fixture.price
    return { item, fixture, sourceUnitPrice, quantity: item.quantity }
  })

  // The production POS applies a fixed cart discount as a percentage of its
  // converted, pre-discount subtotal, then negotiates each source-currency line.
  const conversionRates = lines.map((line) => conversionRate(exchangeRows, line.fixture.currency, settlementCurrency))
  if (conversionRates.some((rate) => rate === null) && conversionApplied) {
    throw new Error('The checkout has no captured exchange snapshot for a required currency conversion.')
  }
  const convertedSubtotal = lines.reduce((sum, line, index) => {
    const factor = conversionRates[index] ?? 1
    return sum + roundCurrency(line.fixture.price * factor, settlementCurrency) * line.quantity
  }, 0)
  const explicitDiscountPercent = Number(scenario.discount?.percent ?? 0)
  const discountPercent = explicitDiscountPercent > 0
    ? explicitDiscountPercent
    : (scenario.discount?.amount && convertedSubtotal > 0
      ? Number(scenario.discount.amount) / convertedSubtotal * 100
      : 0)

  const expectedLines = lines.map((line, index) => {
    const sourceCurrency = String(line.fixture.currency).toLowerCase()
    const factor = conversionRates[index] ?? 1
    const effectiveSourceUnitPrice = line.sourceUnitPrice * (1 - discountPercent / 100)
    const convertedUnitPrice = roundCurrency(effectiveSourceUnitPrice * factor, settlementCurrency)
    const sourceTotal = effectiveSourceUnitPrice * line.quantity
    const lineTotal = convertedUnitPrice * line.quantity
    const negotiated = line.item.price === 'modified' || discountPercent > 0
    return {
      fixtureId: line.fixture.id,
      productId: line.fixture.id,
      itemType: line.item.itemType,
      storageId: line.item.itemType === 'Service' ? null : line.fixture.storageId,
      quantity: line.quantity,
      inventoryQuantity: line.item.itemType === 'Service' ? 0 : line.quantity,
      originalUnitPrice: line.fixture.price,
      sourceUnitPrice: line.sourceUnitPrice,
      effectiveSourceUnitPrice,
      sourceTotal,
      negotiatedPrice: negotiated ? effectiveSourceUnitPrice : null,
      currency: sourceCurrency,
      convertedUnitPrice,
      lineTotal,
      expectedCostPrice: line.fixture.costPrice,
      expectedConvertedCostPrice: roundCurrency(line.fixture.costPrice * factor, settlementCurrency),
      customName: line.item.customName ? line.item.additionalName : null
    }
  })

  const payableTotal = expectedLines.reduce((sum, line) => sum + line.lineTotal, 0)

  return {
    workspaceId: scenario.workspaceId,
    origin: 'pos',
    cashierId: scenario.cashierId,
    currency: settlementCurrency,
    paymentMethod: scenario.payment.id,
    paymentAccountId: scenario.account.id,
    paymentAccountName: scenario.account.name,
    total: payableTotal,
    // The sales schema stores the amount due (after cart discount) in both
    // total_amount and original_total_amount. Keep the undiscounted subtotal
    // as an independent expected value for diagnostics and line reconciliation.
    originalTotal: payableTotal,
    grossSubtotal: convertedSubtotal,
    lines: expectedLines,
    discountPercent,
    conversionApplied,
    exchangeRows,
    checkoutTimestamp
  }
}

export function compareScalar(label, expected, actual) {
  if (expected === actual) return null
  return { field: label, expected, actual }
}

export function compareNumber(label, expected, actual, tolerance = 0.000001) {
  const number = Number(actual)
  if (Number.isFinite(number) && Math.abs(expected - number) <= tolerance) return null
  return { field: label, expected, actual }
}
