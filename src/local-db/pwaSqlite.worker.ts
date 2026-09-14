import sqlite3InitModule, {
  type Database,
  type SAHPoolUtil,
  type SqlValue,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";

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
  error?: { name: string; message: string };
}

interface WorkerSurface {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const workerSurface = globalThis as unknown as WorkerSurface;
let sqlite3: Sqlite3Static | null = null;
let pool: SAHPoolUtil | null = null;
let database: Database | null = null;
let filename = "";
let expectedWorkspaceId = "";
let expectedUserId = "";
const RESTORE_ROLLBACK_FILENAME = "/atlas-restore-rollback.db";

function requireDatabase(): Database {
  if (!database?.isOpen()) throw new Error("PWA SQLite is not initialized.");
  return database;
}

function requirePool(): SAHPoolUtil {
  if (!pool) throw new Error("The OPFS SAH pool is not initialized.");
  return pool;
}

function normalizeBindings(value: unknown): SqlValue[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((binding) => {
    if (
      binding === null ||
      typeof binding === "string" ||
      typeof binding === "number" ||
      typeof binding === "bigint" ||
      binding instanceof Uint8Array
    ) {
      return binding;
    }
    if (binding instanceof ArrayBuffer) return new Uint8Array(binding);
    if (typeof binding === "boolean") return binding ? 1 : 0;
    throw new TypeError(`Unsupported SQLite binding type: ${typeof binding}`);
  });
}

function execute(query: string, bindValues?: unknown): { rowsAffected: number } {
  const db = requireDatabase();
  const bind = normalizeBindings(bindValues);
  db.exec({ sql: query, ...(bind ? { bind } : {}) });
  return { rowsAffected: db.changes() };
}

function select(query: string, bindValues?: unknown): Array<Record<string, SqlValue>> {
  const bind = normalizeBindings(bindValues);
  return requireDatabase().exec({
    sql: query,
    ...(bind ? { bind } : {}),
    rowMode: "object",
    returnValue: "resultRows",
  });
}

function ensureSchema(): void {
  const db = requireDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_entities (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      workspace_id TEXT,
      payload TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_local_entities_workspace
      ON local_entities (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_local_entities_type_workspace
      ON local_entities (entity_type, workspace_id);
  `);

  const columns = select("PRAGMA table_info(local_entities)");
  if (!columns.some((row) => row.name === "current_workspace")) {
    db.exec("ALTER TABLE local_entities ADD COLUMN current_workspace TEXT");
  }
  db.exec(`
    UPDATE local_entities
    SET current_workspace = workspace_id
    WHERE entity_type = 'profiles'
      AND current_workspace IS NULL;
    CREATE INDEX IF NOT EXISTS idx_local_entities_current_workspace
      ON local_entities (current_workspace);
  `);

  if (expectedWorkspaceId && expectedUserId) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS atlas_database_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL
      )
    `);
    const identities = db.exec({
      sql: "SELECT workspace_id, user_id FROM atlas_database_identity WHERE singleton = 1",
      rowMode: "object",
      returnValue: "resultRows",
    }) as Array<Record<string, SqlValue>>;
    const identity = identities[0];
    if (identity) {
      if (
        identity.workspace_id !== expectedWorkspaceId ||
        identity.user_id !== expectedUserId
      ) {
        throw new Error("This SQLite database belongs to a different workspace or user.");
      }
    } else {
      db.exec({
        sql: `
          INSERT INTO atlas_database_identity (singleton, workspace_id, user_id)
          VALUES (1, ?, ?)
        `,
        bind: [expectedWorkspaceId, expectedUserId],
      });
    }
  }
}

async function readLegacyFile(legacyFilename: string): Promise<Uint8Array | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(legacyFilename);
    const file = await handle.getFile();
    if (file.size === 0) return null;
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function open(payload: Record<string, unknown>): Promise<{ recoveredPendingReplacement: boolean }> {
  if (database?.isOpen()) return { recoveredPendingReplacement: false };
  filename = String(payload.filename || "");
  const directory = String(payload.poolDirectory || "");
  expectedWorkspaceId = String(payload.workspaceId || "").trim();
  expectedUserId = String(payload.userId || "").trim();
  if (!filename.startsWith("/") || !directory || !expectedWorkspaceId || !expectedUserId) {
    throw new Error("Invalid PWA SQLite database identity.");
  }

  await navigator.storage.getDirectory();
  sqlite3 ??= await sqlite3InitModule();
  pool = await sqlite3.installOpfsSAHPoolVfs({
    directory,
    initialCapacity: 8,
  });

  if (
    payload.importLegacyFile === true &&
    !pool.getFileNames().includes(filename)
  ) {
    const legacyData = await readLegacyFile(String(payload.legacyFilename || ""));
    if (legacyData) await pool.importDb(filename, legacyData);
  }

  // A retained rollback file means the prior two-phase restore never reached
  // finalize (failure, tab termination, or crash). Recover before opening the
  // active file so the workspace never boots an uncommitted replacement.
  const recoveredPendingReplacement = pool.getFileNames().includes(RESTORE_ROLLBACK_FILENAME);
  if (recoveredPendingReplacement) {
    const rollbackData = await pool.exportFile(RESTORE_ROLLBACK_FILENAME);
    await pool.importDb(filename, rollbackData);
  }

  database = new pool.OpfsSAHPoolDb(filename);
  ensureSchema();
  assertQuickCheck(database);
  runWriteTest();
  return { recoveredPendingReplacement };
}

function assertQuickCheck(candidate: Database): void {
  const quickCheck = candidate.exec({
    sql: "PRAGMA quick_check",
    rowMode: 0,
    returnValue: "resultRows",
  });
  if (quickCheck[0] !== "ok") {
    throw new Error("The selected database failed its integrity check.");
  }
}

function assertAtlasSchemaAndIdentity(
  candidate: Database,
  requireScopedIdentity: boolean,
): void {
  const table = candidate.exec({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_entities' LIMIT 1",
    rowMode: 0,
    returnValue: "resultRows",
  });
  if (!table.length) {
    throw new Error("The selected SQLite file is not an Atlas Local Mode database.");
  }

  const columns = candidate.exec({
    sql: "PRAGMA table_info(local_entities)",
    rowMode: "$name",
    returnValue: "resultRows",
  });
  const names = new Set(columns);
  for (const required of ["entity_type", "entity_id", "workspace_id", "payload"]) {
    if (!names.has(required)) {
      throw new Error("The selected SQLite file is not an Atlas Local Mode database.");
    }
  }

  const identityTable = candidate.exec({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'atlas_database_identity' LIMIT 1",
    rowMode: 0,
    returnValue: "resultRows",
  });
  if (identityTable.length) {
    const identities = candidate.exec({
      sql: "SELECT workspace_id, user_id FROM atlas_database_identity WHERE singleton = 1",
      rowMode: "object",
      returnValue: "resultRows",
    }) as Array<Record<string, SqlValue>>;
    const identity = identities[0];
    if (
      !identity ||
      identity.workspace_id !== expectedWorkspaceId ||
      identity.user_id !== expectedUserId
    ) {
      throw new Error("This SQLite database belongs to a different workspace or user.");
    }
    return;
  }

  if (requireScopedIdentity) {
    throw new Error("The selected backup is missing its workspace database identity.");
  }

  // Compatibility for pre-identity raw SQLite exports: reject evidence of a
  // different workspace or user, while allowing an empty legacy database.
  const foreignWorkspace = candidate.exec({
    sql: `
      SELECT 1
      FROM local_entities
      WHERE (workspace_id IS NOT NULL AND workspace_id <> ?)
         OR (entity_type = 'workspaces' AND entity_id <> ?)
      LIMIT 1
    `,
    bind: [expectedWorkspaceId, expectedWorkspaceId],
    rowMode: 0,
    returnValue: "resultRows",
  });
  const foreignProfile = candidate.exec({
    sql: `
      SELECT 1
      FROM local_entities
      WHERE entity_type = 'profiles' AND entity_id <> ?
      LIMIT 1
    `,
    bind: [expectedUserId],
    rowMode: 0,
    returnValue: "resultRows",
  });
  if (foreignWorkspace.length || foreignProfile.length) {
    throw new Error("This SQLite database belongs to a different workspace or user.");
  }
}

function runWriteTest(): void {
  const db = requireDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE IF NOT EXISTS __atlas_storage_probe (
        probe INTEGER NOT NULL
      );
      DELETE FROM __atlas_storage_probe;
      INSERT INTO __atlas_storage_probe (probe) VALUES (1);
    `);
    const result = select("SELECT probe FROM __atlas_storage_probe LIMIT 1");
    if (result[0]?.probe !== 1) throw new Error("SQLite write test returned invalid data.");
    db.exec("ROLLBACK");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failed operation may already have ended the transaction.
    }
    const failure = new Error("SQLite transactional write test failed.");
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
}

async function validateDatabaseFile(
  data: Uint8Array,
  requireScopedIdentity = false,
): Promise<void> {
  const currentPool = requirePool();
  const temporaryFilename = `/atlas-validation-${crypto.randomUUID()}.db`;
  let candidate: Database | null = null;
  try {
    await currentPool.importDb(temporaryFilename, data);
    candidate = new currentPool.OpfsSAHPoolDb(temporaryFilename);
    assertQuickCheck(candidate);
    assertAtlasSchemaAndIdentity(candidate, requireScopedIdentity);
  } finally {
    candidate?.close();
    try {
      currentPool.unlink(temporaryFilename);
    } catch {
      // Import can fail before the temporary file exists.
    }
  }
}

async function replaceDatabase(
  data: Uint8Array,
  requireScopedIdentity = false,
  retainRollback = false,
): Promise<void> {
  const currentPool = requirePool();
  await validateDatabaseFile(data, requireScopedIdentity);
  if (currentPool.getFileNames().includes(RESTORE_ROLLBACK_FILENAME)) {
    throw new Error("A previous browser database restore still requires recovery.");
  }
  assertQuickCheck(requireDatabase());
  assertAtlasSchemaAndIdentity(requireDatabase(), true);
  const rollbackData = (await currentPool.exportFile(filename)).slice();
  await currentPool.importDb(RESTORE_ROLLBACK_FILENAME, rollbackData);
  let rollbackCandidate: Database | null = null;
  let rollbackValidationError: unknown;
  try {
    rollbackCandidate = new currentPool.OpfsSAHPoolDb(RESTORE_ROLLBACK_FILENAME);
    assertQuickCheck(rollbackCandidate);
    assertAtlasSchemaAndIdentity(rollbackCandidate, true);
  } catch (error) {
    rollbackValidationError = error;
  } finally {
    rollbackCandidate?.close();
  }
  if (rollbackValidationError) {
    try {
      currentPool.unlink(RESTORE_ROLLBACK_FILENAME);
    } catch {
      // Preserve the original validation failure.
    }
    throw rollbackValidationError;
  }
  database?.close();
  database = null;
  try {
    await currentPool.importDb(filename, data);
    database = new currentPool.OpfsSAHPoolDb(filename);
    ensureSchema();
    assertQuickCheck(database);
    assertAtlasSchemaAndIdentity(database, true);
    runWriteTest();
    if (!retainRollback) currentPool.unlink(RESTORE_ROLLBACK_FILENAME);
  } catch (error) {
    let rollbackError: unknown;
    try {
      database?.close();
      database = null;
      await currentPool.importDb(filename, rollbackData);
      database = new currentPool.OpfsSAHPoolDb(filename);
      ensureSchema();
      assertQuickCheck(database);
      runWriteTest();
      currentPool.unlink(RESTORE_ROLLBACK_FILENAME);
    } catch (caughtRollbackError) {
      rollbackError = caughtRollbackError;
    }
    if (rollbackError) {
      const recoveryError = new Error(
        "The database restore failed and the previous browser database could not be reopened.",
      );
      (recoveryError as Error & { cause?: unknown }).cause = {
        primaryError: error,
        rollbackError,
      };
      throw recoveryError;
    }
    throw error;
  }
}

async function rollbackPendingDatabaseReplacement(retainRecoveryEvidence = false): Promise<void> {
  const currentPool = requirePool();
  if (!currentPool.getFileNames().includes(RESTORE_ROLLBACK_FILENAME)) {
    throw new Error("The browser database rollback copy is unavailable.");
  }
  const rollbackData = await currentPool.exportFile(RESTORE_ROLLBACK_FILENAME);
  database?.close();
  database = null;
  await currentPool.importDb(filename, rollbackData);
  database = new currentPool.OpfsSAHPoolDb(filename);
  ensureSchema();
  assertQuickCheck(database);
  assertAtlasSchemaAndIdentity(database, true);
  runWriteTest();
  if (!retainRecoveryEvidence) currentPool.unlink(RESTORE_ROLLBACK_FILENAME);
}

function finalizePendingDatabaseReplacement(): void {
  const currentPool = requirePool();
  if (currentPool.getFileNames().includes(RESTORE_ROLLBACK_FILENAME)) {
    currentPool.unlink(RESTORE_ROLLBACK_FILENAME);
  }
}

function acknowledgeRecoveredDatabaseReplacement(): void {
  const currentPool = requirePool();
  if (currentPool.getFileNames().includes(RESTORE_ROLLBACK_FILENAME)) {
    currentPool.unlink(RESTORE_ROLLBACK_FILENAME);
  }
}

async function close(): Promise<void> {
  database?.close();
  database = null;
  pool?.pauseVfs();
  pool = null;
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  const payload = request.payload ?? {};
  switch (request.operation) {
    case "open":
      return open(payload);
    case "execute":
      return execute(String(payload.query ?? ""), payload.bindValues);
    case "select":
      return select(String(payload.query ?? ""), payload.bindValues);
    case "begin":
      return execute("BEGIN IMMEDIATE");
    case "commit":
      return execute("COMMIT");
    case "rollback":
      return execute("ROLLBACK");
    case "write-test":
      return runWriteTest();
    case "export":
      return requirePool().exportFile(filename);
    case "validate":
      return validateDatabaseFile(
        payload.data as Uint8Array,
        payload.requireScopedIdentity === true,
      );
    case "replace":
      return replaceDatabase(
        payload.data as Uint8Array,
        payload.requireScopedIdentity === true,
        payload.retainRollback === true,
      );
    case "finalize-replace":
      return finalizePendingDatabaseReplacement();
    case "rollback-replace":
      return rollbackPendingDatabaseReplacement(payload.retainRecoveryEvidence === true);
    case "acknowledge-recovery":
      return acknowledgeRecoveredDatabaseReplacement();
    case "close":
      return close();
  }
}

workerSurface.onmessage = (event) => {
  const request = event.data;
  void dispatch(request).then(
    (result) => {
      const response: WorkerResponse = { id: request.id, ok: true, result };
      if (result instanceof Uint8Array) {
        workerSurface.postMessage(response, [result.buffer]);
      } else {
        workerSurface.postMessage(response);
      }
    },
    (error: unknown) => {
      workerSurface.postMessage({
        id: request.id,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    },
  );
};
