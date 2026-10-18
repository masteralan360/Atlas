import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useTranslation } from 'react-i18next'
import { useKdsStream } from '@/hooks/useKdsStream'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useAuth } from '@/auth'
import { saveRestaurantPosTicket, useRestaurantPosTickets, useRestaurantTableSettings } from '@/local-db/restaurantTables'
import { cn, formatTime, stylizeText } from '@/lib/utils'
import { Check } from 'lucide-react'
import { isDesktop } from '@/lib/platform'

const TICKETS_STORAGE_KEY = 'instant_pos_tickets'
const LATE_THRESHOLD_MS = 10 * 60 * 1000

type InstantPosStatus = 'pending' | 'preparing' | 'ready' | 'served'

type InstantPosItem = {
    productId: string
    name: string
    sku: string
    unitPrice: number
    quantity: number
    currency: string
    note?: string
}

type InstantPosTicket = {
    id: string
    number: string
    createdAt: string
    status: InstantPosStatus
    items: InstantPosItem[]
    tableNumber?: string
    kitchenRoutedAt?: string
}

type KdsColumnStatus = 'pending' | 'preparing' | 'ready' | 'served'

const COLUMN_ORDER: KdsColumnStatus[] = ['pending', 'preparing', 'ready', 'served']

const COLUMN_CONFIG: Record<KdsColumnStatus, {
    labelKey: string
    accent: string
    stripe: string
    action?: {
        labelKey: string
        next: KdsColumnStatus
        button: string
    }
}> = {
    pending: {
        labelKey: 'kdsDashboard.column.pending',
        accent: 'text-amber-700',
        stripe: 'bg-amber-500',
        action: {
            labelKey: 'kdsDashboard.action.startCooking',
            next: 'preparing',
            button: 'bg-[#F2991A] text-white hover:bg-amber-600'
        }
    },
    preparing: {
        labelKey: 'kdsDashboard.column.preparing',
        accent: 'text-blue-700',
        stripe: 'bg-blue-500',
        action: {
            labelKey: 'kdsDashboard.action.markReady',
            next: 'ready',
            button: 'bg-blue-600 text-white hover:bg-blue-500'
        }
    },
    ready: {
        labelKey: 'kdsDashboard.column.ready',
        accent: 'text-emerald-700',
        stripe: 'bg-emerald-500',
        action: {
            labelKey: 'kdsDashboard.action.serveOrder',
            next: 'served',
            button: 'bg-emerald-600 text-white hover:bg-emerald-500'
        }
    },
    served: {
        labelKey: 'kdsDashboard.column.served',
        accent: 'text-slate-600',
        stripe: 'bg-slate-400'
    }
}

function loadTickets(): InstantPosTicket[] {
    if (typeof window === 'undefined') return []
    try {
        const raw = localStorage.getItem(TICKETS_STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed)
            ? parsed.map((ticket: InstantPosTicket) => {
                const storedStatus = (ticket as { status?: unknown }).status
                return {
                    ...ticket,
                    status: storedStatus === 'paid'
                    ? 'served'
                    : ticket.status
                }
            })
            : []
    } catch {
        return []
    }
}

function saveTickets(tickets: InstantPosTicket[]) {
    if (typeof window === 'undefined') return
    const next = JSON.stringify(tickets)
    const current = localStorage.getItem(TICKETS_STORAGE_KEY)
    if (current === next) return
    localStorage.setItem(TICKETS_STORAGE_KEY, next)
    window.dispatchEvent(new CustomEvent('instant-pos-tickets-updated'))
}

