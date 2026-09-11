import {
  buildPaymentObligations,
  db,
  enrichSalesForUiRows,
  getPaymentTransactionRoutePath,
  toUISale,
  type CurrencyCode,
  type ExpenseItem,
  type Invoice,
  type PaymentObligation,
  type PaymentTransaction,
  type Product,
  type PurchaseOrder,
  type Sale,
  type SalesOrder,
} from "@/local-db";
import { convertToStoreBase } from "@/lib/currency";
import { isService } from "@/lib/catalogItem";
import {
  buildRevenueAnalysisRecords,
  getRevenueAnalysisTotals,
  type RevenueAnalysisRecord,
} from "@/lib/revenueAnalysis";
import { formatDate } from "@/lib/utils";
import {
  assistantDayKey,
  getAssistantDateRange,
  isWithinAssistantRange,
  type AssistantDateRange,
} from "./dateRanges";
import {
  formatAssistantCurrency,
  formatAssistantNumber,
  formatPercentChange,
  localizeAssistantText,
} from "./formatAssistantAnswer";
import { getAssistantCatalogEntry } from "./intentCatalog";
import { detectAssistantIntent, normalizeAssistantQuery } from "./normalizeQuery";
import type {
  AssistantAnswer,
  AssistantAnswerContext,
  AssistantAnswerRow,
  AssistantDetection,
  AssistantIntentId,
  AssistantLanguage,
  AssistantMetric,
} from "./types";

type AmountMap = Partial<Record<CurrencyCode, number>>;

interface AssistantLedgerEntry {
  id: string;
  date: string;
  direction: "incoming" | "outgoing";
  amount: number;
  currency: CurrencyCode;
  paymentMethod: string;
  partner: string | null;
  label: string;
  detail?: string | null;
  routePath: string;
}

const SUPPORTED_CURRENCIES: CurrencyCode[] = ["usd", "eur", "iqd", "try"];

function asCurrency(value: string | null | undefined, fallback: CurrencyCode): CurrencyCode {
  const normalized = value?.toLowerCase() as CurrencyCode | undefined;
  return normalized && SUPPORTED_CURRENCIES.includes(normalized) ? normalized : fallback;
}

function active<T extends { isDeleted?: boolean; voidId?: string | null }>(rows: T[]) {
  return rows.filter((row) => !row.isDeleted && !row.voidId);
}

function addAmount(target: AmountMap, currency: CurrencyCode, amount: number) {
  target[currency] = (target[currency] ?? 0) + amount;
}

function amountMapEntries(amounts: AmountMap) {
  return SUPPORTED_CURRENCIES
    .map((currency) => [currency, amounts[currency] ?? 0] as const)
    .filter(([, value]) => Math.abs(value) > 0.0001);
}

function formatAmountMap(amounts: AmountMap, context: AssistantAnswerContext) {
  const entries = amountMapEntries(amounts);
  if (entries.length === 0) {
    return formatAssistantCurrency(0, context.defaultCurrency, context.iqdDisplayPreference);
  }

  return entries
    .map(([currency, amount]) =>
      formatAssistantCurrency(amount, currency, context.iqdDisplayPreference),
    )
    .join(" + ");
}

function defaultCurrencyTotal(amounts: AmountMap, context: AssistantAnswerContext) {
  if (!context.rates) return null;
  return amountMapEntries(amounts).reduce(
    (sum, [currency, amount]) =>
      sum + convertToStoreBase(amount, currency, context.defaultCurrency, context.rates!),
    0,
  );
}

function metricFromAmount(
  label: string,
  amounts: AmountMap,
  context: AssistantAnswerContext,
  tone?: AssistantMetric["tone"],
): AssistantMetric {
  const defaultTotal = defaultCurrencyTotal(amounts, context);
  return {
    label,
    value: defaultTotal === null
      ? formatAmountMap(amounts, context)
      : formatAssistantCurrency(defaultTotal, context.defaultCurrency, context.iqdDisplayPreference),
    tone,
  };
}

function answerBase(
  detection: AssistantDetection,
  status: AssistantAnswer["status"],
  title: string,
  summary: string,
  extra: Partial<AssistantAnswer> = {},
): AssistantAnswer {
  return {
    status,
    intentId: detection.intentId ?? undefined,
    language: detection.language,
    title,
    summary,
    confidence: detection.confidence,
    ...extra,
  };
}

function noData(detection: AssistantDetection, title: string, routePath?: string): AssistantAnswer {
  return answerBase(
    detection,
    "no_data",
    title,
    localizeAssistantText(detection.language, {
      en: "No matching records were found for this question.",
      ar: "لم يتم العثور على سجلات مطابقة لهذا السؤال.",
      ku: "هیچ تۆمارێکی گونجاو بۆ ئەم پرسیارە نەدۆزرایەوە.",
    }),
    { routePath },
  );
}

