import Dexie, { type InsertType, type Table } from "dexie";
import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useQuery } from "@tanstack/react-query";
import { v5 as uuidv5 } from "uuid";

import { queryKeys } from "@/query/queryKeys";
import i18n from "@/i18n/config";
import {
  QUANTITY_EPSILON,
  quantitiesEqual,
  roundQuantity,
} from "@/lib/quantity";
import {
  getActiveBusinessUserId,
  getActiveBusinessUserRole,
  isOnline,
} from "@/lib/network";
import { getSupabaseClientForTable } from "@/lib/supabaseSchema";
import {
  isRetriableWebRequestError,
  normalizeSupabaseActionError,
  runSupabaseAction,
} from "@/lib/supabaseRequest";
import { generateId, toCamelCase, toSnakeCase } from "@/lib/utils";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";

import {
  db,
  INVENTORY_TRANSACTIONS_CHANGED_EVENT,
  withoutInventoryTransactionChangeEvents,
} from "./database";
import { isAllowedInventoryQuantityTransition } from "./inventoryDeficit";
import { canAccessStorage, useStorageAccess } from "./storagePermissions";
import type {
  Inventory,
  InventoryTransferBatch,
  InventoryTransaction,
  InventoryTransactionType,
  OrderReturnItem,
  Product,
  PurchaseOrder,
  Sale,
  SaleReturn,
  SalesOrder,
  Storage,
  StockAdjustmentReason,
} from "./models";

const TABLE_NAME = "inventory_transactions";
const INVENTORY_MOVEMENT_TRANSACTION_NAMESPACE = "8e2e489b-fb4a-48af-8b2a-9e1b0ab8690a";
const CLOUD_TRANSACTION_TYPES = new Set<InventoryTransactionType>([
  "stock_adjustment",
]);

