import "fake-indexeddb/auto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { setNetworkStatus } from "@/lib/network";
import {
  clearWorkspaceModeSnapshot,
  writeWorkspaceModeSnapshot,
} from "@/workspace/workspaceMode";

import { db } from "./database";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000701";

let createBusinessPartner: typeof import("./businessPartners").createBusinessPartner;
let createInstallmentSale: typeof import("./installmentSales").createInstallmentSale;
let recordInstallmentSaleCustomerPayment: typeof import("./installmentSales").recordInstallmentSaleCustomerPayment;
let buildInstallmentSaleSchedule: typeof import("./installmentSales").buildInstallmentSaleSchedule;
let getInstallmentSaleOverdueDays: typeof import("./installmentSales").getInstallmentSaleOverdueDays;
let getInstallmentSaleDisplayStatus: typeof import("./installmentSales").getInstallmentSaleDisplayStatus;
let cancelInstallmentSale: typeof import("./installmentSales").cancelInstallmentSale;
let savePaymentAccount: typeof import("./paymentAccounts").savePaymentAccount;
let reversePaymentTransaction: typeof import("./payments").reversePaymentTransaction;

function installBrowserStorage() {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: storage,
      sessionStorage: storage,
      URL,
      location: { origin: "http://localhost", hash: "", pathname: "/" },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      dir: "ltr",
      documentElement: { lang: "en", dir: "ltr" },
      head: { appendChild: () => undefined },
      createElement: () => ({
        setAttribute: () => undefined,
        appendChild: () => undefined,
      }),
      createTextNode: () => ({}),
      getElementsByTagName: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: false },
  });
  Object.defineProperty(globalThis, "DOMMatrix", {
    configurable: true,
    value: class DOMMatrix {},
  });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: class Element {} });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class HTMLElement {} });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:test",
  });
}

