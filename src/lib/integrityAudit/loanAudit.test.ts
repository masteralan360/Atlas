import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoanTransactionGraph } from './loanGraph'
import { resolveLoanTransactionGraph } from './loanGraph'
import { auditLoanGraph, runLoanIntegrityAudit } from './loanAudit'
import { buildIntegrityAuditModel } from './auditModel'
import { IntegrityAuditReadError } from './types'

vi.mock('./loanGraph', () => ({ resolveLoanTransactionGraph: vi.fn() }))

const workspaceId = 'workspace-1'
const loanId = 'loan-1'

function graph(): LoanTransactionGraph {
  return {
    loan: {
      id: loanId, workspaceId, loanNo: 'LN-00001', source: 'pos', saleId: 'sale-1', loanCategory: 'standard', direction: 'lent',
      principalAmount: 100, totalPaidAmount: 20, balanceAmount: 80, settlementCurrency: 'usd', installmentCount: 1,
      firstDueDate: '2026-10-31', status: 'active', integrityVersion: 1, isDeleted: false
    } as any,
    installments: [{ id: 'installment-1', workspaceId, loanId, installmentNo: 1, plannedAmount: 100,
      paidAmount: 20, balanceAmount: 80, status: 'partial', isDeleted: false } as any],
    loanPayments: [{ id: 'repayment-1', workspaceId, loanId, amount: 20, paymentTransactionId: 'transaction-1',
      reversedAmount: 0, integrityVersion: 1, isDeleted: false } as any],
    payments: [{ id: 'transaction-1', workspaceId, sourceModule: 'loans', sourceType: 'simple_loan', sourceRecordId: loanId,
      sourceSubrecordId: 'repayment-1', direction: 'incoming', amount: 20, currency: 'usd', paymentMethod: 'cash',
      accountId: 'account-1', isDeleted: false } as any],
    accountMovements: [{ id: 'movement-1', workspaceId, accountId: 'account-1', paymentTransactionId: 'transaction-1',
      direction: 'incoming', amount: 20, deltaAmount: 20, currency: 'usd' } as any],
    paymentAccounts: [{ id: 'account-1', workspaceId, currency: 'usd', isDeleted: false } as any], partners: []
  }
}

const failures = (value: LoanTransactionGraph) => auditLoanGraph(value, workspaceId, loanId).checks.filter(row => row.status === 'FAIL')

