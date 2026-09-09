import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  BadgeDollarSign,
  CalendarDays,
  CircleX,
  LayoutGrid,
  List,
  Printer,
  ReceiptText,
  RotateCcw,
  TrendingUp,
  UserRound,
} from "lucide-react";

import { useAuth } from "@/auth";
import {
  getInstallmentSaleDisplayStatus,
  getInstallmentSaleOverdueDays,
  reversePaymentTransaction,
  useInstallmentSale,
  useInstallmentSaleInstallments,
  useInstallmentSalePaymentTransactions,
  useInstallmentSalePayments,
  type InstallmentSalePayment,
  type PaymentTransaction,
} from "@/local-db";
import { cn, formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { isMobile } from "@/lib/platform";
import type { TemplatePreview } from "@/lib/printPreviewEditorStore";
import { generateTemplatePdf, type PrintFormat } from "@/services/pdfGenerator";
import { printPdfBlob } from "@/services/pdfPrintService";
import { useWorkspace } from "@/workspace";
import { ReverseTransactionCofirmationDialog } from "@/ui/components/payments/ReverseTransactionCofirmationDialog";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PrintPreviewModal,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from "@/ui/components";

import {
  CancelInstallmentSaleDialog,
  RecordInstallmentSalePaymentDialog,
} from "./InstallmentSaleDialogs";
import { InstallmentSalePrintTemplate } from "./InstallmentSalePrintTemplate";

function statusTone(status: "active" | "overdue" | "completed" | "cancelled") {
  if (status === "overdue") return "destructive";
  if (status === "completed") return "secondary";
  if (status === "cancelled") return "outline";
  return "default";
}

function formatInstallmentSaleDueAt(value: string | null | undefined) {
  if (!value) return "—";
  return value.length > 10 ? formatDateTime(value) : formatDate(value);
}

function getPaymentDescription(
  payment: InstallmentSalePayment,
  t: ReturnType<typeof useTranslation>["t"],
) {
  return (
    payment.note?.trim() ||
    (payment.installmentId
      ? t("installmentSales.print.installmentCollection")
      : t("installmentSales.downPayment"))
  );
}

export function InstallmentSaleDetailsView({
  workspaceId,
  saleId,
}: {
  workspaceId: string;
  saleId: string;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { features, workspaceName } = useWorkspace();
  const sale = useInstallmentSale(saleId, workspaceId);
  const installments = useInstallmentSaleInstallments(saleId);
  const payments = useInstallmentSalePayments(saleId);
  const paymentTransactions = useInstallmentSalePaymentTransactions(saleId);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "grid">(
    () =>
      (localStorage.getItem("installment_sale_details_view_mode") as
        "table" | "grid") || "table",
  );
  const [transactionToReverse, setTransactionToReverse] =
    useState<PaymentTransaction | null>(null);
  const [reversingTransactionId, setReversingTransactionId] = useState<
    string | null
  >(null);

  useEffect(() => {
    localStorage.setItem("installment_sale_details_view_mode", viewMode);
  }, [viewMode]);

  const readOnly = user?.role === "viewer";
  const printLang =
    features.print_lang && features.print_lang !== "auto"
      ? features.print_lang
      : i18n.language;
  const displayStatus = sale ? getInstallmentSaleDisplayStatus(sale) : "active";
  const isCancelled = sale?.status === "cancelled";
  const isOpenEndedFrequency =
    !!sale &&
    sale.installmentFrequency !== "no_frequency" &&
    sale.hasInstallmentCount === false;
  const overdueDays =
    sale && isOpenEndedFrequency && sale.customerBalanceAmount > 0
      ? getInstallmentSaleOverdueDays(sale.firstDueDate)
      : 0;
  const paidPercent =
    sale && sale.totalSalePrice > 0
      ? Math.min(100, (sale.customerPaidAmount / sale.totalSalePrice) * 100)
      : 0;
  const paymentActivityRows = useMemo(() => {
    if (!sale) return [];

    return [
      {
        id: `${sale.id}:created`,
        kind: "sale" as const,
        date: sale.createdAt,
      },
      ...payments.map((payment) => ({
        id: payment.id,
        kind: "payment" as const,
        date: payment.paidAt,
        payment,
      })),
    ].sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
  }, [payments, sale]);

  const {
    reversibleTransactionByPaymentId,
    originalTransactionIdsByPaymentId,
  } = useMemo(() => {
    const reversedTransactionIds = new Set(
      paymentTransactions
        .map((transaction) => transaction.reversalOfTransactionId)
        .filter((transactionId): transactionId is string => !!transactionId),
    );
    const reversible = new Map<string, PaymentTransaction>();
    const originals = new Map<string, string>();

    for (const transaction of paymentTransactions) {
      const paymentId = transaction.sourceSubrecordId;
      if (!paymentId || transaction.reversalOfTransactionId) continue;
      originals.set(paymentId, transaction.id);
      if (!reversedTransactionIds.has(transaction.id)) {
        reversible.set(paymentId, transaction);
      }
    }

    return {
      reversibleTransactionByPaymentId: reversible,
      originalTransactionIdsByPaymentId: originals,
    };
  }, [paymentTransactions]);

  const installmentSaleTemplatePreview = useMemo<
    TemplatePreview | undefined
  >(() => {
    if (!sale) return undefined;

    return {
      fields: [
        {
          key: "customerName",
          label: t("installmentSales.customer"),
          value: sale.customerNameSnapshot,
          type: "text",
        },
        {
          key: "description",
          label: t("installmentSales.description"),
          value: sale.description,
          type: "text",
        },
        {
          key: "hideNextDue",
          label: t("installmentSales.print.hideNextDue"),
          value: "false",
          type: "boolean",
        },
        {
          key: "hideDueDate",
          label: t("installmentSales.print.hideDueDate"),
          value: "false",
          type: "boolean",
        },
      ],
      page: { widthMm: 210, heightMm: 297 },
      createElement: (data, effectiveId, printLangOverride, renderOptions) => (
        <InstallmentSalePrintTemplate
          workspaceName={workspaceName}
          printLang={printLangOverride || printLang}
          sale={{
            ...sale,
            customerNameSnapshot:
              data.customerName ?? sale.customerNameSnapshot,
            description: data.description ?? sale.description,
          }}
          installments={installments}
          payments={payments}
          iqdPreference={features.iqd_display_preference}
          logoUrl={features.logo_url}
          qrValue={features.print_qr && effectiveId ? effectiveId : undefined}
          hideNextDue={data.hideNextDue === "true"}
          hideDueDate={data.hideDueDate === "true"}
          hiddenFields={renderOptions?.hiddenFields}
          onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
        />
      ),
      buildPdf: async (element: ReactElement, printLangOverride?: string) =>
        generateTemplatePdf({
          element,
          format: "a4",
          printLang: printLangOverride || printLang,
        }),
    };
  }, [
    features.iqd_display_preference,
    features.logo_url,
    features.print_qr,
    installments,
    payments,
    printLang,
    sale,
    t,
    workspaceName,
  ]);

  const buildSalePrintPdf = useCallback(
    async ({
      format,
      effectiveId,
      printLangOverride,
    }: {
      format: PrintFormat;
      effectiveId: string;
      printLangOverride?: string;
    }) => {
      if (!sale) throw new Error(t("installmentSales.notFound"));
      return generateTemplatePdf({
        element: (
          <InstallmentSalePrintTemplate
            workspaceName={workspaceName}
            printLang={printLangOverride || printLang}
            sale={sale}
            installments={installments}
            payments={payments}
            iqdPreference={features.iqd_display_preference}
            logoUrl={features.logo_url}
            qrValue={features.print_qr ? effectiveId : undefined}
          />
        ),
        format,
        printLang: printLangOverride || printLang,
      });
    },
    [
      features.iqd_display_preference,
      features.logo_url,
      features.print_qr,
      installments,
      payments,
      printLang,
      sale,
      t,
      workspaceName,
    ],
  );

  const handleReversePayment = async () => {
    if (!transactionToReverse || reversingTransactionId) return;

    setReversingTransactionId(transactionToReverse.id);
    try {
      await reversePaymentTransaction(workspaceId, transactionToReverse.id, {
        createdBy: user?.id ?? null,
      });
      toast({
        title: t("messages.success"),
        description: t("installmentSales.messages.paymentReversed"),
      });
      setTransactionToReverse(null);
    } catch {
      toast({
        variant: "destructive",
        title: t("messages.error"),
        description: t("installmentSales.messages.paymentReverseFailed"),
      });
    } finally {
      setReversingTransactionId(null);
    }
  };

  if (!sale) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          {t("installmentSales.notFound")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link
            href="/installments/sales"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("installmentSales.title")}
          </Link>
          <span>/</span>
          <span className="font-medium text-foreground">{sale.saleNo}</span>
          <Badge variant={statusTone(displayStatus)}>
            {t(`installmentSales.statuses.${displayStatus}`)}
          </Badge>
          {overdueDays > 0 ? (
            <span className="text-xs font-medium text-destructive">
              {t("installmentSales.daysOverdue", { count: overdueDays })}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            allowViewer
            onClick={() => setPrintOpen(true)}
            className="gap-2 print:hidden"
          >
            <Printer className="h-4 w-4" />
            {t("common.print")}
          </Button>
          {!readOnly && !isCancelled ? (
            <Button
              variant="outline"
              className="gap-2 text-destructive hover:text-destructive print:hidden"
              onClick={() => setCancelOpen(true)}
            >
              <CircleX className="h-4 w-4" />
              {t("installmentSales.cancelSale")}
            </Button>
          ) : null}
          {!readOnly && !isCancelled && sale.customerBalanceAmount > 0 ? (
            <Button
              className="gap-2 print:hidden"
              onClick={() => setPaymentOpen(true)}
            >
              <BadgeDollarSign className="h-4 w-4" />
              {t("installmentSales.collectCustomer")}
            </Button>
          ) : null}
        </div>
      </div>

      {isCancelled ? (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-start gap-3 py-4">
            <div className="rounded-full bg-destructive/10 p-2 text-destructive">
              <CircleX className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold text-destructive">
                {t("installmentSales.cancelledSaleTitle")}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("installmentSales.cancelledSaleDescription")}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4">
          <Card className="order-1">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserRound className="h-5 w-5" />
                {t("installmentSales.print.customerDetails")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="text-lg font-semibold">
                {sale.customerNameSnapshot}
              </div>
              <div className="text-xs font-semibold uppercase tracking-wide text-primary">
                {t("installmentSales.customer")}
              </div>
              <div className="pt-2 text-muted-foreground">
                {sale.description}
              </div>
              {sale.notes?.trim() ? (
                <div className="border-t pt-3 text-xs text-muted-foreground">
                  {sale.notes}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="order-3 overflow-hidden border-none bg-transparent shadow-none">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xl font-bold">
                {t("installmentSales.totalSalePrice")}
              </CardTitle>
              <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                {t(`installmentSales.statuses.${displayStatus}`)}
              </span>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="relative overflow-hidden rounded-2xl border border-border/40 bg-muted/30 p-6 text-center">
                <div className="relative z-10">
                  <div className="mb-1 text-sm font-medium text-muted-foreground">
                    {t("installmentSales.totalSalePrice")}
                  </div>
                  <div className="text-4xl font-black tracking-tighter">
                    {formatCurrency(
                      sale.totalSalePrice,
                      sale.currency,
                      features.iqd_display_preference,
                    )}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-center">
                <div className="rounded-2xl border border-border/40 bg-muted/20 p-5">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    {t("installmentSales.paid")}
                  </div>
                  <div className="text-2xl font-bold text-emerald-500">
                    {formatCurrency(
                      sale.customerPaidAmount,
                      sale.currency,
                      features.iqd_display_preference,
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-border/40 bg-muted/20 p-5">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    {t("installmentSales.customerReceivable")}
                  </div>
                  <div className="text-2xl font-bold text-blue-500">
                    {formatCurrency(
                      sale.customerBalanceAmount,
                      sale.currency,
                      features.iqd_display_preference,
                    )}
                  </div>
                </div>
              </div>
              <div className="space-y-2 pt-2">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
                  <div
                    className="h-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)] transition-all duration-500 ease-out"
                    style={{ width: `${paidPercent}%` }}
                  />
                </div>
                <div className="text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
                  {t("installmentSales.paidPercent", {
                    percent: Math.round(paidPercent),
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="order-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ReceiptText className="h-5 w-5" />
                {t("installmentSales.print.saleSummary")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SummaryRow
                label={t("installmentSales.acquisitionCost")}
                value={formatCurrency(
                  sale.acquisitionCost,
                  sale.currency,
                  features.iqd_display_preference,
                )}
              />
              <SummaryRow
                label={t("installmentSales.downPayment")}
                value={formatCurrency(
                  sale.downPaymentAmount,
                  sale.currency,
                  features.iqd_display_preference,
                )}
              />
              <SummaryRow
                label={t("installmentSales.expectedGrossProfit")}
                value={formatCurrency(
                  sale.grossProfit,
                  sale.currency,
                  features.iqd_display_preference,
                )}
              />
              <SummaryRow
                label={t("installmentSales.frequency")}
                value={t(
                  `installmentSales.print.frequencyLabels.${sale.installmentFrequency}`,
                )}
              />
              <SummaryRow
                label={
                  sale.hasInstallmentCount === false
                    ? t("installmentSales.firstDueDate")
                    : t("installmentSales.nextDueDate")
                }
                value={
                  sale.installmentFrequency === "no_frequency"
                    ? "—"
                    : formatInstallmentSaleDueAt(
                        sale.hasInstallmentCount === false
                          ? sale.firstDueDate
                          : sale.nextDueDate,
                      )
                }
              />
            </CardContent>
          </Card>

          <Card className="order-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                {t("installmentSales.print.paymentActivity")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative space-y-6 ps-4 before:absolute before:bottom-2 before:start-0 before:top-2 before:w-0.5 before:bg-border/60">
                {paymentActivityRows.map((row) => {
                  if (row.kind === "sale") {
                    return (
                      <PaymentActivityItem
                        key={row.id}
                        label={t("installmentSales.saleCreated")}
                        date={row.date}
                        amount={sale.totalSalePrice}
                        currency={sale.currency}
                        iqdPreference={features.iqd_display_preference}
                        iconClassName="bg-blue-500"
                      />
                    );
                  }

                  const reversed =
                    originalTransactionIdsByPaymentId.has(row.payment.id) &&
                    !reversibleTransactionByPaymentId.has(row.payment.id);
                  return (
                    <PaymentActivityItem
                      key={row.id}
                      label={getPaymentDescription(row.payment, t)}
                      date={row.date}
                      amount={row.payment.amount}
                      currency={sale.currency}
                      iqdPreference={features.iqd_display_preference}
                      iconClassName={
                        reversed ? "bg-destructive" : "bg-emerald-500"
                      }
                      suffix={
                        reversed
                          ? t("installmentSales.paymentStatuses.reversed")
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 lg:col-span-2">
          <Card>
            <CardContent>
              <div>
                <div className="mb-4 flex flex-row items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <CalendarDays className="h-4 w-4" />
                    {t("installmentSales.customerPayments")}
                  </h3>
                  <div className="hidden items-center rounded-lg border border-border/40 bg-muted/30 p-1 md:flex">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setViewMode("table")}
                      className={cn(
                        "h-7 w-7 transition-all",
                        viewMode === "table"
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-background/50",
                      )}
                      aria-label={t("installmentSales.paymentTableView")}
                    >
                      <List className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setViewMode("grid")}
                      className={cn(
                        "h-7 w-7 transition-all",
                        viewMode === "grid"
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-background/50",
                      )}
                      aria-label={t("installmentSales.paymentCardView")}
                    >
                      <LayoutGrid className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="overflow-hidden rounded-md border">
                  {isMobile() || viewMode === "grid" ? (
                    <div
                      className={cn(
                        "grid gap-4 bg-muted/5 p-4",
                        viewMode === "grid" && !isMobile()
                          ? "grid-cols-2"
                          : "grid-cols-1",
                      )}
                    >
                      {payments.length === 0 ? (
                        <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">
                          {t("common.noData")}
                        </div>
                      ) : (
                        payments.map((payment) => {
                          const transaction =
                            reversibleTransactionByPaymentId.get(payment.id);
                          const reversed =
                            originalTransactionIdsByPaymentId.has(payment.id) &&
                            !transaction;
                          return (
                            <PaymentCard
                              key={payment.id}
                              payment={payment}
                              currency={sale.currency}
                              iqdPreference={features.iqd_display_preference}
                              reversed={reversed}
                              onReverse={
                                !readOnly && transaction
                                  ? () => setTransactionToReverse(transaction)
                                  : undefined
                              }
                            />
                          );
                        })
                      )}
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            {t("installmentSales.paymentDate")}
                          </TableHead>
                          <TableHead>
                            {t("installmentSales.description")}
                          </TableHead>
                          <TableHead>
                            {t("installmentSales.print.paymentMethod")}
                          </TableHead>
                          <TableHead className="text-end">
                            {t("installmentSales.print.amount")}
                          </TableHead>
                          <TableHead>{t("installmentSales.status")}</TableHead>
                          <TableHead className="text-end print:hidden">
                            {t("common.actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {payments.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={6}
                              className="py-8 text-center text-muted-foreground"
                            >
                              {t("common.noData")}
                            </TableCell>
                          </TableRow>
                        ) : (
                          payments.map((payment) => {
                            const transaction =
                              reversibleTransactionByPaymentId.get(payment.id);
                            const reversed =
                              originalTransactionIdsByPaymentId.has(
                                payment.id,
                              ) && !transaction;
                            return (
                              <TableRow key={payment.id}>
                                <TableCell>
                                  {formatDateTime(payment.paidAt)}
                                </TableCell>
                                <TableCell>
                                  {getPaymentDescription(payment, t)}
                                </TableCell>
                                <TableCell>
                                  {t(
                                    `installmentSales.print.paymentMethods.${payment.paymentMethod}`,
                                  )}
                                </TableCell>
                                <TableCell className="text-end font-semibold">
                                  {formatCurrency(
                                    payment.amount,
                                    sale.currency,
                                    features.iqd_display_preference,
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant={reversed ? "outline" : "secondary"}
                                  >
                                    {reversed
                                      ? t(
                                          "installmentSales.paymentStatuses.reversed",
                                        )
                                      : t(
                                          "installmentSales.paymentStatuses.recorded",
                                        )}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-end print:hidden">
                                  {!readOnly && transaction ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="gap-1.5 text-destructive hover:text-destructive"
                                      onClick={() =>
                                        setTransactionToReverse(transaction)
                                      }
                                    >
                                      <RotateCcw className="h-3.5 w-3.5" />
                                      {t("installmentSales.reversePayment")}
                                    </Button>
                                  ) : null}
                                </TableCell>
                              </TableRow>
                            );
                          })
                        )}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <RecordInstallmentSalePaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        sale={sale}
      />
      <CancelInstallmentSaleDialog
        sale={sale}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
      />
      <ReverseTransactionCofirmationDialog
        open={!!transactionToReverse}
        onOpenChange={(open) => {
          if (!open && !reversingTransactionId) {
            setTransactionToReverse(null);
          }
        }}
        onConfirm={handleReversePayment}
        isProcessing={!!reversingTransactionId}
        transaction={transactionToReverse}
        iqdPreference={features.iqd_display_preference}
      />
      <PrintPreviewModal
        module="installment_sales"
        isOpen={printOpen}
        onClose={() => setPrintOpen(false)}
        onConfirm={() => setPrintOpen(false)}
        title={t("installmentSales.print.documentTitle")}
        features={features}
        workspaceName={workspaceName}
        originId={sale.id}
        showSaveButton={false}
        pdfBuilder={buildSalePrintPdf}
        printTemplate={({ effectiveId }) => (
          <InstallmentSalePrintTemplate
            workspaceName={workspaceName}
            printLang={printLang}
            sale={sale}
            installments={installments}
            payments={payments}
            iqdPreference={features.iqd_display_preference}
            logoUrl={features.logo_url}
            qrValue={features.print_qr ? effectiveId : undefined}
          />
        )}
        templatePreview={installmentSaleTemplatePreview}
        customTemplate={{
          moduleTypeKey: "installment_sales",
          nativeTemplateKey: "installment-sales.details",
          label: t("installmentSales.print.documentTitle"),
        }}
        onPreviewPrint={(blob) =>
          printPdfBlob(blob, {
            title: t("installmentSales.print.documentTitle"),
          })
        }
        previewPrintActionLabel={t("common.print")}
        printSelectionOptions={[
          {
            format: "a4",
            nativeTemplateKey: "installment-sales.details",
            label: t("installmentSales.print.documentTitle"),
            description: t("installmentSales.subtitle"),
          },
        ]}
      />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-end font-medium">{value}</span>
    </div>
  );
}

function PaymentActivityItem({
  label,
  date,
  amount,
  currency,
  iqdPreference,
  iconClassName,
  suffix,
}: {
  label: string;
  date: string;
  amount: number;
  currency: "usd" | "iqd" | "eur" | "try";
  iqdPreference: "IQD" | "د.ع";
  iconClassName: string;
  suffix?: string;
}) {
  return (
    <div className="relative">
      <div
        className={cn(
          "absolute -start-[1.375rem] top-1.5 h-3 w-3 rounded-full border-2 border-background",
          iconClassName,
        )}
      />
      <div className="space-y-0.5">
        <div className="font-bold text-sm leading-none">
          {label}
          {suffix ? (
            <span className="ms-2 text-xs font-medium text-destructive">
              {suffix}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 pt-1 text-xs font-medium text-muted-foreground">
          <span>{formatDateTime(date)}</span>
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
          <span className="font-bold text-foreground/80">
            {formatCurrency(amount, currency, iqdPreference)}
          </span>
        </div>
      </div>
    </div>
  );
}

function PaymentCard({
  payment,
  currency,
  iqdPreference,
  reversed,
  onReverse,
}: {
  payment: InstallmentSalePayment;
  currency: "usd" | "iqd" | "eur" | "try";
  iqdPreference: "IQD" | "د.ع";
  reversed: boolean;
  onReverse?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-background p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
            {formatDateTime(payment.paidAt)}
          </span>
        </div>
        <Badge variant={reversed ? "outline" : "secondary"}>
          {reversed
            ? t("installmentSales.paymentStatuses.reversed")
            : t("installmentSales.paymentStatuses.recorded")}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 border-y border-border/50 py-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-tight text-muted-foreground">
            {t("installmentSales.description")}
          </div>
          <div className="text-[11px] font-bold">
            {getPaymentDescription(payment, t)}
          </div>
        </div>
        <div className="border-s border-border/50 ps-2 text-end">
          <div className="text-[10px] font-bold uppercase tracking-tight text-muted-foreground">
            {t("installmentSales.print.amount")}
          </div>
          <div className="text-[11px] font-bold text-emerald-600">
            {formatCurrency(payment.amount, currency, iqdPreference)}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t(`installmentSales.print.paymentMethods.${payment.paymentMethod}`)}
        </span>
        {onReverse ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={onReverse}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("installmentSales.reversePayment")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
