import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { BadgeDollarSign, CircleX, Loader2, ReceiptText } from "lucide-react";

import { useAuth } from "@/auth";
import {
  cancelInstallmentSale,
  recordInstallmentSaleCustomerPayment,
  type InstallmentSale,
  type InstallmentSaleInstallment,
  type PaymentAccount,
  type WorkspacePaymentMethod,
} from "@/local-db";
import {
  formatCurrency,
  formatNumericInput,
  parseFormattedNumber,
  sanitizeNumericInput,
} from "@/lib/utils";
import { useWorkspace } from "@/workspace";
import { PaymentMethodSelector } from "@/ui/components/PaymentMethodSelector";
import { PaymentAccountSelector } from "@/ui/components/payments/PaymentAccountSelector";
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  DateTimePicker,
  Input,
  Label,
  Textarea,
  useToast,
} from "@/ui/components";

export function RecordInstallmentSalePaymentDialog({
  open,
  onOpenChange,
  sale,
  installment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale: InstallmentSale | null;
  installment?: InstallmentSaleInstallment | null;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { features } = useWorkspace();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<WorkspacePaymentMethod>("cash");
  const [account, setAccount] = useState<PaymentAccount | null>(null);
  const [note, setNote] = useState("");
  const [date, setDate] = useState<Date | undefined>(new Date());
  const [isSaving, setIsSaving] = useState(false);
  const maximum =
    installment?.balanceAmount ?? sale?.customerBalanceAmount ?? 0;

  useEffect(() => {
    if (open && sale) {
      setAmount(String(maximum));
      setMethod("cash");
      setAccount(null);
      setNote("");
      setDate(new Date());
      setIsSaving(false);
    }
  }, [maximum, open, sale]);

  const numericAmount = parseFormattedNumber(amount || "0");
  const canSubmit = !!sale && numericAmount > 0 && numericAmount <= maximum;
  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sale || !canSubmit || isSaving) return;

    setIsSaving(true);
    try {
      await recordInstallmentSaleCustomerPayment(sale.workspaceId, {
        installmentSaleId: sale.id,
        installmentId: installment?.id ?? null,
        amount: numericAmount,
        paymentMethod: method,
        paidAt: date?.toISOString(),
        note,
        createdBy: user?.id ?? null,
        accountId: account?.id ?? null,
        accountNameSnapshot: account?.name ?? null,
      });
      toast({
        title: t("messages.success"),
        description: t("installmentSales.messages.paymentRecorded"),
      });
      onOpenChange(false);
    } catch {
      toast({
        variant: "destructive",
        title: t("messages.error"),
        description: t("installmentSales.messages.paymentFailed"),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => !isSaving && onOpenChange(next)}
    >
      <AppDialogContent
        className="max-w-xl"
        showCloseButton={!isSaving}
        onPointerDownOutside={(event) => isSaving && event.preventDefault()}
        onInteractOutside={(event) => isSaving && event.preventDefault()}
        onEscapeKeyDown={(event) => isSaving && event.preventDefault()}
      >
        <AppDialogHeader>
          <AppDialogTitle className="flex gap-2">
            <BadgeDollarSign className="h-5 w-5" />
            {t("installmentSales.collectCustomer")}
          </AppDialogTitle>
        </AppDialogHeader>
        <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
          <AppDialogBody className="space-y-4">
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">
                {t("installmentSales.paymentBalance")}
              </div>
              <strong>
                {sale
                  ? formatCurrency(
                      maximum,
                      sale.currency,
                      features.iqd_display_preference,
                    )
                  : "—"}
              </strong>
            </div>
            <div className="grid gap-2">
              <Label>
                {t("payments.table.amount")} <span className="text-destructive">*</span>
              </Label>
              <Input
                type="text"
                inputMode={sale?.currency === "iqd" ? "numeric" : "decimal"}
                placeholder="0"
                value={formatNumericInput(amount)}
                onChange={(event) =>
                  setAmount(
                    sanitizeNumericInput(event.target.value, {
                      allowDecimal: sale?.currency !== "iqd",
                    }),
                  )
                }
                disabled={isSaving}
              />
            </div>
            <div className="grid gap-2">
              <Label>
                {t("payments.table.method")} <span className="text-destructive">*</span>
              </Label>
              <PaymentMethodSelector
                value={method}
                onValueChange={(value) =>
                  setMethod(value as WorkspacePaymentMethod)
                }
                onLinkedPaymentAccountSelect={setAccount}
                workspaceId={sale?.workspaceId}
              />
            </div>
            <PaymentAccountSelector
              workspaceId={sale?.workspaceId}
              value={account?.id ?? null}
              onValueChange={setAccount}
              disabled={isSaving}
              cashDrawerOnly={method === "cash"}
            />
            <div className="grid gap-2">
              <Label>
                {t("installmentSales.paymentDate")} <span className="text-destructive">*</span>
              </Label>
              <DateTimePicker
                date={date}
                setDate={setDate}
                mode="date-time"
                disabled={isSaving}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("common.notes")}</Label>
              <Textarea
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={isSaving}
              />
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit || isSaving}>
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ReceiptText className="h-4 w-4" />
              )}
              {t("common.record")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}

export function CancelInstallmentSaleDialog({
  sale,
  open,
  onOpenChange,
}: {
  sale: InstallmentSale | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setIsSaving(false);
    }
  }, [open]);

  const canSubmit = !!sale && !!reason.trim();
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sale || !canSubmit || isSaving) return;

    setIsSaving(true);
    try {
      await cancelInstallmentSale(sale.workspaceId, sale.id, {
        reason,
        cancelledBy: user?.id ?? null,
      });
      toast({
        title: t("messages.success"),
        description: t("installmentSales.messages.cancelled"),
      });
      onOpenChange(false);
    } catch {
      toast({
        variant: "destructive",
        title: t("messages.error"),
        description: t("installmentSales.messages.cancelFailed"),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => !isSaving && onOpenChange(next)}
    >
      <AppDialogContent
        className="max-w-lg"
        showCloseButton={!isSaving}
        onPointerDownOutside={(event) => isSaving && event.preventDefault()}
        onInteractOutside={(event) => isSaving && event.preventDefault()}
        onEscapeKeyDown={(event) => isSaving && event.preventDefault()}
      >
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            <CircleX className="h-5 w-5 text-destructive" />
            {t("installmentSales.cancelTitle")}
          </AppDialogTitle>
        </AppDialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <AppDialogBody className="space-y-4">
            <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-muted-foreground">
              {t("installmentSales.cancellationWarning")}
            </p>
            <div className="grid gap-2">
              <Label>
                {t("installmentSales.cancellationReason")} <span className="text-destructive">*</span>
              </Label>
              <Textarea
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={isSaving}
              />
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!canSubmit || isSaving}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CircleX className="h-4 w-4" />
              )}
              {t("installmentSales.confirmCancellation")}
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  );
}