describe('Loan transaction integrity reconciliation', () => {
  beforeEach(() => vi.mocked(resolveLoanTransactionGraph).mockReset())

  it('reconstructs a loan balance from its payments and validates the schedule', () => {
    const audit = auditLoanGraph(graph(), workspaceId, loanId)
    expect(audit.checks.filter(row => row.status === 'FAIL')).toEqual([])
    expect(audit.expected).toMatchObject({ totalPaidAmount: 20, balanceAmount: 80, installmentPrincipal: 100 })
  })

  it('detects balance, payment-record, currency, direction, and schedule discrepancies', () => {
    const value = graph()
    value.loan!.balanceAmount = 70
    value.loanPayments[0].amount = 19
    value.payments[0].currency = 'iqd'
    value.payments[0].direction = 'outgoing'
    value.installments[0].balanceAmount = 70
    value.accountMovements[0].deltaAmount = 15
    expect(failures(value).map(row => row.code)).toEqual(expect.arrayContaining([
      'LOAN_BALANCE_MISMATCH', 'LOAN_PAYMENT_AMOUNT_MISMATCH', 'LOAN_PAYMENT_CURRENCY_MISMATCH',
      'LOAN_PAYMENT_DIRECTION_MISMATCH', 'LOAN_INSTALLMENT_BALANCE_MISMATCH', 'PAYMENT_ACCOUNT_DELTA_MISMATCH'
    ]))
  })

  it('uses the loan module three-decimal precision for fractional repayments', () => {
    const value = graph()
    value.loan!.principalAmount = 10.005
    value.loan!.totalPaidAmount = 3.335
    value.loan!.balanceAmount = 6.67
    value.loanPayments[0].amount = 3.335
    value.payments[0].amount = 3.335
    value.accountMovements[0].amount = 3.335
    value.accountMovements[0].deltaAmount = 3.335
    value.installments[0].plannedAmount = 10.005
    value.installments[0].paidAmount = 3.335
    value.installments[0].balanceAmount = 6.67
    value.installments[0].status = 'partial'
    const audit = auditLoanGraph(value, workspaceId, loanId)
    expect(audit.expected).toMatchObject({ totalPaidAmount: 3.335, balanceAmount: 6.67 })
    expect(audit.checks.filter(row => row.status === 'FAIL')).toEqual([])
  })

  it('flags repayments that cross the principal boundary', () => {
    const value = graph()
    value.loan!.principalAmount = 100
    value.loan!.totalPaidAmount = 101
    value.loan!.balanceAmount = 0
    value.loanPayments[0].amount = 101
    value.payments[0].amount = 101
    value.accountMovements[0].amount = 101
    value.accountMovements[0].deltaAmount = 101
    value.installments[0].paidAmount = 101
    value.installments[0].balanceAmount = 0
    value.installments[0].status = 'paid'
    expect(failures(value).map(row => row.code)).toContain('LOAN_REPAYMENTS_EXCEED_PRINCIPAL')
  })

  it('accepts a full repayment reversal only when the linked counter-entry exactly reverses it', () => {
    const value = graph()
    value.loan!.totalPaidAmount = 0
    value.loan!.balanceAmount = 100
    value.installments[0].paidAmount = 0
    value.installments[0].balanceAmount = 100
    value.installments[0].status = 'unpaid'
    value.loanPayments[0] = { ...value.loanPayments[0], reversedAmount: 20, reversalTransactionId: 'reversal-1', isDeleted: true }
    value.payments.push({ ...value.payments[0], id: 'reversal-1', amount: -20, reversalOfTransactionId: 'transaction-1' } as any)
    value.accountMovements.push({ ...value.accountMovements[0], id: 'movement-reversal', paymentTransactionId: 'reversal-1',
      amount: -20, deltaAmount: -20 } as any)
    expect(failures(value)).toEqual([])

    value.payments[1].amount = -15
    expect(failures(value).map(row => row.code)).toContain('LOAN_PAYMENT_REVERSAL_RECORD_MISMATCH')
  })

  it('reports missing legacy payment history as a warning instead of asserting a false failure', () => {
    const value = graph()
    value.loan!.integrityVersion = 0
    value.loanPayments[0] = { ...value.loanPayments[0], paymentTransactionId: null, integrityVersion: 0 }
    value.payments = []
    value.accountMovements = []
    const audit = auditLoanGraph(value, workspaceId, loanId)
    expect(audit.checks).toContainEqual(expect.objectContaining({ code: 'LOAN_PAYMENT_TRANSACTION_MISSING', status: 'WARNING' }))
    expect(audit.checks.filter(row => row.status === 'FAIL')).toEqual([])
  })

  it('checks manual loan origination against its payment transaction', () => {
    const value = graph()
    value.loan = { ...value.loan!, source: 'manual', saleId: null, originationTransactionId: 'origin-1' } as any
    value.payments = [{ id: 'origin-1', workspaceId, sourceModule: 'loans', sourceType: 'loan_origination', sourceRecordId: loanId,
      direction: 'outgoing', amount: 100, currency: 'usd', paymentMethod: 'cash', isDeleted: false } as any,
      ...value.payments]
    expect(failures(value)).toEqual([])
    value.payments[0].amount = 90
    expect(failures(value).map(row => row.code)).toContain('LOAN_ORIGINATION_AMOUNT_MISMATCH')
  })

  it('keeps Hybrid mirror mismatches separate and exposes loan details in the JSON snapshot', async () => {
    const source = graph()
    const mirror = graph()
    mirror.loan!.balanceAmount = 75
    vi.mocked(resolveLoanTransactionGraph).mockImplementation(async (_workspace, _loan, target) => target === 'supabase' ? source : mirror)
    const result = await runLoanIntegrityAudit(workspaceId, loanId, 'hybrid')
    expect(result.integrityStatus).toBe('PASS')
    expect(result.mirrorStatus).toBe('WARNING')
    expect(result.checks).toContainEqual(expect.objectContaining({ category: 'mirror', code: 'SQLITE_MIRROR_FIELD_MISMATCH', entityType: 'loan.balanceAmount', status: 'WARNING', severity: 'warning' }))
    expect(buildIntegrityAuditModel(result)).toMatchObject({
      transaction: { type: 'loan', id: loanId, number: 'LN-00001', status: 'active', currency: 'usd' },
      expected: { totalPaidAmount: 20, balanceAmount: 80 },
      summary: { integrityStatus: 'PASS', mirrorStatus: 'WARNING' }
    })
  })

  it('uses SQLite alone in Local mode and fails closed when required source records cannot be read', async () => {
    vi.mocked(resolveLoanTransactionGraph).mockResolvedValue(graph())
    const local = await runLoanIntegrityAudit(workspaceId, loanId, 'local')
    expect(local.sourceOfTruth).toBe('sqlite')
    expect(local.mirrorStatus).toBeNull()
    expect(resolveLoanTransactionGraph).toHaveBeenCalledWith(workspaceId, loanId, 'sqlite')

    vi.mocked(resolveLoanTransactionGraph).mockRejectedValueOnce(new Error('permission denied'))
    await expect(runLoanIntegrityAudit(workspaceId, loanId, 'cloud')).rejects.toBeInstanceOf(IntegrityAuditReadError)
  })
})