describe("installment sales", () => {
  beforeAll(async () => {
    installBrowserStorage();
    ({ createBusinessPartner } = await import("./businessPartners"));
    ({
      createInstallmentSale,
      recordInstallmentSaleCustomerPayment,
      buildInstallmentSaleSchedule,
      getInstallmentSaleOverdueDays,
      getInstallmentSaleDisplayStatus,
      cancelInstallmentSale,
    } = await import("./installmentSales"));
    ({ savePaymentAccount } = await import("./paymentAccounts"));
    ({ reversePaymentTransaction } = await import("./payments"));
  }, 30_000);

  beforeEach(async () => {
    installBrowserStorage();
    await db.delete();
    await db.open();
    setNetworkStatus(true);
    writeWorkspaceModeSnapshot({
      workspaceId: WORKSPACE_ID,
      dataMode: "local",
    });
  });

  afterEach(() => {
    clearWorkspaceModeSnapshot(WORKSPACE_ID);
    setNetworkStatus(true);
  });

  afterAll(async () => {
    await db.delete();
    await db.open();
  });

  it("uses the selected first due date and puts the IQD rounding remainder on the final daily installment", () => {
    expect(
      buildInstallmentSaleSchedule(1_300_000, "iqd", 3, "daily", "2026-09-08"),
    ).toEqual([
      { installmentNo: 1, dueDate: "2026-09-08", plannedAmount: 433_333 },
      { installmentNo: 2, dueDate: "2026-09-09", plannedAmount: 433_333 },
      { installmentNo: 3, dueDate: "2026-09-10", plannedAmount: 433_334 },
    ]);
  });

  it("creates an untimed open balance with no due date or overdue state", async () => {
    expect(
      buildInstallmentSaleSchedule(1_500_000, "iqd", 7, "no_frequency", null),
    ).toEqual([
      { installmentNo: 1, dueDate: null, plannedAmount: 1_500_000 },
    ]);

    const customer = await createBusinessPartner(WORKSPACE_ID, {
      partnerName: "Open balance customer",
      phone: "07500000002",
      defaultCurrency: "iqd",
      creditLimit: 0,
      role: "customer",
    });
    const { sale, installments } = await createInstallmentSale(WORKSPACE_ID, {
      customerBusinessPartnerId: customer.id,
      description: "Untimed device sale",
      currency: "iqd",
      acquisitionCost: 1_000_000,
      totalSalePrice: 1_500_000,
      installmentCount: 7,
      installmentFrequency: "no_frequency",
    });

    expect(sale).toMatchObject({
      installmentCount: 1,
      hasInstallmentCount: false,
      installmentFrequency: "no_frequency",
      firstDueDate: null,
      nextDueDate: null,
      customerBalanceAmount: 1_500_000,
      status: "active",
    });
    expect(installments).toEqual([
      expect.objectContaining({
        dueDate: null,
        plannedAmount: 1_500_000,
        balanceAmount: 1_500_000,
        status: "unpaid",
      }),
    ]);

    await recordInstallmentSaleCustomerPayment(WORKSPACE_ID, {
      installmentSaleId: sale.id,
      amount: 300_000,
      paymentMethod: "cash",
    });

    expect(await db.installment_sales.get(sale.id)).toMatchObject({
      customerPaidAmount: 300_000,
      customerBalanceAmount: 1_200_000,
      nextDueDate: null,
      status: "active",
    });
    expect(await db.installment_sale_installments.get(installments[0].id)).toMatchObject({
      dueDate: null,
      paidAmount: 300_000,
      balanceAmount: 1_200_000,
      status: "partial",
    });
    expect(
      await db.payment_transactions
        .where("workspaceId")
        .equals(WORKSPACE_ID)
        .toArray(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "installment_sale_installment",
          direction: "incoming",
          amount: 300_000,
        }),
      ]),
    );
  });

  it("keeps a frequency-based sale open-ended and shows the elapsed days after its first due date", async () => {
    expect(
      buildInstallmentSaleSchedule(1_500_000, "iqd", 12, "daily", "2000-01-01", false),
    ).toEqual([
      { installmentNo: 1, dueDate: "2000-01-01", plannedAmount: 1_500_000 },
    ]);
    expect(
      buildInstallmentSaleSchedule(
        1_500_000,
        "iqd",
        3,
        "daily",
        "2026-09-08T14:30",
      ),
    ).toEqual([
      {
        installmentNo: 1,
        dueDate: "2026-09-08T14:30:00",
        plannedAmount: 500_000,
      },
      {
        installmentNo: 2,
        dueDate: "2026-09-09T14:30:00",
        plannedAmount: 500_000,
      },
      {
        installmentNo: 3,
        dueDate: "2026-09-10T14:30:00",
        plannedAmount: 500_000,
      },
    ]);
    expect(getInstallmentSaleOverdueDays("2026-09-06", "2026-09-09")).toBe(3);
    expect(getInstallmentSaleOverdueDays("2026-09-09", "2026-09-09")).toBe(0);
    expect(
      getInstallmentSaleDisplayStatus(
        {
          status: "active",
          customerBalanceAmount: 1_500_000,
          hasInstallmentCount: false,
          installmentFrequency: "daily",
          firstDueDate: "2026-09-09T10:00",
        },
        "2026-09-09T10:01",
      ),
    ).toBe("overdue");
    expect(
      getInstallmentSaleOverdueDays(
        "2026-09-09T10:00",
        "2026-09-09T10:01",
      ),
    ).toBe(0);
    expect(
      getInstallmentSaleDisplayStatus(
        {
          status: "active",
          customerBalanceAmount: 1_500_000,
          hasInstallmentCount: false,
          installmentFrequency: "daily",
          firstDueDate: "2026-09-06",
        },
        "2026-09-09",
      ),
    ).toBe("overdue");

    const customer = await createBusinessPartner(WORKSPACE_ID, {
      partnerName: "Open-ended daily customer",
      phone: "07500000004",
      defaultCurrency: "iqd",
      creditLimit: 0,
      role: "customer",
    });
    const { sale, installments } = await createInstallmentSale(WORKSPACE_ID, {
      customerBusinessPartnerId: customer.id,
      description: "Open-ended daily sale",
      currency: "iqd",
      acquisitionCost: 1_000_000,
      totalSalePrice: 1_500_000,
      installmentCount: 12,
      hasInstallmentCount: false,
      installmentFrequency: "daily",
      firstDueDate: "2000-01-01T09:30",
    });

    expect(sale).toMatchObject({
      installmentCount: 1,
      hasInstallmentCount: false,
      firstDueDate: "2000-01-01T09:30:00",
      nextDueDate: "2000-01-01T09:30:00",
      customerBalanceAmount: 1_500_000,
      status: "overdue",
    });
    expect(installments).toEqual([
      expect.objectContaining({
        dueDate: "2000-01-01T09:30:00",
        plannedAmount: 1_500_000,
        status: "overdue",
      }),
    ]);

    await recordInstallmentSaleCustomerPayment(WORKSPACE_ID, {
      installmentSaleId: sale.id,
      amount: 300_000,
      paymentMethod: "cash",
    });
    expect(await db.installment_sales.get(sale.id)).toMatchObject({
      customerPaidAmount: 300_000,
      customerBalanceAmount: 1_200_000,
      status: "overdue",
    });

    await expect(
      createInstallmentSale(WORKSPACE_ID, {
        customerBusinessPartnerId: customer.id,
        description: "Missing first due date",
        currency: "iqd",
        acquisitionCost: 100,
        totalSalePrice: 150,
        installmentCount: 1,
        hasInstallmentCount: false,
        installmentFrequency: "daily",
      }),
    ).rejects.toThrow("A valid first due date and time is required");
  });

  it("creates a customer receivable and records every collection through payment transactions", async () => {
    const customer = await createBusinessPartner(WORKSPACE_ID, {
      partnerName: "Customer A",
      phone: "07500000001",
      defaultCurrency: "iqd",
      creditLimit: 0,
      role: "customer",
    });
    const account = await savePaymentAccount(WORKSPACE_ID, {
      name: "Sale drawer",
      accountType: "cash_drawer",
      openingBalances: [{ currency: "iqd", amount: 100_000 }],
    });

    const created = await createInstallmentSale(WORKSPACE_ID, {
      customerBusinessPartnerId: customer.id,
      description: "One-off device bundle",
      currency: "iqd",
      acquisitionCost: 1_000_000,
      totalSalePrice: 1_500_000,
      downPaymentAmount: 200_000,
      installmentCount: 3,
      installmentFrequency: "daily",
      firstDueDate: "2026-09-08",
      downPaymentMethod: "cash",
      downPaymentAccountId: account.id,
      downPaymentAccountNameSnapshot: account.name,
    });

    expect(created.sale).toMatchObject({
      grossProfit: 500_000,
      customerPaidAmount: 200_000,
      customerBalanceAmount: 1_300_000,
    });
    expect(created.installments.map((row) => row.plannedAmount)).toEqual([
      433_333, 433_333, 433_334,
    ]);
    expect(
      await db.payment_transactions
        .where("workspaceId")
        .equals(WORKSPACE_ID)
        .toArray(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "installment_sale_down_payment",
          direction: "incoming",
          amount: 200_000,
        }),
      ]),
    );

    const afterDownPaymentCustomer = await db.business_partners.get(
      customer.id,
    );
    expect(afterDownPaymentCustomer?.receivableBalance).toBe(1_300_000);

    await recordInstallmentSaleCustomerPayment(WORKSPACE_ID, {
      installmentSaleId: created.sale.id,
      installmentId: created.installments[0].id,
      amount: 300_000,
      paymentMethod: "cash",
      accountId: account.id,
      accountNameSnapshot: account.name,
    });
    const updatedSale = await db.installment_sales.get(created.sale.id);
    const updatedSchedule = await db.installment_sale_installments
      .where("installmentSaleId")
      .equals(created.sale.id)
      .sortBy("installmentNo");
    expect(updatedSale).toMatchObject({
      customerPaidAmount: 500_000,
      customerBalanceAmount: 1_000_000,
    });
    expect(updatedSchedule[0]).toMatchObject({
      paidAmount: 300_000,
      balanceAmount: 133_333,
      status: "partial",
    });
    expect(
      await db.payment_transactions
        .where("workspaceId")
        .equals(WORKSPACE_ID)
        .toArray(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "installment_sale_installment",
          direction: "incoming",
          amount: 300_000,
        }),
      ]),
    );
    const saleTransactions = (
      await db.payment_transactions
        .where("workspaceId")
        .equals(WORKSPACE_ID)
        .toArray()
    ).filter((transaction) => transaction.sourceModule === "installment_sales");
    expect(
      await db.payment_account_movements
        .where("accountId")
        .equals(account.id)
        .toArray(),
    ).toEqual(
      expect.arrayContaining(
        saleTransactions.map((transaction) =>
          expect.objectContaining({
            paymentTransactionId: transaction.id,
            deltaAmount: transaction.amount,
          }),
        ),
      ),
    );
    expect(
      await db.payment_account_balances
        .where("[accountId+currency]")
        .equals([account.id, "iqd"])
        .first(),
    ).toMatchObject({ balanceAmount: 600_000 });
  });

  it("rejects prices below cost and customer collections above the outstanding balance", async () => {
    const customer = await createBusinessPartner(WORKSPACE_ID, {
      partnerName: "Customer B",
      phone: "07500000003",
      defaultCurrency: "iqd",
      creditLimit: 0,
      role: "customer",
    });
    await expect(
      createInstallmentSale(WORKSPACE_ID, {
        customerBusinessPartnerId: customer.id,
        description: "Invalid",
        currency: "iqd",
        acquisitionCost: 100,
        totalSalePrice: 99,
        installmentCount: 1,
        installmentFrequency: "monthly",
        firstDueDate: "2026-10-01",
      }),
    ).rejects.toThrow("Sale price cannot be less than acquisition cost");

    const { sale } = await createInstallmentSale(WORKSPACE_ID, {
      customerBusinessPartnerId: customer.id,
      description: "Valid",
      currency: "iqd",
      acquisitionCost: 100,
      totalSalePrice: 150,
      installmentCount: 1,
      installmentFrequency: "monthly",
      firstDueDate: "2026-10-01",
    });
    await expect(
      recordInstallmentSaleCustomerPayment(WORKSPACE_ID, {
        installmentSaleId: sale.id,
        amount: 151,
        paymentMethod: "cash",
      }),
    ).rejects.toThrow("Payment amount cannot exceed the customer balance");
    expect(
      (await db.installment_sales.get(sale.id))?.customerBalanceAmount,
    ).toBe(150);
    expect(
      await db.installment_sale_payments
        .where("installmentSaleId")
        .equals(sale.id)
        .count(),
    ).toBe(0);
  });

  it("cancels a financially active sale by posting immutable customer-payment reversals", async () => {
    const customer = await createBusinessPartner(WORKSPACE_ID, {
      partnerName: "Customer C",
      phone: "07500000005",
      defaultCurrency: "iqd",
      creditLimit: 0,
      role: "customer",
    });
    const { sale, installments } = await createInstallmentSale(WORKSPACE_ID, {
      customerBusinessPartnerId: customer.id,
      description: "Cancelled sale",
      currency: "iqd",
      acquisitionCost: 100,
      totalSalePrice: 150,
      downPaymentAmount: 20,
      installmentCount: 2,
      installmentFrequency: "weekly",
      firstDueDate: "2026-10-01",
      downPaymentMethod: "cash",
    });
    await recordInstallmentSaleCustomerPayment(WORKSPACE_ID, {
      installmentSaleId: sale.id,
      installmentId: installments[0].id,
      amount: 40,
      paymentMethod: "cash",
    });
    await cancelInstallmentSale(WORKSPACE_ID, sale.id, {
      reason: "Customer returned the item",
      cancelledBy: "user-1",
    });

    expect(await db.installment_sales.get(sale.id)).toMatchObject({
      status: "cancelled",
      customerPaidAmount: 0,
      customerBalanceAmount: 0,
      cancellationReason: "Customer returned the item",
    });
    expect(
      await db.installment_sale_installments
        .where("installmentSaleId")
        .equals(sale.id)
        .toArray(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "cancelled", balanceAmount: 0 }),
      ]),
    );
    const transactions = await db.payment_transactions
      .where("workspaceId")
      .equals(WORKSPACE_ID)
      .toArray();
    expect(
      transactions.filter((item) => item.reversalOfTransactionId),
    ).toHaveLength(2);
    expect(transactions.filter((item) => item.amount < 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "installment_sale_down_payment",
          amount: -20,
        }),
        expect.objectContaining({
          sourceType: "installment_sale_installment",
          amount: -40,
        }),
      ]),
    );
    expect(
      (await db.business_partners.get(customer.id))?.receivableBalance,
    ).toBe(0);
  });

  it("reverses an individual customer payment through an immutable payment transaction", async () => {
    const customer = await createBusinessPartner(WORKSPACE_ID, {
      partnerName: "Customer D",
      phone: "07500000006",
      defaultCurrency: "iqd",
      creditLimit: 0,
      role: "customer",
    });
    const { sale, installments } = await createInstallmentSale(WORKSPACE_ID, {
      customerBusinessPartnerId: customer.id,
      description: "Reversible payment sale",
      currency: "iqd",
      acquisitionCost: 100,
      totalSalePrice: 150,
      installmentCount: 2,
      installmentFrequency: "weekly",
      firstDueDate: "2026-10-01",
    });
    const recorded = await recordInstallmentSaleCustomerPayment(WORKSPACE_ID, {
      installmentSaleId: sale.id,
      installmentId: installments[0].id,
      amount: 40,
      paymentMethod: "cash",
    });
    const originalTransaction = (
      await db.payment_transactions
        .where("workspaceId")
        .equals(WORKSPACE_ID)
        .toArray()
    ).find(
      (transaction) =>
        transaction.sourceSubrecordId === recorded.payment.id &&
        !transaction.reversalOfTransactionId,
    );

    expect(originalTransaction).toMatchObject({
      sourceModule: "installment_sales",
      sourceType: "installment_sale_installment",
      amount: 40,
    });

    const partialReversal = await reversePaymentTransaction(
      WORKSPACE_ID,
      originalTransaction!.id,
      { amount: 15, createdBy: "user-1" },
    );

    expect(partialReversal).toMatchObject({
      sourceModule: "installment_sales",
      sourceSubrecordId: recorded.payment.id,
      amount: -15,
      reversalOfTransactionId: originalTransaction!.id,
    });
    expect(await db.installment_sales.get(sale.id)).toMatchObject({
      customerPaidAmount: 25,
      customerBalanceAmount: 125,
      status: "active",
    });
    expect(await db.installment_sale_installments.get(installments[0].id)).toMatchObject({
      paidAmount: 25,
      balanceAmount: 50,
      status: "partial",
    });

    const remainingReversal = await reversePaymentTransaction(
      WORKSPACE_ID,
      originalTransaction!.id,
      { amount: 25, createdBy: "user-1" },
    );
    expect(await db.installment_sales.get(sale.id)).toMatchObject({
      customerPaidAmount: 0,
      customerBalanceAmount: 150,
      status: "active",
    });
    expect(await db.installment_sale_installments.get(installments[0].id)).toMatchObject({
      paidAmount: 0,
      balanceAmount: 75,
      status: "unpaid",
    });
    expect(
      await db.payment_transactions
        .where("sourceRecordId")
        .equals(sale.id)
        .toArray(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: originalTransaction!.id, amount: 40 }),
        expect.objectContaining({ id: partialReversal.id, amount: -15 }),
        expect.objectContaining({ id: remainingReversal.id, amount: -25 }),
      ]),
    );
    await expect(
      reversePaymentTransaction(WORKSPACE_ID, partialReversal.id),
    ).rejects.toThrow("Reversal entries cannot be reversed");
  });
});
