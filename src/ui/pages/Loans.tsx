import { useCallback, useMemo, useState, useEffect } from 'react'
import { Link, useLocation, useRoute } from 'wouter'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { db } from '@/local-db/database'
import {
    useLoans,
    useLoan,
    useLoanInstallments,
    useLoanPayments,
    deleteLoan,
    hasLoanTransactionHistory,
    isLoanDeletionAllowed,
    type Loan,
    type LoanInstallment
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import { getLoanLinkedPartySummary } from '@/lib/loanParties'
import {
    getLoanDeleteWarning,
    getLoanDetailsPath,
    getLoanDetailsTitle,
    getLoanDisbursementActivityLabel,
    getLoanIdentityTitle,
    getLoanListPath,
    getLoanModuleTitle,
    getLoanPaymentActivityLabel,
    getLoanRecordPaymentLabel,
    getLoanScheduleAmountLabel,
    getLoanScheduleIndexLabel,
    getLoanScheduleItemLabel,
    getLoanScheduleTitle,
    getStandardLoanModuleTitle,
    getLoanSummaryTitle,
} from '@/lib/loanPresentation'
import { setPendingSaleDetailsId } from '@/lib/saleNavigation'
import { formatCurrency, formatDate, cn, formatLoanDetailsForWhatsApp } from '@/lib/utils'
import { whatsappManager } from '@/lib/whatsappWebviewManager'
import { WhatsAppNumberInputModal } from '@/ui/components/modals/WhatsAppNumberInputModal'
import { isMobile } from '@/lib/platform'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    AppPagination,
    DeleteConfirmationModal,
    PrintPreviewModal,
    useToast
} from '@/ui/components'
import { Search, Plus, ArrowLeft, Printer, Trash2, List, LayoutGrid, MessageCircle, Receipt } from 'lucide-react'
import { CreateManualLoanModal } from '@/ui/components/loans/CreateManualLoanModal'
import { LoanDetailsPrintTemplate, LoanListPrintTemplate } from '@/ui/components/loans/LoanPrintTemplates'
import { LoanNoDisplay } from '@/ui/components/loans/LoanNoDisplay'
import { useLoanPaymentModal } from '@/ui/components/loans/LoanPaymentModalProvider'
import { SimpleLoanListView } from '@/ui/components/loans/SimpleLoanListView'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

type LoanFilter = 'all' | 'active' | 'overdue' | 'completed'

function statusClass(status: string) {
    if (status === 'completed') return 'bg-blue-500/15 text-blue-600 dark:text-blue-300'
    if (status === 'overdue') return 'bg-red-500/15 text-red-600 dark:text-red-300'
    return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
}

function sourceClass(source: string) {
    return source === 'pos'
        ? 'bg-primary/15 text-primary'
        : 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
}

function isLoanOverdue(loan: Loan) {
    if (loan.balanceAmount <= 0) return false
    if (loan.status === 'overdue') return true
    if (!loan.nextDueDate) return false
    return loan.nextDueDate < new Date().toISOString().slice(0, 10)
}

