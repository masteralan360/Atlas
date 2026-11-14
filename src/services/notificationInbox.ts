import { supabase } from '@/auth/supabase'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { getActiveBusinessWorkspaceId } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

export type NotificationInboxRecord = {
    id: string
    event_id: string | null
    workspace_id: string
    user_id: string
    notification_type: string
    scope: NotificationScope
    organization_id?: string | null
    priority: string
    dedupe_key: string | null
    title: string
    body: string | null
    action_url: string | null
    action_label: string | null
    payload: Record<string, unknown>
    read_at: string | null
    archived_at: string | null
    created_at: string
    updated_at: string
}

export type NotificationScope = 'user' | 'workspace' | 'system' | 'organization'

export type NotificationInboxRow = Omit<NotificationInboxRecord, 'payload'> & {
    payload: unknown
}

export type NotificationInboxRealtimePayload = RealtimePostgresChangesPayload<Record<string, unknown>>

type NotificationInboxSubscriber = (payload: NotificationInboxRealtimePayload) => void

type NotificationInboxRealtimeSubscription = {
    channel: ReturnType<typeof supabase.channel>
    subscribers: Set<NotificationInboxSubscriber>
}

const realtimeSubscriptionsByUserId = new Map<string, NotificationInboxRealtimeSubscription>()

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeNotificationInboxRow(row: NotificationInboxRow): NotificationInboxRecord {
    return {
        ...row,
        payload: isRecord(row.payload) ? row.payload : {}
    }
}

export async function listNotificationInbox(limit = 200) {
    if (isLocalWorkspaceMode(getActiveBusinessWorkspaceId())) {
        return { data: [], error: null }
    }

    const { data, error } = await supabase.rpc('list_notifications_inbox', {
        p_limit: limit
    })

    return {
        data: ((data ?? []) as NotificationInboxRow[]).map(normalizeNotificationInboxRow),
        error
    }
}

export async function markNotificationInboxRead(notificationId: string, read = true) {
    if (isLocalWorkspaceMode(getActiveBusinessWorkspaceId())) {
        return { success: false, error: null }
    }

    const { data, error } = await supabase.rpc('mark_notification_inbox_read', {
        p_notification_id: notificationId,
        p_read: read
    })

    return {
        success: Boolean(data),
        error
    }
}

export async function markNotificationInboxArchived(notificationId: string, archived = true) {
    if (isLocalWorkspaceMode(getActiveBusinessWorkspaceId())) {
        return { success: false, error: null }
    }

    const { data, error } = await supabase.rpc('mark_notification_inbox_archived', {
        p_notification_id: notificationId,
        p_archived: archived
    })

    return {
        success: Boolean(data),
        error
    }
}

export async function markAllNotificationInboxRead() {
    if (isLocalWorkspaceMode(getActiveBusinessWorkspaceId())) {
        return { updatedCount: 0, error: null }
    }

    const { data, error } = await supabase.rpc('mark_all_notifications_inbox_read')

    return {
        updatedCount: typeof data === 'number' ? data : 0,
        error
    }
}

export function subscribeToNotificationInbox(
    userId: string,
    callback: NotificationInboxSubscriber,
) {
    if (isLocalWorkspaceMode(getActiveBusinessWorkspaceId())) {
        return () => undefined
    }

    let subscription = realtimeSubscriptionsByUserId.get(userId)
    if (!subscription) {
        const subscribers = new Set<NotificationInboxSubscriber>()
        let createdSubscription: NotificationInboxRealtimeSubscription | null = null
        const channel = supabase
            .channel(`notifications-inbox-${userId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'notifications',
                    table: 'inbox',
                    filter: `user_id=eq.${userId}`,
                },
                (payload) => {
                    for (const subscriber of createdSubscription?.subscribers ?? []) {
                        subscriber(payload)
                    }
                },
            )
            .subscribe((status) => {
                console.log(`[Notifications] Inbox realtime: ${status}`)
            })

        createdSubscription = { channel, subscribers }
        realtimeSubscriptionsByUserId.set(userId, createdSubscription)
        subscription = createdSubscription
    }

    subscription.subscribers.add(callback)

    return () => {
        const activeSubscription = realtimeSubscriptionsByUserId.get(userId)
        if (!activeSubscription) return

        activeSubscription.subscribers.delete(callback)
        if (activeSubscription.subscribers.size === 0) {
            realtimeSubscriptionsByUserId.delete(userId)
            void supabase.removeChannel(activeSubscription.channel)
        }
    }
}
