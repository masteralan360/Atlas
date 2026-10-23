import { useMemo, useRef, useState } from 'react'
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { usePaginationState, usePaginationBounds } from '@/hooks/usePaginationState'
import { directTransactionReversalState, type DirectTransactionPageRow } from '@/local-db/directTransactions'
import { useDirectTransactionsPage } from '@/local-db/directTransactionHooks'
import { DIRECT_TRANSACTION_PAGE_SIZES, readDirectTransactionPageSize, saveDirectTransactionPageSize } from '@/ui/components/payments/directTransactionPageSize'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { ArrowDownLeft, ArrowUpRight, Plus, Printer, RotateCcw, Search, Loader2, UserRound, Users } from 'lucide-react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import {
    getPaymentTransactionRoutePath,
    loadDirectTransactionVoucher,
    recordDirectTransaction,
    reversePaymentTransaction,
    useWorkspaceContacts,
    type PaymentTransaction,
    type RecordDirectTransactionInput
} from '@/local-db'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { Input } from '@/ui/components/input'
import {
  AppPagination,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/ui/components'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { DateRangeBadge } from '@/ui/components/DateRangeBadge'
import { DirectTransactionDialog } from '@/ui/components/payments/DirectTransactionDialog'
import { DirectTransactionVoucherPrintTemplate, type DirectTransactionVoucherData } from '@/ui/components/payments/DirectTransactionVoucherPrintTemplate'
import { PaymentReversalDialog, type PaymentReversalDialogInput } from '@/ui/components/payments/PaymentReversalDialog'
import { PrintFlow } from '@/ui/components/PrintFlow'
import { formatDirectTransactionVoucherNumber } from '@/lib/directTransactionVoucher'
import type { TemplatePreview } from '@/lib/printPreviewEditorStore'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { saveDirectTransactionVoucherPdf } from '@/services/directTransactionVoucherSave'
import { useWorkspace } from '@/workspace/WorkspaceContext'

type DirectionFilter = 'all' | 'incoming' | 'outgoing'
const DIRECT_FRESHNESS_TABLES = ['payment_transactions']
const DIRECT_COLUMNS: ColumnDef<DirectTransactionPageRow>[] = [
    { id: 'paidAt', accessorFn: row => row.transaction.paidAt },
    { id: 'createdAt', accessorFn: row => row.transaction.createdAt },
    { id: 'id', accessorFn: row => row.transaction.id },
]


function paymentMethodLabel(value: PaymentTransaction['paymentMethod'], t: any) {
    switch (value) {
        case 'bank_transfer':
            return t('directTransactions.paymentMethod.bankTransfer', { defaultValue: 'Bank Transfer' })
        case 'loan_adjustment':
            return t('directTransactions.paymentMethod.loanAdjustment', { defaultValue: 'Loan Adjustment' })
        case 'qicard':
            return t('directTransactions.paymentMethod.qicard', { defaultValue: 'QiCard' })
        case 'zaincash':
            return t('directTransactions.paymentMethod.zaincash', { defaultValue: 'ZainCash' })
        case 'fastpay':
            return t('directTransactions.paymentMethod.fastpay', { defaultValue: 'FastPay' })
        case 'fib':
            return t('directTransactions.paymentMethod.fib', { defaultValue: 'FIB' })
        case 'cash':
            return t('directTransactions.paymentMethod.cash', { defaultValue: 'Cash' })
        default:
            return value.charAt(0).toUpperCase() + value.slice(1).replace('_', ' ')
    }
}

export function DirectTransactions() {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { toast } = useToast()
    const { features, workspaceName } = useWorkspace()
    const { dateRange, customDates } = useDateRange()
    const [, setLocation] = useLocation()
    const workspaceId = user?.workspaceId
    const hasPaymentsSurface = features.loans || features.crm || features.budget || features.hr || features.agents

    const submitLock = useRef(false)
    const [search, setSearch] = useState('')
    const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all')
    const [isDirectDialogOpen, setIsDirectDialogOpen] = useState(false)
    const [isSubmittingDirectTransaction, setIsSubmittingDirectTransaction] = useState(false)
    const [reversingTransactionId, setReversingTransactionId] = useState<string | null>(null)
    const [transactionToReverse, setTransactionToReverse] = useState<PaymentTransaction | null>(null)
    const [voucherData, setVoucherData] = useState<DirectTransactionVoucherData | null>(null)
    const [preparingPrintId, setPreparingPrintId] = useState<string | null>(null)
    const printLang = features.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const workspaceContacts = useWorkspaceContacts(workspaceId)
    const printContactLine = useMemo(() => (['phone', 'email', 'address'] as const)
        .map(type => workspaceContacts.find(contact => contact.type === type && contact.isPrimary)
            || workspaceContacts.find(contact => contact.type === type))
        .map(contact => contact?.value.trim())
        .filter(Boolean)
        .join(' · '), [workspaceContacts])
    const voucherPreview = useMemo<TemplatePreview | undefined>(() => voucherData ? {
        fields: [],
        page: { widthMm: 210, heightMm: 297 },
        createElement: (_fields, _effectiveId, printLangOverride) => <DirectTransactionVoucherPrintTemplate
            data={voucherData}
            workspaceName={workspaceName || workspaceId || 'Atlas'}
            logoUrl={features.logo_url}
            contactLine={printContactLine}
            printLang={printLangOverride || printLang}
            iqdPreference={features.iqd_display_preference}
        />,
        buildPdf: (element, printLangOverride) => generateTemplatePdf({
            element, format: 'a4', printLang: printLangOverride || printLang
        })
    } : undefined, [features.iqd_display_preference, features.logo_url, printContactLine, printLang, voucherData, workspaceId, workspaceName])

    const dateBounds = getDateRangeBounds(dateRange, customDates)
    const pagination = usePaginationState({ resetOn: [workspaceId, search, directionFilter, dateBounds.start?.toISOString(), dateBounds.end?.toISOString()],
        initialPageSize: readDirectTransactionPageSize('direct_transactions_page_size'),
        onPageSizeChange: size => saveDirectTransactionPageSize('direct_transactions_page_size', size) })
    const page = useDirectTransactionsPage(workspaceId, { page: pagination.currentPage, pageSize: pagination.pageSize,
        search, direction: directionFilter, start: dateBounds.start?.toISOString(), end: dateBounds.end?.toISOString() })
    const bounds = usePaginationBounds({ currentPage: pagination.currentPage, setCurrentPage: pagination.setCurrentPage,
        totalCount: page.data?.totalCount, pageSize: pagination.pageSize, isLoading: page.isLoading, error: page.error })
    const table = useReactTable({ data: page.data?.items ?? [], columns: DIRECT_COLUMNS,
        getRowId: row => row.transaction.id, getCoreRowModel: getCoreRowModel(),
        manualPagination: true, manualFiltering: true, manualSorting: true, rowCount: page.data?.totalCount ?? 0,
        state: { pagination: { pageIndex: bounds.currentPage - 1, pageSize: pagination.pageSize }, globalFilter: search,
            sorting: [{ id: 'paidAt', desc: true }, { id: 'createdAt', desc: true }, { id: 'id', desc: true }] },
        onPaginationChange: updater => {
            const next = typeof updater === 'function' ? updater({ pageIndex: bounds.currentPage - 1, pageSize: pagination.pageSize }) : updater
            if (next.pageSize !== pagination.pageSize) pagination.setPageSize(next.pageSize)
            else pagination.setCurrentPage(next.pageIndex + 1)
        } })
    const visibleDirectTransactions = table.getRowModel().rows.map(row => row.original)
    const reverseRow = page.data?.items.find(row => row.transaction.id === transactionToReverse?.id)
    const handleCreateDirectTransaction = async (input: RecordDirectTransactionInput) => {
        if (!workspaceId || submitLock.current) {
            return
        }
        submitLock.current = true
        setIsSubmittingDirectTransaction(true)
        try {
            await recordDirectTransaction(workspaceId, {
                ...input,
                createdBy: user?.id || null
            })
            toast({ title: t('directTransactions.recorded', { defaultValue: 'Direct transaction recorded' }) })
            setIsDirectDialogOpen(false)
        } catch (error: unknown) {
            console.error('[DirectTransactions] Payment action failed:', error)
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('directTransactions.recordFailed'),
                variant: 'destructive'
            })
        } finally {
            submitLock.current = false
            setIsSubmittingDirectTransaction(false)
        }
    }

    const handleReverse = async (input: PaymentReversalDialogInput) => {
        if (!workspaceId || !transactionToReverse || reversingTransactionId) {
            return
        }

        setReversingTransactionId(transactionToReverse.id)
        try {
            await reversePaymentTransaction(workspaceId, transactionToReverse.id, {
                ...input,
                createdBy: user?.id || null
            })
            toast({ title: t('directTransactions.reversed', { defaultValue: 'Transaction reversed' }) })
            setTransactionToReverse(null)
        } catch (error: unknown) {
            console.error('[DirectTransactions] Reversal failed:', error)
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('directTransactions.reverseFailed'),
                variant: 'destructive'
            })
        } finally {
            setReversingTransactionId(null)
        }
    }

    const handlePrint = async (transactionId: string) => {
        if (!workspaceId || preparingPrintId) return
        setPreparingPrintId(transactionId)
        try {
            setVoucherData(await loadDirectTransactionVoucher(workspaceId, transactionId))
        } catch (error) {
            const needsSync = error instanceof Error && error.message.includes('synchronization')
            toast({
                title: t('common.error'),
                description: t(needsSync ? 'directTransactions.printWaitForSync' : 'directTransactions.printFailed'),
                variant: 'destructive'
            })
        } finally {
            setPreparingPrintId(null)
        }
    }

    if (!hasPaymentsSurface) {
        return (
            <div className="p-6">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('directTransactions.notAvailable', { defaultValue: 'Direct Transactions is not available in this workspace' })}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        {t('directTransactions.enableModules', { defaultValue: 'Enable Loans, CRM, Accounting and Expenses, or HR to use the central payments surface.' })}
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="space-y-3">
                    <h1 className="flex flex-wrap items-center gap-3 text-3xl font-bold tracking-tight">
                        {t('directTransactions.title', { defaultValue: 'Direct Transactions' })}
                        <DateRangeBadge />
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t('directTransactions.subtitle', { defaultValue: 'Manual incoming and outgoing money for activity outside the tracked modules. Payroll stays out of this page.' })} <ModulePageFreshness className="ms-2" tableNames={DIRECT_FRESHNESS_TABLES} />
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <Button type="button" variant="outline" onClick={() => setLocation('/payments')} className="w-fit">
                            {t('payments.title', { defaultValue: 'Payments' })}
                        </Button>
                        <Button type="button" onClick={() => setIsDirectDialogOpen(true)} className="w-fit">
                            <Plus className="mr-2 h-4 w-4" />
                            {t('directTransactions.newTransaction', { defaultValue: 'New Direct Transaction' })}
                        </Button>
                    </div>
                </div>
            </div>

            <Card>
                <CardContent className="pt-6">
                    <div className="space-y-3">
                        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_180px_auto]">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                                <Input
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder={t('directTransactions.searchPlaceholder', { defaultValue: 'Search direct transactions' })}
                                    className="pl-9"
                                />
                            </div>
                            <Select value={directionFilter} onValueChange={(value: DirectionFilter) => setDirectionFilter(value)}>
                                <SelectTrigger>
                                    <SelectValue placeholder={t('directTransactions.filters.direction', { defaultValue: 'Direction' })} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">{t('directTransactions.filters.allDirections', { defaultValue: 'All Directions' })}</SelectItem>
                                    <SelectItem value="incoming">{t('directTransactions.filters.incoming', { defaultValue: 'Incoming' })}</SelectItem>
                                    <SelectItem value="outgoing">{t('directTransactions.filters.outgoing', { defaultValue: 'Outgoing' })}</SelectItem>
                                </SelectContent>
                            </Select>
                            {(search.trim() || directionFilter !== 'all') ? (
                                <Button type="button" variant="ghost" onClick={() => {
                                    setSearch('')
                                    setDirectionFilter('all')
                                }} className="justify-self-start lg:justify-self-end">
                                    <RotateCcw className="mr-2 h-4 w-4" />
                                    {t('directTransactions.clearFilters', { defaultValue: 'Clear Filters' })}
                                </Button>
                            ) : null}
                        </div>
                        <DateRangeFilters />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-col gap-3 space-y-0">
                    <div className="space-y-1">
                        <CardTitle>{t('directTransactions.title', { defaultValue: 'Direct Transactions' })}</CardTitle>
                        <p className="text-sm text-muted-foreground">
                            {t('directTransactions.tableSubtitle', { defaultValue: 'Posted direct transactions stay separate from tracked module settlements but still support reversals.' })}
                        </p>
                    </div>
                    <div className="text-sm text-muted-foreground">
                        {t('directTransactions.matchingEntries', { count: page.data?.totalCount ?? 0, defaultValue: '{{count}} matching entries' })}
                    </div>
                    <AppPagination currentPage={bounds.currentPage} pageCount={bounds.pageCount} totalCount={page.data?.totalCount ?? 0}
                        pageSize={pagination.pageSize} onPageChange={pageNumber => table.setPageIndex(pageNumber - 1)}
                        onPageSizeChange={size => table.setPageSize(size)} pageSizeOptions={DIRECT_TRANSACTION_PAGE_SIZES} />
                </CardHeader>
                <CardContent className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('directTransactions.table.time', { defaultValue: 'Time' })}</TableHead>
                                <TableHead>{t('directTransactions.voucher.reference')}</TableHead>
                                <TableHead>{t('directTransactions.table.reason', { defaultValue: 'Reason' })}</TableHead>
                                <TableHead>{t('directTransactions.table.counterparty', { defaultValue: 'Counterparty' })}</TableHead>
                                <TableHead>{t('directTransactions.table.linked', { defaultValue: 'Linked' })}</TableHead>
                                <TableHead>{t('directTransactions.table.direction', { defaultValue: 'Direction' })}</TableHead>
                                <TableHead>{t('directTransactions.table.amount', { defaultValue: 'Amount' })}</TableHead>
                                <TableHead>{t('directTransactions.table.method', { defaultValue: 'Method' })}</TableHead>
                                <TableHead>{t('directTransactions.table.note', { defaultValue: 'Note' })}</TableHead>
                                <TableHead>{t('directTransactions.table.status', { defaultValue: 'Status' })}</TableHead>
                                <TableHead className="text-right">{t('directTransactions.table.actions', { defaultValue: 'Actions' })}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {page.isLoading ? <TableRow><TableCell colSpan={11} className="py-16 text-center">
                                <div role="status" className="flex items-center justify-center gap-2 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{t('common.loading')}</div>
                            </TableCell></TableRow> : page.error ? <TableRow><TableCell colSpan={11} className="py-12 text-center">
                                <p role="alert">{t('directTransactions.loadFailed')}</p><Button type="button" variant="outline" onClick={() => void page.refetch()}>{t('directTransactionModal.counterparties.retry')}</Button>
                            </TableCell></TableRow> : visibleDirectTransactions.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={11} className="py-12 text-center text-muted-foreground">
                                        {t('directTransactions.noMatch', { defaultValue: 'No direct transactions match the current filters.' })}
                                    </TableCell>
                                </TableRow>
                            ) : visibleDirectTransactions.map((row) => {
                                const item = row.transaction
                                const isReversal = !!item.reversalOfTransactionId
                                const reversalState = isReversal ? null : directTransactionReversalState(row)
                                const isReversed = reversalState?.status === 'fully_reversed'
                                const isPartiallyReversed = reversalState?.status === 'partially_reversed'
                                const canReverse = row.canReverse
                                const displayAmount = isReversal
                                    ? (item.direction === 'incoming' ? item.amount : -item.amount)
                                    : item.amount

                                return (
                                    <TableRow key={item.id}>
                                        <TableCell>{formatDateTime(item.paidAt)}</TableCell>
                                        <TableCell className="font-mono text-xs">{formatDirectTransactionVoucherNumber(item)}</TableCell>
                                        <TableCell className="font-medium">{item.referenceLabel || t('directTransactions.defaultReason', { defaultValue: 'Direct transaction' })}</TableCell>
                                        <TableCell>{item.counterpartyName || '-'}</TableCell>
                                        <TableCell>
                                            <Badge variant="outline">{row.counterpartyKind === 'agent' ? <UserRound className="me-1 h-3 w-3" /> : <Users className="me-1 h-3 w-3" />}
                                                {row.counterpartyKind === 'agent' ? t('agents.agent') : row.counterpartyKind === 'business_partner'
                                                    ? t('directTransactions.businessPartnerLink') : t('directTransactions.external')}</Badge>
                                            {row.counterpartyKind === 'agent' && page.scope.agents && typeof item.metadata?.businessPartnerId === 'string' ? (
                                                <Button type="button" variant="link" size="sm" onClick={() => setLocation('/agents/' + item.metadata!.businessPartnerId)}>{t('agents.viewProfile')}</Button>
                                            ) : null}
                                        </TableCell>
                                        <TableCell>
                                            <span className={cn(
                                                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                isReversal
                                                    ? 'border-violet-200 bg-violet-50 text-violet-700'
                                                    : item.direction === 'incoming'
                                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                        : 'border-amber-200 bg-amber-50 text-amber-700'
                                            )}>
                                                {isReversal ? <RotateCcw className="h-3 w-3" /> : item.direction === 'incoming' ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                                                {isReversal
                                                    ? item.direction === 'incoming'
                                                        ? t('paymentReversal.cashReturned', { defaultValue: 'Cash returned' })
                                                        : t('paymentReversal.cashRestored', { defaultValue: 'Cash restored' })
                                                    : item.direction === 'incoming'
                                                        ? t('directTransactions.filters.incoming', { defaultValue: 'Incoming' })
                                                        : t('directTransactions.filters.outgoing', { defaultValue: 'Outgoing' })}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            {displayAmount < 0 ? '-' : ''}
                                            {formatCurrency(Math.abs(displayAmount), item.currency, features.iqd_display_preference)}
                                        </TableCell>
                                        <TableCell>{paymentMethodLabel(item.paymentMethod, t)}</TableCell>
                                        <TableCell className="max-w-[240px] truncate">{item.note || '-'}</TableCell>
                                        <TableCell>
                                            <span className={cn(
                                                'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                                                isReversal
                                                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                                                    : isPartiallyReversed
                                                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                                                    : isReversed
                                                        ? 'border-slate-200 bg-slate-50 text-slate-700'
                                                        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                            )}>
                                                {isReversal 
                                                    ? t('directTransactions.status.reversal', { defaultValue: 'Reversal' }) 
                                                    : isPartiallyReversed
                                                        ? t('payments.status.partialReversal', { defaultValue: 'Partially reversed' })
                                                    : isReversed
                                                        ? t('directTransactions.status.reversed', { defaultValue: 'Reversed' }) 
                                                        : t('directTransactions.status.posted', { defaultValue: 'Posted' })}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex justify-end gap-2">
                                                <Button variant="outline" size="sm" onClick={() => void handlePrint(item.id)} disabled={!!preparingPrintId}>
                                                    <Printer className="mr-1 h-3.5 w-3.5" />
                                                    {preparingPrintId === item.id ? t('common.loading') : t('directTransactions.print')}
                                                </Button>
                                                <Button variant="outline" size="sm" onClick={() => setLocation(getPaymentTransactionRoutePath(item))}>
                                                    {t('common.view', { defaultValue: 'View' })}
                                                </Button>
                                                {canReverse ? (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => setTransactionToReverse(item)}
                                                        disabled={reversingTransactionId === item.id}
                                                    >
                                                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                                                        {t('common.reverse', { defaultValue: 'Reverse' })}
                                                    </Button>
                                                ) : null}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                )
                            })}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {workspaceId ? (
                <DirectTransactionDialog
                    open={isDirectDialogOpen}
                    onOpenChange={setIsDirectDialogOpen}
                    workspaceId={workspaceId}
                    isSubmitting={isSubmittingDirectTransaction}
                    onSubmit={handleCreateDirectTransaction}
                />
            ) : null}

            <PaymentReversalDialog
                open={!!transactionToReverse}
                onOpenChange={(open) => {
                    if (!open) {
                        setTransactionToReverse(null)
                    }
                }}
                onSubmit={handleReverse}
                isProcessing={reversingTransactionId === transactionToReverse?.id}
                transaction={transactionToReverse}
                reversalState={reverseRow ? directTransactionReversalState(reverseRow) : null}
                workspaceId={workspaceId}
                iqdPreference={features.iqd_display_preference}
            />
            {voucherData && voucherPreview ? <PrintFlow
                module="directTransaction"
                isOpen
                onClose={() => setVoucherData(null)}
                onConfirm={() => setVoucherData(null)}
                title={t(voucherData.transaction.reversalOfTransactionId
                    ? 'directTransactions.voucher.reversalTitle'
                    : voucherData.transaction.direction === 'incoming'
                        ? 'directTransactions.voucher.receiptTitle'
                        : 'directTransactions.voucher.paymentTitle')}
                features={features}
                workspaceName={workspaceName}
                originId={voucherData.transaction.id}
                showSaveButton={false}
                allowA4Document
                templatePrimaryActionLabel={t('print.printAndSave')}
                templatePreview={voucherPreview}
                pdfBuilder={async ({ effectiveId, printLangOverride }) => voucherPreview.buildPdf(
                    voucherPreview.createElement({}, effectiveId, printLangOverride), printLangOverride
                )}
                onPreviewPrint={blob => printPdfBlob(blob, { title: formatDirectTransactionVoucherNumber(voucherData.transaction) })}
                onPreviewSave={async blob => {
                    try {
                        return await saveDirectTransactionVoucherPdf(voucherData.transaction.workspaceId, voucherData.transaction, blob, {
                            id: user?.id,
                            name: user?.name
                        })
                    } catch (error) {
                        console.error('[DirectTransactions] Failed to save voucher:', error)
                        toast({
                            title: t('common.error'),
                            description: t('directTransactions.voucher.saveFailed'),
                            variant: 'destructive'
                        })
                        throw error
                    }
                }}
            /> : null}
        </div>
    )
}
