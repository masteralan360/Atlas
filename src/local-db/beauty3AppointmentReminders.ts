import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/auth/supabase'
import { queryKeys } from '@/query/queryKeys'
import {
  normalizeNotificationInboxPageItem,
} from '@/local-db/notificationInbox'
import type { NotificationInboxRecord } from '@/services/notificationInbox'

export type Beauty3AppointmentReminderPageQuery = {
  workspaceId: string
  userId: string
  page: number
  pageSize: number
  startAt?: string
  endBefore?: string
}

export type Beauty3AppointmentReminderPage = {
  items: Beauty3AppointmentReminderListItem[]
  totalCount: number
}

export type Beauty3AppointmentReminderListItem = NotificationInboxRecord & {
  clientName: string | null
  clientPhone: string | null
}

export type Beauty3AppointmentReminderNotification = NotificationInboxRecord & {
  clientName: string | null
  clientPhone: string | null
}

export type Beauty3AppointmentReminderNotificationQuery = {
  workspaceId: string
  userId: string
  notificationId: string | null
}

type Beauty3AppointmentReminderPageResponse = {
  items?: unknown
  totalCount?: unknown
}

function readCount(value: unknown) {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

function normalizeBeauty3AppointmentReminderListItem(value: unknown): Beauty3AppointmentReminderListItem | null {
  const notification = normalizeNotificationInboxPageItem(value)
  if (!notification) return null

  const row = value as { client_name?: unknown; client_phone?: unknown }
  return {
    ...notification,
    clientName: typeof row.client_name === 'string' ? row.client_name : null,
    clientPhone: typeof row.client_phone === 'string' ? row.client_phone : null,
  }
}

export async function fetchBeauty3AppointmentReminderPage(
  query: Beauty3AppointmentReminderPageQuery,
  signal: AbortSignal,
): Promise<Beauty3AppointmentReminderPage> {
  signal.throwIfAborted()
  const { data, error } = await supabase.rpc('list_beauty3_appointment_reminders_page', {
    p_limit: query.pageSize,
    p_offset: (query.page - 1) * query.pageSize,
    p_start_at: query.startAt ?? null,
    p_end_before: query.endBefore ?? null,
  }).abortSignal(signal)

  signal.throwIfAborted()
  if (error) throw error

  const response = (data ?? {}) as Beauty3AppointmentReminderPageResponse
  return {
    items: Array.isArray(response.items)
      ? response.items
        .map(normalizeBeauty3AppointmentReminderListItem)
        .filter((item): item is Beauty3AppointmentReminderListItem => item !== null)
      : [],
    totalCount: readCount(response.totalCount),
  }
}

export function useBeauty3AppointmentReminderPage(query: Beauty3AppointmentReminderPageQuery, enabled = true) {
  return useQuery({
    queryKey: queryKeys.notificationInbox.reminderPage(query),
    queryFn: ({ signal }) => fetchBeauty3AppointmentReminderPage(query, signal),
    enabled: enabled && Boolean(query.workspaceId && query.userId),
  })
}

export async function fetchBeauty3AppointmentReminderNotification(
  query: Beauty3AppointmentReminderNotificationQuery,
  signal: AbortSignal,
): Promise<Beauty3AppointmentReminderNotification | null> {
  if (!query.notificationId) return null
  signal.throwIfAborted()
  const { data, error } = await supabase.rpc('get_beauty3_appointment_reminder_notification', {
    p_notification_id: query.notificationId,
  }).abortSignal(signal)

  signal.throwIfAborted()
  if (error) throw error
  const notification = normalizeNotificationInboxPageItem(data)
  if (!notification) return null
  const response = data as { client_name?: unknown; client_phone?: unknown }
  return {
    ...notification,
    clientName: typeof response.client_name === 'string' ? response.client_name : null,
    clientPhone: typeof response.client_phone === 'string' ? response.client_phone : null,
  }
}

export function useBeauty3AppointmentReminderNotification(
  query: Beauty3AppointmentReminderNotificationQuery,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.notificationInbox.reminderNotification(query),
    queryFn: ({ signal }) => fetchBeauty3AppointmentReminderNotification(query, signal),
    enabled: enabled && Boolean(query.workspaceId && query.userId && query.notificationId),
  })
}
