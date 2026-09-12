import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  clearWorkspaceModeSnapshot,
  writeWorkspaceModeSnapshot,
} from "@/workspace/workspaceMode";
import { clearWorkspaceCache, writeWorkspaceCache } from "@/workspace/workspaceCache";

import { db } from "./database";
import type { Agent, OrderReturn, SalesOrder } from "./models";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000919";
let commissions: typeof import("./agentCommissions");

function installBrowserEnvironment() {
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:vitest",
  });
  Object.defineProperty(globalThis, "DOMMatrix", {
    configurable: true,
    value: class DOMMatrix {},
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: class Element {},
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: class HTMLElement extends (globalThis.Element as typeof Element) {},
  });
  const rows = new Map<string, string>();
  const storage = {
    get length() { return rows.size; },
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
    removeItem: (key: string) => rows.delete(key),
    clear: () => rows.clear(),
    key: (index: number) => Array.from(rows.keys())[index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: storage,
      sessionStorage: storage,
      URL: globalThis.URL,
      location: { origin: "http://localhost", hash: "", pathname: "/" },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  const documentHead = { appendChild: () => undefined };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      documentElement: { lang: "en", dir: "ltr" },
      head: documentHead,
      getElementsByTagName: () => [documentHead],
      createElement: () => ({
        setAttribute: () => undefined,
        appendChild: () => undefined,
      }),
      createTextNode: () => ({}),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
}

function fieldAgent(id: string, type: Agent["agentType"] = "field_agent"): Agent {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId: WORKSPACE_ID,
    businessPartnerId: crypto.randomUUID(),
    zone: "Baghdad",
    agentType: type,
    carModel: type === "driver" ? "Hilux" : null,
    plateNumber: type === "driver" ? "22-A-1" : null,
    linkedUserId: crypto.randomUUID(),
    status: "active",
    createdAt: now,
    updatedAt: now,
    syncStatus: "synced",
    lastSyncedAt: now,
    version: 1,
    isDeleted: false,
  };
}

function completedOrder(id: string): SalesOrder {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId: WORKSPACE_ID,
    orderNumber: "SO-1001",
    businessPartnerId: null,
    customerId: crypto.randomUUID(),
    customerName: "Customer",
    sourceStorageId: null,
    items: [{
      id: "line-1",
      productId: crypto.randomUUID(),
      productName: "Product",
      productSku: "P-1",
      quantity: 10,
      freeBonusQuantity: 0,
      lineTotal: 1_000,
      originalCurrency: "usd",
      originalUnitPrice: 100,
      convertedUnitPrice: 100,
      settlementCurrency: "usd",
      costPrice: 60,
      convertedCostPrice: 60,
      returnedQuantity: 0,
    }],
    subtotal: 1_000,
    discount: 0,
    tax: 0,
    total: 1_000,
    currency: "usd",
    exchangeRate: null,
    exchangeRateSource: null,
    exchangeRateTimestamp: null,
    status: "completed",
    actualDeliveryDate: now,
    expectedDeliveryDate: null,
    isPaid: true,
    paymentStatus: "paid",
    paidAmount: 1_000,
    balanceAmount: 0,
    paidAt: now,
    paymentMethod: "cash",
    initialPaymentAmount: 0,
    linkedLoanId: null,
    isInstallmentBased: false,
    installmentCount: 0,
    installmentFrequency: null,
    firstDueDate: null,
    nextDueDate: null,
    reservedAt: now,
    returnStatus: "none",
    returnedAmount: 0,
    createdBy: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    syncStatus: "synced",
    lastSyncedAt: now,
    version: 1,
    isDeleted: false,
  };
}

