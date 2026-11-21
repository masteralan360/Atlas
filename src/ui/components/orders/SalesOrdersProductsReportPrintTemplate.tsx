import { useTranslation } from 'react-i18next'
import { formatDateTime } from '@/lib/utils'
import { formatProductQuantity } from '@/lib/productUnitPresentation'
import type { SalesOrdersProductsReportData } from '@/lib/salesOrdersProductsReport'
import { platformService } from '@/services/platformService'

export function SalesOrdersProductsReportPrintTemplate({
  workspaceName,
  printLang,
  data,
  logoUrl
}: {
  workspaceName?: string | null
  printLang: string
  data: SalesOrdersProductsReportData
  logoUrl?: string | null
}) {
  const { i18n } = useTranslation()
  const t = i18n.getFixedT(printLang)
  const unknownUnit = t('businessPartners.productMovements.unknownUnit')
  const formatQuantity = (quantity: number, unit: string | null) => {
    const formattedQuantity = formatProductQuantity(quantity, unit, printLang, t)
    return unit ? formattedQuantity : `${formattedQuantity} ${unknownUnit}`
  }
  const logo = logoUrl ? logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl) : null
  const collator = new Intl.Collator(printLang, { numeric: true, sensitivity: 'base' })
  const rows = [...data.rows].sort((left, right) => (
    collator.compare(left.item, right.item)
    || collator.compare(left.unit || '', right.unit || '')
    || left.key.localeCompare(right.key)
  ))
  const unitTotals = [...data.unitTotals].sort((left, right) => collator.compare(left.unit || '', right.unit || ''))

  return (
    <div
      dir={['ar', 'ku'].includes(printLang.split('-')[0]) ? 'rtl' : 'ltr'}
      className="bg-white text-black"
      style={{ width: '210mm' }}
      data-sales-orders-products-report
      data-order-print-page
      data-page-width-mm="210"
      data-page-padding-mm="9"
    >
      <style>{`@media print { @page { margin: 0; size: A4; } [data-sales-orders-products-report] tr, [data-sales-orders-products-report] [data-pdf-keep-together] { break-inside: avoid; page-break-inside: avoid; } [data-sales-orders-products-report] thead { display: table-header-group; } }`}</style>
      <section style={{ minHeight: '297mm', padding: '9mm', boxSizing: 'border-box' }}>
        <header className="grid grid-cols-[1fr_1.6fr] gap-4 border-b-2 border-slate-800 pb-4" data-pdf-keep-together>
          <div className="flex items-center justify-center border-e pe-4">
            {logo
              ? <img src={logo} alt="" className="max-h-[28mm] max-w-[60mm] object-contain" />
              : <strong className="text-[16px]">{workspaceName || t('businessPartners.ourBusiness')}</strong>}
          </div>
          <div className="text-[10px] leading-relaxed">
            <h1 className="text-[17px] font-bold">{t('orders.productsReport.title')}</h1>
            <p><strong>{t('businessPartners.accountStatement.printed')}: </strong>{formatDateTime(data.generatedAt)}</p>
          </div>
        </header>

        <table
          className="mt-3 w-full table-fixed border-collapse text-[9px]"
          data-pdf-page-chunk
          data-order-items-paginated
        >
          <thead>
            <tr className="bg-slate-200">
              <th className="border border-slate-400 px-2 py-2 text-start font-semibold">{t('businessPartners.accountStatement.item')}</th>
              <th className="w-[30%] border border-slate-400 px-2 py-2 text-end font-semibold">{t('businessPartners.accountStatement.quantity')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length > 0 ? rows.map((row) => (
              <tr key={row.key} data-pdf-keep-together>
                <td className="break-words border border-slate-400 px-2 py-2 align-top">{row.item}</td>
                <td className="border border-slate-400 px-2 py-2 text-end align-top tabular-nums">
                  {formatQuantity(row.quantity, row.unit)}
                </td>
              </tr>
            )) : (
              <tr data-pdf-keep-together>
                <td className="border border-slate-400 p-8 text-center text-slate-500" colSpan={2}>
                  {t('orders.productsReport.empty')}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr data-pdf-keep-together>
              <td className="border border-slate-400 bg-slate-50 p-2" colSpan={2}>
                <div className="flex flex-wrap items-start gap-x-6 gap-y-2 text-[9px]">
                  <strong>{t('common.total')} {t('businessPartners.accountStatement.quantity')}</strong>
                  {unitTotals.length > 0 ? unitTotals.map((total) => (
                    <span key={total.unit || '__unknown-unit__'} className="tabular-nums">
                      <strong>{formatQuantity(total.quantity, total.unit)}</strong>
                    </span>
                  )) : (
                    <span className="tabular-nums"><strong>{formatQuantity(0, null)}</strong></span>
                  )}
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
    </div>
  )
}