// Cloud movements other than manual stock adjustments are written atomically
// with the authoritative inventory update. This set is only for the dedicated
// stock-adjustment RPC; it is not a restriction on inventory audit coverage.
export interface InventoryTransactionInput {
  productId: string;
  storageId: string;
  transactionType: InventoryTransactionType;
  quantityDelta: number;
  previousQuantity: number;
  newQuantity: number;
  adjustmentReason?: StockAdjustmentReason | null;
  referenceId?: string | null;
  referenceType?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

export interface InventoryTransactionFilterOptions {
  productId?: string | null;
  storageId?: string | null;
  transactionType?: InventoryTransactionType | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}

function normalizeOptionalString(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeOptionalAdjustmentReason(
  value?: StockAdjustmentReason | null,
) {
  const normalized = value?.trim();
  return normalized ? (normalized as StockAdjustmentReason) : null;
}

function normalizeTransactionInput(input: InventoryTransactionInput) {
  const productId = input.productId.trim();
  const storageId = input.storageId.trim();
  const quantityDelta = Number(input.quantityDelta);
  const previousQuantity = Number(input.previousQuantity);
  const newQuantity = Number(input.newQuantity);
  const transactionType = input.transactionType;
  const allowedTypes: InventoryTransactionType[] = [
    "stock_adjustment",
    "transfer_in",
    "transfer_out",
    "sale",
    "return",
    "purchase",
    "initial_stock",
    "inventory_change",
  ];
  const allowedAdjustmentReasons: StockAdjustmentReason[] = [
    "purchase",
    "return",
    "correction",
    "damage",
    "theft",
    "expired",
    "production",
    "other",
  ];
  const adjustmentReason = normalizeOptionalAdjustmentReason(
    input.adjustmentReason,
  );

  if (!productId) {
    throw new Error("Product is required");
  }

  if (!storageId) {
    throw new Error("Storage is required");
  }

  if (!allowedTypes.includes(transactionType)) {
    throw new Error("Transaction type is invalid");
  }

  if (!Number.isFinite(quantityDelta) || Math.abs(quantityDelta) <= QUANTITY_EPSILON) {
    throw new Error("Quantity delta must be non-zero");
  }

  if (!Number.isFinite(previousQuantity)) {
    throw new Error("Previous quantity is invalid");
  }

  if (!isAllowedInventoryQuantityTransition(previousQuantity, newQuantity)) {
    throw new Error("New quantity is invalid");
  }

  if (!quantitiesEqual(previousQuantity + quantityDelta, newQuantity)) {
    throw new Error("Transaction quantities are inconsistent");
  }

  if (
    transactionType === "stock_adjustment" &&
    (!adjustmentReason || !allowedAdjustmentReasons.includes(adjustmentReason))
  ) {
    throw new Error("Adjustment reason is invalid");
  }

  return {
    productId,
    storageId,
    transactionType,
    quantityDelta: roundQuantity(quantityDelta),
    previousQuantity: roundQuantity(previousQuantity),
    newQuantity: roundQuantity(newQuantity),
    adjustmentReason:
      transactionType === "stock_adjustment" ? adjustmentReason : null,
    referenceId: normalizeOptionalString(input.referenceId),
    referenceType: normalizeOptionalString(input.referenceType),
    notes: normalizeOptionalString(input.notes),
    createdBy: normalizeOptionalString(input.createdBy),
  };
}

function shouldSyncInventoryTransaction(
  workspaceId: string,
  transactionType: InventoryTransactionType,
) {
  return (
    CLOUD_TRANSACTION_TYPES.has(transactionType) &&
    !isLocalWorkspaceMode(workspaceId)
  );
}

function toRemoteInventoryTransactionPayload(transaction: InventoryTransaction) {
  return toSnakeCase({
    ...transaction,
    syncStatus: undefined,
    lastSyncedAt: undefined,
  });
}

/**
 * Gives each committed inventory-position version one stable movement id.
 * The database uses the same namespace and input when its inventory trigger
 * writes the authoritative ledger row, so retries replace the local pending
 * projection instead of creating a second event.
 */
export function buildInventoryMovementTransactionId(
  workspaceId: string,
  productId: string,
  storageId: string,
  inventoryVersion: number,
) {
  return uuidv5(
    `${workspaceId}:${productId}:${storageId}:${Math.max(1, Math.trunc(inventoryVersion))}`,
    INVENTORY_MOVEMENT_TRANSACTION_NAMESPACE,
  );
}

type ApplyStockAdjustmentResult = {
  transaction: Record<string, unknown>;
  inventory: Record<string, unknown> | null;
  already_applied: boolean;
};

function isMissingTargetStockAdjustmentRpc(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const rpcError = error as { code?: unknown };
  return rpcError.code === "PGRST202" || rpcError.code === "42883";
}

export async function applyStockAdjustmentTransactionRemotely(
  transaction: InventoryTransaction,
  targetQuantity?: number,
) {
  if (transaction.transactionType !== "stock_adjustment") {
    throw new Error("Only stock adjustments can use the stock adjustment RPC");
  }

  const client = getSupabaseClientForTable(TABLE_NAME);
  const usesTargetQuantity = targetQuantity !== undefined;
  const rpcName = usesTargetQuantity
    ? "apply_stock_adjustment_to_target"
    : "apply_stock_adjustment";
  const rpcParameters = usesTargetQuantity
    ? {
      p_transaction: toRemoteInventoryTransactionPayload(transaction),
      p_target_quantity: targetQuantity,
    }
    : { p_transaction: toRemoteInventoryTransactionPayload(transaction) };
  const { data, error } = await runSupabaseAction(
    `${TABLE_NAME}.${rpcName}`,
    () => client.rpc(rpcName, rpcParameters),
  );

  if (error) {
    if (usesTargetQuantity && isMissingTargetStockAdjustmentRpc(error)) {
      // Keep older databases functional during a staged rollout. Only the
      // explicit missing-function response takes this path; network failures
      // still retry the idempotent target RPC above.
      const { getInventoryQuantityForProductStorage, hydrateInventoryProductStoragesFromSupabase } =
        await import("./inventory");
      await hydrateInventoryProductStoragesFromSupabase(
        transaction.workspaceId,
        transaction.productId,
        [transaction.storageId],
      );
      const previousQuantity = await getInventoryQuantityForProductStorage(
        transaction.productId,
        transaction.storageId,
      );
      const quantityDelta = roundQuantity(targetQuantity! - previousQuantity);
      if (Math.abs(quantityDelta) <= QUANTITY_EPSILON) {
        throw new Error("Stock is already at the requested quantity");
      }
      return applyStockAdjustmentTransactionRemotely({
        ...transaction,
        quantityDelta,
        previousQuantity,
        newQuantity: roundQuantity(previousQuantity + quantityDelta),
      });
    }
    throw error;
  }

  const result = data as ApplyStockAdjustmentResult | null;
  if (!result?.transaction) {
    throw new Error("Stock adjustment RPC returned no transaction");
  }

  return {
    transaction: toCamelCase(result.transaction) as unknown as InventoryTransaction,
    inventory: result.inventory
      ? toCamelCase(result.inventory) as unknown as Inventory
      : null,
    alreadyApplied: result.already_applied === true,
  };
}

async function reconcileAuthoritativeInventory(remoteInventory: Inventory) {
  const localRows = await db.inventory
    .where("[productId+storageId]")
    .equals([remoteInventory.productId, remoteInventory.storageId])
    .toArray();
  const duplicateIds = localRows
    .filter((row) => (
      row.workspaceId === remoteInventory.workspaceId
      && row.id !== remoteInventory.id
    ))
    .map((row) => row.id);

  await db.transaction("rw", db.inventory, async () => {
    if (duplicateIds.length > 0) {
      await db.inventory.bulkDelete(duplicateIds);
    }
    await db.inventory.put(remoteInventory);
  });

  const { syncProductStockSnapshot } = await import("./inventory");
  await syncProductStockSnapshot(
    remoteInventory.productId,
    remoteInventory.lastSyncedAt || new Date().toISOString(),
    "remote",
  );
}

export async function syncInventoryTransactionBestEffort(
  transaction: InventoryTransaction,
  options?: { targetQuantity?: number },
): Promise<InventoryTransaction> {
  if (!shouldSyncInventoryTransaction(transaction.workspaceId, transaction.transactionType)) {
    return transaction;
  }

  if (!isOnline(transaction.workspaceId)) {
    throw new Error(i18n.t("inventory.errors.onlineRequired"));
  }

  let result;
  try {
    result = await applyStockAdjustmentTransactionRemotely(
      transaction,
      options?.targetQuantity,
    );
  } catch (error) {
    if (!isRetriableWebRequestError(error)) throw error;
    // The operation id is the transaction id, so this verification retry is
    // safe even when the first response was lost after the server committed.
    result = await applyStockAdjustmentTransactionRemotely(
      transaction,
      options?.targetQuantity,
    );
  }
  const syncedAt = new Date().toISOString();
  const syncedTransaction: InventoryTransaction = {
    ...result.transaction,
    syncStatus: "synced",
    lastSyncedAt: syncedAt,
  };
  await db.inventory_transactions.put(syncedTransaction);
  if (result.inventory) {
    await reconcileAuthoritativeInventory({
      ...result.inventory,
      syncStatus: "synced",
      lastSyncedAt: syncedAt,
    });
  }
  return syncedTransaction;
}

export async function syncInventoryTransactionsBestEffort(
  transactions: InventoryTransaction[],
) {
  await Promise.all(
    transactions.map((transaction) =>
      syncInventoryTransactionBestEffort(transaction),
    ),
  );
}

// Kept as a compatibility alias for callers introduced with the original
// stock-adjustment-only ledger.
export const syncStockAdjustmentTransactionBestEffort =
  syncInventoryTransactionBestEffort;

export async function createInventoryTransaction(
  workspaceId: string,
  input: InventoryTransactionInput,
  options?: {
    id?: string;
    timestamp?: string;
    skipRemoteSync?: boolean;
    targetQuantity?: number;
  },
) {
  const timestamp = options?.timestamp || new Date().toISOString();
  const normalized = normalizeTransactionInput(input);
  const shouldSync = shouldSyncInventoryTransaction(
    workspaceId,
    normalized.transactionType,
  );

  const transaction: InventoryTransaction = {
    id: options?.id || generateId(),
    workspaceId,
    ...normalized,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    isDeleted: false,
    syncStatus: shouldSync ? "pending" : "synced",
    lastSyncedAt: shouldSync ? null : timestamp,
  };

  if (!options?.skipRemoteSync && shouldSync) {
    return syncInventoryTransactionBestEffort(transaction, {
      targetQuantity: options?.targetQuantity,
    });
  }

  await db.inventory_transactions.put(transaction);
  return transaction;
}

export async function hydrateInventoryTransactionsFromSupabase(
  workspaceId: string,
) {
  if (isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) {
    return;
  }

  const client = getSupabaseClientForTable(TABLE_NAME);
  const remoteTransactions: InventoryTransaction[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await runSupabaseAction(
      `${TABLE_NAME}.hydrate`,
      () =>
        client
          .from(TABLE_NAME)
          .select("*")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .range(from, from + pageSize - 1),
    );

    if (error) {
      console.error("[InventoryTransactions] Failed to hydrate ledger:", error);
      return;
    }

    remoteTransactions.push(
      ...((data ?? []).map((row) => ({
        ...(toCamelCase(row) as unknown as InventoryTransaction),
        syncStatus: "synced" as const,
        lastSyncedAt: new Date().toISOString(),
      }))),
    );

    if (!data || data.length < pageSize) {
      break;
    }
  }

  if (remoteTransactions.length > 0) {
    await withoutInventoryTransactionChangeEvents(() =>
      db.inventory_transactions.bulkPut(remoteTransactions),
    );
  }
}

/** Fetch newly committed source movements without reloading the full ledger. */
export async function hydrateInventoryTransactionsForReferences(
  workspaceId: string,
  referenceIds: ReadonlyArray<string | null | undefined>,
) {
  const ids = Array.from(new Set(referenceIds.filter((value): value is string => Boolean(value?.trim()))));
  if (ids.length === 0 || isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) {
    return [] as InventoryTransaction[];
  }

  const client = getSupabaseClientForTable(TABLE_NAME);
  let data: Record<string, unknown>[] | null;
  let error: unknown;
  try {
    ({ data, error } = await runSupabaseAction(
      `${TABLE_NAME}.hydrateReferences`,
      () => client
        .from(TABLE_NAME)
        .select("*")
        .eq("workspace_id", workspaceId)
        .in("reference_id", ids),
    ));
  } catch (requestError) {
    console.error("[InventoryTransactions] Failed to hydrate source movements:", requestError);
    return [] as InventoryTransaction[];
  }
  if (error) {
    // The authoritative transaction already committed. Keep the UI usable and
    // let the normal workspace ledger hydration reconcile on its next refresh.
    console.error("[InventoryTransactions] Failed to hydrate source movements:", error);
    return [] as InventoryTransaction[];
  }

  const syncedAt = new Date().toISOString();
  const transactions = (data ?? []).map((row) => ({
    ...(toCamelCase(row as Record<string, unknown>) as unknown as InventoryTransaction),
    syncStatus: "synced" as const,
    lastSyncedAt: syncedAt,
  }));
  if (transactions.length > 0) {
    try {
      await db.inventory_transactions.bulkPut(transactions);
    } catch (cacheError) {
      console.error("[InventoryTransactions] Failed to cache source movements:", cacheError);
      return [] as InventoryTransaction[];
    }
  }
  return transactions;
}

export function filterInventoryTransactions(
  transactions: InventoryTransaction[],
  filters: InventoryTransactionFilterOptions,
) {
  const startTime = filters.startDate
    ? new Date(filters.startDate).setHours(0, 0, 0, 0)
    : null;
  const endTime = filters.endDate
    ? new Date(filters.endDate).setHours(23, 59, 59, 999)
    : null;

  return transactions.filter((transaction) => {
    if (filters.productId && transaction.productId !== filters.productId) {
      return false;
    }

    if (filters.storageId && transaction.storageId !== filters.storageId) {
      return false;
    }

    if (
      filters.transactionType &&
      transaction.transactionType !== filters.transactionType
    ) {
      return false;
    }

    const createdAt = new Date(transaction.createdAt).getTime();
    if (startTime !== null && createdAt < startTime) {
      return false;
    }

    if (endTime !== null && createdAt > endTime) {
      return false;
    }

    return true;
  });
}

export function getInventoryTransactionsForProduct(
  transactions: InventoryTransaction[],
  productId: string,
) {
  return filterInventoryTransactions(transactions, { productId });
}

export function getInventoryTransactionsForStorage(
  transactions: InventoryTransaction[],
  storageId: string,
) {
  return filterInventoryTransactions(transactions, { storageId });
}

export function getInventoryTransactionsForType(
  transactions: InventoryTransaction[],
  transactionType: InventoryTransactionType,
) {
  return filterInventoryTransactions(transactions, { transactionType });
}

export function getInventoryTransactionsInDateRange(
  transactions: InventoryTransaction[],
  startDate?: Date | string | null,
  endDate?: Date | string | null,
) {
  return filterInventoryTransactions(transactions, { startDate, endDate });
}

export function useInventoryTransactions(workspaceId: string | undefined) {
  const storageAccess = useStorageAccess(workspaceId);
  const transactions = useLiveQuery(async () => {
    if (!workspaceId) {
      return [];
    }

    const rows = await db.inventory_transactions
      .where("workspaceId")
      .equals(workspaceId)
      .and((row) => !row.isDeleted)
      .toArray();

    return rows.filter((row) => canAccessStorage(row.storageId, storageAccess)).sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    );
  }, [storageAccess.signature, workspaceId]);

  return transactions ?? [];
}

export type InventoryMovementDirection = "all" | "incoming" | "outgoing";
export type InventoryMovementSource =
  | "all"
  | "stock-adjustment"
  | "transfer"
  | "pos-sale"
  | "pos-return"
  | "sales-order"
  | "sales-order-return"
  | "purchase-order"
  | "initial-stock"
  | "inventory-change"
  | "sale-product-exchange"
  | "sale-product-exchange-return";
export type InventorySnapshotFilter = "all" | "recorded" | "not-recorded";

export interface InventoryTransactionListFilters {
  productId: string | null;
  direction: InventoryMovementDirection;
  source: InventoryMovementSource;
  storageId: string | null;
  snapshot: InventorySnapshotFilter;
}

export interface InventoryTransactionListQuery {
  workspaceId?: string;
  page: number;
  pageSize: number;
  startAt?: string;
  endBefore?: string;
  filters: InventoryTransactionListFilters;
}

export interface InventoryTransactionListPage {
  rows: InventoryTransaction[];
  totalCount: number;
  pageCount: number;
}

export interface InventoryTransactionProductSummary {
  productId: string;
  productName: string | null;
  sku: string | null;
  unit: string | null;
  incoming: number;
  outgoing: number;
  balance: number;
}

export interface InventoryTransactionProductSummaryPage {
  rows: InventoryTransactionProductSummary[];
  totalCount: number;
  pageCount: number;
}

const EMPTY_INVENTORY_TRANSACTION_PAGE: InventoryTransactionListPage = {
  rows: [],
  totalCount: 0,
  pageCount: 1,
};

const EMPTY_INVENTORY_TRANSACTION_SUMMARY_PAGE: InventoryTransactionProductSummaryPage = {
  rows: [],
  totalCount: 0,
  pageCount: 1,
};

const inventoryTransactionTypes = new Set<InventoryTransactionType>([
  "stock_adjustment",
  "transfer_in",
  "transfer_out",
  "sale",
  "return",
  "purchase",
  "initial_stock",
  "inventory_change",
]);

export function getInventoryTransactionMovementSource(
  transactionType: InventoryTransactionType,
  referenceType?: string | null,
): Exclude<InventoryMovementSource, "all"> {
  switch (referenceType) {
    case "pos_sale":
      return "pos-sale";
    case "pos_return":
      return "pos-return";
    case "sales_order":
      return "sales-order";
    case "sales_order_return":
      return "sales-order-return";
    case "purchase_order":
    case "purchase_order_repair":
      return "purchase-order";
    case "inventory_transfer":
    case "inventory_transfer_rollback":
    case "reorder_transfer":
      return "transfer";
    case "sale_product_exchange":
      return "sale-product-exchange";
    case "sale_product_exchange_return":
      return "sale-product-exchange-return";
  }

  switch (transactionType) {
    case "stock_adjustment":
      return "stock-adjustment";
    case "transfer_in":
    case "transfer_out":
      return "transfer";
    case "purchase":
      return "purchase-order";
    case "initial_stock":
      return "initial-stock";
    default:
      return "inventory-change";
  }
}

function normalizeInventoryTransactionRow(
  value: unknown,
  workspaceId: string,
): InventoryTransaction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = toCamelCase(value as Record<string, unknown>) as Record<string, unknown>;
  const quantityDelta = Number(row.quantityDelta);
  const previousQuantity = row.previousQuantity == null
    ? null
    : Number(row.previousQuantity);
  const newQuantity = row.newQuantity == null
    ? null
    : Number(row.newQuantity);
  if (
    typeof row.id !== "string" ||
    row.workspaceId !== workspaceId ||
    typeof row.productId !== "string" ||
    typeof row.storageId !== "string" ||
    typeof row.createdAt !== "string" ||
    Number.isNaN(Date.parse(row.createdAt)) ||
    !inventoryTransactionTypes.has(row.transactionType as InventoryTransactionType) ||
    !Number.isFinite(quantityDelta) ||
    (previousQuantity !== null && !Number.isFinite(previousQuantity)) ||
    (newQuantity !== null && !Number.isFinite(newQuantity))
  ) {
    return null;
  }

