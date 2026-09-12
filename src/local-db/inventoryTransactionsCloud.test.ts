import "fake-indexeddb/auto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const rows = new Map<string, string>();
  const storage = {
    get length() { return rows.size; },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      dir: "ltr",
      documentElement: { lang: "en", dir: "ltr" },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { hash: "", origin: "http://localhost", pathname: "/" },
  });
  Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: () => undefined });
  Object.defineProperty(globalThis, "removeEventListener", { configurable: true, value: () => undefined });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
});

import { setNetworkStatus } from "@/lib/network";
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from "@/workspace/workspaceMode";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabaseSchema", () => ({
  getSupabaseClientForTable: () => ({ rpc }),
}));

import { db } from "./database";
import { createInventoryTransaction } from "./inventoryTransactions";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000611";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000612";
const STORAGE_ID = "00000000-0000-4000-8000-000000000613";
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000614";
const INVENTORY_ID = "00000000-0000-4000-8000-000000000615";

function installBrowserGlobals() {
  const rows = new Map<string, string>();
  const storage = {
    get length() { return rows.size; },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
}

function authoritativeResult(quantity: number, alreadyApplied = false) {
  const timestamp = "2026-09-12T10:00:00.000Z";
  return {
    data: {
      transaction: {
        id: TRANSACTION_ID,
        workspace_id: WORKSPACE_ID,
        product_id: PRODUCT_ID,
        storage_id: STORAGE_ID,
        transaction_type: "stock_adjustment",
        quantity_delta: quantity - 4,
        previous_quantity: 4,
        new_quantity: quantity,
        adjustment_reason: "correction",
        reference_id: TRANSACTION_ID,
        reference_type: "stock_adjustment",
        created_at: timestamp,
        updated_at: timestamp,
        version: 1,
        is_deleted: false,
      },
      inventory: {
        id: INVENTORY_ID,
        workspace_id: WORKSPACE_ID,
        product_id: PRODUCT_ID,
        storage_id: STORAGE_ID,
        quantity,
        created_at: timestamp,
        updated_at: timestamp,
        version: 2,
        is_deleted: quantity === 0,
      },
      already_applied: alreadyApplied,
    },
    error: null,
  };
}

async function seedLocalProjection() {
  const timestamp = "2026-09-12T09:00:00.000Z";
  const base = {
    workspaceId: WORKSPACE_ID,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    isDeleted: false,
    syncStatus: "synced" as const,
    lastSyncedAt: timestamp,
  };
  await db.storages.put({
    id: STORAGE_ID,
    ...base,
    name: "Main Storage",
    isSystem: false,
    isProtected: false,
    isPrimary: true,
    isMarketplace: false,
  });
  await db.products.put({
    id: PRODUCT_ID,
    ...base,
    sku: "CLOUD-STOCK",
    name: "Cloud Stock",
    description: "",
    categoryId: null,
    price: 10,
    costPrice: 5,
    quantity: 4,
    minStockLevel: 0,
    unit: "pcs",
    currency: "usd",
    canBeReturned: true,
  });
  await db.inventory.put({
    id: INVENTORY_ID,
    ...base,
    productId: PRODUCT_ID,
    storageId: STORAGE_ID,
    quantity: 4,
  });
}

describe("cloud stock adjustment authority", () => {
  beforeAll(async () => {
    installBrowserGlobals();
    await db.open();
  });

  beforeEach(async () => {
    installBrowserGlobals();
    await db.delete();
    await db.open();
    rpc.mockReset();
    setNetworkStatus(true);
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: "cloud" });
    await seedLocalProjection();
  });

  afterEach(() => {
    clearWorkspaceModeSnapshot(WORKSPACE_ID);
    setNetworkStatus(true);
  });

  afterAll(async () => {
    await db.delete();
  });

  it("retries an uncertain response with the same operation id and reconciles server stock", async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: new Error("Failed to fetch") })
      .mockResolvedValueOnce(authoritativeResult(3, true));

    const transaction = await createInventoryTransaction(
      WORKSPACE_ID,
      {
        productId: PRODUCT_ID,
        storageId: STORAGE_ID,
        transactionType: "stock_adjustment",
        quantityDelta: -1,
        previousQuantity: 4,
        newQuantity: 3,
        adjustmentReason: "correction",
      },
      { id: TRANSACTION_ID },
    );

    expect(transaction).toMatchObject({ id: TRANSACTION_ID, newQuantity: 3, syncStatus: "synced" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);
    expect(rpc.mock.calls[0][1].p_transaction.id).toBe(TRANSACTION_ID);
    expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 3, version: 2 });
    expect(await db.products.get(PRODUCT_ID)).toMatchObject({ quantity: 3 });
  });

  it("does not change the local projection when the authoritative operation fails", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error("permission denied") });

    await expect(createInventoryTransaction(
      WORKSPACE_ID,
      {
        productId: PRODUCT_ID,
        storageId: STORAGE_ID,
        transactionType: "stock_adjustment",
        quantityDelta: -1,
        previousQuantity: 4,
        newQuantity: 3,
        adjustmentReason: "correction",
      },
      { id: TRANSACTION_ID },
    )).rejects.toThrow("permission denied");

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 4 });
    expect(await db.inventory_transactions.count()).toBe(0);
  });
});
