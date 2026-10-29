import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useLocation } from "wouter";
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Boxes,
  History,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthContext";
import { useWorkspace } from "@/workspace/WorkspaceContext";
import {
  createStockBatch,
  deleteStockBatch,
  updateStockBatch,
  useInventory,
  useInventoryTransactionPagesChanged,
  useInventoryTransactionsPage,
  useProducts,
  useStockAdjustmentPage,
  useStockAdjustmentPagesChanged,
  useStockBatchGroupPage,
  useStockBatchPagesChanged,
  useStorages,
  type CurrencyCode,
  type InventoryTransaction,
  type StockAdjustment,
  type StockAdjustmentReason,
  type StockAdjustmentType,
  type StockBatchGroup,
  type StockBatch,
} from "@/local-db";
import {
  cn,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatLocalDateValue,
  formatNumericInput,
  parseFormattedNumber,
  parseLocalDateValue,
  sanitizeNumericInput,
} from "@/lib/utils";
import { isPositiveQuantity } from "@/lib/quantity";
import { isService } from "@/lib/catalogItem";
import { usePaginationBounds, usePaginationPageMap } from "@/hooks/usePaginationState";
import { Button } from "@/ui/components/button";
import { DeleteConfirmationModal } from "@/ui/components/DeleteConfirmationModal";
import { StockAdjustmentDialog } from "@/ui/components/StockAdjustmentDialog";
import { Input } from "@/ui/components/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  AppPagination,
  CurrencySelector,
  DateTimePicker,
  Dialog,
  DialogBody,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from "@/ui/components";
import { ProductAutocompleteInput } from "@/ui/components/orders/ProductAutocompleteInput";
import { ProductsViewModal, ProductsViewModalTrigger } from "@/ui/components/ProductsViewModal";

type ActiveTab = "adjustments" | "batches";

type BatchFormState = {
  id?: string;
  productId: string;
  storageId: string;
  batchNumber: string;
  quantity: string;
  price: string;
  costPrice: string;
  currency: CurrencyCode;
  expiryDate: string;
  manufacturingDate: string;
  notes: string;
};

function getAdjustmentReasonOptions(
  translate: (key: string, defaultValue: string) => string,
) {
  return [
    { value: "purchase" as StockAdjustmentReason, label: translate("stockAdjustments.reasons.purchase", "Purchase") },
    { value: "return" as StockAdjustmentReason, label: translate("stockAdjustments.reasons.return", "Return") },
    { value: "correction" as StockAdjustmentReason, label: translate("stockAdjustments.reasons.correction", "Correction") },
    { value: "damage" as StockAdjustmentReason, label: translate("stockAdjustments.reasons.damage", "Damage") },
    { value: "theft" as StockAdjustmentReason, label: translate("stockAdjustments.reasons.theft", "Theft") },
    { value: "expired" as StockAdjustmentReason, label: translate("stockAdjustments.reasons.expired", "Expired") },
    { value: "production" as StockAdjustmentReason, label: translate("stockAdjustments.reasons.production", "Production") },
    { value: "other" as StockAdjustmentReason, label: translate("stockAdjustments.reasons.other", "Other") },
  ];
}

const emptyBatchForm: BatchFormState = {
  productId: "",
  storageId: "",
  batchNumber: "",
  quantity: "",
  price: "",
  costPrice: "",
  currency: "usd",
  expiryDate: "",
  manufacturingDate: "",
  notes: "",
};

const STOCK_ADJUSTMENT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function getStockAdjustmentPageSize() {
  if (typeof localStorage === "undefined") return 20;
  const stored = Number(localStorage.getItem("stock_adjustments_page_size"));
  return STOCK_ADJUSTMENT_PAGE_SIZE_OPTIONS.includes(stored) ? stored : 20;
}

function groupKey(productId: string, storageId: string) {
  return `${productId}::${storageId}`;
}

function getReasonLabel(
  reason: StockAdjustmentReason,
  translate?: (key: string, defaultValue: string, options?: Record<string, unknown>) => string,
) {
  const fallback = reason.charAt(0).toUpperCase() + reason.slice(1);
  if (!translate) {
    return fallback;
  }
  return translate(`stockAdjustments.reasons.${reason}`, fallback);
}

function getExpiryBadge(
  expiryDate?: string | null,
  t?: (key: string, defaultValue: string, options?: Record<string, unknown>) => string,
) {
  if (!expiryDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${expiryDate}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) return null;
  const days = Math.ceil((expiry.getTime() - today.getTime()) / 86400000);
  if (days < 0)
    return {
      label: t ? t("stockAdjustments.expired", "Expired") : "Expired",
      className: "border-rose-500/20 bg-rose-500/10 text-rose-700",
    };
  if (days <= 30)
    return {
      label: t
        ? t("stockAdjustments.nearExpiry", "Near expiry • {{days}}d", { days })
        : `Near expiry • ${days}d`,
      className: "border-amber-500/20 bg-amber-500/10 text-amber-700",
    };
  return null;
}

const transactionTypeLabels: Record<string, string> = {
  stock_adjustment: "Stock Adjustment",
  transfer_in: "Transfer In",
  transfer_out: "Transfer Out",
  initial_stock: "Initial Stock",
};

function mapTransactionLabel(
  transaction: InventoryTransaction,
  translate?: (key: string, defaultValue: string) => string,
) {
  if (!translate) {
    return transactionTypeLabels[transaction.transactionType] || transaction.transactionType.replace(/_/g, " ");
  }
  return translate(
    `stockAdjustments.transactionType.${transaction.transactionType}`,
    transactionTypeLabels[transaction.transactionType] || transaction.transactionType.replace(/_/g, " "),
  );
}

