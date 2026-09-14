import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquirePwaDatabaseOwnership,
  beginPwaDatabaseReplacement,
  checkPwaSqliteReadiness,
  createPwaSqliteConnection,
  finalizePwaDatabaseReplacement,
  getPwaOwnershipLockName,
  pwaSqliteInternals,
  replacePwaDatabaseFile,
  releasePwaDatabaseOwnership,
  runExclusivePwaDatabaseReplacement,
  type PwaSqliteScope,
} from "./pwaSqlite";

interface TestWorkerRequest {
  id: number;
  operation: string;
  payload?: Record<string, unknown>;
}

class FakeLockManager {
  readonly held = new Set<string>();
  readonly calls: Array<{ name: string; options: LockOptions }> = [];

  async request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    this.calls.push({ name, options });
    if (options.ifAvailable && this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name, mode: options.mode ?? "exclusive" } as Lock);
    } finally {
      this.held.delete(name);
    }
  }
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  static recoverOnOpen = false;
  readonly requests: TestWorkerRequest[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(request: TestWorkerRequest) {
    this.requests.push(request);
    queueMicrotask(() => {
      const query = String(request.payload?.query ?? "");
      const response = query === "FAIL"
        ? { id: request.id, ok: false, error: { name: "Error", message: "write failed" } }
        : {
            id: request.id,
            ok: true,
            result: request.operation === "open" && FakeWorker.recoverOnOpen
              ? { recoveredPendingReplacement: true }
              : request.operation === "select"
              ? [{ value: 1 }]
              : request.operation === "export"
                ? new Uint8Array([1, 2, 3])
                : { rowsAffected: 1 },
          };
      for (const listener of this.listeners.get("message") ?? []) {
        listener({ data: response } as MessageEvent);
      }
    });
  }

  terminate() {
    this.terminated = true;
  }

  crash() {
    const event = { error: new Error("worker crashed") } as ErrorEvent;
    for (const listener of this.listeners.get("error") ?? []) {
      listener(event as unknown as MessageEvent);
    }
  }
}

const workspacesToRelease = new Set<string>();
let locks: FakeLockManager;
let storage: {
  getDirectory: ReturnType<typeof vi.fn>;
  persisted: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
};

