import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  formatCurrency: (amount: number, currency: string) =>
    `${amount} ${currency.toUpperCase()}`,
  formatDate: (value: string) => value,
  formatDateTime: (value: string) => value,
}));

vi.mock("@/services/platformService", () => ({
  platformService: { convertFileSrc: (path: string) => path },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: {
      getFixedT: () => (key: string, options?: { number?: number }) =>
        key === "installmentSales.print.installmentNumber"
          ? `Installment #${options?.number}`
          : key,
    },
  }),
}));

vi.mock("@lglab/react-qr-code", () => ({
  ReactQRCode: () => null,
}));

vi.mock("@/ui/components/print/HideablePrintFieldCard", () => ({
  HideablePrintFieldCard: ({
    title,
    fields,
  }: {
    title: string;
    fields: Array<{ key: string; value?: string }>;
  }) => (
    <div>
      {title}
      {fields.map((field) => (
        <span key={field.key}>{field.value}</span>
      ))}
    </div>
  ),
}));

import { InstallmentSalePrintTemplate } from "./InstallmentSalePrintTemplate";

const sale = {
  id: "sale-1",
  saleNo: "IS-0001",
  customerNameSnapshot: "Sample Customer",
  description: "A product sold by installment",
  currency: "iqd",
  acquisitionCost: 1_000_000,
  totalSalePrice: 1_500_000,
  grossProfit: 500_000,
  downPaymentAmount: 100_000,
  customerPaidAmount: 500_000,
  customerBalanceAmount: 1_000_000,
  installmentCount: 27,
  hasInstallmentCount: true,
  installmentFrequency: "monthly",
  firstDueDate: "2026-10-01T09:00:00",
  nextDueDate: "2026-11-01T09:00:00",
  status: "active",
  createdAt: "2026-09-09T09:00:00.000Z",
} as any;

describe("InstallmentSalePrintTemplate", () => {
  it("uses loan-style A4 chunks for long schedules and payment activity", () => {
    const installments = Array.from({ length: 27 }, (_, index) => ({
      id: `installment-${index + 1}`,
      installmentNo: index + 1,
      dueDate: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T09:00:00`,
      plannedAmount: 50_000,
      paidAmount: 0,
      balanceAmount: 50_000,
      status: "unpaid",
    })) as any;
    const payments = Array.from({ length: 27 }, (_, index) => ({
      id: `payment-${index + 1}`,
      installmentId: index === 0 ? null : `installment-${index}`,
      paidAt: `2026-11-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
      paymentMethod: "cash",
      amount: 10_000,
    })) as any;

    const html = renderToStaticMarkup(
      createElement(InstallmentSalePrintTemplate, {
        workspaceName: "Atlas",
        printLang: "en",
        sale,
        installments,
        payments,
        iqdPreference: "IQD",
      }),
    );

    expect(html).toContain('data-installment-sale-details-print="true"');
    expect(html).toContain('data-order-print-page="true"');
    expect(html).toContain('data-page-padding-mm="14"');
    expect(html.match(/data-pdf-page-chunk/g)).toHaveLength(6);
    expect(html.match(/data-centered-table/g)).toHaveLength(5);
    expect(html.match(/installmentSales\.print\.paymentSchedule/g)).toHaveLength(3);
    expect(html.match(/installmentSales\.print\.paymentActivity/g)).toHaveLength(3);
    expect(html.match(/Installment #/g)).toHaveLength(27);
    expect(html).toContain("Installment #27");
    expect(html).toContain("2026-11-27T10:00:00.000Z");
    expect(html).toContain("installmentSales.print.continued");
  });

  it("prints an open-balance repayment summary instead of a fictional schedule", () => {
    const html = renderToStaticMarkup(
      createElement(InstallmentSalePrintTemplate, {
        printLang: "en",
        sale: {
          ...sale,
          installmentFrequency: "no_frequency",
          hasInstallmentCount: true,
          installmentCount: 1,
          firstDueDate: null,
          nextDueDate: null,
        },
        installments: [],
        payments: [],
        iqdPreference: "IQD",
      }),
    );

    expect(html).toContain("installmentSales.repaymentSummary");
    expect(html).not.toContain("installmentSales.print.paymentSchedule");
    expect(html).toContain("installmentSales.print.paymentActivity");
    expect(html.match(/data-pdf-page-chunk/g)).toHaveLength(2);
    expect(html.match(/data-centered-table/g)).toHaveLength(1);
  });
});
