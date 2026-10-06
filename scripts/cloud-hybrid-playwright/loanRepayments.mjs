const AMOUNT_TOLERANCE = 0.001
const PAYMENT_METHOD = 'cash'

function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data ?? []
}

function closeAmount(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) <= AMOUNT_TOLERANCE
}

function paymentSourceType(loan) {
  return loan.loan_category === 'simple'
    ? 'simple_loan'
    : Number(loan.installment_count) > 1 ? 'loan_installment' : 'loan_payment'
}

function partialAmountFor(loan) {
  const balance = Number(loan.balance_amount)
  const currency = String(loan.settlement_currency ?? '').toLowerCase()
  const amount = currency === 'iqd'
    ? Math.floor(balance / 2)
    : Math.round((balance / 2 + Number.EPSILON) * 100) / 100
  if (!(amount > 0 && amount < balance)) {
    throw new Error(`Could not choose a positive partial repayment below the ${currency.toUpperCase()} loan balance ${balance}.`)
  }
  return amount
}

async function readLoanState(context, loanId) {
  const { supabase, workspace } = context
  const loans = checked(await supabase.from('loans')
    .select('id,workspace_id,sale_id,source,created_by,loan_category,direction,principal_amount,total_paid_amount,balance_amount,settlement_currency,status,installment_count,next_due_date,created_at,updated_at,is_deleted,version')
    .eq('workspace_id', workspace.id).eq('id', loanId), 'Could not read POS loan state')
  const installments = checked(await supabase.from('loan_installments')
    .select('id,workspace_id,loan_id,installment_no,planned_amount,paid_amount,balance_amount,status,due_date,created_at,updated_at,is_deleted,version')
    .eq('workspace_id', workspace.id).eq('loan_id', loanId), 'Could not read POS loan installments')
  const payments = checked(await supabase.from('loan_payments')
    .select('id,workspace_id,loan_id,sequence_no,amount,payment_method,paid_at,created_at,updated_at,created_by,payment_transaction_id,reversed_amount,reversal_transaction_id,is_deleted,version')
    .eq('workspace_id', workspace.id).eq('loan_id', loanId).order('sequence_no', { ascending: true }), 'Could not read POS loan payments')
  const transactions = checked(await supabase.from('payment_transactions')
    .select('id,workspace_id,source_module,source_type,source_record_id,source_subrecord_id,direction,amount,currency,payment_method,paid_at,created_at,updated_at,account_id,account_name_snapshot,created_by,reversal_of_transaction_id,metadata,is_deleted')
    .eq('workspace_id', workspace.id).eq('source_module', 'loans').eq('source_record_id', loanId),
  'Could not read the POS loan payment ledger')
  const activeTransactionIds = transactions.filter((row) => !row.is_deleted).map((row) => row.id)
  const accountMovements = activeTransactionIds.length
    ? checked(await supabase.schema('payment_accounts').from('account_movements')
      .select('id,workspace_id,account_id,payment_transaction_id,amount,delta_amount,currency,is_deleted')
      .eq('workspace_id', workspace.id).in('payment_transaction_id', activeTransactionIds),
    'Could not inspect POS loan payment-account movements')
    : []
  return { loans, installments, payments, transactions, accountMovements }
}