function LoanListView({
    workspaceId
}: {
    workspaceId: string
}) {
    const { t, i18n } = useTranslation()
    const [, navigate] = useLocation()
    const { features, workspaceName } = useWorkspace()
    const { user } = useAuth()
    const { toast } = useToast()
    const isReadOnly = user?.role === 'viewer'
    const [search, setSearch] = useState('')
    const [filter, setFilter] = useState<LoanFilter>('all')
    const [currentPage, setCurrentPage] = useState(1)
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('loans_view_mode') as 'table' | 'grid') || 'table'
    })

    useEffect(() => {
        localStorage.setItem('loans_view_mode', viewMode)
    }, [viewMode])
    const [createOpen, setCreateOpen] = useState(false)
    const [loanToDelete, setLoanToDelete] = useState<Loan | null>(null)
    const [isDeletingLoan, setIsDeletingLoan] = useState(false)
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const pageSize = 10
    const allLoans = useLoans(workspaceId)
    const loans = useMemo(
        () => allLoans.filter((loan) => loan.loanCategory !== 'simple'),
        [allLoans]
    )
    const standardLoanIds = useMemo(
        () => new Set(loans.map((loan) => loan.id)),
        [loans]
    )
    const installments = useLiveQuery(
        () => db.loan_installments.where('workspaceId').equals(workspaceId).and(item => !item.isDeleted).toArray(),
        [workspaceId]
    ) ?? []
    const workspaceSales = useLiveQuery(
        () => db.sales.where('workspaceId').equals(workspaceId).toArray(),
        [workspaceId]
    )
    const loanTransactionHistoryIds = useLiveQuery(
        async () => {
            const rows = await db.payment_transactions.where('workspaceId').equals(workspaceId).toArray()
            return rows
                .filter((item) => item.sourceModule === 'loans')
                .map((item) => item.sourceRecordId)
        },
        [workspaceId]
    )
    const activeSaleIds = useMemo(
        () => new Set((workspaceSales ?? []).filter(item => !item.isDeleted).map(item => item.id)),
        [workspaceSales]
    )
    const loanTransactionHistoryIdSet = useMemo(
        () => new Set(loanTransactionHistoryIds ?? []),
        [loanTransactionHistoryIds]
    )

    const metrics = useMemo(() => {
        const today = new Date().toISOString().slice(0, 10)
        const totalOutstanding = loans.reduce((sum, loan) => sum + loan.balanceAmount, 0)
        const activeLoans = loans.filter(loan => loan.status === 'active' && loan.balanceAmount > 0).length
        const overdueLoans = loans.filter(loan => isLoanOverdue(loan)).length
        const dueToday = installments
            .filter(item => standardLoanIds.has(item.loanId) && item.dueDate === today && item.balanceAmount > 0 && item.status !== 'paid')
            .reduce((sum, item) => sum + item.balanceAmount, 0)

        return { totalOutstanding, activeLoans, overdueLoans, dueToday }
    }, [installments, loans, standardLoanIds])

    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase()
        return loans.filter(loan => {
            if (filter === 'active' && loan.status !== 'active') return false
            if (filter === 'completed' && loan.status !== 'completed') return false
            if (filter === 'overdue' && !isLoanOverdue(loan)) return false
            if (!query) return true

            return (
                loan.borrowerName.toLowerCase().includes(query) ||
                (loan.linkedPartyName?.toLowerCase().includes(query) ?? false) ||
                loan.loanNo.toLowerCase().includes(query)
            )
        })
    }, [loans, search, filter])

    const paginated = useMemo(() => {
        const from = (currentPage - 1) * pageSize
        return filtered.slice(from, from + pageSize)
    }, [filtered, currentPage])

    const currency = features.default_currency || 'usd'
    const iqdPreference = features.iqd_display_preference
    const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const buildQrValue = useCallback((effectiveId: string) => {
        if (!features.print_qr || !workspaceId || isLocalWorkspaceMode(workspaceId)) return undefined
        return `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/A4/${effectiveId}.pdf`
    }, [features.print_qr, workspaceId])

    const renderLoanListTemplate = useCallback((effectiveId?: string) => (
        <LoanListPrintTemplate
            workspaceName={workspaceName}
            printLang={printLang}
            loans={filtered}
            filter={filter}
            displayCurrency={currency}
            iqdPreference={iqdPreference}
            metrics={metrics}
            logoUrl={features.logo_url}
            qrValue={effectiveId ? buildQrValue(effectiveId) : undefined}
        />
    ), [buildQrValue, currency, features.logo_url, filter, filtered, iqdPreference, metrics, printLang, workspaceName])

    const buildLoanListPdf = useCallback(async ({ format, effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        return generateTemplatePdf({
            element: renderLoanListTemplate(effectiveId),
            format,
            printLang,
            printQuality: features.print_quality
        })
    }, [features.print_quality, printLang, renderLoanListTemplate])

    const loanListInvoiceData = useMemo(() => ({
        totalAmount: metrics.totalOutstanding,
        settlementCurrency: currency,
        origin: 'Loans' as const,
        createdByName: user?.name || 'Unknown',
        cashierName: user?.name || 'Unknown',
        printFormat: 'a4' as const
    }), [currency, metrics.totalOutstanding, user?.name])
    const canDeleteLoanRecord = (loan: Loan) => {
        const hasTransactionHistory = loanTransactionHistoryIdSet.has(loan.id)
        if (loan.source === 'manual' || !loan.saleId) {
            return isLoanDeletionAllowed(loan, false, hasTransactionHistory)
        }

        if (workspaceSales === undefined) {
            return false
        }

        return isLoanDeletionAllowed(loan, activeSaleIds.has(loan.saleId), hasTransactionHistory)
    }
    const confirmDeleteLoan = async () => {
        if (!loanToDelete) {
            return
        }

        setIsDeletingLoan(true)
        try {
            await deleteLoan(loanToDelete.id)
            toast({
                title: t('common.success') || 'Success',
                description: t('loans.messages.loanDeleted')
            })
            setLoanToDelete(null)
        } catch (error: any) {
            const message = error?.message === 'loan_delete_not_allowed'
                ? t('loans.messages.loanDeleteBlocked')
                : error?.message || t('loans.messages.loanDeleteFailed')
            toast({
                title: t('common.error') || 'Error',
                description: message,
                variant: 'destructive'
            })
        } finally {
            setIsDeletingLoan(false)
        }
    }

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.totalOutstanding') || 'Total Outstanding'}</div>
                        <div className="text-2xl font-bold">{formatCurrency(metrics.totalOutstanding, currency, iqdPreference)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.activeLoans') || 'Active Loans'}</div>
                        <div className="text-2xl font-bold">{metrics.activeLoans}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.overdueLoans') || 'Overdue Loans'}</div>
                        <div className="text-2xl font-bold text-red-500">{metrics.overdueLoans}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.dueToday') || 'Due Today'}</div>
                        <div className="text-2xl font-bold">{formatCurrency(metrics.dueToday, currency, iqdPreference)}</div>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardContent className="pt-6 space-y-4">
                    <div className="flex flex-col lg:flex-row gap-3">
                        <div className="relative flex-1">
                            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                className="ps-9"
                                value={search}
                                onChange={e => {
                                    setCurrentPage(1)
                                    setSearch(e.target.value)
                                }}
                                allowViewer={true}
                                placeholder={t('loans.searchPlaceholder') || 'Search by borrower name or loan number'}
                            />
                        </div>
                        <div className="hidden md:flex items-center bg-muted/30 p-1 rounded-lg border border-border/40">
                            <Button
                                variant="ghost"
                                size="sm"
                                allowViewer={true}
                                onClick={() => setViewMode('table')}
                                className={cn(
                                    "h-7 px-3 font-bold uppercase text-[9px] flex items-center gap-1.5 transition-all",
                                    viewMode === 'table'
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <List className="w-3 h-3" />
                                {t('loans.view.table')}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                allowViewer={true}
                                onClick={() => setViewMode('grid')}
                                className={cn(
                                    "h-7 px-3 font-bold uppercase text-[9px] flex items-center gap-1.5 transition-all",
                                    viewMode === 'grid'
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <LayoutGrid className="w-3 h-3" />
                                {t('loans.view.grid')}
                            </Button>
                        </div>
                        <div className="flex items-center gap-1 bg-muted/30 rounded-md p-1">
                            {(['all', 'active', 'overdue', 'completed'] as LoanFilter[]).map(value => (
                                <button
                                    key={value}
                                    onClick={() => {
                                        setCurrentPage(1)
                                        setFilter(value)
                                    }}
                                    className={cn(
                                        'px-3 py-1.5 text-xs rounded-md font-medium transition-colors',
                                        filter === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background'
                                    )}
                                >
                                    {t(`loans.filters.${value}`) || value}
                                </button>
                            ))}
                        </div>
                        <Button variant="outline" allowViewer={true} onClick={() => setShowPrintPreview(true)} className="gap-2 print:hidden">
                            <Printer className="w-4 h-4" />
                            {t('common.print') || 'Print'}
                        </Button>
                        {!isReadOnly && (
                            <Button onClick={() => setCreateOpen(true)} className="gap-2 print:hidden">
                                <Plus className="w-4 h-4" />
                                {t('loans.createManualLoan') || 'Create Manual Loan'}
                            </Button>
                        )}
                    </div>

                    <div className="rounded-lg border overflow-hidden">
                        {(isMobile() || viewMode === 'grid') ? (
                            <div className={cn(
                                "grid gap-4 p-4 bg-muted/5",
                                viewMode === 'grid' && !isMobile() ? "md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
                            )}>
                                {paginated.length === 0 ? (
                                    <div className="text-center text-muted-foreground py-10 bg-background rounded-lg border">
                                        {t('common.noData') || 'No data'}
                                    </div>
                                ) : paginated.map(loan => {
                                    const overdue = isLoanOverdue(loan)
                                    const linkedPartySummary = getLoanLinkedPartySummary(loan, t)
                                    return (
                                        <div
                                            key={loan.id}
                                            className={cn(
                                                "p-4 border shadow-sm space-y-4 transition-all active:scale-[0.98] bg-background rounded-2xl",
                                                overdue ? 'border-red-500/20 bg-red-500/5' : 'border-border'
                                            )}
                                        >
                                            <div className="flex justify-between items-start">
                                                <div className="space-y-1">
                                                    <div className="flex items-center gap-2">
                                                        <LoanNoDisplay
                                                            loanNo={loan.loanNo}
                                                            className="text-sm text-primary"
                                                        />
                                                        <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold uppercase', sourceClass(loan.source))}>
                                                            {loan.source}
                                                        </span>
                                                    </div>
                                                    <div className="text-base font-bold text-foreground">
                                                        {loan.borrowerName}
                                                    </div>
                                                    {linkedPartySummary ? (
                                                        <div className="text-xs font-medium text-primary">
                                                            {linkedPartySummary}
                                                        </div>
                                                    ) : null}
                                                    <div className="text-xs text-muted-foreground">
                                                        {loan.borrowerNationalId}
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <span className={cn('inline-flex px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider', statusClass(overdue ? 'overdue' : loan.status))}>
                                                        {overdue ? (t('loans.statuses.overdue') || 'Overdue') : (t(`loans.statuses.${loan.status}`) || loan.status)}
                                                    </span>
                                                    <div className="text-xs text-muted-foreground mt-2 font-medium">
                                                        {loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-3 gap-2 py-3 border-y border-border/50">
                                                <div className="text-center">
                                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('loans.principal') || 'Principal'}</div>
                                                    <div className="text-[11px] font-bold">{formatCurrency(loan.principalAmount, loan.settlementCurrency, iqdPreference)}</div>
                                                </div>
                                                <div className="text-center border-x border-border/50">
                                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('loans.paid') || 'Paid'}</div>
                                                    <div className="text-[11px] font-bold text-emerald-600">{formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, iqdPreference)}</div>
                                                </div>
                                                <div className="text-center">
                                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('loans.balance') || 'Balance'}</div>
                                                    <div className="text-[11px] font-bold text-primary">{formatCurrency(loan.balanceAmount, loan.settlementCurrency, iqdPreference)}</div>
                                                </div>
                                            </div>

                                            <div className="flex items-center justify-between gap-2 pt-1">
                                                <Button
                                                    variant="secondary"
                                                    allowViewer={true}
                                                    className="flex-1 h-9 rounded-xl font-bold gap-2 text-xs"
                                                    onClick={() => navigate(getLoanDetailsPath(loan, loan.id))}
                                                >
                                                    <Search className="w-3.5 h-3.5" />
                                                    {t('common.view') || 'View'}
                                                </Button>
                                                {!isReadOnly && canDeleteLoanRecord(loan) && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/5 rounded-xl border border-destructive/10"
                                                        onClick={() => setLoanToDelete(loan)}
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('loans.loanNo') || 'Loan No.'}</TableHead>
                                        <TableHead>{t('loans.borrower') || 'Borrower'}</TableHead>
                                        <TableHead>{t('loans.source') || 'Source'}</TableHead>
                                        <TableHead className="text-end">{t('loans.principal') || 'Principal'}</TableHead>
                                        <TableHead className="text-end">{t('loans.paid') || 'Paid'}</TableHead>
                                        <TableHead className="text-end">{t('loans.balance') || 'Balance'}</TableHead>
                                        <TableHead>{t('loans.nextDue') || 'Next Due'}</TableHead>
                                        <TableHead>{t('loans.status') || 'Status'}</TableHead>
                                        <TableHead className="text-end print:hidden">{t('common.actions') || 'Actions'}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {paginated.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                                                {t('common.noData') || 'No data'}
                                            </TableCell>
                                        </TableRow>
                                    ) : paginated.map(loan => (
                                        <TableRow key={loan.id}>
                                            <TableCell>
                                                <LoanNoDisplay loanNo={loan.loanNo} className="text-primary" />
                                            </TableCell>
                                            <TableCell>
                                                <div className="font-medium">{loan.borrowerName}</div>
                                                {getLoanLinkedPartySummary(loan, t) ? (
                                                    <div className="text-xs font-medium text-primary">{getLoanLinkedPartySummary(loan, t)}</div>
                                                ) : null}
                                                <div className="text-xs text-muted-foreground">{loan.borrowerNationalId}</div>
                                            </TableCell>
                                            <TableCell>
                                                <span className={cn('inline-flex px-2 py-0.5 rounded-full text-xs font-medium uppercase', sourceClass(loan.source))}>
                                                    {loan.source}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-end">{formatCurrency(loan.principalAmount, loan.settlementCurrency, iqdPreference)}</TableCell>
                                            <TableCell className="text-end">{formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, iqdPreference)}</TableCell>
                                            <TableCell className="text-end font-semibold">{formatCurrency(loan.balanceAmount, loan.settlementCurrency, iqdPreference)}</TableCell>
                                            <TableCell>{loan.nextDueDate ? formatDate(loan.nextDueDate) : '-'}</TableCell>
                                            <TableCell>
                                                <span className={cn('inline-flex px-2 py-0.5 rounded-full text-xs font-medium capitalize', statusClass(isLoanOverdue(loan) ? 'overdue' : loan.status))}>
                                                    {isLoanOverdue(loan) ? (t('loans.statuses.overdue') || 'Overdue') : (t(`loans.statuses.${loan.status}`) || loan.status)}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-end print:hidden">
                                                <div className="flex items-center justify-end gap-1">
                                                    <Button variant="ghost" size="sm" allowViewer={true} onClick={() => navigate(getLoanDetailsPath(loan, loan.id))}>
                                                        {t('common.view') || 'View'}
                                                    </Button>
                                                    {!isReadOnly && canDeleteLoanRecord(loan) && (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="text-destructive hover:text-destructive"
                                                            onClick={() => setLoanToDelete(loan)}
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                            {t('common.delete') || 'Delete'}
                                                        </Button>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </div>

                    <AppPagination
                        currentPage={currentPage}
                        totalCount={filtered.length}
                        pageSize={pageSize}
                        onPageChange={setCurrentPage}
                        className="print:hidden"
                    />
                </CardContent>
            </Card>

            {!isReadOnly && (
                <CreateManualLoanModal
                    isOpen={createOpen}
                    onOpenChange={setCreateOpen}
                    workspaceId={workspaceId}
                    settlementCurrency={currency}
                    onCreated={(loanId) => navigate(getLoanDetailsPath('standard', loanId))}
                />
            )}

            <DeleteConfirmationModal
                isOpen={!!loanToDelete}
                onClose={() => {
                    if (isDeletingLoan) return
                    setLoanToDelete(null)
                }}
                onConfirm={confirmDeleteLoan}
                itemName={loanToDelete?.loanNo || ''}
                isLoading={isDeletingLoan}
                title={t('loans.confirmDelete')}
                description={t('loans.deleteWarning')}
            />
            <PrintPreviewModal
                isOpen={showPrintPreview}
                onClose={() => setShowPrintPreview(false)}
                onConfirm={() => setShowPrintPreview(false)}
                title={getStandardLoanModuleTitle(t)}
                features={features}
                workspaceName={workspaceName}
                invoiceData={loanListInvoiceData}
                pdfBuilder={buildLoanListPdf}
                printTemplate={({ effectiveId }) => renderLoanListTemplate(effectiveId)}
            />
        </div>
    )
}

function LoanDetailsView({
    workspaceId,
    loanId,
    onOpenPayment
}: {
    workspaceId: string
    loanId: string
    onOpenPayment: (loan: Loan, installment?: LoanInstallment | null) => void
}) {
    const { t, i18n } = useTranslation()
    const { features, workspaceName } = useWorkspace()
    const { user } = useAuth()
    const [, navigate] = useLocation()
    const { toast } = useToast()
    const isReadOnly = user?.role === 'viewer'
    const loan = useLoan(loanId)
    const installments = useLoanInstallments(loanId, workspaceId)
    const payments = useLoanPayments(loanId, workspaceId)
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('loan_details_view_mode') as 'table' | 'grid') || 'table'
    })

    const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)
    useEffect(() => {
        localStorage.setItem('loan_details_view_mode', viewMode)
    }, [viewMode])

    const handleWhatsAppConfirm = (phone: string, dialogLanguage: string) => {
        if (!loan) return

        const translator = i18n.getFixedT(dialogLanguage)
        const message = formatLoanDetailsForWhatsApp(loan, translator)

        void whatsappManager.openChat(phone, message).catch((error) => {
            console.error('[Loans] Failed to open WhatsApp chat:', error)
        })
        navigate('/whatsapp')
    }


    const [deleteOpen, setDeleteOpen] = useState(false)
    const [isDeletingLoan, setIsDeletingLoan] = useState(false)
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const buildQrValue = useCallback((effectiveId: string) => {
        if (!features.print_qr || !workspaceId || isLocalWorkspaceMode(workspaceId)) return undefined
        return `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/A4/${effectiveId}.pdf`
    }, [features.print_qr, workspaceId])
    const normalizedLoanNo = loan?.loanNo?.trim() || ''

    const renderLoanDetailsTemplate = useCallback((effectiveId?: string) => {
        if (!loan) return null
        return (
            <LoanDetailsPrintTemplate
                workspaceName={workspaceName}
                printLang={printLang}
                loan={loan}
                installments={installments}
                payments={payments}
                iqdPreference={features.iqd_display_preference}
                logoUrl={features.logo_url}
                qrValue={effectiveId ? buildQrValue(effectiveId) : undefined}
            />
        )
    }, [buildQrValue, features.iqd_display_preference, features.logo_url, installments, loan, payments, printLang, workspaceName])

    const buildLoanDetailsPdf = useCallback(async ({ format, effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        const loanDetailsTemplate = renderLoanDetailsTemplate(effectiveId)
        if (!loanDetailsTemplate) {
            throw new Error('Loan data not ready')
        }

        return generateTemplatePdf({
            element: loanDetailsTemplate,
            format,
            printLang,
            printQuality: features.print_quality
        })
    }, [features.print_quality, printLang, renderLoanDetailsTemplate])

    const loanDetailsInvoiceData = useMemo(() => {
        if (!loan) return null
        return {
            invoiceid: normalizedLoanNo || loan.loanNo,
            totalAmount: loan.principalAmount,
            settlementCurrency: loan.settlementCurrency,
            origin: 'Loans' as const,
            createdByName: user?.name || 'Unknown',
            cashierName: user?.name || 'Unknown',
            printFormat: 'a4' as const
        }
    }, [loan, normalizedLoanNo, user?.name])
    const linkedSaleMissingOrDeleted = useLiveQuery(
        async () => {
            if (!loan?.saleId) {
                return true
            }

            const linkedSale = await db.sales.get(loan.saleId)
            return !linkedSale || linkedSale.isDeleted
        },
        [loan?.saleId]
    )
    const hasPostedTransactionHistory = useLiveQuery(
        async () => {
            if (!loan?.id || !loan.workspaceId) {
                return false
            }

            return hasLoanTransactionHistory(loan.workspaceId, loan.id)
        },
        [loan?.id, loan?.workspaceId]
    )

    if (!loan) {
        return (
            <Card>
                <CardContent className="py-10 text-center text-muted-foreground">
                    {t('loans.messages.loanNotFound') || 'Loan not found'}
                </CardContent>
            </Card>
        )
    }

    const canDeleteCurrentLoan = linkedSaleMissingOrDeleted !== undefined
        && hasPostedTransactionHistory !== undefined
        && isLoanDeletionAllowed(
            loan,
            linkedSaleMissingOrDeleted === false,
            hasPostedTransactionHistory
        )

    const confirmDeleteLoan = async () => {
        setIsDeletingLoan(true)
        try {
            await deleteLoan(loan.id)
            toast({
                title: t('common.success') || 'Success',
                description: t('loans.messages.loanDeleted')
            })
            setDeleteOpen(false)
            navigate(getLoanListPath(loan))
        } catch (error: any) {
            const message = error?.message === 'loan_delete_not_allowed'
                ? t('loans.messages.loanDeleteBlocked')
                : error?.message || t('loans.messages.loanDeleteFailed')
            toast({
                title: t('common.error') || 'Error',
                description: message,
                variant: 'destructive'
            })
        } finally {
            setIsDeletingLoan(false)
        }
    }

    const paidPercent = loan.principalAmount > 0
        ? Math.min(100, (loan.totalPaidAmount / loan.principalAmount) * 100)
        : 0

    const activityRows = [
        ...payments.map(payment => ({
            id: payment.id,
            date: payment.paidAt,
            label: getLoanPaymentActivityLabel(loan, t),
            amount: payment.amount
        })),
        {
            id: `${loan.id}-created`,
            date: loan.createdAt,
            label: getLoanDisbursementActivityLabel(loan, t),
            amount: loan.principalAmount
        }
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

    const canOpenLinkedSale = !!loan.saleId && linkedSaleMissingOrDeleted !== true
    const moduleTitle = getLoanModuleTitle(loan, t)
    const modulePath = getLoanListPath(loan)
    const loanDetailsTitle = getLoanDetailsTitle(loan, t)
    const loanSummaryTitle = getLoanSummaryTitle(loan, t)
    const loanScheduleTitle = getLoanScheduleTitle(loan, t)
    const loanScheduleIndexLabel = getLoanScheduleIndexLabel(loan, t)
    const loanScheduleAmountLabel = getLoanScheduleAmountLabel(loan, t)

    const openLinkedSaleDetails = () => {
        if (!loan.saleId) {
            return
        }

        setPendingSaleDetailsId(loan.saleId)
        navigate('/sales')
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Link href={modulePath} className="hover:text-foreground inline-flex items-center gap-1">
                        <ArrowLeft className="w-4 h-4" />
                        {moduleTitle}
                    </Link>
                    <span>/</span>
                    <LoanNoDisplay loanNo={loan.loanNo} className="text-foreground" />
                </div>
                <div className="flex items-center gap-2">
                    {canOpenLinkedSale && (
                        <Button variant="outline" allowViewer={true} onClick={openLinkedSaleDetails} className="gap-2 print:hidden">
                            <Receipt className="w-4 h-4" />
                            {t('loans.openLinkedSale', { defaultValue: 'Open Sale Details' })}
                        </Button>
                    )}
                    <Button variant="outline" allowViewer={true} onClick={() => setShowWhatsAppModal(true)} className="gap-2 text-emerald-600 border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-300 dark:border-emerald-800 dark:hover:bg-emerald-500/10">
                        <MessageCircle className="w-4 h-4" />
                    </Button>
                    <Button variant="outline" allowViewer={true} onClick={() => setShowPrintPreview(true)} className="gap-2 print:hidden">
                        <Printer className="w-4 h-4" />
                        {t('common.print') || 'Print'}
                    </Button>
                    {!isReadOnly && canDeleteCurrentLoan && (
                        <Button variant="destructive" onClick={() => setDeleteOpen(true)} className="gap-2 print:hidden">
                            <Trash2 className="w-4 h-4" />
                            {t('common.delete') || 'Delete'}
                        </Button>
                    )}
                    {!isReadOnly && (
                        <Button onClick={() => onOpenPayment(loan)} className="print:hidden">
                            {getLoanRecordPaymentLabel(loan, t)}
                        </Button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>{getLoanIdentityTitle(loan, t)}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <div className="font-semibold text-lg">{loan.borrowerName}</div>
                            {getLoanLinkedPartySummary(loan, t) ? (
                                <div className="text-xs font-bold uppercase tracking-wide text-primary">{getLoanLinkedPartySummary(loan, t)}</div>
                            ) : null}
                            <div>{loan.borrowerPhone}</div>
                            <div>{loan.borrowerAddress}</div>
                            <div className="text-muted-foreground">{loan.borrowerNationalId}</div>
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-none shadow-none bg-transparent">
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-xl font-bold">{loanSummaryTitle}</CardTitle>
                            <span className="px-2 py-0.5 rounded-md bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider">
                                {t('loans.principalOnly') || 'Principal Only'}
                            </span>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {/* Main Principal Card */}
                            <div className="bg-muted/30 rounded-2xl p-6 relative overflow-hidden group border border-border/40 text-center">
                                <div className="relative z-10">
                                    <div className="text-sm text-muted-foreground font-medium mb-1">{t('loans.totalPrincipal') || 'Total Principal'}</div>
                                    <div className="text-4xl font-black tracking-tight tracking-tighter">
                                        {formatCurrency(loan.principalAmount, loan.settlementCurrency, features.iqd_display_preference)}
                                    </div>
                                </div>
                            </div>

                            {/* Stats Grid */}
                            <div className="grid grid-cols-2 gap-4 text-center">
                                <div className="bg-muted/20 rounded-2xl p-5 border border-border/40">
                                    <div className="text-[11px] text-muted-foreground font-bold uppercase tracking-wider mb-2">{t('loans.totalRepaid') || 'Total Repaid'}</div>
                                    <div className="text-2xl font-bold text-emerald-500">
                                        {formatCurrency(loan.totalPaidAmount, loan.settlementCurrency, features.iqd_display_preference)}
                                    </div>
                                </div>
                                <div className="bg-muted/20 rounded-2xl p-5 border border-border/40">
                                    <div className="text-[11px] text-muted-foreground font-bold uppercase tracking-wider mb-2">{t('loans.balanceDue') || 'Balance Due'}</div>
                                    <div className="text-2xl font-bold text-blue-500">
                                        {formatCurrency(loan.balanceAmount, loan.settlementCurrency, features.iqd_display_preference)}
                                    </div>
                                </div>
                            </div>

                            {/* Bottom Progress Section */}
                            <div className="pt-2 space-y-2">
                                <div className="w-full bg-muted/40 h-1.5 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-emerald-500 transition-all duration-500 ease-out shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                                        style={{ width: `${paidPercent}%` }}
                                    />
                                </div>
                                <div className="text-[10px] font-bold text-muted-foreground/80 uppercase tracking-widest text-center">
                                    {Math.round(paidPercent)}% {t('loans.completedStep') || 'Repayment Completed'}
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>{t('loans.recentActivity') || 'Recent Activity'}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="relative ps-4 space-y-6 before:absolute before:start-0 before:top-2 before:bottom-2 before:w-0.5 before:bg-border/60">
                                {activityRows.slice(0, 8).map(row => {
                                    const isDisbursement = row.id.includes('created');
                                    return (
                                        <div key={row.id} className="relative group">
                                            {/* Timeline Node */}
                                            <div className={cn(
                                                "absolute -start-[1.375rem] top-1.5 w-3 h-3 rounded-full border-2 border-background z-10 transition-transform group-hover:scale-125",
                                                isDisbursement ? "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]" : "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"
                                            )} />

                                            <div className="space-y-0.5">
                                                <div className="font-bold text-sm leading-none transition-colors group-hover:text-primary">
                                                    {row.label}
                                                </div>
                                                <div className="text-muted-foreground text-xs font-medium flex items-center gap-1.5 pt-1">
                                                    <span>{formatDate(row.date)}</span>
                                                    <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                                                    <span className="font-bold text-foreground/80">
                                                        {formatCurrency(row.amount, loan.settlementCurrency, features.iqd_display_preference)}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <Card className="lg:col-span-2">
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle>{loanScheduleTitle}</CardTitle>
                        <div className="hidden md:flex items-center bg-muted/30 p-1 rounded-lg border border-border/40">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewMode('table')}
                                className={cn(
                                    "h-7 px-3 font-bold uppercase text-[9px] flex items-center gap-1.5 transition-all",
                                    viewMode === 'table'
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <List className="w-3 h-3" />
                                {t('loans.view.table')}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewMode('grid')}
                                className={cn(
                                    "h-7 px-3 font-bold uppercase text-[9px] flex items-center gap-1.5 transition-all",
                                    viewMode === 'grid'
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <LayoutGrid className="w-3 h-3" />
                                {t('loans.view.grid')}
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="rounded-md border overflow-hidden">
                            {(isMobile() || viewMode === 'grid') ? (
                                <div className={cn(
                                    "grid gap-4 p-4 bg-muted/5",
                                    viewMode === 'grid' && !isMobile() ? "grid-cols-2" : "grid-cols-1"
                                )}>
                                    {installments.length === 0 ? (
                                        <div className="text-center text-muted-foreground py-10 bg-background rounded-lg border">
                                            {t('common.noData') || 'No data'}
                                        </div>
                                    ) : installments.map((item: LoanInstallment) => (
                                        <div
                                            key={item.id}
                                            className="p-4 border shadow-sm space-y-4 bg-background rounded-2xl border-border"
                                        >
                                            <div className="flex justify-between items-center">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                                                        {getLoanScheduleItemLabel(loan, item.installmentNo, t)}
                                                    </span>
                                                    <span className="text-sm font-bold text-foreground">
                                                        {formatDate(item.dueDate)}
                                                    </span>
                                                </div>
                                                <span className={cn('inline-flex px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider', statusClass(item.status === 'unpaid' ? 'active' : item.status))}>
                                                    {t(`loans.installmentStatuses.${item.status}`) || item.status}
                                                </span>
                                            </div>

                                            <div className="grid grid-cols-3 gap-2 py-3 border-y border-border/50">
                                                <div className="text-center">
                                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{loanScheduleAmountLabel}</div>
                                                    <div className="text-[11px] font-bold">{formatCurrency(item.plannedAmount, loan.settlementCurrency, features.iqd_display_preference)}</div>
                                                </div>
                                                <div className="text-center border-x border-border/50">
                                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('loans.paid') || 'Paid'}</div>
                                                    <div className="text-[11px] font-bold text-emerald-600">{formatCurrency(item.paidAmount, loan.settlementCurrency, features.iqd_display_preference)}</div>
                                                </div>
                                                <div className="text-center">
                                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('loans.balance') || 'Balance'}</div>
                                                    <div className="text-[11px] font-bold text-primary">{formatCurrency(item.balanceAmount, loan.settlementCurrency, features.iqd_display_preference)}</div>
                                                </div>
                                            </div>

                                            {!isReadOnly && item.balanceAmount > 0 && (
                                                <div className="pt-1">
                                                    <Button
                                                        variant="secondary"
                                                        className="w-full h-9 rounded-xl font-bold gap-2 text-xs"
                                                        onClick={() => onOpenPayment(loan, item)}
                                                    >
                                                        {t('loans.pay') || 'Pay'}
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="text-start">{loanScheduleIndexLabel}</TableHead>
                                            <TableHead>{t('loans.dueDate') || 'Due Date'}</TableHead>
                                            <TableHead className="text-end">{loanScheduleAmountLabel}</TableHead>
                                            <TableHead className="text-end">{t('loans.paid') || 'Paid'}</TableHead>
                                            <TableHead className="text-end">{t('loans.balance') || 'Balance'}</TableHead>
                                            <TableHead>{t('loans.status') || 'Status'}</TableHead>
                                            <TableHead className="text-end print:hidden">{t('common.actions') || 'Actions'}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {installments.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                                                    {t('common.noData') || 'No data'}
                                                </TableCell>
                                            </TableRow>
                                        ) : installments.map((item: LoanInstallment) => (
                                            <TableRow key={item.id}>
                                                <TableCell>{getLoanScheduleItemLabel(loan, item.installmentNo, t)}</TableCell>
                                                <TableCell>{formatDate(item.dueDate)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(item.plannedAmount, loan.settlementCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell className="text-end text-emerald-500">{formatCurrency(item.paidAmount, loan.settlementCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell className="text-end font-semibold">{formatCurrency(item.balanceAmount, loan.settlementCurrency, features.iqd_display_preference)}</TableCell>
                                                <TableCell>
                                                    <span className={cn('inline-flex px-2 py-0.5 rounded-full text-xs font-medium', statusClass(item.status === 'unpaid' ? 'active' : item.status))}>
                                                        {t(`loans.installmentStatuses.${item.status}`) || item.status}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-end print:hidden">
                                                    {!isReadOnly && item.balanceAmount > 0 && (
                                                        <Button variant="ghost" size="sm" onClick={() => onOpenPayment(loan, item)}>
                                                            {t('loans.pay') || 'Pay'}
                                                        </Button>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <DeleteConfirmationModal
                isOpen={deleteOpen}
                onClose={() => {
                    if (isDeletingLoan) return
                    setDeleteOpen(false)
                }}
                onConfirm={confirmDeleteLoan}
                itemName={loan.loanNo}
                isLoading={isDeletingLoan}
                title={t('loans.confirmDelete')}
                description={getLoanDeleteWarning(loan, t)}
            />
            <PrintPreviewModal
                isOpen={showPrintPreview}
                onClose={() => setShowPrintPreview(false)}
                onConfirm={() => setShowPrintPreview(false)}
                title={loanDetailsTitle}
                features={features}
                workspaceName={workspaceName}
                invoiceData={loanDetailsInvoiceData || undefined}
                pdfBuilder={buildLoanDetailsPdf}
                printTemplate={loan ? ({ effectiveId }) => renderLoanDetailsTemplate(effectiveId) : undefined}
            />

            <WhatsAppNumberInputModal
                isOpen={showWhatsAppModal}
                onClose={() => setShowWhatsAppModal(false)}
                onConfirm={handleWhatsAppConfirm}
            />
        </div>
    )
}

export function Loans() {
    const { user } = useAuth()
    const [detailMatch, params] = useRoute('/loans/:loanId')
    const { openLoanPayment } = useLoanPaymentModal()
    const workspaceId = user?.workspaceId

    const openPaymentForLoan = (loan: Loan, installment?: LoanInstallment | null) => {
        openLoanPayment(loan.id, {
            installmentId: installment?.id ?? null
        })
    }

    if (!workspaceId) {
        return null
    }

    if (detailMatch && params?.loanId) {
        return (
            <LoanDetailsView
                workspaceId={workspaceId}
                loanId={params.loanId}
                onOpenPayment={openPaymentForLoan}
            />
        )
    }

    return <SimpleLoanListView workspaceId={workspaceId} />
}

export function Installments() {
    const { user } = useAuth()
    const [detailMatch, params] = useRoute('/installments/:loanId')
    const { openLoanPayment } = useLoanPaymentModal()
    const workspaceId = user?.workspaceId

    const openPaymentForLoan = (loan: Loan, installment?: LoanInstallment | null) => {
        openLoanPayment(loan.id, {
            installmentId: installment?.id ?? null
        })
    }

    if (!workspaceId) {
        return null
    }

    if (detailMatch && params?.loanId) {
        return (
            <LoanDetailsView
                workspaceId={workspaceId}
                loanId={params.loanId}
                onOpenPayment={openPaymentForLoan}
            />
        )
    }

    return <LoanListView workspaceId={workspaceId} />
}
