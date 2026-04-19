import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { isOnline } from "@/lib/network";
import { getSupabaseClientForTable } from "@/lib/supabaseSchema";
import { runSupabaseAction } from "@/lib/supabaseRequest";
import { generateId, toCamelCase } from "@/lib/utils";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";

import { db } from "./database";
import {
  adjustInventoryQuantity,
  getInventoryQuantityForProductStorage,
} from "./inventory";
import { createInventoryTransaction } from "./inventoryTransactions";
import type {
  InventoryTransaction,
  StockAdjustment,
  StockAdjustmentReason,
  StockAdjustmentType,
} from "./models";

const INVENTORY_TRANSACTIONS_TABLE = "inventory_transactions";
const STOCK_ADJUSTMENT_TRANSACTION_TYPE = "stock_adjustment";
const ALLOWED_TYPES: StockAdjustmentType[] = ["increase", "decrease"];
const ALLOWED_REASONS: StockAdjustmentReason[] = [
  "purchase",
  "return",
  "correction",
  "damage",
  "theft",
  "expired",
  "production",
  "other",
];

export interface StockAdjustmentInput {
  productId: string;
  storageId: string;
  adjustmentType: StockAdjustmentType;
  quantity: number;
  reason: StockAdjustmentReason;
  notes?: string | null;
  createdBy?: string | null;
}

export interface StockAdjustmentFilterOptions {
  productId?: string | null;
  storageId?: string | null;
  adjustmentType?: StockAdjustmentType | null;
  reason?: StockAdjustmentReason | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
  return !!workspaceId && !isLocalWorkspaceMode(workspaceId);
}

