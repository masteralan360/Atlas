import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ExternalLink, Loader2, PackageCheck, RefreshCw } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useOptionalAuth } from '@/auth'
import { db, INVENTORY_TRANSACTIONS_CHANGED_EVENT } from '@/local-db/database'
import { queryClient } from '@/query/queryClient'
import { queryKeys } from '@/query/queryKeys'
import { useStockAvailability, useVisibleStockReservations, type StockPosition, type useStockDemandGuard } from '@/local-db/stockReservations'
import { STOCK_RESERVATION_CONFLICT_EVENT, type StockReservationConflict } from '@/lib/stockReservationConflict'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import { Button } from '@/ui/components/button'
import { AppDialog, AppDialogBody, AppDialogContent, AppDialogDescription, AppDialogFooter, AppDialogHeader, AppDialogTitle } from '@/ui/components/dialog'
import { SmallDialog, SmallDialogBody, SmallDialogContent, SmallDialogHeader, SmallDialogTitle } from '@/ui/components/small-dialog'
import { AppPagination } from '@/ui/components/AppPagination'
import { reportStockReservationConflict } from '@/lib/stockReservationConflict'
import { getPathWithLang } from '@/lib/i18nRouting'
import { formatStockReservationQuantity, getSellableStockQuantity, type StockReservationSellingUnit } from '@/lib/stockReservationPresentation'

function useReservationQuantityFormatter(workspaceId?: string, productId?: string, sellingUnit?: StockReservationSellingUnit) {
  const { t, i18n } = useTranslation()
  const unit = useLiveQuery(async () => {
    const product = productId ? await db.products.get(productId) : undefined
    return product?.workspaceId === workspaceId ? product?.unit : undefined
  }, [workspaceId, productId])
  const unitLabel = (code?: string | null) => code ? t(`products.units.${code}`, { defaultValue: code }) : t('stockReservations.baseUnits')
  const baseLabel = unitLabel(sellingUnit?.baseUnitCode || unit)
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 6 })
  return (value: number) => formatStockReservationQuantity(value, baseLabel,
    sellingUnit?.unitCode ? { label: unitLabel(sellingUnit.unitCode), factor: sellingUnit.factor ?? 1, isDynamic: sellingUnit.isDynamic } : undefined,
    quantity => number.format(quantity), t('common.and'))
}

export function SellableStockQuantity({ workspaceId, productId, storageId, inCart = 0, unitFactor = 1, unitCode, isDynamic = true }: {
  workspaceId?: string; productId: string; storageId?: string | null; inCart?: number; unitFactor?: number; unitCode?: string; isDynamic?: boolean
}) {
  const { t, i18n } = useTranslation()
  const result = useStockAvailability(workspaceId, storageId ? [{ productId, storageId }] : [])
  const stock = result.data?.find(row => row.productId === productId && row.storageId === storageId)
  if (!stock || result.error) return <span aria-label={t(result.error ? 'stockReservations.loadFailed' : 'stockReservations.checking')}>…</span>
  const value = getSellableStockQuantity(stock.available, inCart, unitFactor, isDynamic)
  const quantity = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 6 }).format(value)
  const label = unitCode ? `${quantity} ${t(`products.units.${unitCode}`, { defaultValue: unitCode })}` : quantity
  return <span aria-label={t('stockReservations.availableQuantity', { quantity: label })}>{label}</span>
}

