import type Dexie from "dexie";

import i18n from "@/i18n/config";
import { getActiveBusinessUserId, getActiveBusinessWorkspaceId, isOnline } from "@/lib/network";
import { isTauri } from "@/lib/platform";
import { shouldMirrorToSqlite, isStrictLocalWorkspaceMode } from "@/workspace/workspaceMode";
import { recordWorkspaceDataFetch } from "@/workspace/workspaceDataFreshness";
import { isAllowedInventoryQuantityTransition } from "./inventoryDeficit";
import { normalizeProductSku } from "./productSku";
import { closePwaDatabase, createPwaSqliteConnection, DEFAULT_PWA_SQLITE_SCOPE, exportPwaDatabase, isOpfsSupported, quarantinePwaDatabase, runExclusivePwaDatabaseReplacement, validateAtlasLocalDatabase, type PwaSqliteScope } from "./pwaSqlite";
import type { OfflineMutationEntityType } from "./models";

const LEGACY_LOCAL_MODE_SQLITE_FILENAME = "atlas-local-mode.db";
const SQLITE_SCOPE_CATALOG_KEY = "atlas_sqlite_scopes:v1";
const DEXIE_COMPATIBILITY_MIGRATION_KEY = "dexie_compatibility_migrated:v1";

export interface LocalModeSqliteScope {
  workspaceId: string;
  userId: string;
}

function normalizeScopePart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function getLocalModeSqliteFilename(scope?: LocalModeSqliteScope | null) {
  if (!scope) return LEGACY_LOCAL_MODE_SQLITE_FILENAME;
  return `atlas-${normalizeScopePart(scope.workspaceId)}-${normalizeScopePart(scope.userId)}.db`;
}

function getLocalModeSqlitePath(scope?: LocalModeSqliteScope | null) {
  return `sqlite:${getLocalModeSqliteFilename(scope)}`;
}

function scopeKey(scope?: LocalModeSqliteScope | null) {
  return scope ? `${scope.workspaceId}:${scope.userId}` : "legacy";
}

function resolveSqliteScope(scope?: LocalModeSqliteScope | null) {
  // `null` is reserved for the one-time legacy database. Omitting the argument
  // resolves the currently authenticated workspace/user pair.
  if (scope === null) return null;
  if (scope?.workspaceId && scope.userId) return scope;
  const workspaceId = getActiveBusinessWorkspaceId();
  const userId = getActiveBusinessUserId();
  return workspaceId && userId ? { workspaceId, userId } : null;
}

function readRememberedSqliteScopes(userId?: string | null) {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SQLITE_SCOPE_CATALOG_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LocalModeSqliteScope => (
      !!item && typeof item === "object" &&
      typeof (item as LocalModeSqliteScope).workspaceId === "string" &&
      typeof (item as LocalModeSqliteScope).userId === "string" &&
      (!userId || (item as LocalModeSqliteScope).userId === userId)
    ));
  } catch {
    return [];
  }
}

function rememberSqliteScope(scope: LocalModeSqliteScope | null) {
  if (!scope || typeof localStorage === "undefined") return;
  try {
    const parsed = JSON.parse(localStorage.getItem(SQLITE_SCOPE_CATALOG_KEY) ?? "[]") as unknown;
    const scopes = Array.isArray(parsed)
      ? parsed.filter((item): item is LocalModeSqliteScope => (
        !!item && typeof item === "object" &&
        typeof (item as LocalModeSqliteScope).workspaceId === "string" &&
        typeof (item as LocalModeSqliteScope).userId === "string"
      ))
      : [];
    const next = [scope, ...scopes.filter((item) => scopeKey(item) !== scopeKey(scope))].slice(0, 100);
    localStorage.setItem(SQLITE_SCOPE_CATALOG_KEY, JSON.stringify(next));
  } catch {
    // Scope discovery is a recovery convenience; opening the database remains authoritative.
  }
}

export const LOCAL_MODE_SQLITE_TABLES = [
  "products",
  "product_barcodes",
  "price_books",
  "price_book_items",
  "categories",
  "units",
  "invoices",
  "invoice_versions",
  "users",
  "sales",
  "sales_exchange",
  "sale_items",
  "sale_returns",
  "sale_return_items",
  "sale_product_exchanges",
  "order_returns",
  "order_return_items",
  "workspaces",
  "storages",
  "inventory",
  "inventory_transactions",
  "stock_batches",
  "product_discounts",
  "category_discounts",
  "inventory_transfer_transactions",
  "reorder_transfer_rules",
  "suppliers",
  "customers",
  "agents",
  "agent_excluded_categories",
  "agent_commission_plans",
  "agent_commission_memberships",
  "product_commission_rules",
  "product_commission_rule_agents",
  "sales_order_agent_assignments",
  "agent_commission_entries",
  "agent_product_commission_entries",
  "fleet_vehicles",
  "fleet_vehicle_assignments",
  "rental_vehicles",
  "rental_requests",
  "rental_contracts",
  "delivery_merchant_profiles",
  "delivery_shipments",
  "delivery_shipment_events",
  "delivery_shipment_cod_adjustment_requests",
  "delivery_shipment_cod_corrections",
  "delivery_shipment_recipient_payout_corrections",
  "delivery_shipment_recipient_payout_adjustment_requests",
  "delivery_runs",
  "delivery_run_items",
  "delivery_settlements",
  "delivery_ledger_entries",
  "business_partners",
  "employees",
  "budget_settings",
  "budget_allocations",
  "expense_categories",
  "expense_series",
  "expense_items",
  "payroll_statuses",
  "dividend_statuses",
  "workspace_contacts",
  "restaurant_table_settings",
  "restaurant_pos_tickets",
  "loans",
  "loan_installments",
  "loan_payments",
  "installment_sales",
  "installment_sale_installments",
  "installment_sale_payments",
  "payment_transactions",
  "financial_transaction_voids",
  "payment_accounts",
  "capital_pools",
  "payment_account_balances",
  "payment_account_movements",
  "cashier_shifts",
  "cashier_shift_currency_counts",
  "cashier_shift_templates",
  "cashier_shift_assignments",
  "cashier_shift_occurrences",
  "sales_orders",
  "purchase_orders",
  "order_installments",
  "real_estate_transactions",
  "real_estate_installments",
  "real_estate_payments",
  "travel_bookings",
  "travel_passengers",
  "activity_catalog",
  "activity_transactions",
  "activity_transaction_lines",
  "exchange_pair_prices",
  "exchange_transactions",
  "exchange_fee_rules",
  "fx_safes",
  "fx_safe_balances",
  "fx_safe_movements",
  "profiles",
  "local_account_credentials",
  "workspace_permissions",
  "manual_entry_templates",
  "manual_entries",
  "clinical_appointments",
  "clinical_patients",
  "clinical_attachments",
  "clinical_presets",
] as const;

export type LocalModeSqliteTableName =
  (typeof LOCAL_MODE_SQLITE_TABLES)[number];

const LEGACY_HYBRID_MIRROR_SEED_TABLES = [
  "activity_catalog",
  "activity_transactions",
  "activity_transaction_lines",
] as const satisfies readonly LocalModeSqliteTableName[];

export interface SqliteConnection {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  transaction?<T>(
    task: (connection: SqliteConnection) => Promise<T>,
  ): Promise<T>;
  close?(database?: string): Promise<boolean>;
}

export type NativeSqliteReadiness =
  | { ready: true; scope: LocalModeSqliteScope }
  | {
      ready: false;
      scope: LocalModeSqliteScope;
      reason: "sqlite-unavailable" | "integrity-check-failed" | "write-test-failed";
      message: string;
    };

export type LocalModeSqliteMutation =
  | {
      type: "upsert";
      tableName: LocalModeSqliteTableName;
      row: Record<string, unknown>;
      workspaceId?: string | null;
    }
  | {
      type: "delete";
      tableName: LocalModeSqliteTableName;
      row: Record<string, unknown>;
      workspaceId?: string | null;
    };

interface StoredEntityRow {
  entity_type: string;
  entity_id: string;
  workspace_id: string | null;
  current_workspace: string | null;
  payload: string;
  updated_at: string | null;
}

function firstTimestamp(...candidates: unknown[]): string | undefined {
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
}

/**
 * Local-mode SQLite stores entity payloads as JSON rather than a per-table
 * schema.  Normalize legacy sale line payloads without assigning the upgrade
 * time, so an old sale keeps the audit time of its parent sale.
 */
function normalizeLegacySaleItemTimestamps(
  item: Record<string, unknown>,
  parentSaleCreatedAt: string | undefined,
  persistedUpdatedAt: string | null,
) {
  const createdAt = firstTimestamp(
    item.createdAt,
    item.created_at,
    parentSaleCreatedAt,
    persistedUpdatedAt,
  );
  if (!createdAt) {
    return false;
  }

  const updatedAt = firstTimestamp(
    item.updatedAt,
    item.updated_at,
    item.returnedAt,
    item.returned_at,
    createdAt,
  );
  if (!updatedAt) {
    return false;
  }

  const changed = item.createdAt !== createdAt || item.updatedAt !== updatedAt;
  if (changed) {
    item.createdAt = createdAt;
    item.updatedAt = updatedAt;
  }
  return changed;
}

/**
 * SQLite keeps JSON payloads from older desktop releases. Promote the former
 * `name` value only while hydrating an old partner record, leaving `name` and
 * `contactName` untouched as historical metadata. Retired email and country
 * fields are removed before the row reaches Dexie.
 */
function normalizeLegacyPartnerPayload(
  tableName: string,
  payload: Record<string, unknown>,
) {
  if (
    tableName !== "business_partners"
    && tableName !== "customers"
    && tableName !== "suppliers"
  ) {
    return false;
  }

  const existingPartnerName = typeof payload.partnerName === "string"
    ? payload.partnerName.trim()
    : "";
  const legacyName = typeof payload.name === "string" ? payload.name.trim() : "";
  const partnerName = existingPartnerName || legacyName || "Unnamed partner";
  const changed = payload.partnerName !== partnerName || "email" in payload || "country" in payload;

  payload.partnerName = partnerName;
  delete payload.email;
  delete payload.country;
  return changed;
}

const hydratedWorkspaces = new Set<string>();
const hydrationTasks = new Map<string, Promise<void>>();

function hydrationKey(workspaceId: string, userId?: string | null) {
  return `${workspaceId}:${userId ?? getActiveBusinessUserId() ?? "legacy"}`;
}

function markLocalWorkspaceFetched(workspaceId: string, userId?: string | null) {
  hydratedWorkspaces.add(hydrationKey(workspaceId, userId));
  recordWorkspaceDataFetch(workspaceId, "local");
}

