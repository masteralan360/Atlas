import Dexie from "dexie";
import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import i18n from "@/i18n/config";
import { isPositiveQuantity, roundQuantity } from "@/lib/quantity";
import { getActiveBusinessUserId, getActiveBusinessUserRole, isOnline } from "@/lib/network";
import { getSupabaseClientForTable } from "@/lib/supabaseSchema";
import { normalizeSupabaseActionError, runSupabaseAction } from "@/lib/supabaseRequest";
import { generateId, toCamelCase } from "@/lib/utils";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";
import { queryKeys } from "@/query/queryKeys";
import { recordWorkspaceDataFetch } from "@/workspace/workspaceDataFreshness";

import {
  db,
  INVENTORY_TRANSACTIONS_CHANGED_EVENT,
  withoutInventoryTransactionChangeEvents,
} from "./database";
import {
  adjustInventoryQuantity,
  getInventoryQuantityForProductStorage,
  hydrateInventoryProductStoragesFromSupabase,
} from "./inventory";
import { createInventoryTransaction } from "./inventoryTransactions";
import { canAccessStorage, useStorageAccess } from "./storagePermissions";
import type {
  InventoryTransaction,
  StockAdjustment,
  StockAdjustmentReason,
  StockAdjustmentType,
} from "./models";

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

export async function getProductStockSnapshot(productId: string) {
  const product = await db.products.get(productId);
  return product && !product.isDeleted ? {
    quantity: roundQuantity(product.quantity),
    updatedAt: product.updatedAt,
  } : null;
}

