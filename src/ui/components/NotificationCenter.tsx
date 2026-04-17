import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { Archive, Bell, CheckCheck, ExternalLink, Inbox, Info, Package, ShieldAlert } from 'lucide-react'
import { useLocation } from 'wouter'
import { useAuth } from '@/auth'
import { useTranslation } from 'react-i18next'
import { toast } from '@/ui/components/use-toast'
import { connectionManager } from '@/lib/connectionManager'
import { cn } from '@/lib/utils'
import { isMobile, isTauri } from '@/lib/platform'
import { useTheme } from './theme-provider'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './button'
import { Tabs, TabsList, TabsTrigger } from './tabs'
import {
    listNotificationInbox,
    markAllNotificationInboxRead,
    markNotificationInboxArchived,
    markNotificationInboxRead,
    normalizeNotificationInboxRow,
    subscribeToNotificationInbox,
    type NotificationInboxRecord,
} from '@/services/notificationInbox'

let trackedInboxKey = ''
let hasPrimedInbox = false
const seenInboxNotificationIds = new Set<string>()

type NotificationTab = 'all' | 'unread' | 'archived'
type NotificationAction = { label: string; url: string }

type BellButtonProps = ComponentPropsWithoutRef<'button'> & {
    unreadCount: number
    style: string
}

function syncInboxTracker(nextKey: string) {
    if (trackedInboxKey === nextKey) return
    trackedInboxKey = nextKey
    hasPrimedInbox = false
    seenInboxNotificationIds.clear()
}

function rememberInboxNotifications(items: NotificationInboxRecord[]) {
    for (const item of items) seenInboxNotificationIds.add(item.id)
}

function playNotificationSound() {
    try {
        const ctx = new AudioContext()
        const now = ctx.currentTime
        const osc1 = ctx.createOscillator()
        const gain1 = ctx.createGain()
        osc1.type = 'sine'
        osc1.frequency.setValueAtTime(830, now)
        gain1.gain.setValueAtTime(0.15, now)
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15)
        osc1.connect(gain1).connect(ctx.destination)
        osc1.start(now)
        osc1.stop(now + 0.15)
        const osc2 = ctx.createOscillator()
        const gain2 = ctx.createGain()
        osc2.type = 'sine'
        osc2.frequency.setValueAtTime(1050, now + 0.12)
        gain2.gain.setValueAtTime(0.001, now)
        gain2.gain.setValueAtTime(0.15, now + 0.12)
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3)
        osc2.connect(gain2).connect(ctx.destination)
        osc2.start(now + 0.12)
        osc2.stop(now + 0.3)
        setTimeout(() => void ctx.close(), 500)
    } catch {
        // Audio not available
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown) {
    return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function mergeNotification(items: NotificationInboxRecord[], nextItem: NotificationInboxRecord) {
    const remaining = items.filter((item) => item.id !== nextItem.id)
    return [nextItem, ...remaining].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
}

function formatNotificationTypeLabel(notificationType: string) {
    return notificationType
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
}

function formatNotificationTime(timestamp: string, locale: string) {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return ''
    const diffMs = date.getTime() - Date.now()
    const absSeconds = Math.abs(diffMs) / 1000
    const rtf = new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto' })
    if (absSeconds < 60) return rtf.format(Math.round(diffMs / 1000), 'second')
    if (absSeconds < 3600) return rtf.format(Math.round(diffMs / 60000), 'minute')
    if (absSeconds < 86400) return rtf.format(Math.round(diffMs / 3600000), 'hour')
    if (absSeconds < 604800) return rtf.format(Math.round(diffMs / 86400000), 'day')
    return new Intl.DateTimeFormat(locale || 'en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

function buildNotificationPreview(item: NotificationInboxRecord, locale: string) {
    const body = readString(item.body)
    if (body) return body
    const payload = item.payload
    const summary = readString(payload.summary) || readString(payload.preview) || readString(payload.content) || readString(payload.message)
    if (summary) return summary
    if (item.notification_type === 'marketplace_order_pending') {
        const customerName = readString(payload.customer_name)
        const itemCount = readNumber(payload.item_count)
        const amount = readNumber(payload.amount)
        const currency = readString(payload.currency).toUpperCase()
        const parts: string[] = []
        if (customerName) parts.push(customerName)
        if (itemCount !== null && itemCount > 0) parts.push(`${itemCount} item${itemCount === 1 ? '' : 's'}`)
        if (amount !== null) {
            const formattedAmount = new Intl.NumberFormat(locale || 'en', { maximumFractionDigits: 2 }).format(amount)
            parts.push(currency ? `${formattedAmount} ${currency}` : formattedAmount)
        }
        if (parts.length > 0) return parts.join(' • ')
    }
    return readString(payload.order_number) || readString(payload.entity_type)
}

function getNotificationActions(item: NotificationInboxRecord): NotificationAction[] {
    const payloadActions = item.payload.actions
    const actions: NotificationAction[] = []
    if (Array.isArray(payloadActions)) {
        for (const entry of payloadActions.slice(0, 2)) {
            if (!isRecord(entry)) continue
            const label = readString(entry.label)
            const url = readString(entry.url) || readString(entry.href) || readString(entry.route)
            if (label && url) actions.push({ label, url })
        }
    }
    if (actions.length > 0) return actions
    const fallbackUrl = readString(item.action_url) || readString(item.payload.route)
    return fallbackUrl ? [{ label: readString(item.action_label) || 'Open', url: fallbackUrl }] : []
}

function getNotificationIcon(item: NotificationInboxRecord) {
    if (item.priority === 'urgent' || item.priority === 'high') return ShieldAlert
    if (item.notification_type.includes('marketplace') || item.notification_type.includes('order')) return Package
    return Info
}

const BellButton = forwardRef<HTMLButtonElement, BellButtonProps>(function BellButton({ unreadCount, style, className, type = 'button', ...props }, ref) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(
                'relative transition-colors cursor-pointer mr-1 p-1.5',
                style === 'neo-orange' ? 'neo-indicator' : 'hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground',
                className,
            )}
            {...props}
        >
            <Bell className="w-4 h-4 transition-transform active:scale-90" />
            {unreadCount > 0 && (
                <span className={cn(
                    'absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center text-[9px] font-bold text-white border-2 border-background animate-pop-in shadow-lg',
                    style === 'neo-orange' ? 'rounded-none bg-black border-white' : 'rounded-full bg-red-500',
                )}>
                    {unreadCount > 9 ? '9+' : unreadCount}
                </span>
            )}
        </button>
    )
})

