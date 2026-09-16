import { useTranslation } from 'react-i18next'
import type { IQDDisplayPreference } from '@/local-db'
import type { PartnerAccountStatementPeriod } from '@/lib/partnerAccountStatement'
import type { PartnerProductMovementsStatement } from '@/lib/partnerProductMovements'
import { getProductMovementPrintRows } from '@/lib/partnerProductMovementsPresentation'
import { DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION, getPartnerProductMovementsVisibleColumns, type PartnerProductMovementsColumnId } from '@/lib/partnerProductMovementsTemplates'
import { formatDate, formatDateTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { PartnerProductMovementsTable } from './PartnerProductMovementsTable'

export type PartnerProductMovementsPrintData = {
  statement: PartnerProductMovementsStatement
  period: PartnerAccountStatementPeriod
  tableColumns?: PartnerProductMovementsColumnId[]
  partner: { partnerName: string; phone?: string; address?: string; city?: string }
  workspace?: { phone?: string; address?: string; email?: string }
  generatedAt: string
}

export function PartnerProductMovementsPrintTemplate({ workspaceName, workspaceDescription, printLang, data, iqdPreference, logoUrl }: {
  workspaceName?: string | null; workspaceDescription?: string | null; printLang: string;
  data: PartnerProductMovementsPrintData; iqdPreference?: IQDDisplayPreference; logoUrl?: string | null
}) {
  const { i18n } = useTranslation()
  const t = i18n.getFixedT(printLang)
  const columns = data.tableColumns?.length ? data.tableColumns : getPartnerProductMovementsVisibleColumns(DEFAULT_PARTNER_PRODUCT_MOVEMENTS_TEMPLATE_CONFIGURATION, { showProductCommissionColumns: data.statement.hasCommission })
  const rows = getProductMovementPrintRows(data.statement.entries, columns.includes('reference'))
  const logo = logoUrl ? logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl) : null
  const period = data.period.type === 'allTime' ? t('performance.filters.allTime') : t('businessPartners.fromDateToDate', { start: data.period.start ? formatDate(data.period.start) : '—', end: data.period.end ? formatDate(data.period.end) : '—' })
  return <div dir={['ar', 'ku'].includes(printLang.split('-')[0]) ? 'rtl' : 'ltr'} className="bg-white text-black" style={{ width: '210mm' }}
    data-partner-product-movements-print data-order-print-page data-page-width-mm="210" data-page-padding-mm="9">
    <style>{`@media print { @page { margin: 0; size: A4; } [data-partner-product-movements-print] tr, [data-partner-product-movements-print] [data-pdf-keep-together] { break-inside: avoid; page-break-inside: avoid; } [data-partner-product-movements-print] thead { display: table-header-group; } }`}</style>
    <section style={{ minHeight: '297mm', padding: '9mm', boxSizing: 'border-box' }}>
      <header className="grid grid-cols-[1fr_1.6fr] gap-4 border-b-2 border-slate-800 pb-4" data-pdf-keep-together>
        <div className="flex items-center justify-center border-e pe-4">{logo ? <img src={logo} alt="" className="max-h-[28mm] max-w-[60mm] object-contain" /> : <strong className="text-[16px]">{workspaceName || t('businessPartners.ourBusiness')}</strong>}</div>
        <div className="text-[10px] leading-relaxed">
          <h1 className="text-[17px] font-bold">{t('businessPartners.productMovements.title')}</h1>
          <p><strong>{t('businessPartners.accountStatement.partner')}: </strong>{data.partner.partnerName}</p>
          <p><strong>{t('businessPartners.accountStatement.period')}: </strong>{period}</p>
          <p><strong>{t('businessPartners.accountStatement.printed')}: </strong>{formatDateTime(data.generatedAt)}</p>
        </div>
      </header>
      <div className="my-3 flex flex-wrap gap-x-4 gap-y-1 border-b pb-3 text-[10px]" data-pdf-keep-together>
        <span>{[data.partner.phone, data.partner.address, data.partner.city].filter(Boolean).join(' · ')}</span>
        <span>{[data.workspace?.phone, data.workspace?.address, data.workspace?.email].filter(Boolean).join(' · ') || workspaceDescription}</span>
      </div>
      {data.statement.undatedCount > 0 && <p className="mb-3 text-[9px]" data-pdf-keep-together>{t('businessPartners.productMovements.undatedNotice', { count: data.statement.undatedCount })}</p>}
      <PartnerProductMovementsTable statement={data.statement} columns={columns} language={printLang}
        iqdPreference={iqdPreference} printRows={rows} footerNote={t('businessPartners.productMovements.footerNote')} />
    </section>
  </div>
}
