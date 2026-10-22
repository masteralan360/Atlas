import { useEffect, useMemo, useRef, useState } from "react";
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness';
import {
  ArrowRightLeft,
  AlertCircle,
  Bot,
  Boxes,
  ChevronRight,
  FileSpreadsheet,
  History,
  Loader2,
  Link2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";

import {
  fetchAllInventoryTransactionProductSummary,
  auditInventoryTransactionIntegrity,
  getInventoryTransactionMovementSource,
  useInventoryTransactionPageRelations,
  useInventoryTransactionPagesChanged,
  useInventoryTransactionProduct,
  useInventoryTransactionProductSummaryPage,
  useInventoryTransactionsPage,
  useStorageAccess,
  useStorages,
  type InventoryTransferBatchAllocation,
  type InventoryTransactionListFilters,
  type InventoryTransactionIntegrityAuditReport,
  type InventoryTransactionIntegrityAuditProgress,
  type InventoryTransactionProductSummary,
  type InventoryTransactionType,
  type Storage,
} from "@/local-db";
import { usePaginationBounds, usePaginationPageMap } from "@/hooks/usePaginationState";
import { getDateRangeBounds } from "@/lib/dateRangeFilters";
import { setPendingSaleDetailsId } from "@/lib/saleNavigation";
import { formatDateTime } from "@/lib/utils";
import { ProductAutocompleteInput } from "@/ui/components/orders/ProductAutocompleteInput";
import { ExportPreviewModal } from "@/ui/components/ExportPreviewModal";
import { Button } from "@/ui/components/button";
import { DateRangeFilters } from "@/ui/components/DateRangeFilters";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  AppPagination,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
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
  useToast,
} from "@/ui/components";
import { DateRangeBadge } from "@/ui/components/DateRangeBadge";
import { useDateRange } from "@/context/DateRangeContext";
import { useWorkspace } from "@/workspace/WorkspaceContext";

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
      sourceStorageId?: string | null;
      destinationStorageId?: string | null;
      sourceStorageName?: string | null;
      destinationStorageName?: string | null;
      sourceWorkspaceName?: string | null;
      destinationWorkspaceName?: string | null;
      sourceKind?: "manual" | "automation";
      quantityDelta: number;
      previousQuantity: number | null;
      newQuantity: number | null;
    };

type InventoryMovementDirectionFilter = InventoryTransactionListFilters["direction"];
type InventoryMovementSourceFilter = InventoryTransactionListFilters["source"];
type InventorySnapshotFilter = InventoryTransactionListFilters["snapshot"];

type InventoryTransactionFilters = InventoryTransactionListFilters & {
  productSearch: string;
};

const DEFAULT_INVENTORY_TRANSACTION_FILTERS: InventoryTransactionFilters = {
  productId: null,
  productSearch: "",
  direction: "all",
  source: "all",
  storageId: null,
  snapshot: "all",
};

type MirroredSale = {
  id: string;
  createdAt: string;
  sequenceId?: number;
};

const INVENTORY_TRANSACTION_PAGE_SIZE_OPTIONS = [20, 50, 100];
const INITIAL_INVENTORY_TRANSACTION_PAGES = {
  timeline: 1,
  productSummary: 1,
  integrityAudit: 1,
};

type InventoryTransactionIntegrityAuditState =
  | ({ status: "running" | "cancelled" } & InventoryTransactionIntegrityAuditProgress)
  | { status: "complete"; report: InventoryTransactionIntegrityAuditReport }
  | { status: "error" };

function getSavedInventoryTransactionPageSize() {
  if (typeof localStorage === "undefined") return 20;
  const saved = Number(localStorage.getItem("inventory_transactions_page_size"));
  return INVENTORY_TRANSACTION_PAGE_SIZE_OPTIONS.includes(saved) ? saved : 20;
}

function formatPosSaleReference(sale: MirroredSale) {
  return sale.sequenceId
    ? `#${String(sale.sequenceId).padStart(5, "0")}`
    : `#${sale.id.slice(0, 8)}`;
}

