import { useMemo } from "react";
import {
  ArrowRightLeft,
  Bot,
  Boxes,
  ChevronRight,
  History,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  useInventoryTransferTransactions,
  useProducts,
  useStockAdjustments,
  useStorages,
  type Storage,
} from "@/local-db";
import { formatDateTime } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/components";
import { useWorkspace } from "@/workspace";

type InventoryActivityRecord =
  | {
      id: string;
      kind: "transfer";
      createdAt: string;
      productId: string;
      quantity: number;
      sourceStorageId: string;
      destinationStorageId: string;
      sourceKind: "manual" | "automation";
    }
  | {
      id: string;
      kind: "adjustment";
      createdAt: string;
      productId: string;
      quantity: number;
      storageId: string;
      adjustmentType: "increase" | "decrease";
    };

function formatDateTimeLabel(value?: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return formatDateTime(parsed);
}

function getStorageDisplayName(
  storage: Storage | undefined,
  translate: (key: string, defaultValue: string) => string,
) {
  if (!storage) {
    return translate("inventoryTransfer.unknownStorage", "Unknown storage");
  }

  return storage.isSystem
    ? translate(`storages.${storage.name.toLowerCase()}`, storage.name) ||
        storage.name
    : storage.name;
}

export function InventoryTransactionsPage() {
  const { t } = useTranslation();
  const { activeWorkspace } = useWorkspace();
  const transferTransactions = useInventoryTransferTransactions(
    activeWorkspace?.id,
  );
  const stockAdjustments = useStockAdjustments(activeWorkspace?.id);
  const products = useProducts(activeWorkspace?.id);
  const storages = useStorages(activeWorkspace?.id);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product] as const)),
    [products],
  );

  const storagesById = useMemo(
    () => new Map(storages.map((storage) => [storage.id, storage] as const)),
    [storages],
  );

  const activityRecords = useMemo(() => {
    const transferRecords: InventoryActivityRecord[] = transferTransactions.map(
      (transaction) => ({
        id: transaction.id,
        kind: "transfer",
        createdAt: transaction.createdAt,
        productId: transaction.productId,
        quantity: transaction.quantity,
        sourceStorageId: transaction.sourceStorageId,
        destinationStorageId: transaction.destinationStorageId,
        sourceKind: transaction.transferType,
      }),
    );

    const adjustmentRecords: InventoryActivityRecord[] = stockAdjustments.map(
      (adjustment) => ({
        id: adjustment.id,
        kind: "adjustment",
        createdAt: adjustment.createdAt,
        productId: adjustment.productId,
        quantity: adjustment.quantity,
        storageId: adjustment.storageId,
        adjustmentType: adjustment.adjustmentType,
      }),
    );

    return [...transferRecords, ...adjustmentRecords].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    );
  }, [stockAdjustments, transferTransactions]);

  const transactionStats = useMemo(() => {
    const manualCount =
      transferTransactions.filter(
        (transaction) => transaction.transferType === "manual",
      ).length + stockAdjustments.length;
    const automationCount = transferTransactions.filter(
      (transaction) => transaction.transferType === "automation",
    ).length;
    const totalUnits =
      transferTransactions.reduce(
        (sum, transaction) => sum + transaction.quantity,
        0,
      ) +
      stockAdjustments.reduce(
        (sum, adjustment) => sum + adjustment.quantity,
        0,
      );

    return {
      totalCount: activityRecords.length,
      manualCount,
      automationCount,
      totalUnits,
    };
  }, [activityRecords.length, stockAdjustments, transferTransactions]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <History className="h-6 w-6 text-primary" />
          {t("inventoryTransfer.transactions.title", "Inventory Transactions")}
        </h1>
        <p className="text-muted-foreground">
          {t(
            "inventoryTransactions.pageSubtitle",
            "Review permanent records for inventory transfers and stock adjustments.",
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_320px]">
        <Card className="rounded-3xl border shadow-sm">
          <CardHeader className="border-b bg-muted/20 p-6">
            <CardTitle className="flex items-center gap-2 text-xl">
              <History className="h-5 w-5 text-primary" />
              {t(
                "inventoryTransfer.transactions.title",
                "Inventory Transactions",
              )}
            </CardTitle>
            <CardDescription>
              {t(
                "inventoryTransactions.subtitle",
                "Every manual transfer, automation move, and stock adjustment is recorded here. These records are permanent and cannot be deleted.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-6">
            {activityRecords.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-muted-foreground/30 bg-muted/10 px-6 py-12 text-center">
                <History className="mx-auto mb-4 h-10 w-10 text-primary/70" />
                <h3 className="text-lg font-semibold">
                  {t(
                    "inventoryTransactions.emptyTitle",
                    "No inventory transactions yet",
                  )}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t(
                    "inventoryTransactions.emptyDescription",
                    "Transfer products manually, let an automation rule trigger, or record a stock adjustment, and the records will appear here.",
                  )}
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-3xl border">
                <div className="hidden grid-cols-[160px_minmax(0,1.2fr)_minmax(0,1fr)_120px_120px] gap-4 border-b bg-muted/20 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground md:grid">
                  <div>
                    {t("inventoryTransfer.transactions.columns.time", "Time")}
                  </div>
                  <div>
                    {t(
                      "inventoryTransfer.transactions.columns.product",
                      "Product",
                    )}
                  </div>
                  <div>
                    {t(
                      "inventoryTransfer.transactions.columns.pathway",
                      "Movement Pathway",
                    )}
                  </div>
                  <div>
                    {t(
                      "inventoryTransfer.transactions.columns.quantity",
                      "Quantity",
                    )}
                  </div>
                  <div>
                    {t(
                      "inventoryTransfer.transactions.columns.source",
                      "Source",
                    )}
                  </div>
                </div>

                <div className="divide-y">
                  {activityRecords.map((record) => {
                    const product = productsById.get(record.productId);

                    return (
                      <div
                        key={`${record.kind}:${record.id}`}
                        className="grid gap-4 px-5 py-5 md:grid-cols-[160px_minmax(0,1.2fr)_minmax(0,1fr)_120px_120px] md:items-center"
                      >
                        <div className="text-sm">
                          <div className="font-medium">
                            {formatDateTimeLabel(record.createdAt)}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {record.id.slice(0, 8)}
                          </div>
                        </div>

                        <div>
                          <div className="text-sm font-semibold">
                            {product?.name ||
                              t(
                                "inventoryTransfer.transactions.unknownProduct",
                                "Unknown product",
                              )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            SKU: {product?.sku || "N/A"}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 text-sm">
                          {record.kind === "transfer" ? (
                            <>
                              <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                                {getStorageDisplayName(
                                  storagesById.get(record.sourceStorageId),
                                  t,
                                )}
                              </span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                                {getStorageDisplayName(
                                  storagesById.get(record.destinationStorageId),
                                  t,
                                )}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                                {getStorageDisplayName(
                                  storagesById.get(record.storageId),
                                  t,
                                )}
                              </span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              <span
                                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                                  record.adjustmentType === "increase"
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-rose-100 text-rose-800"
                                }`}
                              >
                                {record.adjustmentType === "increase"
                                  ? t(
                                      "inventoryTransactions.increaseLabel",
                                      "Increase",
                                    )
                                  : t(
                                      "inventoryTransactions.decreaseLabel",
                                      "Decrease",
                                    )}
                              </span>
                            </>
                          )}
                        </div>

                        <div className="text-sm font-semibold">
                          {record.quantity}{" "}
                          {product?.unit ||
                            t("inventoryTransfer.automation.units", "Units")}
                        </div>

                        <div>
                          {record.kind === "transfer" ? (
                            <span
                              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                                record.sourceKind === "automation"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-blue-100 text-blue-800"
                              }`}
                            >
                              {record.sourceKind === "automation" ? (
                                <Bot className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowRightLeft className="h-3.5 w-3.5" />
                              )}
                              {record.sourceKind === "automation"
                                ? t(
                                    "inventoryTransfer.transactions.automationLabel",
                                    "Automation",
                                  )
                                : t(
                                    "inventoryTransfer.transactions.manualLabel",
                                    "Manual",
                                  )}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
                              <Boxes className="h-3.5 w-3.5" />
                              {t(
                                "inventoryTransactions.adjustmentLabel",
                                "Stock Adjustment",
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card className="rounded-3xl border shadow-sm">
            <CardHeader className="space-y-1 p-6">
              <CardTitle className="text-lg">
                {t(
                  "inventoryTransfer.transactions.summaryTitle",
                  "Transfer Summary",
                )}
              </CardTitle>
              <CardDescription>
                {t(
                  "inventoryTransactions.summaryDescription",
                  "A live count of permanent inventory movement records for this workspace.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 p-6 pt-0">
              <div className="rounded-2xl bg-muted/30 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {t(
                    "inventoryTransfer.transactions.totalTransactions",
                    "Total Transactions",
                  )}
                </div>
                <div className="mt-2 text-3xl font-semibold">
                  {transactionStats.totalCount}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-2xl bg-muted/30 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    {t("inventoryTransfer.transactions.manualCount", "Manual")}
                  </div>
                  <div className="mt-2 text-2xl font-semibold">
                    {transactionStats.manualCount}
                  </div>
                </div>
                <div className="rounded-2xl bg-muted/30 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    {t(
                      "inventoryTransfer.transactions.automationCount",
                      "Automation",
                    )}
                  </div>
                  <div className="mt-2 text-2xl font-semibold">
                    {transactionStats.automationCount}
                  </div>
                </div>
              </div>
              <div className="rounded-2xl bg-muted/30 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {t(
                    "inventoryTransfer.transactions.totalUnits",
                    "Units Moved",
                  )}
                </div>
                <div className="mt-2 text-3xl font-semibold">
                  {transactionStats.totalUnits}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-0 bg-[linear-gradient(180deg,#0f4c81,#0b3254)] text-white shadow-xl">
            <CardHeader className="space-y-3 p-6">
              <CardTitle className="flex items-center gap-2 text-2xl">
                <ShieldCheck className="h-5 w-5" />
                {t(
                  "inventoryTransfer.transactions.permanentTitle",
                  "Permanent Log",
                )}
              </CardTitle>
              <CardDescription className="text-sky-100/85">
                {t(
                  "inventoryTransfer.transactions.permanentDescription",
                  "Inventory transaction records are append-only. You can review them here, but they are intentionally not editable or deletable.",
                )}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default InventoryTransactionsPage;
