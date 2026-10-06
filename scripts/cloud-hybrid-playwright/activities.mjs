import { randomUUID } from 'node:crypto'

const MARKER = 'atlas-cloud-hybrid-playwright'
const PRICE = 100
const MODIFIED_PRICE = 120
const FINITE_SEED = 50
const journals = new Map()

function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data ?? []
}

function roundAmount(value, currency) {
  return currency === 'iqd' ? Math.round(value) : Math.round((value + Number.EPSILON) * 100) / 100
}

export async function prepareOwnedActivities(context, runId) {
  const { supabase, workspace, user } = context
  const journal = []
  journals.set(runId, journal)
  const currency = String(workspace.default_currency ?? 'usd').toLowerCase()
  const fixtures = []
  for (const mode of [
    { name: 'Finite', is_infinite: false, available_quantity: FINITE_SEED },
    { name: 'Unlimited', is_infinite: true, available_quantity: null }
  ]) {
    const row = {
      id: randomUUID(), workspace_id: workspace.id,
      name: `CHPW ${runId.slice(0, 8)} ${mode.name} Activity`,
      default_unit_price: PRICE, currency, is_infinite: mode.is_infinite,
      available_quantity: mode.available_quantity, is_active: true, created_by: user.id, is_deleted: false
    }
    const inserted = await supabase.schema('activities').from('activity_catalog').insert(row).select('*').single()
    if (inserted.error || !inserted.data) throw new Error(`Could not prepare a test-owned ${mode.name.toLowerCase()} Activities fixture: ${inserted.error?.message ?? 'no catalog row returned'}`)
    journal.push(inserted.data.id)
    fixtures.push({
      id: inserted.data.id, name: inserted.data.name, itemType: 'Activity', activityId: inserted.data.id,
      price: PRICE, modifiedPrice: MODIFIED_PRICE, currency, costPrice: 0,
      isInfinite: mode.is_infinite, availableQuantity: mode.available_quantity
    })
  }
  return { runId, currency, fixtures, ids: fixtures.map((fixture) => fixture.id) }
}

export async function captureActivityBaseline(context, setup, scenario) {
  const { supabase, workspace } = context
  const ids = [...new Set(scenario.items.map((item) => item.fixtureId))]
  const catalogRows = checked(await supabase.schema('activities').from('activity_catalog').select('*')
    .eq('workspace_id', workspace.id).in('id', ids), 'Could not capture Activities catalog baseline')
  if (catalogRows.length !== ids.length || catalogRows.some((row) => row.is_deleted || !row.is_active || row.created_by !== context.user.id
      || !String(row.name).startsWith(`CHPW ${setup.runId.slice(0, 8)}`))) {
    throw new Error('Activity scenario did not resolve exclusively to active test-owned catalog records.')
  }
  const lineRows = checked(await supabase.schema('activities').from('activity_transaction_lines').select('*')
    .eq('workspace_id', workspace.id).in('activity_id', ids), 'Could not capture Activities line baseline')
  const transactionIds = [...new Set(lineRows.map((row) => row.transaction_id))]
  const transactionRows = transactionIds.length
    ? checked(await supabase.schema('activities').from('activity_transactions').select('*')
      .eq('workspace_id', workspace.id).in('id', transactionIds), 'Could not capture Activities transaction baseline')
    : []
  const paymentRows = transactionIds.length
    ? checked(await supabase.from('payment_transactions').select('*')
      .eq('workspace_id', workspace.id).eq('source_module', 'activities').in('source_record_id', transactionIds), 'Could not capture Activities payment baseline')
    : []
  const idsSet = new Set(ids)
  const fixtures = [...scenario.items].map((item) => item.fixtureId)
  if (fixtures.some((id) => !idsSet.has(id))) throw new Error('Activity baseline fixture scope did not match the scenario.')
  return { ids, catalogRows, lineRows, transactionRows, paymentRows }
}

export function calculateExpectedActivityCheckout(context, setup, scenario) {
  const lines = scenario.items.map((item) => {
    const fixture = setup.fixtures.find((entry) => entry.id === item.fixtureId)
    if (!fixture) throw new Error(`Activity scenario references missing fixture ${item.fixtureId}.`)
    const unitPrice = item.price === 'modified' ? fixture.modifiedPrice : fixture.price
    return {
      activityId: fixture.id, activityName: fixture.name,
      quantity: item.quantity, catalogUnitPrice: fixture.price,
      unitPrice, priceOverridden: unitPrice !== fixture.price,
      lineTotal: roundAmount(unitPrice * item.quantity, setup.currency),
      isInfinite: fixture.isInfinite
    }
  })
  const total = roundAmount(lines.reduce((sum, line) => sum + line.lineTotal, 0), setup.currency)
  return {
    workspaceId: context.workspace.id,
    cashierId: context.user.id,
    origin: 'activities',
    currency: setup.currency,
    paymentMethod: scenario.payment.id,
    paymentAccountId: scenario.account?.id ?? null,
    paymentAccountName: scenario.account?.name ?? null,
    subtotal: total,
    total,
    lines
  }
}

