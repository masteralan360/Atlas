import type { SqliteConnection } from "./localModeSqlite";

const DB_FILENAME = "atlas-local-mode.db";
const DATABASE_VFS_FILENAME = `/${DB_FILENAME}`;
const OWNERSHIP_LOCK_PREFIX = "atlas:sqlite:workspace:";
export const PWA_SQLITE_FATAL_EVENT = "atlas:pwa-sqlite-fatal";

export interface PwaSqliteScope {
  workspaceId: string;
  userId: string;
}

export const DEFAULT_PWA_SQLITE_SCOPE: Readonly<PwaSqliteScope> = Object.freeze({
  workspaceId: "legacy-local-workspace",
  userId: "legacy-local-user",
});

export type PwaSqliteReadinessFailure =
  | "opfs-unavailable"
  | "web-locks-unavailable"
  | "persistent-storage-unavailable"
  | "persistent-storage-denied"
  | "workspace-owned"
  | "worker-unavailable"
  | "write-test-failed"
  | "initialization-failed";

export type PwaSqliteReadiness =
  | { ready: true; scope: PwaSqliteScope }
  | {
      ready: false;
      scope: PwaSqliteScope;
      reason: PwaSqliteReadinessFailure;
      message: string;
    };

interface WorkerRequest {
  id: number;
  operation:
    | "open"
    | "execute"
    | "select"
    | "begin"
    | "commit"
    | "rollback"
    | "write-test"
    | "export"
    | "replace"
    | "finalize-replace"
    | "rollback-replace"
    | "acknowledge-recovery"
    | "validate"
    | "close";
  payload?: Record<string, unknown>;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: {
    name?: string;
    message?: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface OwnershipLease {
  acquired: Promise<boolean>;
  release: () => void;
  request: Promise<void>;
}

export class PwaSqliteError extends Error {
  readonly code: PwaSqliteReadinessFailure;
  readonly cause?: unknown;

  constructor(code: PwaSqliteReadinessFailure, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PwaSqliteError";
    this.code = code;
    this.cause = options?.cause;
  }
}

function normalizeScope(scope?: PwaSqliteScope): PwaSqliteScope {
  const normalized = scope ?? DEFAULT_PWA_SQLITE_SCOPE;
  const workspaceId = normalized.workspaceId.trim();
  const userId = normalized.userId.trim();
  if (!workspaceId || !userId) {
    throw new PwaSqliteError(
      "initialization-failed",
      "A workspace and user are required to open the local database.",
    );
  }
  return { workspaceId, userId };
}

function scopeKey(scope: PwaSqliteScope): string {
  return JSON.stringify([scope.workspaceId, scope.userId]);
}

function poolDirectory(scope: PwaSqliteScope): string {
  return `.atlas-sqlite-sahpool/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.userId)}`;
}

export function getPwaOwnershipLockName(workspaceId: string): string {
  return `${OWNERSHIP_LOCK_PREFIX}${workspaceId}`;
}

export function isOpfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

export function isWebLocksSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "locks" in navigator &&
    typeof navigator.locks?.request === "function"
  );
}

function isPersistentStorageSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage?.persisted === "function" &&
    typeof navigator.storage?.persist === "function"
  );
}

const ownershipLeases = new Map<string, OwnershipLease>();

/**
 * Acquire this tab's workspace-wide ownership lease without waiting for, or
 * taking over from, another tab/PWA window.
 */
export async function acquirePwaDatabaseOwnership(workspaceId: string): Promise<boolean> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId || !isWebLocksSupported()) return false;

  const current = ownershipLeases.get(normalizedWorkspaceId);
  if (current) return current.acquired;

  let resolveAcquired!: (acquired: boolean) => void;
  let release!: () => void;
  const acquired = new Promise<boolean>((resolve) => {
    resolveAcquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const request = navigator.locks
    .request(
      getPwaOwnershipLockName(normalizedWorkspaceId),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          resolveAcquired(false);
          return;
        }
        resolveAcquired(true);
        await held;
      },
    )
    .then(() => undefined)
    .catch((error) => {
      resolveAcquired(false);
      console.error("[PwaSQLite] Workspace ownership request failed:", error);
    });

  const lease: OwnershipLease = { acquired, release, request };
  ownershipLeases.set(normalizedWorkspaceId, lease);
  if (!(await acquired)) {
    if (ownershipLeases.get(normalizedWorkspaceId) === lease) {
      ownershipLeases.delete(normalizedWorkspaceId);
    }
    return false;
  }
  return true;
}