export interface StockAdjustmentInput {
  productId: string;
  storageId: string;
  adjustmentType: StockAdjustmentType;
  quantity: number;
  /**
   * The desired quantity after the adjustment. When supplied, it takes
   * precedence over quantity/adjustmentType. Cloud workspaces apply this
   * target against the authoritative position inside the stock adjustment RPC.
   */
  targetQuantity?: number;
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

function normalizeOptionalString(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeAdjustmentInput(input: StockAdjustmentInput) {
  const productId = input.productId.trim();
  const storageId = input.storageId.trim();
  const adjustmentType = input.adjustmentType;
  const quantity = Number(input.quantity);
  const targetQuantity =
    input.targetQuantity === undefined ? null : Number(input.targetQuantity);
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

  if (!isPositiveQuantity(quantity)) {
    throw new Error("Quantity must be greater than zero");
  }

  if (targetQuantity !== null && !Number.isFinite(targetQuantity)) {
    throw new Error("Target quantity is invalid");
  }

  if (targetQuantity !== null && targetQuantity < 0) {
    throw new Error("Target quantity cannot be negative");
  }

  if (!ALLOWED_REASONS.includes(reason)) {
    throw new Error("Adjustment reason is invalid");
  }

  return {
    productId,
    storageId,
    adjustmentType,
    quantity: roundQuantity(quantity),
    targetQuantity: targetQuantity === null ? null : roundQuantity(targetQuantity),
    reason,
    notes: normalizeOptionalString(input.notes),
    createdBy: normalizeOptionalString(input.createdBy),
  };
}

export function mapTransactionToStockAdjustment(
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
  const transactionId = options?.id || generateId();
  if (isLocalWorkspaceMode(workspaceId)) {
    const existingTransaction = await db.inventory_transactions.get(transactionId);
    if (existingTransaction) {
      return mapTransactionToStockAdjustment(existingTransaction) as StockAdjustment;
    }
  }
  const useAuthoritativeTarget =
    !isLocalWorkspaceMode(workspaceId) && normalized.targetQuantity !== null;

  // Relative adjustments still need the latest quantity to build their
  // transaction. Absolute cloud adjustments pass the target to the database,
  // which calculates the delta under the position lock and avoids this second
  // round trip after the dialog has already loaded the position.
  if (!useAuthoritativeTarget) {
    await hydrateInventoryProductStoragesFromSupabase(
      workspaceId,
      normalized.productId,
      [normalized.storageId],
    );
  }
  const previousQuantity = await getInventoryQuantityForProductStorage(
    normalized.productId,
    normalized.storageId,
  );
  const quantityDelta = normalized.targetQuantity === null
    ? roundQuantity(
      normalized.adjustmentType === "increase"
        ? normalized.quantity
        : -normalized.quantity,
    )
    : roundQuantity(normalized.targetQuantity - previousQuantity);
  const newQuantity = roundQuantity(previousQuantity + quantityDelta);

  if (quantityDelta === 0 && !useAuthoritativeTarget) {
    throw new Error("Stock is already at the requested quantity");
  }

  if (newQuantity < 0) {
    throw new Error("Insufficient inventory");
  }

  if (!isLocalWorkspaceMode(workspaceId)) {
    // The target RPC replaces these client-side quantities with the exact
    // authoritative values. If the local snapshot already equals the target,
    // provide a harmless non-zero placeholder for the shared transaction
    // validator; the RPC will either apply the target or report a no-op.
    const transactionPreviousQuantity = quantityDelta === 0 ? 0 : previousQuantity;
    const transactionQuantityDelta = quantityDelta === 0 ? 1 : quantityDelta;
    const transactionNewQuantity = quantityDelta === 0 ? 1 : newQuantity;
    const transaction = await createInventoryTransaction(
      workspaceId,
      {
        productId: normalized.productId,
        storageId: normalized.storageId,
        transactionType: STOCK_ADJUSTMENT_TRANSACTION_TYPE,
        quantityDelta: transactionQuantityDelta,
        previousQuantity: transactionPreviousQuantity,
        newQuantity: transactionNewQuantity,
        adjustmentReason: normalized.reason,
        referenceId: transactionId,
        referenceType: STOCK_ADJUSTMENT_TRANSACTION_TYPE,
        notes: normalized.notes,
        createdBy: normalized.createdBy,
      },
      {
        id: transactionId,
        timestamp,
        targetQuantity: useAuthoritativeTarget
          ? normalized.targetQuantity ?? undefined
          : undefined,
      },
    );

    return mapTransactionToStockAdjustment(transaction) as StockAdjustment;
  }

  let inventoryAdjusted = false;
  try {
    await adjustInventoryQuantity({
      workspaceId,
      productId: normalized.productId,
      storageId: normalized.storageId,
      quantityDelta,
      timestamp,
      skipRemoteHydration: true,
      // Local adjustments write their ledger row in the same Dexie
      // transaction as stock, so the SQLite mirror commits both together.
      skipRemoteSync: true,
      movementTransactionId: transactionId,
      movement: {
        productId: normalized.productId,
        storageId: normalized.storageId,
        transactionType: STOCK_ADJUSTMENT_TRANSACTION_TYPE,
        adjustmentReason: normalized.reason,
        referenceId: transactionId,
        referenceType: STOCK_ADJUSTMENT_TRANSACTION_TYPE,
        notes: normalized.notes,
        createdBy: normalized.createdBy,
      },
    });
    inventoryAdjusted = true;

    const transaction = await db.inventory_transactions.get(transactionId);
    if (!transaction) throw new Error(i18n.t("inventory.errors.authoritativeResultMissing"));

    return mapTransactionToStockAdjustment(transaction) as StockAdjustment;
  } catch (error) {
    if (inventoryAdjusted) {
      try {
        await adjustInventoryQuantity({
          workspaceId,
          productId: normalized.productId,
          storageId: normalized.storageId,
          quantityDelta: -quantityDelta,
          skipRemoteHydration: true,
          skipRemoteSync: true,
          movement: null,
        });
        await db.inventory_transactions.delete(transactionId);
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

  return adjustments ?? [];
}

export interface StockAdjustmentPageQuery {
  workspaceId?: string;
  page: number;
  pageSize: number;
  startAt?: string;
  endBefore?: string;
  productId?: string | null;
  storageId?: string | null;
  adjustmentType?: StockAdjustmentType | null;
  reason?: StockAdjustmentReason | null;
}

export interface StockAdjustmentPage {
  rows: StockAdjustment[];
  totalCount: number;
  pageCount: number;
}

const EMPTY_STOCK_ADJUSTMENT_PAGE: StockAdjustmentPage = {
  rows: [],
  totalCount: 0,
  pageCount: 1,
};

function getStockAdjustmentCollection(query: StockAdjustmentPageQuery) {
  const startAt = query.startAt ?? Dexie.minKey;
  const endBefore = query.endBefore ?? Dexie.maxKey;
  return db.inventory_transactions
    .where("[workspaceId+createdAt+id]")
    .between(
      [query.workspaceId!, startAt, Dexie.minKey],
      [query.workspaceId!, endBefore, query.endBefore ? Dexie.minKey : Dexie.maxKey],
      true,
      !query.endBefore,
    );
}

function matchesStockAdjustmentPageFilters(
  transaction: InventoryTransaction,
  query: StockAdjustmentPageQuery,
  access: ReturnType<typeof useStorageAccess>,
) {
  if (
    transaction.workspaceId !== query.workspaceId ||
    transaction.isDeleted ||
    transaction.transactionType !== STOCK_ADJUSTMENT_TRANSACTION_TYPE ||
    !canAccessStorage(transaction.storageId, access)
  ) {
    return false;
  }
  if (query.productId && transaction.productId !== query.productId) return false;
  if (query.storageId && transaction.storageId !== query.storageId) return false;
  if (query.adjustmentType === "increase" && transaction.quantityDelta <= 0) return false;
  if (query.adjustmentType === "decrease" && transaction.quantityDelta >= 0) return false;
  const reason = transaction.adjustmentReason && ALLOWED_REASONS.includes(transaction.adjustmentReason)
    ? transaction.adjustmentReason
    : "correction";
  return !query.reason || query.reason === reason;
}

async function fetchLocalStockAdjustmentPage(
  query: StockAdjustmentPageQuery,
  access: ReturnType<typeof useStorageAccess>,
): Promise<StockAdjustmentPage> {
  if (!query.workspaceId || access.isReady === false) return EMPTY_STOCK_ADJUSTMENT_PAGE;
  const offset = (Math.max(1, query.page) - 1) * Math.max(1, query.pageSize);
  const limit = Math.max(1, query.pageSize);
  const rows: StockAdjustment[] = [];
  let totalCount = 0;

  await getStockAdjustmentCollection(query).reverse().each((transaction) => {
    if (!matchesStockAdjustmentPageFilters(transaction, query, access)) return;
    if (totalCount >= offset && rows.length < limit) {
      const adjustment = mapTransactionToStockAdjustment(transaction);
      if (adjustment) rows.push(adjustment);
    }
    totalCount += 1;
  });

  const page = {
    rows,
    totalCount,
    pageCount: Math.max(1, Math.ceil(totalCount / limit)),
  };
  recordWorkspaceDataFetch(query.workspaceId, "local", undefined, "inventory_transactions");
  return page;
}

function normalizeRemoteStockAdjustment(value: unknown, workspaceId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = toCamelCase(value as Record<string, unknown>) as Record<string, unknown>;
  const quantityDelta = Number(row.quantityDelta);
  const previousQuantity = row.previousQuantity == null ? null : Number(row.previousQuantity);
  const newQuantity = row.newQuantity == null ? null : Number(row.newQuantity);
  if (
    typeof row.id !== "string" ||
    row.workspaceId !== workspaceId ||
    typeof row.productId !== "string" ||
    typeof row.storageId !== "string" ||
    typeof row.createdAt !== "string" ||
    Number.isNaN(Date.parse(row.createdAt)) ||
    row.transactionType !== STOCK_ADJUSTMENT_TRANSACTION_TYPE ||
    !Number.isFinite(quantityDelta) || quantityDelta === 0 ||
    (previousQuantity !== null && !Number.isFinite(previousQuantity)) ||
    (newQuantity !== null && !Number.isFinite(newQuantity)) ||
    row.isDeleted === true
  ) {
    return null;
  }

  return mapTransactionToStockAdjustment({
    ...row,
    id: row.id,
    workspaceId,
    productId: row.productId,
    storageId: row.storageId,
    createdAt: row.createdAt,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : row.createdAt,
    transactionType: STOCK_ADJUSTMENT_TRANSACTION_TYPE,
    quantityDelta,
    previousQuantity: previousQuantity as number,
    newQuantity: newQuantity as number,
    adjustmentReason: typeof row.adjustmentReason === "string"
      && ALLOWED_REASONS.includes(row.adjustmentReason as StockAdjustmentReason)
      ? row.adjustmentReason as StockAdjustmentReason
      : null,
    isDeleted: row.isDeleted === true,
  } as InventoryTransaction);
}

async function cacheRemoteStockAdjustments(rows: readonly StockAdjustment[]) {
  if (rows.length === 0) return;
  const fetchedAt = new Date().toISOString();
  await withoutInventoryTransactionChangeEvents(() => db.transaction(
    "rw",
    db.inventory_transactions,
    async () => {
      const existingRows = await db.inventory_transactions.bulkGet(rows.map((row) => row.id));
      const cacheRows = rows.flatMap((row, index) => {
        const existing = existingRows[index];
        if (existing?.syncStatus === "pending" || existing?.syncStatus === "conflict") return [];
        const existingUpdatedAt = Date.parse(existing?.updatedAt || "");
        const remoteUpdatedAt = Date.parse(row.updatedAt || "");
        if (existing && Number.isFinite(existingUpdatedAt) && Number.isFinite(remoteUpdatedAt)
          && remoteUpdatedAt <= existingUpdatedAt) return [];
        return [{
          ...existing,
          id: row.id,
          workspaceId: row.workspaceId,
          productId: row.productId,
          storageId: row.storageId,
          transactionType: STOCK_ADJUSTMENT_TRANSACTION_TYPE,
          quantityDelta: row.adjustmentType === "increase" ? row.quantity : -row.quantity,
          previousQuantity: row.previousQuantity,
          newQuantity: row.newQuantity,
          adjustmentReason: row.reason,
          referenceId: existing?.referenceId ?? row.id,
          referenceType: existing?.referenceType ?? STOCK_ADJUSTMENT_TRANSACTION_TYPE,
          notes: row.notes,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          version: row.version ?? existing?.version ?? 1,
          isDeleted: row.isDeleted,
          syncStatus: "synced" as const,
          lastSyncedAt: fetchedAt,
        } satisfies InventoryTransaction];
      });
      if (cacheRows.length > 0) await db.inventory_transactions.bulkPut(cacheRows);
    },
  ));
}

async function fetchRemoteStockAdjustmentPage(
  query: StockAdjustmentPageQuery,
  access: ReturnType<typeof useStorageAccess>,
  signal?: AbortSignal,
): Promise<StockAdjustmentPage> {
  if (!query.workspaceId) return EMPTY_STOCK_ADJUSTMENT_PAGE;
  const response = await runSupabaseAction("stockAdjustments.listPage", () => {
    const request = getSupabaseClientForTable("inventory_transactions").rpc(
      "get_stock_adjustments_list_page",
      {
        p_workspace_id: query.workspaceId,
        p_page: Math.max(1, Math.floor(query.page)),
        p_page_size: Math.max(1, Math.floor(query.pageSize)),
        p_start_at: query.startAt ?? null,
        p_end_before: query.endBefore ?? null,
        p_product_id: query.productId ?? null,
        p_storage_id: query.storageId ?? null,
        p_adjustment_type: query.adjustmentType ?? null,
        p_reason: query.reason ?? null,
        p_excluded_storage_ids: access.isAdmin ? [] : Array.from(access.excludedStorageIds),
      },
    );
    return signal ? request.abortSignal(signal) : request;
  });
  if (response.error) throw normalizeSupabaseActionError(response.error);
  if (signal?.aborted) throw signal.reason ?? new Error("Stock adjustment request cancelled.");
  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
    throw new Error("Invalid stock adjustment page response.");
  }

  const payload = response.data as Record<string, unknown>;
  if (!Array.isArray(payload.rows)) throw new Error("Invalid stock adjustment rows.");
  const totalCount = Number(payload.total_count);
  if (!Number.isInteger(totalCount) || totalCount < 0) throw new Error("Invalid stock adjustment count.");
  const rows = payload.rows.map((row) => normalizeRemoteStockAdjustment(row, query.workspaceId!));
  if (rows.some((row) => row === null)) throw new Error("Invalid stock adjustment record.");
  const page = {
    rows: rows as StockAdjustment[],
    totalCount,
    pageCount: Math.max(1, Math.ceil(totalCount / Math.max(1, query.pageSize))),
  };
  await cacheRemoteStockAdjustments(page.rows);
  recordWorkspaceDataFetch(query.workspaceId, "supabase", undefined, "inventory_transactions");
  return page;
}

export function useStockAdjustmentPage(
  query: StockAdjustmentPageQuery,
  enabled = true,
  onlineOverride?: boolean,
) {
  const access = useStorageAccess(query.workspaceId);
  const online = onlineOverride ?? isOnline(query.workspaceId);
  const sourceMode = query.workspaceId && online && !isLocalWorkspaceMode(query.workspaceId)
    ? "remote"
    : "local";
  const viewer = {
    userId: getActiveBusinessUserId(),
    role: getActiveBusinessUserRole(),
    storageScope: access.signature,
  };
  const key = queryKeys.stockAdjustments.page(query, sourceMode, viewer);
  const remoteQuery = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchRemoteStockAdjustmentPage(query, access, signal),
    enabled: enabled && sourceMode === "remote" && Boolean(query.workspaceId) && access.isReady !== false,
    placeholderData: undefined,
  });
  const localPage = useLiveQuery(
    () => enabled && sourceMode === "local"
      ? fetchLocalStockAdjustmentPage(query, access)
      : Promise.resolve(undefined),
    [
      access.signature,
      enabled,
      query.adjustmentType,
      query.endBefore,
      query.page,
      query.pageSize,
      query.productId,
      query.reason,
      query.startAt,
      query.storageId,
      query.workspaceId,
      sourceMode,
    ],
  );

  return {
    data: sourceMode === "remote" ? remoteQuery.data : localPage,
    error: sourceMode === "remote" ? remoteQuery.error : null,
    isPending: sourceMode === "remote"
      ? remoteQuery.isPending
      : enabled && sourceMode === "local" && localPage === undefined,
    isFetching: sourceMode === "remote" ? remoteQuery.isFetching : false,
    sourceMode,
  };
}

export function useStockAdjustmentPagesChanged(workspaceId?: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!workspaceId || typeof window === "undefined") return;
    const handleChanged = (event: Event) => {
      const changedWorkspaceIds = (event as CustomEvent<{ workspaceIds?: string[] }>).detail?.workspaceIds;
      if (!changedWorkspaceIds?.includes(workspaceId)) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.stockAdjustments.all(workspaceId),
      });
    };
    window.addEventListener(INVENTORY_TRANSACTIONS_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(INVENTORY_TRANSACTIONS_CHANGED_EVENT, handleChanged);
  }, [queryClient, workspaceId]);
}