function periodLabel(language: AssistantLanguage, key: "today" | "this_month" | "this_year" | "last_month") {
  const labels = {
    today: { en: "today", ar: "اليوم", ku: "ئەمڕۆ" },
    this_month: { en: "this month", ar: "هذا الشهر", ku: "ئەم مانگە" },
    this_year: { en: "this year", ar: "هذه السنة", ku: "ئەم ساڵە" },
    last_month: { en: "last month", ar: "الشهر الماضي", ku: "مانگی ڕابردوو" },
  } as const;
  return labels[key][language];
}

async function loadRevenueRecords(
  context: AssistantAnswerContext,
  range?: AssistantDateRange,
) {
  const salesRows = range
    ? await db.sales
      .where("[workspaceId+createdAt]")
      .between([context.workspaceId, range.startIso], [context.workspaceId, range.endIso], true, true)
      .toArray()
    : await db.sales.where("workspaceId").equals(context.workspaceId).toArray();
  const enriched = await enrichSalesForUiRows(context.workspaceId, active(salesRows));
  const uiSales = enriched.map((sale) => toUISale(sale)) as unknown as Parameters<typeof buildRevenueAnalysisRecords>[0];
  const salesOrders = active(
    await db.sales_orders.where("workspaceId").equals(context.workspaceId).toArray(),
  );

  return buildRevenueAnalysisRecords(uiSales, salesOrders);
}

function revenueTotalsByCurrency(records: RevenueAnalysisRecord[], fallbackCurrency: CurrencyCode) {
  const revenue: AmountMap = {};
  const cost: AmountMap = {};
  const profit: AmountMap = {};

  for (const record of records) {
    if (record.isReturned) continue;
    const currency = asCurrency(record.currency, fallbackCurrency);
    const totals = getRevenueAnalysisTotals(record);
    addAmount(revenue, currency, totals.revenue);
    addAmount(cost, currency, totals.cost);
    addAmount(profit, currency, totals.profit);
  }

  return { revenue, cost, profit };
}

function filterRecords(records: RevenueAnalysisRecord[], range: AssistantDateRange) {
  return records.filter((record) => isWithinAssistantRange(record.date, range));
}

async function answerRevenue(
  detection: AssistantDetection,
  context: AssistantAnswerContext,
  rangeKey: "today" | "this_month" | "this_year",
) {
  const range = getAssistantDateRange(rangeKey, context.now);
  const records = filterRecords(await loadRevenueRecords(context, range), range);
  const totals = revenueTotalsByCurrency(records, context.defaultCurrency);
  if (records.length === 0 || amountMapEntries(totals.revenue).length === 0) {
    return noData(detection, "Revenue", "/revenue");
  }

  const period = periodLabel(detection.language, rangeKey);
  return answerBase(
    detection,
    "answered",
    localizeAssistantText(detection.language, {
      en: "Revenue",
      ar: "الإيرادات",
      ku: "داهات",
    }),
    localizeAssistantText(detection.language, {
      en: `Revenue ${period} is ${formatAmountMap(totals.revenue, context)}.`,
      ar: `الإيرادات ${period} هي ${formatAmountMap(totals.revenue, context)}.`,
      ku: `داهات ${period} بریتییە لە ${formatAmountMap(totals.revenue, context)}.`,
    }),
    {
      metrics: [
        metricFromAmount("Revenue", totals.revenue, context, "positive"),
        metricFromAmount("Cost", totals.cost, context),
        metricFromAmount("Gross profit", totals.profit, context, "positive"),
      ],
      routePath: "/revenue",
    },
  );
}

async function loadExpenseTotalsThisMonth(context: AssistantAnswerContext) {
  const month = `${(context.now ?? new Date()).getFullYear()}-${String((context.now ?? new Date()).getMonth() + 1).padStart(2, "0")}`;
  const [expenseItems, expenseSeries, directTransactions] = await Promise.all([
    db.expense_items.where("[workspaceId+month]").equals([context.workspaceId, month]).toArray(),
    db.expense_series.where("workspaceId").equals(context.workspaceId).toArray(),
    db.payment_transactions.where("workspaceId").equals(context.workspaceId).toArray(),
  ]);
  const seriesById = new Map(active(expenseSeries).map((series) => [series.id, series]));
  const amounts: AmountMap = {};

  active(expenseItems).forEach((item: ExpenseItem) => {
    const series = seriesById.get(item.seriesId);
    addAmount(amounts, asCurrency(item.currency || series?.currency, context.defaultCurrency), item.amount || 0);
  });

  const range = getAssistantDateRange("this_month", context.now);
  active(directTransactions)
    .filter((transaction) =>
      transaction.sourceType === "direct_transaction"
      && transaction.direction === "outgoing"
      && isWithinAssistantRange(transaction.paidAt, range),
    )
    .forEach((transaction) => {
      addAmount(amounts, asCurrency(transaction.currency, context.defaultCurrency), transaction.amount || 0);
    });

  return amounts;
}

