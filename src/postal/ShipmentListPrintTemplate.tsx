import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, HandCoins, Truck, Wallet } from 'lucide-react'
import type { PostalDashboardSummary } from '@/local-db/postalSummary'
import i18n from '@/i18n/config'
import { CustomTemplateLayoutOverlay } from '@/ui/components/CustomTemplateLayoutOverlay'
import type { PostalLocationCatalog, PostalShipment } from './domain'
import { formatPostalShipmentId, locationLabel } from './domain'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { platformService } from '@/services/platformService'
import type { TemplatePreview } from '@/lib/printPreviewEditorStore'

const PAGE_SIZE_MM = { widthMm: 297, heightMm: 210 }
const FIRST_PAGE_BODY_HEIGHT_MM = 147
const CONTINUATION_PAGE_BODY_HEIGHT_MM = 164
const TABLE_ROW_PADDING_MM = 3.2
const TABLE_LINE_HEIGHT_MM = 2.6

export type PostalShipmentPrintRow = PostalShipment & {
  organization_name: string | null
}

export type PostalShipmentPrintData = {
  rows: PostalShipmentPrintRow[]
  summary: PostalDashboardSummary
  isAdmin: boolean
  titleKey: 'postal.shipments' | 'postal.myShipments'
  status: string
  start?: string
  end?: string
  generatedAt: string
  locationCatalog: PostalLocationCatalog
}

type PostalShipmentPrintPageData = PostalShipmentPrintData & {
  pageRows: PostalShipmentPrintRow[]
  pageNumber: number
  pageCount: number
  isFirstPage: boolean
}

type EditorLayoutOverlayProps = ComponentProps<typeof CustomTemplateLayoutOverlay>

export function paginatePostalShipmentPrintData(
  data: PostalShipmentPrintData,
): PostalShipmentPrintPageData[] {
  const pageRows: PostalShipmentPrintRow[][] = []
  let currentRows: PostalShipmentPrintRow[] = []
  let currentHeightMm = 0
  let availableHeightMm = FIRST_PAGE_BODY_HEIGHT_MM

  for (const shipment of data.rows) {
    const rowHeightMm = estimateShipmentPrintRowHeight(shipment, data)
    if (currentRows.length > 0 && currentHeightMm + rowHeightMm > availableHeightMm) {
      pageRows.push(currentRows)
      currentRows = []
      currentHeightMm = 0
      availableHeightMm = CONTINUATION_PAGE_BODY_HEIGHT_MM
    }
    currentRows.push(shipment)
    currentHeightMm += rowHeightMm
  }
  if (currentRows.length > 0 || pageRows.length === 0) pageRows.push(currentRows)

  return pageRows.map((rows, index) => ({
    ...data,
    pageRows: rows,
    pageNumber: index + 1,
    pageCount: pageRows.length,
    isFirstPage: index === 0,
  }))
}

function estimateWrappedLines(value: string, widthMm: number) {
  const averageCharacterWidthMm = 1.25
  const charactersPerLine = Math.max(1, Math.floor(widthMm / averageCharacterWidthMm))
  return Math.max(1, Math.ceil(Array.from(value.trim()).length / charactersPerLine))
}

