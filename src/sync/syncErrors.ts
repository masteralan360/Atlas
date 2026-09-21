import i18n from '@/i18n/config';

export const SCHEMA_MISMATCH_ERROR_PREFIX = "Schema mismatch:";
export const SYNC_INTEGRITY_ERROR_PREFIX = "Sync integrity issue:";
const CAPITAL_POOL_CONFLICT_MARKER = "CAPITAL_POOL_ACCOUNT_CONFLICT:";

export interface CapitalPoolSyncConflict {
  accountName: string;
  poolName: string;
  currency?: string;
}

type SyncIntegrityIssueKind = "schema" | "permission" | "validation";

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "Unknown error");
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function getCapitalPoolConflictFromRemoteError(error: unknown): CapitalPoolSyncConflict | null {
  if (!error || typeof error !== "object") return null;
  const message = getErrorMessage(error);
  if (!message.includes("CAPITAL_POOL_ACCOUNT_CONFLICT")) return null;
  const details = "details" in error ? (error as { details?: unknown }).details : null;
  if (typeof details !== "string") return null;

  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    if (typeof parsed.account_name !== "string" || typeof parsed.pool_name !== "string") return null;
    return {
      accountName: parsed.account_name,
      poolName: parsed.pool_name,
      currency: typeof parsed.currency === "string" ? parsed.currency : undefined,
    };
  } catch {
    return null;
  }
}

export function getCapitalPoolConflictFromSyncError(error?: string): CapitalPoolSyncConflict | null {
  if (typeof error !== "string") return null;
  const markerIndex = error.indexOf(CAPITAL_POOL_CONFLICT_MARKER);
  if (markerIndex < 0) return null;

  try {
    const parsed = JSON.parse(error.slice(markerIndex + CAPITAL_POOL_CONFLICT_MARKER.length)) as CapitalPoolSyncConflict;
    return typeof parsed.accountName === "string" && typeof parsed.poolName === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function getSchemaMismatchColumnName(error?: string): string | null {
  if (typeof error !== "string") return null;
  const patterns = [
    /does not recognize (?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)/i,
    /could not find the ['"]([^'"]+)['"] column/i,
    /column ['"]([^'"]+)['"](?: of relation ['"][^'"]+['"])? does not exist/i,
    /column ([a-z_][a-z0-9_]*) does not exist/i,
  ];

  for (const pattern of patterns) {
    const match = error.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

/**
 * Returns an actionable, non-retrying queue error when PostgREST/Postgres
 * rejects a payload because the app and remote table schemas differ.
 */
export function getSchemaMismatchError(
  tableName: string,
  error: unknown,
): string | null {
  const message = getErrorMessage(error);
  const code = getErrorCode(error);
  const column = getSchemaMismatchColumnName(message);
  const isSchemaMismatch =
    code === "PGRST204" ||
    code === "42703" ||
    column !== null ||
    /schema cache/i.test(message) && /column/i.test(message);

  if (!isSchemaMismatch) return null;

  const target = column ? `${tableName}.${column}` : tableName;
  return `${SCHEMA_MISMATCH_ERROR_PREFIX} Supabase does not recognize ${target}. The queued change was kept locally and needs an explicit retry after the server schema is updated. Original error: ${message}`;
}

export function isSchemaMismatchError(error?: string): boolean {
  return typeof error === "string" && error.startsWith(SCHEMA_MISMATCH_ERROR_PREFIX);
}

function getSyncIntegrityIssueKind(error: unknown): SyncIntegrityIssueKind | null {
  const message = getErrorMessage(error);
  const code = getErrorCode(error);

  if (
    isSchemaMismatchError(message) ||
    code === "PGRST204" ||
    code === "42703" ||
    getSchemaMismatchColumnName(message) !== null ||
    (/schema cache/i.test(message) && /column/i.test(message))
  ) {
    return "schema";
  }

  if (
    code === "42501" ||
    /permission denied|row-level security|insufficient privilege|not authorized|forbidden/i.test(message)
  ) {
    return "permission";
  }

  if (
    ["23502", "23503", "23505", "23514", "22001", "22P02"].includes(code ?? "") ||
    /\b(?:23502|23503|23505|23514|22001|22P02)\b|violates (?:check |foreign key |unique |not-null )?constraint|invalid input|value too long|not-null constraint|foreign key constraint|unique constraint|duplicate key|must reference|same workspace|validation (?:failed|error)/i.test(message)
  ) {
    return "validation";
  }

  return null;
}

/**
 * Returns a durable, user-actionable error for rejections that cannot be
 * safely resolved by retrying in the background. The local queued change is
 * deliberately retained so the user can retry only after the root cause is
 * fixed.
 */
export function getSyncIntegrityError(
  tableName: string,
  error: unknown,
): string | null {
  const message = getErrorMessage(error);
  if (
    tableName === "loans" &&
    /loans_v1_amounts_check|loan principal must equal paid amount plus balance/i.test(message)
  ) {
    return `${SYNC_INTEGRITY_ERROR_PREFIX} ${i18n.t("sync.errors.loanAmountIntegrity", {
      defaultValue: "The loan's principal, repayments, balance, and status do not agree. The change was kept locally; refresh the loan and retry the return or repayment.",
    })}`;
  }

  if (tableName === "capital_pools") {
    const conflict = getCapitalPoolConflictFromRemoteError(error);
    if (conflict) {
      return `${SYNC_INTEGRITY_ERROR_PREFIX} ${CAPITAL_POOL_CONFLICT_MARKER}${JSON.stringify(conflict)}`;
    }
  }

  const kind = getSyncIntegrityIssueKind(error);
  if (!kind) return null;

  const reason = kind === "schema"
    ? "the remote schema does not match the app"
    : kind === "permission"
      ? "the current account is not allowed to make this change"
      : "the server rejected this change as invalid";

  return `${SYNC_INTEGRITY_ERROR_PREFIX} Supabase rejected ${tableName} because ${reason}. The queued change was kept locally and needs an explicit retry after the underlying issue is fixed. Original error: ${message}`;
}

/**
 * Accepts both the formatted errors created above and older raw Supabase
 * errors already stored in the offline queue.
 */
export function isSyncIntegrityError(error?: string): boolean {
  if (typeof error !== "string") return false;
  return error.startsWith(SYNC_INTEGRITY_ERROR_PREFIX) ||
    getSyncIntegrityIssueKind(error) !== null;
}
