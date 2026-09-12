import "fake-indexeddb/auto";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  clearWorkspaceModeSnapshot,
  writeWorkspaceModeSnapshot,
} from "@/workspace/workspaceMode";

import { AtlasDatabase } from "./database";
import {
  checkpointLocalModeSqliteForBackup,
  hydrateLocalModeCacheFromSqlite,
  setLocalModeSqliteConnectionForTests,
  type SqliteConnection,
} from "./localModeSqlite";

const WORKSPACE_ID = "local-authority-workspace";
const LEGACY_TIMESTAMP_WORKSPACE_ID = "local-timestamp-workspace";
const testDb = new AtlasDatabase("AtlasDatabaseLocalAuthorityTest");

function installBrowserStorage() {
  const rows = new Map<string, string>();
  const storage = {
    get length() {
      return rows.size;
    },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for test condition");
}

class RecordingSqliteConnection implements SqliteConnection {
  rows = new Map<string, string>();
  activeCashierShiftClaims = new Map<string, string>();
  events: string[] = [];
  selectQueries: string[] = [];
  failEntityType: string | null = null;
  checkpointBusy = false;
  commitGate: Promise<void> | null = null;

  async execute(query: string, bindValues: unknown[] = []) {
    const normalized = query.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalized.startsWith("INSERT INTO LOCAL_ENTITIES")) {
      const entityType = String(bindValues[0]);
      if (entityType === this.failEntityType) {
        throw new Error(`SQLite rejected ${entityType}`);
      }
      this.rows.set(`${entityType}:${String(bindValues[1])}`, String(bindValues[4]));
    } else if (normalized.startsWith("DELETE FROM LOCAL_ENTITIES")) {
      this.rows.delete(`${String(bindValues[0])}:${String(bindValues[1])}`);
    } else if (normalized.startsWith("INSERT INTO CASHIER_SHIFT_ACTIVE_CLAIMS")) {
      this.activeCashierShiftClaims.set(
        `${String(bindValues[0])}:${String(bindValues[1])}`,
        String(bindValues[2]),
      );
    } else if (normalized.startsWith("DELETE FROM CASHIER_SHIFT_ACTIVE_CLAIMS")) {
      const key = `${String(bindValues[0])}:${String(bindValues[1])}`;
      if (
        bindValues.length < 3 ||
        this.activeCashierShiftClaims.get(key) === String(bindValues[2])
      ) {
        this.activeCashierShiftClaims.delete(key);
      }
    }
    return { rowsAffected: 1 };
  }

  async select<T>(query?: string, bindValues: unknown[] = []): Promise<T> {
    this.selectQueries.push(query ?? "");
    if (query?.includes("PRAGMA wal_checkpoint(TRUNCATE)")) {
      return [{ busy: this.checkpointBusy ? 1 : 0 }] as T;
    }
    if (query?.includes("FROM cashier_shift_active_claims")) {
      const occurrenceId = this.activeCashierShiftClaims.get(
        `${String(bindValues[0])}:${String(bindValues[1])}`,
      );
      return (occurrenceId ? [{ occurrence_id: occurrenceId }] : []) as T;
    }
    if (query?.includes("FROM local_entities") && bindValues.length >= 2) {
      const payload = this.rows.get(`${String(bindValues[0])}:${String(bindValues[1])}`);
      return (payload ? [{ payload }] : []) as T;
    }
    return [] as T;
  }

  async transaction<T>(task: (connection: SqliteConnection) => Promise<T>) {
    const snapshot = new Map(this.rows);
    this.events.push("begin");
    try {
      const result = await task(this);
      if (this.commitGate) {
        await this.commitGate;
      }
      this.events.push("commit");
      return result;
    } catch (error) {
      this.rows = snapshot;
      this.events.push("rollback");
      throw error;
    }
  }
}

class HydrationSqliteConnection implements SqliteConnection {
  constructor(
    readonly storedRows: Array<{
      entity_type: string;
      entity_id: string;
      workspace_id: string;
      current_workspace: string | null;
      payload: string;
      updated_at: string;
    }>,
  ) {}