let sqlitePromise: Promise<SqliteConnection | null> | null = null;
let sqliteWriteQueue: Promise<void> = Promise.resolve();
let activeSqliteScope: LocalModeSqliteScope | null = null;
let mirroringPauseDepth = 0;
let testConnectionOverride: SqliteConnection | undefined;

async function ensureCurrentWorkspaceColumn(connection: SqliteConnection) {
  const columns = await connection.select<Array<{ name: string }>>(
    "PRAGMA table_info(local_entities)",
  );
  if (!columns.some((column) => column.name === "current_workspace")) {
    await connection.execute(
      "ALTER TABLE local_entities ADD COLUMN current_workspace TEXT",
    );
  }
  await connection.execute(`
    UPDATE local_entities
    SET current_workspace = workspace_id
    WHERE entity_type = 'profiles'
      AND current_workspace IS NULL
  `);
  await connection.execute(`
    CREATE INDEX IF NOT EXISTS idx_local_entities_current_workspace
    ON local_entities (current_workspace)
  `);
}

async function ensureDatabaseIdentity(
  connection: SqliteConnection,
  scope: LocalModeSqliteScope | null,
) {
  if (!scope) return;
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS atlas_database_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL
    )
  `);
  const identities = await connection.select<Array<{
    workspace_id: string;
    user_id: string;
  }>>(
    "SELECT workspace_id, user_id FROM atlas_database_identity WHERE singleton = 1",
  );
  const identity = identities[0];
  if (identity) {
    if (
      identity.workspace_id !== scope.workspaceId ||
      identity.user_id !== scope.userId
    ) {
      throw new Error("This SQLite database belongs to a different workspace or user.");
    }
    return;
  }
  await connection.execute(
    `
      INSERT INTO atlas_database_identity (singleton, workspace_id, user_id)
      VALUES (1, $1, $2)
    `,
    [scope.workspaceId, scope.userId],
  );
}

async function ensureLocalMetadata(connection: SqliteConnection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS atlas_local_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

async function hasCompletedDexieCompatibilityMigration(
  connection: SqliteConnection,
) {
  await ensureLocalMetadata(connection);
  const rows = await connection.select<Array<{ value: string }>>(
    "SELECT value FROM atlas_local_metadata WHERE key = $1 LIMIT 1",
    [DEXIE_COMPATIBILITY_MIGRATION_KEY],
  );
  return rows[0]?.value === "complete";
}

async function markDexieCompatibilityMigrationComplete(
  connection: SqliteConnection,
) {
  await ensureLocalMetadata(connection);
  await connection.execute(
    `
      INSERT INTO atlas_local_metadata (key, value, updated_at)
      VALUES ($1, 'complete', $2)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
    [DEXIE_COMPATIBILITY_MIGRATION_KEY, new Date().toISOString()],
  );
}

async function ensureInventoryDeficitTriggers(connection: SqliteConnection) {
  const localWorkspacePredicate = `EXISTS (
    SELECT 1
    FROM local_entities AS workspace
    WHERE workspace.entity_type = 'workspaces'
      AND workspace.entity_id = NEW.workspace_id
      AND COALESCE(
        json_extract(workspace.payload, '$.dataMode'),
        json_extract(workspace.payload, '$.data_mode')
      ) = 'local'
  )`;
  const invalidNewQuantityPredicate = `(
    COALESCE(json_type(NEW.payload, '$.quantity'), 'missing') NOT IN ('integer', 'real')
    OR CAST(json_extract(NEW.payload, '$.quantity') AS REAL) < 0
  )`;

  await connection.execute(`
    CREATE TRIGGER IF NOT EXISTS local_inventory_prevent_deficit_insert
    BEFORE INSERT ON local_entities
    WHEN NEW.entity_type IN ('inventory', 'products')
      AND ${localWorkspacePredicate}
      AND ${invalidNewQuantityPredicate}
    BEGIN
      SELECT RAISE(ABORT, 'inventory_quantity_deficit');
    END
  `);

  await connection.execute(`
    CREATE TRIGGER IF NOT EXISTS local_inventory_prevent_deficit_update
    BEFORE UPDATE OF payload, workspace_id ON local_entities
    WHEN NEW.entity_type IN ('inventory', 'products')
      AND ${localWorkspacePredicate}
      AND (
        COALESCE(json_type(NEW.payload, '$.quantity'), 'missing') NOT IN ('integer', 'real')
        OR (
          COALESCE(json_type(OLD.payload, '$.quantity'), 'missing') NOT IN ('integer', 'real')
          AND CAST(json_extract(NEW.payload, '$.quantity') AS REAL) < 0
        )
        OR (
          CAST(json_extract(OLD.payload, '$.quantity') AS REAL) >= 0
          AND CAST(json_extract(NEW.payload, '$.quantity') AS REAL) < 0
        )
        OR (
          CAST(json_extract(OLD.payload, '$.quantity') AS REAL) < 0
          AND CAST(json_extract(NEW.payload, '$.quantity') AS REAL)
            < CAST(json_extract(OLD.payload, '$.quantity') AS REAL)
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'inventory_quantity_deficit');
    END
  `);
}