export async function reconcileActivityCheckout(context, setup, scenario, transactionId, baseline, expected) {
  const { supabase, workspace, user } = context
  const catalogAfter = checked(await supabase.schema('activities').from('activity_catalog').select('*')
    .eq('workspace_id', workspace.id).in('id', baseline.ids), 'Could not read post-checkout Activities catalog')
  const transactions = checked(await supabase.schema('activities').from('activity_transactions').select('*')
    .eq('workspace_id', workspace.id).eq('id', transactionId), 'Could not read the persisted Activities transaction')
  const lines = checked(await supabase.schema('activities').from('activity_transaction_lines').select('*')
    .eq('workspace_id', workspace.id).eq('transaction_id', transactionId), 'Could not read persisted Activities lines')
  const payments = checked(await supabase.from('payment_transactions').select('*')
    .eq('workspace_id', workspace.id).eq('source_module', 'activities')
    .eq('source_type', 'activity_transaction').eq('source_record_id', transactionId), 'Could not read the Activities payment')
  let balancesQuery = supabase.schema('payment_accounts').from('account_balances').select('*').eq('workspace_id', workspace.id)
  if (expected.paymentAccountId) balancesQuery = balancesQuery.eq('account_id', expected.paymentAccountId)
  const balances = checked(await balancesQuery, 'Could not read post-checkout account balances')
  const movementRows = payments.length
    ? checked(await supabase.schema('payment_accounts').from('account_movements').select('*')
      .eq('workspace_id', workspace.id).in('payment_transaction_id', payments.map((row) => row.id)), 'Could not read Activities account movements')
    : []
  const mismatches = []
  if (transactions.length !== 1) mismatches.push({ field: 'activityTransactions.count', expected: 1, actual: transactions.length })
  const transaction = transactions[0]
  if (transaction) {
    for (const [field, want, actual] of [
      ['id', transactionId, transaction.id], ['workspace_id', workspace.id, transaction.workspace_id],
      ['created_by', user.id, transaction.created_by], ['currency', expected.currency, transaction.currency],
      ['payment_method', expected.paymentMethod, transaction.payment_method], ['status', 'completed', transaction.status],
      ['customer_name', null, transaction.customer_name ?? null], ['notes', null, transaction.notes ?? null]
    ]) if (want !== actual) mismatches.push({ field: `activityTransaction.${field}`, expected: want, actual })
    for (const field of ['subtotal_amount', 'total_amount']) {
      const want = field === 'subtotal_amount' ? expected.subtotal : expected.total
      if (Math.abs(Number(transaction[field]) - want) > 0.000001) mismatches.push({ field: `activityTransaction.${field}`, expected: want, actual: transaction[field] })
    }
  }
  if (lines.length !== expected.lines.length) mismatches.push({ field: 'activityTransactionLines.count', expected: expected.lines.length, actual: lines.length })
  for (const expectedLine of expected.lines) {
    const matches = lines.filter((line) => line.activity_id === expectedLine.activityId)
    if (matches.length !== 1) {
      mismatches.push({ field: `activityLine.${expectedLine.activityId}.count`, expected: 1, actual: matches.length })
      continue
    }
    const line = matches[0]
    for (const [field, want, actual] of [
      ['workspace_id', workspace.id, line.workspace_id], ['transaction_id', transactionId, line.transaction_id],
      ['activity_id', expectedLine.activityId, line.activity_id], ['activity_name_snapshot', expectedLine.activityName, line.activity_name_snapshot],
      ['catalog_unit_price_snapshot', expectedLine.catalogUnitPrice, Number(line.catalog_unit_price_snapshot)],
      ['unit_price', expectedLine.unitPrice, Number(line.unit_price)], ['price_overridden', expectedLine.priceOverridden, line.price_overridden],
      ['quantity', expectedLine.quantity, Number(line.quantity)], ['line_total', expectedLine.lineTotal, Number(line.line_total)]
    ]) {
      const mismatch = typeof want === 'number' ? Math.abs(want - Number(actual)) > 0.000001 : want !== actual
      if (mismatch) mismatches.push({ field: `activityLine.${expectedLine.activityId}.${field}`, expected: want, actual })
    }
  }
  if (payments.length !== 1) mismatches.push({ field: 'activityPayment.count', expected: 1, actual: payments.length })
  const payment = payments[0]
  if (payment && transaction) {
    for (const [field, want, actual] of [
      ['workspace_id', workspace.id, payment.workspace_id], ['source_module', 'activities', payment.source_module],
      ['source_type', 'activity_transaction', payment.source_type], ['source_record_id', transactionId, payment.source_record_id],
      ['direction', 'incoming', payment.direction], ['currency', expected.currency, payment.currency],
      ['payment_method', expected.paymentMethod, payment.payment_method], ['account_id', expected.paymentAccountId, payment.account_id],
      ['account_name_snapshot', expected.paymentAccountName, payment.account_name_snapshot ?? null],
      ['paid_at', transaction.occurred_at, payment.paid_at]
    ]) if (want !== actual) mismatches.push({ field: `activityPayment.${field}`, expected: want, actual })
    if (Math.abs(Number(payment.amount) - expected.total) > 0.000001) mismatches.push({ field: 'activityPayment.amount', expected: expected.total, actual: payment.amount })
  }
  if (expected.paymentAccountId) {
    if (movementRows.length !== 1) mismatches.push({ field: 'activityAccountMovements.count', expected: 1, actual: movementRows.length })
    const movement = movementRows[0]
    if (movement && (movement.account_id !== expected.paymentAccountId || movement.direction !== 'incoming'
        || Number(movement.amount) !== expected.total || Number(movement.delta_amount) !== expected.total
        || movement.currency !== expected.currency || movement.is_deleted)) {
      mismatches.push({ field: 'activityAccountMovement', expected: { accountId: expected.paymentAccountId, direction: 'incoming', amount: expected.total, delta: expected.total, currency: expected.currency }, actual: movement })
    }
  } else if (movementRows.length) {
    mismatches.push({ field: 'activityAccountMovements.count', expected: 0, actual: movementRows })
  }
  const currentBalances = new Map(balances.map((row) => [`${row.account_id}:${row.currency}`, row]))
  const beforeBalances = new Map(baseline.accountBalances.map((row) => [`${row.account_id}:${row.currency}`, row]))
  const balanceKeys = new Set([...currentBalances.keys(), ...beforeBalances.keys()])
  for (const key of balanceKeys) {
    const before = beforeBalances.get(key)
    const after = currentBalances.get(key)
    const [accountId, currency] = key.split(':')
    const expectedDelta = expected.paymentAccountId === accountId && expected.currency === currency ? expected.total : 0
    const amount = Number(before?.balance_amount ?? 0) + expectedDelta
    const expectedVersion = Number(before?.version ?? 0) + (expectedDelta ? 1 : 0)
    if (!before || !after || Math.abs(Number(after.balance_amount) - amount) > 0.000001
        || Number(after.version ?? 0) !== expectedVersion) {
      mismatches.push({ field: `activityAccountBalance.${key}`, expected: amount, actual: after?.balance_amount ?? null })
    }
  }
  for (const before of baseline.catalogRows) {
    const after = catalogAfter.find((row) => row.id === before.id)
    const sold = expected.lines.filter((line) => line.activityId === before.id).reduce((sum, line) => sum + line.quantity, 0)
    const quantity = before.is_infinite ? null : Number(before.available_quantity) - sold
    if (!after || after.is_deleted !== before.is_deleted || after.is_active !== before.is_active
        || (quantity === null ? after.available_quantity !== null : Number(after.available_quantity) !== quantity)) {
      mismatches.push({ field: `activityCatalog.${before.id}.availability`, expected: quantity, actual: after?.available_quantity ?? null })
    }
  }
  const unexpectedLineRows = checked(await supabase.schema('activities').from('activity_transaction_lines').select('id,transaction_id,activity_id')
    .eq('workspace_id', workspace.id).in('activity_id', baseline.ids), 'Could not inspect related Activities lines')
    .filter((row) => !baseline.lineRows.some((old) => old.id === row.id))
  if (unexpectedLineRows.length !== expected.lines.length || unexpectedLineRows.some((row) => row.transaction_id !== transactionId)) {
    mismatches.push({ field: 'activityTransactionLines.unexpected', expected: expected.lines.length, actual: unexpectedLineRows })
  }
  return { passed: mismatches.length === 0, transaction, lines, payments, catalogAfter, movementRows, balances, mismatches, baseline }
}

