import { Loan, LoanInstallment, LoanPayment, type IQDDisplayPreference } from '@/local-db'
import { getLoanLinkedPartySummary } from '@/lib/loanParties'
import type { SimpleLoanSummaryMode } from '@/lib/loanListMetrics'
import {
    getLoanCounterpartyLabel,
    getLoanDirection,
    getLoanDirectionLabel,
    getLoanIdentityTitle,
    getLoanModuleTitle,
    getLoanPaymentActivityLabel,
    getLoanScheduleAmountLabel,
    getLoanScheduleIndexLabel,
    getLoanScheduleItemLabel,
    getLoanScheduleTitle,
    getSimpleLoanModuleTitle,
    getStandardLoanModuleTitle,
    getLoanSummaryTitle,
    isSimpleLoan
} from '@/lib/loanPresentation'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import { LoanNoDisplay } from './LoanNoDisplay'
import { HideablePrintFieldCard } from '@/ui/components/print/HideablePrintFieldCard'

type LoanFilter = 'all' | 'active' | 'overdue' | 'completed' | 'lent' | 'borrowed'

interface LoanListPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    loans: Loan[]
    filter: LoanFilter
    variant?: 'standard' | 'simple'
    simpleSummaryMode?: SimpleLoanSummaryMode
    displayCurrency: string
    iqdPreference?: IQDDisplayPreference
    metrics: {
        totalOutstanding?: number
        activeLoans?: number
        overdueLoans?: number
        dueToday?: number
        totalPrincipalByCurrency?: Record<string, number>
        totalPaidByCurrency?: Record<string, number>
        totalBalanceByCurrency?: Record<string, number>
        totalLentByCurrency?: Record<string, number>
        totalBorrowedByCurrency?: Record<string, number>
        activeEntries?: number
        settledEntries?: number
    }
    logoUrl?: string | null
    qrValue?: string | null
    titleOverride?: string
    subtitleOverride?: string
    notesOverride?: string
    hideNextDue?: boolean
    hiddenFields?: Record<string, boolean>
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
}

interface LoanReceiptPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    loan: Loan
    installments: LoanInstallment[]
    payments: LoanPayment[]
    iqdPreference?: IQDDisplayPreference
    logoUrl?: string | null
    qrValue?: string | null
    hideDueDate?: boolean
}

interface LoanDetailsPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    loan: Loan
    installments: LoanInstallment[]
    payments: LoanPayment[]
    iqdPreference?: IQDDisplayPreference
    logoUrl?: string | null
    qrValue?: string | null
    hideNextDue?: boolean
    hideDueDate?: boolean
    hiddenFields?: Record<string, boolean>
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
}

function isLoanOverdue(loan: Loan): boolean {
    if (loan.balanceAmount <= 0) return false
    if (loan.status === 'overdue') return true
    if (!loan.nextDueDate) return false
    return loan.nextDueDate < new Date().toISOString().slice(0, 10)
}

function isRTL(lang: string): boolean {
    const baseLang = (lang || 'en').split('-')[0]
    return baseLang === 'ar' || baseLang === 'ku'
}

function resolveLogoSrc(logoUrl?: string | null) {
    if (!logoUrl) return null
    return logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)
}

interface LoanPrintHeaderProps {
    workspaceName?: string | null
    printLang: string
    title: string
    subtitle?: React.ReactNode
    logoUrl?: string | null
    qrValue?: string | null
}

