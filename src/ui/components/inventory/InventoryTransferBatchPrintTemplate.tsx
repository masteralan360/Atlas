import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownLeft, ArrowUpRight, type LucideIcon } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'
import { getProductUnitLabel } from '@/lib/productUnitPresentation'
import type { InventoryTransferBatchDetails } from '@/local-db'
import { platformService } from '@/services/platformService'

const DEFAULT_FIRST_PAGE_ROWS = 22
const DEFAULT_CONTINUATION_PAGE_ROWS = 29
const PRODUCT_ROW_HEIGHT_MM = 8.8
const PAGE_HEIGHT_MM = 297
const PAGE_PADDING_MM = 9
const TABLE_TOP_GAP_MM = 3.2
const FOOTER_RESERVE_MM = 10

export function areTransferBatchWorkspacesSame(data: Pick<InventoryTransferBatchDetails, 'batch'>) {
  const sourceId = data.batch.sourceWorkspaceId
  const destinationId = data.batch.destinationWorkspaceId
  if (sourceId && destinationId) return sourceId === destinationId
  const sourceName = data.batch.sourceWorkspaceName?.trim().toLocaleLowerCase()
  const destinationName = data.batch.destinationWorkspaceName?.trim().toLocaleLowerCase()
  if (sourceName && destinationName) return sourceName === destinationName
  return !sourceId && !destinationId
}

export interface InventoryTransferBatchPrintData extends InventoryTransferBatchDetails {
  printedAt: string
}

function chunkProducts(
  products: InventoryTransferBatchPrintData['products'],
  firstPageRows: number,
  continuationPageRows: number,
) {
  if (products.length === 0) return [{ products: [], startIndex: 0 }]
  const chunks: { products: InventoryTransferBatchPrintData['products']; startIndex: number }[] = []
  let startIndex = 0
  while (startIndex < products.length) {
    const pageIndex = chunks.length
    const pageSize = pageIndex === 0 ? firstPageRows : continuationPageRows
    chunks.push({ products: products.slice(startIndex, startIndex + pageSize), startIndex })
    startIndex += pageSize
  }
  return chunks
}

export function getInventoryTransferBatchPrintTokenValues(
  data: InventoryTransferBatchPrintData,
  workspaceName?: string | null,
  t?: (key: string, options?: Record<string, unknown>) => string,
) {
  const sameWorkspace = areTransferBatchWorkspacesSame(data)
  const tokens: Record<string, string> = {
    workspaceName: workspaceName?.trim() || 'Atlas',
    transferNumber: data.batch.transferNumber,
    transferDate: formatDateTime(data.batch.transferredAt),
    sourceWorkspace: sameWorkspace ? '' : data.batch.sourceWorkspaceName || workspaceName || '',
    sourceStorage: data.batch.sourceStorageName || '',
    destinationWorkspace: sameWorkspace ? '' : data.batch.destinationWorkspaceName || workspaceName || '',
    destinationStorage: data.batch.destinationStorageName || '',
    performedBy: data.performedByName || data.batch.performedBy || '',
    status: t?.(`inventoryTransfer.batch.status.${data.batch.status}`, { defaultValue: data.batch.status }) || data.batch.status,
    notes: data.batch.notes || '',
    productCount: String(data.products.length),
    printedAt: formatDateTime(data.printedAt),
  }
  tokens.sharedWorkspace = sameWorkspace
    ? data.batch.sourceWorkspaceName || data.batch.destinationWorkspaceName || workspaceName || ''
    : ''
  data.products.forEach((product, index) => {
    const row = index + 1
    tokens[`product${row}Name`] = product.productName
    tokens[`product${row}Sku`] = product.sku
    tokens[`product${row}Quantity`] = String(product.quantity)
    tokens[`product${row}Unit`] = t
      ? getProductUnitLabel(product.unit, t)
      : product.unit || ''
    tokens[`product${row}Batch`] = product.batchAllocations.map((allocation) => allocation.batchNumber).filter(Boolean).join(', ')
  })
  return tokens
}