  return {
    ...row,
    id: row.id,
    workspaceId,
    productId: row.productId,
    storageId: row.storageId,
    createdAt: row.createdAt,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : row.createdAt,
    transactionType: row.transactionType as InventoryTransactionType,
    quantityDelta,
    previousQuantity: previousQuantity as number,
    newQuantity: newQuantity as number,
    isDeleted: row.isDeleted === true,
  } as InventoryTransaction;
}

function getRemoteInventoryTransactionArgs(
  query: InventoryTransactionListQuery,
  access: ReturnType<typeof useStorageAccess>,
) {
  return {
    p_workspace_id: query.workspaceId,
    p_page: Math.max(1, Math.floor(query.page)),
    p_page_size: Math.max(1, Math.floor(query.pageSize)),
    p_start_at: query.startAt ?? null,
    p_end_before: query.endBefore ?? null,
    p_product_id: query.filters.productId,
    p_direction: query.filters.direction,
    p_source: query.filters.source,
    p_storage_id: query.filters.storageId,
    p_excluded_storage_ids: access.isAdmin
      ? []
      : Array.from(access.excludedStorageIds),
    p_snapshot: query.filters.snapshot,
  };
}

function normalizeInventoryTransactionPage(
  value: unknown,
  workspaceId: string,
  pageSize: number,
): InventoryTransactionListPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid inventory transaction page response.");
  }
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.rows)) {
    throw new Error("Invalid inventory transaction rows.");
  }
  const totalCount = Number(payload.total_count);
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new Error("Invalid inventory transaction count.");
  }
  const rows = payload.rows.map((row) => normalizeInventoryTransactionRow(row, workspaceId));
  if (rows.some((row) => row === null)) {
    throw new Error("Invalid inventory transaction record.");
  }
  return {
    rows: rows as InventoryTransaction[],
    totalCount,
    pageCount: Math.max(1, Math.ceil(totalCount / Math.max(1, pageSize))),
  };
}

