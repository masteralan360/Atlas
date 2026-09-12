import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    AlertTriangle,
    BellRing,
    Clipboard,
    Copy,
    FileSearch,
    FileWarning,
    FolderClock,
    LoaderCircle,
    RefreshCw,
    Search,
    ShieldCheck,
    Terminal,
    Upload,
} from 'lucide-react'
import type { DateRangeType } from '@/context/DateRangeContext'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import {
    copyErrorLogRecord,
    exportErrorLogRecord,
    formatErrorLogRecord,
    isErrorLogStorageAvailable,
    readErrorLogs,
    type ErrorLogRecord,
    type SerializedConsoleValue,
} from '@/lib/errorLogger'
import { formatDateTime } from '@/lib/utils'
import {
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    DateRangeFilters,
    Input,
    SmallDialog,
    SmallDialogBody,
    SmallDialogContent,
    SmallDialogDescription,
    SmallDialogFooter,
    SmallDialogHeader,
    SmallDialogTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast,
} from '@/ui/components'

function getLogSummary(argument: SerializedConsoleValue | undefined) {
    if (typeof argument === 'string') return argument
    if (argument && typeof argument === 'object' && argument.type === 'error') {
        return `${argument.name}: ${argument.message}`
    }
    return argument === undefined ? '' : JSON.stringify(argument)
}

function getRecordSummary(record: ErrorLogRecord) {
    if (record.source === 'toast') {
        const toastText = [record.toast?.title, record.toast?.description]
            .filter((value): value is string => Boolean(value))
            .join(' — ')
        if (toastText) return toastText
    }

    return getLogSummary(record.arguments[0])
}

