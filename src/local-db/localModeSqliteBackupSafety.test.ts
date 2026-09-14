import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "backup-safety-workspace";
const USER_ID = "backup-safety-user";
const TARGET = `atlas-${WORKSPACE_ID}-${USER_ID}.db`;

const testState = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  events: [] as string[],
  target: "",
  readGate: null as Promise<void> | null,
  notifyReadStarted: null as (() => void) | null,
  failureMode: null as null | "swap" | "open" | "quick-check" | "write-test",
}));

vi.mock("@/lib/platform", () => ({ isTauri: () => true }));
vi.mock("@/lib/network", () => ({
  getActiveBusinessWorkspaceId: () => WORKSPACE_ID,
  getActiveBusinessUserId: () => USER_ID,
  isOnline: () => true,
}));
vi.mock("@/workspace/workspaceMode", () => ({
  shouldMirrorToSqlite: () => true,
  isStrictLocalWorkspaceMode: () => false,
}));
vi.mock("@/workspace/workspaceDataFreshness", () => ({
  recordWorkspaceDataFetch: vi.fn(),
}));
vi.mock("./usbBackup", () => ({ runUsbBackupIfNeeded: vi.fn() }));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: "app-data" },
  exists: async (path: string) => testState.files.has(String(path)),
  mkdir: async () => undefined,
  readFile: async (path: string) => {
    const normalized = String(path);
    if (normalized === testState.target && testState.readGate) {
      testState.events.push("capture-read-start");
      testState.notifyReadStarted?.();
      await testState.readGate;
      testState.events.push("capture-read-end");
    }
    const value = testState.files.get(normalized);
    if (!value) throw new Error(`Missing mocked file ${normalized}`);
    return value.slice();
  },
  writeFile: async (path: string, data: Uint8Array) => {
    testState.files.set(String(path), data.slice());
  },
  copyFile: async (source: string, destination: string) => {
    const value = testState.files.get(String(source));
    if (!value) throw new Error(`Missing mocked file ${source}`);
    testState.files.set(String(destination), value.slice());
  },
  rename: async (source: string, destination: string) => {
    const value = testState.files.get(String(source));
    if (!value) throw new Error(`Missing mocked file ${source}`);
    if (
      testState.failureMode === "swap" &&
      String(source).includes(".candidate.db") &&
      String(destination) === testState.target
    ) {
      throw new Error("mock atomic swap failure");
    }
    testState.files.set(String(destination), value);
    testState.files.delete(String(source));
  },
  remove: async (path: string, options?: { recursive?: boolean }) => {
    const normalized = String(path);
    if (options?.recursive) {
      for (const key of [...testState.files.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) testState.files.delete(key);
      }
      return;
    }
    testState.files.delete(normalized);
  },
}));

vi.mock("@tauri-apps/plugin-sql", () => {
  function isNewLiveDatabase(path: string) {
    return path === `sqlite:${testState.target}` &&
      testState.files.get(testState.target)?.at(-1) === 2;
  }

  function connection(path: string) {
    let restoreProbePresent = false;
    return {
      async execute(query: string) {
        const normalized = query.replace(/\s+/g, " ").trim().toUpperCase();
        if (normalized.startsWith("INSERT INTO ATLAS_LOCAL_METADATA")) {
          testState.events.push("compatibility-marker");
        }
        if (
          normalized.startsWith("INSERT INTO ATLAS_SQLITE_RESTORE_PROBE") &&
          isNewLiveDatabase(path) &&
          testState.failureMode === "write-test"
        ) {
          throw new Error("mock restored write-test failure");
        }
        if (normalized.startsWith("INSERT INTO ATLAS_SQLITE_RESTORE_PROBE")) {
          restoreProbePresent = true;
        } else if (normalized === "ROLLBACK") {
          restoreProbePresent = false;
        }
        return { rowsAffected: 1 };
      },
      async select(query: string) {
        if (query.includes("PRAGMA wal_checkpoint(TRUNCATE)")) return [{ busy: 0 }];
        if (query.includes("PRAGMA quick_check")) {
          testState.events.push(`quick-check:${path}`);
          if (isNewLiveDatabase(path) && testState.failureMode === "quick-check") {
            return [{ quick_check: "corrupt" }];
          }
          return [{ quick_check: "ok" }];
        }
        if (query.includes("PRAGMA table_info(local_entities)")) {
          return [
            { name: "entity_type" },
            { name: "entity_id" },
            { name: "workspace_id" },
            { name: "payload" },
            { name: "current_workspace" },
          ];
        }
        if (query.includes("name = 'local_entities'")) return [{ name: "local_entities" }];
        if (query.includes("name = 'atlas_database_identity'")) {
          return [{ name: "atlas_database_identity" }];
        }
        if (query.includes("FROM atlas_database_identity")) {
          return [{ workspace_id: WORKSPACE_ID, user_id: USER_ID }];
        }
        if (query.includes("FROM atlas_sqlite_restore_probe")) {
          return [{ count: restoreProbePresent ? 1 : 0 }];
        }
        return [];
      },
      async close() {
        return true;
      },
    };
  }

  const Database = {
    async load(path: string) {
      if (
        path === `sqlite:${testState.target}` &&
        testState.files.get(testState.target)?.at(-1) === 2 &&
        testState.failureMode === "open"
      ) {
        throw new Error("mock restored open failure");
      }
      return connection(path);
    },
    get(path: string) {
      return connection(path);
    },
  };
  return { default: Database };
});

