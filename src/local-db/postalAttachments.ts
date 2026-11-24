import { supabase } from '@/auth/supabase'
import { queryClient } from '@/query/queryClient'
import { queryKeys } from '@/query/queryKeys'
import type { PostalScope } from './postal'

export interface PostalShipmentAttachment {
  id: string
  workspace_id: string
  shipment_id: string
  object_key: string
  content_type: 'image/webp'
  size_bytes: number
  width: number
  height: number
  created_at: string
}

export interface NewPostalShipmentAttachment {
  object_key: string
  content_type: 'image/webp'
  size_bytes: number
  width: number
  height: number
}

function normalizeAttachment(
  row: Partial<PostalShipmentAttachment>,
  workspaceId: string,
  shipmentId: string,
): PostalShipmentAttachment {
  const size = Number(row.size_bytes)
  const width = Number(row.width)
  const height = Number(row.height)
  const keyPrefix = `${workspaceId}/shipment-attachments/${shipmentId}/`
  if (
    !row.id ||
    row.workspace_id !== workspaceId ||
    row.shipment_id !== shipmentId ||
    !row.object_key?.startsWith(keyPrefix) ||
    row.content_type !== 'image/webp' ||
    !Number.isSafeInteger(size) || size <= 0 || size > 5 * 1024 * 1024 ||
    !Number.isSafeInteger(width) || width <= 0 || width > 2560 ||
    !Number.isSafeInteger(height) || height <= 0 || height > 2560 ||
    !row.created_at
  ) {
    throw new Error('postal_attachment_invalid_result')
  }
  return { ...row, size_bytes: size, width, height } as PostalShipmentAttachment
}

async function invalidateShipmentAttachmentQueries(scope: PostalScope, shipmentId: string) {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.postal.detail(scope, shipmentId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.postal.pageRoot(scope.workspaceId),
    }),
  ])
}

export async function fetchPostalShipmentAttachments(
  workspaceId: string,
  shipmentId: string,
  signal?: AbortSignal,
): Promise<PostalShipmentAttachment[]> {
  const { data, error } = await supabase
    .from('postal_shipment_attachments')
    .select('id,workspace_id,shipment_id,object_key,content_type,size_bytes,width,height,created_at')
    .eq('workspace_id', workspaceId)
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .abortSignal(signal ?? new AbortController().signal)
  if (error) throw error
  return (data ?? []).map((row) =>
    normalizeAttachment(row as Partial<PostalShipmentAttachment>, workspaceId, shipmentId),
  )
}