function normalizeOptionalString(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeAdjustmentInput(input: StockAdjustmentInput) {
  const productId = input.productId.trim();
  const storageId = input.storageId.trim();
  const adjustmentType = input.adjustmentType;
  const quantity = Number(input.quantity);
  const reason = input.reason;

  if (!productId) {
    throw new Error("Product is required");
  }

  if (!storageId) {
    throw new Error("Storage is required");
  }

  if (!ALLOWED_TYPES.includes(adjustmentType)) {
    throw new Error("Adjustment type is invalid");
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a whole number greater than zero");
  }

  if (!ALLOWED_REASONS.includes(reason)) {
    throw new Error("Adjustment reason is invalid");
  }

  return {
    productId,
    storageId,
    adjustmentType,
    quantity,
    reason,
    notes: normalizeOptionalString(input.notes),
    createdBy: normalizeOptionalString(input.createdBy),
  };
}

function mapTransactionToStockAdjustment(
  transaction: InventoryTransaction,
): StockAdjustment | null {
  if (
    transaction.transactionType !== STOCK_ADJUSTMENT_TRANSACTION_TYPE ||
    transaction.quantityDelta === 0
  ) {
    return null;
  }

  const adjustmentType =
    transaction.quantityDelta > 0 ? "increase" : "decrease";
  const reason =
    transaction.adjustmentReason &&
    ALLOWED_REASONS.includes(transaction.adjustmentReason)
      ? transaction.adjustmentReason
      : "correction";

  return {
    id: transaction.id,
    workspaceId: transaction.workspaceId,
    productId: transaction.productId,
    storageId: transaction.storageId,
    adjustmentType,
    quantity: Math.abs(transaction.quantityDelta),
    previousQuantity: transaction.previousQuantity,
    newQuantity: transaction.newQuantity,
    reason,
    notes: transaction.notes,
    createdBy: transaction.createdBy,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    version: transaction.version,
    isDeleted: transaction.isDeleted,
    syncStatus: transaction.syncStatus,
    lastSyncedAt: transaction.lastSyncedAt,
  };
}

export async function createStockAdjustment(
  workspaceId: string,
  input: StockAdjustmentInput,
  options?: {
    timestamp?: string;
    id?: string;
  },
) {
  const timestamp = options?.timestamp || new Date().toISOString();
  const normalized = normalizeAdjustmentInput(input);
  const quantityDelta =
    normalized.adjustmentType === "increase"
      ? normalized.quantity
      : -normalized.quantity;
  const previousQuantity = await getInventoryQuantityForProductStorage(
    normalized.productId,
    normalized.storageId,
  );
  const newQuantity = previousQuantity + quantityDelta;
  const transactionId = options?.id || generateId();

  if (newQuantity < 0) {
    throw new Error("Insufficient inventory");
  }

  let inventoryAdjusted = false;
  try {
    await adjustInventoryQuantity({
      workspaceId,
      productId: normalized.productId,
      storageId: normalized.storageId,
      quantityDelta,
      timestamp,
    });
    inventoryAdjusted = true;

    const transaction = await createInventoryTransaction(
      workspaceId,
      {
        productId: normalized.productId,
        storageId: normalized.storageId,
        transactionType: STOCK_ADJUSTMENT_TRANSACTION_TYPE,
        quantityDelta,
        previousQuantity,
        newQuantity,
        adjustmentReason: normalized.reason,
        referenceId: transactionId,
        referenceType: STOCK_ADJUSTMENT_TRANSACTION_TYPE,
        notes: normalized.notes,
        createdBy: normalized.createdBy,
      },
      {
        id: transactionId,
        timestamp,
      },
    );

    return mapTransactionToStockAdjustment(transaction) as StockAdjustment;
  } catch (error) {
    if (inventoryAdjusted) {
      try {
        await adjustInventoryQuantity({
          workspaceId,
          productId: normalized.productId,
          storageId: normalized.storageId,
          quantityDelta: -quantityDelta,
        });
      } catch (rollbackError) {
        console.error(
          "[StockAdjustments] Failed to roll back inventory after adjustment error:",
          rollbackError,
        );
      }
    }

    throw error;
  }
}

export function filterStockAdjustments(
  adjustments: StockAdjustment[],
  filters: StockAdjustmentFilterOptions,
) {
  const startTime = filters.startDate
    ? new Date(filters.startDate).setHours(0, 0, 0, 0)
    : null;
  const endTime = filters.endDate
    ? new Date(filters.endDate).setHours(23, 59, 59, 999)
    : null;

  return adjustments.filter((adjustment) => {
    if (filters.productId && adjustment.productId !== filters.productId) {
      return false;
    }

    if (filters.storageId && adjustment.storageId !== filters.storageId) {
      return false;
    }

    if (
      filters.adjustmentType &&
      adjustment.adjustmentType !== filters.adjustmentType
    ) {
      return false;
    }

    if (filters.reason && adjustment.reason !== filters.reason) {
      return false;
    }

    const createdAt = new Date(adjustment.createdAt).getTime();
    if (startTime !== null && createdAt < startTime) {
      return false;
    }

    if (endTime !== null && createdAt > endTime) {
      return false;
    }

    return true;
  });
}

export function useStockAdjustments(workspaceId: string | undefined) {
  const online = useNetworkStatus();

  const adjustments = useLiveQuery(async () => {
    if (!workspaceId) {
      return [];
    }

    const rows = await db.inventory_transactions
      .where("workspaceId")
      .equals(workspaceId)
      .and(
        (row) =>
          !row.isDeleted &&
          row.transactionType === STOCK_ADJUSTMENT_TRANSACTION_TYPE,
      )
      .toArray();

    return rows
      .map(mapTransactionToStockAdjustment)
      .filter((row): row is StockAdjustment => !!row)
      .sort(
        (left, right) =>
          new Date(right.createdAt).getTime() -
          new Date(left.createdAt).getTime(),
      );
  }, [workspaceId]);

  useEffect(() => {
    async function fetchFromSupabase() {
      if (
        !online ||
        !workspaceId ||
        !shouldUseCloudBusinessData(workspaceId) ||
        !isOnline()
      ) {
        return;
      }

      const client = getSupabaseClientForTable(INVENTORY_TRANSACTIONS_TABLE);
      const { data, error } = await runSupabaseAction(
        "inventory_transactions.stock_adjustments.fetch",
        () =>
          client
            .from(INVENTORY_TRANSACTIONS_TABLE)
            .select("*")
            .eq("workspace_id", workspaceId)
            .eq("transaction_type", STOCK_ADJUSTMENT_TRANSACTION_TYPE)
            .eq("is_deleted", false),
      );

      if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
        return;
      }

      const syncedAt = new Date().toISOString();
      const remoteIds = new Set(data.map((row: Record<string, unknown>) => row.id as string));

      await db.transaction("rw", db.inventory_transactions, async () => {
        // Upsert remote records
        for (const remoteItem of data) {
          const localItem = toCamelCase(
            remoteItem as Record<string, unknown>,
          ) as unknown as InventoryTransaction;
          localItem.syncStatus = "synced";
          localItem.lastSyncedAt = syncedAt;
          await db.inventory_transactions.put(localItem);
        }

        // Remove local stock_adjustment records that no longer exist in Supabase
        const localRows = await db.inventory_transactions
          .where("workspaceId")
          .equals(workspaceId)
          .and((row) => row.transactionType === STOCK_ADJUSTMENT_TRANSACTION_TYPE)
          .toArray();
        const staleIds = localRows
          .filter((row) => row.syncStatus === "synced" && !remoteIds.has(row.id))
          .map((row) => row.id);
        if (staleIds.length > 0) {
          await db.inventory_transactions.bulkDelete(staleIds);
        }
      });
    }

    void fetchFromSupabase();
  }, [online, workspaceId]);

  return adjustments ?? [];
}