async function cacheRemoteInventoryTransactions(rows: readonly InventoryTransaction[]) {
  if (rows.length === 0) return;
  const existingRows = await db.inventory_transactions.bulkGet(rows.map((row) => row.id));
  const fetchedAt = new Date().toISOString();
  const cacheRows = rows.flatMap((row, index) => {
    const existing = existingRows[index];
    if (existing?.syncStatus === "pending" || existing?.syncStatus === "conflict") {
      return [];
    }
    const existingUpdatedAt = Date.parse(existing?.updatedAt || "");
    const remoteUpdatedAt = Date.parse(row.updatedAt || "");
    if (
      existing &&
      Number.isFinite(existingUpdatedAt) &&
      Number.isFinite(remoteUpdatedAt) &&
      remoteUpdatedAt <= existingUpdatedAt
    ) {
      return [];
    }
    return [{ ...row, syncStatus: "synced" as const, lastSyncedAt: fetchedAt }];
  });
  if (cacheRows.length > 0) {
    await withoutInventoryTransactionChangeEvents(() =>
      db.inventory_transactions.bulkPut(cacheRows),
    );
  }
}

async function fetchRemoteInventoryTransactionPage(
  query: InventoryTransactionListQuery,
  access: ReturnType<typeof useStorageAccess>,
  signal?: AbortSignal,
): Promise<InventoryTransactionListPage> {
  if (!query.workspaceId) return EMPTY_INVENTORY_TRANSACTION_PAGE;
  const response = await runSupabaseAction("inventoryTransactions.listPage", () => {
    const request = getSupabaseClientForTable(TABLE_NAME).rpc(
      "get_inventory_transactions_list_page",
      getRemoteInventoryTransactionArgs(query, access),
    );
    return signal ? request.abortSignal(signal) : request;
  });
  if (response.error) {
    throw normalizeSupabaseActionError(response.error);
  }
  if (signal?.aborted) throw signal.reason ?? new Error("Inventory transaction request cancelled.");

  const page = normalizeInventoryTransactionPage(
    response.data,
    query.workspaceId,
    query.pageSize,
  );
  await cacheRemoteInventoryTransactions(page.rows);
  return page;
}

function getLocalInventoryTransactionCollection(query: InventoryTransactionListQuery) {
  const workspaceId = query.workspaceId!;
  const startAt = query.startAt ?? Dexie.minKey;
  const endBefore = query.endBefore ?? Dexie.maxKey;
  const endId = query.endBefore ? Dexie.minKey : Dexie.maxKey;
  const includeUpper = !query.endBefore;
  const productId = query.filters.productId;
  const storageId = query.filters.storageId;

  if (productId) {
    return db.inventory_transactions
      .where("[workspaceId+productId+createdAt+id]")
      .between(
        [workspaceId, productId, startAt, Dexie.minKey],
        [workspaceId, productId, endBefore, endId],
        true,
        includeUpper,
      );
  }

  if (storageId) {
    return db.inventory_transactions
      .where("[workspaceId+storageId+createdAt+id]")
      .between(
        [workspaceId, storageId, startAt, Dexie.minKey],
        [workspaceId, storageId, endBefore, endId],
        true,
        includeUpper,
      );
  }

  return db.inventory_transactions
    .where("[workspaceId+createdAt+id]")
    .between(
      [workspaceId, startAt, Dexie.minKey],
      [workspaceId, endBefore, endId],
      true,
      includeUpper,
    );
}

function matchesInventoryTransactionListFilters(
  transaction: InventoryTransaction,
  query: InventoryTransactionListQuery,
  access: ReturnType<typeof useStorageAccess>,
  serviceProductIds: ReadonlySet<string>,
) {
  const { filters } = query;
  if (
    transaction.workspaceId !== query.workspaceId ||
    transaction.isDeleted ||
    !access.canAccessStorage(transaction.storageId) ||
    serviceProductIds.has(transaction.productId)
  ) {
    return false;
  }
  if (filters.productId && transaction.productId !== filters.productId) return false;
  if (filters.storageId && transaction.storageId !== filters.storageId) return false;

  const movementSource = getInventoryTransactionMovementSource(
    transaction.transactionType,
    transaction.referenceType,
  );
  if (filters.source !== "all" && movementSource !== filters.source) return false;
  if (
    filters.direction === "incoming" && transaction.quantityDelta <= 0 ||
    filters.direction === "outgoing" && transaction.quantityDelta >= 0
  ) {
    return false;
  }

  const hasSnapshot =
    transaction.previousQuantity !== null &&
    transaction.previousQuantity !== undefined &&
    transaction.newQuantity !== null &&
    transaction.newQuantity !== undefined;
  if (filters.snapshot === "recorded" && !hasSnapshot) return false;
  if (filters.snapshot === "not-recorded" && hasSnapshot) return false;
  return true;
}