export function NotificationCenter() {
    const { user, isLoading } = useAuth()
    const { t, i18n } = useTranslation()
    const { style } = useTheme()
    const [, setLocation] = useLocation()
    const [open, setOpen] = useState(false)
    const [tab, setTab] = useState<NotificationTab>('all')
    const [items, setItems] = useState<NotificationInboxRecord[]>([])
    const [isSyncing, setIsSyncing] = useState(false)
    const [syncError, setSyncError] = useState<string | null>(null)
    const refreshRequestRef = useRef(0)
    const trackerKey = `${user?.id ?? ''}:${user?.workspaceId ?? ''}`

    useEffect(() => {
        syncInboxTracker(trackerKey)
        if (!trackerKey) {
            setItems([])
            setSyncError(null)
        }
    }, [trackerKey])

    const showNotificationToast = useCallback((count: number) => {
        playNotificationSound()
        toast({
            title: count > 1 ? t('notifications.newNotificationsTitle', { defaultValue: 'New Notifications' }) : t('notifications.newNotificationTitle', { defaultValue: 'New Notification' }),
            description: count > 1 ? `${count} ${t('notifications.newNotifications', { defaultValue: 'new notifications' })}` : t('notifications.newNotification', { defaultValue: 'You have a new notification' }),
            duration: 4000,
        })
    }, [t])

    const sendDesktopNotification = useCallback(async (item: NotificationInboxRecord) => {
        if (!isTauri() || isMobile()) return
        try {
            const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')
            let permission = await isPermissionGranted()
            if (!permission) permission = (await requestPermission()) === 'granted'
            if (!permission) return
            sendNotification({
                title: item.title || t('notifications.newNotificationTitle', { defaultValue: 'New Notification' }),
                body: buildNotificationPreview(item, i18n.language) || t('notifications.newNotification', { defaultValue: 'You have a new notification' }),
            })
        } catch (error) {
            console.warn('[NotificationCenter] Failed to show desktop notification:', error)
        }
    }, [i18n.language, t])

    const announceNewNotifications = useCallback((nextItems: NotificationInboxRecord[]) => {
        const freshItems = nextItems.filter((item) => !item.archived_at && !seenInboxNotificationIds.has(item.id))
        if (freshItems.length === 0) return
        for (const item of freshItems) seenInboxNotificationIds.add(item.id)
        showNotificationToast(freshItems.length)
        void sendDesktopNotification(freshItems[0])
    }, [sendDesktopNotification, showNotificationToast])

    const applyInboxSnapshot = useCallback((nextItems: NotificationInboxRecord[]) => {
        syncInboxTracker(trackerKey)
        setItems(nextItems)
        if (!trackerKey) return
        if (!hasPrimedInbox) {
            rememberInboxNotifications(nextItems)
            hasPrimedInbox = true
            return
        }
        announceNewNotifications(nextItems)
    }, [announceNewNotifications, trackerKey])

    const refreshInbox = useCallback(async () => {
        if (!user?.id) {
            setItems([])
            setSyncError(null)
            return
        }
        const requestId = ++refreshRequestRef.current
        setIsSyncing(true)
        const { data, error } = await listNotificationInbox(200)
        if (requestId !== refreshRequestRef.current) return
        if (error) {
            console.error('[NotificationCenter] Failed to load inbox:', error)
            setSyncError(error.message)
            setIsSyncing(false)
            return
        }
        setSyncError(null)
        applyInboxSnapshot(data)
        setIsSyncing(false)
    }, [applyInboxSnapshot, user?.id])

    useEffect(() => {
        if (!user?.id) return
        void refreshInbox()
        const unsubscribeRealtime = subscribeToNotificationInbox(user.id, (payload) => {
            if (payload.eventType === 'INSERT' && payload.new) {
                const nextItem = normalizeNotificationInboxRow(payload.new as NotificationInboxRecord)
                setItems((currentItems) => mergeNotification(currentItems, nextItem))
                if (!hasPrimedInbox) {
                    seenInboxNotificationIds.add(nextItem.id)
                    return
                }
                if (!nextItem.archived_at && !seenInboxNotificationIds.has(nextItem.id)) {
                    seenInboxNotificationIds.add(nextItem.id)
                    showNotificationToast(1)
                    void sendDesktopNotification(nextItem)
                }
                return
            }
            void refreshInbox()
        })
        const unsubscribeConnection = connectionManager.subscribe((event) => {
            if (event === 'wake' || event === 'online') void refreshInbox()
        })
        return () => {
            unsubscribeRealtime()
            unsubscribeConnection()
        }
    }, [refreshInbox, sendDesktopNotification, showNotificationToast, user?.id])

    const navigateToUrl = useCallback((url: string) => {
        if (/^https?:\/\//i.test(url)) {
            window.open(url, '_blank', 'noopener,noreferrer')
            return
        }
        setLocation(url)
    }, [setLocation])

    const mutateNotification = useCallback((notificationId: string, patch: Partial<NotificationInboxRecord>) => {
        setItems((currentItems) => currentItems.map((item) => item.id === notificationId ? { ...item, ...patch } : item))
    }, [])

    const handleMarkRead = useCallback(async (item: NotificationInboxRecord, read = true) => {
        mutateNotification(item.id, { read_at: read ? (item.read_at ?? new Date().toISOString()) : null })
        const { error } = await markNotificationInboxRead(item.id, read)
        if (error) {
            console.error('[NotificationCenter] Failed to update read state:', error)
            void refreshInbox()
        }
    }, [mutateNotification, refreshInbox])

    const handleArchive = useCallback(async (item: NotificationInboxRecord, archived = true) => {
        mutateNotification(item.id, { archived_at: archived ? (item.archived_at ?? new Date().toISOString()) : null })
        const { error } = await markNotificationInboxArchived(item.id, archived)
        if (error) {
            console.error('[NotificationCenter] Failed to update archive state:', error)
            void refreshInbox()
        }
    }, [mutateNotification, refreshInbox])

    const handleMarkAllRead = useCallback(async () => {
        const timestamp = new Date().toISOString()
        setItems((currentItems) => currentItems.map((item) => item.archived_at || item.read_at ? item : { ...item, read_at: timestamp }))
        const { error } = await markAllNotificationInboxRead()
        if (error) {
            console.error('[NotificationCenter] Failed to mark all notifications as read:', error)
            void refreshInbox()
        }
    }, [refreshInbox])

    const handleOpenNotification = useCallback((item: NotificationInboxRecord, actionUrl?: string) => {
        if (!item.read_at) void handleMarkRead(item, true)
        const targetUrl = actionUrl || readString(item.action_url) || readString(item.payload.route)
        if (!targetUrl) return
        setOpen(false)
        navigateToUrl(targetUrl)
    }, [handleMarkRead, navigateToUrl])

    const activeItems = useMemo(() => items.filter((item) => !item.archived_at), [items])
    const unreadItems = useMemo(() => activeItems.filter((item) => !item.read_at), [activeItems])
    const archivedItems = useMemo(() => items.filter((item) => Boolean(item.archived_at)), [items])
    const visibleItems = useMemo(() => tab === 'unread' ? unreadItems : tab === 'archived' ? archivedItems : activeItems, [activeItems, archivedItems, tab, unreadItems])
    const unreadCount = unreadItems.length

    if (isLoading) {
        return <button className="relative p-2 rounded-md text-muted-foreground animate-pulse" type="button"><Bell className="w-4 h-4" /></button>
    }

    if (!user?.id) {
        return <button className="relative hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground cursor-pointer mr-1 opacity-50" title={t('notifications.waitingSession', { defaultValue: 'Waiting for user session...' })} type="button"><Bell className="w-4 h-4" /></button>
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild><BellButton unreadCount={unreadCount} style={style} /></PopoverTrigger>
            <PopoverContent align="end" side="bottom" sideOffset={10} className="w-[440px] max-w-[calc(100vw-1rem)] border-none bg-transparent p-0 shadow-none">
                <div className="overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
                    <Tabs value={tab} onValueChange={(value) => setTab(value as NotificationTab)} className="flex flex-col">
                        <div className="border-b border-border/70 px-4 py-4">
                            <div className="flex items-start justify-between gap-3">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2"><Inbox className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">{t('notifications.title', { defaultValue: 'Notifications' })}</h3>{isSyncing && <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />}</div>
                                    <p className="text-xs text-muted-foreground">{unreadCount > 0 ? `${unreadCount} ${t('notifications.unread', { defaultValue: 'unread' })}` : t('notifications.allCaughtUp', { defaultValue: 'You are all caught up' })}</p>
                                </div>
                                <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => void handleMarkAllRead()} disabled={unreadCount === 0}><CheckCheck className="h-3.5 w-3.5" />{t('notifications.markAllRead', { defaultValue: 'Mark all read' })}</Button>
                            </div>
                            <TabsList className="mt-4 grid w-full grid-cols-3 rounded-xl bg-muted/60 p-1">
                                <TabsTrigger value="all" className="rounded-lg text-xs font-bold uppercase tracking-wide">{t('notifications.tabs.all', { defaultValue: 'All' })}<span className="ml-1.5 text-[10px] opacity-70">{activeItems.length}</span></TabsTrigger>
                                <TabsTrigger value="unread" className="rounded-lg text-xs font-bold uppercase tracking-wide">{t('notifications.tabs.unread', { defaultValue: 'Unread' })}<span className="ml-1.5 text-[10px] opacity-70">{unreadItems.length}</span></TabsTrigger>
                                <TabsTrigger value="archived" className="rounded-lg text-xs font-bold uppercase tracking-wide">{t('notifications.tabs.archived', { defaultValue: 'Archived' })}<span className="ml-1.5 text-[10px] opacity-70">{archivedItems.length}</span></TabsTrigger>
                            </TabsList>
                        </div>
                        <div className="max-h-[560px] overflow-y-auto p-3">
                            {syncError && visibleItems.length === 0 && <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"><div className="font-semibold">{t('notifications.error', { defaultValue: 'Failed to load notifications' })}</div><div className="mt-1 text-xs opacity-90">{syncError}</div><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void refreshInbox()}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button></div>}
                            {!syncError && isSyncing && items.length === 0 && <div className="space-y-3">{[0, 1, 2].map((index) => <div key={index} className="rounded-2xl border border-border/60 p-4 animate-pulse"><div className="h-3 w-1/3 rounded bg-muted" /><div className="mt-3 h-4 w-3/4 rounded bg-muted" /><div className="mt-2 h-3 w-1/2 rounded bg-muted" /></div>)}</div>}
                            {!isSyncing && visibleItems.length === 0 && <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 px-6 py-12 text-center"><Inbox className="h-10 w-10 text-muted-foreground/60" /><div className="mt-4 text-sm font-semibold">{tab === 'archived' ? t('notifications.emptyArchived', { defaultValue: 'No archived notifications' }) : tab === 'unread' ? t('notifications.emptyUnread', { defaultValue: 'No unread notifications' }) : t('notifications.empty', { defaultValue: 'No notifications yet' })}</div><div className="mt-1 text-xs text-muted-foreground">{tab === 'archived' ? t('notifications.emptyArchivedHint', { defaultValue: 'Archived items will stay here until you restore them.' }) : t('notifications.emptyHint', { defaultValue: 'New workspace activity will appear here.' })}</div></div>}
                            <div className="space-y-3">
                                {visibleItems.map((item) => {
                                    const Icon = getNotificationIcon(item)
                                    const preview = buildNotificationPreview(item, i18n.language)
                                    const actions = getNotificationActions(item)
                                    const timeLabel = formatNotificationTime(item.created_at, i18n.language)
                                    const typeLabel = formatNotificationTypeLabel(item.notification_type)
                                    return <div key={item.id} role="button" tabIndex={0} onClick={() => handleOpenNotification(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleOpenNotification(item) } }} className={cn('group rounded-2xl border p-4 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40', item.read_at ? 'border-border/70 bg-background hover:bg-muted/40' : 'border-primary/20 bg-primary/5 shadow-sm shadow-primary/10 hover:bg-primary/10')}>
                                        <div className="flex items-start gap-3">
                                            <div className={cn('mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border', item.priority === 'high' || item.priority === 'urgent' ? 'border-amber-500/30 bg-amber-500/10 text-amber-600' : 'border-primary/20 bg-primary/10 text-primary')}><Icon className="h-4 w-4" /></div>
                                            <div className="min-w-0 flex-1 space-y-2">
                                                <div className="flex items-start justify-between gap-3"><div className="space-y-1"><div className="flex items-center gap-2"><span className="text-sm font-semibold leading-none text-foreground">{item.title}</span>{!item.read_at && <span className="h-2 w-2 rounded-full bg-primary" />}</div>{preview && <p className="line-clamp-2 text-xs text-muted-foreground">{preview}</p>}</div>{timeLabel && <span className="shrink-0 text-[11px] text-muted-foreground">{timeLabel}</span>}</div>
                                                <div className="flex flex-wrap items-center gap-2"><span className="inline-flex rounded-full border border-border/70 bg-muted/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{typeLabel}</span>{item.scope !== 'user' && <span className="inline-flex rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{item.scope}</span>}</div>
                                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                                    {actions.map((action) => <Button key={`${item.id}-${action.url}`} type="button" variant="outline" size="sm" className="h-8 rounded-xl text-[11px] font-semibold" onClick={(event) => { event.stopPropagation(); handleOpenNotification(item, action.url) }}><ExternalLink className="h-3.5 w-3.5" />{action.label}</Button>)}
                                                    {!item.read_at && <Button type="button" variant="ghost" size="sm" className="h-8 rounded-xl text-[11px] font-semibold" onClick={(event) => { event.stopPropagation(); void handleMarkRead(item, true) }}><CheckCheck className="h-3.5 w-3.5" />{t('notifications.markRead', { defaultValue: 'Mark read' })}</Button>}
                                                    <Button type="button" variant="ghost" size="sm" className="h-8 rounded-xl text-[11px] font-semibold" onClick={(event) => { event.stopPropagation(); void handleArchive(item, !item.archived_at) }}><Archive className="h-3.5 w-3.5" />{item.archived_at ? t('notifications.restore', { defaultValue: 'Restore' }) : t('notifications.archive', { defaultValue: 'Archive' })}</Button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                })}
                            </div>
                        </div>
                    </Tabs>
                </div>
            </PopoverContent>
        </Popover>
    )
}