export function StockAdjustments() {
  const [location, setLocation] = useLocation();
  const { t } = useTranslation();
  const { user } = useAuth();
  const { hasCapability } = useWorkspace();
  const { toast } = useToast();
  const workspaceId = user?.workspaceId;
  const canEdit = user?.role === "admin" || user?.role === "staff";
  const canManageStockBatches = hasCapability("stockBatches");

  const products = useProducts(workspaceId);
  const inventoryProducts = useMemo(
    () => products.filter((product) => !isService(product)),
    [products],
  );
  const storages = useStorages(workspaceId);
  const inventory = useInventory(workspaceId);

  const reasonOptions = useMemo(() => getAdjustmentReasonOptions(t), [t]);

  const [activeTab, setActiveTab] = useState<ActiveTab>(
    location === "/stock-adjustments/batches" ? "batches" : "adjustments",
  );
  const [productFilter, setProductFilter] = useState("all");
  const [storageFilter, setStorageFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | StockAdjustmentType>(
    "all",
  );
  const [reasonFilter, setReasonFilter] = useState<
    "all" | StockAdjustmentReason
  >("all");
  const [startDate, setStartDate] = useState<Date | undefined>();
  const [endDate, setEndDate] = useState<Date | undefined>();
  const [batchSearchInput, setBatchSearchInput] = useState("");
  const [batchSearch, setBatchSearch] = useState("");

  const [adjustmentDialogOpen, setAdjustmentDialogOpen] = useState(false);

  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchProductsViewOpen, setBatchProductsViewOpen] = useState(false);
  const [batchProductSearch, setBatchProductSearch] = useState("");
  const [batchForm, setBatchForm] = useState<BatchFormState>(emptyBatchForm);
  const [isSavingBatch, setIsSavingBatch] = useState(false);
  const [batchToDelete, setBatchToDelete] = useState<StockBatch | null>(null);
  const [isDeletingBatch, setIsDeletingBatch] = useState(false);
  const batchUserPickedStorageRef = useRef(false);
  const batchAutoStorageIdRef = useRef<string | null>(null);
  const persistPageSize = useCallback((pageSize: number) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("stock_adjustments_page_size", String(pageSize));
    }
  }, []);

  const startAt = useMemo(() => {
    if (!startDate) return undefined;
    const value = new Date(startDate);
    value.setHours(0, 0, 0, 0);
    return value.toISOString();
  }, [startDate]);
  const endBefore = useMemo(() => {
    if (!endDate) return undefined;
    const value = new Date(endDate);
    value.setHours(0, 0, 0, 0);
    value.setDate(value.getDate() + 1);
    return value.toISOString();
  }, [endDate]);
  const pagination = usePaginationPageMap({
    initialPages: { adjustments: 1, batches: 1 },
    initialPageSize: getStockAdjustmentPageSize(),
    resetOn: [
      workspaceId,
      productFilter,
      storageFilter,
      typeFilter,
      reasonFilter,
      startAt,
      endBefore,
      batchSearch,
    ],
    onPageSizeChange: persistPageSize,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setBatchSearch(batchSearchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [batchSearchInput]);

  useEffect(() => {
    if (location === "/stock-adjustments/batches" && !canManageStockBatches) {
      setLocation("/stock-adjustments");
      setActiveTab("adjustments");
      return;
    }

    setActiveTab(location === "/stock-adjustments/batches" ? "batches" : "adjustments");
  }, [canManageStockBatches, location, setLocation]);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product] as const)),
    [products],
  );
  const storagesById = useMemo(
    () => new Map(storages.map((storage) => [storage.id, storage] as const)),
    [storages],
  );
  const inventoryByKey = useMemo(
    () =>
      new Map(
        inventory.map(
          (row) =>
            [groupKey(row.productId, row.storageId), row.quantity] as const,
        ),
      ),
    [inventory],
  );
  const searchTerm = batchSearch.toLocaleLowerCase();
  const searchProductIds = useMemo(
    () => searchTerm ? products
      .filter((product) => `${product.name} ${product.sku ?? ""}`.toLocaleLowerCase().includes(searchTerm))
      .map((product) => product.id)
      .sort() : [],
    [products, searchTerm],
  );
  const searchStorageIds = useMemo(
    () => searchTerm ? storages
      .filter((storage) => storage.name.toLocaleLowerCase().includes(searchTerm))
      .map((storage) => storage.id)
      .sort() : [],
    [searchTerm, storages],
  );

  useStockAdjustmentPagesChanged(workspaceId);
  useStockBatchPagesChanged(workspaceId);
  useInventoryTransactionPagesChanged(workspaceId);

  const adjustmentPageQuery = useStockAdjustmentPage({
    workspaceId,
    page: pagination.pages.adjustments,
    pageSize: pagination.pageSize,
    startAt,
    endBefore,
    productId: productFilter === "all" ? null : productFilter,
    storageId: storageFilter === "all" ? null : storageFilter,
    adjustmentType: typeFilter === "all" ? null : typeFilter,
    reason: reasonFilter === "all" ? null : reasonFilter,
  }, activeTab === "adjustments");
  const adjustmentPagination = usePaginationBounds({
    currentPage: pagination.pages.adjustments,
    setCurrentPage: (page) => pagination.setPage("adjustments", page),
    totalCount: adjustmentPageQuery.data?.totalCount ?? 0,
    pageCount: adjustmentPageQuery.data?.pageCount,
    pageSize: pagination.pageSize,
    isLoading: adjustmentPageQuery.isPending || adjustmentPageQuery.isFetching,
    error: adjustmentPageQuery.error,
  });
  const batchGroupPageQuery = useStockBatchGroupPage({
    workspaceId,
    page: pagination.pages.batches,
    pageSize: pagination.pageSize,
    search: batchSearch,
    searchProductIds,
    searchStorageIds,
  }, activeTab === "batches" && canManageStockBatches);
  const batchPagination = usePaginationBounds({
    currentPage: pagination.pages.batches,
    setCurrentPage: (page) => pagination.setPage("batches", page),
    totalCount: batchGroupPageQuery.data?.totalCount ?? 0,
    pageCount: batchGroupPageQuery.data?.pageCount,
    pageSize: pagination.pageSize,
    isLoading: batchGroupPageQuery.isPending || batchGroupPageQuery.isFetching,
    error: batchGroupPageQuery.error,
  });
  const adjustmentRows = adjustmentPageQuery.data?.rows ?? [];
  const batchGroups = batchGroupPageQuery.data?.rows ?? [];

  const recentAdjustmentTransactionsQuery = useInventoryTransactionsPage({
    workspaceId,
    page: 1,
    pageSize: 12,
    filters: {
      productId: null,
      direction: "all",
      source: "stock-adjustment",
      storageId: null,
      snapshot: "all",
    },
  }, activeTab === "adjustments");
  const recentTransferTransactionsQuery = useInventoryTransactionsPage({
    workspaceId,
    page: 1,
    pageSize: 12,
    filters: {
      productId: null,
      direction: "all",
      source: "transfer",
      storageId: null,
      snapshot: "all",
    },
  }, activeTab === "adjustments");
  const recentInitialTransactionsQuery = useInventoryTransactionsPage({
    workspaceId,
    page: 1,
    pageSize: 12,
    filters: {
      productId: null,
      direction: "all",
      source: "initial-stock",
      storageId: null,
      snapshot: "all",
    },
  }, activeTab === "adjustments");
  const recentTransactionsLoading = activeTab === "adjustments" && [
    recentAdjustmentTransactionsQuery,
    recentTransferTransactionsQuery,
    recentInitialTransactionsQuery,
  ].some((query) => query.isPending || query.isFetching);
  const recentTransactions = useMemo(() => [
    ...(recentAdjustmentTransactionsQuery.data?.rows ?? []),
    ...(recentTransferTransactionsQuery.data?.rows ?? []),
    ...(recentInitialTransactionsQuery.data?.rows ?? []),
  ].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  ).slice(0, 12), [
    recentAdjustmentTransactionsQuery.data?.rows,
    recentInitialTransactionsQuery.data?.rows,
    recentTransferTransactionsQuery.data?.rows,
  ]);

  const adjustmentTableColumns = useMemo<ColumnDef<StockAdjustment>[]>(() => [
    { id: "createdAt", accessorFn: (row) => row.createdAt },
    { id: "id", accessorFn: (row) => row.id },
    { id: "productId", accessorFn: (row) => row.productId },
    { id: "storageId", accessorFn: (row) => row.storageId },
    { id: "adjustmentType", accessorFn: (row) => row.adjustmentType },
    { id: "reason", accessorFn: (row) => row.reason },
  ], []);
  const adjustmentTable = useReactTable({
    data: adjustmentRows,
    columns: adjustmentTableColumns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: adjustmentPageQuery.data?.totalCount ?? 0,
    state: {
      pagination: { pageIndex: adjustmentPagination.currentPage - 1, pageSize: pagination.pageSize },
      sorting: [{ id: "createdAt", desc: true }, { id: "id", desc: true }],
      columnFilters: [
        { id: "productId", value: productFilter },
        { id: "storageId", value: storageFilter },
        { id: "adjustmentType", value: typeFilter },
        { id: "reason", value: reasonFilter },
      ],
    },
  });
  const batchGroupTableColumns = useMemo<ColumnDef<StockBatchGroup>[]>(() => [
    { id: "productId", accessorFn: (group) => group.productId },
    { id: "storageId", accessorFn: (group) => group.storageId },
  ], []);
  const batchGroupTable = useReactTable({
    data: batchGroups,
    columns: batchGroupTableColumns,
    getRowId: (group) => groupKey(group.productId, group.storageId),
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount: batchGroupPageQuery.data?.totalCount ?? 0,
    state: {
      pagination: { pageIndex: batchPagination.currentPage - 1, pageSize: pagination.pageSize },
      sorting: [{ id: "productId", desc: false }, { id: "storageId", desc: false }],
      columnFilters: [{ id: "search", value: batchSearch }],
    },
  });

  const batchStorageOptions = useMemo(() => {
    if (!batchForm.productId) return storages;
    const storageIds = Array.from(
      new Set(
        inventory
          .filter((row) => row.productId === batchForm.productId)
          .map((row) => row.storageId),
      ),
    );
    return storageIds.length
      ? storages.filter((storage) => storageIds.includes(storage.id))
      : storages;
  }, [batchForm.productId, inventory, storages]);

  useEffect(() => {
    if (!batchDialogOpen) {
      batchUserPickedStorageRef.current = false;
      batchAutoStorageIdRef.current = null;
      return;
    }
    if (batchUserPickedStorageRef.current || batchStorageOptions.length === 0) {
      return;
    }

    const desiredStorageId = batchStorageOptions[0].id;
    if (
      desiredStorageId === batchAutoStorageIdRef.current &&
      batchForm.storageId === desiredStorageId
    ) {
      return;
    }

    batchAutoStorageIdRef.current = desiredStorageId;
    setBatchForm((current) => ({ ...current, storageId: desiredStorageId }));
  }, [batchDialogOpen, batchForm.productId, batchForm.storageId, batchStorageOptions]);

  const batchSelectionKey =
    batchForm.productId && batchForm.storageId
      ? groupKey(batchForm.productId, batchForm.storageId)
      : "";
  const batchInventoryQuantity = batchSelectionKey
    ? (inventoryByKey.get(batchSelectionKey) ?? 0)
    : null;
  const batchPriceValue =
    batchForm.price === "" ? null : parseFormattedNumber(batchForm.price);
  const batchCostPriceValue =
    batchForm.costPrice === ""
      ? null
      : parseFormattedNumber(batchForm.costPrice);
  const selectedBatchProduct = batchForm.productId
    ? productsById.get(batchForm.productId)
    : null;
  const batchUsesCustomPricing =
    !!selectedBatchProduct &&
    (selectedBatchProduct.price !== batchPriceValue ||
      selectedBatchProduct.costPrice !== batchCostPriceValue ||
      selectedBatchProduct.currency !== batchForm.currency);

  const canSaveBatch =
    !!batchForm.productId &&
    !!batchForm.storageId &&
    !!batchForm.batchNumber.trim() &&
    isPositiveQuantity(parseFormattedNumber(batchForm.quantity || "")) &&
    batchPriceValue !== null &&
    Number.isFinite(batchPriceValue) &&
    batchPriceValue >= 0 &&
    batchCostPriceValue !== null &&
    Number.isFinite(batchCostPriceValue) &&
    batchCostPriceValue >= 0;
  const canOpenBatchProductsView = Boolean(batchForm.storageId) && storages.length > 0;

  const resetBatchForm = () => {
    setBatchForm(emptyBatchForm);
    setBatchProductSearch("");
    setBatchProductsViewOpen(false);
    setIsSavingBatch(false);
  };

  const selectBatchProduct = (productId: string) => {
    const product = productsById.get(productId);
    if (!product) return;

    setBatchForm((current) => ({
      ...current,
      productId: product.id,
      price: String(product.price ?? 0),
      costPrice: String(product.costPrice ?? 0),
      currency: product.currency ?? "usd",
    }));
    setBatchProductSearch(product.name);
  };

  const handleSaveBatch = async () => {
    if (!workspaceId || !canManageStockBatches) return;
    setIsSavingBatch(true);
    try {
      const payload = {
        productId: batchForm.productId,
        storageId: batchForm.storageId,
        batchNumber: batchForm.batchNumber,
        quantity: parseFormattedNumber(batchForm.quantity),
        price: parseFormattedNumber(batchForm.price),
        costPrice: parseFormattedNumber(batchForm.costPrice),
        currency: batchForm.currency,
        expiryDate: batchForm.expiryDate || null,
        manufacturingDate: batchForm.manufacturingDate || null,
        notes: batchForm.notes,
      };

      if (batchForm.id) {
        await updateStockBatch(batchForm.id, payload);
        toast({
          title: t("stockAdjustments.messages.batchUpdated", "Batch updated"),
          description: t("stockAdjustments.messages.batchUpdatedDesc", "Batch changes were saved."),
        });
      } else {
        await createStockBatch(workspaceId, payload);
        toast({
          title: t("stockAdjustments.messages.batchCreated", "Batch created"),
          description: t("stockAdjustments.messages.batchCreatedDesc", "New batch added successfully."),
        });
      }

      setBatchDialogOpen(false);
      resetBatchForm();
    } catch (error) {
      toast({
        title: t("stockAdjustments.messages.batchFailed", "Unable to save batch"),
        description:
          error instanceof Error ? error.message : t("stockAdjustments.messages.genericError", "Something went wrong."),
        variant: "destructive",
      });
      setIsSavingBatch(false);
    }
  };

  const handleDeleteBatch = async () => {
    if (!batchToDelete || !canManageStockBatches) return;
    setIsDeletingBatch(true);
    try {
      await deleteStockBatch(batchToDelete.id);
      toast({
        title: t("stockAdjustments.messages.batchDeleted", "Batch deleted"),
        description: t("stockAdjustments.messages.batchDeletedDesc", "The batch was removed from active tracking."),
      });
      setBatchToDelete(null);
    } catch (error) {
      toast({
        title: t("stockAdjustments.messages.batchDeleteFailed", "Unable to delete batch"),
        description:
          error instanceof Error ? error.message : t("stockAdjustments.messages.genericError", "Something went wrong."),
        variant: "destructive",
      });
    } finally {
      setIsDeletingBatch(false);
    }
  };

  const handleBatchSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleSaveBatch();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="flex items-center gap-3 text-2xl font-bold">
            <Boxes className="h-6 w-6 text-primary" />
            {t("nav.stockAdjustments", { defaultValue: "Stock Adjustments" })}
          </h1>
          <p className="max-w-3xl text-muted-foreground">
            {canManageStockBatches
              ? t("stockAdjustments.pageSubtitle", "Record manual stock changes, manage product batches, and review the unified inventory log.")
            : t("stockAdjustments.pageSubtitleSimple", "Record manual stock changes and review the unified inventory log.")} <ModulePageFreshness
              className="ms-2"
              tableNames={[activeTab === "batches" ? "stock_batches" : "inventory_transactions"]}
            />
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button
              className="gap-2 rounded-xl"
              onClick={() => setAdjustmentDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              {t("stockAdjustments.newAdjustment", "New Stock Adjustment")}
            </Button>
            {canManageStockBatches && (
              <Button
                variant="outline"
                className="gap-2 rounded-xl"
                onClick={() => {
                  resetBatchForm();
                  setBatchDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                {t("stockAdjustments.newBatch", "New Stock Batch")}
              </Button>
            )}
          </div>
        )}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (value === "batches" && !canManageStockBatches) return;
          const nextTab = value as ActiveTab;
          setActiveTab(nextTab);
          setLocation(nextTab === "batches" ? "/stock-adjustments/batches" : "/stock-adjustments");
        }}
        className="space-y-6"
      >
        <TabsList className={cn(
          "grid h-auto min-h-12 w-full rounded-2xl items-stretch",
          canManageStockBatches ? "max-w-xl grid-cols-2" : "max-w-xs grid-cols-1",
        )}>
          <TabsTrigger value="adjustments" className="min-h-10">
            {t("stockAdjustments.tabs.adjustments", "Stock Adjustments")}
          </TabsTrigger>
          {canManageStockBatches && (
            <TabsTrigger value="batches" className="min-h-10">
              {t("stockAdjustments.tabs.batches", "Stock Batches")}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="adjustments" className="space-y-6">
          <Card className="border-border/60 shadow-sm">
            <CardHeader>
              <CardTitle>{t("stockAdjustments.filters.title", "Filters")}</CardTitle>
              <CardDescription>
                {t("stockAdjustments.filters.description", "Filter by product, storage, type, reason, or date range.")}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
              <div className="space-y-2">
                <Label>{t("stockAdjustments.filters.product", "Product")}</Label>
                <Select value={productFilter} onValueChange={setProductFilter}>
                  <SelectTrigger className="rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("stockAdjustments.filters.allProducts", "All products")}</SelectItem>
                    {products.map((product) => (
                      <SelectItem key={product.id} value={product.id}>
                        {product.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("stockAdjustments.filters.storage", "Storage")}</Label>
                <Select value={storageFilter} onValueChange={setStorageFilter}>
                  <SelectTrigger className="rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("stockAdjustments.filters.allStorages", "All storages")}</SelectItem>
                    {storages.map((storage) => (
                      <SelectItem key={storage.id} value={storage.id}>
                        {storage.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("stockAdjustments.filters.type", "Type")}</Label>
                <Select
                  value={typeFilter}
                  onValueChange={(value) =>
                    setTypeFilter(value as "all" | StockAdjustmentType)
                  }
                >
                  <SelectTrigger className="rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("stockAdjustments.filters.allTypes", "All types")}</SelectItem>
                    <SelectItem value="increase">{t("stockAdjustments.filters.increase", "Increase")}</SelectItem>
                    <SelectItem value="decrease">{t("stockAdjustments.filters.decrease", "Decrease")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("stockAdjustments.filters.reason", "Reason")}</Label>
                <Select
                  value={reasonFilter}
                  onValueChange={(value) =>
                    setReasonFilter(value as "all" | StockAdjustmentReason)
                  }
                >
                  <SelectTrigger className="rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("stockAdjustments.filters.allReasons", "All reasons")}</SelectItem>
                    {reasonOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("stockAdjustments.filters.start", "Start")}</Label>
                <DateTimePicker
                  mode="date"
                  date={startDate}
                  setDate={setStartDate}
                  placeholder={t("stockAdjustments.filters.startDate", "Start date")}
                  buttonClassName="rounded-xl"
                />
              </div>
              <div className="space-y-2">
                <Label>{t("stockAdjustments.filters.end", "End")}</Label>
                <DateTimePicker
                  mode="date"
                  date={endDate}
                  setDate={setEndDate}
                  placeholder={t("stockAdjustments.filters.endDate", "End date")}
                  buttonClassName="rounded-xl"
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/60 shadow-sm">
            <CardHeader>
              <CardTitle>{t("stockAdjustments.history.title", "Adjustment history")}</CardTitle>
              <CardDescription>
                {t("stockAdjustments.history.description", "Each entry shows the before and after quantity snapshot for the selected storage.")}
              </CardDescription>
              <AppPagination
                currentPage={adjustmentPagination.currentPage}
                totalCount={adjustmentPageQuery.data?.totalCount ?? 0}
                pageCount={adjustmentPagination.pageCount}
                pageSize={pagination.pageSize}
                onPageChange={(page) => pagination.setPage("adjustments", page)}
                onPageSizeChange={pagination.setPageSize}
                pageSizeOptions={STOCK_ADJUSTMENT_PAGE_SIZE_OPTIONS}
                className="justify-end"
              />
            </CardHeader>
            <CardContent className="space-y-3">
              {adjustmentPageQuery.isPending || adjustmentPageQuery.isFetching ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("common.loading", "Loading...")}
                </div>
              ) : adjustmentPageQuery.error ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-destructive">
                  {t("stockAdjustments.history.loadError", "Could not load stock adjustments. Check your connection and try again.")}
                </div>
              ) : adjustmentRows.length === 0 ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  {t("stockAdjustments.history.empty", "No adjustments match the current filters.")}
                </div>
              ) : (
                adjustmentTable.getRowModel().rows.map(({ original: adjustment }) => {
                  const isIncrease = adjustment.adjustmentType === "increase";
                  return (
                    <div
                      key={adjustment.id}
                      className="rounded-2xl border border-border/60 bg-background/70 p-4"
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold">
                              {productsById.get(adjustment.productId)?.name ||
                                t("inventoryTransfer.transactions.unknownProduct", "Unknown product")}
                            </span>
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold",
                                isIncrease
                                  ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700"
                                  : "border-rose-500/20 bg-rose-500/10 text-rose-700",
                              )}
                            >
                              {isIncrease ? (
                                <ArrowUp className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowDown className="h-3.5 w-3.5" />
                              )}
                              {adjustment.adjustmentType === "increase"
                                ? t("stockAdjustments.filters.increase", "Increase")
                                : t("stockAdjustments.filters.decrease", "Decrease")}
                            </span>
                            <span className="rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                              {getReasonLabel(adjustment.reason, t)}
                            </span>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {storagesById.get(adjustment.storageId)?.name ||
                              t("inventoryTransfer.unknownStorage", "Unknown storage")}{" "}
                            • {formatDateTime(adjustment.createdAt)}
                          </div>
                          <div className="flex flex-wrap gap-2 text-sm">
                            <span className="rounded-full border border-border/60 px-3 py-1 font-semibold">
                              {t("stockAdjustments.history.qty", "Qty {{value}}", { value: formatNumericInput(String(adjustment.quantity)) })}
                            </span>
                            <span className="rounded-full border border-border/60 px-3 py-1 font-semibold">
                              {t("stockAdjustments.history.previousToNew", "{{previous}} → {{new}}", { previous: String(adjustment.previousQuantity), new: String(adjustment.newQuantity) })}
                            </span>
                          </div>
                        </div>
                        <div className="max-w-md text-sm text-muted-foreground">
                          {adjustment.notes || t("stockAdjustments.history.noNotes", "No notes provided.")}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="border-border/60 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5 text-primary" />
                {t("stockAdjustments.recentTransactions.title", "Recent inventory transactions")}
              </CardTitle>
              <CardDescription>
                {t("stockAdjustments.recentTransactions.description", "Unified audit trail for initial stock, adjustments, and transfers.")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {recentTransactionsLoading ? (
                <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("common.loading", "Loading...")}
                </div>
              ) : recentAdjustmentTransactionsQuery.error
                || recentTransferTransactionsQuery.error
                || recentInitialTransactionsQuery.error ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-destructive">
                  {t("stockAdjustments.recentTransactions.loadError", "Could not load recent inventory transactions.")}
                </div>
              ) : recentTransactions.length === 0 ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  {t("stockAdjustments.recentTransactions.empty", "No inventory transactions are available yet.")}
                </div>
              ) : (
                recentTransactions.map((transaction) => {
                  const isPositive = transaction.quantityDelta > 0;
                  return (
                    <div
                      key={transaction.id}
                      className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-background/70 p-4 lg:flex-row lg:items-center lg:justify-between"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">
                            {productsById.get(transaction.productId)?.name ||
                              t("inventoryTransfer.transactions.unknownProduct", "Unknown product")}
                          </span>
                          <span
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-xs font-semibold",
                              isPositive
                                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700"
                                : "border-rose-500/20 bg-rose-500/10 text-rose-700",
                            )}
                          >
                            {mapTransactionLabel(transaction, t)}
                          </span>
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {storagesById.get(transaction.storageId)?.name ||
                            t("inventoryTransfer.unknownStorage", "Unknown storage")}{" "}
                          • {formatDateTime(transaction.createdAt)}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 text-sm">
                        <span className="rounded-full border border-border/60 px-3 py-1 font-semibold">
                          {t("stockAdjustments.recentTransactions.delta", "Delta {{sign}}{{value}}", { sign: isPositive ? "+" : "", value: formatNumericInput(String(transaction.quantityDelta)) })}
                        </span>
                        <span className="rounded-full border border-border/60 px-3 py-1 font-semibold">
                          {transaction.previousQuantity} →{" "}
                          {transaction.newQuantity}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {canManageStockBatches && (
        <TabsContent value="batches" className="space-y-6">
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="gap-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-2">
                  <CardTitle>{t("stockAdjustments.batches.title", "Batch tracking")}</CardTitle>
                  <CardDescription>
                    {t("stockAdjustments.batches.description", "Grouped by product and storage with a coverage check against current inventory.")}
                  </CardDescription>
                </div>
                <div className="relative w-full lg:max-w-sm">
                  <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={batchSearchInput}
                    onChange={(event) => setBatchSearchInput(event.target.value)}
                    placeholder={t("stockAdjustments.batches.searchPlaceholder", "Search product, storage, batch number, or notes")}
                    aria-label={t("stockAdjustments.batches.search", "Search stock batches")}
                    className="ps-9"
                  />
                </div>
              </div>
              <AppPagination
                currentPage={batchPagination.currentPage}
                totalCount={batchGroupPageQuery.data?.totalCount ?? 0}
                pageCount={batchPagination.pageCount}
                pageSize={pagination.pageSize}
                onPageChange={(page) => pagination.setPage("batches", page)}
                onPageSizeChange={pagination.setPageSize}
                pageSizeOptions={STOCK_ADJUSTMENT_PAGE_SIZE_OPTIONS}
                className="justify-end"
              />
            </CardHeader>
            <CardContent className="space-y-4">
              {batchGroupPageQuery.isPending || batchGroupPageQuery.isFetching ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("common.loading", "Loading...")}
                </div>
              ) : batchGroupPageQuery.error ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-destructive">
                  {t("stockAdjustments.batches.loadError", "Could not load stock batches. Check your connection and try again.")}
                </div>
              ) : batchGroups.length === 0 ? (
                <div className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  {batchSearch
                    ? t("stockAdjustments.batches.emptySearch", "No stock batches match your search.")
                    : t("stockAdjustments.batches.empty", "No stock batches have been created yet.")}
                </div>
              ) : (
                batchGroupTable.getRowModel().rows.map(({ original: group }) => {
                  const inventoryQuantity =
                    inventoryByKey.get(
                      groupKey(group.productId, group.storageId),
                    ) || 0;
                  const mismatch = !batchSearch && inventoryQuantity !== group.batchQuantity;
                  return (
                    <div
                      key={groupKey(group.productId, group.storageId)}
                      className="rounded-3xl border border-border/60 bg-background/80 p-5"
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-lg font-black">
                              {productsById.get(group.productId)?.name ||
                                t("inventoryTransfer.transactions.unknownProduct", "Unknown product")}
                            </span>
                            <span className="rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                              {storagesById.get(group.storageId)?.name ||
                                t("inventoryTransfer.unknownStorage", "Unknown storage")}
                            </span>
                            {mismatch && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {t("stockAdjustments.batches.coverageMismatch", "Coverage mismatch")}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 text-sm">
                            <span className="rounded-full border border-border/60 px-3 py-1 font-semibold">
                              {t("stockAdjustments.batches.inventory", "Inventory {{value}}", { value: formatNumericInput(String(inventoryQuantity)) })}
                            </span>
                            <span className="rounded-full border border-border/60 px-3 py-1 font-semibold">
                              {t("stockAdjustments.batches.batchCount", "Batches {{value}}", { value: String(group.batchQuantity) })}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 space-y-3">
                        {group.rows.map((batch) => {
                          const expiryBadge = getExpiryBadge(batch.expiryDate, t);
                          const productDefaults = productsById.get(
                            batch.productId,
                          );
                          const hasCustomPricing =
                            !!productDefaults &&
                            (batch.price !== productDefaults.price ||
                              batch.costPrice !== productDefaults.costPrice ||
                              batch.currency !== productDefaults.currency);
                          return (
                            <div
                              key={batch.id}
                              className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-muted/20 p-4 lg:flex-row lg:items-center lg:justify-between"
                            >
                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold">
                                    {batch.batchNumber}
                                  </span>
                                  <span className="rounded-full border border-border/60 bg-background px-2 py-0.5 text-xs font-semibold">
                                    {t("stockAdjustments.batches.qty", "Qty {{value}}", { value: formatNumericInput(String(batch.quantity)) })}
                                  </span>
                                  {expiryBadge && (
                                    <span
                                      className={cn(
                                        "rounded-full border px-2 py-0.5 text-xs font-semibold",
                                        expiryBadge.className,
                                      )}
                                    >
                                      {expiryBadge.label}
                                    </span>
                                  )}
                                  {hasCustomPricing && (
                                    <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-xs font-semibold text-sky-700">
                                      {t("stockAdjustments.batches.customPricing", "Custom pricing")}
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-2 text-sm">
                                  <span className="rounded-full border border-border/60 bg-background px-2.5 py-1 font-semibold">
                                    {t("stockAdjustments.batches.sell", "Sell {{amount}}", { amount: formatCurrency(batch.price, batch.currency) })}
                                  </span>
                                  <span className="rounded-full border border-border/60 bg-background px-2.5 py-1 font-semibold">
                                    {t("stockAdjustments.batches.cost", "Cost {{amount}}", { amount: formatCurrency(batch.costPrice, batch.currency) })}
                                  </span>
                                  <span className="rounded-full border border-border/60 bg-background px-2.5 py-1 font-semibold uppercase text-muted-foreground">
                                    {batch.currency}
                                  </span>
                                </div>
                                <div className="text-sm text-muted-foreground">
                                  {batch.manufacturingDate
                                    ? t("stockAdjustments.batches.manufactured", "Manufactured {{date}}", { date: formatDate(batch.manufacturingDate) })
                                    : t("stockAdjustments.batches.noManufacturingDate", "No manufacturing date")}
                                  {batch.expiryDate
                                    ? ` • ${t("stockAdjustments.batches.expires", "Expires {{date}}", { date: formatDate(batch.expiryDate) })}`
                                    : ` • ${t("stockAdjustments.batches.noExpiryDate", "No expiry date")}`}
                                </div>
                                {batch.notes && (
                                  <div className="text-sm text-muted-foreground">
                                    {batch.notes}
                                  </div>
                                )}
                              </div>
                              {canEdit && (
                                <div className="flex gap-2">
                                  <Button
                                    variant="outline"
                                    className="gap-2 rounded-xl"
                                    onClick={() => {
                                      batchUserPickedStorageRef.current = true;
                                      setBatchForm({
                                        id: batch.id,
                                        productId: batch.productId,
                                        storageId: batch.storageId,
                                        batchNumber: batch.batchNumber,
                                        quantity: String(batch.quantity),
                                        price: String(
                                          batch.price ??
                                            productDefaults?.price ??
                                            0,
                                        ),
                                        costPrice: String(
                                          batch.costPrice ??
                                            productDefaults?.costPrice ??
                                            0,
                                        ),
                                        currency:
                                          batch.currency ??
                                          productDefaults?.currency ??
                                          "usd",
                                        expiryDate: batch.expiryDate || "",
                                        manufacturingDate:
                                          batch.manufacturingDate || "",
                                        notes: batch.notes || "",
                                      });
                                      setBatchProductSearch(productDefaults?.name ?? "");
                                      setBatchDialogOpen(true);
                                    }}
                                  >
                                    <Pencil className="h-4 w-4" />
                                    {t("stockAdjustments.batches.edit", "Edit")}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    className="gap-2 rounded-xl text-rose-700"
                                    onClick={() => setBatchToDelete(batch)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    {t("stockAdjustments.batches.delete", "Delete")}
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </TabsContent>
        )}
      </Tabs>

      <StockAdjustmentDialog
        open={adjustmentDialogOpen}
        onOpenChange={setAdjustmentDialogOpen}
        products={inventoryProducts}
        storages={storages}
        inventory={inventory}
        workspaceId={workspaceId ?? ""}
        userId={user?.id ?? null}
      />

      <Dialog
        open={batchDialogOpen}
        onOpenChange={(open) => {
          setBatchDialogOpen(open);
          if (!open) resetBatchForm();
        }}
      >
        <DialogContent layout="structured" className="max-w-3xl">
          <DialogHeader layout="structured">
            <DialogTitle>
              {batchForm.id ? t("stockAdjustments.dialog.batch.titleEdit", "Edit Stock Batch") : t("stockAdjustments.dialog.batch.titleNew", "New Stock Batch")}
            </DialogTitle>
            <DialogDescription>
              {t("stockAdjustments.dialog.batch.description", "Track the batch quantity, dates, and pricing snapshot for one storage. Product pricing is loaded by default and can be overridden for this batch.")}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={handleBatchSubmit}
            className="flex min-h-0 flex-1 flex-col"
          >
            <DialogBody>
              <div className="grid gap-4">
                <div className="space-y-2">
                  <Label htmlFor="batch-search" >{t("stockAdjustments.dialog.batch.productSearch", "Product search")}</Label>
                  <div className="flex items-center">
                    {canOpenBatchProductsView ? (
                      <ProductsViewModalTrigger
                        label={t("products.title", "Browse products")}
                        onClick={() => setBatchProductsViewOpen(true)}
                      />
                    ) : null}
                    <ProductAutocompleteInput
                      className="min-w-0 flex-1"
                      inputClassName={canOpenBatchProductsView ? "rounded-s-none" : undefined}
                      value={batchProductSearch}
                      onChange={(value) => {
                        setBatchProductSearch(value);
                        setBatchForm((current) => ({ ...current, productId: "" }));
                      }}
                      onSelectProduct={(product) => selectBatchProduct(product.id)}

                      placeholder={t("stockAdjustments.dialog.batch.productSearchPlaceholder", "Search products by name or SKU")}
                      hasSelection={!!batchForm.productId}
                    />
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>{t("stockAdjustments.dialog.batch.storage", "Storage")} <span className="text-destructive">*</span></Label>
                    <Select
                      value={batchForm.storageId}
                      onValueChange={(value) => {
                        batchUserPickedStorageRef.current = true;
                        setBatchForm((current) => ({
                          ...current,
                          storageId: value,
                        }));
                      }}
                    >
                      <SelectTrigger className="rounded-xl">
                        <SelectValue placeholder={t("stockAdjustments.dialog.batch.selectStorage", "Select storage")} />
                      </SelectTrigger>
                      <SelectContent>
                        {batchStorageOptions.map((storage) => (
                          <SelectItem key={storage.id} value={storage.id}>
                            {storage.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="batch-number">{t("stockAdjustments.dialog.batch.batchNumber", "Batch / Lot Number")} <span className="text-destructive">*</span></Label>
                    <Input
                      id="batch-number"
                      value={batchForm.batchNumber}
                      onChange={(event) =>
                        setBatchForm((current) => ({
                          ...current,
                          batchNumber: event.target.value,
                        }))
                      }
                      className="rounded-xl"
                    />
                  </div>
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label htmlFor="batch-quantity">{t("stockAdjustments.dialog.batch.quantity", "Quantity")} <span className="text-destructive">*</span></Label>
                      {batchInventoryQuantity !== null ? (
                        <span className="text-xs text-muted-foreground">
                          {t("stockAdjustments.dialog.batch.inventoryAvailable", "Inventory available {{value}}", { value: formatNumericInput(String(batchInventoryQuantity)) })}
                        </span>
                      ) : null}
                    </div>
                    <Input
                      id="batch-quantity"
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      value={formatNumericInput(batchForm.quantity)}
                      onChange={(event) =>
                        setBatchForm((current) => ({
                          ...current,
                          quantity: sanitizeNumericInput(event.target.value, {
                            allowDecimal: true,
                          }),
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="batch-price">{t("stockAdjustments.dialog.batch.batchPrice", "Batch price")} <span className="text-destructive">*</span></Label>
                    <Input
                      id="batch-price"
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={formatNumericInput(batchForm.price)}
                      onChange={(event) =>
                        setBatchForm((current) => ({
                          ...current,
                          price: sanitizeNumericInput(event.target.value),
                        }))
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="batch-cost-price">{t("stockAdjustments.dialog.batch.batchCost", "Batch cost")} <span className="text-destructive">*</span></Label>
                    <Input
                      id="batch-cost-price"
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={formatNumericInput(batchForm.costPrice)}
                      onChange={(event) =>
                        setBatchForm((current) => ({
                          ...current,
                          costPrice: sanitizeNumericInput(event.target.value),
                        }))
                      }
                    />
                  </div>
                  <CurrencySelector
                    label={t("stockAdjustments.dialog.batch.currency", "Currency")}
                    value={batchForm.currency}
                    onChange={(value) =>
                      setBatchForm((current) => ({
                        ...current,
                        currency: value,
                      }))
                    }
                  />
                </div>
                <div className="rounded-2xl border border-dashed border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                  {selectedBatchProduct ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span>
                        {t("stockAdjustments.batches.productDefault", "Product default:")}
                        {" "}
                        {formatCurrency(
                          selectedBatchProduct.price,
                          selectedBatchProduct.currency,
                        )}
                      </span>
                      <span>
                        {t("stockAdjustments.batches.cost", "Cost {{amount}}", { amount: formatCurrency(selectedBatchProduct.costPrice ?? 0, selectedBatchProduct.currency) })}
                      </span>
                      <span className="uppercase">
                        {selectedBatchProduct.currency}
                      </span>
                      {batchUsesCustomPricing ? (
                        <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-xs font-semibold text-sky-700">
                          {t("stockAdjustments.batches.batchOverride", "Batch override active")}
                        </span>
                      ) : (
                        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          {t("stockAdjustments.batches.usingDefaults", "Using product defaults")}
                        </span>
                      )}
                    </div>
                  ) : (
                    t("stockAdjustments.batches.loadProductMsg", "Select a product to load its default price, cost, and currency.")
                  )}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>{t("stockAdjustments.dialog.batch.expiryDate", "Expiry date")}</Label>
                    <DateTimePicker
                      mode="date"
                      date={parseLocalDateValue(batchForm.expiryDate)}
                      setDate={(value) =>
                        setBatchForm((current) => ({
                          ...current,
                          expiryDate: formatLocalDateValue(value),
                        }))
                      }
                      placeholder={t("stockAdjustments.dialog.batch.expiryDatePlaceholder", "Optional expiry date")}
                      buttonClassName="rounded-xl"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t("stockAdjustments.dialog.batch.manufacturingDate", "Manufacturing date")}</Label>
                    <DateTimePicker
                      mode="date"
                      date={parseLocalDateValue(batchForm.manufacturingDate)}
                      setDate={(value) =>
                        setBatchForm((current) => ({
                          ...current,
                          manufacturingDate: formatLocalDateValue(value),
                        }))
                      }
                      placeholder={t("stockAdjustments.dialog.batch.manufacturingDatePlaceholder", "Optional manufacturing date")}
                      buttonClassName="rounded-xl"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="batch-notes">{t("stockAdjustments.dialog.batch.notes", "Notes")}</Label>
                  <Textarea
                    id="batch-notes"
                    value={batchForm.notes}
                    onChange={(event) =>
                      setBatchForm((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                    rows={4}
                  />
                </div>
              </div>
            </DialogBody>
            <DialogFooter layout="structured">
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => setBatchDialogOpen(false)}
                disabled={isSavingBatch}
              >
                {t("stockAdjustments.dialog.batch.cancel", "Cancel")}
              </Button>
              <Button
                type="submit"
                className="w-full sm:w-auto"
                disabled={!canSaveBatch || isSavingBatch}
              >
                {isSavingBatch
                  ? t("stockAdjustments.dialog.batch.saving", "Saving...")
                  : batchForm.id
                    ? t("stockAdjustments.dialog.batch.saveChanges", "Save Changes")
                    : t("stockAdjustments.dialog.batch.saveBatch", "Save Batch")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
        <ProductsViewModal
          open={batchProductsViewOpen}
          onOpenChange={setBatchProductsViewOpen}
          products={inventoryProducts}
          storages={storages}
          initialStorageId={batchForm.storageId}
          filterProducts={(availableProducts, storageId) => {
            const productIdsInStorage = new Set(
              inventory
                .filter((row) => row.storageId === storageId)
                .map((row) => row.productId),
            );
            return availableProducts.filter((product) => productIdsInStorage.has(product.id));
          }}
          labels={{
            title: t("products.title", "Products"),
            description: t("stockAdjustments.dialog.batch.productSearch", "Select a product for this stock batch."),
            searchLabel: t("common.search", "Search"),
            searchPlaceholder: t("products.searchPlaceholder", "Search products..."),
            storageLabel: t("stockAdjustments.dialog.batch.storage", "Storage"),
            storagePlaceholder: t("stockAdjustments.dialog.batch.selectStorage", "Select storage"),
            noProductsLabel: t("inventoryTransfer.noProducts", "No products in this storage."),
            noResultsLabel: t("inventoryTransfer.noMatchingProducts", "No products match your search."),
          }}
          onSelectProduct={(product, storageId) => {
            batchUserPickedStorageRef.current = true;
            selectBatchProduct(product.id);
            setBatchForm((current) => ({ ...current, storageId }));
            setBatchProductsViewOpen(false);
          }}
        />
      </Dialog>

      <DeleteConfirmationModal
        isOpen={!!batchToDelete}
        onClose={() => {
          if (!isDeletingBatch) setBatchToDelete(null);
        }}
        onConfirm={() => {
          void handleDeleteBatch();
        }}
        isLoading={isDeletingBatch}
        title={t("stockAdjustments.deleteConfirm.title", "Delete stock batch?")}
        description={t("stockAdjustments.deleteConfirm.description", "This will soft-delete the batch from active tracking.")}
        itemName={batchToDelete?.batchNumber || ""}
      />
    </div>
  );
}

export default StockAdjustments;
