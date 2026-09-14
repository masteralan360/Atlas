import "fake-indexeddb/auto";

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
    value: { localStorage: storage, URL: globalThis.URL },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

installBrowserStorage();

Object.defineProperty(globalThis.URL, "createObjectURL", {
  configurable: true,
  value: () => "blob:vitest",
});

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { onLine: true, userAgent: "node-test" },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    visibilityState: "visible",
    dir: "ltr",
    documentElement: { lang: "en", dir: "ltr", style: {} },
    head: { appendChild: () => undefined },
    getElementsByTagName: () => [{ appendChild: () => undefined }],
    createElement: () => ({
      appendChild: () => undefined,
      getContext: () => null,
      setAttribute: () => undefined,
      style: {},
    }),
    createTextNode: () => ({}),
  },
});
Object.defineProperty(globalThis, "Element", {
  configurable: true,
  value: class Element {},
});
Object.defineProperty(globalThis, "HTMLElement", {
  configurable: true,
  value: class HTMLElement {},
});
Object.defineProperty(globalThis, "DOMMatrix", {
  configurable: true,
  value: class DOMMatrix {},
});
Object.defineProperty(globalThis, "ImageData", {
  configurable: true,
  value: class ImageData {},
});
Object.defineProperty(globalThis, "Path2D", {
  configurable: true,
  value: class Path2D {},
});
if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { hash: "", pathname: "/" },
      localStorage: (globalThis as unknown as { localStorage: unknown })
        .localStorage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
} else {
  const win = (globalThis as unknown as { window: Record<string, unknown> })
    .window;
  win.location = { hash: "", pathname: "/" };
  win.document = (globalThis as unknown as { document: unknown }).document;
}

import { describe, expect, it, vi } from "vitest";

// In-memory fake of the public.units + public.products tables used by the
// mocked supabase client.
const remoteUnits = new Map<string, Record<string, unknown>>();
const remoteProducts = new Map<string, Record<string, unknown>>();

function makeChainable() {
  const chainable = {
    from: (table: string) => {
      const tableRows = table === "products" ? remoteProducts : remoteUnits;
      return {
        ...chainable,
        upsert: (payload: unknown) => {
          const row = payload as Record<string, unknown>;
          tableRows.set(String(row.id), row);
          return { data: null, error: null };
        },
        update: (_payload: unknown) => ({
          eq: () => ({ data: null, error: null }),
        }),
        delete: () => ({ eq: () => ({ data: null, error: null }) }),
        range: () => {
          return { data: Array.from(tableRows.values()), error: null };
        },
      };
    },
    select: () => chainable,
    eq: () => chainable,
    order: () => chainable,
    in: () => chainable,
    gt: () => chainable,
    maybeSingle: () => ({ data: null, error: null }),
    single: () => ({ data: null, error: null }),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" } } } }),
    },
    schema: () => chainable,
  };
  return chainable;
}

vi.mock("@/auth/supabase", () => {
  return {
    supabase: makeChainable(),
    isSupabaseConfigured: true,
    isBackendConfigurationRequired: false,
  };
});

const WORKSPACE_ID = "ws-units-test";

describe("units normalization + rename migration", () => {
  it("normalizes invisible characters from unit codes", async () => {
    const { normalizeUnitCode, isReservedUnitCode } = await import(
      "@/local-db/models"
    );
    expect(normalizeUnitCode("\u200B\u200C وحدة \u200D")).toBe("وحدة");
    expect(normalizeUnitCode("  box  ")).toBe("box");
    expect(normalizeUnitCode(null)).toBe("");
    expect(isReservedUnitCode("\u200Bpcs\u200B")).toBe(true);
  });

  it("renaming a unit migrates products that reference the old code", async () => {
    const { createUnit, updateUnit } = await import("@/local-db/hooks");
    const { db } = await import("@/local-db/database");
    const { writeWorkspaceModeSnapshot } = await import(
      "@/workspace/workspaceMode"
    );

    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: "hybrid" });
    await db.workspaces.put({
      id: WORKSPACE_ID,
      name: "Repro",
      data_mode: "hybrid",
      syncStatus: "synced",
      isDeleted: false,
    } as never);

    const created = await createUnit(WORKSPACE_ID, {
      code: "وحدة",
      icon: "Package",
      isDynamic: false,
    });

    const now = new Date().toISOString();
    await db.products.put({
      id: "product-a",
      workspaceId: WORKSPACE_ID,
      sku: "A1",
      skuKey: "a1",
      name: "Product A",
      unit: "وحدة",
      price: 1,
      currency: "usd",
      quantity: 0,
      createdAt: now,
      updatedAt: now,
      syncStatus: "synced",
      lastSyncedAt: now,
      version: 1,
      isDeleted: false,
    } as never);

    await updateUnit(created.id, { code: "وحدة معدلة" });

    const product = await db.products.get("product-a");
    expect(product?.unit).toBe("وحدة معدلة");
    const unit = await db.units.get(created.id);
    expect(unit?.code).toBe("وحدة معدلة");
  });
});
