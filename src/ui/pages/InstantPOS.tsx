import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useRoute } from 'wouter'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { addToOfflineMutations, adjustInventoryQuantity, calculateStockBatchUnitCost, commitStockBatchAllocations, generateLocalSaleSequenceId, getPrimaryStorageFromList, getStockBatchSalePlans, refreshStockBatchesFromSupabase, useActiveDiscountMap, useBatchAwareInventoryProducts, useCategories, useProductSelectionAccess, useProducts, useStorages } from '@/local-db'
import { isService, SERVICES_VIRTUAL_STORAGE_ID } from '@/lib/catalogItem'
import { db } from '@/local-db/database'
import type { CurrencyCode } from '@/local-db/models'
import { useWorkspace } from '@/workspace'
import { formatCompactDateTime, formatCurrency, generateId, cn, stylizeText } from '@/lib/utils'
import { readInstantPosProductsPerRow, saveInstantPosProductsPerRow } from '@/lib/instantPosLayout'
import { AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle, Button, Input, useToast, Textarea, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, StorageSelector } from '@/ui/components'
import { AlertCircle, CheckCircle2, ChefHat, ChevronDown, ChevronRight, ChevronUp, Loader2, Menu, Minus, Package, Plus, Receipt, Search, ShoppingCart, StickyNote, Table2, Trash2 } from 'lucide-react'
import { UiAccessGate } from '@/context/UiAccessContext'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { platformService } from '@/services/platformService'
import { useKdsStream } from '@/hooks/useKdsStream'
import { createVerificationSale, verifySale } from '@/lib/saleVerification'
import { convertCurrencyAmountWithAvailableSnapshot } from '@/lib/orderCurrency'
import { getMissingProductCostMessage, hasValidProductCost } from '@/lib/productCost'
import { mapSaleToUniversal } from '@/lib/mappings'
import { INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY } from '@/lib/customTemplates'
import { formatCookOrderTicketTimestamp } from '@/lib/cookOrderTicket'
import { printService } from '@/services/printService'
import { CheckoutSuccessModal } from '@/ui/components/pos/CheckoutSuccessModal'
import { InstantPosAdjust } from '@/ui/components/pos/InstantPosAdjust'
import { usePosReceiptPrinter } from '@/ui/components/pos/usePosReceiptPrinter'
import { RestaurantTableGrid } from '@/ui/components/pos/RestaurantTableGrid'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { calculateRestaurantTicketTotal } from '@/lib/restaurantTableView'
import {
    readRestaurantTableActionVisibility,
    saveRestaurantTableActionVisibility,
    shouldHideRestaurantTableAction,
    type RestaurantTableActionVisibility,
} from '@/lib/restaurantTableActionVisibility'
import { closeRestaurantPosTicket, createRestaurantPosTicket, hardDeleteRestaurantPosTicket, moveRestaurantPosTicket, refreshRestaurantPosTicketsFromSupabase, saveRestaurantPosTicket, useRestaurantPosTickets, useRestaurantTableSettings } from '@/local-db/restaurantTables'
import type { RestaurantPosTicket } from '@/local-db/models'

const TICKETS_STORAGE_KEY = 'instant_pos_tickets'
const TICKET_COUNTER_KEY = 'instant_pos_ticket_counter'
const PENDING_TICKET_TTL_MINUTES = 15
const PENDING_TICKET_EXTENSION_MINUTES = 5
const PENDING_TICKET_TTL_MS = PENDING_TICKET_TTL_MINUTES * 60 * 1000
const PENDING_TICKET_EXTENSION_MS = PENDING_TICKET_EXTENSION_MINUTES * 60 * 1000
const TABLE_NUMBER_PRESETS = Array.from({ length: 20 }, (_, index) => String(index + 1))

type InstantPosStatus = 'pending' | 'preparing' | 'ready' | 'served'

type InstantPosItem = {
    productId: string
    storageId?: string
    name: string
    sku: string
    baseUnitPrice: number
    unitPrice: number
    quantity: number
    currency: string
    discountType?: 'percentage' | 'fixed_amount'
    discountValue?: number
    discountSource?: 'product' | 'category'
    discountEndsAt?: string
    note?: string
}

type InstantPosTicket = {
    id: string
    number: string
    createdAt: string
    status: InstantPosStatus
    items: InstantPosItem[]
    note?: string
    tableNumber?: string
    kitchenRoutedAt?: string
    expiresAt?: string
}

function restaurantTicketToInstantTicket(ticket: RestaurantPosTicket): InstantPosTicket {
    return {
        id: ticket.id,
        number: ticket.number,
        createdAt: ticket.createdAt,
        status: ticket.status,
        items: ticket.items,
        note: ticket.note,
        tableNumber: String(ticket.tableNumber),
        kitchenRoutedAt: ticket.kitchenRoutedAt,
    }
}

function instantTicketToRestaurantTicket(
    ticket: InstantPosTicket,
    workspaceId: string,
    userId: string | undefined,
    existing?: RestaurantPosTicket,
): RestaurantPosTicket {
    const timestamp = new Date().toISOString()
    return {
        id: ticket.id,
        workspaceId,
        tableNumber: Number(ticket.tableNumber),
        number: ticket.number,
        status: ticket.status,
        items: ticket.items,
        note: ticket.note,
        kitchenRoutedAt: ticket.kitchenRoutedAt,
        createdBy: existing?.createdBy ?? userId ?? null,
        createdAt: existing?.createdAt ?? ticket.createdAt,
        updatedAt: timestamp,
        version: existing?.version ?? 1,
        isDeleted: false,
        syncStatus: existing?.syncStatus ?? 'pending',
        lastSyncedAt: existing?.lastSyncedAt ?? null,
    }
}

const STATUS_FLOW: InstantPosStatus[] = ['pending', 'preparing', 'ready', 'served']

function buildInstantPosItemKey(productId: string, storageId?: string | null) {
    return `${productId}:${storageId ?? ''}`
}

function formatDiscountBadge(
    discount: { discountType: 'percentage' | 'fixed_amount'; discountValue: number },
    currency: CurrencyCode,
    iqdPreference: 'IQD' | 'د.ع'
) {
    if (discount.discountType === 'percentage') {
        return `-${Number(discount.discountValue)}%`
    }

    return `-${formatCurrency(discount.discountValue, currency, iqdPreference)}`
}

function normalizeTableNumber(value: string) {
    const trimmed = value.trim()
    if (!/^\d{1,4}$/.test(trimmed)) return null

    const numeric = Number(trimmed)
    if (!Number.isInteger(numeric) || numeric < 1) return null

    return String(numeric)
}

function wrapCookTicketText(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
    const words = value.trim().split(/\s+/).filter(Boolean)
    const lines: string[] = []
    let line = ''

    const pushLongWord = (word: string) => {
        let segment = ''
        for (const character of Array.from(word)) {
            const candidate = `${segment}${character}`
            if (segment && context.measureText(candidate).width > maxWidth) {
                lines.push(segment)
                segment = character
            } else {
                segment = candidate
            }
        }
        if (segment) line = segment
    }

    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word
        if (context.measureText(candidate).width <= maxWidth) {
            line = candidate
            continue
        }

        if (line) lines.push(line)
        line = ''
        if (context.measureText(word).width <= maxWidth) {
            line = word
        } else {
            pushLongWord(word)
        }
    }

    if (line) lines.push(line)
    return lines.length > 0 ? lines : ['']
}

async function createCookOrderTicketPdf({
    items,
    widthMm,
    direction,
    locale,
    printedAt,
}: {
    items: InstantPosItem[]
    widthMm: number
    direction: 'ltr' | 'rtl'
    locale: string
    printedAt: Date
}): Promise<Blob> {
    const widthPx = widthMm <= 58 ? 384 : 576
    const pixelsPerMm = widthPx / widthMm
    const horizontalPaddingPx = Math.round(pixelsPerMm * 3)
    const verticalPaddingPx = Math.round(pixelsPerMm * 3)
    const titleFontPx = Math.round(pixelsPerMm * 4)
    const quantityFontPx = Math.round(pixelsPerMm * 3.4)
    const noteFontPx = Math.round(pixelsPerMm * 3.2)
    const timestampFontPx = Math.round(pixelsPerMm * 2.8)
    const maxTextWidthPx = widthPx - (horizontalPaddingPx * 2)
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create the cook order ticket.')

    await document.fonts?.ready

    context.font = `500 ${timestampFontPx}px Inter, Arial, sans-serif`
    const timestampLines = wrapCookTicketText(
        context,
        formatCookOrderTicketTimestamp(locale, printedAt),
        maxTextWidthPx,
    )

    const rows = items.map((item) => {
        context.font = `700 ${titleFontPx}px Inter, Arial, sans-serif`
        const nameLines = wrapCookTicketText(context, item.name, maxTextWidthPx)
        const note = item.note?.trim()
        const noteLines = note
            ? (() => {
                context.font = `italic ${noteFontPx}px Inter, Arial, sans-serif`
                return wrapCookTicketText(context, note, maxTextWidthPx)
            })()
            : []
        return { item, nameLines, noteLines }
    })

    const titleLineHeightPx = Math.round(titleFontPx * 1.25)
    const quantityLineHeightPx = Math.round(quantityFontPx * 1.25)
    const noteLineHeightPx = Math.round(noteFontPx * 1.3)
    const timestampLineHeightPx = Math.round(timestampFontPx * 1.3)
    const timestampGapPx = Math.round(pixelsPerMm * 2.5)
    const itemGapPx = Math.round(pixelsPerMm * 2.5)
    const heightPx = verticalPaddingPx * 2
        + (timestampLines.length * timestampLineHeightPx)
        + timestampGapPx
        + rows.reduce((total, row) => (
            total
            + (row.nameLines.length * titleLineHeightPx)
            + quantityLineHeightPx
            + (row.noteLines.length * noteLineHeightPx)
            + itemGapPx
        ), 0)

    canvas.width = widthPx
    canvas.height = heightPx
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, widthPx, heightPx)
    context.fillStyle = '#000000'
    context.textAlign = direction === 'rtl' ? 'right' : 'left'
    const textX = direction === 'rtl' ? widthPx - horizontalPaddingPx : horizontalPaddingPx
    let y = verticalPaddingPx

    context.font = `500 ${timestampFontPx}px Inter, Arial, sans-serif`
    for (const line of timestampLines) {
        y += timestampLineHeightPx
        context.fillText(line, textX, y)
    }
    y += timestampGapPx

    for (const row of rows) {
        context.font = `700 ${titleFontPx}px Inter, Arial, sans-serif`
        for (const line of row.nameLines) {
            y += titleLineHeightPx
            context.fillText(line, textX, y)
        }

        context.font = `700 ${quantityFontPx}px Inter, Arial, sans-serif`
        y += quantityLineHeightPx
        context.fillText(`x${row.item.quantity}`, textX, y)

        if (row.noteLines.length > 0) {
            context.font = `italic ${noteFontPx}px Inter, Arial, sans-serif`
            for (const line of row.noteLines) {
                y += noteLineHeightPx
                context.fillText(line, textX, y)
            }
        }
        y += itemGapPx
    }

    const heightMm = heightPx / pixelsPerMm
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({
        orientation: heightMm >= widthMm ? 'p' : 'l',
        unit: 'mm',
        format: [widthMm, heightMm]
    })
    pdf.addImage(canvas, 'PNG', 0, 0, widthMm, heightMm, undefined, 'FAST')
    return pdf.output('blob') as Blob
}


