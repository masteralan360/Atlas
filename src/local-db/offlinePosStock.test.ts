import { installTestBrowser } from '@/dev/testing/fixtures/browser';
import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setNetworkStatus } from "@/lib/network";
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from "@/workspace/workspaceMode";

import { db } from "./database";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000611";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000612";
const STORAGE_ID = "00000000-0000-4000-8000-000000000613";
const TARGET_STORAGE_ID = "00000000-0000-4000-8000-000000000617";
const INVENTORY_ID = "00000000-0000-4000-8000-000000000614";
const BATCH_ID = "00000000-0000-4000-8000-000000000615";
const SALE_ID = "00000000-0000-4000-8000-000000000616";
const TRANSFER_ID = "00000000-0000-4000-8000-000000000618";
const TIMESTAMP = "2026-09-09T10:00:00.000Z";

let applyOfflinePosStockEffects: typeof import("./offlinePosStock").applyOfflinePosStockEffects;
let deleteInventoryForProduct: typeof import("./inventory").deleteInventoryForProduct;
let setProductInventoryFromLegacyInput: typeof import("./inventory").setProductInventoryFromLegacyInput;
let transferInventoryQuantityWithBatches: typeof import("./inventory").transferInventoryQuantityWithBatches;

const installBrowserGlobals = installTestBrowser;

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
  await db.storages.put({
    id: TARGET_STORAGE_ID,
    ...base,
    name: "Target Storage",
    isSystem: false,
    isProtected: false,
    isPrimary: false,
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
    const inventory = await import("./inventory");
    deleteInventoryForProduct = inventory.deleteInventoryForProduct;
    setProductInventoryFromLegacyInput = inventory.setProductInventoryFromLegacyInput;
    transferInventoryQuantityWithBatches = inventory.transferInventoryQuantityWithBatches;
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
      saleId: SALE_ID,
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
    expect(await db.inventory_transactions.toArray()).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        productId: PRODUCT_ID,
        storageId: STORAGE_ID,
        transactionType: "sale",
        quantityDelta: -2.25,
        previousQuantity: 20,
        newQuantity: 17.75,
        referenceId: SALE_ID,
        referenceType: "pos_sale",
      }),
    ]);
    expect(await db.offline_mutations.count()).toBe(0);
  });

  it("rejects insufficient inventory before changing inventory or batch balances", async () => {
    await expect(applyOfflinePosStockEffects({
      workspaceId: WORKSPACE_ID,
      saleId: SALE_ID,
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

  it("records the stock removed when a Local product is archived", async () => {
    await deleteInventoryForProduct(PRODUCT_ID, TIMESTAMP);

    expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({
      quantity: 0,
      isDeleted: true,
    });
    expect(await db.inventory_transactions.toArray()).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        productId: PRODUCT_ID,
        storageId: STORAGE_ID,
        transactionType: "inventory_change",
        quantityDelta: -20,
        previousQuantity: 20,
        newQuantity: 0,
        referenceId: PRODUCT_ID,
        referenceType: "product_archive",
      }),
    ]);
  });

  it("records Local opening stock as an incoming movement", async () => {
    await db.inventory.delete(INVENTORY_ID);

    await setProductInventoryFromLegacyInput({
      workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID,
      storageId: STORAGE_ID,
      quantity: 4,
      timestamp: TIMESTAMP,
    });

    expect(await db.inventory.where("[productId+storageId]").equals([PRODUCT_ID, STORAGE_ID]).first())
      .toMatchObject({ quantity: 4, isDeleted: false });
    expect(await db.inventory_transactions.toArray()).toEqual([
      expect.objectContaining({
        transactionType: "initial_stock",
        quantityDelta: 4,
        previousQuantity: 0,
        newQuantity: 4,
        referenceId: PRODUCT_ID,
        referenceType: "product_initial_stock",
      }),
    ]);
  });

  it("records both Local inventory transfer legs", async () => {
    await transferInventoryQuantityWithBatches({
      workspaceId: WORKSPACE_ID,
      productId: PRODUCT_ID,
      sourceStorageId: STORAGE_ID,
      targetStorageId: TARGET_STORAGE_ID,
      quantity: 2.5,
      referenceId: TRANSFER_ID,
      timestamp: TIMESTAMP,
      skipBatchRefresh: true,
      skipReorderCheck: true,
    });

    expect(await db.inventory.where("[productId+storageId]").equals([PRODUCT_ID, STORAGE_ID]).first())
      .toMatchObject({ quantity: 17.5 });
    expect(await db.inventory.where("[productId+storageId]").equals([PRODUCT_ID, TARGET_STORAGE_ID]).first())
      .toMatchObject({ quantity: 2.5, isDeleted: false });
    expect(await db.inventory_transactions.toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        storageId: STORAGE_ID,
        transactionType: "transfer_out",
        quantityDelta: -2.5,
        previousQuantity: 20,
        newQuantity: 17.5,
        referenceId: TRANSFER_ID,
        referenceType: "inventory_transfer",
      }),
      expect.objectContaining({
        storageId: TARGET_STORAGE_ID,
        transactionType: "transfer_in",
        quantityDelta: 2.5,
        previousQuantity: 0,
        newQuantity: 2.5,
        referenceId: TRANSFER_ID,
        referenceType: "inventory_transfer",
      }),
    ]));
  });

  it("blocks Cloud and Hybrid workspaces from applying offline stock effects", async () => {
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: "hybrid" });

    await expect(applyOfflinePosStockEffects({
      workspaceId: WORKSPACE_ID,
      saleId: SALE_ID,
      items: [{ productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 1 }],
      batchPlans: [],
      timestamp: TIMESTAMP,
    })).rejects.toThrow("Connect to the internet");

    expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 20 });
    expect(await db.stock_batches.get(BATCH_ID)).toMatchObject({ quantity: 20 });
  });
});
