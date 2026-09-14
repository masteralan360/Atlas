import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "pwa-restore-workspace";
const USER_ID = "pwa-restore-user";

const pwaState = vi.hoisted(() => ({
  failFinalize: false,
  events: [] as string[],
}));

vi.mock("@/lib/platform", () => ({ isTauri: () => false }));
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
vi.mock("./pwaSqlite", () => ({
  DEFAULT_PWA_SQLITE_SCOPE: { workspaceId: "legacy", userId: "legacy" },
  isOpfsSupported: () => true,
  createPwaSqliteConnection: () => {
    throw new Error("The test connection override should be used.");
  },
  closePwaDatabase: vi.fn(),
  exportPwaDatabase: vi.fn(),
  validateAtlasLocalDatabase: async () => {
    pwaState.events.push("validate");
  },
  runExclusivePwaDatabaseReplacement: async (
    _data: Uint8Array,
    _scope: unknown,
    _options: unknown,
    task: (session: unknown) => Promise<unknown>,
  ) => {
    pwaState.events.push("begin");
    const connection = {
      execute: async (query: string) => {
        if (query.includes("INSERT INTO atlas_local_metadata")) {
          pwaState.events.push("mark-authoritative");
        }
        return { rowsAffected: 0 };
      },
      select: async <T>() => [] as T,
    };
    return task({
      connection,
      finalize: async () => {
        pwaState.events.push("finalize");
        if (pwaState.failFinalize) throw new Error("mock finalize failure");
      },
      rollback: async () => {
        pwaState.events.push("rollback");
      },
    });
  },
  quarantinePwaDatabase: async () => {
    pwaState.events.push("quarantine");
  },
}));

import {
  injectLocalModeDatabaseFile,
  setLocalModeSqliteConnectionForTests,
} from "./localModeSqlite";

const testConnection = {
  execute: async (query: string) => {
    if (query.includes("INSERT INTO atlas_local_metadata")) {
      pwaState.events.push("mark-authoritative");
    }
    return { rowsAffected: 0 };
  },
  select: async <T>() => [] as T,
  close: async () => true,
};

describe("PWA SQLite restore compatibility marker safety", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    pwaState.failFinalize = false;
    pwaState.events.length = 0;
    setLocalModeSqliteConnectionForTests(testConnection);
  });

  afterEach(() => {
    setLocalModeSqliteConnectionForTests();
    vi.unstubAllGlobals();
  });

  it("quarantines an outcome-uncertain finalization without rolling either side back", async () => {
    pwaState.failFinalize = true;
    let externalRollbackCalled = false;

    await expect(injectLocalModeDatabaseFile(
      new Uint8Array(128),
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      {
        requireScopedIdentity: true,
        commitExternalState: async () => {
          pwaState.events.push("commit-assets");
        },
        rollbackExternalState: async () => {
          externalRollbackCalled = true;
          pwaState.events.push("rollback-assets");
        },
      },
    )).rejects.toThrow("mock finalize failure");

    expect(pwaState.events).toEqual([
      "validate",
      "begin",
      "mark-authoritative",
      "commit-assets",
      "finalize",
      "quarantine",
    ]);
    expect(externalRollbackCalled).toBe(false);
  });

  it("persists the SQLite authority marker on a finalized replacement", async () => {
    await injectLocalModeDatabaseFile(
      new Uint8Array(128),
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
    );

    expect(pwaState.events).toEqual([
      "validate",
      "begin",
      "mark-authoritative",
      "finalize",
    ]);
  });

  it("rolls both sides back before finalization and quarantines when asset rollback is incomplete", async () => {

    await expect(injectLocalModeDatabaseFile(
      new Uint8Array(128),
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      {
        commitExternalState: async () => {
          pwaState.events.push("commit-assets");
          throw new Error("mock asset commit failure");
        },
        rollbackExternalState: async () => {
          pwaState.events.push("rollback-assets");
          throw new Error("mock asset rollback failure");
        },
      },
    )).rejects.toThrow("automatic rollback was incomplete");

    expect(pwaState.events).toEqual([
      "validate",
      "begin",
      "mark-authoritative",
      "commit-assets",
      "rollback-assets",
      "rollback",
      "quarantine",
    ]);
  });
});
