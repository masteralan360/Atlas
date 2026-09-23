import type { ReactElement } from 'react'
import i18n from '@/i18n/config'
import type { PaymentTransaction, IQDDisplayPreference } from '@/local-db/models'
import { formatDirectTransactionVoucherNumber } from '@/lib/directTransactionVoucher'
import { isReportablePaymentTransaction } from '@/lib/financialReportability'
import { getPaymentTransactionReversalState } from '@/lib/paymentReversals'
import { formatCurrency } from '@/lib/utils'
import { platformService } from '@/services/platformService'

export type DirectTransactionVoucherData = {
  transaction: PaymentTransaction
  related: PaymentTransaction[]
  asOf: string
}

const chunkText = (value: string, firstSize: number, nextSize: number) => {
  const characters = Array.from(value)
  const chunks = [characters.splice(0, firstSize).join('')]
  while (characters.length) chunks.push(characters.splice(0, nextSize).join(''))
  return chunks
}

const paymentMethodKey = (method: PaymentTransaction['paymentMethod']) =>
  method === 'bank_transfer' ? 'bankTransfer'
    : method === 'loan_adjustment' ? 'loanAdjustment' : method

export function DirectTransactionVoucherPrintTemplate({ data, workspaceName, contactLine, logoUrl, printLang, iqdPreference }: {
  data: DirectTransactionVoucherData
  workspaceName: string
  contactLine?: string
  logoUrl?: string | null
  printLang: string
  iqdPreference: IQDDisplayPreference
}): ReactElement {
  const t = i18n.getFixedT(printLang)
  const lang = printLang.split('-')[0]
  const rtl = lang === 'ar' || lang === 'ku'
  const { transaction, related, asOf } = data
  const original = transaction.reversalOfTransactionId
    ? related.find(row => row.id === transaction.reversalOfTransactionId) || transaction
    : transaction
  const reversals = related.filter(row => row.reversalOfTransactionId === original.id && isReportablePaymentTransaction(row))
    .sort((left, right) => left.paidAt.localeCompare(right.paidAt))
  const state = getPaymentTransactionReversalState(original, related)
  const actualDirection = transaction.amount < 0
    ? transaction.direction === 'incoming' ? 'outgoing' : 'incoming'
    : transaction.direction
  const payer = actualDirection === 'incoming' ? transaction.counterpartyName || '—' : workspaceName
  const recipient = actualDirection === 'incoming' ? workspaceName : transaction.counterpartyName || '—'
  const title = transaction.reversalOfTransactionId
    ? t('directTransactions.voucher.reversalTitle')
    : actualDirection === 'incoming'
      ? t('directTransactions.voucher.receiptTitle')
      : t('directTransactions.voucher.paymentTitle')
  const reference = formatDirectTransactionVoucherNumber(transaction)
  const money = (amount: number) => formatCurrency(Math.abs(amount), transaction.currency, iqdPreference)
  const dateTime = (value: string) => new Date(value).toLocaleString(printLang)
  const reasonChunks = chunkText(transaction.referenceLabel || '—', 180, 850)
  const noteChunks = chunkText(transaction.note || '', 280, 850)
  const firstReversals = reversals.slice(0, 5)
  const remainingReversals = reversals.slice(5)
  const pages: Array<{ kind: 'first' | 'reason' | 'note' | 'reversals'; reason?: string; note?: string; reversals?: PaymentTransaction[] }> = [
    { kind: 'first', note: noteChunks[0], reversals: firstReversals },
    ...reasonChunks.slice(1).map(reason => ({ kind: 'reason' as const, reason })),
    ...noteChunks.slice(1).map(note => ({ kind: 'note' as const, note })),
  ]
  for (let index = 0; index < remainingReversals.length; index += 12) {
    pages.push({ kind: 'reversals', reversals: remainingReversals.slice(index, index + 12) })
  }
  const resolvedLogo = logoUrl
    ? /^(https?:|data:|blob:)/i.test(logoUrl) ? logoUrl : platformService.convertFileSrc(logoUrl)
    : null

  const reversalTable = (rows: PaymentTransaction[], continued: boolean) => (
    <section className="mt-5">
      <h2 className="mb-2 text-[12px] font-bold text-slate-800">
        {t('directTransactions.voucher.reversalHistory')}{continued ? ` ${t('directTransactions.voucher.continued')}` : ''}
      </h2>
      <table data-pdf-page-chunk className="w-full table-fixed border-collapse text-[10px]">
        <thead><tr className="bg-slate-100 text-slate-800">
          <th className="w-[27%] border border-slate-300 p-2 text-start">{t('directTransactions.voucher.reference')}</th>
          <th className="w-[27%] border border-slate-300 p-2 text-start">{t('directTransactions.voucher.date')}</th>
          <th className="w-[24%] border border-slate-300 p-2 text-start">{t('directTransactions.voucher.method')}</th>
          <th className="w-[22%] border border-slate-300 p-2 text-end">{t('directTransactions.voucher.amount')}</th>
        </tr></thead>
        <tbody>{rows.length ? rows.map(row => (
          <tr key={row.id} data-pdf-keep-together>
            <td className="break-all border border-slate-300 p-2">{formatDirectTransactionVoucherNumber(row)}</td>
            <td className="border border-slate-300 p-2">{dateTime(row.paidAt)}</td>
            <td className="border border-slate-300 p-2">{t(`directTransactions.paymentMethod.${paymentMethodKey(row.paymentMethod)}`)}</td>
            <td className="border border-slate-300 p-2 text-end font-semibold">{money(row.amount)}</td>
          </tr>
        )) : <tr><td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={4}>{t('directTransactions.voucher.noReversals')}</td></tr>}</tbody>
      </table>
    </section>
  )

  return <article dir={rtl ? 'rtl' : 'ltr'} className="bg-white text-slate-900" style={{ width: '210mm', fontFamily: 'Inter, Arial, sans-serif' }}>
    {pages.map((page, index) => <section key={index} className="flex flex-col bg-white" style={{ width: '210mm', height: '297mm', boxSizing: 'border-box', padding: '15mm' }}>
      <div>
        <header className="flex items-start justify-between gap-5 border-b-2 border-slate-800 pb-4" data-pdf-keep-together>
          <div className="flex items-center gap-3">
            {resolvedLogo ? <img src={resolvedLogo} alt="" className="h-12 w-12 object-contain" /> : null}
            <div><div className="text-[17px] font-bold">{workspaceName}</div>{contactLine ? <div className="max-w-[100mm] break-words text-[9px] text-slate-500">{contactLine}</div> : null}<div className="text-[11px] text-slate-500">{title}</div></div>
          </div>
          <div className="text-end"><div className="text-[9px] uppercase text-slate-500">{t('directTransactions.voucher.reference')}</div><div className="max-w-[72mm] break-all text-[15px] font-bold">{reference}</div></div>
        </header>

        {page.kind === 'first' ? <>
          <div className="mt-5 flex items-center justify-between rounded-lg bg-slate-100 px-4 py-3" data-pdf-keep-together>
            <div><div className="text-[10px] text-slate-500">{t('directTransactions.voucher.amount')}</div><div className="text-[22px] font-bold">{money(transaction.amount)}</div></div>
            <div className="text-end text-[11px]"><div>{t('directTransactions.voucher.status')}: <strong>{transaction.reversalOfTransactionId ? t('directTransactions.status.reversal') : t(`directTransactions.voucher.${state.status}`)}</strong></div>{transaction.reversalOfTransactionId ? <div>{t('directTransactions.voucher.originalStatus')}: <strong>{t(`directTransactions.voucher.${state.status}`)}</strong></div> : null}<div>{t('directTransactions.voucher.currency')}: {transaction.currency.toUpperCase()}</div></div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 text-[11px]" data-pdf-keep-together>
            {([
              [t('directTransactions.voucher.date'), dateTime(transaction.paidAt)],
              [t('directTransactions.voucher.method'), t(`directTransactions.paymentMethod.${paymentMethodKey(transaction.paymentMethod)}`)],
              [t('directTransactions.voucher.payer'), payer],
              [t('directTransactions.voucher.recipient'), recipient],
              [t('directTransactions.voucher.account'), transaction.accountNameSnapshot || '—'],
              [t('directTransactions.voucher.linkedPartner'), typeof transaction.metadata?.businessPartnerId === 'string' && transaction.metadata.businessPartnerId ? transaction.counterpartyName || '—' : '—'],
            ] as [string, string][]).map(([label, value]) => <div key={label} className="border-b border-slate-200 pb-2"><div className="text-[9px] font-semibold uppercase text-slate-500">{label}</div><div className="break-words font-medium">{value}</div></div>)}
          </div>
          <div className="mt-4 text-[11px]"><div className="text-[9px] font-semibold uppercase text-slate-500">{t('directTransactions.voucher.reason')}</div><div className="break-words font-medium">{reasonChunks[0]}</div></div>
          {page.note ? <div className="mt-3 text-[11px]"><div className="text-[9px] font-semibold uppercase text-slate-500">{t('directTransactions.voucher.note')}</div><div className="whitespace-pre-wrap break-words">{page.note}</div></div> : null}
          {transaction.reversalOfTransactionId ? <div className="mt-3 text-[10px] text-slate-600">{t('directTransactions.voucher.originalReference')}: {formatDirectTransactionVoucherNumber(original)}</div> : null}
          {reversalTable(page.reversals || [], false)}
        </> : page.kind === 'reason' || page.kind === 'note' ? <div className="mt-6"><h2 className="text-[12px] font-bold">{t(page.kind === 'reason' ? 'directTransactions.voucher.reason' : 'directTransactions.voucher.note')} {t('directTransactions.voucher.continued')}</h2><p className="whitespace-pre-wrap break-words text-[11px] leading-5">{page.kind === 'reason' ? page.reason : page.note}</p></div>
          : reversalTable(page.reversals || [], true)}
      </div>

      <footer className="mt-auto pt-4">
        {index === pages.length - 1 ? <div data-pdf-keep-together>
          <div className="grid grid-cols-2 gap-3 border-t border-slate-300 py-3 text-[11px]">
            <div>{t('directTransactions.voucher.reversedTotal')}: <strong>{money(state.reversedAmount)}</strong></div>
            <div className="text-end">{t('directTransactions.voucher.remaining')}: <strong>{money(state.remainingAmount)}</strong></div>
          </div>
          <div className="mt-7 grid grid-cols-3 gap-5 text-center text-[10px]">
            {[t('directTransactions.voucher.payerSignature'), t('directTransactions.voucher.recipientSignature'), t('directTransactions.voucher.preparerSignature')].map(label => <div key={label}><div className="border-t border-slate-500 pt-2">{label}</div></div>)}
          </div>
        </div> : null}
        <div className="mt-7 flex justify-between border-t border-slate-200 pt-2 text-[8px] text-slate-500">
          <span>{t('directTransactions.voucher.transactionId')}: {transaction.id}</span>
          <span>{t('directTransactions.voucher.asOf')}: {dateTime(asOf)} · {t('directTransactions.voucher.page', { page: index + 1, total: pages.length })}</span>
        </div>
      </footer>
    </section>)}
  </article>
}
