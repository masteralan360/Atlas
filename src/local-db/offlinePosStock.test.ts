import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setNetworkStatus } from "@/lib/network";
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from "@/workspace/workspaceMode";

import { db } from "./database";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000611";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000612";
const STORAGE_ID = "00000000-0000-4000-8000-000000000613";
const INVENTORY_ID = "00000000-0000-4000-8000-000000000614";
const BATCH_ID = "00000000-0000-4000-8000-000000000615";
const TIMESTAMP = "2026-09-09T10:00:00.000Z";

let applyOfflinePosStockEffects: typeof import("./offlinePosStock").applyOfflinePosStockEffects;

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
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: storage,
      sessionStorage: storage,
      location: { hash: "", origin: "http://localhost", pathname: "/" },
      addEventListener: () => undefined,
    },
  });
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
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
}

async function seedStock() {
  const base = {
    workspaceId: WORKSPACE_ID,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    version: 1,
    isDeleted: false,
    syncStatus: "synced" as const,
    lastSyncedAt: TIMESTAMP,
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
    sku: "OFFLINE-POS-STOCK",
    name: "Offline POS Stock",
    description: "",
    categoryId: null,
    price: 10,
    costPrice: 5,
    quantity: 20,
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
    quantity: 20,
  });
  await db.stock_batches.put({
    id: BATCH_ID,
    ...base,
    productId: PRODUCT_ID,
    storageId: STORAGE_ID,
    batchNumber: "BATCH-1",
    quantity: 20,
    price: 10,
    costPrice: 5,
    currency: "usd",
    expiryDate: null,
    manufacturingDate: null,
    notes: null,
    sourcePurchaseOrderId: null,
    sourcePurchaseOrderItemId: null,
  });
}

describe("offline POS stock effects", () => {
  beforeAll(async () => {
    installBrowserGlobals();
    applyOfflinePosStockEffects = (await import("./offlinePosStock")).applyOfflinePosStockEffects;
  });

  beforeEach(async () => {
    installBrowserGlobals();
    await db.delete();
    await db.open();
    setNetworkStatus(false);
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: "local" });
    await seedStock();
  });

  afterEach(() => {
    clearWorkspaceModeSnapshot(WORKSPACE_ID);
    setNetworkStatus(true);
  });
  afterAll(async () => { await db.delete(); });

  it("updates fractional inventory and batch balances without queueing duplicate snapshots", async () => {
    await applyOfflinePosStockEffects({
      workspaceId: WORKSPACE_ID,
      items: [{ productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 2.25 }],
      batchPlans: [{
        productId: PRODUCT_ID,
        storageId: STORAGE_ID,
        allocations: [{ batchId: BATCH_ID, batchNumber: "BATCH-1", quantity: 2.25 }],
      }],
      timestamp: TIMESTAMP,
    });

    expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 17.75 });
    expect(await db.stock_batches.get(BATCH_ID)).toMatchObject({ quantity: 17.75 });
    expect(await db.products.get(PRODUCT_ID)).toMatchObject({ quantity: 17.75 });
    expect(await db.offline_mutations.count()).toBe(0);
  });

  it("rejects insufficient inventory before changing inventory or batch balances", async () => {
    await expect(applyOfflinePosStockEffects({
      workspaceId: WORKSPACE_ID,
      items: [{ productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 20.000001 }],
      batchPlans: [{
        productId: PRODUCT_ID,
        storageId: STORAGE_ID,
        allocations: [{ batchId: BATCH_ID, batchNumber: "BATCH-1", quantity: 20 }],
      }],
      timestamp: TIMESTAMP,
    })).rejects.toThrow("Insufficient inventory");

    expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 20 });
    expect(await db.stock_batches.get(BATCH_ID)).toMatchObject({ quantity: 20 });
    expect(await db.offline_mutations.count()).toBe(0);
  });

  it("blocks Cloud and Hybrid workspaces from applying offline stock effects", async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: "hybrid" });

    await expect(applyOfflinePosStockEffects({
      workspaceId: WORKSPACE_ID,
      items: [{ productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 1 }],
      batchPlans: [],
      timestamp: TIMESTAMP,
    })).rejects.toThrow("Connect to the internet");

    expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 20 });
    expect(await db.stock_batches.get(BATCH_ID)).toMatchObject({ quantity: 20 });
  });
});
