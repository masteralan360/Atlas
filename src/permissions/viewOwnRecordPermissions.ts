import type { WorkspacePermissionKey } from "./workspacePermissionDefinitions";

export const VIEW_OWN_RECORD_PERMISSION_KEYS = [
  "orders.view_own",
  "sales.view_own",
  "loans.view_own",
  "installments.view_own",
  "invoice_history.view_own",
] as const satisfies readonly WorkspacePermissionKey[];

export type ViewOwnRecordPermissionState = "all" | "none" | "custom";

export function getViewOwnRecordPermissionState(
  permissionKeys: ReadonlySet<WorkspacePermissionKey>,
): ViewOwnRecordPermissionState {
  const grantedCount = VIEW_OWN_RECORD_PERMISSION_KEYS.filter((key) =>
    permissionKeys.has(key),
  ).length;

  if (grantedCount === 0) return "none";
  if (grantedCount === VIEW_OWN_RECORD_PERMISSION_KEYS.length) return "all";
  return "custom";
}
