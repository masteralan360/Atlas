import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./database";
import type { SalesOrder, SalesOrderAgentAssignment, AgentCommissionEntry, AgentProductCommissionEntry } from "./models";
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from "@/workspace/workspaceMode";
import { clearWorkspaceCache, writeWorkspaceCache } from "@/workspace/workspaceCache";

const remote = vi.hoisted(() => ({ rpc: vi.fn(), fetch: vi.fn() }));
vi.mock("@/auth/supabase", () => ({ supabase: { rpc: remote.rpc, schema: () => ({}) } }));
vi.mock("@/lib/supabaseRequest", () => ({ runSupabaseAction: (_key: string, action: () => unknown) => action() }));
vi.mock("./hooks", () => ({ fetchTableFromSupabase: remote.fetch }));
vi.mock("@/lib/network", () => ({ isOnline: () => true }));
vi.mock("@/hooks/useNetworkStatus", () => ({ useNetworkStatus: () => true }));

const workspace = "00000000-0000-4000-8000-000000000929";
const orderId = "00000000-0000-4000-8000-000000000930";
const actor = "00000000-0000-4000-8000-000000000931";
let commissions: typeof import("./agentCommissions");

beforeAll(async () => {
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value), removeItem: (key: string) => rows.delete(key) };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, location: { origin: "http://localhost" } });
  commissions = await import("./agentCommissions");
}, 60000);
beforeEach(async () => {
  await db.delete(); await db.open();
  remote.rpc.mockReset(); remote.fetch.mockReset();
  remote.rpc.mockResolvedValue({ data: 1, error: null });
  writeWorkspaceCache({ workspaceId: workspace, workspaceName: null, features: { sales_agent_commissions: true } });
  await db.sales_orders.put({
    id: orderId, workspaceId: workspace, createdBy: actor, status: "completed",
    orderNumber: "SO-2026-00025", customerId: "customer", customerName: "Customer",
    subtotal: 100, discount: 0, tax: 0, total: 100, currency: "iqd",
    exchangeRate: null, exchangeRateSource: null, exchangeRateTimestamp: null,
    actualDeliveryDate: "2026-09-01T00:00:00Z", expectedDeliveryDate: null,
    paidAt: null, paymentMethod: "cash", initialPaymentAmount: 0, linkedLoanId: null,
    isInstallmentBased: false, installmentCount: 0, installmentFrequency: null,
    firstDueDate: null, nextDueDate: null, reservedAt: null, returnStatus: "none", returnedAmount: 0,
    commissionEnabled: true, commissionMode: "tracked", isPaid: false, paymentStatus: "unpaid",
    paidAmount: 0, balanceAmount: 100, items: [], syncStatus: "synced", isDeleted: false,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", version: 1,
    lastSyncedAt: "2026-09-01T00:00:00Z",
  } as SalesOrder);
});
afterEach(() => { clearWorkspaceModeSnapshot(workspace); clearWorkspaceCache(workspace); vi.restoreAllMocks(); });
afterAll(async () => { await db.delete(); vi.unstubAllGlobals(); });

describe("fulfilled creator commission recovery in Cloud and Hybrid", () => {
  it.each(["cloud", "hybrid"] as const)("requests %s reconciliation for an unpaid sale and hydrates tracked server records", async dataMode => {
    writeWorkspaceModeSnapshot({ workspaceId: workspace, dataMode });
    const assignment = { id: "assignment", workspaceId: workspace, orderId, agentId: "agent", assignmentSource: "order_creator_product", assignedAt: "2026-09-01T00:00:00Z", syncStatus: "synced", isDeleted: false } as SalesOrderAgentAssignment;
    const aggregate = { id: "aggregate", workspaceId: workspace, orderId, assignmentId: "assignment", agentId: "agent", kind: "accrual", status: "earned", commissionMode: "tracked", amount: 300, productCommissionAmount: 300, planCommissionAmount: 0, currency: "iqd", isDeleted: false } as AgentCommissionEntry;
    const product = { id: "product-entry", workspaceId: workspace, orderId, assignmentId: "assignment", agentId: "agent", orderItemId: "line", quantity: 1, commissionPerUnit: 300, amount: 300, commissionMode: "tracked", currency: "iqd", kind: "accrual", isDeleted: false } as AgentProductCommissionEntry;
    remote.fetch.mockImplementation(async (tableName: string) => {
      if (tableName === "sales_order_agent_assignments") await db.sales_order_agent_assignments.put(assignment);
      if (tableName === "agent_commission_entries") await db.agent_commission_entries.put(aggregate);
      if (tableName === "agent_product_commission_entries") await db.agent_product_commission_entries.put(product);
    });
    await expect(commissions.reconcileSalesOrderCommission(workspace, orderId, actor)).resolves.toBeNull();
    expect(remote.rpc).toHaveBeenCalledExactlyOnceWith("reconcile_sales_agent_commission", { p_order_id: orderId, p_order_return_id: null });
    expect(remote.fetch.mock.calls.map(([table]) => table).sort()).toEqual(["sales_order_agent_assignments", "agent_commission_entries", "agent_product_commission_entries", "payment_transactions"].sort());
    expect(await db.agent_commission_entries.get("aggregate")).toEqual(aggregate);
    expect(await db.agent_product_commission_entries.get("product-entry")).toEqual(product);
    expect(await db.payment_transactions.count()).toBe(0);
    expect((await db.offline_mutations.toArray()).find(m => m.entityType === "sales_agent_commission_reconciliation")).toMatchObject({ status: "synced", payload: { orderId } });
  });
  it.each(["cloud", "hybrid"] as const)("keeps a failed %s request queued without exposing the server error or creating local financial records", async dataMode => {
    writeWorkspaceModeSnapshot({ workspaceId: workspace, dataMode });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    remote.rpc.mockResolvedValue({ data: null, error: { message: "internal PostgreSQL failure", code: "XX000" } });
    await expect(commissions.reconcileSalesOrderCommission(workspace, orderId, actor)).resolves.toBeNull();
    expect(remote.fetch).not.toHaveBeenCalled();
    expect((await db.offline_mutations.toArray()).find(m => m.entityType === "sales_agent_commission_reconciliation")).toMatchObject({ status: "pending", payload: { orderId } });
    expect(await db.agent_commission_entries.count()).toBe(0);
    expect(await db.agent_product_commission_entries.count()).toBe(0);
    expect(await db.payment_transactions.count()).toBe(0);
  });
});