async function answerExpensesThisMonth(detection: AssistantDetection, context: AssistantAnswerContext) {
  const amounts = await loadExpenseTotalsThisMonth(context);
  if (amountMapEntries(amounts).length === 0) return noData(detection, "Expenses", "/budget");
  return answerBase(
    detection,
    "answered",
    localizeAssistantText(detection.language, {
      en: "Expenses",
      ar: "المصاريف",
      ku: "خەرجی",
    }),
    localizeAssistantText(detection.language, {
      en: `Expenses this month are ${formatAmountMap(amounts, context)}.`,
      ar: `المصاريف هذا الشهر هي ${formatAmountMap(amounts, context)}.`,
      ku: `خەرجی ئەم مانگە بریتییە لە ${formatAmountMap(amounts, context)}.`,
    }),
    {
      metrics: [metricFromAmount("Expenses", amounts, context, "negative")],
      routePath: "/budget",
    },
  );
}

async function answerProfitThisMonth(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("this_month", context.now);
  const records = filterRecords(await loadRevenueRecords(context, range), range);
  const totals = revenueTotalsByCurrency(records, context.defaultCurrency);
  const expenses = context.hasFeature("budget") && context.hasPermission("budget.access")
    ? await loadExpenseTotalsThisMonth(context)
    : {};
  const profitBase = defaultCurrencyTotal(totals.profit, context);
  const expenseBase = defaultCurrencyTotal(expenses, context) ?? 0;
  const netProfitBase = profitBase === null ? null : profitBase - expenseBase;

  if (records.length === 0 && amountMapEntries(expenses).length === 0) {
    return noData(detection, "Profit", "/revenue");
  }

  return answerBase(
    detection,
    "answered",
    localizeAssistantText(detection.language, {
      en: "Profit",
      ar: "الربح",
      ku: "قازانج",
    }),
    netProfitBase === null
      ? localizeAssistantText(detection.language, {
        en: `Gross profit this month is ${formatAmountMap(totals.profit, context)}.`,
        ar: `إجمالي الربح هذا الشهر هو ${formatAmountMap(totals.profit, context)}.`,
        ku: `قازانجی گشتی ئەم مانگە ${formatAmountMap(totals.profit, context)} ـە.`,
      })
      : localizeAssistantText(detection.language, {
        en: `Estimated profit this month is ${formatAssistantCurrency(netProfitBase, context.defaultCurrency, context.iqdDisplayPreference)}.`,
        ar: `الربح التقديري هذا الشهر هو ${formatAssistantCurrency(netProfitBase, context.defaultCurrency, context.iqdDisplayPreference)}.`,
        ku: `قازانجی خەملێنراوی ئەم مانگە ${formatAssistantCurrency(netProfitBase, context.defaultCurrency, context.iqdDisplayPreference)} ـە.`,
      }),
    {
      metrics: [
        metricFromAmount("Gross profit", totals.profit, context, "positive"),
        metricFromAmount("Expenses", expenses, context, "negative"),
        ...(netProfitBase === null ? [] : [{
          label: "Net estimate",
          value: formatAssistantCurrency(netProfitBase, context.defaultCurrency, context.iqdDisplayPreference),
          tone: netProfitBase >= 0 ? "positive" as const : "negative" as const,
        }]),
      ],
      routePath: "/revenue",
    },
  );
}

async function answerSalesCountToday(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("today", context.now);
  const sales = active(
    await db.sales
      .where("[workspaceId+createdAt]")
      .between([context.workspaceId, range.startIso], [context.workspaceId, range.endIso], true, true)
      .toArray(),
  ).filter((sale) => !sale.isReturned);

  return answerBase(
    detection,
    sales.length > 0 ? "answered" : "no_data",
    localizeAssistantText(detection.language, {
      en: "Sales Count",
      ar: "عدد المبيعات",
      ku: "ژمارەی فرۆشتن",
    }),
    localizeAssistantText(detection.language, {
      en: `There ${sales.length === 1 ? "was" : "were"} ${sales.length} sale${sales.length === 1 ? "" : "s"} today.`,
      ar: `عدد المبيعات اليوم هو ${sales.length}.`,
      ku: `ژمارەی فرۆشتنی ئەمڕۆ ${sales.length} ـە.`,
    }),
    {
      metrics: [{ label: "Sales", value: formatAssistantNumber(sales.length) }],
      routePath: "/sales",
    },
  );
}

async function answerUnpaidInvoices(detection: AssistantDetection, context: AssistantAnswerContext) {
  const invoices = active(await db.invoices.where("workspaceId").equals(context.workspaceId).toArray())
    .filter((invoice: Invoice) => invoice.status !== "paid" && invoice.status !== "cancelled")
    .slice(0, 10);

  if (invoices.length === 0) return noData(detection, "Unpaid invoices", "/invoices-history");

  return answerBase(
    detection,
    "answered",
    "Unpaid invoices",
    `${invoices.length} unpaid invoice${invoices.length === 1 ? "" : "s"} found.`,
    {
      metrics: [{ label: "Invoices", value: formatAssistantNumber(invoices.length), tone: "warning" }],
      rows: invoices.map((invoice) => ({
        id: invoice.id,
        label: invoice.invoiceid,
        value: formatAssistantCurrency(invoice.totalAmount || 0, asCurrency(invoice.settlementCurrency, context.defaultCurrency), context.iqdDisplayPreference),
        detail: invoice.status || "open",
        routePath: "/invoices-history",
      })),
      routePath: "/invoices-history",
    },
  );
}

