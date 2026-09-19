import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Ban,
  CalendarClock,
  Check,
  CircleCheck,
  ClipboardCheck,
  Clock3,
  FileText,
  PauseCircle,
  Pencil,
  Plus,
  ShieldCheck,
  UserRound,
  UsersRound,
  WalletCards,
  X
} from 'lucide-react'
import { useLocation } from 'wouter'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import {
  createCashierShiftAssignment,
  createCashierShiftTemplate,
  completeCashierShiftOccurrence,
  getCashierShiftListRows,
  getCashierShiftTeamRows,
  getCashierShiftCompletionEligibility,
  requestCashierShiftEarlyFinish,
  summarizeCashierShiftTransactions,
  startCashierShiftOccurrence,
  updateCashierShiftAssignment,
  type CashierShiftAssignment,
  type CashierShiftAssignmentMode,
  type CashierShiftEarlyFinishPolicy,
  type CashierShiftListRow,
  type CashierShiftListStatus,
  useCashierShiftAssignments,
  useCashierShiftOccurrences,
  useCashierShiftTemplates,
  usePaymentAccounts,
  usePaymentTransactions,
  useWorkspaceUsers
} from '@/local-db'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import { formatCurrency, formatTime } from '@/lib/utils'
import { useWorkspacePermissions } from '@/permissions'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DateRangeFilters,
  DateTimePicker,
  Input,
  Label,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast
} from '@/ui/components'
import { DateRangeBadge } from '@/ui/components/DateRangeBadge'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { PressAndHoldButton } from '@/ui/components/PressAndHoldButton'
import { useWorkspace } from '@/workspace'

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const
const DEFAULT_TIME_DATE = new Date(2000, 0, 1, 8, 0, 0, 0)
const DEFAULT_END_TIME_DATE = new Date(2000, 0, 1, 16, 0, 0, 0)
const DEFAULT_EARLY_FINISH_OFFSET_MINUTES = '15'

type ShiftDisplayStatus = CashierShiftListStatus
type ShiftDisplayRow = CashierShiftListRow

function timeKey(value: Date | undefined) {
  if (!value) return ''
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
}

function timeDate(value: string) {
  const [hours, minutes] = value.split(':').map(Number)
  return new Date(2000, 0, 1, hours, minutes)
}

function isOvernight(startTime: string, endTime: string) {
  return Boolean(startTime && endTime && endTime <= startTime)
}

function statusClass(status: ShiftDisplayStatus) {
  switch (status) {
    case 'available':
      return 'border-primary/20 bg-primary/10 text-primary'
    case 'active':
      return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700'
    case 'paused':
      return 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'completed':
      return 'border-slate-500/20 bg-slate-500/10 text-muted-foreground'
    case 'terminated':
      return 'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300'
    default:
      return 'border-primary/20 bg-primary/10 text-primary'
  }
}

function statusIcon(status: ShiftDisplayStatus) {
  if (status === 'paused') return <PauseCircle className="h-3.5 w-3.5" />
  if (status === 'terminated') return <Ban className="h-3.5 w-3.5" />
  if (status === 'completed') return <CircleCheck className="h-3.5 w-3.5" />
  return <Clock3 className="h-3.5 w-3.5" />
}

function formatCashierShiftCompletionAmount(
  summaries: ReturnType<typeof summarizeCashierShiftTransactions>,
  direction: 'incoming' | 'outgoing'
) {
  if (summaries.length === 0) return '0'

  return summaries
    .map((summary) => formatCurrency(direction === 'incoming' ? summary.incomingAmount : summary.outgoingAmount, summary.currency))
    .join(' • ')
}

