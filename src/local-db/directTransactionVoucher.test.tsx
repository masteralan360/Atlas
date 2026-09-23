import 'fake-indexeddb/auto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { formatDirectTransactionVoucherNumber } from '@/lib/directTransactionVoucher'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from './database'

const workspaceId = '00000000-0000-4000-8000-000000000671'
let recordDirectTransaction: typeof import('./payments').recordDirectTransaction
let reversePaymentTransaction: typeof import('./payments').reversePaymentTransaction
let loadDirectTransactionVoucher: typeof import('./payments').loadDirectTransactionVoucher
let template: typeof import('@/ui/components/payments/DirectTransactionVoucherPrintTemplate').DirectTransactionVoucherPrintTemplate
let getLedgerPaymentTransactionEffect: typeof import('@/lib/ledgerPaymentTransactions').getLedgerPaymentTransactionEffect
let getLedgerPaymentTransactions: typeof import('@/lib/ledgerPaymentTransactions').getLedgerPaymentTransactions
let savePaymentAccount: typeof import('./paymentAccounts').savePaymentAccount

describe('direct transaction vouchers in Local mode', () => {
  beforeAll(async () => {
    installTestBrowser()
    ;({ recordDirectTransaction, reversePaymentTransaction, loadDirectTransactionVoucher } = await import('./payments'))
    ;({ DirectTransactionVoucherPrintTemplate: template } = await import('@/ui/components/payments/DirectTransactionVoucherPrintTemplate'))
    ;({ getLedgerPaymentTransactionEffect, getLedgerPaymentTransactions } = await import('@/lib/ledgerPaymentTransactions'))
    ;({ savePaymentAccount } = await import('./paymentAccounts'))
  }, 90_000)
  beforeEach(async () => {
    installTestBrowser()
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'local' })
  })
  afterEach(() => clearWorkspaceModeSnapshot(workspaceId))
  afterAll(async () => { await db.delete() })

  it('numbers posted rows and reversals once, preserving payment and ledger effects', async () => {
    const account = await savePaymentAccount(workspaceId, {
      name: 'Cash Drawer', accountType: 'cash_drawer',
      openingBalances: [{ currency: 'usd', amount: 1000 }]
    })
    const original = await recordDirectTransaction(workspaceId, {
      direction: 'incoming', amount: 100.01, currency: 'usd', paymentMethod: 'cash',
      reason: 'Cash receipt', counterpartyName: 'Alice',
      accountId: account.id, accountNameSnapshot: account.name
    })
    const another = await recordDirectTransaction(workspaceId, {
      direction: 'outgoing', amount: 20, currency: 'usd', paymentMethod: 'cash',
      reason: 'Delivery', counterpartyName: 'Bob'
    })
    const reversal = await reversePaymentTransaction(workspaceId, original.id, { amount: 33.34 })
    expect([original, another, reversal].map(formatDirectTransactionVoucherNumber))
      .toEqual(['DT-000001', 'DT-000002', 'DT-000003'])
    expect(reversal.reversalOfTransactionId).toBe(original.id)
    expect(reversal.amount).toBeCloseTo(-33.34, 6)

    const saved = await db.payment_transactions.where('workspaceId').equals(workspaceId).toArray()
    expect(getLedgerPaymentTransactions(saved).map(row => row.id)).toContain(reversal.id)
    expect(getLedgerPaymentTransactionEffect(reversal)).toEqual({ direction: 'outgoing', amount: 33.34 })
    const movements = await db.payment_account_movements.where('accountId').equals(account.id).toArray()
    expect(movements.filter(row => [original.id, reversal.id].includes(row.paymentTransactionId))
      .map(row => row.deltaAmount).sort((a, b) => a - b)).toEqual([-33.34, 100.01])
    const balance = await db.payment_account_balances.where('accountId').equals(account.id).first()
    expect(balance?.balanceAmount).toBeCloseTo(1066.67, 6)
    const voucher = await loadDirectTransactionVoucher(workspaceId, original.id)
    expect(voucher.related.map(row => row.id)).toEqual(expect.arrayContaining([original.id, reversal.id]))
    expect(voucher.related).not.toContainEqual(expect.objectContaining({ id: another.id }))

    const html = renderToStaticMarkup(createElement(template, {
      data: voucher, workspaceName: 'Atlas Shop', printLang: 'en', iqdPreference: 'IQD'
    }))
    expect(html).toContain('DT-000001')
    expect(html).toContain('DT-000003')
    expect(html).toContain('66.67')
    expect(html).toContain('Payer signature')
    expect(html).toContain('data-pdf-page-chunk')
    const arabic = renderToStaticMarkup(createElement(template, {
      data: voucher, workspaceName: 'Atlas Shop', printLang: 'ar', iqdPreference: 'IQD'
    }))
    expect(arabic).toContain('dir="rtl"')
    expect(arabic).toContain('سند قبض')
    const reversalHtml = renderToStaticMarkup(createElement(template, {
      data: { ...voucher, transaction: reversal },
      workspaceName: 'Atlas Shop', printLang: 'en', iqdPreference: 'IQD'
    }))
    expect(reversalHtml).toContain('Reversal Voucher')
    expect(reversalHtml).toContain('Original status')
    expect(reversalHtml).toMatch(/Payer<\/div><div[^>]*>Atlas Shop.*Recipient<\/div><div[^>]*>Alice/s)
  })

  it('keeps older unnumbered rows on their transaction ID and rejects invalid posting', async () => {
    await expect(recordDirectTransaction(workspaceId, {
      direction: 'incoming', amount: 0, currency: 'usd', paymentMethod: 'cash',
      reason: 'Invalid', counterpartyName: 'Alice'
    })).rejects.toThrow()
    expect(await db.payment_transactions.where('workspaceId').equals(workspaceId).count()).toBe(0)
    expect(formatDirectTransactionVoucherNumber({ id: 'legacy-id', voucherNumber: null })).toBe('legacy-id')
  })

  it('paginates long reversal history with repeated headings and the final signatures', async () => {
    const original = await recordDirectTransaction(workspaceId, {
      direction: 'outgoing', amount: 100, currency: 'usd', paymentMethod: 'cash',
      reason: 'Long history', counterpartyName: 'Bob'
    })
    const reversals = []
    for (let index = 0; index < 20; index++) {
      reversals.push(await reversePaymentTransaction(workspaceId, original.id, { amount: 1 }))
    }
    const html = renderToStaticMarkup(createElement(template, {
      data: { transaction: original, related: [original, ...reversals], asOf: new Date().toISOString() },
      workspaceName: 'Atlas Shop', printLang: 'en', iqdPreference: 'IQD'
    }))
    expect((html.match(/data-pdf-page-chunk/g) || []).length).toBe(3)
    expect(html).toContain('Page 3 of 3')
    expect(html).toContain('DT-000021')
    expect(html).toContain('Recipient signature')
  })

  it('continues long recorded reasons and notes onto numbered A4 pages', async () => {
    const original = await recordDirectTransaction(workspaceId, {
      direction: 'incoming', amount: 1, currency: 'usd', paymentMethod: 'cash',
      reason: 'R'.repeat(1200), note: 'N'.repeat(2100), counterpartyName: 'Alice'
    })
    const html = renderToStaticMarkup(createElement(template, {
      data: { transaction: original, related: [original], asOf: new Date().toISOString() },
      workspaceName: 'Atlas Shop', printLang: 'en', iqdPreference: 'IQD'
    }))
    expect(html).toContain('Page 6 of 6')
    expect((html.match(/height:297mm/g) || []).length).toBe(6)
    expect(html).toContain('Note (continued)')
  })
})