async function getServiceProductIds(workspaceId: string) {
  const ids = await db.products
    .where("workspaceId")
    .equals(workspaceId)
    .filter((product) => product.isService === true)
    .primaryKeys();
  return new Set(ids.map(String));
}

async function fetchLocalInventoryTransactionPage(
  query: InventoryTransactionListQuery,
  access: ReturnType<typeof useStorageAccess>,
  signal?: AbortSignal,
): Promise<InventoryTransactionListPage> {
  if (!query.workspaceId || access.isReady === false) {
    return EMPTY_INVENTORY_TRANSACTION_PAGE;
  }
  const serviceProductIds = await getServiceProductIds(query.workspaceId);
  const offset = (Math.max(1, query.page) - 1) * Math.max(1, query.pageSize);
  const limit = Math.max(1, query.pageSize);
  const rows: InventoryTransaction[] = [];
  let totalCount = 0;

  await getLocalInventoryTransactionCollection(query).reverse().each((row) => {
    if (signal?.aborted) return false;
    if (!matchesInventoryTransactionListFilters(row, query, access, serviceProductIds)) {
      return;
    }
    if (totalCount >= offset && rows.length < limit) rows.push(row);
    totalCount += 1;
  });
  if (signal?.aborted) throw signal.reason ?? new Error("Inventory transaction request cancelled.");

  return {
    rows,
    totalCount,
    pageCount: Math.max(1, Math.ceil(totalCount / limit)),
  };
}

function getInventoryTransactionQueryKeyParts(
  query: InventoryTransactionListQuery,
  sourceMode: "remote" | "local",
) {
  return {
    workspaceId: query.workspaceId,
    page: query.page,
    pageSize: query.pageSize,
    startAt: query.startAt,
    endBefore: query.endBefore,
    ...query.filters,
    sort: "createdAt:desc,id:desc" as const,
    sourceMode,
    viewer: {
      userId: getActiveBusinessUserId(),
      role: getActiveBusinessUserRole(),
      storageScope: "",
    },
  };
}

export function useInventoryTransactionsPage(
  query: InventoryTransactionListQuery,
  enabled = true,
  onlineOverride?: boolean,
) {
  const access = useStorageAccess(query.workspaceId);
  const online = onlineOverride ?? isOnline(query.workspaceId);
  const sourceMode = query.workspaceId && online && !isLocalWorkspaceMode(query.workspaceId)
    ? "remote"
    : "local";
  const keyParts = getInventoryTransactionQueryKeyParts(query, sourceMode);
  keyParts.viewer.storageScope = access.signature;

  return useQuery({
    queryKey: queryKeys.inventoryTransactions.page(keyParts),
    queryFn: ({ signal }) => sourceMode === "remote"
      ? fetchRemoteInventoryTransactionPage(query, access, signal)
      : fetchLocalInventoryTransactionPage(query, access, signal),
    enabled: enabled && Boolean(query.workspaceId) && access.isReady !== false,
    placeholderData: undefined,
  });
}

function normalizeProductSummaryPage(
  value: unknown,
  pageSize: number,
): InventoryTransactionProductSummaryPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid inventory product summary response.");
  }
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.rows)) throw new Error("Invalid inventory product summary rows.");
  const totalCount = Number(payload.total_count);
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new Error("Invalid inventory product summary count.");
  }
  const rows = payload.rows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = toCamelCase(value as Record<string, unknown>) as Record<string, unknown>;
    if (typeof row.productId !== "string") return null;
    const incoming = Number(row.incoming);
    const outgoing = Number(row.outgoing);
    const balance = Number(row.balance);
    if (![incoming, outgoing, balance].every(Number.isFinite)) return null;
    return {
      productId: row.productId,
      productName: typeof row.productName === "string" ? row.productName : null,
      sku: typeof row.sku === "string" ? row.sku : null,
      unit: typeof row.unit === "string" ? row.unit : null,
      incoming,
      outgoing,
      balance,
    } satisfies InventoryTransactionProductSummary;
  });
  if (rows.some((row) => row === null)) {
    throw new Error("Invalid inventory product summary record.");
  }
  return {
    rows: rows as InventoryTransactionProductSummary[],
    totalCount,
    pageCount: Math.max(1, Math.ceil(totalCount / Math.max(1, pageSize))),
  };
}

async function aggregateLocalInventoryTransactions(
  query: InventoryTransactionListQuery,
  access: ReturnType<typeof useStorageAccess>,
  signal?: AbortSignal,
) {
  if (!query.workspaceId || access.isReady === false) return new Map<string, { incoming: number; outgoing: number }>();
  const serviceProductIds = await getServiceProductIds(query.workspaceId);
  const totals = new Map<string, { incoming: number; outgoing: number }>();
  await getLocalInventoryTransactionCollection(query).reverse().each((row) => {
    if (signal?.aborted) return false;
    if (!matchesInventoryTransactionListFilters(row, query, access, serviceProductIds)) return;
    const current = totals.get(row.productId) ?? { incoming: 0, outgoing: 0 };
    if (row.quantityDelta > 0) current.incoming += row.quantityDelta;
    else current.outgoing += Math.abs(row.quantityDelta);
    totals.set(row.productId, current);
  });
  if (signal?.aborted) throw signal.reason ?? new Error("Inventory transaction request cancelled.");
  return totals;
}

async function localProductSummaryPageFromTotals(
  totals: ReadonlyMap<string, { incoming: number; outgoing: number }>,
  query: InventoryTransactionListQuery,
): Promise<InventoryTransactionProductSummaryPage> {
  const productIds = Array.from(totals.keys()).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const offset = (Math.max(1, query.page) - 1) * Math.max(1, query.pageSize);
  const pageIds = productIds.slice(offset, offset + Math.max(1, query.pageSize));
  const products = await db.products.bulkGet(pageIds);
  const rows = pageIds.flatMap((productId, index) => {
    const totalsForProduct = totals.get(productId);
    if (!totalsForProduct) return [];
    const product = products[index];
    return [{
      productId,
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      unit: product?.unit ?? null,
      incoming: totalsForProduct.incoming,
      outgoing: totalsForProduct.outgoing,
      balance: totalsForProduct.incoming - totalsForProduct.outgoing,
    }];
  });
  return {
    rows,
    totalCount: productIds.length,
    pageCount: Math.max(1, Math.ceil(productIds.length / Math.max(1, query.pageSize))),
  };
}

async function fetchRemoteInventoryTransactionProductSummaryPage(
  query: InventoryTransactionListQuery,
  access: ReturnType<typeof useStorageAccess>,
  signal?: AbortSignal,
) {
  if (!query.workspaceId) return EMPTY_INVENTORY_TRANSACTION_SUMMARY_PAGE;
  const response = await runSupabaseAction("inventoryTransactions.productSummaryPage", () => {
    const request = getSupabaseClientForTable(TABLE_NAME).rpc(
      "get_inventory_transaction_product_summary_page",
      getRemoteInventoryTransactionArgs(query, access),
    );
    return signal ? request.abortSignal(signal) : request;
  });
  if (response.error) throw normalizeSupabaseActionError(response.error);
  if (signal?.aborted) throw signal.reason ?? new Error("Inventory summary request cancelled.");
  return normalizeProductSummaryPage(response.data, query.pageSize);
}