async function loadObligations(context: AssistantAnswerContext, direction?: "incoming" | "outgoing", status?: "open" | "overdue") {
  return buildPaymentObligations(context.workspaceId, {
    direction: direction ?? "all",
    status: status ?? "all",
  });
}

function obligationTotals(obligations: PaymentObligation[], context: AssistantAnswerContext) {
  const amounts: AmountMap = {};
  obligations.forEach((obligation) => {
    addAmount(amounts, asCurrency(obligation.currency, context.defaultCurrency), obligation.amount || 0);
  });
  return amounts;
}

async function answerObligationTotal(
  detection: AssistantDetection,
  context: AssistantAnswerContext,
  direction: "incoming" | "outgoing",
) {
  const obligations = await loadObligations(context, direction, "open");
  const amounts = obligationTotals(obligations, context);
  if (obligations.length === 0) return noData(detection, direction === "incoming" ? "Receivables" : "Payables", "/payments");

  return answerBase(
    detection,
    "answered",
    direction === "incoming" ? "Receivables" : "Payables",
    direction === "incoming"
      ? `Money owed to us is ${formatAmountMap(amounts, context)}.`
      : `Money we owe is ${formatAmountMap(amounts, context)}.`,
    {
      metrics: [
        { label: "Open items", value: formatAssistantNumber(obligations.length), tone: "warning" },
        metricFromAmount("Total", amounts, context, direction === "incoming" ? "positive" : "negative"),
      ],
      rows: obligations.slice(0, 8).map((obligation) => ({
        id: obligation.id,
        label: obligation.title,
        value: formatAssistantCurrency(obligation.amount, asCurrency(obligation.currency, context.defaultCurrency), context.iqdDisplayPreference),
        detail: obligation.counterpartyName || obligation.subtitle || undefined,
        routePath: obligation.routePath,
      })),
      routePath: "/payments",
    },
  );
}

async function answerTopCustomers(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("this_month", context.now);
  const orders = active(await db.sales_orders.where("workspaceId").equals(context.workspaceId).toArray())
    .filter((order: SalesOrder) => order.status !== "cancelled" && isWithinAssistantRange(order.createdAt, range));
  const totals = new Map<string, { name: string; amount: number; currency: CurrencyCode }>();

  orders.forEach((order) => {
    const key = order.businessPartnerId || order.customerId || order.customerName;
    const currency = asCurrency(order.currency, context.defaultCurrency);
    const amount = context.rates
      ? convertToStoreBase(order.total || 0, currency, context.defaultCurrency, context.rates)
      : order.total || 0;
    const existing = totals.get(key) ?? { name: order.customerName || "Customer", amount: 0, currency: context.defaultCurrency };
    existing.amount += amount;
    totals.set(key, existing);
  });

  const rows = Array.from(totals.values()).sort((a, b) => b.amount - a.amount).slice(0, 8);
  if (rows.length === 0) return noData(detection, "Top customers", "/business-partners");

  return answerBase(
    detection,
    "answered",
    "Top customers",
    `Top customers this month are ranked by sales order value.`,
    {
      rows: rows.map((row, index) => ({
        id: `${index}-${row.name}`,
        label: row.name,
        value: formatAssistantCurrency(row.amount, context.defaultCurrency, context.iqdDisplayPreference),
        routePath: "/business-partners",
      })),
      routePath: "/business-partners",
    },
  );
}

async function answerBestSellingProducts(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("this_month", context.now);
  const records = filterRecords(await loadRevenueRecords(context, range), range);
  const products = new Map<string, { name: string; quantity: number; revenue: AmountMap }>();

  records.forEach((record) => {
    if (record.isReturned) return;
    const currency = asCurrency(record.currency, context.defaultCurrency);
    record.items.forEach((item) => {
      const quantity = Math.max(0, item.quantity - item.returnedQuantity);
      if (quantity <= 0) return;
      const existing = products.get(item.productId) ?? { name: item.productName, quantity: 0, revenue: {} };
      existing.quantity += quantity;
      addAmount(existing.revenue, currency, item.unitPrice * quantity);
      products.set(item.productId, existing);
    });
  });

  const rows = Array.from(products.values()).sort((a, b) => b.quantity - a.quantity).slice(0, 8);
  if (rows.length === 0) return noData(detection, "Best-selling products", "/revenue");

  return answerBase(
    detection,
    "answered",
    "Best-selling products",
    "Best-selling products this month are ranked by quantity sold.",
    {
      rows: rows.map((row) => ({
        id: row.name,
        label: row.name,
        value: `${formatAssistantNumber(row.quantity)} sold`,
        detail: formatAmountMap(row.revenue, context),
        routePath: "/revenue",
      })),
      routePath: "/revenue",
    },
  );
}

