import { useTranslation } from 'react-i18next'
import { formatCurrency, formatDate } from '@/lib/utils'

interface BudgetPrintExpense {
    id: string
    description?: string
    category?: string
    subcategory?: string | null
    amount: number
    currency?: string
    status?: string
    dueDate: string
}

interface BudgetPrintMetrics {
    total: number
    paid: number
    pending: number
    dividendTotal: number
    finalNetProfit: number
    isDeficit: boolean
}

interface BudgetPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    month: string
    baseCurrency: string
    iqdPreference?: string
    metrics: BudgetPrintMetrics
    expenses: BudgetPrintExpense[]
}

function isRTL(lang: string): boolean {
    const baseLang = (lang || 'en').split('-')[0]
    return baseLang === 'ar' || baseLang === 'ku'
}

function resolveBudgetCategoryKey(rawCategory?: string): string {
    const normalized = (rawCategory || 'other').toLowerCase()
    if (normalized === 'electricity') return 'utility'
    if (normalized === 'general') return 'other'
    if (normalized === 'payroll') return 'payroll'
    if (normalized === 'rent') return 'rent'
    if (normalized === 'utility') return 'utility'
    if (normalized === 'marketing') return 'marketing'
    if (normalized === 'other') return 'other'
    return 'other'
}

function resolveStatus(rawStatus?: string): 'paid' | 'pending' | 'snoozed' {
    if (rawStatus === 'paid') return 'paid'
    if (rawStatus === 'snoozed') return 'snoozed'
    return 'pending'
}

function formatMonth(month: string, lang: string): string {
    const [yearRaw, monthRaw] = month.split('-')
    const year = Number(yearRaw)
    const monthIndex = Number(monthRaw) - 1
    if (Number.isNaN(year) || Number.isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) {
        return month
    }
    return new Intl.DateTimeFormat(lang || 'en', { month: 'long', year: 'numeric' }).format(new Date(year, monthIndex, 1))
}

function statusClass(status: 'paid' | 'pending' | 'snoozed'): string {
    if (status === 'paid') return 'bg-emerald-100 text-emerald-800'
    if (status === 'snoozed') return 'bg-blue-100 text-blue-800'
    return 'bg-amber-100 text-amber-800'
}

export function BudgetPrintTemplate({
    workspaceName,
    printLang,
    month,
    baseCurrency,
    iqdPreference = 'IQD',
    metrics,
    expenses
}: BudgetPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const monthLabel = formatMonth(month, printLang)
    const generatedAt = new Intl.DateTimeFormat(printLang || 'en', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date())

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

            <div className="border-b border-slate-300 pb-3 mb-4">
                <h1 className="text-xl font-bold">{workspaceName || 'Asaas'}</h1>
                <p className="text-sm font-semibold">{t('budget.title') || 'Budget Management'}</p>
                <p className="text-[11px] text-slate-600">
                    {monthLabel} - {(t('report.generatedOn') || 'Report generated on')} {generatedAt}
                </p>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500">{t('budget.totalAllocated') || 'Total Allocated'}</p>
                    <p className="font-bold">{formatCurrency(metrics.total, baseCurrency, iqdPreference as any)}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500">{t('budget.paid') || 'Total Paid'}</p>
                    <p className="font-bold text-emerald-700">{formatCurrency(metrics.paid, baseCurrency, iqdPreference as any)}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500">{t('budget.pending') || 'Outstanding'}</p>
                    <p className="font-bold text-amber-700">{formatCurrency(metrics.pending, baseCurrency, iqdPreference as any)}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500">{t('budget.dividends') || 'Dividends'}</p>
                    <p className="font-bold">{formatCurrency(metrics.dividendTotal, baseCurrency, iqdPreference as any)}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2 col-span-2">
                    <p className="text-slate-500">
                        {metrics.isDeficit ? (t('budget.deficit') || 'Deficit') : (t('budget.netProfit') || 'Surplus')}
                    </p>
                    <p className={metrics.isDeficit ? 'font-bold text-red-700' : 'font-bold text-violet-700'}>
                        {formatCurrency(metrics.finalNetProfit, baseCurrency, iqdPreference as any)}
                    </p>
                </div>
            </div>

            <h3 className="font-semibold mb-2 text-sm">{t('budget.expenseList') || 'Monthly Expenses'}</h3>
            <table className="w-full border-collapse text-xs">
                <thead>
                    <tr className="bg-slate-100">
                        <th className="border border-slate-300 p-2 text-start">{t('common.description') || 'Description'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('budget.form.category') || 'Category'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('budget.form.dueDate') || 'Due Date'}</th>
                        <th className="border border-slate-300 p-2 text-end">{t('budget.form.amount') || 'Amount'}</th>
                        <th className="border border-slate-300 p-2 text-start">{t('common.status') || 'Status'}</th>
                    </tr>
                </thead>
                <tbody>
                    {expenses.length === 0 ? (
                        <tr>
                            <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={5}>
                                {t('common.noData') || 'No data'}
                            </td>
                        </tr>
                    ) : expenses.map((expense) => {
                        const categoryKey = resolveBudgetCategoryKey(expense.category)
                        const categoryLabel = t(`budget.cat.${categoryKey}`) || categoryKey
                        const composedCategoryLabel = expense.subcategory?.trim()
                            ? `${categoryLabel} / ${String(t(`budget.subcat.${expense.subcategory.trim()}`, { defaultValue: expense.subcategory.trim() }))}`
                            : categoryLabel
                        const status = resolveStatus(expense.status)
                        return (
                            <tr key={expense.id}>
                                <td className="border border-slate-300 p-2 font-medium">
                                    {expense.description || categoryLabel}
                                </td>
                                <td className="border border-slate-300 p-2">{composedCategoryLabel}</td>
                                <td className="border border-slate-300 p-2">{formatDate(expense.dueDate)}</td>
                                <td className="border border-slate-300 p-2 text-end">{formatCurrency(expense.amount, expense.currency || baseCurrency, iqdPreference as any)}</td>
                                <td className="border border-slate-300 p-2">
                                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${statusClass(status)}`}>
                                        {t(`budget.status.${status}`) || status}
                                    </span>
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