/** Fetches only the four preview references needed for the currently loaded shipment page. */
export async function fetchPostalShipmentAttachmentMosaics(
  workspaceId: string,
  shipmentIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, PostalShipmentAttachment[]>> {
  const ids = [...new Set(shipmentIds.filter(Boolean))]
  if (!workspaceId || ids.length === 0) return {}

  const { data, error } = await supabase
    .from('postal_shipment_attachments')
    .select('id,workspace_id,shipment_id,object_key,content_type,size_bytes,width,height,created_at')
    .eq('workspace_id', workspaceId)
    .in('shipment_id', ids)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .abortSignal(signal ?? new AbortController().signal)
  if (error) throw error

  const mosaics: Record<string, PostalShipmentAttachment[]> = {}
  for (const row of data ?? []) {
    const shipmentId = (row as Partial<PostalShipmentAttachment>).shipment_id
    if (typeof shipmentId !== 'string') throw new Error('postal_attachment_invalid_result')
    const attachments = mosaics[shipmentId] ?? (mosaics[shipmentId] = [])
    if (attachments.length >= 4) continue
    attachments.push(
      normalizeAttachment(row as Partial<PostalShipmentAttachment>, workspaceId, shipmentId),
    )
  }
  return mosaics
}

export async function savePostalShipmentAttachments(
  scope: PostalScope,
  shipmentId: string,
  attachments: NewPostalShipmentAttachment[],
): Promise<PostalShipmentAttachment[]> {
  if (attachments.length < 1 || attachments.length > 5) {
    throw new Error('postal_attachment_limit')
  }
  const { data, error } = await supabase.rpc('postal_save_shipment_attachments', {
    p_workspace_id: scope.workspaceId,
    p_shipment_id: shipmentId,
    p_attachments: attachments,
  })
  if (error) throw error
  if (!Array.isArray(data) || data.length !== attachments.length) {
    throw new Error('postal_attachment_invalid_result')
  }
  const rows = data.map((row) =>
    normalizeAttachment(row as Partial<PostalShipmentAttachment>, scope.workspaceId, shipmentId),
  )
  await invalidateShipmentAttachmentQueries(scope, shipmentId)
  return rows
}

/** Adds photos to a draft shipment without replacing its existing attachments. */
export async function addPostalShipmentAttachments(
  scope: PostalScope,
  shipmentId: string,
  attachments: NewPostalShipmentAttachment[],
): Promise<PostalShipmentAttachment[]> {
  if (attachments.length < 1 || attachments.length > 5) {
    throw new Error('postal_attachment_limit')
  }
  const { data, error } = await supabase.rpc('postal_add_shipment_attachments', {
    p_workspace_id: scope.workspaceId,
    p_shipment_id: shipmentId,
    p_attachments: attachments,
  })
  if (error) throw error
  if (!Array.isArray(data) || data.length < attachments.length || data.length > 5) {
    throw new Error('postal_attachment_invalid_result')
  }
  const rows = data.map((row) =>
    normalizeAttachment(row as Partial<PostalShipmentAttachment>, scope.workspaceId, shipmentId),
  )
  const savedKeys = new Set(rows.map((row) => row.object_key))
  if (attachments.some((attachment) => !savedKeys.has(attachment.object_key))) {
    throw new Error('postal_attachment_invalid_result')
  }
  await invalidateShipmentAttachmentQueries(scope, shipmentId)
  return rows
}

export async function fetchPostalShipmentAttachmentCleanup(
  workspaceId: string,
  shipmentId: string,
): Promise<Array<{ object_key: string }>> {
  const { data, error } = await supabase
    .from('postal_shipment_attachment_cleanup')
    .select('object_key')
    .eq('workspace_id', workspaceId)
    .eq('shipment_id', shipmentId)
    .order('queued_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw error
  return (data ?? []).filter(
    (row): row is { object_key: string } => typeof row.object_key === 'string',
  )
}

export async function fetchPendingPostalShipmentAttachmentCleanup(
  workspaceId: string,
  limit = 50,
): Promise<Array<{ workspace_id: string; shipment_id: string; object_key: string }>> {
  const { data, error } = await supabase
    .from('postal_shipment_attachment_cleanup')
    .select('workspace_id,shipment_id,object_key')
    .eq('workspace_id', workspaceId)
    .order('queued_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (error) throw error
  return (data ?? []).filter(
    (row): row is { workspace_id: string; shipment_id: string; object_key: string } =>
      typeof row.workspace_id === 'string' &&
      typeof row.shipment_id === 'string' &&
      typeof row.object_key === 'string',
  )
}

export async function finishPostalShipmentAttachmentCleanup(
  workspaceId: string,
  shipmentId: string,
  objectKeys: string[],
): Promise<void> {
  if (objectKeys.length === 0) return
  const { error } = await supabase.rpc('postal_finish_shipment_attachment_cleanup', {
    p_workspace_id: workspaceId,
    p_shipment_id: shipmentId,
    p_object_keys: objectKeys,
  })
  if (error) throw error
}

export async function queuePostalShipmentAttachmentCleanup(
  workspaceId: string,
  shipmentId: string,
  objectKeys: string[],
): Promise<void> {
  if (objectKeys.length === 0) return
  const { error } = await supabase.rpc('postal_queue_shipment_attachment_cleanup', {
    p_workspace_id: workspaceId,
    p_shipment_id: shipmentId,
    p_object_keys: objectKeys,
  })
  if (error) throw error
}
