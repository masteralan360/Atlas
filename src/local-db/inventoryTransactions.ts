import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { isOnline } from "@/lib/network";
import { getSupabaseClientForTable } from "@/lib/supabaseSchema";
import { runSupabaseAction } from "@/lib/supabaseRequest";
import { generateId, toCamelCase, toSnakeCase } from "@/lib/utils";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";

import { db } from "./database";
import { addToOfflineMutations } from "./offlineMutations";
import type {
  InventoryTransaction,
  InventoryTransactionType,
  StockAdjustmentReason,
} from "./models";

const TABLE_NAME = "inventory_transactions";

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

function shouldUseCloudBusinessData(workspaceId?: string | null) {
  return !!workspaceId && !isLocalWorkspaceMode(workspaceId);
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
  if (!shouldUseCloudBusinessData(workspaceId)) {
    return {
      syncStatus: "synced" as const,
      lastSyncedAt: timestamp,
    };
  }

  return {
    syncStatus: "pending" as const,
    lastSyncedAt: null,
  };
}

function sanitizeTransactionPayload(transaction: Record<string, unknown>) {
  return toSnakeCase({
    ...transaction,
    syncStatus: undefined,
    lastSyncedAt: undefined,
  });
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

  if (!Number.isInteger(quantityDelta) || quantityDelta === 0) {
    throw new Error("Quantity delta must be a non-zero whole number");
  }

  if (!Number.isInteger(previousQuantity) || previousQuantity < 0) {
    throw new Error("Previous quantity is invalid");
  }

  if (!Number.isInteger(newQuantity) || newQuantity < 0) {
    throw new Error("New quantity is invalid");
  }

  if (previousQuantity + quantityDelta !== newQuantity) {
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
    quantityDelta,
    previousQuantity,
    newQuantity,
    adjustmentReason:
      transactionType === "stock_adjustment" ? adjustmentReason : null,
    referenceId: normalizeOptionalString(input.referenceId),
    referenceType: normalizeOptionalString(input.referenceType),
    notes: normalizeOptionalString(input.notes),
    createdBy: normalizeOptionalString(input.createdBy),
  };
}

async function markTransactionsSynced(ids: string[]) {
  if (ids.length === 0) {
    return;
  }

  const syncedAt = new Date().toISOString();
  await Promise.all(
    ids.map((id) =>
      db.inventory_transactions.update(id, {
        syncStatus: "synced",
        lastSyncedAt: syncedAt,
      }),
    ),
  );
}

async function queueOfflineUpserts(
  transactions: InventoryTransaction[],
  workspaceId: string,
) {
  await Promise.all(
    transactions.map((transaction) =>
      addToOfflineMutations(
        TABLE_NAME,
        transaction.id,
        transaction.version > 1 ? "update" : "create",
        transaction as unknown as Record<string, unknown>,
        workspaceId,
      ),
    ),
  );
}

async function syncUpsertTransactions(
  transactions: InventoryTransaction[],
  workspaceId: string,
) {
  if (!transactions.length || !shouldUseCloudBusinessData(workspaceId)) {
    return;
  }

  if (!isOnline()) {
    await queueOfflineUpserts(transactions, workspaceId);
    return;
  }

  try {
    const client = getSupabaseClientForTable(TABLE_NAME);
    const payload = transactions.map((transaction) =>
      sanitizeTransactionPayload(
        transaction as unknown as Record<string, unknown>,
      ),
    );

    const { error } = await runSupabaseAction(`${TABLE_NAME}.sync`, () =>
      client.from(TABLE_NAME).upsert(payload),
    );

    if (error) {
      throw error;
    }

    await markTransactionsSynced(
      transactions.map((transaction) => transaction.id),
    );
  } catch (error) {
    console.error(
      "[InventoryTransactions] Failed to sync transactions:",
      error,
    );
    await queueOfflineUpserts(transactions, workspaceId);
  }
}

export async function refreshInventoryTransactionsFromSupabase(
  workspaceId: string,
) {
  if (!workspaceId || !shouldUseCloudBusinessData(workspaceId) || !isOnline()) {
    return;
  }

  const client = getSupabaseClientForTable(TABLE_NAME);
  const { data, error } = await runSupabaseAction(`${TABLE_NAME}.fetch`, () =>
    client
      .from(TABLE_NAME)
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("is_deleted", false),
  );

  if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
    return;
  }

  const syncedAt = new Date().toISOString();
  const remoteIds = new Set(
    data.map((row: Record<string, unknown>) => row.id as string),
  );

  await db.transaction("rw", db.inventory_transactions, async () => {
    for (const remoteItem of data) {
      const localItem = toCamelCase(
        remoteItem as Record<string, unknown>,
      ) as unknown as InventoryTransaction;
      localItem.syncStatus = "synced";
      localItem.lastSyncedAt = syncedAt;
      await db.inventory_transactions.put(localItem);
    }

    const localRows = await db.inventory_transactions
      .where("workspaceId")
      .equals(workspaceId)
      .toArray();
    const staleIds = localRows
      .filter((row) => row.syncStatus === "synced" && !remoteIds.has(row.id))
      .map((row) => row.id);
    if (staleIds.length > 0) {
      await db.inventory_transactions.bulkDelete(staleIds);
    }
  });
}

export async function createInventoryTransaction(
  workspaceId: string,
  input: InventoryTransactionInput,
  options?: {
    id?: string;
    timestamp?: string;
  },
) {
  const timestamp = options?.timestamp || new Date().toISOString();
  const normalized = normalizeTransactionInput(input);

  const transaction: InventoryTransaction = {
    id: options?.id || generateId(),
    workspaceId,
    ...normalized,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, timestamp),
  };

  await db.inventory_transactions.put(transaction);
  await syncUpsertTransactions([transaction], workspaceId);
  return transaction;
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
  const online = useNetworkStatus();

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

  useEffect(() => {
    async function fetchFromSupabase() {
      if (!online || !workspaceId) {
        return;
      }

      await refreshInventoryTransactionsFromSupabase(workspaceId);
    }

    void fetchFromSupabase();
  }, [online, workspaceId]);

  return transactions ?? [];
}
