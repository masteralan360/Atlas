import { useEffect, useMemo, useState } from "react";
import {
  createReorderTransferRule,
  deleteReorderTransferRule,
  transferInventoryBetweenStorages,
  updateReorderTransferRule,
  useInventory,
  useProducts,
  useReorderTransferRules,
  useStorages,
} from "@/local-db";
import type { Product, ReorderTransferRule, Storage } from "@/local-db";
import { useWorkspace } from "@/workspace";
import { useAuth } from "@/auth";
import { Button } from "@/ui/components/button";
import {
  ArrowRightLeft,
  Bot,
  Check,
  ChevronRight,
  Infinity,
  Package,
  Pencil,
  Plus,
  Trash2,
  Warehouse,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  DateTimePicker,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
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
} from "@/ui/components";
import { useTranslation } from "react-i18next";
import { useToast } from "@/ui/components/use-toast";
import {
  formatDate,
  formatLocalDateValue,
  parseLocalDateValue,
} from "@/lib/utils";

interface RuleFormState {
  productId: string;
  sourceStorageId: string;
  destinationStorageId: string;
  minStockLevel: string;
  transferQuantity: string;
  expiresOn: string;
  isIndefinite: boolean;
}

type InventoryTransferTab = "manual" | "automation";

const INVENTORY_TRANSFER_PENDING_TAB_KEY = "inventory-transfer.pending-tab";
const INVENTORY_TRANSFER_TAB_EVENT = "inventory-transfer:open-tab";

function isInventoryTransferTab(
  value: string | null | undefined,
): value is InventoryTransferTab {
  return value === "manual" || value === "automation";
}

function consumePendingInventoryTransferTab(): InventoryTransferTab | null {
  if (typeof window === "undefined") {
    return null;
  }

  const pendingTab = window.sessionStorage.getItem(
    INVENTORY_TRANSFER_PENDING_TAB_KEY,
  );
  if (!isInventoryTransferTab(pendingTab)) {
    return null;
  }

  window.sessionStorage.removeItem(INVENTORY_TRANSFER_PENDING_TAB_KEY);
  return pendingTab;
}

function getDefaultRuleExpiryDate() {
  const now = new Date();
  return `${now.getFullYear()}-12-31`;
}

function createEmptyRuleForm(): RuleFormState {
  return {
    productId: "",
    sourceStorageId: "",
    destinationStorageId: "",
    minStockLevel: "",
    transferQuantity: "",
    expiresOn: getDefaultRuleExpiryDate(),
    isIndefinite: false,
  };
}

function formatDateLabel(value?: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return formatDate(parsed);
}

function getTodayDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getRemainingDays(expiresOn?: string | null) {
  if (!expiresOn) {
    return null;
  }

  const today = new Date(`${getTodayDateKey()}T00:00:00`);
  const expiry = new Date(`${expiresOn}T00:00:00`);
  if (Number.isNaN(today.getTime()) || Number.isNaN(expiry.getTime())) {
    return null;
  }

  return Math.ceil(
    (expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
  );
}

function isRuleExpired(
  rule: Pick<ReorderTransferRule, "expiresOn" | "isIndefinite">,
) {
  return (
    !rule.isIndefinite && !!rule.expiresOn && rule.expiresOn < getTodayDateKey()
  );
}

function buildRuleForm(rule: ReorderTransferRule | null): RuleFormState {
  if (!rule) {
    return createEmptyRuleForm();
  }

  return {
    productId: rule.productId,
    sourceStorageId: rule.sourceStorageId,
    destinationStorageId: rule.destinationStorageId,
    minStockLevel: String(rule.minStockLevel),
    transferQuantity: String(rule.transferQuantity),
    expiresOn: rule.expiresOn || getDefaultRuleExpiryDate(),
    isIndefinite: rule.isIndefinite,
  };
}

export default function InventoryTransfer() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "staff";
  const { t } = useTranslation();
  const { activeWorkspace } = useWorkspace();
  const storages = useStorages(activeWorkspace?.id);
  const inventory = useInventory(activeWorkspace?.id);
  const products = useProducts(activeWorkspace?.id);
  const reorderRules = useReorderTransferRules(activeWorkspace?.id);
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<InventoryTransferTab>(
    () => consumePendingInventoryTransferTab() ?? "manual",
  );

  const [sourceStorageId, setSourceStorageId] = useState<string>("");
  const [targetStorageId, setTargetStorageId] = useState<string>("");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(
    new Set(),
  );
  const [transferQuantities, setTransferQuantities] = useState<
    Record<string, string>
  >({});
  const [isTransferring, setIsTransferring] = useState(false);

  const [isRuleDialogOpen, setIsRuleDialogOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState<RuleFormState>(
    createEmptyRuleForm(),
  );
  const [isSavingRule, setIsSavingRule] = useState(false);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product] as const)),
    [products],
  );

  const storagesById = useMemo(
    () => new Map(storages.map((storage) => [storage.id, storage] as const)),
    [storages],
  );

  const getStorageDisplayName = (storage?: Storage) => {
    if (!storage) {
      return t("inventoryTransfer.unknownStorage", "Unknown storage");
    }

    return storage.isSystem
      ? t(`storages.${storage.name.toLowerCase()}`) || storage.name
      : storage.name;
  };

  const sourceProducts = useMemo(
    () =>
      inventory
        .filter((row) => row.storageId === sourceStorageId)
        .map((row) => {
          const product = products.find((entry) => entry.id === row.productId);
          if (!product || product.isDeleted) {
            return null;
          }

          return { row, product };
        })
        .filter(
          (
            entry,
          ): entry is { row: (typeof inventory)[number]; product: Product } =>
            !!entry,
        ),
    [inventory, products, sourceStorageId],
  );

  const availableTargetStorages = useMemo(
    () => storages.filter((storage) => storage.id !== sourceStorageId),
    [storages, sourceStorageId],
  );

  const activeRules = useMemo(
    () => reorderRules.filter((rule) => !isRuleExpired(rule)),
    [reorderRules],
  );

  const selectedProduct = ruleForm.productId
    ? productsById.get(ruleForm.productId)
    : undefined;

  const ruleSourceProducts = useMemo(
    () =>
      inventory
        .filter(
          (row) =>
            row.storageId === ruleForm.sourceStorageId && row.quantity > 0,
        )
        .map((row) => {
          const product = products.find((entry) => entry.id === row.productId);
          if (!product || product.isDeleted) {
            return null;
          }

          return { row, product };
        })
        .filter(
          (
            entry,
          ): entry is { row: (typeof inventory)[number]; product: Product } =>
            !!entry,
        )
        .sort((left, right) =>
          left.product.name.localeCompare(right.product.name),
        ),
    [inventory, products, ruleForm.sourceStorageId],
  );

  const selectedTransferItems = useMemo(
    () =>
      sourceProducts
        .filter(({ product }) => selectedProductIds.has(product.id))
        .map(({ product, row }) => ({
          productId: product.id,
          productName: product.name,
          unit: product.unit,
          availableQuantity: row.quantity,
          quantity: Number(transferQuantities[product.id] || 0),
        })),
    [selectedProductIds, sourceProducts, transferQuantities],
  );

  const hasInvalidTransferQuantity = selectedTransferItems.some(
    (item) =>
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0 ||
      item.quantity > item.availableQuantity,
  );

  const automationStats = useMemo(() => {
    const triggeredToday = activeRules.filter((rule) =>
      rule.lastTriggeredAt?.startsWith(getTodayDateKey()),
    ).length;
    const indefiniteCount = activeRules.filter(
      (rule) => rule.isIndefinite,
    ).length;
    const expiringSoonCount = activeRules.filter((rule) => {
      const remainingDays = getRemainingDays(rule.expiresOn);
      return remainingDays !== null && remainingDays >= 0 && remainingDays <= 7;
    }).length;

    return {
      activeCount: activeRules.length,
      triggeredToday,
      indefiniteCount,
      expiringSoonCount,
    };
  }, [activeRules]);

  const automationTabCountLabel =
    automationStats.activeCount > 99
      ? "99+"
      : String(automationStats.activeCount);

  useEffect(() => {
    const pendingTab = consumePendingInventoryTransferTab();
    if (pendingTab) {
      setActiveTab(pendingTab);
    }

    const handleOpenTab = (event: Event) => {
      const requestedTab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      if (isInventoryTransferTab(requestedTab)) {
        setActiveTab(requestedTab);
      }
    };

    window.addEventListener(
      INVENTORY_TRANSFER_TAB_EVENT,
      handleOpenTab as EventListener,
    );
    return () =>
      window.removeEventListener(
        INVENTORY_TRANSFER_TAB_EVENT,
        handleOpenTab as EventListener,
      );
  }, []);

  const resetRuleDialog = () => {
    setEditingRuleId(null);
    setRuleForm(createEmptyRuleForm());
    setIsSavingRule(false);
  };

  const handleRuleDialogChange = (open: boolean) => {
    setIsRuleDialogOpen(open);
    if (!open) {
      resetRuleDialog();
    }
  };

  const openNewRuleDialog = () => {
    setEditingRuleId(null);
    setRuleForm(createEmptyRuleForm());
    setIsRuleDialogOpen(true);
  };

  const openEditRuleDialog = (rule: ReorderTransferRule) => {
    setEditingRuleId(rule.id);
    setRuleForm(buildRuleForm(rule));
    setIsRuleDialogOpen(true);
  };

  const toggleProduct = (productId: string, availableQuantity: number) => {
    setSelectedProductIds((previous) => {
      const next = new Set(previous);
      const isSelected = next.has(productId);

      if (isSelected) {
        next.delete(productId);
      } else {
        next.add(productId);
      }

      setTransferQuantities((current) => {
        const nextQuantities = { ...current };
        if (isSelected) {
          delete nextQuantities[productId];
        } else if (!nextQuantities[productId]) {
          nextQuantities[productId] = String(availableQuantity);
        }
        return nextQuantities;
      });

      return next;
    });
  };

  const selectAllProducts = () => {
    if (selectedProductIds.size === sourceProducts.length) {
      setSelectedProductIds(new Set());
      setTransferQuantities({});
      return;
    }

    setSelectedProductIds(
      new Set(sourceProducts.map(({ product }) => product.id)),
    );
    setTransferQuantities((current) => {
      const nextQuantities: Record<string, string> = {};
      for (const { product, row } of sourceProducts) {
        nextQuantities[product.id] =
          current[product.id] || String(row.quantity);
      }
      return nextQuantities;
    });
  };

  const handleTransfer = async () => {
    if (
      !activeWorkspace ||
      !sourceStorageId ||
      !targetStorageId ||
      selectedProductIds.size === 0
    ) {
      return;
    }

    if (hasInvalidTransferQuantity) {
      toast({
        title: t("common.error", "Error"),
        description: t(
          "inventoryTransfer.invalidQuantity",
          "Enter a valid quantity for each selected product.",
        ),
        variant: "destructive",
      });
      return;
    }

    setIsTransferring(true);

    try {
      const result = await transferInventoryBetweenStorages(
        activeWorkspace.id,
        sourceStorageId,
        targetStorageId,
        selectedTransferItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        })),
      );

      const targetStorage = storages.find(
        (storage) => storage.id === targetStorageId,
      );
      toast({
        title: t("inventoryTransfer.success", "Transfer Complete"),
        description: t(
          "inventoryTransfer.successMessage",
          "{{count}} products moved to {{storage}}",
          {
            count: result.movedCount,
            storage: getStorageDisplayName(targetStorage),
          },
        ),
      });

      setSelectedProductIds(new Set());
      setTransferQuantities({});
      setTargetStorageId("");
    } catch (error) {
      toast({
        title: t("common.error", "Error"),
        description:
          error instanceof Error
            ? error.message
            : t("inventoryTransfer.error", "Failed to transfer products"),
        variant: "destructive",
      });
    } finally {
      setIsTransferring(false);
    }
  };

  const handleSaveRule = async () => {
    if (!activeWorkspace) {
      return;
    }

    setIsSavingRule(true);

    try {
      const payload = {
        productId: ruleForm.productId,
        sourceStorageId: ruleForm.sourceStorageId,
        destinationStorageId: ruleForm.destinationStorageId,
        minStockLevel: Number(ruleForm.minStockLevel),
        transferQuantity: Number(ruleForm.transferQuantity),
        expiresOn: ruleForm.isIndefinite ? null : ruleForm.expiresOn,
        isIndefinite: ruleForm.isIndefinite,
      };

      if (editingRuleId) {
        await updateReorderTransferRule(editingRuleId, payload);
        toast({
          title: t(
            "inventoryTransfer.automation.ruleUpdatedTitle",
            "Rule updated",
          ),
          description: t(
            "inventoryTransfer.automation.ruleUpdatedDescription",
            "Automatic reorder rule saved successfully.",
          ),
        });
      } else {
        await createReorderTransferRule(activeWorkspace.id, payload);
        toast({
          title: t(
            "inventoryTransfer.automation.ruleCreatedTitle",
            "Rule created",
          ),
          description: t(
            "inventoryTransfer.automation.ruleCreatedDescription",
            "Automatic reorder rule is now active.",
          ),
        });
      }

      handleRuleDialogChange(false);
    } catch (error) {
      toast({
        title: t("common.error", "Error"),
        description:
          error instanceof Error
            ? error.message
            : t(
                "inventoryTransfer.automation.ruleSaveError",
                "Failed to save reorder rule",
              ),
        variant: "destructive",
      });
      setIsSavingRule(false);
    }
  };

  const handleDeleteRule = async (rule: ReorderTransferRule) => {
    const confirmed = window.confirm(
      t(
        "inventoryTransfer.automation.deleteConfirm",
        "Delete this reorder rule?",
      ),
    );
    if (!confirmed) {
      return;
    }

    setDeletingRuleId(rule.id);

    try {
      await deleteReorderTransferRule(rule.id);
      toast({
        title: t(
          "inventoryTransfer.automation.ruleDeletedTitle",
          "Rule deleted",
        ),
        description: t(
          "inventoryTransfer.automation.ruleDeletedDescription",
          "The reorder rule has been removed.",
        ),
      });
    } catch (error) {
      toast({
        title: t("common.error", "Error"),
        description:
          error instanceof Error
            ? error.message
            : t(
                "inventoryTransfer.automation.ruleDeleteError",
                "Failed to delete reorder rule",
              ),
        variant: "destructive",
      });
    } finally {
      setDeletingRuleId(null);
    }
  };

  const sourceStorage = storages.find(
    (storage) => storage.id === sourceStorageId,
  );
  const targetStorage = storages.find(
    (storage) => storage.id === targetStorageId,
  );
  const sourceDisplayName = getStorageDisplayName(sourceStorage);
  const targetDisplayName = getStorageDisplayName(targetStorage);

  const isRuleFormInvalid =
    !ruleForm.productId ||
    !ruleForm.sourceStorageId ||
    !ruleForm.destinationStorageId ||
    !ruleForm.minStockLevel ||
    !ruleForm.transferQuantity ||
    (!ruleForm.isIndefinite && !ruleForm.expiresOn);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ArrowRightLeft className="h-6 w-6 text-primary" />
          {t("inventoryTransfer.title", "Inventory Transfer")}
        </h1>
        <p className="text-muted-foreground">
          {t(
            "inventoryTransfer.subtitle",
            "Move products between storage locations and keep key shelves automatically replenished.",
          )}
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (isInventoryTransferTab(value)) {
            setActiveTab(value);
          }
        }}
        className="space-y-6"
      >
        <TabsList className="grid h-auto min-h-12 w-full max-w-xl grid-cols-2 rounded-2xl items-stretch">
          <TabsTrigger value="manual" className="min-h-10">
            {t("inventoryTransfer.tabs.manual", "Manual Transfer")}
          </TabsTrigger>
          <TabsTrigger
            value="automation"
            className="group min-h-10 gap-2 px-2 sm:px-3"
          >
            <span className="truncate">
              {t("inventoryTransfer.tabs.automation", "Reorder Automation")}
            </span>
            {automationStats.activeCount > 0 && (
              <>
                <span className="inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-sky-500/12 px-1.5 text-[11px] font-semibold text-sky-700 ring-1 ring-sky-500/15 dark:bg-sky-400/15 dark:text-sky-200 dark:ring-sky-300/15 md:hidden group-data-[state=active]:bg-sky-600/12 group-data-[state=active]:text-sky-700 group-data-[state=active]:ring-sky-500/20 dark:group-data-[state=active]:bg-sky-400/20 dark:group-data-[state=active]:text-sky-100">
                  {automationTabCountLabel}
                </span>
                <span className="hidden shrink-0 items-center gap-1 rounded-full bg-sky-500/12 px-2 py-1 text-[11px] font-semibold text-sky-700 ring-1 ring-sky-500/15 shadow-[0_8px_18px_rgba(14,165,233,0.10)] dark:bg-sky-400/15 dark:text-sky-200 dark:ring-sky-300/15 dark:shadow-[0_8px_18px_rgba(14,165,233,0.14)] md:inline-flex group-data-[state=active]:bg-sky-600/12 group-data-[state=active]:text-sky-700 group-data-[state=active]:ring-sky-500/20 dark:group-data-[state=active]:bg-sky-400/20 dark:group-data-[state=active]:text-sky-100">
                  <Bot className="h-3.5 w-3.5" />
                  <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full border border-white/80 bg-sky-600 px-1 text-[9px] font-semibold leading-none text-white shadow-sm dark:border-sky-100/70 dark:bg-sky-300 dark:text-slate-950 group-data-[state=active]:bg-sky-600 group-data-[state=active]:text-white dark:group-data-[state=active]:bg-sky-300 dark:group-data-[state=active]:text-slate-950">
                    {automationTabCountLabel}
                  </span>
                </span>
              </>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="manual" className="space-y-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="rounded-2xl border-2 shadow-sm">
              <CardHeader className="border-b bg-muted/30 p-4">
                <CardTitle className="flex items-center gap-2 text-base font-bold">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                    1
                  </span>
                  {t("inventoryTransfer.selectSource", "Select Source")}
                </CardTitle>
                <CardDescription>
                  {t(
                    "inventoryTransfer.sourceDescription",
                    "Choose storage to transfer from",
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <Select
                  value={sourceStorageId}
                  onValueChange={(id) => {
                    setSourceStorageId(id);
                    setTargetStorageId("");
                    setSelectedProductIds(new Set());
                    setTransferQuantities({});
                  }}
                >
                  <SelectTrigger className="rounded-xl">
                    <SelectValue
                      placeholder={t(
                        "inventoryTransfer.selectStorage",
                        "Select storage...",
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {storages.map((storage) => (
                      <SelectItem key={storage.id} value={storage.id}>
                        <div className="flex items-center gap-2">
                          <Warehouse className="h-4 w-4" />
                          {getStorageDisplayName(storage)}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {sourceStorageId && (
                  <div className="text-sm text-muted-foreground">
                    {sourceProducts.length}{" "}
                    {t(
                      "inventoryTransfer.productsAvailable",
                      "products available",
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-2xl border-2 shadow-sm">
              <CardHeader className="border-b bg-muted/30 p-4">
                <CardTitle className="flex items-center gap-2 text-base font-bold">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                    2
                  </span>
                  {t("inventoryTransfer.selectProducts", "Select Products")}
                </CardTitle>
                <CardDescription>
                  {t(
                    "inventoryTransfer.productsDescription",
                    "Choose products to transfer",
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4">
                {!sourceStorageId ? (
                  <div className="py-8 text-center text-muted-foreground">
                    <Package className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    <p className="text-sm">
                      {t(
                        "inventoryTransfer.selectSourceFirst",
                        "Select a source storage first",
                      )}
                    </p>
                  </div>
                ) : sourceProducts.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">
                    <Package className="mx-auto mb-2 h-8 w-8 opacity-30" />
                    <p className="text-sm">
                      {t(
                        "inventoryTransfer.noProducts",
                        "No products in this storage",
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    <div className="flex items-center gap-2 border-b pb-2">
                      <Checkbox
                        id="select-all"
                        checked={
                          selectedProductIds.size === sourceProducts.length
                        }
                        onCheckedChange={selectAllProducts}
                      />
                      <Label
                        htmlFor="select-all"
                        className="cursor-pointer text-sm font-medium"
                      >
                        {t("common.selectAll", "Select All")} (
                        {sourceProducts.length})
                      </Label>
                    </div>

                    {sourceProducts.map(({ row, product }) => (
                      <div
                        key={row.id}
                        className="flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-muted/30"
                      >
                        <Checkbox
                          id={product.id}
                          checked={selectedProductIds.has(product.id)}
                          onCheckedChange={() =>
                            toggleProduct(product.id, row.quantity)
                          }
                        />
                        <Label
                          htmlFor={product.id}
                          className="flex-1 cursor-pointer"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">
                              {product.name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {row.quantity} {product.unit}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {product.sku}
                          </div>
                        </Label>
                        <div className="w-24">
                          <Input
                            type="number"
                            min="1"
                            max={row.quantity}
                            step="1"
                            value={transferQuantities[product.id] || ""}
                            disabled={!selectedProductIds.has(product.id)}
                            onChange={(event) =>
                              setTransferQuantities((current) => ({
                                ...current,
                                [product.id]: event.target.value,
                              }))
                            }
                            className="h-9 rounded-lg text-center"
                            aria-label={`${product.name} ${t("common.quantity", "Quantity")}`}
                          />
                          {selectedProductIds.has(product.id) && (
                            <div className="mt-1 text-center text-[11px] text-muted-foreground">
                              {`${t("inventoryTransfer.available", "Available")}: ${row.quantity} ${product.unit}`}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-2xl border-2 shadow-sm">
              <CardHeader className="border-b bg-muted/30 p-4">
                <CardTitle className="flex items-center gap-2 text-base font-bold">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                    3
                  </span>
                  {t(
                    "inventoryTransfer.selectDestination",
                    "Select Destination",
                  )}
                </CardTitle>
                <CardDescription>
                  {t(
                    "inventoryTransfer.destinationDescription",
                    "Choose target storage",
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                <Select
                  value={targetStorageId}
                  onValueChange={setTargetStorageId}
                  disabled={!sourceStorageId}
                >
                  <SelectTrigger className="rounded-xl">
                    <SelectValue
                      placeholder={t(
                        "inventoryTransfer.selectStorage",
                        "Select storage...",
                      )}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTargetStorages.map((storage) => (
                      <SelectItem key={storage.id} value={storage.id}>
                        <div className="flex items-center gap-2">
                          <Warehouse className="h-4 w-4" />
                          {getStorageDisplayName(storage)}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {selectedProductIds.size > 0 && targetStorageId && (
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{sourceDisplayName}</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{targetDisplayName}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {selectedProductIds.size}{" "}
                      {t(
                        "inventoryTransfer.productsSelected",
                        "products selected",
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleTransfer}
              disabled={
                !sourceStorageId ||
                !targetStorageId ||
                selectedProductIds.size === 0 ||
                hasInvalidTransferQuantity ||
                isTransferring ||
                !canEdit
              }
              className="gap-2 rounded-xl px-8 shadow-lg"
              size="lg"
            >
              {isTransferring ? (
                <>
                  <ArrowRightLeft className="h-5 w-5 animate-spin" />
                  {t("inventoryTransfer.transferring", "Transferring...")}
                </>
              ) : (
                <>
                  <Check className="h-5 w-5" />
                  {t("inventoryTransfer.confirmTransfer", "Confirm Transfer")}
                </>
              )}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="automation" className="space-y-6">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_320px]">
            <Card className="rounded-3xl border shadow-sm">
              <CardHeader className="flex flex-col gap-4 border-b bg-muted/20 p-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <CardTitle className="text-xl">
                    {t(
                      "inventoryTransfer.automation.title",
                      "Active Reorder Rules",
                    )}
                  </CardTitle>
                  <CardDescription>
                    {t(
                      "inventoryTransfer.automation.subtitle",
                      "Monitor destination stock and move replenishment stock automatically when it drops below target.",
                    )}
                  </CardDescription>
                </div>
                {canEdit && (
                  <Button
                    className="gap-2 rounded-2xl"
                    onClick={openNewRuleDialog}
                  >
                    <Plus className="h-4 w-4" />
                    {t("inventoryTransfer.automation.newRule", "New Rule")}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="p-6">
                {activeRules.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-muted-foreground/30 bg-muted/10 px-6 py-12 text-center">
                    <Bot className="mx-auto mb-4 h-10 w-10 text-primary/70" />
                    <h3 className="text-lg font-semibold">
                      {t(
                        "inventoryTransfer.automation.emptyTitle",
                        "No reorder rules yet",
                      )}
                    </h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t(
                        "inventoryTransfer.automation.emptyDescription",
                        "Create a rule to replenish a destination storage automatically whenever it falls below your threshold.",
                      )}
                    </p>
                    {canEdit && (
                      <Button
                        className="mt-5 rounded-2xl"
                        onClick={openNewRuleDialog}
                      >
                        {t(
                          "inventoryTransfer.automation.createFirstRule",
                          "Create First Rule",
                        )}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-3xl border">
                    <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_120px_84px] gap-4 border-b bg-muted/20 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground md:grid">
                      <div>
                        {t(
                          "inventoryTransfer.automation.columns.ruleItem",
                          "Rule Item",
                        )}
                      </div>
                      <div>
                        {t(
                          "inventoryTransfer.automation.columns.pathway",
                          "Movement Pathway",
                        )}
                      </div>
                      <div>
                        {t(
                          "inventoryTransfer.automation.columns.thresholds",
                          "Thresholds",
                        )}
                      </div>
                      <div>
                        {t(
                          "inventoryTransfer.automation.columns.schedule",
                          "Schedule",
                        )}
                      </div>
                      <div>{t("common.status", "Status")}</div>
                      <div>{t("common.actions", "Actions")}</div>
                    </div>

                    <div className="divide-y">
                      {activeRules.map((rule) => {
                        const ruleProduct = productsById.get(rule.productId);
                        const source = storagesById.get(rule.sourceStorageId);
                        const destination = storagesById.get(
                          rule.destinationStorageId,
                        );
                        const remainingDays = getRemainingDays(rule.expiresOn);

                        return (
                          <div
                            key={rule.id}
                            className="grid gap-4 px-5 py-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_120px_84px] md:items-center"
                          >
                            <div>
                              <div className="text-sm font-semibold">
                                {ruleProduct?.name ||
                                  t(
                                    "inventoryTransfer.automation.unknownProduct",
                                    "Unknown product",
                                  )}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                SKU: {ruleProduct?.sku || "N/A"}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 text-sm">
                              <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                                {getStorageDisplayName(source)}
                              </span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                                {getStorageDisplayName(destination)}
                              </span>
                            </div>

                            <div className="space-y-1 text-sm">
                              <div>
                                {t(
                                  "inventoryTransfer.automation.minLabel",
                                  "Min",
                                )}
                                :{" "}
                                <span className="font-semibold">
                                  {rule.minStockLevel}
                                </span>
                              </div>
                              <div className="text-muted-foreground">
                                {t(
                                  "inventoryTransfer.automation.moveLabel",
                                  "Move",
                                )}
                                :{" "}
                                <span className="font-semibold text-foreground">
                                  {rule.transferQuantity}
                                </span>
                              </div>
                            </div>

                            <div className="space-y-1 text-sm">
                              {rule.isIndefinite ? (
                                <div className="flex items-center gap-2 font-medium">
                                  <Infinity className="h-4 w-4 text-primary" />
                                  {t(
                                    "inventoryTransfer.automation.indefinite",
                                    "Indefinite",
                                  )}
                                </div>
                              ) : (
                                <>
                                  <div className="font-medium">
                                    {formatDateLabel(rule.expiresOn)}
                                  </div>
                                  {remainingDays !== null && (
                                    <div className="text-xs text-muted-foreground">
                                      {remainingDays >= 0
                                        ? t(
                                            "inventoryTransfer.automation.expiresInDays",
                                            "Expires in {{count}} days",
                                            { count: remainingDays },
                                          )
                                        : t(
                                            "inventoryTransfer.automation.expired",
                                            "Expired",
                                          )}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>

                            <div>
                              <span className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
                                {t(
                                  "inventoryTransfer.automation.activeStatus",
                                  "Active",
                                )}
                              </span>
                            </div>

                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="rounded-xl"
                                onClick={() => openEditRuleDialog(rule)}
                                disabled={!canEdit}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="rounded-xl text-destructive hover:text-destructive"
                                disabled={
                                  deletingRuleId === rule.id || !canEdit
                                }
                                onClick={() => handleDeleteRule(rule)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-3xl border-0 bg-[linear-gradient(180deg,#166534,#0f3f2d)] text-white shadow-xl">
              <CardHeader className="space-y-3 p-6">
                <CardTitle className="text-2xl">
                  {t(
                    "inventoryTransfer.automation.insightTitle",
                    "Automation Insight",
                  )}
                </CardTitle>
                <CardDescription className="text-emerald-100/85">
                  {t(
                    "inventoryTransfer.automation.insightDescription",
                    "Reorder rules are checked after local inventory movements so your destination storage can refill the moment it drops below target.",
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 p-6 pt-0">
                <div className="rounded-2xl bg-white/10 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">
                    {t(
                      "inventoryTransfer.automation.activeRulesStat",
                      "Active Rules",
                    )}
                  </div>
                  <div className="mt-2 text-4xl font-semibold">
                    {automationStats.activeCount}
                  </div>
                </div>
                <div className="rounded-2xl bg-white/10 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">
                    {t(
                      "inventoryTransfer.automation.triggeredTodayStat",
                      "Triggered Today",
                    )}
                  </div>
                  <div className="mt-2 text-3xl font-semibold">
                    {automationStats.triggeredToday}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-2xl bg-white/10 p-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-emerald-100/80">
                      {t(
                        "inventoryTransfer.automation.indefiniteStat",
                        "Indefinite",
                      )}
                    </div>
                    <div className="mt-2 text-2xl font-semibold">
                      {automationStats.indefiniteCount}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-white/10 p-4">
                    <div className="text-xs uppercase tracking-[0.18em] text-emerald-100/80">
                      {t(
                        "inventoryTransfer.automation.expiringSoonStat",
                        "Expiring Soon",
                      )}
                    </div>
                    <div className="mt-2 text-2xl font-semibold">
                      {automationStats.expiringSoonCount}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={isRuleDialogOpen} onOpenChange={handleRuleDialogChange}>
        <DialogContent className="left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-0 sm:left-[50%] sm:top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] sm:h-auto sm:max-h-[min(calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),920px)] sm:w-[calc(100vw-2rem)] sm:max-w-5xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border-border/60">
          <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1.7fr)_320px]">
            <div className="flex min-h-0 flex-1 flex-col">
              <DialogHeader className="space-y-2 border-b bg-background px-4 py-4 pr-14 text-left sm:px-8 sm:py-6">
                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                  <Bot className="h-3.5 w-3.5" />
                  {t(
                    "inventoryTransfer.automation.configurationMode",
                    "Configuration Mode",
                  )}
                </div>
                <DialogTitle className="text-2xl">
                  {editingRuleId
                    ? t(
                        "inventoryTransfer.automation.editRuleTitle",
                        "Edit Automation Rule",
                      )
                    : t(
                        "inventoryTransfer.automation.newRuleTitle",
                        "New Automation Rule",
                      )}
                </DialogTitle>
                <DialogDescription>
                  {t(
                    "inventoryTransfer.automation.dialogDescription",
                    "Choose the product, replenishment path, threshold, and optional end date for this automatic transfer rule.",
                  )}
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-6 sm:px-8 sm:py-6 sm:pb-8">
                <div className="space-y-5 sm:space-y-6">
                  <div className="space-y-3">
                    <Label>
                      {t(
                        "inventoryTransfer.automation.sourceStorage",
                        "Source Storage",
                      )}
                    </Label>
                    <Select
                      value={ruleForm.sourceStorageId}
                      onValueChange={(value) =>
                        setRuleForm((current) => ({
                          ...current,
                          sourceStorageId: value,
                          productId: "",
                          destinationStorageId:
                            current.destinationStorageId === value
                              ? ""
                              : current.destinationStorageId,
                        }))
                      }
                    >
                      <SelectTrigger className="h-12 rounded-2xl">
                        <SelectValue
                          placeholder={t(
                            "inventoryTransfer.selectStorage",
                            "Select storage...",
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {storages
                          .filter(
                            (storage) =>
                              storage.id !== ruleForm.destinationStorageId,
                          )
                          .map((storage) => (
                            <SelectItem key={storage.id} value={storage.id}>
                              {getStorageDisplayName(storage)}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-3">
                    <Label>
                      {t(
                        "inventoryTransfer.automation.selectProductFromStorage",
                        "Product From Source Storage",
                      )}
                    </Label>
                    {!ruleForm.sourceStorageId ? (
                      <div className="rounded-2xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
                        {t(
                          "inventoryTransfer.automation.selectSourceFirst",
                          "Select a source storage first to view its products.",
                        )}
                      </div>
                    ) : ruleSourceProducts.length === 0 ? (
                      <div className="rounded-2xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
                        {t(
                          "inventoryTransfer.automation.noProductsInSource",
                          "No products are currently available in this storage.",
                        )}
                      </div>
                    ) : (
                      <div className="max-h-56 space-y-2 overflow-y-auto rounded-2xl border p-2">
                        {ruleSourceProducts.map(({ row, product }) => (
                          <button
                            key={`${row.id}:${product.id}`}
                            type="button"
                            onClick={() =>
                              setRuleForm((current) => ({
                                ...current,
                                productId: product.id,
                              }))
                            }
                            className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left transition-colors ${
                              ruleForm.productId === product.id
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted"
                            }`}
                          >
                            <div>
                              <div className="text-sm font-semibold">
                                {product.name}
                              </div>
                              <div
                                className={`text-xs ${ruleForm.productId === product.id ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                              >
                                {product.sku}
                              </div>
                            </div>
                            <div
                              className={`text-right text-xs ${ruleForm.productId === product.id ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                            >
                              <div>
                                {row.quantity} {product.unit}
                              </div>
                              <div>
                                {t("inventoryTransfer.available", "Available")}
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {selectedProduct && (
                    <div className="rounded-2xl border bg-muted/20 p-4 text-sm">
                      <div className="font-semibold">
                        {selectedProduct.name}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {selectedProduct.sku}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label>
                      {t(
                        "inventoryTransfer.automation.destinationStorage",
                        "Destination Storage",
                      )}
                    </Label>
                    <Select
                      value={ruleForm.destinationStorageId}
                      onValueChange={(value) =>
                        setRuleForm((current) => ({
                          ...current,
                          destinationStorageId: value,
                        }))
                      }
                    >
                      <SelectTrigger className="h-12 rounded-2xl">
                        <SelectValue
                          placeholder={t(
                            "inventoryTransfer.selectStorage",
                            "Select storage...",
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {storages
                          .filter(
                            (storage) =>
                              storage.id !== ruleForm.sourceStorageId,
                          )
                          .map((storage) => (
                            <SelectItem key={storage.id} value={storage.id}>
                              {getStorageDisplayName(storage)}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="rule-min-stock">
                        {t(
                          "inventoryTransfer.automation.minStockLevel",
                          "Minimum Stock Level",
                        )}
                      </Label>
                      <div className="relative">
                        <Input
                          id="rule-min-stock"
                          type="number"
                          min="0"
                          step="1"
                          value={ruleForm.minStockLevel}
                          onChange={(event) =>
                            setRuleForm((current) => ({
                              ...current,
                              minStockLevel: event.target.value,
                            }))
                          }
                          className="h-12 rounded-2xl pr-16"
                        />
                        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {t("inventoryTransfer.automation.units", "Units")}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="rule-transfer-quantity">
                        {t(
                          "inventoryTransfer.automation.transferQuantity",
                          "Transfer Quantity",
                        )}
                      </Label>
                      <div className="relative">
                        <Input
                          id="rule-transfer-quantity"
                          type="number"
                          min="1"
                          step="1"
                          value={ruleForm.transferQuantity}
                          onChange={(event) =>
                            setRuleForm((current) => ({
                              ...current,
                              transferQuantity: event.target.value,
                            }))
                          }
                          className="h-12 rounded-2xl pr-16"
                        />
                        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {t("inventoryTransfer.automation.units", "Units")}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-3xl bg-muted/20 p-5">
                    <div className="space-y-3">
                      <Label htmlFor="rule-expiry">
                        {t(
                          "inventoryTransfer.automation.scheduleExpiry",
                          "Schedule / Expiry Date",
                        )}
                      </Label>
                      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)] md:items-end">
                        <div className="space-y-2">
                          <div className="relative">
                            <DateTimePicker
                              id="rule-expiry"
                              mode="date"
                              date={parseLocalDateValue(ruleForm.expiresOn)}
                              disabled={ruleForm.isIndefinite}
                              setDate={(value) =>
                                setRuleForm((current) => ({
                                  ...current,
                                  expiresOn: value
                                    ? formatLocalDateValue(value)
                                    : "",
                                }))
                              }
                              placeholder={t(
                                "inventoryTransfer.automation.scheduleExpiry",
                                "Schedule / Expiry Date",
                              )}
                              buttonClassName="h-12 rounded-2xl"
                            />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t(
                              "inventoryTransfer.automation.defaultExpiryHint",
                              "Defaults to the end of the current year unless you mark the rule as indefinite.",
                            )}
                          </p>
                        </div>

                        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                          <label className="flex items-center gap-3 text-sm font-medium">
                            <Checkbox
                              checked={ruleForm.isIndefinite}
                              onCheckedChange={(checked) =>
                                setRuleForm((current) => ({
                                  ...current,
                                  isIndefinite: Boolean(checked),
                                }))
                              }
                            />
                            {t(
                              "inventoryTransfer.automation.indefiniteRule",
                              "Indefinite Rule",
                            )}
                          </label>

                          <Button
                            type="button"
                            onClick={handleSaveRule}
                            disabled={isRuleFormInvalid || isSavingRule}
                            className="h-12 w-full rounded-2xl px-8 md:w-auto"
                          >
                            {isSavingRule
                              ? t(
                                  "inventoryTransfer.automation.savingRule",
                                  "Saving Rule...",
                                )
                              : t(
                                  "inventoryTransfer.automation.saveRule",
                                  "Save Rule",
                                )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <DialogFooter className="border-t bg-background/95 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-start sm:px-8">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full sm:w-auto"
                  onClick={() => handleRuleDialogChange(false)}
                >
                  {t("common.cancel", "Cancel")}
                </Button>
              </DialogFooter>
            </div>

            <div className="hidden min-h-0 overflow-y-auto rounded-b-3xl bg-[linear-gradient(180deg,#166534,#0f3f2d)] p-6 text-white lg:block lg:rounded-b-none lg:rounded-r-3xl">
              <div className="space-y-4">
                <h3 className="text-2xl font-semibold">
                  {t(
                    "inventoryTransfer.automation.insightTitle",
                    "Automation Insight",
                  )}
                </h3>
                <p className="text-sm text-emerald-100/85">
                  {t(
                    "inventoryTransfer.automation.modalInsightDescription",
                    "Rules watch the destination storage. If it falls under the minimum level, the configured quantity is moved from the source storage automatically.",
                  )}
                </p>

                <div className="space-y-3 pt-4">
                  <div className="rounded-2xl bg-white/10 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">
                      {t(
                        "inventoryTransfer.automation.activeRulesStat",
                        "Active Rules",
                      )}
                    </div>
                    <div className="mt-2 text-4xl font-semibold">
                      {automationStats.activeCount}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-white/10 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">
                      {t(
                        "inventoryTransfer.automation.nextTriggerHint",
                        "Trigger Logic",
                      )}
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {selectedProduct
                        ? t(
                            "inventoryTransfer.automation.triggerPreview",
                            "If stock in {{storage}} drops below {{min}}, move {{qty}} units.",
                            {
                              storage: getStorageDisplayName(
                                storagesById.get(ruleForm.destinationStorageId),
                              ),
                              min: ruleForm.minStockLevel || 0,
                              qty: ruleForm.transferQuantity || 0,
                            },
                          )
                        : t(
                            "inventoryTransfer.automation.triggerPreviewFallback",
                            "Select a product and storages to preview the rule behavior.",
                          )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
