import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { BellRing, CalendarDays, Eye, Loader2, MessageCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useRoute } from 'wouter'
import { useAuth } from '@/auth/AuthContext'
import { useHashLocation } from '@/hooks/useHashLocation'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  AppPagination,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/ui/components'
import { useDateRange, type DateRangeType } from '@/context/DateRangeContext'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { localizeNotification } from '@/lib/notificationLocalization'
import { formatDate, formatDateTime, formatDocumentDate, parseLocalDateValue } from '@/lib/utils'
import { queryKeys } from '@/query/queryKeys'
import {
  type Beauty3AppointmentReminderListItem,
  useBeauty3AppointmentReminderNotification,
  useBeauty3AppointmentReminderPage,
} from '@/local-db/beauty3AppointmentReminders'
import type { NotificationInboxRecord } from '@/services/notificationInbox'
import { markNotificationInboxRead } from '@/services/notificationInbox'
import { useWorkspace } from '@/workspace'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

const PAGE_SIZE_OPTIONS = [10, 20, 50]
const columnHelper = createColumnHelper<Beauty3AppointmentReminderListItem>()

function readPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

function formatProcedureDate(value: string, fullYear = false) {
  if (!value) return '—'
  const parsed = parseLocalDateValue(value)
  return parsed ? (fullYear ? formatDocumentDate(parsed) : formatDate(parsed)) : value
}

function normalizeIraqWhatsAppPhone(value: string | null) {
  if (!value?.trim()) return null

  const original = value.trim()
  let digits = original.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)

  if (digits.startsWith('964')) {
    // Already stored with Iraq's country code.
  } else if (digits.startsWith('0')) {
    digits = `964${digits.slice(1)}`
  } else if (digits.startsWith('7')) {
    digits = `964${digits}`
  } else if (!original.startsWith('+')) {
    return null
  }

  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

