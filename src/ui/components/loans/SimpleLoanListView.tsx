import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BadgeCheck, CircleDashed, CreditCard, Eye, LayoutGrid, List, ListFilter, Plus, Printer, Search, Trash2, MessageCircle, Wallet, type LucideIcon } from 'lucide-react'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import { getLoanLinkedPartySummary } from '@/lib/loanParties'
import { calculateLegacySimpleLoanListMetrics, calculateSimpleLoanListMetrics, type SimpleLoanSummaryMode } from '@/lib/loanListMetrics'
import { getReportOriginId } from '@/lib/printIdentity'
import { isMobile } from '@/lib/platform'
import { getLoanDeleteWarning, getLoanDetailsTitle, getLoanDirection, getLoanDirectionLabel, getSimpleLoanModuleTitle, matchesLoanPaymentFilter, type LoanPaymentFilter } from '@/lib/loanPresentation'
import { cn, formatCurrency, formatDate, formatDateTime, formatLoanDetailsForWhatsApp } from '@/lib/utils'
import { whatsappManager } from '@/lib/whatsappWebviewManager'
import { deleteLoan, isLoanDeletionAllowed, type Loan, useLoanInstallments, useLoanPayments, useLoans } from '@/local-db'
import { db } from '@/local-db/database'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
import type { TemplatePreview, TemplatePreviewRenderOptions } from '@/lib/printPreviewEditorStore'
import { DEFAULT_SIMPLE_LOAN_SUMMARY_MODE, getSimpleLoanSummaryMode, saveSimpleLoanSummaryMode } from '@/lib/simpleLoanSummaryPreference'
import {
    AppPagination,
    Button,
    Card,
    CardContent,
    DeleteConfirmationModal,
    Input,
    PrintPreviewModal,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast,
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
} from '@/ui/components'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { FilterDropdown } from '@/ui/components/FilterDropdown'
import { WhatsAppNumberInputModal } from '@/ui/components/modals/WhatsAppNumberInputModal'
import { useWorkspace } from '@/workspace'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { CreateSimpleLoanModal } from './CreateSimpleLoanModal'
import { LoanDetailsPrintTemplate, LoanListPrintTemplate } from './LoanPrintTemplates'
import { LoanAccountStatementPrintFlow } from './LoanAccountStatementPrintFlow'
import { LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY } from '@/lib/customTemplates'
import { LoanNoDisplay } from './LoanNoDisplay'
import { LoanSourceBadge } from './LoanSourceBadge'
import { LoanNoteActionButton } from './LoanNoteActionButton'
import { LoanNoteDialog } from './LoanNoteDialog'

type SimpleLoanFilter = 'all' | 'lent' | 'borrowed' | 'completed'

const simpleLoanFilterIcons = {
    all: ListFilter,
    lent: ArrowUpRight,
    borrowed: ArrowDownLeft,
    completed: BadgeCheck,
} satisfies Record<SimpleLoanFilter, LucideIcon>

const loanPaymentFilterIcons = {
    all: CreditCard,
    outstanding: Wallet,
    partial: CircleDashed,
    paid: BadgeCheck,
} satisfies Record<LoanPaymentFilter, LucideIcon>

function statusClass(status: string) {
    if (status === 'completed') return 'bg-blue-500/15 text-blue-600 dark:text-blue-300'
    if (status === 'overdue') return 'bg-red-500/15 text-red-600 dark:text-red-300'
    return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
}

function directionClass(direction: ReturnType<typeof getLoanDirection>) {
    return direction === 'borrowed'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
}

function isLoanOverdue(loan: Loan) {
    if (loan.balanceAmount <= 0) return false
    if (loan.status === 'overdue') return true
    if (!loan.nextDueDate) return false
    return loan.nextDueDate < new Date().toISOString().slice(0, 10)
}