async function releaseOwnershipLease(workspaceId: string): Promise<void> {
  const lease = ownershipLeases.get(workspaceId);
  if (!lease) return;
  ownershipLeases.delete(workspaceId);
  lease.release();
  await lease.request;
}

async function requirePersistentStorage(): Promise<void> {
  if (!isPersistentStorageSupported()) {
    throw new PwaSqliteError(
      "persistent-storage-unavailable",
      "Persistent browser storage is unavailable.",
    );
  }

  let persisted = false;
  try {
    persisted = await navigator.storage.persisted();
    if (!persisted) persisted = await navigator.storage.persist();
  } catch (error) {
    throw new PwaSqliteError(
      "persistent-storage-unavailable",
      "Persistent browser storage could not be verified.",
      { cause: error },
    );
  }

  if (!persisted) {
    throw new PwaSqliteError(
      "persistent-storage-denied",
      "Persistent browser storage permission is required.",
    );
  }
}

class PwaSqliteWorkerClient {
  readonly scope: PwaSqliteScope;
  recoveredPendingReplacement = false;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    scope: PwaSqliteScope,
    private readonly onFatal: (client: PwaSqliteWorkerClient, reason: unknown) => void,
  ) {
    this.scope = scope;
    if (typeof Worker === "undefined") {
      throw new PwaSqliteError("worker-unavailable", "Dedicated workers are unavailable.");
    }

    this.worker = new Worker(new URL("./pwaSqlite.worker.ts", import.meta.url), {
      type: "module",
      name: `atlas-sqlite-${scope.workspaceId}`,
    });
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onWorkerError);
    this.worker.addEventListener("messageerror", this.onWorkerError);
  }

  private readonly onMessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }
    const error = new Error(response.error?.message || "SQLite worker request failed.");
    error.name = response.error?.name || "Error";
    pending.reject(error);
  };

  private readonly onWorkerError = (event: Event | ErrorEvent) => {
    if (this.closed) return;
    const reason = "error" in event && event.error
      ? event.error
      : new Error("The SQLite worker stopped unexpectedly.");
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.removeEventListener("messageerror", this.onWorkerError);
    this.worker.terminate();
    this.onFatal(this, reason);
  };

  request<T>(operation: WorkerRequest["operation"], payload?: Record<string, unknown>): Promise<T> {
    if (this.closed && operation !== "close") {
      return Promise.reject(new Error("The PWA SQLite database is closed."));
    }
    const id = this.nextRequestId++;
    const message: WorkerRequest = { id, operation, payload };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        if (payload?.data instanceof Uint8Array) {
          const data = payload.data.slice();
          message.payload = { ...payload, data };
          this.worker.postMessage(message, [data.buffer]);
        } else {
          this.worker.postMessage(message);
        }
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(task, task);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async initialize(): Promise<void> {
    const result = await this.request<{ recoveredPendingReplacement?: boolean }>("open", {
      filename: DATABASE_VFS_FILENAME,
      poolDirectory: poolDirectory(this.scope),
      workspaceId: this.scope.workspaceId,
      userId: this.scope.userId,
      importLegacyFile: scopeKey(this.scope) === scopeKey(DEFAULT_PWA_SQLITE_SCOPE),
      legacyFilename: DB_FILENAME,
    });
    this.recoveredPendingReplacement = result?.recoveredPendingReplacement === true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.operationTail.catch(() => undefined);
    try {
      await this.request("close");
    } finally {
      this.closed = true;
      this.worker.removeEventListener("message", this.onMessage);
      this.worker.removeEventListener("error", this.onWorkerError);
      this.worker.removeEventListener("messageerror", this.onWorkerError);
      this.worker.terminate();
      for (const pending of this.pending.values()) {
        pending.reject(new Error("The PWA SQLite worker was closed."));
      }
      this.pending.clear();
    }
  }
}

const clients = new Map<string, PwaSqliteWorkerClient>();
const clientPromises = new Map<string, Promise<PwaSqliteWorkerClient>>();
const pendingClientScopes = new Map<string, PwaSqliteScope>();
const workspaceOpenAttempts = new Map<string, number>();