  async execute(query: string, bindValues: unknown[] = []) {
    const normalized = query.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalized.startsWith("UPDATE LOCAL_ENTITIES SET PAYLOAD")) {
      const [, entityType, entityId] = bindValues;
      const row = this.storedRows.find(
        (candidate) =>
          candidate.entity_type === entityType &&
          candidate.entity_id === entityId,
      );
      if (row) {
        row.payload = String(bindValues[0]);
      }
    }
    return { rowsAffected: 1 };
  }

  async select<T>(query: string): Promise<T> {
    if (query.includes("COUNT(*) AS count")) {
      return [{ count: this.storedRows.length }] as T;
    }
    return this.storedRows as T;
  }
}

function entity(table: string, id: string) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name: `${table}-${id}`,
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    version: 1,
    isDeleted: false,
    syncStatus: "synced",
    lastSyncedAt: "2026-06-19T00:00:00.000Z",
  };
}

describe("local-mode SQLite authority", () => {
  let sqlite: RecordingSqliteConnection;

  beforeAll(async () => {
    installBrowserStorage();
    await testDb.open();
  });

  beforeEach(async () => {
    await testDb.delete();
    await testDb.open();
    sqlite = new RecordingSqliteConnection();
    setLocalModeSqliteConnectionForTests(sqlite);
    writeWorkspaceModeSnapshot({
      workspaceId: WORKSPACE_ID,
      dataMode: "local",
    });
  });

  afterEach(() => {
    clearWorkspaceModeSnapshot(WORKSPACE_ID);
    setLocalModeSqliteConnectionForTests();
  });

  afterAll(async () => {
    await testDb.delete();
  });

  it("does not acknowledge a cache write before SQLite commits", async () => {
    const gate = deferred();
    sqlite.commitGate = gate.promise;
    let settled = false;

    const write = testDb.categories.put(entity("category", "category-1") as never)
      .then(() => {
        settled = true;
      });

    await waitFor(() => sqlite.events.length > 0);
    expect(sqlite.events).toEqual(["begin"]);
    expect(settled).toBe(false);

    gate.resolve();
    await write;

    expect(sqlite.events).toEqual(["begin", "commit"]);
    expect(settled).toBe(true);
    expect(sqlite.rows.has("categories:category-1")).toBe(true);
  });

  it("rejects a new negative product snapshot before either Local store commits", async () => {
    const product = { ...entity("product", "negative-product"), quantity: -0.0000001 };

    await expect(testDb.products.put(product as never)).rejects.toThrow();

    expect(await testDb.products.get(product.id)).toBeUndefined();
    expect(sqlite.rows.has(`products:${product.id}`)).toBe(false);
  });

  it("allows a legacy deficit to improve but rejects making it worse", async () => {
    const productId = "legacy-negative-product";
    sqlite.rows.set(`products:${productId}`, JSON.stringify({ quantity: -5 }));

    await testDb.products.put({ ...entity("product", productId), quantity: -3 } as never);
    expect(JSON.parse(sqlite.rows.get(`products:${productId}`) || "{}").quantity).toBe(-3);

    await expect(
      testDb.products.put({ ...entity("product", productId), quantity: -4 } as never),
    ).rejects.toThrow();
    expect(JSON.parse(sqlite.rows.get(`products:${productId}`) || "{}").quantity).toBe(-3);
  });

  it("checkpoints Local Mode SQLite before an update safety backup", async () => {
    await checkpointLocalModeSqliteForBackup();

    expect(sqlite.selectQueries).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
  });

  it("refuses an update safety backup when SQLite cannot checkpoint", async () => {
    sqlite.checkpointBusy = true;

    await expect(checkpointLocalModeSqliteForBackup()).rejects.toThrow(
      "Local-mode SQLite is busy",
    );
  });

  it("claims one active cashier occurrence atomically in Local-mode SQLite", async () => {
    const first = {
      ...entity("cashier_shift_occurrences", "cashier-shift-one"),
      assignmentId: "assignment-one",
      cashierUserId: "cashier-one",
      status: "active",
    } as any;
    const second = {
      ...entity("cashier_shift_occurrences", "cashier-shift-two"),
      assignmentId: "assignment-two",
      cashierUserId: "cashier-one",
      status: "active",
    } as any;

    await testDb.cashier_shift_occurrences.put(first);
    await expect(testDb.cashier_shift_occurrences.put(second)).rejects.toThrow(
      "already has an active shift",
    );
    expect(
      sqlite.activeCashierShiftClaims.get(`${WORKSPACE_ID}:cashier-one`),
    ).toBe(first.id);
    expect(await testDb.cashier_shift_occurrences.get(second.id)).toBeUndefined();
  });

  it("aborts the Dexie cache write when SQLite fails", async () => {
    sqlite.failEntityType = "products";

    await expect(
      testDb.products.put(entity("product", "product-1") as never),
    ).rejects.toThrow("SQLite rejected products");

    expect(await testDb.products.get("product-1")).toBeUndefined();
    expect(sqlite.rows.size).toBe(0);
    expect(sqlite.events).toEqual(["begin", "rollback"]);
  });

  it("commits an explicit multi-table cache transaction as one SQLite transaction", async () => {
    await testDb.transaction("rw", [testDb.categories, testDb.products], async () => {
      await testDb.categories.put(entity("category", "category-2") as never);
      await testDb.products.put(entity("product", "product-2") as never);
    });

    expect(sqlite.events).toEqual(["begin", "commit"]);
    expect(sqlite.rows.has("categories:category-2")).toBe(true);
    expect(sqlite.rows.has("products:product-2")).toBe(true);
  });

  it("rolls back SQLite and Dexie together when a grouped write fails", async () => {
    sqlite.failEntityType = "products";

    await expect(
      testDb.transaction("rw", [testDb.categories, testDb.products], async () => {
        await testDb.categories.put(entity("category", "category-3") as never);
        await testDb.products.put(entity("product", "product-3") as never);
      }),
    ).rejects.toThrow("SQLite rejected products");

    expect(sqlite.events).toEqual(["begin", "rollback"]);
    expect(sqlite.rows.size).toBe(0);
    expect(await testDb.categories.get("category-3")).toBeUndefined();
    expect(await testDb.products.get("product-3")).toBeUndefined();
  });

  it("mirrors Activity data for hybrid workspaces", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    writeWorkspaceModeSnapshot({
      workspaceId: WORKSPACE_ID,
      dataMode: "hybrid",
    });

    try {
      await testDb.activity_catalog.put({
        ...entity("activity", "activity-1"),
        isInfinite: true,
        isActive: true,
        availableQuantity: null,
        price: 1000,
        currency: "iqd",
      } as never);

      await waitFor(() => sqlite.rows.has("activity_catalog:activity-1"));
      expect(sqlite.rows.has("activity_catalog:activity-1")).toBe(true);
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it("backfills timestamp-less sale items while hydrating a legacy local cache", async () => {
    const saleCreatedAt = "2026-07-01T10:00:00.000Z";
    const legacyItemId = "legacy-timestamp-sale-item";
    const sqlite = new HydrationSqliteConnection([
      {
        entity_type: "sales",
        entity_id: "legacy-timestamp-sale",
        workspace_id: LEGACY_TIMESTAMP_WORKSPACE_ID,
        current_workspace: null,
        payload: JSON.stringify({
          id: "legacy-timestamp-sale",
          workspaceId: LEGACY_TIMESTAMP_WORKSPACE_ID,
          createdAt: saleCreatedAt,
          updatedAt: saleCreatedAt,
        }),
        updated_at: saleCreatedAt,
      },
      {
        entity_type: "sale_items",
        entity_id: legacyItemId,
        workspace_id: LEGACY_TIMESTAMP_WORKSPACE_ID,
        current_workspace: null,
        payload: JSON.stringify({
          id: legacyItemId,
          saleId: "legacy-timestamp-sale",
          productId: "legacy-product",
        }),
        updated_at: "2026-07-02T10:00:00.000Z",
      },
    ]);
    setLocalModeSqliteConnectionForTests(sqlite);
    writeWorkspaceModeSnapshot({
      workspaceId: LEGACY_TIMESTAMP_WORKSPACE_ID,
      dataMode: "local",
    });

    try {
      await hydrateLocalModeCacheFromSqlite(
        testDb,
        LEGACY_TIMESTAMP_WORKSPACE_ID,
      );

      expect(await testDb.sale_items.get(legacyItemId)).toMatchObject({
        workspaceId: LEGACY_TIMESTAMP_WORKSPACE_ID,
        createdAt: saleCreatedAt,
        updatedAt: saleCreatedAt,
      });
      expect(JSON.parse(sqlite.storedRows[1].payload)).toMatchObject({
        createdAt: saleCreatedAt,
        updatedAt: saleCreatedAt,
      });
    } finally {
      clearWorkspaceModeSnapshot(LEGACY_TIMESTAMP_WORKSPACE_ID);
      setLocalModeSqliteConnectionForTests(sqlite);
    }
  });
});