export function SimpleLoanListView({
    workspaceId
}: {
    workspaceId: string
}) {
    const { t, i18n } = useTranslation()
    const [, navigate] = useLocation()
    const { features, workspaceName, hasCapability } = useWorkspace()
    const { user } = useAuth()
    const { toast } = useToast()
    const { dateRange, customDates } = useDateRange()
    const isReadOnly = user?.role === 'viewer'
    const canUseWhatsApp = hasCapability('whatsappSharing')
    const [search, setSearch] = useState('')
    const [filter, setFilter] = useState<SimpleLoanFilter>('all')
    const [paymentFilter, setPaymentFilter] = useState<LoanPaymentFilter>('all')
    const [summaryModeByWorkspace, setSummaryModeByWorkspace] = useState<Record<string, SimpleLoanSummaryMode>>({})
    const persistedSummaryMode = useMemo(
        () => getSimpleLoanSummaryMode(workspaceId),
        [workspaceId]
    )
    const summaryMode = summaryModeByWorkspace[workspaceId] ?? persistedSummaryMode
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(() => {
        return Number(localStorage.getItem('simple_loans_page_size')) || 10
    })

    useEffect(() => {
        localStorage.setItem('simple_loans_page_size', String(pageSize))
    }, [pageSize])

    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('simple_loans_view_mode') as 'table' | 'grid') || 'table'
    })
    const [createOpen, setCreateOpen] = useState(false)
    const [loanToDelete, setLoanToDelete] = useState<Loan | null>(null)
    const [isDeletingLoan, setIsDeletingLoan] = useState(false)
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const [loanForWhatsApp, setLoanForWhatsApp] = useState<Loan | null>(null)
    const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)
    const [loanToPrint, setLoanToPrint] = useState<Loan | null>(null)
    const [showLoanPrintPreview, setShowLoanPrintPreview] = useState(false)
    const [showLoanAccountStatementPaymentPicker, setShowLoanAccountStatementPaymentPicker] = useState(false)
    const [loanForNote, setLoanForNote] = useState<Loan | null>(null)

    const handleShareOnWhatsApp = (phone: string, dialogLanguage: string) => {
        if (!loanForWhatsApp) return
        const translator = i18n.getFixedT(dialogLanguage)
        const message = formatLoanDetailsForWhatsApp(loanForWhatsApp, translator)
        void whatsappManager.openChat(phone, message).catch((error) => {
            console.error('[SimpleLoans] Failed to open WhatsApp chat:', error)
        })
        navigate('/whatsapp')
        setLoanForWhatsApp(null)
    }

    useEffect(() => {
        localStorage.setItem('simple_loans_view_mode', viewMode)
    }, [viewMode])

    const handleSummaryModeChange = useCallback((mode: SimpleLoanSummaryMode) => {
        setSummaryModeByWorkspace((current) => ({ ...current, [workspaceId]: mode }))
        saveSimpleLoanSummaryMode(workspaceId, mode)
    }, [workspaceId])

    const summaryModeOptions = useMemo(() => ([
        {
            value: 'principal_paid' as const,
            label: t('loans.summaryModes.principalPaid'),
            icon: CreditCard
        },
        {
            value: 'lent_borrowed' as const,
            label: t('loans.summaryModes.lentBorrowed'),
            icon: ArrowLeftRight
        }
    ]), [t])

    const loans = useLoans(workspaceId)
    const simpleLoans = useMemo(
        () => loans.filter((loan) => loan.loanCategory === 'simple'),
        [loans]
    )
    const dateScopedSimpleLoans = useMemo(
        () => simpleLoans.filter((loan) => isDateInDateRange(loan.createdAt, dateRange, customDates)),
        [customDates, dateRange, simpleLoans]
    )
    const loanPaymentHistoryIds = useLiveQuery(
        async () => {
            const rows = await db.loan_payments.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
            return rows.map((item) => item.loanId)
        },
        [workspaceId]
    )
    const loanPaymentHistoryIdSet = useMemo(
        () => new Set(loanPaymentHistoryIds ?? []),
        [loanPaymentHistoryIds]
    )

    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase()
        return dateScopedSimpleLoans.filter((loan) => {
            const direction = getLoanDirection(loan)
            const overdue = isLoanOverdue(loan)

            if (!matchesLoanPaymentFilter(loan, paymentFilter)) return false
            if (filter === 'lent' && direction !== 'lent') return false
            if (filter === 'borrowed' && direction !== 'borrowed') return false
            if (filter === 'completed' && !(loan.status === 'completed' || loan.balanceAmount <= 0)) return false
            if (!query) return true

            return (
                loan.borrowerName.toLowerCase().includes(query) ||
                (loan.linkedPartyName?.toLowerCase().includes(query) ?? false) ||
                loan.loanNo.toLowerCase().includes(query) ||
                (overdue && (t('loans.statuses.overdue') || 'overdue').toLowerCase().includes(query))
            )
        })
    }, [dateScopedSimpleLoans, filter, paymentFilter, search, t])

    const metrics = useMemo(
        () => calculateSimpleLoanListMetrics(filtered, features.default_currency),
        [features.default_currency, filtered]
    )
    const legacyMetrics = useMemo(
        () => calculateLegacySimpleLoanListMetrics(dateScopedSimpleLoans, features.default_currency),
        [dateScopedSimpleLoans, features.default_currency]
    )
    const usesLegacyMetrics = summaryMode === 'lent_borrowed'
    const primaryTotalsByCurrency = usesLegacyMetrics
        ? legacyMetrics.totalLentByCurrency
        : metrics.totalPrincipalByCurrency
    const secondaryTotalsByCurrency = usesLegacyMetrics
        ? legacyMetrics.totalBorrowedByCurrency
        : metrics.totalPaidByCurrency
    const activeEntries = usesLegacyMetrics ? legacyMetrics.activeCount : metrics.activeCount

    const paginated = useMemo(() => {
        const from = (currentPage - 1) * pageSize
        return filtered.slice(from, from + pageSize)
    }, [filtered, currentPage, pageSize])

    useEffect(() => {
        setCurrentPage(1)
    }, [customDates.end, customDates.start, dateRange])

    const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const buildQrValue = useCallback((effectiveId: string) => {
        if (!features.print_qr || !workspaceId || isLocalWorkspaceMode(workspaceId)) return undefined
        return `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/A4/${effectiveId}.pdf`
    }, [features.print_qr, workspaceId])
    const renderSimpleLoanListTemplate = useCallback((effectiveId?: string) => (
        <LoanListPrintTemplate
            workspaceName={workspaceName}
            printLang={printLang}
            loans={filtered}
            filter={filter}
            variant="simple"
            simpleSummaryMode={summaryMode}
            displayCurrency={features.default_currency}
            iqdPreference={features.iqd_display_preference}
            metrics={{
                totalPrincipalByCurrency: metrics.totalPrincipalByCurrency,
                totalPaidByCurrency: metrics.totalPaidByCurrency,
                totalBalanceByCurrency: metrics.totalBalanceByCurrency,
                totalLentByCurrency: legacyMetrics.totalLentByCurrency,
                totalBorrowedByCurrency: legacyMetrics.totalBorrowedByCurrency,
                activeEntries,
                settledEntries: legacyMetrics.settledCount
            }}
            logoUrl={features.logo_url}
            qrValue={effectiveId ? buildQrValue(effectiveId) : undefined}
            hideNextDue={localStorage.getItem('atlas_print_hide_next_due') === 'true'}
        />
    ), [activeEntries, buildQrValue, features.default_currency, features.iqd_display_preference, features.logo_url, filter, filtered, legacyMetrics.settledCount, legacyMetrics.totalBorrowedByCurrency, legacyMetrics.totalLentByCurrency, metrics.totalBalanceByCurrency, metrics.totalPaidByCurrency, metrics.totalPrincipalByCurrency, printLang, summaryMode, workspaceName])
    const buildSimpleLoanListPdf = useCallback(async ({ format, effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        return generateTemplatePdf({
            element: renderSimpleLoanListTemplate(effectiveId),
            format,
            printLang,
        })
    }, [printLang, renderSimpleLoanListTemplate])

    const simpleLoanListPreview = useMemo<TemplatePreview | undefined>(() => ({
        fields: [
            { key: 'title', label: t('common.title') || 'Title', value: getSimpleLoanModuleTitle(t), type: 'text' },
            { key: 'subtitle', label: t('common.subtitle') || 'Subtitle', value: `${t(`loans.filters.${filter}`) || filter} • ${formatDateTime(new Date().toISOString())}`, type: 'text' },
            { key: 'notes', label: t('loans.noteLabel') || 'Notes', value: '', type: 'text' },
            { key: 'hideNextDue', label: t('loans.hideNextDue', { defaultValue: 'Hide Next Due' }), value: localStorage.getItem('atlas_print_hide_next_due') || 'false', type: 'boolean' },
            { key: 'hideDueDate', label: t('loans.hideDueDate', { defaultValue: 'Hide Due Date' }), value: localStorage.getItem('atlas_print_hide_due_date') || 'false', type: 'boolean' }
        ],
        createElement: (data: Record<string, string>, effectiveId?: string, printLangOverride?: string, renderOptions?: TemplatePreviewRenderOptions) => (
            <LoanListPrintTemplate
                workspaceName={workspaceName}
                printLang={printLangOverride || printLang}
                loans={filtered}
                filter={filter}
                variant="simple"
                simpleSummaryMode={summaryMode}
                displayCurrency={features.default_currency}
                iqdPreference={features.iqd_display_preference}
                metrics={{
                    totalPrincipalByCurrency: metrics.totalPrincipalByCurrency,
                    totalPaidByCurrency: metrics.totalPaidByCurrency,
                    totalBalanceByCurrency: metrics.totalBalanceByCurrency,
                    totalLentByCurrency: legacyMetrics.totalLentByCurrency,
                    totalBorrowedByCurrency: legacyMetrics.totalBorrowedByCurrency,
                    activeEntries,
                    settledEntries: legacyMetrics.settledCount
                }}
                logoUrl={features.logo_url}
                qrValue={effectiveId ? buildQrValue(effectiveId) : undefined}
                titleOverride={data.title}
                subtitleOverride={data.subtitle}
                notesOverride={data.notes}
                hideNextDue={data.hideNextDue === 'true'}
                hiddenFields={renderOptions?.hiddenFields}
                onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
            />
        ),
        buildPdf: async (element: ReactElement, printLangOverride?: string) => generateTemplatePdf({
            element,
            format: 'a4',
            printLang: printLangOverride || printLang,
        }),
    }), [activeEntries, workspaceName, printLang, filtered, filter, features.default_currency, features.iqd_display_preference, legacyMetrics, metrics, features.logo_url, buildQrValue, summaryMode, t])

    const loanPrintInstallments = useLoanInstallments(loanToPrint?.id, workspaceId)
    const loanPrintPayments = useLoanPayments(loanToPrint?.id, workspaceId)
    const renderLoanPrintTemplate = useCallback((effectiveId?: string) => {
        if (!loanToPrint) return null
        return (
            <LoanDetailsPrintTemplate
                workspaceName={workspaceName}
                printLang={printLang}
                loan={loanToPrint}
                installments={loanPrintInstallments}
                payments={loanPrintPayments}
                iqdPreference={features.iqd_display_preference}
                logoUrl={features.logo_url}
                qrValue={effectiveId ? buildQrValue(effectiveId) : undefined}
                hideNextDue={localStorage.getItem('atlas_print_hide_next_due') === 'true'}
                hideDueDate={localStorage.getItem('atlas_print_hide_due_date') === 'true'}
            />
        )
    }, [buildQrValue, features.iqd_display_preference, features.logo_url, loanPrintInstallments, loanPrintPayments, loanToPrint, printLang, workspaceName])
    const buildLoanPrintPdf = useCallback(async ({ format, effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        const template = renderLoanPrintTemplate(effectiveId)
        if (!template) throw new Error('Loan data not ready')
        return generateTemplatePdf({
            element: template,
            format,
            printLang,
        })
    }, [printLang, renderLoanPrintTemplate])

    const simpleLoanDetailsPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!loanToPrint) return undefined
        return {
            fields: [
                { key: 'borrowerName', label: t('loans.borrowerName') || 'Borrower Name', value: loanToPrint.borrowerName || '', type: 'text' },
                { key: 'principalAmount', label: t('loans.principal') || 'Principal', value: String(loanToPrint.principalAmount ?? ''), type: 'number' },
                { key: 'hideNextDue', label: t('loans.hideNextDue', { defaultValue: 'Hide Next Due' }), value: localStorage.getItem('atlas_print_hide_next_due') || 'false', type: 'boolean' },
                { key: 'hideDueDate', label: t('loans.hideDueDate', { defaultValue: 'Hide Due Date' }), value: localStorage.getItem('atlas_print_hide_due_date') || 'false', type: 'boolean' }
            ],
            createElement: (data: Record<string, string>, effectiveId?: string, printLangOverride?: string, renderOptions?: TemplatePreviewRenderOptions) => (
                <LoanDetailsPrintTemplate
                    workspaceName={workspaceName}
                    printLang={printLangOverride || printLang}
                    loan={{ ...loanToPrint, borrowerName: data.borrowerName, principalAmount: Number(data.principalAmount) }}
                    installments={loanPrintInstallments}
                    payments={loanPrintPayments}
                    iqdPreference={features.iqd_display_preference}
                    logoUrl={features.logo_url}
                    qrValue={effectiveId ? buildQrValue(effectiveId) : undefined}
                    hideNextDue={data.hideNextDue === 'true'}
                    hideDueDate={data.hideDueDate === 'true'}
                    hiddenFields={renderOptions?.hiddenFields}
                    onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                />
            ),
            buildPdf: async (element: ReactElement, printLangOverride?: string) => generateTemplatePdf({
                element,
                format: 'a4',
                printLang: printLangOverride || printLang,
            }),
        }
    }, [loanToPrint, workspaceName, printLang, features, loanPrintInstallments, loanPrintPayments, t, buildQrValue])

    const simpleLoanListInvoiceData = useMemo(() => ({
        totalAmount: usesLegacyMetrics
            ? Object.values(legacyMetrics.totalLentByCurrency).reduce((a, b) => a + b, 0)
                + Object.values(legacyMetrics.totalBorrowedByCurrency).reduce((a, b) => a + b, 0)
            : Object.values(metrics.totalBalanceByCurrency).reduce((a, b) => a + b, 0),
        settlementCurrency: features.default_currency,
        origin: 'loan_report' as const,
        createdByName: user?.name || 'Unknown',
        cashierName: user?.name || 'Unknown',
        printFormat: 'a4' as const
    }), [features.default_currency, legacyMetrics.totalBorrowedByCurrency, legacyMetrics.totalLentByCurrency, metrics.totalBalanceByCurrency, user?.name, usesLegacyMetrics])
    const canDeleteLoanRecord = (loan: Loan) => loan.source !== 'order'
        && isLoanDeletionAllowed(loan, false, loanPaymentHistoryIdSet.has(loan.id))

    const confirmDeleteLoan = async () => {
        if (!loanToDelete) {
            return
        }

        setIsDeletingLoan(true)
        try {
            await deleteLoan(loanToDelete.id)
            toast({
                title: t('common.success') || 'Success',
                description: t('loans.messages.loanDeleted') || 'Loan deleted successfully.'
            })
            setLoanToDelete(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message === 'loan_delete_not_allowed'
                    ? (t('loans.messages.loanDeleteBlocked') || 'Loans with recorded repayments cannot be deleted.')
                    : error?.message || (t('loans.messages.loanDeleteFailed') || 'Failed to delete loan.'),
                variant: 'destructive'
            })
        } finally {
            setIsDeletingLoan(false)
        }
    }

    return (
        <div className="space-y-4">
            <div className="flex min-h-10 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="print:hidden">
                    <FilterDropdown
                        value={summaryMode}
                        label={t('loans.summaryMetrics')}
                        options={summaryModeOptions}
                        onValueChange={handleSummaryModeChange}
                        dir={i18n.dir()}
                        hasActiveFilter={summaryMode !== DEFAULT_SIMPLE_LOAN_SUMMARY_MODE}
                    />
                </div>
                {!isReadOnly && (
                    <Button onClick={() => setCreateOpen(true)} className="gap-2 print:hidden h-10 rounded-xl px-4">
                        <Plus className="h-4 w-4" />
                        <span>{t('loans.createSimpleLoan', { defaultValue: 'Create Simple Loan' })}</span>
                    </Button>
                )}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">
                            {usesLegacyMetrics
                                ? t('loans.totalLent', { defaultValue: 'Total Lent' })
                                : t('loans.totalPrincipal', { defaultValue: 'Total Principal' })}
                        </div>
                        <div className="space-y-1">
                            {Object.keys(primaryTotalsByCurrency).length > 0
                                ? Object.entries(primaryTotalsByCurrency).map(([curr, val]) => (
                                    <div key={curr} className="text-2xl font-bold tabular-nums leading-none">
                                        {formatCurrency(val, curr as any, features.iqd_display_preference)}
                                    </div>
                                ))
                                : <div className="text-2xl font-bold tabular-nums leading-none">{formatCurrency(0, features.default_currency as any, features.iqd_display_preference)}</div>
                            }
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">
                            {usesLegacyMetrics
                                ? t('loans.totalBorrowed', { defaultValue: 'Total Borrowed' })
                                : t('loans.totalPaid', { defaultValue: 'Total Paid' })}
                        </div>
                        <div className="space-y-1">
                            {Object.keys(secondaryTotalsByCurrency).length > 0
                                ? Object.entries(secondaryTotalsByCurrency).map(([curr, val]) => (
                                    <div key={curr} className="text-2xl font-bold tabular-nums leading-none">
                                        {formatCurrency(val, curr as any, features.iqd_display_preference)}
                                    </div>
                                ))
                                : <div className="text-2xl font-bold tabular-nums leading-none">{formatCurrency(0, features.default_currency as any, features.iqd_display_preference)}</div>
                            }
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.activeEntries', { defaultValue: 'Active Entries' })}</div>
                        <div className="text-2xl font-bold">{activeEntries}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">
                            {usesLegacyMetrics
                                ? t('loans.settledEntries', { defaultValue: 'Settled Entries' })
                                : t('loans.totalBalance', { defaultValue: 'Total Balance' })}
                        </div>
                        {usesLegacyMetrics ? (
                            <div className="text-2xl font-bold">{legacyMetrics.settledCount}</div>
                        ) : (
                            <div className="space-y-1">
                                {Object.keys(metrics.totalBalanceByCurrency).length > 0
                                    ? Object.entries(metrics.totalBalanceByCurrency).map(([curr, val]) => (
                                        <div key={curr} className="text-2xl font-bold tabular-nums leading-none">
                                            {formatCurrency(val, curr as any, features.iqd_display_preference)}
                                        </div>
                                    ))
                                    : <div className="text-2xl font-bold">0</div>}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardContent className="space-y-4 pt-6">
                    <DateRangeFilters />

                    <div className="flex flex-col gap-3 xl:flex-row">
                        <div className="relative flex-1">
                            <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                className="ps-9"
                                value={search}
                                onChange={(event) => {
                                    setCurrentPage(1)
                                    setSearch(event.target.value)
                                }}
                                allowViewer={true}
                                placeholder={t('loans.simpleSearchPlaceholder', { defaultValue: 'Search by counterparty, partner, or loan number...' })}
                            />
                        </div>
                        <div className="hidden md:flex items-center bg-muted/30 p-1 rounded-lg border border-border/40">
                            <Button
                                variant="ghost"
                                size={filtered.length > pageSize ? "icon" : "sm"}
                                allowViewer={true}
                                onClick={() => setViewMode('table')}
                                className={cn(
                                    filtered.length > pageSize ? "h-7 w-7" : "h-7 px-3 font-bold uppercase text-[9px] flex items-center gap-1.5",
                                    "transition-all",
                                    viewMode === 'table'
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <List className="w-3.5 h-3.5" />
                                {filtered.length <= pageSize && (t('loans.view.table') || 'Loans Details')}
                            </Button>
                            <Button
                                variant="ghost"
                                size={filtered.length > pageSize ? "icon" : "sm"}
                                allowViewer={true}
                                onClick={() => setViewMode('grid')}
                                className={cn(
                                    filtered.length > pageSize ? "h-7 w-7" : "h-7 px-3 font-bold uppercase text-[9px] flex items-center gap-1.5",
                                    "transition-all",
                                    viewMode === 'grid'
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <LayoutGrid className="w-3.5 h-3.5" />
                                {filtered.length <= pageSize && (t('loans.view.grid') || 'Loans Grid')}
                            </Button>
                        </div>
                        <div className="flex flex-wrap items-center gap-4">
                            <AppPagination
                                currentPage={currentPage}
                                totalCount={filtered.length}
                                pageSize={pageSize}
                                onPageChange={setCurrentPage}
                                onPageSizeChange={(newSize) => {
                                    setPageSize(newSize)
                                    setCurrentPage(1)
                                }}
                                className="w-auto"
                            />
                            <FilterDropdown
                                dir={i18n.dir() === 'rtl' ? 'rtl' : 'ltr'}
                                value={filter}
                                label={t('loans.status') || 'Status'}
                                hasActiveFilter={filter !== 'all'}
                                options={(['all', 'lent', 'borrowed', 'completed'] as SimpleLoanFilter[]).map((value) => ({
                                    value,
                                    icon: simpleLoanFilterIcons[value],
                                    label: value === 'lent' || value === 'borrowed'
                                        ? getLoanDirectionLabel(value, t)
                                        : (t(`loans.filters.${value}`) || value),
                                }))}
                                onValueChange={(value) => {
                                    setCurrentPage(1)
                                    setFilter(value)
                                }}
                            />
                            <FilterDropdown
                                dir={i18n.dir() === 'rtl' ? 'rtl' : 'ltr'}
                                value={paymentFilter}
                                label={t('loans.paymentStatus')}
                                hasActiveFilter={paymentFilter !== 'all'}
                                options={(['all', 'outstanding', 'partial', 'paid'] as LoanPaymentFilter[]).map((value) => ({
                                    value,
                                    icon: loanPaymentFilterIcons[value],
                                    label: value === 'all'
                                        ? (t('common.all') || 'All')
                                        : t(`loans.paymentFilters.${value}`, { defaultValue: value }),
                                }))}
                                onValueChange={(value) => {
                                    setCurrentPage(1)
                                    setPaymentFilter(value)
                                }}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" allowViewer={true} onClick={() => setShowPrintPreview(true)} className="gap-2 print:hidden h-10 rounded-xl px-4">
                                <Printer className="h-4 w-4" />
                                <span className="hidden sm:inline">{t('common.print') || 'Print'}</span>
                            </Button>
                        </div>
                    </div>

                    <div className="overflow-hidden rounded-lg border">
                        {(isMobile() || viewMode === 'grid') ? (
                            <div className={cn(
                                "grid gap-4 bg-muted/5 p-4",
                                viewMode === 'grid' && !isMobile() ? "md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
                            )}>
                            {paginated.length === 0 ? (
                                <div className="rounded-lg border bg-background py-10 text-center text-muted-foreground">
                                    {t('common.noData') || 'No data'}
                                </div>
                            ) : paginated.map((loan) => {
                                const direction = getLoanDirection(loan)
                                const overdue = isLoanOverdue(loan)
                                return (
                                    <ContextMenu key={loan.id}>
                                    <ContextMenuTrigger asChild>
                                    <div
                                        className={cn(
                                            'space-y-4 rounded-2xl border bg-background p-4 shadow-sm',
                                            overdue ? 'border-red-500/20 bg-red-500/5' : 'border-border'
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="space-y-1">
                                                <LoanNoDisplay loanNo={loan.loanNo} className="text-sm text-primary" />
                                                <div className="text-base font-bold">{loan.borrowerName}</div>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase', directionClass(direction))}>
                                                        {getLoanDirectionLabel(direction, t)}
                                                    </span>
                                                    {loan.source === 'order' ? (
                                                        <LoanSourceBadge source={loan.source} className="text-[10px]" />
                                                    ) : null}
                                                    {getLoanLinkedPartySummary(loan, t) ? (
                                                        <span className="text-xs font-medium text-primary">{getLoanLinkedPartySummary(loan, t)}</span>
                                                    ) : null}
                                                </div>
                                            </div>
                                            <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider', statusClass(overdue ? 'overdue' : loan.status))}>
                                                {overdue ? (t('loans.statuses.overdue') || 'Overdue') : (t(`loans.statuses.${loan.status}`) || loan.status)}
                                            </span>
                                        </div>

                                        <div className="grid grid-cols-3 gap-2 border-y border-border/50 py-3">
                                            <div className="text-center">
                                                <div className="text-[10px] font-bold uppercase tracking-tight text-muted-foreground">{t('loans.principal') || 'Principal'}</div>
                                                <div className="text-[11px] font-bold">{formatCurrency(loan.principalAmount, loan.settlementCurrency, features.iqd_display_preference)}</div>
                                            </div>
                                            <div className="border-x border-border/50 text-center">
                                                <div className="text-[10px] font-bold uppercase tracking-tight text-muted-foreground">{t('loans.paid') || 'Paid'}</div>
                                                <div className="text-[11px] font-bold text-emerald-600">{formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, features.iqd_display_preference)}</div>
                                            </div>
                                            <div className="text-center">
                                                <div className="text-[10px] font-bold uppercase tracking-tight text-muted-foreground">{t('loans.balance') || 'Balance'}</div>
                                                <div className="text-[11px] font-bold text-primary">{formatCurrency(loan.balanceAmount, loan.settlementCurrency, features.iqd_display_preference)}</div>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between gap-2">
                                            <div className="text-xs text-muted-foreground">
                                                {t('loans.nextDue') || 'Next Due'}: {loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button variant="secondary" allowViewer={true} className="h-9 gap-2 rounded-xl text-xs font-bold" onClick={() => navigate(`/loans/${loan.id}`)}>
                                                    <Eye className="h-3.5 w-3.5" />
                                                    {t('common.view') || 'View'}
                                                </Button>
                                                {!isReadOnly && canDeleteLoanRecord(loan) ? (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-9 w-9 rounded-xl border border-destructive/10 text-destructive hover:bg-destructive/5 hover:text-destructive"
                                                        onClick={() => setLoanToDelete(loan)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent>
                                        <ContextMenuItem
                                            className="gap-2"
                                            onSelect={() => navigate(`/loans/${loan.id}`)}
                                        >
                                            <Eye className="w-4 h-4" />
                                            {t('common.view') || 'View'}
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                            className="gap-2"
                                                onSelect={() => {
                                                    setLoanToPrint(loan)
                                                    setShowLoanPrintPreview(true)
                                                }}
                                            >
                                                <Printer className="w-4 h-4" />
                                                {t('common.print') || 'Print'}
                                            </ContextMenuItem>
                                            {canUseWhatsApp && (
                                                <ContextMenuItem
                                                    className="gap-2"
                                                    onSelect={() => {
                                                        setLoanForWhatsApp(loan)
                                                        setShowWhatsAppModal(true)
                                                    }}
                                                >
                                                    <MessageCircle className="w-4 h-4 text-emerald-600" />
                                                    {t('sales.share.whatsapp') || 'Share to WhatsApp'}
                                                </ContextMenuItem>
                                            )}
                                        {!isReadOnly && canDeleteLoanRecord(loan) && (
                                            <ContextMenuItem
                                                className="gap-2"
                                                onSelect={() => setLoanToDelete(loan)}
                                            >
                                                <Trash2 className="w-4 h-4 text-destructive" />
                                                {t('common.delete') || 'Delete'}
                                            </ContextMenuItem>
                                        )}
                                    </ContextMenuContent>
                                    </ContextMenu>
                                )
                            })}
                            </div>
                        ) : (
                            <div>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('loans.loanNo') || 'Loan No.'}</TableHead>
                                        <TableHead>{t('loans.direction', { defaultValue: 'Direction' })}</TableHead>
                                        <TableHead>{t('loans.counterparty', { defaultValue: 'Counterparty' })}</TableHead>
                                        <TableHead className="text-end">{t('loans.principal') || 'Principal'}</TableHead>
                                        <TableHead className="text-end">{t('loans.paid') || 'Paid'}</TableHead>
                                        <TableHead className="text-end">{t('loans.balance') || 'Balance'}</TableHead>
                                        <TableHead>{t('loans.nextDue') || 'Next Due'}</TableHead>
                                        <TableHead>{t('loans.status') || 'Status'}</TableHead>
                                        <TableHead>{t('sales.notes.title') || 'Notes'}</TableHead>
                                        <TableHead className="text-end">{t('common.actions') || 'Actions'}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {paginated.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                                                {t('common.noData') || 'No data'}
                                            </TableCell>
                                        </TableRow>
                                    ) : paginated.map((loan) => {
                                        const direction = getLoanDirection(loan)
                                        const overdue = isLoanOverdue(loan)
                                        return (
                                            <ContextMenu key={loan.id}>
                                            <ContextMenuTrigger asChild>
                                            <TableRow>
                                                <TableCell>
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <LoanNoDisplay loanNo={loan.loanNo} className="text-primary" />
                                                        {loan.source === 'order' ? (
                                                            <LoanSourceBadge source={loan.source} className="text-[10px]" />
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase', directionClass(direction))}>
                                                        {getLoanDirectionLabel(direction, t)}
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="font-medium">{loan.borrowerName}</div>
                                                    {getLoanLinkedPartySummary(loan, t) ? (
                                                        <div className="text-xs font-medium text-primary">{getLoanLinkedPartySummary(loan, t)}</div>
                                                    ) : null}
                                                    {loan.borrowerNationalId ? (
                                                        <div className="text-xs text-muted-foreground">{loan.borrowerNationalId}</div>
                                                    ) : null}
                                                </TableCell>
                                                <TableCell className="text-end">{formatCurrency(loan.principalAmount, loan.settlementCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell className="text-end font-semibold">{formatCurrency(loan.balanceAmount, loan.settlementCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell>{loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'}</TableCell>
                                                <TableCell>
                                                    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize', statusClass(overdue ? 'overdue' : loan.status))}>
                                                        {overdue ? (t('loans.statuses.overdue') || 'Overdue') : (t(`loans.statuses.${loan.status}`) || loan.status)}
                                                    </span>
                                                </TableCell>
                                                <TableCell>
                                                    <LoanNoteActionButton
                                                        loan={loan}
                                                        isReadOnly={isReadOnly}
                                                        onClick={() => setLoanForNote(loan)}
                                                    />
                                                </TableCell>
                                                <TableCell className="text-end">
                                                    <div className="flex items-center justify-end gap-1">
                                                        <Button variant="ghost" size="sm" allowViewer={true} onClick={() => navigate(`/loans/${loan.id}`)}>
                                                            {t('common.view') || 'View'}
                                                        </Button>
                                                    {!isReadOnly && canDeleteLoanRecord(loan) ? (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="text-destructive hover:text-destructive"
                                                            onClick={() => setLoanToDelete(loan)}
                                                            >
                                                                <Trash2 className="mr-1 h-4 w-4" />
                                                                {t('common.delete') || 'Delete'}
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                                </TableRow>
                                                </ContextMenuTrigger>
                                                <ContextMenuContent>
                                                    <ContextMenuItem
                                                        className="gap-2"
                                                        onSelect={() => navigate(`/loans/${loan.id}`)}
                                                    >
                                                        <Eye className="w-4 h-4" />
                                                        {t('common.view') || 'View'}
                                                    </ContextMenuItem>
                                                <ContextMenuItem
                                                    className="gap-2"
                                                    onSelect={() => {
                                                        setLoanToPrint(loan)
                                                        setShowLoanPrintPreview(true)
                                                    }}
                                                >
                                                    <Printer className="w-4 h-4" />
                                                    {t('common.print') || 'Print'}
                                                </ContextMenuItem>
                                                {canUseWhatsApp && (
                                                    <ContextMenuItem
                                                        className="gap-2"
                                                        onSelect={() => {
                                                            setLoanForWhatsApp(loan)
                                                            setShowWhatsAppModal(true)
                                                        }}
                                                    >
                                                        <MessageCircle className="w-4 h-4 text-emerald-600" />
                                                        {t('sales.share.whatsapp') || 'Share to WhatsApp'}
                                                    </ContextMenuItem>
                                                )}
                                                    {!isReadOnly && canDeleteLoanRecord(loan) && (
                                                        <ContextMenuItem
                                                            className="gap-2"
                                                            onSelect={() => setLoanToDelete(loan)}
                                                        >
                                                            <Trash2 className="w-4 h-4 text-destructive" />
                                                            {t('common.delete') || 'Delete'}
                                                        </ContextMenuItem>
                                                    )}
                                                </ContextMenuContent>
                                                </ContextMenu>
                                            )
                                        })}
                                    </TableBody>
                            </Table>
                            </div>
                        )}
                    </div>

                </CardContent>
            </Card>

            {!isReadOnly ? (
                <CreateSimpleLoanModal
                    isOpen={createOpen}
                    onOpenChange={setCreateOpen}
                    workspaceId={workspaceId}
                    settlementCurrency={features.default_currency}
                    onCreated={(loanId) => navigate(`/loans/${loanId}`)}
                />
            ) : null}

            <LoanNoteDialog
                open={!!loanForNote}
                onOpenChange={(open) => {
                    if (!open) setLoanForNote(null)
                }}
                loan={loanForNote}
                isReadOnly={isReadOnly}
            />

            <PrintPreviewModal
                isOpen={showPrintPreview}
                onClose={() => setShowPrintPreview(false)}
                onConfirm={() => setShowPrintPreview(false)}
                module="loans"
                title={getSimpleLoanModuleTitle(t)}
                features={features}
                workspaceName={workspaceName}
                originId={getReportOriginId(user?.workspaceId, 'loan_report', 'simple-loan-list')}
                invoiceData={simpleLoanListInvoiceData}
                pdfBuilder={buildSimpleLoanListPdf}
                printTemplate={({ effectiveId }) => renderSimpleLoanListTemplate(effectiveId)}
                templatePreview={simpleLoanListPreview}
            />

            <DeleteConfirmationModal
                isOpen={!!loanToDelete}
                onClose={() => {
                    if (isDeletingLoan) return
                    setLoanToDelete(null)
                }}
                onConfirm={confirmDeleteLoan}
                itemName={loanToDelete?.loanNo || ''}
                isLoading={isDeletingLoan}
                title={t('loans.confirmDelete') || 'Delete Loan'}
                description={getLoanDeleteWarning(loanToDelete, t)}
            />
            <PrintPreviewModal
                isOpen={showLoanPrintPreview}
                onClose={() => {
                    setShowLoanPrintPreview(false)
                    setLoanToPrint(null)
                }}
                onConfirm={() => {
                    setShowLoanPrintPreview(false)
                    setLoanToPrint(null)
                }}
                module="loans"
                title={getLoanDetailsTitle(loanToPrint || ({} as Loan), t)}
                features={features}
                workspaceName={workspaceName}
                originId={loanToPrint?.id}
                invoiceData={loanToPrint ? {
                    sequenceId: 0,
                    totalAmount: loanToPrint.principalAmount,
                    settlementCurrency: loanToPrint.settlementCurrency,
                    origin: 'loans',
                    cashierName: loanToPrint.borrowerName,
                    createdByName: loanToPrint.borrowerName,
                    printFormat: 'a4'
                } : undefined}
                pdfBuilder={buildLoanPrintPdf}
                printTemplate={loanToPrint ? ({ effectiveId }) => renderLoanPrintTemplate(effectiveId) : undefined}
                templatePreview={simpleLoanDetailsPreview}
                printSelectionOptions={[
                    {
                        format: 'a4',
                        label: getLoanDetailsTitle(loanToPrint || ({} as Loan), t),
                        description: t('loans.accountStatement.loanDetailsDescription'),
                        nativeTemplateKey: 'loans.Details'
                    },
                    {
                        format: 'a4',
                        label: t('loans.accountStatement.printOption'),
                        description: t('loans.accountStatement.printOptionDescription'),
                        nativeTemplateKey: LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY,
                        disabled: loanToPrint?.linkedPartyType !== 'business_partner'
                            || !loanToPrint?.linkedPartyId
                            || !loanPrintPayments.some((payment) => !payment.isDeleted),
                        warning: loanToPrint?.linkedPartyType !== 'business_partner' || !loanToPrint?.linkedPartyId
                            ? t('loans.accountStatement.requiresLinkedPartner')
                            : !loanPrintPayments.some((payment) => !payment.isDeleted)
                                ? t('loans.accountStatement.noRepayments')
                                : undefined
                    }
                ]}
                onPrintSelection={(_format, _template, nativeTemplateKey) => {
                    if (nativeTemplateKey !== LOAN_ACCOUNT_STATEMENT_TEMPLATE_KEY) return
                    setShowLoanPrintPreview(false)
                    setShowLoanAccountStatementPaymentPicker(true)
                }}
            />
            <LoanAccountStatementPrintFlow
                paymentPickerOpen={showLoanAccountStatementPaymentPicker}
                onPaymentPickerOpenChange={setShowLoanAccountStatementPaymentPicker}
                loan={loanToPrint}
                payments={loanPrintPayments}
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                features={features}
                createdByName={user?.name}
            />
            <WhatsAppNumberInputModal
                isOpen={showWhatsAppModal}
                onClose={() => {
                    setShowWhatsAppModal(false)
                    setLoanForWhatsApp(null)
                }}
                onConfirm={handleShareOnWhatsApp}
            />
        </div>
    )
}
