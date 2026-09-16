import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import type { IQDDisplayPreference } from '@/local-db'
import { cn, formatCurrency } from '@/lib/utils'
import { formatPrintReferenceList } from '@/lib/printReferenceList'
import type { PartnerProductMovementsStatement } from '@/lib/partnerProductMovements'
import type { PartnerProductMovementsColumnId } from '@/lib/partnerProductMovementsTemplates'
import { formatProductMovementQuantity, getProductMovementDescription, PRODUCT_MOVEMENTS_COLUMN_KEYS, type ProductMovementPrintRow } from '@/lib/partnerProductMovementsPresentation'

export function ProductMovementsTotals({ statement, language, iqdPreference, print = false }: {
  statement: PartnerProductMovementsStatement; language: string; iqdPreference?: IQDDisplayPreference; print?: boolean
}) {
  const { i18n } = useTranslation()
  const t = i18n.getFixedT(language)
  return <div className={cn('flex flex-wrap items-start gap-x-6 gap-y-2', print ? 'text-[9px]' : 'text-sm')}>
    <strong>{t('common.total')}</strong>
    {statement.quantityTotals.map(total => <span key={JSON.stringify([total.direction, total.unit])}>
      {t(`businessPartners.productMovements.${total.direction}`)}: <strong className="tabular-nums">{formatProductMovementQuantity(total.quantity, total.unit || t('businessPartners.productMovements.unknownUnit'), language)}</strong>
    </span>)}
    {statement.commissionTotals.map(total => <span key={total.currency}>
      {t('salesAgentCommissions.productCommission.lineTotal')}: <strong className="tabular-nums">{formatCurrency(total.amount, total.currency, iqdPreference)}</strong>
    </span>)}
  </div>
}

export function PartnerProductMovementsTable({ statement, columns, language, iqdPreference, printRows, footerNote }: {
  statement: PartnerProductMovementsStatement; columns: PartnerProductMovementsColumnId[]; language: string;
  iqdPreference?: IQDDisplayPreference; printRows?: ProductMovementPrintRow[]; footerNote?: string
}) {
  const { i18n } = useTranslation()
  const t = i18n.getFixedT(language)
  const print = !!printRows
  const rows = printRows || statement.entries.map(entry => ({ entry, references: entry.references }))
  const numeric = (column: PartnerProductMovementsColumnId) => ['quantity', 'commissionPerProduct', 'totalProductCommission'].includes(column)
  const cellClass = (column: PartnerProductMovementsColumnId) => cn(print ? 'border border-slate-400 px-2 py-2 align-top break-words' : 'border-b px-4 py-3 align-top', numeric(column) && 'text-end tabular-nums')
  return <table className={cn('w-full border-collapse', print ? 'table-fixed text-[9px]' : 'text-sm')}
    data-pdf-page-chunk={print ? '' : undefined} data-order-items-paginated={print ? '' : undefined}>
    <thead><tr className={print ? 'bg-slate-200' : 'bg-muted/40'}>{columns.map(column =>
      <th key={column} className={cn(cellClass(column), !numeric(column) && 'text-start font-semibold')}>{t(PRODUCT_MOVEMENTS_COLUMN_KEYS[column])}</th>
    )}</tr></thead>
    <tbody>{rows.length ? rows.map(({ entry, references }, index) => <tr key={`${entry.id}:${index}`} className={print ? '' : 'hover:bg-muted/20'} data-pdf-keep-together={print ? '' : undefined}>
      {columns.map(column => {
        let value
        switch (column) {
          case 'reference': value = print ? <span className="relative block [overflow-wrap:anywhere]" lang={language}
            data-print-reference-list={JSON.stringify(references.map(ref => ref.label))}
            data-print-more-label={t('businessPartners.productMovements.moreReferences', { additionalCount: '{count}' })}>
            {formatPrintReferenceList(references.map(ref => ref.label), 3, count => t('businessPartners.productMovements.moreReferences', { additionalCount: new Intl.NumberFormat(language).format(count) }))}
          </span> : references.map((ref, i) => <span key={`${ref.path}:${ref.label}`}>{i > 0 ? ' - ' : ''}<Link className="text-primary underline-offset-4 hover:underline" href={ref.path}>{ref.label}</Link></span>); break
          case 'description': value = <>{getProductMovementDescription(entry, t)}{!entry.date && <span className="ms-1 text-muted-foreground">({t('businessPartners.productMovements.undated')})</span>}</>; break
          case 'item': value = entry.item; break
          case 'quantity': value = formatProductMovementQuantity(entry.quantity, entry.unit, language); break
          case 'commissionPerProduct': value = entry.commissionPerProduct === null ? '—' : formatCurrency(entry.commissionPerProduct, entry.currency, iqdPreference); break
          case 'totalProductCommission': value = entry.totalProductCommission === null ? '—' : formatCurrency(entry.totalProductCommission, entry.currency, iqdPreference); break
        }
        return <td key={column} className={cellClass(column)}>{value}</td>
      })}
    </tr>) : <tr><td className="p-8 text-center text-muted-foreground" colSpan={columns.length}>{t('businessPartners.noActivity')}</td></tr>}</tbody>
    <tfoot><tr><td className={print ? 'border border-slate-400 bg-slate-50 p-2' : 'bg-muted/30 p-4'} colSpan={columns.length}>
      <ProductMovementsTotals statement={statement} language={language} iqdPreference={iqdPreference} print={print} />
      {footerNote && <p className="mt-2 border-t border-slate-300 pt-2 text-[8px] text-slate-600">{footerNote}</p>}
    </td></tr></tfoot>
  </table>
}