describe("sales agent commission lifecycle", () => {
  beforeAll(async () => {
    installBrowserEnvironment();
    commissions = await import("./agentCommissions");
  });

  beforeEach(async () => {
    await db.delete();
    await db.open();
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: "local" });
    writeWorkspaceCache({
      workspaceId: WORKSPACE_ID,
      workspaceName: null,
      features: {
        sales_agent_commissions: true,
        agent_sales_accounts: true,
      },
    });
  });

  afterEach(() => {
    clearWorkspaceModeSnapshot(WORKSPACE_ID);
    clearWorkspaceCache(WORKSPACE_ID);
  });
  afterAll(async () => { await db.delete(); });

  it("calculates return-aware profit commission from frozen delivery snapshots", () => {
    const order = completedOrder(crypto.randomUUID());
    order.items[0].returnedQuantity = 4;
    order.returnStatus = "partial";
    const calculation = commissions.calculateSalesOrderCommission(order, {
      ratePercent: 10,
      calculationBasis: "net_profit",
      includeTax: false,
      includeDeliveryCharge: true,
    }, {
      deliveryChargeAmount: 50,
      internalDeliveryCostAmount: 10,
    });

    // Revenue: 6 * 100 + 50. Cost: 6 * 60 + 10. Profit: 280.
    expect(calculation).toMatchObject({
      revenueAmount: 650,
      costAmount: 370,
      basisAmount: 280,
      commissionAmount: 28,
    });
  });

  it("keeps the sales-account commission beneficiary separate from manual assignments", async () => {
    const agent = { ...fieldAgent(crypto.randomUUID()), salesAccountEnabled: true };
    const order = { ...completedOrder(crypto.randomUUID()), salesAccountAgentId: agent.id };
    await db.agents.put(agent);
    await db.sales_orders.put(order);

    const assignment = await commissions.synchronizeSalesAccountAgentCommissionAssignment(
      WORKSPACE_ID,
      order.id,
      order.createdBy,
    );

    expect(assignment).toMatchObject({
      agentId: agent.id,
      assignmentSource: "sales_account",
      unassignedAt: null,
    });

    await db.sales_orders.put({
      ...order,
      salesAccountAgentId: null,
      updatedAt: new Date().toISOString(),
      version: order.version + 1,
    });
    await commissions.synchronizeSalesAccountAgentCommissionAssignment(WORKSPACE_ID, order.id, order.createdBy);

    const assignments = await db.sales_order_agent_assignments
      .where("[workspaceId+orderId]")
      .equals([WORKSPACE_ID, order.id])
      .toArray();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ assignmentSource: "sales_account" });
    expect(assignments[0].unassignedAt).toBeTruthy();
  });

  it("does not create a sales-account commission assignment when commission credit was not selected", async () => {
    const agent = { ...fieldAgent(crypto.randomUUID()), salesAccountEnabled: true };
    const order = {
      ...completedOrder(crypto.randomUUID()),
      salesAccountAgentId: agent.id,
      commissionEnabled: false,
    };
    await db.agents.put(agent);
    await db.sales_orders.put(order);

    const assignment = await commissions.synchronizeSalesAccountAgentCommissionAssignment(
      WORKSPACE_ID,
      order.id,
      order.createdBy,
    );

    expect(assignment).toBeNull();
    expect(await db.sales_order_agent_assignments.where("orderId").equals(order.id).count()).toBe(0);
  });

  it("does not restore a stale sales-account beneficiary after the order account changes", async () => {
    const firstAgent = { ...fieldAgent(crypto.randomUUID()), salesAccountEnabled: true };
    const secondAgent = { ...fieldAgent(crypto.randomUUID()), salesAccountEnabled: true };
    const order = { ...completedOrder(crypto.randomUUID()), salesAccountAgentId: firstAgent.id };
    await db.agents.bulkPut([firstAgent, secondAgent]);
    await db.sales_orders.put(order);

    await commissions.synchronizeSalesAccountAgentCommissionAssignment(WORKSPACE_ID, order.id, order.createdBy);
    await db.sales_orders.put({
      ...order,
      salesAccountAgentId: secondAgent.id,
      updatedAt: new Date().toISOString(),
      version: order.version + 1,
    });
    await commissions.synchronizeSalesAccountAgentCommissionAssignment(WORKSPACE_ID, order.id, order.createdBy);

    // This mirrors a form that was submitted just after the order account was
    // changed but before its local commission draft had re-rendered.
    await commissions.replaceSalesOrderAgentAssignments(WORKSPACE_ID, {
      orderId: order.id,
      assignedBy: order.createdBy,
      assignments: [{ agentId: firstAgent.id, assignmentSource: "sales_account" }],
    });

    const activeAssignments = commissions.getActiveSalesOrderAgentAssignments(
      await db.sales_order_agent_assignments
        .where("[workspaceId+orderId]")
        .equals([WORKSPACE_ID, order.id])
        .toArray(),
      order.id,
    );
    expect(activeAssignments).toHaveLength(1);
    expect(activeAssignments[0]).toMatchObject({
      agentId: secondAgent.id,
      assignmentSource: "sales_account",
    });
  });

  it("serializes concurrent sales-account beneficiary synchronization", async () => {
    const agent = { ...fieldAgent(crypto.randomUUID()), salesAccountEnabled: true };
    const order = { ...completedOrder(crypto.randomUUID()), salesAccountAgentId: agent.id };
    await db.agents.put(agent);
    await db.sales_orders.put(order);

    await Promise.all([
      commissions.synchronizeSalesAccountAgentCommissionAssignment(
        WORKSPACE_ID,
        order.id,
        order.createdBy,
      ),
      commissions.synchronizeSalesAccountAgentCommissionAssignment(
        WORKSPACE_ID,
        order.id,
        order.createdBy,
      ),
    ]);

    const activeAssignments = commissions.getActiveSalesOrderAgentAssignments(
      await db.sales_order_agent_assignments
        .where("[workspaceId+orderId]")
        .equals([WORKSPACE_ID, order.id])
        .toArray(),
      order.id,
    );
    expect(activeAssignments).toHaveLength(1);
    expect(activeAssignments[0]).toMatchObject({
      agentId: agent.id,
      assignmentSource: "sales_account",
    });
  });

  it("stores fixed cross-currency manual commissions in the order currency for agents without a plan", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = { ...completedOrder(crypto.randomUUID()), currency: "iqd" as const };
    order.exchangeRates = [{
      pair: "USD/IQD",
      rate: 150_000,
      priceBasisAmount: 100,
      source: "test",
      timestamp: new Date().toISOString(),
    }];
    await db.agents.put(agent);
    await db.sales_orders.put(order);

    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      manualCommission: {
        type: "fixed_amount",
        amount: 10,
        currency: "usd",
        exchangeRates: order.exchangeRates,
      },
    });
    const accrual = await db.agent_commission_entries
      .where("assignmentId")
      .equals(assignment!.id)
      .and((entry) => entry.kind === "accrual")
      .first();

    expect(assignment).toMatchObject({
      manualCommissionType: "fixed_amount",
      manualCommissionSourceAmount: 10,
      manualCommissionSourceCurrency: "usd",
      manualCommissionConvertedAmount: 15_000,
      manualCommissionExchangeRate: 1_500,
    });
    expect(accrual).toMatchObject({
      membershipId: null,
      planId: null,
      currency: "iqd",
      amount: 15_000,
      ratePercent: 0,
    });
  });

  it("calculates a fixed commission plan in the order currency using its locked rate snapshot", () => {
    const order = { ...completedOrder(crypto.randomUUID()), currency: "iqd" as const };
    order.exchangeRates = [{
      pair: "USD/IQD",
      rate: 150_000,
      priceBasisAmount: 100,
      source: "test",
      timestamp: new Date().toISOString(),
    }];

    const calculation = commissions.calculateSalesOrderCommission(order, {
      commissionType: "fixed_amount",
      ratePercent: 0,
      fixedAmount: 10,
      fixedCurrency: "usd",
      calculationBasis: "net_profit",
      includeTax: false,
      includeDeliveryCharge: false,
    });

    expect(calculation).toMatchObject({
      currency: "iqd",
      ratePercent: 0,
      commissionAmount: 15_000,
    });
  });

  it("calculates a zero fixed commission without an exchange-rate path", () => {
    const order = { ...completedOrder(crypto.randomUUID()), currency: "usd" as const, exchangeRates: [] };

    const calculation = commissions.calculateSalesOrderCommission(order, {
      commissionType: "fixed_amount",
      ratePercent: 0,
      fixedAmount: 0,
      fixedCurrency: "iqd",
      calculationBasis: "net_profit",
      includeTax: false,
      includeDeliveryCharge: false,
    });

    expect(calculation).toMatchObject({
      currency: "usd",
      basisAmount: 400,
      ratePercent: 0,
      commissionAmount: 0,
    });
  });

  it("stores a tier label without changing the current commission calculation", async () => {
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Tiered sales",
      level: "tiered-sales",
      commissionType: "percentage",
      ratePercent: 10,
      tierName: "Gold",
      calculationBasis: "net_profit",
      effectiveFrom: new Date().toISOString(),
    });

    const calculation = commissions.calculateSalesOrderCommission(completedOrder(crypto.randomUUID()), plan);

    expect(plan.tierName).toBe("Gold");
    expect(calculation.commissionAmount).toBe(40);
  });

  it("retires a saved commission level and ends current memberships without deleting history", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    await db.agents.put(agent);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Retired level",
      level: "retired-level",
      commissionType: "percentage",
      ratePercent: 5,
      calculationBasis: "net_profit",
      effectiveFrom: new Date().toISOString(),
    });
    const membership = await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
    });

    const retired = await commissions.deleteAgentCommissionPlan(plan.id);
    const endedMembership = await db.agent_commission_memberships.get(membership!.id);

    expect(retired).toMatchObject({
      id: plan.id,
      isActive: false,
      isDeleted: false,
    });
    expect(retired.effectiveTo).toBeTruthy();
    expect(endedMembership).toMatchObject({
      id: membership!.id,
      planId: plan.id,
      isDeleted: false,
    });
    expect(endedMembership?.effectiveTo).toBe(retired.effectiveTo);
  });

  it("recalculates percentage manual commissions from the current order total", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.put(agent);
    await db.sales_orders.put(order);

    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      manualCommission: {
        type: "percentage",
        amount: 5,
        currency: "usd",
      },
    });
    expect(assignment).toMatchObject({
      manualCommissionType: "percentage",
      manualCommissionSourceAmount: 5,
      manualCommissionConvertedAmount: 50,
      manualCommissionSourceCurrency: "usd",
    });

    await db.sales_orders.put({
      ...order,
      total: 1_200,
      subtotal: 1_200,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
      version: 2,
    });
    const adjustment = await commissions.reconcileSalesOrderCommission(WORKSPACE_ID, order.id);
    expect(adjustment).toMatchObject({ kind: "adjustment", amount: 10, currency: "usd" });
  });

  it("replaces the normal plan only for configured product lines and reverses their historical unit snapshot", async () => {
    const productCommissions = await import("./productCommissions");
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    const productCommissionId = order.items[0].productId;
    const ordinaryProductId = crypto.randomUUID();
    order.items = [
      { ...order.items[0], id: "commission-line", productId: productCommissionId, quantity: 2, lineTotal: 200, convertedUnitPrice: 100 },
      { ...order.items[0], id: "ordinary-line", productId: ordinaryProductId, quantity: 3, lineTotal: 300, convertedUnitPrice: 100 },
    ];
    order.subtotal = 500;
    order.total = 500;
    order.paidAmount = 500;
    await db.agents.put(agent);
    await db.sales_orders.put(order);

    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Whole order revenue plan",
      level: "whole-order-revenue",
      ratePercent: 10,
      calculationBasis: "net_revenue",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, { agentId: agent.id, planId: plan.id });
    await productCommissions.replaceProductCommissionRule(WORKSPACE_ID, productCommissionId, {
      commissionType: "fixed_amount",
      fixedAmount: 7,
      fixedCurrency: "usd",
      recipientScope: "all_assigned",
    });

    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
    });
    const accrual = await db.agent_commission_entries
      .where("assignmentId").equals(assignment!.id)
      .and((entry) => entry.kind === "accrual")
      .first();
    const initialAggregateEntries = await db.agent_commission_entries
      .where("assignmentId").equals(assignment!.id)
      .and((entry) => !entry.isDeleted)
      .toArray();
    const productAccrual = await db.agent_product_commission_entries
      .where("assignmentId").equals(assignment!.id)
      .and((entry) => entry.kind === "accrual")
      .first();

    // The 10% plan applies to the ordinary $300 line only; the configured
    // product earns $7 × 2 instead of another share of that plan.
    expect(accrual).toMatchObject({ planCommissionAmount: 30, productCommissionAmount: 14, amount: 44 });
    expect(initialAggregateEntries).toEqual([
      expect.objectContaining({ kind: "accrual", amount: 44 }),
    ]);
    expect(productAccrual).toMatchObject({ quantity: 2, commissionPerUnit: 7, amount: 14 });

    const returnedAt = new Date().toISOString();
    await db.sales_orders.put({
      ...order,
      items: [{ ...order.items[0], returnedQuantity: 1 }, order.items[1]],
      subtotal: 400,
      total: 400,
      returnedAmount: 100,
      returnStatus: "partial",
      updatedAt: returnedAt,
      version: 2,
    });
    const orderReturn: OrderReturn = {
      id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, orderId: order.id,
      reason: "Partial return", status: "posted", refundAmount: 100,
      returnedAt, createdAt: returnedAt, updatedAt: returnedAt,
      syncStatus: "synced", lastSyncedAt: returnedAt, version: 1, isDeleted: false,
    };
    await db.order_returns.put(orderReturn);
    await commissions.reverseCommissionForOrderReturn(WORKSPACE_ID, orderReturn.id);

    const productEntries = await db.agent_product_commission_entries
      .where("assignmentId").equals(assignment!.id)
      .toArray();
    const recognizedProductCommission = productEntries.reduce((sum, entry) => sum + entry.amount, 0);
    expect(productEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reversal", quantity: -1, commissionPerUnit: 7, amount: -7, orderReturnId: orderReturn.id }),
    ]));
    expect(recognizedProductCommission).toBe(7);
  });

  it("keeps a paid product commission return-linked through one reversal and makes the excess recoverable", async () => {
    const productCommissions = await import("./productCommissions");
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    order.items = [{
      ...order.items[0], id: "paid-product-return-line", quantity: 2,
      convertedUnitPrice: 100, lineTotal: 200,
    }];
    order.subtotal = 200;
    order.total = 200;
    order.paidAmount = 200;
    await db.agents.put(agent);
    await db.business_partners.put({
      id: agent.businessPartnerId,
      workspaceId: WORKSPACE_ID,
      partnerName: "Commission agent",
      isDeleted: false,
    } as any);
    await db.sales_orders.put(order);
    await productCommissions.replaceProductCommissionRule(WORKSPACE_ID, order.items[0].productId, {
      commissionType: "fixed_amount",
      fixedAmount: 7,
      fixedCurrency: "usd",
      recipientScope: "all_assigned",
    });

    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
    });
    if (!assignment) throw new Error("Expected a sales-agent assignment");
    await commissions.recordAgentCommissionPayout(WORKSPACE_ID, {
      agentId: agent.id,
      assignmentId: assignment.id,
      orderId: order.id,
      amount: 14,
      currency: "usd",
      paymentMethod: "cash",
    });

    const returnedAt = new Date().toISOString();
    const orderReturn: OrderReturn = {
      id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, orderId: order.id,
      reason: "Partial return", status: "posted", refundAmount: 100,
      returnedAt, createdAt: returnedAt, updatedAt: returnedAt,
      syncStatus: "synced", lastSyncedAt: returnedAt, version: 1, isDeleted: false,
    };
    await db.sales_orders.put({
      ...order,
      items: [{ ...order.items[0], returnedQuantity: 1 }],
      subtotal: 100,
      total: 100,
      returnedAmount: 100,
      returnStatus: "partial",
      updatedAt: returnedAt,
      version: 2,
    });
    await db.order_returns.put(orderReturn);

    const reversals = await commissions.reverseCommissionForOrderReturn(WORKSPACE_ID, orderReturn.id);
    expect(reversals).toEqual([expect.objectContaining({
      kind: "reversal",
      status: "reversed",
      amount: -7,
      orderReturnId: orderReturn.id,
    })]);

    const outstanding = (await db.agent_commission_entries
      .where("assignmentId").equals(assignment.id)
      .and((entry) => !entry.isDeleted && entry.kind !== "estimate" && entry.kind !== "approval")
      .toArray())
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(outstanding).toBe(-7);

    const recovery = await commissions.recordAgentCommissionRecovery(WORKSPACE_ID, {
      agentId: agent.id,
      assignmentId: assignment.id,
      orderId: order.id,
      amount: 7,
      currency: "usd",
      paymentMethod: "cash",
    });
    expect(recovery).toMatchObject({ kind: "recovery", amount: 7 });
    if (!recovery) throw new Error("Expected a commission recovery entry");
    const recoveryPayment = await db.payment_transactions
      .where("[workspaceId+sourceType+sourceRecordId]")
      .equals([WORKSPACE_ID, "agent_commission_recovery", agent.id])
      .first();
    expect(recoveryPayment).toMatchObject({
      direction: "incoming",
      amount: 7,
      sourceSubrecordId: recovery.id,
    });
  });

  it("recovers only the amount paid when a 75,000 IQD product order is fully returned", async () => {
    const productCommissions = await import("./productCommissions");
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    const productCommissionId = order.items[0].productId;
    const ordinaryProductId = crypto.randomUUID();
    order.currency = "iqd";
    order.items = [
      {
        ...order.items[0],
        id: "full-return-product-line",
        productId: productCommissionId,
        quantity: 1,
        lineTotal: 25_000,
        originalCurrency: "iqd",
        originalUnitPrice: 25_000,
        convertedUnitPrice: 25_000,
        settlementCurrency: "iqd",
      },
      {
        ...order.items[0],
        id: "full-return-ordinary-line",
        productId: ordinaryProductId,
        quantity: 1,
        lineTotal: 50_000,
        originalCurrency: "iqd",
        originalUnitPrice: 50_000,
        convertedUnitPrice: 50_000,
        settlementCurrency: "iqd",
      },
    ];
    order.subtotal = 75_000;
    order.total = 75_000;
    order.paidAmount = 75_000;
    await db.agents.put(agent);
    await db.business_partners.put({
      id: agent.businessPartnerId,
      workspaceId: WORKSPACE_ID,
      partnerName: "Commission agent",
      isDeleted: false,
    } as any);
    await db.sales_orders.put(order);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Full return plan component",
      level: "full-return-plan-component",
      ratePercent: 50,
      calculationBasis: "net_revenue",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, { agentId: agent.id, planId: plan.id });
    await productCommissions.replaceProductCommissionRule(WORKSPACE_ID, productCommissionId, {
      commissionType: "fixed_amount",
      fixedAmount: 25_000,
      fixedCurrency: "iqd",
      recipientScope: "all_assigned",
    });

    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
    });
    if (!assignment) throw new Error("Expected a sales-agent assignment");
    const accrual = await db.agent_commission_entries
      .where("assignmentId").equals(assignment.id)
      .and((entry) => !entry.isDeleted && entry.kind === "accrual")
      .first();
    expect(accrual).toMatchObject({
      planCommissionAmount: 25_000,
      productCommissionAmount: 25_000,
      amount: 50_000,
    });
    await commissions.recordAgentCommissionPayout(WORKSPACE_ID, {
      agentId: agent.id,
      assignmentId: assignment.id,
      orderId: order.id,
      amount: 25_000,
      currency: "iqd",
      paymentMethod: "cash",
    });

    const returnedAt = new Date().toISOString();
    const orderReturn: OrderReturn = {
      id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, orderId: order.id,
      reason: "Full return", status: "posted", refundAmount: 75_000,
      returnedAt, createdAt: returnedAt, updatedAt: returnedAt,
      syncStatus: "synced", lastSyncedAt: returnedAt, version: 1, isDeleted: false,
    };
    await db.sales_orders.put({
      ...order,
      items: order.items.map((item) => ({ ...item, returnedQuantity: 1 })),
      subtotal: 0,
      total: 0,
      returnedAmount: 75_000,
      returnStatus: "full",
      updatedAt: returnedAt,
      version: 2,
    });
    await db.order_returns.put(orderReturn);

    const reversals = await commissions.reverseCommissionForOrderReturn(WORKSPACE_ID, orderReturn.id);
    expect(reversals).toEqual([expect.objectContaining({
      kind: "reversal",
      status: "reversed",
      amount: -50_000,
      orderReturnId: orderReturn.id,
    })]);

    const outstanding = (await db.agent_commission_entries
      .where("assignmentId").equals(assignment.id)
      .and((entry) => !entry.isDeleted && entry.kind !== "estimate" && entry.kind !== "approval")
      .toArray())
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(outstanding).toBe(-25_000);

    await expect(commissions.recordAgentCommissionRecovery(WORKSPACE_ID, {
      agentId: agent.id,
      assignmentId: assignment.id,
      orderId: order.id,
      amount: 25_001,
      currency: "iqd",
      paymentMethod: "cash",
    })).rejects.toThrow("cannot exceed");

    const recovery = await commissions.recordAgentCommissionRecovery(WORKSPACE_ID, {
      agentId: agent.id,
      assignmentId: assignment.id,
      orderId: order.id,
      amount: 25_000,
      currency: "iqd",
      paymentMethod: "cash",
    });
    expect(recovery).toMatchObject({ kind: "recovery", amount: 25_000 });
  });

  it("creates a payable product-only percentage commission using a rounded per-unit snapshot", async () => {
    const productCommissions = await import("./productCommissions");
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    order.items = [{
      ...order.items[0], id: "percentage-line", quantity: 3,
      convertedUnitPrice: 10.01, lineTotal: 30.03,
    }];
    order.subtotal = 30.03;
    order.total = 30.03;
    order.paidAmount = 30.03;
    await db.agents.put(agent);
    await db.sales_orders.put(order);
    await productCommissions.replaceProductCommissionRule(WORKSPACE_ID, order.items[0].productId, {
      commissionType: "percentage",
      ratePercent: 12.5,
      recipientScope: "selected_assigned",
      agentIds: [agent.id],
    });

    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
    });
    const aggregate = await db.agent_commission_entries
      .where("assignmentId").equals(assignment!.id)
      .and((entry) => entry.kind === "accrual")
      .first();
    const line = await db.agent_product_commission_entries
      .where("assignmentId").equals(assignment!.id)
      .first();

    expect(line).toMatchObject({
      commissionType: "percentage", ratePercent: 12.5,
      quantity: 3, commissionPerUnit: 1.25125, amount: 3.75375,
    });
    expect(aggregate).toMatchObject({
      membershipId: null, planId: null,
      planCommissionAmount: 0, productCommissionAmount: 3.75375, amount: 3.75375,
    });
  });

  it("keeps an all-assigned product commission outstanding for the linked staff creator", async () => {
    const productCommissions = await import("./productCommissions");
    const order = completedOrder(crypto.randomUUID());
    const creatorAgent = {
      ...fieldAgent(crypto.randomUUID()),
      linkedUserId: order.createdBy,
    };
    const commissionedProductId = order.items[0].productId;
    const ordinaryProductId = crypto.randomUUID();
    order.items = [
      { ...order.items[0], id: "creator-product-line", quantity: 2, lineTotal: 200 },
      { ...order.items[0], id: "creator-ordinary-line", productId: ordinaryProductId, quantity: 3, lineTotal: 300 },
    ];
    order.subtotal = 500;
    order.total = 500;
    order.paidAmount = 500;
    // POS customer checkout can leave the optional order-wide commission
    // switch off. Creator product commission remains automatic.
    order.commissionEnabled = false;
    await db.agents.put(creatorAgent);
    await db.sales_orders.put(order);

    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Creator ordinary plan",
      level: "creator-ordinary-plan",
      ratePercent: 10,
      calculationBasis: "net_revenue",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: creatorAgent.id,
      planId: plan.id,
    });
    await productCommissions.replaceProductCommissionRule(WORKSPACE_ID, commissionedProductId, {
      commissionType: "fixed_amount",
      fixedAmount: 7,
      fixedCurrency: "usd",
      recipientScope: "all_assigned",
      effectiveFrom: new Date(Date.now() - 1_000).toISOString(),
    });

    await commissions.accrueSalesOrderCommission(WORKSPACE_ID, order.id, order.createdBy);
    await commissions.replaceSalesOrderAgentAssignments(WORKSPACE_ID, {
      orderId: order.id,
      assignments: [],
      assignedBy: order.createdBy,
    });
    await commissions.accrueSalesOrderCommission(WORKSPACE_ID, order.id, order.createdBy);

    const assignments = commissions.getActiveSalesOrderAgentAssignments(
      await db.sales_order_agent_assignments.where("[workspaceId+orderId]").equals([WORKSPACE_ID, order.id]).toArray(),
      order.id,
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      agentId: creatorAgent.id,
      assignmentSource: "order_creator_product",
    });
    const accrual = await db.agent_commission_entries
      .where("assignmentId").equals(assignments[0].id)
      .and((entry) => entry.kind === "accrual")
      .first();
    expect(accrual).toMatchObject({
      membershipId: null,
      planId: null,
      planCommissionAmount: 0,
      productCommissionAmount: 14,
      amount: 14,
    });
    expect(await db.agent_commission_entries
      .where("assignmentId").equals(assignments[0].id)
      .and((entry) => entry.kind === "accrual")
      .count()).toBe(1);
    expect(await db.agent_product_commission_entries
      .where("assignmentId").equals(assignments[0].id)
      .and((entry) => entry.kind === "accrual")
      .count()).toBe(1);
    const payout = await db.agent_commission_entries
      .where("assignmentId").equals(assignments[0].id)
      .and((entry) => entry.kind === "payout")
      .first();
    expect(payout).toBeUndefined();
  });

  it("credits a selected-assigned product rule to its linked staff creator with per-unit rounding", async () => {
    const productCommissions = await import("./productCommissions");
    const order = completedOrder(crypto.randomUUID());
    const creatorAgent = {
      ...fieldAgent(crypto.randomUUID()),
      linkedUserId: order.createdBy,
    };
    order.items = [{
      ...order.items[0],
      id: "creator-percentage-line",
      quantity: 3,
      convertedUnitPrice: 10.01,
      lineTotal: 30.03,
    }];
    order.subtotal = 30.03;
    order.total = 30.03;
    order.paidAmount = 30.03;
    await db.agents.put(creatorAgent);
    await db.sales_orders.put(order);
    await productCommissions.replaceProductCommissionRule(WORKSPACE_ID, order.items[0].productId, {
      commissionType: "percentage",
      ratePercent: 12.5,
      recipientScope: "selected_assigned",
      agentIds: [creatorAgent.id],
      effectiveFrom: new Date(Date.now() - 1_000).toISOString(),
    });

    await commissions.accrueSalesOrderCommission(WORKSPACE_ID, order.id, order.createdBy);

    const assignment = await db.sales_order_agent_assignments.where("orderId").equals(order.id).first();
    const line = await db.agent_product_commission_entries.where("assignmentId").equals(assignment!.id).first();
    expect(line).toMatchObject({
      agentId: creatorAgent.id,
      quantity: 3,
      commissionPerUnit: 1.25125,
      amount: 3.75375,
    });
  });

  it("does not assign a linked staff creator excluded by a selected-assigned product rule", async () => {
    const productCommissions = await import("./productCommissions");
    const order = completedOrder(crypto.randomUUID());
    const creatorAgent = {
      ...fieldAgent(crypto.randomUUID()),
      linkedUserId: order.createdBy,
    };
    const selectedAgent = fieldAgent(crypto.randomUUID());
    await db.agents.bulkPut([creatorAgent, selectedAgent]);
    await db.sales_orders.put(order);
    await productCommissions.replaceProductCommissionRule(WORKSPACE_ID, order.items[0].productId, {
      commissionType: "fixed_amount",
      fixedAmount: 5,
      fixedCurrency: "usd",
      recipientScope: "selected_assigned",
      agentIds: [selectedAgent.id],
      effectiveFrom: new Date(Date.now() - 1_000).toISOString(),
    });

    await commissions.accrueSalesOrderCommission(WORKSPACE_ID, order.id, order.createdBy);

    expect(await db.sales_order_agent_assignments.where("orderId").equals(order.id).count()).toBe(0);
    expect(await db.agent_product_commission_entries.where("orderId").equals(order.id).count()).toBe(0);
  });

  it("saves an order-specific fixed amount override for an agent with an effective plan", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.put(agent);
    await db.sales_orders.put(order);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Level 1",
      level: "level_1",
      commissionType: "fixed_amount",
      ratePercent: 0,
      fixedAmount: 10,
      fixedCurrency: "usd",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
    });

    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      manualCommission: {
        type: "fixed_amount",
        amount: 25,
        currency: "usd",
      },
    });
    const accrual = await db.agent_commission_entries
      .where("assignmentId")
      .equals(assignment!.id)
      .and((entry) => entry.kind === "accrual")
      .first();

    expect(assignment).toMatchObject({
      manualCommissionType: "fixed_amount",
      manualCommissionSourceAmount: 25,
      manualCommissionSourceCurrency: "usd",
      manualCommissionConvertedAmount: 25,
    });
    expect(accrual).toMatchObject({
      currency: "usd",
      planCommissionAmount: 25,
      amount: 25,
    });
    expect((await db.agent_commission_plans.get(plan.id))?.fixedAmount).toBe(10);
  });

  it("rejects an order commission amount override for a percentage plan", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.put(agent);
    await db.sales_orders.put(order);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Percentage plan",
      level: "percentage-plan",
      commissionType: "percentage",
      ratePercent: 10,
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
    });

    await expect(commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      manualCommission: {
        type: "fixed_amount",
        amount: 25,
        currency: "usd",
      },
    })).rejects.toThrow("fixed commission plans");
  });

  it("includes standard and post-return order adjustments in commissionable revenue", () => {
    const order = completedOrder(crypto.randomUUID());
    const adjustmentBase = {
      currency: "usd" as const,
      orderCurrency: "usd" as const,
      exchangeRate: 1,
      exchangeRateSource: "native",
      exchangeRateTimestamp: new Date(0).toISOString(),
      exchangeRates: [],
    };
    order.orderAdjustments = [
      { ...adjustmentBase, id: "add", type: "addition", name: "Handling", amount: 20, convertedAmount: 20 },
      { ...adjustmentBase, id: "deduct", type: "deduction", name: "Commercial credit", amount: 50, convertedAmount: 50 },
      {
        ...adjustmentBase,
        id: "post-return",
        type: "addition",
        name: "Refund correction",
        amount: 999,
        convertedAmount: 999,
        scope: "post_return",
        returnId: crypto.randomUUID(),
      },
    ];

    const calculation = commissions.calculateSalesOrderCommission(order, {
      ratePercent: 10,
      calculationBasis: "net_profit",
      includeTax: false,
      includeDeliveryCharge: false,
    });

    expect(calculation).toMatchObject({
      revenueAmount: 1969,
      costAmount: 600,
      basisAmount: 1369,
      commissionAmount: 136.9,
    });
  });

  it("ignores malformed persisted order adjustments", () => {
    const order = completedOrder(crypto.randomUUID());
    order.orderAdjustments = [
      {
        id: "valid",
        type: "addition",
        name: "Handling",
        currency: "usd",
        amount: 10,
        orderCurrency: "usd",
        convertedAmount: 10,
        exchangeRate: 1,
        exchangeRateSource: "native",
        exchangeRateTimestamp: new Date(0).toISOString(),
        exchangeRates: [],
      },
      { id: "bad-type", type: "mystery", name: "Bad", convertedAmount: 500 },
      { id: "", type: "deduction", name: "Missing id", convertedAmount: 500 },
      { id: "bad-amount", type: "deduction", name: "Bad amount", convertedAmount: -500 },
    ] as any;

    expect(commissions.calculateSalesOrderCommission(order, {
      ratePercent: 10,
      calculationBasis: "net_revenue",
      includeTax: false,
      includeDeliveryCharge: false,
    })).toMatchObject({ revenueAmount: 1010, commissionAmount: 101 });
  });

  it("keeps earned commission outstanding until a user records its payment", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.put(agent);
    await db.sales_orders.put(order);

    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Level 1",
      level: "level_1",
      ratePercent: 10,
      calculationBasis: "net_profit",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
    });
    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      customerCitySnapshot: "Baghdad",
    });
    expect(assignment).not.toBeNull();

    const initialEntries = await db.agent_commission_entries.where("orderId").equals(order.id).toArray();
    expect(initialEntries).toEqual([
      expect.objectContaining({ kind: "accrual", status: "earned", amount: 40 }),
    ]);

    const returnedAt = new Date().toISOString();
    const updatedOrder: SalesOrder = {
      ...order,
      items: [{ ...order.items[0], returnedQuantity: 5 }],
      returnStatus: "partial",
      returnedAmount: 500,
      total: 500,
      subtotal: 500,
      updatedAt: returnedAt,
      version: 2,
    };
    const orderReturn: OrderReturn = {
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      orderId: order.id,
      reason: "Customer return",
      status: "posted",
      refundAmount: 500,
      returnedBy: crypto.randomUUID(),
      returnedAt,
      createdAt: returnedAt,
      updatedAt: returnedAt,
      syncStatus: "synced",
      lastSyncedAt: returnedAt,
      version: 1,
      isDeleted: false,
    };
    await db.sales_orders.put(updatedOrder);
    await db.order_returns.put(orderReturn);
    const reversals = await commissions.reverseCommissionForOrderReturn(
      WORKSPACE_ID,
      orderReturn.id,
    );
    expect(reversals).toEqual([
      expect.objectContaining({ kind: "reversal", status: "reversed", amount: -20 }),
    ]);

    const allEntries = await db.agent_commission_entries.where("agentId").equals(agent.id).toArray();
    expect(allEntries.filter((entry) => entry.kind === "payout")).toHaveLength(0);
    const outstanding = allEntries
      .filter((entry) => entry.kind !== "approval" && entry.kind !== "estimate")
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(outstanding).toBe(20);

    const payoutTransactions = await db.payment_transactions
      .where("[workspaceId+sourceType+sourceRecordId]")
      .equals([WORKSPACE_ID, "agent_commission_payout", agent.id])
      .toArray();
    expect(payoutTransactions).toEqual([]);
  });

  it("allows a manual commission payment before the customer order is paid", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = {
      ...completedOrder(crypto.randomUUID()),
      status: 'draft' as const,
      isPaid: false,
      paymentStatus: 'unpaid' as const,
      paidAmount: 0,
      balanceAmount: 1_000,
      paidAt: null,
    };
    await db.agents.put(agent);
    await db.business_partners.put({
      id: agent.businessPartnerId,
      workspaceId: WORKSPACE_ID,
      partnerName: 'Commission agent',
      isDeleted: false,
    } as any);
    await db.sales_orders.put(order);
    const { savePaymentAccount } = await import('./paymentAccounts');
    const { appendPaymentTransaction } = await import('./payments');
    const paymentAccount = await savePaymentAccount(WORKSPACE_ID, {
      name: 'Commission till',
      accountType: 'cash_drawer',
      createdBy: order.createdBy,
    });
    await appendPaymentTransaction(WORKSPACE_ID, {
      sourceModule: 'payments',
      sourceType: 'direct_transaction',
      sourceRecordId: crypto.randomUUID(),
      direction: 'incoming',
      amount: 40,
      currency: 'usd',
      paymentMethod: 'cash',
      paidAt: order.createdAt,
      counterpartyName: null,
      referenceLabel: 'Commission float',
      createdBy: order.createdBy,
      accountId: paymentAccount.id,
      accountNameSnapshot: paymentAccount.name,
    });
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: 'Manual payment level', level: 'manual-payment-level', ratePercent: 10,
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, { agentId: agent.id, planId: plan.id });
    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, { orderId: order.id, agentId: agent.id });
    if (!assignment) throw new Error('Expected a sales-agent assignment');

    await expect(commissions.recordAgentCommissionPayout(WORKSPACE_ID, {
      agentId: agent.id, assignmentId: assignment.id, orderId: order.id, amount: 41,
      currency: 'usd', paymentMethod: 'cash',
    })).rejects.toThrow('cannot exceed');
    const payout = await commissions.recordAgentCommissionPayout(WORKSPACE_ID, {
      agentId: agent.id, assignmentId: assignment.id, orderId: order.id, amount: 40,
      currency: 'usd', paymentMethod: 'cash', accountId: paymentAccount.id, accountNameSnapshot: paymentAccount.name,
    });
    expect(payout).toMatchObject({ kind: 'payout', amount: -40, settlementSource: 'manual' });
    if (!payout) throw new Error('Expected a commission payout entry');
    const payment = await db.payment_transactions
      .where('[workspaceId+sourceType+sourceRecordId]')
      .equals([WORKSPACE_ID, 'agent_commission_payout', agent.id])
      .first();
    expect(payment).toMatchObject({
      direction: 'outgoing',
      amount: 40,
      sourceSubrecordId: payout.id,
      accountId: paymentAccount.id,
      accountNameSnapshot: paymentAccount.name,
    });
    const accountBalance = await db.payment_account_balances
      .where('[accountId+currency]')
      .equals([paymentAccount.id, 'usd'])
      .first();
    expect(accountBalance?.balanceAmount).toBe(0);
  });

  it("tracks the full commission calculation without creating any financial obligation", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = {
      ...completedOrder(crypto.randomUUID()),
      commissionMode: 'tracked' as const,
      commissionModeCapturedAt: '2026-09-12T08:00:00.000Z',
    };
    await db.agents.put(agent);
    await db.business_partners.put({
      id: agent.businessPartnerId,
      workspaceId: WORKSPACE_ID,
      partnerName: 'Tracked commission agent',
      isDeleted: false,
    } as any);
    await db.sales_orders.put(order);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: 'Tracked level',
      level: 'tracked-level',
      ratePercent: 10,
      calculationBasis: 'net_profit',
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
    });
    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
    });
    if (!assignment) throw new Error('Expected a tracked sales-agent assignment');

    const entries = await db.agent_commission_entries
      .where('assignmentId')
      .equals(assignment.id)
      .toArray();
    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'accrual',
        status: 'earned',
        commissionMode: 'tracked',
        basisAmount: 400,
        amount: 40,
      }),
    ]);

    const { appendPaymentTransaction, buildAgentCommissionObligations } = await import('./payments');
    expect(await buildAgentCommissionObligations(WORKSPACE_ID)).toEqual([]);
    await expect(commissions.recordCommissionApproval(WORKSPACE_ID, {
      entryId: entries[0].id,
    })).rejects.toThrow('nonpayable');
    await expect(commissions.recordAgentCommissionPayout(WORKSPACE_ID, {
      agentId: agent.id,
      assignmentId: assignment.id,
      orderId: order.id,
      amount: 40,
      currency: 'usd',
      paymentMethod: 'cash',
    })).rejects.toThrow('nonpayable');
    await expect(appendPaymentTransaction(WORKSPACE_ID, {
      sourceModule: 'orders',
      sourceType: 'agent_commission_payout',
      sourceRecordId: agent.id,
      direction: 'outgoing',
      amount: 40,
      currency: 'usd',
      paymentMethod: 'cash',
      paidAt: '2026-09-12T09:00:00.000Z',
      metadata: { orderId: order.id },
    })).rejects.toThrow('cannot create a payment transaction');
    expect(await db.payment_transactions.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(0);
  });

  it("records an incoming recovery when a paid commission is later reversed", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.put(agent);
    await db.business_partners.put({ id: agent.businessPartnerId, workspaceId: WORKSPACE_ID, partnerName: 'Commission agent', isDeleted: false } as any);
    await db.sales_orders.put(order);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: 'Recovery level', level: 'recovery-level', ratePercent: 10,
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, { agentId: agent.id, planId: plan.id });
    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, { orderId: order.id, agentId: agent.id });
    if (!assignment) throw new Error('Expected a sales-agent assignment');
    await commissions.recordAgentCommissionPayout(WORKSPACE_ID, {
      agentId: agent.id, assignmentId: assignment.id, orderId: order.id, amount: 40, currency: 'usd', paymentMethod: 'cash',
    });
    const returnedAt = new Date().toISOString();
    await db.sales_orders.put({
      ...order, items: [{ ...order.items[0], returnedQuantity: 5 }], returnStatus: 'partial', total: 500,
      subtotal: 500, returnedAmount: 500, updatedAt: returnedAt, version: 2,
    });
    const orderReturn: OrderReturn = {
      id: crypto.randomUUID(), workspaceId: WORKSPACE_ID, orderId: order.id, reason: 'Customer return', status: 'posted',
      refundAmount: 500, returnedBy: null, returnedAt, createdAt: returnedAt, updatedAt: returnedAt,
      syncStatus: 'synced', lastSyncedAt: returnedAt, version: 1, isDeleted: false,
    };
    await db.order_returns.put(orderReturn);
    await commissions.reverseCommissionForOrderReturn(WORKSPACE_ID, orderReturn.id);

    await expect(commissions.recordAgentCommissionRecovery(WORKSPACE_ID, {
      agentId: agent.id, assignmentId: assignment.id, orderId: order.id, amount: 21, currency: 'usd', paymentMethod: 'cash',
    })).rejects.toThrow('cannot exceed');
    const recovery = await commissions.recordAgentCommissionRecovery(WORKSPACE_ID, {
      agentId: agent.id, assignmentId: assignment.id, orderId: order.id, amount: 20, currency: 'usd', paymentMethod: 'cash',
    });
    expect(recovery).toMatchObject({ kind: 'recovery', amount: 20, settlementSource: 'manual' });
    if (!recovery) throw new Error('Expected a commission recovery entry');
    const payment = await db.payment_transactions
      .where('[workspaceId+sourceType+sourceRecordId]')
      .equals([WORKSPACE_ID, 'agent_commission_recovery', agent.id])
      .first();
    expect(payment).toMatchObject({ direction: 'incoming', amount: 20, sourceSubrecordId: recovery.id });
  });

  it("does not spend the customer order receipt without a manual commission payment", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    const { savePaymentAccount } = await import("./paymentAccounts");
    const { appendPaymentTransaction } = await import("./payments");
    const account = await savePaymentAccount(WORKSPACE_ID, {
      name: "Main cash drawer",
      accountType: "cash_drawer",
      createdBy: order.createdBy,
    });

    await db.agents.put(agent);
    await db.sales_orders.put(order);
    await appendPaymentTransaction(WORKSPACE_ID, {
      sourceModule: "orders",
      sourceType: "sales_order",
      sourceRecordId: order.id,
      direction: "incoming",
      amount: order.total,
      currency: order.currency,
      paymentMethod: "cash",
      paidAt: order.paidAt!,
      counterpartyName: order.customerName,
      referenceLabel: order.orderNumber,
      createdBy: order.createdBy,
      accountId: account.id,
      accountNameSnapshot: account.name,
    });

    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Account-funded level",
      level: "account-funded-level",
      ratePercent: 10,
      calculationBasis: "net_profit",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
    });
    await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      customerCitySnapshot: "Baghdad",
    });

    const payouts = await db.payment_transactions
      .where("[workspaceId+sourceType+sourceRecordId]")
      .equals([WORKSPACE_ID, "agent_commission_payout", agent.id])
      .toArray();
    expect(payouts).toEqual([]);
    const balance = await db.payment_account_balances
      .where("[accountId+currency]")
      .equals([account.id, "usd"])
      .first();
    expect(balance?.balanceAmount).toBe(1000);
  });

  it("does not split or create a commission payment from customer collection accounts", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    const { savePaymentAccount } = await import("./paymentAccounts");
    const { appendPaymentTransaction } = await import("./payments");
    const firstAccount = await savePaymentAccount(WORKSPACE_ID, {
      name: "First collection account",
      accountType: "cash_drawer",
      createdBy: order.createdBy,
    });
    const secondAccount = await savePaymentAccount(WORKSPACE_ID, {
      name: "Second collection account",
      accountType: "cash_drawer",
      createdBy: order.createdBy,
    });

    await db.agents.put(agent);
    await db.sales_orders.put(order);
    await Promise.all([firstAccount, secondAccount].map((account) => appendPaymentTransaction(WORKSPACE_ID, {
      sourceModule: "orders",
      sourceType: "sales_order",
      sourceRecordId: order.id,
      direction: "incoming",
      amount: 20,
      currency: order.currency,
      paymentMethod: "cash",
      paidAt: order.paidAt!,
      counterpartyName: order.customerName,
      referenceLabel: order.orderNumber,
      createdBy: order.createdBy,
      accountId: account.id,
      accountNameSnapshot: account.name,
    })));

    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Split-funded level",
      level: "split-funded-level",
      ratePercent: 10,
      calculationBasis: "net_profit",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, { agentId: agent.id, planId: plan.id });
    await commissions.assignSalesOrderAgent(WORKSPACE_ID, { orderId: order.id, agentId: agent.id });

    const payouts = await db.payment_transactions
      .where("[workspaceId+sourceType+sourceRecordId]")
      .equals([WORKSPACE_ID, "agent_commission_payout", agent.id])
      .toArray();
    expect(payouts).toHaveLength(0);
  });

  it("leaves commission outstanding when the order payment account no longer has funds", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    const { savePaymentAccount } = await import("./paymentAccounts");
    const { appendPaymentTransaction } = await import("./payments");
    const account = await savePaymentAccount(WORKSPACE_ID, {
      name: "Collected then spent",
      accountType: "cash_drawer",
      createdBy: order.createdBy,
    });

    await db.agents.put(agent);
    await db.sales_orders.put(order);
    await appendPaymentTransaction(WORKSPACE_ID, {
      sourceModule: "orders",
      sourceType: "sales_order",
      sourceRecordId: order.id,
      direction: "incoming",
      amount: order.total,
      currency: order.currency,
      paymentMethod: "cash",
      paidAt: order.paidAt!,
      counterpartyName: order.customerName,
      referenceLabel: order.orderNumber,
      createdBy: order.createdBy,
      accountId: account.id,
      accountNameSnapshot: account.name,
    });
    await appendPaymentTransaction(WORKSPACE_ID, {
      sourceModule: "payments",
      sourceType: "direct_transaction",
      sourceRecordId: crypto.randomUUID(),
      direction: "outgoing",
      amount: order.total,
      currency: order.currency,
      paymentMethod: "cash",
      paidAt: order.paidAt!,
      counterpartyName: null,
      referenceLabel: "Operating expense",
      createdBy: order.createdBy,
      accountId: account.id,
      accountNameSnapshot: account.name,
    });

    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Balance-capped level",
      level: "balance-capped-level",
      ratePercent: 10,
      calculationBasis: "net_profit",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, { agentId: agent.id, planId: plan.id });
    await commissions.assignSalesOrderAgent(WORKSPACE_ID, { orderId: order.id, agentId: agent.id });

    const payouts = await db.payment_transactions
      .where("[workspaceId+sourceType+sourceRecordId]")
      .equals([WORKSPACE_ID, "agent_commission_payout", agent.id])
      .toArray();
    const entries = await db.agent_commission_entries.where("agentId").equals(agent.id).toArray();
    expect(payouts).toHaveLength(0);
    expect(entries.filter((entry) => entry.kind === "accrual").map((entry) => entry.amount)).toEqual([40]);
  });

  it("reuses only field agents and preserves membership history before replacement", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const driver = fieldAgent(crypto.randomUUID(), "driver");
    await db.agents.bulkPut([agent, driver]);
    const level1 = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Starter sales",
      level: "starter-sales",
      ratePercent: 5,
    });
    const level2 = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Senior sales",
      level: "senior-sales",
      ratePercent: 7.5,
    });

    await expect(commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: driver.id,
      planId: level1.id,
    })).rejects.toThrow("field agent");

    const first = await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: level1.id,
    });
    const second = await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: level2.id,
    });
    const history = await db.agent_commission_memberships.where("agentId").equals(agent.id).toArray();
    expect(first).not.toBeNull();
    expect(second?.planId).toBe(level2.id);
    expect(history.find((row) => row.id === first?.id)?.effectiveTo).toBeTruthy();
    expect(history.filter((row) => !row.effectiveTo)).toHaveLength(1);
  });

  it("supports a named user-defined level while keeping its active revision unique", async () => {
    await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Enterprise sales",
      level: "enterprise-sales",
      ratePercent: 5,
    });
    await expect(commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Another enterprise revision",
      level: "enterprise-sales",
      ratePercent: 7,
    })).rejects.toThrow("already has a commission plan");
  });

  it("accepts zero as a fixed commission amount when creating and updating a plan", async () => {
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Zero fixed commission",
      level: "zero-fixed-commission",
      commissionType: "fixed_amount",
      ratePercent: 0,
      fixedAmount: 0,
      fixedCurrency: "usd",
    });

    expect(plan).toMatchObject({
      commissionType: "fixed_amount",
      fixedAmount: 0,
      fixedCurrency: "usd",
    });

    const updated = await commissions.updateAgentCommissionPlan(plan.id, {
      fixedAmount: 0,
    });
    expect(updated.fixedAmount).toBe(0);
  });

  it("revises used plan terms without rewriting accruals or late historical events", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    const historicalOrder = {
      ...completedOrder(crypto.randomUUID()),
      orderNumber: "SO-1002",
      isPaid: false,
      paymentStatus: "unpaid" as const,
      paidAt: null,
      paidAmount: 0,
      balanceAmount: 1_000,
    };
    const futureOrder = { ...completedOrder(crypto.randomUUID()), orderNumber: "SO-1002" };
    await db.agents.put(agent);
    await db.sales_orders.bulkPut([order, historicalOrder, futureOrder]);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Level 1",
      level: "level_1",
      ratePercent: 10,
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
    });
    await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
    });
    await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: historicalOrder.id,
      agentId: agent.id,
    });
    const original = await db.agent_commission_entries
      .where("orderId")
      .equals(order.id)
      .and((entry) => entry.kind === "accrual")
      .first();

    const actorId = crypto.randomUUID();
    const updated = await commissions.updateAgentCommissionPlan(plan.id, {
      ratePercent: 20,
      createdBy: actorId,
    });
    const frozen = await db.agent_commission_entries.get(original!.id);
    const closedPlan = await db.agent_commission_plans.get(plan.id);
    const membershipHistory = await db.agent_commission_memberships
      .where("agentId")
      .equals(agent.id)
      .sortBy("effectiveFrom");

    await db.sales_orders.put({
      ...historicalOrder,
      isPaid: true,
      paymentStatus: "paid",
      paidAt: historicalOrder.updatedAt,
      paidAmount: 1_000,
      balanceAmount: 0,
      version: historicalOrder.version + 1,
    });
    await commissions.accrueSalesOrderCommission(WORKSPACE_ID, historicalOrder.id);
    const historicalAccrual = await db.agent_commission_entries
      .where("orderId")
      .equals(historicalOrder.id)
      .and((entry) => entry.kind === "accrual")
      .first();

    await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: futureOrder.id,
      agentId: agent.id,
    });
    const futureAccrual = await db.agent_commission_entries
      .where("orderId")
      .equals(futureOrder.id)
      .and((entry) => entry.kind === "accrual")
      .first();

    expect(updated.id).not.toBe(plan.id);
    expect(updated.ratePercent).toBe(20);
    expect(closedPlan).toMatchObject({ isActive: false, effectiveTo: updated.effectiveFrom });
    expect(membershipHistory).toHaveLength(2);
    expect(membershipHistory[0]).toMatchObject({
      planId: plan.id,
      effectiveTo: updated.effectiveFrom,
      endedBy: actorId,
    });
    expect(membershipHistory[1]).toMatchObject({
      planId: updated.id,
      effectiveFrom: updated.effectiveFrom,
      effectiveTo: null,
      assignedBy: actorId,
    });
    expect(frozen).toMatchObject({ ratePercent: 10, amount: 40 });
    expect(historicalAccrual).toMatchObject({ planId: plan.id, ratePercent: 10, amount: 40 });
    expect(futureAccrual).toMatchObject({ ratePercent: 20, amount: 80 });
  });

  it("does not use a later generic order update to make a new membership retroactive", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    order.actualDeliveryDate = "2026-01-01T10:00:00.000Z";
    order.paidAt = "2026-01-01T11:00:00.000Z";
    order.updatedAt = "2026-01-03T10:00:00.000Z";
    await db.agents.put(agent);
    await db.sales_orders.put(order);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Level 1",
      level: "level_1",
      ratePercent: 10,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
      effectiveAt: "2026-01-02T00:00:00.000Z",
    });
    await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      assignedAt: "2026-01-01T12:00:00.000Z",
    });

    expect(await db.agent_commission_entries.where("orderId").equals(order.id).count()).toBe(0);
  });

  it("credits every active beneficiary on the same sales order independently", async () => {
    const firstAgent = fieldAgent(crypto.randomUUID());
    const secondAgent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.bulkPut([firstAgent, secondAgent]);
    await db.sales_orders.put(order);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Shared level",
      level: "level_1",
      ratePercent: 10,
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: firstAgent.id,
      planId: plan.id,
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: secondAgent.id,
      planId: plan.id,
    });

    await commissions.replaceSalesOrderAgentAssignments(WORKSPACE_ID, {
      orderId: order.id,
      assignments: [
        { agentId: firstAgent.id },
        { agentId: secondAgent.id },
      ],
    });

    const activeAssignments = (await db.sales_order_agent_assignments
      .where("orderId")
      .equals(order.id)
      .toArray())
      .filter((assignment) => !assignment.isDeleted && !assignment.unassignedAt);
    const accruals = (await db.agent_commission_entries
      .where("orderId")
      .equals(order.id)
      .toArray())
      .filter((entry) => entry.kind === "accrual");

    expect(activeAssignments.map((assignment) => assignment.agentId).sort()).toEqual([
      firstAgent.id,
      secondAgent.id,
    ].sort());
    expect(accruals).toHaveLength(2);
    expect(accruals.map((entry) => entry.agentId).sort()).toEqual([
      firstAgent.id,
      secondAgent.id,
    ].sort());
    expect(accruals.every((entry) => entry.amount === 40)).toBe(true);

    await commissions.replaceSalesOrderAgentAssignments(WORKSPACE_ID, {
      orderId: order.id,
      assignments: [{ agentId: firstAgent.id }],
    });

    const remainingAssignments = (await db.sales_order_agent_assignments
      .where("orderId")
      .equals(order.id)
      .toArray())
      .filter((assignment) => !assignment.isDeleted && !assignment.unassignedAt);
    const recognizedByAgent = (await db.agent_commission_entries
      .where("orderId")
      .equals(order.id)
      .toArray())
      .reduce((totals, entry) => {
        totals.set(entry.agentId, (totals.get(entry.agentId) ?? 0) + entry.amount);
        return totals;
      }, new Map<string, number>());

    expect(remainingAssignments.map((assignment) => assignment.agentId)).toEqual([firstAgent.id]);
    expect(recognizedByAgent.get(firstAgent.id)).toBe(40);
    expect(recognizedByAgent.get(secondAgent.id)).toBe(0);
  });

  it("records same-agent snapshot edits as assignment history", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.put(agent);
    await db.sales_orders.put(order);

    const original = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      customerCitySnapshot: "Baghdad",
      deliveryChargeAmount: 5,
    });
    const updated = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
      customerCitySnapshot: "Erbil",
      deliveryChargeAmount: 12,
      internalDeliveryCostAmount: 3,
      reason: "Corrected delivery snapshot",
    });

    expect(updated?.id).not.toBe(original?.id);
    expect(updated).toMatchObject({
      previousAssignmentId: original?.id,
      customerCitySnapshot: "Erbil",
      deliveryChargeAmount: 12,
      internalDeliveryCostAmount: 3,
    });
    const history = await db.sales_order_agent_assignments.where("orderId").equals(order.id).toArray();
    expect(history.find((row) => row.id === original?.id)?.unassignedAt).toBeTruthy();
    expect(history.filter((row) => !row.unassignedAt)).toHaveLength(1);
  });

  it("does not change commission entitlement when the customer payment is reversed or repaid", async () => {
    const agent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.put(agent);
    await db.sales_orders.put(order);
    const plan = await commissions.createAgentCommissionPlan(WORKSPACE_ID, {
      name: "Level 1",
      level: "level_1",
      ratePercent: 10,
    });
    await commissions.setAgentCommissionMembership(WORKSPACE_ID, {
      agentId: agent.id,
      planId: plan.id,
    });
    await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: agent.id,
    });

    const suspendedAt = new Date(Date.now() + 1_000).toISOString();
    await db.sales_orders.put({
      ...order,
      isPaid: false,
      paymentStatus: "partial",
      paidAmount: 500,
      balanceAmount: 500,
      paidAt: null,
      updatedAt: suspendedAt,
      version: 2,
    });
    await expect(commissions.reconcileSalesOrderCommission(WORKSPACE_ID, order.id)).resolves.toBeNull();

    const repaidAt = new Date(Date.now() + 2_000).toISOString();
    await db.sales_orders.put({ ...order, updatedAt: repaidAt, version: 3 });
    await expect(commissions.reconcileSalesOrderCommission(WORKSPACE_ID, order.id)).resolves.toBeNull();
    const recognized = (await db.agent_commission_entries.where("orderId").equals(order.id).toArray())
      .filter((entry) => ["accrual", "reversal", "adjustment"].includes(entry.kind))
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(recognized).toBe(40);
  });

  it("requires an order-linked adjustment to use that agent's assignment", async () => {
    const assignedAgent = fieldAgent(crypto.randomUUID());
    const otherAgent = fieldAgent(crypto.randomUUID());
    const order = completedOrder(crypto.randomUUID());
    await db.agents.bulkPut([assignedAgent, otherAgent]);
    await db.sales_orders.put(order);
    const assignment = await commissions.assignSalesOrderAgent(WORKSPACE_ID, {
      orderId: order.id,
      agentId: assignedAgent.id,
    });

    const adjustment = await commissions.recordCommissionAdjustment(WORKSPACE_ID, {
      agentId: assignedAgent.id,
      orderId: order.id,
      amount: 5,
      currency: "usd",
      notes: "Manual correction",
    });
    expect(adjustment.assignmentId).toBe(assignment?.id);

    await expect(commissions.recordCommissionAdjustment(WORKSPACE_ID, {
      agentId: assignedAgent.id,
      orderId: order.id,
      amount: 5,
      currency: "eur",
      notes: "Wrong currency",
    })).rejects.toThrow("must use the sales order currency");

    await expect(commissions.recordCommissionAdjustment(WORKSPACE_ID, {
      agentId: otherAgent.id,
      orderId: order.id,
      amount: 5,
      currency: "usd",
      notes: "Wrong agent",
    })).rejects.toThrow("not assigned to this agent");
  });
});