import {
  captureLocalModeSqliteDatabaseForBackup,
  injectLocalModeDatabaseFile,
  runLocalModeSqliteWrite,
  setLocalModeSqliteConnectionForTests,
} from "./localModeSqlite";

function sqliteBytes(marker: number) {
  const result = new Uint8Array(128);
  result.set(new TextEncoder().encode("SQLite format 3\0"));
  result[result.length - 1] = marker;
  return result;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("SQLite backup and restore safety", () => {
  beforeEach(() => {
    const storedValues = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => storedValues.set(key, value),
      removeItem: (key: string) => storedValues.delete(key),
      clear: () => storedValues.clear(),
      key: (index: number) => [...storedValues.keys()][index] ?? null,
      get length() { return storedValues.size; },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);
    testState.files.clear();
    testState.files.set(TARGET, sqliteBytes(1));
    testState.events.length = 0;
    testState.target = TARGET;
    testState.readGate = null;
    testState.notifyReadStarted = null;
    testState.failureMode = null;
    setLocalModeSqliteConnectionForTests();
  });

  afterEach(() => {
    setLocalModeSqliteConnectionForTests();
    vi.unstubAllGlobals();
  });

  it("holds the global write lane through native read and captured-byte quick_check", async () => {
    const readStarted = deferred();
    const releaseRead = deferred();
    testState.readGate = releaseRead.promise;
    testState.notifyReadStarted = readStarted.resolve;

    const capture = captureLocalModeSqliteDatabaseForBackup({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    });
    await readStarted.promise;

    let laterWriteRan = false;
    const laterWrite = runLocalModeSqliteWrite(async () => {
      laterWriteRan = true;
      testState.events.push("later-write");
    }, { workspaceId: WORKSPACE_ID, userId: USER_ID });
    await Promise.resolve();
    expect(laterWriteRan).toBe(false);

    releaseRead.resolve();
    await expect(capture).resolves.toEqual(sqliteBytes(1));
    await laterWrite;

    const readEnd = testState.events.indexOf("capture-read-end");
    const capturedQuickCheck = testState.events.findIndex((event) =>
      event.includes("atlas-restore-validation"),
    );
    expect(readEnd).toBeGreaterThanOrEqual(0);
    expect(capturedQuickCheck).toBeGreaterThan(readEnd);
    expect(testState.events.indexOf("later-write")).toBeGreaterThan(capturedQuickCheck);
  });

  it.each(["swap", "open", "quick-check", "write-test"] as const)(
    "automatically restores the prior native bytes after a %s failure",
    async (failureMode) => {
      testState.failureMode = failureMode;
      await expect(injectLocalModeDatabaseFile(
        sqliteBytes(2),
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        { requireScopedIdentity: true },
      )).rejects.toThrow();

      expect(testState.files.get(TARGET)).toEqual(sqliteBytes(1));
      expect([...testState.files.keys()].some((path) => path.includes(".rollback.db")))
        .toBe(false);
    },
  );

  it("rolls assets and database back together when staged asset commit fails", async () => {
    let activeAssetGeneration = "old";
    await expect(injectLocalModeDatabaseFile(
      sqliteBytes(2),
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      {
        requireScopedIdentity: true,
        commitExternalState: async () => {
          activeAssetGeneration = "new";
          throw new Error("mock asset commit failure");
        },
        rollbackExternalState: async () => {
          activeAssetGeneration = "old";
        },
      },
    )).rejects.toThrow("mock asset commit failure");

    expect(activeAssetGeneration).toBe("old");
    expect(testState.files.get(TARGET)).toEqual(sqliteBytes(1));
  });

  it("marks restored SQLite authoritative before allowing compatibility hydration", async () => {
    await injectLocalModeDatabaseFile(
      sqliteBytes(2),
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      { requireScopedIdentity: true },
    );

    expect(testState.files.get(TARGET)).toEqual(sqliteBytes(2));
    expect(testState.events).toContain("compatibility-marker");
  });
});