function compareLoanPaymentStage(context, baseline, actual, { partialAmount, remainingAmount, completedCount, expectedPaymentIds = [], expectedTransactionIds = [] }) {
  const mismatches = []
  if (actual.loans.length !== 1) {
    mismatches.push({ field: 'loan.count', expected: 1, actual: actual.loans.length })
    return mismatches
  }
  const loan = actual.loans[0]
  const paidInRun = partialAmount + (completedCount === 2 ? remainingAmount : 0)
  const expectedPaid = Number(baseline.loan.total_paid_amount) + paidInRun
  const expectedBalance = Math.max(0, Number(baseline.loan.balance_amount) - paidInRun)
  const expectedStatus = expectedBalance <= AMOUNT_TOLERANCE
    ? 'completed'
    : loan.next_due_date && loan.next_due_date < new Date().toISOString().slice(0, 10) ? 'overdue' : 'active'

  for (const [field, expected, value] of [
    ['workspace_id', context.workspace.id, loan.workspace_id],
    ['sale_id', baseline.saleId, loan.sale_id],
    ['source', 'pos', loan.source],
    ['created_by', context.user.id, loan.created_by],
    ['status', expectedStatus, loan.status],
    ['created_at', baseline.loan.created_at, loan.created_at],
    ['settlement_currency', baseline.loan.settlement_currency, loan.settlement_currency]
  ]) if (value !== expected) mismatches.push({ field: `loan.${field}`, expected, actual: value })
  if (!closeAmount(loan.principal_amount, baseline.loan.principal_amount)) {
    mismatches.push({ field: 'loan.principal_amount', expected: baseline.loan.principal_amount, actual: loan.principal_amount })
  }
  if (!closeAmount(loan.total_paid_amount, expectedPaid)) {
    mismatches.push({ field: 'loan.total_paid_amount', expected: expectedPaid, actual: loan.total_paid_amount })
  }
  if (!closeAmount(loan.balance_amount, expectedBalance)) {
    mismatches.push({ field: 'loan.balance_amount', expected: expectedBalance, actual: loan.balance_amount })
  }
  if (Number(loan.version) !== Number(baseline.loan.version) + completedCount) {
    mismatches.push({ field: 'loan.version', expected: Number(baseline.loan.version) + completedCount, actual: loan.version })
  }

  const baselinePaymentsById = new Map(baseline.state.payments.map((row) => [row.id, row]))
  const allNewPayments = actual.payments.filter((row) => !baselinePaymentsById.has(row.id))
  const newPayments = allNewPayments.filter((row) => !row.is_deleted)
  if (allNewPayments.length !== completedCount || newPayments.length !== completedCount) {
    mismatches.push({ field: 'loan_payments.new_count', expected: completedCount, actual: allNewPayments.length, active: newPayments.length, rows: allNewPayments })
  }
  const paymentIds = new Set(newPayments.map((row) => row.id))
  if (paymentIds.size !== completedCount || expectedPaymentIds.some((id) => !paymentIds.has(id))) {
    mismatches.push({ field: 'loan_payments.request_correlations', expected: expectedPaymentIds, actual: [...paymentIds] })
  }
  for (const [index, payment] of newPayments.entries()) {
    const expectedAmount = index === 0 ? partialAmount : remainingAmount
    for (const [field, expected, value] of [
      ['workspace_id', context.workspace.id, payment.workspace_id],
      ['loan_id', baseline.loan.id, payment.loan_id],
      ['sequence_no', baseline.state.payments.length + index + 1, Number(payment.sequence_no)],
      ['payment_method', PAYMENT_METHOD, payment.payment_method],
      ['created_by', context.user.id, payment.created_by],
      ['is_deleted', false, Boolean(payment.is_deleted)],
      ['reversed_amount', 0, Number(payment.reversed_amount)],
      ['reversal_transaction_id', null, payment.reversal_transaction_id]
    ]) if (value !== expected) mismatches.push({ field: `loan_payments.${payment.id}.${field}`, expected, actual: value })
    if (!closeAmount(payment.amount, expectedAmount)) {
      mismatches.push({ field: `loan_payments.${payment.id}.amount`, expected: expectedAmount, actual: payment.amount })
    }
    if (Number(payment.version) !== 1) mismatches.push({ field: `loan_payments.${payment.id}.version`, expected: 1, actual: payment.version })
    if (!payment.payment_transaction_id) {
      mismatches.push({ field: `loan_payments.${payment.id}.payment_transaction_id`, expected: 'linked payment transaction', actual: null })
    }
  }

  const baselineTransactionIds = new Set(baseline.state.transactions.map((row) => row.id))
  const allNewTransactions = actual.transactions.filter((row) => !baselineTransactionIds.has(row.id))
  const newTransactions = allNewTransactions.filter((row) => !row.is_deleted)
  if (allNewTransactions.length !== completedCount || newTransactions.length !== completedCount) {
    mismatches.push({ field: 'payment_transactions.new_count', expected: completedCount, actual: allNewTransactions.length, active: newTransactions.length, rows: allNewTransactions })
  }
  const transactionIds = new Set(newTransactions.map((row) => row.id))
  if (transactionIds.size !== completedCount || expectedTransactionIds.some((id) => !transactionIds.has(id))) {
    mismatches.push({ field: 'payment_transactions.request_correlations', expected: expectedTransactionIds, actual: [...transactionIds] })
  }
  for (const payment of newPayments) {
    const matching = newTransactions.filter((row) => row.id === payment.payment_transaction_id
      && row.metadata?.loanPaymentId === payment.id)
    if (matching.length !== 1) {
      mismatches.push({ field: `payment_transactions.for_${payment.id}`, expected: 1, actual: matching.length })
      continue
    }
    const transaction = matching[0]
    const expectedTransaction = {
      workspace_id: context.workspace.id,
      source_module: 'loans',
      source_type: paymentSourceType(baseline.loan),
      source_record_id: baseline.loan.id,
      source_subrecord_id: payment.id,
      direction: 'incoming',
      currency: String(baseline.loan.settlement_currency).toLowerCase(),
      payment_method: PAYMENT_METHOD,
      account_id: null,
      account_name_snapshot: null,
      created_by: context.user.id,
      reversal_of_transaction_id: null,
      is_deleted: false
    }
    for (const [field, expected] of Object.entries(expectedTransaction)) {
      const value = field === 'is_deleted' ? Boolean(transaction[field]) : transaction[field] ?? null
      if (value !== expected) mismatches.push({ field: `payment_transactions.${transaction.id}.${field}`, expected, actual: value })
    }
    if (!closeAmount(transaction.amount, Number(payment.amount))) {
      mismatches.push({ field: `payment_transactions.${transaction.id}.amount`, expected: payment.amount, actual: transaction.amount })
    }
    const paymentPaidAt = Date.parse(payment.paid_at ?? '')
    const transactionPaidAt = Date.parse(transaction.paid_at ?? '')
    if (!Number.isFinite(paymentPaidAt) || paymentPaidAt !== transactionPaidAt) {
      mismatches.push({
        field: `payment_transactions.${transaction.id}.paid_at`,
        expected: payment.paid_at ?? 'valid payment timestamp',
        actual: transaction.paid_at
      })
    }
  }

  const baselineInstallmentIds = new Set(baseline.state.installments.map((row) => row.id))
  const installmentChanges = actual.installments.filter((row) => baselineInstallmentIds.has(row.id))
  if (installmentChanges.length !== baseline.state.installments.length || actual.installments.length !== baseline.state.installments.length) {
    mismatches.push({ field: 'loan_installments.count', expected: baseline.state.installments.length, actual: actual.installments.length })
  }
  for (const before of baseline.state.installments) {
    const installment = installmentChanges.find((row) => row.id === before.id)
    if (!installment) continue
    const expectedPaid = Number(before.paid_amount) + paidInRun
    const expectedRemaining = Math.max(0, Number(before.balance_amount) - paidInRun)
    const expectedInstallmentStatus = expectedRemaining <= AMOUNT_TOLERANCE ? 'paid' : 'partial'
    for (const [field, expected, value] of [
      ['workspace_id', context.workspace.id, installment.workspace_id],
      ['loan_id', baseline.loan.id, installment.loan_id],
      ['status', expectedInstallmentStatus, installment.status],
      ['is_deleted', false, Boolean(installment.is_deleted)]
    ]) if (value !== expected) mismatches.push({ field: `loan_installments.${installment.id}.${field}`, expected, actual: value })
    if (!closeAmount(installment.planned_amount, before.planned_amount)
      || !closeAmount(installment.paid_amount, expectedPaid)
      || !closeAmount(installment.balance_amount, expectedRemaining)) {
      mismatches.push({
        field: `loan_installments.${installment.id}.amounts`,
        expected: { planned: before.planned_amount, paid: expectedPaid, balance: expectedRemaining },
        actual: { planned: installment.planned_amount, paid: installment.paid_amount, balance: installment.balance_amount }
      })
    }
    if (Number(installment.version) !== Number(before.version) + completedCount || installment.due_date !== before.due_date || installment.created_at !== before.created_at) {
      mismatches.push({
        field: `loan_installments.${installment.id}.version_or_immutable_fields`,
        expected: { version: Number(before.version) + completedCount, due_date: before.due_date, created_at: before.created_at },
        actual: { version: installment.version, due_date: installment.due_date, created_at: installment.created_at }
      })
    }
  }

  const testTransactionIds = new Set(newTransactions.map((row) => row.id))
  const unexpectedAccountMovements = actual.accountMovements.filter((row) => testTransactionIds.has(row.payment_transaction_id) && !row.is_deleted)
  if (unexpectedAccountMovements.length) {
    mismatches.push({ field: 'payment_account_movements', expected: [], actual: unexpectedAccountMovements })
  }
  return mismatches
}

