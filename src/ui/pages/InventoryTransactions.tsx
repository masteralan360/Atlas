import { useEffect, useMemo, useState } from "react";
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness';
import {
  ArrowRightLeft,
  Bot,
  Boxes,
  ChevronRight,
  FileSpreadsheet,
  History,
  Link2,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";

import {
  useInventoryTransactions,
  usePurchaseOrders,
  useProducts,
  useSales,
  useSalesOrderReturnItemsForWorkspace,
  useSalesOrders,
  useStorages,
  type InventoryTransferBatchAllocation,
  type InventoryTransactionType,
  type Storage,
} from "@/local-db";
import { hydrateInventoryTransactionsFromSupabase } from "@/local-db/inventoryTransactions";
import { isDateInDateRange } from "@/lib/dateRangeFilters";
import { setPendingSaleDetailsId } from "@/lib/saleNavigation";
import { formatDateTime } from "@/lib/utils";
import { ProductAutocompleteInput } from "@/ui/components/orders/ProductAutocompleteInput";
import { ExportPreviewModal } from "@/ui/components/ExportPreviewModal";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DateRangeFilters,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/ui/components";
import { DateRangeBadge } from "@/ui/components/DateRangeBadge";
import { useDateRange } from "@/context/DateRangeContext";
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
      sourceWorkspaceId?: string | null;
      destinationWorkspaceId?: string | null;
      sourceWorkspaceName?: string | null;
      destinationWorkspaceName?: string | null;
      sourceStorageName?: string | null;
      destinationStorageName?: string | null;
      sourceKind: "manual" | "automation";
      batchAllocations?: InventoryTransferBatchAllocation[] | null;
    }
  | {
      id: string;
      kind: "adjustment";
      createdAt: string;
      productId: string;
      quantity: number;
      storageId: string;
      adjustmentType: "increase" | "decrease";
      previousQuantity: number;
      newQuantity: number;
    }
  | {
      id: string;
      kind: "ledger";
      createdAt: string;
      productId: string;
      storageId: string;
      sourceRecordId: string;
      referenceLabel: string;
      transactionType: InventoryTransactionType;
      movementSource:
        | "pos-sale"
        | "pos-return"
        | "sales-order"
        | "sales-order-return"
        | "purchase-order"
        | "transfer"
        | "stock-adjustment"
        | "initial-stock"
        | "inventory-change"
        | "sale-product-exchange"
        | "sale-product-exchange-return";
      sourceKind?: "manual" | "automation";
      quantityDelta: number;
      previousQuantity: number | null;
      newQuantity: number | null;
    };

type InventoryMovementDirectionFilter = "all" | "incoming" | "outgoing";
type InventoryMovementSourceFilter =
  | "all"
  | "stock-adjustment"
  | "transfer"
  | "pos-sale"
  | "pos-return"
  | "sales-order"
  | "sales-order-return"
  | "purchase-order"
  | "initial-stock"
  | "inventory-change"
  | "sale-product-exchange"
  | "sale-product-exchange-return";
type InventoryMovementSource = Exclude<InventoryMovementSourceFilter, "all">;
type InventorySnapshotFilter = "all" | "recorded" | "not-recorded";

type InventoryTransactionFilters = {
  productId: string | null;
  productSearch: string;
  direction: InventoryMovementDirectionFilter;
  source: InventoryMovementSourceFilter;
  storageId: string | null;
  snapshot: InventorySnapshotFilter;
};

const DEFAULT_INVENTORY_TRANSACTION_FILTERS: InventoryTransactionFilters = {
  productId: null,
  productSearch: "",
  direction: "all",
  source: "all",
  storageId: null,
  snapshot: "all",
};

type MirroredSaleItem = {
  id: string;
  product_id: string;
  storage_id?: string | null;
  quantity: number;
  inventory_snapshot?: number | null;
};

type MirroredSaleReturnItem = {
  id: string;
  sale_item_id: string;
  quantity: number;
  restored_storage_id?: string | null;
  created_at?: string | null;
};

type MirroredSale = {
  id: string;
  createdAt: string;
  sequenceId?: number;
  _enrichedItems?: MirroredSaleItem[];
  _returns?: Array<{ id?: string; items?: MirroredSaleReturnItem[] }>;
};

function getInventoryTransactionMovementSource(
  transactionType: InventoryTransactionType,
  referenceType?: string | null,
): InventoryMovementSource {
  switch (referenceType) {
    case "pos_sale":
      return "pos-sale";
    case "pos_return":
      return "pos-return";
    case "sales_order":
      return "sales-order";
    case "sales_order_return":
      return "sales-order-return";
    case "purchase_order":
    case "purchase_order_repair":
      return "purchase-order";
    case "inventory_transfer":
    case "inventory_transfer_rollback":
    case "reorder_transfer":
      return "transfer";
    case "sale_product_exchange":
      return "sale-product-exchange";
    case "sale_product_exchange_return":
      return "sale-product-exchange-return";
  }

  switch (transactionType) {
    case "stock_adjustment":
      return "stock-adjustment";
    case "transfer_in":
    case "transfer_out":
      return "transfer";
    case "purchase":
      return "purchase-order";
    case "initial_stock":
      return "initial-stock";
    case "sale":
    case "return":
      return "inventory-change";
    default:
      return "inventory-change";
  }
}