function LoanPrintHeader({
    workspaceName,
    printLang,
    title,
    subtitle,
    logoUrl,
    qrValue
}: LoanPrintHeaderProps) {
    const logoSrc = resolveLogoSrc(logoUrl)
    const isRtl = isRTL(printLang)

    return (
        <div className="border-b border-slate-300 pb-3 mb-4">
            <div className="flex items-start justify-between gap-3">
                <div className="w-1/3 flex flex-col items-start">
                    <div className="flex items-start w-full max-w-[180px]">
                        {logoSrc ? (
                            <img
                                src={logoSrc}
                                alt="Workspace Logo"
                                className="max-h-16 max-w-full object-contain object-left"
                            />
                        ) : (
                            <div className="h-10 flex items-center bg-gray-100 border border-gray-200 justify-center w-40 text-gray-400 font-bold tracking-wider uppercase">
                                LOGO
                            </div>
                        )}
                    </div>
                </div>

                <div className="w-1/3 flex justify-center pt-1">
                    {qrValue ? (
                        <div className="p-1.5 bg-white border border-slate-200 rounded" data-qr-sharp="true">
                            <ReactQRCode
                                value={qrValue}
                                size={64}
                                level="M"
                            />
                        </div>
                    ) : null}
                </div>

                <div className={`w-1/3 flex flex-col ${isRtl ? 'items-center text-center' : 'items-center text-center'}`}>
                    <h1 className="text-xl font-bold">{workspaceName || 'Atlas'}</h1>
                    <p className="text-sm font-semibold">{title}</p>
                    {subtitle ? (
                        <p className="text-[11px] text-slate-600">{subtitle}</p>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

function resolveStatusLabel(loan: Loan, t: (key: string) => string): string {
    if (isLoanOverdue(loan)) {
        return t('loans.statuses.overdue') || 'Overdue'
    }
    return t(`loans.statuses.${loan.status}`) || loan.status
}

function resolveInstallmentStatusLabel(status: LoanInstallment['status'], t: (key: string) => string): string {
    return t(`loans.installmentStatuses.${status}`) || status
}

const LOAN_DETAILS_FIRST_TABLE_MAX_ROWS = 10
const LOAN_DETAILS_CONTINUATION_TABLE_MAX_ROWS = 16
const LOAN_DETAILS_TABLE_ROW_HEIGHT_MM = 12

function chunkLoanDetailPrintRows<T>(rows: readonly T[]): T[][] {
    if (rows.length === 0) return [[]]

    const chunks: T[][] = []
    let start = 0
    let capacity = LOAN_DETAILS_FIRST_TABLE_MAX_ROWS

    while (start < rows.length) {
        chunks.push(rows.slice(start, start + capacity))
        start += capacity
        capacity = LOAN_DETAILS_CONTINUATION_TABLE_MAX_ROWS
    }

    return chunks
}

export function LoanListPrintTemplate({
    workspaceName,
    printLang,
    loans,
    filter,
    variant = 'standard',
    simpleSummaryMode = 'principal_paid',
    displayCurrency,
    iqdPreference = 'IQD',
    metrics,
    logoUrl,
    qrValue,
    titleOverride,
    subtitleOverride,
    notesOverride,
    hideNextDue,
    hiddenFields,
    onHiddenFieldChange
}: LoanListPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const isSimpleVariant = variant === 'simple'
    const counterpartyColumnLabel = isSimpleVariant || loans.some((loan) => isSimpleLoan(loan))
        ? (t('loans.counterparty') || 'Counterparty')
        : (t('loans.borrower') || 'Borrower')
    const printTitle = titleOverride || (isSimpleVariant ? getSimpleLoanModuleTitle(t) : getStandardLoanModuleTitle(t))
    const continuedLabel = t('businessPartners.accountStatement.continued', { defaultValue: '(continued)' })
    const isLegacySimpleSummary = isSimpleVariant && simpleSummaryMode === 'lent_borrowed'
    const simplePrimaryLabel = isLegacySimpleSummary
        ? t('loans.totalLent', { defaultValue: 'Total Lent' })
        : t('loans.totalPrincipal', { defaultValue: 'Total Principal' })
    const simpleSecondaryLabel = isLegacySimpleSummary
        ? t('loans.totalBorrowed', { defaultValue: 'Total Borrowed' })
        : t('loans.totalPaid', { defaultValue: 'Total Paid' })
    const simpleStatusLabel = isLegacySimpleSummary
        ? t('loans.settledEntries', { defaultValue: 'Settled Entries' })
        : t('loans.totalBalance', { defaultValue: 'Total Balance' })
    const simplePrimaryTotals = isLegacySimpleSummary
        ? metrics.totalLentByCurrency
        : metrics.totalPrincipalByCurrency
    const simpleSecondaryTotals = isLegacySimpleSummary
        ? metrics.totalBorrowedByCurrency
        : metrics.totalPaidByCurrency

    return (
        <div
            dir={isRTL(printLang) ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '210mm' }}
            data-loan-list-print
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
    [data-loan-list-print] tr,
    [data-loan-list-print] [data-pdf-keep-together] { break-inside: avoid; page-break-inside: avoid; }
    [data-loan-list-print] thead { display: table-header-group; }
}
`
                }}
            />

            <section className="bg-white" style={{ minHeight: '297mm', padding: '14mm 12mm', boxSizing: 'border-box' }}>
                <LoanPrintHeader
                    workspaceName={workspaceName}
                    printLang={printLang}
                    title={printTitle}
                    subtitle={subtitleOverride || `${t(`loans.filters.${filter}`) || filter} • ${formatDateTime(new Date().toISOString())}`}
                    logoUrl={logoUrl}
                    qrValue={qrValue}
                />

            <div className="grid grid-cols-2 items-start gap-3 mb-4 text-xs" data-pdf-keep-together>
                <HideablePrintFieldCard
                    title={isSimpleVariant
                        ? simplePrimaryLabel
                        : (t('loans.totalOutstanding') || 'Total Outstanding')}
                    className="border border-slate-300 rounded-md p-2"
                    titleClassName="text-slate-500 text-center font-normal mb-0"
                    hiddenFields={hiddenFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                    fields={[
                        {
                            key: 'loans.list.totalPrimary',
                            label: isSimpleVariant
                                ? simplePrimaryLabel
                                : (t('loans.totalOutstanding') || 'Total Outstanding'),
                            value: formatCurrency(isSimpleVariant ? 0 : (metrics.totalOutstanding || 0), displayCurrency as any, iqdPreference),
                            render: isSimpleVariant && simplePrimaryTotals && Object.keys(simplePrimaryTotals).length > 0
                                ? <div className="text-center">{Object.entries(simplePrimaryTotals).map(([curr, val]) => (
                                    <p key={curr} className="font-bold">{formatCurrency(val, curr as any, iqdPreference)}</p>
                                ))}</div>
                                : <p className="font-bold text-center">{formatCurrency(isSimpleVariant ? 0 : (metrics.totalOutstanding || 0), displayCurrency as any, iqdPreference)}</p>
                        }
                    ]}
                />
                <HideablePrintFieldCard
                    title={isSimpleVariant
                        ? simpleSecondaryLabel
                        : (t('loans.dueToday') || 'Due Today')}
                    className="border border-slate-300 rounded-md p-2"
                    titleClassName="text-slate-500 text-center font-normal mb-0"
                    hiddenFields={hiddenFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                    fields={[
                        {
                            key: 'loans.list.totalSecondary',
                            label: isSimpleVariant
                                ? simpleSecondaryLabel
                                : (t('loans.dueToday') || 'Due Today'),
                            value: formatCurrency(isSimpleVariant ? 0 : (metrics.dueToday || 0), displayCurrency as any, iqdPreference),
                            render: isSimpleVariant && simpleSecondaryTotals && Object.keys(simpleSecondaryTotals).length > 0
                                ? <div className="text-center">{Object.entries(simpleSecondaryTotals).map(([curr, val]) => (
                                    <p key={curr} className="font-bold">{formatCurrency(val, curr as any, iqdPreference)}</p>
                                ))}</div>
                                : <p className="font-bold text-center">{formatCurrency(isSimpleVariant ? 0 : (metrics.dueToday || 0), displayCurrency as any, iqdPreference)}</p>
                        }
                    ]}
                />
                <HideablePrintFieldCard
                    title={isSimpleVariant
                        ? t('loans.activeEntries', { defaultValue: 'Active Entries' })
                        : (t('loans.activeLoans') || 'Active Loans')}
                    className="border border-slate-300 rounded-md p-2"
                    titleClassName="text-slate-500 text-center font-normal mb-0"
                    hiddenFields={hiddenFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                    fields={[
                        {
                            key: 'loans.list.activeCount',
                            label: isSimpleVariant
                                ? t('loans.activeEntries', { defaultValue: 'Active Entries' })
                                : (t('loans.activeLoans') || 'Active Loans'),
                            value: isSimpleVariant ? (metrics.activeEntries || 0) : (metrics.activeLoans || 0),
                            render: <p className="font-bold text-center">{isSimpleVariant ? (metrics.activeEntries || 0) : (metrics.activeLoans || 0)}</p>
                        }
                    ]}
                />
                <HideablePrintFieldCard
                    title={isSimpleVariant
                        ? simpleStatusLabel
                        : (t('loans.overdueLoans') || 'Overdue Loans')}
                    className="border border-slate-300 rounded-md p-2"
                    titleClassName="text-slate-500 text-center font-normal mb-0"
                    hiddenFields={hiddenFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                    fields={[
                        {
                            key: 'loans.list.statusCount',
                            label: isSimpleVariant
                                ? simpleStatusLabel
                                : (t('loans.overdueLoans') || 'Overdue Loans'),
                            value: isLegacySimpleSummary
                                ? (metrics.settledEntries || 0)
                                : (isSimpleVariant ? 0 : (metrics.overdueLoans || 0)),
                            render: isLegacySimpleSummary
                                ? <p className="font-bold text-center">{metrics.settledEntries || 0}</p>
                                : isSimpleVariant && metrics.totalBalanceByCurrency && Object.keys(metrics.totalBalanceByCurrency).length > 0
                                ? <div className="text-center">{Object.entries(metrics.totalBalanceByCurrency).map(([curr, val]) => (
                                    <p key={curr} className="font-bold">{formatCurrency(val, curr as any, iqdPreference)}</p>
                                ))}</div>
                                : <p className="font-bold text-center">{isSimpleVariant ? formatCurrency(0, displayCurrency as any, iqdPreference) : (metrics.overdueLoans || 0)}</p>
                        }
                    ]}
                />
            </div>

                <table
                    data-order-items-paginated
                    data-order-items-title-text={printTitle}
                    data-order-items-continuation-label={continuedLabel}
                    className="w-full table-fixed border-collapse text-xs"
                >
                    <thead>
                        <tr className="bg-slate-100">
                            <th className="w-[19%] border border-slate-300 p-2 text-start">{t('loans.loanNo') || 'Loan No.'}</th>
                            <th className="w-[28%] border border-slate-300 p-2 text-start">{counterpartyColumnLabel}</th>
                            <th className="border border-slate-300 p-2 text-end">{t('loans.principal') || 'Principal'}</th>
                            <th className="border border-slate-300 p-2 text-end">{t('loans.paid') || 'Paid'}</th>
                            <th className="border border-slate-300 p-2 text-end">{t('loans.balance') || 'Balance'}</th>
                            {!hideNextDue && <th className="w-[10%] border border-slate-300 p-2 text-start">{t('loans.nextDue') || 'Next Due'}</th>}
                            <th className="w-[11%] border border-slate-300 p-2 text-start">{t('loans.status') || 'Status'}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {loans.length === 0 ? (
                            <tr>
                                <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={hideNextDue ? 6 : 7}>
                                    {t('common.noData') || 'No data'}
                                </td>
                            </tr>
                        ) : loans.map((loan) => (
                            <tr key={loan.id} data-pdf-keep-together>
                                <td className="border border-slate-300 p-2 font-semibold break-words">
                                    <LoanNoDisplay loanNo={loan.loanNo} plain />
                                </td>
                                <td className="border border-slate-300 p-2">
                                    <p className="font-medium">{loan.borrowerName}</p>
                                    {isSimpleLoan(loan) ? (
                                        <p className="text-[10px] font-semibold text-slate-600">
                                            {getLoanDirectionLabel(getLoanDirection(loan), t)}
                                        </p>
                                    ) : null}
                                    {getLoanLinkedPartySummary(loan, t) ? (
                                        <p className="text-[10px] font-medium text-slate-600">{getLoanLinkedPartySummary(loan, t)}</p>
                                    ) : null}
                                    <p className="text-[10px] text-slate-500">{loan.borrowerNationalId}</p>
                                </td>
                                <td className="border border-slate-300 p-2 text-end whitespace-nowrap">{formatCurrency(loan.principalAmount, loan.settlementCurrency, iqdPreference)}</td>
                                <td className="border border-slate-300 p-2 text-end whitespace-nowrap">{formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, iqdPreference)}</td>
                                <td className="border border-slate-300 p-2 text-end font-semibold whitespace-nowrap">{formatCurrency(loan.balanceAmount, loan.settlementCurrency, iqdPreference)}</td>
                                {!hideNextDue && <td className="border border-slate-300 p-2">{loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'}</td>}
                                <td className="border border-slate-300 p-2">{resolveStatusLabel(loan, t)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {notesOverride?.trim() ? (
                    <div className="mt-6 text-xs" data-pdf-keep-together>
                        <div className="font-semibold text-slate-600">{t('loans.noteLabel') || 'Note:'}</div>
                        <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-slate-800">
                            {notesOverride.trim()}
                        </div>
                    </div>
                ) : null}
            </section>
        </div>
    )
}

export function LoanDetailsPrintTemplate({
    workspaceName,
    printLang,
    loan,
    installments,
    payments,
    iqdPreference = 'IQD',
    logoUrl,
    qrValue,
    hideNextDue,
    hideDueDate,
    hiddenFields,
    onHiddenFieldChange
}: LoanDetailsPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const noteValue = loan.notes?.trim()
    const loanSummaryTitle = getLoanSummaryTitle(loan, t)
    const loanScheduleTitle = getLoanScheduleTitle(loan, t)
    const loanScheduleIndexLabel = getLoanScheduleIndexLabel(loan, t)
    const loanScheduleAmountLabel = getLoanScheduleAmountLabel(loan, t)
    const installmentChunks = chunkLoanDetailPrintRows(installments)
    const paymentChunks = chunkLoanDetailPrintRows(
        payments
            .slice()
            .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
            .map((payment, index) => ({ payment, index }))
    )
    const continuedLabel = t('businessPartners.accountStatement.continued', { defaultValue: '(continued)' })

    return (
        <div
            dir={isRTL(printLang) ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '210mm' }}
            data-loan-details-print
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
    [data-loan-details-print] tr,
    [data-loan-details-print] [data-pdf-keep-together] { break-inside: avoid; page-break-inside: avoid; }
    [data-loan-details-print] thead { display: table-header-group; }
}
`
                }}
            />

            <section className="bg-white" style={{ minHeight: '297mm', padding: '14mm 12mm', boxSizing: 'border-box' }}>
                <LoanPrintHeader
                    workspaceName={workspaceName}
                    printLang={printLang}
                    title={getLoanModuleTitle(loan, t)}
                    subtitle={
                        <span className="flex items-center justify-center gap-1">
                            <LoanNoDisplay loanNo={loan.loanNo} className="text-slate-600" plain />
                            <span>•</span>
                            <span>{formatDateTime(new Date().toISOString())}</span>
                        </span>
                    }
                    logoUrl={logoUrl}
                    qrValue={qrValue}
                />

                <div className="grid grid-cols-2 items-start gap-4 mb-4 text-xs text-center" data-pdf-keep-together>
                    <HideablePrintFieldCard
                        title={getLoanIdentityTitle(loan, t)}
                        className="border border-slate-300 rounded-md p-3"
                        hiddenFields={hiddenFields}
                        onHiddenFieldChange={onHiddenFieldChange}
                        fields={[
                            ...(getLoanLinkedPartySummary(loan, t) ? [{
                                key: 'loans.identity.linkedParty',
                                label: t('loans.linkedParty', { defaultValue: 'Linked Party' }),
                                value: getLoanLinkedPartySummary(loan, t),
                                render: <p className="mb-1 text-slate-600">{getLoanLinkedPartySummary(loan, t)}</p>
                            }] : []),
                            ...(isSimpleLoan(loan) ? [{
                                key: 'loans.identity.direction',
                                label: t('loans.direction', { defaultValue: 'Direction' }),
                                value: getLoanDirectionLabel(getLoanDirection(loan), t),
                                render: <p className="mb-1 font-semibold text-slate-700">{getLoanDirectionLabel(getLoanDirection(loan), t)}</p>
                            }] : []),
                            {
                                key: 'loans.identity.name',
                                label: getLoanCounterpartyLabel(loan, t),
                                value: loan.borrowerName
                            },
                            {
                                key: 'loans.identity.phone',
                                label: t('common.phone', { defaultValue: 'Phone' }),
                                value: loan.borrowerPhone
                            },
                            {
                                key: 'loans.identity.address',
                                label: t('common.address', { defaultValue: 'Address' }),
                                value: loan.borrowerAddress
                            },
                            {
                                key: 'loans.identity.nationalId',
                                label: t('loans.nationalId', { defaultValue: 'National ID' }),
                                value: loan.borrowerNationalId,
                                className: 'text-slate-600'
                            }
                        ]}
                    />
                    <HideablePrintFieldCard
                        title={loanSummaryTitle}
                        className="border border-slate-300 rounded-md p-3 text-center"
                        hiddenFields={hiddenFields}
                        onHiddenFieldChange={onHiddenFieldChange}
                        fields={[
                            {
                                key: 'loans.summary.principal',
                                label: t('loans.principal') || 'Principal',
                                value: formatCurrency(loan.principalAmount, loan.settlementCurrency, iqdPreference)
                            },
                            {
                                key: 'loans.summary.paid',
                                label: t('loans.paid') || 'Paid',
                                value: formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, iqdPreference)
                            },
                            {
                                key: 'loans.summary.balance',
                                label: t('loans.balance') || 'Balance',
                                value: formatCurrency(loan.balanceAmount, loan.settlementCurrency, iqdPreference)
                            },
                            ...(!hideNextDue ? [{
                                key: 'loans.summary.nextDue',
                                label: t('loans.nextDue') || 'Next Due',
                                value: loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'
                            }] : []),
                            {
                                key: 'loans.summary.status',
                                label: t('loans.status') || 'Status',
                                value: resolveStatusLabel(loan, t)
                            }
                        ]}
                    />
                </div>

                {installmentChunks.map((installmentChunk, chunkIndex) => (
                    <table
                        key={`schedule-${chunkIndex}`}
                        data-pdf-page-chunk
                        data-centered-table={chunkIndex > 0 ? '' : undefined}
                        className={`${chunkIndex === 0 ? 'mt-5' : 'mt-3'} w-full table-fixed border-collapse text-xs`}
                    >
                        <thead>
                            <tr className="bg-white">
                                <th className="border-x border-t border-slate-300 px-2 py-1 text-start text-sm" colSpan={hideDueDate ? 5 : 6}>
                                    {loanScheduleTitle}
                                    {chunkIndex > 0 ? <span className="ms-1 text-[9px] font-normal text-slate-500">{continuedLabel}</span> : null}
                                </th>
                            </tr>
                            <tr className="bg-slate-100">
                                <th className="w-[16%] border border-slate-300 p-2 text-start">{loanScheduleIndexLabel}</th>
                                {!hideDueDate && <th className="w-[16%] border border-slate-300 p-2 text-start">{t('loans.dueDate') || 'Due Date'}</th>}
                                <th className="border border-slate-300 p-2 text-end">{loanScheduleAmountLabel}</th>
                                <th className="border border-slate-300 p-2 text-end">{t('loans.paid') || 'Paid'}</th>
                                <th className="border border-slate-300 p-2 text-end">{t('loans.balance') || 'Balance'}</th>
                                <th className="w-[15%] border border-slate-300 p-2 text-start">{t('loans.status') || 'Status'}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {installmentChunk.length === 0 ? (
                                <tr style={{ height: `${LOAN_DETAILS_TABLE_ROW_HEIGHT_MM}mm` }}>
                                    <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={hideDueDate ? 5 : 6}>
                                        {t('common.noData') || 'No data'}
                                    </td>
                                </tr>
                            ) : installmentChunk.map((item) => (
                                <tr key={item.id} data-pdf-keep-together style={{ height: `${LOAN_DETAILS_TABLE_ROW_HEIGHT_MM}mm` }}>
                                    <td className="border border-slate-300 p-2">{getLoanScheduleItemLabel(loan, item.installmentNo, t)}</td>
                                    {!hideDueDate && <td className="border border-slate-300 p-2 whitespace-nowrap">{item.dueDate ? formatDate(item.dueDate) : '-'}</td>}
                                    <td className="border border-slate-300 p-2 text-end whitespace-nowrap">{formatCurrency(item.plannedAmount, loan.settlementCurrency, iqdPreference)}</td>
                                    <td className="border border-slate-300 p-2 text-end whitespace-nowrap">{formatCurrency(item.paidAmount, loan.settlementCurrency, iqdPreference)}</td>
                                    <td className="border border-slate-300 p-2 text-end whitespace-nowrap">{formatCurrency(item.balanceAmount, loan.settlementCurrency, iqdPreference)}</td>
                                    <td className="border border-slate-300 p-2">{resolveInstallmentStatusLabel(item.status, t)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ))}

                {paymentChunks.map((paymentChunk, chunkIndex) => (
                    <table
                        key={`activity-${chunkIndex}`}
                        data-pdf-page-chunk
                        data-centered-table=""
                        className="mt-5 w-full table-fixed border-collapse text-xs"
                    >
                        <thead>
                            <tr className="bg-white">
                                <th className="border-x border-t border-slate-300 px-2 py-1 text-start text-sm" colSpan={4}>
                                    {t('loans.recentActivity') || 'Recent Activity'}
                                    {chunkIndex > 0 ? <span className="ms-1 text-[9px] font-normal text-slate-500">{continuedLabel}</span> : null}
                                </th>
                            </tr>
                            <tr className="bg-slate-100">
                                <th className="w-[20%] border border-slate-300 p-2 text-start">{t('common.date') || 'Date'}</th>
                                <th className="w-[35%] border border-slate-300 p-2 text-start">{t('common.description') || 'Description'}</th>
                                <th className="w-[25%] border border-slate-300 p-2 text-start">{t('pos.paymentMethod') || 'Payment Method'}</th>
                                <th className="w-[20%] border border-slate-300 p-2 text-end">{t('common.amount') || 'Amount'}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {paymentChunk.length === 0 ? (
                                <tr style={{ height: `${LOAN_DETAILS_TABLE_ROW_HEIGHT_MM}mm` }}>
                                    <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={4}>
                                        {t('common.noData') || 'No data'}
                                    </td>
                                </tr>
                            ) : paymentChunk.map(({ payment, index }) => (
                                <tr key={payment.id} data-pdf-keep-together style={{ height: `${LOAN_DETAILS_TABLE_ROW_HEIGHT_MM}mm` }}>
                                    <td className="border border-slate-300 p-2 whitespace-nowrap">{formatDateTime(payment.paidAt)}</td>
                                    <td className="border border-slate-300 p-2">
                                        {getLoanPaymentActivityLabel(loan, t)}{index === 0 && loan.balanceAmount <= 0 ? ' (Final)' : ''}
                                    </td>
                                    <td className="border border-slate-300 p-2">
                                        {t(`pos.${payment.paymentMethod}`) || payment.paymentMethod}
                                    </td>
                                    <td className="border border-slate-300 p-2 text-end whitespace-nowrap">
                                        {formatCurrency(payment.amount, loan.settlementCurrency, iqdPreference)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ))}

                <div className="mt-6 text-xs" data-pdf-keep-together>
                    <div className="font-semibold text-slate-600">{t('loans.noteLabel') || 'Note:'}</div>
                    <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-slate-800">
                        {noteValue || ''}
                    </div>
                </div>
            </section>
        </div>
    )
}


export function LoanReceiptPrintTemplate({
    workspaceName,
    printLang,
    loan,
    installments,
    payments,
    iqdPreference = 'IQD',
    logoUrl,
    qrValue,
    hideDueDate
}: LoanReceiptPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const noteValue = loan.notes?.trim()
    const logoSrc = resolveLogoSrc(logoUrl)
    const isRtl = isRTL(printLang)
    const loanScheduleTitle = getLoanScheduleTitle(loan, t)
    const loanScheduleIndexLabel = getLoanScheduleIndexLabel(loan, t)
    const loanScheduleAmountLabel = getLoanScheduleAmountLabel(loan, t)

    return (
        <div
            dir={isRtl ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '80mm', padding: '8mm 6mm' }}
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: 80mm auto; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
}
`
                }}
            />

            <div className="text-center mb-4">
                <div className="flex items-center justify-between mb-3">
                    <div className="w-10" />
                    {logoSrc ? (
                        <img
                            src={logoSrc}
                            alt="Workspace Logo"
                            className="h-10 w-auto object-contain"
                        />
                    ) : (
                        <div className="h-8 w-20 bg-gray-100 border border-gray-200 text-gray-400 text-[9px] font-bold flex items-center justify-center">
                            LOGO
                        </div>
                    )}
                    <div className="w-12 flex justify-end">
                        {qrValue ? (
                            <div className="p-1 bg-white border border-gray-200 rounded-sm" data-qr-sharp="true">
                                <ReactQRCode
                                    value={qrValue}
                                    size={48}
                                    level="M"
                                />
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="text-lg font-bold">{workspaceName || 'Atlas'}</div>
                <div className="text-[10px] font-semibold">
                    {getLoanModuleTitle(loan, t)}
                </div>
                <div className="text-[10px] text-gray-500 mt-1 flex items-center justify-center gap-1">
                    <LoanNoDisplay loanNo={loan.loanNo} suffixClassName="text-slate-500" plain />
                    <span>•</span>
                    <span>{formatDateTime(new Date().toISOString())}</span>
                </div>
            </div>

            <div className="border-b border-gray-200 pb-3 mb-3 text-xs">
                <div className="font-semibold text-[10px] text-gray-500 mb-1">{getLoanCounterpartyLabel(loan, t)}</div>
                {getLoanLinkedPartySummary(loan, t) ? (
                    <div className="text-[10px] font-semibold text-primary mb-1">{getLoanLinkedPartySummary(loan, t)}</div>
                ) : null}
                {isSimpleLoan(loan) ? (
                    <div className="text-[10px] font-semibold text-slate-600 mb-1">{getLoanDirectionLabel(getLoanDirection(loan), t)}</div>
                ) : null}
                <div className="font-bold text-sm">{loan.borrowerName}</div>
                <div className="text-[10px] text-gray-500">{loan.borrowerPhone}</div>
                <div className="text-[10px] text-gray-500">{loan.borrowerAddress}</div>
                <div className="text-[10px] text-gray-500">{loan.borrowerNationalId}</div>
            </div>

            <div className="border-b border-gray-200 pb-3 mb-3 text-[10px] space-y-1">
                <div className="flex items-center justify-between">
                    <span className="text-gray-500">{t('loans.principal') || 'Principal'}</span>
                    <span className="font-semibold">{formatCurrency(loan.principalAmount, loan.settlementCurrency, iqdPreference)}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-gray-500">{t('loans.paid') || 'Paid'}</span>
                    <span className="font-semibold">{formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, iqdPreference)}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-gray-500">{t('loans.balance') || 'Balance'}</span>
                    <span className="font-semibold">{formatCurrency(loan.balanceAmount, loan.settlementCurrency, iqdPreference)}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-gray-500">{t('loans.nextDue') || 'Next Due'}</span>
                    <span className="font-semibold">{loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-gray-500">{t('loans.status') || 'Status'}</span>
                    <span className="font-semibold">{resolveStatusLabel(loan, t)}</span>
                </div>
            </div>

            <div className="mb-3">
                <div className="text-[10px] font-semibold text-gray-500 mb-2">{loanScheduleTitle}</div>
                <table className="w-full border-collapse text-[9px]">
                    <thead>
                        <tr className="text-gray-400 border-b border-gray-200">
                            <th className="py-1 text-start">{loanScheduleIndexLabel}</th>
                            {!hideDueDate && <th className="py-1 text-start">{t('loans.dueDate') || 'Due'}</th>}
                            <th className="py-1 text-start">{loanScheduleAmountLabel}</th>
                            <th className="py-1 text-start">{t('loans.paid') || 'Paid'}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {installments.length === 0 ? (
                            <tr>
                                <td className="py-2 text-center text-gray-400" colSpan={hideDueDate ? 3 : 4}>
                                    {t('common.noData') || 'No data'}
                                </td>
                            </tr>
                        ) : installments.map(item => (
                            <tr key={item.id}>
                                <td className="py-1">{getLoanScheduleItemLabel(loan, item.installmentNo, t)}</td>
                                {!hideDueDate && <td className="py-1">{item.dueDate ? formatDate(item.dueDate) : '-'}</td>}
                                <td className="py-1">{formatCurrency(item.plannedAmount, loan.settlementCurrency, iqdPreference)}</td>
                                <td className="py-1">{formatCurrency(item.paidAmount, loan.settlementCurrency, iqdPreference)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="mb-3">
                <div className="text-[10px] font-semibold text-gray-500 mb-2">{t('loans.recentActivity') || 'Recent Activity'}</div>
                <table className="w-full border-collapse text-[9px]">
                    <thead>
                        <tr className="text-gray-400 border-b border-gray-200">
                            <th className="py-1 text-start">{t('common.date') || 'Date'}</th>
                            <th className="py-1 text-start">{t('pos.paymentMethod') || 'Payment Method'}</th>
                            <th className="py-1 text-start">{t('common.amount') || 'Amount'}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {payments.length === 0 ? (
                            <tr>
                                <td className="py-2 text-center text-gray-400" colSpan={3}>
                                    {t('common.noData') || 'No data'}
                                </td>
                            </tr>
                        ) : payments
                            .slice()
                            .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
                            .map(payment => (
                                <tr key={payment.id}>
                                    <td className="py-1">{formatDateTime(payment.paidAt)}</td>
                                    <td className="py-1">{t(`pos.${payment.paymentMethod}`) || payment.paymentMethod}</td>
                                    <td className="py-1">{formatCurrency(payment.amount, loan.settlementCurrency, iqdPreference)}</td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>

            <div className="text-[9px]">
                <div className="font-semibold text-gray-600">{t('loans.noteLabel') || 'Note:'}</div>
                <div className="mt-1 whitespace-pre-wrap break-words text-gray-800">
                    {noteValue || ''}
                </div>
            </div>
        </div>
    )
}
