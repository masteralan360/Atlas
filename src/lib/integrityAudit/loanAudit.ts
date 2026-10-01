import { ORDER_AMOUNT_EPSILON, roundOrderValue } from '@/lib/orderPrecision'
import type { PaymentTransaction } from '@/local-db/models'
import type { LoanTransactionGraph } from './loanGraph'
import { IntegrityAuditReadError, type AuditCategory, type AuditStatus, type IntegrityAuditCheck, type IntegrityAuditResult } from './types'

export type LoanIntegrityAuditResult = IntegrityAuditResult<LoanTransactionGraph>

const close = (left: number, right: number) => Math.abs(roundOrderValue(left) - roundOrderValue(right)) <= ORDER_AMOUNT_EPSILON
const amount = (value: unknown) => Number(value ?? 0)
const active = <T extends { isDeleted?: boolean }>(rows: T[]) => rows.filter(row => !row.isDeleted)
const repaymentTypes = new Set(['loan_payment', 'simple_loan', 'loan_installment'])

function check(
  category: AuditCategory,
  code: string,
  matches: boolean,
  entityType: string,
  entityId?: string,
  expected?: unknown,
  actual?: unknown,
  warning = false
): IntegrityAuditCheck {
  return {
    category,
    code,
    status: matches ? 'PASS' : warning ? 'WARNING' : 'FAIL',
    severity: matches ? 'info' : warning ? 'warning' : 'error',
    entityType,
    entityId,
    expected,
    actual
  }
}

function paymentNet(row: PaymentTransaction, all: PaymentTransaction[]) {
  if (row.isDeleted || row.voidId || row.reversalOfTransactionId) return 0
  const reversals = all.filter(candidate => !candidate.isDeleted && !candidate.voidId && candidate.reversalOfTransactionId === row.id)
  return roundOrderValue(Math.max(0, amount(row.amount) - reversals.reduce((sum, candidate) => sum + Math.abs(amount(candidate.amount)), 0)))
}

function paymentIdFor(row: PaymentTransaction) {
  const id = row.metadata?.loanPaymentId
  if (typeof id === 'string' && id) return id
  return row.sourceSubrecordId || null
}

function summarize(checks: IntegrityAuditCheck[]): LoanIntegrityAuditResult['summary'] {
  return {
    total: checks.length,
    passed: checks.filter(row => row.status === 'PASS').length,
    warnings: checks.filter(row => row.status === 'WARNING').length,
    failed: checks.filter(row => row.status === 'FAIL').length
  }
}

const statusOf = (checks: IntegrityAuditCheck[]): AuditStatus => checks.some(row => row.status === 'FAIL')
  ? 'FAIL'
  : checks.some(row => row.status === 'WARNING') ? 'WARNING' : 'PASS'

