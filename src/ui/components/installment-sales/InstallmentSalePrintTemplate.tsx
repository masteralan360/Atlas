import { ReactQRCode } from "@lglab/react-qr-code";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type {
  InstallmentSale,
  InstallmentSaleInstallment,
  InstallmentSalePayment,
} from "@/local-db";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { platformService } from "@/services/platformService";
import { HideablePrintFieldCard } from "@/ui/components/print/HideablePrintFieldCard";

type InstallmentSalePrintTemplateProps = {
  workspaceName?: string | null;
  printLang: string;
  sale: InstallmentSale;
  installments: InstallmentSaleInstallment[];
  payments: InstallmentSalePayment[];
  iqdPreference: Parameters<typeof formatCurrency>[2];
  logoUrl?: string | null;
  qrValue?: string;
  hideNextDue?: boolean;
  hideDueDate?: boolean;
  hiddenFields?: Record<string, boolean>;
  onHiddenFieldChange?: (key: string, hidden: boolean) => void;
};

const FIRST_TABLE_MAX_ROWS = 10;
const CONTINUATION_TABLE_MAX_ROWS = 16;
const TABLE_ROW_HEIGHT_MM = 12;

function isRTL(language: string) {
  const baseLanguage = (language || "en").split("-")[0];
  return baseLanguage === "ar" || baseLanguage === "ku";
}

function resolveLogoSrc(logoUrl?: string | null) {
  if (!logoUrl) return null;
  return logoUrl.startsWith("http")
    ? logoUrl
    : platformService.convertFileSrc(logoUrl);
}

function formatInstallmentSaleDueAt(value: string | null | undefined) {
  if (!value) return "—";
  return value.length > 10 ? formatDateTime(value) : formatDate(value);
}

function chunkSaleDetailPrintRows<T>(rows: readonly T[]): T[][] {
  if (rows.length === 0) return [[]];

  const chunks: T[][] = [];
  let start = 0;
  let capacity = FIRST_TABLE_MAX_ROWS;

  while (start < rows.length) {
    chunks.push(rows.slice(start, start + capacity));
    start += capacity;
    capacity = CONTINUATION_TABLE_MAX_ROWS;
  }

  return chunks;
}

function SalePrintHeader({
  workspaceName,
  title,
  subtitle,
  logoUrl,
  qrValue,
}: {
  workspaceName?: string | null;
  title: string;
  subtitle: ReactNode;
  logoUrl?: string | null;
  qrValue?: string;
}) {
  const logoSrc = resolveLogoSrc(logoUrl);

  return (
    <header className="mb-4 border-b border-slate-300 pb-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex w-1/3 flex-col items-start">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt=""
              className="max-h-16 max-w-full object-contain object-left"
            />
          ) : (
            <div aria-hidden className="h-10 w-40 border border-slate-200 bg-slate-50" />
          )}
        </div>
        <div className="flex w-1/3 justify-center pt-1">
          {qrValue ? (
            <div
              className="rounded border border-slate-200 bg-white p-1.5"
              data-qr-sharp="true"
            >
              <ReactQRCode value={qrValue} size={64} level="M" />
            </div>
          ) : null}
        </div>
        <div className="flex w-1/3 flex-col items-center text-center">
          <h1 className="text-xl font-bold">{workspaceName || ""}</h1>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-[11px] text-slate-600">{subtitle}</p>
        </div>
      </div>
    </header>
  );
}

