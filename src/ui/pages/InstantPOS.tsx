import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { addToOfflineMutations, useCategories, useProducts } from '@/local-db'
import { db } from '@/local-db/database'
import type { CurrencyCode } from '@/local-db/models'
import { useWorkspace } from '@/workspace'
import { formatCompactDateTime, formatCurrency, generateId, cn, stylizeText } from '@/lib/utils'
import { Button, Input, Switch, useToast, Textarea, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/ui/components'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Loader2, Menu, Minus, Plus, Receipt, Search, StickyNote, Trash2 } from 'lucide-react'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { platformService } from '@/services/platformService'
import { useKdsStream } from '@/hooks/useKdsStream'

const TICKETS_STORAGE_KEY = 'instant_pos_tickets'
const TICKET_COUNTER_KEY = 'instant_pos_ticket_counter'
const PENDING_TICKET_TTL_MINUTES = 15
const PENDING_TICKET_EXTENSION_MINUTES = 5
const PENDING_TICKET_TTL_MS = PENDING_TICKET_TTL_MINUTES * 60 * 1000
const PENDING_TICKET_EXTENSION_MS = PENDING_TICKET_EXTENSION_MINUTES * 60 * 1000

type InstantPosStatus = 'pending' | 'preparing' | 'ready' | 'served' | 'paid'

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
    kitchenRoutedAt?: string
    expiresAt?: string
}

const STATUS_FLOW: InstantPosStatus[] = ['pending', 'preparing', 'ready', 'served', 'paid']