function formatPosSaleReference(sale: MirroredSale) {
  return sale.sequenceId
    ? `#${String(sale.sequenceId).padStart(5, "0")}`
    : `#${sale.id.slice(0, 8)}`;
}

function formatSignedQuantity(quantity: number) {
  return quantity > 0 ? `+${quantity}` : quantity < 0 ? `${quantity}` : "0";
}

function getMovementSource(record: InventoryActivityRecord) {
  if (record.kind === "adjustment") {
    return "stock-adjustment" as const;
  }

  if (record.kind === "transfer") {
    return "transfer" as const;
  }

  return record.movementSource;
}

function hasRecordedQuantitySnapshot(record: InventoryActivityRecord) {
  return (
    record.kind === "adjustment" ||
    (record.kind === "ledger" &&
      record.previousQuantity !== null &&
      record.newQuantity !== null)
  );
}

function matchesInventoryTransactionFilters(
  record: InventoryActivityRecord,
  filters: InventoryTransactionFilters,
  workspaceId: string | undefined,
) {
  if (filters.productId && record.productId !== filters.productId) {
    return false;
  }

  if (
    filters.source !== "all" &&
    getMovementSource(record) !== filters.source
  ) {
    return false;
  }

  if (filters.storageId) {
    const storageIds =
      record.kind === "transfer"
        ? [record.sourceStorageId, record.destinationStorageId]
        : [record.storageId];
    if (!storageIds.includes(filters.storageId)) {
      return false;
    }
  }

  if (
    filters.snapshot !== "all" &&
    (filters.snapshot === "recorded") !== hasRecordedQuantitySnapshot(record)
  ) {
    return false;
  }

  if (filters.direction === "all") {
    return true;
  }

  if (record.kind === "ledger") {
    return filters.direction === "incoming"
      ? record.quantityDelta > 0
      : record.quantityDelta < 0;
  }

  if (record.kind === "adjustment") {
    return filters.direction === "incoming"
      ? record.adjustmentType === "increase"
      : record.adjustmentType === "decrease";
  }

  const isCrossWorkspaceTransfer =
    Boolean(record.sourceWorkspaceId) &&
    Boolean(record.destinationWorkspaceId) &&
    record.sourceWorkspaceId !== record.destinationWorkspaceId;

  if (!isCrossWorkspaceTransfer) {
    return true;
  }

  return filters.direction === "incoming"
    ? record.destinationWorkspaceId === workspaceId
    : record.sourceWorkspaceId === workspaceId;
}

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
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const { activeWorkspace } = useWorkspace();
  const { dateRange, customDates, setDateRange } = useDateRange();
  const inventoryDateRange = dateRange === "allTime" ? "month" : dateRange;
  const pageDirection =
    typeof document === "undefined"
      ? i18n.dir(i18n.resolvedLanguage || i18n.language)
      : document.documentElement.dir || document.dir || "ltr";
  const isRtl = pageDirection === "rtl";
  const inventoryTransactions = useInventoryTransactions(activeWorkspace?.id);
  const sales = useSales(activeWorkspace?.id);
  const salesOrders = useSalesOrders(activeWorkspace?.id);
  const purchaseOrders = usePurchaseOrders(activeWorkspace?.id);
  const salesOrderReturnItems = useSalesOrderReturnItemsForWorkspace(
    activeWorkspace?.id,
  );
  const products = useProducts(activeWorkspace?.id);
  const storages = useStorages(activeWorkspace?.id);
  const [filters, setFilters] = useState<InventoryTransactionFilters>(
    DEFAULT_INVENTORY_TRANSACTION_FILTERS,
  );
  const [draftFilters, setDraftFilters] =
    useState<InventoryTransactionFilters>(DEFAULT_INVENTORY_TRANSACTION_FILTERS);
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
  const [isProductSummaryExportOpen, setIsProductSummaryExportOpen] =
    useState(false);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product] as const)),
    [products],
  );

  const storagesById = useMemo(
    () => new Map(storages.map((storage) => [storage.id, storage] as const)),
    [storages],
  );

  useEffect(() => {
    if (!activeWorkspace?.id) {
      return;
    }

    void hydrateInventoryTransactionsFromSupabase(activeWorkspace.id);
  }, [activeWorkspace?.id]);

  const activityRecords = useMemo(() => {
    const typedSales = sales as MirroredSale[];
    const salesById = new Map(typedSales.map((sale) => [sale.id, sale] as const));
    const saleByReturnId = new Map(
      typedSales.flatMap((sale) =>
        (sale._returns ?? [])
          .filter((saleReturn) => Boolean(saleReturn.id))
          .map((saleReturn) => [saleReturn.id as string, sale] as const),
      ),
    );
    const salesOrdersById = new Map(salesOrders.map((order) => [order.id, order] as const));
    const salesOrderReturnsById = new Map(
      salesOrderReturnItems.map((returnItem) => [returnItem.returnId, returnItem] as const),
    );
    const purchaseOrdersById = new Map(purchaseOrders.map((order) => [order.id, order] as const));

    return inventoryTransactions
      .map((transaction): InventoryActivityRecord => {
        const movementSource = getInventoryTransactionMovementSource(
          transaction.transactionType,
          transaction.referenceType,
        );
        const referenceId = transaction.referenceId || transaction.id;
        const sale = movementSource === "pos-sale"
          ? salesById.get(referenceId)
          : movementSource === "pos-return"
            ? saleByReturnId.get(referenceId)
            : undefined;
        const salesOrderId = movementSource === "sales-order"
          ? referenceId
          : movementSource === "sales-order-return"
            ? salesOrderReturnsById.get(referenceId)?.orderId
            : undefined;
        const purchaseOrder = movementSource === "purchase-order"
          ? purchaseOrdersById.get(referenceId)
          : undefined;
        const salesOrder = salesOrderId ? salesOrdersById.get(salesOrderId) : undefined;
        const sourceRecordId = sale?.id || salesOrderId || referenceId;
        const referenceLabel = sale
          ? formatPosSaleReference(sale)
          : salesOrder?.orderNumber || purchaseOrder?.orderNumber
            || ("#" + referenceId.slice(0, 8));

        return {
          id: transaction.id,
          kind: "ledger",
          createdAt: transaction.createdAt,
          productId: transaction.productId,
          storageId: transaction.storageId,
          sourceRecordId,
          referenceLabel,
          transactionType: transaction.transactionType,
          movementSource,
          sourceKind: movementSource === "transfer" && transaction.referenceType === "reorder_transfer"
            ? "automation"
            : movementSource === "transfer"
              ? "manual"
              : undefined,
          quantityDelta: transaction.quantityDelta,
          previousQuantity: transaction.previousQuantity,
          newQuantity: transaction.newQuantity,
        };
      })
      .filter((record) => !productsById.get(record.productId)?.isService)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
      );
  }, [
    inventoryTransactions,
    productsById,
    purchaseOrders,
    sales,
    salesOrderReturnItems,
    salesOrders,
  ]);
  const dateScopedActivityRecords = useMemo(
    () =>
      activityRecords.filter((record) =>
        isDateInDateRange(record.createdAt, inventoryDateRange, customDates),
      ),
    [activityRecords, customDates, inventoryDateRange],
  );

  const filteredActivityRecords = useMemo(
    () =>
      dateScopedActivityRecords.filter((record) =>
        matchesInventoryTransactionFilters(
          record,
          filters,
          activeWorkspace?.id,
        ),
      ),
    [activeWorkspace?.id, dateScopedActivityRecords, filters],
  );

  const activeFilterCount = [
    filters.productId,
    filters.direction !== "all",
    filters.source !== "all",
    filters.storageId,
    filters.snapshot !== "all",
  ].filter(Boolean).length;

  const selectedDraftProduct = draftFilters.productId
    ? productsById.get(draftFilters.productId)
    : undefined;

  const productMovementSummary = useMemo(() => {
    const summaries = new Map<
      string,
      {
        productId: string;
        productName: string;
        sku: string | null;
        unit: string | null;
        incoming: number;
        outgoing: number;
      }
    >();

    for (const record of filteredActivityRecords) {
      let incoming = 0;
      let outgoing = 0;

      if (record.kind === "ledger") {
        if (record.quantityDelta > 0) {
          incoming = record.quantityDelta;
        } else {
          outgoing = Math.abs(record.quantityDelta);
        }
      } else if (record.kind === "adjustment") {
        if (record.adjustmentType === "increase") {
          incoming = record.quantity;
        } else {
          outgoing = record.quantity;
        }
      } else {
        const isCrossWorkspaceTransfer =
          Boolean(record.sourceWorkspaceId) &&
          Boolean(record.destinationWorkspaceId) &&
          record.sourceWorkspaceId !== record.destinationWorkspaceId;

        if (!isCrossWorkspaceTransfer) {
          incoming = record.quantity;
          outgoing = record.quantity;
        } else if (record.destinationWorkspaceId === activeWorkspace?.id) {
          incoming = record.quantity;
        } else {
          outgoing = record.quantity;
        }
      }

      const existing = summaries.get(record.productId);
      if (existing) {
        existing.incoming += incoming;
        existing.outgoing += outgoing;
        continue;
      }

      const product = productsById.get(record.productId);
      summaries.set(record.productId, {
        productId: record.productId,
        productName:
          product?.name ||
          t("inventoryTransfer.transactions.unknownProduct", "Unknown product"),
        sku: product?.sku || null,
        unit: product?.unit || null,
        incoming,
        outgoing,
      });
    }

    return Array.from(summaries.values())
      .map((summary) => ({
        ...summary,
        balance: summary.incoming - summary.outgoing,
      }))
      .sort((left, right) =>
        left.productName.localeCompare(right.productName, undefined, {
          sensitivity: "base",
        }),
      );
  }, [activeWorkspace?.id, filteredActivityRecords, productsById, t]);

  const productSummaryExportRows = useMemo(
    () =>
      productMovementSummary.map((summary) => ({
        [t("inventoryTransactions.productSummary.name", "Name")]:
          summary.productName,
        [t("inventoryTransactions.productSummary.sku", "SKU")]:
          summary.sku || "",
        [t("inventoryTransactions.productSummary.unit", "Unit")]:
          summary.unit || "",
        [t("inventoryTransactions.productSummary.incoming", "Incoming")]:
          summary.incoming,
        [t("inventoryTransactions.productSummary.outgoing", "Outgoing")]:
          summary.outgoing,
        [t("inventoryTransactions.productSummary.balance", "Balance")]:
          summary.balance,
      })),
    [productMovementSummary, t],
  );

  const getLedgerMovementLabel = (
    record: Extract<InventoryActivityRecord, { kind: "ledger" }>,
  ) => {
    switch (record.movementSource) {
      case "pos-sale":
        return t("inventoryTransactions.posSaleLabel", "POS Sale");
      case "pos-return":
        return t("inventoryTransactions.posReturnLabel", "POS Return");
      case "sales-order":
        return t("inventoryTransactions.salesOrderLabel", "Sales Order");
      case "sales-order-return":
        return t(
          "inventoryTransactions.salesOrderReturnLabel",
          "Sales Order Return",
        );
      case "purchase-order":
        return t(
          "inventoryTransactions.purchaseOrderReceiptLabel",
          "Purchase Order Receipt",
        );
      case "transfer":
        return t("inventoryTransactions.transferLabel", "Inventory Transfer");
      case "stock-adjustment":
        return t("inventoryTransactions.adjustmentLabel", "Stock Adjustment");
      case "initial-stock":
        return t("inventoryTransactions.initialStockLabel", "Initial Stock");
      case "inventory-change":
        return t("inventoryTransactions.inventoryChangeLabel", "Inventory Change");
      case "sale-product-exchange":
        return t("inventoryTransactions.exchangeOutLabel", "Exchange Replacement");
      case "sale-product-exchange-return":
        return t("inventoryTransactions.exchangeReturnLabel", "Exchange Return");
    }
  };

  const getMovementFilterLabel = (source: InventoryMovementSourceFilter) => {
    switch (source) {
      case "stock-adjustment":
        return t("inventoryTransactions.filters.sources.stockAdjustment", "Stock adjustment");
      case "transfer":
        return t("inventoryTransactions.filters.sources.transfer", "Transfer");
      case "pos-sale":
        return t("inventoryTransactions.posSaleLabel", "POS Sale");
      case "pos-return":
        return t("inventoryTransactions.posReturnLabel", "POS Return");
      case "sales-order":
        return t("inventoryTransactions.salesOrderLabel", "Sales Order");
      case "sales-order-return":
        return t(
          "inventoryTransactions.salesOrderReturnLabel",
          "Sales Order Return",
        );
      case "purchase-order":
        return t(
          "inventoryTransactions.purchaseOrderReceiptLabel",
          "Purchase Order Receipt",
        );
      case "initial-stock":
        return t("inventoryTransactions.initialStockLabel", "Initial Stock");
      case "inventory-change":
        return t("inventoryTransactions.inventoryChangeLabel", "Inventory Change");
      case "sale-product-exchange":
        return t("inventoryTransactions.exchangeOutLabel", "Exchange Replacement");
      case "sale-product-exchange-return":
        return t("inventoryTransactions.exchangeReturnLabel", "Exchange Return");
      case "all":
        return t("inventoryTransactions.filters.allSources", "All sources");
    }
  };

  const openFilterDialog = () => {
    setDraftFilters(filters);
    setIsFilterDialogOpen(true);
  };

  const clearFilters = () => {
    setFilters(DEFAULT_INVENTORY_TRANSACTION_FILTERS);
    setDraftFilters(DEFAULT_INVENTORY_TRANSACTION_FILTERS);
  };

  const getLedgerDetailAction = (
    record: Extract<InventoryActivityRecord, { kind: "ledger" }>,
  ) => {
    if (
      record.movementSource === "pos-sale" ||
      record.movementSource === "pos-return"
    ) {
      return {
        label: t("inventoryTransactions.actions.viewPosSale", "View POS sale"),
        onSelect: () => {
          setPendingSaleDetailsId(record.sourceRecordId);
          navigate("/sales");
        },
      };
    }

    if (
      record.movementSource === "sales-order" ||
      record.movementSource === "sales-order-return"
    ) {
      return {
        label: t(
          "inventoryTransactions.actions.viewSalesOrder",
          "View sales order",
        ),
        onSelect: () => navigate(`/orders/${record.sourceRecordId}`),
      };
    }

    return null;
  };

  const transactionStats = useMemo(() => {
    const manualCount = filteredActivityRecords.filter(
      (record) =>
        record.kind === "adjustment" ||
        (record.kind === "transfer" && record.sourceKind === "manual") ||
        (record.kind === "ledger" && (
          record.movementSource === "stock-adjustment" ||
          (record.movementSource === "transfer" && record.sourceKind === "manual")
        )),
    ).length;
    const automationCount = filteredActivityRecords.filter(
      (record) => (record.kind === "transfer" && record.sourceKind === "automation")
        || (record.kind === "ledger" && record.movementSource === "transfer" && record.sourceKind === "automation"),
    ).length;
    const totalUnits = filteredActivityRecords.reduce(
      (sum, record) =>
        sum +
        (record.kind === "ledger"
          ? Math.abs(record.quantityDelta)
          : record.quantity),
      0,
    );

    return {
      totalCount: filteredActivityRecords.length,
      manualCount,
      automationCount,
      totalUnits,
    };
  }, [filteredActivityRecords]);

  if (isProductSummaryExportOpen) {
    return (
      <ExportPreviewModal
        isOpen={isProductSummaryExportOpen}
        onClose={() => setIsProductSummaryExportOpen(false)}
        type="inventory-product-summary"
        records={productSummaryExportRows}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <History className="h-6 w-6 text-primary" />
          {t("inventoryTransfer.transactions.title", "Inventory Transactions")}
          <DateRangeBadge dateRange={inventoryDateRange} customDates={customDates} />
        </h1>
        <p className="text-muted-foreground">
          {t(
            "inventoryTransactions.pageSubtitle",
        "Review permanent records for transfers, adjustments, sales, returns, and purchase receipts.",
          )} <ModulePageFreshness className="ms-2" />
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_320px]">
        <Card className="rounded-3xl border shadow-sm">
          <CardHeader className="border-b bg-muted/20 p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0 xl:flex-1">
                <CardTitle className="flex items-center gap-2 text-xl">
                  <History className="h-5 w-5 text-primary" />
                  {t(
                    "inventoryTransfer.transactions.title",
                    "Inventory Transactions",
                  )}
                </CardTitle>
                <CardDescription className="mt-1.5">
                  {t(
                    "inventoryTransactions.subtitle",
                    "Every stock-changing sale, return, purchase receipt, transfer, and adjustment is recorded here. These records are permanent and cannot be deleted.",
                  )}
                </CardDescription>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <DateRangeFilters
                  dateRange={inventoryDateRange}
                  onDateRangeChange={setDateRange}
                  showAllTime={false}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 rounded-2xl px-4"
                  onClick={openFilterDialog}
                >
                  <SlidersHorizontal className="me-2 h-4 w-4" />
                  {t("inventoryTransactions.filters.title", "Filters")}
                  {activeFilterCount > 0 ? (
                    <span className="ms-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </Button>
                {activeFilterCount > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11 rounded-2xl px-4 text-muted-foreground"
                    onClick={clearFilters}
                  >
                    <RotateCcw className="me-2 h-4 w-4" />
                    {t(
                      "inventoryTransactions.filters.reset",
                      "Reset filters",
                    )}
                  </Button>
                ) : null}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6">
            <Tabs defaultValue="timeline" className="space-y-4">
              <TabsList className="grid w-full max-w-md grid-cols-2 rounded-2xl bg-muted/60 p-1">
                <TabsTrigger value="timeline" className="rounded-xl">
                  {t("inventoryTransactions.tabs.timeline", "Timeline")}
                </TabsTrigger>
                <TabsTrigger value="product-summary" className="rounded-xl">
                  {t(
                    "inventoryTransactions.tabs.productSummary",
                    "Product Summary",
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="timeline" className="mt-0">
            {filteredActivityRecords.length === 0 ? (
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
                    "Complete a sale or purchase receipt, process a return, transfer products, or record a stock adjustment to see it here.",
                  )}
                </p>
              </div>
            ) : (
              <div
                dir={isRtl ? "rtl" : "ltr"}
                className="overflow-hidden rounded-3xl border bg-card"
              >
                <div className="hidden grid-cols-[150px_minmax(180px,1.2fr)_minmax(200px,1fr)_minmax(180px,0.9fr)_120px_120px] gap-5 border-b bg-muted/40 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground lg:grid">
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
                      "inventoryTransactions.columns.beforeAfter",
                      "Before → After",
                    )}
                  </div>
                  <div>
                    {t(
                      "inventoryTransfer.transactions.columns.quantity",
                      "Change",
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
                  {filteredActivityRecords.map((record) => {
                    const product = productsById.get(record.productId);
                    const isQuantityIncrease =
                      record.kind === "adjustment"
                        ? record.adjustmentType === "increase"
                        : record.kind === "ledger"
                          ? record.quantityDelta > 0
                          : false;
                    const allocatedBatchQuantity =
                      record.kind === "transfer"
                        ? (record.batchAllocations ?? []).reduce(
                          (sum, allocation) =>
                            sum + allocation.quantity,
                          0,
                        )
                        : 0;

                    const detailAction =
                      record.kind === "ledger"
                        ? getLedgerDetailAction(record)
                        : null;

                    const row = (
                      <div
                        className="grid gap-4 px-5 py-5 transition-colors hover:bg-muted/20 lg:grid-cols-[150px_minmax(180px,1.2fr)_minmax(200px,1fr)_minmax(180px,0.9fr)_120px_120px] lg:items-center lg:gap-5"
                      >
                        <div className="text-sm">
                          <div className="font-medium">
                            {formatDateTimeLabel(record.createdAt)}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {record.kind === "ledger"
                              ? record.referenceLabel
                              : record.id.slice(0, 8)}
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
                          {record.kind === "transfer" &&
                            record.batchAllocations != null && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {record.batchAllocations.map((allocation) => (
                                  <span
                                    key={`${allocation.sourceBatchId}:${allocation.destinationBatchId}`}
                                    className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                                  >
                                    {t("sales.batchNumber", "Batch")}{" "}
                                    {allocation.batchNumber} x{" "}
                                    {allocation.quantity}
                                  </span>
                                ))}
                                {record.quantity - allocatedBatchQuantity >
                                  0 && (
                                    <span className="rounded-full border bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                      {t(
                                        "inventoryTransfer.regularStock",
                                        "Regular stock",
                                      )}{" "}
                                      x{" "}
                                      {record.quantity - allocatedBatchQuantity}
                                    </span>
                                  )}
                              </div>
                            )}
                        </div>

                        <div className="flex items-center gap-2 text-sm">
                          {record.kind === "transfer" ? (
                            <>
                              <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                                {record.sourceStorageName
                                  ? `${record.sourceStorageName}${
                                      record.sourceWorkspaceName
                                        ? ` (${record.sourceWorkspaceName})`
                                        : ""
                                    }`
                                  : getStorageDisplayName(
                                      storagesById.get(record.sourceStorageId),
                                      t,
                                    )}
                              </span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                                {record.destinationStorageName
                                  ? `${record.destinationStorageName}${
                                      record.destinationWorkspaceName
                                        ? ` (${record.destinationWorkspaceName})`
                                        : ""
                                    }`
                                  : getStorageDisplayName(
                                      storagesById.get(record.destinationStorageId),
                                      t,
                                    )}
                              </span>
                            </>
                          ) : record.kind === "adjustment" ? (
                            <>
                              {isRtl ? (
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
                              ) : (
                                <>
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
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                                    {getStorageDisplayName(
                                      storagesById.get(record.storageId),
                                      t,
                                    )}
                                  </span>
                                </>
                              )}
                            </>
                          ) : (
                            <>
                              {record.quantityDelta < 0 ? (
                                <>
                                  <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                                    {getStorageDisplayName(
                                      storagesById.get(record.storageId),
                                      t,
                                    )}
                                  </span>
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-rose-800">
                                    {getLedgerMovementLabel(record)}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span
                                    className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                                      record.transactionType === "purchase"
                                        ? "bg-emerald-100 text-emerald-800"
                                        : "bg-sky-100 text-sky-800"
                                    }`}
                                  >
                                    {getLedgerMovementLabel(record)}
                                  </span>
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                  <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                                    {getStorageDisplayName(
                                      storagesById.get(record.storageId),
                                      t,
                                    )}
                                  </span>
                                </>
                              )}
                            </>
                          )}
                        </div>

                        <div className="order-5 lg:order-none">
                          {record.kind === "ledger" ? (
                            <div className="inline-flex items-baseline gap-1.5 font-semibold tabular-nums">
                              <span
                                className={
                                  isQuantityIncrease
                                    ? "text-emerald-700"
                                    : "text-rose-700"
                                }
                              >
                                {isQuantityIncrease ? "+" : "-"}
                                {Math.abs(record.quantityDelta)}
                              </span>
                              <span className="text-xs font-medium text-muted-foreground">
                                {product?.unit ||
                                  t(
                                    "inventoryTransfer.automation.units",
                                    "Units",
                                  )}
                              </span>
                            </div>
                          ) : record.kind === "adjustment" ? (
                            <div className="inline-flex items-baseline gap-1.5 font-semibold tabular-nums">
                              <span
                                className={
                                  record.adjustmentType === "increase"
                                    ? "text-emerald-700"
                                    : "text-rose-700"
                                }
                              >
                                {record.adjustmentType === "increase" ? "+" : "−"}
                                {record.quantity}
                              </span>
                              <span className="text-xs font-medium text-muted-foreground">
                                {product?.unit ||
                                  t(
                                    "inventoryTransfer.automation.units",
                                    "Units",
                                  )}
                              </span>
                            </div>
                          ) : (
                            <div className="inline-flex items-baseline gap-1.5 font-semibold tabular-nums">
                              <span>{record.quantity}</span>
                              <span className="text-xs font-medium text-muted-foreground">
                                {product?.unit ||
                                  t(
                                    "inventoryTransfer.automation.units",
                                    "Units",
                                  )}
                              </span>
                            </div>
                          )}
                        </div>

                        <div className="order-4 lg:order-none">
                          {record.kind === "ledger" &&
                          record.previousQuantity !== null &&
                          record.newQuantity !== null ? (
                            <div
                              className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2 tabular-nums"
                              aria-label={t(
                                "stockAdjustments.history.previousToNew",
                                "{{previous}} → {{new}}",
                                {
                                  previous: record.previousQuantity,
                                  new: record.newQuantity,
                                },
                              )}
                            >
                              <span className="grid gap-0.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {t("inventoryTransactions.columns.before", "Before")}
                                </span>
                                <span className="text-sm font-semibold">
                                  {record.previousQuantity}
                                </span>
                              </span>
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                              <span className="grid gap-0.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {t("inventoryTransactions.columns.after", "After")}
                                </span>
                                <span
                                  className={`text-sm font-semibold ${
                                    isQuantityIncrease
                                      ? "text-emerald-700"
                                      : "text-rose-700"
                                  }`}
                                >
                                  {record.newQuantity}
                                </span>
                              </span>
                            </div>
                          ) : record.kind === "adjustment" ? (
                            <div
                              className="inline-flex items-center gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2 tabular-nums"
                              aria-label={t(
                                "stockAdjustments.history.previousToNew",
                                "{{previous}} → {{new}}",
                                {
                                  previous: record.previousQuantity,
                                  new: record.newQuantity,
                                },
                              )}
                            >
                              <span className="grid gap-0.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {t(
                                    "inventoryTransactions.columns.before",
                                    "Before",
                                  )}
                                </span>
                                <span className="text-sm font-semibold">
                                  {record.previousQuantity}
                                </span>
                              </span>
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                              <span className="grid gap-0.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  {t(
                                    "inventoryTransactions.columns.after",
                                    "After",
                                  )}
                                </span>
                                <span
                                  className={`text-sm font-semibold ${
                                    record.adjustmentType === "increase"
                                      ? "text-emerald-700"
                                      : "text-rose-700"
                                  }`}
                                >
                                  {record.newQuantity}
                                </span>
                              </span>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              {t(
                                "inventoryTransactions.columns.notRecorded",
                                "Not recorded",
                              )}
                            </span>
                          )}
                        </div>

                        <div className="order-6 lg:order-none">
                          {record.kind === "ledger" ? (
                            <span
                              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                                record.transactionType === "sale"
                                  ? "bg-rose-100 text-rose-800"
                                  : record.transactionType === "purchase"
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-sky-100 text-sky-800"
                              }`}
                            >
                              <Boxes className="h-3.5 w-3.5" />
                              {getLedgerMovementLabel(record)}
                            </span>
                          ) : record.kind === "transfer" ? (
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

                    if (!detailAction) {
                      return <div key={`${record.kind}:${record.id}`}>{row}</div>;
                    }

                    return (
                      <ContextMenu key={`${record.kind}:${record.id}`}>
                        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onSelect={detailAction.onSelect}>
                            {detailAction.label}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </div>
              </div>
            )}
              </TabsContent>

              <TabsContent value="product-summary" className="mt-0">
                {productMovementSummary.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-muted-foreground/30 bg-muted/10 px-6 py-12 text-center">
                    <Boxes className="mx-auto mb-4 h-10 w-10 text-primary/70" />
                    <h3 className="text-lg font-semibold">
                      {t(
                        "inventoryTransactions.productSummary.emptyTitle",
                        "No product movement in this period",
                      )}
                    </h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t(
                        "inventoryTransactions.productSummary.emptyDescription",
                        "Change the date range or record inventory movement to see a product summary.",
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        allowViewer={true}
                        onClick={() => setIsProductSummaryExportOpen(true)}
                        className="h-10 gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-5 text-[10px] font-black uppercase tracking-widest text-emerald-700 transition-all hover:bg-emerald-100 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] active:scale-95 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/20"
                      >
                        <FileSpreadsheet className="h-4 w-4" />
                        {t("sales.export.button", "Excel Export")}
                      </Button>
                    </div>
                    <div
                      dir={pageDirection}
                      className="overflow-x-auto rounded-3xl border bg-card"
                    >
                      <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="text-start">
                            {t(
                              "inventoryTransactions.productSummary.name",
                              "Name",
                            )}
                          </TableHead>
                          <TableHead className="text-end">
                            {t(
                              "inventoryTransactions.productSummary.incoming",
                              "Incoming",
                            )}
                          </TableHead>
                          <TableHead className="text-end">
                            {t(
                              "inventoryTransactions.productSummary.outgoing",
                              "Outgoing",
                            )}
                          </TableHead>
                          <TableHead className="text-end">
                            {t(
                              "inventoryTransactions.productSummary.balance",
                              "Balance",
                            )}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {productMovementSummary.map((summary) => (
                          <TableRow key={summary.productId}>
                            <TableCell className="text-start">
                              <div className="font-semibold">
                                {summary.productName}
                              </div>
                              {(summary.sku || summary.unit) && (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {summary.sku ? `SKU: ${summary.sku}` : null}
                                  {summary.sku && summary.unit ? " · " : null}
                                  {summary.unit || null}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-end font-semibold tabular-nums text-emerald-700">
                              {formatSignedQuantity(summary.incoming)}
                            </TableCell>
                            <TableCell className="text-end font-semibold tabular-nums text-rose-700">
                              {summary.outgoing > 0
                                ? `-${summary.outgoing}`
                                : "0"}
                            </TableCell>
                            <TableCell
                              className={`text-end font-semibold tabular-nums ${
                                summary.balance > 0
                                  ? "text-emerald-700"
                                  : summary.balance < 0
                                    ? "text-rose-700"
                                    : "text-muted-foreground"
                              }`}
                            >
                              {formatSignedQuantity(summary.balance)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>
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

      <Dialog
        open={isFilterDialogOpen}
        onOpenChange={(open) => {
          setIsFilterDialogOpen(open);
          if (open) {
            setDraftFilters(filters);
          }
        }}
      >
        <DialogContent className="top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] w-[calc(100vw-0.75rem)] max-w-2xl overflow-hidden rounded-[2rem] border-border/60 p-0 sm:w-[calc(100vw-2rem)]">
          <div className="flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-1rem)] flex-col">
          <DialogHeader className="border-b border-border/60 bg-gradient-to-r from-primary/8 via-background to-emerald-500/5 px-6 py-5 text-start">
            <DialogTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5" />
              {t("inventoryTransactions.filters.title", "Filters")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "inventoryTransactions.filters.description",
                "Narrow both the timeline and product summary within the current date range.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="grid gap-5">
            <div className="space-y-2">
              <Label isLoading={products.isLoading}>
                {t("inventoryTransactions.filters.product", "Product")}
              </Label>
              <ProductAutocompleteInput
                value={draftFilters.productSearch}
                onChange={(value) =>
                  setDraftFilters((current) => ({
                    ...current,
                    productId: null,
                    productSearch: value,
                  }))
                }
                onSelectProduct={(product) =>
                  setDraftFilters((current) => ({
                    ...current,
                    productId: product.id,
                    productSearch: product.name,
                  }))
                }
                products={products}
                isLoading={products.isLoading}
                placeholder={t(
                  "inventoryTransactions.filters.selectProduct",
                  "Search by name or SKU",
                )}
                hasSelection={Boolean(draftFilters.productId)}
                linkedLabel={t(
                  "inventoryTransactions.filters.linked",
                  "Linked",
                )}
                linkedTooltip={t(
                  "inventoryTransactions.filters.linkedTooltip",
                  "This product is linked to the active filter.",
                )}
                skuLabel={t("inventoryTransactions.filters.sku", "SKU")}
              />
              {selectedDraftProduct ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto rounded-full bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-500/15 hover:text-emerald-800 dark:text-emerald-400"
                  onClick={() => navigate(`/products/${selectedDraftProduct.id}`)}
                >
                  <Link2 className="me-1.5 h-3.5 w-3.5" />
                  {t(
                    "inventoryTransactions.filters.openLinkedProduct",
                    "Linked: {{name}}",
                    { name: selectedDraftProduct.name },
                  )}
                </Button>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>
                  {t("inventoryTransactions.filters.direction", "Direction")}
                </Label>
                <Select
                  value={draftFilters.direction}
                  onValueChange={(value: InventoryMovementDirectionFilter) =>
                    setDraftFilters((current) => ({
                      ...current,
                      direction: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t(
                        "inventoryTransactions.filters.allDirections",
                        "All directions",
                      )}
                    </SelectItem>
                    <SelectItem value="incoming">
                      {t("inventoryTransactions.filters.incoming", "Incoming")}
                    </SelectItem>
                    <SelectItem value="outgoing">
                      {t("inventoryTransactions.filters.outgoing", "Outgoing")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>
                  {t("inventoryTransactions.filters.source", "Movement source")}
                </Label>
                <Select
                  value={draftFilters.source}
                  onValueChange={(value: InventoryMovementSourceFilter) =>
                    setDraftFilters((current) => ({ ...current, source: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      [
                        "all",
                        "stock-adjustment",
                        "transfer",
                        "pos-sale",
                        "pos-return",
                        "sales-order",
                        "sales-order-return",
                        "purchase-order",
                        "initial-stock",
                        "inventory-change",
                        "sale-product-exchange",
                        "sale-product-exchange-return",
                      ] as InventoryMovementSourceFilter[]
                    ).map((source) => (
                      <SelectItem key={source} value={source}>
                        {getMovementFilterLabel(source)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>
                  {t("inventoryTransactions.filters.storage", "Storage")}
                </Label>
                <Select
                  value={draftFilters.storageId || "all"}
                  onValueChange={(value) =>
                    setDraftFilters((current) => ({
                      ...current,
                      storageId: value === "all" ? null : value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t("inventoryTransactions.filters.allStorages", "All storages")}
                    </SelectItem>
                    {storages.map((storage) => (
                      <SelectItem key={storage.id} value={storage.id}>
                        {getStorageDisplayName(storage, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>
                  {t(
                    "inventoryTransactions.filters.snapshot",
                    "Before/after status",
                  )}
                </Label>
                <Select
                  value={draftFilters.snapshot}
                  onValueChange={(value: InventorySnapshotFilter) =>
                    setDraftFilters((current) => ({
                      ...current,
                      snapshot: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t("inventoryTransactions.filters.anySnapshot", "Any status")}
                    </SelectItem>
                    <SelectItem value="recorded">
                      {t("inventoryTransactions.filters.recorded", "Recorded")}
                    </SelectItem>
                    <SelectItem value="not-recorded">
                      {t(
                        "inventoryTransactions.filters.notRecorded",
                        "Not recorded",
                      )}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          </div>

          <DialogFooter className="border-t border-border/60 bg-background/95 px-6 py-4 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraftFilters(DEFAULT_INVENTORY_TRANSACTION_FILTERS)}
            >
              <RotateCcw className="me-2 h-4 w-4" />
              {t("inventoryTransactions.filters.resetDraft", "Reset draft")}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsFilterDialogOpen(false)}
              >
                {t("common.cancel", "Cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setFilters(draftFilters);
                  setIsFilterDialogOpen(false);
                }}
              >
                {t("inventoryTransactions.filters.apply", "Apply filters")}
              </Button>
            </div>
          </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default InventoryTransactionsPage;