export async function cleanupActivityScenario(context, setup, scenario, transactionId, baseline) {
  const { supabase, workspace, user } = context
  const report = { attempted: true, completed: false, errors: [], retainedAuditRows: [] }
  if (transactionId) {
    const transaction = await supabase.schema('activities').from('activity_transactions').select('*')
      .eq('id', transactionId).eq('workspace_id', workspace.id).maybeSingle()
    if (transaction.error) report.errors.push(`Could not verify Activities transaction ownership: ${transaction.error.message}`)
    else if (transaction.data) {
      const lines = await supabase.schema('activities').from('activity_transaction_lines').select('*')
        .eq('transaction_id', transactionId).eq('workspace_id', workspace.id)
      const owned = transaction.data.created_by === user.id && !lines.error && lines.data?.length > 0
        && lines.data.every((line) => setup.ids.includes(line.activity_id))
      if (!owned) report.errors.push('Activities cleanup stopped because transaction ownership could not be proven.')
      else {
        const original = await supabase.from('payment_transactions').select('*')
          .eq('workspace_id', workspace.id).eq('source_module', 'activities')
          .eq('source_type', 'activity_transaction').eq('source_record_id', transactionId).maybeSingle()
        if (original.error) report.errors.push(`Could not verify original Activities payment: ${original.error.message}`)
        else if (original.data && !original.data.is_deleted) {
          const existing = await supabase.from('payment_transactions').select('id,amount,direction,is_deleted')
            .eq('workspace_id', workspace.id).eq('reversal_of_transaction_id', original.data.id).eq('is_deleted', false)
          if (existing.error) report.errors.push(`Could not inspect existing Activities payment reversals: ${existing.error.message}`)
          else {
            const reversed = (existing.data ?? []).reduce((sum, row) => sum + Number(row.amount) * (row.direction === 'outgoing' ? 1 : -1), 0)
            const remaining = Number(original.data.amount) - reversed
            if (remaining < -0.000001) report.errors.push('Existing counter-entries over-reverse the test Activities payment.')
            else if (remaining > 0.000001) {
              const reversedPayment = await supabase.from('payment_transactions').insert({
                id: randomUUID(), workspace_id: workspace.id, source_module: 'activities', source_type: 'activity_refund',
                source_record_id: transactionId, source_subrecord_id: original.data.id,
                direction: 'outgoing', amount: remaining, currency: original.data.currency,
                payment_method: original.data.payment_method, paid_at: new Date().toISOString(),
                counterparty_name: original.data.counterparty_name, reference_label: `${original.data.reference_label ?? transactionId} / Cleanup refund`,
                note: `Cloud/Hybrid Playwright cleanup ${scenario.id}`, created_by: user.id,
                reversal_of_transaction_id: original.data.id,
                metadata: { ...(original.data.metadata ?? {}), reversal: true, cloudHybridPlaywrightRun: setup.runId },
                account_id: original.data.account_id, account_name_snapshot: original.data.account_name_snapshot
              }).select('id').single()
              if (reversedPayment.error || !reversedPayment.data) report.errors.push(`Could not reverse the test Activities payment: ${reversedPayment.error?.message ?? 'no row returned'}`)
              else report.reversalId = reversedPayment.data.id
            }
          }
        }
        if (!report.errors.length && transaction.data.status === 'completed') {
          const updated = await supabase.schema('activities').from('activity_transactions').update({
            status: 'refunded', refunded_at: new Date().toISOString()
          }).eq('id', transactionId).eq('workspace_id', workspace.id).eq('created_by', user.id).select('id').maybeSingle()
          if (updated.error || !updated.data) report.errors.push(`Could not restore test Activities availability through the transaction status trigger: ${updated.error?.message ?? 'no row returned'}`)
        }
        if (!report.errors.length) report.retainedAuditRows.push(`activities.activity_transactions:${transactionId}:refunded`)
      }
    }
  }
  const activityRows = await supabase.schema('activities').from('activity_catalog').select('*')
    .eq('workspace_id', workspace.id).in('id', baseline.ids)
  if (activityRows.error) report.errors.push(`Could not verify restored Activities availability: ${activityRows.error.message}`)
  else for (const before of baseline.catalogRows) {
    const after = activityRows.data?.find((row) => row.id === before.id)
    if (!after || after.available_quantity !== before.available_quantity || after.is_infinite !== before.is_infinite) {
      report.errors.push(`Activity availability cleanup mismatch for ${before.id}.`)
    }
  }
  if (scenario.account?.id) {
    const balances = await supabase.schema('payment_accounts').from('account_balances').select('account_id,currency,balance_amount')
      .eq('workspace_id', workspace.id).eq('account_id', scenario.account.id)
    if (balances.error) report.errors.push(`Could not verify Activities account cleanup: ${balances.error.message}`)
    else for (const before of baseline.accountBalances) {
      const after = balances.data?.find((row) => row.account_id === before.account_id && row.currency === before.currency)
      if (Math.abs(Number(after?.balance_amount ?? 0) - Number(before.balance_amount)) > 0.000001) {
        report.errors.push(`Activities account balance cleanup mismatch for ${before.currency}.`)
      }
    }
  } else {
    const balances = await supabase.schema('payment_accounts').from('account_balances').select('account_id,currency,balance_amount')
      .eq('workspace_id', workspace.id)
    if (balances.error) report.errors.push(`Could not verify no-account Activities cleanup: ${balances.error.message}`)
    else for (const before of baseline.accountBalances) {
      const after = balances.data?.find((row) => row.account_id === before.account_id && row.currency === before.currency)
      if (Math.abs(Number(after?.balance_amount ?? 0) - Number(before.balance_amount)) > 0.000001) {
        report.errors.push(`No-account Activities cleanup changed ${before.account_id} balance in ${before.currency}.`)
      }
    }
  }
  if (transactionId) {
    const paymentRows = await supabase.from('payment_transactions').select('id,amount,direction,reversal_of_transaction_id,is_deleted,account_id')
      .eq('workspace_id', workspace.id).eq('source_record_id', transactionId).eq('source_module', 'activities')
    if (paymentRows.error) report.errors.push(`Could not verify Activities payment cleanup: ${paymentRows.error.message}`)
    else {
      const original = (paymentRows.data ?? []).find((row) => row.reversal_of_transaction_id == null && !row.is_deleted)
      const reversals = original ? (paymentRows.data ?? []).filter((row) => row.reversal_of_transaction_id === original.id && !row.is_deleted) : []
      const net = original ? Number(original.amount) + reversals.reduce((sum, row) => sum + Number(row.amount) * (row.direction === 'outgoing' ? -1 : 1), 0) : 0
      if (original && Math.abs(net) > 0.000001) report.errors.push(`Activities payment and refund did not net to zero (actual ${net}).`)
      if (original?.account_id) {
        const movementRows = await supabase.schema('payment_accounts').from('account_movements').select('payment_transaction_id,delta_amount,is_deleted')
          .eq('workspace_id', workspace.id).in('payment_transaction_id', [original.id, ...reversals.map((row) => row.id)])
        if (movementRows.error) report.errors.push(`Could not verify Activities counter-entry movements: ${movementRows.error.message}`)
        else {
          const netMovement = (movementRows.data ?? []).filter((row) => !row.is_deleted).reduce((sum, row) => sum + Number(row.delta_amount), 0)
          if (Math.abs(netMovement) > 0.000001 || movementRows.data?.length !== reversals.length + 1) {
            report.errors.push(`Activities account movements did not return to zero: ${JSON.stringify(movementRows.data)}`)
          }
        }
      }
    }
  }
  report.completed = report.errors.length === 0
  return report
}

