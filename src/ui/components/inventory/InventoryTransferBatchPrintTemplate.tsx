import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownLeft, ArrowUpRight, type LucideIcon } from 'lucide-react'
import { formatDateTime } from '@/lib/utils'
import type { InventoryTransferBatchDetails } from '@/local-db'
import { platformService } from '@/services/platformService'

const ROWS_PER_PAGE = 12

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

function chunkProducts(products: InventoryTransferBatchPrintData['products']) {
  if (products.length === 0) return [[]]
  const chunks: InventoryTransferBatchPrintData['products'][] = []
  for (let index = 0; index < products.length; index += ROWS_PER_PAGE) {
    chunks.push(products.slice(index, index + ROWS_PER_PAGE))
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
    tokens[`product${row}Unit`] = product.unit
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
  const language = printLang || i18n.language
  const direction = language.startsWith('ar') || language.startsWith('ku') ? 'rtl' : 'ltr'
  const pages = useMemo(() => chunkProducts(data.products), [data.products])
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
      {pages.map((products, pageIndex) => (
        <section
          key={`transfer-print-page-${pageIndex}`}
          className="box-border bg-white px-[9mm] py-[9mm]"
          style={{ minHeight: '297mm' }}
          data-pdf-page-chunk
        >
          {pageIndex === 0 ? (
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
              <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2 text-[9px]" data-pdf-keep-together>
                <Info label={label('date', 'Transfer Date / Time')} value={formatDateTime(data.batch.transferredAt)} />
                <Info label={label('performedBy', 'Performed By')} value={data.performedByName || data.batch.performedBy || '—'} />
                <Info label={label('statusLabel', 'Status')} value={t(`inventoryTransfer.batch.status.${data.batch.status}`, { defaultValue: data.batch.status })} />
                {data.batch.notes?.trim() ? <Info label={label('notes', 'Notes')} value={data.batch.notes} /> : null}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3" data-pdf-keep-together>
                {sameWorkspace ? (
                  <div className="col-span-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                    <Info label={sourceIsBranch || destinationIsBranch ? label('branch', 'Branch') : label('workspace', 'Workspace')}
                      value={data.batch.sourceWorkspaceName || data.batch.destinationWorkspaceName || companyName} />
                  </div>
                ) : (
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
          ) : (
            <header className="mb-4 flex items-start justify-between border-b-2 border-slate-800 pb-3" data-pdf-keep-together>
              <div>
                <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">{companyName}</div>
                <h1 className="mt-1 text-[16px] font-black uppercase tracking-wide">{label('continued', 'Inventory Transfer · Continued')}</h1>
              </div>
              <div className="rounded bg-slate-900 px-2.5 py-1 text-[10px] font-bold text-white">{data.batch.transferNumber}</div>
            </header>
          )}

          <div className="mt-4">
            {pageIndex === 0 ? <h2 className="mb-2 text-[10px] font-black uppercase tracking-wider text-slate-700">{label('products', 'Products Transferred')}</h2> : null}
            <table className="w-full table-fixed border-collapse text-[9px]" data-pdf-page-chunk data-centered-table>
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
                {products.length > 0 ? products.map((product, index) => {
                  const allocations = product.batchAllocations.map((allocation) => allocation.batchNumber).filter(Boolean)
                  return (
                    <tr key={product.transactionId || product.productId} className={index % 2 ? 'bg-slate-50' : 'bg-white'} data-pdf-keep-together style={{ height: '10mm' }}>
                      <td className="border border-slate-300 px-1.5 py-1.5 text-center">{pageIndex * ROWS_PER_PAGE + index + 1}</td>
                      <td className="border border-slate-300 px-1.5 py-1.5 font-semibold">{product.productName || '—'}</td>
                      <td className="border border-slate-300 px-1.5 py-1.5">{product.sku || '—'}</td>
                      <td className="border border-slate-300 px-1.5 py-1.5 text-end font-bold">{number.format(product.quantity)}</td>
                      <td className="border border-slate-300 px-1.5 py-1.5">{product.unit || '—'}</td>
                      <td className="border border-slate-300 px-1.5 py-1.5">{allocations.join(', ') || '—'}</td>
                    </tr>
                  )
                }) : (
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
    <section className="rounded-lg border border-slate-200 bg-slate-50/70 p-3" data-pdf-keep-together>
      <h3 className="mb-2 flex items-center gap-2 border-b border-slate-200 pb-2 text-[10px] font-black uppercase tracking-wide text-slate-700">
        <Icon className="h-3.5 w-3.5 text-teal-700" />{title}
      </h3>
      <div className="space-y-2 text-[9px]">
        {locationLabel ? <Info label={locationLabel} value={locationName || '—'} /> : null}
        <Info label={storageLabel} value={storageName || '—'} />
      </div>
    </section>
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