export function StockDemandNotice({ workspaceId, guard }: { workspaceId?: string; guard: ReturnType<typeof useStockDemandGuard> }) {
  const { t } = useTranslation()
  if (!guard.blocked) return null
  return <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="status">
    {guard.isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
    <span className="min-w-0 flex-1">{t(guard.isLoading ? 'stockReservations.checking' : guard.error || guard.hasAvailabilityGap ? 'stockReservations.loadFailed' : 'stockReservations.resolveHelp')}</span>
    {guard.error || (guard.hasAvailabilityGap && !guard.isLoading) ? <Button type="button" variant="outline" size="sm" disabled={guard.isFetching} onClick={() => void guard.refetch()}><RefreshCw className="me-1 h-4 w-4" />{t('stockReservations.retry')}</Button>
      : guard.conflicts[0] && workspaceId ? <Button type="button" variant="outline" size="sm" onClick={() => {
        const stock = guard.conflicts[0]
        reportStockReservationConflict({ ...stock, workspaceId, required: guard.requiredByPosition.get(`${stock.productId}:${stock.storageId}`) ?? 0 })
      }}>{t('stockReservations.reviewItems')}</Button> : null}
  </div>
}

export function StockReservationDetails({ workspaceId, position, open, onOpenChange, sellingUnit }: {
  workspaceId: string; position: StockPosition; open: boolean; onOpenChange: (open: boolean) => void; sellingUnit?: StockReservationSellingUnit
}) {
  const { t, i18n } = useTranslation()
  const format = useReservationQuantityFormatter(workspaceId, position.productId, sellingUnit)
  const { currentPage, setCurrentPage, pageSize } = usePaginationState({ initialPageSize: 20, resetOn: [workspaceId, position.productId, position.storageId, open] })
  const result = useVisibleStockReservations(workspaceId, position, currentPage, open)
  const bounds = usePaginationBounds({ currentPage, setCurrentPage, pageSize, totalCount: result.data?.total, isLoading: result.isLoading, error: result.error })
  return <SmallDialog open={open} onOpenChange={onOpenChange}>
    <SmallDialogContent layout="structured" className="sm:max-w-xl" aria-describedby={undefined}>
      <SmallDialogHeader layout="structured" className="rtl:pl-14 rtl:pr-4 sm:rtl:pr-6">
        <SmallDialogTitle className="flex items-center gap-2"><PackageCheck className="h-5 w-5" />{t('stockReservations.detailsTitle')}</SmallDialogTitle>
        <AppPagination currentPage={bounds.currentPage} pageSize={pageSize} pageCount={bounds.pageCount} totalCount={result.data?.total ?? 0} onPageChange={setCurrentPage} />
      </SmallDialogHeader>
      <SmallDialogBody className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('stockReservations.visibilityHelp')}</p>
        {result.isLoading ? <div className="flex justify-center gap-2 p-6" role="status"><Loader2 className="h-5 w-5 animate-spin" />{t('common.loading')}</div>
          : result.error ? <p role="alert">{t('stockReservations.loadFailed')}</p>
          : result.data?.rows.length ? result.data.rows.map(row => <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <a href={`#${getPathWithLang(`/orders/${encodeURIComponent(row.id)}`, i18n.language)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 font-medium text-primary underline">
              <bdi>{row.order_number}</bdi><ExternalLink className="h-4 w-4" />
            </a>
            <span><bdi>{t('stockReservations.reservedQuantity', { quantity: format(row.quantity) })}</bdi></span>
          </div>) : <p>{t('stockReservations.noVisibleOrders')}</p>}
      </SmallDialogBody>
    </SmallDialogContent>
  </SmallDialog>
}

/** Small, reusable selling-stock readout. No nested interactive controls on catalog cards. */
export function StockReservationInfo({ workspaceId, productId, storageId, required, excludeOrderId, interactive = true, hideWhenUnreserved = false, sellingUnit }: {
  workspaceId?: string; productId?: string; storageId?: string | null; required?: number; excludeOrderId?: string; interactive?: boolean; hideWhenUnreserved?: boolean; sellingUnit?: StockReservationSellingUnit
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const format = useReservationQuantityFormatter(workspaceId, productId, sellingUnit)
  const position = { productId: productId || '', storageId: storageId || '' }
  const result = useStockAvailability(workspaceId, workspaceId && productId && storageId ? [position] : [], excludeOrderId)
  if (!workspaceId || !productId || !storageId) return null
  if (result.isLoading) return hideWhenUnreserved ? null : <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status"><Loader2 className="h-3 w-3 animate-spin" />{t('stockReservations.checking')}</span>
  if (result.error) return <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"><RefreshCw className="h-3 w-3" />{t('stockReservations.loadFailed')}</span>
  const stock = result.data?.find(row => row.productId === productId && row.storageId === storageId)
  if (!stock) return null
  const shortage = required !== undefined && required > stock.available + 0.0000005
  if (hideWhenUnreserved && stock.reserved <= 0 && !shortage) return null
  return <>
    <span className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${shortage ? 'text-destructive' : 'text-muted-foreground'}`} data-testid="stock-reservation-info">
      {shortage ? <AlertTriangle className="h-3.5 w-3.5" /> : <PackageCheck className="h-3.5 w-3.5" />}
      <span className="font-semibold">{t(excludeOrderId ? 'stockReservations.availableForOrderQuantity' : 'stockReservations.availableQuantity', { quantity: format(stock.available) })}</span>
      <span>{t('stockReservations.onHandQuantity', { quantity: format(stock.onHand) })}</span>
      {excludeOrderId && required !== undefined && <span>{t('stockReservations.ownReservationQuantity', { quantity: format(required) })}</span>}
      {stock.reserved > 0 && (interactive ? <button type="button" onClick={event => { event.stopPropagation(); setOpen(true) }} className="rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-800 dark:text-amber-200 underline" aria-label={t('stockReservations.detailsTitle')}>
        {t('stockReservations.reservedQuantity', { quantity: format(stock.reserved) })}
      </button> : <span className="rounded border border-amber-500/40 px-1.5 py-0.5 text-amber-800 dark:text-amber-200">{t('stockReservations.reservedQuantity', { quantity: format(stock.reserved) })}</span>)}
      {shortage && <span role="status">{t('stockReservations.shortQuantity', { quantity: format(Math.max(0, (required ?? 0) - stock.available)) })}</span>}
    </span>
    {interactive && open && <StockReservationDetails workspaceId={workspaceId} position={position} open={open} onOpenChange={setOpen} sellingUnit={sellingUnit} />}
  </>
}

/** Central error presentation also covers backend conflicts discovered after the cart was checked. */
export function GlobalStockReservationConflict() {
  const user = useOptionalAuth()?.user
  const { t } = useTranslation()
  const [conflict, setConflict] = useState<StockReservationConflict | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  useEffect(() => {
    setConflict(null)
    const listener = (event: Event) => {
      const value = (event as CustomEvent<StockReservationConflict>).detail
      if (value.workspaceId === user?.workspaceId) { setDetailsOpen(false); setConflict(value) }
    }
    window.addEventListener(STOCK_RESERVATION_CONFLICT_EVENT, listener)
    return () => window.removeEventListener(STOCK_RESERVATION_CONFLICT_EVENT, listener)
  }, [user?.workspaceId, user?.id])
  useEffect(() => {
    const refresh = (event: Event) => {
      const ids = (event as CustomEvent<{ workspaceIds?: string[] }>).detail?.workspaceIds
      if (user?.workspaceId && ids?.includes(user.workspaceId)) void queryClient.invalidateQueries({ queryKey: queryKeys.stockReservations.all(user.workspaceId) })
    }
    window.addEventListener(INVENTORY_TRANSACTIONS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(INVENTORY_TRANSACTIONS_CHANGED_EVENT, refresh)
  }, [user?.workspaceId])
  const labels = useLiveQuery(async () => conflict ? {
    product: (await db.products.get(conflict.productId))?.name,
    storage: (await db.storages.get(conflict.storageId))?.name,
  } : undefined, [conflict?.productId, conflict?.storageId])
  const format = useReservationQuantityFormatter(conflict?.workspaceId, conflict?.productId)
  return <>
    <AppDialog open={!!conflict} onOpenChange={open => { if (!open) { setConflict(null); setDetailsOpen(false) } }}>
      <AppDialogContent className="max-w-lg">
        <AppDialogHeader className="rtl:pl-14 rtl:pr-4 sm:rtl:pr-6"><AppDialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive" />{t('stockReservations.conflictTitle')}</AppDialogTitle>
          <AppDialogDescription>{t('stockReservations.resolveHelp')}</AppDialogDescription></AppDialogHeader>
        <AppDialogBody>
          {conflict && <div className="space-y-4">
            <p className="font-medium"><bdi>{labels?.product || conflict.productName || t('stockReservations.product')}</bdi>{labels?.storage && <> · <bdi>{labels.storage}</bdi></>}</p>
            <dl className="grid grid-cols-2 gap-3 rounded-lg border p-4">
              {(['required', 'onHand', 'reserved', 'available'] as const).map(key => <div key={key} className="min-w-0"><dt className="text-sm text-muted-foreground">{t(`stockReservations.${key}`)}</dt><dd className="break-words text-lg font-semibold"><bdi>{format(conflict[key])}</bdi></dd></div>)}
            </dl>
            <p className="text-sm font-medium text-destructive">{t('stockReservations.shortQuantity', { quantity: format(Math.max(0, conflict.required - conflict.available)) })}</p>
          </div>}
        </AppDialogBody>
        <AppDialogFooter>
          <Button type="button" variant="outline" onClick={() => setDetailsOpen(true)}><PackageCheck className="me-2 h-4 w-4" />{t('stockReservations.detailsTitle')}</Button>
          <Button type="button" onClick={() => setConflict(null)}>{t('stockReservations.reviewItems')}</Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
    {conflict && detailsOpen && <StockReservationDetails workspaceId={conflict.workspaceId} position={conflict} open={detailsOpen} onOpenChange={setDetailsOpen} />}
  </>
}