async function loadProductQuantities(context: AssistantAnswerContext) {
  const [products, inventory] = await Promise.all([
    db.products.where("workspaceId").equals(context.workspaceId).toArray(),
    db.inventory.where("workspaceId").equals(context.workspaceId).toArray(),
  ]);
  const inventoryByProduct = new Map<string, number>();
  active(inventory).forEach((row) => {
    inventoryByProduct.set(row.productId, (inventoryByProduct.get(row.productId) ?? 0) + (row.quantity || 0));
  });

  return active(products).filter((product: Product) => !isService(product)).map((product: Product) => ({
    product,
    quantity: inventoryByProduct.has(product.id)
      ? inventoryByProduct.get(product.id) ?? 0
      : product.quantity || 0,
  }));
}

async function answerLowStock(detection: AssistantDetection, context: AssistantAnswerContext) {
  const rows = (await loadProductQuantities(context))
    .filter(({ product, quantity }) => quantity <= (product.minStockLevel || 0))
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 10);

  if (rows.length === 0) return noData(detection, "Low stock", "/products");

  return answerBase(
    detection,
    "answered",
    "Low stock",
    `${rows.length} product${rows.length === 1 ? "" : "s"} are at or below minimum stock.`,
    {
      metrics: [{ label: "Low stock items", value: formatAssistantNumber(rows.length), tone: "warning" }],
      rows: rows.map(({ product, quantity }) => ({
        id: product.id,
        label: product.name,
        value: formatAssistantNumber(quantity),
        detail: `Minimum ${formatAssistantNumber(product.minStockLevel || 0)}`,
        routePath: `/products/${product.id}`,
      })),
      routePath: "/products",
    },
  );
}

async function answerStockValue(detection: AssistantDetection, context: AssistantAnswerContext) {
  const amounts: AmountMap = {};
  (await loadProductQuantities(context)).forEach(({ product, quantity }) => {
    addAmount(amounts, asCurrency(product.currency, context.defaultCurrency), (product.costPrice || 0) * quantity);
  });

  if (amountMapEntries(amounts).length === 0) return noData(detection, "Stock value", "/products");

  return answerBase(
    detection,
    "answered",
    "Stock value",
    `Current stock value is ${formatAmountMap(amounts, context)}.`,
    {
      metrics: [metricFromAmount("Stock value", amounts, context)],
      routePath: "/products",
    },
  );
}

async function answerSalesByDay(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("this_month", context.now);
  const records = filterRecords(await loadRevenueRecords(context, range), range);
  const byDay = new Map<string, AmountMap>();

  records.forEach((record) => {
    const day = assistantDayKey(record.date);
    const totals = getRevenueAnalysisTotals(record);
    const amounts = byDay.get(day) ?? {};
    addAmount(amounts, asCurrency(record.currency, context.defaultCurrency), totals.revenue);
    byDay.set(day, amounts);
  });

  const rows = Array.from(byDay.entries()).sort(([a], [b]) => b.localeCompare(a)).slice(0, 12);
  if (rows.length === 0) return noData(detection, "Sales by day", "/revenue");

  return answerBase(
    detection,
    "answered",
    "Sales by day",
    "Daily sales for this month are shown below.",
    {
      rows: rows.map(([day, amounts]) => ({
        id: day,
        label: formatDate(day),
        value: formatAmountMap(amounts, context),
        routePath: "/revenue",
      })),
      routePath: "/revenue",
    },
  );
}

async function answerSalesByBranch(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("this_month", context.now);
  const records = filterRecords(await loadRevenueRecords(context, range), range);
  const totals = revenueTotalsByCurrency(records, context.defaultCurrency);
  if (amountMapEntries(totals.revenue).length === 0) return noData(detection, "Sales by branch", "/revenue");

  return answerBase(
    detection,
    "answered",
    "Sales by branch",
    "This local assistant can currently report the active workspace branch only.",
    {
      rows: [{
        id: context.workspaceId,
        label: "Current workspace",
        value: formatAmountMap(totals.revenue, context),
        routePath: "/revenue",
      }],
      routePath: "/revenue",
    },
  );
}

async function answerPurchasesThisMonth(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("this_month", context.now);
  const orders = active(await db.purchase_orders.where("workspaceId").equals(context.workspaceId).toArray())
    .filter((order: PurchaseOrder) => order.status !== "cancelled" && isWithinAssistantRange(order.createdAt, range));
  const amounts: AmountMap = {};
  orders.forEach((order) => addAmount(amounts, asCurrency(order.currency, context.defaultCurrency), order.total || 0));

  if (orders.length === 0) return noData(detection, "Purchases", "/orders");

  return answerBase(
    detection,
    "answered",
    "Purchases",
    `Purchases this month are ${formatAmountMap(amounts, context)}.`,
    {
      metrics: [
        { label: "Purchase orders", value: formatAssistantNumber(orders.length) },
        metricFromAmount("Total", amounts, context, "negative"),
      ],
      rows: orders.slice(0, 8).map((order) => ({
        id: order.id,
        label: order.orderNumber,
        value: formatAssistantCurrency(order.total || 0, asCurrency(order.currency, context.defaultCurrency), context.iqdDisplayPreference),
        detail: order.supplierName,
        routePath: `/orders/${order.id}`,
      })),
      routePath: "/orders",
    },
  );
}