async function purgeRetiredModuleEntities(connection: SqliteConnection) {
  const rows = await connection.select<StoredEntityRow[]>(`
    SELECT entity_type, entity_id, workspace_id, current_workspace, payload, updated_at
    FROM local_entities
    WHERE entity_type IN (
      'workspaces',
      'workspace_permissions',
      'payment_transactions',
      'payment_account_movements',
      'payment_account_balances'
    )
  `);
  const timestamp = new Date().toISOString();
  const parsePayload = (row: StoredEntityRow) => {
    try {
      const parsed = JSON.parse(row.payload);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };
  const updatePayload = async (row: StoredEntityRow, payload: Record<string, unknown>) => {
    await connection.execute(
      `
        UPDATE local_entities
        SET payload = $1, updated_at = $2
        WHERE entity_type = $3 AND entity_id = $4
      `,
      [JSON.stringify(payload), timestamp, row.entity_type, row.entity_id],
    );
  };

  const workspaceRows = rows.filter((row) => row.entity_type === 'workspaces');
  for (const row of workspaceRows) {
    const payload = parsePayload(row);
    if (!payload || !('travel_agency' in payload)) continue;
    const { travel_agency: _retiredModuleFlag, ...updatedPayload } = payload;
    await updatePayload(row, updatedPayload);
  }

  const permissionRows = rows.filter((row) => row.entity_type === 'workspace_permissions');
  for (const row of permissionRows) {
    const payload = parsePayload(row);
    if (!payload || (
      payload.module !== 'travelAgency'
      && (typeof payload.key !== 'string' || !payload.key.startsWith('travelAgency.'))
    )) {
      continue;
    }
    await connection.execute(
      'DELETE FROM local_entities WHERE entity_type = $1 AND entity_id = $2',
      [row.entity_type, row.entity_id],
    );
  }

  const paymentRows = rows.filter((row) => row.entity_type === 'payment_transactions');
  const retiredPaymentIds = new Set(
    paymentRows.flatMap((row) => {
      const payload = parsePayload(row);
      return payload?.sourceModule === 'travel_agency'
        || payload?.sourceType === 'travel_agency_sale'
        || payload?.source_module === 'travel_agency'
        || payload?.source_type === 'travel_agency_sale'
        ? [row.entity_id]
        : [];
    }),
  );

  const movementRows = rows.filter((row) => row.entity_type === 'payment_account_movements');
  const retiredMovements = movementRows.flatMap((row) => {
    const payload = parsePayload(row);
    return payload && typeof payload.paymentTransactionId === 'string' && retiredPaymentIds.has(payload.paymentTransactionId)
      ? [{ row, payload }]
      : [];
  });
  const balanceDeltas = new Map<string, number>();
  for (const { payload } of retiredMovements) {
    if (payload.isDeleted) continue;
    if (typeof payload.workspaceId !== 'string' || typeof payload.accountId !== 'string' || typeof payload.currency !== 'string') {
      continue;
    }
    const delta = Number(payload.deltaAmount);
    if (!Number.isFinite(delta)) continue;
    const key = `${payload.workspaceId}:${payload.accountId}:${payload.currency}`;
    balanceDeltas.set(key, (balanceDeltas.get(key) ?? 0) + delta);
  }

  const balanceRows = rows.filter((row) => row.entity_type === 'payment_account_balances');
  for (const row of balanceRows) {
    const payload = parsePayload(row);
    if (!payload || typeof payload.workspaceId !== 'string' || typeof payload.accountId !== 'string' || typeof payload.currency !== 'string') {
      continue;
    }
    const delta = balanceDeltas.get(`${payload.workspaceId}:${payload.accountId}:${payload.currency}`);
    if (!delta) continue;
    const amount = Number(payload.balanceAmount);
    await updatePayload(row, {
      ...payload,
      balanceAmount: (Number.isFinite(amount) ? amount : 0) - delta,
      updatedAt: timestamp,
      version: (Number(payload.version) || 0) + 1,
    });
  }

  for (const { row } of retiredMovements) {
    await connection.execute(
      'DELETE FROM local_entities WHERE entity_type = $1 AND entity_id = $2',
      [row.entity_type, row.entity_id],
    );
  }
  for (const paymentId of retiredPaymentIds) {
    await connection.execute(
      'DELETE FROM local_entities WHERE entity_type = $1 AND entity_id = $2',
      ['payment_transactions', paymentId],
    );
  }
  await connection.execute(
    'DELETE FROM local_entities WHERE entity_type = $1',
    ['travel_agency_sales'],
  );
}

async function purgeRetiredRecipientPayoutSettlementObligations(connection: SqliteConnection) {
  await connection.execute(
    'DELETE FROM local_entities WHERE entity_type = $1',
    ['delivery_shipment_settlement_obligations'],
  );
}

async function ensureCashierShiftActiveClaimsTable(
  connection: SqliteConnection,
) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS cashier_shift_active_claims (
      workspace_id TEXT NOT NULL,
      cashier_user_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, cashier_user_id)
    )
  `);
}

function isSupported() {
  return (
    testConnectionOverride !== undefined ||
    typeof window !== "undefined" &&
    (isTauri() || isOpfsSupported())
  );
}

export function setLocalModeSqliteConnectionForTests(
  connection?: SqliteConnection,
) {
  if (import.meta.env.MODE !== "test") {
    throw new Error("The SQLite test connection can only be set in tests.");
  }
  testConnectionOverride = connection;
  sqlitePromise = connection ? Promise.resolve(connection) : null;
  sqliteWriteQueue = Promise.resolve();
  activeSqliteScope = null;
}

function isSqliteMirrorEnabled(workspaceId?: string | null) {
  return shouldMirrorToSqlite(workspaceId);
}

function isMirroredTableName(
  tableName: string,
): tableName is LocalModeSqliteTableName {
  return (LOCAL_MODE_SQLITE_TABLES as readonly string[]).includes(tableName);
}

function isBlobMarker(
  value: unknown,
): value is { __atlasType: "blob"; mimeType: string; data: string } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { __atlasType?: string }).__atlasType === "blob" &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

async function serializeValue(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    return {
      __atlasType: "blob" as const,
      mimeType: value.type,
      data: arrayBufferToBase64(await value.arrayBuffer()),
    };
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => serializeValue(item)));
  }

  if (isPlainObject(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, nested]) => [key, await serializeValue(nested)] as const,
      ),
    );

    return Object.fromEntries(entries);
  }

  return value;
}

function deserializeValue(value: unknown): unknown {
  if (isBlobMarker(value)) {
    return base64ToBlob(value.data, value.mimeType);
  }

  if (Array.isArray(value)) {
    return value.map((item) => deserializeValue(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        deserializeValue(nested),
      ]),
    );
  }

  return value;
}

async function ensureConnection(requestedScope?: LocalModeSqliteScope | null) {
  if (testConnectionOverride) {
    return testConnectionOverride;
  }
  if (!isSupported()) {
    return null;
  }

  const desiredScope = resolveSqliteScope(requestedScope);
  if (requestedScope !== null && !desiredScope) {
    throw new Error(
      "SQLite access requires an explicit workspace and authenticated user scope.",
    );
  }
  if (sqlitePromise && scopeKey(desiredScope) !== scopeKey(activeSqliteScope)) {
    await resetSqliteConnection();
  }
  activeSqliteScope = desiredScope;
  rememberSqliteScope(desiredScope);

  if (!sqlitePromise) {
    sqlitePromise = (async () => {
      let connection: SqliteConnection;
      if (isTauri()) {
        const { default: Database } = await import("@tauri-apps/plugin-sql");
        connection = (await Database.load(
          getLocalModeSqlitePath(desiredScope),
        )) as SqliteConnection;

        await connection.execute("PRAGMA busy_timeout = 5000");
        await connection.execute("PRAGMA journal_mode = WAL");
        await connection.execute(`
                CREATE TABLE IF NOT EXISTS local_entities (
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    workspace_id TEXT,
                    payload TEXT NOT NULL,
                    updated_at TEXT,
                    PRIMARY KEY (entity_type, entity_id)
                )
            `);
        await connection.execute(`
                CREATE INDEX IF NOT EXISTS idx_local_entities_workspace
                ON local_entities (workspace_id)
            `);
        await connection.execute(`
                CREATE INDEX IF NOT EXISTS idx_local_entities_type_workspace
                ON local_entities (entity_type, workspace_id)
            `);
        await ensureCurrentWorkspaceColumn(connection);
        await ensureDatabaseIdentity(connection, desiredScope);
      } else {
        connection = createPwaSqliteConnection(desiredScope as PwaSqliteScope | undefined);
      }

      await ensureLocalMetadata(connection);
      await ensureInventoryDeficitTriggers(connection);
      await ensureCashierShiftActiveClaimsTable(connection);
      await purgeRetiredModuleEntities(connection);
      await purgeRetiredRecipientPayoutSettlementObligations(connection);
      return connection;
    })().catch((error) => {
      sqlitePromise = null;
      console.error(
        "[LocalModeSQLite] Failed to initialize SQLite connection:",
        error,
      );
      if (isSqliteLockedError(error)) {
        throw error;
      }
      return null;
    });
  }

  return sqlitePromise;
}

export async function getLocalModeSqliteConnection(scope?: LocalModeSqliteScope | null) {
  return ensureConnection(scope);
}

function isSqliteLockedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|code:\s*5/i.test(message);
}

async function resetSqliteConnection() {
  const currentConnection = sqlitePromise;
  const closingScope = activeSqliteScope;
  sqlitePromise = null;
  activeSqliteScope = null;
  let closed = false;

  try {
    const connection = currentConnection ? await currentConnection : null;
    if (connection?.close) {
      await connection.close();
      closed = true;
    }
  } catch {
    // Fall through.
  }

  if (!closed && isTauri()) {
    try {
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      await Database.get(getLocalModeSqlitePath(closingScope)).close();
    } catch {
      // Reopening on the next attempt is enough.
    }
  } else if (!closed && closingScope) {
    await closePwaDatabase(closingScope).catch(() => undefined);
  }
}

export async function releaseLocalModeSqliteConnection(
  expectedScope?: LocalModeSqliteScope | null,
) {
  await sqliteWriteQueue.catch(() => undefined);
  if (
    expectedScope !== undefined &&
    scopeKey(resolveSqliteScope(expectedScope)) !== scopeKey(activeSqliteScope)
  ) {
    return;
  }
  await resetSqliteConnection();
}

async function retrySqliteWrite<T>(task: () => Promise<T>) {
  const retryDelays = [75, 200, 500];

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const delay = retryDelays[attempt];
      if (!isSqliteLockedError(error) || delay === undefined) {
        throw error;
      }
      await resetSqliteConnection();
      await new Promise((resolve) => globalThis.setTimeout(resolve, delay));
    }
  }
}

function enqueueSqliteWriteLane<T>(task: () => Promise<T>): Promise<T> {
  const queued = sqliteWriteQueue.catch(() => undefined).then(task);
  sqliteWriteQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

export function runLocalModeSqliteWrite<T>(
  task: () => Promise<T>,
  scope?: LocalModeSqliteScope | null,
): Promise<T> {
  const writeScope = resolveSqliteScope(scope);
  const queued = enqueueSqliteWriteLane(() => retrySqliteWrite(async () => {
      // Resolve/switch the physical database while this global write lane is
      // held, so two workspace scopes can never share a transaction.
      await ensureConnection(writeScope);
      return task();
    }));

  void queued.then(
    () => {
      if (writeScope) {
        void import("./usbBackup").then(({ runUsbBackupIfNeeded }) => {
          runUsbBackupIfNeeded(writeScope.workspaceId, writeScope.userId);
        });
      }
    },
    () => undefined,
  );

  return queued;
}

async function runConnectionTransaction<T>(
  connection: SqliteConnection,
  task: (connection: SqliteConnection) => Promise<T>,
) {
  if (connection.transaction) {
    return connection.transaction(task);
  }

  await connection.execute("BEGIN IMMEDIATE");
  try {
    const result = await task(connection);
    await connection.execute("COMMIT");
    return result;
  } catch (error) {
    try {
      await connection.execute("ROLLBACK");
    } catch (rollbackError) {
      console.error("[LocalModeSQLite] Rollback failed:", rollbackError);
    }
    throw error;
  }
}

/**
 * Proves that the native database can be opened, passes SQLite's integrity
 * check, and provides real commit/rollback semantics before the workspace UI
 * is allowed to mount. Browser/PWA readiness is handled by pwaSqlite because
 * it also owns the workspace-wide Web Lock.
 */
export async function checkNativeSqliteReadiness(
  scope: LocalModeSqliteScope,
): Promise<NativeSqliteReadiness> {
  try {
    const connection = await ensureConnection(scope);
    if (!connection) {
      return {
        ready: false,
        scope,
        reason: "sqlite-unavailable",
        message: "The native SQLite database could not be opened.",
      };
    }

    const integrityRows = await connection.select<Array<Record<string, unknown>>>(
      "PRAGMA quick_check(1)",
    );
    const integrityResult = integrityRows[0]
      ? String(Object.values(integrityRows[0])[0] ?? "").toLowerCase()
      : "";
    if (integrityResult !== "ok") {
      return {
        ready: false,
        scope,
        reason: "integrity-check-failed",
        message: "The native SQLite database failed its integrity check.",
      };
    }

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS atlas_sqlite_readiness_probe (
        probe_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `);
    const probeId = globalThis.crypto.randomUUID();
    const rollbackProbe = new Error("atlas-sqlite-readiness-rollback");
    try {
      await runConnectionTransaction(connection, async (transaction) => {
        await transaction.execute(
          "INSERT INTO atlas_sqlite_readiness_probe (probe_id, created_at) VALUES ($1, $2)",
          [probeId, new Date().toISOString()],
        );
        const inserted = await transaction.select<Array<{ count: number }>>(
          "SELECT COUNT(*) AS count FROM atlas_sqlite_readiness_probe WHERE probe_id = $1",
          [probeId],
        );
        if (Number(inserted[0]?.count ?? 0) !== 1) {
          throw new Error("The native SQLite write probe could not be read back.");
        }
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }

    const rolledBack = await connection.select<Array<{ count: number }>>(
      "SELECT COUNT(*) AS count FROM atlas_sqlite_readiness_probe WHERE probe_id = $1",
      [probeId],
    );
    if (Number(rolledBack[0]?.count ?? 0) !== 0) {
      throw new Error("The native SQLite rollback probe remained committed.");
    }

    return { ready: true, scope };
  } catch (error) {
    return {
      ready: false,
      scope,
      reason: "write-test-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runLocalModeSqliteTransaction<T>(
  task: (connection: SqliteConnection) => Promise<T>,
  scope?: LocalModeSqliteScope | null,
): Promise<T> {
  return runLocalModeSqliteWrite(async () => {
    const connection = await ensureConnection(scope);
    if (!connection) {
      throw new Error(
        "Local-mode SQLite is unavailable; the mutation was not committed.",
      );
    }

    return runConnectionTransaction(connection, task);
  }, scope);
}

/**
 * Flush the SQLite write-ahead log before a file-level recovery backup.
 *
 * This runs behind all queued Local Mode mutations and closes the connection
 * afterwards so an updater can copy a stable database file without retaining
 * a stale WAL lock.
 */
export function checkpointLocalModeSqliteForBackup(
  scope?: LocalModeSqliteScope | null,
): Promise<void> {
  return runLocalModeSqliteWrite(async () => {
    const connection = await ensureConnection(scope);
    if (!connection) {
      throw new Error("Local-mode SQLite is unavailable; the backup was not created.");
    }

    const checkpoint = await connection.select<Array<{ busy?: number }>>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    );
    if (checkpoint.some((row) => Number(row.busy ?? 0) !== 0)) {
      throw new Error("Local-mode SQLite is busy; the backup was not created.");
    }

    await resetSqliteConnection();
  }, scope);
}

/**
 * Capture a verified SQLite file while the global write lane remains held.
 * Native capture deliberately keeps the lane through checkpoint, close, file
 * read, and validation so a new WAL writer cannot race the copied bytes.
 */
export function captureLocalModeSqliteDatabaseForBackup(
  requestedScope: LocalModeSqliteScope,
): Promise<Uint8Array> {
  const scope = resolveSqliteScope(requestedScope);
  if (!scope) {
    return Promise.reject(new Error("A workspace and user are required to create a backup."));
  }

  return runLocalModeSqliteWrite(async () => {
    const connection = await ensureConnection(scope);
    if (!connection) {
      throw new Error("Local-mode SQLite is unavailable; the backup was not created.");
    }

    if (!isTauri()) {
      const data = await exportPwaDatabase(scope as PwaSqliteScope);
      if (!data) throw new Error("No browser SQLite database is open for this workspace and user.");
      await validateAtlasLocalDatabase(data, scope as PwaSqliteScope, {
        requireScopedIdentity: true,
      });
      return data;
    }

    const checkpoint = await connection.select<Array<{ busy?: number }>>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    );
    if (checkpoint.some((row) => Number(row.busy ?? 0) !== 0)) {
      throw new Error("Local-mode SQLite is busy; the backup was not created.");
    }
    await resetSqliteConnection();

    const { exists, readFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const databaseFilename = getLocalModeSqliteFilename(scope);
    if (!(await exists(databaseFilename, { baseDir: BaseDirectory.AppData }))) {
      throw new Error("No SQLite database exists for this workspace and user.");
    }
    const data = await readFile(databaseFilename, { baseDir: BaseDirectory.AppData });
    await validateTauriDatabaseFile(data, scope, true);
    return data;
  }, scope);
}

function enqueueWrite(
  task: () => Promise<void>,
  scope?: LocalModeSqliteScope | null,
) {
  return runLocalModeSqliteWrite(task, scope).catch((error) => {
      console.error("[LocalModeSQLite] Write failed:", error);
    });
}

async function withMirroringPaused<T>(work: () => Promise<T>) {
  mirroringPauseDepth += 1;

  try {
    return await work();
  } finally {
    mirroringPauseDepth = Math.max(0, mirroringPauseDepth - 1);
  }
}

/** Run a disposable-cache projection without feeding it back into SQLite. */
export function projectDexieFromSqlite<T>(work: () => Promise<T>) {
  return withMirroringPaused(work);
}

function getEntityId(
  tableName: LocalModeSqliteTableName,
  row: Record<string, unknown>,
) {
  if (tableName === "workspaces") {
    return typeof row.id === "string"
      ? row.id
      : typeof row.workspaceId === "string"
        ? row.workspaceId
        : null;
  }

  return typeof row.id === "string" ? row.id : null;
}

async function resolveWorkspaceId(
  cacheDb: Dexie,
  tableName: LocalModeSqliteTableName,
  row: Record<string, unknown>,
) {
  if (tableName === "workspaces") {
    return typeof row.id === "string"
      ? row.id
      : typeof row.workspaceId === "string"
        ? row.workspaceId
        : null;
  }

  if (typeof row.workspaceId === "string") {
    return row.workspaceId;
  }

  if (tableName === "sale_items" && typeof row.saleId === "string") {
    const sale = await cacheDb.table("sales").get(row.saleId);
    return typeof sale?.workspaceId === "string" ? sale.workspaceId : null;
  }

  return null;
}

async function clearCacheRowsForWorkspace(cacheDb: Dexie, workspaceId: string) {
  const currentSales = await cacheDb
    .table("sales")
    .where("workspaceId")
    .equals(workspaceId)
    .toArray();
  const currentSaleIds = currentSales
    .map((sale: Record<string, unknown>) => sale.id)
    .filter((saleId): saleId is string => typeof saleId === "string");

  for (const tableName of LOCAL_MODE_SQLITE_TABLES) {
    if (tableName === "workspaces") {
      await cacheDb.table(tableName).delete(workspaceId);
      continue;
    }

    if (tableName === "sale_items") {
      if (currentSaleIds.length > 0) {
        await cacheDb
          .table(tableName)
          .where("saleId")
          .anyOf(currentSaleIds)
          .delete();
      }
      continue;
    }

    await cacheDb
      .table(tableName)
      .where("workspaceId")
      .equals(workspaceId)
      .delete();
  }
}

async function readCacheRowsForWorkspace(
  cacheDb: Dexie,
  tableName: LocalModeSqliteTableName,
  workspaceId: string,
) {
  if (tableName === "workspaces") {
    const workspace = await cacheDb.table(tableName).get(workspaceId);
    return workspace ? [workspace] : [];
  }

  if (tableName === "sale_items") {
    const sales = await cacheDb
      .table("sales")
      .where("workspaceId")
      .equals(workspaceId)
      .toArray();
    const saleIds = sales
      .map((sale: Record<string, unknown>) => sale.id)
      .filter((saleId): saleId is string => typeof saleId === "string");

    if (saleIds.length === 0) {
      return [];
    }

    return cacheDb.table(tableName).where("saleId").anyOf(saleIds).toArray();
  }

  return cacheDb
    .table(tableName)
    .where("workspaceId")
    .equals(workspaceId)
    .toArray();
}

export async function seedWorkspaceFromDexie(
  cacheDb: Dexie,
  workspaceId: string,
  userId?: string | null,
) {
  const resolvedUserId = userId ?? getActiveBusinessUserId();
  if (!resolvedUserId) {
    throw new Error("Dexie compatibility migration requires an explicit user scope.");
  }
  const scope = { workspaceId, userId: resolvedUserId };
  await runLocalModeSqliteTransaction(async (connection) => {
    for (const tableName of LOCAL_MODE_SQLITE_TABLES) {
      const rows = await readCacheRowsForWorkspace(
        cacheDb,
        tableName,
        workspaceId,
      );

      for (const row of rows) {
        await persistEntity(cacheDb, tableName, row as Record<string, unknown>, {
          connection,
          workspaceId,
        });
      }
    }
  }, scope);
}

async function hasCachedRowsForWorkspace(cacheDb: Dexie, workspaceId: string) {
  for (const tableName of LOCAL_MODE_SQLITE_TABLES) {
    const rows = await readCacheRowsForWorkspace(
      cacheDb,
      tableName,
      workspaceId,
    );
    if (rows.length > 0) {
      return true;
    }
  }
  return false;
}

async function getStoredWorkspaceRowCount(
  connection: SqliteConnection,
  workspaceId: string,
) {
  const rows = await connection.select<Array<{ count: number | string }>>(
    `
            SELECT COUNT(*) AS count
            FROM local_entities
            WHERE workspace_id = $1
               OR (entity_type = 'profiles' AND current_workspace = $1)
               OR (entity_type = 'workspaces' AND entity_id = $1)
        `,
    [workspaceId],
  );

  const count = rows[0]?.count;
  return typeof count === "string"
    ? Number.parseInt(count, 10)
    : Number(count ?? 0);
}

async function openLegacySqliteConnectionForMigration() {
  if (testConnectionOverride) return null;
  if (isTauri()) {
    const { exists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(LEGACY_LOCAL_MODE_SQLITE_FILENAME, { baseDir: BaseDirectory.AppData }))) {
      return null;
    }
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    return await Database.load(getLocalModeSqlitePath(null)) as SqliteConnection;
  }
  return createPwaSqliteConnection(DEFAULT_PWA_SQLITE_SCOPE);
}

