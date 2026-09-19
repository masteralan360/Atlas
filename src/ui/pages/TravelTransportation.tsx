import { useMemo, useState } from 'react'
import { CalendarDays, Eye, Plane, Plus, Search, UsersRound } from 'lucide-react'
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
    type TravelBooking
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import {
    Badge,
    Button,
    Card,
    CardContent,
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
    const { t } = useTranslation()
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

    const passengerNamesByBookingId = useMemo(() => {
        const result = new Map<string, string[]>()
        for (const passenger of workspacePassengers) {
            const names = result.get(passenger.bookingId) ?? []
            names.push(passenger.name)
            result.set(passenger.bookingId, names)
        }
        return result
    }, [workspacePassengers])
    const visibleBookings = useMemo(() => {
        const query = search.trim().toLowerCase()
        return bookings.filter((candidate) => {
            const passengerNames = passengerNamesByBookingId.get(candidate.id) ?? []
            const searchable = [candidate.bookingNumber, candidate.notes || '', ...passengerNames].join(' ').toLowerCase()
            return (!query || searchable.includes(query)) && matchesCreatedDate(candidate.createdAt, dateRange, customDates)
        })
    }, [bookings, customDates, dateRange, passengerNamesByBookingId, search])

    if (!workspace) return null

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
                <Button type="button" onClick={() => setLocation('/travel-transportation/new')}>
                    <Plus className="mr-2 h-4 w-4" />{t('travelTransportation.newBooking')}
                </Button>
            </div>

            <Card className="border-border/60 shadow-sm">
                <CardContent className="space-y-4 pt-6">
                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="relative">
                            <Search className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-muted-foreground" />
                            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('travelTransportation.search')} className="ps-9" />
                        </div>
                        <DateRangeFilters label={t('travelTransportation.table.created')} />
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
        </div>
    )
}