function loadTickets(): InstantPosTicket[] {
    if (typeof window === 'undefined') return []
    try {
        const raw = localStorage.getItem(TICKETS_STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.map((ticket: InstantPosTicket) => {
            const storedStatus = (ticket as { status?: unknown }).status
            const normalizedItems = (ticket.items || []).map((item) => ({
                ...item,
                baseUnitPrice: Number.isFinite(item.baseUnitPrice) ? item.baseUnitPrice : item.unitPrice
            }))
            const normalizedTicket = {
                ...ticket,
                status: storedStatus === 'paid' ? 'served' : ticket.status,
                items: normalizedItems
            }
            if (ticket.expiresAt) return normalizedTicket
            if (!ticket.createdAt) return normalizedTicket
            const createdAt = new Date(ticket.createdAt)
            if (Number.isNaN(createdAt.getTime())) return normalizedTicket
            return {
                ...normalizedTicket,
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
    canPreprintReceipt: boolean
    isPreprinting: boolean
    isLoadingPreprintTemplate: boolean
    canCookOrderTicket: boolean
    isPrintingCookOrderTicket: boolean
    getStorageLabel: (storageId?: string | null) => string | null
    checkoutTicket: () => void
    handlePreprintReceipt: () => Promise<void>
    handleCookOrderTicket: () => Promise<void>
    setTicketStatus: (status: InstantPosStatus) => void
    extendPendingExpiry: (id: string) => void
    clearActiveTicket: () => void
    updateItemQuantity: (productId: string, storageId: string | undefined, delta: number) => void
    setItemQuantity: (productId: string, storageId: string | undefined, quantity: number) => void
    removeItem: (productId: string, storageId: string | undefined) => void
    setNoteItem: (item: { productId: string, storageId?: string, name: string, note: string } | null) => void
    hasTicketNote: boolean
    openTicketNoteEditor: () => void
    openTablePicker: () => void
    closeTicket: (id: string) => void
    hideTableAssignment?: boolean
    hideItemDelete?: boolean
    hideCloseTicket?: boolean
    hideClearAll?: boolean
}

function MobileTicketPanel({
    activeTicket, activeTicketTotals, settlementCurrency, features, t,
    statusLabels, statusAction, activePendingTimeLeftMs, isCheckoutLoading,
    canPreprintReceipt, isPreprinting, isLoadingPreprintTemplate,
    canCookOrderTicket, isPrintingCookOrderTicket,
    getStorageLabel, checkoutTicket, handlePreprintReceipt, handleCookOrderTicket, setTicketStatus, extendPendingExpiry, clearActiveTicket,
    updateItemQuantity, setItemQuantity, removeItem, setNoteItem, hasTicketNote, openTicketNoteEditor, openTablePicker, closeTicket,
    hideTableAssignment = false, hideItemDelete = false, hideCloseTicket = false, hideClearAll = false
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
                            {activeTicket.number}{activeTicket.tableNumber ? ` • ${t('instantPos.table', { defaultValue: 'Table' })} ${activeTicket.tableNumber}` : ''} • {activeTicket.items.length} {activeTicket.items.length === 1 ? t('common.item') : t('common.items')} • {statusLabels[activeTicket.status]}
                        </span>
                    </div>

                    <div
                        className="transition-opacity duration-300"
                        style={{
                            opacity: Math.max(0, 1 - progress * 2),
                            pointerEvents: progress > 0.3 ? 'none' : 'auto'
                        }}
                    >
                        <div className="flex items-center gap-2">
                        {!hideTableAssignment && <Button
                            variant="outline"
                            size="icon"
                            className="h-12 w-12 rounded-2xl border-2"
                            onClick={(event) => {
                                event.stopPropagation()
                                openTablePicker()
                            }}
                            disabled={isCheckoutLoading}
                            title={t('instantPos.assignTable', { defaultValue: 'Assign table' })}
                            aria-label={t('instantPos.assignTable', { defaultValue: 'Assign table' })}
                        >
                            <Table2 className="h-5 w-5" />
                        </Button>}
                        {canPreprintReceipt && (
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-12 w-12 rounded-2xl border-2"
                                onClick={(event) => {
                                    event.stopPropagation()
                                    void handlePreprintReceipt()
                                }}
                                disabled={isCheckoutLoading || isPreprinting || isPrintingCookOrderTicket || isLoadingPreprintTemplate}
                                title={t('pos.preprintReceipt', { defaultValue: 'Pre-print receipt' })}
                                aria-label={t('pos.preprintReceipt', { defaultValue: 'Pre-print receipt' })}
                            >
                                {isPreprinting || isLoadingPreprintTemplate
                                    ? <Loader2 className="h-5 w-5 animate-spin" />
                                    : <Receipt className="h-5 w-5" />}
                            </Button>
                        )}
                        {canCookOrderTicket && (
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-12 w-12 rounded-2xl border-2"
                                onClick={(event) => {
                                    event.stopPropagation()
                                    void handleCookOrderTicket()
                                }}
                                disabled={isCheckoutLoading || isPreprinting || isPrintingCookOrderTicket}
                                title={t('instantPos.cookOrderTicket', { defaultValue: 'Cook Order Ticket' })}
                                aria-label={t('instantPos.cookOrderTicket', { defaultValue: 'Cook Order Ticket' })}
                            >
                                {isPrintingCookOrderTicket
                                    ? <Loader2 className="h-5 w-5 animate-spin" />
                                    : <ChefHat className="h-5 w-5" />}
                            </Button>
                        )}
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
                            <div className="grid grid-cols-4 gap-2">
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

                            {!hideTableAssignment && <button
                                type="button"
                                onClick={openTablePicker}
                                disabled={isCheckoutLoading}
                                className="flex w-full items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-3 py-3 text-left transition hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                <span className="flex items-center gap-2 text-sm font-semibold">
                                    <Table2 className="h-4 w-4 text-primary" />
                                    {t('instantPos.table', { defaultValue: 'Table' })}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                    {activeTicket.tableNumber || t('instantPos.assignTable', { defaultValue: 'Assign table' })}
                                </span>
                            </button>}

                            {/* Items List */}
                            <div className="space-y-3">
                                {activeTicket.items.length === 0 ? (
                                    <div className="rounded-2xl border border-dashed border-border/60 bg-muted/30 px-4 py-10 text-center text-sm text-muted-foreground">
                                        {t('instantPos.emptyTicket') || 'Add items to start this ticket.'}
                                    </div>
                                ) : (
                                    activeTicket.items.map(item => (
                                        <div key={buildInstantPosItemKey(item.productId, item.storageId)} className="rounded-2xl border border-border/60 bg-muted/30 p-4">
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
                                                        {getStorageLabel(item.storageId) && (
                                                            <div className="mt-1 inline-flex rounded-full border border-border/60 bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                                                {getStorageLabel(item.storageId)}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    {item.unitPrice < item.baseUnitPrice && (
                                                        <div className="text-[10px] font-medium text-muted-foreground line-through">
                                                            {formatCurrency(item.baseUnitPrice * item.quantity, item.currency, features.iqd_display_preference)}
                                                        </div>
                                                    )}
                                                    <div className="text-sm font-semibold text-foreground">
                                                        {formatCurrency(item.unitPrice * item.quantity, item.currency, features.iqd_display_preference)}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="mt-4 flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <button onClick={() => updateItemQuantity(item.productId, item.storageId, -1)} className="p-2 bg-background rounded-full border border-border/60"><Minus className="w-3 h-3" /></button>
                                                    {item.storageId === SERVICES_VIRTUAL_STORAGE_ID && <Input type="number" min="0.001" step="0.001" value={item.quantity} onChange={(event) => setItemQuantity(item.productId, item.storageId, Number(event.target.value))} className="h-8 w-20 text-center" aria-label="Service quantity" />}
                                                    <button onClick={() => updateItemQuantity(item.productId, item.storageId, 1)} className="p-2 bg-background rounded-full border border-border/60"><Plus className="w-3 h-3" /></button>
                                                    <button
                                                        onClick={() => setNoteItem({ productId: item.productId, storageId: item.storageId, name: item.name, note: item.note || '' })}
                                                        className={cn("h-8 px-3 rounded-full border border-border/60 text-[10px] font-bold uppercase flex items-center gap-1.5", item.note ? "bg-primary/10 text-primary border-primary/40" : "bg-background")}
                                                    >
                                                        <StickyNote className="w-3.5 h-3.5" /> {t('common.note')}
                                                    </button>
                                                </div>
                                                {!hideItemDelete && (
                                                    <button onClick={() => removeItem(item.productId, item.storageId)} className="text-destructive p-2"><Trash2 className="w-4 h-4" /></button>
                                                )}
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

                                <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_3.5rem] gap-3 pt-2">
                                    <div className={cn('col-span-3 flex gap-3', !statusAction && 'justify-end')}>
                                        {statusAction && (
                                            <Button
                                                onClick={() => setTicketStatus(statusAction.status)}
                                                variant="secondary"
                                                className="h-14 flex-1 rounded-2xl font-bold"
                                            >
                                                {statusAction.label}
                                            </Button>
                                        )}
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className={cn(
                                                'h-14 w-14 rounded-2xl border-2',
                                                hasTicketNote && 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/15'
                                            )}
                                            onClick={openTicketNoteEditor}
                                            disabled={isCheckoutLoading}
                                            title={t('instantPos.addTicketNote', { defaultValue: 'Add Note' })}
                                            aria-label={t('instantPos.addTicketNote', { defaultValue: 'Add Note' })}
                                        >
                                            <StickyNote className="h-5 w-5" />
                                        </Button>
                                    </div>
                                    {canCookOrderTicket && (
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className="h-14 w-14 rounded-2xl border-2"
                                            onClick={() => void handleCookOrderTicket()}
                                            disabled={isCheckoutLoading || isPreprinting || isPrintingCookOrderTicket}
                                            title={t('instantPos.cookOrderTicket', { defaultValue: 'Cook Order Ticket' })}
                                            aria-label={t('instantPos.cookOrderTicket', { defaultValue: 'Cook Order Ticket' })}
                                        >
                                            {isPrintingCookOrderTicket
                                                ? <Loader2 className="h-5 w-5 animate-spin" />
                                                : <ChefHat className="h-5 w-5" />}
                                        </Button>
                                    )}
                                    <Button className={cn("h-14 rounded-2xl font-black text-lg gap-2", !canCookOrderTicket && "col-start-2")} onClick={checkoutTicket} disabled={activeTicket.items.length === 0 || isCheckoutLoading || activeTicketTotals.hasMixedCurrency}>
                                        {isCheckoutLoading ? <Loader2 className="animate-spin" /> : <><CheckCircle2 className="w-5 h-5" /> {t('instantPos.checkout')}</>}
                                    </Button>
                                    {canPreprintReceipt && (
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className="h-14 w-14 rounded-2xl border-2"
                                            onClick={() => void handlePreprintReceipt()}
                                            disabled={isCheckoutLoading || isPreprinting || isPrintingCookOrderTicket || isLoadingPreprintTemplate}
                                            title={t('pos.preprintReceipt', { defaultValue: 'Pre-print receipt' })}
                                            aria-label={t('pos.preprintReceipt', { defaultValue: 'Pre-print receipt' })}
                                        >
                                            {isPreprinting || isLoadingPreprintTemplate
                                                ? <Loader2 className="h-5 w-5 animate-spin" />
                                                : <Receipt className="h-5 w-5" />}
                                        </Button>
                                    )}
                                    {!hideCloseTicket && (
                                        <Button variant="outline" className="h-14 rounded-2xl font-bold col-span-3" onClick={() => closeTicket(activeTicket.id)} disabled={isCheckoutLoading}>
                                            {t('instantPos.closeTicket')}
                                        </Button>
                                    )}
                                    {!hideClearAll && (
                                        <Button variant="ghost" className="h-10 rounded-xl text-destructive font-bold col-span-3" onClick={clearActiveTicket} disabled={isCheckoutLoading}>
                                            {t('instantPos.clearAll')}
                                        </Button>
                                    )}
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
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const [, navigate] = useLocation()
    const [hasRestaurantTableRoute, restaurantTableRouteParams] = useRoute('/instant-pos/table/:tableNumber')
    const { features, hasFeature, isLocalMode } = useWorkspace()
    const storages = useStorages(user?.workspaceId)
    const [selectedStorageId, setSelectedStorageId] = useState<string>(() => {
        return localStorage.getItem('instant_pos_selected_storage') || ''
    })
    const isServicesStorage = selectedStorageId === SERVICES_VIRTUAL_STORAGE_ID
    const instantPosStorages = useMemo(() => [
        ...storages,
        ...(hasFeature('services') ? [{
            id: SERVICES_VIRTUAL_STORAGE_ID,
            name: t('services.title', { defaultValue: 'Services' }),
            isSystem: false,
            isVirtual: true
        }] : [])
    ], [hasFeature, storages, t])
    const products = useBatchAwareInventoryProducts(user?.workspaceId, {
        enabled: !!selectedStorageId && !isServicesStorage,
        storageId: isServicesStorage ? undefined : selectedStorageId || undefined
    })
    const catalogProducts = useProducts(user?.workspaceId, { syncBarcodeCache: false })
    const { canSelectProduct, filterProducts: filterSelectableProducts } = useProductSelectionAccess(user?.workspaceId, user?.id)
    const serviceProducts = useMemo(() => {
        if (!hasFeature('services')) return []
        return filterSelectableProducts(catalogProducts.filter(isService)).map((service) => ({
            ...service,
            sku: '', unit: '', storageId: SERVICES_VIRTUAL_STORAGE_ID, storageName: 'Services',
            quantity: Number.MAX_SAFE_INTEGER, minStockLevel: 0,
            inventoryId: `service:${service.id}`, inventoryQuantity: Number.MAX_SAFE_INTEGER,
            hasBatches: false, batchCount: 0, nextBatchNumber: null, nextBatchExpiryDate: null, nextBatchQuantity: null
        }))
    }, [catalogProducts, filterSelectableProducts, hasFeature])
    const inventoryProducts = useMemo(
        () => filterSelectableProducts(products),
        [filterSelectableProducts, products]
    )
    const selectableProducts = useMemo(
        () => isServicesStorage ? serviceProducts : inventoryProducts,
        [inventoryProducts, isServicesStorage, serviceProducts]
    )
    const ticketProducts = useMemo(
        () => [...inventoryProducts, ...serviceProducts],
        [inventoryProducts, serviceProducts]
    )
    const activeDiscountMap = useActiveDiscountMap(user?.workspaceId, {
        products: isServicesStorage ? catalogProducts.filter(isService) : products,
        inventoryRows: selectedStorageId && !isServicesStorage ? undefined : [],
        storageId: isServicesStorage ? undefined : selectedStorageId || undefined,
        syncRemote: false
    })
    const categories = useCategories(user?.workspaceId)

    // KDS Streaming
    const { status: kdsStatus, startStream, broadcast } = useKdsStream(true)

    useEffect(() => {
        if (hasFeature('kds') && kdsStatus === 'idle') {
            startStream(4004).catch(console.error)
        }
    }, [hasFeature, kdsStatus, startStream])

    const restaurantTableSettings = useRestaurantTableSettings(user?.workspaceId)
    const restaurantLiveSyncEnabled = restaurantTableSettings?.liveSyncEnabled === true
    const restaurantPosTickets = useRestaurantPosTickets(user?.workspaceId, restaurantLiveSyncEnabled)
    const restaurantMode = restaurantTableSettings?.enabled === true
    const isRestaurantAdmin = user?.role === 'admin'
    const [restaurantActionVisibility, setRestaurantActionVisibility] = useState<RestaurantTableActionVisibility>(() => (
        readRestaurantTableActionVisibility(user?.workspaceId)
    ))
    const restaurantTickets = useMemo(
        () => restaurantPosTickets.map(restaurantTicketToInstantTicket),
        [restaurantPosTickets]
    )
    const [localTickets, setLocalTickets] = useState<InstantPosTicket[]>(() => loadTickets())
    const [restaurantTableNumber, setRestaurantTableNumber] = useState<number | null>(null)
    const [restaurantTicketToClose, setRestaurantTicketToClose] = useState<RestaurantPosTicket | null>(null)
    const [isRestaurantTicketClosing, setIsRestaurantTicketClosing] = useState(false)
    const tickets = restaurantMode ? restaurantTickets : localTickets
    const routedRestaurantTableNumber = useMemo(() => {
        const value = Number(restaurantTableRouteParams?.tableNumber)
        return Number.isInteger(value) && value > 0 ? value : null
    }, [restaurantTableRouteParams?.tableNumber])

    useEffect(() => {
        setRestaurantActionVisibility(readRestaurantTableActionVisibility(user?.workspaceId))
    }, [user?.workspaceId])

    const hideRestaurantItemDelete = shouldHideRestaurantTableAction({
        restaurantMode,
        isAdmin: isRestaurantAdmin,
        settings: restaurantActionVisibility,
        action: 'hideItemDelete',
    })
    const hideRestaurantCloseTicket = shouldHideRestaurantTableAction({
        restaurantMode,
        isAdmin: isRestaurantAdmin,
        settings: restaurantActionVisibility,
        action: 'hideCloseTicket',
    })
    const hideRestaurantClearAll = shouldHideRestaurantTableAction({
        restaurantMode,
        isAdmin: isRestaurantAdmin,
        settings: restaurantActionVisibility,
        action: 'hideClearAll',
    })

    useEffect(() => {
        if (!hasRestaurantTableRoute) {
            if (restaurantMode) {
                setRestaurantTableNumber(null)
                setActiveTicketId(null)
            }
            return
        }
        if (!restaurantTableSettings) return
        if (!restaurantTableSettings.enabled
            || !routedRestaurantTableNumber
            || routedRestaurantTableNumber > restaurantTableSettings.tableCount) {
            navigate('/instant-pos', { replace: true })
            return
        }

        setRestaurantTableNumber(routedRestaurantTableNumber)
        const ticket = restaurantPosTickets.find((current) => current.tableNumber === routedRestaurantTableNumber)
        setActiveTicketId(ticket?.id ?? null)
    }, [hasRestaurantTableRoute, navigate, restaurantMode, restaurantPosTickets, restaurantTableSettings, routedRestaurantTableNumber])

    const openRestaurantTable = useCallback((tableNumber: number) => {
        navigate(`/instant-pos/table/${tableNumber}`)
    }, [navigate])

    const returnToRestaurantTableGrid = useCallback(() => {
        navigate('/instant-pos')
    }, [navigate])

    const saveRestaurantActionVisibility = useCallback(async (settings: RestaurantTableActionVisibility) => {
        if (!user?.workspaceId) return
        try {
            const saved = await saveRestaurantTableActionVisibility(user.workspaceId, settings)
            setRestaurantActionVisibility(saved)
            toast({ title: t('restaurantTables.actionVisibilitySaved') })
        } catch (error) {
            console.error('[Instant POS] Failed to save Restaurant Table View action visibility:', error)
            toast({
                title: t('common.error'),
                description: t('restaurantTables.actionVisibilitySaveError'),
                variant: 'destructive',
            })
            throw error
        }
    }, [t, toast, user?.workspaceId])

    const persistRestaurantTickets = useCallback((nextTickets: InstantPosTicket[]) => {
        if (!user?.workspaceId) return
        const existingById = new Map(restaurantPosTickets.map((ticket) => [ticket.id, ticket]))
        const nextIds = new Set(nextTickets.map((ticket) => ticket.id))

        nextTickets.forEach((ticket) => {
            const existing = existingById.get(ticket.id)
            const restaurantTicket = instantTicketToRestaurantTicket(ticket, user.workspaceId, user.id, existing)
            const persist = existing
                ? saveRestaurantPosTicket(restaurantTicket, restaurantLiveSyncEnabled)
                : createRestaurantPosTicket(restaurantTicket, restaurantLiveSyncEnabled)
            void persist.catch((error) => {
                console.error('[Instant POS] Failed to save restaurant ticket:', error)
                if (restaurantLiveSyncEnabled) void refreshRestaurantPosTicketsFromSupabase(user.workspaceId)
            })
        })

        restaurantPosTickets
            .filter((ticket) => !nextIds.has(ticket.id))
            .forEach((ticket) => {
                void closeRestaurantPosTicket(ticket, restaurantLiveSyncEnabled).catch((error) => {
                    console.error('[Instant POS] Failed to close restaurant ticket:', error)
                })
            })
    }, [restaurantLiveSyncEnabled, restaurantPosTickets, user?.id, user?.workspaceId])

    const setTickets = useCallback((next: InstantPosTicket[] | ((current: InstantPosTicket[]) => InstantPosTicket[])) => {
        if (!restaurantMode) {
            setLocalTickets(next)
            return
        }
        const resolved = typeof next === 'function' ? next(restaurantTickets) : next
        persistRestaurantTickets(resolved)
    }, [persistRestaurantTickets, restaurantMode, restaurantTickets])
    const [activeTicketId, setActiveTicketId] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [selectedCategory, setSelectedCategory] = useState<string>('all')
    const [isInstantPosAdjustOpen, setIsInstantPosAdjustOpen] = useState(false)
    const [productsPerRow, setProductsPerRow] = useState(readInstantPosProductsPerRow)
    const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
    const [isCheckoutLoading, setIsCheckoutLoading] = useState(false)
    const [isPreprinting, setIsPreprinting] = useState(false)
    const [isPrintingCookOrderTicket, setIsPrintingCookOrderTicket] = useState(false)
    const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false)
    const [completedSaleData, setCompletedSaleData] = useState<any>(null)
    const [now, setNow] = useState(() => Date.now())
    const [noteItem, setNoteItem] = useState<{ productId: string, storageId?: string, name: string, note: string } | null>(null)
    const [ticketNoteEditor, setTicketNoteEditor] = useState<{ ticketId: string, note: string } | null>(null)
    const [isTablePickerOpen, setIsTablePickerOpen] = useState(false)
    const [tableNumberInput, setTableNumberInput] = useState('')

    const settlementCurrency = features.default_currency || 'usd'

    useEffect(() => {
        if (selectedStorageId) {
            localStorage.setItem('instant_pos_selected_storage', selectedStorageId)
        }
    }, [selectedStorageId])

    useEffect(() => {
        const handleResize = () => setViewportWidth(window.innerWidth)
        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [])

    useEffect(() => {
        saveInstantPosProductsPerRow(productsPerRow)
    }, [productsPerRow])

    useEffect(() => {
        if (selectedStorageId && instantPosStorages.some(storage => storage.id === selectedStorageId)) {
            return
        }

        if (storages.length > 0) {
            const mainStorage = getPrimaryStorageFromList(storages)
            if (mainStorage) {
                setSelectedStorageId(mainStorage.id)
            }
        }
    }, [instantPosStorages, selectedStorageId, storages])

    useEffect(() => {
        if (restaurantMode) return
        saveTickets(tickets)
        // Broadcast to KDS remote clients whenever tickets change
        if (hasFeature('kds') && kdsStatus === 'host') {
            broadcast('TICKET_UPDATED', tickets)
        }
    }, [broadcast, tickets, kdsStatus, hasFeature, restaurantMode])

    useEffect(() => {
        if (restaurantMode) return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [restaurantMode])

    // Automatic expiry deletion: remove pending tickets that have passed their expiresAt time
    useEffect(() => {
        if (restaurantMode) return
        const expiredIds = tickets
            .filter(ticket => ticket.status === 'pending' && getTicketExpiryDate(ticket).getTime() < now)
            .map(t => t.id)

        if (expiredIds.length > 0) {
            setLocalTickets(prev => prev.filter(t => !expiredIds.includes(t.id)))
        }
    }, [now, restaurantMode, tickets])

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key === TICKETS_STORAGE_KEY) {
                setLocalTickets(loadTickets())
            }
        }

        // Internal event for same-window updates (e.g. from KDS Dashboard to POS)
        const handleInternalSync = () => {
            setLocalTickets(loadTickets())
        }

        // Event for updates from remote tablets
        const handleRemoteSync = (event: any) => {
            const updatedTickets = event.detail
            if (updatedTickets && Array.isArray(updatedTickets)) {
                setLocalTickets(updatedTickets)
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
        if (restaurantMode) {
            const tableTicket = restaurantTableNumber === null
                ? null
                : tickets.find((ticket) => ticket.tableNumber === String(restaurantTableNumber))
            setActiveTicketId(tableTicket?.id ?? null)
            return
        }
        if (!tickets.length) {
            setActiveTicketId(null)
            return
        }
        if (!activeTicketId || !tickets.some(ticket => ticket.id === activeTicketId)) {
            setActiveTicketId(tickets[0].id)
        }
    }, [tickets, activeTicketId, restaurantMode, restaurantTableNumber])

    const activeTicket = useMemo(
        () => tickets.find(ticket => ticket.id === activeTicketId) || null,
        [tickets, activeTicketId]
    )

    const handleStorageSelect = useCallback((storageId: string) => {
        if (storageId !== selectedStorageId && tickets.some((ticket) => ticket.items.length > 0)) {
            toast({
                title: t('common.error') || 'Error',
                description: t('pos.switchStorageBlocked') || 'Finish or clear open tickets before switching storage.',
                variant: 'destructive'
            })
            return
        }
        setSelectedStorageId(storageId)
    }, [selectedStorageId, t, tickets, toast])

    const getStorageLabel = useCallback((storageId?: string | null) => {
        if (storageId === SERVICES_VIRTUAL_STORAGE_ID) {
            return t('services.title', { defaultValue: 'Services' })
        }
        if (!storageId) {
            return null
        }

        const storage = storages.find(item => item.id === storageId)
        if (!storage) {
            return null
        }

        return storage.isSystem
            ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name)
            : storage.name
    }, [storages, t])

    const resolveTicketProduct = useCallback((item: Pick<InstantPosItem, 'productId' | 'storageId'>) => {
        if (item.storageId) {
            return ticketProducts.find(product => product.id === item.productId && product.storageId === item.storageId)
        }

        const matches = ticketProducts.filter(product => product.id === item.productId)
        return matches.length === 1 ? matches[0] : undefined
    }, [ticketProducts])

    const filteredProducts = useMemo(() => {
        const term = search.trim().toLowerCase()
        const normalizedSettlement = settlementCurrency?.toLowerCase()
        return selectableProducts.filter(product => {
            if (!selectedStorageId || product.storageId !== selectedStorageId) return false
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
    }, [search, selectableProducts, selectedCategory, selectedStorageId, settlementCurrency])

    useEffect(() => {
        const excludedProductIds = new Set(
            ticketProducts
                .filter((product) => !canSelectProduct(product))
                .map((product) => product.id)
        )

        if (excludedProductIds.size === 0) {
            return
        }

        const removeExcludedItems = (current: InstantPosTicket[]) => current.map((ticket) => {
            const items = ticket.items.filter((item) => !excludedProductIds.has(item.productId))
            return items.length === ticket.items.length ? ticket : { ...ticket, items }
        })
        if (restaurantMode) {
            const nextTickets = removeExcludedItems(restaurantTickets)
            if (nextTickets.some((ticket, index) => ticket !== restaurantTickets[index])) {
                persistRestaurantTickets(nextTickets)
            }
            return
        }
        setLocalTickets(removeExcludedItems)
    }, [canSelectProduct, persistRestaurantTickets, restaurantMode, restaurantTickets, ticketProducts])

    const activeTicketTotals = useMemo(() => {
        if (!activeTicket) {
            return { count: 0, total: 0, hasMixedCurrency: false }
        }
        const hasMixedCurrency = activeTicket.items.some(item => item.currency !== settlementCurrency)
        const total = activeTicket.items.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0)
        const count = activeTicket.items.reduce((sum, item) => sum + item.quantity, 0)
        return { count, total, hasMixedCurrency }
    }, [activeTicket, settlementCurrency])

    const activeTicketQuantityByItemKey = useMemo(() => new Map(
        activeTicket?.items.map((item) => [buildInstantPosItemKey(item.productId, item.storageId), item.quantity]) ?? []
    ), [activeTicket])

    const preprintReceiptData = useMemo(() => {
        if (!user || !activeTicket || activeTicket.items.length === 0 || activeTicketTotals.hasMixedCurrency) {
            return null
        }

        const printedAt = new Date().toISOString()
        return mapSaleToUniversal({
            id: generateId(),
            workspace_id: user.workspaceId,
            cashier_id: user.id,
            cashier_name: user.name || 'System',
            created_at: printedAt,
            items: activeTicket.items.map((item) => {
                const product = resolveTicketProduct(item)
                const service = isService(product)
                return {
                    product_id: item.productId,
                    storage_id: service ? null : item.storageId || product?.storageId || null,
                    product_name: item.name,
                    product_sku: item.sku,
                    created_at: printedAt,
                    updated_at: printedAt,
                    quantity: item.quantity,
                    unit_price: item.unitPrice,
                    total_price: item.unitPrice * item.quantity,
                    cost_price: product?.costPrice ?? 0,
                    converted_cost_price: product?.costPrice ?? 0,
                    original_currency: item.currency,
                    original_unit_price: item.baseUnitPrice,
                    converted_unit_price: item.unitPrice,
                    settlement_currency: settlementCurrency,
                    inventory_snapshot: service ? null : product?.quantity ?? 0,
                }
            }),
            total_amount: activeTicketTotals.total,
            settlement_currency: settlementCurrency,
            sales_exchange: [],
            origin: 'instant_pos',
            payment_method: 'cash',
            instant_table_number: activeTicket.tableNumber || null,
            notes: activeTicket.note?.trim() || null
        } as any)
    }, [activeTicket, activeTicketTotals.hasMixedCurrency, activeTicketTotals.total, resolveTicketProduct, settlementCurrency, user])

    const canPreprintReceipt = !!preprintReceiptData
    const {
        isLoadingPrimaryReceiptTemplate: isLoadingPreprintTemplate,
        printReceipt: printPreprintReceipt,
    } = usePosReceiptPrinter({
        saleData: preprintReceiptData,
        features,
        enabled: canPreprintReceipt,
        receiptTemplateKey: INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY,
    })

    const handlePreprintReceipt = useCallback(async () => {
        if (!preprintReceiptData || isPreprinting) return

        setIsPreprinting(true)
        try {
            await printPreprintReceipt({
                title: `Receipt_${preprintReceiptData.invoiceid || preprintReceiptData.id}`
            })
        } catch (error) {
            console.error('[Instant POS] Failed to print receipt pre-print:', error)
            toast({
                variant: 'destructive',
                title: t('messages.error'),
                description: t('pos.preprintReceiptFailed', { defaultValue: 'Could not print the receipt pre-print.' })
            })
        } finally {
            setIsPreprinting(false)
        }
    }, [isPreprinting, preprintReceiptData, printPreprintReceipt, t, toast])

    const canCookOrderTicket = !!activeTicket && activeTicket.items.length > 0
    const cookTicketLocale = useMemo(() => (
        features.print_lang && features.print_lang !== 'auto'
            ? features.print_lang
            : i18n.language
    ), [features.print_lang, i18n.language])
    const cookTicketDirection = useMemo<'ltr' | 'rtl'>(() => {
        return cookTicketLocale.startsWith('ar') || cookTicketLocale.startsWith('ku') ? 'rtl' : 'ltr'
    }, [cookTicketLocale])
    const buildCookOrderTicketPdf = useCallback(async (printedAt: Date) => {
        if (!activeTicket || activeTicket.items.length === 0) {
            throw new Error('Cook order ticket items are not available.')
        }

        const thermalPrinter = features.thermal_printing && user?.workspaceId
            ? await printService.getSelectedThermalPrinter(user.workspaceId)
            : null
        return createCookOrderTicketPdf({
            items: activeTicket.items,
            widthMm: thermalPrinter?.roll_width_mm ?? 80,
            direction: cookTicketDirection,
            locale: cookTicketLocale,
            printedAt,
        })
    }, [activeTicket, cookTicketDirection, cookTicketLocale, features.thermal_printing, user?.workspaceId])
    const { printReceipt: printCookOrderTicket } = usePosReceiptPrinter({
        saleData: undefined,
        features,
        enabled: canCookOrderTicket,
        receiptPdfBuilder: () => buildCookOrderTicketPdf(new Date()),
    })

    const handleCookOrderTicket = useCallback(async () => {
        if (!activeTicket || !canCookOrderTicket || isPrintingCookOrderTicket) return

        setIsPrintingCookOrderTicket(true)
        try {
            const printedAt = new Date()
            await printCookOrderTicket({
                title: `Cook_Order_Ticket_${activeTicket.number}`,
                pdfBuilder: () => buildCookOrderTicketPdf(printedAt),
            })
        } catch (error) {
            console.error('[Instant POS] Failed to print cook order ticket:', error)
            toast({
                variant: 'destructive',
                title: t('messages.error'),
                description: t('instantPos.cookOrderTicketFailed', { defaultValue: 'Could not print the cook order ticket.' })
            })
        } finally {
            setIsPrintingCookOrderTicket(false)
        }
    }, [activeTicket, buildCookOrderTicketPdf, canCookOrderTicket, isPrintingCookOrderTicket, printCookOrderTicket, t, toast])

    const statusLabels = useMemo(() => ({
        pending: t('instantPos.status.pending') || 'Pending',
        preparing: t('instantPos.status.preparing') || 'Preparing',
        ready: t('instantPos.status.ready') || 'Ready',
        served: t('instantPos.status.served') || 'Served'
    }), [t])

    const createTicket = () => {
        if (restaurantMode) return
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

    const updateTicket = useCallback((ticketId: string, updater: (ticket: InstantPosTicket) => InstantPosTicket) => {
        setTickets(prev => prev.map(ticket => (ticket.id === ticketId ? updater(ticket) : ticket)))
    }, [setTickets])

    const openTablePicker = useCallback(() => {
        if (!activeTicket) return
        setTableNumberInput(activeTicket.tableNumber || '')
        setIsTablePickerOpen(true)
    }, [activeTicket])

    const applyTableNumber = useCallback((value: string) => {
        if (!activeTicket) return

        const tableNumber = normalizeTableNumber(value)
        if (!tableNumber) {
            toast({
                title: t('common.error') || 'Error',
                description: t('instantPos.invalidTableNumber', { defaultValue: 'Enter a table number from 1 to 9999.' }),
                variant: 'destructive'
            })
            return
        }

        updateTicket(activeTicket.id, ticket => ({ ...ticket, tableNumber }))
        setIsTablePickerOpen(false)
    }, [activeTicket, t, toast, updateTicket])

    const clearTableNumber = useCallback(() => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => ({ ...ticket, tableNumber: undefined }))
        setTableNumberInput('')
        setIsTablePickerOpen(false)
    }, [activeTicket, updateTicket])

    const addItemToTicket = (productId: string) => {
        const product = selectableProducts.find(item => item.id === productId && item.storageId === selectedStorageId)
        const activeDiscount = activeDiscountMap.get(productId)
        if (!product) return
        if (!selectedStorageId && !isService(product)) {
            toast({
                title: t('common.error') || 'Error',
                description: t('storages.selectStorage') || 'Select a storage first.',
                variant: 'destructive'
            })
            return
        }
        if (!isService(product) && !hasValidProductCost(product.costPrice)) {
            toast({
                title: t('common.error') || 'Error',
                description: getMissingProductCostMessage(product.name),
                variant: 'destructive'
            })
            return
        }
        if (!isService(product) && product.quantity <= 0) {
            toast({
                title: t('common.error') || 'Error',
                description: t('instantPos.outOfStock') || 'This product is out of stock.',
                variant: 'destructive'
            })
            return
        }

        if (!activeTicket) {
            if (restaurantMode && restaurantTableNumber === null) return
            const createdAt = new Date()
            const newTicket: InstantPosTicket = {
                id: generateId(),
                number: restaurantMode
                    ? `R-${String(restaurantTableNumber).padStart(3, '0')}-${String(createdAt.getTime()).slice(-4)}`
                    : nextTicketNumber(),
                createdAt: createdAt.toISOString(),
                status: 'pending',
                items: [{
                    productId: product.id,
                    storageId: product.storageId,
                    name: product.name,
                    sku: product.sku,
                    baseUnitPrice: product.price,
                    unitPrice: activeDiscount?.discountPrice ?? product.price,
                    quantity: 1,
                    currency: product.currency,
                    discountType: activeDiscount?.discountType,
                    discountValue: activeDiscount?.discountValue,
                    discountSource: activeDiscount?.source,
                    discountEndsAt: activeDiscount?.endsAt
                }],
                tableNumber: restaurantMode ? String(restaurantTableNumber) : undefined,
                expiresAt: restaurantMode ? undefined : new Date(createdAt.getTime() + PENDING_TICKET_TTL_MS).toISOString()
            }
            setTickets(prev => [newTicket, ...prev])
            setActiveTicketId(newTicket.id)
            return
        }

        updateTicket(activeTicket.id, ticket => {
            const existing = ticket.items.find(item =>
                item.productId === product.id && item.storageId === product.storageId
            )
            if (existing) {
                if (!isService(product) && existing.quantity >= product.quantity) {
                    toast({
                        title: t('common.error') || 'Error',
                        description: t('instantPos.outOfStock') || 'This product is out of stock.',
                        variant: 'destructive'
                    })
                    return ticket
                }
                const items = ticket.items.map(item =>
                    item.productId === product.id && item.storageId === product.storageId
                        ? { ...item, quantity: item.quantity + 1 }
                        : item
                )
                return { ...ticket, items }
            }

            const newItem: InstantPosItem = {
                productId: product.id,
                storageId: product.storageId,
                name: product.name,
                sku: product.sku,
                baseUnitPrice: product.price,
                unitPrice: activeDiscount?.discountPrice ?? product.price,
                quantity: 1,
                currency: product.currency,
                discountType: activeDiscount?.discountType,
                discountValue: activeDiscount?.discountValue,
                discountSource: activeDiscount?.source,
                discountEndsAt: activeDiscount?.endsAt
            }

            return { ...ticket, items: [...ticket.items, newItem] }
        })
    }

    const updateItemQuantity = (productId: string, storageId: string | undefined, delta: number) => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => {
            const product = resolveTicketProduct({ productId, storageId })
            const items = ticket.items
                .map(item => {
                    if (item.productId !== productId || item.storageId !== storageId) return item
                    const nextQuantity = Math.max(1, item.quantity + delta)
                    const maxStock = isService(product) ? Number.MAX_SAFE_INTEGER : (product?.quantity ?? nextQuantity)
                    const boundedQuantity = maxStock > 0 ? Math.min(nextQuantity, maxStock) : 1
                    return {
                        ...item,
                        quantity: boundedQuantity
                    }
                })
            return { ...ticket, items }
        })
    }

    const setItemQuantity = (productId: string, storageId: string | undefined, quantity: number) => {
        if (!activeTicket || !Number.isFinite(quantity) || quantity <= 0) return
        updateTicket(activeTicket.id, (ticket) => ({
            ...ticket,
            items: ticket.items.map((item) => item.productId === productId && item.storageId === storageId
                ? { ...item, quantity: isService(resolveTicketProduct(item)) ? quantity : Math.min(quantity, resolveTicketProduct(item)?.quantity ?? quantity) }
                : item)
        }))
    }

    const removeItem = (productId: string, storageId: string | undefined) => {
        if (!activeTicket) return
        if (restaurantMode && activeTicket.items.length === 1
            && activeTicket.items[0].productId === productId
            && activeTicket.items[0].storageId === storageId) {
            const storedTicket = restaurantPosTickets.find((ticket) => ticket.id === activeTicket.id)
            if (storedTicket) {
                void hardDeleteRestaurantPosTicket(storedTicket, restaurantLiveSyncEnabled)
                returnToRestaurantTableGrid()
                setActiveTicketId(null)
            }
            return
        }
        updateTicket(activeTicket.id, ticket => ({
            ...ticket,
            items: ticket.items.filter(item => item.productId !== productId || item.storageId !== storageId)
        }))
    }

    const updateItemNote = (productId: string, storageId: string | undefined, note: string) => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => ({
            ...ticket,
            items: ticket.items.map(item =>
                item.productId === productId && item.storageId === storageId ? { ...item, note } : item
            )
        }))
        setNoteItem(null)
    }

    const openTicketNoteEditor = () => {
        if (!activeTicket) return
        setTicketNoteEditor({
            ticketId: activeTicket.id,
            note: activeTicket.note || ''
        })
    }

    const saveTicketNote = () => {
        if (!ticketNoteEditor) return
        const note = ticketNoteEditor.note.trim()
        updateTicket(ticketNoteEditor.ticketId, (ticket) => ({
            ...ticket,
            note: note || undefined
        }))
        setTicketNoteEditor(null)
    }

    const setTicketStatus = (status: InstantPosStatus) => {
        if (!activeTicket) return
        updateTicket(activeTicket.id, ticket => ({
            ...ticket,
            status,
            expiresAt: !restaurantMode && status === 'pending'
                ? (ticket.expiresAt || new Date(Date.now() + PENDING_TICKET_TTL_MS).toISOString())
                : ticket.expiresAt,
            kitchenRoutedAt: status === 'preparing' && hasFeature('kds')
                ? (ticket.kitchenRoutedAt || new Date().toISOString())
                : ticket.kitchenRoutedAt
        }))

        if (status === 'preparing' && hasFeature('kds')) {
            toast({
                title: t('common.success') || 'Sent to Kitchen',
                description: t('instantPos.kdsToast') || 'Ticket routed to KDS for preparation.'
            })
        }
    }

    const finalizeTicket = async (ticketId: string) => {
        if (restaurantMode) {
            const ticket = restaurantPosTickets.find((current) => current.id === ticketId)
            if (ticket) {
                await closeRestaurantPosTicket(ticket, restaurantLiveSyncEnabled)
            }
            returnToRestaurantTableGrid()
            setActiveTicketId(null)
            return
        }
        setTickets(prev => prev.filter(ticket => ticket.id !== ticketId))
        if (activeTicketId === ticketId) {
            setActiveTicketId(null)
        }
    }

    const closeTicket = (ticketId: string) => {
        if (restaurantMode) {
            const ticket = restaurantPosTickets.find((current) => current.id === ticketId)
            if (ticket) setRestaurantTicketToClose(ticket)
            return
        }
        finalizeTicket(ticketId)
    }

    const checkoutTicket = async () => {
        if (!activeTicket || !user?.workspaceId || !user?.id) return
        if (activeTicket.items.length === 0) return

        const restrictedItem = activeTicket.items.find((item) => {
            const product = products.find((candidate) => candidate.id === item.productId && candidate.storageId === item.storageId)
            return product ? !canSelectProduct(product) : false
        })
        if (restrictedItem) {
            toast({
                title: t('common.error') || 'Error',
                description: t('businessPartners.agent.productCategoryExcluded', { defaultValue: 'This product category is not available to this user.' }),
                variant: 'destructive'
            })
            return
        }

        const missingCostItem = activeTicket.items.find((item) => {
            const product = resolveTicketProduct(item)
            return product ? !isService(product) && !hasValidProductCost(product.costPrice) : false
        })
        if (missingCostItem) {
            const product = resolveTicketProduct(missingCostItem)
            toast({
                title: t('common.error') || 'Error',
                description: getMissingProductCostMessage(product?.name || missingCostItem.name),
                variant: 'destructive'
            })
            return
        }

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

        for (const item of activeTicket.items) {
            const product = resolveTicketProduct(item)
            const resolvedStorageId = item.storageId || product?.storageId
            if (!product || (!isService(product) && !resolvedStorageId)) {
                toast({
                    title: t('common.error') || 'Error',
                    description: t('instantPos.storageRequired') || 'This product is stocked in multiple storages. Use the full POS flow to choose a storage.',
                    variant: 'destructive'
                })
                setIsCheckoutLoading(false)
                return
            }

            if (!isService(product) && item.quantity > product.quantity) {
                toast({
                    title: t('common.error') || 'Error',
                    description: `${product.name} ${t('instantPos.outOfStock') || 'is out of stock.'}`,
                    variant: 'destructive'
                })
                setIsCheckoutLoading(false)
                return
            }
        }

        const physicalItems = activeTicket.items.filter((item) => !isService(resolveTicketProduct(item)))
        let batchSalePlans: Awaited<ReturnType<typeof getStockBatchSalePlans>>
        try {
            batchSalePlans = await getStockBatchSalePlans(physicalItems.map((item) => {
                const resolvedStorageId = item.storageId || resolveTicketProduct(item)?.storageId
                if (!resolvedStorageId) {
                    throw new Error('Storage is required for batched sale items')
                }

                return {
                    productId: item.productId,
                    storageId: resolvedStorageId,
                    quantity: item.quantity
                }
            }))
        } catch (error) {
            const normalized = normalizeSupabaseActionError(error)
            toast({
                title: t('common.error') || 'Error',
                description: normalized.message || (t('instantPos.checkoutError') || 'Unable to allocate stock batches for this ticket.'),
                variant: 'destructive'
            })
            setIsCheckoutLoading(false)
            return
        }

        const batchPlanByItemKey = new Map(
            physicalItems.map((item, index) => [buildInstantPosItemKey(item.productId, item.storageId), batchSalePlans[index]] as const)
        )

        const itemsWithMetadata = activeTicket.items.map((item) => {
            const product = resolveTicketProduct(item)
            const service = isService(product)
            const inventorySnapshot = service ? null : (product?.quantity ?? 0)
            const batchPlan = batchPlanByItemKey.get(buildInstantPosItemKey(item.productId, item.storageId))
            const resolvedStorageId = service ? null : (item.storageId || product?.storageId || null)
            const originalCurrency = item.currency as CurrencyCode
            const targetCurrency = settlementCurrency as CurrencyCode
            const convertBatchCost = (amount: number, from: CurrencyCode, to: CurrencyCode) =>
                convertCurrencyAmountWithAvailableSnapshot(amount, from, to) ?? amount
            const costPrice = calculateStockBatchUnitCost(
                batchPlan?.allocations ?? [],
                product?.costPrice || 0,
                originalCurrency,
                convertBatchCost,
                batchPlan?.requestedQuantity ?? item.quantity
            )
            const convertedCostPrice = calculateStockBatchUnitCost(
                batchPlan?.allocations ?? [],
                convertBatchCost(product?.costPrice || 0, originalCurrency, targetCurrency),
                targetCurrency,
                convertBatchCost,
                batchPlan?.requestedQuantity ?? item.quantity
            )
            return {
                product_id: item.productId,
                storage_id: resolvedStorageId,
                product_name: item.name,
                product_sku: item.sku,
                created_at: snapshotTimestamp,
                updated_at: snapshotTimestamp,
                quantity: item.quantity,
                unit_price: item.unitPrice,
                total_price: item.unitPrice * item.quantity,
                cost_price: costPrice,
                converted_cost_price: convertedCostPrice,
                original_currency: item.currency,
                original_unit_price: item.baseUnitPrice,
                converted_unit_price: item.unitPrice,
                settlement_currency: settlementCurrency,
                negotiated_price: null,
                total: item.unitPrice * item.quantity,
                inventory_snapshot: inventorySnapshot,
                batch_allocations: !service && (batchPlan?.allocations.length ?? 0) > 0
                    ? batchPlan!.allocations.map((allocation) => ({
                        batch_id: allocation.batchId,
                        batch_number: allocation.batchNumber,
                        quantity: allocation.quantity,
                        price: allocation.price ?? null,
                        cost_price: allocation.costPrice ?? null,
                        currency: allocation.currency ?? null,
                        expiry_date: allocation.expiryDate ?? null,
                        manufacturing_date: allocation.manufacturingDate ?? null
                    }))
                    : null
            }
        })

        const totalAmount = itemsWithMetadata.reduce((sum, item) => sum + item.total_price, 0)
        const verificationSale = createVerificationSale(
            totalAmount,
            settlementCurrency,
            null,
            null,
            itemsWithMetadata,
            null
        )
        const verificationResult = verifySale(verificationSale, {
            maxDiscountPercent: features.max_discount_percent
        })

        const ticketNote = activeTicket.note?.trim() || null

        const checkoutPayload = {
            id: saleId,
            workspace_id: user.workspaceId,
            items: itemsWithMetadata,
            total_amount: totalAmount,
            settlement_currency: settlementCurrency,
            sales_exchange: [],
            origin: 'instant_pos',
            payment_method: 'cash',
            instant_table_number: activeTicket.tableNumber || null,
            notes: ticketNote
        }

        try {
            if (isLocalMode) {
                throw new Error('local_workspace_sale')
            }

            let completeSaleResponse = await runSupabaseAction('instantPos.completeSale', () =>
                supabase.rpc('complete_sale', { payload: checkoutPayload })
            )

            if (completeSaleResponse.error && isRetriableWebRequestError(completeSaleResponse.error)) {
                completeSaleResponse = await runSupabaseAction('instantPos.completeSale.verify', () =>
                    supabase.rpc('complete_sale', { payload: checkoutPayload })
                )
            }

            const { data, error } = completeSaleResponse

            if (error) throw normalizeSupabaseActionError(error)

            const serverResult = data as any
            const sequenceId = serverResult?.sequence_id
            const formattedInvoiceId = sequenceId ? `#${String(sequenceId).padStart(5, '0')}` : `#${saleId.slice(0, 8)}`

            await Promise.all(physicalItems.map(async (item) => {
                const resolvedStorageId = item.storageId || resolveTicketProduct(item)?.storageId
                if (resolvedStorageId) {
                    await adjustInventoryQuantity({
                        workspaceId: user.workspaceId,
                        productId: item.productId,
                        storageId: resolvedStorageId,
                        quantityDelta: -item.quantity,
                        timestamp: snapshotTimestamp,
                        syncSource: 'remote',
                        skipRemoteSync: true
                    })
                }
            }))

            await Promise.all(batchSalePlans.map((plan) =>
                commitStockBatchAllocations(
                    user.workspaceId,
                    plan.productId,
                    plan.storageId,
                    plan.allocations,
                    {
                        timestamp: snapshotTimestamp,
                        syncSource: 'remote',
                        skipRemoteSync: true
                    }
                )
            ))
            await refreshStockBatchesFromSupabase(user.workspaceId)

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

            const saleData = mapSaleToUniversal({
                ...checkoutPayload,
                sequenceId,
                created_at: snapshotTimestamp,
                workspace_id: user.workspaceId,
                cashier_id: user.id,
                cashier_name: user.name || 'System'
            } as any)

            await finalizeTicket(activeTicket.id)
            setCompletedSaleData(saleData)
            setIsSuccessModalOpen(true)

            toast({
                title: t('instantPos.checkoutComplete') || 'Order closed',
                description: t('instantPos.checkoutCompleteDesc') || 'Sale recorded in Sales History.'
            })
        } catch (err) {
            const normalized = normalizeSupabaseActionError(err)
            console.error('[Instant POS] Checkout failed, saving offline:', normalized)

            if (isLocalMode) {
                try {
                    const localSequenceId = await generateLocalSaleSequenceId(user.workspaceId)
                    const localSaleItems = itemsWithMetadata.map((item) => ({
                        id: generateId(),
                        workspaceId: user.workspaceId,
                        saleId,
                        createdAt: item.created_at,
                        updatedAt: item.updated_at,
                        productId: item.product_id,
                        storageId: item.storage_id,
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
                        inventorySnapshot: item.inventory_snapshot,
                        batchAllocations: item.batch_allocations?.map((allocation) => ({
                            batchId: allocation.batch_id,
                            batchNumber: allocation.batch_number,
                            quantity: allocation.quantity,
                            price: allocation.price ?? null,
                            costPrice: allocation.cost_price ?? null,
                            currency: allocation.currency ?? null,
                            expiryDate: allocation.expiry_date ?? null,
                            manufacturingDate: allocation.manufacturing_date ?? null
                        })),
                        originalBatchAllocations: item.batch_allocations?.map((allocation) => ({
                            batchId: allocation.batch_id,
                            batchNumber: allocation.batch_number,
                            quantity: allocation.quantity,
                            price: allocation.price ?? null,
                            costPrice: allocation.cost_price ?? null,
                            currency: allocation.currency ?? null,
                            expiryDate: allocation.expiry_date ?? null,
                            manufacturingDate: allocation.manufacturing_date ?? null
                        }))
                    }))

                    // A local ticket is valid only when its header and every
                    // line item have been committed together.
                    await db.transaction('rw', [db.sales, db.sale_items], async () => {
                        await db.sales.add({
                        id: saleId,
                        workspaceId: user.workspaceId,
                        cashierId: user.id,
                        totalAmount: totalAmount,
                        originalTotalAmount: totalAmount,
                        returnedAmount: 0,
                        returnStatus: 'none',
                        settlementCurrency: settlementCurrency,
                        origin: 'instant_pos',
                        payment_method: 'cash',
                        tableNumber: activeTicket.tableNumber || null,
                        notes: ticketNote || undefined,
                        sequenceId: localSequenceId,
                        createdAt: snapshotTimestamp,
                        updatedAt: snapshotTimestamp,
                        syncStatus: 'pending',
                        lastSyncedAt: null,
                        version: 1,
                        isDeleted: false,
                        systemVerified: verificationResult.verified,
                        systemReviewStatus: verificationResult.status,
                        systemReviewReason: verificationResult.reason
                        })

                        if (localSaleItems.length > 0) {
                            await db.sale_items.bulkAdd(localSaleItems)
                        }
                    })

                    await Promise.all(physicalItems.map(async (item) => {
                        const resolvedStorageId = item.storageId || resolveTicketProduct(item)?.storageId
                        if (resolvedStorageId) {
                            await adjustInventoryQuantity({
                                workspaceId: user.workspaceId,
                                productId: item.productId,
                                storageId: resolvedStorageId,
                                quantityDelta: -item.quantity,
                                timestamp: snapshotTimestamp
                            })
                        }
                    }))

                    await Promise.all(batchSalePlans.map((plan) =>
                        commitStockBatchAllocations(
                            user.workspaceId,
                            plan.productId,
                            plan.storageId,
                            plan.allocations,
                            { timestamp: snapshotTimestamp }
                        )
                    ))

                    if (!isLocalMode) {
                        await db.invoices.add({
                            id: saleId,
                            invoiceid: `#${String(localSequenceId).padStart(5, '0')}`,
                            sequenceId: localSequenceId,
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
                    }

                    const saleDataOffline = mapSaleToUniversal({
                        ...checkoutPayload,
                        sequenceId: localSequenceId,
                        created_at: snapshotTimestamp,
                        workspace_id: user.workspaceId,
                        cashier_id: user.id,
                        cashier_name: user.name || 'System'
                    } as any)

                    await addToOfflineMutations('sales', saleId, 'create', checkoutPayload, user.workspaceId)

                    await finalizeTicket(activeTicket.id)
                    setCompletedSaleData(saleDataOffline)
                    setIsSuccessModalOpen(true)

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
                    description: (!navigator.onLine || isRetriableWebRequestError(normalized))
                        ? t('inventory.errors.onlineRequired')
                        : normalized.message || (t('instantPos.checkoutError') || 'Failed to complete checkout.'),
                    variant: 'destructive'
                })
            }
        } finally {
            setIsCheckoutLoading(false)
        }
    }

    const clearActiveTicket = () => {
        if (!activeTicket) return
        if (restaurantMode) {
            const ticket = restaurantPosTickets.find((current) => current.id === activeTicket.id)
            if (ticket) {
                setRestaurantTicketToClose(ticket)
            }
            return
        }
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
        if (restaurantMode || !activeTicket || activeTicket.status !== 'pending') return null
        const expiry = getTicketExpiryDate(activeTicket)
        return expiry.getTime() - now
    }, [activeTicket, now, restaurantMode])

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

    const handleRestaurantTicketMove = async (ticket: RestaurantPosTicket, destinationTableNumber: number) => {
        try {
            await moveRestaurantPosTicket(ticket, destinationTableNumber, restaurantLiveSyncEnabled)
        } catch (error) {
            console.error('[Instant POS] Failed to transfer restaurant ticket:', error)
            toast({
                title: t('common.error'),
                description: t('restaurantTables.transferFailed'),
                variant: 'destructive'
            })
            throw error
        }
    }

    const confirmRestaurantTicketClose = async () => {
        if (!restaurantTicketToClose || isRestaurantTicketClosing) return
        setIsRestaurantTicketClosing(true)
        try {
            await hardDeleteRestaurantPosTicket(restaurantTicketToClose, restaurantLiveSyncEnabled)
            if (activeTicketId === restaurantTicketToClose.id) {
                returnToRestaurantTableGrid()
                setActiveTicketId(null)
            }
            setRestaurantTicketToClose(null)
        } catch (error) {
            console.error('[Instant POS] Failed to close restaurant ticket:', error)
            toast({
                title: t('common.error'),
                description: t('instantPos.checkoutError'),
                variant: 'destructive'
            })
        } finally {
            setIsRestaurantTicketClosing(false)
        }
    }

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return ''
        if (url.startsWith('http') || url.startsWith('data:')) return url
        return platformService.convertFileSrc(url)
    }

    if (restaurantMode && restaurantTableNumber === null) {
        return (
            <RestaurantTableGrid
                tableCount={restaurantTableSettings.tableCount}
                vipTableNumbers={restaurantTableSettings.vipTableNumbers}
                tickets={restaurantPosTickets}
                formatTotal={(ticket) => formatCurrency(
                    calculateRestaurantTicketTotal(ticket.items),
                    settlementCurrency,
                    features.iqd_display_preference
                )}
                onOpenTable={openRestaurantTable}
                onMoveTicket={handleRestaurantTicketMove}
                canManageActionVisibility={isRestaurantAdmin}
                actionVisibility={restaurantActionVisibility}
                onSaveActionVisibility={saveRestaurantActionVisibility}
            />
        )
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-background p-4 text-foreground xl:flex-row xl:m-0">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
                    <button
                        className="-ms-2 rounded-lg p-2 transition-colors hover:bg-secondary xl:hidden"
                        onClick={() => window.dispatchEvent(new CustomEvent('open-mobile-sidebar'))}
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <div className="min-w-0 shrink-0">
                        <h1 className="text-lg font-bold">
                            {t('instantPos.title') || 'Instant POS'}
                        </h1>
                        <p className="max-w-48 truncate text-xs text-muted-foreground">
                            {t('instantPos.serverTicket', {
                                server: user?.name || (t('instantPos.staffFallback') || 'Staff'),
                                ticket: activeTicket?.number || '--'
                            }) || `Server: ${user?.name || 'Staff'} | Ticket ${activeTicket?.number || '--'}`}
                        </p>
                    </div>
                    {restaurantMode && restaurantTableNumber !== null && (
                        <div className="inline-flex h-12 shrink-0 items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-4 text-sm font-black text-primary">
                            <Table2 className="h-5 w-5" />
                            <span>{t('instantPos.table')} {restaurantTableNumber}</span>
                        </div>
                    )}
                    <StorageSelector
                        storages={instantPosStorages}
                        selectedStorageId={selectedStorageId}
                        onSelect={handleStorageSelect}
                        className="h-12 w-full bg-background/80 sm:w-[220px]"
                    />
                    <UiAccessGate>
                        <div className="flex items-center gap-2 animate-in fade-in zoom-in duration-300">
                            <Button
                                variant="outline"
                                type="button"
                                className="h-12 rounded-xl border-dashed border-primary/50 bg-primary/5 px-4 font-bold"
                                onClick={() => setIsInstantPosAdjustOpen(true)}
                                title={t('instantPos.adjust')}
                            >
                                <Menu className="h-4 w-4 text-primary" />
                                {t('instantPos.adjust')}
                            </Button>
                        </div>
                    </UiAccessGate>
                    <div className="relative min-w-[13rem] flex-1">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={t('instantPos.search') || 'Search menu items...'}
                            className="h-12 pl-10 text-base"
                        />
                    </div>
                    <Button
                        onClick={() => {
                            if (restaurantMode) {
                                returnToRestaurantTableGrid()
                                setActiveTicketId(null)
                                return
                            }
                            createTicket()
                        }}
                        variant="secondary"
                        className="h-12 gap-2 rounded-xl px-4"
                    >
                        {restaurantMode ? <Table2 className="w-4 h-4" /> : <Receipt className="w-4 h-4" />}
                        {restaurantMode ? t('restaurantTables.backToTables') : (t('instantPos.newTicket') || 'New Ticket')}
                    </Button>
                </div>

                {!restaurantMode && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm">
                        <div className="flex max-w-full flex-1 items-center gap-2 overflow-x-auto pb-1 custom-scrollbar">
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
                                            {ticket.tableNumber && (
                                                <span className="rounded-full bg-background/20 px-1.5 py-0.5 text-[10px] font-bold">
                                                    {t('instantPos.table', { defaultValue: 'Table' })} {ticket.tableNumber}
                                                </span>
                                            )}
                                            <span className="text-[10px] uppercase tracking-widest opacity-70">
                                                {statusLabels[ticket.status]}
                                            </span>
                                        </button>
                                    )
                                })
                            )}
                        </div>

                </div>}

                    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none no-scrollbar">
                        <button
                            onClick={() => setSelectedCategory('all')}
                            className={cn(
                                'whitespace-nowrap rounded-full px-6 py-2.5 text-sm font-bold transition-all',
                                selectedCategory === 'all'
                                    ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20'
                                    : 'border border-border bg-card text-muted-foreground'
                            )}
                        >
                            {t('instantPos.allCategories') || 'All Items'}
                        </button>
                        {categories.map(category => (
                            <button
                                key={category.id}
                                onClick={() => setSelectedCategory(category.id)}
                                className={cn(
                                    'whitespace-nowrap rounded-full px-6 py-2.5 text-sm font-bold transition-all',
                                    selectedCategory === category.id
                                        ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20'
                                        : 'border border-border bg-card text-muted-foreground'
                                )}
                            >
                                {category.name}
                            </button>
                        ))}
                        <button
                            onClick={() => setSelectedCategory('none')}
                            className={cn(
                                'whitespace-nowrap rounded-full px-6 py-2.5 text-sm font-bold transition-all',
                                selectedCategory === 'none'
                                    ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20'
                                    : 'border border-border bg-card text-muted-foreground'
                            )}
                        >
                            {t('instantPos.uncategorized') || 'Uncategorized'}
                        </button>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-2">
                        <div
                            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
                            style={{
                                gridTemplateColumns: viewportWidth < 1024
                                    ? undefined
                                    : `repeat(${productsPerRow}, minmax(0, 1fr))`,
                            }}
                        >
                            {filteredProducts.length === 0 ? (
                                <div className="col-span-full text-sm text-muted-foreground">
                                    {!selectedStorageId
                                        ? (t('storages.selectStorage') || 'Select a storage')
                                        : (t('instantPos.noProducts') || 'No products match your search.')}
                                </div>
                            ) : (
                                filteredProducts.map(product => {
                                    const imageUrl = getDisplayImageUrl(product.imageUrl)
                                    const activeDiscount = activeDiscountMap.get(product.id)
                                    const displayPrice = activeDiscount?.discountPrice ?? product.price
                                    const inTicketQuantity = activeTicketQuantityByItemKey.get(
                                        buildInstantPosItemKey(product.id, product.storageId)
                                    ) ?? 0
                                    const service = isService(product)
                                    const remainingQuantity = service ? null : Math.max(0, product.quantity - inTicketQuantity)
                                    const isOutOfStock = !service && remainingQuantity === 0
                                    return (
                                        <button
                                            key={buildInstantPosItemKey(product.id, product.storageId)}
                                            onClick={() => addItemToTicket(product.id)}
                                            disabled={isOutOfStock}
                                            className={cn(
                                                'group relative flex flex-col gap-4 overflow-hidden rounded-[1.5rem] border border-border/50 bg-card p-4 text-left outline-none transition-all duration-300 hover:-translate-y-1 hover:bg-accent/5 hover:shadow-2xl hover:shadow-primary/5',
                                                isOutOfStock && 'cursor-not-allowed opacity-60'
                                            )}
                                        >
                                            <div className="relative aspect-square overflow-hidden rounded-2xl border border-border/20 bg-muted/30">
                                                {imageUrl ? (
                                                    <img
                                                        src={imageUrl}
                                                        alt={product.name}
                                                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
                                                    />
                                                ) : (
                                                    <div className="flex h-full w-full items-center justify-center bg-muted/60">
                                                        <Package className="h-10 w-10 text-muted-foreground/20 transition-transform duration-500 group-hover:scale-110" />
                                                    </div>
                                                )}
                                                {inTicketQuantity > 0 && (
                                                    <div className="absolute left-2 top-2 rounded-2xl border border-emerald-400 bg-emerald-500 px-2.5 py-1.5 text-[12px] font-black text-white shadow-md">
                                                        +{inTicketQuantity}
                                                    </div>
                                                )}
                                                {service ? (
                                                    <div className="absolute right-2 top-2 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-black uppercase text-primary">
                                                        {t('services.badge', { defaultValue: 'Service' })}
                                                    </div>
                                                ) : (
                                                    <div className={cn(
                                                        'absolute right-2 top-2 rounded-2xl px-2.5 py-1.5 text-[12px] font-black shadow-md',
                                                        isOutOfStock
                                                            ? 'bg-destructive text-destructive-foreground'
                                                            : remainingQuantity !== null && remainingQuantity <= (product.minStockLevel || 5)
                                                                ? 'bg-amber-400 text-amber-950'
                                                                : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 backdrop-blur-md'
                                                    )}>
                                                        {remainingQuantity}
                                                    </div>
                                                )}
                                                {activeDiscount && (
                                                    <div className="absolute bottom-2 left-2 rounded-2xl bg-emerald-500 px-2.5 py-1 text-[11px] font-black text-white shadow-md">
                                                        {formatDiscountBadge(activeDiscount, product.currency, features.iqd_display_preference)}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex flex-1 flex-col space-y-2">
                                                <div className="truncate text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/60">
                                                    {product.sku || (service ? t('services.title', { defaultValue: 'Services' }) : '---')}
                                                </div>
                                                <h3 className="line-clamp-2 text-sm font-bold leading-snug text-foreground transition-colors group-hover:text-primary">
                                                    {product.name}
                                                </h3>
                                            </div>
                                            <div className="border-t border-border/40 pt-2">
                                                {activeDiscount ? (
                                                    <div className="space-y-0.5">
                                                        <div className="text-xs font-semibold text-muted-foreground line-through">
                                                            {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                        </div>
                                                        <div className="text-lg font-black text-emerald-600">
                                                            {formatCurrency(displayPrice, product.currency, features.iqd_display_preference)}
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div className="text-lg font-black text-primary">
                                                        {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                    </div>
                                                )}
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
                            canPreprintReceipt={canPreprintReceipt}
                            isPreprinting={isPreprinting}
                            isLoadingPreprintTemplate={isLoadingPreprintTemplate}
                            canCookOrderTicket={canCookOrderTicket}
                            isPrintingCookOrderTicket={isPrintingCookOrderTicket}
                            getStorageLabel={getStorageLabel}
                            checkoutTicket={checkoutTicket}
                            handlePreprintReceipt={handlePreprintReceipt}
                            handleCookOrderTicket={handleCookOrderTicket}
                            setTicketStatus={setTicketStatus}
                            extendPendingExpiry={extendPendingExpiry}
                            clearActiveTicket={clearActiveTicket}
                            updateItemQuantity={updateItemQuantity}
                            setItemQuantity={setItemQuantity}
                            removeItem={removeItem}
                            setNoteItem={setNoteItem}
                            hasTicketNote={Boolean(activeTicket.note?.trim())}
                            openTicketNoteEditor={openTicketNoteEditor}
                            openTablePicker={openTablePicker}
                            closeTicket={closeTicket}
                            hideTableAssignment={restaurantMode}
                            hideItemDelete={hideRestaurantItemDelete}
                            hideCloseTicket={hideRestaurantCloseTicket}
                            hideClearAll={hideRestaurantClearAll}
                        />
                    )}
            </div>

                <aside className="hidden w-[380px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl xl:flex">
                    {!activeTicket ? (
                        <div className="flex h-full flex-col items-center justify-center space-y-2 p-8 text-center text-muted-foreground opacity-60">
                            <ShoppingCart className="h-12 w-12" />
                            <p>{t('instantPos.selectTicket') || 'Select a ticket to begin.'}</p>
                        </div>
                    ) : (
                        <div className="flex h-full flex-col">
                            <div className="border-b border-border bg-muted/5 p-4">
                                <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h2 className="flex items-center gap-2 text-xl font-bold">
                                        <ShoppingCart className="h-5 w-5" />
                                        {t('instantPos.ticketLabel', { number: activeTicket.number }) || `Ticket ${activeTicket.number}`}
                                    </h2>
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        {activeTicket.items.length} {activeTicket.items.length === 1 ? t('common.item') : t('common.items')} · {formatCompactDateTime(activeTicket.createdAt)}
                                    </div>
                                </div>
                                {!hideRestaurantClearAll && (
                                    <button
                                        onClick={clearActiveTicket}
                                        className="text-xs font-semibold text-destructive hover:text-destructive/80"
                                    >
                                        {t('instantPos.clearAll') || 'Clear All'}
                                    </button>
                                )}
                                </div>
                                {!restaurantMode && <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={openTablePicker}
                                    disabled={isCheckoutLoading}
                                    className="mt-3 flex w-full items-center justify-between rounded-lg"
                                >
                                    <span className="flex items-center gap-2">
                                        <Table2 className="h-4 w-4" />
                                        {t('instantPos.table', { defaultValue: 'Table' })}
                                    </span>
                                    <span>{activeTicket.tableNumber || t('instantPos.assignTable', { defaultValue: 'Assign table' })}</span>
                                </Button>}
                            </div>

                            {activePendingTimeLeftMs !== null && (
                                <div className="mx-4 mt-3 flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
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
                                        className="h-8 rounded-lg px-3"
                                    >
                                        {t('instantPos.extendTimeout', { minutes: PENDING_TICKET_EXTENSION_MINUTES }) || `+${PENDING_TICKET_EXTENSION_MINUTES} min`}
                                    </Button>
                                </div>
                            )}

                            <div className="mt-4 space-y-2 px-4">
                                <div className="text-center text-[10px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                                    {t('instantPos.orderStatus') || 'Order Status'}
                                </div>
                                <div className="grid grid-cols-4 gap-2">
                                    {STATUS_FLOW.map(status => (
                                        <button
                                            key={status}
                                            onClick={() => setTicketStatus(status)}
                                            className={cn(
                                                'flex items-center justify-center rounded-lg border px-2 py-1.5 text-center text-[10px] font-semibold uppercase transition',
                                                activeTicket.status === status
                                                    ? 'bg-primary/90 text-primary-foreground shadow-sm'
                                                    : 'border-border/40 bg-muted/30 text-muted-foreground hover:bg-muted/50'
                                            )}
                                        >
                                            {statusLabels[status]}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="mt-4 flex-1 space-y-3 overflow-y-auto p-4 pt-0 custom-scrollbar">
                                {activeTicket.items.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center space-y-2 rounded-lg border border-dashed border-border/60 bg-muted/30 px-4 py-12 text-center text-sm text-muted-foreground">
                                        <ShoppingCart className="h-10 w-10 opacity-50" />
                                        {t('instantPos.emptyTicket') || 'Add items to start this ticket.'}
                                    </div>
                                ) : (
                                    activeTicket.items.map(item => (
                                        <div key={buildInstantPosItemKey(item.productId, item.storageId)} className="group flex flex-col rounded-lg border border-border bg-background p-3 transition-all duration-200">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                        <div className="truncate text-sm font-medium text-foreground">{item.name}</div>
                                                        {item.note && (
                                                            <div className="text-[10px] italic text-primary/80 font-medium">
                                                                --{stylizeText(item.note)}
                                                            </div>
                                                        )}
                                                        <div className="text-xs text-muted-foreground">{item.sku || '---'}</div>
                                                        {getStorageLabel(item.storageId) && (
                                                            <div className="mt-1 inline-flex rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                                                {getStorageLabel(item.storageId)}
                                                            </div>
                                                        )}
                                                </div>
                                                <div className="text-right">
                                                    {item.unitPrice < item.baseUnitPrice && (
                                                        <div className="text-[10px] font-medium text-muted-foreground line-through">
                                                            {formatCurrency(item.baseUnitPrice * item.quantity, item.currency, features.iqd_display_preference)}
                                                        </div>
                                                    )}
                                                    <div className="text-sm font-semibold text-foreground">
                                                        {formatCurrency(item.unitPrice * item.quantity, item.currency, features.iqd_display_preference)}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="mt-3 flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => updateItemQuantity(item.productId, item.storageId, -1)}
                                                        className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted/60"
                                                    >
                                                        <Minus className="h-3 w-3" />
                                                    </button>
                                                    {item.storageId === SERVICES_VIRTUAL_STORAGE_ID && <Input type="number" min="0.001" step="0.001" value={item.quantity} onChange={(event) => setItemQuantity(item.productId, item.storageId, Number(event.target.value))} className="h-7 w-14 border-0 bg-transparent p-0 text-center text-xs" aria-label="Service quantity" />}
                                                    <button
                                                        onClick={() => updateItemQuantity(item.productId, item.storageId, 1)}
                                                        className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted/60"
                                                    >
                                                        <Plus className="h-3 w-3" />
                                                    </button>
                                                    <button
                                                        onClick={() => setNoteItem({ productId: item.productId, storageId: item.storageId, name: item.name, note: item.note || '' })}
                                                        className={cn(
                                                            "flex h-7 items-center justify-center rounded-md border px-2 text-[10px] font-bold uppercase transition",
                                                            item.note ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:bg-muted/60"
                                                        )}
                                                    >
                                                        <StickyNote className="h-3 w-3 mr-1" />
                                                        {t('common.note') || 'Note'}
                                                    </button>
                                                </div>
                                                {!hideRestaurantItemDelete && (
                                                    <button
                                                        onClick={() => removeItem(item.productId, item.storageId)}
                                                        className="ml-1 flex h-7 w-7 items-center justify-center rounded-md border border-destructive/20 bg-destructive/10 text-destructive transition-opacity hover:bg-destructive/20"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>

                            <div className="space-y-3 border-t border-border bg-muted/10 p-4">
                                <div className="flex items-center justify-between text-xs text-muted-foreground">
                                    <span>{t('instantPos.subtotal') || 'Subtotal'}</span>
                                    <span>
                                        {activeTicketTotals.hasMixedCurrency
                                            ? '--'
                                            : formatCurrency(activeTicketTotals.total, settlementCurrency, features.iqd_display_preference)}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between border-t border-border/50 pt-1 text-xl font-bold text-primary">
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

                            <div className="flex flex-col gap-2 px-4 pb-4">
                                <div className={cn('flex gap-2', !statusAction && 'justify-end')}>
                                    {statusAction && (
                                        <Button
                                            onClick={() => setTicketStatus(statusAction.status)}
                                            variant="secondary"
                                            className="h-11 flex-1 rounded-xl"
                                        >
                                            {statusAction.label}
                                        </Button>
                                    )}
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className={cn(
                                            'h-11 w-11 rounded-xl border-2',
                                            activeTicket.note?.trim() && 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/15'
                                        )}
                                        onClick={openTicketNoteEditor}
                                        disabled={isCheckoutLoading}
                                        title={t('instantPos.addTicketNote', { defaultValue: 'Add Note' })}
                                        aria-label={t('instantPos.addTicketNote', { defaultValue: 'Add Note' })}
                                    >
                                        <StickyNote className="h-4 w-4" />
                                    </Button>
                                </div>
                                <div className="flex gap-2">
                                    {canCookOrderTicket && (
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className="h-11 w-11 rounded-xl border-2"
                                            onClick={() => void handleCookOrderTicket()}
                                            disabled={isCheckoutLoading || isPreprinting || isPrintingCookOrderTicket}
                                            title={t('instantPos.cookOrderTicket', { defaultValue: 'Cook Order Ticket' })}
                                            aria-label={t('instantPos.cookOrderTicket', { defaultValue: 'Cook Order Ticket' })}
                                        >
                                            {isPrintingCookOrderTicket
                                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                                : <ChefHat className="h-4 w-4" />}
                                        </Button>
                                    )}
                                    <Button
                                        className="h-11 flex-1 rounded-xl"
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
                                    {canPreprintReceipt && (
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className="h-11 w-11 rounded-xl border-2"
                                            onClick={() => void handlePreprintReceipt()}
                                            disabled={isCheckoutLoading || isPreprinting || isPrintingCookOrderTicket || isLoadingPreprintTemplate}
                                            title={t('pos.preprintReceipt', { defaultValue: 'Pre-print receipt' })}
                                            aria-label={t('pos.preprintReceipt', { defaultValue: 'Pre-print receipt' })}
                                        >
                                            {isPreprinting || isLoadingPreprintTemplate
                                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                                : <Receipt className="h-4 w-4" />}
                                        </Button>
                                    )}
                                </div>
                                {!hideRestaurantCloseTicket && (
                                    <Button
                                        variant="outline"
                                        onClick={() => closeTicket(activeTicket.id)}
                                        disabled={isCheckoutLoading}
                                        className="h-11 w-full rounded-xl"
                                    >
                                        {t('instantPos.closeTicket') || 'Close Ticket'}
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}
                </aside>

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
                        <Button onClick={() => noteItem && updateItemNote(noteItem.productId, noteItem.storageId, noteItem.note)}>
                            {t('common.save') || 'Save Note'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AppDialog open={!!ticketNoteEditor} onOpenChange={(open) => !open && setTicketNoteEditor(null)}>
                <AppDialogContent className="max-w-lg">
                    <AppDialogHeader>
                        <AppDialogTitle>{t('instantPos.ticketNotes', { defaultValue: 'Ticket Notes' })}</AppDialogTitle>
                    </AppDialogHeader>
                    <AppDialogBody>
                        <div className="space-y-2">
                            <label htmlFor="instant-pos-ticket-note" className="text-sm font-medium">
                                {t('common.notes', { defaultValue: 'Notes' })}
                            </label>
                            <Textarea
                                id="instant-pos-ticket-note"
                                autoFocus
                                value={ticketNoteEditor?.note || ''}
                                onChange={(event) => setTicketNoteEditor((current) => current
                                    ? { ...current, note: event.target.value }
                                    : current)}
                                placeholder={t('instantPos.ticketNotePlaceholder', { defaultValue: 'Add a note for this ticket...' })}
                                className="min-h-28"
                            />
                        </div>
                    </AppDialogBody>
                    <AppDialogFooter>
                        <Button variant="outline" onClick={() => setTicketNoteEditor(null)}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button onClick={saveTicketNote}>
                            {t('common.save', { defaultValue: 'Save' })}
                        </Button>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>

            <Dialog open={isTablePickerOpen} onOpenChange={setIsTablePickerOpen}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>{t('instantPos.assignTable', { defaultValue: 'Assign table' })}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <Input
                            autoFocus
                            inputMode="numeric"
                            maxLength={4}
                            value={tableNumberInput}
                            onChange={(event) => setTableNumberInput(event.target.value.replace(/\D/g, ''))}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') applyTableNumber(tableNumberInput)
                            }}
                            placeholder={t('instantPos.tableNumberPlaceholder', { defaultValue: 'Enter table number' })}
                        />
                        <div className="grid grid-cols-5 gap-2">
                            {TABLE_NUMBER_PRESETS.map((tableNumber) => (
                                <Button
                                    key={tableNumber}
                                    type="button"
                                    variant={tableNumberInput === tableNumber ? 'default' : 'outline'}
                                    className="h-10"
                                    onClick={() => {
                                        setTableNumberInput(tableNumber)
                                        applyTableNumber(tableNumber)
                                    }}
                                >
                                    {tableNumber}
                                </Button>
                            ))}
                        </div>
                    </div>
                    <DialogFooter className="gap-2 sm:justify-between">
                        <Button
                            variant="ghost"
                            onClick={clearTableNumber}
                            disabled={!activeTicket?.tableNumber}
                        >
                            {t('instantPos.clearTable', { defaultValue: 'Clear table' })}
                        </Button>
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={() => setIsTablePickerOpen(false)}>
                                {t('common.cancel') || 'Cancel'}
                            </Button>
                            <Button onClick={() => applyTableNumber(tableNumberInput)}>
                                {t('common.save') || 'Save'}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={!!restaurantTicketToClose}
                onClose={() => !isRestaurantTicketClosing && setRestaurantTicketToClose(null)}
                onConfirm={() => void confirmRestaurantTicketClose()}
                isLoading={isRestaurantTicketClosing}
                title={t('restaurantTables.closeTitle')}
                description={t('restaurantTables.closeDescription')}
                simpleConfirmation
                itemName={restaurantTicketToClose
                    ? `${t('instantPos.table')} ${restaurantTicketToClose.tableNumber}`
                    : ''}
            />

            <InstantPosAdjust
                open={isInstantPosAdjustOpen}
                onOpenChange={setIsInstantPosAdjustOpen}
                productsPerRow={productsPerRow}
                onProductsPerRowChange={setProductsPerRow}
            />

            <CheckoutSuccessModal
                isOpen={isSuccessModalOpen}
                onClose={() => {
                    setIsSuccessModalOpen(false)
                    setCompletedSaleData(null)
                }}
                saleData={completedSaleData}
                features={features}
                receiptTemplateKey={INSTANT_HISTORY_RECEIPT_TEMPLATE_KEY}
            />
        </div>
    )
}