export function useInventoryTransactionProductSummaryPage(
  query: InventoryTransactionListQuery,
  enabled = true,
  onlineOverride?: boolean,
) {
  const access = useStorageAccess(query.workspaceId);
  const online = onlineOverride ?? isOnline(query.workspaceId);
  const sourceMode = query.workspaceId && online && !isLocalWorkspaceMode(query.workspaceId)
    ? "remote"
    : "local";
  const keyParts = getInventoryTransactionQueryKeyParts(query, sourceMode);
  keyParts.viewer.storageScope = access.signature;
  const summaryKeyParts = { ...keyParts, sort: "productId:asc" as const };

  return useQuery({
    queryKey: queryKeys.inventoryTransactions.productSummaryPage(summaryKeyParts),
    queryFn: async ({ signal }) => {
      if (sourceMode === "remote") {
        return fetchRemoteInventoryTransactionProductSummaryPage(query, access, signal);
      }
      const totals = await aggregateLocalInventoryTransactions(query, access, signal);
      return localProductSummaryPageFromTotals(totals, query);
    },
    enabled: enabled && Boolean(query.workspaceId) && access.isReady !== false,
    placeholderData: undefined,
  });
}

export async function fetchAllInventoryTransactionProductSummary(
  query: InventoryTransactionListQuery,
  access: ReturnType<typeof useStorageAccess>,
  onlineOverride?: boolean,
) {
  if (!query.workspaceId || access.isReady === false) return [] as InventoryTransactionProductSummary[];
  const exportPageSize = 250;
  const exportQuery = { ...query, page: 1, pageSize: exportPageSize };
  const online = (onlineOverride ?? isOnline(query.workspaceId))
    && !isLocalWorkspaceMode(query.workspaceId);

  if (online) {
    const firstPage = await fetchRemoteInventoryTransactionProductSummaryPage(exportQuery, access);
    const rows = [...firstPage.rows];
    for (let page = 2; page <= firstPage.pageCount; page += 1) {
      const result = await fetchRemoteInventoryTransactionProductSummaryPage(
        { ...exportQuery, page },
        access,
      );
      rows.push(...result.rows);
    }
    return rows;
  }

  const totals = await aggregateLocalInventoryTransactions(exportQuery, access);
  const productIds = Array.from(totals.keys()).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const rows: InventoryTransactionProductSummary[] = [];
  for (let offset = 0; offset < productIds.length; offset += exportPageSize) {
    const pageIds = productIds.slice(offset, offset + exportPageSize);
    const products = await db.products.bulkGet(pageIds);
    for (let index = 0; index < pageIds.length; index += 1) {
      const productId = pageIds[index];
      const productTotals = totals.get(productId);
      if (!productTotals) continue;
      const product = products[index];
      rows.push({
        productId,
        productName: product?.name ?? null,
        sku: product?.sku ?? null,
        unit: product?.unit ?? null,
        incoming: productTotals.incoming,
        outgoing: productTotals.outgoing,
        balance: productTotals.incoming - productTotals.outgoing,
      });
    }
  }
  return rows;
}

export interface InventoryTransactionIntegrityIssue {
  id: string;
  productId: string;
  storageId: string;
  createdAt: string;
  quantityDelta: number | null;
  previousQuantity: number | null;
  newQuantity: number | null;
  expectedNewQuantity: number | null;
}

export interface InventoryTransactionIntegrityAuditReport {
  checkedCount: number;
  arithmeticCheckedCount: number;
  consistentCount: number;
  inconsistentCount: number;
  unverifiableCount: number;
  issues: InventoryTransactionIntegrityIssue[];
}

export interface InventoryTransactionIntegrityAuditProgress {
  checkedCount: number;
  totalCount: number | null;
}

export interface InventoryTransactionIntegrityAuditOptions {
  signal?: AbortSignal;
  online?: boolean;
  expectedTotalCount?: number;
  onProgress?: (progress: InventoryTransactionIntegrityAuditProgress) => void;
}

const INVENTORY_TRANSACTION_AUDIT_BATCH_SIZE = 250;

function createInventoryTransactionIntegrityAuditReport(
  checkedCount: number,
  unverifiableCount: number,
  issues: InventoryTransactionIntegrityIssue[],
): InventoryTransactionIntegrityAuditReport {
  const arithmeticCheckedCount = Math.max(0, checkedCount - unverifiableCount);
  return {
    checkedCount,
    arithmeticCheckedCount,
    consistentCount: Math.max(0, arithmeticCheckedCount - issues.length),
    inconsistentCount: issues.length,
    unverifiableCount,
    issues,
  };
}

/** Audits every transaction matching the active list filters, across source pages. */
export async function auditInventoryTransactionIntegrity(
  query: InventoryTransactionListQuery,
  access: ReturnType<typeof useStorageAccess>,
  options: InventoryTransactionIntegrityAuditOptions = {},
): Promise<InventoryTransactionIntegrityAuditReport> {
  if (!query.workspaceId || access.isReady === false) {
    throw new Error("Inventory transaction access is not ready.");
  }

  const issues: InventoryTransactionIntegrityIssue[] = [];
  let checkedCount = 0;
  let unverifiableCount = 0;
  const signal = options.signal;
  const reportProgress = (totalCount: number | null) => {
    options.onProgress?.({ checkedCount, totalCount });
  };

  const inspectTransaction = (transaction: InventoryTransaction) => {
    checkedCount += 1;
    const quantityDelta = transaction.quantityDelta as unknown;
    const previousQuantity = transaction.previousQuantity as unknown;
    const newQuantity = transaction.newQuantity as unknown;
    const deltaValue = typeof quantityDelta === "number" ? quantityDelta : null;
    const previousValue = typeof previousQuantity === "number" ? previousQuantity : null;
    const newValue = typeof newQuantity === "number" ? newQuantity : null;
    const deltaIsFinite = deltaValue !== null && Number.isFinite(deltaValue);
    const previousIsFinite = typeof previousQuantity === "number" && Number.isFinite(previousQuantity);
    const newIsFinite = typeof newQuantity === "number" && Number.isFinite(newQuantity);

    if (!deltaIsFinite) {
      issues.push({
        id: transaction.id,
        productId: transaction.productId,
        storageId: transaction.storageId,
        createdAt: transaction.createdAt,
        quantityDelta: deltaValue,
        previousQuantity: previousValue,
        newQuantity: newValue,
        expectedNewQuantity: null,
      });
      return;
    }

    if (previousQuantity == null || newQuantity == null) {
      unverifiableCount += 1;
      return;
    }

    const expectedValue = previousIsFinite
      ? previousValue! + deltaValue!
      : Number.NaN;
    const expectedNewQuantity = Number.isFinite(expectedValue)
      ? roundQuantity(expectedValue)
      : null;
    if (
      !previousIsFinite ||
      !newIsFinite ||
      expectedNewQuantity === null ||
      !quantitiesEqual(expectedValue, newValue!)
    ) {
      issues.push({
        id: transaction.id,
        productId: transaction.productId,
        storageId: transaction.storageId,
        createdAt: transaction.createdAt,
        quantityDelta: deltaValue,
        previousQuantity: previousValue,
        newQuantity: newValue,
        expectedNewQuantity,
      });
    }
  };

  const online = (options.online ?? isOnline(query.workspaceId))
    && !isLocalWorkspaceMode(query.workspaceId);

  if (online) {
    const auditPageSize = INVENTORY_TRANSACTION_AUDIT_BATCH_SIZE;
    const firstPage = await fetchRemoteInventoryTransactionPage(
      { ...query, page: 1, pageSize: auditPageSize },
      access,
      signal,
    );
    const totalCount = firstPage.totalCount;
    for (let page = 1; page <= firstPage.pageCount; page += 1) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Inventory transaction audit cancelled.");
      }
      const result = page === 1
        ? firstPage
        : await fetchRemoteInventoryTransactionPage(
          { ...query, page, pageSize: auditPageSize },
          access,
          signal,
        );
      result.rows.forEach(inspectTransaction);
      reportProgress(totalCount);
    }
    return createInventoryTransactionIntegrityAuditReport(
      checkedCount,
      unverifiableCount,
      issues,
    );
  }

  const serviceProductIds = await getServiceProductIds(query.workspaceId);
  const expectedTotalCount = Number.isFinite(options.expectedTotalCount)
    ? Math.max(0, options.expectedTotalCount!)
    : null;
  await getLocalInventoryTransactionCollection(query).reverse().each((transaction) => {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Inventory transaction audit cancelled.");
    }
    if (!matchesInventoryTransactionListFilters(
      transaction,
      query,
      access,
      serviceProductIds,
    )) {
      return;
    }
    inspectTransaction(transaction);
    if (checkedCount % INVENTORY_TRANSACTION_AUDIT_BATCH_SIZE === 0) {
      reportProgress(expectedTotalCount);
    }
  });
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Inventory transaction audit cancelled.");
  }
  reportProgress(expectedTotalCount ?? checkedCount);
  return createInventoryTransactionIntegrityAuditReport(
    checkedCount,
    unverifiableCount,
    issues,
  );
}