function handleFatalClient(client: PwaSqliteWorkerClient, reason: unknown) {
  const key = scopeKey(client.scope);
  if (clients.get(key) === client) clients.delete(key);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PWA_SQLITE_FATAL_EVENT, {
      detail: { scope: client.scope, reason },
    }));
  }
  const workspaceStillOpen = [...clients.values()].some(
    (candidate) => candidate.scope.workspaceId === client.scope.workspaceId,
  );
  if (!workspaceStillOpen && !workspaceOpenAttempts.has(client.scope.workspaceId)) {
    void releaseOwnershipLease(client.scope.workspaceId).catch((error) => {
      console.error("[PwaSQLite] Failed to release ownership after worker failure:", error);
    });
  }
}

async function createClient(scope: PwaSqliteScope): Promise<PwaSqliteWorkerClient> {
  workspaceOpenAttempts.set(
    scope.workspaceId,
    (workspaceOpenAttempts.get(scope.workspaceId) ?? 0) + 1,
  );
  let client: PwaSqliteWorkerClient | null = null;
  let failed = false;
  try {
    if (!isOpfsSupported()) {
      throw new PwaSqliteError("opfs-unavailable", "OPFS is unavailable.");
    }
    if (!isWebLocksSupported()) {
      throw new PwaSqliteError("web-locks-unavailable", "Web Locks are unavailable.");
    }
    await requirePersistentStorage();
    if (!(await acquirePwaDatabaseOwnership(scope.workspaceId))) {
      throw new PwaSqliteError(
        "workspace-owned",
        "This workspace is already open in another browser tab or PWA window.",
      );
    }

    client = new PwaSqliteWorkerClient(scope, handleFatalClient);
    await client.initialize();
    const { reconcilePwaWorkspaceBackupAssetRestore } = await import("./hybridBackupBundle");
    await reconcilePwaWorkspaceBackupAssetRestore(
      scope,
      client.recoveredPendingReplacement,
    );
    if (client.recoveredPendingReplacement) {
      await client.request("acknowledge-recovery");
    }
    await client.request("write-test");
    clients.set(scopeKey(scope), client);
    return client;
  } catch (error) {
    failed = true;
    await client?.close().catch(() => undefined);
    if (error instanceof PwaSqliteError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code: PwaSqliteReadinessFailure = /write test/i.test(message)
      ? "write-test-failed"
      : "initialization-failed";
    throw new PwaSqliteError(code, message, { cause: error });
  } finally {
    const attempts = (workspaceOpenAttempts.get(scope.workspaceId) ?? 1) - 1;
    if (attempts > 0) workspaceOpenAttempts.set(scope.workspaceId, attempts);
    else workspaceOpenAttempts.delete(scope.workspaceId);

    if (
      failed &&
      attempts === 0 &&
      ![...clients.values()].some((candidate) => candidate.scope.workspaceId === scope.workspaceId)
    ) {
      await releaseOwnershipLease(scope.workspaceId);
    }
  }
}

async function requireClient(scopeInput?: PwaSqliteScope): Promise<PwaSqliteWorkerClient> {
  const scope = normalizeScope(scopeInput);
  const key = scopeKey(scope);
  const current = clients.get(key);
  if (current) return current;

  let pending = clientPromises.get(key);
  if (!pending) {
    pending = createClient(scope).finally(() => {
      clientPromises.delete(key);
      pendingClientScopes.delete(key);
    });
    clientPromises.set(key, pending);
    pendingClientScopes.set(key, scope);
  }
  return pending;
}

export interface PwaSqliteDatabaseHandle {
  readonly scope: PwaSqliteScope;
  exec(query: string, bindValues?: unknown[]): Promise<Array<Record<string, unknown>>>;
  export(): Promise<Uint8Array>;
}

function handleFor(client: PwaSqliteWorkerClient): PwaSqliteDatabaseHandle {
  return {
    scope: client.scope,
    exec: (query, bindValues) =>
      client.enqueue(() => client.request("select", { query, bindValues })),
    export: () => client.enqueue(() => client.request("export")),
  };
}

export function getPwaDbInstance(scopeInput?: PwaSqliteScope): PwaSqliteDatabaseHandle | null {
  const scope = normalizeScope(scopeInput);
  const client = clients.get(scopeKey(scope));
  return client ? handleFor(client) : null;
}

export async function ensurePwaDatabase(
  scopeInput?: PwaSqliteScope,
): Promise<PwaSqliteDatabaseHandle | null> {
  try {
    return handleFor(await requireClient(scopeInput));
  } catch (error) {
    console.error("[PwaSQLite] Failed to initialize:", error);
    return null;
  }
}

export async function checkPwaSqliteReadiness(
  scopeInput?: PwaSqliteScope,
): Promise<PwaSqliteReadiness> {
  const scope = normalizeScope(scopeInput);
  try {
    const client = await requireClient(scope);
    await client.enqueue(() => client.request("write-test"));
    return { ready: true, scope };
  } catch (error) {
    const sqliteError = error instanceof PwaSqliteError
      ? error
      : new PwaSqliteError(
          "initialization-failed",
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
    return {
      ready: false,
      scope,
      reason: sqliteError.code,
      message: sqliteError.message,
    };
  }
}

function createConnectionForClient(
  client: PwaSqliteWorkerClient,
  bypassQueue: boolean,
): SqliteConnection {
  const run = <T>(task: () => Promise<T>) => bypassQueue ? task() : client.enqueue(task);
  const connection: SqliteConnection = {
    execute(query: string, bindValues?: unknown[]): Promise<unknown> {
      return run(() => client.request("execute", { query, bindValues }));
    },

    select<T>(query: string, bindValues?: unknown[]): Promise<T> {
      return run(() => client.request<T>("select", { query, bindValues }));
    },

    transaction<T>(task: (transactionConnection: SqliteConnection) => Promise<T>): Promise<T> {
      if (bypassQueue) return task(connection);
      return client.enqueue(async () => {
        await client.request("begin");
        const transactionConnection = createConnectionForClient(client, true);
        try {
          const result = await task(transactionConnection);
          await client.request("commit");
          return result;
        } catch (error) {
          await client.request("rollback").catch((rollbackError) => {
            console.error("[PwaSQLite] Rollback failed:", rollbackError);
          });
          throw error;
        }
      });
    },

    async close(): Promise<boolean> {
      try {
        await closePwaDatabase(client.scope);
        return true;
      } catch {
        return false;
      }
    },
  };
  return connection;
}

export function createPwaSqliteConnection(scopeInput?: PwaSqliteScope): SqliteConnection {
  const scope = normalizeScope(scopeInput);
  let clientPromise: Promise<PwaSqliteWorkerClient> | null = null;
  const getClient = () => clientPromise ??= requireClient(scope);

  const connection: SqliteConnection = {
    async execute(query: string, bindValues?: unknown[]): Promise<unknown> {
      const client = await getClient();
      return createConnectionForClient(client, false).execute(query, bindValues);
    },
    async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
      const client = await getClient();
      return createConnectionForClient(client, false).select<T>(query, bindValues);
    },
    async transaction<T>(task: (transactionConnection: SqliteConnection) => Promise<T>): Promise<T> {
      const client = await getClient();
      return createConnectionForClient(client, false).transaction!(task);
    },
    async close(): Promise<boolean> {
      try {
        await closePwaDatabase(scope);
        clientPromise = null;
        return true;
      } catch {
        return false;
      }
    },
  };
  return connection;
}

export async function exportPwaDatabase(
  scopeInput?: PwaSqliteScope,
  options: { openIfNeeded?: boolean } = {},
): Promise<Uint8Array | null> {
  const scope = normalizeScope(scopeInput);
  const existing = clients.get(scopeKey(scope));
  if (!existing && options.openIfNeeded === false) return null;
  const client = existing ?? await requireClient(scope);
  return client.enqueue(() => client.request("export"));
}

/** Validate a candidate backup without replacing the active database. */
export async function validateAtlasLocalDatabase(
  data: Uint8Array,
  scopeInput?: PwaSqliteScope,
  options: { requireScopedIdentity?: boolean } = {},
): Promise<void> {
  if (data.byteLength < 100) {
    throw new Error("The selected file is not a valid SQLite database.");
  }
  const client = await requireClient(scopeInput);
  await client.enqueue(() => client.request("validate", {
    data,
    requireScopedIdentity: options.requireScopedIdentity === true,
  }));
}

/** Replace the OPFS database while retaining this tab's exclusive lease. */
export async function replacePwaDatabaseFile(
  data: Uint8Array,
  scopeInput?: PwaSqliteScope,
  options: { requireScopedIdentity?: boolean } = {},
): Promise<void> {
  if (data.byteLength < 100) {
    throw new Error("The selected file is not a valid SQLite database.");
  }
  const client = await requireClient(scopeInput);
  await client.enqueue(() => client.request("replace", {
    data,
    requireScopedIdentity: options.requireScopedIdentity === true,
  }));
}

/** Begin a two-phase restore while retaining durable old bytes in the SAH pool. */
export async function beginPwaDatabaseReplacement(
  data: Uint8Array,
  scopeInput?: PwaSqliteScope,
  options: { requireScopedIdentity?: boolean } = {},
): Promise<void> {
  if (data.byteLength < 100) {
    throw new Error("The selected file is not a valid SQLite database.");
  }
  const client = await requireClient(scopeInput);
  await client.enqueue(() => client.request("replace", {
    data,
    requireScopedIdentity: options.requireScopedIdentity === true,
    retainRollback: true,
  }));
}

export async function finalizePwaDatabaseReplacement(
  scopeInput?: PwaSqliteScope,
): Promise<void> {
  const client = await requireClient(scopeInput);
  await client.enqueue(() => client.request("finalize-replace"));
}

export async function rollbackPwaDatabaseReplacement(
  scopeInput?: PwaSqliteScope,
  options: { retainRecoveryEvidence?: boolean } = {},
): Promise<void> {
  const client = await requireClient(scopeInput);
  await client.enqueue(() => client.request("rollback-replace", {
    retainRecoveryEvidence: options.retainRecoveryEvidence === true,
  }));
}

export interface PwaDatabaseReplacementSession {
  connection: SqliteConnection;
  finalize(): Promise<void>;
  rollback(options?: { retainRecoveryEvidence?: boolean }): Promise<void>;
}

/**
 * Hold the client's operation queue across every phase of a two-phase restore.
 * The supplied connection bypasses that queue only for restore-internal SQL.
 */
export async function runExclusivePwaDatabaseReplacement<T>(
  data: Uint8Array,
  scopeInput: PwaSqliteScope,
  options: { requireScopedIdentity?: boolean },
  task: (session: PwaDatabaseReplacementSession) => Promise<T>,
): Promise<T> {
  if (data.byteLength < 100) {
    throw new Error("The selected file is not a valid SQLite database.");
  }
  const client = await requireClient(scopeInput);
  return client.enqueue(async () => {
    await client.request("replace", {
      data,
      requireScopedIdentity: options.requireScopedIdentity === true,
      retainRollback: true,
    });
    const session: PwaDatabaseReplacementSession = {
      connection: createConnectionForClient(client, true),
      finalize: () => client.request("finalize-replace"),
      rollback: (rollbackOptions = {}) => client.request("rollback-replace", {
        retainRecoveryEvidence: rollbackOptions.retainRecoveryEvidence === true,
      }),
    };
    return task(session);
  });
}

export async function closePwaDatabase(scopeInput?: PwaSqliteScope): Promise<void> {
  const scope = normalizeScope(scopeInput);
  const key = scopeKey(scope);
  const pending = clientPromises.get(key);
  const client = clients.get(key) ?? (pending ? await pending.catch(() => null) : null);
  clients.delete(key);
  if (client) await client.close();

  const workspaceStillOpen = [...clients.values()].some(
    (candidate) => candidate.scope.workspaceId === scope.workspaceId,
  );
  if (!workspaceStillOpen) await releaseOwnershipLease(scope.workspaceId);
}

export async function releasePwaDatabaseOwnership(workspaceId: string): Promise<void> {
  const pendingForWorkspace = [...pendingClientScopes.entries()]
    .filter(([, scope]) => scope.workspaceId === workspaceId)
    .map(([key]) => clientPromises.get(key))
    .filter((promise): promise is Promise<PwaSqliteWorkerClient> => Boolean(promise));
  await Promise.allSettled(pendingForWorkspace);

  const matchingScopes = [...clients.values()]
    .filter((client) => client.scope.workspaceId === workspaceId)
    .map((client) => client.scope);
  for (const scope of matchingScopes) await closePwaDatabase(scope);
  await releaseOwnershipLease(workspaceId);
}

let desiredPwaWorkspaceAssetScope: PwaSqliteScope | null = null;
let boundPwaWorkspaceAssetScopeKey: string | null = null;
let pwaWorkspaceAssetScopeUpdateQueue: Promise<void> = Promise.resolve();
let pwaWorkspaceAssetControllerListenerInstalled = false;

function installPwaWorkspaceAssetControllerListener() {
  if (
    pwaWorkspaceAssetControllerListenerInstalled
    || typeof navigator === "undefined"
    || !("serviceWorker" in navigator)
  ) return;
  pwaWorkspaceAssetControllerListenerInstalled = true;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    boundPwaWorkspaceAssetScopeKey = null;
    pwaWorkspaceAssetScopeUpdateQueue = pwaWorkspaceAssetScopeUpdateQueue
      .catch(() => undefined)
      .then(() => postPwaWorkspaceAssetScope(desiredPwaWorkspaceAssetScope));
  });
}

