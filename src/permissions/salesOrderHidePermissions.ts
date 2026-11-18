import {
  SALES_ORDER_PERMISSION_PAYMENT_METHODS,
  SALES_ORDER_PERMISSION_STATUSES,
  type WorkspacePermissionKey,
} from "./workspacePermissionDefinitions";

export const SALES_ORDER_PAYMENT_METHOD_PERMISSION_PREFIX =
  "orders.salesOrderPaymentMethod.";
export const SALES_ORDER_MAX_STATUS_PERMISSION_PREFIX =
  "orders.salesOrderMaxStatus.";

export type SalesOrderPaymentMethod =
  (typeof SALES_ORDER_PERMISSION_PAYMENT_METHODS)[number];
export type SalesOrderAdvancementStatus =
  (typeof SALES_ORDER_PERMISSION_STATUSES)[number];

const statusRank = new Map<SalesOrderAdvancementStatus, number>(
  SALES_ORDER_PERMISSION_STATUSES.map((status, index) => [status, index]),
);

export function getSalesOrderPaymentMethodHidePermissionKey(
  method: SalesOrderPaymentMethod,
): WorkspacePermissionKey {
  const permissionSegment = method.replace(/_/g, "");
  return `${SALES_ORDER_PAYMENT_METHOD_PERMISSION_PREFIX}${permissionSegment}` as WorkspacePermissionKey;
}

export function getSalesOrderMaxStatusPermissionKey(
  status: SalesOrderAdvancementStatus,
): WorkspacePermissionKey {
  return `${SALES_ORDER_MAX_STATUS_PERMISSION_PREFIX}${status}` as WorkspacePermissionKey;
}

export function isSalesOrderHidePermissionKey(key: string) {
  return SALES_ORDER_PERMISSION_PAYMENT_METHODS.some(
    (method) => key === getSalesOrderPaymentMethodHidePermissionKey(method),
  ) || SALES_ORDER_PERMISSION_STATUSES.some(
    (status) => key === getSalesOrderMaxStatusPermissionKey(status),
  );
}

export function isSalesOrderPaymentMethodAllowed(
  method: string | null | undefined,
  permissionKeys: ReadonlySet<string>,
) {
  if (!method) return false;
  if (!(SALES_ORDER_PERMISSION_PAYMENT_METHODS as readonly string[]).includes(method)) {
    return false;
  }
  return !permissionKeys.has(
    getSalesOrderPaymentMethodHidePermissionKey(method as SalesOrderPaymentMethod),
  );
}

export function getAllowedSalesOrderPaymentMethods(
  permissionKeys: ReadonlySet<string>,
) {
  return SALES_ORDER_PERMISSION_PAYMENT_METHODS.filter((method) =>
    isSalesOrderPaymentMethodAllowed(method, permissionKeys),
  );
}

export function getProhibitedSalesOrderPaymentMethods(
  permissionKeys: ReadonlySet<string>,
) {
  return SALES_ORDER_PERMISSION_PAYMENT_METHODS.filter((method) =>
    permissionKeys.has(getSalesOrderPaymentMethodHidePermissionKey(method)),
  );
}

/**
 * A missing maximum-status row keeps legacy staff unrestricted. If malformed
 * data contains multiple maximum rows, resolve to the lowest level so the
 * result remains restrictive and hierarchical.
 */
export function getMaximumSalesOrderStatus(
  permissionKeys: ReadonlySet<string>,
): SalesOrderAdvancementStatus {
  const configured = SALES_ORDER_PERMISSION_STATUSES.filter((status) =>
    permissionKeys.has(getSalesOrderMaxStatusPermissionKey(status)),
  );
  return configured[0] ?? "completed";
}

export function isSalesOrderStatusAllowed(
  status: string | null | undefined,
  permissionKeys: ReadonlySet<string>,
) {
  const targetRank = statusRank.get(status as SalesOrderAdvancementStatus);
  if (targetRank === undefined) return false;
  const maximumRank = statusRank.get(getMaximumSalesOrderStatus(permissionKeys)) ?? 0;
  return targetRank <= maximumRank;
}