function scope(workspaceId = "workspace-one", userId = "user-one"): PwaSqliteScope {
  workspacesToRelease.add(workspaceId);
  return { workspaceId, userId };
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.recoverOnOpen = false;
  locks = new FakeLockManager();
  const missingDirectoryError = Object.assign(new Error("Directory not found"), {
    name: "NotFoundError",
  });
  storage = {
    getDirectory: vi.fn().mockResolvedValue({
      getDirectoryHandle: vi.fn().mockRejectedValue(missingDirectoryError),
    }),
    persisted: vi.fn().mockResolvedValue(true),
    persist: vi.fn().mockResolvedValue(true),
  };
  vi.stubGlobal("navigator", { storage, locks });
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(async () => {
  for (const workspaceId of workspacesToRelease) {
    await releasePwaDatabaseOwnership(workspaceId);
  }
  workspacesToRelease.clear();
  vi.unstubAllGlobals();
});

describe("PWA SQLite ownership and readiness", () => {
  it("blocks readiness when OPFS is unavailable", async () => {
    vi.stubGlobal("navigator", {
      storage: { ...storage, getDirectory: undefined },
      locks,
    });

    await expect(checkPwaSqliteReadiness(scope())).resolves.toMatchObject({
      ready: false,
      reason: "opfs-unavailable",
    });
  });

  it("blocks readiness when Web Locks are unavailable", async () => {
    vi.stubGlobal("navigator", { storage });

    await expect(checkPwaSqliteReadiness(scope())).resolves.toMatchObject({
      ready: false,
      reason: "web-locks-unavailable",
    });
  });

  it("uses one workspace-wide, non-waiting exclusive Web Lock", async () => {
    const workspaceId = "busy-workspace";
    workspacesToRelease.add(workspaceId);
    let releaseBlocker!: () => void;
    const blocker = locks.request(
      getPwaOwnershipLockName(workspaceId),
      { mode: "exclusive" },
      () => new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      }),
    );

    await expect(acquirePwaDatabaseOwnership(workspaceId)).resolves.toBe(false);
    expect(locks.calls.at(-1)).toMatchObject({
      name: getPwaOwnershipLockName(workspaceId),
      options: { mode: "exclusive", ifAvailable: true },
    });

    releaseBlocker();
    await blocker;
  });

  it("requires a granted persistent-storage lease before starting a worker", async () => {
    storage.persisted.mockResolvedValue(false);
    storage.persist.mockResolvedValue(false);

    await expect(checkPwaSqliteReadiness(scope())).resolves.toMatchObject({
      ready: false,
      reason: "persistent-storage-denied",
    });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("opens the dedicated worker and completes a transactional write test", async () => {
    await expect(checkPwaSqliteReadiness(scope())).resolves.toMatchObject({ ready: true });

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].requests.map((request) => request.operation)).toEqual([
      "open",
      "write-test",
      "write-test",
    ]);
  });

  it("acknowledges a recovered database only after external recovery can run", async () => {
    FakeWorker.recoverOnOpen = true;

    await expect(checkPwaSqliteReadiness(scope("recovered-workspace"))).resolves.toMatchObject({
      ready: true,
    });

    expect(FakeWorker.instances[0].requests.map((request) => request.operation)).toEqual([
      "open",
      "acknowledge-recovery",
      "write-test",
      "write-test",
    ]);
  });

  it("evicts a crashed worker and releases ownership for a clean retry", async () => {
    const databaseScope = scope("crashed-workspace", "user-one");
    await expect(checkPwaSqliteReadiness(databaseScope)).resolves.toMatchObject({ ready: true });
    const crashed = FakeWorker.instances[0];

    crashed.crash();
    await Promise.resolve();

    expect(crashed.terminated).toBe(true);
    await expect(checkPwaSqliteReadiness(databaseScope)).resolves.toMatchObject({ ready: true });
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("derives separate physical pool directories per workspace/user tuple", () => {
    const first = pwaSqliteInternals.poolDirectory(scope("workspace-a", "user-a"));
    const second = pwaSqliteInternals.poolDirectory(scope("workspace-a", "user-b"));

    expect(first).not.toBe(second);
    expect(getPwaOwnershipLockName("workspace-a")).toBe(
      "atlas:sqlite:workspace:workspace-a",
    );
  });
});

describe("PWA SQLite connection protocol", () => {
  it("keeps a transaction contiguous in the worker", async () => {
    const connection = createPwaSqliteConnection(scope());
    await connection.transaction!(async (transaction) => {
      await transaction.execute("INSERT ONE", [1]);
      await transaction.execute("INSERT TWO", [2]);
    });

    const operations = FakeWorker.instances[0].requests
      .slice(2)
      .map((request) => `${request.operation}:${request.payload?.query ?? ""}`);
    expect(operations).toEqual([
      "begin:",
      "execute:INSERT ONE",
      "execute:INSERT TWO",
      "commit:",
    ]);
  });

  it("rolls back a failed transaction", async () => {
    const connection = createPwaSqliteConnection(scope("rollback-workspace"));

    await expect(
      connection.transaction!(async (transaction) => {
        await transaction.execute("INSERT ONE");
        await transaction.execute("FAIL");
      }),
    ).rejects.toThrow("write failed");

    expect(FakeWorker.instances[0].requests.map((request) => request.operation)).toContain(
      "rollback",
    );
  });

  it("performs validation, swap, reopen, and write-test as one worker operation", async () => {
    const databaseScope = scope("restore-workspace", "restore-user");
    await replacePwaDatabaseFile(new Uint8Array(128), databaseScope, {
      requireScopedIdentity: true,
    });

    const requests = FakeWorker.instances[0].requests;
    expect(requests.map((request) => request.operation)).toEqual([
      "open",
      "write-test",
      "replace",
    ]);
    expect(requests[0].payload).toMatchObject({
      workspaceId: databaseScope.workspaceId,
      userId: databaseScope.userId,
    });
    expect(requests.at(-1)?.payload?.requireScopedIdentity).toBe(true);
  });

  it("retains the browser rollback file until the two-phase restore is finalized", async () => {
    const databaseScope = scope("two-phase-workspace", "two-phase-user");
    await beginPwaDatabaseReplacement(new Uint8Array(128), databaseScope, {
      requireScopedIdentity: true,
    });
    await finalizePwaDatabaseReplacement(databaseScope);

    const requests = FakeWorker.instances[0].requests;
    expect(requests.map((request) => request.operation)).toEqual([
      "open",
      "write-test",
      "replace",
      "finalize-replace",
    ]);
    expect(requests[2].payload).toMatchObject({
      requireScopedIdentity: true,
      retainRollback: true,
    });
  });

  it("blocks ordinary database operations across every restore phase", async () => {
    const databaseScope = scope("barrier-workspace", "barrier-user");
    const connection = createPwaSqliteConnection(databaseScope);
    let releaseRestore!: () => void;
    let notifyRestoreStarted!: () => void;
    const restoreStarted = new Promise<void>((resolve) => {
      notifyRestoreStarted = resolve;
    });
    const holdRestore = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });

    const replacement = runExclusivePwaDatabaseReplacement(
      new Uint8Array(128),
      databaseScope,
      { requireScopedIdentity: true },
      async (session) => {
        await session.connection.execute("RESTORE MARKER");
        notifyRestoreStarted();
        await holdRestore;
        await session.finalize();
      },
    );
    await restoreStarted;
    const ordinaryWrite = connection.execute("ORDINARY WRITE");
    await Promise.resolve();
    expect(FakeWorker.instances[0].requests.some((request) =>
      request.payload?.query === "ORDINARY WRITE"
    )).toBe(false);

    releaseRestore();
    await replacement;
    await ordinaryWrite;
    expect(FakeWorker.instances[0].requests.map((request) =>
      `${request.operation}:${request.payload?.query ?? ""}`
    )).toEqual([
      "open:",
      "write-test:",
      "replace:",
      "execute:RESTORE MARKER",
      "finalize-replace:",
      "execute:ORDINARY WRITE",
    ]);
  });
});
