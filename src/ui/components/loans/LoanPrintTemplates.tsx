import { Loan, LoanInstallment, LoanPayment, type IQDDisplayPreference } from '@/local-db'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import { LoanNoDisplay } from './LoanNoDisplay'

type LoanFilter = 'all' | 'active' | 'overdue' | 'completed'

interface LoanListPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    loans: Loan[]
    filter: LoanFilter
    displayCurrency: string
    iqdPreference?: IQDDisplayPreference
    metrics: {
        totalOutstanding: number
        activeLoans: number
        overdueLoans: number
        dueToday: number
    }
    logoUrl?: string | null
    qrValue?: string | null
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
                    <h1 className="text-xl font-bold">{workspaceName || 'Asaas'}</h1>
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

export function LoanListPrintTemplate({
    workspaceName,
    printLang,
    loans,
    filter,
    displayCurrency,
    iqdPreference = 'IQD',
    metrics,
    logoUrl,
    qrValue
}: LoanListPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)

    return (
        <div
            dir={isRTL(printLang) ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '210mm', minHeight: '297mm', padding: '14mm 12mm' }}
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
}
`
                }}
            />

            <LoanPrintHeader
                workspaceName={workspaceName}
                printLang={printLang}
                title={t('nav.loans') || 'Loans'}
                subtitle={`${t(`loans.filters.${filter}`) || filter} • ${formatDateTime(new Date().toISOString())}`}
                logoUrl={logoUrl}
                qrValue={qrValue}
            />

            <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('loans.totalOutstanding') || 'Total Outstanding'}</p>
                    <p className="font-bold text-center">{formatCurrency(metrics.totalOutstanding, displayCurrency as any, iqdPreference)}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('loans.dueToday') || 'Due Today'}</p>
                    <p className="font-bold text-center">{formatCurrency(metrics.dueToday, displayCurrency as any, iqdPreference)}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('loans.activeLoans') || 'Active Loans'}</p>
                    <p className="font-bold text-center">{metrics.activeLoans}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('loans.overdueLoans') || 'Overdue Loans'}</p>
                    <p className="font-bold text-center">{metrics.overdueLoans}</p>
                </div>
            </div>

            <table className="w-full border-collapse text-xs">
                <thead>
                    <tr className="bg-slate-100">
                        <th className="border border-slate-300 p-2 text-start">{t('loans.loanNo') || 'Loan No.'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('loans.borrower') || 'Borrower'}</th>
                        <th className="border border-slate-300 p-2 text-end">{t('loans.principal') || 'Principal'}</th>
                        <th className="border border-slate-300 p-2 text-end">{t('loans.paid') || 'Paid'}</th>
                        <th className="border border-slate-300 p-2 text-end">{t('loans.balance') || 'Balance'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('loans.nextDue') || 'Next Due'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('loans.status') || 'Status'}</th>
                    </tr>
                </thead>
                <tbody>
                    {loans.length === 0 ? (
                        <tr>
                            <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={7}>
                                {t('common.noData') || 'No data'}
                            </td>
                        </tr>
                    ) : loans.map((loan) => (
                        <tr key={loan.id}>
                            <td className="border border-slate-300 p-2 font-semibold">
                                <LoanNoDisplay loanNo={loan.loanNo} plain />
                            </td>
                            <td className="border border-slate-300 p-2">
                                <p className="font-medium">{loan.borrowerName}</p>
                                <p className="text-[10px] text-slate-500">{loan.borrowerNationalId}</p>
                            </td>
                            <td className="border border-slate-300 p-2 text-end">{formatCurrency(loan.principalAmount, loan.settlementCurrency, iqdPreference)}</td>
                            <td className="border border-slate-300 p-2 text-end">{formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, iqdPreference)}</td>
                            <td className="border border-slate-300 p-2 text-end font-semibold">{formatCurrency(loan.balanceAmount, loan.settlementCurrency, iqdPreference)}</td>
                            <td className="border border-slate-300 p-2">{loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'}</td>
                            <td className="border border-slate-300 p-2">{resolveStatusLabel(loan, t)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
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
    qrValue
}: LoanDetailsPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const noteValue = loan.notes?.trim()

    return (
        <div
            dir={isRTL(printLang) ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '210mm', minHeight: '297mm', padding: '14mm 12mm' }}
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
}
`
                }}
            />

            <LoanPrintHeader
                workspaceName={workspaceName}
                printLang={printLang}
                title={t('nav.loans') || 'Loans'}
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

            <div className="grid grid-cols-2 gap-4 mb-4 text-xs text-center">
                <div className="border border-slate-300 rounded-md p-3">
                    <h2 className="font-semibold mb-2">{t('loans.borrowerIdentity') || 'Borrower Identity'}</h2>
                    <p>{loan.borrowerName}</p>
                    <p>{loan.borrowerPhone}</p>
                    <p>{loan.borrowerAddress}</p>
                    <p className="text-slate-600">{loan.borrowerNationalId}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-3 text-center">
                    <h2 className="font-semibold mb-2">{t('loans.summary') || 'Loan Summary'}</h2>
                    <p>{t('loans.principal') || 'Principal'}: {formatCurrency(loan.principalAmount, loan.settlementCurrency, iqdPreference)}</p>
                    <p>{t('loans.paid') || 'Paid'}: {formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, iqdPreference)}</p>
                    <p>{t('loans.balance') || 'Balance'}: {formatCurrency(loan.balanceAmount, loan.settlementCurrency, iqdPreference)}</p>
                    <p>{t('loans.nextDue') || 'Next Due'}: {loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'}</p>
                    <p>{t('loans.status') || 'Status'}: {resolveStatusLabel(loan, t)}</p>
                </div>
            </div>

            <h3 className="font-semibold mb-2 text-sm">{t('loans.installmentSchedule') || 'Installment Schedule'}</h3>
            <table className="w-full border-collapse text-xs mb-5">
                <thead>
                    <tr className="bg-slate-100">
                        <th className="border border-slate-300 p-2 text-start">#</th>
                        <th className="border border-slate-300 p-2 text-start">{t('loans.dueDate') || 'Due Date'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('loans.planned') || 'Planned'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('loans.paid') || 'Paid'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('loans.balance') || 'Balance'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('loans.status') || 'Status'}</th>
                    </tr>
                </thead>
                <tbody>
                    {installments.length === 0 ? (
                        <tr>
                            <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={6}>
                                {t('common.noData') || 'No data'}
                            </td>
                        </tr>
                    ) : installments.map((item) => (
                        <tr key={item.id}>
                            <td className="border border-slate-300 p-2">{String(item.installmentNo).padStart(2, '0')}</td>
                            <td className="border border-slate-300 p-2">{formatDate(item.dueDate)}</td>
                            <td className="border border-slate-300 p-2 text-start">{formatCurrency(item.plannedAmount, loan.settlementCurrency, iqdPreference)}</td>
                            <td className="border border-slate-300 p-2 text-start">{formatCurrency(item.paidAmount, loan.settlementCurrency, iqdPreference)}</td>
                            <td className="border border-slate-300 p-2 text-start">{formatCurrency(item.balanceAmount, loan.settlementCurrency, iqdPreference)}</td>
                            <td className="border border-slate-300 p-2">{resolveInstallmentStatusLabel(item.status, t)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <h3 className="font-semibold mb-2 text-sm">{t('loans.recentActivity') || 'Recent Activity'}</h3>
            <table className="w-full border-collapse text-xs">
                <thead>
                    <tr className="bg-slate-100">
                        <th className="border border-slate-300 p-2 text-start">{t('common.date') || 'Date'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('common.description') || 'Description'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('common.amount') || 'Amount'}</th>
                    </tr>
                </thead>
                <tbody>
                    {payments.length === 0 ? (
                        <tr>
                            <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={3}>
                                {t('common.noData') || 'No data'}
                            </td>
                        </tr>
                    ) : payments
                        .slice()
                        .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
                        .map((payment) => (
                            <tr key={payment.id}>
                                <td className="border border-slate-300 p-2">{formatDate(payment.paidAt)}</td>
                                <td className="border border-slate-300 p-2">
                                    {t('loans.activities.paymentReceived') || 'Payment Received'}
                                </td>
                                <td className="border border-slate-300 p-2 text-start">
                                    {formatCurrency(payment.amount, loan.settlementCurrency, iqdPreference)}
                                </td>
                            </tr>
                        ))}
                </tbody>
            </table>

            <div className="mt-6 text-xs">
                <div className="font-semibold text-slate-600">{t('loans.noteLabel') || 'Note:'}</div>
                <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-slate-800">
                    {noteValue || ''}
                </div>
            </div>
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
    qrValue
}: LoanReceiptPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const noteValue = loan.notes?.trim()
    const logoSrc = resolveLogoSrc(logoUrl)
    const isRtl = isRTL(printLang)

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
                <div className="text-lg font-bold">{workspaceName || 'Asaas'}</div>
                <div className="text-[10px] font-semibold">{t('nav.loans') || 'Loans'}</div>
                <div className="text-[10px] text-gray-500 mt-1 flex items-center justify-center gap-1">
                    <LoanNoDisplay loanNo={loan.loanNo} suffixClassName="text-slate-500" plain />
                    <span>•</span>
                    <span>{formatDateTime(new Date().toISOString())}</span>
                </div>
            </div>

            <div className="border-b border-gray-200 pb-3 mb-3 text-xs">
                <div className="font-semibold text-[10px] text-gray-500 mb-1">{t('loans.borrower') || 'Borrower'}</div>
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
                <div className="text-[10px] font-semibold text-gray-500 mb-2">{t('loans.installmentSchedule') || 'Installment Schedule'}</div>
                <table className="w-full border-collapse text-[9px]">
                    <thead>
                        <tr className="text-gray-400 border-b border-gray-200">
                            <th className="py-1 text-start">#</th>
                            <th className="py-1 text-start">{t('loans.dueDate') || 'Due'}</th>
                            <th className="py-1 text-start">{t('loans.planned') || 'Planned'}</th>
                            <th className="py-1 text-start">{t('loans.paid') || 'Paid'}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {installments.length === 0 ? (
                            <tr>
                                <td className="py-2 text-center text-gray-400" colSpan={4}>
                                    {t('common.noData') || 'No data'}
                                </td>
                            </tr>
                        ) : installments.map(item => (
                            <tr key={item.id}>
                                <td className="py-1">{String(item.installmentNo).padStart(2, '0')}</td>
                                <td className="py-1">{formatDate(item.dueDate)}</td>
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
                            <th className="py-1 text-start">{t('common.amount') || 'Amount'}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {payments.length === 0 ? (
                            <tr>
                                <td className="py-2 text-center text-gray-400" colSpan={2}>
                                    {t('common.noData') || 'No data'}
                                </td>
                            </tr>
                        ) : payments
                            .slice()
                            .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime())
                            .map(payment => (
                                <tr key={payment.id}>
                                    <td className="py-1">{formatDate(payment.paidAt)}</td>
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
