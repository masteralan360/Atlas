import type { ReactElement } from 'react'
import i18n from '@/i18n/config'
import type { IQDDisplayPreference, PaymentTransaction } from '@/local-db/models'
import type { PaymentTransactionReversalState } from '@/lib/paymentReversals'
import { formatCurrency } from '@/lib/utils'
import { platformService } from '@/services/platformService'

export type PaymentTransactionPrintStatus = 'reversal' | 'partialReversal' | 'locked' | 'reversed' | 'posted'

export type PaymentTransactionPrintData = {
  transaction: PaymentTransaction
  displayAmount: number
  status: PaymentTransactionPrintStatus
  reversalSummary: Pick<PaymentTransactionReversalState, 'reversedAmount' | 'remainingAmount'> | null
  asOf: string
}

const chunkText = (value: string, firstSize: number, nextSize: number) => {
  const characters = Array.from(value)
  const chunks = [characters.splice(0, firstSize).join('')]
  while (characters.length) chunks.push(characters.splice(0, nextSize).join(''))
  return chunks
}

export function PaymentTransactionPrintTemplate({ data, workspaceName, contactLine, logoUrl, printLang, iqdPreference, sourceLabel, methodLabel }: {
  data: PaymentTransactionPrintData
  workspaceName: string
  contactLine?: string
  logoUrl?: string | null
  printLang: string
  iqdPreference: IQDDisplayPreference
  sourceLabel: string
  methodLabel: string
}): ReactElement {
  const t = i18n.getFixedT(printLang)
  const lang = printLang.split('-')[0]
  const rtl = lang === 'ar' || lang === 'ku'
  const { transaction, displayAmount, status, reversalSummary, asOf } = data
  const noteChunks = transaction.note?.trim() ? chunkText(transaction.note.trim(), 320, 900) : []
  const pages: Array<{ kind: 'first' | 'note'; note?: string }> = [
    { kind: 'first', note: noteChunks[0] },
    ...noteChunks.slice(1).map(note => ({ kind: 'note' as const, note }))
  ]
  const dateTime = (value: string) => new Date(value).toLocaleString(printLang)
  const money = (amount: number) => formatCurrency(Math.abs(amount), transaction.currency, iqdPreference)
  const statusLabel = status === 'reversal'
    ? t('payments.status.reversal')
    : status === 'partialReversal'
      ? t('directTransactions.voucher.partially_reversed')
      : status === 'locked'
        ? t('payments.status.locked')
        : status === 'reversed'
          ? t('payments.status.reversed')
          : t('payments.status.posted')
  const directionLabel = transaction.reversalOfTransactionId
    ? transaction.direction === 'incoming'
      ? t('paymentReversal.cashReturned')
      : t('paymentReversal.cashRestored')
    : transaction.direction === 'incoming'
      ? t('payments.filters.incoming')
      : t('payments.filters.outgoing')
  const resolvedLogo = logoUrl
    ? /^(https?:|data:|blob:)/i.test(logoUrl) ? logoUrl : platformService.convertFileSrc(logoUrl)
    : null

  const fields = ([
    [t('payments.transactionPrint.paymentDate'), dateTime(transaction.paidAt)],
    [t('payments.table.source'), sourceLabel],
    [t('payments.table.reference'), transaction.referenceLabel?.trim() || null],
    [t('payments.transactionPrint.sourceRecordId'), transaction.sourceRecordId],
    [t('payments.transactionPrint.sourceSubrecordId'), transaction.sourceSubrecordId?.trim() || null],
    [t('payments.table.direction'), directionLabel],
    [t('payments.table.method'), methodLabel],
    [t('payments.table.counterparty'), transaction.counterpartyName?.trim() || null],
    [t('directTransactions.voucher.account'), transaction.accountNameSnapshot?.trim() || null],
    [t('payments.transactionPrint.originalTransaction'), transaction.reversalOfTransactionId || null],
  ] satisfies Array<[string, string | null | undefined]>).filter(([, value]) => typeof value === 'string' && value.length > 0)

  return <article dir={rtl ? 'rtl' : 'ltr'} className="bg-white text-slate-900" style={{ width: '210mm', fontFamily: 'Inter, Arial, sans-serif' }}>
    {pages.map((page, index) => <section key={index} className="flex flex-col bg-white" style={{ width: '210mm', height: '297mm', boxSizing: 'border-box', padding: '15mm' }}>
      <div>
        <header className="flex items-start justify-between gap-5 border-b-2 border-slate-800 pb-4" data-pdf-keep-together>
          <div className="flex items-center gap-3">
            {resolvedLogo ? <img src={resolvedLogo} alt="" className="h-12 w-12 object-contain" /> : null}
            <div><div className="text-[17px] font-bold">{workspaceName}</div>{contactLine ? <div className="max-w-[100mm] break-words text-[9px] text-slate-500">{contactLine}</div> : null}<div className="text-[11px] text-slate-500">{t('payments.transactionPrint.title')}</div></div>
          </div>
          <div className="text-end"><div className="text-[9px] uppercase text-slate-500">{t('directTransactions.voucher.transactionId')}</div><div className="max-w-[72mm] break-all text-[15px] font-bold">{transaction.id}</div></div>
        </header>

        {page.kind === 'first' ? <>
          <div className="mt-5 flex items-center justify-between rounded-lg bg-slate-100 px-4 py-3" data-pdf-keep-together>
            <div><div className="text-[10px] text-slate-500">{t('payments.table.amount')}</div><div className="text-[22px] font-bold">{displayAmount < 0 ? '−' : ''}{money(displayAmount)}</div></div>
            <div className="text-end text-[11px]"><div>{t('payments.table.status')}: <strong>{statusLabel}</strong></div><div>{t('directTransactions.voucher.currency')}: {transaction.currency.toUpperCase()}</div></div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 text-[11px]" data-pdf-keep-together>
            {fields.map(([label, value]) => <div key={label} className="border-b border-slate-200 pb-2"><div className="text-[9px] font-semibold uppercase text-slate-500">{label}</div><div className="break-words font-medium">{value}</div></div>)}
          </div>
          {page.note ? <div className="mt-4 text-[11px]"><div className="text-[9px] font-semibold uppercase text-slate-500">{t('payments.table.note')}</div><div className="whitespace-pre-wrap break-words">{page.note}</div></div> : null}
        </> : <div className="mt-6"><h2 className="text-[12px] font-bold">{t('payments.table.note')} {t('directTransactions.voucher.continued')}</h2><p className="whitespace-pre-wrap break-words text-[11px] leading-5">{page.note}</p></div>}
      </div>

      <footer className="mt-auto pt-4">
        {index === pages.length - 1 ? <div data-pdf-keep-together>
          {reversalSummary ? <div className="grid grid-cols-2 gap-3 border-t border-slate-300 py-3 text-[11px]">
            <div>{t('directTransactions.voucher.reversedTotal')}: <strong>{money(reversalSummary.reversedAmount)}</strong></div>
            <div className="text-end">{t('directTransactions.voucher.remaining')}: <strong>{money(reversalSummary.remainingAmount)}</strong></div>
          </div> : null}
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
