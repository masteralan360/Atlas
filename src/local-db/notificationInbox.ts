import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/auth/supabase'
import { queryKeys } from '@/query/queryKeys'
import {
  normalizeNotificationInboxRow,
  type NotificationInboxRecord,
  type NotificationInboxRow,
} from '@/services/notificationInbox'

export type NotificationInboxTab = 'all' | 'unread' | 'archived'

export type NotificationInboxPageQuery = {
  workspaceId: string
  userId: string
  tab: NotificationInboxTab
  page: number
  pageSize: number
}

export type NotificationInboxPage = {
  items: NotificationInboxRecord[]
  totalCount: number
  activeCount: number
  unreadCount: number
  archivedCount: number
}

type NotificationInboxPageResponse = {
  items?: unknown
  totalCount?: unknown
  activeCount?: unknown
  unreadCount?: unknown
  archivedCount?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown) {
  return value == null || typeof value === 'string'
}

function normalizePageItem(value: unknown): NotificationInboxRecord | null {
  if (!isRecord(value)) return null
  const requiredStrings = [
    'id', 'workspace_id', 'user_id', 'notification_type', 'scope', 'priority', 'title', 'created_at', 'updated_at',
  ]
  if (requiredStrings.some((field) => typeof value[field] !== 'string')) return null
  if (!['event_id', 'dedupe_key', 'body', 'action_url', 'action_label', 'read_at', 'archived_at'].every((field) => isNullableString(value[field]))) {
    return null
  }

  return normalizeNotificationInboxRow({
    ...value,
    event_id: typeof value.event_id === 'string' ? value.event_id : null,
    dedupe_key: typeof value.dedupe_key === 'string' ? value.dedupe_key : null,
    body: typeof value.body === 'string' ? value.body : null,
    action_url: typeof value.action_url === 'string' ? value.action_url : null,
    action_label: typeof value.action_label === 'string' ? value.action_label : null,
    read_at: typeof value.read_at === 'string' ? value.read_at : null,
    archived_at: typeof value.archived_at === 'string' ? value.archived_at : null,
    payload: value.payload,
  } as NotificationInboxRow)
}

function readCount(value: unknown) {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

export async function fetchNotificationInboxPage(
  query: NotificationInboxPageQuery,
  signal: AbortSignal,
): Promise<NotificationInboxPage> {
  signal.throwIfAborted()
  const { data, error } = await supabase.rpc('list_notifications_inbox_page', {
    p_tab: query.tab,
    p_limit: query.pageSize,
    p_offset: (query.page - 1) * query.pageSize,
  }).abortSignal(signal)

  signal.throwIfAborted()
  if (error) throw error

  const response = (data ?? {}) as NotificationInboxPageResponse
  return {
    items: Array.isArray(response.items)
      ? response.items.map(normalizePageItem).filter((item): item is NotificationInboxRecord => item !== null)
      : [],
    totalCount: readCount(response.totalCount),
    activeCount: readCount(response.activeCount),
    unreadCount: readCount(response.unreadCount),
    archivedCount: readCount(response.archivedCount),
  }
}

export function useNotificationInboxPage(query: NotificationInboxPageQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.notificationInbox.page(query),
    queryFn: ({ signal }) => fetchNotificationInboxPage(query, signal),
    enabled: enabled && Boolean(query.workspaceId && query.userId),
  })
}