/**
 * One-time compatibility bridge from the old shared SQLite file. Only rows
 * belonging to the selected workspace are copied, so the new physical file
 * never inherits another workspace's data. The legacy file remains untouched
 * as a recovery source until the compatibility window ends.
 */
async function migrateLegacyWorkspaceIntoScope(
  target: SqliteConnection,
  scope: LocalModeSqliteScope,
) {
  const legacy = await openLegacySqliteConnectionForMigration();
  if (!legacy) return 0;
  try {
    const legacyTables = await legacy.select<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_entities' LIMIT 1",
    );
    if (legacyTables.length === 0) return 0;
    const legacyColumns = await legacy.select<Array<{ name: string }>>(
      "PRAGMA table_info(local_entities)",
    );
    const hasCurrentWorkspace = legacyColumns.some((column) => column.name === "current_workspace");
    const currentWorkspaceSelect = hasCurrentWorkspace
      ? "current_workspace"
      : "NULL AS current_workspace";
    const currentWorkspacePredicate = hasCurrentWorkspace
      ? "OR (entity_type = 'profiles' AND current_workspace = $1)"
      : "";
    const rows = await legacy.select<StoredEntityRow[]>(
      `
        SELECT entity_type, entity_id, workspace_id, ${currentWorkspaceSelect}, payload, updated_at
        FROM local_entities
        WHERE workspace_id = $1
           ${currentWorkspacePredicate}
           OR (entity_type = 'workspaces' AND entity_id = $1)
           OR (entity_type = 'profiles' AND entity_id = $2)
        ORDER BY entity_type, updated_at
      `,
      [scope.workspaceId, scope.userId],
    );
    if (rows.length === 0) return 0;

    await runConnectionTransaction(target, async (connection) => {
      for (const row of rows) {
        await connection.execute(
          `
            INSERT INTO local_entities (
              entity_type, entity_id, workspace_id, current_workspace, payload, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT(entity_type, entity_id) DO NOTHING
          `,
          [
            row.entity_type,
            row.entity_id,
            row.workspace_id,
            row.current_workspace,
            row.payload,
            row.updated_at,
          ],
        );
      }
    });
    console.info(
      `[LocalModeSQLite] Migrated ${rows.length} legacy row(s) into scoped workspace storage.`,
    );
    return rows.length;
  } finally {
    await legacy.close?.().catch(() => false);
  }
}

/**
 * Preserve cache rows when a new table is added to the SQLite mirror after a
 * hybrid workspace already exists. Without this bridge, hydration would clear
 * that newly supported Dexie table before its first SQLite seed.
 */
async function seedMissingMirrorTablesFromDexie(
  connection: SqliteConnection,
  cacheDb: Dexie,
  workspaceId: string,
  storedRows: readonly StoredEntityRow[],
) {
  const storedTableNames = new Set(
    storedRows
      .map((row) => row.entity_type)
      .filter(isMirroredTableName),
  );
  let seeded = false;

  for (const tableName of LEGACY_HYBRID_MIRROR_SEED_TABLES) {
    if (storedTableNames.has(tableName)) {
      continue;
    }

    const cachedRows = await readCacheRowsForWorkspace(
      cacheDb,
      tableName,
      workspaceId,
    );
    if (cachedRows.length === 0) {
      continue;
    }

    for (const row of cachedRows) {
      await persistEntity(cacheDb, tableName, row as Record<string, unknown>, {
        connection,
        workspaceId,
      });
    }
    seeded = true;
  }

  return seeded;
}