export async function cleanupOwnedActivities(context, setup) {
  const { supabase, workspace, user } = context
  const errors = []
  for (const id of setup.ids) {
    const verified = await supabase.schema('activities').from('activity_catalog').select('*')
      .eq('id', id).eq('workspace_id', workspace.id).maybeSingle()
    if (verified.error) { errors.push(`Could not prove activity fixture ownership for ${id}: ${verified.error.message}`); continue }
    if (!verified.data || verified.data.created_by !== user.id || !String(verified.data.name).startsWith(`CHPW ${setup.runId.slice(0, 8)}`)) {
      errors.push(`Activity fixture ${id} was retained because ownership could not be proven.`)
      continue
    }
    const retired = await supabase.schema('activities').from('activity_catalog').update({ is_active: false, is_deleted: true })
      .eq('id', id).eq('workspace_id', workspace.id).eq('created_by', user.id).select('id,is_deleted,is_active').maybeSingle()
    if (retired.error || !retired.data?.is_deleted || retired.data.is_active) errors.push(`Could not retire test-owned activity fixture ${id}: ${retired.error?.message ?? 'fixture remains active'}`)
  }
  journals.delete(setup.runId)
  return { completed: errors.length === 0, errors }
}

export async function cleanupPartialOwnedActivities(context, runId) {
  const ids = journals.get(runId) ?? []
  if (!ids.length) return { completed: true, errors: [] }
  return cleanupOwnedActivities(context, { runId, ids })
}