export function InstallmentSalePrintTemplate({
  workspaceName,
  printLang,
  sale,
  installments,
  payments,
  iqdPreference,
  logoUrl,
  qrValue,
  hideNextDue,
  hideDueDate,
  hiddenFields,
  onHiddenFieldChange,
}: InstallmentSalePrintTemplateProps) {
  const { i18n } = useTranslation();
  const t = i18n.getFixedT(printLang);
  const isNoFrequency = sale.installmentFrequency === "no_frequency";
  const isOpenBalance = isNoFrequency || sale.hasInstallmentCount === false;
  const scheduleChunks = isOpenBalance
    ? []
    : chunkSaleDetailPrintRows(installments);
  const paymentChunks = chunkSaleDetailPrintRows(
    payments
      .slice()
      .sort((left, right) =>
        new Date(right.paidAt).getTime() - new Date(left.paidAt).getTime(),
      )
      .map((payment) => ({ payment })),
  );
  const dueDateLabel = sale.hasInstallmentCount === false
    ? t("installmentSales.firstDueDate")
    : t("installmentSales.nextDueDate");
  const dueDateValue = sale.hasInstallmentCount === false
    ? sale.firstDueDate
    : sale.nextDueDate;
  const continuedLabel = t("installmentSales.print.continued");
  const noteValue = sale.notes?.trim();

  return (
    <div
      dir={isRTL(printLang) ? "rtl" : "ltr"}
      className="bg-white text-black"
      style={{ width: "210mm" }}
      data-installment-sale-details-print
      data-order-print-page
      data-page-width-mm="210"
      data-page-padding-mm="14"
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `
@media print {
  @page { margin: 0; size: A4; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; }
  [data-installment-sale-details-print] tr,
  [data-installment-sale-details-print] [data-pdf-keep-together] { break-inside: avoid; page-break-inside: avoid; }
  [data-installment-sale-details-print] thead { display: table-header-group; }
}
`,
        }}
      />

      <section
        className="bg-white"
        style={{
          minHeight: "297mm",
          padding: "14mm 12mm",
          boxSizing: "border-box",
        }}
      >
        <SalePrintHeader
          workspaceName={workspaceName}
          title={t("installmentSales.print.documentTitle")}
          subtitle={
            <span className="flex items-center justify-center gap-1">
              <span className="text-slate-600">{sale.saleNo}</span>
              <span>•</span>
              <span>{formatDateTime(sale.createdAt)}</span>
            </span>
          }
          logoUrl={logoUrl}
          qrValue={qrValue}
        />

        <div
          className="mb-4 grid grid-cols-2 items-start gap-4 text-center text-xs"
          data-pdf-keep-together
        >
          <HideablePrintFieldCard
            title={t("installmentSales.print.customerDetails")}
            className="rounded-md border border-slate-300 p-3"
            hiddenFields={hiddenFields}
            onHiddenFieldChange={onHiddenFieldChange}
            fields={[
              {
                key: "installmentSales.identity.customer",
                label: t("installmentSales.customer"),
                value: sale.customerNameSnapshot,
                render: (
                  <p className="mb-1 text-lg font-semibold text-slate-800">
                    {sale.customerNameSnapshot}
                  </p>
                ),
              },
              {
                key: "installmentSales.identity.saleNo",
                label: t("installmentSales.saleNo"),
                value: sale.saleNo,
              },
              {
                key: "installmentSales.identity.description",
                label: t("installmentSales.description"),
                value: sale.description,
                className: "text-slate-600",
              },
            ]}
          />
          <HideablePrintFieldCard
            title={t("installmentSales.print.saleSummary")}
            className="rounded-md border border-slate-300 p-3 text-center"
            hiddenFields={hiddenFields}
            onHiddenFieldChange={onHiddenFieldChange}
            fields={[
              {
                key: "installmentSales.summary.totalSalePrice",
                label: t("installmentSales.totalSalePrice"),
                value: formatCurrency(
                  sale.totalSalePrice,
                  sale.currency,
                  iqdPreference,
                ),
              },
              {
                key: "installmentSales.summary.downPayment",
                label: t("installmentSales.downPayment"),
                value: formatCurrency(
                  sale.downPaymentAmount,
                  sale.currency,
                  iqdPreference,
                ),
              },
              {
                key: "installmentSales.summary.paid",
                label: t("installmentSales.paid"),
                value: formatCurrency(
                  sale.customerPaidAmount,
                  sale.currency,
                  iqdPreference,
                ),
              },
              {
                key: "installmentSales.summary.balance",
                label: t("installmentSales.customerReceivable"),
                value: formatCurrency(
                  sale.customerBalanceAmount,
                  sale.currency,
                  iqdPreference,
                ),
              },
              ...(!hideNextDue && !isNoFrequency
                ? [
                    {
                      key: "installmentSales.summary.nextDue",
                      label: dueDateLabel,
                      value: formatInstallmentSaleDueAt(dueDateValue),
                    },
                  ]
                : []),
              {
                key: "installmentSales.summary.status",
                label: t("installmentSales.status"),
                value: t(`installmentSales.statuses.${sale.status}`),
              },
            ]}
          />
        </div>

        <div
          className="mb-5 grid grid-cols-3 gap-3 text-center text-xs"
          data-pdf-keep-together
        >
          <div className="rounded-md border border-slate-300 p-2">
            <p className="text-slate-500">
              {t("installmentSales.acquisitionCost")}
            </p>
            <p className="font-bold">
              {formatCurrency(sale.acquisitionCost, sale.currency, iqdPreference)}
            </p>
          </div>
          <div className="rounded-md border border-slate-300 p-2">
            <p className="text-slate-500">
              {t("installmentSales.expectedGrossProfit")}
            </p>
            <p className="font-bold">
              {formatCurrency(sale.grossProfit, sale.currency, iqdPreference)}
            </p>
          </div>
          <div className="rounded-md border border-slate-300 p-2">
            <p className="text-slate-500">{t("installmentSales.frequency")}</p>
            <p className="font-bold">
              {t(`installmentSales.print.frequencyLabels.${sale.installmentFrequency}`)}
            </p>
          </div>
        </div>

        {isOpenBalance ? (
          <table
            data-pdf-page-chunk
            className="mt-5 w-full table-fixed border-collapse text-xs"
          >
            <thead>
              <tr className="bg-white">
                <th
                  className="border-x border-t border-slate-300 px-2 py-1 text-start text-sm"
                  colSpan={3}
                >
                  {t("installmentSales.repaymentSummary")}
                </th>
              </tr>
              <tr className="bg-slate-100">
                <th className="border border-slate-300 p-2 text-end">
                  {t("installmentSales.totalSalePrice")}
                </th>
                <th className="border border-slate-300 p-2 text-end">
                  {t("installmentSales.paid")}
                </th>
                <th className="border border-slate-300 p-2 text-end">
                  {t("installmentSales.customerReceivable")}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                data-pdf-keep-together
                style={{ height: `${TABLE_ROW_HEIGHT_MM}mm` }}
              >
                <td className="border border-slate-300 p-2 text-end whitespace-nowrap">
                  {formatCurrency(sale.totalSalePrice, sale.currency, iqdPreference)}
                </td>
                <td className="border border-slate-300 p-2 text-end whitespace-nowrap">
                  {formatCurrency(sale.customerPaidAmount, sale.currency, iqdPreference)}
                </td>
                <td className="border border-slate-300 p-2 text-end font-semibold whitespace-nowrap">
                  {formatCurrency(
                    sale.customerBalanceAmount,
                    sale.currency,
                    iqdPreference,
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          scheduleChunks.map((scheduleChunk, chunkIndex) => (
            <table
              key={`schedule-${chunkIndex}`}
              data-pdf-page-chunk
              data-centered-table={chunkIndex > 0 ? "" : undefined}
              className={`${chunkIndex === 0 ? "mt-5" : "mt-3"} w-full table-fixed border-collapse text-xs`}
            >
              <thead>
                <tr className="bg-white">
                  <th
                    className="border-x border-t border-slate-300 px-2 py-1 text-start text-sm"
                    colSpan={hideDueDate ? 5 : 6}
                  >
                    {t("installmentSales.print.paymentSchedule")}
                    {chunkIndex > 0 ? (
                      <span className="ms-1 text-[9px] font-normal text-slate-500">
                        {continuedLabel}
                      </span>
                    ) : null}
                  </th>
                </tr>
                <tr className="bg-slate-100">
                  <th className="w-[16%] border border-slate-300 p-2 text-start">
                    {t("installmentSales.installment")}
                  </th>
                  {!hideDueDate ? (
                    <th className="w-[18%] border border-slate-300 p-2 text-start">
                      {t("installmentSales.dueDate")}
                    </th>
                  ) : null}
                  <th className="border border-slate-300 p-2 text-end">
                    {t("installmentSales.planned")}
                  </th>
                  <th className="border border-slate-300 p-2 text-end">
                    {t("installmentSales.paid")}
                  </th>
                  <th className="border border-slate-300 p-2 text-end">
                    {t("installmentSales.balance")}
                  </th>
                  <th className="w-[15%] border border-slate-300 p-2 text-start">
                    {t("installmentSales.status")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {scheduleChunk.length === 0 ? (
                  <tr style={{ height: `${TABLE_ROW_HEIGHT_MM}mm` }}>
                    <td
                      className="border border-slate-300 p-3 text-center text-slate-500"
                      colSpan={hideDueDate ? 5 : 6}
                    >
                      {t("common.noData")}
                    </td>
                  </tr>
                ) : (
                  scheduleChunk.map((installment) => (
                    <tr
                      key={installment.id}
                      data-pdf-keep-together
                      style={{ height: `${TABLE_ROW_HEIGHT_MM}mm` }}
                    >
                      <td className="border border-slate-300 p-2">
                        {t("installmentSales.print.installmentNumber", {
                          number: installment.installmentNo,
                        })}
                      </td>
                      {!hideDueDate ? (
                        <td className="border border-slate-300 p-2 whitespace-nowrap">
                          {formatInstallmentSaleDueAt(installment.dueDate)}
                        </td>
                      ) : null}
                      <td className="border border-slate-300 p-2 text-end whitespace-nowrap">
                        {formatCurrency(
                          installment.plannedAmount,
                          sale.currency,
                          iqdPreference,
                        )}
                      </td>
                      <td className="border border-slate-300 p-2 text-end whitespace-nowrap">
                        {formatCurrency(
                          installment.paidAmount,
                          sale.currency,
                          iqdPreference,
                        )}
                      </td>
                      <td className="border border-slate-300 p-2 text-end whitespace-nowrap">
                        {formatCurrency(
                          installment.balanceAmount,
                          sale.currency,
                          iqdPreference,
                        )}
                      </td>
                      <td className="border border-slate-300 p-2">
                        {t(
                          `installmentSales.print.installmentStatuses.${installment.status}`,
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ))
        )}

        {paymentChunks.map((paymentChunk, chunkIndex) => (
          <table
            key={`activity-${chunkIndex}`}
            data-pdf-page-chunk
            data-centered-table=""
            className="mt-5 w-full table-fixed border-collapse text-xs"
          >
            <thead>
              <tr className="bg-white">
                <th
                  className="border-x border-t border-slate-300 px-2 py-1 text-start text-sm"
                  colSpan={4}
                >
                  {t("installmentSales.print.paymentActivity")}
                  {chunkIndex > 0 ? (
                    <span className="ms-1 text-[9px] font-normal text-slate-500">
                      {continuedLabel}
                    </span>
                  ) : null}
                </th>
              </tr>
              <tr className="bg-slate-100">
                <th className="w-[20%] border border-slate-300 p-2 text-start">
                  {t("common.date")}
                </th>
                <th className="w-[35%] border border-slate-300 p-2 text-start">
                  {t("installmentSales.description")}
                </th>
                <th className="w-[25%] border border-slate-300 p-2 text-start">
                  {t("installmentSales.print.paymentMethod")}
                </th>
                <th className="w-[20%] border border-slate-300 p-2 text-end">
                  {t("installmentSales.print.amount")}
                </th>
              </tr>
            </thead>
            <tbody>
              {paymentChunk.length === 0 ? (
                <tr style={{ height: `${TABLE_ROW_HEIGHT_MM}mm` }}>
                  <td
                    className="border border-slate-300 p-3 text-center text-slate-500"
                    colSpan={4}
                  >
                    {t("common.noData")}
                  </td>
                </tr>
              ) : (
                paymentChunk.map(({ payment }) => (
                  <tr
                    key={payment.id}
                    data-pdf-keep-together
                    style={{ height: `${TABLE_ROW_HEIGHT_MM}mm` }}
                  >
                    <td className="border border-slate-300 p-2 whitespace-nowrap">
                      {formatDateTime(payment.paidAt)}
                    </td>
                    <td className="border border-slate-300 p-2">
                      {payment.note?.trim() || (
                        payment.installmentId
                          ? t("installmentSales.print.installmentCollection")
                          : t("installmentSales.downPayment")
                      )}
                    </td>
                    <td className="border border-slate-300 p-2">
                      {t(
                        `installmentSales.print.paymentMethods.${payment.paymentMethod}`,
                      )}
                    </td>
                    <td className="border border-slate-300 p-2 text-end whitespace-nowrap">
                      {formatCurrency(payment.amount, sale.currency, iqdPreference)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ))}

        {noteValue ? (
          <div className="mt-6 text-xs" data-pdf-keep-together>
            <div className="font-semibold text-slate-600">
              {t("installmentSales.print.notes")}
            </div>
            <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-slate-800">
              {noteValue}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
