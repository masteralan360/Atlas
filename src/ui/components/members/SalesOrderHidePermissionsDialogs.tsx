import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ShieldCheck } from "lucide-react";

import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Checkbox,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/components";
import { getPaymentMethodLabel } from "@/lib/paymentMethods";
import {
  getMaximumSalesOrderStatus,
  getSalesOrderPaymentMethodHidePermissionKey,
  type SalesOrderAdvancementStatus,
  type SalesOrderPaymentMethod,
} from "@/permissions/salesOrderHidePermissions";
import {
  SALES_ORDER_PERMISSION_PAYMENT_METHODS,
  SALES_ORDER_PERMISSION_STATUSES,
} from "@/permissions/workspacePermissionDefinitions";

type SharedDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memberName: string;
  permissionKeys: ReadonlySet<string>;
  isSaving: boolean;
};

type PaymentMethodsDialogProps = SharedDialogProps & {
  onSave: (prohibitedMethods: SalesOrderPaymentMethod[]) => Promise<void>;
};

type StatusDialogProps = SharedDialogProps & {
  onSave: (maximumStatus: SalesOrderAdvancementStatus) => Promise<void>;
};

export function SalesOrderPaymentMethodPermissionsDialog({
  open,
  onOpenChange,
  memberName,
  permissionKeys,
  isSaving,
  onSave,
}: PaymentMethodsDialogProps) {
  const { t } = useTranslation();
  const [allowedMethods, setAllowedMethods] = useState<Set<SalesOrderPaymentMethod>>(
    new Set(SALES_ORDER_PERMISSION_PAYMENT_METHODS),
  );

  useEffect(() => {
    if (!open) return;
    setAllowedMethods(new Set(
      SALES_ORDER_PERMISSION_PAYMENT_METHODS.filter((method) =>
        !permissionKeys.has(getSalesOrderPaymentMethodHidePermissionKey(method)),
      ),
    ));
  }, [open, permissionKeys]);

  const save = async () => {
    if (isSaving) return;
    const prohibitedMethods = SALES_ORDER_PERMISSION_PAYMENT_METHODS.filter(
      (method) => !allowedMethods.has(method),
    );
    await onSave(prohibitedMethods);
  };

  return (
    <AppDialog open={open} onOpenChange={(nextOpen) => {
      if (!isSaving) onOpenChange(nextOpen);
    }}>
      <AppDialogContent className="max-w-xl" showCloseButton={!isSaving}>
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {t("members.permissions.salesOrderPaymentMethodsTitle", { defaultValue: "Sales Order Payment Method Hide Permissions" })}
          </AppDialogTitle>
          <p className="text-sm text-muted-foreground">
            {t("members.permissions.salesOrderPaymentMethodsDescription", {
              name: memberName,
              defaultValue: "Choose which Sales Order payment methods {{name}} can use. Checked methods are allowed.",
            })}
          </p>
        </AppDialogHeader>
        <AppDialogBody>
          <div className="space-y-2">
            {SALES_ORDER_PERMISSION_PAYMENT_METHODS.map((method) => {
              const id = `sales-order-payment-permission-${method}`;
              return (
                <div key={method} className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2.5">
                  <Checkbox
                    id={id}
                    checked={allowedMethods.has(method)}
                    disabled={isSaving}
                    onCheckedChange={(checked) => setAllowedMethods((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(method);
                      else next.delete(method);
                      return next;
                    })}
                  />
                  <Label htmlFor={id} className="flex-1 cursor-pointer font-medium">
                    {getPaymentMethodLabel(method, t)}
                  </Label>
                  <span className={`text-xs font-medium ${allowedMethods.has(method) ? "text-emerald-600" : "text-muted-foreground"}`}>
                    {allowedMethods.has(method)
                      ? t("members.permissions.allowed", { defaultValue: "Allowed" })
                      : t("members.permissions.hidden", { defaultValue: "Hidden" })}
                  </span>
                </div>
              );
            })}
          </div>
        </AppDialogBody>
        <AppDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={isSaving} className="gap-2">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isSaving
              ? t("common.saving", { defaultValue: "Saving..." })
              : t("common.save", { defaultValue: "Save" })}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  );
}

export function SalesOrderStatusAdvancementPermissionsDialog({
  open,
  onOpenChange,
  memberName,
  permissionKeys,
  isSaving,
  onSave,
}: StatusDialogProps) {
  const { t } = useTranslation();
  const [maximumStatus, setMaximumStatus] = useState<SalesOrderAdvancementStatus>("completed");

  useEffect(() => {
    if (open) setMaximumStatus(getMaximumSalesOrderStatus(permissionKeys));
  }, [open, permissionKeys]);

  return (
    <AppDialog open={open} onOpenChange={(nextOpen) => {
      if (!isSaving) onOpenChange(nextOpen);
    }}>
      <AppDialogContent className="max-w-xl" showCloseButton={!isSaving}>
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {t("members.permissions.salesOrderStatusTitle", { defaultValue: "Sales Order Status Advancement Permissions" })}
          </AppDialogTitle>
          <p className="text-sm text-muted-foreground">
            {t("members.permissions.salesOrderStatusDescription", {
              name: memberName,
              defaultValue: "Set the highest Sales Order status {{name}} can advance to. Earlier statuses are included automatically.",
            })}
          </p>
        </AppDialogHeader>
        <AppDialogBody>
          <div className="space-y-2">
            <Label htmlFor="sales-order-maximum-status">
              {t("members.permissions.salesOrderMaximumStatus", { defaultValue: "Maximum allowed status" })} <span className="text-destructive">*</span>
            </Label>
            <Select
              value={maximumStatus}
              onValueChange={(value) => setMaximumStatus(value as SalesOrderAdvancementStatus)}
              disabled={isSaving}
            >
              <SelectTrigger id="sales-order-maximum-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SALES_ORDER_PERMISSION_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(`orders.status.${status}`, { defaultValue: status })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="rounded-lg border border-primary/15 bg-primary/5 p-3 text-sm text-muted-foreground">
              {t("members.permissions.salesOrderStatusHierarchy", {
                defaultValue: "Choosing a later status automatically allows every earlier status in the Sales Order sequence.",
              })}
            </div>
          </div>
        </AppDialogBody>
        <AppDialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button type="button" onClick={() => void onSave(maximumStatus)} disabled={isSaving || !maximumStatus} className="gap-2">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isSaving
              ? t("common.saving", { defaultValue: "Saving..." })
              : t("common.save", { defaultValue: "Save" })}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  );
}
