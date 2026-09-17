import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import {
    AlertTriangle,
    CheckCircle2,
    CircleDotDashed,
    Clock3,
    Database,
    FileSearch,
    LoaderCircle,
    Search,
    ShieldCheck,
    Trash2,
    UploadCloud,
} from 'lucide-react'
import type { DateRangeType } from '@/context/DateRangeContext'
import { useAuth } from '@/auth'
import { db } from '@/local-db'
import type { MutationStatus, OfflineMutation } from '@/local-db/models'
import {
    canRecoverOfflineMutation,
    discardAndRestoreOfflineMutation,
} from '@/local-db/offlineMutationRecovery'
import { formatDateTime } from '@/lib/utils'
import { useSyncStatus } from '@/sync'
import {
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    DateRangeFilters,
    DeleteConfirmationModal,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
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
import {
    MUTATION_QUEUE_STATUSES,
    canStartMutationQueueSync,
    filterMutationQueueRows,
    getMutationQueueRecoveryFailureKey,
    getMutationQueueStatusCounts,
    requestMutationQueueSync,
    type MutationQueueStatusFilter,
} from './mutationQueueUtils'

const EMPTY_MUTATION_QUEUE: OfflineMutation[] = []

function getStatusIcon(status: MutationStatus) {
    switch (status) {
        case 'pending':
            return Clock3
        case 'syncing':
            return LoaderCircle
        case 'failed':
            return AlertTriangle
        case 'synced':
            return CheckCircle2
        case 'discarded':
            return Trash2
    }
}

function getStatusClassName(status: MutationStatus) {
    switch (status) {
        case 'pending':
            return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        case 'syncing':
            return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
        case 'failed':
            return 'border-destructive/30 bg-destructive/10 text-destructive'
        case 'synced':
            return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        case 'discarded':
            return 'border-muted-foreground/30 bg-muted text-muted-foreground'
    }
}

function formatPayload(payload: OfflineMutation['payload']) {
    try {
        return JSON.stringify(payload, null, 2)
    } catch {
        return ''
    }
}

export function MutationQueue() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user, isSupabaseConfigured } = useAuth()
    const { sync, isOnline, isSyncing } = useSyncStatus()
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState<MutationQueueStatusFilter>('actionable')
    const [dateRange, setDateRange] = useState<DateRangeType>('allTime')
    const [customDates, setCustomDates] = useState({ start: '', end: '' })
    const [selectedMutation, setSelectedMutation] = useState<OfflineMutation | null>(null)
    const [discardTarget, setDiscardTarget] = useState<OfflineMutation | null>(null)
    const [isDiscarding, setIsDiscarding] = useState(false)

    const mutations = useLiveQuery(
        () => user?.workspaceId
            ? db.offline_mutations.where('workspaceId').equals(user.workspaceId).toArray()
            : [],
        [user?.workspaceId]
    )
    const queueRows = mutations ?? EMPTY_MUTATION_QUEUE
    const isLoading = mutations === undefined

    const filteredMutations = useMemo(() => filterMutationQueueRows(
        queueRows,
        user?.workspaceId,
        { search, status: statusFilter, dateRange, customDates }
    ), [customDates, dateRange, queueRows, search, statusFilter, user?.workspaceId])
    const statusCounts = useMemo(
        () => getMutationQueueStatusCounts(queueRows, user?.workspaceId),
        [queueRows, user?.workspaceId]
    )
    const canSync = canStartMutationQueueSync({ isOnline, isSyncing, isSupabaseConfigured })

    const startSync = async () => {
        await requestMutationQueueSync({ isOnline, isSyncing, isSupabaseConfigured, sync })
    }

    const discardMutation = async () => {
        if (!discardTarget || !user?.workspaceId || !user.id || isDiscarding) return

        setIsDiscarding(true)
        try {
            const result = await discardAndRestoreOfflineMutation(
                user.workspaceId,
                discardTarget.id,
                user.id
            )

            if (result.status === 'discarded') {
                toast({
                    title: t('mutationQueue.discardSuccessTitle'),
                    description: t(
                        result.action === 'restored'
                            ? 'mutationQueue.discardedRestored'
                            : 'mutationQueue.discardedRemoved'
                    ),
                })
                if (selectedMutation?.id === discardTarget.id) setSelectedMutation(null)
                setDiscardTarget(null)
                return
            }

            toast({
                title: t('mutationQueue.discardFailedTitle'),
                description: t(getMutationQueueRecoveryFailureKey(result.reason)),
                variant: 'destructive',
            })
        } finally {
            setIsDiscarding(false)
        }
    }

    return (
        <div className="space-y-6">
            <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                        <Database className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                        <h1 className="text-3xl font-bold tracking-tight">{t('mutationQueue.title')}</h1>
                        <p className="mt-1 text-sm text-muted-foreground">{t('mutationQueue.subtitle')}</p>
                    </div>
                </div>
                <Button
                    type="button"
                    onClick={() => void startSync()}
                    disabled={!canSync}
                    className="gap-2"
                    title={!canSync ? t('mutationQueue.syncUnavailable') : undefined}
                >
                    {isSyncing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                    {t('mutationQueue.syncNow')}
                </Button>
            </header>

            <Card className="border-primary/20 bg-primary/[0.03]">
                <CardContent className="flex items-start gap-3 p-4 text-sm text-muted-foreground">
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <p>{t('mutationQueue.deviceOnly')}</p>
                </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                {MUTATION_QUEUE_STATUSES.map((status) => {
                    const StatusIcon = getStatusIcon(status)
                    return (
                        <Card key={status} className="overflow-hidden">
                            <CardContent className="flex items-center gap-3 p-4">
                                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${getStatusClassName(status)}`}>
                                    <StatusIcon className={`h-4 w-4 ${status === 'syncing' ? 'animate-spin' : ''}`} />
                                </span>
                                <div>
                                    <p className="text-2xl font-bold tabular-nums">{statusCounts[status]}</p>
                                    <p className="text-xs text-muted-foreground">{t(`mutationQueue.statuses.${status}`)}</p>
                                </div>
                            </CardContent>
                        </Card>
                    )
                })}
            </div>

            <Card>
                <CardHeader className="gap-4 xl:flex-row xl:items-end xl:justify-between">
                    <div>
                        <CardTitle className="flex items-center gap-2">
                            <CircleDotDashed className="h-5 w-5 text-primary" />
                            {t('mutationQueue.recordsTitle')}
                        </CardTitle>
                        <CardDescription>{t('mutationQueue.recordsDescription')}</CardDescription>
                    </div>
                    <div className="relative w-full xl:max-w-sm">
                        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('mutationQueue.search')}
                            className="ps-9"
                        />
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_260px] xl:items-end">
                        <DateRangeFilters
                            label={t('mutationQueue.dateFilter')}
                            dateRange={dateRange}
                            customDates={customDates}
                            onDateRangeChange={setDateRange}
                            onCustomDatesChange={setCustomDates}
                        />
                        <div className="space-y-2">
                            <label className="text-sm font-medium" htmlFor="mutation-queue-status">
                                {t('mutationQueue.status')}
                            </label>
                            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as MutationQueueStatusFilter)}>
                                <SelectTrigger id="mutation-queue-status">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="actionable">{t('mutationQueue.statuses.actionable')}</SelectItem>
                                    <SelectItem value="allHistory">{t('mutationQueue.statuses.allHistory')}</SelectItem>
                                    {MUTATION_QUEUE_STATUSES.map((status) => (
                                        <SelectItem key={status} value={status}>{t(`mutationQueue.statuses.${status}`)}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="overflow-x-auto rounded-2xl border border-border/60">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('mutationQueue.createdAt')}</TableHead>
                                    <TableHead>{t('mutationQueue.status')}</TableHead>
                                    <TableHead>{t('mutationQueue.entityType')}</TableHead>
                                    <TableHead>{t('mutationQueue.operation')}</TableHead>
                                    <TableHead>{t('mutationQueue.entityId')}</TableHead>
                                    <TableHead>{t('mutationQueue.error')}</TableHead>
                                    <TableHead>{t('mutationQueue.discardAudit')}</TableHead>
                                    <TableHead className="w-[1%] whitespace-nowrap text-end">{t('common.actions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {isLoading ? (
                                    <TableRow>
                                        <TableCell colSpan={8} className="h-40 text-center text-muted-foreground">
                                            <LoaderCircle className="mx-auto mb-3 h-5 w-5 animate-spin text-primary" />
                                            {t('mutationQueue.loading')}
                                        </TableCell>
                                    </TableRow>
                                ) : filteredMutations.length > 0 ? filteredMutations.map((mutation) => {
                                    const StatusIcon = getStatusIcon(mutation.status)
                                    const canDiscard = canRecoverOfflineMutation(mutation)
                                    return (
                                        <TableRow key={mutation.id}>
                                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                                {formatDateTime(mutation.createdAt)}
                                            </TableCell>
                                            <TableCell>
                                                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium ${getStatusClassName(mutation.status)}`}>
                                                    <StatusIcon className={`h-3.5 w-3.5 ${mutation.status === 'syncing' ? 'animate-spin' : ''}`} />
                                                    {t(`mutationQueue.statuses.${mutation.status}`)}
                                                </span>
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap font-mono text-xs">{mutation.entityType}</TableCell>
                                            <TableCell className="whitespace-nowrap text-sm">{t(`mutationQueue.operations.${mutation.operation}`)}</TableCell>
                                            <TableCell className="max-w-48 truncate font-mono text-xs" title={mutation.entityId}>{mutation.entityId}</TableCell>
                                            <TableCell className="max-w-xs">
                                                <p className="truncate text-sm" title={mutation.error}>{mutation.error || t('mutationQueue.noError')}</p>
                                            </TableCell>
                                            <TableCell className="max-w-xs text-xs text-muted-foreground">
                                                {mutation.discardedAt
                                                    ? <span title={mutation.discardedBy}>{formatDateTime(mutation.discardedAt)}</span>
                                                    : '—'}
                                            </TableCell>
                                            <TableCell className="text-end">
                                                <div className="flex justify-end gap-2">
                                                    <Button type="button" size="sm" variant="outline" onClick={() => setSelectedMutation(mutation)} className="gap-2">
                                                        <FileSearch className="h-4 w-4" />
                                                        {t('mutationQueue.details')}
                                                    </Button>
                                                    {canDiscard ? (
                                                        <Button type="button" size="sm" variant="destructive" onClick={() => setDiscardTarget(mutation)} className="gap-2">
                                                            <Trash2 className="h-4 w-4" />
                                                            {t('mutationQueue.discardAndRestore')}
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )
                                }) : (
                                    <TableRow>
                                        <TableCell colSpan={8} className="h-40 text-center">
                                            <CircleDotDashed className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
                                            <p className="text-sm text-muted-foreground">
                                                {queueRows.length > 0 ? t('mutationQueue.noMatchingRecords') : t('mutationQueue.noRecords')}
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
                open={selectedMutation !== null}
                onOpenChange={(open) => {
                    if (!open && !isDiscarding) setSelectedMutation(null)
                }}
            >
                <SmallDialogContent className="sm:max-w-4xl">
                    <SmallDialogHeader>
                        <SmallDialogTitle className="flex items-center gap-2">
                            <FileSearch className="h-5 w-5 text-primary" />
                            {t('mutationQueue.detailsTitle')}
                        </SmallDialogTitle>
                        <SmallDialogDescription>{t('mutationQueue.detailsDescription')}</SmallDialogDescription>
                    </SmallDialogHeader>
                    <SmallDialogBody className="space-y-4">
                        {selectedMutation ? (
                            <>
                                <div className="grid gap-3 rounded-2xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-2 xl:grid-cols-3">
                                    <MutationDetail label={t('mutationQueue.createdAt')} value={formatDateTime(selectedMutation.createdAt)} />
                                    <MutationDetail label={t('mutationQueue.status')} value={t(`mutationQueue.statuses.${selectedMutation.status}`)} />
                                    <MutationDetail label={t('mutationQueue.operation')} value={t(`mutationQueue.operations.${selectedMutation.operation}`)} />
                                    <MutationDetail label={t('mutationQueue.entityType')} value={selectedMutation.entityType} mono />
                                    <MutationDetail label={t('mutationQueue.entityId')} value={selectedMutation.entityId} mono />
                                    <MutationDetail
                                        label={t('mutationQueue.discardAudit')}
                                        value={selectedMutation.discardedAt
                                            ? `${formatDateTime(selectedMutation.discardedAt)}${selectedMutation.discardedBy ? ` · ${selectedMutation.discardedBy}` : ''}`
                                            : t('mutationQueue.notDiscarded')}
                                    />
                                </div>
                                <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                                    <p className="text-xs font-semibold text-muted-foreground">{t('mutationQueue.error')}</p>
                                    <p className="mt-1 break-words text-sm">{selectedMutation.error || t('mutationQueue.noError')}</p>
                                </div>
                                <details className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                                    <summary className="cursor-pointer text-sm font-semibold">{t('mutationQueue.showPayload')}</summary>
                                    <p className="mt-2 text-xs text-muted-foreground">{t('mutationQueue.payloadDescription')}</p>
                                    <pre dir="ltr" className="mt-3 max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background p-4 text-xs leading-5 text-foreground">
                                        {formatPayload(selectedMutation.payload)}
                                    </pre>
                                </details>
                            </>
                        ) : null}
                    </SmallDialogBody>
                    <SmallDialogFooter>
                        <Button type="button" onClick={() => setSelectedMutation(null)} disabled={isDiscarding}>
                            {t('common.close')}
                        </Button>
                    </SmallDialogFooter>
                </SmallDialogContent>
            </SmallDialog>

            <DeleteConfirmationModal
                isOpen={discardTarget !== null}
                onClose={() => {
                    if (!isDiscarding) setDiscardTarget(null)
                }}
                onConfirm={() => void discardMutation()}
                isLoading={isDiscarding}
                simpleConfirmation
                confirmLabel={t('mutationQueue.discardAndRestore')}
                title={t('mutationQueue.discardTitle')}
                description={t('mutationQueue.discardDescription')}
                itemName={discardTarget
                    ? t('mutationQueue.discardTarget', { entityType: discardTarget.entityType, entityId: discardTarget.entityId })
                    : ''}
            />
        </div>
    )
}

function MutationDetail({ label, value, mono = false }: { label: string, value: string, mono?: boolean }) {
    return (
        <div>
            <p className="text-xs font-semibold text-muted-foreground">{label}</p>
            <p className={`mt-1 break-all text-sm font-medium ${mono ? 'font-mono' : ''}`}>{value}</p>
        </div>
    )
}
