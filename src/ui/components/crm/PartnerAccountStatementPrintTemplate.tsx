import { useTranslation } from 'react-i18next'
import type { i18n as I18n } from 'i18next'

import type { IQDDisplayPreference } from '@/local-db'
import {
    buildPartnerAccountStatementLedger,
    type PartnerAccountStatementCurrencyLedger,
    type PartnerAccountStatementData,
    type PartnerAccountStatementEntryKind,
    type PartnerAccountStatementPeriod
} from '@/lib/partnerAccountStatement'
import {
    getPartnerAccountStatementEntryDescription,
    getPartnerAccountStatementEntryDetail
} from '@/lib/partnerAccountStatementPresentation'
import {
    DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION,
    getPartnerAccountStatementSummaryLabelColumn,
    getPartnerAccountStatementVisibleColumns,
    type PartnerAccountStatementColumnId
} from '@/lib/partnerAccountStatementTemplates'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'
export {
    buildPartnerAccountStatementLedger,
    type PartnerAccountStatementCurrencyLedger,
    type PartnerAccountStatementData,
    type PartnerAccountStatementEntry,
    type PartnerAccountStatementEntryKind,
    type PartnerAccountStatementPeriod
} from '@/lib/partnerAccountStatement'

export type PartnerAccountStatementPrintData = PartnerAccountStatementData & {
    tableColumns?: PartnerAccountStatementColumnId[]
    workspace?: {
        phone?: string
        address?: string
        email?: string
    }
    partner: {
        partnerName: string
        phone?: string
        address?: string
        city?: string
    }
    generatedAt: string
}

interface PartnerAccountStatementPrintTemplateProps {
    workspaceName?: string | null
    workspaceDescription?: string | null
    printLang: string
    data: PartnerAccountStatementPrintData
    iqdPreference?: IQDDisplayPreference
    logoUrl?: string | null
}

function isRTL(lang: string) {
    const baseLang = (lang || 'en').split('-')[0]
    return baseLang === 'ar' || baseLang === 'ku'
}

function resolveLogoSrc(logoUrl?: string | null) {
    if (!logoUrl) return null
    return logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)
}

function resolvePeriodLabel(
    period: PartnerAccountStatementPeriod,
    t: (key: string, options?: Record<string, unknown>) => string
) {
    if (period.start || period.end) {
        return t('businessPartners.fromDateToDate', {
            defaultValue: 'from {{start}} to {{end}}',
            start: period.start ? formatDate(period.start) : '—',
            end: period.end ? formatDate(period.end) : '—'
        })
    }
    return t('performance.filters.allTime', { defaultValue: 'All Time' })
}

function entryLabel(kind: PartnerAccountStatementEntryKind, t: (key: string, options?: Record<string, unknown>) => string) {
    const labels: Record<PartnerAccountStatementEntryKind, string> = {
        sales_order: t('orders.tabs.sales', { defaultValue: 'Sales Order' }),
        sales_order_return: t('businessPartners.accountStatement.salesOrderReturn', { defaultValue: 'Sales order return' }),
        purchase_order: t('orders.tabs.purchase', { defaultValue: 'Purchase Order' }),
        incoming_payment: t('businessPartners.accountStatement.paymentReceived', { defaultValue: 'Payment received' }),
        outgoing_payment: t('businessPartners.accountStatement.paymentMade', { defaultValue: 'Payment made' }),
        direct_transaction: t('ledger.type.direct_transaction', { defaultValue: 'Direct Transaction' }),
        loan_disbursal: t('businessPartners.accountStatement.loanMovement', { defaultValue: 'Loan movement' }),
        loan_repayment: t('businessPartners.accountStatement.loanRepayment', { defaultValue: 'Loan repayment' }),
        pos_sale_loan: t('loans.posSaleLoan', { defaultValue: 'POS Sale Loan' }),
        pos_sale_installment_loan: t('loans.posSaleInstallmentLoan', { defaultValue: 'POS Sale Installment Loan' }),
        agent_commission: t('salesAgentCommissions.title', { defaultValue: 'Sales agent commission' }),
        delivery_post: t('postService.title', { defaultValue: 'Post Service' }),
        installment_sale: t('businessPartners.accountStatement.installmentSale', { defaultValue: 'Installment sale' })
    }
    return labels[kind]
}