function formatElapsed(start: string, now: Date) {
    const diff = Math.max(0, now.getTime() - new Date(start).getTime())
    const minutes = Math.floor(diff / 60000)
    const seconds = Math.floor((diff % 60000) / 1000)
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatClockTime(date: Date, withSeconds: boolean) {
    return formatTime(date, { includeSeconds: withSeconds })
}

export function KDSDashboard() {
    const { hasFeature, workspaceName } = useWorkspace()
    const { user } = useAuth()
    const { t } = useTranslation()

    const restaurantTableSettings = useRestaurantTableSettings(user?.workspaceId)
    const restaurantLiveSyncEnabled = restaurantTableSettings?.liveSyncEnabled === true
    const restaurantPosTickets = useRestaurantPosTickets(user?.workspaceId, restaurantLiveSyncEnabled)
    const isRestaurantTableView = restaurantTableSettings?.enabled === true
    const [tickets, setTickets] = useState<InstantPosTicket[]>(() => loadTickets())
    const activeTickets = isRestaurantTableView
        ? restaurantPosTickets.map((ticket) => ({
            id: ticket.id,
            number: ticket.number,
            createdAt: ticket.createdAt,
            status: ticket.status,
            items: ticket.items,
            tableNumber: String(ticket.tableNumber),
            kitchenRoutedAt: ticket.kitchenRoutedAt,
        }))
        : tickets
    const [now, setNow] = useState(() => new Date())
    const [draggingId, setDraggingId] = useState<string | null>(null)
    const [dragOverStatus, setDragOverStatus] = useState<KdsColumnStatus | null>(null)
    const [touchDragging, setTouchDragging] = useState<{ id: string, initialX: number, initialY: number } | null>(null)

    const isMain = isDesktop()
    const { status: streamStatus, streamUrl, broadcast, sendViaSocket } = useKdsStream(isMain)

    useEffect(() => {
        const interval = window.setInterval(() => setNow(new Date()), 1000)
        return () => window.clearInterval(interval)
    }, [])

    useEffect(() => {
        if (isRestaurantTableView) return
        saveTickets(tickets)
        // Broadcast to remote clients whenever tickets change on the main terminal
        if (isMain && streamStatus === 'host') {
            broadcast('TICKET_UPDATED', tickets)
        }
    }, [broadcast, isMain, isRestaurantTableView, streamStatus, tickets])

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key === TICKETS_STORAGE_KEY) {
                setTickets(loadTickets())
            }
        }
        window.addEventListener('storage', handleStorage)

        // Internal event for same-window updates (e.g. from POS to KDS Dashboard)
        const handleInternalSync = () => {
            setTickets(loadTickets())
        }
        window.addEventListener('instant-pos-tickets-updated', handleInternalSync)

        const handleStreamUpdate = (event: any) => {
            const updatedTickets = event.detail
            if (updatedTickets && Array.isArray(updatedTickets)) {
                if (!isMain) {
                    setTickets(updatedTickets)
                }
            }
        }
        window.addEventListener('kds-stream-update', handleStreamUpdate)

        // Main terminal listens for updates from remote clients
        const handleRemoteSync = (event: any) => {
            const updatedTickets = event.detail
            if (updatedTickets && Array.isArray(updatedTickets) && isMain) {
                setTickets(updatedTickets)
            }
        }
        window.addEventListener('kds-remote-sync', handleRemoteSync)

        return () => {
            window.removeEventListener('storage', handleStorage)
            window.removeEventListener('instant-pos-tickets-updated', handleInternalSync)
            window.removeEventListener('kds-stream-update', handleStreamUpdate)
            window.removeEventListener('kds-remote-sync', handleRemoteSync)
        }
    }, [isMain])

    const visibleTickets = useMemo(
        () => activeTickets.filter((ticket: InstantPosTicket) => ticket.items.length > 0),
        [activeTickets]
    )

    const groupedTickets = useMemo(() => {
        const groups: Record<KdsColumnStatus, InstantPosTicket[]> = {
            pending: [],
            preparing: [],
            ready: [],
            served: []
        }

        visibleTickets.forEach((ticket: InstantPosTicket) => {
            groups[ticket.status as KdsColumnStatus].push(ticket)
        })

        COLUMN_ORDER.forEach(status => {
            groups[status].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        })

        return groups
    }, [visibleTickets])

    const stationLabel = workspaceName ? `${workspaceName} - ${t('kdsDashboard.kitchen')}` : t('kdsDashboard.mainKitchen')
    const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine
    const isKdsEnabled = hasFeature('kds')
    const isSystemOnline = isMain ? (isKdsEnabled && isOnline) : isOnline
    const systemStatusLabel = isMain 
        ? (isKdsEnabled
            ? (isOnline ? t('kdsDashboard.systemOnline') : t('kdsDashboard.systemOffline'))
            : t('kdsDashboard.kdsDisabled')) 
        : (isDesktop() 
            ? (isOnline ? t('kdsDashboard.systemOnline') : t('kdsDashboard.systemOffline')) 
            : t('kdsDashboard.hostingDisabled'))

    const updateTicketStatus = (ticketId: string, status: KdsColumnStatus) => {
        const nextTickets = activeTickets.map((ticket: InstantPosTicket) => {
            if (ticket.id !== ticketId) return ticket
            return {
                ...ticket,
                status,
                kitchenRoutedAt: status === 'preparing'
                    ? (ticket.kitchenRoutedAt || new Date().toISOString())
                    : ticket.kitchenRoutedAt
            }
        })
        if (isRestaurantTableView) {
            const sourceTicket = restaurantPosTickets.find((ticket) => ticket.id === ticketId)
            if (sourceTicket) {
                void saveRestaurantPosTicket({
                    ...sourceTicket,
                    status,
                    kitchenRoutedAt: status === 'preparing'
                        ? (sourceTicket.kitchenRoutedAt || new Date().toISOString())
                        : sourceTicket.kitchenRoutedAt,
                    updatedAt: new Date().toISOString(),
                    version: sourceTicket.version + 1,
                }, restaurantLiveSyncEnabled)
            }
        } else {
            setTickets(nextTickets)
        }
        // Remote client sends via WebSocket
        if (!isRestaurantTableView && !isMain) {
            sendViaSocket('TICKET_UPDATED', nextTickets)
        }
    }

    const handleDragStart = (event: DragEvent<HTMLElement>, ticketId: string) => {
        event.dataTransfer.setData('text/plain', ticketId)
        event.dataTransfer.effectAllowed = 'move'
        setDraggingId(ticketId)
    }

    const handleDragEnd = () => {
        setDraggingId(null)
        setDragOverStatus(null)
    }

    const handleDrop = (event: DragEvent<HTMLElement>, status: KdsColumnStatus) => {
        event.preventDefault()
        const ticketId = event.dataTransfer.getData('text/plain') || draggingId
        if (!ticketId) return
        updateTicketStatus(ticketId, status)
        setDraggingId(null)
        setDragOverStatus(null)
    }

    const handleTouchStart = (event: React.TouchEvent, ticketId: string) => {
        const touch = event.touches[0]
        setTouchDragging({ id: ticketId, initialX: touch.clientX, initialY: touch.clientY })
        setDraggingId(ticketId)
    }

    const handleTouchMove = (event: React.TouchEvent) => {
        if (!touchDragging) return
        if (event.cancelable) event.preventDefault() // Prevent scrolling while dragging
        const touch = event.touches[0]
        const element = document.elementFromPoint(touch.clientX, touch.clientY)
        const column = element?.closest('[data-kds-column]')
        const status = column?.getAttribute('data-kds-column') as KdsColumnStatus | null
        
        if (status && status !== dragOverStatus) {
            setDragOverStatus(status)
        } else if (!status && dragOverStatus) {
            setDragOverStatus(null)
        }
    }

    const handleTouchEnd = (event: React.TouchEvent) => {
        if (!touchDragging) return
        
        const touch = event.changedTouches[0]
        const element = document.elementFromPoint(touch.clientX, touch.clientY)
        const column = element?.closest('[data-kds-column]')
        const status = column?.getAttribute('data-kds-column') as KdsColumnStatus | null

        if (status) {
            updateTicketStatus(touchDragging.id, status)
        }

        setTouchDragging(null)
        setDraggingId(null)
        setDragOverStatus(null)
    }



    return (
        <div className="relative flex h-full min-h-[calc(100vh-180px)] flex-col overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900 text-slate-100 shadow-2xl">
            <div className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(circle_at_top,rgba(56,189,248,0.16),transparent_60%),radial-gradient(circle_at_bottom,rgba(16,185,129,0.14),transparent_55%)]" />

            <header className="relative z-10 flex flex-wrap items-center justify-between gap-4 border-b border-white/10 bg-slate-900/60 px-6 py-4 backdrop-blur">
                <div className="flex flex-wrap items-center gap-4">
                    <div>
                        <h1 className="text-xl font-semibold tracking-tight">{t('kdsDashboard.title')}</h1>
                        <p className="text-xs text-slate-400">
                            {t('kdsDashboard.subtitle')} <ModulePageFreshness className="ms-2" />
                        </p>
                    </div>
                    <span className={cn(
                        'rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest shadow-lg',
                        isSystemOnline ? 'bg-emerald-500/20 text-emerald-200 shadow-emerald-500/30' : 'bg-rose-500/20 text-rose-200 shadow-rose-500/30'
                    )}>
                        {systemStatusLabel}
                    </span>
                    {streamUrl && (
                        <span className="flex items-center gap-1.5 rounded-full bg-blue-500/20 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-blue-200 shadow-lg shadow-blue-500/30">
                            <span className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                streamStatus === 'connected' || streamStatus === 'host' ? "bg-blue-400 animate-pulse" : "bg-slate-400"
                            )} />
                            {isMain ? t('kdsDashboard.streaming') : t('kdsDashboard.remote')}
                        </span>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-5">
                    <div className="text-right">
                        <div className="text-[10px] uppercase tracking-[0.3em] text-slate-400">{t('kdsDashboard.station')}</div>
                        <div className="text-sm font-semibold text-slate-100">{stationLabel}</div>
                    </div>
                    <div className="h-10 w-px bg-white/10" />
                    <div className="text-right">
                        <div className="text-[10px] uppercase tracking-[0.3em] text-slate-400">{t('kdsDashboard.currentTime')}</div>
                        <div className="text-lg font-mono font-semibold text-slate-100">
                            {formatClockTime(now, true)}
                        </div>
                    </div>
                </div>
            </header>

            {isMain && !isKdsEnabled && (
                <div className="relative z-10 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-200">
                    {t('kdsDashboard.disabledBanner')}
                </div>
            )}

            <div className="relative z-10 flex-1 overflow-hidden p-4">
                <div className="grid h-full gap-4 xl:grid-cols-4">
                    {COLUMN_ORDER.map(status => {
                        const config = COLUMN_CONFIG[status]
                        const columnTickets = groupedTickets[status]
                        const isDropTarget = dragOverStatus === status

                        return (
                            <section
                                key={status}
                                data-kds-column={status}
                                onDragOver={(event) => {
                                    event.preventDefault()
                                    event.dataTransfer.dropEffect = 'move'
                                    if (dragOverStatus !== status) {
                                        setDragOverStatus(status)
                                    }
                                }}
                                onDrop={(event) => handleDrop(event, status)}
                                onDragLeave={() => setDragOverStatus(null)}
                                className={cn(
                                    'flex min-h-0 flex-col rounded-2xl border border-white/10 bg-slate-900/50 p-4 shadow-inner backdrop-blur',
                                    isDropTarget && 'ring-2 ring-emerald-400/60 ring-offset-2 ring-offset-slate-950'
                                )}
                            >
                                <div className="flex items-center justify-between">
                                    <div className={cn('flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em]', config.accent)}>
                                        <span className={cn('h-2 w-2 rounded-full', config.stripe)} />
                                        {t(config.labelKey)}
                                    </div>
                                    <div className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-semibold text-slate-200">
                                        {columnTickets.length}
                                    </div>
                                </div>

                                <div className="mt-4 flex-1 min-h-0 space-y-4 overflow-y-auto custom-scrollbar pr-1">
                                    {columnTickets.length === 0 ? (
                                        <div className="rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-xs text-slate-400">
                                            {t('kdsDashboard.dragOrdersHere')}
                                        </div>
                                    ) : (
                                        columnTickets.map((ticket: InstantPosTicket) => {
                                            const normalizedStatus = ticket.status
                                            const action = COLUMN_CONFIG[normalizedStatus as KdsColumnStatus].action
                                            const elapsedFrom = ticket.kitchenRoutedAt || ticket.createdAt
                                            const elapsed = formatElapsed(elapsedFrom, now)
                                            const isLate = (normalizedStatus === 'pending' || normalizedStatus === 'preparing')
                                                && (now.getTime() - new Date(elapsedFrom).getTime()) > LATE_THRESHOLD_MS
                                            const timeLabel = normalizedStatus === 'served'
                                                ? formatClockTime(new Date(ticket.createdAt), false)
                                                : elapsed
                                            const timeCaption = normalizedStatus === 'served'
                                                ? t('kdsDashboard.timeCaption.completed')
                                                : normalizedStatus === 'ready'
                                                    ? t('kdsDashboard.timeCaption.ready')
                                                    : isLate
                                                        ? t('kdsDashboard.timeCaption.late')
                                                        : t('kdsDashboard.timeCaption.elapsed')

                                            return (
                                                <div
                                                    key={ticket.id}
                                                    draggable
                                                    onDragStart={(event) => handleDragStart(event, ticket.id)}
                                                    onDragEnd={handleDragEnd}
                                                    onTouchStart={(e) => handleTouchStart(e, ticket.id)}
                                                    onTouchMove={handleTouchMove}
                                                    onTouchEnd={handleTouchEnd}
                                                    className={cn(
                                                        'relative overflow-hidden rounded-lg bg-[#FFF9E6] shadow-xl transition-all select-none cursor-grab active:cursor-grabbing border-b-4 border-black/5 touch-action-none',
                                                        draggingId === ticket.id ? 'opacity-40 scale-95' : 'hover:-translate-y-0.5'
                                                    )}
                                                    style={{ touchAction: 'none' }}
                                                >
                                                    {/* Left Stripe */}
                                                    <div className={cn("absolute left-0 top-0 bottom-0 w-3", config.stripe)} />

                                                    <div className="pl-6 pr-4 py-4">
                                                        <div className="flex items-start justify-between">
                                                            <div>
                                                                <div className="text-[10px] font-bold uppercase tracking-wider text-[#7A5C33]">
                                                                    {t('kdsDashboard.orderPrefix', { number: ticket.number })}
                                                                </div>
                                                                <div className="mt-1 text-2xl font-black text-[#1A1A1A]">
                                                                    {t('kdsDashboard.ticketPrefix', { number: ticket.number })}
                                                                </div>
                                                                {ticket.tableNumber && (
                                                                    <div className="mt-2 inline-flex rounded-md bg-[#7A5C33]/10 px-2 py-1 text-xs font-black uppercase tracking-wide text-[#7A5C33]">
                                                                        {t('instantPos.table', { defaultValue: 'Table' })} {ticket.tableNumber}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {!isRestaurantTableView && (
                                                                <div className="text-right">
                                                                    <div className="text-2xl font-black text-[#7A5C33]">
                                                                        {timeLabel}
                                                                    </div>
                                                                    <div className="text-[10px] font-bold uppercase tracking-widest text-[#7A5C33]">
                                                                        {timeCaption}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>

                                                        <div className="mt-4 h-px bg-[#7A5C33]/10" />

                                                        <div className="mt-4 space-y-4">
                                                            {ticket.items.map((item: InstantPosItem) => (
                                                                <div key={item.productId} className="space-y-1">
                                                                    <div className="text-lg font-bold leading-none text-[#1A1A1A]">
                                                                        {item.quantity}x {item.name}
                                                                    </div>
                                                                    {item.note && (
                                                                        <div className="text-sm font-bold italic text-[#D93025]">
                                                                            — {stylizeText(item.note).toUpperCase()}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>

                                                        {action && (
                                                            <button
                                                                type="button"
                                                                onClick={() => updateTicketStatus(ticket.id, action.next)}
                                                                className={cn(
                                                                    'mt-6 w-full py-3 rounded-md text-base font-black uppercase tracking-widest transition-colors shadow-[0_4px_0_0_rgba(0,0,0,0.1)] active:translate-y-[2px] active:shadow-none',
                                                                    action.button
                                                                )}
                                                            >
                                                                {t(action.labelKey)}
                                                            </button>
                                                        )}

                                                        {normalizedStatus === 'served' && (
                                                            <div className="mt-4 flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[#7A5C33]/60">
                                                                <Check className="h-3 w-3" />
                                                                {t('kdsDashboard.completedAt', { time: formatClockTime(new Date(ticket.createdAt), false) })}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )
                                        })
                                    )}
                                </div>
                            </section>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
