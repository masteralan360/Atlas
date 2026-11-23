import { r2Service } from '@/services/r2Service'
import {
  fetchPostalShipmentAttachmentCleanup,
  fetchPendingPostalShipmentAttachmentCleanup,
  finishPostalShipmentAttachmentCleanup,
  queuePostalShipmentAttachmentCleanup,
} from '@/local-db/postalAttachments'

const pendingCleanupByWorkspace = new Map<string, Promise<void>>()

function shipmentAttachmentPrefix(workspaceId: string, shipmentId: string) {
  return `${workspaceId}/shipment-attachments/${shipmentId}/`
}

export async function deleteShipmentAttachmentUploads(
  workspaceId: string,
  shipmentId: string,
  knownKeys: string[] = [],
): Promise<boolean> {
  const prefix = shipmentAttachmentPrefix(workspaceId, shipmentId)
  const safeKnownKeys = knownKeys.filter((key) => key.startsWith(prefix))
  let listedKeys: string[] = []
  let listingFailed = false
  try {
    listedKeys = await r2Service.listObjects(prefix)
  } catch {
    listingFailed = true
  }
  const keys = [...new Set([...safeKnownKeys, ...listedKeys.filter((key) => key.startsWith(prefix))])]
  const results = await Promise.allSettled(keys.map((key) => r2Service.delete(key)))
  const deletesSucceeded = results.every((result) => result.status === 'fulfilled')
  if (!deletesSucceeded || listingFailed) {
    try {
      await queuePostalShipmentAttachmentCleanup(workspaceId, shipmentId, keys)
    } catch {
      // The upload prefix remains discoverable for cleanup the next time the draft is deleted.
    }
  }
  return !listingFailed && deletesSucceeded
}

/** Deletes queued objects and any abandoned upload objects under this shipment's R2 prefix. */
export async function cleanupDeletedShipmentAttachments(
  workspaceId: string,
  shipmentId: string,
): Promise<boolean> {
  let queued: Array<{ object_key: string }>
  try {
    queued = await fetchPostalShipmentAttachmentCleanup(workspaceId, shipmentId)
  } catch {
    return false
  }

  const prefix = shipmentAttachmentPrefix(workspaceId, shipmentId)
  let listedKeys: string[] = []
  let listingFailed = false
  try {
    listedKeys = await r2Service.listObjects(prefix)
  } catch {
    listingFailed = true
  }
  const queuedKeys = queued.map((item) => item.object_key).filter((key) => key.startsWith(prefix))
  const keys = [...new Set([...queuedKeys, ...listedKeys.filter((key) => key.startsWith(prefix))])]
  const results = await Promise.allSettled(keys.map((key) => r2Service.delete(key)))
  const deletesSucceeded = results.every((result) => result.status === 'fulfilled')
  if (!deletesSucceeded || listingFailed) {
    try {
      await queuePostalShipmentAttachmentCleanup(workspaceId, shipmentId, keys)
    } catch {
      // The existing queue rows remain available when cleanup could not be confirmed.
    }
  }
  if (!deletesSucceeded) return false

  try {
    await finishPostalShipmentAttachmentCleanup(workspaceId, shipmentId, queuedKeys)
  } catch {
    return false
  }
  return !listingFailed
}

/** Retries queued object deletes when an authorized user returns to Postal Service. */
export function retryPendingShipmentAttachmentCleanup(workspaceId: string): Promise<void> {
  const current = pendingCleanupByWorkspace.get(workspaceId)
  if (current) return current

  const request = (async () => {
    let pending: Awaited<ReturnType<typeof fetchPendingPostalShipmentAttachmentCleanup>>
    try {
      pending = await fetchPendingPostalShipmentAttachmentCleanup(workspaceId)
    } catch {
      return
    }

    const grouped = new Map<string, string[]>()
    for (const item of pending) {
      const prefix = shipmentAttachmentPrefix(workspaceId, item.shipment_id)
      if (!item.object_key.startsWith(prefix)) continue
      const keys = grouped.get(item.shipment_id) ?? []
      keys.push(item.object_key)
      grouped.set(item.shipment_id, keys)
    }

    for (const [shipmentId, keys] of grouped) {
      const uniqueKeys = [...new Set(keys)]
      const results = await Promise.allSettled(uniqueKeys.map((key) => r2Service.delete(key)))
      if (results.some((result) => result.status !== 'fulfilled')) continue
      await finishPostalShipmentAttachmentCleanup(workspaceId, shipmentId, uniqueKeys).catch(() => undefined)
    }
  })().finally(() => {
    pendingCleanupByWorkspace.delete(workspaceId)
  })

  pendingCleanupByWorkspace.set(workspaceId, request)
  return request
}