export function useInventoryTransactionPagesChanged(workspaceId?: string) {
  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") return;
    const handleChanged = (event: Event) => {
      const changedWorkspaceIds = (event as CustomEvent<{ workspaceIds?: string[] }>).detail
        ?.workspaceIds;
      if (!changedWorkspaceIds?.includes(workspaceId)) return;
      void import("@/query/queryClient").then(({ queryClient }) =>
        queryClient.invalidateQueries({
          queryKey: queryKeys.inventoryTransactions.all(workspaceId),
        }),
      );
    };
    window.addEventListener(INVENTORY_TRANSACTIONS_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(INVENTORY_TRANSACTIONS_CHANGED_EVENT, handleChanged);
  }, [workspaceId]);
}

export interface InventoryTransactionPageRelations {
  products: Product[];
  storages: Storage[];
  transferBatches: InventoryTransferBatch[];
  sales: Sale[];
  saleReturns: SaleReturn[];
  salesOrders: SalesOrder[];
  purchaseOrders: PurchaseOrder[];
  salesOrderReturnItems: OrderReturnItem[];
}

export function useInventoryTransactionProduct(
  workspaceId?: string,
  productId?: string | null,
) {
  return useLiveQuery(async () => {
    if (!workspaceId || !productId) return undefined;
    const product = await db.products.get(productId);
    return product?.workspaceId === workspaceId && !product.isDeleted
      ? product
      : undefined;
  }, [productId, workspaceId]);
}

type WorkspaceRelatedRecord = {
  id: string;
  workspaceId: string;
  updatedAt?: string;
  syncStatus?: string;
  lastSyncedAt?: string | null;
};

async function cacheInventoryTransactionRelatedRows<T extends WorkspaceRelatedRecord>(
  table: Table<T, string, InsertType<T, "id">>,
  rows: readonly T[],
) {
  if (rows.length === 0) return;
  const existingRows = await table.bulkGet(rows.map((row) => row.id));
  const syncedAt = new Date().toISOString();
  const cacheRows = rows.flatMap((row, index) => {
    const existing = existingRows[index];
    if (existing?.syncStatus === "pending" || existing?.syncStatus === "conflict") return [];
    const existingUpdatedAt = Date.parse(existing?.updatedAt || "");
    const remoteUpdatedAt = Date.parse(row.updatedAt || "");
    if (
      existing &&
      Number.isFinite(existingUpdatedAt) &&
      Number.isFinite(remoteUpdatedAt) &&
      remoteUpdatedAt <= existingUpdatedAt
    ) {
      return [];
    }
    return [{ ...existing, ...row, syncStatus: "synced", lastSyncedAt: syncedAt } as T];
  });
  if (cacheRows.length > 0) await table.bulkPut(cacheRows);
}

async function fetchInventoryTransactionRelatedRows<T extends WorkspaceRelatedRecord>(
  tableName: string,
  workspaceId: string,
  ids: readonly string[],
  signal: AbortSignal,
  filterColumn = "id",
): Promise<T[]> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0 || signal.aborted) return [];
  try {
    const response = await runSupabaseAction(`inventoryTransactions.pageRelations.${tableName}`, () => {
      const request = getSupabaseClientForTable(tableName)
        .from(tableName)
        .select("*")
        .eq("workspace_id", workspaceId)
        .in(filterColumn, uniqueIds);
      return request.abortSignal(signal);
    });
    if (response.error) return [];
    return (response.data ?? []).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = toCamelCase(value as Record<string, unknown>) as Record<string, unknown>;
      if (typeof row.id !== "string" || row.workspaceId !== workspaceId) return [];
      return [row as T];
    });
  } catch {
    return [];
  }
}