function estimateShipmentPrintRowHeight(
  shipment: PostalShipmentPrintRow,
  data: PostalShipmentPrintData,
) {
  const tableWidthMm = PAGE_SIZE_MM.widthMm - 12
  const textCells = data.isAdmin
    ? [
        { value: shipment.organization_name || '', width: tableWidthMm * 0.13 },
        { value: shipment.recipient_name, width: tableWidthMm * 0.15 },
        { value: '', width: tableWidthMm * 0.12 },
        { value: '', width: tableWidthMm * 0.19 },
      ]
    : [
        { value: shipment.recipient_name, width: tableWidthMm * 0.18 },
        { value: '', width: tableWidthMm * 0.12 },
        { value: '', width: tableWidthMm * 0.23 },
      ]

  const translatedStates = ['en', 'ar', 'ku'].map((language) =>
    i18n.getFixedT(language)(`postal.states.${shipment.state}`),
  )
  textCells[data.isAdmin ? 2 : 1]!.value = translatedStates.reduce(
    (longest, label) => label.length > longest.length ? label : longest,
    '',
  )
  const destinationLabels = ['en', 'ar', 'ku'].map((language) =>
    shipmentDestination(shipment, language, data.locationCatalog),
  )
  textCells[textCells.length - 1]!.value = destinationLabels.reduce(
    (longest, label) => label.length > longest.length ? label : longest,
    '',
  )

  const lineCount = Math.max(...textCells.map((cell) => estimateWrappedLines(cell.value, cell.width)))
  return TABLE_ROW_PADDING_MM + (lineCount * TABLE_LINE_HEIGHT_MM)
}

function readEditorLayoutOverlay(element: ReactElement): EditorLayoutOverlayProps | null {
  const children = Children.toArray((element.props as { children?: ReactNode }).children)
  const overlay = children.find((child) => (
    isValidElement(child) && child.type === CustomTemplateLayoutOverlay
  ))
  return isValidElement<EditorLayoutOverlayProps>(overlay) ? overlay.props : null
}

function printDate(value: string | undefined, language: string) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(language)
}

function resolveWorkspaceLogoSrc(logoUrl?: string | null) {
  if (!logoUrl) return null
  return /^(https?:|data:|blob:)/i.test(logoUrl) ? logoUrl : platformService.convertFileSrc(logoUrl)
}

function shipmentDestination(shipment: PostalShipmentPrintRow, language: string, catalog: PostalLocationCatalog) {
  return [
    locationLabel(shipment.governorate, language, undefined, catalog),
    locationLabel(shipment.area, language, shipment.governorate, catalog),
  ].filter(Boolean).join(' / ')
}

