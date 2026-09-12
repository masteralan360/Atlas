import { useLiveQuery } from "dexie-react-hooks";

import i18n from "@/i18n/config";
import {
  QUANTITY_EPSILON,
  isNonNegativeQuantity,
  quantitiesEqual,
  roundQuantity,
} from "@/lib/quantity";
import { isOnline } from "@/lib/network";
import { getSupabaseClientForTable } from "@/lib/supabaseSchema";
import { isRetriableWebRequestError, runSupabaseAction } from "@/lib/supabaseRequest";
import { generateId, toCamelCase, toSnakeCase } from "@/lib/utils";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";

import { db } from "./database";
import type {
  Inventory,
  InventoryTransaction,
  InventoryTransactionType,
  StockAdjustmentReason,
} from "./models";

const TABLE_NAME = "inventory_transactions";
const CLOUD_TRANSACTION_TYPES = new Set<InventoryTransactionType>([
  "stock_adjustment",
]);

// Sales, returns, purchases, transfers, and initial stock are mirrored only
// in the local ledger. Manual stock adjustments are the sole cloud entries.
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
    "initial_stock",
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

  if (!isNonNegativeQuantity(previousQuantity)) {
    throw new Error("Previous quantity is invalid");
  }

  if (!isNonNegativeQuantity(newQuantity)) {
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

type ApplyStockAdjustmentResult = {
  transaction: Record<string, unknown>;
  inventory: Record<string, unknown> | null;
  already_applied: boolean;
};

export async function applyStockAdjustmentTransactionRemotely(
  transaction: InventoryTransaction,
) {
  if (transaction.transactionType !== "stock_adjustment") {
    throw new Error("Only stock adjustments can use the stock adjustment RPC");
  }

  const client = getSupabaseClientForTable(TABLE_NAME);
  const { data, error } = await runSupabaseAction(
    `${TABLE_NAME}.apply_stock_adjustment`,
    () => client.rpc("apply_stock_adjustment", {
      p_transaction: toRemoteInventoryTransactionPayload(transaction),
    }),
  );

  if (error) {
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

  await db.transaction("rw", db.inventory, async () => {
    await Promise.all(
      localRows
        .filter((row) => (
          row.workspaceId === remoteInventory.workspaceId
          && row.id !== remoteInventory.id
        ))
        .map((row) => db.inventory.delete(row.id)),
    );
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
): Promise<InventoryTransaction> {
  if (!shouldSyncInventoryTransaction(transaction.workspaceId, transaction.transactionType)) {
    return transaction;
  }

  if (!isOnline(transaction.workspaceId)) {
    throw new Error(i18n.t("inventory.errors.onlineRequired"));
  }

  let result;
  try {
    result = await applyStockAdjustmentTransactionRemotely(transaction);
  } catch (error) {
    if (!isRetriableWebRequestError(error)) throw error;
    // The operation id is the transaction id, so this verification retry is
    // safe even when the first response was lost after the server committed.
    result = await applyStockAdjustmentTransactionRemotely(transaction);
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
    return syncInventoryTransactionBestEffort(transaction);
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
    await db.inventory_transactions.bulkPut(remoteTransactions);
  }
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
  const transactions = useLiveQuery(async () => {
    if (!workspaceId) {
      return [];
    }

    const rows = await db.inventory_transactions
      .where("workspaceId")
      .equals(workspaceId)
      .and((row) => !row.isDeleted)
      .toArray();

    return rows.sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    );
  }, [workspaceId]);

  return transactions ?? [];
}