async function postPwaWorkspaceAssetScope(scope: PwaSqliteScope | null): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return;

  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = globalThis.setTimeout(() => {
      channel.port1.close();
      reject(new Error("The workspace asset scope could not be registered."));
    }, 2_000);
    channel.port1.onmessage = () => {
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      if (navigator.serviceWorker.controller === worker) {
        boundPwaWorkspaceAssetScopeKey = scope ? scopeKey(scope) : null;
      }
      resolve();
    };
    worker.postMessage(scope
      ? {
          type: "SET_WORKSPACE_ASSET_SCOPE",
          workspaceId: scope.workspaceId,
          userId: scope.userId,
        }
      : { type: "CLEAR_WORKSPACE_ASSET_SCOPE" }, [channel.port2]);
  });
}

export async function bindPwaWorkspaceAssetScope(scope: PwaSqliteScope): Promise<void> {
  desiredPwaWorkspaceAssetScope = normalizeScope(scope);
  installPwaWorkspaceAssetControllerListener();
  pwaWorkspaceAssetScopeUpdateQueue = pwaWorkspaceAssetScopeUpdateQueue
    .catch(() => undefined)
    .then(() => postPwaWorkspaceAssetScope(desiredPwaWorkspaceAssetScope));
  await pwaWorkspaceAssetScopeUpdateQueue;
}

