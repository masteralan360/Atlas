import { useMemo, useState } from 'react'
import { CalendarDays, CircleDollarSign, CreditCard, Eye, History, Plane, Plus, Search, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation, useRoute } from 'wouter'

import { useDateRange } from '@/context/DateRangeContext'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import {
    useTravelBooking,
    useTravelBookingPayments,
    useTravelBookings,
    useTravelPassengers,
    useTravelPassengersForWorkspace,
    summarizeTravelBookings,
    type CurrencyCode,
    type TravelBooking
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    DateRangeFilters,
    Input,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/ui/components'
import { DateRangeBadge } from '@/ui/components/DateRangeBadge'
import { TravelBookingDetailsView } from '@/ui/components/travel/TravelBookingDetailsView'
import { TravelBookingFormPage } from '@/ui/components/travel/TravelBookingFormPage'

function statusClass(status: TravelBooking['status']) {
    if (status === 'completed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    if (status === 'partially_paid') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    if (status === 'cancelled') return 'border-destructive/30 bg-destructive/10 text-destructive'
    if (status === 'booked') return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
    return 'border-muted bg-muted text-muted-foreground'
}

function dateKey(value: string) {
    return value.slice(0, 10)
}

function localDateKey(date: Date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function matchesCreatedDate(
    createdAt: string,
    range: ReturnType<typeof useDateRange>['dateRange'],
    customDates: ReturnType<typeof useDateRange>['customDates']
) {
    const createdKey = dateKey(createdAt)
    const today = new Date()
    if (range === 'allTime') return true
    if (range === 'today') return createdKey === localDateKey(today)
    if (range === 'yesterday') {
        const yesterday = new Date(today)
        yesterday.setDate(today.getDate() - 1)
        return createdKey === localDateKey(yesterday)
    }
    if (range === 'month') return createdKey.slice(0, 7) === localDateKey(today).slice(0, 7)
    if (range === 'lastMonth') {
        const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
        return createdKey.slice(0, 7) === localDateKey(lastMonth).slice(0, 7)
    }
    return (!customDates.start || createdKey >= customDates.start) && (!customDates.end || createdKey <= customDates.end)
}

export function TravelTransportation() {
    const { t, i18n } = useTranslation()
    // WorkspaceContext exposes the selected workspace as `activeWorkspace`.
    // Keeping a local alias preserves the booking data API's workspace naming
    // while ensuring the page does not render an empty main area.
    const { activeWorkspace: workspace, features } = useWorkspace()
    const [location, setLocation] = useLocation()
    const [, editParams] = useRoute('/travel-transportation/:bookingId/edit')
    const [, detailParams] = useRoute('/travel-transportation/:bookingId')
    const isNew = location === '/travel-transportation/new'
    const bookingId = editParams?.bookingId || (!isNew ? detailParams?.bookingId : undefined)
    const isEditing = Boolean(editParams?.bookingId)
    const bookings = useTravelBookings(workspace?.id)
    const booking = useTravelBooking(bookingId)
    const passengers = useTravelPassengers(bookingId, workspace?.id)
    const workspacePassengers = useTravelPassengersForWorkspace(workspace?.id)
    const payments = useTravelBookingPayments(bookingId, workspace?.id)
    const { dateRange, customDates } = useDateRange()
    const [search, setSearch] = useState('')
    const [historyOpen, setHistoryOpen] = useState(false)

    const passengerNamesByBookingId = useMemo(() => {
        const result = new Map<string, string[]>()
        for (const passenger of workspacePassengers) {
            const names = result.get(passenger.bookingId) ?? []
            names.push(passenger.name)
            result.set(passenger.bookingId, names)
        }
        return result
    }, [workspacePassengers])
    const passengerCountByBookingId = useMemo(() => new Map<string, number>(
        [...passengerNamesByBookingId].map(([id, names]) => [id, names.length] as const)
    ), [passengerNamesByBookingId])
    const archivedBookings = useMemo(() => bookings
        .filter((candidate) => candidate.isArchived === true)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [bookings])
    const visibleBookings = useMemo(() => {
        const query = search.trim().toLowerCase()
        return bookings.filter((candidate) => {
            if (candidate.isArchived === true) return false
            const passengerNames = passengerNamesByBookingId.get(candidate.id) ?? []
            const searchable = [candidate.bookingNumber, candidate.notes || '', ...passengerNames].join(' ').toLowerCase()
            return (!query || searchable.includes(query)) && matchesCreatedDate(candidate.createdAt, dateRange, customDates)
        })
    }, [bookings, customDates, dateRange, passengerNamesByBookingId, search])
    const summary = useMemo(
        () => summarizeTravelBookings(visibleBookings, passengerCountByBookingId),
        [passengerCountByBookingId, visibleBookings]
    )

    if (!workspace) return null

    const defaultCurrency = features.default_currency || 'usd'
    const sortCurrencyEntries = (totals: Record<string, number>): [string, number][] => {
        const entries = Object.entries(totals).sort(([left], [right]) => {
            if (left === defaultCurrency) return -1
            if (right === defaultCurrency) return 1
            return left.localeCompare(right)
        })
        return entries.length > 0 ? entries : [[defaultCurrency, 0]]
    }
    const totalProfitEntries = sortCurrencyEntries(summary.profitByCurrency)
    const outstandingProfitEntries = sortCurrencyEntries(summary.outstandingProfitByCurrency)

    if (isNew) {
        return <TravelBookingFormPage
            workspaceId={workspace.id}
            onCancel={() => setLocation('/travel-transportation')}
            onSaved={(id) => setLocation(`/travel-transportation/${id}`)}
        />
    }

    if (bookingId && booking && !booking.isDeleted) {
        if (isEditing) {
            return <TravelBookingFormPage
                workspaceId={workspace.id}
                booking={booking}
                existingPassengers={passengers}
                onCancel={() => setLocation(`/travel-transportation/${booking.id}`)}
                onSaved={(id) => setLocation(`/travel-transportation/${id}`)}
            />
        }
        return <TravelBookingDetailsView
            booking={booking}
            passengers={passengers}
            payments={payments}
            onBack={() => setLocation('/travel-transportation')}
            onEdit={() => setLocation(`/travel-transportation/${booking.id}/edit`)}
        />
    }

    return (
        <div className="space-y-6 p-4 sm:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <div className="flex items-center gap-3">
                        <span className="rounded-2xl bg-primary/10 p-3 text-primary"><Plane className="h-6 w-6" /></span>
                        <div>
                            <h1 className="flex flex-wrap items-center gap-3 text-3xl font-bold tracking-tight">
                                {t('travelTransportation.title')}
                                <DateRangeBadge />
                            </h1>
                            <p className="mt-1 text-sm text-muted-foreground">{t('travelTransportation.subtitle')}</p>
                        </div>
                    </div>
                </div>
                <div className="flex w-full flex-col gap-3 sm:flex-row lg:w-auto">
                    <DateRangeFilters label={t('travelTransportation.table.created')} className="w-full lg:w-auto" />
                    {archivedBookings.length > 0 ? <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setHistoryOpen(true)}>
                        <History className="mr-2 h-4 w-4" />{t('travelTransportation.history.open')}
                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">{new Intl.NumberFormat(i18n.language).format(archivedBookings.length)}</span>
                    </Button> : null}
                    <Button type="button" className="w-full sm:w-auto" onClick={() => setLocation('/travel-transportation/new')}>
                        <Plus className="mr-2 h-4 w-4" />{t('travelTransportation.newBooking')}
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <Card className="rounded-2xl border-border/80 shadow-none">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                        <CardTitle className="text-sm font-semibold text-muted-foreground">
                            {t('travelTransportation.summary.totalPassengers')}
                        </CardTitle>
                        <span className="rounded-xl bg-muted/60 p-2 text-muted-foreground"><UsersRound className="h-4 w-4" /></span>
                    </CardHeader>
                    <CardContent className="pt-0">
                        <div className="text-3xl font-black tracking-tight">{new Intl.NumberFormat(i18n.language).format(summary.totalPassengers)}</div>
                    </CardContent>
                </Card>

                <Card className="rounded-2xl border-border/80 shadow-none">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                        <CardTitle className="text-sm font-semibold text-muted-foreground">
                            {t('travelTransportation.summary.totalProfit')}
                        </CardTitle>
                        <span className="rounded-xl bg-emerald-500/10 p-2 text-emerald-700 dark:text-emerald-300"><CircleDollarSign className="h-4 w-4" /></span>
                    </CardHeader>
                    <CardContent className="space-y-1 pt-0">
                        {totalProfitEntries.map(([currency, amount], index) => (
                            <div key={currency} className={cn('break-words font-black leading-tight tracking-tight', index === 0 ? 'text-3xl' : 'text-base text-muted-foreground')}>
                                {formatCurrency(amount, currency as CurrencyCode, features.iqd_display_preference)}
                            </div>
                        ))}
                    </CardContent>
                </Card>

                <Card className="rounded-2xl border-border/80 shadow-none">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                        <CardTitle className="text-sm font-semibold text-muted-foreground">
                            {t('travelTransportation.summary.totalOutstandingProfit')}
                        </CardTitle>
                        <span className="rounded-xl bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300"><CreditCard className="h-4 w-4" /></span>
                    </CardHeader>
                    <CardContent className="space-y-1 pt-0">
                        {outstandingProfitEntries.map(([currency, amount], index) => (
                            <div key={currency} className={cn('break-words font-black leading-tight tracking-tight', index === 0 ? 'text-3xl' : 'text-base text-muted-foreground')}>
                                {formatCurrency(amount, currency as CurrencyCode, features.iqd_display_preference)}
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>

            <Card className="border-border/60 shadow-sm">
                <CardContent className="space-y-4 pt-6">
                    <div className="relative">
                        <Search className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-muted-foreground" />
                        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('travelTransportation.search')} className="ps-9" />
                    </div>
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader><TableRow>
                                <TableHead>{t('travelTransportation.bookingNumber')}</TableHead>
                                <TableHead>{t('travelTransportation.table.travelDate')}</TableHead>
                                <TableHead>{t('travelTransportation.table.passengerCount')}</TableHead>
                                <TableHead>{t('travelTransportation.table.status')}</TableHead>
                                <TableHead className="text-end">{t('travelTransportation.table.profit')}</TableHead>
                                <TableHead className="text-end">{t('travelTransportation.table.outstanding')}</TableHead>
                                <TableHead className="text-end">{t('travelTransportation.table.actions')}</TableHead>
                            </TableRow></TableHeader>
                            <TableBody>
                                {visibleBookings.length === 0 ? <TableRow><TableCell colSpan={7} className="py-12 text-center text-muted-foreground">{t('travelTransportation.empty')}</TableCell></TableRow> : visibleBookings.map((candidate) => {
                                    const passengerCount = passengerNamesByBookingId.get(candidate.id)?.length ?? 0
                                    return <TableRow key={candidate.id} className="cursor-pointer" onClick={() => setLocation(`/travel-transportation/${candidate.id}`)}>
                                        <TableCell className="font-semibold">{candidate.bookingNumber}</TableCell>
                                        <TableCell>{candidate.travelDate ? <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />{formatDate(candidate.travelDate)}</span> : '-'}</TableCell>
                                        <TableCell><span className="inline-flex items-center gap-1.5"><UsersRound className="h-3.5 w-3.5 text-muted-foreground" />{passengerCount}</span></TableCell>
                                        <TableCell><Badge className={cn('capitalize', statusClass(candidate.status))}>{t(`travelTransportation.statuses.${candidate.status}`)}</Badge></TableCell>
                                        <TableCell className="text-end">{candidate.status === 'cancelled' ? '--' : formatCurrency(candidate.profitAmount, candidate.currency, features.iqd_display_preference)}</TableCell>
                                        <TableCell className="text-end">{candidate.status === 'cancelled' ? '--' : formatCurrency(candidate.outstandingProfitAmount, candidate.currency, features.iqd_display_preference)}</TableCell>
                                        <TableCell className="text-end"><Button type="button" variant="ghost" size="icon" onClick={(event) => { event.stopPropagation(); setLocation(`/travel-transportation/${candidate.id}`) }} aria-label={t('common.view')}><Eye className="h-4 w-4" /></Button></TableCell>
                                    </TableRow>
                                })}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>

            <AppDialog open={historyOpen} onOpenChange={setHistoryOpen}>
                <AppDialogContent className="max-w-4xl">
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <History className="h-5 w-5 text-primary" />
                            {t('travelTransportation.history.title')}
                        </AppDialogTitle>
                    </AppDialogHeader>
                    <AppDialogBody className="space-y-3">
                        {archivedBookings.length === 0 ? (
                            <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                                {t('travelTransportation.history.empty')}
                            </div>
                        ) : archivedBookings.map((archivedBooking) => {
                            const passengerCount = passengerNamesByBookingId.get(archivedBooking.id)?.length ?? 0
                            return <div key={archivedBooking.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-background p-3 sm:p-4">
                                <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-semibold">{archivedBooking.bookingNumber}</span>
                                        <Badge className={cn('capitalize', statusClass(archivedBooking.status))}>{t(`travelTransportation.statuses.${archivedBooking.status}`)}</Badge>
                                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                                            <History className="h-3 w-3" />{t('travelTransportation.history.badge')}
                                        </span>
                                    </div>
                                    <div className="text-sm text-muted-foreground">
                                        {t('travelTransportation.history.passengerCount', { count: passengerCount })}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {formatDate(archivedBooking.createdAt)} · {formatCurrency(archivedBooking.profitAmount, archivedBooking.currency, features.iqd_display_preference)}
                                    </div>
                                </div>
                                <Button type="button" variant="outline" className="shrink-0 gap-2" onClick={() => {
                                    setHistoryOpen(false)
                                    setLocation(`/travel-transportation/${archivedBooking.id}`)
                                }}>
                                    <Eye className="h-4 w-4" />{t('travelTransportation.history.view')}
                                </Button>
                            </div>
                        })}
                    </AppDialogBody>
                    <AppDialogFooter>
                        <Button type="button" variant="outline" onClick={() => setHistoryOpen(false)}>{t('common.cancel')}</Button>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>
        </div>
    )
}
