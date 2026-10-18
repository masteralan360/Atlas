import type { Database as SqlJsDatabase, SqlJsStatic } from "sql.js";
import type { SqliteConnection } from "./localModeSqlite";
export { isOpfsSupported } from "./pwaSqliteSupport";

const DB_FILENAME = "atlas-local-mode.db";

let sqlJsModule: SqlJsStatic | null = null;
let dbInstance: SqlJsDatabase | null = null;
let dbPromise: Promise<SqlJsDatabase | null> | null = null;
let transactionDepth = 0;
let transactionDirty = false;

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

async function loadFromOpfs(): Promise<Uint8Array | null> {
  try {
    const root = await getOpfsRoot();
    if (!root) return null;
    const handle = await root.getFileHandle(DB_FILENAME);
    const file = await handle.getFile();
    if (file.size === 0) return null;
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function saveToOpfs(data: Uint8Array): Promise<void> {
  const root = await getOpfsRoot();
  if (!root) {
    throw new Error("OPFS is unavailable; SQLite could not be persisted.");
  }
  const handle = await root.getFileHandle(DB_FILENAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function saveCurrentDatabase(): Promise<void> {
  if (!dbInstance) return;
  await saveToOpfs(dbInstance.export());
}

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsModule) {
    const { default: initSqlJs } = await import("sql.js");
    sqlJsModule = await initSqlJs({
      locateFile: () => `/sql-wasm.wasm`,
    });
  }
  return sqlJsModule;
}

export function getPwaDbInstance(): SqlJsDatabase | null {
  return dbInstance;
}

/** Reject ordinary SQLite files that are not Atlas Local Mode databases. */
export async function validateAtlasLocalDatabase(data: Uint8Array): Promise<void> {
  if (data.byteLength < 100) {
    throw new Error("The selected file is not a valid SQLite database.");
  }

  const SQL = await getSqlJs();
  let candidate: SqlJsDatabase | null = null;
  try {
    candidate = new SQL.Database(data);
    const integrityResult = candidate.exec("PRAGMA quick_check");
    if (integrityResult[0]?.values[0]?.[0] !== "ok") {
      throw new Error("The selected database failed its integrity check.");
    }

    const tableResult = candidate.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_entities' LIMIT 1",
    );
    if (!tableResult[0]?.values.length) {
      throw new Error("The selected SQLite file is not an Atlas Local Mode database.");
    }

    const columnsResult = candidate.exec("PRAGMA table_info(local_entities)");
    const nameColumn = columnsResult[0]?.columns.indexOf("name") ?? -1;
    const columnNames = new Set(
      nameColumn < 0 ? [] : columnsResult[0].values.map((row) => row[nameColumn]),
    );
    for (const requiredColumn of ["entity_type", "entity_id", "workspace_id", "payload"]) {
      if (!columnNames.has(requiredColumn)) {
        throw new Error("The selected SQLite file is not an Atlas Local Mode database.");
      }
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("The selected file is not a valid SQLite database.");
  } finally {
    candidate?.close();
  }
}

/** Replace the OPFS database after the active connection has been closed. */
export async function replacePwaDatabaseFile(data: Uint8Array): Promise<void> {
  await validateAtlasLocalDatabase(data);
  await saveToOpfs(data);
  dbInstance = null;
  dbPromise = null;
  transactionDepth = 0;
  transactionDirty = false;
}

export async function ensurePwaDatabase(): Promise<SqlJsDatabase | null> {
  if (dbInstance) return dbInstance;
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    try {
      const SQL = await getSqlJs();
      const existingData = await loadFromOpfs();

      if (existingData && existingData.length > 0) {
        dbInstance = new SQL.Database(existingData);
      } else {
        dbInstance = new SQL.Database();
      }

      dbInstance.run(
        `CREATE TABLE IF NOT EXISTS local_entities (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          workspace_id TEXT,
          payload TEXT NOT NULL,
          updated_at TEXT,
          PRIMARY KEY (entity_type, entity_id)
        )`,
      );
      dbInstance.run(
        `CREATE INDEX IF NOT EXISTS idx_local_entities_workspace
         ON local_entities (workspace_id)`,
      );
      dbInstance.run(
        `CREATE INDEX IF NOT EXISTS idx_local_entities_type_workspace
         ON local_entities (entity_type, workspace_id)`,
      );
      const tableInfo = dbInstance.exec("PRAGMA table_info(local_entities)");
      const nameIndex = tableInfo[0]?.columns.indexOf("name") ?? -1;
      const hasCurrentWorkspace = nameIndex >= 0 && tableInfo[0].values.some(
        (row) => row[nameIndex] === "current_workspace",
      );
      if (!hasCurrentWorkspace) {
        dbInstance.run(
          "ALTER TABLE local_entities ADD COLUMN current_workspace TEXT",
        );
      }
      dbInstance.run(`
        UPDATE local_entities
        SET current_workspace = workspace_id
        WHERE entity_type = 'profiles'
          AND current_workspace IS NULL
      `);
      dbInstance.run(
        `CREATE INDEX IF NOT EXISTS idx_local_entities_current_workspace
         ON local_entities (current_workspace)`,
      );

      const initialData = dbInstance.export();
      await saveToOpfs(initialData);

      return dbInstance;
    } catch (error) {
      dbPromise = null;
      console.error("[PwaSQLite] Failed to initialize:", error);
      return null;
    }
  })();

  return dbPromise;
}

