import { useRef, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Circle,
  PackagePlus,
  Building2,
  Truck,
  Warehouse,
  CheckCircle2,
  Wallet,
  History,
  ShieldCheck,
} from 'lucide-react'
import type { PostalEvent, PostalState } from './domain'

const icons: Record<string, typeof Circle> = {
  created: PackagePlus,
  receive: Building2,
  dispatch: Truck,
  arrive: Warehouse,
  out_for_delivery: Truck,
  deliver: CheckCircle2,
  merchant_account_updated: Wallet,
  cod_recorded: Wallet,
  delivery_fee_recorded: Wallet,
  admin_correction: ShieldCheck,
}
export function ShipmentTimeline({
  events,
  state,
  complete = true,
}: {
  events: PostalEvent[]
  state: PostalState
  complete?: boolean
}) {
  const { t, i18n } = useTranslation()
  const drag = useRef<{ x: number; left: number } | null>(null)
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || window.innerWidth < 768)
      return
    drag.current = { x: e.clientX, left: e.currentTarget.scrollLeft }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const future =
    complete && !['delivered', 'cancelled'].includes(state)
      ? state === 'draft'
        ? 'received'
        : state === 'out_for_delivery'
          ? 'delivered'
          : 'out_for_delivery'
      : null
  const physicalIndex = events.reduce(
    (last, event, index) =>
      !['merchant_account_updated', 'cod_recorded', 'delivery_fee_recorded'].includes(
        event.event_type,
      ) && event.resulting_state === state
        ? index
        : last,
    -1,
  )
  return (
    <section aria-label={t('postal.history')} className="min-w-0">
      <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
        <History className="h-5 w-5" />
        {t('postal.history')}
      </h2>
      <div
        data-testid="postal-timeline"
        tabIndex={0}
        aria-label={t('postal.timelineHint')}
        className="overflow-x-hidden rounded-xl border bg-card p-4 md:cursor-grab md:overflow-x-auto md:active:cursor-grabbing"
        onPointerDown={onDown}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onPointerMove={(e) => {
          if (drag.current)
            e.currentTarget.scrollLeft =
              drag.current.left - (e.clientX - drag.current.x)
        }}
      >
        <ol className="flex flex-col gap-4 md:min-w-max md:flex-row md:items-stretch md:gap-0">
          {events.map((event, index) => {
            const Icon = icons[event.event_type] ?? History
            const current = complete && index === physicalIndex
            const financial = [
              'merchant_account_updated',
              'cod_recorded',
              'delivery_fee_recorded',
            ].includes(event.event_type)
            return (
              <li
                key={event.id}
                className="relative flex gap-3 border-s-2 border-border ps-4 md:w-52 md:flex-col md:border-s-0 md:border-t-2 md:px-4 md:pt-4"
                aria-current={current ? 'step' : undefined}
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${financial ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : current ? 'bg-primary text-primary-foreground' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'}`}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="font-semibold">
                    {t(`postal.events.${event.event_type}`)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      financial
                        ? 'postal.financialEvent'
                        : 'postal.physicalEvent',
                    )}
                  </p>
                  <time className="block text-xs" dateTime={event.created_at}>
                    {new Date(event.created_at).toLocaleString(i18n.language)}
                  </time>
                  <p className="break-words text-sm">{event.actor_name}</p>
                  {!!event.metadata.origin_name && (
                    <p className="text-xs">
                      {String(event.metadata.origin_name)}
                    </p>
                  )}
                  {!!event.metadata.destination_name && (
                    <p className="text-xs">
                      → {String(event.metadata.destination_name)}
                    </p>
                  )}
                  {event.notes && (
                    <p className="break-words text-xs text-muted-foreground">
                      {event.notes}
                    </p>
                  )}
                  {!!event.metadata.reason && (
                    <p className="break-words text-xs text-muted-foreground">
                      {t('postal.correctionReason')}:{' '}
                      {String(event.metadata.reason)}
                    </p>
                  )}
                  {event.metadata.signed_amount !== undefined && (
                    <p className="text-sm font-medium">
                      {Number(event.metadata.signed_amount).toLocaleString(
                        i18n.language,
                      )}{' '}
                      {t('postal.iqd')}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
          {future && (
            <li className="flex items-start gap-3 border-s-2 border-dashed ps-4 text-muted-foreground md:w-52 md:flex-col md:border-s-0 md:border-t-2 md:px-4 md:pt-4">
              <Circle className="h-10 w-10 p-2" />
              <p>
                {t(`postal.states.${future}`)}
                <span className="block text-xs">{t('postal.upcoming')}</span>
              </p>
            </li>
          )}
        </ol>
      </div>
    </section>
  )
}
