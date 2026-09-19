import { useEffect, useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useLocation } from 'wouter'
import { useInvoices, type Invoice, type InvoiceVersion } from '@/local-db'
import { formatCurrency, formatDateTime, formatDate, formatOriginLabel } from '@/lib/utils'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { platformService } from '@/services/platformService'
import { getStoredLocalInvoicePdfPath } from '@/services/localInvoiceStorage'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Input,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Button,
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/ui/components'
import { FileText, Search, Eye, Upload, RefreshCw, Share2, History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useDateRange } from '@/context/DateRangeContext'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { DateRangeBadge } from '@/ui/components/DateRangeBadge'
import { r2Service } from '@/services/r2Service'
import { UploadFilesTab } from './UploadFile'
import { setPDFPreviewSource } from '@/lib/pdfPreviewStore'
import { loadInvoiceVersions } from '@/services/invoiceVersionService'
import { getReadableFileSize } from '@/components/application/file-upload/file-upload-base'
import { getWorkspaceUsageLimitMessage, isWorkspaceUsageLimitError } from '@/lib/workspaceUsage'
import { isDateInDateRange } from '@/lib/dateRangeFilters'

const UPLOAD_FILES_ROUTE = '/invoices-history/upload-files'

export function InvoicesHistory() {
    const [location, setLocation] = useLocation()
    const { user } = useAuth()
    const { invoices, refreshInvoices } = useInvoices(user?.workspaceId)
    const { features } = useWorkspace()
    const { t, i18n } = useTranslation()
    const { dateRange, customDates } = useDateRange()
    const [search, setSearch] = useState('')
    const [isLoadingPdf, setIsLoadingPdf] = useState(false)
    const [downloadError, setDownloadError] = useState<string | null>(null)
    const [versionsTarget, setVersionsTarget] = useState<Invoice | null>(null)
    const [versions, setVersions] = useState<InvoiceVersion[]>([])
    const [isLoadingVersions, setIsLoadingVersions] = useState(false)

    useEffect(() => {
        if (!versionsTarget) {
            setVersions([])
            return
        }

        let cancelled = false
        setIsLoadingVersions(true)
        loadInvoiceVersions(versionsTarget.id, versionsTarget.workspaceId)
            .then((rows) => {
                if (!cancelled) setVersions(rows)
            })
            .catch((error) => {
                console.error('[InvoicesHistory] Failed to load invoice versions:', error)
                if (!cancelled) setDownloadError(t('invoices.versionsLoadError', { defaultValue: 'Failed to load invoice versions.' }))
            })
            .finally(() => {
                if (!cancelled) setIsLoadingVersions(false)
            })

        return () => {
            cancelled = true
        }
    }, [t, versionsTarget])

    const activeTab = location === UPLOAD_FILES_ROUTE ? 'uploads' : 'history'
    const historyInvoices = useMemo(
        () => invoices.filter((invoice) => invoice.origin !== 'upload'),
        [invoices],
    )
    const uploadedFilesCount = invoices.length - historyInvoices.length

    const filteredInvoices = useMemo(() => {
        const now = new Date()
        return historyInvoices
            .filter((invoice) => {
                const normalizedSearch = search.trim().toLowerCase()
                const matchesSearch = !normalizedSearch || [
                    invoice.invoiceid,
                    invoice.sourceId,
                    invoice.origin,
                    invoice.createdByName,
                ].some((value) => value?.toLowerCase().includes(normalizedSearch))
                return matchesSearch && isDateInDateRange(invoice.createdAt, dateRange, customDates, now)
            })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }, [customDates, dateRange, historyInvoices, search])

    const getDateDisplay = () => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }

        if (dateRange === 'month') {
            return formatLocalizedMonthYear(new Date(), i18n.language)
        }

        if (dateRange === 'lastMonth') {
            const now = new Date()
            return formatLocalizedMonthYear(new Date(now.getFullYear(), now.getMonth() - 1, 1), i18n.language)
        }

        if (dateRange === 'custom') {
            if (filteredInvoices.length > 0) {
                const dates = filteredInvoices.map((invoice) => new Date(invoice.createdAt).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from') || 'From'} ${formatDate(minDate)} ${t('performance.filters.to') || 'To'} ${formatDate(maxDate)}`
            }

            if (customDates.start || customDates.end) {
                const parts = []
                if (customDates.start) parts.push(`${t('performance.filters.from') || 'From'} ${formatDate(customDates.start)}`)
                if (customDates.end) parts.push(`${t('performance.filters.to') || 'To'} ${formatDate(customDates.end)}`)
                return parts.join(' ')
            }
        }

        if (dateRange === 'allTime') {
            if (historyInvoices.length > 0) {
                const dates = historyInvoices.map((invoice) => new Date(invoice.createdAt).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from') || 'From'} ${formatDate(minDate)} ${t('performance.filters.to') || 'To'} ${formatDate(maxDate)}`
            }

            return t('performance.filters.allTime') || 'All Time'
        }

        return ''
    }

    const handleView = async (invoice: Invoice, format: 'a4' | 'receipt') => {
        setIsLoadingPdf(true)
        setDownloadError(null)

        try {
            const localPath = getStoredLocalInvoicePdfPath(invoice, format)
            const pdfBlob = format === 'a4' ? invoice.pdfBlobA4 : invoice.pdfBlobReceipt
            const r2Path = format === 'a4' ? invoice.r2PathA4 : invoice.r2PathReceipt

            let url: string | null = null

            if (localPath) {
                const exists = await platformService.exists(localPath)
                if (exists) {
                    try {
                        const content = await platformService.readFile(localPath)
                        // Use Data URL (base64) which is often more compatible for framing in WebView2 than blob: or asset:
                        const base64 = platformService.uint8ArrayToBase64(content)
                        url = `data:application/pdf;base64,${base64}`
                        console.log('[InvoicesHistory] Successfully created Data URL from local file')
                    } catch (err) {
                        console.error('[InvoicesHistory] Failed to read local PDF as data URL:', err)
                        url = platformService.convertFileSrc(localPath)
                    }
                }
            }

            if (!url && pdfBlob) {
                url = URL.createObjectURL(pdfBlob)
            }

            if (!url && r2Path) {
                if (!navigator.onLine) {
                    setDownloadError(t('invoices.offlineError') || 'You must be online to view invoice PDFs.')
                    return
                }
                try {
                    const content = await r2Service.download(r2Path)
                    if (content) {
                        const bytes = new Uint8Array(content)
                        const base64 = platformService.uint8ArrayToBase64(bytes)
                        url = `data:application/pdf;base64,${base64}`
                    }
                } catch (error) {
                    if (isWorkspaceUsageLimitError(error)) {
                        setDownloadError(getWorkspaceUsageLimitMessage(error))
                        return
                    }
                    throw error
                }
            }

            if (!url) {
                setDownloadError(t('invoices.pdfNotAvailable') || 'PDF not available.')
                return
            }

            setPDFPreviewSource({
                url,
                title: `${t('invoices.viewInvoice') || 'Invoice'} ${invoice.invoiceid}`
            })
            setLocation('/pdf-preview')
        } catch (error) {
            console.error('[InvoicesHistory] Failed to load PDF:', error)
            setDownloadError(t('invoices.pdfLoadError') || 'Failed to load PDF')
        } finally {
            setIsLoadingPdf(false)
        }
    }

    const handleShare = async (invoice: Invoice, format: 'a4' | 'receipt') => {
        setIsLoadingPdf(true)
        setDownloadError(null)

        try {
            const localPath = getStoredLocalInvoicePdfPath(invoice, format)
            const pdfBlob = format === 'a4' ? invoice.pdfBlobA4 : invoice.pdfBlobReceipt
            const r2Path = format === 'a4' ? invoice.r2PathA4 : invoice.r2PathReceipt

            let blob: Blob | null = pdfBlob ?? null

            if (!blob && localPath) {
                const exists = await platformService.exists(localPath)
                if (exists) {
                    try {
                        const content = await platformService.readFile(localPath)
                        blob = new Blob([content], { type: 'application/pdf' })
                    } catch {
                        // fall through
                    }
                }
            }

            if (!blob && r2Path) {
                if (!navigator.onLine) {
                    setDownloadError(t('invoices.offlineError') || 'You must be online to share invoice PDFs.')
                    return
                }
                try {
                    const content = await r2Service.download(r2Path)
                    if (content) {
                        blob = new Blob([content], { type: 'application/pdf' })
                    }
                } catch (error) {
                    if (isWorkspaceUsageLimitError(error)) {
                        setDownloadError(getWorkspaceUsageLimitMessage(error))
                        return
                    }
                }
            }

            if (!blob) {
                setDownloadError(t('invoices.pdfNotAvailable') || 'PDF not available.')
                return
            }

            const fileName = `${t('invoices.invoice') || 'Invoice'}_${invoice.sequenceId ? String(invoice.sequenceId).padStart(5, '0') : invoice.invoiceid}.pdf`
            const file = new File([blob], fileName, { type: 'application/pdf' })

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    title: fileName,
                    files: [file],
                })
            } else {
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = fileName
                a.style.display = 'none'
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return
            console.error('[InvoicesHistory] Failed to share PDF:', error)
            setDownloadError(t('invoices.shareError') || 'Failed to share PDF')
        } finally {
            setIsLoadingPdf(false)
        }
    }

    const handleViewVersion = async (version: InvoiceVersion) => {
        setIsLoadingPdf(true)
        setDownloadError(null)

        try {
            let url: string | null = null
            if (version.localPath) {
                const exists = await platformService.exists(version.localPath)
                if (exists) {
                    const content = await platformService.readFile(version.localPath)
                    url = `data:application/pdf;base64,${platformService.uint8ArrayToBase64(content)}`
                }
            }
            if (!url && version.pdfBlob) url = URL.createObjectURL(version.pdfBlob)
            if (!url && version.r2Path) {
                if (!navigator.onLine) {
                    setDownloadError(t('invoices.offlineError') || 'You must be online to view invoice PDFs.')
                    return
                }
                try {
                    const content = await r2Service.download(version.r2Path)
                    if (content) {
                        const bytes = new Uint8Array(content)
                        url = `data:application/pdf;base64,${platformService.uint8ArrayToBase64(bytes)}`
                    }
                } catch (error) {
                    if (isWorkspaceUsageLimitError(error)) {
                        setDownloadError(getWorkspaceUsageLimitMessage(error))
                        return
                    }
                    throw error
                }
            }
            if (!url) {
                setDownloadError(t('invoices.pdfNotAvailable') || 'PDF not available.')
                return
            }

            setPDFPreviewSource({
                url,
                title: `${versionsTarget?.invoiceid || t('invoices.invoice', { defaultValue: 'Invoice' })} · ${t('invoices.version', { defaultValue: 'Version' })} ${version.versionNumber}`,
            })
            setVersionsTarget(null)
            setLocation('/pdf-preview')
        } catch (error) {
            console.error('[InvoicesHistory] Failed to view invoice version:', error)
            setDownloadError(t('invoices.pdfLoadError') || 'Failed to load PDF')
        } finally {
            setIsLoadingPdf(false)
        }
    }

    return (
        <Tabs
            value={activeTab}
            onValueChange={(value) => {
                setLocation(value === 'uploads' ? UPLOAD_FILES_ROUTE : '/invoices-history')
            }}
            className="space-y-6"
        >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <div className="flex flex-wrap items-center gap-3">
                        <h1 className="flex items-center gap-2 text-2xl font-bold">
                            <FileText className="h-6 w-6 text-primary" />
                            {t('invoices.historyTitle') || 'Invoices History'}
                        </h1>
                        {activeTab === 'history' ? <DateRangeBadge>{getDateDisplay()}</DateRangeBadge> : null}
                    </div>
                    <p className="text-muted-foreground">
                        {activeTab === 'history'
                            ? (t('invoices.historySubtitle', { count: historyInvoices.length }) || `${historyInvoices.length} historical records`)
                            : `${uploadedFilesCount} uploaded PDF file${uploadedFilesCount === 1 ? '' : 's'}`} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>

                <TabsList className="grid h-auto w-full max-w-[380px] grid-cols-2 rounded-2xl bg-secondary/50 p-1">
                    <TabsTrigger value="history" className="gap-2 rounded-xl font-bold">
                        <FileText className="h-4 w-4" />
                        History
                    </TabsTrigger>
                    <TabsTrigger value="uploads" className="gap-2 rounded-xl font-bold">
                        <Upload className="h-4 w-4" />
                        Upload Files
                    </TabsTrigger>
                </TabsList>
            </div>

            <TabsContent value="history" className="mt-0 space-y-6">
                <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
                    <div className="flex w-full max-w-md items-center gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                allowViewer={true}
                                placeholder={t('invoices.searchPlaceholder') || 'Search by ID...'}
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                className="pl-10 rounded-xl"
                            />
                        </div>
                        <Button
                            variant="outline"
                            size="icon"
                            allowViewer={true}
                            className="shrink-0 rounded-xl"
                            onClick={() => refreshInvoices()}
                            title={t('common.refresh') || 'Refresh'}
                        >
                            <RefreshCw className="h-4 w-4" />
                        </Button>
                    </div>
                    <DateRangeFilters />
                </div>

                <Card className="overflow-hidden rounded-2xl border-2 shadow-sm">
                    <CardHeader className="border-b bg-muted/30">
                        <CardTitle className="flex items-center gap-2 text-lg font-bold">
                            <FileText className="h-5 w-5 text-primary/70" />
                            {t('invoices.listTitle') || 'Historical Records'}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        {filteredInvoices.length === 0 ? (
                            <div className="bg-muted/5 py-12 text-center text-muted-foreground">
                                <FileText className="mx-auto mb-4 h-12 w-12 opacity-10" />
                                {historyInvoices.length === 0 ? t('common.noData') : t('common.noResults')}
                            </div>
                        ) : (
                            <Table>
                                <TableHeader className="bg-muted/20">
                                    <TableRow className="border-b hover:bg-transparent">
                                        <TableHead className="py-4 font-bold">{t('invoices.table.created')}</TableHead>
                                        <TableHead className="font-bold">{t('invoices.table.invoiceid')}</TableHead>
                                        <TableHead className="text-center font-bold">{t('invoices.table.createdBy') || 'Created By'}</TableHead>
                                        <TableHead className="text-center font-bold">{t('invoices.table.origin') || 'Origin'}</TableHead>
                                        <TableHead className="text-right font-bold">{t('invoices.table.total')}</TableHead>
                                        <TableHead className="pr-6 text-right font-bold">{t('common.actions')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filteredInvoices.map((invoice) => (
                                        <TableRow key={invoice.id} className="group transition-colors hover:bg-muted/30">
                                            <TableCell className="py-4 pl-4 text-xs font-medium text-muted-foreground">
                                                {formatDateTime(invoice.createdAt)}
                                            </TableCell>
                                            <TableCell className="font-mono text-xs font-bold text-primary">
                                                {invoice.sequenceId ? `#${String(invoice.sequenceId).padStart(5, '0')}` : invoice.invoiceid}
                                            </TableCell>
                                            <TableCell className="text-center text-xs font-medium">
                                                {invoice.createdByName || invoice.createdBy || 'Unknown'}
                                            </TableCell>
                                            <TableCell className="text-center">
                                                <span className="rounded-lg bg-secondary/50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-secondary-foreground">
                                                    {formatOriginLabel(invoice.origin)}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-right font-black tabular-nums">
                                                {formatCurrency(invoice.totalAmount, invoice.settlementCurrency || 'usd', features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="pr-6 text-right">
                                                <div className="flex justify-end gap-2">
                                                    {(invoice.localPathA4 || invoice.pdfBlobA4 || invoice.r2PathA4) && (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            allowViewer={true}
                                                            className="flex items-center gap-2 rounded-xl px-3 transition-all hover:bg-primary/10 hover:text-primary"
                                                            onClick={() => {
                                                                void handleView(invoice, 'a4')
                                                            }}
                                                        >
                                                            <Eye className="h-4 w-4" />
                                                            <span className="font-mono text-xs font-bold">A4</span>
                                                        </Button>
                                                    )}
                                                    {(invoice.localPathReceipt || invoice.pdfBlobReceipt || invoice.r2PathReceipt) && (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            allowViewer={true}
                                                            className="flex items-center gap-2 rounded-xl px-3 transition-all hover:bg-primary/10 hover:text-primary"
                                                            onClick={() => {
                                                                void handleView(invoice, 'receipt')
                                                            }}
                                                        >
                                                            <FileText className="h-4 w-4" />
                                                            <span className="font-mono text-xs font-bold">Receipt</span>
                                                        </Button>
                                                    )}
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        allowViewer={true}
                                                        className="flex items-center gap-2 rounded-xl px-3 transition-all hover:bg-primary/10 hover:text-primary"
                                                        onClick={() => setVersionsTarget(invoice)}
                                                    >
                                                        <History className="h-4 w-4" />
                                                        <span className="text-xs font-bold">
                                                            {t('invoices.versions', { defaultValue: 'Versions' })}
                                                            {invoice.latestVersionNumber ? ` (${invoice.latestVersionNumber})` : ''}
                                                        </span>
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        allowViewer={true}
                                                        className="flex items-center gap-2 rounded-xl px-3 transition-all hover:bg-primary/10 hover:text-primary"
                                                        onClick={() => {
                                                            const format = (invoice.localPathA4 || invoice.pdfBlobA4 || invoice.r2PathA4) ? 'a4' : 'receipt'
                                                            void handleShare(invoice, format)
                                                        }}
                                                    >
                                                        <Share2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>
            </TabsContent>

            <TabsContent value="uploads" className="mt-0">
                <UploadFilesTab
                    invoices={invoices}
                    onPreview={(invoice) => {
                        void handleView(invoice, 'a4')
                    }}
                />
            </TabsContent>

            <Dialog open={!!versionsTarget} onOpenChange={(open) => !open && setVersionsTarget(null)}>
                <DialogContent className="max-w-4xl overflow-hidden p-0">
                    <DialogHeader className="border-b px-6 py-5">
                        <DialogTitle className="flex items-center gap-2">
                            <History className="h-5 w-5 text-primary" />
                            {t('invoices.versions', { defaultValue: 'Versions' })} · {versionsTarget?.invoiceid}
                        </DialogTitle>
                        <DialogDescription>
                            {t('invoices.versionsDescription', { defaultValue: 'Immutable PDF snapshots, sorted from latest to oldest.' })}
                            {versionsTarget && (
                                <span className="mt-1 block font-mono text-[11px]">
                                    {formatOriginLabel(versionsTarget.origin)} · {versionsTarget.sourceId || versionsTarget.orderId || versionsTarget.id}
                                </span>
                            )}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="max-h-[65vh] overflow-auto">
                        {isLoadingVersions ? (
                            <div className="flex items-center justify-center gap-3 py-14 text-sm text-muted-foreground">
                                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                                {t('common.loading') || 'Loading...'}
                            </div>
                        ) : versions.length === 0 ? (
                            <div className="py-14 text-center text-sm text-muted-foreground">
                                {t('invoices.noVersions', { defaultValue: 'No saved versions are available.' })}
                            </div>
                        ) : (
                            <Table>
                                <TableHeader className="sticky top-0 z-10 bg-background">
                                    <TableRow>
                                        <TableHead>{t('invoices.version', { defaultValue: 'Version' })}</TableHead>
                                        <TableHead>{t('invoices.table.created')}</TableHead>
                                        <TableHead>{t('invoices.table.createdBy') || 'Created By'}</TableHead>
                                        <TableHead>{t('invoices.format', { defaultValue: 'Format' })}</TableHead>
                                        <TableHead>{t('invoices.size', { defaultValue: 'Size' })}</TableHead>
                                        <TableHead className="text-right">{t('common.actions')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {versions.map((version, index) => (
                                        <TableRow key={version.id}>
                                            <TableCell>
                                                <div className="flex items-center gap-2">
                                                    <span className="font-mono font-bold">v{version.versionNumber}</span>
                                                    {index === 0 && (
                                                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase text-primary">
                                                            {t('common.latest', { defaultValue: 'Latest' })}
                                                        </span>
                                                    )}
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-xs">{formatDateTime(version.createdAt)}</TableCell>
                                            <TableCell className="text-xs font-medium">{version.createdByName || version.createdBy || 'Unknown'}</TableCell>
                                            <TableCell>
                                                <span className="rounded-md bg-secondary px-2 py-1 font-mono text-[10px] font-bold uppercase">
                                                    {version.format}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-xs text-muted-foreground">
                                                {version.fileSize > 0 ? getReadableFileSize(version.fileSize) : '—'}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    allowViewer={true}
                                                    className="gap-2 rounded-xl"
                                                    onClick={() => void handleViewVersion(version)}
                                                >
                                                    <Eye className="h-4 w-4" />
                                                    {t('common.view', { defaultValue: 'View' })}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            {isLoadingPdf && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
                    <div className="text-center">
                        <div className="mx-auto mb-2 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        <p className="text-muted-foreground">{t('common.loading') || 'Loading...'}</p>
                    </div>
                </div>
            )}
            {downloadError && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
                    <div className="rounded-lg border bg-card p-6 text-center shadow-lg max-w-sm">
                        <p className="text-sm text-muted-foreground mb-4">{downloadError}</p>
                        <Button variant="outline" size="sm" onClick={() => setDownloadError(null)}>
                            {t('common.close') || 'Close'}
                        </Button>
                    </div>
                </div>
            )}
        </Tabs>
    )
}
