import { SERVICES_VIRTUAL_STORAGE_ID } from "@/lib/catalogItem";
import { getSchemaMismatchColumnName } from "./syncErrors";

/**
 * Fields that exist in the local model but must never be included in an
 * ordinary table mutation. Keep this contract deliberately small and
 * explicit: a field is removed only when Atlas knows it is local-only or a
 * derived/legacy value. Everything else is sent to Supabase so a schema
 * mismatch remains visible instead of silently losing business data.
 */
const COMMON_NON_REMOTE_FIELDS = new Set([
  "sync_status",
  "last_synced_at",
]);

const NON_REMOTE_FIELDS_BY_ENTITY: Readonly<Record<string, ReadonlySet<string>>> = {
  products: new Set([
    "sku_key",
    // Product quantity is a local snapshot derived from inventory rows.
    "quantity",
    "storage_id",
    "storage_name",
    // Product barcodes live in product_barcodes.
    "barcode",
    "barcodes",
  ]),
  agents: new Set(["image_url"]),
  invoices: new Set([
    // Legacy/local invoice display and file fields.
    "items",
    "currency",
    "subtotal",
    "discount",
    "print_metadata",
    "is_snapshot",
    "customer_id",
    "status",
    "local_path_a4",
    "local_path_receipt",
    "pdf_blob_a4",
    "pdf_blob_receipt",
  ]),
  // `partner_name` is the sole active identity. The former `name` and
  // `contact_name` fields remain stored only for historical recovery. Email
  // and country are retired and must never be recreated from queued changes.
  business_partners: new Set(["name", "contact_name", "email", "country"]),
  customers: new Set(["is_locked", "name", "email", "country"]),
  suppliers: new Set(["is_locked", "name", "contact_name", "email", "country"]),
  // Order balances are reconstructed from the Account Statement ledger. This
  // retired field can survive in a queued mutation from an older client.
  sales_orders: new Set(["partner_balance_snapshot"]),
  purchase_orders: new Set(["partner_balance_snapshot"]),
  // Delivery recipient phone is the only current identifier. These fields may
  // remain in a local offline row created before the simplified contract, but
  // no longer exist in the delivery_shipments table.
  delivery_shipments: new Set([
    "recipient_name",
    "recipient_alternate_phone",
    "recipient_city",
  ]),
};

// Development-only fault injection. Set VITE_DEBUG_FORCE_SYNC_SCHEMA_MISMATCH
// to "true" in a local .env.local file and restart the dev app to make the
// next queued product mutation include a deliberately invalid remote column.
// It is hard-disabled in production builds.
const FORCE_PRODUCT_SCHEMA_MISMATCH =
  import.meta.env.DEV &&
  import.meta.env.VITE_DEBUG_FORCE_SYNC_SCHEMA_MISMATCH === "true";

export type RemoteMutationFieldStatus = "valid" | "invalid" | "excluded";

export interface RemoteMutationFieldInspection {
  field: string;
  value: unknown;
  status: RemoteMutationFieldStatus;
  reason: string;
}

function toSnakeCase(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in payload) {
    if (payload[key] === undefined) continue;
    result[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = payload[key];
  }
  return result;
}

/**
 * `__atlas_services__` is a client-only selector value, not a storage UUID.
 * Strip it from queued orders created by older desktop clients before sending
 * their JSONB line items to Supabase.
 */
function removeServicesVirtualStorageFromOrderItems(
  remotePayload: Record<string, unknown>,
): void {
  if (!Array.isArray(remotePayload.items)) return;

  remotePayload.items = remotePayload.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;

    const line = { ...(item as Record<string, unknown>) };
    if (line.storageId === SERVICES_VIRTUAL_STORAGE_ID) line.storageId = null;
    if (line.storage_id === SERVICES_VIRTUAL_STORAGE_ID) line.storage_id = null;
    return line;
  });
}

export function prepareRemoteMutationPayload(
  entityType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const remotePayload = toSnakeCase(payload);
  const nonRemoteFields = NON_REMOTE_FIELDS_BY_ENTITY[entityType];

  for (const field of COMMON_NON_REMOTE_FIELDS) {
    delete remotePayload[field];
  }
  for (const field of nonRemoteFields ?? []) {
    delete remotePayload[field];
  }

  if (entityType === "sales_orders") {
    removeServicesVirtualStorageFromOrderItems(remotePayload);
  }

  if (FORCE_PRODUCT_SCHEMA_MISMATCH && entityType === "products") {
    remotePayload.__debug_force_sync_schema_mismatch = true;
  }

  return remotePayload;
}

/**
 * Produces a user-facing view of a queued payload without changing it. This
 * lets the sync dialog distinguish fields that will be sent from fields that
 * were deliberately excluded or rejected by the remote schema.
 */
export function inspectRemoteMutationPayload(
  entityType: string,
  payload: Record<string, unknown>,
  error?: string,
): RemoteMutationFieldInspection[] {
  const serializedPayload = toSnakeCase(payload);
  const nonRemoteFields = new Set([
    ...COMMON_NON_REMOTE_FIELDS,
    ...(NON_REMOTE_FIELDS_BY_ENTITY[entityType] ?? []),
  ]);
  const remotePayload = prepareRemoteMutationPayload(entityType, payload);
  const rejectedColumn = getSchemaMismatchColumnName(error);
  const fields = new Set([
    ...Object.keys(serializedPayload),
    ...Object.keys(remotePayload),
  ]);

  const rows = Array.from(fields, (field): RemoteMutationFieldInspection => {
    const value = remotePayload[field] ?? serializedPayload[field];
    if (nonRemoteFields.has(field)) {
      return {
        field,
        value,
        status: "excluded",
        reason: "Local-only or derived field; it is not sent to Supabase.",
      };
    }
    if (field === rejectedColumn) {
      return {
        field,
        value,
        status: "invalid",
        reason: "Supabase rejected this column because it is not in the remote schema.",
      };
    }
    return {
      field,
      value,
      status: "valid",
      reason: "Will be included in the next Supabase sync request.",
    };
  });

  const order: Record<RemoteMutationFieldStatus, number> = {
    invalid: 0,
    valid: 1,
    excluded: 2,
  };
  return rows.sort((left, right) =>
    order[left.status] - order[right.status] || left.field.localeCompare(right.field),
  );
}