function formatSignedQuantity(quantity: number) {
  return quantity > 0 ? `+${quantity}` : quantity < 0 ? `${quantity}` : "0";
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
  const { toast } = useToast();
  const { activeWorkspace } = useWorkspace();
  const { dateRange, customDates, setDateRange } = useDateRange();
  const online = useNetworkStatus();
  const inventoryDateRange = dateRange === "allTime" ? "month" : dateRange;
  const pageDirection =
    typeof document === "undefined"
      ? i18n.dir(i18n.resolvedLanguage || i18n.language)
      : document.documentElement.dir || document.dir || "ltr";
  const isRtl = pageDirection === "rtl";
  const storages = useStorages(activeWorkspace?.id);
  const [filters, setFilters] = useState<InventoryTransactionFilters>(
    DEFAULT_INVENTORY_TRANSACTION_FILTERS,
  );
  const [draftFilters, setDraftFilters] =
    useState<InventoryTransactionFilters>(DEFAULT_INVENTORY_TRANSACTION_FILTERS);
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"timeline" | "product-summary">("timeline");
  const [isProductSummaryExportOpen, setIsProductSummaryExportOpen] =
    useState(false);
  const [isProductSummaryExporting, setIsProductSummaryExporting] = useState(false);
  const [productSummaryExportRows, setProductSummaryExportRows] = useState<Record<string, unknown>[]>([]);
  const [integrityAudit, setIntegrityAudit] =
    useState<InventoryTransactionIntegrityAuditState | null>(null);
  const integrityAuditController = useRef<AbortController | null>(null);

  useInventoryTransactionPagesChanged(activeWorkspace?.id);
  const storageAccess = useStorageAccess(activeWorkspace?.id);

  const pagination = usePaginationPageMap({
    initialPages: INITIAL_INVENTORY_TRANSACTION_PAGES,
    initialPageSize: getSavedInventoryTransactionPageSize(),
    resetOn: [
      activeWorkspace?.id,
      inventoryDateRange,
      customDates.start,
      customDates.end,
      filters.productId,
      filters.direction,
      filters.source,
      filters.storageId,
      filters.snapshot,
    ],
    onPageSizeChange: (pageSize) => {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("inventory_transactions_page_size", String(pageSize));
      }
    },
  });

  const dateBounds = useMemo(
    () => getDateRangeBounds(inventoryDateRange, customDates),
    [customDates, inventoryDateRange],
  );
  const listFilters = useMemo<InventoryTransactionListFilters>(() => ({
    productId: filters.productId,
    direction: filters.direction,
    source: filters.source,
    storageId: filters.storageId,
    snapshot: filters.snapshot,
  }), [filters.direction, filters.productId, filters.snapshot, filters.source, filters.storageId]);
  const listQueryBase = useMemo(() => ({
    workspaceId: activeWorkspace?.id,
    startAt: dateBounds.start?.toISOString(),
    endBefore: dateBounds.end?.toISOString(),
    filters: listFilters,
  }), [activeWorkspace?.id, dateBounds.end, dateBounds.start, listFilters]);
  const integrityAuditScopeKey = JSON.stringify([
    activeWorkspace?.id ?? null,
    listQueryBase.startAt ?? null,
    listQueryBase.endBefore ?? null,
    filters.productId,
    filters.direction,
    filters.source,
    filters.storageId,
    filters.snapshot,
    storageAccess.signature,
    online,
  ]);

  useEffect(() => {
    integrityAuditController.current?.abort();
    integrityAuditController.current = null;
    setIntegrityAudit(null);
    pagination.setPage("integrityAudit", 1);
    return () => integrityAuditController.current?.abort();
  }, [integrityAuditScopeKey, pagination.setPage]);

  const timelineQuery = useInventoryTransactionsPage({
    ...listQueryBase,
    page: pagination.pages.timeline,
    pageSize: pagination.pageSize,
  }, true, online);
  const timelinePagination = usePaginationBounds({
    currentPage: pagination.pages.timeline,
    setCurrentPage: (page) => pagination.setPage("timeline", page),
    totalCount: timelineQuery.data?.totalCount ?? 0,
    pageSize: pagination.pageSize,
    pageCount: timelineQuery.data?.pageCount,
    isLoading: timelineQuery.isPending,
    error: timelineQuery.error,
  });
  const summaryQuery = useInventoryTransactionProductSummaryPage({
    ...listQueryBase,
    page: pagination.pages.productSummary,
    pageSize: pagination.pageSize,
  }, activeTab === "product-summary", online);
  const summaryPagination = usePaginationBounds({
    currentPage: pagination.pages.productSummary,
    setCurrentPage: (page) => pagination.setPage("productSummary", page),
    totalCount: summaryQuery.data?.totalCount ?? 0,
    pageSize: pagination.pageSize,
    pageCount: summaryQuery.data?.pageCount,
    isLoading: summaryQuery.isPending,
    error: summaryQuery.error,
  });
  const integrityAuditReport = integrityAudit?.status === "complete"
    ? integrityAudit.report
    : null;
  const integrityAuditPagination = usePaginationBounds({
    currentPage: pagination.pages.integrityAudit,
    setCurrentPage: (page) => pagination.setPage("integrityAudit", page),
    totalCount: integrityAuditReport?.issues.length ?? 0,
    pageSize: pagination.pageSize,
  });
  const visibleIntegrityAuditIssues = useMemo(() => {
    if (!integrityAuditReport) return [];
    const startIndex = (integrityAuditPagination.currentPage - 1) * pagination.pageSize;
    return integrityAuditReport.issues.slice(startIndex, startIndex + pagination.pageSize);
  }, [integrityAuditPagination.currentPage, integrityAuditReport, pagination.pageSize]);

  const inventoryTransactions = timelineQuery.data?.rows ?? [];
  const relations = useInventoryTransactionPageRelations(
    inventoryTransactions,
    activeWorkspace?.id,
    online,
  );
  const productsById = useMemo(
    () => new Map((relations?.products ?? []).map((product) => [product.id, product] as const)),
    [relations?.products],
  );
  const storagesById = useMemo(
    () => new Map((relations?.storages ?? []).map((storage) => [storage.id, storage] as const)),
    [relations?.storages],
  );
  const transferBatchesById = useMemo(
    () => new Map((relations?.transferBatches ?? []).map((batch) => [batch.id, batch] as const)),
    [relations?.transferBatches],
  );

  const activityRecords = useMemo(() => {
    const typedSales = (relations?.sales ?? []) as MirroredSale[];
    const salesById = new Map(typedSales.map((sale) => [sale.id, sale] as const));
    const saleReturnsById = new Map(
      (relations?.saleReturns ?? []).map((saleReturn) => [saleReturn.id, saleReturn] as const),
    );
    const salesOrdersById = new Map(
      (relations?.salesOrders ?? []).map((order) => [order.id, order] as const),
    );
    const salesOrderReturnsById = new Map(
      (relations?.salesOrderReturnItems ?? []).map((returnItem) => [returnItem.returnId, returnItem] as const),
    );
    const purchaseOrdersById = new Map(
      (relations?.purchaseOrders ?? []).map((order) => [order.id, order] as const),
    );

    return inventoryTransactions.map((transaction): InventoryActivityRecord => {
      const movementSource = getInventoryTransactionMovementSource(
        transaction.transactionType,
        transaction.referenceType,
      );
      const referenceId = transaction.referenceId || transaction.id;
      const transferBatch = movementSource === "transfer"
        ? transferBatchesById.get(transaction.transferBatchId || referenceId)
        : undefined;
      const saleId = movementSource === "pos-return"
        ? saleReturnsById.get(referenceId)?.saleId
        : undefined;
      const sale = movementSource === "pos-sale"
        ? salesById.get(referenceId)
        : saleId
          ? salesById.get(saleId)
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
        ...(movementSource === "transfer" ? {
          sourceStorageId: transferBatch?.sourceStorageId ?? (
            transaction.transactionType === "transfer_out" ? transaction.storageId : null
          ),
          destinationStorageId: transferBatch?.destinationStorageId ?? (
            transaction.transactionType === "transfer_in" ? transaction.storageId : null
          ),
          sourceStorageName: transferBatch?.sourceStorageName,
          destinationStorageName: transferBatch?.destinationStorageName,
          sourceWorkspaceName: transferBatch?.sourceWorkspaceName,
          destinationWorkspaceName: transferBatch?.destinationWorkspaceName,
        } : {}),
        sourceKind: movementSource === "transfer" && transaction.referenceType === "reorder_transfer"
          ? "automation"
          : movementSource === "transfer"
            ? "manual"
            : undefined,
        quantityDelta: transaction.quantityDelta,
        previousQuantity: transaction.previousQuantity,
        newQuantity: transaction.newQuantity,
      };
    });
  }, [inventoryTransactions, relations, transferBatchesById]);

  const productMovementSummary = summaryQuery.data?.rows ?? [];
  const activeFilterCount = [
    filters.productId,
    filters.direction !== "all",
    filters.source !== "all",
    filters.storageId,
    filters.snapshot !== "all",
  ].filter(Boolean).length;
  const selectedDraftProduct = useInventoryTransactionProduct(
    activeWorkspace?.id,
    draftFilters.productId,
  );
  const timelineTableColumns = useMemo<ColumnDef<InventoryActivityRecord>[]>(() => [
    { id: "createdAt", accessorFn: (record) => record.createdAt },
    { id: "id", accessorFn: (record) => record.id },
    { id: "productId", accessorFn: (record) => record.productId },
    { id: "movementSource", accessorFn: (record) => record.kind === "ledger" ? record.movementSource : "" },
    { id: "quantity", accessorFn: (record) => record.kind === "ledger" ? record.quantityDelta : 0 },
  ], []);
  const summaryTableColumns = useMemo<ColumnDef<InventoryTransactionProductSummary>[]>(() => [
    { id: "productId", accessorFn: (summary) => summary.productId },
    { id: "incoming", accessorFn: (summary) => summary.incoming },
    { id: "outgoing", accessorFn: (summary) => summary.outgoing },
    { id: "balance", accessorFn: (summary) => summary.balance },
  ], []);
  const timelineTable = useReactTable({
    data: activityRecords,
    columns: timelineTableColumns,
    getRowId: (record) => record.id,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: timelineQuery.data?.totalCount ?? 0,
    state: {
      pagination: {
        pageIndex: timelinePagination.currentPage - 1,
        pageSize: pagination.pageSize,
      },
      sorting: [
        { id: "createdAt", desc: true },
        { id: "id", desc: true },
      ],
      columnFilters: [
        { id: "productId", value: filters.productId },
        { id: "direction", value: filters.direction },
        { id: "movementSource", value: filters.source },
        { id: "storageId", value: filters.storageId },
        { id: "snapshot", value: filters.snapshot },
      ],
    },
  });
  const summaryTable = useReactTable({
    data: productMovementSummary,
    columns: summaryTableColumns,
    getRowId: (summary) => summary.productId,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: summaryQuery.data?.totalCount ?? 0,
    state: {
      pagination: {
        pageIndex: summaryPagination.currentPage - 1,
        pageSize: pagination.pageSize,
      },
      sorting: [{ id: "productId", desc: false }],
      columnFilters: [
        { id: "productId", value: filters.productId },
        { id: "direction", value: filters.direction },
        { id: "movementSource", value: filters.source },
        { id: "storageId", value: filters.storageId },
        { id: "snapshot", value: filters.snapshot },
      ],
    },
  });

  const openProductSummaryExport = async () => {
    if (!activeWorkspace?.id || isProductSummaryExporting) return;
    setIsProductSummaryExporting(true);
    try {
      const summaryRows = await fetchAllInventoryTransactionProductSummary({
        ...listQueryBase,
        page: 1,
        pageSize: 250,
      }, storageAccess, online);
      setProductSummaryExportRows(summaryRows.map((summary) => ({
        [t("inventoryTransactions.productSummary.name", "Name")]:
          summary.productName || t("inventoryTransfer.transactions.unknownProduct", "Unknown product"),
        [t("inventoryTransactions.productSummary.sku", "SKU")]: summary.sku || "",
        [t("inventoryTransactions.productSummary.unit", "Unit")]: summary.unit || "",
        [t("inventoryTransactions.productSummary.incoming", "Incoming")]: summary.incoming,
        [t("inventoryTransactions.productSummary.outgoing", "Outgoing")]: summary.outgoing,
        [t("inventoryTransactions.productSummary.balance", "Balance")]: summary.balance,
      })));
      setIsProductSummaryExportOpen(true);
    } catch {
      toast({
        title: t("common.error", "Something went wrong"),
        description: t(
          "inventoryTransactions.productSummary.exportError",
          "The product summary could not be prepared. Please try again.",
        ),
        variant: "destructive",
      });
    } finally {
      setIsProductSummaryExporting(false);
    }
  };

  const startInventoryTransactionIntegrityAudit = async () => {
    if (
      !activeWorkspace?.id ||
      storageAccess.isReady === false ||
      integrityAuditController.current
    ) {
      return;
    }

    const controller = new AbortController();
    integrityAuditController.current = controller;
    setIntegrityAudit({
      status: "running",
      checkedCount: 0,
      totalCount: timelineQuery.data?.totalCount ?? null,
    });

    try {
      const report = await auditInventoryTransactionIntegrity(
        {
          ...listQueryBase,
          page: 1,
          pageSize: 250,
        },
        storageAccess,
        {
          signal: controller.signal,
          online,
          expectedTotalCount: timelineQuery.data?.totalCount,
          onProgress: (progress) => {
            if (integrityAuditController.current !== controller) return;
            setIntegrityAudit({ status: "running", ...progress });
          },
        },
      );
      if (integrityAuditController.current !== controller) return;
      setIntegrityAudit({ status: "complete", report });
      pagination.setPage("integrityAudit", 1);
    } catch {
      if (integrityAuditController.current !== controller) return;
      setIntegrityAudit(controller.signal.aborted ? {
        status: "cancelled",
        checkedCount: 0,
        totalCount: null,
      } : { status: "error" });
    } finally {
      if (integrityAuditController.current === controller) {
        integrityAuditController.current = null;
      }
    }
  };

  const cancelInventoryTransactionIntegrityAudit = () => {
    const controller = integrityAuditController.current;
    if (!controller) return;
    integrityAuditController.current = null;
    controller.abort();
    setIntegrityAudit((current) => current?.status === "running"
      ? { ...current, status: "cancelled" }
      : current);
  };

  const formatAuditQuantity = (value: number | null) => value === null
    ? t("inventoryTransactions.integrityAudit.notAvailable", "—")
    : new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language, {
      maximumFractionDigits: 6,
    }).format(value);

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

  const getTransferStorageDisplayName = (
    storageId?: string | null,
    storageName?: string | null,
    workspaceName?: string | null,
  ) => {
    if (storageId && !storageAccess.canAccessStorage(storageId)) {
      return t("inventoryTransactions.transferRoute.restrictedStorage", "Restricted storage");
    }
    const name = storageName || getStorageDisplayName(
      storageId ? storagesById.get(storageId) : undefined,
      t,
    );
    return workspaceName ? `${name} (${workspaceName})` : name;
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

  const integrityAuditRunning = integrityAudit?.status === "running";

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

      <div className="grid grid-cols-1 gap-6">
        <Card className="rounded-3xl border shadow-sm">
          <CardHeader className="border-b bg-muted/20 p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0 xl:flex-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-xl">
                    <History className="h-5 w-5 text-primary" />
                    {t(
                      "inventoryTransfer.transactions.title",
                      "Inventory Transactions",
                    )}
                  </CardTitle>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 w-9 shrink-0 rounded-xl p-0"
                    aria-label={t(
                      integrityAuditRunning
                        ? "inventoryTransactions.integrityAudit.runningTitle"
                        : "inventoryTransactions.integrityAudit.action",
                      integrityAuditRunning ? "Audit in progress" : "Transactions integrity Audit",
                    )}
                    title={t(
                      "inventoryTransactions.integrityAudit.action",
                      "Transactions integrity Audit",
                    )}
                    disabled={!activeWorkspace?.id || storageAccess.isReady === false || integrityAuditRunning}
                    onClick={() => void startInventoryTransactionIntegrityAudit()}
                  >
                    {integrityAuditRunning
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <ShieldCheck className="h-4 w-4" />}
                  </Button>
                </div>
                <CardDescription className="mt-1.5">
                  {t(
                    "inventoryTransactions.subtitle",
                    "Every stock-changing sale, return, purchase receipt, transfer, and adjustment is recorded here. These records are permanent and cannot be deleted.",
                  )}
                </CardDescription>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:justify-end">
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
            <Tabs
              value={activeTab}
              onValueChange={(value) => {
                if (value === "timeline" || value === "product-summary") setActiveTab(value);
              }}
              className="space-y-4"
            >
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
                <div className="mb-4 flex justify-end">
                  <AppPagination
                    currentPage={timelinePagination.currentPage}
                    totalCount={timelineQuery.data?.totalCount ?? 0}
                    pageCount={timelinePagination.pageCount}
                    pageSize={pagination.pageSize}
                    onPageChange={(page) => pagination.setPage("timeline", page)}
                    onPageSizeChange={pagination.setPageSize}
                    pageSizeOptions={INVENTORY_TRANSACTION_PAGE_SIZE_OPTIONS}
                  />
                </div>
            {timelineQuery.isPending && activeWorkspace?.id ? (
              <div className="flex min-h-56 items-center justify-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                {t("inventoryTransactions.pagination.loading", "Loading inventory transactions…")}
              </div>
            ) : timelineQuery.error ? (
              <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-3xl border border-dashed px-6 text-center">
                <AlertCircle className="h-8 w-8 text-destructive" />
                <p className="text-sm text-muted-foreground">
                  {t("inventoryTransactions.pagination.loadError", "Inventory transactions could not be loaded. Please try again.")}
                </p>
                <Button type="button" variant="outline" onClick={() => void timelineQuery.refetch()}>
                  {t("common.retry", "Retry")}
                </Button>
              </div>
            ) : !activeWorkspace?.id || (timelineQuery.data?.totalCount ?? 0) === 0 ? (
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
                  {timelineTable.getRowModel().rows.map(({ original: record }) => {
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

                        <div className="flex flex-wrap items-center gap-2 text-sm">
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
                          ) : record.movementSource === "transfer" ? (
                            <>
                              <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                                <span className="text-muted-foreground">
                                  {t("inventoryTransactions.transferRoute.source", "Source")}: {" "}
                                </span>
                                {getTransferStorageDisplayName(
                                  record.sourceStorageId,
                                  record.sourceStorageName,
                                  record.sourceWorkspaceName,
                                )}
                              </span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180" />
                              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                                <span className="text-emerald-700">
                                  {t("inventoryTransactions.transferRoute.destination", "Destination")}: {" "}
                                </span>
                                {getTransferStorageDisplayName(
                                  record.destinationStorageId,
                                  record.destinationStorageName,
                                  record.destinationWorkspaceName,
                                )}
                              </span>
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
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <AppPagination
                    currentPage={summaryPagination.currentPage}
                    totalCount={summaryQuery.data?.totalCount ?? 0}
                    pageCount={summaryPagination.pageCount}
                    pageSize={pagination.pageSize}
                    onPageChange={(page) => pagination.setPage("productSummary", page)}
                    onPageSizeChange={pagination.setPageSize}
                    pageSizeOptions={INVENTORY_TRANSACTION_PAGE_SIZE_OPTIONS}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    allowViewer={true}
                    disabled={isProductSummaryExporting}
                    onClick={() => void openProductSummaryExport()}
                    className="h-10 gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-5 text-[10px] font-black uppercase tracking-widest text-emerald-700 transition-all hover:bg-emerald-100 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] active:scale-95 disabled:opacity-60 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/20"
                  >
                    {isProductSummaryExporting
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <FileSpreadsheet className="h-4 w-4" />}
                    {t("sales.export.button", "Excel Export")}
                  </Button>
                </div>
                {summaryQuery.isPending && activeWorkspace?.id ? (
                  <div className="flex min-h-56 items-center justify-center gap-3 text-sm text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    {t("inventoryTransactions.productSummary.loading", "Loading product summary…")}
                  </div>
                ) : summaryQuery.error ? (
                  <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-3xl border border-dashed px-6 text-center">
                    <AlertCircle className="h-8 w-8 text-destructive" />
                    <p className="text-sm text-muted-foreground">
                      {t("inventoryTransactions.productSummary.loadError", "The product summary could not be loaded. Please try again.")}
                    </p>
                    <Button type="button" variant="outline" onClick={() => void summaryQuery.refetch()}>
                      {t("common.retry", "Retry")}
                    </Button>
                  </div>
                ) : !activeWorkspace?.id || (summaryQuery.data?.totalCount ?? 0) === 0 ? (
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
                        {summaryTable.getRowModel().rows.map(({ original: summary }) => (
                          <TableRow key={summary.productId}>
                            <TableCell className="text-start">
                              <div className="font-semibold">
                                {summary.productName || t("inventoryTransfer.transactions.unknownProduct", "Unknown product")}
                              </div>
                              {(summary.sku || summary.unit) && (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {summary.sku
                                    ? `${t("inventoryTransactions.productSummary.sku", "SKU")}: ${summary.sku}`
                                    : null}
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
                )}
              </TabsContent>
            </Tabs>
            {integrityAudit ? (
              <section
                aria-live="polite"
                className="mt-6 space-y-5 rounded-3xl border bg-muted/10 p-4 sm:p-6"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-2 text-lg font-semibold">
                      {integrityAuditRunning ? (
                        <Loader2 className="h-5 w-5 animate-spin text-primary" />
                      ) : integrityAudit.status === "complete" && integrityAudit.report.inconsistentCount > 0 ? (
                        <ShieldAlert className="h-5 w-5 text-destructive" />
                      ) : integrityAudit.status === "error" ? (
                        <AlertCircle className="h-5 w-5 text-destructive" />
                      ) : (
                        <ShieldCheck className="h-5 w-5 text-emerald-600" />
                      )}
                      {integrityAuditRunning
                        ? t("inventoryTransactions.integrityAudit.runningTitle", "Audit in progress")
                        : integrityAudit.status === "complete"
                          ? integrityAudit.report.inconsistentCount > 0
                            ? t("inventoryTransactions.integrityAudit.issuesTitle", "Arithmetic inconsistencies found")
                            : t("inventoryTransactions.integrityAudit.completeTitle", "Audit complete")
                          : integrityAudit.status === "cancelled"
                            ? t("inventoryTransactions.integrityAudit.cancelledTitle", "Audit cancelled")
                            : t("inventoryTransactions.integrityAudit.errorTitle", "Audit could not be completed")}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {integrityAuditRunning ? (
                        t("inventoryTransactions.integrityAudit.progress", "Checked {{checked}} of {{total}} transactions…", {
                          checked: integrityAudit.checkedCount.toLocaleString(i18n.resolvedLanguage || i18n.language),
                          total: integrityAudit.totalCount === null
                            ? "…"
                            : integrityAudit.totalCount.toLocaleString(i18n.resolvedLanguage || i18n.language),
                        })
                      ) : integrityAudit.status === "complete" ? (
                        integrityAudit.report.inconsistentCount > 0
                          ? t("inventoryTransactions.integrityAudit.issuesDescription", "Review the transactions below; the audit compared each recorded balance with the previous balance plus the change.")
                          : t("inventoryTransactions.integrityAudit.cleanDescription", "No arithmetic inconsistencies were found among transactions with recorded quantity snapshots.")
                      ) : integrityAudit.status === "cancelled" ? (
                        t("inventoryTransactions.integrityAudit.cancelledDescription", "The audit stopped before all matching transactions were checked.")
                      ) : (
                        t("inventoryTransactions.integrityAudit.errorDescription", "The matching transactions could not all be checked. Please try again.")
                      )}
                    </p>
                  </div>
                  {integrityAuditRunning ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="shrink-0 self-start"
                      onClick={cancelInventoryTransactionIntegrityAudit}
                    >
                      {t("inventoryTransactions.integrityAudit.cancel", "Cancel audit")}
                    </Button>
                  ) : integrityAudit.status !== "complete" ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 self-start"
                      onClick={() => void startInventoryTransactionIntegrityAudit()}
                    >
                      <RotateCcw className="me-2 h-4 w-4" />
                      {t("inventoryTransactions.integrityAudit.retry", "Run again")}
                    </Button>
                  ) : null}
                </div>

                {integrityAuditRunning ? (
                  <div
                    className="h-2 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={t("inventoryTransactions.integrityAudit.progressLabel", "Audit progress")}
                    aria-valuemin={0}
                    aria-valuemax={integrityAudit.totalCount ?? undefined}
                    aria-valuenow={integrityAudit.checkedCount}
                  >
                    <div
                      className={`h-full rounded-full bg-primary transition-[width] ${integrityAudit.totalCount === null ? "w-1/3 animate-pulse" : ""}`}
                      style={integrityAudit.totalCount === null
                        ? undefined
                        : { width: `${integrityAudit.totalCount > 0
                          ? Math.min(100, (integrityAudit.checkedCount / integrityAudit.totalCount) * 100)
                          : 100}%` }}
                    />
                  </div>
                ) : null}

                {integrityAudit.status === "complete" ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                      {[
                        { key: "checked", value: integrityAudit.report.checkedCount },
                        { key: "arithmeticChecked", value: integrityAudit.report.arithmeticCheckedCount },
                        { key: "consistent", value: integrityAudit.report.consistentCount },
                        { key: "inconsistent", value: integrityAudit.report.inconsistentCount },
                        { key: "unverifiable", value: integrityAudit.report.unverifiableCount },
                      ].map(({ key, value }) => (
                        <div key={key} className="rounded-2xl border bg-background p-3">
                          <div className="text-xs text-muted-foreground">
                            {t(`inventoryTransactions.integrityAudit.stats.${key}`, key)}
                          </div>
                          <div className="mt-1 text-xl font-semibold tabular-nums">
                            {Number(value).toLocaleString(i18n.resolvedLanguage || i18n.language)}
                          </div>
                        </div>
                      ))}
                    </div>

                    {integrityAudit.report.issues.length === 0 ? (
                      <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
                        <ShieldCheck className="h-4 w-4 shrink-0" />
                        {t("inventoryTransactions.integrityAudit.noIssues", "No arithmetic inconsistencies to review.")}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex justify-end">
                          <AppPagination
                            currentPage={integrityAuditPagination.currentPage}
                            totalCount={integrityAudit.report.issues.length}
                            pageCount={integrityAuditPagination.pageCount}
                            pageSize={pagination.pageSize}
                            onPageChange={(page) => pagination.setPage("integrityAudit", page)}
                            onPageSizeChange={pagination.setPageSize}
                            pageSizeOptions={INVENTORY_TRANSACTION_PAGE_SIZE_OPTIONS}
                          />
                        </div>
                        <div className="grid gap-3">
                          {visibleIntegrityAuditIssues.map((issue) => (
                            <article key={issue.id} className="min-w-0 rounded-2xl border bg-background p-4">
                              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex min-w-0 items-center gap-2 font-semibold">
                                  <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
                                  <span className="truncate">{issue.id}</span>
                                </div>
                                <time className="text-xs text-muted-foreground">
                                  {formatDateTimeLabel(issue.createdAt) || t("inventoryTransactions.integrityAudit.notAvailable", "—")}
                                </time>
                              </div>
                              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
                                <div className="min-w-0">
                                  <dt className="text-xs text-muted-foreground">{t("inventoryTransactions.integrityAudit.fields.product", "Product ID")}</dt>
                                  <dd className="break-all font-medium">{issue.productId}</dd>
                                </div>
                                <div className="min-w-0">
                                  <dt className="text-xs text-muted-foreground">{t("inventoryTransactions.integrityAudit.fields.storage", "Storage ID")}</dt>
                                  <dd className="break-all font-medium">{issue.storageId}</dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-muted-foreground">{t("inventoryTransactions.integrityAudit.fields.previous", "Previous quantity")}</dt>
                                  <dd className="font-medium tabular-nums">{formatAuditQuantity(issue.previousQuantity)}</dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-muted-foreground">{t("inventoryTransactions.integrityAudit.fields.change", "Quantity change")}</dt>
                                  <dd className="font-medium tabular-nums">{formatAuditQuantity(issue.quantityDelta)}</dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-muted-foreground">{t("inventoryTransactions.integrityAudit.fields.expected", "Expected after")}</dt>
                                  <dd className="font-medium tabular-nums">{formatAuditQuantity(issue.expectedNewQuantity)}</dd>
                                </div>
                                <div>
                                  <dt className="text-xs text-muted-foreground">{t("inventoryTransactions.integrityAudit.fields.recorded", "Recorded after")}</dt>
                                  <dd className="font-medium tabular-nums">{formatAuditQuantity(issue.newQuantity)}</dd>
                                </div>
                              </dl>
                            </article>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : null}
              </section>
            ) : null}
          </CardContent>
        </Card>
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
              <Label>
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