function balanceLabel(balance: number, t: (key: string, options?: Record<string, unknown>) => string) {
    if (balance > 0.000001) return t('businessPartners.accountStatement.dueFromPartner', { defaultValue: 'Due from partner' })
    if (balance < -0.000001) return t('businessPartners.accountStatement.dueToPartner', { defaultValue: 'Due to partner' })
    return t('businessPartners.accountStatement.settled', { defaultValue: 'Settled' })
}

function balanceClass(balance: number) {
    if (balance > 0.000001) return 'text-emerald-600'
    if (balance < -0.000001) return 'text-yellow-500'
    return ''
}

function formatStatementQuantity(quantity: number | null | undefined, unit: string | null | undefined, language: string) {
    if (quantity === null || quantity === undefined) return '—'
    const value = new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(quantity)
    return unit ? `${value} ${unit}` : value
}

// Keep the same fixed-table pagination model as Atlas Standard: the first
// table stays in document flow, while every continuation table is marked for
// the shared A4 centering pass used by preview and PDF generation.
// A statement row can grow substantially when a reference or description
// wraps. Keep the chunk deliberately conservative so every table—including a
// page with several long order-return references—fits inside a real A4 page.
// Do not pad a short final chunk with blank rows: pagination is controlled by
// the chunk size and shared centering pass, not artificial table height.
const PARTNER_STATEMENT_TABLE_ROW_HEIGHT_MM = 12
const PARTNER_STATEMENT_MAX_ROWS_PER_TABLE = 12

type LedgerEntry = PartnerAccountStatementCurrencyLedger['entries'][number]

function chunkLedgerEntries(entries: LedgerEntry[]) {
    if (entries.length === 0) return [[]] as LedgerEntry[][]

    const chunks: LedgerEntry[][] = []
    for (let index = 0; index < entries.length; index += PARTNER_STATEMENT_MAX_ROWS_PER_TABLE) {
        chunks.push(entries.slice(index, index + PARTNER_STATEMENT_MAX_ROWS_PER_TABLE))
    }
    return chunks
}