/** Reconcile one loan against its immutable payment, reversal, account, and schedule records. */
export function auditLoanGraph(
  graph: LoanTransactionGraph,
  workspaceId: string,
  loanId: string
) {
  const checks: IntegrityAuditCheck[] = []
  const add = (...args: Parameters<typeof check>) => checks.push(check(...args))
  const loan = graph.loan
  const expected: Record<string, unknown> = {}
  add('loan', 'LOAN_EXISTS', !!loan, 'loan', loanId, true, !!loan)
  if (!loan) return { checks, expected }

  add('relationships', 'LOAN_WORKSPACE_MISMATCH', loan.workspaceId === workspaceId, 'loan', loan.id, workspaceId, loan.workspaceId)
  add('loan', 'LOAN_DELETED', !loan.isDeleted, 'loan', loan.id, false, !!loan.isDeleted)
  add('loan', 'LOAN_NUMBER_MISSING', !!loan.loanNo?.trim(), 'loan', loan.id)
  add('loan', 'LOAN_CURRENCY_MISSING', !!loan.settlementCurrency, 'loan', loan.id)
  add('loan', 'LOAN_PRINCIPAL_INVALID', Number.isFinite(loan.principalAmount) && loan.principalAmount >= 0, 'loan', loan.id, 'a non-negative amount', loan.principalAmount)
  add('loan', 'LOAN_PAID_INVALID', Number.isFinite(loan.totalPaidAmount) && loan.totalPaidAmount >= 0, 'loan', loan.id, 'a non-negative amount', loan.totalPaidAmount)
  add('loan', 'LOAN_BALANCE_INVALID', Number.isFinite(loan.balanceAmount) && loan.balanceAmount >= 0, 'loan', loan.id, 'a non-negative amount', loan.balanceAmount)
  add('loan', 'LOAN_STATUS_INVALID', ['active', 'overdue', 'completed', 'cancelled'].includes(loan.status), 'loan', loan.id, 'active, overdue, completed, or cancelled', loan.status)

  const loanDirection = loan.direction === 'borrowed' ? 'borrowed' : 'lent'
  const repaymentDirection = loanDirection === 'borrowed' ? 'outgoing' : 'incoming'
  const originationDirection = repaymentDirection === 'incoming' ? 'outgoing' : 'incoming'
  if (loan.direction) add('loan', 'LOAN_DIRECTION_INVALID', ['lent', 'borrowed'].includes(loan.direction), 'loan', loan.id, 'lent or borrowed', loan.direction)
  if (loan.loanCategory) add('loan', 'LOAN_CATEGORY_INVALID', ['standard', 'simple'].includes(loan.loanCategory), 'loan', loan.id, 'standard or simple', loan.loanCategory)

  if (loan.source === 'pos') {
    add('relationships', 'LOAN_SOURCE_LINK_MISSING', !!loan.saleId, 'sale', loan.saleId ?? loan.id, 'sale ID', loan.saleId ?? null)
  } else if (loan.source === 'order') {
    add('relationships', 'LOAN_SOURCE_LINK_MISSING', !!loan.orderId && ['sales', 'purchase'].includes(String(loan.orderType)), 'order', loan.orderId ?? loan.id,
      'order ID and sales or purchase type', { orderId: loan.orderId ?? null, orderType: loan.orderType ?? null })
  } else if (loan.source === 'manual') {
    add('relationships', 'LOAN_SOURCE_LINK_INVALID', !loan.saleId && !loan.orderId, 'loan', loan.id, null, { saleId: loan.saleId ?? null, orderId: loan.orderId ?? null })
  } else {
    add('loan', 'LOAN_SOURCE_INVALID', ['manual', 'pos', 'order'].includes(loan.source), 'loan', loan.id, 'manual, pos, or order', loan.source)
  }

  if (loan.linkedPartyId) {
    const partner = graph.partners.find(row => row.id === loan.linkedPartyId)
    add('relationships', 'LOAN_PARTNER_MISSING', !!partner && !partner.isDeleted, 'business_partner', loan.linkedPartyId, true, !!partner && !partner.isDeleted)
    if (partner) add('relationships', 'RELATED_WORKSPACE_MISMATCH', partner.workspaceId === workspaceId, 'business_partner', partner.id, workspaceId, partner.workspaceId)
    add('relationships', 'LOAN_PARTNER_TYPE_INVALID', loan.linkedPartyType === 'business_partner', 'loan', loan.id, 'business_partner', loan.linkedPartyType)
  } else {
    add('relationships', 'LOAN_PARTNER_REFERENCE_INVALID', !loan.linkedPartyType, 'loan', loan.id, null, loan.linkedPartyType ?? null)
  }

  const paymentRows = graph.payments
  const paymentById = new Map(paymentRows.map(row => [row.id, row]))
  const paymentRecordById = new Map(graph.loanPayments.map(row => [row.id, row]))
  for (const row of [...graph.loanPayments, ...graph.installments, ...paymentRows, ...graph.accountMovements, ...graph.paymentAccounts]) {
    add('relationships', 'RELATED_WORKSPACE_MISMATCH', row.workspaceId === workspaceId, 'related_record', row.id, workspaceId, row.workspaceId)
  }

  for (const row of paymentRows) {
    const isRepayment = repaymentTypes.has(row.sourceType) && row.sourceRecordId === loan.id && !row.reversalOfTransactionId
    const isOrigination = row.sourceType === 'loan_origination' && row.sourceRecordId === loan.id && !row.reversalOfTransactionId
    const relatedReversal = !!row.reversalOfTransactionId && paymentById.get(row.reversalOfTransactionId)?.sourceRecordId === loan.id
    add('relationships', 'LOAN_PAYMENT_REFERENCE_INVALID', isRepayment || isOrigination || relatedReversal,
      'payment_transaction', row.id, loan.id, row.sourceRecordId)
    if (row.sourceModule !== 'loans') add('payments', 'LOAN_PAYMENT_MODULE_INVALID', false, 'payment_transaction', row.id, 'loans', row.sourceModule)
    if (row.currency !== loan.settlementCurrency) add('payments', 'LOAN_PAYMENT_CURRENCY_MISMATCH', false, 'payment_transaction', row.id, loan.settlementCurrency, row.currency)
    if (row.reversalOfTransactionId) {
      const original = paymentById.get(row.reversalOfTransactionId)
      add('relationships', 'LOAN_PAYMENT_REVERSAL_ORPHANED', !!original, 'payment_transaction', row.id, row.reversalOfTransactionId, original?.id)
      if (original) {
        add('payments', 'LOAN_PAYMENT_REVERSAL_REFERENCE_MISMATCH', row.sourceRecordId === original.sourceRecordId
          && row.sourceType === original.sourceType && row.direction === original.direction,
        'payment_transaction', row.id, { sourceRecordId: original.sourceRecordId, sourceType: original.sourceType, direction: original.direction },
        { sourceRecordId: row.sourceRecordId, sourceType: row.sourceType, direction: row.direction })
        add('payments', 'LOAN_PAYMENT_REVERSAL_EXCEEDS_ORIGINAL', Math.abs(amount(row.amount)) <= Math.abs(amount(original.amount)) + ORDER_AMOUNT_EPSILON,
          'payment_transaction', row.id, Math.abs(amount(original.amount)), Math.abs(amount(row.amount)))
        add('payments', 'LOAN_PAYMENT_REVERSAL_SIGN_INVALID', amount(row.amount) < 0, 'payment_transaction', row.id, 'negative counter-entry', row.amount)
      }
    } else {
      const linkedPaymentId = paymentIdFor(row)
      if (isRepayment) {
        const linkedPayment = linkedPaymentId ? paymentRecordById.get(linkedPaymentId) : undefined
        add('relationships', 'LOAN_PAYMENT_RECORD_MISSING', !!linkedPayment, 'payment_transaction', row.id, linkedPaymentId, linkedPayment?.id,
          !loan.integrityVersion && !row.metadata?.loanPaymentId && !row.sourceSubrecordId)
        if (linkedPayment) add('payments', 'LOAN_PAYMENT_RECORD_REFERENCE_MISMATCH', linkedPayment.paymentTransactionId === row.id
          && linkedPayment.loanId === loan.id, 'loan_payment', linkedPayment.id, row.id, linkedPayment.paymentTransactionId)
        add('payments', 'LOAN_PAYMENT_DIRECTION_MISMATCH', row.direction === repaymentDirection, 'payment_transaction', row.id, repaymentDirection, row.direction)
        add('payments', 'LOAN_PAYMENT_AMOUNT_INVALID', Number.isFinite(row.amount) && row.amount > 0, 'payment_transaction', row.id, 'a positive amount', row.amount)
      }
      if (isOrigination) {
        add('payments', 'LOAN_ORIGINATION_DIRECTION_MISMATCH', row.direction === originationDirection, 'payment_transaction', row.id, originationDirection, row.direction)
        add('payments', 'LOAN_ORIGINATION_AMOUNT_MISMATCH', close(amount(row.amount), loan.principalAmount), 'payment_transaction', row.id, loan.principalAmount, row.amount)
        add('payments', 'LOAN_ORIGINATION_CURRENCY_MISMATCH', row.currency === loan.settlementCurrency, 'payment_transaction', row.id, loan.settlementCurrency, row.currency)
      }
    }

    if (row.accountId) {
      const account = graph.paymentAccounts.find(candidate => candidate.id === row.accountId)
      add('relationships', 'PAYMENT_ACCOUNT_REFERENCE_MISSING', !!account && !account.isDeleted, 'payment_account', row.accountId, true, !!account && !account.isDeleted)
      const movements = active(graph.accountMovements).filter(movement => movement.paymentTransactionId === row.id)
      add('payments', 'PAYMENT_ACCOUNT_MOVEMENT_MISSING', movements.length === 1, 'payment_transaction', row.id, 1, movements.length)
      if (movements.length === 1) {
        add('payments', 'PAYMENT_ACCOUNT_MOVEMENT_MISMATCH', movements[0].accountId === row.accountId
          && close(Math.abs(amount(movements[0].amount)), Math.abs(amount(row.amount)),), 'payment_account_movement', movements[0].id,
        { accountId: row.accountId, amount: Math.abs(amount(row.amount)) },
        { accountId: movements[0].accountId, amount: Math.abs(amount(movements[0].amount)) })
        const expectedDelta = row.voidId ? 0 : row.direction === 'incoming' ? amount(row.amount) : -amount(row.amount)
        add('payments', 'PAYMENT_ACCOUNT_DELTA_MISMATCH', close(expectedDelta, amount(movements[0].deltaAmount)),
          'payment_account_movement', movements[0].id, expectedDelta, movements[0].deltaAmount)
        add('payments', 'PAYMENT_ACCOUNT_CURRENCY_MISMATCH', movements[0].currency === row.currency,
          'payment_account_movement', movements[0].id, row.currency, movements[0].currency)
      }
    }
  }

  for (const movement of graph.accountMovements) {
    if (movement.paymentTransactionId) add('relationships', 'ORPHAN_ACCOUNT_MOVEMENT', paymentById.has(movement.paymentTransactionId),
      'payment_account_movement', movement.id, movement.paymentTransactionId, paymentById.get(movement.paymentTransactionId)?.id)
  }
  for (const original of paymentRows.filter(row => !row.reversalOfTransactionId)) {
    const reversed = paymentRows.filter(row => row.reversalOfTransactionId === original.id && !row.isDeleted && !row.voidId)
      .reduce((sum, row) => sum + Math.abs(amount(row.amount)), 0)
    add('payments', 'LOAN_PAYMENT_REVERSALS_EXCEED_ORIGINAL', reversed <= Math.abs(amount(original.amount)) + ORDER_AMOUNT_EPSILON,
      'payment_transaction', original.id, Math.abs(amount(original.amount)), reversed)
  }

  for (const row of graph.loanPayments) {
    add('relationships', 'LOAN_PAYMENT_LOAN_REFERENCE_INVALID', row.loanId === loan.id, 'loan_payment', row.id, loan.id, row.loanId)
    if (amount(row.reversedAmount) > ORDER_AMOUNT_EPSILON) {
      const original = row.paymentTransactionId ? paymentById.get(row.paymentTransactionId) : undefined
      const linkedReversals = original
        ? paymentRows.filter(candidate => candidate.reversalOfTransactionId === original.id && !candidate.isDeleted && !candidate.voidId)
        : []
      const reversedAmount = roundOrderValue(linkedReversals.reduce((sum, candidate) => sum + Math.abs(amount(candidate.amount)), 0))
      const reversal = row.reversalTransactionId ? paymentById.get(row.reversalTransactionId) : undefined
      const reversalRecordMatches = !!original && !!reversal && reversal.reversalOfTransactionId === original.id
        && close(reversedAmount, amount(row.reversedAmount))
      add('payments', 'LOAN_PAYMENT_REVERSAL_RECORD_MISMATCH', reversalRecordMatches, 'loan_payment', row.id,
        { originalTransactionId: row.paymentTransactionId, reversedAmount: row.reversedAmount },
        { originalTransactionId: original?.id ?? null, reversalTransactionId: reversal?.id ?? null, reversedAmount },
        !loan.integrityVersion && !row.integrityVersion)
    }
    if (row.isDeleted) {
      continue
    }

    const original = row.paymentTransactionId ? paymentById.get(row.paymentTransactionId) : undefined
    const historical = !loan.integrityVersion && !row.integrityVersion
    add('payments', 'LOAN_PAYMENT_TRANSACTION_MISSING', !!original, 'loan_payment', row.id, row.paymentTransactionId ?? null, original?.id ?? null, historical)
    if (!original) continue
    const net = paymentNet(original, paymentRows)
    const remaining = Math.max(0, amount(row.amount) - amount(row.reversedAmount))
    add('payments', 'LOAN_PAYMENT_AMOUNT_MISMATCH', close(remaining, net), 'loan_payment', row.id, remaining, net)
    if (row.reversalTransactionId) {
      const reversal = paymentById.get(row.reversalTransactionId)
      add('payments', 'LOAN_PAYMENT_REVERSAL_REFERENCE_MISMATCH', !!reversal && reversal.reversalOfTransactionId === original.id,
        'loan_payment', row.id, original.id, reversal?.reversalOfTransactionId ?? null, historical)
    }
  }

  const activePayments = active(graph.loanPayments)
  const paidFromRecords = roundOrderValue(activePayments.reduce((sum, row) => sum + Math.max(0, amount(row.amount) - amount(row.reversedAmount)), 0))
  const remainingBalance = roundOrderValue(Math.max(0, amount(loan.principalAmount) - paidFromRecords))
  expected.totalPaidAmount = paidFromRecords
  expected.balanceAmount = remainingBalance
  add('loan', 'LOAN_TOTAL_PAID_MISMATCH', close(paidFromRecords, amount(loan.totalPaidAmount)), 'loan', loan.id, paidFromRecords, loan.totalPaidAmount)
  add('loan', 'LOAN_BALANCE_MISMATCH', close(remainingBalance, amount(loan.balanceAmount)), 'loan', loan.id, remainingBalance, loan.balanceAmount)
  add('loan', 'LOAN_REPAYMENTS_EXCEED_PRINCIPAL', paidFromRecords <= amount(loan.principalAmount) + ORDER_AMOUNT_EPSILON,
    'loan', loan.id, loan.principalAmount, paidFromRecords)
  if (remainingBalance <= ORDER_AMOUNT_EPSILON) {
    add('loan', 'LOAN_COMPLETION_STATUS_MISMATCH', loan.status === 'completed' || loan.status === 'cancelled', 'loan', loan.id,
      'completed or cancelled', loan.status)
  } else {
    add('loan', 'LOAN_STATUS_BALANCE_MISMATCH', loan.status !== 'completed', 'loan', loan.id,
      'active, overdue, or cancelled', loan.status)
  }
  if (loan.source === 'manual') {
    const origination = loan.originationTransactionId ? paymentById.get(loan.originationTransactionId) : undefined
    add('payments', 'LOAN_ORIGINATION_TRANSACTION_MISSING', !!origination && origination.sourceType === 'loan_origination'
      && origination.sourceRecordId === loan.id, 'loan', loan.id, loan.originationTransactionId ?? null, origination?.id ?? null,
    !loan.integrityVersion)
  }

  const installments = active(graph.installments)
  const installmentNos = new Set<number>()
  for (const row of graph.installments) {
    add('relationships', 'LOAN_INSTALLMENT_LOAN_REFERENCE_INVALID', row.loanId === loan.id, 'loan_installment', row.id, loan.id, row.loanId)
  }
  for (const row of installments) {
    add('installments', 'LOAN_INSTALLMENT_NUMBER_INVALID', Number.isInteger(row.installmentNo) && row.installmentNo > 0,
      'loan_installment', row.id, 'a positive integer', row.installmentNo)
    add('installments', 'LOAN_INSTALLMENT_DUPLICATE_NUMBER', !installmentNos.has(row.installmentNo), 'loan_installment', row.id,
      'unique installment number', row.installmentNo)
    installmentNos.add(row.installmentNo)
    add('installments', 'LOAN_INSTALLMENT_AMOUNT_INVALID', [row.plannedAmount, row.paidAmount, row.balanceAmount].every(value => Number.isFinite(value) && value >= 0),
      'loan_installment', row.id, 'non-negative planned, paid, and balance amounts', {
        plannedAmount: row.plannedAmount, paidAmount: row.paidAmount, balanceAmount: row.balanceAmount
      })
    if (loan.status !== 'cancelled') {
      add('installments', 'LOAN_INSTALLMENT_BALANCE_MISMATCH', close(amount(row.paidAmount) + amount(row.balanceAmount), amount(row.plannedAmount)),
        'loan_installment', row.id, row.plannedAmount, amount(row.paidAmount) + amount(row.balanceAmount))
    }
  }
  if (loan.loanCategory !== 'simple' && Number(loan.installmentCount) > 0) {
    add('installments', 'LOAN_INSTALLMENTS_MISSING', installments.length === Number(loan.installmentCount), 'loan', loan.id,
      Number(loan.installmentCount), installments.length, !loan.integrityVersion)
  }
  if (installments.length > 0) {
    const planned = roundOrderValue(installments.reduce((sum, row) => sum + amount(row.plannedAmount), 0))
    expected.installmentPrincipal = planned
    add('installments', 'LOAN_INSTALLMENT_PRINCIPAL_MISMATCH', close(planned, amount(loan.principalAmount)), 'loan', loan.id,
      loan.principalAmount, planned)
    if (loan.status !== 'cancelled') {
      const scheduledPaid = roundOrderValue(installments.reduce((sum, row) => sum + amount(row.paidAmount), 0))
      const scheduledBalance = roundOrderValue(installments.reduce((sum, row) => sum + amount(row.balanceAmount), 0))
      add('installments', 'LOAN_INSTALLMENT_PAID_TOTAL_MISMATCH', close(scheduledPaid, paidFromRecords), 'loan', loan.id, paidFromRecords, scheduledPaid)
      add('installments', 'LOAN_INSTALLMENT_BALANCE_TOTAL_MISMATCH', close(scheduledBalance, remainingBalance), 'loan', loan.id, remainingBalance, scheduledBalance)
    }
  }

  return { checks, expected }
}