async function answerOverdueInvoices(detection: AssistantDetection, context: AssistantAnswerContext) {
  const [obligations, invoices] = await Promise.all([
    loadObligations(context, undefined, "overdue"),
    db.invoices.where("workspaceId").equals(context.workspaceId).toArray(),
  ]);
  const overdueInvoices = active(invoices).filter((invoice) => invoice.status === "overdue");
  const rows: AssistantAnswerRow[] = [
    ...overdueInvoices.map((invoice) => ({
      id: invoice.id,
      label: invoice.invoiceid,
      value: formatAssistantCurrency(invoice.totalAmount || 0, asCurrency(invoice.settlementCurrency, context.defaultCurrency), context.iqdDisplayPreference),
      detail: "Invoice overdue",
      routePath: "/invoices-history",
    })),
    ...obligations.slice(0, 8).map((obligation) => ({
      id: obligation.id,
      label: obligation.title,
      value: formatAssistantCurrency(obligation.amount, asCurrency(obligation.currency, context.defaultCurrency), context.iqdDisplayPreference),
      detail: obligation.counterpartyName || "Overdue",
      routePath: obligation.routePath,
    })),
  ];

  if (rows.length === 0) return noData(detection, "Overdue invoices", "/payments");

  return answerBase(
    detection,
    "answered",
    "Overdue invoices",
    `${rows.length} overdue item${rows.length === 1 ? "" : "s"} found.`,
    {
      rows,
      routePath: "/payments",
    },
  );
}

function paymentLabel(transaction: PaymentTransaction) {
  return transaction.referenceLabel || transaction.counterpartyName || transaction.sourceType.replace(/_/g, " ");
}

function paymentRoute(transaction: PaymentTransaction) {
  return getPaymentTransactionRoutePath(transaction);
}

function salePaymentMethod(sale: Sale) {
  return sale.payment_method || "unknown";
}

async function loadLedgerEntries(context: AssistantAnswerContext) {
  const [salesRows, transactions] = await Promise.all([
    db.sales.where("workspaceId").equals(context.workspaceId).toArray(),
    db.payment_transactions.where("workspaceId").equals(context.workspaceId).toArray(),
  ]);
  const reversedIds = new Set(
    transactions
      .filter((transaction) => !!transaction.reversalOfTransactionId)
      .map((transaction) => transaction.reversalOfTransactionId as string),
  );
  const rows: AssistantLedgerEntry[] = [];

  active(salesRows)
    .filter((sale) =>
      (sale.origin === "pos" || sale.origin === "instant_pos")
      && !sale.isReturned
      && salePaymentMethod(sale) !== "loan",
    )
    .forEach((sale) => {
      rows.push({
        id: `sale:${sale.id}`,
        date: sale.createdAt,
        direction: "incoming",
        amount: sale.totalAmount || 0,
        currency: asCurrency(sale.settlementCurrency, context.defaultCurrency),
        paymentMethod: salePaymentMethod(sale),
        partner: null,
        label: sale.sequenceId ? `POS-${sale.sequenceId}` : `POS-${sale.id.slice(0, 8).toUpperCase()}`,
        detail: sale.notes,
        routePath: "/sales",
      });
    });

  active(transactions)
    .filter((transaction) =>
      !transaction.reversalOfTransactionId
      && !reversedIds.has(transaction.id)
      && transaction.paymentMethod !== "loan"
      && transaction.paymentMethod !== "loan_adjustment",
    )
    .forEach((transaction) => {
      rows.push({
        id: `payment:${transaction.id}`,
        date: transaction.paidAt,
        direction: transaction.direction,
        amount: transaction.amount || 0,
        currency: asCurrency(transaction.currency, context.defaultCurrency),
        paymentMethod: transaction.paymentMethod || "unknown",
        partner: transaction.counterpartyName || null,
        label: paymentLabel(transaction),
        detail: transaction.note,
        routePath: paymentRoute(transaction),
      });
    });

  return rows.sort((left, right) => right.date.localeCompare(left.date));
}

function ledgerTotals(entries: AssistantLedgerEntry[]) {
  const amounts: AmountMap = {};
  entries.forEach((entry) => addAmount(amounts, entry.currency, entry.amount));
  return amounts;
}

async function answerLedgerSum(
  detection: AssistantDetection,
  context: AssistantAnswerContext,
  direction: "incoming" | "outgoing",
  paymentMethod?: string,
) {
  const range = getAssistantDateRange("today", context.now);
  const entries = (await loadLedgerEntries(context))
    .filter((entry) =>
      entry.direction === direction
      && isWithinAssistantRange(entry.date, range)
      && (!paymentMethod || entry.paymentMethod === paymentMethod),
    );
  const amounts = ledgerTotals(entries);
  if (entries.length === 0) return noData(detection, "Ledger", "/ledger");

  return answerBase(
    detection,
    "answered",
    direction === "incoming" ? "Money in" : "Money out",
    `${direction === "incoming" ? "Incoming" : "Outgoing"} money today is ${formatAmountMap(amounts, context)}.`,
    {
      metrics: [
        { label: "Entries", value: formatAssistantNumber(entries.length) },
        metricFromAmount("Total", amounts, context, direction === "incoming" ? "positive" : "negative"),
      ],
      rows: entries.slice(0, 8).map((entry) => ({
        id: entry.id,
        label: entry.label,
        value: formatAssistantCurrency(entry.amount, entry.currency, context.iqdDisplayPreference),
        detail: entry.partner || entry.paymentMethod,
        routePath: entry.routePath,
      })),
      routePath: "/ledger",
    },
  );
}