export async function clearPwaWorkspaceAssetScope(): Promise<void> {
  desiredPwaWorkspaceAssetScope = null;
  boundPwaWorkspaceAssetScopeKey = null;
  installPwaWorkspaceAssetControllerListener();
  pwaWorkspaceAssetScopeUpdateQueue = pwaWorkspaceAssetScopeUpdateQueue
    .catch(() => undefined)
    .then(() => postPwaWorkspaceAssetScope(null));
  await pwaWorkspaceAssetScopeUpdateQueue;
}

export function isPwaWorkspaceAssetScopeBound(scope: PwaSqliteScope): boolean {
  return boundPwaWorkspaceAssetScopeKey === scopeKey(normalizeScope(scope));
}

/** Close an uncertain browser database and force the workspace gate shut. */
export async function quarantinePwaDatabase(
  scopeInput: PwaSqliteScope,
  reason: unknown,
): Promise<void> {
  const scope = normalizeScope(scopeInput);
  let closeError: unknown;
  try {
    await closePwaDatabase(scope);
  } catch (error) {
    closeError = error;
  } finally {
    clients.delete(scopeKey(scope));
    await releaseOwnershipLease(scope.workspaceId).catch((error) => {
      closeError ??= error;
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PWA_SQLITE_FATAL_EVENT, {
        detail: { scope, reason },
      }));
    }
  }
  if (closeError) throw closeError;
}

function downloadBytes(data: Uint8Array, filename: string): void {
  const blob = new Blob([data], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export async function downloadPwaDatabase(scopeInput?: PwaSqliteScope): Promise<void> {
  const data = await exportPwaDatabase(scopeInput);
  if (data) downloadBytes(data, DB_FILENAME);
}

export async function exportPwaDatabaseAsBase64(
  scopeInput?: PwaSqliteScope,
): Promise<string | null> {
  const data = await exportPwaDatabase(scopeInput, { openIfNeeded: false });
  if (!data) return null;
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export const pwaSqliteInternals = {
  normalizeScope,
  poolDirectory,
  scopeKey,
};

export { DB_FILENAME };
