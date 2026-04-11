import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { useInvoices, type Invoice } from '@/local-db'
import { formatCurrency, formatDateTime, formatDate, formatOriginLabel } from '@/lib/utils'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { platformService } from '@/services/platformService'
import {
    getAbsoluteAppDataPath,
    getStoredLocalInvoicePdfPath,
} from '@/services/localInvoiceStorage'
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
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
} from '@/ui/components'
import { FileText, Search, Eye, Download, AlertCircle, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useDateRange } from '@/context/DateRangeContext'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { r2Service } from '@/services/r2Service'
import { PdfViewer } from '@/ui/components'
import { open } from '@tauri-apps/plugin-shell'
import { invoke } from '@tauri-apps/api/core'
import { UploadFilesTab } from './UploadFile'

const UPLOAD_FILES_ROUTE = '/invoices-history/upload-files'

export function InvoicesHistory() {
    const [location, setLocation] = useLocation()
    const { user } = useAuth()
    const invoices = useInvoices(user?.workspaceId)
    const { features } = useWorkspace()
    const { t, i18n } = useTranslation()
    const { dateRange, customDates } = useDateRange()
    const [search, setSearch] = useState('')
    const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)
    const [showPdfViewer, setShowPdfViewer] = useState(false)
    const [pdfUrl, setPdfUrl] = useState<string | null>(null)
    const [pdfPath, setPdfPath] = useState<string | null>(null)
    const [pdfError, setPdfError] = useState<string | null>(null)
    const [isLoadingPdf, setIsLoadingPdf] = useState(false)

    useEffect(() => {
        return () => {
            if (pdfUrl?.startsWith('blob:')) {
                URL.revokeObjectURL(pdfUrl)
            }
        }
    }, [pdfUrl])

    const activeTab = location === UPLOAD_FILES_ROUTE ? 'uploads' : 'history'
    const historyInvoices = useMemo(
        () => invoices.filter((invoice) => invoice.origin !== 'upload'),
        [invoices],
    )
    const uploadedFilesCount = invoices.length - historyInvoices.length

    const filteredInvoices = useMemo(() => {
        return historyInvoices
            .filter((invoice) => {
                const matchesSearch = invoice.invoiceid.toLowerCase().includes(search.toLowerCase())
                const invoiceDate = new Date(invoice.createdAt)
                const now = new Date()

                if (dateRange === 'today') {
                    const startOfDay = new Date(now.setHours(0, 0, 0, 0))
                    return matchesSearch && invoiceDate >= startOfDay
                }

                if (dateRange === 'month') {
                    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
                    return matchesSearch && invoiceDate >= startOfMonth
                }

                if (dateRange === 'custom' && customDates.start && customDates.end) {
                    const start = new Date(customDates.start)
                    start.setHours(0, 0, 0, 0)
                    const end = new Date(customDates.end)
                    end.setHours(23, 59, 59, 999)
                    return matchesSearch && invoiceDate >= start && invoiceDate <= end
                }

                return matchesSearch
            })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }, [customDates.end, customDates.start, dateRange, historyInvoices, search])

    const getDateDisplay = () => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }

        if (dateRange === 'month') {
            return formatLocalizedMonthYear(new Date(), i18n.language)
        }

        if (dateRange === 'custom') {
            if (filteredInvoices.length > 0) {
                const dates = filteredInvoices.map((invoice) => new Date(invoice.createdAt).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from') || 'From'} ${formatDate(minDate)} ${t('performance.filters.to') || 'To'} ${formatDate(maxDate)}`
            }

            if (customDates.start && customDates.end) {
                return `${t('performance.filters.from') || 'From'} ${formatDate(customDates.start)} ${t('performance.filters.to') || 'To'} ${formatDate(customDates.end)}`
            }
        }

        if (dateRange === 'allTime') {
            if (historyInvoices.length > 0) {
                const dates = historyInvoices.map((invoice) => new Date(invoice.createdAt).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.allTime')}, ${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }

            return t('performance.filters.allTime') || 'All Time'
        }

        return ''
    }

    const handleView = async (invoice: Invoice, format: 'a4' | 'receipt') => {
        setSelectedInvoice(invoice)
        setIsLoadingPdf(true)
        setPdfError(null)
        setPdfUrl(null)
        setPdfPath(null)
        setShowPdfViewer(true)

        try {
            const localPath = getStoredLocalInvoicePdfPath(invoice, format)
            const pdfBlob = format === 'a4' ? invoice.pdfBlobA4 : invoice.pdfBlobReceipt
            const r2Path = format === 'a4' ? invoice.r2PathA4 : invoice.r2PathReceipt

            if (localPath) {
                const exists = await platformService.exists(localPath)
                if (exists) {
                    setPdfPath(localPath)
                    setPdfUrl(platformService.convertFileSrc(localPath))
                    return
                }
            }

            if (pdfBlob) {
                setPdfUrl(URL.createObjectURL(pdfBlob))
                return
            }

            if (!r2Path) {
                setPdfError(t('invoices.pdfNotAvailable') || 'PDF not available. This invoice was created before PDF storage was enabled.')
                return
            }

            if (!navigator.onLine) {
                setPdfError(t('invoices.offlineError') || 'You must be online to view invoice PDFs.')
                return
            }

            setPdfUrl(r2Service.getUrl(r2Path))
        } catch (error) {
            console.error('[InvoicesHistory] Failed to load PDF:', error)
            setPdfError(t('invoices.pdfLoadError') || 'Failed to load PDF')
        } finally {
            setIsLoadingPdf(false)
        }
    }

    const handleDownload = async () => {
        if ((!pdfUrl && !pdfPath) || !selectedInvoice) return

        if (pdfPath) {
            try {
                const absPath = await getAbsoluteAppDataPath(pdfPath)
                await invoke('open_file_path', { path: absPath })
                return
            } catch (error) {
                console.error('[InvoicesHistory] Failed to open file with invoke:', error)
            }
        }

        if (!pdfUrl) return

        try {
            await open(pdfUrl)
        } catch (error) {
            console.error('[InvoicesHistory] Failed to open URL with Tauri shell:', error)

            const link = document.createElement('a')
            link.href = pdfUrl
            link.download = `${selectedInvoice.invoiceid.replace(/[^\w.-]+/g, '_')}.pdf`
            link.target = '_blank'
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
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
                        {activeTab === 'history' && getDateDisplay() && (
                            <div className="animate-pop-in rounded-lg bg-primary px-3 py-1 text-sm font-bold text-primary-foreground shadow-sm">
                                {getDateDisplay()}
                            </div>
                        )}
                    </div>
                    <p className="text-muted-foreground">
                        {activeTab === 'history'
                            ? (t('invoices.historySubtitle', { count: historyInvoices.length }) || `${historyInvoices.length} historical records`)
                            : `${uploadedFilesCount} uploaded PDF file${uploadedFilesCount === 1 ? '' : 's'}`}
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
                    <div className="relative w-full max-w-md">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            allowViewer={true}
                            placeholder={t('invoices.searchPlaceholder') || 'Search by ID...'}
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            className="pl-10 rounded-xl"
                        />
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

            <Dialog
                open={showPdfViewer}
                onOpenChange={(open) => {
                    if (!open) {
                        setShowPdfViewer(false)
                        setSelectedInvoice(null)
                        setPdfUrl(null)
                        setPdfPath(null)
                        setPdfError(null)
                    }
                }}
            >
                <DialogContent className="flex h-[90vh] max-w-4xl flex-col">
                    <DialogHeader className="flex-shrink-0">
                        <DialogTitle className="flex items-center justify-between">
                            <span>{t('invoices.viewInvoice') || 'View Invoice'} {selectedInvoice?.invoiceid}</span>
                            {pdfUrl && !pdfError && (
                                <Button size="sm" variant="outline" allowViewer={true} onClick={handleDownload} className="ml-4">
                                    <Download className="mr-2 h-4 w-4" />
                                    {t('common.ViewAndDownload') || 'View and Download'}
                                </Button>
                            )}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="flex-1 overflow-hidden rounded-lg">
                        {isLoadingPdf && (
                            <div className="flex h-full items-center justify-center">
                                <div className="text-center">
                                    <div className="mx-auto mb-2 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                                    <p className="text-muted-foreground">{t('common.loading') || 'Loading...'}</p>
                                </div>
                            </div>
                        )}
                        {pdfError && (
                            <div className="flex h-full items-center justify-center">
                                <div className="p-8 text-center">
                                    <AlertCircle className="mx-auto mb-4 h-12 w-12 text-yellow-500" />
                                    <p className="text-muted-foreground">{pdfError}</p>
                                </div>
                            </div>
                        )}
                        {pdfUrl && !pdfError && !isLoadingPdf && (
                            <PdfViewer
                                file={pdfUrl}
                                className="h-full w-full overflow-auto"
                                onLoadError={(error) => {
                                    console.error('[InvoicesHistory] Failed to load PDF:', error)
                                    setPdfError(t('invoices.pdfLoadError') || 'Failed to load PDF')
                                }}
                            />
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </Tabs>
    )
}