export function CashierShifts() {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const { user } = useAuth()
  const { hasFeature } = useWorkspace()
  const { hasPermission } = useWorkspacePermissions()
  const [, navigate] = useLocation()
  const { dateRange, customDates } = useDateRange()
  const workspaceId = user?.workspaceId
  const currentUserId = user?.id
  const members = useWorkspaceUsers(workspaceId)
  const templates = useCashierShiftTemplates(workspaceId)
  const assignments = useCashierShiftAssignments(workspaceId)
  const occurrences = useCashierShiftOccurrences(workspaceId)
  const paymentAccounts = usePaymentAccounts(workspaceId)
  const paymentTransactions = usePaymentTransactions(workspaceId, {}, { hydrateSourceTables: false })
  const enabled =
    hasFeature('payment_accounts') && hasFeature('cashier_shift_control') && hasPermission('cashierShiftControl.access')

  const isAdmin = user?.role === 'admin'
  const [activeTab, setActiveTab] = useState<'shifts' | 'team' | 'assignments'>('shifts')
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)
  const [assignmentDialogOpen, setAssignmentDialogOpen] = useState(false)
  const [editingAssignment, setEditingAssignment] = useState<CashierShiftAssignment | null>(null)
  const [startDialogRow, setStartDialogRow] = useState<ShiftDisplayRow | null>(null)
  const [completeDialogRow, setCompleteDialogRow] = useState<ShiftDisplayRow | null>(null)
  const [earlyFinishRequestRow, setEarlyFinishRequestRow] = useState<ShiftDisplayRow | null>(null)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [savingAssignment, setSavingAssignment] = useState(false)
  const [startingShift, setStartingShift] = useState(false)
  const [completingShift, setCompletingShift] = useState(false)
  const [requestingEarlyFinish, setRequestingEarlyFinish] = useState(false)
  const [now, setNow] = useState(() => new Date())

  const [templateName, setTemplateName] = useState('')
  const [templateStartTime, setTemplateStartTime] = useState<Date | undefined>(new Date(DEFAULT_TIME_DATE))
  const [templateEndTime, setTemplateEndTime] = useState<Date | undefined>(new Date(DEFAULT_END_TIME_DATE))

  const [cashDrawerId, setCashDrawerId] = useState<string | null>(null)
  const [cashierUserId, setCashierUserId] = useState('')
  const [selectedTemplateId, setSelectedTemplateId] = useState('__custom__')
  const [assignmentMode, setAssignmentMode] = useState<CashierShiftAssignmentMode>('scheduled')
  const [assignmentStartTime, setAssignmentStartTime] = useState<Date | undefined>(new Date(DEFAULT_TIME_DATE))
  const [assignmentEndTime, setAssignmentEndTime] = useState<Date | undefined>(new Date(DEFAULT_END_TIME_DATE))
  const [workingDays, setWorkingDays] = useState<number[]>([0, 1, 2, 3, 4])
  const [earlyFinishPolicy, setEarlyFinishPolicy] = useState<CashierShiftEarlyFinishPolicy>('scheduled_end')
  const [earlyFinishOffsetMinutes, setEarlyFinishOffsetMinutes] = useState(DEFAULT_EARLY_FINISH_OFFSET_MINUTES)
  const [completionReason, setCompletionReason] = useState('')
  const [earlyFinishRequestReason, setEarlyFinishRequestReason] = useState('')

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (isAdmin && activeTab === 'shifts') {
      setActiveTab('team')
      return
    }

    if (!isAdmin && activeTab !== 'shifts') setActiveTab('shifts')
  }, [activeTab, isAdmin])

  const workspaceMembers = useMemo(
    () =>
      members
        .filter((member) => !member.isDeleted)
        .sort((left, right) => (left.name || left.email).localeCompare(right.name || right.email)),
    [members]
  )
  const selectedCashier = useMemo(
    () => workspaceMembers.find((member) => member.id === cashierUserId) ?? null,
    [cashierUserId, workspaceMembers]
  )
  const selectedCashDrawer = useMemo(
    () => (cashDrawerId ? (paymentAccounts.find((account) => account.id === cashDrawerId) ?? null) : null),
    [cashDrawerId, paymentAccounts]
  )
  const hasValidCashDrawer = Boolean(
    selectedCashDrawer &&
    selectedCashDrawer.accountType === 'cash_drawer' &&
    selectedCashDrawer.isActive &&
    !selectedCashDrawer.isDeleted
  )
  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [selectedTemplateId, templates]
  )
  const activeTemplates = useMemo(() => templates.filter((template) => template.isActive), [templates])
  const activeAssignments = useMemo(() => assignments.filter((assignment) => assignment.isActive), [assignments])
  const hasActiveShift = occurrences.some(
    (occurrence) =>
      occurrence.cashierUserId === currentUserId && (occurrence.status === 'active' || occurrence.status === 'paused')
  )
  const visibleAssignments = useMemo(
    () =>
      [...activeAssignments].sort(
        (left, right) =>
          Number(right.cashierUserId === currentUserId) - Number(left.cashierUserId === currentUserId) ||
          left.cashierNameSnapshot.localeCompare(right.cashierNameSnapshot)
      ),
    [activeAssignments, currentUserId]
  )

  const weekdayLabel = (day: number) => t(`paymentAccounts.weekdays.${day}`)
  const workingDayList = (days: number[]) => {
    const labels = [...days].sort((left, right) => left - right).map(weekdayLabel)
    if (labels.length < 2) return labels[0] ?? ''

    return labels.reduce((list, day, index) => {
      if (index === 0) return day
      if (index === 1 && labels.length === 2) {
        return t('paymentAccounts.weekdayListPair', { first: list, last: day })
      }
      if (index === labels.length - 1) {
        return t('paymentAccounts.weekdayListEnd', { list, last: day })
      }
      return t('paymentAccounts.weekdayListContinue', { list, next: day })
    }, '')
  }
  const formatScheduleTime = (value: Date | undefined) => (value ? formatTime(value) : t('paymentAccounts.timeNotSet'))
  const formatOccurrenceDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value))
  const formatShiftStartedDateTime = (value: string) => {
    const date = new Date(value)
    return t('paymentAccounts.shiftStartedDateTime', {
      weekday: new Intl.DateTimeFormat(i18n.language, { weekday: 'long' }).format(date),
      date: `${String(date.getFullYear()).slice(-2)}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(
        date.getDate()
      ).padStart(2, '0')}`,
      time: new Intl.DateTimeFormat(i18n.language, {
        hour: '2-digit',
        minute: '2-digit'
      }).format(date)
    })
  }

  const shiftRows = useMemo(() => {
    return getCashierShiftListRows({
      assignments,
      occurrences,
      cashierUserId: currentUserId,
      now
    }).filter((row) => isDateInDateRange(row.scheduledStartAt, dateRange, customDates))
  }, [assignments, currentUserId, customDates, dateRange, now, occurrences])
  const teamShiftRows = useMemo(
    () =>
      getCashierShiftTeamRows({ assignments, occurrences }).filter((row) =>
        isDateInDateRange(row.scheduledStartAt, dateRange, customDates)
      ),
    [assignments, customDates, dateRange, occurrences]
  )

  const assignmentStartKey = timeKey(assignmentStartTime)
  const assignmentEndKey = timeKey(assignmentEndTime)
  const assignmentDurationMinutes =
    assignmentStartTime && assignmentEndTime
      ? assignmentEndTime.getHours() * 60 +
        assignmentEndTime.getMinutes() -
        (assignmentStartTime.getHours() * 60 + assignmentStartTime.getMinutes()) +
        (isOvernight(assignmentStartKey, assignmentEndKey) ? 1_440 : 0)
      : 0
  const assignmentSummary = (() => {
    if (!selectedCashier) return null
    if (assignmentMode === 'login_logout')
      return t('paymentAccounts.assignmentModeSummaries.login_logout', {
        cashier: selectedCashier.name || selectedCashier.email
      })
    if (assignmentMode === 'manual')
      return workingDays.length
        ? t('paymentAccounts.assignmentModeSummaries.manual', {
            cashier: selectedCashier.name || selectedCashier.email,
            days: workingDayList(workingDays)
          })
        : null
    if (!selectedCashier || !assignmentStartTime || !assignmentEndTime || workingDays.length === 0) return null
    const values = {
      cashier: selectedCashier.name || selectedCashier.email,
      startTime: formatScheduleTime(assignmentStartTime),
      endTime: formatScheduleTime(assignmentEndTime),
      days: workingDayList(workingDays)
    }
    return isOvernight(assignmentStartKey, assignmentEndKey)
      ? t('paymentAccounts.shiftScheduleOvernightSummary', values)
      : t('paymentAccounts.shiftScheduleSummary', values)
  })()

  const openTemplateDialog = () => {
    setTemplateName('')
    setTemplateStartTime(new Date(DEFAULT_TIME_DATE))
    setTemplateEndTime(new Date(DEFAULT_END_TIME_DATE))
    setTemplateDialogOpen(true)
  }

  const openAssignmentDialog = () => {
    setEditingAssignment(null)
    setCashDrawerId(null)
    setCashierUserId('')
    setAssignmentMode('scheduled')
    setSelectedTemplateId('__custom__')
    setAssignmentStartTime(new Date(DEFAULT_TIME_DATE))
    setAssignmentEndTime(new Date(DEFAULT_END_TIME_DATE))
    setWorkingDays([0, 1, 2, 3, 4])
    setEarlyFinishPolicy('scheduled_end')
    setEarlyFinishOffsetMinutes(DEFAULT_EARLY_FINISH_OFFSET_MINUTES)
    setAssignmentDialogOpen(true)
  }

  const openEditAssignmentDialog = (assignment: CashierShiftAssignment) => {
    setEditingAssignment(assignment)
    setCashDrawerId(assignment.accountId)
    setCashierUserId(assignment.cashierUserId)
    setAssignmentMode(assignment.assignmentMode ?? 'scheduled')
    setSelectedTemplateId(
      templates.some((template) => template.id === assignment.templateId && template.isActive)
        ? assignment.templateId!
        : '__custom__'
    )
    setAssignmentStartTime(assignment.startTime ? timeDate(assignment.startTime) : new Date(DEFAULT_TIME_DATE))
    setAssignmentEndTime(assignment.endTime ? timeDate(assignment.endTime) : new Date(DEFAULT_END_TIME_DATE))
    setWorkingDays(assignment.workingDays ?? [])
    setEarlyFinishPolicy(assignment.earlyFinishPolicy ?? 'scheduled_end')
    setEarlyFinishOffsetMinutes(String(assignment.earlyFinishOffsetMinutes ?? DEFAULT_EARLY_FINISH_OFFSET_MINUTES))
    setAssignmentDialogOpen(true)
  }

  const selectTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId)
    const template = templates.find((entry) => entry.id === templateId)
    if (!template) return
    setAssignmentStartTime(timeDate(template.startTime))
    setAssignmentEndTime(timeDate(template.endTime))
  }

  const toggleWorkingDay = (day: number, isWorking: boolean) => {
    setWorkingDays((current) => {
      const next = new Set(current)
      if (isWorking) next.add(day)
      else next.delete(day)
      return [...next].sort((left, right) => left - right)
    })
  }

  const saveTemplate = async () => {
    if (!workspaceId || !templateStartTime || !templateEndTime || !templateName.trim()) return
    setSavingTemplate(true)
    try {
      await createCashierShiftTemplate(workspaceId, {
        name: templateName,
        startTime: timeKey(templateStartTime),
        endTime: timeKey(templateEndTime)
      })
      toast({ title: t('paymentAccounts.shiftCreated') })
      setTemplateDialogOpen(false)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setSavingTemplate(false)
    }
  }

  const saveAssignment = async () => {
    if (!workspaceId || !hasValidCashDrawer || !selectedCashDrawer || !selectedCashier) return
    if (assignmentMode === 'scheduled' && (!assignmentStartTime || !assignmentEndTime || workingDays.length === 0))
      return
    if (assignmentMode === 'manual' && workingDays.length === 0) return
    const parsedEarlyFinishOffsetMinutes =
      earlyFinishPolicy === 'time_before_end' ? Number(earlyFinishOffsetMinutes) : null
    setSavingAssignment(true)
    try {
      const input = {
        account: selectedCashDrawer,
        cashierUserId: selectedCashier.id,
        cashierName: selectedCashier.name || selectedCashier.email,
        assignmentMode,
        template: assignmentMode === 'scheduled' ? selectedTemplate : null,
        startTime: assignmentMode === 'scheduled' ? timeKey(assignmentStartTime) : null,
        endTime: assignmentMode === 'scheduled' ? timeKey(assignmentEndTime) : null,
        workingDays: assignmentMode === 'login_logout' ? [] : workingDays,
        earlyFinishPolicy: assignmentMode === 'scheduled' ? earlyFinishPolicy : undefined,
        earlyFinishOffsetMinutes: assignmentMode === 'scheduled' ? parsedEarlyFinishOffsetMinutes : null
      }
      if (editingAssignment) {
        await updateCashierShiftAssignment(workspaceId, editingAssignment.id, input)
        toast({ title: t('paymentAccounts.cashierShiftUpdated') })
      } else {
        await createCashierShiftAssignment(workspaceId, input)
        toast({ title: t('paymentAccounts.cashierShiftAssigned') })
      }
      setAssignmentDialogOpen(false)
      setEditingAssignment(null)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setSavingAssignment(false)
    }
  }

  const startShift = async () => {
    const assignment = startDialogRow?.assignment
    if (!workspaceId || !currentUserId || !startDialogRow || !assignment) return
    if (hasActiveShift) {
      setStartDialogRow(null)
      toast({
        title: t('common.error'),
        description: t('paymentAccounts.activeShiftMustBeCompleted'),
        variant: 'destructive'
      })
      return
    }
    const mode = assignment.assignmentMode ?? 'scheduled'
    setStartingShift(true)
    try {
      await startCashierShiftOccurrence(workspaceId, {
        assignmentId: assignment.id,
        cashierUserId: currentUserId,
        scheduledStartAt: mode === 'scheduled' ? startDialogRow.scheduledStartAt : undefined,
        source: mode === 'manual' ? 'manual' : 'scheduled'
      })
      toast({ title: t('paymentAccounts.shiftStarted') })
      setStartDialogRow(null)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setStartingShift(false)
    }
  }

  const completeShift = async () => {
    if (!workspaceId || !currentUserId || !completeDialogRow?.occurrence) return
    setCompletingShift(true)
    try {
      await completeCashierShiftOccurrence(workspaceId, {
        occurrenceId: completeDialogRow.occurrence.id,
        cashierUserId: currentUserId,
        reason: completionReason
      })
      toast({ title: t('paymentAccounts.shiftCompleted') })
      setCompleteDialogRow(null)
    } catch {
      toast({
        title: t('common.error'),
        description: t('paymentAccounts.completeShiftFailed'),
        variant: 'destructive'
      })
    } finally {
      setCompletingShift(false)
    }
  }

  const openCompleteShiftDialog = (row: ShiftDisplayRow) => {
    setCompletionReason('')
    setCompleteDialogRow(row)
  }

  const requestEarlyFinish = async () => {
    if (!workspaceId || !currentUserId || !earlyFinishRequestRow?.occurrence) return
    setRequestingEarlyFinish(true)
    try {
      await requestCashierShiftEarlyFinish(workspaceId, {
        occurrenceId: earlyFinishRequestRow.occurrence.id,
        cashierUserId: currentUserId,
        reason: earlyFinishRequestReason
      })
      toast({ title: t('paymentAccounts.earlyFinishRequestSubmitted') })
      setEarlyFinishRequestRow(null)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setRequestingEarlyFinish(false)
    }
  }

  const openEarlyFinishRequestDialog = (row: ShiftDisplayRow) => {
    setEarlyFinishRequestReason('')
    setEarlyFinishRequestRow(row)
  }

  const isEarlyFinishOffsetValid =
    earlyFinishPolicy !== 'time_before_end' ||
    (Number.isInteger(Number(earlyFinishOffsetMinutes)) &&
      Number(earlyFinishOffsetMinutes) > 0 &&
      Number(earlyFinishOffsetMinutes) < assignmentDurationMinutes)
  const pendingEarlyFinishRequests =
    user?.role === 'admin'
      ? occurrences.filter(
          (occurrence) =>
            occurrence.status === 'active' &&
            occurrence.earlyFinishPolicy === 'request_approval' &&
            occurrence.earlyFinishRequestStatus === 'requested'
        )
      : []
  const completeShiftRequiresReason = Boolean(
    completeDialogRow?.occurrence &&
    getCashierShiftCompletionEligibility(completeDialogRow.occurrence, now).requiresReason
  )
  const completionFinancialSummaries = useMemo(
    () =>
      completeDialogRow?.occurrence
        ? summarizeCashierShiftTransactions(paymentTransactions, completeDialogRow.occurrence.id)
        : [],
    [completeDialogRow?.occurrence, paymentTransactions]
  )

  if (!workspaceId || !enabled) return null

  return (
    <div className="space-y-8 p-6">
      <div>
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          <WalletCards className="h-3.5 w-3.5" />
          {t('paymentAccounts.title')}
        </div>
        <h1 className="flex flex-wrap items-center gap-3 text-3xl font-bold tracking-tight">
          {t('paymentAccounts.shiftManagement')}
          {activeTab === 'shifts' || activeTab === 'team' ? <DateRangeBadge /> : null}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.shiftManagementDescription')}</p>
      </div>

      <Tabs
        value={isAdmin && activeTab === 'shifts' ? 'team' : activeTab}
        onValueChange={(value) => setActiveTab(value as 'shifts' | 'team' | 'assignments')}
        className="space-y-6"
      >
        <TabsList
          className={`grid h-auto min-h-12 w-full ${isAdmin ? 'max-w-xl grid-cols-2' : 'max-w-xs grid-cols-1'} rounded-2xl bg-secondary/50 p-1`}
        >
          {!isAdmin ? (
            <TabsTrigger value="shifts" className="gap-2 rounded-xl">
              <Clock3 className="h-4 w-4" />
              {t('paymentAccounts.shiftsTab')}
            </TabsTrigger>
          ) : null}
          {isAdmin ? (
            <TabsTrigger value="team" className="gap-2 rounded-xl">
              <UsersRound className="h-4 w-4" />
              {t('paymentAccounts.teamShifts')}
            </TabsTrigger>
          ) : null}
          {isAdmin ? (
            <TabsTrigger value="assignments" className="gap-2 rounded-xl">
              <UserRound className="h-4 w-4" />
              {t('paymentAccounts.assignShiftsTab')}
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="shifts" className="mt-0 space-y-6">
          <Card>
            <CardHeader className="border-b border-border/60 pb-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>{t('paymentAccounts.myShifts')}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.myShiftsDescription')}</p>
                </div>
                <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                  {t('paymentAccounts.shiftCount', { count: shiftRows.length })}
                </span>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <DateRangeFilters />
              <div className="mt-6 overflow-x-auto rounded-2xl border border-border/60">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('paymentAccounts.shift')}</TableHead>
                      <TableHead>{t('paymentAccounts.cashDrawer')}</TableHead>
                      <TableHead>{t('paymentAccounts.scheduledStart')}</TableHead>
                      <TableHead>{t('paymentAccounts.scheduledEnd')}</TableHead>
                      <TableHead>{t('common.status')}</TableHead>
                      <TableHead className="text-end">{t('common.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shiftRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-12 text-center">
                          <CalendarClock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                          <p className="font-semibold">{t('paymentAccounts.noAssignedShifts')}</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {t('paymentAccounts.noAssignedShiftsDescription')}
                          </p>
                        </TableCell>
                      </TableRow>
                    ) : (
                      shiftRows.map((row) => {
                        const occurrence = row.occurrence ?? null
                        const completionEligibility = occurrence
                          ? getCashierShiftCompletionEligibility(occurrence, now)
                          : null
                        const canRequestEarlyFinish =
                          occurrence &&
                          occurrence.status === 'active' &&
                          occurrence.assignmentMode !== 'login_logout' &&
                          occurrence.earlyFinishPolicy === 'request_approval' &&
                          occurrence.earlyFinishRequestStatus === 'not_requested' &&
                          typeof occurrence.scheduledEndAt === 'string' &&
                          now < new Date(occurrence.scheduledEndAt)
                        const requestPending =
                          occurrence?.earlyFinishPolicy === 'request_approval' &&
                          occurrence.earlyFinishRequestStatus === 'requested'
                        const requestRejected =
                          occurrence?.earlyFinishPolicy === 'request_approval' &&
                          occurrence.earlyFinishRequestStatus === 'rejected'

                        return (
                          <TableRow key={row.key}>
                            <TableCell className="font-medium">
                              {row.assignmentMode === 'scheduled'
                                ? occurrence?.templateNameSnapshot ||
                                  row.assignment?.templateNameSnapshot ||
                                  t('paymentAccounts.customShift')
                                : t(`paymentAccounts.assignmentModes.${row.assignmentMode}`)}
                            </TableCell>
                            <TableCell>
                              {occurrence?.accountNameSnapshot || row.assignment?.accountNameSnapshot || '—'}
                            </TableCell>
                            <TableCell>{formatOccurrenceDateTime(row.scheduledStartAt)}</TableCell>
                            <TableCell>
                              {row.assignmentMode === 'scheduled'
                                ? formatOccurrenceDateTime(row.scheduledEndAt)
                                : t('paymentAccounts.unscheduled')}
                            </TableCell>
                            <TableCell>
                              <span
                                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}
                              >
                                {statusIcon(row.status)}
                                {t(`paymentAccounts.shiftStatuses.${row.status}`)}
                              </span>
                            </TableCell>
                            <TableCell className="text-end">
                              <div className="flex flex-wrap justify-end gap-2">
                                {occurrence ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => navigate(`/payment-accounts/cashier-shifts/${occurrence.id}`)}
                                  >
                                    <FileText className="mr-2 h-4 w-4" />
                                    {t('paymentAccounts.viewShiftDetails')}
                                  </Button>
                                ) : null}
                                {row.status === 'available' ? (
                                  <Button
                                    size="sm"
                                    disabled={hasActiveShift}
                                    title={hasActiveShift ? t('paymentAccounts.activeShiftMustBeCompleted') : undefined}
                                    onClick={() => setStartDialogRow(row)}
                                  >
                                    <ShieldCheck className="mr-2 h-4 w-4" />
                                    {t('paymentAccounts.startShift')}
                                  </Button>
                                ) : null}
                                {row.status === 'active' &&
                                row.assignmentMode !== 'login_logout' &&
                                completionEligibility?.canComplete ? (
                                  <Button size="sm" onClick={() => openCompleteShiftDialog(row)}>
                                    <CircleCheck className="mr-2 h-4 w-4" />
                                    {t('paymentAccounts.completeShift')}
                                  </Button>
                                ) : null}
                                {row.status === 'active' && canRequestEarlyFinish ? (
                                  <Button size="sm" variant="outline" onClick={() => openEarlyFinishRequestDialog(row)}>
                                    <ClipboardCheck className="mr-2 h-4 w-4" />
                                    {t('paymentAccounts.requestEarlyFinish')}
                                  </Button>
                                ) : null}
                                {row.status === 'active' && requestPending ? (
                                  <span className="self-center rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
                                    {t('paymentAccounts.earlyFinishRequestStatuses.requested')}
                                  </span>
                                ) : null}
                                {row.status === 'active' && requestRejected ? (
                                  <span className="self-center rounded-full border border-rose-500/20 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-700 dark:text-rose-300">
                                    {t('paymentAccounts.earlyFinishRequestStatuses.rejected')}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {isAdmin ? (
          <TabsContent value="team" className="mt-0 space-y-6">
            <Card>
              <CardHeader className="border-b border-border/60 pb-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <UsersRound className="h-5 w-5 text-primary" />
                      {t('paymentAccounts.teamShifts')}
                    </CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.teamShiftsDescription')}</p>
                  </div>
                  <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                    {t('paymentAccounts.shiftCount', {
                      count: teamShiftRows.length
                    })}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="pt-6">
                <DateRangeFilters />
                <div className="mt-6 overflow-x-auto rounded-2xl border border-border/60">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('paymentAccounts.cashier')}</TableHead>
                        <TableHead>{t('paymentAccounts.shift')}</TableHead>
                        <TableHead>{t('paymentAccounts.cashDrawer')}</TableHead>
                        <TableHead>{t('paymentAccounts.actualStart')}</TableHead>
                        <TableHead>{t('paymentAccounts.scheduledEnd')}</TableHead>
                        <TableHead>{t('common.status')}</TableHead>
                        <TableHead className="text-end">{t('common.actions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {teamShiftRows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-12 text-center">
                            <UsersRound className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                            <p className="font-semibold">{t('paymentAccounts.noTeamShifts')}</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {t('paymentAccounts.noTeamShiftsDescription')}
                            </p>
                          </TableCell>
                        </TableRow>
                      ) : (
                        teamShiftRows.map((row) => {
                          const occurrence = row.occurrence!
                          return (
                            <TableRow key={row.key}>
                              <TableCell className="font-medium">{occurrence.cashierNameSnapshot}</TableCell>
                              <TableCell>
                                {occurrence.assignmentMode === 'scheduled'
                                  ? occurrence.templateNameSnapshot || t('paymentAccounts.customShift')
                                  : t(`paymentAccounts.assignmentModes.${occurrence.assignmentMode ?? 'scheduled'}`)}
                              </TableCell>
                              <TableCell>{occurrence.accountNameSnapshot}</TableCell>
                              <TableCell>{formatOccurrenceDateTime(occurrence.startedAt)}</TableCell>
                              <TableCell>
                                {occurrence.assignmentMode === 'scheduled'
                                  ? formatOccurrenceDateTime(occurrence.scheduledEndAt ?? '')
                                  : t('paymentAccounts.unscheduled')}
                              </TableCell>
                              <TableCell>
                                <span
                                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}
                                >
                                  {statusIcon(row.status)}
                                  {t(`paymentAccounts.shiftStatuses.${row.status}`)}
                                </span>
                              </TableCell>
                              <TableCell className="text-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => navigate(`/payment-accounts/cashier-shifts/${occurrence.id}`)}
                                >
                                  <FileText className="mr-2 h-4 w-4" />
                                  {t('paymentAccounts.viewShiftDetails')}
                                </Button>
                              </TableCell>
                            </TableRow>
                          )
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        ) : null}

        {isAdmin ? (
          <TabsContent value="assignments" className="mt-0 space-y-6">
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="outline" onClick={openTemplateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              {t('paymentAccounts.createShift')}
            </Button>
            <Button onClick={openAssignmentDialog}>
              <UserRound className="mr-2 h-4 w-4" />
              {t('paymentAccounts.assignCashierShift')}
            </Button>
          </div>
          <Card>
            <CardHeader className="border-b border-border/60 pb-5">
              <div>
                <CardTitle>{t('paymentAccounts.shiftAssignments')}</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.shiftAssignmentsDescription')}</p>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="overflow-x-auto rounded-2xl border border-border/60">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('paymentAccounts.cashier')}</TableHead>
                      <TableHead>{t('paymentAccounts.shift')}</TableHead>
                      <TableHead>{t('paymentAccounts.cashDrawer')}</TableHead>
                      <TableHead>{t('paymentAccounts.shiftTime')}</TableHead>
                      <TableHead>{t('paymentAccounts.earlyFinishRule')}</TableHead>
                      <TableHead>{t('paymentAccounts.workingDays')}</TableHead>
                      <TableHead className="text-end">{t('common.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleAssignments.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-12 text-center">
                          <UserRound className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                          <p className="font-semibold">{t('paymentAccounts.noShiftAssignments')}</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {t('paymentAccounts.noShiftAssignmentsDescription')}
                          </p>
                        </TableCell>
                      </TableRow>
                    ) : (
                      visibleAssignments.map((assignment) => {
                        const assignmentLocked = occurrences.some(
                          (occurrence) =>
                            occurrence.assignmentId === assignment.id &&
                            (occurrence.status === 'active' || occurrence.status === 'paused')
                        )
                        const mode = assignment.assignmentMode ?? 'scheduled'
                        return (
                          <TableRow key={assignment.id}>
                            <TableCell className="font-medium">
                              {assignment.cashierNameSnapshot}
                              {assignment.cashierUserId === currentUserId ? (
                                <span className="ml-2 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                                  {t('paymentAccounts.you')}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              {mode === 'scheduled'
                                ? assignment.templateNameSnapshot || t('paymentAccounts.customShift')
                                : t(`paymentAccounts.assignmentModes.${mode}`)}
                            </TableCell>
                            <TableCell>{assignment.accountNameSnapshot}</TableCell>
                            <TableCell>
                              {mode === 'scheduled' ? (
                                <>
                                  {assignment.startTime} — {assignment.endTime}
                                </>
                              ) : (
                                t('paymentAccounts.unscheduled')
                              )}
                              {mode === 'scheduled' &&
                              assignment.startTime &&
                              assignment.endTime &&
                              isOvernight(assignment.startTime, assignment.endTime) ? (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {t('paymentAccounts.overnight')}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              {mode === 'scheduled'
                                ? t(
                                    `paymentAccounts.earlyFinishPolicies.${assignment.earlyFinishPolicy ?? 'scheduled_end'}`
                                  )
                                : t('paymentAccounts.notApplicable')}
                            </TableCell>
                            <TableCell>
                              {mode === 'login_logout'
                                ? t('paymentAccounts.notApplicable')
                                : workingDayList(assignment.workingDays ?? [])}
                            </TableCell>
                            <TableCell className="text-end">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={assignmentLocked}
                                title={assignmentLocked ? t('paymentAccounts.assignmentLockedDescription') : undefined}
                                onClick={() => openEditAssignmentDialog(assignment)}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                {t('paymentAccounts.editCashierShift')}
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
          {user?.role === 'admin' ? (
            <Card>
              <CardHeader className="border-b border-border/60 pb-5">
                <CardTitle className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-primary" />
                  {t('paymentAccounts.earlyFinishRequests')}
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('paymentAccounts.earlyFinishRequestsDescription')}
                </p>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="overflow-x-auto rounded-2xl border border-border/60">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('paymentAccounts.cashier')}</TableHead>
                        <TableHead>{t('paymentAccounts.shift')}</TableHead>
                        <TableHead>{t('paymentAccounts.earlyFinishReason')}</TableHead>
                        <TableHead>{t('paymentAccounts.requestedAt')}</TableHead>
                        <TableHead className="text-end">{t('common.actions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pendingEarlyFinishRequests.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                            {t('paymentAccounts.noEarlyFinishRequests')}
                          </TableCell>
                        </TableRow>
                      ) : (
                        pendingEarlyFinishRequests.map((occurrence) => (
                          <TableRow key={occurrence.id}>
                            <TableCell className="font-medium">{occurrence.cashierNameSnapshot}</TableCell>
                            <TableCell>{occurrence.templateNameSnapshot || t('paymentAccounts.customShift')}</TableCell>
                            <TableCell
                              className="max-w-72 truncate"
                              title={occurrence.earlyFinishRequestReason || undefined}
                            >
                              {occurrence.earlyFinishRequestReason}
                            </TableCell>
                            <TableCell>
                              {formatOccurrenceDateTime(occurrence.earlyFinishRequestedAt || occurrence.updatedAt)}
                            </TableCell>
                            <TableCell className="text-end">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => navigate(`/payment-accounts/cashier-shifts/${occurrence.id}`)}
                              >
                                <FileText className="mr-2 h-4 w-4" />
                                {t('paymentAccounts.reviewEarlyFinishRequest')}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : null}
          </TabsContent>
        ) : null}
      </Tabs>

      <AppDialog open={templateDialogOpen} onOpenChange={(open) => !savingTemplate && setTemplateDialogOpen(open)}>
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!savingTemplate}
          onPointerDownOutside={(event) => savingTemplate && event.preventDefault()}
          onEscapeKeyDown={(event) => savingTemplate && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('paymentAccounts.createShift')}</AppDialogTitle>
            <AppDialogDescription>{t('paymentAccounts.createShiftDescription')}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="cashier-shift-template-name">{t('paymentAccounts.shiftName')}</Label>
                <Input
                  id="cashier-shift-template-name"
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  disabled={savingTemplate}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>{t('paymentAccounts.startTime')}</Label>
                  <DateTimePicker
                    mode="time"
                    date={templateStartTime}
                    setDate={setTemplateStartTime}
                    disabled={savingTemplate}
                    placeholder={t('paymentAccounts.selectTime')}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>{t('paymentAccounts.endTime')}</Label>
                  <DateTimePicker
                    mode="time"
                    date={templateEndTime}
                    setDate={setTemplateEndTime}
                    disabled={savingTemplate}
                    placeholder={t('paymentAccounts.selectTime')}
                  />
                </div>
              </div>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setTemplateDialogOpen(false)} disabled={savingTemplate}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={saveTemplate}
              disabled={
                savingTemplate ||
                !templateName.trim() ||
                !templateStartTime ||
                !templateEndTime ||
                timeKey(templateStartTime) === timeKey(templateEndTime)
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('paymentAccounts.createShift')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog
        open={assignmentDialogOpen}
        onOpenChange={(open) => {
          if (!savingAssignment) {
            setAssignmentDialogOpen(open)
            if (!open) setEditingAssignment(null)
          }
        }}
      >
        <AppDialogContent
          className="max-w-3xl"
          showCloseButton={!savingAssignment}
          onPointerDownOutside={(event) => savingAssignment && event.preventDefault()}
          onEscapeKeyDown={(event) => savingAssignment && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>
              {t(editingAssignment ? 'paymentAccounts.editCashierShift' : 'paymentAccounts.assignCashierShift')}
            </AppDialogTitle>
            <AppDialogDescription>
              {t(
                editingAssignment
                  ? 'paymentAccounts.editCashierShiftDescription'
                  : 'paymentAccounts.assignCashierShiftDescription'
              )}
            </AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-6">
              <section className="grid gap-4">
                <div>
                  <h3 className="font-semibold">{t('paymentAccounts.cashier')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('paymentAccounts.cashierAssignmentDescription')}
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="cashier-shift-member">{t('paymentAccounts.assignedWorkspaceMember')}</Label>
                    <Select
                      value={cashierUserId}
                      onValueChange={setCashierUserId}
                      disabled={savingAssignment || workspaceMembers.length === 0}
                    >
                      <SelectTrigger id="cashier-shift-member">
                        <SelectValue placeholder={t('paymentAccounts.selectWorkspaceMember')} />
                      </SelectTrigger>
                      <SelectContent>
                        {workspaceMembers.map((member) => (
                          <SelectItem key={member.id} value={member.id}>
                            {member.name || member.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <PaymentAccountSelector
                    workspaceId={workspaceId}
                    value={cashDrawerId}
                    onValueChange={(account) => setCashDrawerId(account?.id ?? null)}
                    cashDrawerOnly
                    allowNoAccount={false}
                    applyDefault={false}
                    placeholder={t('paymentAccounts.selectCashDrawer')}
                    disabled={savingAssignment}
                    label={t('paymentAccounts.cashDrawer')}
                  />
                </div>
              </section>
              <section className="grid gap-4 border-t border-border/60 pt-6">
                <div>
                  <h3 className="font-semibold">{t('paymentAccounts.assignmentMode')}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.assignmentModeDescription')}</p>
                </div>
                <Select
                  value={assignmentMode}
                  onValueChange={(value) => setAssignmentMode(value as CashierShiftAssignmentMode)}
                  disabled={
                    savingAssignment ||
                    Boolean(
                      editingAssignment &&
                      occurrences.some(
                        (occurrence) =>
                          occurrence.assignmentId === editingAssignment.id &&
                          (occurrence.status === 'active' || occurrence.status === 'paused')
                      )
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scheduled">{t('paymentAccounts.assignmentModes.scheduled')}</SelectItem>
                    <SelectItem value="manual">{t('paymentAccounts.assignmentModes.manual')}</SelectItem>
                    <SelectItem value="login_logout">{t('paymentAccounts.assignmentModes.login_logout')}</SelectItem>
                  </SelectContent>
                </Select>
              </section>
              {assignmentMode === 'scheduled' ? (
                <>
                  <section className="grid gap-4 border-t border-border/60 pt-6">
                    <div>
                      <h3 className="font-semibold">{t('paymentAccounts.shiftTime')}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.shiftTimeDescription')}</p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="grid gap-2">
                        <Label>{t('paymentAccounts.shiftTemplate')}</Label>
                        <Select value={selectedTemplateId} onValueChange={selectTemplate} disabled={savingAssignment}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__custom__">{t('paymentAccounts.customShift')}</SelectItem>
                            {activeTemplates.map((template) => (
                              <SelectItem key={template.id} value={template.id}>
                                {template.name} · {template.startTime} — {template.endTime}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2">
                        <Label>{t('paymentAccounts.startTime')}</Label>
                        <DateTimePicker
                          mode="time"
                          date={assignmentStartTime}
                          setDate={setAssignmentStartTime}
                          disabled={savingAssignment}
                          placeholder={t('paymentAccounts.selectTime')}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>{t('paymentAccounts.endTime')}</Label>
                        <DateTimePicker
                          mode="time"
                          date={assignmentEndTime}
                          setDate={setAssignmentEndTime}
                          disabled={savingAssignment}
                          placeholder={t('paymentAccounts.selectTime')}
                        />
                      </div>
                    </div>
                    {isOvernight(assignmentStartKey, assignmentEndKey) ? (
                      <p className="rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-sm text-sky-700">
                        {t('paymentAccounts.overnightShiftHint')}
                      </p>
                    ) : null}
                  </section>
                  <section className="grid gap-4 border-t border-border/60 pt-6">
                    <div>
                      <h3 className="font-semibold">{t('paymentAccounts.earlyFinishRule')}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t('paymentAccounts.earlyFinishRuleDescription')}
                      </p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="grid gap-2">
                        <Label htmlFor="cashier-shift-early-finish-policy">
                          {t('paymentAccounts.earlyFinishRule')}
                        </Label>
                        <Select
                          value={earlyFinishPolicy}
                          onValueChange={(value) => setEarlyFinishPolicy(value as CashierShiftEarlyFinishPolicy)}
                          disabled={savingAssignment}
                        >
                          <SelectTrigger id="cashier-shift-early-finish-policy">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="scheduled_end">
                              {t('paymentAccounts.earlyFinishPolicies.scheduled_end')}
                            </SelectItem>
                            <SelectItem value="time_before_end">
                              {t('paymentAccounts.earlyFinishPolicies.time_before_end')}
                            </SelectItem>
                            <SelectItem value="request_approval">
                              {t('paymentAccounts.earlyFinishPolicies.request_approval')}
                            </SelectItem>
                            <SelectItem value="free_with_reason">
                              {t('paymentAccounts.earlyFinishPolicies.free_with_reason')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {earlyFinishPolicy === 'time_before_end' ? (
                        <div className="grid gap-2">
                          <Label htmlFor="cashier-shift-early-finish-offset">
                            {t('paymentAccounts.earlyFinishOffsetMinutes')}
                          </Label>
                          <Input
                            id="cashier-shift-early-finish-offset"
                            type="number"
                            min="1"
                            inputMode="numeric"
                            value={earlyFinishOffsetMinutes}
                            onChange={(event) => setEarlyFinishOffsetMinutes(event.target.value)}
                            disabled={savingAssignment}
                            placeholder="0"
                          />
                          <p className="text-xs text-muted-foreground">{t('paymentAccounts.earlyFinishOffsetHint')}</p>
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
                          {t(`paymentAccounts.earlyFinishPolicyDescriptions.${earlyFinishPolicy}`)}
                        </div>
                      )}
                    </div>
                  </section>
                </>
              ) : null}
              {assignmentMode !== 'login_logout' ? (
                <section className="grid gap-4 border-t border-border/60 pt-6">
                  <div>
                    <h3 className="font-semibold">{t('paymentAccounts.workingDays')}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.workingDaysDescription')}</p>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border/60">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('paymentAccounts.weekday')}</TableHead>
                          <TableHead>{t('paymentAccounts.workingDay')}</TableHead>
                          <TableHead>{t('paymentAccounts.dayOff')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {WEEKDAYS.map((day) => {
                          const isWorking = workingDays.includes(day)
                          return (
                            <TableRow key={day}>
                              <TableCell className="font-medium">{weekdayLabel(day)}</TableCell>
                              <TableCell>
                                <Button
                                  type="button"
                                  variant={isWorking ? 'default' : 'ghost'}
                                  size="sm"
                                  className="min-w-28"
                                  onClick={() => toggleWorkingDay(day, true)}
                                  disabled={savingAssignment}
                                >
                                  <Check className="mr-2 h-4 w-4" />
                                  {t('paymentAccounts.workingDay')}
                                </Button>
                              </TableCell>
                              <TableCell>
                                <Button
                                  type="button"
                                  variant={!isWorking ? 'secondary' : 'ghost'}
                                  size="sm"
                                  className="min-w-28"
                                  onClick={() => toggleWorkingDay(day, false)}
                                  disabled={savingAssignment}
                                >
                                  <X className="mr-2 h-4 w-4" />
                                  {t('paymentAccounts.dayOff')}
                                </Button>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              ) : null}
              <section className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                <h3 className="font-semibold">{t('paymentAccounts.scheduleSummary')}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {assignmentSummary ?? t('paymentAccounts.scheduleSummaryPending')}
                </p>
              </section>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAssignmentDialogOpen(false)
                setEditingAssignment(null)
              }}
              disabled={savingAssignment}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={saveAssignment}
              disabled={
                savingAssignment ||
                !hasValidCashDrawer ||
                !selectedCashier ||
                (assignmentMode === 'scheduled' &&
                  (!assignmentStartTime ||
                    !assignmentEndTime ||
                    workingDays.length === 0 ||
                    assignmentStartKey === assignmentEndKey ||
                    !isEarlyFinishOffsetValid)) ||
                (assignmentMode === 'manual' && workingDays.length === 0)
              }
            >
              {editingAssignment ? <Pencil className="mr-2 h-4 w-4" /> : <UserRound className="mr-2 h-4 w-4" />}
              {t(editingAssignment ? 'paymentAccounts.editCashierShift' : 'paymentAccounts.assignCashierShift')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog
        open={Boolean(startDialogRow)}
        onOpenChange={(open) => !startingShift && !open && setStartDialogRow(null)}
      >
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!startingShift}
          onPointerDownOutside={(event) => startingShift && event.preventDefault()}
          onEscapeKeyDown={(event) => startingShift && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('paymentAccounts.startShift')}</AppDialogTitle>
            <AppDialogDescription>
              {startDialogRow?.assignmentMode === 'manual'
                ? t('paymentAccounts.manualShiftStartDescription')
                : t('paymentAccounts.startShiftConfirmationDescription')}
            </AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody>
            {startDialogRow ? (
              startDialogRow.assignmentMode === 'manual' ? (
                <p className="rounded-2xl border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground">
                  {t('paymentAccounts.manualShiftStartDescription')}
                </p>
              ) : (
                <div className="grid gap-4">
                  <div className="rounded-2xl border border-border/60 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('paymentAccounts.yourShiftWillStart')}
                    </p>
                    <p className="mt-2 font-semibold">{formatOccurrenceDateTime(startDialogRow.scheduledStartAt)}</p>
                  </div>
                  <div className="rounded-2xl border border-border/60 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('paymentAccounts.yourShiftWillEnd')}
                    </p>
                    <p className="mt-2 font-semibold">{formatOccurrenceDateTime(startDialogRow.scheduledEndAt)}</p>
                  </div>
                </div>
              )
            ) : null}
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setStartDialogRow(null)} disabled={startingShift}>
              {t('common.cancel')}
            </Button>
            <PressAndHoldButton
              onComplete={startShift}
              idleLabel={t('paymentAccounts.holdToStartShift')}
              holdingLabel={t('paymentAccounts.keepHoldingToStartShift')}
              loadingLabel={t('paymentAccounts.startingShift')}
              isLoading={startingShift}
              disabled={hasActiveShift}
              icon={<ShieldCheck className="h-4 w-4" />}
            />
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog
        open={Boolean(completeDialogRow)}
        onOpenChange={(open) => !completingShift && !open && setCompleteDialogRow(null)}
      >
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!completingShift}
          onPointerDownOutside={(event) => completingShift && event.preventDefault()}
          onEscapeKeyDown={(event) => completingShift && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('paymentAccounts.completeShift')}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            {completeDialogRow?.occurrence ? (
              <div className="grid gap-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{t('paymentAccounts.actualStart')}</span>
                  <span className="font-semibold tabular-nums">
                    {formatShiftStartedDateTime(completeDialogRow.occurrence.startedAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{t('paymentAccounts.incoming')}</span>
                  <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                    {formatCashierShiftCompletionAmount(completionFinancialSummaries, 'incoming')}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{t('paymentAccounts.outgoing')}</span>
                  <span className="font-semibold tabular-nums text-rose-700 dark:text-rose-300">
                    {formatCashierShiftCompletionAmount(completionFinancialSummaries, 'outgoing')}
                  </span>
                </div>
                {completeShiftRequiresReason ? (
                  <div className="grid gap-2">
                    <Label htmlFor="cashier-shift-completion-reason">{t('paymentAccounts.earlyFinishReason')}</Label>
                    <Textarea
                      id="cashier-shift-completion-reason"
                      value={completionReason}
                      onChange={(event) => setCompletionReason(event.target.value)}
                      disabled={completingShift}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setCompleteDialogRow(null)} disabled={completingShift}>
              {t('common.cancel')}
            </Button>
            <PressAndHoldButton
              onComplete={completeShift}
              idleLabel={t('paymentAccounts.holdToCompleteShift')}
              holdingLabel={t('paymentAccounts.keepHoldingToCompleteShift')}
              loadingLabel={t('paymentAccounts.completingShift')}
              isLoading={completingShift}
              disabled={completeShiftRequiresReason && !completionReason.trim()}
              icon={<CircleCheck className="h-4 w-4" />}
            />
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog
        open={Boolean(earlyFinishRequestRow)}
        onOpenChange={(open) => !requestingEarlyFinish && !open && setEarlyFinishRequestRow(null)}
      >
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!requestingEarlyFinish}
          onPointerDownOutside={(event) => requestingEarlyFinish && event.preventDefault()}
          onEscapeKeyDown={(event) => requestingEarlyFinish && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('paymentAccounts.requestEarlyFinish')}</AppDialogTitle>
            <AppDialogDescription>{t('paymentAccounts.requestEarlyFinishDescription')}</AppDialogDescription>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-2">
              <Label htmlFor="cashier-shift-early-finish-request-reason">
                {t('paymentAccounts.earlyFinishReason')}
              </Label>
              <Textarea
                id="cashier-shift-early-finish-request-reason"
                value={earlyFinishRequestReason}
                onChange={(event) => setEarlyFinishRequestReason(event.target.value)}
                disabled={requestingEarlyFinish}
              />
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setEarlyFinishRequestRow(null)} disabled={requestingEarlyFinish}>
              {t('common.cancel')}
            </Button>
            <PressAndHoldButton
              onComplete={requestEarlyFinish}
              idleLabel={t('paymentAccounts.holdToRequestEarlyFinish')}
              holdingLabel={t('paymentAccounts.keepHoldingToRequestEarlyFinish')}
              loadingLabel={t('paymentAccounts.requestingEarlyFinish')}
              isLoading={requestingEarlyFinish}
              disabled={!earlyFinishRequestReason.trim()}
              icon={<ClipboardCheck className="h-4 w-4" />}
            />
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>
    </div>
  )
}
