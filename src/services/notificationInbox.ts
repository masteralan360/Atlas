import { supabase } from '@/auth/supabase'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

export type NotificationInboxRecord = {
    id: string
    event_id: string | null
    workspace_id: string
    user_id: string
    notification_type: string
    scope: string
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

type NotificationInboxRow = Omit<NotificationInboxRecord, 'payload'> & {
    payload: unknown
}

export type NotificationInboxRealtimePayload = RealtimePostgresChangesPayload<Record<string, unknown>>

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
    const { data, error } = await supabase.rpc('list_notifications_inbox', {
        p_limit: limit
    })

    return {
        data: ((data ?? []) as NotificationInboxRow[]).map(normalizeNotificationInboxRow),
        error
    }
}

export async function markNotificationInboxRead(notificationId: string, read = true) {
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
    const { data, error } = await supabase.rpc('mark_all_notifications_inbox_read')

    return {
        updatedCount: typeof data === 'number' ? data : 0,
        error
    }
}

export function subscribeToNotificationInbox(
    userId: string,
    callback: (payload: NotificationInboxRealtimePayload) => void,
) {
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
            callback,
        )
        .subscribe((status) => {
            console.log(`[Notifications] Inbox realtime: ${status}`)
        })

    return () => {
        void supabase.removeChannel(channel)
    }
}
