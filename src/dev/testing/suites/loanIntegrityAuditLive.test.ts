import { describe, expect, it } from 'vitest'
import {
  financeLivePosInput, freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
  setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('Loans · hosted transaction integrity audit', () => {
  setupHostedPos()

  it('reconciles a persisted loan graph and respects workspace row security', async () => {
    await withLivePosFixture(async ({ ids, input }) => {
      const { commitPosCheckout } = await import('@/local-db/posCheckout')
      const { runLoanIntegrityAudit } = await import('@/lib/integrityAudit/loanAudit')
      const checkout = financeLivePosInput(input(), 1)
      const loanPayload = checkout.atomicLoanPayload!
      loanPayload.workspace_id = livePosWorkspaceId
      loanPayload.sale_id = checkout.payload.id
      loanPayload.created_by = checkout.user.id
      loanPayload.first_due_date = new Date(Date.now() + 30 * 86_400_000).toISOString()
      checkout.loanRegistration!.firstDueDate = loanPayload.first_due_date as string
      ids.saleId = checkout.payload.id
      ids.loanId = loanPayload.id as string
      recordPosFixture(ids)

      const checkoutResult = await commitPosCheckout(checkout)
      expect(checkoutResult.loanId).toBe(ids.loanId)
      const observer = await freshPosClient()
      try {
        const paymentRowsBefore = requirePosLiveData(await observer.from('payment_transactions').select('id')
          .eq('workspace_id', livePosWorkspaceId).eq('source_record_id', ids.loanId), 'loan payments before audit')
        const audit = await runLoanIntegrityAudit(livePosWorkspaceId, ids.loanId!, 'cloud')
        expect(audit.integrityStatus).toBe('PASS')
        expect(audit.transactionType).toBe('loan')
        expect(audit.actual.loan).toMatchObject({ id: ids.loanId, source: 'pos', saleId: checkout.payload.id })
        expect(audit.actual.installments).toHaveLength(1)

        const hiddenAudit = await runLoanIntegrityAudit('00000000-0000-0000-0000-000000000000', ids.loanId!, 'cloud')
        expect(hiddenAudit.actual.loan).toBeNull()
        expect(hiddenAudit.checks).toContainEqual(expect.objectContaining({ code: 'LOAN_EXISTS', status: 'FAIL', actual: false }))

        const loan = requirePosLiveData(await observer.from('loans').select('id,workspace_id,principal_amount,balance_amount,is_deleted')
          .eq('id', ids.loanId).single(), 'audited loan')
        const installments = requirePosLiveData(await observer.from('loan_installments').select('id,planned_amount,paid_amount,balance_amount')
          .eq('loan_id', ids.loanId), 'audited loan schedule')
        const paymentRows = requirePosLiveData(await observer.from('payment_transactions').select('id')
          .eq('workspace_id', livePosWorkspaceId).eq('source_record_id', ids.loanId), 'audited loan payment transactions')
        expect(loan).toMatchObject({ id: ids.loanId, workspace_id: livePosWorkspaceId, is_deleted: false })
        expect(Number(loan.principal_amount)).toBe(100)
        expect(Number(loan.balance_amount)).toBe(100)
        expect(installments).toHaveLength(1)
        expect(Number(installments[0].planned_amount)).toBe(100)
        expect(paymentRows.map((row: { id: string }) => row.id)).toEqual(paymentRowsBefore.map((row: { id: string }) => row.id))
      } finally { await observer.auth.signOut() }
    })
  }, 120_000)
})