async function answerTodayLedger(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("today", context.now);
  const entries = (await loadLedgerEntries(context)).filter((entry) => isWithinAssistantRange(entry.date, range));
  if (entries.length === 0) return noData(detection, "Today's ledger", "/ledger");
  const incoming = ledgerTotals(entries.filter((entry) => entry.direction === "incoming"));
  const outgoing = ledgerTotals(entries.filter((entry) => entry.direction === "outgoing"));

  return answerBase(
    detection,
    "answered",
    "Today's ledger",
    `${entries.length} ledger entr${entries.length === 1 ? "y" : "ies"} found today.`,
    {
      metrics: [
        metricFromAmount("In", incoming, context, "positive"),
        metricFromAmount("Out", outgoing, context, "negative"),
      ],
      rows: entries.slice(0, 10).map((entry) => ({
        id: entry.id,
        label: entry.label,
        value: `${entry.direction === "incoming" ? "+" : "-"} ${formatAssistantCurrency(entry.amount, entry.currency, context.iqdDisplayPreference)}`,
        detail: entry.partner || entry.paymentMethod,
        routePath: entry.routePath,
      })),
      routePath: "/ledger",
    },
  );
}

async function answerPartyTransactions(detection: AssistantDetection, context: AssistantAnswerContext) {
  const entity = detection.entity?.trim();
  if (!entity) {
    return answerBase(
      detection,
      "needs_clarification",
      "Which customer or vendor?",
      "Type a name, for example: transactions for Ali Company.",
      { routePath: "/ledger" },
    );
  }

  const normalizedEntity = normalizeAssistantQuery(entity);
  const entries = (await loadLedgerEntries(context))
    .filter((entry) => normalizeAssistantQuery(entry.partner || entry.label).includes(normalizedEntity))
    .slice(0, 12);

  if (entries.length === 0) return noData(detection, `Transactions for ${entity}`, "/ledger");

  return answerBase(
    detection,
    "answered",
    `Transactions for ${entity}`,
    `${entries.length} matching ledger entr${entries.length === 1 ? "y" : "ies"} found.`,
    {
      rows: entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        value: `${entry.direction === "incoming" ? "+" : "-"} ${formatAssistantCurrency(entry.amount, entry.currency, context.iqdDisplayPreference)}`,
        detail: formatDate(entry.date),
        routePath: entry.routePath,
      })),
      routePath: "/ledger",
    },
  );
}

async function answerLedgerByPaymentMethod(detection: AssistantDetection, context: AssistantAnswerContext) {
  const range = getAssistantDateRange("this_month", context.now);
  const entries = (await loadLedgerEntries(context)).filter((entry) => isWithinAssistantRange(entry.date, range));
  const grouped = new Map<string, { incoming: AmountMap; outgoing: AmountMap; count: number }>();

  entries.forEach((entry) => {
    const key = entry.paymentMethod || "unknown";
    const group = grouped.get(key) ?? { incoming: {}, outgoing: {}, count: 0 };
    addAmount(entry.direction === "incoming" ? group.incoming : group.outgoing, entry.currency, entry.amount);
    group.count += 1;
    grouped.set(key, group);
  });

  const rows = Array.from(grouped.entries()).sort(([, a], [, b]) => b.count - a.count);
  if (rows.length === 0) return noData(detection, "Ledger by payment method", "/ledger");

  return answerBase(
    detection,
    "answered",
    "Ledger by payment method",
    "Ledger movement this month grouped by payment method.",
    {
      rows: rows.map(([method, group]) => ({
        id: method,
        label: method.replace(/_/g, " "),
        value: `In ${formatAmountMap(group.incoming, context)}`,
        detail: `Out ${formatAmountMap(group.outgoing, context)} | ${group.count} entries`,
        routePath: "/ledger",
      })),
      routePath: "/ledger",
    },
  );
}

async function answerMonthComparison(detection: AssistantDetection, context: AssistantAnswerContext) {
  const currentRange = getAssistantDateRange("this_month", context.now);
  const previousRange = getAssistantDateRange("last_month", context.now);
  const records = await loadRevenueRecords(context);
  const current = revenueTotalsByCurrency(filterRecords(records, currentRange), context.defaultCurrency);
  const previous = revenueTotalsByCurrency(filterRecords(records, previousRange), context.defaultCurrency);
  const currentRevenue = defaultCurrencyTotal(current.revenue, context) ?? 0;
  const previousRevenue = defaultCurrencyTotal(previous.revenue, context) ?? 0;
  const change = previousRevenue === 0
    ? (currentRevenue > 0 ? 100 : 0)
    : ((currentRevenue - previousRevenue) / previousRevenue) * 100;

  return answerBase(
    detection,
    "answered",
    "Month comparison",
    `This month is ${formatPercentChange(change)} versus last month.`,
    {
      metrics: [
        metricFromAmount("This month", current.revenue, context),
        metricFromAmount("Last month", previous.revenue, context),
        { label: "Change", value: formatPercentChange(change), tone: change >= 0 ? "positive" : "negative" },
      ],
      routePath: "/revenue",
    },
  );
}