function loadTickets(): InstantPosTicket[] {
    if (typeof window === 'undefined') return []
    try {
        const raw = localStorage.getItem(TICKETS_STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.map((ticket: InstantPosTicket) => {
            if (ticket.expiresAt) return ticket
            if (!ticket.createdAt) return ticket
            const createdAt = new Date(ticket.createdAt)
            if (Number.isNaN(createdAt.getTime())) return ticket
            return {
                ...ticket,
                expiresAt: new Date(createdAt.getTime() + PENDING_TICKET_TTL_MS).toISOString()
            }
        })
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

function nextTicketNumber(): string {
    if (typeof window === 'undefined') return 'T-001'
    const current = Number(localStorage.getItem(TICKET_COUNTER_KEY) || '0') + 1
    localStorage.setItem(TICKET_COUNTER_KEY, String(current))
    return `T-${String(current).padStart(3, '0')}`
}

function getTicketExpiryDate(ticket: InstantPosTicket) {
    if (ticket.expiresAt) {
        const parsed = new Date(ticket.expiresAt)
        if (!Number.isNaN(parsed.getTime())) return parsed
    }
    const createdAt = new Date(ticket.createdAt)
    if (Number.isNaN(createdAt.getTime())) {
        return new Date(Date.now() + PENDING_TICKET_TTL_MS)
    }
    return new Date(createdAt.getTime() + PENDING_TICKET_TTL_MS)
}

function formatCountdown(ms: number, expiredLabel: string) {
    if (ms <= 0) return expiredLabel
    const totalSeconds = Math.ceil(ms / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

interface MobileTicketPanelProps {
    activeTicket: InstantPosTicket
    activeTicketTotals: { total: number, hasMixedCurrency: boolean }
    settlementCurrency: string
    features: any
    t: any
    statusLabels: Record<InstantPosStatus, string>
    statusAction: { label: string, status: InstantPosStatus } | null
    activePendingTimeLeftMs: number | null
    isCheckoutLoading: boolean
    checkoutTicket: () => void
    setTicketStatus: (status: InstantPosStatus) => void
    extendPendingExpiry: (id: string) => void
    clearActiveTicket: () => void
    updateItemQuantity: (id: string, delta: number) => void
    removeItem: (id: string) => void
    setNoteItem: (item: { productId: string, name: string, note: string } | null) => void
    closeTicket: (id: string) => void
}

function MobileTicketPanel({
    activeTicket, activeTicketTotals, settlementCurrency, features, t,
    statusLabels, statusAction, activePendingTimeLeftMs, isCheckoutLoading,
    checkoutTicket, setTicketStatus, extendPendingExpiry, clearActiveTicket,
    updateItemQuantity, removeItem, setNoteItem, closeTicket
}: MobileTicketPanelProps) {
    const [isExpanded, setIsExpanded] = useState(false)
    const [isDragging, setIsDragging] = useState(false)
    const [startY, setStartY] = useState<number | null>(null)
    const [currentY, setCurrentY] = useState(0)
    const panelRef = useRef<HTMLDivElement>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const [canScrollUp, setCanScrollUp] = useState(false)
    const [canScrollDown, setCanScrollDown] = useState(false)

    const checkScroll = useCallback(() => {
        if (!scrollContainerRef.current) return
        const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
        setCanScrollUp(scrollTop > 10)
        setCanScrollDown(scrollTop + clientHeight < scrollHeight - 10)
    }, [])

    useEffect(() => {
        const container = scrollContainerRef.current
        if (!container) return
        const handleScroll = () => checkScroll()
        container.addEventListener('scroll', handleScroll)
        const observer = new ResizeObserver(() => checkScroll())
        observer.observe(container)
        checkScroll()
        return () => {
            container.removeEventListener('scroll', handleScroll)
            observer.disconnect()
        }
    }, [activeTicket.items.length, checkScroll])

    const handleTouchStart = (e: React.TouchEvent) => {
        setStartY(e.touches[0].clientY)
        setIsDragging(true)
    }

    const handleTouchMove = (e: React.TouchEvent) => {
        if (startY === null) return
        const touchY = e.touches[0].clientY
        let deltaY = touchY - startY
        if (isExpanded) {
            if (deltaY < 0) deltaY = deltaY * 0.2
            setCurrentY(deltaY)
        } else {
            if (deltaY > 0) deltaY = deltaY * 0.2
            setCurrentY(deltaY)
        }
    }

    const handleTouchEnd = () => {
        if (Math.abs(currentY) > 60) {
            if (isExpanded && currentY > 0) setIsExpanded(false)
            else if (!isExpanded && currentY < 0) setIsExpanded(true)
        }
        setIsDragging(false)
        setStartY(null)
        setCurrentY(0)
    }

    const collapsedHeight = 120
    const progress = isDragging
        ? Math.min(1, Math.max(0, isExpanded ? 1 - (currentY / 100) : (-currentY / 100)))
        : isExpanded ? 1 : 0

    return (
        <>
            <div
                ref={panelRef}
                className={cn(
                    "fixed bottom-0 left-0 right-0 bg-card border-t border-border shadow-[0_-10px_40px_rgba(0,0,0,0.1)] z-40 transition-all duration-500 ease-in-out px-6 pt-2 overscroll-none touch-none flex flex-col xl:hidden",
                    "h-[85vh]",
                    isExpanded ? "rounded-t-[2.5rem]" : "rounded-t-[2rem]",
                    isDragging && "duration-0 transition-none will-change-transform"
                )}
                style={{
                    transform: isDragging
                        ? `translateY(calc(${isExpanded ? '0px' : `85vh - ${collapsedHeight}px`} + ${currentY}px))`
                        : isExpanded ? 'none' : `translateY(calc(85vh - ${collapsedHeight}px))`
                }}
            >
                {/* Drag Handle */}
                <div
                    className="flex flex-col items-center gap-1.5 cursor-grab active:cursor-grabbing py-4 -mt-3 group touch-none"
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                    <div className="w-12 h-1.5 bg-muted-foreground/20 rounded-full group-hover:bg-primary/30 transition-colors" />
                </div>

                {/* Collapsed Header */}
                <div className="flex items-center justify-between py-2 touch-none">
                    <div className="flex flex-col cursor-pointer" onClick={() => setIsExpanded(true)}>
                        <div className="flex items-baseline gap-1.5">
                            <span className="text-2xl font-black text-primary">
                                {formatCurrency(activeTicketTotals.total, settlementCurrency, features.iqd_display_preference)}
                            </span>
                            <span className="text-[10px] font-bold text-muted-foreground uppercase">{settlementCurrency}</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider -mt-1">
                            {activeTicket.number} • {activeTicket.items.length} {activeTicket.items.length === 1 ? t('common.item') : t('common.items')} • {statusLabels[activeTicket.status]}
                        </span>
                    </div>

                    <div
                        className="transition-opacity duration-300"
                        style={{
                            opacity: Math.max(0, 1 - progress * 2),
                            pointerEvents: progress > 0.3 ? 'none' : 'auto'
                        }}
                    >
                        <Button
                            className="h-12 px-6 rounded-2xl font-black shadow-lg shadow-primary/20 active:scale-95 transition-all text-primary-foreground"
                            onClick={(e) => {
                                e.stopPropagation();
                                checkoutTicket();
                            }}
                            disabled={activeTicket.items.length === 0 || isCheckoutLoading || activeTicketTotals.hasMixedCurrency}
                        >
                            {isCheckoutLoading ? <Loader2 className="animate-spin w-5 h-5" /> : (
                                <div className="flex items-center gap-2">
                                    <span>{t('pos.checkout')}</span>
                                    <ChevronRight className="w-4 h-4" />
                                </div>
                            )}
                        </Button>
                    </div>
                </div>

                {/* Expanded Content */}
                <div
                    className={cn(
                        "flex-1 flex flex-col min-h-0 touch-auto mt-4 transition-all duration-300 relative",
                        !isDragging && !isExpanded && "pointer-events-none"
                    )}
                    style={{
                        opacity: progress,
                        transform: `translateY(${(1 - progress) * 20}px)`
                    }}
                >
                    {isExpanded && canScrollUp && (
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-background/80 backdrop-blur-sm p-1.5 rounded-full border border-border shadow-sm animate-bounce pointer-events-none">
                            <ChevronUp className="w-4 h-4 text-primary" />
                        </div>
                    )}
                    {isExpanded && canScrollDown && (
                        <div className="absolute bottom-40 left-1/2 -translate-x-1/2 z-10 bg-background/80 backdrop-blur-sm p-1.5 rounded-full border border-border shadow-sm animate-bounce pointer-events-none">
                            <ChevronDown className="w-4 h-4 text-primary" />
                        </div>
                    )}

                    <div
                        ref={scrollContainerRef}
                        className="flex-1 overflow-y-auto overscroll-contain custom-scrollbar"
                    >
                        <div className="space-y-6 pb-20">
                            {/* Pending Timeout */}
                            {activePendingTimeLeftMs !== null && (
                                <div className="mt-3 flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                                    <div className="flex flex-col">
                                        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                                            {t('instantPos.pendingTimeout') || 'Pending Timeout'}
                                        </span>
                                        <span className={cn(
                                            "text-sm font-semibold",
                                            activePendingTimeLeftMs <= 0 ? "text-destructive" : "text-foreground"
                                        )}>
                                            {formatCountdown(activePendingTimeLeftMs, t('instantPos.expired') || 'Expired')}
                                        </span>
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => extendPendingExpiry(activeTicket.id)}
                                        className="h-8 rounded-full px-3"
                                    >
                                        {t('instantPos.extendTimeout', { minutes: PENDING_TICKET_EXTENSION_MINUTES }) || `+${PENDING_TICKET_EXTENSION_MINUTES} min`}
                                    </Button>
                                </div>
                            )}

                            {/* Status Actions */}
                            <div className="grid grid-cols-5 gap-2">
                                {STATUS_FLOW.map(status => (
                                    <button
                                        key={status}
                                        onClick={() => setTicketStatus(status)}
                                        className={cn(
                                            'flex items-center justify-center text-center rounded-xl px-2 py-3 text-[10px] font-semibold uppercase transition',
                                            activeTicket.status === status
                                                ? 'bg-primary/90 text-primary-foreground shadow-sm'
                                                : 'bg-muted/30 text-muted-foreground hover:bg-muted/50 border border-border/40'
                                        )}
                                    >
                                        {statusLabels[status]}
                                    </button>
                                ))}
                            </div>

                            {/* Items List */}
                            <div className="space-y-3">
                                {activeTicket.items.length === 0 ? (
                                    <div className="rounded-2xl border border-dashed border-border/60 bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
                                        {t('instantPos.emptyTicket') || 'Add items to start this ticket.'}
                                    </div>
                                ) : (
                                    activeTicket.items.map(item => (
                                        <div key={item.productId} className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="flex items-start gap-3">
                                                    <div className="rounded-lg bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                                                        {item.quantity}x
                                                    </div>
                                                    <div>
                                                        <div className="text-sm font-semibold text-foreground">{item.name}</div>
                                                        {item.note && (
                                                            <div className="text-[10px] italic text-primary/80 font-medium">
                                                                --{stylizeText(item.note)}
                                                            </div>
                                                        )}
                                                        <div className="text-xs text-muted-foreground">{item.sku || '---'}</div>
                                                    </div>
                                                </div>
                                                <div className="text-sm font-semibold text-foreground">
                                                    {formatCurrency(item.unitPrice * item.quantity, item.currency, features.iqd_display_preference)}
                                                </div>
                                            </div>
                                            <div className="mt-4 flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <button onClick={() => updateItemQuantity(item.productId, -1)} className="p-2 bg-background rounded-full border border-border/60"><Minus className="w-3 h-3" /></button>
                                                    <button onClick={() => updateItemQuantity(item.productId, 1)} className="p-2 bg-background rounded-full border border-border/60"><Plus className="w-3 h-3" /></button>
                                                    <button
                                                        onClick={() => setNoteItem({ productId: item.productId, name: item.name, note: item.note || '' })}
                                                        className={cn("h-8 px-3 rounded-full border border-border/60 text-[10px] font-bold uppercase flex items-center gap-1.5", item.note ? "bg-primary/10 text-primary border-primary/40" : "bg-background")}
                                                    >
                                                        <StickyNote className="w-3.5 h-3.5" /> {t('common.note')}
                                                    </button>
                                                </div>
                                                <button onClick={() => removeItem(item.productId)} className="text-destructive p-2"><Trash2 className="w-4 h-4" /></button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>

                            {/* Summary */}
                            <div className="space-y-4 pt-4 border-t border-border/40">
                                <div className="flex justify-between items-center text-sm font-medium">
                                    <span className="text-muted-foreground">{t('instantPos.subtotal')}</span>
                                    <span>{formatCurrency(activeTicketTotals.total, settlementCurrency, features.iqd_display_preference)}</span>
                                </div>
                                <div className="flex justify-between items-center">
                                    <span className="font-bold text-lg">{t('common.total')}</span>
                                    <span className="text-2xl font-black text-primary">{formatCurrency(activeTicketTotals.total, settlementCurrency, features.iqd_display_preference)}</span>
                                </div>
                                {activeTicketTotals.hasMixedCurrency && (
                                    <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-2 py-1 text-xs text-destructive">
                                        <AlertCircle className="h-3.5 w-3.5" />
                                        {t('instantPos.currencyWarning')}
                                    </div>
                                )}

                                <div className="grid grid-cols-2 gap-3 pt-2">
                                    {statusAction && (
                                        <Button
                                            onClick={() => setTicketStatus(statusAction.status)}
                                            variant="secondary"
                                            className="h-14 rounded-2xl font-bold"
                                        >
                                            {statusAction.label}
                                        </Button>
                                    )}
                                    <Button className={cn("h-14 rounded-2xl font-black text-lg gap-2", !statusAction && "col-span-2")} onClick={checkoutTicket} disabled={activeTicket.items.length === 0 || isCheckoutLoading || activeTicketTotals.hasMixedCurrency}>
                                        {isCheckoutLoading ? <Loader2 className="animate-spin" /> : <><CheckCircle2 className="w-5 h-5" /> {t('instantPos.checkout')}</>}
                                    </Button>
                                    <Button variant="outline" className="h-14 rounded-2xl font-bold col-span-2" onClick={() => closeTicket(activeTicket.id)} disabled={isCheckoutLoading}>
                                        {t('instantPos.closeTicket')}
                                    </Button>
                                    <Button variant="ghost" className="h-10 rounded-xl text-destructive font-bold col-span-2" onClick={clearActiveTicket} disabled={isCheckoutLoading}>
                                        {t('instantPos.clearAll')}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Backdrop */}
            {isExpanded && (
                <div
                    className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-30 animate-in fade-in duration-300 xl:hidden"
                    onClick={() => setIsExpanded(false)}
                />
            )}
        </>
    )
}

export function InstantPOS() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features, updateSettings, isLocalMode } = useWorkspace()
    const products = useProducts(user?.workspaceId)
    const categories = useCategories(user?.workspaceId)

    // KDS Streaming
    const { status: kdsStatus, startStream, broadcast } = useKdsStream(true)

    useEffect(() => {
        if (features.kds_enabled && kdsStatus === 'idle') {
            startStream(4004).catch(console.error)
        }
    }, [features.kds_enabled, kdsStatus, startStream])

    const [tickets, setTickets] = useState<InstantPosTicket[]>(() => loadTickets())
    const [activeTicketId, setActiveTicketId] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [selectedCategory, setSelectedCategory] = useState<string>('all')
    const [isKdsSaving, setIsKdsSaving] = useState(false)
    const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
    const [now, setNow] = useState(() => Date.now())
    const [noteItem, setNoteItem] = useState<{ productId: string, name: string, note: string } | null>(null)

    const settlementCurrency = features.default_currency || 'usd'

    useEffect(() => {
        saveTickets(tickets)
        // Broadcast to KDS remote clients whenever tickets change
        if (features.kds_enabled && kdsStatus === 'host') {
            broadcast('TICKET_UPDATED', tickets)
        }
    }, [tickets, kdsStatus, features.kds_enabled])

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [])

    // Automatic expiry deletion: remove pending tickets that have passed their expiresAt time
    useEffect(() => {
        const expiredIds = tickets
            .filter(ticket => ticket.status === 'pending' && getTicketExpiryDate(ticket).getTime() < now)
            .map(t => t.id)

        if (expiredIds.length > 0) {
            setTickets(prev => prev.filter(t => !expiredIds.includes(t.id)))
        }
    }, [now, tickets])

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key === TICKETS_STORAGE_KEY) {
                setTickets(loadTickets())
            }
        }

        // Internal event for same-window updates (e.g. from KDS Dashboard to POS)
        const handleInternalSync = () => {
            setTickets(loadTickets())
        }

        // Event for updates from remote tablets
        const handleRemoteSync = (event: any) => {
            const updatedTickets = event.detail
            if (updatedTickets && Array.isArray(updatedTickets)) {
                setTickets(updatedTickets)
            }
        }

        window.addEventListener('storage', handleStorage)
        window.addEventListener('instant-pos-tickets-updated', handleInternalSync)
        window.addEventListener('kds-remote-sync', handleRemoteSync)

        return () => {
            window.removeEventListener('storage', handleStorage)
            window.removeEventListener('instant-pos-tickets-updated', handleInternalSync)
            window.removeEventListener('kds-remote-sync', handleRemoteSync)
        }
    }, [])

    useEffect(() => {
        if (!tickets.length) {
            setActiveTicketId(null)
            return
        }
        if (!activeTicketId || !tickets.some(ticket => ticket.id === activeTicketId)) {
            setActiveTicketId(tickets[0].id)
        }
    }, [tickets, activeTicketId])

    const activeTicket = useMemo(
        () => tickets.find(ticket => ticket.id === activeTicketId) || null,
        [tickets, activeTicketId]
    )

    const filteredProducts = useMemo(() => {
        const term = search.trim().toLowerCase()
        const normalizedSettlement = settlementCurrency?.toLowerCase()
        return products.filter(product => {
            const matchesSearch = !term
                || (product.name || '').toLowerCase().includes(term)
                || (product.sku || '').toLowerCase().includes(term)
            if (!matchesSearch) return false
            if (normalizedSettlement) {
                const productCurrency = (product.currency || '').toLowerCase()
                if (productCurrency && productCurrency !== normalizedSettlement) return false
            }
            if (selectedCategory === 'all') return true
            if (selectedCategory === 'none') return !product.categoryId
            return product.categoryId === selectedCategory
        })
    }, [products, search, selectedCategory, settlementCurrency])

    const activeTicketTotals = useMemo(() => {
        if (!activeTicket) {
            return { count: 0, total: 0, hasMixedCurrency: false }
        }
        const hasMixedCurrency = activeTicket.items.some(item => item.currency !== settlementCurrency)
        const total = activeTicket.items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0)
        const count = activeTicket.items.reduce((sum, item) => sum + item.quantity, 0)
        return { count, total, hasMixedCurrency }
    }, [activeTicket, settlementCurrency])

    const statusLabels = useMemo(() => ({
        pending: t('instantPos.status.pending') || 'Pending',
        preparing: t('instantPos.status.preparing') || 'Preparing',
        ready: t('instantPos.status.ready') || 'Ready',
        served: t('instantPos.status.served') || 'Served',
        paid: t('instantPos.status.paid') || 'Paid / Closed'
    }), [t])

    const createTicket = () => {
        const createdAt = new Date()
        const ticket: InstantPosTicket = {
            id: generateId(),
            number: nextTicketNumber(),
            createdAt: createdAt.toISOString(),
            status: 'pending',
            items: [],
            expiresAt: new Date(createdAt.getTime() + PENDING_TICKET_TTL_MS).toISOString()
        }
        setTickets(prev => [ticket, ...prev])
        setActiveTicketId(ticket.id)
    }

    const updateTicket = (ticketId: string, updater: (ticket: InstantPosTicket) => InstantPosTicket) => {
        setTickets(prev => prev.map(ticket => (ticket.id === ticketId ? updater(ticket) : ticket)))
    }

    const addItemToTicket = (productId: string) => {
        const product = products.find(item => item.id === productId)
        if (!product) return

        if (!activeTicket) {
            const createdAt = new Date()
            const newTicket: InstantPosTicket = {
                id: generateId(),
                number: nextTicketNumber(),
                createdAt: createdAt.toISOString(),
                status: 'pending',
                items: [{
                    productId: product.id,
                    name: product.name,
                    sku: product.sku,
                    unitPrice: product.price,
                    quantity: 1,
                    currency: product.currency
                }],
                expiresAt: new Date(createdAt.getTime() + PENDING_TICKET_TTL_MS).toISOString()
            }
            setTickets(prev => [newTicket, ...prev])
            setActiveTicketId(newTicket.id)
            return
        }

        updateTicket(activeTicket.id, ticket => {
            const existing = ticket.items.find(item => item.productId === product.id)
            if (existing) {
                const items = ticket.items.map(item =>
                    item.productId === product.id
                        ? { ...item, quantity: item.quantity + 1 }
                        : item
                )
                return { ...ticket, items }
            }

            const newItem: InstantPosItem = {
                productId: product.id,
                name: product.name,
                sku: product.sku,
                unitPrice: product.price,
                quantity: 1,
                currency: product.currency
            }

            return { ...ticket, items: [...ticket.items, newItem] }
        })
    }

    const updateItemQuantity = (productId: string, delta: number) => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => {
            const items = ticket.items
                .map(item => item.productId === productId
                    ? { ...item, quantity: Math.max(1, item.quantity + delta) }
                    : item
                )
            return { ...ticket, items }
        })
    }

    const removeItem = (productId: string) => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => ({
            ...ticket,
            items: ticket.items.filter(item => item.productId !== productId)
        }))
    }

    const updateItemNote = (productId: string, note: string) => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => ({
            ...ticket,
            items: ticket.items.map(item =>
                item.productId === productId ? { ...item, note } : item
            )
        }))
        setNoteItem(null)
    }

    const setTicketStatus = (status: InstantPosStatus) => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => ({
            ...ticket,
            status,
            expiresAt: status === 'pending'
                ? (ticket.expiresAt || new Date(Date.now() + PENDING_TICKET_TTL_MS).toISOString())
                : ticket.expiresAt,
            kitchenRoutedAt: status === 'preparing' && features.kds_enabled
                ? (ticket.kitchenRoutedAt || new Date().toISOString())
                : ticket.kitchenRoutedAt
        }))

        if (status === 'preparing' && features.kds_enabled) {
            toast({
                title: t('common.success') || 'Sent to Kitchen',
                description: t('instantPos.kdsToast') || 'Ticket routed to KDS for preparation.'
            })
        }
    }

    const handleKdsToggle = async (nextValue: boolean) => {
        if (isKdsSaving) return
        setIsKdsSaving(true)
        try {
            await updateSettings({ kds_enabled: nextValue })
            toast({
                title: t('common.success') || 'Success',
                description: nextValue
                    ? (t('instantPos.kdsEnabled') || 'Kitchen routing enabled for Instant POS.')
                    : (t('instantPos.kdsDisabled') || 'Kitchen routing disabled. Cashier handles preparation.')
            })
        } catch (error) {
            const normalized = normalizeSupabaseActionError(error)
            toast({
                title: t('common.error') || 'Error',
                description: normalized.message || (t('instantPos.kdsToggleError') || 'Failed to update kitchen routing.'),
                variant: 'destructive'
            })
        } finally {
            setIsKdsSaving(false)
        }
    }

    const closeTicket = (ticketId: string) => {
        setTickets(prev => prev.filter(ticket => ticket.id !== ticketId))
        if (activeTicketId === ticketId) {
            setActiveTicketId(null)
        }
    }

    const checkoutTicket = async () => {
        if (!activeTicket || !user?.workspaceId || !user?.id) return
        if (activeTicket.items.length === 0) return

        if (activeTicketTotals.hasMixedCurrency) {
            toast({
                title: t('common.error') || 'Error',
                description: t('instantPos.currencyMismatch') || 'Instant POS supports one settlement currency per ticket.'
            })
            return
        }

        setIsCheckoutLoading(true)
        const saleId = generateId()
        const snapshotTimestamp = new Date().toISOString()

        const itemsWithMetadata = activeTicket.items.map(item => {
            const product = products.find(p => p.id === item.productId)
            const costPrice = product?.costPrice || 0
            const inventorySnapshot = product?.quantity ?? 0
            return {
                product_id: item.productId,
                product_name: item.name,
                product_sku: item.sku,
                quantity: item.quantity,
                unit_price: item.unitPrice,
                total_price: item.unitPrice * item.quantity,
                cost_price: costPrice,
                converted_cost_price: costPrice,
                original_currency: item.currency,
                original_unit_price: item.unitPrice,
                converted_unit_price: item.unitPrice,
                settlement_currency: settlementCurrency,
                negotiated_price: null,
                total: item.unitPrice * item.quantity,
                inventory_snapshot: inventorySnapshot
            }
        })

        const totalAmount = itemsWithMetadata.reduce((sum, item) => sum + item.total_price, 0)

        const consolidatedNotes = activeTicket.items
            .filter(item => item.note)
            .map(item => `${item.name} --${stylizeText(item.note || '')}`)
            .join('\n')

        const checkoutPayload = {
            id: saleId,
            items: itemsWithMetadata,
            total_amount: totalAmount,
            settlement_currency: settlementCurrency,
            exchange_source: 'instant_pos',
            exchange_rate: 0,
            exchange_rate_timestamp: snapshotTimestamp,
            exchange_rates: [],
            origin: 'instant_pos',
            payment_method: 'cash',
            system_verified: true,
            system_review_status: 'approved',
            system_review_reason: null,
            notes: consolidatedNotes || null
        }

        try {
            if (isLocalMode) {
                throw new Error('local_workspace_sale')
            }

            const { data, error } = await runSupabaseAction('instantPos.completeSale', () =>
                supabase.rpc('complete_sale', { payload: checkoutPayload })
            )

            if (error) throw normalizeSupabaseActionError(error)

            const serverResult = data as any
            const sequenceId = serverResult?.sequence_id
            const formattedInvoiceId = sequenceId ? `#${String(sequenceId).padStart(5, '0')}` : `#${saleId.slice(0, 8)}`

            await Promise.all(activeTicket.items.map(async (item) => {
                const product = products.find(p => p.id === item.productId)
                if (product) {
                    await db.products.update(item.productId, {
                        quantity: Math.max(0, product.quantity - item.quantity)
                    })
                }
            }))

            await db.invoices.add({
                id: saleId,
                invoiceid: formattedInvoiceId,
                sequenceId: sequenceId,
                workspaceId: user.workspaceId,
                customerId: '',
                status: 'paid',
                totalAmount: totalAmount,
                settlementCurrency: settlementCurrency,
                origin: 'instant_pos',
                cashierName: user?.name || 'System',
                createdByName: user?.name || 'System',
                createdAt: snapshotTimestamp,
                updatedAt: snapshotTimestamp,
                syncStatus: 'synced',
                lastSyncedAt: new Date().toISOString(),
                version: 1,
                isDeleted: false
            })

            closeTicket(activeTicket.id)

            toast({
                title: t('instantPos.checkoutComplete') || 'Order closed',
                description: t('instantPos.checkoutCompleteDesc') || 'Sale recorded in Sales History.'
            })
        } catch (err) {
            const normalized = normalizeSupabaseActionError(err)
            console.error('[Instant POS] Checkout failed, saving offline:', normalized)

            if (!navigator.onLine || isLocalMode) {
                try {
                    await db.sales.add({
                        id: saleId,
                        workspaceId: user.workspaceId,
                        cashierId: user.id,
                        totalAmount: totalAmount,
                        settlementCurrency: settlementCurrency,
                        exchangeSource: 'instant_pos',
                        exchangeRate: 0,
                        exchangeRateTimestamp: snapshotTimestamp,
                        exchangeRates: [],
                        origin: 'instant_pos',
                        payment_method: 'cash',
                        createdAt: snapshotTimestamp,
                        updatedAt: snapshotTimestamp,
                        syncStatus: 'pending',
                        lastSyncedAt: null,
                        version: 1,
                        isDeleted: false,
                        systemVerified: true,
                        systemReviewStatus: 'approved',
                        systemReviewReason: null
                    })

                    await Promise.all(itemsWithMetadata.map(item =>
                        db.sale_items.add({
                            id: generateId(),
                            saleId: saleId,
                            productId: item.product_id,
                            quantity: item.quantity,
                            unitPrice: item.unit_price,
                            totalPrice: item.total_price,
                            costPrice: item.cost_price,
                            convertedCostPrice: item.converted_cost_price,
                            originalCurrency: item.original_currency as CurrencyCode,
                            originalUnitPrice: item.original_unit_price,
                            convertedUnitPrice: item.converted_unit_price,
                            settlementCurrency: item.settlement_currency as CurrencyCode,
                            negotiatedPrice: undefined,
                            inventorySnapshot: item.inventory_snapshot
                        })
                    ))

                    await Promise.all(activeTicket.items.map(async (item) => {
                        const product = products.find(p => p.id === item.productId)
                        if (product) {
                            await db.products.update(item.productId, {
                                quantity: Math.max(0, product.quantity - item.quantity)
                            })
                        }
                    }))

                    await db.invoices.add({
                        id: saleId,
                        invoiceid: `#${saleId.slice(0, 8)}`,
                        workspaceId: user.workspaceId,
                        customerId: '',
                        status: 'paid',
                        totalAmount: totalAmount,
                        settlementCurrency: settlementCurrency,
                        origin: 'instant_pos',
                        cashierName: user?.name || 'System',
                        createdByName: user?.name || 'System',
                        createdAt: snapshotTimestamp,
                        updatedAt: snapshotTimestamp,
                        syncStatus: 'pending',
                        lastSyncedAt: null,
                        version: 1,
                        isDeleted: false
                    })

                    await addToOfflineMutations('sales', saleId, 'create', checkoutPayload, user.workspaceId)

                    closeTicket(activeTicket.id)

                    toast({
                        title: isLocalMode
                            ? (t('instantPos.savedLocally') || 'Saved locally')
                            : (t('instantPos.offlineSaved') || 'Saved offline'),
                        description: isLocalMode
                            ? (t('instantPos.savedLocallyDesc') || 'Ticket closed and stored only on this device for this workspace.')
                            : (t('instantPos.offlineSavedDesc') || 'Ticket closed and will sync when online.')
                    })
                } catch (offlineErr) {
                    const offlineNormalized = normalizeSupabaseActionError(offlineErr)
                    toast({
                        title: t('common.error') || 'Error',
                        description: offlineNormalized.message || (t('instantPos.offlineSaveError') || 'Failed to save offline.'),
                        variant: 'destructive'
                    })
                }
            } else {
                toast({
                    title: t('common.error') || 'Error',
                    description: normalized.message || (t('instantPos.checkoutError') || 'Checkout failed.'),
                    variant: 'destructive'
                })
            }
        } finally {
            setIsCheckoutLoading(false)
        }
    }

    const clearActiveTicket = () => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => ({ ...ticket, items: [] }))
    }

    const extendPendingExpiry = (ticketId: string) => {
        updateTicket(ticketId, ticket => {
            const expiry = getTicketExpiryDate(ticket)
            const nextExpiry = new Date(expiry.getTime() + PENDING_TICKET_EXTENSION_MS)
            return {
                ...ticket,
                expiresAt: nextExpiry.toISOString()
            }
        })
    }

    const activePendingTimeLeftMs = useMemo(() => {
        if (!activeTicket || activeTicket.status !== 'pending') return null
        const expiry = getTicketExpiryDate(activeTicket)
        return expiry.getTime() - now
    }, [activeTicket, now])

    const statusAction = activeTicket ? (() => {
        switch (activeTicket.status) {
            case 'pending':
                return { label: t('instantPos.actions.startPreparation') || 'Start Preparation', status: 'preparing' as InstantPosStatus }
            case 'preparing':
                return { label: t('instantPos.actions.markReady') || 'Mark Ready', status: 'ready' as InstantPosStatus }
            case 'ready':
                return { label: t('instantPos.actions.serveOrder') || 'Serve Order', status: 'served' as InstantPosStatus }
            default:
                return null
        }
    })() : null

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return ''
        if (url.startsWith('http') || url.startsWith('data:')) return url
        return platformService.convertFileSrc(url)
    }

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
            <header className="flex flex-col gap-4 border-b border-border/60 bg-card/70 px-6 py-5 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                    <button
                        className="lg:hidden p-2 -ms-2 rounded-lg hover:bg-secondary transition-colors"
                        onClick={() => window.dispatchEvent(new CustomEvent('open-mobile-sidebar'))}
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <div>
                        <h1 className="text-2xl font-black gradient-text">
                            {t('instantPos.title') || 'Instant POS'}
                        </h1>
                        <p className="text-xs text-muted-foreground">
                            {t('instantPos.serverTicket', {
                                server: user?.name || (t('instantPos.staffFallback') || 'Staff'),
                                ticket: activeTicket?.number || '--'
                            }) || `Server: ${user?.name || 'Staff'} | Ticket ${activeTicket?.number || '--'}`}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                        {t('instantPos.kdsLabel') || 'KDS'}
                        <Switch
                            checked={features.kds_enabled}
                            onCheckedChange={handleKdsToggle}
                            disabled={isKdsSaving}
                            className="scale-75"
                        />
                    </div>
                    <Button
                        onClick={createTicket}
                        variant="secondary"
                        className="gap-2 rounded-full"
                    >
                        <Receipt className="w-4 h-4" />
                        {t('instantPos.newTicket') || 'New Ticket'}
                    </Button>
                </div>
            </header>

            <div className="flex flex-1 min-h-0 flex-col xl:flex-row">
                <section className="flex min-h-0 flex-1 flex-col gap-4 p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex max-w-full items-center gap-2 overflow-x-auto pb-1 custom-scrollbar">
                            {tickets.length === 0 ? (
                                <div className="text-xs text-muted-foreground">
                                    {t('instantPos.noTickets') || 'No open tickets yet.'}
                                </div>
                            ) : (
                                tickets.map(ticket => {
                                    const isActive = ticket.id === activeTicketId
                                    return (
                                        <button
                                            key={ticket.id}
                                            onClick={() => setActiveTicketId(ticket.id)}
                                            className={cn(
                                                'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all',
                                                isActive
                                                    ? 'border-primary/60 bg-primary text-primary-foreground shadow-sm'
                                                    : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/60'
                                            )}
                                        >
                                            <span>{ticket.number}</span>
                                            <span className="text-[10px] uppercase tracking-widest opacity-70">
                                                {statusLabels[ticket.status]}
                                            </span>
                                        </button>
                                    )
                                })
                            )}
                        </div>

                        <div className="relative w-full max-w-[280px]">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={t('instantPos.search') || 'Search menu items...'}
                                className="h-11 w-full rounded-full pl-10 text-sm"
                            />
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            onClick={() => setSelectedCategory('all')}
                            className={cn(
                                'rounded-full px-4 py-2 text-xs font-semibold transition',
                                selectedCategory === 'all'
                                    ? 'bg-primary text-primary-foreground shadow-sm'
                                    : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                            )}
                        >
                            {t('instantPos.allCategories') || 'All Items'}
                        </button>
                        {categories.map(category => (
                            <button
                                key={category.id}
                                onClick={() => setSelectedCategory(category.id)}
                                className={cn(
                                    'rounded-full px-4 py-2 text-xs font-semibold transition',
                                    selectedCategory === category.id
                                        ? 'bg-primary text-primary-foreground shadow-sm'
                                        : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                                )}
                            >
                                {category.name}
                            </button>
                        ))}
                        <button
                            onClick={() => setSelectedCategory('none')}
                            className={cn(
                                'rounded-full px-4 py-2 text-xs font-semibold transition',
                                selectedCategory === 'none'
                                    ? 'bg-primary text-primary-foreground shadow-sm'
                                    : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                            )}
                        >
                            {t('instantPos.uncategorized') || 'Uncategorized'}
                        </button>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-2">
                        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                            {filteredProducts.length === 0 ? (
                                <div className="col-span-full text-sm text-muted-foreground">
                                    {t('instantPos.noProducts') || 'No products match your search.'}
                                </div>
                            ) : (
                                filteredProducts.map(product => {
                                    const imageUrl = getDisplayImageUrl(product.imageUrl)
                                    return (
                                        <button
                                            key={product.id}
                                            onClick={() => addItemToTicket(product.id)}
                                            className="group flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/80 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-md"
                                        >
                                            <div className="relative h-32 w-full overflow-hidden">
                                                {imageUrl ? (
                                                    <img
                                                        src={imageUrl}
                                                        alt={product.name}
                                                        className="h-full w-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="h-full w-full bg-muted/60" />
                                                )}
                                            </div>
                                            <div className="flex flex-1 flex-col gap-1 p-3">
                                                <div className="text-sm font-semibold text-foreground line-clamp-1">{product.name}</div>
                                                <div className="text-xs font-semibold text-primary">
                                                    {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                </div>
                                            </div>
                                        </button>
                                    )
                                })
                            )}
                        </div>
                    </div>

                    {activeTicket && (
                        <MobileTicketPanel
                            activeTicket={activeTicket}
                            activeTicketTotals={activeTicketTotals}
                            settlementCurrency={settlementCurrency}
                            features={features}
                            t={t}
                            statusLabels={statusLabels}
                            statusAction={statusAction}
                            activePendingTimeLeftMs={activePendingTimeLeftMs}
                            isCheckoutLoading={isCheckoutLoading}
                            checkoutTicket={checkoutTicket}
                            setTicketStatus={setTicketStatus}
                            extendPendingExpiry={extendPendingExpiry}
                            clearActiveTicket={clearActiveTicket}
                            updateItemQuantity={updateItemQuantity}
                            removeItem={removeItem}
                            setNoteItem={setNoteItem}
                            closeTicket={closeTicket}
                        />
                    )}
                </section>

                <aside className="hidden w-full max-w-full flex-col border-t border-border/60 bg-card/70 px-6 py-5 backdrop-blur xl:flex xl:w-[360px] xl:border-l xl:border-t-0">
                    {!activeTicket ? (
                        <div className="text-sm text-muted-foreground">
                            {t('instantPos.selectTicket') || 'Select a ticket to begin.'}
                        </div>
                    ) : (
                        <div className="flex h-full flex-col">
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="text-lg font-semibold">
                                        {t('instantPos.ticketLabel', { number: activeTicket.number }) || `Ticket ${activeTicket.number}`}
                                    </div>
                                    <div className="text-xs text-muted-foreground">{formatCompactDateTime(activeTicket.createdAt)}</div>
                                </div>
                                <button
                                    onClick={clearActiveTicket}
                                    className="text-xs font-semibold text-destructive hover:text-destructive/80"
                                >
                                    {t('instantPos.clearAll') || 'Clear All'}
                                </button>
                            </div>

                            {activePendingTimeLeftMs !== null && (
                                <div className="mt-3 flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                                    <div className="flex flex-col">
                                        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                                            {t('instantPos.pendingTimeout') || 'Pending Timeout'}
                                        </span>
                                        <span className={cn(
                                            "text-sm font-semibold",
                                            activePendingTimeLeftMs <= 0 ? "text-destructive" : "text-foreground"
                                        )}>
                                            {formatCountdown(activePendingTimeLeftMs, t('instantPos.expired') || 'Expired')}
                                        </span>
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => extendPendingExpiry(activeTicket.id)}
                                        className="h-8 rounded-full px-3"
                                    >
                                        {t('instantPos.extendTimeout', { minutes: PENDING_TICKET_EXTENSION_MINUTES }) || `+${PENDING_TICKET_EXTENSION_MINUTES} min`}
                                    </Button>
                                </div>
                            )}

                            <div className="mt-4 space-y-2">
                                <div className="text-[10px] font-semibold uppercase tracking-[0.3em] text-muted-foreground text-center">
                                    {t('instantPos.orderStatus') || 'Order Status'}
                                </div>
                                <div className="grid grid-cols-5 gap-2">
                                    {STATUS_FLOW.map(status => (
                                        <button
                                            key={status}
                                            onClick={() => setTicketStatus(status)}
                                            className={cn(
                                                'flex items-center justify-center text-center rounded-xl px-2 py-1.5 text-[10px] font-semibold uppercase transition',
                                                activeTicket.status === status
                                                    ? 'bg-primary/90 text-primary-foreground shadow-sm'
                                                    : 'bg-muted/30 text-muted-foreground hover:bg-muted/50 border border-border/40'
                                            )}
                                        >
                                            {statusLabels[status]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="mt-4 flex-1 space-y-3 overflow-y-auto custom-scrollbar pr-1">
                                {activeTicket.items.length === 0 ? (
                                    <div className="rounded-2xl border border-dashed border-border/60 bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
                                        {t('instantPos.emptyTicket') || 'Add items to start this ticket.'}
                                    </div>
                                ) : (
                                    activeTicket.items.map(item => (
                                        <div key={item.productId} className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="flex items-start gap-3">
                                                    <div className="rounded-lg bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                                                        {item.quantity}x
                                                    </div>
                                                    <div>
                                                        <div className="text-sm font-semibold text-foreground">{item.name}</div>
                                                        {item.note && (
                                                            <div className="text-[10px] italic text-primary/80 font-medium">
                                                                --{stylizeText(item.note)}
                                                            </div>
                                                        )}
                                                        <div className="text-xs text-muted-foreground">{item.sku || '---'}</div>
                                                    </div>
                                                </div>
                                                <div className="text-sm font-semibold text-foreground">
                                                    {formatCurrency(item.unitPrice * item.quantity, item.currency, features.iqd_display_preference)}
                                                </div>
                                            </div>
                                            <div className="mt-3 flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => updateItemQuantity(item.productId, -1)}
                                                        className="flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-background text-foreground hover:bg-muted/60"
                                                    >
                                                        <Minus className="h-3 w-3" />
                                                    </button>
                                                    <button
                                                        onClick={() => updateItemQuantity(item.productId, 1)}
                                                        className="flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-background text-foreground hover:bg-muted/60"
                                                    >
                                                        <Plus className="h-3 w-3" />
                                                    </button>
                                                    <button
                                                        onClick={() => setNoteItem({ productId: item.productId, name: item.name, note: item.note || '' })}
                                                        className={cn(
                                                            "flex h-7 px-2 items-center justify-center rounded-full border border-border/60 text-[10px] font-bold uppercase transition",
                                                            item.note ? "bg-primary/10 border-primary/40 text-primary" : "bg-background text-muted-foreground hover:bg-muted/60"
                                                        )}
                                                    >
                                                        <StickyNote className="h-3 w-3 mr-1" />
                                                        {t('common.note') || 'Note'}
                                                    </button>
                                                </div>
                                                <button
                                                    onClick={() => removeItem(item.productId)}
                                                    className="text-xs text-destructive hover:text-destructive/80"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>

                            <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
                                <div className="flex items-center justify-between text-xs text-muted-foreground">
                                    <span>{t('instantPos.subtotal') || 'Subtotal'}</span>
                                    <span>
                                        {activeTicketTotals.hasMixedCurrency
                                            ? '--'
                                            : formatCurrency(activeTicketTotals.total, settlementCurrency, features.iqd_display_preference)}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between text-lg font-semibold">
                                    <span>{t('common.total') || 'Total'}</span>
                                    <span className="text-primary">
                                        {activeTicketTotals.hasMixedCurrency
                                            ? '--'
                                            : formatCurrency(activeTicketTotals.total, settlementCurrency, features.iqd_display_preference)}
                                    </span>
                                </div>
                                {activeTicketTotals.hasMixedCurrency && (
                                    <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-2 py-1 text-xs text-destructive">
                                        <AlertCircle className="h-3.5 w-3.5" />
                                        {t('instantPos.currencyWarning') || 'Ticket has mixed currencies. Checkout is disabled.'}
                                    </div>
                                )}
                            </div>

                            <div className="mt-4 flex flex-col gap-2">
                                {statusAction && (
                                    <Button
                                        onClick={() => setTicketStatus(statusAction.status)}
                                        variant="secondary"
                                        className="h-11 w-full rounded-xl"
                                    >
                                        {statusAction.label}
                                    </Button>
                                )}
                                <Button
                                    className="h-11 w-full rounded-xl"
                                    onClick={checkoutTicket}
                                    disabled={
                                        isCheckoutLoading
                                        || activeTicket.items.length === 0
                                        || activeTicketTotals.hasMixedCurrency
                                    }
                                >
                                    <CheckCircle2 className="w-4 h-4" />
                                    {isCheckoutLoading
                                        ? (t('instantPos.checkoutLoading') || 'Closing...')
                                        : (t('instantPos.checkout') || 'Checkout')}
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={() => closeTicket(activeTicket.id)}
                                    disabled={isCheckoutLoading}
                                    className="h-11 w-full rounded-xl"
                                >
                                    {t('instantPos.closeTicket') || 'Close Ticket'}
                                </Button>
                            </div>
                        </div>
                    )}
                </aside>
            </div>

            <Dialog open={!!noteItem} onOpenChange={(open) => !open && setNoteItem(null)}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>{t('instantPos.addNote') || 'Add Note'} - {noteItem?.name}</DialogTitle>
                    </DialogHeader>
                    <div className="py-4">
                        <Textarea
                            value={noteItem?.note || ''}
                            onChange={(e) => setNoteItem(prev => prev ? { ...prev, note: e.target.value } : null)}
                            placeholder={t('instantPos.notePlaceholder') || 'Add cooking instructions or preferences...'}
                            className="min-h-[100px]"
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setNoteItem(null)}>
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button onClick={() => noteItem && updateItemNote(noteItem.productId, noteItem.note)}>
                            {t('common.save') || 'Save Note'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