async function hydrateInventoryTransactionPageRelations(
  workspaceId: string,
  transactions: readonly InventoryTransaction[],
  signal: AbortSignal,
) {
  const bySource = (source: string) => Array.from(new Set(
    transactions.flatMap((transaction) => getInventoryTransactionMovementSource(
      transaction.transactionType,
      transaction.referenceType,
    ) === source
      ? [transaction.referenceId || transaction.id]
      : []),
  ));
  const productIds = Array.from(new Set(transactions.map((transaction) => transaction.productId)));
  const transactionStorageIds = Array.from(new Set(transactions.map((transaction) => transaction.storageId)));
  const transferBatchIds = Array.from(new Set(transactions.flatMap((transaction) =>
    getInventoryTransactionMovementSource(transaction.transactionType, transaction.referenceType) === "transfer"
      ? [transaction.transferBatchId, transaction.referenceId].filter((id): id is string => Boolean(id))
      : [],
  )));
  const posSaleIds = bySource("pos-sale");
  const posReturnIds = bySource("pos-return");
  const salesOrderIds = bySource("sales-order");
  const salesOrderReturnIds = bySource("sales-order-return");
  const purchaseOrderIds = bySource("purchase-order");

  const [products, transferBatches, directSales, saleReturns, directSalesOrders, purchaseOrders, returnItems] = await Promise.all([
    fetchInventoryTransactionRelatedRows<Product>("products", workspaceId, productIds, signal),
    fetchInventoryTransactionRelatedRows<InventoryTransferBatch>("inventory_transfer_batches", workspaceId, transferBatchIds, signal),
    fetchInventoryTransactionRelatedRows<Sale>("sales", workspaceId, posSaleIds, signal),
    fetchInventoryTransactionRelatedRows<SaleReturn>("sale_returns", workspaceId, posReturnIds, signal),
    fetchInventoryTransactionRelatedRows<SalesOrder>("sales_orders", workspaceId, salesOrderIds, signal),
    fetchInventoryTransactionRelatedRows<PurchaseOrder>("purchase_orders", workspaceId, purchaseOrderIds, signal),
    fetchInventoryTransactionRelatedRows<OrderReturnItem>("order_return_items", workspaceId, salesOrderReturnIds, signal, "return_id"),
  ]);
  if (signal.aborted) return;

  const storageIds = Array.from(new Set([
    ...transactionStorageIds,
    ...transferBatches.flatMap((batch) => [batch.sourceStorageId, batch.destinationStorageId]
      .filter((id): id is string => Boolean(id))),
  ]));
  const storages = await fetchInventoryTransactionRelatedRows<Storage>("storages", workspaceId, storageIds, signal);
  if (signal.aborted) return;

  const saleIds = Array.from(new Set([
    ...posSaleIds,
    ...saleReturns.flatMap((saleReturn) => typeof saleReturn.saleId === "string" ? [saleReturn.saleId] : []),
  ]));
  const relatedSales = saleReturns.length === 0
    ? directSales
    : await fetchInventoryTransactionRelatedRows<Sale>("sales", workspaceId, saleIds, signal);
  const relatedOrderIds = Array.from(new Set([
    ...salesOrderIds,
    ...returnItems.flatMap((item) => typeof item.orderId === "string" ? [item.orderId] : []),
  ]));
  const relatedSalesOrders = returnItems.length === 0
    ? directSalesOrders
    : await fetchInventoryTransactionRelatedRows<SalesOrder>("sales_orders", workspaceId, relatedOrderIds, signal);

  await Promise.all([
    cacheInventoryTransactionRelatedRows(db.products, products),
    cacheInventoryTransactionRelatedRows(db.storages, storages),
    cacheInventoryTransactionRelatedRows(db.inventory_transfer_batches, transferBatches),
    cacheInventoryTransactionRelatedRows(db.sales, relatedSales),
    cacheInventoryTransactionRelatedRows(db.sale_returns, saleReturns),
    cacheInventoryTransactionRelatedRows(db.sales_orders, relatedSalesOrders),
    cacheInventoryTransactionRelatedRows(db.purchase_orders, purchaseOrders),
    cacheInventoryTransactionRelatedRows(db.order_return_items, returnItems),
  ]);
}

export function useInventoryTransactionPageRelations(
  transactions: readonly InventoryTransaction[],
  workspaceId?: string,
  online = false,
) {
  const idsKey = transactions.map((transaction) => [
    transaction.id,
    transaction.productId,
    transaction.storageId,
    transaction.transferBatchId ?? "",
    transaction.referenceId ?? "",
    transaction.referenceType ?? "",
    transaction.updatedAt,
  ].join(":")).join("|");
  useEffect(() => {
    if (
      !workspaceId ||
      !online ||
      isLocalWorkspaceMode(workspaceId) ||
      transactions.length === 0
    ) {
      return;
    }
    const controller = new AbortController();
    void hydrateInventoryTransactionPageRelations(workspaceId, transactions, controller.signal);
    return () => controller.abort();
  }, [idsKey, online, transactions, workspaceId]);
  return useLiveQuery<InventoryTransactionPageRelations>(async () => {
    if (transactions.length === 0) {
      return {
        products: [],
        storages: [],
        transferBatches: [],
        sales: [],
        saleReturns: [],
        salesOrders: [],
        purchaseOrders: [],
        salesOrderReturnItems: [],
      };
    }
    const unique = (values: Array<string | null | undefined>) =>
      Array.from(new Set(values.filter((value): value is string => Boolean(value))));
    const referenceIds = (source: string) => unique(
      transactions
        .filter((transaction) => getInventoryTransactionMovementSource(
          transaction.transactionType,
          transaction.referenceType,
        ) === source)
        .map((transaction) => transaction.referenceId || transaction.id),
    );
    const productIds = unique(transactions.map((transaction) => transaction.productId));
    const transactionStorageIds = unique(transactions.map((transaction) => transaction.storageId));
    const transferBatchIds = unique(transactions.flatMap((transaction) =>
      getInventoryTransactionMovementSource(transaction.transactionType, transaction.referenceType) === "transfer"
        ? [transaction.transferBatchId, transaction.referenceId]
        : [],
    ));
    const posSaleIds = referenceIds("pos-sale");
    const posReturnIds = referenceIds("pos-return");
    const salesOrderIds = referenceIds("sales-order");
    const salesOrderReturnIds = referenceIds("sales-order-return");
    const purchaseOrderIds = referenceIds("purchase-order");

    const [products, transferBatches, directSales, saleReturns, purchaseOrders, salesOrderReturnItems] = await Promise.all([
      db.products.bulkGet(productIds),
      db.inventory_transfer_batches.bulkGet(transferBatchIds),
      db.sales.bulkGet(posSaleIds),
      db.sale_returns.bulkGet(posReturnIds),
      db.purchase_orders.bulkGet(purchaseOrderIds),
      salesOrderReturnIds.length > 0
        ? db.order_return_items.where("returnId").anyOf(salesOrderReturnIds).toArray()
        : Promise.resolve([] as OrderReturnItem[]),
    ]);
    const storageIds = unique([
      ...transactionStorageIds,
      ...transferBatches.flatMap((batch) => batch ? [batch.sourceStorageId, batch.destinationStorageId] : []),
    ]);
    const storages = await db.storages.bulkGet(storageIds);
    const returnedSaleIds = saleReturns.flatMap((saleReturn) => saleReturn?.saleId ? [saleReturn.saleId] : []);
    const additionalSales = returnedSaleIds.length > 0
      ? await db.sales.bulkGet(returnedSaleIds)
      : [];
    const relatedSalesOrderIds = unique([
      ...salesOrderIds,
      ...salesOrderReturnItems.map((item) => item.orderId),
    ]);
    const salesOrders = relatedSalesOrderIds.length > 0
      ? await db.sales_orders.bulkGet(relatedSalesOrderIds)
      : [];

    return {
      products: products.filter((product): product is Product => Boolean(product)),
      storages: storages.filter((storage): storage is Storage => Boolean(storage)),
      transferBatches: transferBatches.filter((batch): batch is InventoryTransferBatch => Boolean(batch)),
      sales: [...directSales, ...additionalSales]
        .filter((sale): sale is Sale => Boolean(sale)),
      saleReturns: saleReturns.filter((saleReturn): saleReturn is SaleReturn => Boolean(saleReturn)),
      salesOrders: salesOrders.filter((order): order is SalesOrder => Boolean(order)),
      purchaseOrders: purchaseOrders.filter((order): order is PurchaseOrder => Boolean(order)),
      salesOrderReturnItems,
    };
  }, [idsKey]);
}
