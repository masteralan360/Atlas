import { useState } from 'react'
import { useInvoices, type Invoice } from '@/local-db'
import { formatCurrency, formatDateTime, formatDate } from '@/lib/utils'
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
    DialogTitle
} from '@/ui/components'
import { FileText, Search, Eye, Download, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useDateRange } from '@/context/DateRangeContext'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { r2Service } from '@/services/r2Service'
import { PdfViewer } from '@/ui/components'
import { open } from '@tauri-apps/plugin-shell'



export function InvoicesHistory() {
    const { user } = useAuth()
    const invoices = useInvoices(user?.workspaceId)
    const { features } = useWorkspace()
    const { t, i18n } = useTranslation()
    const { dateRange, customDates } = useDateRange()
    const [search, setSearch] = useState('')
    const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)
    const [showPdfViewer, setShowPdfViewer] = useState(false)
    const [pdfUrl, setPdfUrl] = useState<string | null>(null)
    const [pdfError, setPdfError] = useState<string | null>(null)
    const [isLoadingPdf, setIsLoadingPdf] = useState(false)

    const getDateDisplay = () => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }
        if (dateRange === 'month') {
            const now = new Date()
            return new Intl.DateTimeFormat(i18n.language, {
                month: 'long',
                year: 'numeric'
            }).format(now)
        }
        if (dateRange === 'custom') {
            if (filteredInvoices && filteredInvoices.length > 0) {
                const dates = filteredInvoices.map(i => new Date(i.createdAt).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from') || 'From'} ${formatDate(minDate)} ${t('performance.filters.to') || 'To'} ${formatDate(maxDate)}`
            }
            if (customDates.start && customDates.end) {
                return `${t('performance.filters.from') || 'From'} ${formatDate(customDates.start)} ${t('performance.filters.to') || 'To'} ${formatDate(customDates.end)}`
            }
        }
        if (dateRange === 'allTime') {
            if (invoices && invoices.length > 0) {
                const dates = invoices.map(i => new Date(i.createdAt).getTime())
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
        setShowPdfViewer(true)

        try {
            // Determine which R2 path to use
            const r2Path = format === 'a4' ? invoice.r2PathA4 : invoice.r2PathReceipt

            if (!r2Path) {
                setPdfError(t('invoices.pdfNotAvailable') || 'PDF not available. This invoice was created before PDF storage was enabled.')
                return
            }

            if (!navigator.onLine) {
                setPdfError(t('invoices.offlineError') || 'You must be online to view invoice PDFs.')
                return
            }

            // Get the PDF URL from R2
            const url = r2Service.getUrl(r2Path)
            setPdfUrl(url)
        } catch (error) {
            console.error('[InvoicesHistory] Failed to load PDF:', error)
            setPdfError(t('invoices.pdfLoadError') || 'Failed to load PDF')
        } finally {
            setIsLoadingPdf(false)
        }
    }

    const handleDownload = async () => {
        if (!pdfUrl || !selectedInvoice) return

        try {
            // Use Tauri Shell API to open the URL in the default browser
            // This works on both desktop and mobile in Tauri v2
            await open(pdfUrl)
        } catch (error) {
            console.error('[InvoicesHistory] Failed to open URL with Tauri shell:', error)

            // Fallback for non-Tauri environments (browser)
            const link = document.createElement('a')
            link.href = pdfUrl
            link.download = `invoice-${selectedInvoice.invoiceid.replace('#', '')}.pdf`
            link.target = '_blank'
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
        }
    }

    const filteredInvoices = invoices.filter(
        (i) => {
            const matchesSearch = i.invoiceid.toLowerCase().includes(search.toLowerCase())

            // Date filtering logic
            const invoiceDate = new Date(i.createdAt)
            const now = new Date()
            let matchesDate = true

            if (dateRange === 'today') {
                const startOfDay = new Date(now.setHours(0, 0, 0, 0))
                matchesDate = invoiceDate >= startOfDay
            } else if (dateRange === 'month') {
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
                matchesDate = invoiceDate >= startOfMonth
            } else if (dateRange === 'custom' && customDates.start && customDates.end) {
                const start = new Date(customDates.start)
                start.setHours(0, 0, 0, 0)
                const end = new Date(customDates.end)
                end.setHours(23, 59, 59, 999)
                matchesDate = invoiceDate >= start && invoiceDate <= end
            } else if (dateRange === 'allTime') {
                matchesDate = true
            }

            return matchesSearch && matchesDate
        }
    ).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-3">
                        <h1 className="text-2xl font-bold flex items-center gap-2">
                            <FileText className="w-6 h-6 text-primary" />
                            {t('invoices.historyTitle') || 'Invoices History'}
                        </h1>
                        {getDateDisplay() && (
                            <div className="px-3 py-1 text-sm font-bold bg-primary text-primary-foreground rounded-lg shadow-sm animate-pop-in">
                                {getDateDisplay()}
                            </div>
                        )}
                    </div>
                    <p className="text-muted-foreground">
                        {t('invoices.historySubtitle', { count: invoices.length }) || `${invoices.length} historical records`}
                    </p>
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
                <div className="relative w-full max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                        placeholder={t('invoices.searchPlaceholder') || "Search by ID..."}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-10 rounded-xl"
                    />
                </div>
                <DateRangeFilters />
            </div>

            {/* Invoices Table */}
            <Card className="rounded-2xl overflow-hidden border-2 shadow-sm">
                <CardHeader className="bg-muted/30 border-b">
                    <CardTitle className="text-lg font-bold flex items-center gap-2">
                        <FileText className="w-5 h-5 text-primary/70" />
                        {t('invoices.listTitle') || "Historical Records"}
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    {filteredInvoices.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground bg-muted/5">
                            <FileText className="w-12 h-12 mx-auto mb-4 opacity-10" />
                            {invoices.length === 0 ? t('common.noData') : t('common.noResults')}
                        </div>
                    ) : (
                        <Table>
                            <TableHeader className="bg-muted/20">
                                <TableRow className="hover:bg-transparent border-b">
                                    <TableHead className="font-bold py-4">{t('invoices.table.created')}</TableHead>
                                    <TableHead className="font-bold">{t('invoices.table.invoiceid')}</TableHead>
                                    <TableHead className="font-bold text-center">{t('invoices.table.createdBy') || 'Created By'}</TableHead>
                                    <TableHead className="font-bold text-center">{t('invoices.table.origin') || 'Origin'}</TableHead>
                                    <TableHead className="text-right font-bold">{t('invoices.table.total')}</TableHead>
                                    <TableHead className="text-right font-bold pr-6">{t('common.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredInvoices.map((invoice) => (
                                    <TableRow key={invoice.id} className="group hover:bg-muted/30 transition-colors">
                                        <TableCell className="text-muted-foreground text-xs font-medium py-4 pl-4">
                                            {formatDateTime(invoice.createdAt)}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs font-bold text-primary">
                                            {invoice.sequenceId ? `#${String(invoice.sequenceId).padStart(5, '0')}` : invoice.invoiceid}
                                        </TableCell>

                                        <TableCell className="text-center text-xs font-medium">
                                            {invoice.createdByName || invoice.createdBy || 'Unknown'}
                                        </TableCell>

                                        <TableCell className="text-center">
                                            <span className="px-2 py-0.5 rounded-lg text-[9px] font-bold bg-secondary/50 text-secondary-foreground uppercase tracking-widest">
                                                {invoice.origin || 'Pos'}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-right font-black tabular-nums">
                                            {formatCurrency(invoice.totalAmount, invoice.settlementCurrency || 'usd', features.iqd_display_preference)}
                                        </TableCell>
                                        <TableCell className="text-right pr-6">
                                            <div className="flex justify-end gap-2">
                                                {invoice.r2PathA4 && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="rounded-xl hover:bg-primary/10 hover:text-primary transition-all flex items-center gap-2 px-3"
                                                        onClick={() => handleView(invoice, 'a4')}
                                                    >
                                                        <Eye className="w-4 h-4" />
                                                        <span className="text-xs font-bold font-mono">A4</span>
                                                    </Button>
                                                )}
                                                {invoice.r2PathReceipt && (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="rounded-xl hover:bg-primary/10 hover:text-primary transition-all flex items-center gap-2 px-3"
                                                        onClick={() => handleView(invoice, 'receipt')}
                                                    >
                                                        <FileText className="w-4 h-4" />
                                                        <span className="text-xs font-bold font-mono">Receipt</span>
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

            {/* PDF Viewer Modal */}
            <Dialog open={showPdfViewer} onOpenChange={(open) => {
                if (!open) {
                    setShowPdfViewer(false)
                    setSelectedInvoice(null)
                    setPdfUrl(null)
                    setPdfError(null)
                }
            }}>
                <DialogContent className="max-w-4xl h-[90vh] flex flex-col">
                    <DialogHeader className="flex-shrink-0">
                        <DialogTitle className="flex items-center justify-between">
                            <span>{t('invoices.viewInvoice') || 'View Invoice'} {selectedInvoice?.invoiceid}</span>
                            {pdfUrl && !pdfError && (
                                <Button size="sm" variant="outline" onClick={handleDownload} className="ml-4">
                                    <Download className="w-4 h-4 mr-2" />
                                    {t('common.ViewAndDownload') || 'View and Download'}
                                </Button>
                            )}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="flex-1 overflow-hidden rounded-lg">
                        {isLoadingPdf && (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center">
                                    <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-2" />
                                    <p className="text-muted-foreground">{t('common.loading') || 'Loading...'}</p>
                                </div>
                            </div>
                        )}
                        {pdfError && (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center p-8">
                                    <AlertCircle className="w-12 h-12 mx-auto mb-4 text-yellow-500" />
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
        </div>
    )
}
