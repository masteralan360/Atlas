import i18n from "@/i18n/config";
import { isLocalWorkspaceMode } from "@/workspace/workspaceMode";

import { db } from "./database";
import type { StockBatchAllocation } from "./models";
import { adjustInventoryQuantity } from "./inventory";
import { commitStockBatchAllocations } from "./stockBatches";

export interface OfflinePosStockItem {
  productId: string;
  storageId: string;
  quantity: number;
}

export interface OfflinePosBatchPlan {
  productId: string;
  storageId: string;
  allocations: StockBatchAllocation[];
}

export async function applyOfflinePosStockEffects(input: {
  workspaceId: string;
  items: OfflinePosStockItem[];
  batchPlans: OfflinePosBatchPlan[];
  timestamp: string;
}) {
  if (!isLocalWorkspaceMode(input.workspaceId)) {
    throw new Error(i18n.t("inventory.errors.onlineRequired"));
  }

  await db.transaction(
    "rw",
    [db.inventory, db.products, db.storages, db.stock_batches],
    async () => {
      for (const item of input.items) {
        await adjustInventoryQuantity({
          workspaceId: input.workspaceId,
          productId: item.productId,
          storageId: item.storageId,
          quantityDelta: -item.quantity,
          timestamp: input.timestamp,
          skipRemoteHydration: true,
          skipRemoteSync: true,
          skipReorderCheck: true,
        });
      }

      for (const plan of input.batchPlans) {
        await commitStockBatchAllocations(
          input.workspaceId,
          plan.productId,
          plan.storageId,
          plan.allocations,
          {
            timestamp: input.timestamp,
            skipRemoteSync: true,
          },
        );
      }
    },
  );

  const { evaluateReorderTransferRulesForProduct } = await import("./reorderTransferRules");
  await Promise.all(
    [...new Set(input.items.map((item) => item.productId))].map((productId) =>
      evaluateReorderTransferRulesForProduct(input.workspaceId, productId),
    ),
  );
}