/**
 * Older desktop versions could retain a sale item in IndexedDB without
 * persisting it to SQLite. The parent sale is already in SQLite, so preserve
 * such cache-only items before hydration clears the workspace cache.
 */
async function seedCacheOnlySaleItemsFromDexie(
  connection: SqliteConnection,
  cacheDb: Dexie,
  workspaceId: string,
  storedRows: readonly StoredEntityRow[],
) {
  const storedSaleIds = new Set(
    storedRows
      .filter((row) => row.entity_type === "sales")
      .map((row) => row.entity_id),
  );
  const storedSaleItemIds = new Set(
    storedRows
      .filter((row) => row.entity_type === "sale_items")
      .map((row) => row.entity_id),
  );
  if (storedSaleIds.size === 0) {
    return false;
  }

  const cachedSaleItems = await readCacheRowsForWorkspace(
    cacheDb,
    "sale_items",
    workspaceId,
  ) as Record<string, unknown>[];
  const missingSaleItems = cachedSaleItems.filter((item) => (
    typeof item.id === "string" &&
    typeof item.saleId === "string" &&
    storedSaleIds.has(item.saleId) &&
    !storedSaleItemIds.has(item.id)
  ));

  for (const item of missingSaleItems) {
    await persistEntity(cacheDb, "sale_items", {
      ...item,
      workspaceId,
    }, {
      connection,
      workspaceId,
    });
  }

  if (missingSaleItems.length > 0) {
    console.warn(
      `[LocalModeSQLite] Preserved ${missingSaleItems.length} cache-only sale item(s) for workspace ${workspaceId}.`,
    );
  }
  return missingSaleItems.length > 0;
}

async function synchronizeCashierShiftActiveClaim(
  connection: SqliteConnection,
  row: Record<string, unknown>,
  workspaceId: string | null,
) {
  const occurrenceId = typeof row.id === "string" ? row.id : null;
  const cashierUserId =
    typeof row.cashierUserId === "string" ? row.cashierUserId : null;
  if (!workspaceId || !occurrenceId || !cashierUserId) return;

  const ownsActiveClaim =
    !row.isDeleted && (row.status === "active" || row.status === "paused");
  if (!ownsActiveClaim) {
    await connection.execute(
      `
        DELETE FROM cashier_shift_active_claims
        WHERE workspace_id = $1 AND cashier_user_id = $2 AND occurrence_id = $3
      `,
      [workspaceId, cashierUserId, occurrenceId],
    );
    return;
  }

  const existing = await connection.select<Array<{ occurrence_id: string }>>(
    `
      SELECT occurrence_id
      FROM cashier_shift_active_claims
      WHERE workspace_id = $1 AND cashier_user_id = $2
      LIMIT 1
    `,
    [workspaceId, cashierUserId],
  );
  if (existing[0] && existing[0].occurrence_id !== occurrenceId) {
    throw new Error("This cashier already has an active shift.");
  }
  await connection.execute(
    `
      INSERT INTO cashier_shift_active_claims (workspace_id, cashier_user_id, occurrence_id)
      VALUES ($1, $2, $3)
      ON CONFLICT(workspace_id, cashier_user_id) DO UPDATE SET
        occurrence_id = excluded.occurrence_id
    `,
    [workspaceId, cashierUserId, occurrenceId],
  );
}

async function persistEntity(
  cacheDb: Dexie,
  tableName: LocalModeSqliteTableName,
  row: Record<string, unknown>,
  options: {
    connection?: SqliteConnection;
    authority?: boolean;
    workspaceId?: string | null;
  } = {},
) {
  const entityId = getEntityId(tableName, row);
  if (!entityId) {
    return;
  }

  const workspaceId = options.workspaceId ??
    await resolveWorkspaceId(cacheDb, tableName, row);
  const mirrorWorkspaceId = tableName === "profiles"
    && typeof row.currentWorkspaceId === "string"
    ? row.currentWorkspaceId
    : workspaceId;
  const shouldPersist =
    tableName === "workspaces"
      ? row.data_mode === "local" ||
        row.data_mode === "hybrid" ||
        (workspaceId ? isSqliteMirrorEnabled(workspaceId) : false)
      : mirrorWorkspaceId
        ? isSqliteMirrorEnabled(mirrorWorkspaceId)
        : false;

  if (!shouldPersist) {
    return;
  }

  const connection = options.connection ?? await ensureConnection();
  if (!connection) {
    if (options.authority) {
      throw new Error(
        "Local-mode SQLite is unavailable; the mutation was not committed.",
      );
    }
    return;
  }

  if (
    (tableName === "inventory" || tableName === "products")
    && workspaceId
    && isStrictLocalWorkspaceMode(workspaceId)
    && Object.prototype.hasOwnProperty.call(row, "quantity")
  ) {
    const nextQuantity = row.quantity;
    const storedRows = await connection.select<Array<{ payload: string }>>(
      `
        SELECT payload
        FROM local_entities
        WHERE entity_type = $1 AND entity_id = $2
        LIMIT 1
      `,
      [tableName, entityId],
    );
    let previousQuantity: number | null = null;
    if (storedRows[0]?.payload) {
      try {
        const stored = JSON.parse(storedRows[0].payload) as { quantity?: unknown };
        previousQuantity = typeof stored.quantity === "number"
          ? stored.quantity
          : null;
      } catch {
        previousQuantity = null;
      }
    }

    if (
      typeof nextQuantity !== "number"
      || !isAllowedInventoryQuantityTransition(previousQuantity, nextQuantity)
    ) {
      throw new Error(i18n.t("inventory.errors.negativeQuantity"));
    }
  }

  const payload = JSON.stringify(await serializeValue(row));
  const currentWorkspaceId = tableName === "profiles"
    ? typeof row.currentWorkspaceId === "string"
      ? row.currentWorkspaceId
      : workspaceId
    : null;
  const updatedAt =
    typeof row.updatedAt === "string"
      ? row.updatedAt
      : new Date().toISOString();

  try {
    await connection.execute(
      `
            INSERT INTO local_entities (entity_type, entity_id, workspace_id, current_workspace, payload, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                current_workspace = excluded.current_workspace,
                payload = excluded.payload,
                updated_at = excluded.updated_at
        `,
      [tableName, entityId, workspaceId, currentWorkspaceId, payload, updatedAt],
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("inventory_quantity_deficit")) {
      throw new Error(i18n.t("inventory.errors.negativeQuantity"));
    }
    throw error;
  }
  if (tableName === "cashier_shift_occurrences") {
    await synchronizeCashierShiftActiveClaim(connection, row, workspaceId);
  }
}

async function deleteEntity(
  cacheDb: Dexie,
  tableName: LocalModeSqliteTableName,
  row: Record<string, unknown>,
  options: {
    connection?: SqliteConnection;
    authority?: boolean;
    workspaceId?: string | null;
  } = {},
) {
  const entityId = getEntityId(tableName, row);
  if (!entityId) {
    return;
  }

  const workspaceId = options.workspaceId ??
    await resolveWorkspaceId(cacheDb, tableName, row);
  const mirrorWorkspaceId = tableName === "profiles"
    && typeof row.currentWorkspaceId === "string"
    ? row.currentWorkspaceId
    : workspaceId;
  const shouldDelete =
    tableName === "workspaces"
      ? row.data_mode === "local" ||
        row.data_mode === "hybrid" ||
        (workspaceId ? isSqliteMirrorEnabled(workspaceId) : false)
      : mirrorWorkspaceId
        ? isSqliteMirrorEnabled(mirrorWorkspaceId)
        : false;

  if (!shouldDelete) {
    return;
  }

  const connection = options.connection ?? await ensureConnection();
  if (!connection) {
    if (options.authority) {
      throw new Error(
        "Local-mode SQLite is unavailable; the mutation was not committed.",
      );
    }
    return;
  }

  await connection.execute(
    `
            DELETE FROM local_entities
            WHERE entity_type = $1 AND entity_id = $2
        `,
    [tableName, entityId],
  );
  if (tableName === "cashier_shift_occurrences") {
    const cashierUserId =
      typeof row.cashierUserId === "string" ? row.cashierUserId : null;
    if (workspaceId && cashierUserId) {
      await connection.execute(
        `
          DELETE FROM cashier_shift_active_claims
          WHERE workspace_id = $1 AND cashier_user_id = $2 AND occurrence_id = $3
        `,
        [workspaceId, cashierUserId, entityId],
      );
    }
  }
}

function isAuthoritativeLocalMutation(
  mutation: LocalModeSqliteMutation,
) {
  const { tableName, row } = mutation;
  if (tableName === "workspaces") {
    const workspaceId = getEntityId(tableName, row);
    return row.data_mode === "local" || row.data_mode === "hybrid" ||
      (workspaceId ? isSqliteMirrorEnabled(workspaceId) : false);
  }

  const workspaceId = tableName === "profiles" &&
      typeof row.currentWorkspaceId === "string"
    ? row.currentWorkspaceId
    : mutation.workspaceId;
  return !!workspaceId && isSqliteMirrorEnabled(workspaceId);
}

async function hydrateDurableOutboxProjection(
  cacheDb: Dexie,
  workspaceId: string,
  userId?: string | null,
  importLegacyProjection = false,
) {
  if (isStrictLocalWorkspaceMode(workspaceId)) return;
  const {
    importLegacyDexieOutbox,
    rebuildDexieOutboxProjection,
  } = await import("./cloudSyncOutbox");
  if (importLegacyProjection) {
    await importLegacyDexieOutbox(cacheDb, workspaceId, userId);
  }
  await rebuildDexieOutboxProjection(cacheDb, workspaceId, userId);
}