async function pollLoanPaymentStage(context, baseline, expected) {
  const deadline = Date.now() + 30000
  let actual = null
  let mismatches = []
  while (Date.now() < deadline) {
    actual = await readLoanState(context, baseline.loan.id)
    mismatches = compareLoanPaymentStage(context, baseline, actual, expected)
    if (!mismatches.length) return { passed: true, mismatches: [], actual }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return { passed: false, mismatches, actual }
}

export async function exercisePosLoanRepayments(context, driver, saleId, expectedPrincipal) {
  const report = { passed: false, saleId, loanId: null, before: null, partialPayment: null, finalPayment: null, errors: [] }
  let baseline
  try {
    const { supabase, workspace, user } = context
    const sales = checked(await supabase.from('sales')
      .select('id,workspace_id,cashier_id,origin,payment_method,total_amount,settlement_currency,is_archived')
      .eq('workspace_id', workspace.id).eq('id', saleId), 'Could not verify the loan scenario sale')
    if (sales.length !== 1 || sales[0].cashier_id !== user.id || sales[0].origin !== 'pos'
      || sales[0].payment_method !== 'loan' || sales[0].is_archived) {
      throw new Error(`Loan repayment test refused an unverified POS sale: ${JSON.stringify(sales)}`)
    }
    const sale = sales[0]
    if (!closeAmount(sale.total_amount, expectedPrincipal)) {
      throw new Error(`POS loan sale total ${sale.total_amount} does not match the independently expected principal ${expectedPrincipal}.`)
    }
    const loans = checked(await supabase.from('loans')
      .select('id,workspace_id,sale_id,source,created_by,loan_category,direction,principal_amount,total_paid_amount,balance_amount,settlement_currency,status,installment_count,next_due_date,created_at,updated_at,is_deleted,version')
      .eq('workspace_id', workspace.id).eq('sale_id', saleId).eq('source', 'pos').eq('is_deleted', false),
    'Could not find the POS sale loan')
    if (loans.length !== 1) throw new Error(`Expected exactly one active POS loan for sale ${saleId}; found ${loans.length}.`)
    const loan = loans[0]
    report.loanId = loan.id
    if (loan.created_by !== user.id || loan.workspace_id !== workspace.id || loan.sale_id !== saleId
      || loan.direction !== 'lent' || !closeAmount(loan.principal_amount, expectedPrincipal)
      || !closeAmount(loan.balance_amount, expectedPrincipal) || !closeAmount(loan.total_paid_amount, 0)) {
      throw new Error(`POS loan baseline did not match the new sale: ${JSON.stringify(loan)}`)
    }
    const state = await readLoanState(context, loan.id)
    if (state.loans.length !== 1 || state.installments.length !== 1 || state.payments.filter((row) => !row.is_deleted).length !== 0) {
      throw new Error(`Expected a new one-installment POS loan with no repayment rows before the UI flow; actual state: ${JSON.stringify(state)}`)
    }
    baseline = { saleId, sale, loan, state }
    report.before = baseline

    const initialUi = await driver.openPosLoanDetails(loan)
    if (!initialUi.passed) throw new Error(`Loan details UI did not match the pre-payment Supabase state: ${JSON.stringify(initialUi)}`)

    const partialAmount = partialAmountFor(loan)
    const partialRemaining = Number(loan.balance_amount) - partialAmount
    const partialAction = await driver.submitLoanPayment(partialAmount, loan.settlement_currency, loan.id)
    report.partialPayment = { requestedAmount: partialAmount, uiAction: partialAction }
    const partial = await pollLoanPaymentStage(context, baseline, {
      partialAmount,
      remainingAmount: partialRemaining,
      completedCount: 1,
      expectedPaymentIds: [partialAction.payload?.id].filter(Boolean),
      expectedTransactionIds: [partialAction.payload?.payment_transaction_id].filter(Boolean)
    })
    const partialUi = await driver.waitForLoanDetailsState({
      totalRepaid: Number(loan.total_paid_amount) + partialAmount,
      balance: partialRemaining,
      paymentActivityCount: 1,
      installmentStatus: 'partial'
    })
    report.partialPayment.database = partial
    report.partialPayment.ui = partialUi
    if (!partialAction.passed || !partial.passed || !partialUi.passed) {
      throw new Error(`Partial POS loan repayment did not reconcile: ${JSON.stringify({ database: partial, ui: partialUi })}`)
    }

    const finalAction = await driver.submitLoanPayment(partialRemaining, loan.settlement_currency, loan.id)
    report.finalPayment = { requestedAmount: partialRemaining, uiAction: finalAction }
    const final = await pollLoanPaymentStage(context, baseline, {
      partialAmount,
      remainingAmount: partialRemaining,
      completedCount: 2,
      expectedPaymentIds: [partialAction.payload?.id, finalAction.payload?.id].filter(Boolean),
      expectedTransactionIds: [partialAction.payload?.payment_transaction_id, finalAction.payload?.payment_transaction_id].filter(Boolean)
    })
    const finalUi = await driver.waitForLoanDetailsState({
      totalRepaid: Number(loan.total_paid_amount) + Number(loan.balance_amount),
      balance: 0,
      paymentActivityCount: 2,
      installmentStatus: 'paid'
    })
    report.finalPayment.database = final
    report.finalPayment.ui = finalUi
    if (!finalAction.passed || !final.passed || !finalUi.passed) {
      throw new Error(`Final POS loan repayment did not reconcile: ${JSON.stringify({ database: final, ui: finalUi })}`)
    }

    report.passed = true
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
  }
  report.baseline = baseline ?? null
  return report
}

export async function verifyPosLoanRepaymentCleanup(context, report) {
  if (!report?.baseline) return { passed: false, errors: ['Cannot verify Loan cleanup because the pre-payment loan baseline was not captured.'] }
  const errors = []
  const { supabase, workspace } = context
  const { loan, saleId, state: baselineState } = report.baseline
  const saleRows = checked(await supabase.from('sales').select('id,workspace_id,is_archived,return_status,payment_method')
    .eq('workspace_id', workspace.id).eq('id', saleId), 'Could not verify loan-sale cleanup')
  if (saleRows.length !== 1 || !saleRows[0].is_archived || saleRows[0].return_status !== 'full'
      || saleRows[0].payment_method !== 'loan') {
    errors.push(`POS loan sale was not fully returned and archived during cleanup: ${JSON.stringify(saleRows)}`)
  }
  const after = await readLoanState(context, loan.id)
  if (after.loans.length !== 1 || after.loans[0].status !== 'cancelled'
      || !closeAmount(after.loans[0].balance_amount, 0) || !closeAmount(after.loans[0].total_paid_amount, 0)) {
    errors.push(`POS loan did not reconcile to the cancelled cleanup state: ${JSON.stringify(after.loans)}`)
  }
  if (after.installments.length !== baselineState.installments.length
      || after.installments.some((row) => row.status !== 'cancelled' || !closeAmount(row.paid_amount, 0) || !closeAmount(row.balance_amount, 0))) {
    errors.push(`POS loan installments were not cancelled and reset during full-return cleanup: ${JSON.stringify(after.installments)}`)
  }
  // Full-sale return intentionally soft-deletes each collected payment after
  // retaining its original ledger entry and a linked counter-entry.
  const newPayments = after.payments.filter((row) => !baselineState.payments.some((before) => before.id === row.id))
  const newTransactions = after.transactions.filter((row) => !baselineState.transactions.some((before) => before.id === row.id))
  if (newTransactions.length !== newPayments.length * 2) {
    errors.push(`Loan repayment cleanup expected one original and one reversal transaction per repayment (${newPayments.length * 2}); found ${newTransactions.length}.`)
  }
  const retainedAuditRows = []
  for (const payment of newPayments) {
    if (!payment.is_deleted || !closeAmount(payment.reversed_amount, payment.amount)) {
      errors.push(`Loan payment ${payment.id} was not fully reversed and soft-deleted during POS-sale cleanup: ${JSON.stringify(payment)}.`)
    }
    const originals = newTransactions.filter((row) => row.id === payment.payment_transaction_id
      && row.metadata?.loanPaymentId === payment.id && !row.reversal_of_transaction_id)
    if (originals.length !== 1) {
      errors.push(`Expected one retained original ledger row for loan payment ${payment.id}; found ${originals.length}.`)
      continue
    }
    const original = originals[0]
    const reversals = newTransactions.filter((row) => row.reversal_of_transaction_id === original.id
      && row.metadata?.loanPaymentId === payment.id && row.metadata?.fullSaleReturn === true)
    if (reversals.length !== 1) {
      errors.push(`Expected one full-sale-return counter-entry for loan payment ${payment.id}; found ${reversals.length}.`)
      continue
    }
    const reversal = reversals[0]
    if (payment.reversal_transaction_id !== reversal.id) {
      errors.push(`Loan payment ${payment.id} does not reference its retained full-return counter-entry ${reversal.id}.`)
    }
    if (!closeAmount(Number(original.amount) + Number(reversal.amount), 0)
      || reversal.direction !== original.direction || reversal.source_record_id !== loan.id
      || reversal.source_subrecord_id !== payment.id || reversal.workspace_id !== workspace.id
      || reversal.currency !== original.currency || reversal.payment_method !== original.payment_method
      || reversal.created_by !== original.created_by) {
      errors.push(`Loan payment ${payment.id} and its return counter-entry do not net to zero or link to the same loan.`)
    }
    retainedAuditRows.push(`${payment.id}:original-and-full-return-counter-entry`)
  }
  const newTransactionIds = newTransactions.map((row) => row.id)
  if (newTransactionIds.length) {
    const movements = checked(await supabase.schema('payment_accounts').from('account_movements')
      .select('id,payment_transaction_id,account_id,delta_amount,is_deleted')
      .eq('workspace_id', workspace.id).in('payment_transaction_id', newTransactionIds),
    'Could not verify loan repayment cleanup account movements')
    if (movements.some((row) => !row.is_deleted)) errors.push(`No-account POS loan repayments unexpectedly mutated a payment account: ${JSON.stringify(movements)}`)
  }
  return { passed: errors.length === 0, errors, retainedAuditRows, finalState: after }
}