function PostalShipmentPrintPage({
  data,
  workspaceName,
  logoUrl,
  printLang,
}: {
  data: PostalShipmentPrintPageData
  workspaceName?: string | null
  logoUrl?: string | null
  printLang: string
}) {
  const { i18n } = useTranslation()
  const t = i18n.getFixedT(printLang)
  const rtl = printLang.startsWith('ar') || printLang.startsWith('ku')
  const workspaceLogoSrc = resolveWorkspaceLogoSrc(logoUrl)
  const number = (value: number) => new Intl.NumberFormat(printLang).format(value)
  const money = (value: string) => `${t('postal.iqd')} ${new Intl.NumberFormat(printLang).format(BigInt(value))}`
  const startDate = printDate(data.start, printLang)
  const endDate = data.end
    ? printDate(new Date(new Date(data.end).getTime() - 1).toISOString(), printLang)
    : null
  const dateRangeLabel = startDate || endDate
    ? `${startDate || '…'} - ${endDate || '…'}`
    : t('postal.statement.allDates')
  const statusLabel = data.status === 'all'
    ? t('postal.allStatuses')
    : t(`postal.states.${data.status}`)
  const columns = [
    { key: 'shipment', label: t('postal.shipmentId'), width: data.isAdmin ? '13%' : '15%' },
    ...(data.isAdmin ? [{ key: 'organization', label: t('postal.organizationName'), width: '13%' }] : []),
    { key: 'recipient', label: t('postal.recipient_name'), width: data.isAdmin ? '15%' : '18%' },
    { key: 'phone', label: t('postal.recipientPhoneNumber'), width: data.isAdmin ? '13%' : '14%' },
    { key: 'status', label: t('postal.status'), width: '12%' },
    { key: 'destination', label: t('postal.destination'), width: data.isAdmin ? '19%' : '23%' },
    { key: 'cod', label: t('postal.codAmount'), width: '15%' },
  ]
  const cards = [
    {
      key: 'active',
      value: number(data.summary.active_shipments),
      icon: Truck,
      tone: 'border-blue-200 bg-blue-50 text-blue-900',
      iconTone: 'bg-blue-100 text-blue-700',
    },
    {
      key: 'delivered',
      value: number(data.summary.delivered_shipments),
      icon: CircleCheck,
      tone: 'border-emerald-200 bg-emerald-50 text-emerald-900',
      iconTone: 'bg-emerald-100 text-emerald-700',
    },
    {
      key: 'inTransit',
      value: number(data.summary.in_transit_shipments),
      icon: Truck,
      tone: 'border-amber-200 bg-amber-50 text-amber-900',
      iconTone: 'bg-amber-100 text-amber-700',
    },
    {
      key: 'merchantSettlements',
      value: money(data.summary.remaining_merchant_settlements),
      icon: Wallet,
      tone: 'border-cyan-200 bg-cyan-50 text-cyan-900',
      iconTone: 'bg-cyan-100 text-cyan-700',
    },
    {
      key: 'cod',
      value: money(data.summary.cod_balance),
      icon: HandCoins,
      tone: 'border-violet-200 bg-violet-50 text-violet-900',
      iconTone: 'bg-violet-100 text-violet-700',
    },
  ] as const

  return (
    <section
      dir={rtl ? 'rtl' : 'ltr'}
      data-postal-shipment-print-page
      data-page-width-mm="297"
      data-page-height-mm="210"
      className="box-border flex h-[210mm] w-[297mm] flex-col overflow-hidden bg-white p-[6mm] text-slate-950"
    >
      <style dangerouslySetInnerHTML={{ __html: `
@page { size: A4 landscape; margin: 0; }
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; }
  [data-postal-shipment-print-page] tr { break-inside: avoid; page-break-inside: avoid; }
}
` }} />

      <header className="grid min-h-[17mm] grid-cols-[1fr_1.4fr_1fr] items-center gap-3 border-b-2 border-slate-800 pb-2">
        <div className="flex min-w-0 items-center gap-2 text-start">
          {workspaceLogoSrc ? (
            <img src={workspaceLogoSrc} alt="" className="h-[10mm] max-w-[24mm] shrink-0 object-contain" />
          ) : null}
          <p className="truncate text-xs font-black text-slate-700">{workspaceName || ''}</p>
        </div>
        <h1 className="text-center text-base font-black leading-tight">{t(data.titleKey)}</h1>
        <div className="text-end text-[8px] leading-3 text-slate-600">
          <p className="font-semibold">{statusLabel}</p>
          <p>{dateRangeLabel}</p>
        </div>
      </header>

      {data.isFirstPage ? (
        <section
          aria-label={t('postal.dashboard.title')}
          className="mt-2 grid grid-cols-5 gap-2"
        >
          {cards.map(({ key, value, icon: Icon, tone, iconTone }) => (
            <article key={key} className={`flex min-w-0 items-start gap-2 rounded-lg border px-2 py-1.5 ${tone}`}>
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${iconTone}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[7px] font-bold leading-tight">{t(`postal.dashboard.${key}.title`)}</h2>
                <p className="mt-0.5 break-words text-[9px] font-black leading-tight tabular-nums">{value}</p>
                <p className="mt-0.5 line-clamp-2 text-[6px] leading-[1.15] text-slate-600">{t(`postal.dashboard.${key}.description`)}</p>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      <div className="mt-2 min-h-0 flex-1">
        <table dir={rtl ? 'rtl' : 'ltr'} className="w-full table-fixed border-collapse text-[8px] leading-[1.2] font-bold">
          <colgroup>
            {columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}
          </colgroup>
          <thead>
            <tr className="bg-slate-200 font-bold">
              {columns.map((column) => (
                <th key={column.key} className="border border-slate-300 px-1.5 py-1.5 text-start align-middle">{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="border border-slate-300 py-8 text-center text-slate-500">
                  {t('postal.empty')}
                </td>
              </tr>
            ) : data.pageRows.map((shipment, index) => (
              <tr key={shipment.id} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                <td className="border border-slate-300 px-1.5 py-1.5 align-middle font-mono text-[7px]" dir="ltr">
                  {formatPostalShipmentId(shipment)}
                </td>
                {data.isAdmin ? (
                  <td className="border border-slate-300 px-1.5 py-1.5 align-middle break-words">{shipment.organization_name || '—'}</td>
                ) : null}
                <td className="border border-slate-300 px-1.5 py-1.5 align-middle break-words font-bold">{shipment.recipient_name}</td>
                <td className="border border-slate-300 px-1.5 py-1.5 align-middle whitespace-nowrap" dir="ltr">{shipment.primary_phone}</td>
                <td className="border border-slate-300 px-1.5 py-1.5 align-middle font-bold">{t(`postal.states.${shipment.state}`)}</td>
                <td className="border border-slate-300 px-1.5 py-1.5 align-middle break-words">
                  {shipmentDestination(shipment, printLang, data.locationCatalog) || '—'}
                </td>
                <td className="border border-slate-300 px-1.5 py-1.5 align-middle whitespace-nowrap text-end tabular-nums" dir="ltr">
                  {new Intl.NumberFormat(printLang).format(shipment.cod_amount)} {t('postal.iqd')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="mt-2 flex items-center justify-between border-t border-slate-300 pt-1 text-[7px] text-slate-600">
        <span>{t('postal.createdAt')}: {new Date(data.generatedAt).toLocaleString(printLang, { dateStyle: 'medium', timeStyle: 'short' })}</span>
        <span>{t('postal.statement.pageNumber', { page: number(data.pageNumber), pages: number(data.pageCount) })}</span>
      </footer>
    </section>
  )
}

export function createPostalShipmentListTemplatePreview(
  data: PostalShipmentPrintData,
  workspaceName?: string | null,
  defaultPrintLang = 'en',
  logoUrl?: string | null,
): TemplatePreview {
  const pages = paginatePostalShipmentPrintData(data)
  const renderPage = (page: PostalShipmentPrintPageData, printLang: string) => (
    <PostalShipmentPrintPage
      data={page}
      workspaceName={workspaceName}
      logoUrl={logoUrl}
      printLang={printLang}
    />
  )
  const renderPageSlice = (
    page: PostalShipmentPrintPageData,
    pageIndex: number,
    printLang: string,
    layoutOverlay: EditorLayoutOverlayProps | null,
  ) => (
    <div
      className="relative overflow-hidden bg-white"
      style={{ width: `${PAGE_SIZE_MM.widthMm}mm`, height: `${PAGE_SIZE_MM.heightMm}mm` }}
    >
      {renderPage(page, printLang)}
      {layoutOverlay ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute left-0 top-0"
            style={{
              width: `${PAGE_SIZE_MM.widthMm}mm`,
              height: `${layoutOverlay.heightMm}mm`,
              transform: `translateY(-${pageIndex * PAGE_SIZE_MM.heightMm}mm)`,
            }}
          >
            <CustomTemplateLayoutOverlay {...layoutOverlay} />
          </div>
        </div>
      ) : null}
    </div>
  )

  return {
    page: PAGE_SIZE_MM,
    measurementRoundingToleranceMm: 0.5,
    fields: [],
    createElement: (_fields, _effectiveId, printLangOverride) => (
      <div className="flex w-full flex-col">
        {pages.map((page) => (
          <div key={page.pageNumber} className="shrink-0">
            {renderPage(page, printLangOverride || defaultPrintLang)}
          </div>
        ))}
      </div>
    ),
    buildPdf: (element: ReactElement, printLangOverride) => {
      const printLang = printLangOverride || defaultPrintLang
      const layoutOverlay = readEditorLayoutOverlay(element)
      return generateTemplatePdf({
        pages: pages.map((page, pageIndex) => renderPageSlice(page, pageIndex, printLang, layoutOverlay)),
        format: 'a4',
        pageSizeMm: PAGE_SIZE_MM,
        printLang,
      })
    },
  }
}