export async function commitLocalModeSqliteMutations(
  cacheDb: Dexie,
  mutations: readonly LocalModeSqliteMutation[],
) {
  if (mutations.length === 0 || mirroringPauseDepth > 0) {
    return;
  }

  const authoritativeMutations: LocalModeSqliteMutation[] = [];
  for (const mutation of mutations) {
    if (isAuthoritativeLocalMutation(mutation)) {
      authoritativeMutations.push(mutation);
    }
  }

  if (authoritativeMutations.length === 0) {
    return;
  }

  if (!isSupported()) {
    if (import.meta.env.MODE === "test") {
      return;
    }
    throw new Error(
      "Local-mode SQLite is unavailable; the mutation was not committed.",
    );
  }

  const workspaceIds = new Set(
    authoritativeMutations
      .map((mutation) => mutation.workspaceId)
      .filter((workspaceId): workspaceId is string => !!workspaceId),
  );
  if (workspaceIds.size > 1) {
    throw new Error("Cross-workspace local mutations must use an online server transaction.");
  }
  const workspaceId = workspaceIds.values().next().value as string | undefined;
  const userId = getActiveBusinessUserId();
  if (!workspaceId || !userId) {
    throw new Error(
      "SQLite business writes require an explicit workspace and authenticated user scope.",
    );
  }
  const scope = { workspaceId, userId };

  await runLocalModeSqliteTransaction(async (connection) => {
    for (const mutation of authoritativeMutations) {
      if (mutation.type === "upsert") {
        await persistEntity(cacheDb, mutation.tableName, mutation.row, {
          connection,
          authority: true,
          workspaceId: mutation.workspaceId,
        });
      } else {
        await deleteEntity(cacheDb, mutation.tableName, mutation.row, {
          connection,
          authority: true,
          workspaceId: mutation.workspaceId,
        });
      }
    }

    // For Cloud Sync, the durable entity post-state/tombstone and its outbox
    // intent share this exact SQLite transaction. Dexie and its queue are only
    // projections, so a process crash cannot leave durable business state with
    // no replayable intent.
    if (!isStrictLocalWorkspaceMode(workspaceId) && !isOnline(workspaceId)) {
      const [{ enqueueCloudSyncMutation }, { SYNC_REGISTRY }] = await Promise.all([
        import("./cloudSyncOutbox"),
        import("@/sync/syncRegistry"),
      ]);
      for (const mutation of authoritativeMutations) {
        const entityType = mutation.tableName as OfflineMutationEntityType;
        const registration = (SYNC_REGISTRY as Partial<
          Record<OfflineMutationEntityType, { kind: string }>
        >)[entityType];
        if (registration?.kind !== "entity") continue;

        const hardDelete = mutation.type === "delete";
        const softDelete = mutation.row.isDeleted === true;
        if (!hardDelete && mutation.row.syncStatus !== "pending") continue;

        const rowVersion = typeof mutation.row.version === "number" &&
            Number.isFinite(mutation.row.version)
          ? Math.max(0, Math.trunc(mutation.row.version))
          : null;
        const operation = hardDelete || softDelete
          ? "delete"
          : rowVersion !== null && rowVersion <= 1
          ? "create"
          : "update";
        const payload = hardDelete
          ? { ...mutation.row, hardDelete: true }
          : mutation.row;
        const entityId = getEntityId(mutation.tableName, mutation.row);
        if (!entityId) continue;

        await enqueueCloudSyncMutation({
          mutationId: globalThis.crypto.randomUUID(),
          workspaceId,
          entityType,
          entityId,
          operation,
          payload,
          actorId: userId,
          baseVersion: hardDelete ? rowVersion : undefined,
        }, connection);
      }
    }
  }, scope);
}

export async function hydrateLocalModeCacheFromSqlite(
  cacheDb: Dexie,
  workspaceId?: string | null,
  userId?: string | null,
) {
  if (!workspaceId || !isSqliteMirrorEnabled(workspaceId) || !isSupported()) {
    return;
  }

  const resolvedUserId = userId ?? getActiveBusinessUserId();
  const key = hydrationKey(workspaceId, resolvedUserId);
  if (!resolvedUserId) {
    throw new Error(
      "SQLite hydration requires an explicit authenticated user scope.",
    );
  }
  const scope = { workspaceId, userId: resolvedUserId };
  const existingTask = hydrationTasks.get(key);
  if (existingTask) {
    return existingTask;
  }

  if (hydratedWorkspaces.has(key)) {
    return;
  }

  const task = (async () => {
    const connection = await ensureConnection(scope);
    if (!connection) {
      return;
    }
    const allowCompatibilityImport = !await hasCompletedDexieCompatibilityMigration(connection);

    let storedRowCount = await getStoredWorkspaceRowCount(
      connection,
      workspaceId,
    );
    if (storedRowCount === 0 && resolvedUserId) {
      await migrateLegacyWorkspaceIntoScope(connection, {
        workspaceId,
        userId: resolvedUserId,
      });
      storedRowCount = await getStoredWorkspaceRowCount(connection, workspaceId);
    }
    if (storedRowCount === 0) {
      if (allowCompatibilityImport && await hasCachedRowsForWorkspace(cacheDb, workspaceId)) {
        console.warn(
          `[LocalModeSQLite] SQLite is empty for workspace ${workspaceId}; seeding it from the existing cache instead of clearing data.`,
        );
        await seedWorkspaceFromDexie(cacheDb, workspaceId, resolvedUserId);
        await hydrateDurableOutboxProjection(cacheDb, workspaceId, resolvedUserId, true);
        await markDexieCompatibilityMigrationComplete(connection);
        markLocalWorkspaceFetched(workspaceId, resolvedUserId);
        return;
      }

      console.log(`[LocalModeSQLite] SQLite is empty for workspace ${workspaceId}.`);
      await withMirroringPaused(() =>
        clearCacheRowsForWorkspace(cacheDb, workspaceId)
      );
      await hydrateDurableOutboxProjection(
        cacheDb,
        workspaceId,
        resolvedUserId,
        allowCompatibilityImport,
      );
      await markDexieCompatibilityMigrationComplete(connection);
      markLocalWorkspaceFetched(workspaceId, resolvedUserId);
      return;
    }

    let rows = await connection.select<StoredEntityRow[]>(
      `
                SELECT entity_type, entity_id, workspace_id, current_workspace, payload, updated_at
                FROM local_entities
                WHERE workspace_id = $1
                   OR (entity_type = 'profiles' AND current_workspace = $1)
                   OR (entity_type = 'workspaces' AND entity_id = $1)
                ORDER BY entity_type, updated_at
      `,
      [workspaceId],
    );

    const seededMissingTables = allowCompatibilityImport
      ? await seedMissingMirrorTablesFromDexie(
        connection,
        cacheDb,
        workspaceId,
        rows,
      )
      : false;
    const seededCacheOnlySaleItems = allowCompatibilityImport
      ? await seedCacheOnlySaleItemsFromDexie(
        connection,
        cacheDb,
        workspaceId,
        rows,
      )
      : false;
    if (seededMissingTables || seededCacheOnlySaleItems) {
      rows = await connection.select<StoredEntityRow[]>(
        `
                  SELECT entity_type, entity_id, workspace_id, current_workspace, payload, updated_at
                  FROM local_entities
                  WHERE workspace_id = $1
                     OR (entity_type = 'profiles' AND current_workspace = $1)
                     OR (entity_type = 'workspaces' AND entity_id = $1)
                  ORDER BY entity_type, updated_at
              `,
        [workspaceId],
      );
    }

    const saleCreatedAtById = new Map<string, string>();
    for (const row of rows) {
      if (row.entity_type !== "sales") {
        continue;
      }
      const sale = deserializeValue(
        JSON.parse(row.payload),
      ) as Record<string, unknown>;
      const createdAt = firstTimestamp(sale.createdAt, sale.created_at);
      if (createdAt) {
        saleCreatedAtById.set(row.entity_id, createdAt);
      }
    }

    await withMirroringPaused(async () => {
      await clearCacheRowsForWorkspace(cacheDb, workspaceId);

      const groupedRows = new Map<
        LocalModeSqliteTableName,
        Record<string, unknown>[]
      >();
      for (const row of rows) {
        if (!isMirroredTableName(row.entity_type)) {
          continue;
        }

        const payload = JSON.parse(row.payload) as unknown;
        const revived = deserializeValue(payload) as Record<string, unknown>;
        const normalizedPartnerPayload = normalizeLegacyPartnerPayload(
          row.entity_type,
          revived,
        );
        if (row.entity_type === "products" && typeof revived.sku === "string") {
          revived.skuKey = normalizeProductSku(revived.sku);
        }
        if (row.entity_type === "sale_items" &&
            typeof revived.workspaceId !== "string" &&
            row.workspace_id) {
          revived.workspaceId = row.workspace_id;
        }
        if (row.entity_type === "sale_items") {
          const parentSaleCreatedAt = typeof revived.saleId === "string"
            ? saleCreatedAtById.get(revived.saleId)
            : undefined;
          const normalizedSaleItem = normalizeLegacySaleItemTimestamps(
            revived,
            parentSaleCreatedAt,
            row.updated_at,
          );
          if (normalizedPartnerPayload || normalizedSaleItem) {
            await connection.execute(
              `
                UPDATE local_entities
                SET payload = $1
                WHERE entity_type = $2 AND entity_id = $3
              `,
              [JSON.stringify(await serializeValue(revived)), row.entity_type, row.entity_id],
            );
          }
        } else if (normalizedPartnerPayload) {
          await connection.execute(
            `
              UPDATE local_entities
              SET payload = $1
              WHERE entity_type = $2 AND entity_id = $3
            `,
            [JSON.stringify(await serializeValue(revived)), row.entity_type, row.entity_id],
          );
        }
        if (row.entity_type === "profiles") {
          if (row.workspace_id) {
            revived.workspaceId = row.workspace_id;
          }
          revived.currentWorkspaceId = row.current_workspace
            || (typeof revived.currentWorkspaceId === "string"
              ? revived.currentWorkspaceId
              : row.workspace_id);
        }
        const existingGroup = groupedRows.get(row.entity_type) ?? [];
        existingGroup.push(revived);
        groupedRows.set(row.entity_type, existingGroup);
      }

      for (const tableName of LOCAL_MODE_SQLITE_TABLES) {
        const records = groupedRows.get(tableName);
        if (!records?.length) {
          continue;
        }

        await cacheDb.table(tableName).bulkPut(records);
      }
    });

    await hydrateDurableOutboxProjection(
      cacheDb,
      workspaceId,
      resolvedUserId,
      allowCompatibilityImport,
    );
    await markDexieCompatibilityMigrationComplete(connection);
    markLocalWorkspaceFetched(workspaceId, resolvedUserId);
  })().finally(() => {
    hydrationTasks.delete(key);
  });

  hydrationTasks.set(key, task);
  return task;
}

