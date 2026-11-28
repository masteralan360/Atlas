import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { platformService } from '@/services/platformService'
import { emptyPostalLocationCatalog, formatPostalShipmentId, locationLabel, type PostalLocationCatalog } from './domain'
import { ShipmentQr } from './ShipmentLabel'
import type {
  PostalStatementPrintData,
  PostalStatementPrintPageData,
} from '@/local-db/postalStatementPrint'
import type { TemplatePreviewVisibilityField } from '@/lib/printPreviewEditorStore'

const MAX_PRINT_ROWS_PER_PAGE = 8

export const POSTAL_ACCOUNT_STATEMENT_PRINT_COLUMNS = [
  { key: 'row_number', label: '#', width: 3 },
  { key: 'organization', label: 'postal.statement.partyLabel', width: 7 },
  { key: 'recipient_phone', label: 'postal.recipientPhoneNumber', width: 6 },
  { key: 'recipient', label: 'directTransactions.voucher.recipient', width: 5 },
  { key: 'destination', label: 'postal.destination', width: 8 },
  { key: 'receipt_number', label: 'postal.statement.receiptNumber', width: 8 },
  { key: 'cod_amount', label: 'postal.codAmount', width: 7 },
  { key: 'delivery_fee', label: 'postal.deliveryFee', width: 5 },
  { key: 'cash_movement', label: 'postal.statement.cashMovement', width: 8 },
  { key: 'debit', label: 'postal.statement.debit', width: 6 },
  { key: 'credit', label: 'postal.statement.credit', width: 6 },
  { key: 'balance', label: 'postal.statement.balance', width: 7 },
  { key: 'pieces', label: 'postal.pieces', width: 4 },
  { key: 'status', label: 'postal.status', width: 7 },
  { key: 'notes', label: 'postal.notes', width: 7 },
  { key: 'transaction_date', label: 'postal.statement.transactionDate', width: 6 },
] as const

export const POSTAL_ACCOUNT_STATEMENT_VISIBILITY_FIELDS: TemplatePreviewVisibilityField[] =
  POSTAL_ACCOUNT_STATEMENT_PRINT_COLUMNS.map(({ key, label }) => ({ key, label }))

function resolveWorkspaceLogoSrc(logoUrl?: string | null) {
  if (!logoUrl) return null
  return /^(https?:|data:|blob:)/i.test(logoUrl) ? logoUrl : platformService.convertFileSrc(logoUrl)
}

export function paginatePostalStatementPrintData(data: PostalStatementPrintData): PostalStatementPrintPageData[] {
  const pageCount = Math.max(1, Math.ceil(data.entries.length / MAX_PRINT_ROWS_PER_PAGE))
  const baseRowsPerPage = Math.floor(data.entries.length / pageCount)
  const extraRows = data.entries.length % pageCount
  let rowOffset = 0

  return Array.from({ length: pageCount }, (_, pageIndex) => {
    const pageRows = baseRowsPerPage + (pageIndex < extraRows ? 1 : 0)
    const pageStart = rowOffset
    rowOffset += pageRows
    return {
      ...data,
      entries: data.entries.slice(pageStart, rowOffset),
      pageNumber: pageIndex + 1,
      pageCount,
      rowOffset: pageStart,
      isFirstPage: pageIndex === 0,
      isLastPage: pageIndex === pageCount - 1,
    }
  })
}

function money(value: string, language: string) {
  return new Intl.NumberFormat(language).format(BigInt(value))
}

function dateTime(value: string, language: string) {
  return new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
}

function dateOnly(value: string | undefined, language: string) {
  return value ? new Date(value).toLocaleDateString(language) : null
}

