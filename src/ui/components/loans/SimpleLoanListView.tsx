import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { Eye, LayoutGrid, List, Plus, Printer, Search, Trash2 } from 'lucide-react'

import { useAuth } from '@/auth'
import { getLoanLinkedPartySummary } from '@/lib/loanParties'
import { isMobile } from '@/lib/platform'
import { getLoanDeleteWarning, getLoanDirection, getLoanDirectionLabel, getSimpleLoanModuleTitle } from '@/lib/loanPresentation'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { deleteLoan, type Loan, useLoans } from '@/local-db'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
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
    useToast
} from '@/ui/components'
import { useWorkspace } from '@/workspace'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { CreateSimpleLoanModal } from './CreateSimpleLoanModal'
import { LoanListPrintTemplate } from './LoanPrintTemplates'
import { LoanNoDisplay } from './LoanNoDisplay'

type SimpleLoanFilter = 'all' | 'lent' | 'borrowed' | 'completed'

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
    const { features, workspaceName } = useWorkspace()
    const { user } = useAuth()
    const { toast } = useToast()
    const isReadOnly = user?.role === 'viewer'
    const [search, setSearch] = useState('')
    const [filter, setFilter] = useState<SimpleLoanFilter>('all')
    const [currentPage, setCurrentPage] = useState(1)
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('simple_loans_view_mode') as 'table' | 'grid') || 'table'
    })
    const [createOpen, setCreateOpen] = useState(false)
    const [loanToDelete, setLoanToDelete] = useState<Loan | null>(null)
    const [isDeletingLoan, setIsDeletingLoan] = useState(false)
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const pageSize = 10

    useEffect(() => {
        localStorage.setItem('simple_loans_view_mode', viewMode)
    }, [viewMode])

    const loans = useLoans(workspaceId)
    const simpleLoans = useMemo(
        () => loans.filter((loan) => loan.loanCategory === 'simple'),
        [loans]
    )

    const metrics = useMemo(() => {
        const activeLoans = simpleLoans.filter((loan) => loan.balanceAmount > 0 && loan.status !== 'completed')
        return {
            totalLent: activeLoans
                .filter((loan) => getLoanDirection(loan) === 'lent')
                .reduce((sum, loan) => sum + loan.balanceAmount, 0),
            totalBorrowed: activeLoans
                .filter((loan) => getLoanDirection(loan) === 'borrowed')
                .reduce((sum, loan) => sum + loan.balanceAmount, 0),
            activeCount: activeLoans.length,
            settledCount: simpleLoans.filter((loan) => loan.balanceAmount <= 0 || loan.status === 'completed').length
        }
    }, [simpleLoans])

    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase()
        return simpleLoans.filter((loan) => {
            const direction = getLoanDirection(loan)
            const overdue = isLoanOverdue(loan)

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
    }, [filter, search, simpleLoans, t])

    const paginated = useMemo(() => {
        const from = (currentPage - 1) * pageSize
        return filtered.slice(from, from + pageSize)
    }, [filtered, currentPage])
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
            displayCurrency={features.default_currency}
            iqdPreference={features.iqd_display_preference}
            metrics={{
                totalLent: metrics.totalLent,
                totalBorrowed: metrics.totalBorrowed,
                activeEntries: metrics.activeCount,
                settledEntries: metrics.settledCount
            }}
            logoUrl={features.logo_url}
            qrValue={effectiveId ? buildQrValue(effectiveId) : undefined}
        />
    ), [buildQrValue, features.default_currency, features.iqd_display_preference, features.logo_url, filter, filtered, metrics.activeCount, metrics.settledCount, metrics.totalBorrowed, metrics.totalLent, printLang, workspaceName])
    const buildSimpleLoanListPdf = useCallback(async ({ format, effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        return generateTemplatePdf({
            element: renderSimpleLoanListTemplate(effectiveId),
            format,
            printLang,
            printQuality: features.print_quality
        })
    }, [features.print_quality, printLang, renderSimpleLoanListTemplate])
    const simpleLoanListInvoiceData = useMemo(() => ({
        totalAmount: metrics.totalLent + metrics.totalBorrowed,
        settlementCurrency: features.default_currency,
        origin: 'Loans' as const,
        createdByName: user?.name || 'Unknown',
        cashierName: user?.name || 'Unknown',
        printFormat: 'a4' as const
    }), [features.default_currency, metrics.totalBorrowed, metrics.totalLent, user?.name])

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
                description: error?.message || (t('loans.messages.loanDeleteFailed') || 'Failed to delete loan.'),
                variant: 'destructive'
            })
        } finally {
            setIsDeletingLoan(false)
        }
    }

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.totalLent', { defaultValue: 'Total Lent' })}</div>
                        <div className="text-2xl font-bold">{formatCurrency(metrics.totalLent, features.default_currency, features.iqd_display_preference)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.totalBorrowed', { defaultValue: 'Total Borrowed' })}</div>
                        <div className="text-2xl font-bold">{formatCurrency(metrics.totalBorrowed, features.default_currency, features.iqd_display_preference)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.activeEntries', { defaultValue: 'Active Entries' })}</div>
                        <div className="text-2xl font-bold">{metrics.activeCount}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground mb-1">{t('loans.settledEntries', { defaultValue: 'Settled Entries' })}</div>
                        <div className="text-2xl font-bold">{metrics.settledCount}</div>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardContent className="space-y-4 pt-6">
                    <div className="flex flex-col gap-3 lg:flex-row">
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
                                {t('loans.view.table') || 'Loans Details'}
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
                                {t('loans.view.grid') || 'Loans Grid'}
                            </Button>
                        </div>
                        <div className="flex items-center gap-1 rounded-md bg-muted/30 p-1">
                            {(['all', 'lent', 'borrowed', 'completed'] as SimpleLoanFilter[]).map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => {
                                        setCurrentPage(1)
                                        setFilter(value)
                                    }}
                                    className={cn(
                                        'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                                        filter === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background'
                                    )}
                                >
                                    {value === 'lent' || value === 'borrowed'
                                        ? getLoanDirectionLabel(value, t)
                                        : (t(`loans.filters.${value}`) || value)}
                                </button>
                            ))}
                        </div>
                        <Button variant="outline" allowViewer={true} onClick={() => setShowPrintPreview(true)} className="gap-2 print:hidden">
                            <Printer className="h-4 w-4" />
                            {t('common.print') || 'Print'}
                        </Button>
                        {!isReadOnly ? (
                            <Button onClick={() => setCreateOpen(true)} className="gap-2 print:hidden">
                                <Plus className="h-4 w-4" />
                                {t('loans.createSimpleLoan', { defaultValue: 'Create Simple Loan' })}
                            </Button>
                        ) : null}
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
                                    <div
                                        key={loan.id}
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
                                                {!isReadOnly ? (
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
                                        <TableHead className="text-end">{t('common.actions') || 'Actions'}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {paginated.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                                                {t('common.noData') || 'No data'}
                                            </TableCell>
                                        </TableRow>
                                    ) : paginated.map((loan) => {
                                        const direction = getLoanDirection(loan)
                                        const overdue = isLoanOverdue(loan)
                                        return (
                                            <TableRow key={loan.id}>
                                                <TableCell>
                                                    <LoanNoDisplay loanNo={loan.loanNo} className="text-primary" />
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
                                                <TableCell className="text-end">
                                                    <div className="flex items-center justify-end gap-1">
                                                        <Button variant="ghost" size="sm" allowViewer={true} onClick={() => navigate(`/loans/${loan.id}`)}>
                                                            {t('common.view') || 'View'}
                                                        </Button>
                                                        {!isReadOnly ? (
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
                                        )
                                    })}
                                </TableBody>
                            </Table>
                            </div>
                        )}
                    </div>

                    <AppPagination
                        currentPage={currentPage}
                        totalCount={filtered.length}
                        pageSize={pageSize}
                        onPageChange={setCurrentPage}
                    />
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

            <PrintPreviewModal
                isOpen={showPrintPreview}
                onClose={() => setShowPrintPreview(false)}
                onConfirm={() => setShowPrintPreview(false)}
                title={getSimpleLoanModuleTitle(t)}
                features={features}
                workspaceName={workspaceName}
                invoiceData={simpleLoanListInvoiceData}
                pdfBuilder={buildSimpleLoanListPdf}
                printTemplate={({ effectiveId }) => renderSimpleLoanListTemplate(effectiveId)}
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
        </div>
    )
}