export async function readLocalProfileWorkspaceState(
  userId: string,
  workspaceId?: string | null,
) {
  if (!userId || !isSupported()) {
    return null;
  }

  const activeWorkspaceId = getActiveBusinessWorkspaceId();
  const candidates: Array<LocalModeSqliteScope | null> = [];
  const seen = new Set<string>();
  const addCandidate = (scope: LocalModeSqliteScope | null) => {
    const key = scopeKey(scope);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(scope);
  };
  if (workspaceId) addCandidate({ workspaceId, userId });
  if (activeWorkspaceId) addCandidate({ workspaceId: activeWorkspaceId, userId });
  readRememberedSqliteScopes(userId).forEach(addCandidate);
  // The unscoped database is read only as a compatibility source for devices
  // that predate per-workspace/per-user physical files.
  addCandidate(null);

  for (const candidate of candidates) {
    const connection = await ensureConnection(candidate);
    if (!connection) continue;
    const rows = await connection.select<StoredEntityRow[]>(
      `
        SELECT entity_type, entity_id, workspace_id, current_workspace, payload, updated_at
        FROM local_entities
        WHERE entity_type = 'profiles' AND entity_id = $1
        LIMIT 1
      `,
      [userId],
    );
    const row = rows[0];
    if (!row) continue;

    const payload = deserializeValue(JSON.parse(row.payload)) as Record<string, unknown>;
    const sourceWorkspaceId = row.workspace_id
      || (typeof payload.workspaceId === "string" ? payload.workspaceId : null);
    const currentWorkspaceId = row.current_workspace
      || (typeof payload.currentWorkspaceId === "string" ? payload.currentWorkspaceId : null)
      || sourceWorkspaceId;

    if (sourceWorkspaceId && currentWorkspaceId) {
      return { sourceWorkspaceId, currentWorkspaceId };
    }
  }

  return null;
}

export function queueLocalModeSqliteUpsert(
  cacheDb: Dexie,
  tableName: string,
  row: Record<string, unknown>,
) {
  if (
    !isSupported() ||
    mirroringPauseDepth > 0 ||
    !isMirroredTableName(tableName)
  ) {
    return;
  }

  const userId = getActiveBusinessUserId();
  void (async () => {
    const workspaceId = tableName === "profiles" &&
        typeof row.currentWorkspaceId === "string"
      ? row.currentWorkspaceId
      : await resolveWorkspaceId(cacheDb, tableName, row);
    const mutation: LocalModeSqliteMutation = {
      type: "upsert",
      tableName,
      row,
      workspaceId,
    };
    if (isAuthoritativeLocalMutation(mutation)) {
      return;
    }
    const scope = workspaceId && userId ? { workspaceId, userId } : undefined;
    await enqueueWrite(async () => {
      const connection = await ensureConnection(scope);
      if (!connection) return;
      await persistEntity(cacheDb, tableName, row, { connection, workspaceId });
    }, scope);
  })();
}

export function queueLocalModeSqliteDelete(
  cacheDb: Dexie,
  tableName: string,
  row: Record<string, unknown>,
) {
  if (
    !isSupported() ||
    mirroringPauseDepth > 0 ||
    !isMirroredTableName(tableName)
  ) {
    return;
  }

  const userId = getActiveBusinessUserId();
  void (async () => {
    const workspaceId = tableName === "profiles" &&
        typeof row.currentWorkspaceId === "string"
      ? row.currentWorkspaceId
      : await resolveWorkspaceId(cacheDb, tableName, row);
    const mutation: LocalModeSqliteMutation = {
      type: "delete",
      tableName,
      row,
      workspaceId,
    };
    if (isAuthoritativeLocalMutation(mutation)) {
      return;
    }
    const scope = workspaceId && userId ? { workspaceId, userId } : undefined;
    await enqueueWrite(async () => {
      const connection = await ensureConnection(scope);
      if (!connection) return;
      await deleteEntity(cacheDb, tableName, row, { connection, workspaceId });
    }, scope);
  })();
}

export async function clearWorkspaceSqliteData(
  workspaceId: string,
  userId?: string | null,
) {
  if (!isSupported()) {
    return;
  }

  const resolvedUserId = userId ?? getActiveBusinessUserId();
  const scope = resolvedUserId ? { workspaceId, userId: resolvedUserId } : undefined;
  const connection = await ensureConnection(scope);
  if (!connection) {
    return;
  }

  await connection.execute(
    `
            DELETE FROM local_entities
            WHERE workspace_id = $1
               OR (entity_type = 'workspaces' AND entity_id = $1)
        `,
    [workspaceId],
  );
  await connection.execute(
    "DELETE FROM cashier_shift_active_claims WHERE workspace_id = $1",
    [workspaceId],
  );

  hydratedWorkspaces.delete(hydrationKey(workspaceId, resolvedUserId));
  console.log(
    `[LocalModeSQLite] Cleared all SQLite data for workspace ${workspaceId}`,
  );
}