export function PostalStatementPrintPage({
  data,
  workspaceName,
  printLang,
  logoUrl,
  locationCatalog = emptyPostalLocationCatalog,
  hiddenFields = {},
}: {
  data: PostalStatementPrintPageData
  workspaceName?: string | null
  printLang: string
  logoUrl?: string | null
  locationCatalog?: PostalLocationCatalog
  hiddenFields?: Record<string, boolean>
}) {
  const { i18n } = useTranslation()
  const t = i18n.getFixedT(printLang)
  const counts = data.shipment_counts
  const startDate = dateOnly(data.start, printLang)
  const endDate = dateOnly(data.end, printLang)
  const periodLabel = startDate || endDate
    ? `${startDate || '…'} - ${endDate || '…'}`
    : t('postal.statement.allDates')
  const isRtlPrintLanguage = printLang.startsWith('ar') || printLang.startsWith('ku')
  const resolvedLogoUrl = resolveWorkspaceLogoSrc(logoUrl)
  const fillPageHeight = data.entries.length >= 6
  const cell = 'border border-slate-300 px-1 py-1 align-middle text-center break-words'
  const headerCell = 'border border-slate-300 px-1 py-1.5 align-middle text-center break-words'
  const numericCell = `${cell} tabular-nums whitespace-normal`
  const visibleColumns = POSTAL_ACCOUNT_STATEMENT_PRINT_COLUMNS.filter((column) => !hiddenFields[column.key])
  const visibleColumnWidthTotal = visibleColumns.reduce((total, column) => total + column.width, 0)
  const columnCell = (key: typeof POSTAL_ACCOUNT_STATEMENT_PRINT_COLUMNS[number]['key'], entry: PostalStatementPrintData['entries'][number], index: number) => {
    const shipmentId = formatPostalShipmentId({ shipment_number: entry.shipment_number, created_at: entry.shipment_created_at })
    const destination = [
      locationLabel(entry.shipment.governorate, printLang, undefined, locationCatalog),
      locationLabel(entry.shipment.area, printLang, entry.shipment.governorate, locationCatalog),
      entry.shipment.address,
    ].filter(Boolean).join(' · ')
    const movementLabel = entry.kind === 'settlement' && BigInt(entry.signed_amount) < 0n
      ? t('postal.statement.printSettlementReceiveFromParty')
      : t(entry.kind === 'delivery_accrual'
        ? 'postal.statement.printDeliveryAccrual'
        : entry.kind === 'delivery_fee'
          ? 'postal.deliveryFeeCollection'
          : `postal.statement.${entry.kind}`)

    switch (key) {
      case 'row_number':
        return <td className={`${cell} tabular-nums`}>{new Intl.NumberFormat(printLang).format(data.rowOffset + index + 1)}</td>
      case 'organization':
        return <td className={`${cell} font-medium`}><bdi>{data.organization.name}</bdi></td>
      case 'recipient_phone':
        return <td className={`${cell} whitespace-nowrap`}><bdi dir="ltr">{entry.primary_phone}</bdi></td>
      case 'recipient':
        return <td className={cell}>
          <div className="line-clamp-2 font-semibold"><bdi>{entry.recipient_name}</bdi></div>
        </td>
      case 'destination':
        return <td className={cell}>
          <div className="line-clamp-2 font-semibold"><bdi>{destination || '—'}</bdi></div>
        </td>
      case 'receipt_number':
        return <td className={cell}>
          <bdi dir="ltr" className="block break-all font-mono font-semibold">{shipmentId}</bdi>
          <div className="mx-auto mt-0.5 h-[9mm] w-[9mm] bg-white p-0.5"><ShipmentQr qrId={entry.shipment.qr_id} size={160} /></div>
        </td>
      case 'cod_amount':
        return <td className={numericCell}>{money(entry.shipment.cod_amount, printLang)}</td>
      case 'delivery_fee':
        return <td className={numericCell}>{entry.shipment.delivery_fee === null ? '—' : money(entry.shipment.delivery_fee, printLang)}</td>
      case 'cash_movement':
        return <td className={`${numericCell} whitespace-normal`}>
          {entry.kind === 'delivery_accrual' ? <span className="font-normal text-slate-500">{t('postal.statement.noCashMovement')}</span> : money(entry.signed_amount, printLang)}
        </td>
      case 'debit':
        return <td className={numericCell}>{BigInt(entry.debit) === 0n ? '—' : money(entry.debit, printLang)}</td>
      case 'credit':
        return <td className={numericCell}>{BigInt(entry.credit) === 0n ? '—' : money(entry.credit, printLang)}</td>
      case 'balance':
        return <td className={`${numericCell} font-semibold`}>{money(entry.balance, printLang)}</td>
      case 'pieces':
        return <td className={`${cell} tabular-nums`}>{entry.shipment.pieces === null ? '—' : new Intl.NumberFormat(printLang).format(entry.shipment.pieces)}</td>
      case 'status':
        return <td className={cell}>
          <div className="line-clamp-2 font-medium">{t(`postal.states.${entry.shipment_state}`)}</div>
          <div className="mt-0.5 line-clamp-2 text-slate-600">{movementLabel}</div>
        </td>
      case 'notes':
        return <td className={`${cell} text-slate-600`}><div className="line-clamp-3"><bdi>{entry.notes || '—'}</bdi></div></td>
      case 'transaction_date':
        return <td className={cell}><bdi dir="ltr">{dateOnly(entry.created_at, printLang)}</bdi></td>
    }
  }
  const renderSummaryCells = (kind: 'opening' | 'closing') => {
    return visibleColumns.map((column, index) => {
      let value: string | null = null
      if (kind === 'closing' && column.key === 'cod_amount') value = money(data.summary.cod_amount_total, printLang)
      else if (kind === 'closing' && column.key === 'delivery_fee') value = money(data.summary.delivery_fee_total, printLang)
      else if (column.key === 'debit') value = money(data.summary.debit_total, printLang)
      else if (column.key === 'credit') value = money(data.summary.credit_total, printLang)
      else if (column.key === 'balance') value = money(kind === 'opening' ? data.summary.opening_balance : data.summary.closing_balance, printLang)
      const isBalance = column.key === 'balance'
      const isFirst = index === 0
      const label = kind === 'opening' ? t('postal.statement.openingBalanceShort') : t('postal.statement.periodTotals')
      const content = value
        ? <>{isFirst ? <span className="mb-0.5 block text-[7px]">{label}</span> : null}{value}{isBalance ? ` ${t('postal.iqd')}` : null}</>
        : isFirst ? <span className="text-[7px]">{label}</span> : null
      return <td key={column.key} className={value ? numericCell : cell}>{content}</td>
    })
  }

  return (
    <section
      dir={isRtlPrintLanguage ? 'rtl' : 'ltr'}
      data-order-print-page
      data-postal-account-statement-page
      data-page-width-mm="297"
      data-page-padding-mm="5"
      className="box-border flex h-[210mm] w-[297mm] flex-col overflow-hidden bg-white p-[5mm] text-slate-950"
    >
      <style dangerouslySetInnerHTML={{ __html: `
@page { size: A4 landscape; margin: 0; }
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; }
  [data-postal-account-statement-page] { break-after: page; page-break-after: always; }
  [data-postal-account-statement-page]:last-child { break-after: auto; page-break-after: auto; }
  [data-postal-account-statement-page] tr { break-inside: avoid; page-break-inside: avoid; }
}
` }} />

      <header className="grid min-h-[24mm] grid-cols-[1fr_1.35fr_1fr] items-center gap-3 border-b-2 border-slate-800 pb-2">
        <div className="flex h-[22mm] items-center justify-start">
          {resolvedLogoUrl ? <img src={resolvedLogoUrl} alt="" className="max-h-[21mm] max-w-[55mm] object-contain object-left" />
            : <span className="text-base font-black text-slate-800">{workspaceName || ''}</span>}
        </div>
        <h1 className="text-center text-[15px] font-black leading-tight">{t('postal.statement.printTitle')}</h1>
        <div className="space-y-1 text-end text-[8px] leading-3">
          <p className="font-bold">{t('postal.statement.partyName')}: <bdi>{data.organization.name}</bdi></p>
          {data.organization.phone ? <p><span className="font-semibold">{t('postal.statement.partyPhone')}:</span> <bdi dir="ltr">{data.organization.phone}</bdi></p> : null}
          <p><span className="font-semibold">{t('postal.statement.partyCode')}:</span> <bdi dir="ltr">{data.organization.code}</bdi></p>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-2 border-b border-slate-300 py-2 text-[7.5px] leading-3" data-pdf-keep-together>
        <div className="space-y-0.5">
          <p><b>{t('postal.statement.printed')}:</b> <bdi dir="ltr">{dateTime(data.generated_at, printLang)}</bdi></p>
          <p><b>{t('postal.statement.period')}:</b> <bdi dir="ltr">{periodLabel}</bdi></p>
          <p><b>{t('postal.iqd')} · {t('postal.statement.closingBalance')}:</b> <bdi dir="ltr">{money(data.summary.closing_balance, printLang)}</bdi></p>
        </div>
        <div className="flex items-center justify-center gap-4 text-center">
          <p><b>{t('postal.statement.shipmentCount')}:</b> <bdi dir="ltr">{new Intl.NumberFormat(printLang).format(counts.total)}</bdi></p>
          <p><b>{t('postal.statement.baghdadShipments')}:</b> <bdi dir="ltr">{new Intl.NumberFormat(printLang).format(counts.baghdad)}</bdi></p>
          <p><b>{t('postal.statement.provinceShipments')}:</b> <bdi dir="ltr">{new Intl.NumberFormat(printLang).format(counts.provinces)}</bdi></p>
        </div>
        <div className="space-y-0.5 text-end">
          <p><b>{t('postal.statement.openingBalance')}:</b> <bdi dir="ltr">{money(data.summary.opening_balance, printLang)} {t('postal.iqd')}</bdi></p>
          <p><b>{t('postal.statement.periodTotals')}:</b> <span>{t('postal.statement.debit')} {money(data.summary.debit_total, printLang)} · {t('postal.statement.credit')} {money(data.summary.credit_total, printLang)}</span></p>
        </div>
        <p className="col-span-3 text-[6px] leading-3 text-slate-600">{t('postal.statement.printSummaryHint')}</p>
      </div>

      {visibleColumns.length > 0 ? <table dir={isRtlPrintLanguage ? 'rtl' : 'ltr'} data-pdf-page-chunk className={`mt-2 w-full table-fixed border-collapse text-[8px] leading-[1.25] ${fillPageHeight ? 'min-h-0 flex-1' : ''}`}>
        <colgroup>
          {visibleColumns.map((column) => <col key={column.key} style={{ width: `${(column.width / visibleColumnWidthTotal) * 100}%` }} />)}
        </colgroup>
        <thead>
          <tr className="bg-slate-200 font-bold">
            {visibleColumns.map((column) => {
              return <th key={column.key} dir={isRtlPrintLanguage ? 'rtl' : 'ltr'} className={headerCell}>{column.key === 'row_number' ? '#' : t(column.label)}</th>
            })}
          </tr>
        </thead>
        <tbody>
          {data.isFirstPage ? <tr className="bg-slate-50 font-semibold" data-pdf-keep-together>{renderSummaryCells('opening')}</tr> : null}
          {data.entries.length === 0 ? <tr><td className={`${cell} py-4 text-center text-slate-500`} colSpan={visibleColumns.length}>{t('postal.empty')}</td></tr> : null}
          {data.entries.map((entry, index) => <tr key={`${entry.kind}:${entry.id}`} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50/70'} data-pdf-keep-together>
            {visibleColumns.map((column) => <Fragment key={column.key}>{columnCell(column.key, entry, index)}</Fragment>)}
          </tr>)}
          {data.isLastPage ? <tr className="bg-slate-200 font-bold" data-pdf-keep-together>{renderSummaryCells('closing')}</tr> : null}
        </tbody>
      </table> : <p className="mt-2 border border-dashed border-slate-300 py-4 text-center text-[8px] text-slate-500">{t('postal.statement.noVisibleColumns')}</p>}

      <div className="mt-auto pt-2">
        {data.isLastPage ? <div className="grid grid-cols-2 gap-12 pb-2 text-[8px]" data-pdf-keep-together>
          <div className="flex items-end gap-2"><span>{t('postal.statement.employeeSignature')}:</span><span className="min-w-36 flex-1 border-b border-dotted border-slate-600" /></div>
          <div className="flex items-end gap-2"><span>{t('postal.statement.partySignature')}:</span><span className="min-w-36 flex-1 border-b border-dotted border-slate-600" /></div>
        </div> : null}
        <footer className="flex items-center justify-between border-t border-slate-300 pt-1 text-[7px] text-slate-600">
          <span>{workspaceName || ''}</span>
          <bdi dir="ltr">{t('postal.statement.pageNumber', { page: data.pageNumber, pages: data.pageCount })}</bdi>
        </footer>
      </div>
    </section>
  )
}

export function PostalAccountStatementPrintTemplate({
  data,
  workspaceName,
  printLang,
  logoUrl,
  locationCatalog = emptyPostalLocationCatalog,
  hiddenFields = {},
}: {
  data: PostalStatementPrintData | PostalStatementPrintPageData
  workspaceName?: string | null
  printLang: string
  logoUrl?: string | null
  locationCatalog?: PostalLocationCatalog
  hiddenFields?: Record<string, boolean>
}) {
  const pages = 'pageNumber' in data ? [data] : paginatePostalStatementPrintData(data)
  return <>{pages.map((page) => <PostalStatementPrintPage
    key={page.pageNumber}
    data={page}
    workspaceName={workspaceName}
    printLang={printLang}
    logoUrl={logoUrl}
    locationCatalog={locationCatalog}
    hiddenFields={hiddenFields}
  />)}</>
}
