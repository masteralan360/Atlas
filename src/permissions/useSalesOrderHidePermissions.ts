import { useMemo } from "react";

import { useAuth } from "@/auth";
import { useOptionalWorkspacePermissions } from "./workspacePermissionsState";
import {
  getAllowedSalesOrderPaymentMethods,
  getMaximumSalesOrderStatus,
  isSalesOrderPaymentMethodAllowed,
  isSalesOrderStatusAllowed,
  type SalesOrderAdvancementStatus,
  type SalesOrderPaymentMethod,
} from "./salesOrderHidePermissions";
import {
  SALES_ORDER_PERMISSION_STATUSES,
  type WorkspacePermissionKey,
} from "./workspacePermissionDefinitions";

const EMPTY_PERMISSION_KEYS: readonly WorkspacePermissionKey[] = [];

export function useSalesOrderHidePermissions() {
  const { user } = useAuth();
  const permissions = useOptionalWorkspacePermissions();
  const permissionKeys = permissions?.permissionKeys ?? EMPTY_PERMISSION_KEYS;
  const permissionSet = useMemo(
    () => new Set<WorkspacePermissionKey>(permissionKeys),
    [permissionKeys],
  );
  const isAdmin = user?.role === "admin";
  const isLoading = !isAdmin && (
    !user || !permissions || permissions.isLoading
  );

  return useMemo(() => {
    const allowedPaymentMethods = isAdmin
      ? [...getAllowedSalesOrderPaymentMethods(new Set())]
      : isLoading
        ? []
        : getAllowedSalesOrderPaymentMethods(permissionSet);
    const maximumStatus = isAdmin
      ? "completed" as const
      : isLoading
        ? null
        : getMaximumSalesOrderStatus(permissionSet);

    return {
      isLoading,
      maximumStatus,
      allowedPaymentMethods,
      allowedStatuses: (isLoading
        ? []
        : SALES_ORDER_PERMISSION_STATUSES.filter((status) =>
            isAdmin || isSalesOrderStatusAllowed(status, permissionSet),
          )) as SalesOrderAdvancementStatus[],
      isPaymentMethodAllowed: (method: string | null | undefined) =>
        isAdmin || (!isLoading && isSalesOrderPaymentMethodAllowed(method, permissionSet)),
      isStatusAllowed: (status: string | null | undefined) =>
        isAdmin || (!isLoading && isSalesOrderStatusAllowed(status, permissionSet)),
      isPaymentMethodRestricted: (method: string | null | undefined) =>
        !isLoading && !isAdmin && !isSalesOrderPaymentMethodAllowed(method, permissionSet),
    };
  }, [isAdmin, isLoading, permissionSet]);
}

export type { SalesOrderAdvancementStatus, SalesOrderPaymentMethod };