export function InventoryTransferBatchPrintTemplate({
  data,
  workspaceName,
  workspaceDescription,
  logoUrl,
  printLang,
  sourceIsBranch,
  destinationIsBranch,
}: {
  data: InventoryTransferBatchPrintData
  workspaceName?: string | null
  workspaceDescription?: string | null
  logoUrl?: string | null
  printLang: string
  sourceIsBranch?: boolean
  destinationIsBranch?: boolean
}) {
  const { t, i18n } = useTranslation()
  const firstPageRef = useRef<HTMLElement | null>(null)
  const firstPageTableRef = useRef<HTMLTableElement | null>(null)
  const [rowCapacities, setRowCapacities] = useState({
    firstPageRows: DEFAULT_FIRST_PAGE_ROWS,
    continuationPageRows: DEFAULT_CONTINUATION_PAGE_ROWS,
  })
  const language = printLang || i18n.language
  const direction = language.startsWith('ar') || language.startsWith('ku') ? 'rtl' : 'ltr'
  const pages = useMemo(
    () => chunkProducts(data.products, rowCapacities.firstPageRows, rowCapacities.continuationPageRows),
    [data.products, rowCapacities],
  )
  const number = useMemo(() => new Intl.NumberFormat(language, { maximumFractionDigits: 6 }), [language])
  const sameWorkspace = areTransferBatchWorkspacesSame(data)
  const companyName = workspaceName?.trim() || t('businessPartners.ourBusiness', { defaultValue: 'Our business' })
  const logoSrc = logoUrl ? (logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)) : null
  const label = (key: string, fallback: string) => t(`inventoryTransfer.batch.${key}`, { defaultValue: fallback })
  const sourceNameLabel = sourceIsBranch
    ? label('fromBranch', 'From Branch')
    : label('fromWorkspace', 'From Workspace')
  const destinationNameLabel = destinationIsBranch
    ? label('toBranch', 'To Branch')
    : label('toWorkspace', 'To Workspace')

  useLayoutEffect(() => {
    const page = firstPageRef.current
    const table = firstPageTableRef.current
    if (!page || !table) return

    let disposed = false
    const printRoot = page.closest<HTMLElement>('[data-inventory-transfer-batch-print]')
    const productRows = Array.from(
      printRoot?.querySelectorAll<HTMLElement>('[data-inventory-transfer-product-row]') || [],
    )
    const measureCapacities = () => {
      if (disposed) return
      const pageRect = page.getBoundingClientRect()
      if (pageRect.width <= 0) return

      const mmPerPixel = 210 / pageRect.width
      const tableRect = table.getBoundingClientRect()
      const tableTopMm = (tableRect.top - pageRect.top) * mmPerPixel
      const tableHeaderMm = (table.tHead?.getBoundingClientRect().height || 0) * mmPerPixel
      const productRowMm = productRows.reduce(
        (maximum, row) => Math.max(maximum, row.getBoundingClientRect().height * mmPerPixel),
        PRODUCT_ROW_HEIGHT_MM,
      )
      if (productRowMm <= 0) return

      const printableBottomMm = PAGE_HEIGHT_MM - PAGE_PADDING_MM
      const firstPageRows = Math.max(1, Math.floor(
        (printableBottomMm - tableTopMm - tableHeaderMm - FOOTER_RESERVE_MM) / productRowMm,
      ))
      const continuationTableTopMm = PAGE_PADDING_MM + TABLE_TOP_GAP_MM
      const continuationPageRows = Math.max(1, Math.floor(
        (printableBottomMm - continuationTableTopMm - tableHeaderMm - FOOTER_RESERVE_MM) / productRowMm,
      ))

      setRowCapacities((current) => current.firstPageRows === firstPageRows
        && current.continuationPageRows === continuationPageRows
        ? current
        : { firstPageRows, continuationPageRows })
    }

    measureCapacities()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureCapacities)
    const observedElements = [
      page.querySelector('header'),
      page.querySelector('[data-inventory-transfer-metadata]'),
      page.querySelector('[data-inventory-transfer-locations]'),
      table.tHead,
      ...productRows,
      page.querySelector('img'),
    ]
    observedElements.forEach((element) => {
      if (element) observer?.observe(element)
    })
    window.addEventListener('resize', measureCapacities)
    if (document.fonts?.ready) void document.fonts.ready.then(measureCapacities)

    return () => {
      disposed = true
      observer?.disconnect()
      window.removeEventListener('resize', measureCapacities)
    }
  }, [data, logoUrl, printLang, rowCapacities.firstPageRows, rowCapacities.continuationPageRows, workspaceDescription, workspaceName])

  return (
    <div
      dir={direction}
      className="bg-white text-slate-950"
      style={{ width: '210mm' }}
      data-inventory-transfer-batch-print
      data-order-print-page
      data-page-width-mm="210"
      data-page-padding-mm="9"
    >
      <style>{`@media print {
        @page { margin: 0; size: A4; }
        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; }
        [data-inventory-transfer-batch-print] table { page-break-inside: auto; }
        [data-inventory-transfer-batch-print] tr,
        [data-inventory-transfer-batch-print] [data-pdf-keep-together] { break-inside: avoid; page-break-inside: avoid; }
        [data-inventory-transfer-batch-print] thead { display: table-header-group; }
      }`}</style>
      {pages.map(({ products, startIndex }, pageIndex) => (
        <section
          key={`transfer-print-page-${pageIndex}`}
          ref={pageIndex === 0 ? firstPageRef : undefined}
          className="box-border bg-white px-[9mm] py-[9mm]"
          style={{ minHeight: '297mm' }}
          data-pdf-page-chunk
        >
          {pageIndex === 0 && (
            <>
              <header className="grid grid-cols-[1fr_1.6fr] gap-5 border-b-2 border-slate-800 pb-4" data-pdf-keep-together>
                <div className="flex min-h-[27mm] items-center justify-center border-e border-slate-300 pe-4">
                  {logoSrc ? <img src={logoSrc} alt="" className="max-h-[25mm] max-w-[58mm] object-contain" /> : (
                    <div className="text-center text-[16px] font-bold">{companyName}</div>
                  )}
                </div>
                <div className="min-w-0 text-[10px] leading-relaxed">
                  <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">{companyName}</div>
                  {workspaceDescription?.trim() ? <div className="mt-1 text-slate-600">{workspaceDescription}</div> : null}
                  <h1 className="mt-2 text-[19px] font-black uppercase tracking-wide text-slate-900">
                    {label('title', 'Inventory Transfer')}
                  </h1>
                  <div className="mt-1 inline-flex rounded bg-slate-900 px-2.5 py-1 text-[10px] font-bold text-white">
                    {data.batch.transferNumber}
                  </div>
                </div>
              </header>
              <div className="mt-4 grid grid-cols-3 gap-x-5 gap-y-2 text-[9px]" data-inventory-transfer-metadata data-pdf-keep-together>
                <Info label={label('date', 'Transfer Date / Time')} value={formatDateTime(data.batch.transferredAt)} />
                <Info label={label('performedBy', 'Performed By')} value={data.performedByName || data.batch.performedBy || '—'} />
                <Info label={label('statusLabel', 'Status')} value={t(`inventoryTransfer.batch.status.${data.batch.status}`, { defaultValue: data.batch.status })} />
                {data.batch.notes?.trim() ? (
                  <div className="col-span-3">
                    <Info label={label('notes', 'Notes')} value={data.batch.notes} />
                  </div>
                ) : null}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3" data-inventory-transfer-locations data-pdf-keep-together>
                {!sameWorkspace && (
                  <>
                    <TransferLocationCard
                      title={label('from', 'From')}
                      icon={ArrowDownLeft}
                      locationLabel={sourceNameLabel}
                      locationName={data.batch.sourceWorkspaceName || '—'}
                      storageLabel={label('storage', 'Storage')}
                      storageName={data.batch.sourceStorageName || '—'}
                    />
                    <TransferLocationCard
                      title={label('to', 'To')}
                      icon={ArrowUpRight}
                      locationLabel={destinationNameLabel}
                      locationName={data.batch.destinationWorkspaceName || '—'}
                      storageLabel={label('storage', 'Storage')}
                      storageName={data.batch.destinationStorageName || '—'}
                    />
                  </>
                )}
                {sameWorkspace ? (
                  <>
                    <TransferLocationCard
                      title={label('from', 'From')}
                      icon={ArrowDownLeft}
                      storageLabel={label('storage', 'Storage')}
                      storageName={data.batch.sourceStorageName || '—'}
                    />
                    <TransferLocationCard
                      title={label('to', 'To')}
                      icon={ArrowUpRight}
                      storageLabel={label('storage', 'Storage')}
                      storageName={data.batch.destinationStorageName || '—'}
                    />
                  </>
                ) : null}
              </div>
            </>
          )}

          <div className="mt-3">
            <table
              ref={pageIndex === 0 ? firstPageTableRef : undefined}
              className="w-full table-fixed border-collapse text-[9px]"
              data-pdf-page-chunk
            >
              <thead>
                <tr className="bg-slate-800 text-white">
                  <th className="w-[6%] border border-slate-500 px-1.5 py-2 text-center">#</th>
                  <th className="w-[34%] border border-slate-500 px-1.5 py-2 text-start">{label('product', 'Product')}</th>
                  <th className="w-[18%] border border-slate-500 px-1.5 py-2 text-start">{label('sku', 'SKU')}</th>
                  <th className="w-[16%] border border-slate-500 px-1.5 py-2 text-end">{label('quantity', 'Quantity')}</th>
                  <th className="w-[12%] border border-slate-500 px-1.5 py-2 text-start">{label('unit', 'Unit')}</th>
                  <th className="w-[14%] border border-slate-500 px-1.5 py-2 text-start">{label('batchLot', 'Batch / Lot')}</th>
                </tr>
              </thead>
              <tbody>
                {products.length > 0 ? (
                  <>
                    {products.map((product, index) => {
                      const allocations = product.batchAllocations.map((allocation) => allocation.batchNumber).filter(Boolean)
                      return (
                        <tr
                          key={product.transactionId || product.productId}
                          className={index % 2 ? 'bg-slate-50' : 'bg-white'}
                          data-inventory-transfer-product-row
                          data-product-index={startIndex + index}
                          data-pdf-keep-together
                          style={{ height: `${PRODUCT_ROW_HEIGHT_MM}mm` }}
                        >
                          <td className="border border-slate-300 px-1.5 py-1.5 text-center">{startIndex + index + 1}</td>
                          <td className="border border-slate-300 px-1.5 py-1.5 font-semibold">{product.productName || '—'}</td>
                          <td className="border border-slate-300 px-1.5 py-1.5">{product.sku || '—'}</td>
                          <td className="border border-slate-300 px-1.5 py-1.5 text-end font-bold">{number.format(product.quantity)}</td>
                          <td className="border border-slate-300 px-1.5 py-1.5">{getProductUnitLabel(product.unit, t) || '—'}</td>
                          <td className="border border-slate-300 px-1.5 py-1.5">{allocations.join(', ') || '—'}</td>
                        </tr>
                      )
                    })}
                  </>
                ) : (
                  <tr><td className="border border-slate-300 px-2 py-4 text-center text-slate-500" colSpan={6}>{label('noProducts', 'No products were returned for this batch.')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {pageIndex === pages.length - 1 ? (
            <footer className="mt-5 flex justify-between border-t border-slate-300 pt-2 text-[8px] text-slate-500">
              <span>{data.batch.transferNumber}</span>
              <span>{label('printedAt', 'Printed')} · {formatDateTime(data.printedAt)}</span>
            </footer>
          ) : null}
        </section>
      ))}
    </div>
  )
}

function TransferLocationCard({
  title,
  icon: Icon,
  locationLabel,
  locationName,
  storageLabel,
  storageName,
}: {
  title: string
  icon: LucideIcon
  locationLabel?: string
  locationName?: string
  storageLabel: string
  storageName: string
}) {
  return (
    <section className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2" data-pdf-keep-together>
      <h3 className="flex shrink-0 items-center gap-1.5 rounded bg-teal-50 px-2 py-1 text-[8px] font-black uppercase tracking-wide text-teal-800">
        <Icon className="h-3 w-3" />{title}
      </h3>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        {locationLabel ? <LocationDetail label={locationLabel} value={locationName || '—'} /> : null}
        <LocationDetail label={storageLabel} value={storageName || '—'} />
      </div>
    </section>
  )
}

function LocationDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-[10px] font-semibold text-slate-500">{label}</span>
      <span className="min-w-0 break-words text-[12px] font-bold leading-tight text-slate-900">{value}</span>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 border-b border-slate-200 pb-1">
      <span className="font-semibold text-slate-500">{label}</span>
      <span className="min-w-0 break-words font-semibold text-slate-900">{value || '—'}</span>
    </div>
  )
}