async function answerByIntent(
  detection: AssistantDetection,
  context: AssistantAnswerContext,
  intentId: AssistantIntentId,
) {
  switch (intentId) {
    case "revenue.thisMonth":
      return answerRevenue(detection, context, "this_month");
    case "revenue.today":
      return answerRevenue(detection, context, "today");
    case "revenue.thisYear":
      return answerRevenue(detection, context, "this_year");
    case "expenses.thisMonth":
      return answerExpensesThisMonth(detection, context);
    case "profit.thisMonth":
      return answerProfitThisMonth(detection, context);
    case "sales.countToday":
      return answerSalesCountToday(detection, context);
    case "invoices.unpaid":
      return answerUnpaidInvoices(detection, context);
    case "receivables.total":
      return answerObligationTotal(detection, context, "incoming");
    case "payables.total":
      return answerObligationTotal(detection, context, "outgoing");
    case "customers.topThisMonth":
      return answerTopCustomers(detection, context);
    case "products.bestSellingThisMonth":
      return answerBestSellingProducts(detection, context);
    case "stock.low":
      return answerLowStock(detection, context);
    case "stock.value":
      return answerStockValue(detection, context);
    case "sales.byDayThisMonth":
      return answerSalesByDay(detection, context);
    case "sales.byBranchThisMonth":
      return answerSalesByBranch(detection, context);
    case "purchases.thisMonth":
      return answerPurchasesThisMonth(detection, context);
    case "invoices.overdue":
      return answerOverdueInvoices(detection, context);
    case "ledger.cashReceivedToday":
      return answerLedgerSum(detection, context, "incoming", "cash");
    case "ledger.paidToday":
      return answerLedgerSum(detection, context, "outgoing");
    case "metrics.compareMonth":
      return answerMonthComparison(detection, context);
    case "ledger.today":
      return answerTodayLedger(detection, context);
    case "ledger.moneyInToday":
      return answerLedgerSum(detection, context, "incoming");
    case "ledger.moneyOutToday":
      return answerLedgerSum(detection, context, "outgoing");
    case "ledger.partyTransactions":
      return answerPartyTransactions(detection, context);
    case "ledger.byPaymentMethodThisMonth":
      return answerLedgerByPaymentMethod(detection, context);
    default:
      return answerBase(detection, "unsupported", "Unsupported", "This question is not supported yet.");
  }
}

export async function answerAssistantQuery(
  query: string,
  context: AssistantAnswerContext,
): Promise<AssistantAnswer> {
  const detection = detectAssistantIntent(query);
  if (!detection.intentId) {
    return answerBase(
      detection,
      "unsupported",
      localizeAssistantText(detection.language, {
        en: "Unsupported question",
        ar: "سؤال غير مدعوم",
        ku: "پرسیاری پشتگیری نەکراو",
      }),
      localizeAssistantText(detection.language, {
        en: "I can answer the first 25 local Atlas reporting questions. Try: revenue this month, low stock, or today's ledger.",
        ar: "يمكنني الإجابة على أول 25 سؤال تقريري محلي في Atlas. جرب: إيرادات هذا الشهر، المخزون المنخفض، أو دفتر اليوم.",
        ku: "دەتوانم وەڵامی 25 پرسیاری یەکەمی ڕاپۆرتی ناوخۆی Atlas بدەمەوە. نموونە: داهاتی ئەم مانگە، کۆگای کەم، یان لەجەری ئەمڕۆ.",
      }),
      { confidence: detection.confidence },
    );
  }

  const entry = getAssistantCatalogEntry(detection.intentId);
  if (!entry) {
    return answerBase(detection, "unsupported", "Unsupported question", "This question is not supported yet.");
  }

  if (entry.requiredFeature && !context.hasFeature(entry.requiredFeature)) {
    return answerBase(
      detection,
      "no_access",
      "Module disabled",
      `${entry.module} is not enabled for this workspace.`,
    );
  }

  const missingPermission = entry.requiredPermissions?.find((permission) => !context.hasPermission(permission));
  if (missingPermission) {
    return answerBase(
      detection,
      "no_access",
      "No access",
      `You do not have permission to access ${entry.module}.`,
    );
  }

  try {
    return await answerByIntent(detection, context, detection.intentId);
  } catch (error) {
    console.error("[AtlasAssistant] Failed to answer query", error);
    return answerBase(
      detection,
      "error",
      "Assistant error",
      error instanceof Error ? error.message : "The assistant could not answer this question.",
    );
  }
}

export type { AssistantLedgerEntry };