export function Beauty3AppointmentReminders() {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { workspaceName } = useWorkspace()
  const [, setLocation] = useHashLocation()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { dateFilterDayBoundary } = useDateRange()
  const [dateRange, setDateRange] = useState<DateRangeType>('allTime')
  const [customDates, setCustomDates] = useState({ start: '', end: '' })
  const [selectedNotification, setSelectedNotification] = useState<NotificationInboxRecord | null>(null)
  const [, notificationRouteParams] = useRoute('/clinical-appointments/appointment-reminders/:notificationId')
  const requestedNotificationId = notificationRouteParams?.notificationId ?? null
  const autoOpenedNotificationId = useRef<string | null>(null)
  const workspaceId = user?.workspaceId ?? ''
  const userId = user?.id ?? ''
  const resolvedWorkspaceName = workspaceName?.trim() || user?.workspaceName?.trim() || ''
  const isLocalMode = isLocalWorkspaceMode(workspaceId)
  const dateBounds = useMemo(
    () => getDateRangeBounds(dateRange, customDates, new Date(), dateFilterDayBoundary),
    [customDates, dateFilterDayBoundary, dateRange],
  )
  const startAt = dateBounds.start?.toISOString()
  const endBefore = dateBounds.end?.toISOString()
  const pagination = usePaginationState({
    initialPageSize: 20,
    resetOn: [workspaceId, userId, dateRange, customDates.start, customDates.end, dateFilterDayBoundary],
  })
  const pageQuery = useBeauty3AppointmentReminderPage({
    workspaceId,
    userId,
    page: pagination.currentPage,
    pageSize: pagination.pageSize,
    startAt,
    endBefore,
  }, !isLocalMode)
  const notificationQuery = useBeauty3AppointmentReminderNotification({
    workspaceId,
    userId,
    notificationId: requestedNotificationId ?? selectedNotification?.id ?? null,
  }, !isLocalMode)
  const page = pageQuery.data ?? { items: [], totalCount: 0 }
  const paginationBounds = usePaginationBounds({
    currentPage: pagination.currentPage,
    setCurrentPage: pagination.setCurrentPage,
    totalCount: page.totalCount,
    pageSize: pagination.pageSize,
    isLoading: pageQuery.isLoading,
    error: pageQuery.error,
  })

  const openNotification = useCallback(async (notification: NotificationInboxRecord) => {
    setSelectedNotification(notification)
    if (notification.read_at || isLocalMode) return

    try {
      const { success, error } = await markNotificationInboxRead(notification.id, true)
      if (error || !success) {
        toast({ title: t('notifications.updateFailed'), variant: 'destructive' })
        return
      }

      const readAt = new Date().toISOString()
      setSelectedNotification((current) => current?.id === notification.id
        ? { ...current, read_at: readAt }
        : current)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.notificationInbox.all(workspaceId, userId),
      })
    } catch (error) {
      console.error('[Beauty3AppointmentReminders] Failed to mark notification as read:', error)
      toast({ title: t('notifications.updateFailed'), variant: 'destructive' })
    }
  }, [isLocalMode, queryClient, t, toast, userId, workspaceId])

  const closeSelectedNotification = useCallback(() => {
    setSelectedNotification(null)
    autoOpenedNotificationId.current = null
    if (requestedNotificationId) setLocation('/clinical-appointments/appointment-reminders')
  }, [requestedNotificationId, setLocation])

  useEffect(() => {
    const notification = notificationQuery.data
    if (!requestedNotificationId || !notification || notification.id !== requestedNotificationId) return
    if (autoOpenedNotificationId.current === requestedNotificationId) return

    autoOpenedNotificationId.current = requestedNotificationId
    void openNotification(notification)
  }, [notificationQuery.data, openNotification, requestedNotificationId])

  const columns = useMemo(() => [
    columnHelper.accessor((item) => item.created_at, {
      id: 'receivedAt',
      header: t('beauty3AppointmentReminders.receivedAt'),
      cell: (info) => <span className="whitespace-nowrap">{formatDateTime(info.getValue())}</span>,
    }),
    columnHelper.accessor((item) => readPayloadString(item.payload, 'procedure_date') || readPayloadString(item.payload, 'due_date'), {
      id: 'procedureDate',
      header: t('beauty3AppointmentReminders.procedureDate'),
      cell: (info) => <span className="whitespace-nowrap">{formatProcedureDate(info.getValue())}</span>,
    }),
    columnHelper.accessor((item) => item.clientName ?? '', {
      id: 'clientName',
      header: t('beauty3Appointments.name'),
      cell: (info) => <span className="whitespace-nowrap">{info.getValue() || '—'}</span>,
    }),
    columnHelper.accessor((item) => item.clientPhone ?? '', {
      id: 'clientPhone',
      header: t('beauty3Appointments.phoneNumber'),
      cell: (info) => <span className="whitespace-nowrap">{info.getValue() || '—'}</span>,
    }),
    columnHelper.accessor((item) => item.title, {
      id: 'notification',
      header: t('beauty3AppointmentReminders.notification'),
      cell: (info) => {
        const localized = localizeNotification({
          notificationType: info.row.original.notification_type,
          payload: info.row.original.payload,
          title: info.row.original.title,
          body: info.row.original.body,
          actionUrl: info.row.original.action_url,
          actionLabel: info.row.original.action_label,
        }, i18n.language)
        return (
          <button
            type="button"
            onClick={() => void openNotification(info.row.original)}
            className="min-w-64 max-w-xl text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="block font-medium text-foreground">{localized.title}</span>
            {localized.body ? <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{localized.body}</span> : null}
          </button>
        )
      },
    }),
    columnHelper.accessor((item) => item.archived_at ? 'archived' : item.read_at ? 'read' : 'unread', {
      id: 'status',
      header: t('beauty3AppointmentReminders.status'),
      cell: (info) => {
        const status = info.getValue()
        return (
          <span className={status === 'unread'
            ? 'inline-flex whitespace-nowrap rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary'
            : 'inline-flex whitespace-nowrap rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground'}>
            {t(`beauty3AppointmentReminders.statusValues.${status}`)}
          </span>
        )
      },
    }),
    columnHelper.display({
      id: 'actions',
      header: t('common.actions'),
      cell: (info) => {
        const item = info.row.original
        const phone = normalizeIraqWhatsAppPhone(item.clientPhone)
        const clientName = item.clientName?.trim()
        const procedureDate = formatProcedureDate(
          readPayloadString(item.payload, 'procedure_date') || readPayloadString(item.payload, 'due_date'),
          true,
        )
        const interpolation = { escapeValue: false }
        const message = [
          clientName
            ? t('beauty3AppointmentReminders.whatsappGreeting', { clientName, interpolation })
            : t('beauty3AppointmentReminders.whatsappGenericGreeting'),
          t('beauty3AppointmentReminders.whatsappReminderBody', {
            procedureDate,
            workspaceName: resolvedWorkspaceName,
            interpolation,
          }),
        ].join(' ')
        const whatsappUrl = phone && resolvedWorkspaceName
          ? `https://wa.me/send/?phone=${phone}&text=${encodeURIComponent(message)}`
          : null

        return (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void openNotification(item)}
              aria-label={t('beauty3AppointmentReminders.viewNotification')}
              title={t('beauty3AppointmentReminders.viewNotification')}
            >
              <Eye className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={!whatsappUrl}
              onClick={() => {
                if (whatsappUrl) window.open(whatsappUrl, '_blank', 'noopener,noreferrer')
              }}
              aria-label={t('beauty3AppointmentReminders.sendWhatsAppReminder')}
              title={whatsappUrl
                ? t('beauty3AppointmentReminders.sendWhatsAppReminder')
                : resolvedWorkspaceName
                  ? t('beauty3AppointmentReminders.whatsappPhoneUnavailable')
                  : t('beauty3AppointmentReminders.workspaceNameUnavailable')}
            >
              <MessageCircle className="size-4 text-emerald-600" />
            </Button>
          </div>
        )
      },
    }),
  ], [i18n.language, openNotification, resolvedWorkspaceName, t])

  const table = useReactTable({
    data: page.items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualFiltering: true,
    manualPagination: true,
    pageCount: paginationBounds.pageCount,
    rowCount: page.totalCount,
    state: {
      pagination: {
        pageIndex: paginationBounds.currentPage - 1,
        pageSize: pagination.pageSize,
      },
    },
    onPaginationChange: (updater) => {
      const current = {
        pageIndex: paginationBounds.currentPage - 1,
        pageSize: pagination.pageSize,
      }
      const next = typeof updater === 'function' ? updater(current) : updater
      if (next.pageSize !== pagination.pageSize) pagination.setPageSize(next.pageSize)
      else pagination.setCurrentPage(next.pageIndex + 1)
    },
  })

  const selectedLocalized = selectedNotification
    ? localizeNotification({
      notificationType: selectedNotification.notification_type,
      payload: selectedNotification.payload,
      title: selectedNotification.title,
      body: selectedNotification.body,
      actionUrl: selectedNotification.action_url,
      actionLabel: selectedNotification.action_label,
    }, i18n.language)
    : null
  const selectedProcedureDate = selectedNotification
    ? readPayloadString(selectedNotification.payload, 'procedure_date') || readPayloadString(selectedNotification.payload, 'due_date')
    : ''
  const selectedClientDetails = notificationQuery.data?.id === selectedNotification?.id
    ? notificationQuery.data
    : null

  return (
    <div className="w-full space-y-5 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
          <BellRing className="size-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t('beauty3AppointmentReminders.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('beauty3AppointmentReminders.subtitle')}</p>
        </div>
      </div>

      <DateRangeFilters
        label={t('beauty3AppointmentReminders.dateFilter')}
        dateRange={dateRange}
        customDates={customDates}
        onDateRangeChange={setDateRange}
        onCustomDatesChange={setCustomDates}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t('beauty3AppointmentReminders.recordCount', { count: page.totalCount })}
        </p>
        {page.totalCount > 0 ? (
          <AppPagination
            currentPage={paginationBounds.currentPage}
            pageCount={paginationBounds.pageCount}
            totalCount={page.totalCount}
            pageSize={pagination.pageSize}
            onPageChange={pagination.setCurrentPage}
            onPageSizeChange={pagination.setPageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        ) : null}
      </div>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-background">
        {isLocalMode ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <BellRing className="size-8 opacity-60" />
            <p>{t('notifications.localModeUnavailable')}</p>
          </div>
        ) : pageQuery.isLoading ? (
          <div className="flex min-h-56 items-center justify-center gap-3 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-5 animate-spin text-primary" />
            {t('beauty3AppointmentReminders.loading')}
          </div>
        ) : pageQuery.isError ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-destructive">{t('beauty3AppointmentReminders.loadFailed')}</p>
            <Button type="button" variant="outline" onClick={() => void pageQuery.refetch()}>
              {t('common.refresh')}
            </Button>
          </div>
        ) : page.items.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <CalendarDays className="size-8 opacity-60" />
            <p className="font-medium text-foreground">{t('beauty3AppointmentReminders.empty')}</p>
            <p className="max-w-lg text-sm">{t('beauty3AppointmentReminders.emptyHint')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id} className="whitespace-nowrap">
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="max-w-xl align-top">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {page.totalCount > 0 ? (
        <div className="flex justify-end">
          <AppPagination
            currentPage={paginationBounds.currentPage}
            pageCount={paginationBounds.pageCount}
            totalCount={page.totalCount}
            pageSize={pagination.pageSize}
            onPageChange={pagination.setCurrentPage}
            onPageSizeChange={pagination.setPageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        </div>
      ) : null}

      <AppDialog
        open={Boolean(selectedNotification)}
        onOpenChange={(open) => {
          if (!open) closeSelectedNotification()
        }}
      >
        <AppDialogContent className="max-w-2xl">
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2">
              <BellRing className="size-5 text-primary" />
              {selectedLocalized?.title ?? t('beauty3AppointmentReminders.title')}
            </AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="space-y-5">
              <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{selectedLocalized?.body}</p>
              <dl className="grid gap-4 rounded-xl border border-border/70 bg-muted/20 p-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">{t('beauty3Appointments.name')}</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {notificationQuery.isLoading && !selectedClientDetails
                      ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      : selectedClientDetails?.clientName || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">{t('beauty3Appointments.phoneNumber')}</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {notificationQuery.isLoading && !selectedClientDetails
                      ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      : selectedClientDetails?.clientPhone || '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">{t('beauty3AppointmentReminders.receivedAt')}</dt>
                  <dd className="mt-1 text-sm font-medium">{selectedNotification ? formatDateTime(selectedNotification.created_at) : '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">{t('beauty3AppointmentReminders.procedureDate')}</dt>
                  <dd className="mt-1 text-sm font-medium">{formatProcedureDate(selectedProcedureDate)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">{t('beauty3AppointmentReminders.status')}</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {selectedNotification?.archived_at
                      ? t('beauty3AppointmentReminders.statusValues.archived')
                      : selectedNotification?.read_at
                        ? t('beauty3AppointmentReminders.statusValues.read')
                        : t('beauty3AppointmentReminders.statusValues.unread')}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">{t('beauty3AppointmentReminders.notificationId')}</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-muted-foreground">{selectedNotification?.id ?? '—'}</dd>
                </div>
              </dl>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" onClick={closeSelectedNotification}>
              {t('common.close')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>
    </div>
  )
}