export async function runLoanIntegrityAudit(
  workspaceId: string,
  loanId: string,
  mode: 'cloud' | 'hybrid' | 'local' | 'demo'
): Promise<LoanIntegrityAuditResult> {
  const { resolveLoanTransactionGraph } = await import('./loanGraph')
  const sourceOfTruth = mode === 'local' || mode === 'demo' ? 'sqlite' : 'supabase'
  let actual: LoanTransactionGraph
  try {
    actual = await resolveLoanTransactionGraph(workspaceId, loanId, sourceOfTruth)
  } catch (error) {
    throw new IntegrityAuditReadError(sourceOfTruth, error)
  }

  const { checks, expected } = auditLoanGraph(actual, workspaceId, loanId)
  let mirrorStatus: AuditStatus | null = null
  let mirrorActual: LoanTransactionGraph | null = null
  if (mode === 'hybrid') {
    try {
      const mirror = await resolveLoanTransactionGraph(workspaceId, loanId, 'sqlite')
      mirrorActual = mirror
      const fields: Array<keyof LoanTransactionGraph> = ['loan', 'installments', 'loanPayments', 'payments', 'accountMovements', 'paymentAccounts']
      for (const key of fields) {
        const sourceRows = key === 'loan' ? (actual.loan ? [actual.loan] : []) : actual[key] as Array<{ id: string }>
        const mirrorRows = key === 'loan' ? (mirror.loan ? [mirror.loan] : []) : mirror[key] as Array<{ id: string }>
        const byId = new Map(mirrorRows.map(row => [row.id, row]))
        for (const row of sourceRows) {
          const localRow = byId.get(row.id)
          if (!localRow) {
            checks.push(check('mirror', 'SQLITE_MIRROR_RECORD_MISSING', false, key, row.id, 'present', 'missing', true))
            continue
          }
          const fieldsToCompare = key === 'loan'
            ? ['workspaceId', 'principalAmount', 'totalPaidAmount', 'balanceAmount', 'settlementCurrency', 'status', 'isDeleted']
            : key === 'loanPayments' ? ['workspaceId', 'loanId', 'amount', 'paymentTransactionId', 'reversedAmount', 'isDeleted']
              : key === 'installments' ? ['workspaceId', 'loanId', 'plannedAmount', 'paidAmount', 'balanceAmount', 'status', 'isDeleted']
                : key === 'payments' ? ['workspaceId', 'sourceType', 'sourceRecordId', 'sourceSubrecordId', 'direction', 'amount', 'currency', 'reversalOfTransactionId', 'voidId', 'isDeleted']
                  : key === 'accountMovements' ? ['workspaceId', 'accountId', 'paymentTransactionId', 'amount', 'deltaAmount', 'currency', 'voidId']
                    : ['workspaceId', 'currency', 'isDeleted']
          for (const field of fieldsToCompare) {
            const supabaseValue = (row as unknown as Record<string, unknown>)[field]
            const sqliteValue = (localRow as unknown as Record<string, unknown>)[field]
            if (supabaseValue !== sqliteValue) checks.push(check('mirror', 'SQLITE_MIRROR_FIELD_MISMATCH', false,
              `${key}.${field}`, row.id, supabaseValue, sqliteValue, true))
          }
        }
        for (const row of mirrorRows) if (!sourceRows.some(candidate => candidate.id === row.id)) {
          checks.push(check('mirror', 'SQLITE_MIRROR_EXTRA_RECORD', false, key, row.id, 'absent', 'present', true))
        }
      }
      mirrorStatus = statusOf(checks.filter(row => row.category === 'mirror'))
    } catch {
      mirrorStatus = 'WARNING'
      checks.push(check('mirror', 'SQLITE_MIRROR_UNAVAILABLE', false, 'loan', loanId, 'readable SQLite mirror', null, true))
    }
  }

  const transactionStatusChecks = checks.filter(row => row.category !== 'mirror')
  return {
    transactionType: 'loan',
    transactionId: loanId,
    transactionNumber: actual.loan?.loanNo,
    workspaceId,
    auditedAt: new Date().toISOString(),
    sourceOfTruth,
    integrityStatus: statusOf(transactionStatusChecks),
    mirrorStatus,
    checks,
    summary: summarize(checks),
    expected,
    actual,
    mirrorActual
  }
}