export function Logs() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const [records, setRecords] = useState<ErrorLogRecord[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [search, setSearch] = useState('')
    const [dateRange, setDateRange] = useState<DateRangeType>('allTime')
    const [customDates, setCustomDates] = useState({ start: '', end: '' })
    const [selectedRecord, setSelectedRecord] = useState<ErrorLogRecord | null>(null)
    const [isCopying, setIsCopying] = useState(false)
    const [isExporting, setIsExporting] = useState(false)

    const refresh = useCallback(async () => {
        setIsLoading(true)
        try {
            setRecords(await readErrorLogs())
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => {
        void refresh()
        const interval = window.setInterval(() => void refresh(), 5000)
        return () => window.clearInterval(interval)
    }, [refresh])

    const filteredRecords = useMemo(() => {
        const normalizedSearch = search.trim().toLocaleLowerCase()
        return records.filter((record) => {
            if (!isDateInDateRange(record.timestamp, dateRange, customDates)) return false
            if (!normalizedSearch) return true
            return `${record.timestamp} ${record.route} ${formatErrorLogRecord(record)}`
                .toLocaleLowerCase()
                .includes(normalizedSearch)
        })
    }, [customDates, dateRange, records, search])

    const copySelectedRecord = async () => {
        if (!selectedRecord) return
        setIsCopying(true)
        try {
            const copied = await copyErrorLogRecord(selectedRecord)
            toast({
                title: copied ? t('errorLogs.copied') : t('errorLogs.copyFailed'),
                variant: copied ? 'default' : 'destructive',
            })
        } catch {
            toast({ title: t('errorLogs.copyFailed'), variant: 'destructive' })
        } finally {
            setIsCopying(false)
        }
    }

    const exportSelectedRecord = async () => {
        if (!selectedRecord) return
        setIsExporting(true)
        try {
            const exported = await exportErrorLogRecord(selectedRecord)
            if (!exported) return
            toast({ title: t('errorLogs.exported') })
        } catch {
            toast({ title: t('errorLogs.exportFailed'), variant: 'destructive' })
        } finally {
            setIsExporting(false)
        }
    }

    if (!isErrorLogStorageAvailable()) {
        return (
            <div className="space-y-6">
                <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
                            <FileWarning className="h-5 w-5" />
                        </span>
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight">{t('errorLogs.title')}</h1>
                            <p className="mt-1 text-sm text-muted-foreground">{t('errorLogs.subtitle')}</p>
                        </div>
                    </div>
                </header>
                <Card className="border-amber-500/25 bg-amber-500/5">
                    <CardContent className="flex items-start gap-3 p-5 text-sm text-muted-foreground">
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                        <p>{t('errorLogs.storageUnavailable')}</p>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                        <FileWarning className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                        <h1 className="text-3xl font-bold tracking-tight">{t('errorLogs.title')}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t('errorLogs.subtitle')}</p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" onClick={() => void refresh()} disabled={isLoading} className="gap-2">
                        {isLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        {t('errorLogs.refresh')}
                    </Button>
                </div>
            </header>

            <div className="grid gap-4 xl:grid-cols-3">
                <Card className="border-destructive/20 bg-destructive/[0.03]">
                    <CardContent className="flex items-center gap-3 p-4">
                        <AlertTriangle className="h-5 w-5 text-destructive" />
                        <div>
                            <p className="text-2xl font-bold tabular-nums">{records.length}</p>
                            <p className="text-xs text-muted-foreground">{t('errorLogs.records')}</p>
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="flex items-center gap-3 p-4">
                        <ShieldCheck className="h-5 w-5 text-primary" />
                        <p className="text-sm text-muted-foreground">{t('errorLogs.captureSources')}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="flex items-center gap-3 p-4">
                        <FolderClock className="h-5 w-5 text-primary" />
                        <p className="text-sm text-muted-foreground">{t('errorLogs.retention')}</p>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader className="gap-4 xl:flex-row xl:items-end xl:justify-between">
                    <div>
                        <CardTitle className="flex items-center gap-2">
                            <FileSearch className="h-5 w-5 text-primary" />
                            {t('errorLogs.recordsTitle')}
                        </CardTitle>
                        <CardDescription>{t('errorLogs.path')}</CardDescription>
                    </div>
                    <div className="relative w-full xl:max-w-sm">
                        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('errorLogs.search')}
                            className="ps-9"
                        />
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <DateRangeFilters
                        label={t('errorLogs.dateFilter')}
                        dateRange={dateRange}
                        customDates={customDates}
                        onDateRangeChange={setDateRange}
                        onCustomDatesChange={setCustomDates}
                    />

                    <div className="overflow-x-auto rounded-2xl border border-border/60">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('errorLogs.timestamp')}</TableHead>
                                    <TableHead>{t('errorLogs.source')}</TableHead>
                                    <TableHead>{t('errorLogs.route')}</TableHead>
                                    <TableHead>{t('errorLogs.error')}</TableHead>
                                    <TableHead className="w-[1%] whitespace-nowrap text-end">{t('common.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {isLoading && records.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={5} className="h-40 text-center text-muted-foreground">
                                            <LoaderCircle className="mx-auto mb-3 h-5 w-5 animate-spin text-primary" />
                                            {t('errorLogs.loading')}
                                        </TableCell>
                                    </TableRow>
                                ) : filteredRecords.length > 0 ? filteredRecords.map((record) => (
                                    <TableRow key={record.id}>
                                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                            {formatDateTime(record.timestamp)}
                                        </TableCell>
                                        <TableCell>
                                            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-muted/40 px-2 py-1 text-xs font-medium">
                                                {record.source === 'toast'
                                                    ? <BellRing className="h-3.5 w-3.5 text-destructive" />
                                                    : <Terminal className="h-3.5 w-3.5 text-primary" />}
                                                {record.source === 'toast'
                                                    ? t('errorLogs.sources.toast')
                                                    : t('errorLogs.sources.console')}
                                            </span>
                                        </TableCell>
                                        <TableCell className="max-w-56 truncate font-mono text-xs" title={record.route}>
                                            {record.route}
                                        </TableCell>
                                        <TableCell className="max-w-md">
                                            <p className="truncate font-medium" title={getRecordSummary(record)}>
                                                {getRecordSummary(record) || t('errorLogs.unnamedError')}
                                            </p>
                                        </TableCell>
                                        <TableCell className="text-end">
                                            <Button type="button" size="sm" variant="outline" onClick={() => setSelectedRecord(record)} className="gap-2">
                                                <FileSearch className="h-4 w-4" />
                                                {t('errorLogs.details')}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                )) : (
                                    <TableRow>
                                        <TableCell colSpan={5} className="h-40 text-center">
                                            <FileSearch className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
                                            <p className="text-sm text-muted-foreground">
                                                {records.length > 0 ? t('errorLogs.noMatchingRecords') : t('errorLogs.noRecords')}
                                            </p>
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>

            <SmallDialog
                open={selectedRecord !== null}
                onOpenChange={(open) => {
                    if (!open && !isExporting && !isCopying) setSelectedRecord(null)
                }}
            >
                <SmallDialogContent className="sm:max-w-4xl">
                    <SmallDialogHeader>
                        <SmallDialogTitle className="flex items-center gap-2">
                            <FileWarning className="h-5 w-5 text-destructive" />
                            {t('errorLogs.detailTitle')}
                        </SmallDialogTitle>
                        <SmallDialogDescription>{t('errorLogs.detailDescription')}</SmallDialogDescription>
                    </SmallDialogHeader>
                    <SmallDialogBody className="space-y-4">
                        {selectedRecord ? (
                            <>
                                <div className="grid gap-3 rounded-2xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-3">
                                    <div>
                                        <p className="text-xs font-semibold text-muted-foreground">{t('errorLogs.timestamp')}</p>
                                        <p className="mt-1 text-sm font-medium">{formatDateTime(selectedRecord.timestamp)}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs font-semibold text-muted-foreground">{t('errorLogs.source')}</p>
                                        <p className="mt-1 text-sm font-medium">
                                            {selectedRecord.source === 'toast'
                                                ? t('errorLogs.sources.toast')
                                                : t('errorLogs.sources.console')}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-xs font-semibold text-muted-foreground">{t('errorLogs.route')}</p>
                                        <p className="mt-1 break-all font-mono text-sm">{selectedRecord.route}</p>
                                    </div>
                                </div>
                                <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                                        <Clipboard className="h-4 w-4 text-primary" />
                                        {t('errorLogs.recordSnapshot')}
                                    </div>
                                    <pre dir="ltr" className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background p-4 text-xs leading-5 text-foreground">
                                        {formatErrorLogRecord(selectedRecord)}
                                    </pre>
                                </div>
                            </>
                        ) : null}
                    </SmallDialogBody>
                    <SmallDialogFooter>
                        <Button type="button" variant="outline" onClick={() => void copySelectedRecord()} disabled={!selectedRecord || isCopying || isExporting} className="gap-2">
                            {isCopying ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                            {t('errorLogs.copy')}
                        </Button>
                        <Button type="button" variant="outline" onClick={() => void exportSelectedRecord()} disabled={!selectedRecord || isExporting || isCopying} className="gap-2">
                            {isExporting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                            {t('errorLogs.export')}
                        </Button>
                        <Button type="button" onClick={() => setSelectedRecord(null)} disabled={isExporting || isCopying}>
                            {t('common.close')}
                        </Button>
                    </SmallDialogFooter>
                </SmallDialogContent>
            </SmallDialog>
        </div>
    )
}