export async function downloadDatabaseFile(): Promise<void> {
  const scope = resolveSqliteScope();
  const databaseFilename = getLocalModeSqliteFilename(scope);
  if (isTauri()) {
    try {
      const { readFile, writeFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      const { save } = await import("@tauri-apps/plugin-dialog");

      const filePath = await save({
        defaultPath: databaseFilename,
        filters: [{ name: "SQLite Database", extensions: ["db"] }],
      });

      if (!filePath) return;

      const fileData = await readFile(databaseFilename, { baseDir: BaseDirectory.AppData });
      await writeFile(filePath, fileData);
    } catch (error) {
      console.error("[LocalModeSQLite] Failed to download database in Tauri:", error);
    }
    return;
  }

  const data = await exportPwaDatabase(scope as PwaSqliteScope | undefined);
  if (!data) return;
  const blob = new Blob([data], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = databaseFilename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function assertSqliteFileHeader(data: Uint8Array): void {
  if (data.byteLength < 100) {
    throw new Error("The selected file is not a valid SQLite database.");
  }
  const header = new TextDecoder().decode(data.subarray(0, 16));
  if (header !== "SQLite format 3\0") {
    throw new Error("The selected file is not a valid SQLite database.");
  }
}

function firstSqliteCell(row: Record<string, unknown> | undefined) {
  return row ? Object.values(row)[0] : undefined;
}

async function assertAtlasDatabaseConnection(
  connection: SqliteConnection,
  scope: LocalModeSqliteScope,
  requireScopedIdentity: boolean,
) {
  const quickCheck = await connection.select<Array<Record<string, unknown>>>(
    "PRAGMA quick_check",
  );
  if (String(firstSqliteCell(quickCheck[0]) ?? "").toLowerCase() !== "ok") {
    throw new Error("The selected database failed its integrity check.");
  }

  const tables = await connection.select<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_entities' LIMIT 1",
  );
  if (tables.length !== 1) {
    throw new Error("The selected SQLite file is not an Atlas Local Mode database.");
  }
  const columns = await connection.select<Array<{ name: string }>>(
    "PRAGMA table_info(local_entities)",
  );
  const columnNames = new Set(columns.map((column) => column.name));
  for (const required of ["entity_type", "entity_id", "workspace_id", "payload"]) {
    if (!columnNames.has(required)) {
      throw new Error("The selected SQLite file is not an Atlas Local Mode database.");
    }
  }

  const identityTables = await connection.select<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'atlas_database_identity' LIMIT 1",
  );
  if (identityTables.length) {
    const identities = await connection.select<Array<{
      workspace_id: string;
      user_id: string;
    }>>(
      "SELECT workspace_id, user_id FROM atlas_database_identity WHERE singleton = 1",
    );
    const identity = identities[0];
    if (
      !identity ||
      identity.workspace_id !== scope.workspaceId ||
      identity.user_id !== scope.userId
    ) {
      throw new Error("This SQLite database belongs to a different workspace or user.");
    }
    return;
  }

  if (requireScopedIdentity) {
    throw new Error("The selected backup is missing its workspace database identity.");
  }

  const [foreignWorkspaces, foreignProfiles] = await Promise.all([
    connection.select<Array<Record<string, unknown>>>(
      `
        SELECT 1
        FROM local_entities
        WHERE (workspace_id IS NOT NULL AND workspace_id <> $1)
           OR (entity_type = 'workspaces' AND entity_id <> $1)
        LIMIT 1
      `,
      [scope.workspaceId],
    ),
    connection.select<Array<Record<string, unknown>>>(
      `
        SELECT 1
        FROM local_entities
        WHERE entity_type = 'profiles' AND entity_id <> $1
        LIMIT 1
      `,
      [scope.userId],
    ),
  ]);
  if (foreignWorkspaces.length || foreignProfiles.length) {
    throw new Error("This SQLite database belongs to a different workspace or user.");
  }
}

async function validateTauriDatabaseAtFilename(
  filename: string,
  scope: LocalModeSqliteScope,
  requireScopedIdentity: boolean,
) {
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  let validationConnection: SqliteConnection | null = null;
  try {
    validationConnection = await Database.load(`sqlite:${filename}`) as SqliteConnection;
    await assertAtlasDatabaseConnection(
      validationConnection,
      scope,
      requireScopedIdentity,
    );
  } finally {
    await validationConnection?.close?.().catch(() => false);
  }
}

async function removeTauriDatabaseJournals(filename: string) {
  const { remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  await Promise.all([
    remove(`${filename}-wal`, { baseDir: BaseDirectory.AppData }).catch(() => undefined),
    remove(`${filename}-shm`, { baseDir: BaseDirectory.AppData }).catch(() => undefined),
  ]);
}

async function validateTauriDatabaseFile(
  data: Uint8Array,
  scope: LocalModeSqliteScope,
  requireScopedIdentity = false,
): Promise<void> {
  assertSqliteFileHeader(data);

  const validationFilename = `atlas-restore-validation-${crypto.randomUUID()}.db`;
  const { writeFile, remove, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  try {
    await writeFile(validationFilename, data, { baseDir: BaseDirectory.AppData });
    await validateTauriDatabaseAtFilename(
      validationFilename,
      scope,
      requireScopedIdentity,
    );
  } finally {
    await Promise.all([
      remove(validationFilename, { baseDir: BaseDirectory.AppData }).catch(() => undefined),
      remove(`${validationFilename}-wal`, { baseDir: BaseDirectory.AppData }).catch(() => undefined),
      remove(`${validationFilename}-shm`, { baseDir: BaseDirectory.AppData }).catch(() => undefined),
    ]);
  }
}

async function assertRestoredConnectionWritable(
  connection: SqliteConnection,
  scope: LocalModeSqliteScope,
) {
  await assertAtlasDatabaseConnection(connection, scope, true);
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS atlas_sqlite_restore_probe (
      probe_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )
  `);
  const probeId = globalThis.crypto.randomUUID();
  const rollbackProbe = new Error("atlas-sqlite-restore-rollback");
  try {
    await runConnectionTransaction(connection, async (transaction) => {
      await transaction.execute(
        "INSERT INTO atlas_sqlite_restore_probe (probe_id, created_at) VALUES ($1, $2)",
        [probeId, new Date().toISOString()],
      );
      const inserted = await transaction.select<Array<{ count: number }>>(
        "SELECT COUNT(*) AS count FROM atlas_sqlite_restore_probe WHERE probe_id = $1",
        [probeId],
      );
      if (Number(inserted[0]?.count ?? 0) !== 1) {
        throw new Error("The restored SQLite write probe could not be read back.");
      }
      throw rollbackProbe;
    });
  } catch (error) {
    if (error !== rollbackProbe) throw error;
  }
  const rolledBack = await connection.select<Array<{ count: number }>>(
    "SELECT COUNT(*) AS count FROM atlas_sqlite_restore_probe WHERE probe_id = $1",
    [probeId],
  );
  if (Number(rolledBack[0]?.count ?? 0) !== 0) {
    throw new Error("The restored SQLite rollback probe remained committed.");
  }
}

export interface LocalModeDatabaseRestoreOptions {
  /** Bundle v1+ databases must carry the same physical workspace/user identity. */
  requireScopedIdentity?: boolean;
  /** Commit a previously staged asset generation after the new DB is healthy. */
  commitExternalState?: () => Promise<void>;
  /** Restore active assets if their commit started but the restore fails. */
  rollbackExternalState?: () => Promise<void>;
}

function combinedRestoreError(
  message: string,
  primaryError: unknown,
  rollbackErrors: unknown[],
) {
  const error = new Error(message);
  (error as Error & { cause?: unknown }).cause = {
    primaryError,
    rollbackErrors,
  };
  return error;
}

async function replaceTauriDatabaseWithRollback(
  data: Uint8Array,
  scope: LocalModeSqliteScope,
  options: LocalModeDatabaseRestoreOptions,
) {
  assertSqliteFileHeader(data);
  const databaseFilename = getLocalModeSqliteFilename(scope);
  const candidateFilename = `${databaseFilename}.restore-${crypto.randomUUID()}.candidate.db`;
  const rollbackFilename = `${databaseFilename}.restore-${crypto.randomUUID()}.rollback.db`;
  const {
    copyFile,
    exists,
    readFile,
    remove,
    rename,
    writeFile,
    BaseDirectory,
  } = await import("@tauri-apps/plugin-fs");
  let targetExisted = false;
  let rollbackBytes: Uint8Array | null = null;
  let databaseWasReplaced = false;
  let rollbackRecovered = false;

  try {
    await writeFile(candidateFilename, data, { baseDir: BaseDirectory.AppData });
    // Validate the exact temporary file which will be renamed into place.
    await validateTauriDatabaseAtFilename(
      candidateFilename,
      scope,
      options.requireScopedIdentity === true,
    );
    await removeTauriDatabaseJournals(candidateFilename);

    const current = await ensureConnection(scope);
    if (!current) throw new Error("The current SQLite database could not be opened for restore.");
    const checkpoint = await current.select<Array<{ busy?: number }>>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    );
    if (checkpoint.some((row) => Number(row.busy ?? 0) !== 0)) {
      throw new Error("Local-mode SQLite is busy; the backup was not restored.");
    }
    await resetSqliteConnection();

    targetExisted = await exists(databaseFilename, { baseDir: BaseDirectory.AppData });
    if (targetExisted) {
      rollbackBytes = await readFile(databaseFilename, { baseDir: BaseDirectory.AppData });
      await copyFile(databaseFilename, rollbackFilename, {
        fromPathBaseDir: BaseDirectory.AppData,
        toPathBaseDir: BaseDirectory.AppData,
      });
      await validateTauriDatabaseAtFilename(rollbackFilename, scope, true);
      await removeTauriDatabaseJournals(rollbackFilename);
    }
    await removeTauriDatabaseJournals(databaseFilename);

    // plugin-fs maps this to a same-directory rename which replaces the target
    // atomically on platforms where the operating system supports it.
    // Treat the swap as potentially mutating before awaiting it: an IPC/OS
    // error may be reported after the filesystem operation has started.
    databaseWasReplaced = true;
    try {
      await rename(candidateFilename, databaseFilename, {
        oldPathBaseDir: BaseDirectory.AppData,
        newPathBaseDir: BaseDirectory.AppData,
      });
    } catch (replaceError) {
      if (!targetExisted) throw replaceError;
      // Windows does not replace an existing destination with rename. The
      // verified rollback copy and in-memory bytes are already durable, so use
      // a remove-then-rename fallback and let the outer recovery path restore
      // the previous file if either operation fails.
      await remove(databaseFilename, { baseDir: BaseDirectory.AppData });
      await rename(candidateFilename, databaseFilename, {
        oldPathBaseDir: BaseDirectory.AppData,
        newPathBaseDir: BaseDirectory.AppData,
      });
    }

    const restored = await ensureConnection(scope);
    if (!restored) throw new Error("The restored SQLite database could not be reopened.");
    await assertRestoredConnectionWritable(restored, scope);
    await markDexieCompatibilityMigrationComplete(restored);
    await options.commitExternalState?.();

    await remove(rollbackFilename, { baseDir: BaseDirectory.AppData }).catch(() => undefined);
    await removeTauriDatabaseJournals(rollbackFilename);
  } catch (primaryError) {
    const rollbackErrors: unknown[] = [];
    try {
      await options.rollbackExternalState?.();
    } catch (error) {
      rollbackErrors.push(error);
    }

    if (databaseWasReplaced) {
      try {
        await resetSqliteConnection();
        await removeTauriDatabaseJournals(databaseFilename);
        if (targetExisted && rollbackBytes) {
          try {
            await rename(rollbackFilename, databaseFilename, {
              oldPathBaseDir: BaseDirectory.AppData,
              newPathBaseDir: BaseDirectory.AppData,
            });
          } catch {
            // Keep the disk rollback copy and use the in-memory copy as a
            // second recovery path if replace-rename is unavailable.
            await writeFile(databaseFilename, rollbackBytes, {
              baseDir: BaseDirectory.AppData,
            });
          }
          const recovered = await ensureConnection(scope);
          if (!recovered) throw new Error("The previous SQLite database could not be reopened.");
          await assertRestoredConnectionWritable(recovered, scope);
        } else {
          await remove(databaseFilename, { baseDir: BaseDirectory.AppData }).catch(() => undefined);
        }
        rollbackRecovered = true;
      } catch (error) {
        rollbackErrors.push(error);
      }
    } else {
      rollbackRecovered = true;
    }

    if (rollbackErrors.length) {
      throw combinedRestoreError(
        "The database restore failed and automatic rollback was incomplete.",
        primaryError,
        rollbackErrors,
      );
    }
    throw primaryError;
  } finally {
    await remove(candidateFilename, { baseDir: BaseDirectory.AppData }).catch(() => undefined);
    await removeTauriDatabaseJournals(candidateFilename);
    if (rollbackRecovered || !databaseWasReplaced) {
      await remove(rollbackFilename, { baseDir: BaseDirectory.AppData }).catch(() => undefined);
      await removeTauriDatabaseJournals(rollbackFilename);
    }
  }
}

async function replacePwaDatabaseWithRollback(
  data: Uint8Array,
  scope: LocalModeSqliteScope,
  options: LocalModeDatabaseRestoreOptions,
) {
  const pwaScope = scope as PwaSqliteScope;
  let quarantineReason: unknown = null;
  try {
    await runExclusivePwaDatabaseReplacement(
      data,
      pwaScope,
      { requireScopedIdentity: options.requireScopedIdentity === true },
      async (session) => {
        let finalizationAttempted = false;
        try {
          await markDexieCompatibilityMigrationComplete(session.connection);
          await options.commitExternalState?.();
          finalizationAttempted = true;
          await session.finalize();
          return;
        } catch (primaryError) {
          // Once finalize has been sent, a rejected/lost reply cannot tell us
          // whether the worker deleted the durable DB rollback first. Keep the
          // asset rollback journal untouched and close the client. On reopen,
          // the worker's rollback-file recovery result decides whether assets
          // follow the old or replacement database.
          if (finalizationAttempted) {
            quarantineReason = primaryError;
            throw primaryError;
          }

          const rollbackErrors: unknown[] = [];
          try {
            await options.rollbackExternalState?.();
          } catch (error) {
            rollbackErrors.push(error);
          }
          let requiresQuarantine = rollbackErrors.length > 0;
          try {
            await session.rollback({ retainRecoveryEvidence: requiresQuarantine });
          } catch (error) {
            rollbackErrors.push(error);
            requiresQuarantine = true;
          }
          if (rollbackErrors.length) {
            quarantineReason = primaryError;
            throw combinedRestoreError(
              "The browser database restore failed and automatic rollback was incomplete.",
              primaryError,
              rollbackErrors,
            );
          }
          throw primaryError;
        }
      },
    );
  } catch (primaryError) {
    if (quarantineReason) {
      let quarantineError: unknown;
      try {
        await quarantinePwaDatabase(pwaScope, quarantineReason);
      } catch (error) {
        quarantineError = error;
      } finally {
        await resetSqliteConnection();
      }
      if (quarantineError) {
        throw combinedRestoreError(
          "The browser database restore failed and its uncertain connection could not be quarantined.",
          primaryError,
          [quarantineError],
        );
      }
    }
    throw primaryError;
  }
}

/**
 * Replace the device's Local Mode SQLite file with a validated Atlas backup.
 * Callers must clear the IndexedDB cache and reload after this resolves.
 */
export async function injectLocalModeDatabaseFile(
  data: Uint8Array,
  requestedScope?: LocalModeSqliteScope | null,
  options: LocalModeDatabaseRestoreOptions = {},
): Promise<void> {
  if (!isSupported()) {
    throw new Error("Local database storage is unavailable on this device.");
  }

  const scope = resolveSqliteScope(requestedScope);
  if (!scope) throw new Error("A workspace and user are required to restore a database.");
  mirroringPauseDepth += 1;
  try {
    await enqueueSqliteWriteLane(async () => {
      const connection = await ensureConnection(scope);
      if (!connection) throw new Error("The current SQLite database could not be opened for restore.");
      if (isTauri()) {
        await replaceTauriDatabaseWithRollback(data, scope, options);
      } else {
        await validateAtlasLocalDatabase(data, scope as PwaSqliteScope, {
          requireScopedIdentity: options.requireScopedIdentity === true,
        });
        await replacePwaDatabaseWithRollback(data, scope, options);
      }
      hydratedWorkspaces.clear();
    });
  } finally {
    mirroringPauseDepth -= 1;
  }
}