function LedgerTableChunk({
    ledger,
    entries,
    isFirst,
    isLast,
    centerOnPage,
    showTableHeading,
    t,
    i18n,
    language,
    columns,
    iqdPreference
}: {
    ledger: PartnerAccountStatementCurrencyLedger
    entries: LedgerEntry[]
    isFirst: boolean
    isLast: boolean
    centerOnPage: boolean
    showTableHeading: boolean
    t: (key: string, options?: Record<string, unknown>) => string
    i18n: I18n
    language: string
    columns: PartnerAccountStatementColumnId[]
    iqdPreference: IQDDisplayPreference
}) {
    const displayAmount = (amount: number) => formatCurrency(Math.abs(amount), ledger.currency, iqdPreference)
    const summaryLabelColumn = getPartnerAccountStatementSummaryLabelColumn(columns)
    const summaryValue = (columnId: PartnerAccountStatementColumnId, kind: 'opening' | 'total') => {
        if (columnId === 'debit') return kind === 'opening'
            ? ledger.openingBalance > 0 ? displayAmount(ledger.openingBalance) : '—'
            : displayAmount(ledger.debitTotal)
        if (columnId === 'credit') return kind === 'opening'
            ? ledger.openingBalance < 0 ? displayAmount(ledger.openingBalance) : '—'
            : displayAmount(ledger.creditTotal)
        if (columnId === 'balance') return displayAmount(kind === 'opening' ? ledger.openingBalance : ledger.closingBalance)
        if (columnId === 'totalProductCommission' && kind === 'total') return displayAmount(ledger.productCommissionTotal)
        return null
    }
    const headerLabel = (columnId: PartnerAccountStatementColumnId) => {
        const labels: Record<PartnerAccountStatementColumnId, [string, string]> = {
            date: ['common.date', 'Date'],
            reference: ['common.reference', 'Reference'],
            type: ['common.type', 'Type'],
            description: ['common.description', 'Description'],
            item: ['businessPartners.accountStatement.item', 'Item'],
            quantity: ['businessPartners.accountStatement.quantity', 'Quantity'],
            commissionPerProduct: ['salesAgentCommissions.productCommission.perUnit', 'Product commission / unit'],
            totalProductCommission: ['salesAgentCommissions.productCommission.lineTotal', 'Total product commission'],
            debit: ['businessPartners.accountStatement.debit', 'Debit'],
            credit: ['businessPartners.accountStatement.credit', 'Credit'],
            balance: ['businessPartners.accountStatement.balance', 'Balance']
        }
        const [key, defaultValue] = labels[columnId]
        return t(key, { defaultValue })
    }
    const numericColumn = (columnId: PartnerAccountStatementColumnId) => [
        'quantity',
        'commissionPerProduct',
        'totalProductCommission',
        'debit',
        'credit',
        'balance'
    ].includes(columnId)

    return (
        <table
            data-pdf-page-chunk
            data-centered-table={centerOnPage ? '' : undefined}
            className="mt-2 w-full table-fixed border-collapse text-[9px]"
        >
            <thead>
                {showTableHeading ? (
                    <tr className="bg-slate-50">
                        <th className="border border-slate-400 px-1.5 py-1 text-start text-[10px] font-bold" colSpan={columns.length}>
                            {t('businessPartners.accountStatement.accountActivity', { defaultValue: 'Account Activity' })} · {ledger.currency.toUpperCase()} {!isFirst ? t('businessPartners.accountStatement.continued', { defaultValue: '(continued)' }) : null}
                        </th>
                    </tr>
                ) : null}
                <tr className="bg-slate-200 font-bold uppercase">
                    {columns.map((columnId) => (
                        <th key={columnId} className={cn(
                            'border border-slate-400 px-1.5 py-1',
                            numericColumn(columnId) ? 'text-end' : 'text-start',
                            columnId === 'date' && 'w-[10%]',
                            columnId === 'reference' && 'w-[14%]',
                            columnId === 'type' && 'w-[12%]',
                            columnId === 'description' && 'w-[18%]',
                            columnId === 'item' && 'w-[14%]',
                            (columnId === 'commissionPerProduct' || columnId === 'totalProductCommission') && 'w-[11%]'
                        )}>{headerLabel(columnId)}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {isFirst && Math.abs(ledger.openingBalance) > 0.000001 ? (
                    <tr className="bg-slate-50 font-semibold" data-pdf-keep-together style={{ height: `${PARTNER_STATEMENT_TABLE_ROW_HEIGHT_MM}mm` }}>
                        {columns.map((columnId) => {
                            const value = summaryValue(columnId, 'opening')
                            const isLabel = columnId === summaryLabelColumn
                            return <td key={columnId} className={cn(
                                'border border-slate-300 px-1.5 py-1',
                                numericColumn(columnId) && 'text-end',
                                columnId === 'balance' && balanceClass(ledger.openingBalance)
                            )}>{isLabel && value ? <span className="flex items-center justify-between gap-2"><span>{t('businessPartners.accountStatement.openingBalance', { defaultValue: 'Opening balance' })}</span><span>{value}</span></span> : isLabel ? t('businessPartners.accountStatement.openingBalance', { defaultValue: 'Opening balance' }) : value || null}</td>
                        })}
                    </tr>
                ) : null}
                {entries.length === 0 ? (
                    <tr style={{ height: `${PARTNER_STATEMENT_TABLE_ROW_HEIGHT_MM}mm` }}>
                        <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={columns.length}>
                            {t('businessPartners.noActivity', { defaultValue: 'No related activity yet.' })}
                        </td>
                    </tr>
                ) : entries.map((entry) => {
                    const description = getPartnerAccountStatementEntryDescription(entry, t)
                    const detail = getPartnerAccountStatementEntryDetail(entry, { t, i18n, language })
                    return (
                        <tr key={entry.id} data-pdf-keep-together style={{ height: `${PARTNER_STATEMENT_TABLE_ROW_HEIGHT_MM}mm` }}>
                            {columns.map((columnId) => {
                                switch (columnId) {
                                    case 'date':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 align-top whitespace-nowrap">{formatDate(entry.date)}</td>
                                    case 'reference':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 align-top font-semibold break-words">{entry.reference}</td>
                                    case 'type':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 align-top">{entryLabel(entry.kind, t)}</td>
                                    case 'description':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 align-top whitespace-pre-wrap"><div>{description}</div>{detail ? <div className="mt-0.5 text-[8px] text-slate-600">{detail}</div> : null}</td>
                                    case 'item':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 align-top whitespace-pre-wrap">{entry.itemName || '—'}</td>
                                    case 'quantity':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 text-end align-top whitespace-nowrap">{formatStatementQuantity(entry.quantity, entry.unit, language)}</td>
                                    case 'commissionPerProduct':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 text-end align-top whitespace-nowrap">{entry.commissionPerProduct == null ? '—' : displayAmount(entry.commissionPerProduct)}</td>
                                    case 'totalProductCommission':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 text-end align-top whitespace-nowrap">{entry.totalProductCommission == null ? '—' : displayAmount(entry.totalProductCommission)}</td>
                                    case 'debit':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 text-end align-top font-semibold whitespace-nowrap">{entry.delta > 0 ? displayAmount(entry.delta) : '—'}</td>
                                    case 'credit':
                                        return <td key={columnId} className="border border-slate-300 px-1.5 py-1 text-end align-top font-semibold whitespace-nowrap">{entry.delta < 0 ? displayAmount(entry.delta) : '—'}</td>
                                    case 'balance':
                                        return <td key={columnId} className={cn('border border-slate-300 px-1.5 py-1 text-end align-top font-bold whitespace-nowrap', balanceClass(entry.runningBalance))}>{displayAmount(entry.runningBalance)}</td>
                                }
                            })}
                        </tr>
                    )
                })}
            </tbody>
            {isLast ? (
                <tfoot>
                    <tr className="bg-slate-100 font-bold" style={{ height: `${PARTNER_STATEMENT_TABLE_ROW_HEIGHT_MM}mm` }}>
                        {columns.map((columnId) => {
                            const value = summaryValue(columnId, 'total')
                            const isLabel = columnId === summaryLabelColumn
                            return <td key={columnId} className={cn(
                                'border border-slate-400 px-1.5 py-1.5',
                                numericColumn(columnId) && 'text-end whitespace-nowrap',
                                columnId === 'balance' && balanceClass(ledger.closingBalance)
                            )}>{isLabel && value ? <span className="flex items-center justify-between gap-2"><span>{t('common.total', { defaultValue: 'Total' })}</span><span>{value}</span></span> : isLabel ? t('common.total', { defaultValue: 'Total' }) : value || null}</td>
                        })}
                    </tr>
                </tfoot>
            ) : null}
        </table>
    )
}

function LedgerTable({
    ledger,
    isFirstLedger,
    t,
    i18n,
    language,
    columns,
    iqdPreference
}: {
    ledger: PartnerAccountStatementCurrencyLedger
    isFirstLedger: boolean
    t: (key: string, options?: Record<string, unknown>) => string
    i18n: I18n
    language: string
    columns: PartnerAccountStatementColumnId[]
    iqdPreference: IQDDisplayPreference
}) {
    const displayAmount = (amount: number) => formatCurrency(Math.abs(amount), ledger.currency, iqdPreference)
    const entryChunks = chunkLedgerEntries(ledger.entries)

    return (
        <section className="mt-5" data-partner-account-statement-section>
            {isFirstLedger ? (
                <div className="flex items-center justify-between gap-3 border-b-2 border-slate-800 pb-1.5">
                    <h2 className="text-[12px] font-bold">
                        {t('businessPartners.accountStatement.accountActivity', { defaultValue: 'Account Activity' })}
                    </h2>
                    <span className="rounded border border-slate-400 px-2 py-0.5 text-[10px] font-bold uppercase">
                        {ledger.currency.toUpperCase()}
                    </span>
                </div>
            ) : null}
            {entryChunks.map((entries, index) => (
                <LedgerTableChunk
                    key={`${ledger.currency}-${index}`}
                    ledger={ledger}
                    entries={entries}
                    isFirst={index === 0}
                    isLast={index === entryChunks.length - 1}
                    centerOnPage={!isFirstLedger || index > 0}
                    showTableHeading={!isFirstLedger || index > 0}
                    t={t}
                    i18n={i18n}
                    language={language}
                    columns={columns}
                    iqdPreference={iqdPreference}
                />
            ))}
            <div className="mt-1 text-end text-[9px] font-semibold">
                {balanceLabel(ledger.closingBalance, t)}:{' '}
                <span className={balanceClass(ledger.closingBalance)}>{displayAmount(ledger.closingBalance)}</span>
            </div>
        </section>
    )
}

export function PartnerAccountStatementPrintTemplate({
    workspaceName,
    workspaceDescription,
    printLang,
    data,
    iqdPreference = 'IQD',
    logoUrl
}: PartnerAccountStatementPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const isRtl = isRTL(printLang)
    const showItemColumns = data.itemizeSalesOrders === true || data.itemizePosSaleLoans === true
    const showProductCommissionColumns = data.isAgentCommissionStatement === true
    const columns = data.tableColumns && data.tableColumns.length > 0
        ? data.tableColumns
        : getPartnerAccountStatementVisibleColumns(DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION, {
            showItemColumns,
            showProductCommissionColumns
        })
    const logoSrc = resolveLogoSrc(logoUrl)
    const ledgers = buildPartnerAccountStatementLedger(data)
    const partnerAddress = [data.partner.address, data.partner.city].filter(Boolean).join(', ')
    const periodLabel = resolvePeriodLabel(data.period, t)
    const businessName = workspaceName?.trim() || t('businessPartners.ourBusiness', { defaultValue: 'Our business' })

    return (
        <div
            dir={isRtl ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '210mm' }}
            data-partner-account-statement-print
            data-order-print-page
            data-page-width-mm="210"
            data-page-padding-mm="9"
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; }
    [data-partner-account-statement-print] tr,
    [data-partner-account-statement-print] [data-pdf-keep-together] { break-inside: avoid; page-break-inside: avoid; }
    [data-partner-account-statement-print] thead { display: table-header-group; }
}
`
                }}
            />
            <section className="bg-white" style={{ minHeight: '297mm', padding: '9mm', boxSizing: 'border-box' }}>
                <header className="grid grid-cols-[1fr_1.55fr] gap-4 border-b-2 border-slate-800 pb-4" data-pdf-keep-together>
                    <div className="flex min-h-[31mm] items-center justify-center border-e border-slate-400 pe-4">
                        {logoSrc ? (
                            <img src={logoSrc} alt="" className="max-h-[28mm] max-w-[60mm] object-contain" />
                        ) : (
                            <div className="text-center text-[15px] font-bold">{businessName}</div>
                        )}
                    </div>
                    <div className="min-w-0 text-[10px] leading-relaxed">
                        <h1 className="text-[17px] font-bold">{t('businessPartners.accountStatement.title', { defaultValue: 'Partner Account Statement' })}</h1>
                        <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
                            <span className="font-bold">{t('businessPartners.accountStatement.period', { defaultValue: 'Period' })}:</span>
                            <strong>{periodLabel}</strong>
                            <span className="font-bold">{t('businessPartners.accountStatement.printed', { defaultValue: 'Printed' })}:</span>
                            <span>{formatDateTime(data.generatedAt)}</span>
                            <span className="font-bold">{t('businessPartners.accountStatement.partner', { defaultValue: 'Partner' })}:</span>
                            <strong>{data.partner.partnerName}</strong>
                        </div>
                    </div>
                </header>

                <div className="mt-3 grid grid-cols-3 gap-3 border-b border-slate-300 pb-3 text-[10px]" data-pdf-keep-together>
                    <div><span className="font-bold">{t('businessPartners.accountStatement.business', { defaultValue: 'Business' })}: </span>{businessName}</div>
                    <div><span className="font-bold">{t('businessPartners.accountStatement.contact', { defaultValue: 'Contact' })}: </span>{data.partner.phone?.trim() || '—'}</div>
                    <div><span className="font-bold">{t('businessPartners.accountStatement.address', { defaultValue: 'Address' })}: </span>{partnerAddress || workspaceDescription?.trim() || '—'}</div>
                </div>

                {ledgers.length === 0 ? (
                    <div className="py-16 text-center text-sm text-slate-500">
                        {t('businessPartners.noActivity', { defaultValue: 'No related activity yet.' })}
                    </div>
                ) : ledgers.map((ledger, index) => (
                    <LedgerTable
                        key={ledger.currency}
                        ledger={ledger}
                        isFirstLedger={index === 0}
                        t={t}
                        i18n={i18n}
                        language={printLang}
                        columns={columns}
                        iqdPreference={iqdPreference}
                    />
                ))}

                <footer className="mt-6 border-t border-slate-300 pt-2 text-[8px] text-slate-600" data-pdf-keep-together>
                    {t('businessPartners.accountStatement.balanceNote', {
                        defaultValue: 'Debit increases the amount due from the partner; credit decreases it. Each currency is kept on its own ledger.'
                    })}
                </footer>
            </section>
        </div>
    )
}
