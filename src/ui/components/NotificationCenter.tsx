import { forwardRef, useCallback, useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import { Archive, Bell, CheckCheck, ExternalLink, Inbox, Info, Loader2, Package, Search, Settings, ShieldAlert } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/auth'
import { usePaginationBounds, usePaginationPageMap } from '@/hooks/usePaginationState'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { toast } from '@/ui/components/use-toast'
import { connectionManager } from '@/lib/connectionManager'
import { useHashLocation } from '@/hooks/useHashLocation'
import { localizeNotification, type NotificationLocalizationResult } from '@/lib/notificationLocalization'
import { cn } from '@/lib/utils'
import { isMobile, isTauri } from '@/lib/platform'
import { queryKeys } from '@/query/queryKeys'
import { useNotificationInboxPage, type NotificationInboxTab } from '@/local-db/notificationInbox'
import { useTheme } from './theme-provider'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './button'
import { Tabs, TabsList, TabsTrigger } from './tabs'
import { AppPagination } from './AppPagination'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog'
import { Label } from './label'
import { Switch } from './switch'
import { WORKSPACE_NOTIFICATION_TYPES, type WorkspaceNotificationType } from '@/lib/notificationTypes'
import {
    listDisabledWorkspaceNotificationTypes,
    setWorkspaceNotificationTypeDisabled,
} from '@/services/notificationSettings'
import {
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
const MAX_SEEN_INBOX_NOTIFICATION_IDS = 500
const NOTIFICATION_PAGE_SIZE_OPTIONS = [5, 10, 20, 50]
const NOTIFICATION_PAGE_SIZE_STORAGE_KEY = 'notification_inbox_page_size'
const INITIAL_NOTIFICATION_PAGES: Record<NotificationInboxTab, number> = {
    all: 1,
    unread: 1,
    archived: 1,
}

type NotificationAction = { label: string; url: string }

function readNotificationPageSize() {
    try {
        const storedPageSize = Number(window.localStorage.getItem(NOTIFICATION_PAGE_SIZE_STORAGE_KEY))
        return NOTIFICATION_PAGE_SIZE_OPTIONS.includes(storedPageSize) ? storedPageSize : 10
    } catch {
        return 10
    }
}

function persistNotificationPageSize(pageSize: number) {
    try {
        window.localStorage.setItem(NOTIFICATION_PAGE_SIZE_STORAGE_KEY, String(pageSize))
    } catch {
        // The in-memory preference still applies when storage is unavailable.
    }
}

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
    for (const item of items) rememberInboxNotification(item.id)
}

function rememberInboxNotification(notificationId: string) {
    seenInboxNotificationIds.add(notificationId)
    while (seenInboxNotificationIds.size > MAX_SEEN_INBOX_NOTIFICATION_IDS) {
        const oldestId = seenInboxNotificationIds.values().next().value
        if (!oldestId) break
        seenInboxNotificationIds.delete(oldestId)
    }
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

function localizeInboxNotification(item: NotificationInboxRecord, language: string): NotificationLocalizationResult {
    return localizeNotification({
        notificationType: item.notification_type,
        payload: item.payload,
        title: item.title,
        body: item.body,
        actionUrl: item.action_url,
        actionLabel: item.action_label,
    }, language)
}

function getNotificationActions(item: NotificationInboxRecord, localized: NotificationLocalizationResult): NotificationAction[] {
    if (item.notification_type === 'beauty3_appointment_reminder') {
        return [{
            label: localized.actionLabel,
            url: `/clinical-appointments/appointment-reminders/${encodeURIComponent(item.id)}`,
        }]
    }

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
    const fallbackUrl = localized.actionUrl || readString(item.action_url) || readString(item.payload.route)
    return fallbackUrl ? [{ label: localized.actionLabel, url: fallbackUrl }] : []
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
    const [, setLocation] = useHashLocation()
    const queryClient = useQueryClient()
    const [open, setOpen] = useState(false)
    const [tab, setTab] = useState<NotificationInboxTab>('all')
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [disabledTypes, setDisabledTypes] = useState<Set<WorkspaceNotificationType>>(() => new Set())
    const [settingsLoading, setSettingsLoading] = useState(false)
    const [settingsError, setSettingsError] = useState<string | null>(null)
    const [settingsSavingType, setSettingsSavingType] = useState<WorkspaceNotificationType | null>(null)
    const [inboxCounts, setInboxCounts] = useState({
        trackerKey: '',
        activeCount: 0,
        unreadCount: 0,
        archivedCount: 0,
    })
    const [initialPageSize] = useState(readNotificationPageSize)
    const isLocalMode = user?.workspaceMode === 'local' || user?.workspaceMode === 'demo'
    const isAdmin = user?.role === 'admin'
    const trackerKey = isLocalMode ? '' : `${user?.id ?? ''}:${user?.workspaceId ?? ''}`
    const pagination = usePaginationPageMap({
        initialPages: INITIAL_NOTIFICATION_PAGES,
        initialPageSize,
        resetOn: [trackerKey],
        onPageSizeChange: persistNotificationPageSize,
    })
    const currentPage = pagination.pages[tab] ?? 1
    const pageQuery = useNotificationInboxPage({
        workspaceId: user?.workspaceId ?? '',
        userId: user?.id ?? '',
        tab,
        page: currentPage,
        pageSize: pagination.pageSize,
    }, Boolean(user?.id && user?.workspaceId && !isLocalMode))
    const activeCount = inboxCounts.trackerKey === trackerKey ? inboxCounts.activeCount : 0
    const unreadCount = inboxCounts.trackerKey === trackerKey ? inboxCounts.unreadCount : 0
    const archivedCount = inboxCounts.trackerKey === trackerKey ? inboxCounts.archivedCount : 0
    const selectedTabCount = tab === 'unread' ? unreadCount : tab === 'archived' ? archivedCount : activeCount
    const setAllPage = useCallback((page: number | ((currentPage: number) => number)) => {
        pagination.setPage('all', page)
    }, [pagination.setPage])
    const setUnreadPage = useCallback((page: number | ((currentPage: number) => number)) => {
        pagination.setPage('unread', page)
    }, [pagination.setPage])
    const setArchivedPage = useCallback((page: number | ((currentPage: number) => number)) => {
        pagination.setPage('archived', page)
    }, [pagination.setPage])
    const allPageBounds = usePaginationBounds({
        currentPage: pagination.pages.all,
        setCurrentPage: setAllPage,
        totalCount: tab === 'all' ? pageQuery.data?.totalCount ?? activeCount : activeCount,
        pageSize: pagination.pageSize,
        isLoading: tab !== 'all' || pageQuery.isFetching || pageQuery.isPending,
        error: tab === 'all' ? pageQuery.error : null,
    })
    const unreadPageBounds = usePaginationBounds({
        currentPage: pagination.pages.unread,
        setCurrentPage: setUnreadPage,
        totalCount: tab === 'unread' ? pageQuery.data?.totalCount ?? unreadCount : unreadCount,
        pageSize: pagination.pageSize,
        isLoading: tab !== 'unread' || pageQuery.isFetching || pageQuery.isPending,
        error: tab === 'unread' ? pageQuery.error : null,
    })
    const archivedPageBounds = usePaginationBounds({
        currentPage: pagination.pages.archived,
        setCurrentPage: setArchivedPage,
        totalCount: tab === 'archived' ? pageQuery.data?.totalCount ?? archivedCount : archivedCount,
        pageSize: pagination.pageSize,
        isLoading: tab !== 'archived' || pageQuery.isFetching || pageQuery.isPending,
        error: tab === 'archived' ? pageQuery.error : null,
    })
    const paginationBounds = tab === 'unread' ? unreadPageBounds : tab === 'archived' ? archivedPageBounds : allPageBounds
    const setCurrentPage = tab === 'unread' ? setUnreadPage : tab === 'archived' ? setArchivedPage : setAllPage
    const isPageClamping = currentPage !== paginationBounds.currentPage
    const visibleItems = isPageClamping ? [] : (pageQuery.data?.items ?? [])
    const isSyncing = pageQuery.isFetching
    const syncError = pageQuery.isError ? t('notifications.loadFailed', { defaultValue: 'Could not load notifications. Please try again.' }) : null

    const invalidateInbox = useCallback(() => queryClient.invalidateQueries({
        queryKey: queryKeys.notificationInbox.all(user?.workspaceId, user?.id),
    }), [queryClient, user?.id, user?.workspaceId])

    useEffect(() => {
        syncInboxTracker(trackerKey)
        setInboxCounts({ trackerKey, activeCount: 0, unreadCount: 0, archivedCount: 0 })
    }, [trackerKey])

    useEffect(() => {
        if (!pageQuery.data || !trackerKey) return
        setInboxCounts({
            trackerKey,
            activeCount: pageQuery.data.activeCount,
            unreadCount: pageQuery.data.unreadCount,
            archivedCount: pageQuery.data.archivedCount,
        })
    }, [pageQuery.data, trackerKey])

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
            const localized = localizeInboxNotification(item, i18n.language)
            const title = localized.title || t('notifications.newNotificationTitle', { defaultValue: 'New Notification' })
            const body = localized.body || t('notifications.newNotification', { defaultValue: 'You have a new notification' })

            if (/Windows/i.test(navigator.userAgent)) {
                await invoke('show_atlas_desktop_notification', { title, body })
                return
            }

            const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification')
            let permission = await isPermissionGranted()
            if (!permission) permission = (await requestPermission()) === 'granted'
            if (!permission) return
            sendNotification({ title, body })
        } catch (error) {
            console.warn('[NotificationCenter] Failed to show desktop notification:', error)
        }
    }, [i18n.language, t])

    const announceNewNotifications = useCallback((nextItems: NotificationInboxRecord[]) => {
        const freshItems = nextItems.filter((item) => !item.archived_at && !item.read_at && !seenInboxNotificationIds.has(item.id))
        if (freshItems.length === 0) return
        for (const item of freshItems) rememberInboxNotification(item.id)
        showNotificationToast(freshItems.length)
        void sendDesktopNotification(freshItems[0])
    }, [sendDesktopNotification, showNotificationToast])

    useEffect(() => {
        if (!pageQuery.data || !trackerKey) return
        syncInboxTracker(trackerKey)
        if (!hasPrimedInbox) {
            rememberInboxNotifications(pageQuery.data.items)
            hasPrimedInbox = true
            return
        }
        if (tab === 'all' && currentPage === 1) announceNewNotifications(pageQuery.data.items)
        else rememberInboxNotifications(pageQuery.data.items)
    }, [announceNewNotifications, currentPage, pageQuery.data, tab, trackerKey])

    const refreshNotificationSettings = useCallback(async () => {
        if (!isAdmin || !user?.workspaceId || isLocalMode) {
            setDisabledTypes(new Set())
            setSettingsError(null)
            setSettingsLoading(false)
            return
        }

        setSettingsLoading(true)
        const { data, error } = await listDisabledWorkspaceNotificationTypes(user.workspaceId)
        if (error) {
            console.error('[NotificationCenter] Failed to load notification settings:', error)
            setSettingsError(error.message)
            setSettingsLoading(false)
            return
        }

        setSettingsError(null)
        setDisabledTypes(new Set(data))
        setSettingsLoading(false)
    }, [isAdmin, isLocalMode, user?.workspaceId])

    useEffect(() => {
        if (!user?.id || isLocalMode) return
        const unsubscribeRealtime = subscribeToNotificationInbox(user.id, (payload) => {
            if (payload.eventType === 'INSERT' && payload.new) {
                const nextItem = normalizeNotificationInboxRow(payload.new as NotificationInboxRecord)
                if (nextItem.workspace_id !== user.workspaceId) return
                if (!hasPrimedInbox) {
                    rememberInboxNotification(nextItem.id)
                } else {
                    announceNewNotifications([nextItem])
                }
                void invalidateInbox()
                return
            }
            void invalidateInbox()
        })
        const unsubscribeConnection = connectionManager.subscribe((event) => {
            if (event === 'wake' || event === 'online') void invalidateInbox()
        })
        return () => {
            unsubscribeRealtime()
            unsubscribeConnection()
        }
    }, [announceNewNotifications, invalidateInbox, isLocalMode, user?.id, user?.workspaceId])

    useEffect(() => {
        if (!settingsOpen) return
        void refreshNotificationSettings()
    }, [refreshNotificationSettings, settingsOpen])

    const navigateToUrl = useCallback((url: string) => {
        if (/^https?:\/\//i.test(url)) {
            window.open(url, '_blank', 'noopener,noreferrer')
            return
        }
        setLocation(url)
    }, [setLocation])

    const showInboxUpdateError = useCallback(() => {
        toast({
            title: t('notifications.updateFailed', { defaultValue: 'Could not update notifications. Please try again.' }),
            variant: 'destructive',
        })
    }, [t])

    const handleMarkRead = useCallback(async (item: NotificationInboxRecord, read = true) => {
        const { success, error } = await markNotificationInboxRead(item.id, read)
        if (error || !success) {
            console.error('[NotificationCenter] Failed to update read state:', error)
            showInboxUpdateError()
            return
        }
        await invalidateInbox()
    }, [invalidateInbox, showInboxUpdateError])

    const handleArchive = useCallback(async (item: NotificationInboxRecord, archived = true) => {
        const { success, error } = await markNotificationInboxArchived(item.id, archived)
        if (error) {
            console.error('[NotificationCenter] Failed to update archive state:', error)
            showInboxUpdateError()
            return
        }
        if (!success) {
            showInboxUpdateError()
            return
        }
        await invalidateInbox()
    }, [invalidateInbox, showInboxUpdateError])

    const handleMarkAllRead = useCallback(async () => {
        const { error } = await markAllNotificationInboxRead()
        if (error) {
            console.error('[NotificationCenter] Failed to mark all notifications as read:', error)
            showInboxUpdateError()
            return
        }
        await invalidateInbox()
    }, [invalidateInbox, showInboxUpdateError])

    const handleToggleNotificationType = useCallback(async (notificationType: WorkspaceNotificationType, enabled: boolean) => {
        if (!user?.workspaceId || settingsSavingType) return

        const previousDisabledTypes = new Set(disabledTypes)
        const nextDisabledTypes = new Set(disabledTypes)
        if (enabled) nextDisabledTypes.delete(notificationType)
        else nextDisabledTypes.add(notificationType)

        setDisabledTypes(nextDisabledTypes)
        setSettingsError(null)
        setSettingsSavingType(notificationType)

        const { error } = await setWorkspaceNotificationTypeDisabled(user.workspaceId, notificationType, !enabled)
        if (error) {
            console.error('[NotificationCenter] Failed to update notification settings:', error)
            setDisabledTypes(previousDisabledTypes)
            setSettingsError(error.message || t('notifications.settings.saveError', { defaultValue: 'Failed to update notification settings' }))
        }

        setSettingsSavingType(null)
    }, [disabledTypes, settingsSavingType, t, user?.workspaceId])

    const handleOpenNotification = useCallback((item: NotificationInboxRecord, actionUrl?: string) => {
        if (!item.read_at) void handleMarkRead(item, true)
        const reminderUrl = item.notification_type === 'beauty3_appointment_reminder'
            ? `/clinical-appointments/appointment-reminders/${encodeURIComponent(item.id)}`
            : ''
        const targetUrl = actionUrl || reminderUrl || readString(item.action_url) || readString(item.payload.route)
        if (!targetUrl) return
        setOpen(false)
        navigateToUrl(targetUrl)
    }, [handleMarkRead, navigateToUrl])

    const notificationTypeOptions = useMemo(() => WORKSPACE_NOTIFICATION_TYPES.map((notificationType) => ({
        notificationType,
        label: localizeNotification({ notificationType }, i18n.language).typeLabel,
    })), [i18n.language])

    if (isLoading) {
        return <button className="relative p-2 rounded-md text-muted-foreground animate-pulse" type="button"><Bell className="w-4 h-4" /></button>
    }

    if (!user?.id || isLocalMode) {
        return <button className="relative hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground cursor-pointer mr-1 opacity-50" title={isLocalMode ? t('notifications.localModeUnavailable', { defaultValue: 'Cloud notifications are unavailable in Local Mode.' }) : t('notifications.waitingSession', { defaultValue: 'Waiting for user session...' })} type="button"><Bell className="w-4 h-4" /></button>
    }

    return (
        <>
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild><BellButton unreadCount={unreadCount} style={style} /></PopoverTrigger>
            <PopoverContent align="end" side="bottom" sideOffset={10} className="w-[440px] max-w-[calc(100vw-1rem)] border-none bg-transparent p-0 shadow-none">
                {open ? (
                <div className="overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
                    <Tabs value={tab} onValueChange={(value) => setTab(value as NotificationInboxTab)} className="flex flex-col">
                        <div className="border-b border-border/70 px-4 py-4">
                            <div className="flex items-start justify-between gap-3">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2"><Inbox className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">{t('notifications.title', { defaultValue: 'Notifications' })}</h3>{isSyncing && <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />}</div>
                                    <p className="text-xs text-muted-foreground">{unreadCount > 0 ? `${unreadCount} ${t('notifications.unread', { defaultValue: 'unread' })}` : t('notifications.allCaughtUp', { defaultValue: 'You are all caught up' })}</p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    {isAdmin && <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-xl" title={t('notifications.settings.title', { defaultValue: 'Notification Settings' })} onClick={() => { setOpen(false); setSettingsOpen(true) }}><Settings className="h-3.5 w-3.5" /><span className="sr-only">{t('notifications.settings.title', { defaultValue: 'Notification Settings' })}</span></Button>}
                                    <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => void handleMarkAllRead()} disabled={unreadCount === 0}><CheckCheck className="h-3.5 w-3.5" />{t('notifications.markAllRead', { defaultValue: 'Mark all read' })}</Button>
                                </div>
                            </div>
                            <TabsList className="mt-4 grid w-full grid-cols-3 rounded-xl bg-muted/60 p-1">
                                <TabsTrigger value="all" className="rounded-lg text-xs font-bold uppercase tracking-wide">{t('notifications.tabs.all', { defaultValue: 'All' })}<span className="ml-1.5 text-[10px] opacity-70">{activeCount}</span></TabsTrigger>
                                <TabsTrigger value="unread" className="rounded-lg text-xs font-bold uppercase tracking-wide">{t('notifications.tabs.unread', { defaultValue: 'Unread' })}<span className="ml-1.5 text-[10px] opacity-70">{unreadCount}</span></TabsTrigger>
                                <TabsTrigger value="archived" className="rounded-lg text-xs font-bold uppercase tracking-wide">{t('notifications.tabs.archived', { defaultValue: 'Archived' })}<span className="ml-1.5 text-[10px] opacity-70">{archivedCount}</span></TabsTrigger>
                            </TabsList>
                            {(pageQuery.data?.totalCount ?? selectedTabCount) > 0 && <AppPagination
                                currentPage={paginationBounds.currentPage}
                                pageCount={paginationBounds.pageCount}
                                totalCount={pageQuery.data?.totalCount ?? selectedTabCount}
                                pageSize={pagination.pageSize}
                                onPageChange={setCurrentPage}
                                onPageSizeChange={pagination.setPageSize}
                                pageSizeOptions={NOTIFICATION_PAGE_SIZE_OPTIONS}
                                className="mt-3"
                            />}
                        </div>
                        <div className="max-h-[560px] overflow-y-auto p-3">
                            {pageQuery.isError && visibleItems.length === 0 && <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"><div className="font-semibold">{t('notifications.error', { defaultValue: 'Failed to load notifications' })}</div><div className="mt-1 text-xs opacity-90">{syncError}</div><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void pageQuery.refetch()}>{t('common.refresh', { defaultValue: 'Refresh' })}</Button></div>}
                            {(isPageClamping || ((pageQuery.isPending || pageQuery.isFetching) && !pageQuery.data)) && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin text-primary" /><span>{t('notifications.loading', { defaultValue: 'Loading notifications…' })}</span></div>}
                            {!pageQuery.isFetching && !pageQuery.isError && !isPageClamping && visibleItems.length === 0 && <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 px-6 py-12 text-center"><Inbox className="h-10 w-10 text-muted-foreground/60" /><div className="mt-4 text-sm font-semibold">{tab === 'archived' ? t('notifications.emptyArchived', { defaultValue: 'No archived notifications' }) : tab === 'unread' ? t('notifications.emptyUnread', { defaultValue: 'No unread notifications' }) : t('notifications.empty', { defaultValue: 'No notifications yet' })}</div><div className="mt-1 text-xs text-muted-foreground">{tab === 'archived' ? t('notifications.emptyArchivedHint', { defaultValue: 'Archived items will stay here until you restore them.' }) : t('notifications.emptyHint', { defaultValue: 'New workspace activity will appear here.' })}</div></div>}
                            <div className="space-y-3">
                                {visibleItems.map((item) => {
                                    const Icon = getNotificationIcon(item)
                                    const localized = localizeInboxNotification(item, i18n.language)
                                    const preview = localized.body
                                    const actions = getNotificationActions(item, localized)
                                    const lowStockProductName = item.notification_type === 'inventory_low_stock'
                                        ? readString(item.payload.product_name)
                                        : ''
                                    const productSearchUrl = lowStockProductName
                                        ? `/products?${new URLSearchParams({ productSearch: lowStockProductName }).toString()}`
                                        : null
                                    const timeLabel = formatNotificationTime(item.created_at, i18n.language)
                                    const typeLabel = localized.typeLabel
                                    const scopeLabel = item.scope === 'workspace'
                                        ? t('notifications.tabs.workspace', { defaultValue: 'Workspace' })
                                        : item.scope === 'user'
                                            ? t('notifications.tabs.user', { defaultValue: 'User' })
                                            : item.scope
                                    return <div key={item.id} role="button" tabIndex={0} onClick={() => handleOpenNotification(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleOpenNotification(item) } }} className={cn('group rounded-2xl border p-4 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40', item.read_at ? 'border-border/70 bg-background hover:bg-muted/40' : 'border-primary/20 bg-primary/5 shadow-sm shadow-primary/10 hover:bg-primary/10')}>
                                        <div className="flex items-start gap-3">
                                            <div className={cn('mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border', item.priority === 'high' || item.priority === 'urgent' ? 'border-amber-500/30 bg-amber-500/10 text-amber-600' : 'border-primary/20 bg-primary/10 text-primary')}><Icon className="h-4 w-4" /></div>
                                            <div className="min-w-0 flex-1 space-y-2">
                                                <div className="flex items-start justify-between gap-3"><div className="space-y-1"><div className="flex items-center gap-2"><span className="text-sm font-semibold leading-none text-foreground">{localized.title}</span>{!item.read_at && <span className="h-2 w-2 rounded-full bg-primary" />}</div>{preview && <p className="line-clamp-2 text-xs text-muted-foreground">{preview}</p>}</div>{timeLabel && <span className="shrink-0 text-[11px] text-muted-foreground">{timeLabel}</span>}</div>
                                                <div className="flex flex-wrap items-center gap-2"><span className="inline-flex rounded-full border border-border/70 bg-muted/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{typeLabel}</span>{item.scope !== 'user' && <span className="inline-flex rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{scopeLabel}</span>}</div>
                                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                                    {actions.map((action) => <Button key={`${item.id}-${action.url}`} type="button" variant="outline" size="sm" className="h-8 rounded-xl text-[11px] font-semibold" onClick={(event) => { event.stopPropagation(); handleOpenNotification(item, action.url) }}><ExternalLink className="h-3.5 w-3.5" />{action.label}</Button>)}
                                                    {productSearchUrl && <Button type="button" variant="outline" size="sm" className="h-8 rounded-xl text-[11px] font-semibold" onClick={(event) => { event.stopPropagation(); handleOpenNotification(item, productSearchUrl) }}><Search className="h-3.5 w-3.5" />{t('notifications.searchForProduct', { defaultValue: 'Search for Product' })}</Button>}
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
                ) : null}
            </PopoverContent>
        </Popover>
        {isAdmin && (
            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
                    <DialogHeader className="border-b border-border/70 px-5 py-4">
                        <DialogTitle className="flex items-center gap-2 text-base"><Settings className="h-4 w-4 text-primary" />{t('notifications.settings.title', { defaultValue: 'Notification Settings' })}</DialogTitle>
                        <DialogDescription className="sr-only">{t('notifications.settings.description', { defaultValue: 'Workspace notification type settings' })}</DialogDescription>
                    </DialogHeader>
                    <div className="max-h-[60vh] overflow-y-auto p-4">
                        {settingsError && <div className="mb-3 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{settingsError}</div>}
                        {settingsLoading ? (
                            <div className="space-y-2">
                                {WORKSPACE_NOTIFICATION_TYPES.map((notificationType) => <div key={notificationType} className="h-[74px] rounded-xl border border-border/70 bg-muted/30 animate-pulse" />)}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {notificationTypeOptions.map(({ notificationType, label }) => {
                                    const enabled = !disabledTypes.has(notificationType)
                                    const isSaving = settingsSavingType === notificationType
                                    const switchId = `workspace-notification-${notificationType}`

                                    return (
                                        <div key={notificationType} className="flex min-h-[74px] items-center justify-between gap-4 rounded-xl border border-border/70 bg-background px-3 py-3">
                                            <div className="min-w-0">
                                                <Label htmlFor={switchId} className="block truncate text-sm font-semibold">{label}</Label>
                                                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{notificationType}</div>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-2">
                                                {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                                                <span className="w-16 text-right text-xs font-medium text-muted-foreground">{enabled ? t('common.enabled', { defaultValue: 'Enabled' }) : t('common.disabled', { defaultValue: 'Disabled' })}</span>
                                                <Switch id={switchId} checked={enabled} disabled={settingsLoading || Boolean(settingsSavingType)} onCheckedChange={(checked) => void handleToggleNotificationType(notificationType, checked)} />
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        )}
        </>
    )
}