export function createPwaSqliteConnection(): SqliteConnection {
  const connection: SqliteConnection = {
    async execute(query: string, bindValues?: unknown[]): Promise<unknown> {
      const db = await ensurePwaDatabase();
      if (!db) throw new Error("PWA SQLite not initialized");
      const snapshot = transactionDepth === 0 ? db.export() : null;

      try {
        if (bindValues && bindValues.length > 0) {
          db.run(query, bindValues as any[]);
        } else {
          db.run(query);
        }

        if (transactionDepth > 0) {
          transactionDirty = true;
        } else {
          await saveCurrentDatabase();
        }
      } catch (error) {
        if (snapshot) {
          db.close();
          const SQL = await getSqlJs();
          dbInstance = new SQL.Database(snapshot);
        }
        throw error;
      }
      return { rowsAffected: 0 };
    },

    async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
      const db = await ensurePwaDatabase();
      if (!db) throw new Error("PWA SQLite not initialized");

      const result = bindValues && bindValues.length > 0
        ? db.exec(query, bindValues as any[])
        : db.exec(query);

      if (!result || result.length === 0) {
        return [] as unknown as T;
      }

      const rows: Record<string, unknown>[] = [];
      for (const stmtResult of result) {
        const { columns, values } = stmtResult;
        for (const row of values) {
          const obj: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++) {
            obj[columns[i]] = row[i];
          }
          rows.push(obj);
        }
      }

      return rows as unknown as T;
    },

    async transaction<T>(
      task: (transactionConnection: SqliteConnection) => Promise<T>,
    ): Promise<T> {
      const db = await ensurePwaDatabase();
      if (!db) throw new Error("PWA SQLite not initialized");

      if (transactionDepth > 0) {
        return task(connection);
      }

      const snapshot = db.export();
      db.run("BEGIN IMMEDIATE");
      transactionDepth = 1;
      transactionDirty = false;
      try {
        const result = await task(connection);
        db.run("COMMIT");
        transactionDepth = 0;
        if (transactionDirty) {
          await saveCurrentDatabase();
        }
        transactionDirty = false;
        return result;
      } catch (error) {
        try {
          if (transactionDepth > 0) {
            db.run("ROLLBACK");
          }
        } catch {
          // A failed OPFS flush happens after COMMIT, so there is no active
          // transaction left to roll back. Restore the pre-transaction image.
        } finally {
          transactionDepth = 0;
          transactionDirty = false;
          db.close();
          const SQL = await getSqlJs();
          dbInstance = new SQL.Database(snapshot);
        }
        throw error;
      }
    },

    async close(): Promise<boolean> {
      try {
        if (dbInstance) {
          const data = dbInstance.export();
          await saveToOpfs(data);
          dbInstance.close();
          dbInstance = null;
          dbPromise = null;
          transactionDepth = 0;
          transactionDirty = false;
        }
        return true;
      } catch {
        return false;
      }
    },
  };

  return connection;
}

export async function downloadPwaDatabase(): Promise<void> {
  const db = getPwaDbInstance();
  if (!db) {
    const loaded = await ensurePwaDatabase();
    if (!loaded) return;
  }

  const data = dbInstance!.export();
  const blob = new Blob([data], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = DB_FILENAME;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function exportPwaDatabaseAsBase64(): Promise<string | null> {
  const db = getPwaDbInstance();
  if (!db) return null;
  const data = db.export();
  const binary = String.fromCharCode(...data);
  return btoa(binary);
}

export { DB_FILENAME };
