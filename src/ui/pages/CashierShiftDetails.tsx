import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useRoute } from 'wouter'
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  BadgeCheck,
  Ban,
  Check,
  ClipboardCheck,
  Clock3,
  PauseCircle,
  PlayCircle,
  ReceiptText,
  ShieldAlert,
  TimerReset,
  UserRound,
  WalletCards,
  X
} from 'lucide-react'

import { useAuth } from '@/auth/AuthContext'
import {
  getPaymentAccountTransactionDelta,
  pauseCashierShiftOccurrence,
  requestCashierShiftPause,
  resumeCashierShiftOccurrence,
  reviewCashierShiftEarlyFinishRequest,
  reviewCashierShiftPauseRequest,
  summarizeCashierShiftTransactions,
  terminateCashierShiftOccurrence,
  useCashierShiftOccurrences,
  useCashierShiftPausePeriods,
  useCashierShiftPauseRequests,
  usePaymentTransactions,
  useWorkspaceUsers,
  type PaymentTransaction
} from '@/local-db'
import { formatCurrency } from '@/lib/utils'
import { useWorkspacePermissions } from '@/permissions'
import { Button } from '@/ui/components/button'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DateTimePicker,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useToast,
} from '@/ui/components'
import { PressAndHoldButton } from '@/ui/components/PressAndHoldButton'
import { useWorkspace } from '@/workspace/WorkspaceContext'

function humanizeIdentifier(value: string | null | undefined) {
  if (!value) return '—'
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function effectiveDirection(transaction: PaymentTransaction) {
  return getPaymentAccountTransactionDelta(transaction) >= 0 ? 'incoming' : 'outgoing'
}

export function CashierShiftDetails() {
  const { t, i18n } = useTranslation()
  const [, navigate] = useLocation()
  const [, params] = useRoute('/payment-accounts/cashier-shifts/:shiftId')
  const { user } = useAuth()
  const { toast } = useToast()
  const { hasFeature } = useWorkspace()
  const { hasPermission } = useWorkspacePermissions()
  const workspaceId = user?.workspaceId
  const shiftId = params?.shiftId
  const occurrences = useCashierShiftOccurrences(workspaceId)
  const pauseRequests = useCashierShiftPauseRequests(workspaceId)
  const pausePeriods = useCashierShiftPausePeriods(workspaceId)
  const members = useWorkspaceUsers(workspaceId)
  const transactions = usePaymentTransactions(workspaceId, {}, { hydrateSourceTables: false })
  const enabled =
    hasFeature('payment_accounts') && hasFeature('cashier_shift_control') && hasPermission('cashierShiftControl.access')
  const occurrence = occurrences.find((entry) => entry.id === shiftId) ?? null
  const isAdmin = user?.role === 'admin'
  const isAssignedCashier = occurrence?.cashierUserId === user?.id
  const [reviewDecision, setReviewDecision] = useState<'approved' | 'rejected' | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [reviewingRequest, setReviewingRequest] = useState(false)
  const [pauseRequestOpen, setPauseRequestOpen] = useState(false)
  const [pauseReason, setPauseReason] = useState('')
  const [pauseDurationMinutes, setPauseDurationMinutes] = useState('')
  const [pauseResumeAt, setPauseResumeAt] = useState<Date | undefined>(undefined)
  const [pauseTimingMode, setPauseTimingMode] = useState<'duration' | 'resume'>('duration')
  const [savingPauseRequest, setSavingPauseRequest] = useState(false)
  const [pauseReviewDecision, setPauseReviewDecision] = useState<'approved' | 'rejected' | null>(null)
  const [pauseReviewRequestId, setPauseReviewRequestId] = useState<string | null>(null)
  const [pauseReviewNote, setPauseReviewNote] = useState('')
  const [savingPauseReview, setSavingPauseReview] = useState(false)
  const [adminPauseOpen, setAdminPauseOpen] = useState(false)
  const [adminPauseKind, setAdminPauseKind] = useState<'admin' | 'emergency' | null>(null)
  const [adminPauseNote, setAdminPauseNote] = useState('')
  const [savingAdminPause, setSavingAdminPause] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [savingResume, setSavingResume] = useState(false)
  const [terminationOpen, setTerminationOpen] = useState(false)
  const [terminationReason, setTerminationReason] = useState('')
  const [savingTermination, setSavingTermination] = useState(false)

  const formatDateTime = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(i18n.language, {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }).format(new Date(value))
      : '—'
  const memberNameById = useMemo(
    () =>
      new Map(members.filter((member) => !member.isDeleted).map((member) => [member.id, member.name || member.email])),
    [members]
  )
  const linkedTransactions = useMemo(
    () =>
      occurrence
        ? transactions.filter(
            (transaction) => !transaction.isDeleted && transaction.cashierShiftOccurrenceId === occurrence.id
          )
        : [],
    [occurrence, transactions]
  )
  const summaries = useMemo(
    () => (occurrence ? summarizeCashierShiftTransactions(linkedTransactions, occurrence.id) : []),
    [linkedTransactions, occurrence]
  )
  const unassignedTransactions = useMemo(() => {
    if (!occurrence) return []
    const intervalStart = new Date(occurrence.scheduledStartAt ?? occurrence.startedAt).getTime()
    const intervalEnd = new Date(
      occurrence.scheduledEndAt ?? occurrence.completedAt ?? occurrence.terminatedAt ?? new Date().toISOString()
    ).getTime()
    return transactions.filter(
      (transaction) =>
        !transaction.isDeleted &&
        !transaction.cashierShiftOccurrenceId &&
        transaction.accountId === occurrence.accountId &&
        transaction.createdBy === occurrence.cashierUserId &&
        new Date(transaction.paidAt).getTime() >= intervalStart &&
        new Date(transaction.paidAt).getTime() <= intervalEnd
    )
  }, [occurrence, transactions])
  const occurrencePauseRequests = useMemo(
    () => (occurrence ? pauseRequests.filter((request) => request.occurrenceId === occurrence.id) : []),
    [occurrence, pauseRequests]
  )
  const occurrencePausePeriods = useMemo(
    () => (occurrence ? pausePeriods.filter((period) => period.occurrenceId === occurrence.id) : []),
    [occurrence, pausePeriods]
  )

  if (!workspaceId || !enabled) return null

  if (!occurrence) {
    return (
      <div className="space-y-6 p-6">
        <Button variant="outline" onClick={() => navigate('/payment-accounts/cashier-shifts')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('paymentAccounts.backToShifts')}
        </Button>
        <Card>
          <CardContent className="py-16 text-center">
            <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-amber-600" />
            <p className="font-semibold">{t('paymentAccounts.shiftNotFound')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.shiftNotFoundDescription')}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!isAdmin && !isAssignedCashier) {
    return (
      <div className="space-y-6 p-6">
        <Button variant="outline" onClick={() => navigate('/payment-accounts/cashier-shifts')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('paymentAccounts.backToShifts')}
        </Button>
        <Card>
          <CardContent className="py-16 text-center">
            <ShieldAlert className="mx-auto mb-3 h-9 w-9 text-amber-600" />
            <p className="font-semibold">{t('paymentAccounts.shiftAccessDenied')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.shiftAccessDeniedDescription')}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const isCompleted = occurrence.status === 'completed'
  const isPaused = occurrence.status === 'paused'
  const isTerminated = occurrence.status === 'terminated'
  const earlyFinishRequestPending =
    occurrence.earlyFinishPolicy === 'request_approval' && occurrence.earlyFinishRequestStatus === 'requested'
  const completedByName = occurrence.completedBy
    ? (memberNameById.get(occurrence.completedBy) ?? occurrence.cashierNameSnapshot)
    : null
  const statusClass = isTerminated
    ? 'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300'
    : isCompleted
      ? 'border-slate-500/20 bg-slate-500/10 text-muted-foreground'
      : isPaused
        ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'

  const transactionRows = (rows: PaymentTransaction[], showUnassigned = false) =>
    rows.map((transaction) => {
      const direction = effectiveDirection(transaction)
      const hasAnotherCashier = !!transaction.createdBy && transaction.createdBy !== occurrence.cashierUserId
      const isManualAdjustment = transaction.sourceType === 'payment_account_adjustment'
      return (
        <TableRow key={transaction.id}>
          <TableCell className="whitespace-nowrap">{formatDateTime(transaction.paidAt)}</TableCell>
          <TableCell>
            <div className="font-medium">
              {t(`paymentAccounts.transactionTypes.${transaction.sourceType}`, {
                defaultValue: humanizeIdentifier(transaction.sourceType)
              })}
            </div>
            <div className="text-xs text-muted-foreground">
              {t(`paymentAccounts.sourceModules.${transaction.sourceModule}`, {
                defaultValue: humanizeIdentifier(transaction.sourceModule)
              })}
            </div>
          </TableCell>
          <TableCell className="max-w-48">
            <div className="truncate font-medium" title={transaction.referenceLabel || undefined}>
              {transaction.referenceLabel || '—'}
            </div>
            <div className="truncate text-xs text-muted-foreground" title={transaction.counterpartyName || undefined}>
              {transaction.counterpartyName || '—'}
            </div>
          </TableCell>
          <TableCell>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${direction === 'incoming' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300'}`}
            >
              {direction === 'incoming' ? (
                <ArrowDownLeft className="h-3.5 w-3.5" />
              ) : (
                <ArrowUpRight className="h-3.5 w-3.5" />
              )}
              {t(`paymentAccounts.${direction}`)}
            </span>
          </TableCell>
          <TableCell>{transaction.createdBy ? (memberNameById.get(transaction.createdBy) ?? '—') : '—'}</TableCell>
          <TableCell className="text-end font-semibold tabular-nums">
            {formatCurrency(Math.abs(Number(transaction.amount || 0)), transaction.currency)}
          </TableCell>
          <TableCell>
            <div className="flex flex-wrap gap-1">
              {showUnassigned ? (
                <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  {t('paymentAccounts.unassigned')}
                </span>
              ) : null}
              {transaction.reversalOfTransactionId ? (
                <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                  {t('paymentAccounts.reversal')}
                </span>
              ) : null}
              {isManualAdjustment ? (
                <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                  {t('paymentAccounts.manualAdjustment')}
                </span>
              ) : null}
              {hasAnotherCashier ? (
                <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  {t('paymentAccounts.otherCashier')}
                </span>
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      )
    })

  const openReviewDialog = (decision: 'approved' | 'rejected') => {
    setReviewDecision(decision)
    setReviewNote('')
  }
  const reviewEarlyFinishRequest = async () => {
    if (!workspaceId || !user?.id || !reviewDecision) return
    setReviewingRequest(true)
    try {
      await reviewCashierShiftEarlyFinishRequest(workspaceId, {
        occurrenceId: occurrence.id,
        reviewerUserId: user.id,
        decision: reviewDecision,
        reviewNote
      })
      toast({
        title: t(
          reviewDecision === 'approved'
            ? 'paymentAccounts.earlyFinishRequestApproved'
            : 'paymentAccounts.earlyFinishRequestRejected'
        )
      })
      setReviewDecision(null)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setReviewingRequest(false)
    }
  }

  const openPauseRequestDialog = () => {
    setPauseReason('')
    setPauseDurationMinutes('')
    setPauseResumeAt(undefined)
    setPauseTimingMode('duration')
    setPauseRequestOpen(true)
  }
  const submitPauseRequest = async () => {
    if (!workspaceId || !user?.id) return
    setSavingPauseRequest(true)
    try {
      await requestCashierShiftPause(workspaceId, {
        occurrenceId: occurrence.id,
        cashierUserId: user.id,
        reason: pauseReason,
        requestedDurationMinutes:
          pauseTimingMode === 'duration' && pauseDurationMinutes.trim() ? Number(pauseDurationMinutes) : null,
        requestedResumeAt: pauseTimingMode === 'resume' && pauseResumeAt ? pauseResumeAt.toISOString() : null
      })
      toast({ title: t('paymentAccounts.pauseRequestSubmitted') })
      setPauseRequestOpen(false)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setSavingPauseRequest(false)
    }
  }
  const openPauseReviewDialog = (requestId: string, decision: 'approved' | 'rejected') => {
    setPauseReviewRequestId(requestId)
    setPauseReviewDecision(decision)
    setPauseReviewNote('')
  }
  const reviewPauseRequest = async () => {
    if (!workspaceId || !user?.id || !pauseReviewDecision || !pauseReviewRequestId) return
    setSavingPauseReview(true)
    try {
      await reviewCashierShiftPauseRequest(workspaceId, {
        requestId: pauseReviewRequestId,
        reviewerUserId: user.id,
        decision: pauseReviewDecision,
        reviewNote: pauseReviewNote
      })
      toast({
        title: t(
          pauseReviewDecision === 'approved'
            ? 'paymentAccounts.pauseRequestApproved'
            : 'paymentAccounts.pauseRequestRejected'
        )
      })
      setPauseReviewDecision(null)
      setPauseReviewRequestId(null)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setSavingPauseReview(false)
    }
  }
  const openAdminPauseDialog = () => {
    setAdminPauseKind(null)
    setAdminPauseNote('')
    setAdminPauseOpen(true)
  }
  const confirmAdminPause = async () => {
    if (!workspaceId || !user?.id || !adminPauseKind) return
    setSavingAdminPause(true)
    try {
      await pauseCashierShiftOccurrence(workspaceId, {
        occurrenceId: occurrence.id,
        initiatorUserId: user.id,
        kind: adminPauseKind,
        note: adminPauseKind === 'emergency' ? adminPauseNote : null
      })
      toast({
        title: t(
          adminPauseKind === 'emergency' ? 'paymentAccounts.emergencyPauseStarted' : 'paymentAccounts.adminPauseStarted'
        )
      })
      setAdminPauseOpen(false)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setSavingAdminPause(false)
    }
  }
  const resumeShift = async () => {
    if (!workspaceId || !user?.id) return
    setSavingResume(true)
    try {
      await resumeCashierShiftOccurrence(workspaceId, {
        occurrenceId: occurrence.id,
        resumedByUserId: user.id
      })
      toast({ title: t('paymentAccounts.shiftResumed') })
      setResumeOpen(false)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setSavingResume(false)
    }
  }
  const terminateShift = async () => {
    if (!workspaceId || !user?.id) return
    setSavingTermination(true)
    try {
      await terminateCashierShiftOccurrence(workspaceId, {
        occurrenceId: occurrence.id,
        terminatedByUserId: user.id,
        reason: terminationReason
      })
      toast({ title: t('paymentAccounts.shiftTerminated') })
      setTerminationOpen(false)
    } catch (error: any) {
      toast({
        title: t('common.error'),
        description: error?.message,
        variant: 'destructive'
      })
    } finally {
      setSavingTermination(false)
    }
  }

  const pauseRequestTimingValid =
    pauseTimingMode === 'duration'
      ? Number.isInteger(Number(pauseDurationMinutes)) && Number(pauseDurationMinutes) > 0
      : Boolean(pauseResumeAt && pauseResumeAt > new Date())
  const formatPauseDuration = (period: (typeof occurrencePausePeriods)[number]) => {
    const end = period.resumedAt ? new Date(period.resumedAt) : new Date()
    const minutes = Math.max(0, Math.floor((end.getTime() - new Date(period.startedAt).getTime()) / 60_000))
    return t('paymentAccounts.pauseDurationMinutes', { count: minutes })
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <ReceiptText className="h-3.5 w-3.5" />
            {t('paymentAccounts.cashierShifts')}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{t('paymentAccounts.shiftDetails')}</h1>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass}`}
            >
              {isPaused ? (
                <PauseCircle className="h-3.5 w-3.5" />
              ) : isTerminated ? (
                <Ban className="h-3.5 w-3.5" />
              ) : isCompleted ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <PlayCircle className="h-3.5 w-3.5" />
              )}
              {t(`paymentAccounts.shiftStatuses.${occurrence.status}`)}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {isTerminated
              ? t('paymentAccounts.terminatedShiftDetailsDescription')
              : isPaused
                ? t('paymentAccounts.pausedShiftDetailsDescription')
                : isCompleted
                  ? t('paymentAccounts.completedShiftDetailsDescription')
                  : t('paymentAccounts.activeShiftDetailsDescription')}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {isAssignedCashier &&
          occurrence.status === 'active' &&
          !occurrencePauseRequests.some((request) => request.status === 'pending') ? (
            <Button variant="outline" onClick={openPauseRequestDialog}>
              <PauseCircle className="mr-2 h-4 w-4" />
              {t('paymentAccounts.requestPause')}
            </Button>
          ) : null}
          {isAdmin && occurrence.status === 'active' ? (
            <Button variant="outline" onClick={openAdminPauseDialog}>
              <PauseCircle className="mr-2 h-4 w-4" />
              {t('paymentAccounts.pauseShift')}
            </Button>
          ) : null}
          {isAdmin && isPaused ? (
            <Button onClick={() => setResumeOpen(true)}>
              <PlayCircle className="mr-2 h-4 w-4" />
              {t('paymentAccounts.resumeShift')}
            </Button>
          ) : null}
          {isAdmin && (occurrence.status === 'active' || isPaused) ? (
            <Button
              variant="destructive"
              onClick={() => {
                setTerminationReason('')
                setTerminationOpen(true)
              }}
            >
              <Ban className="mr-2 h-4 w-4" />
              {t('paymentAccounts.terminateShift')}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => navigate('/payment-accounts/cashier-shifts')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('paymentAccounts.backToShifts')}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b border-border/60 pb-5">
          <CardTitle className="flex items-center gap-2">
            <BadgeCheck className="h-5 w-5 text-primary" />
            {t('paymentAccounts.shiftIdentity')}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 pt-6 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('paymentAccounts.cashier')}
            </p>
            <p className="mt-1 font-medium">{occurrence.cashierNameSnapshot}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('paymentAccounts.cashDrawer')}
            </p>
            <p className="mt-1 font-medium">{occurrence.accountNameSnapshot}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('paymentAccounts.shift')}
            </p>
            <p className="mt-1 font-medium">
              {occurrence.assignmentMode === 'scheduled'
                ? occurrence.templateNameSnapshot || t('paymentAccounts.customShift')
                : t(`paymentAccounts.assignmentModes.${occurrence.assignmentMode ?? 'scheduled'}`)}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {isCompleted
                ? t('paymentAccounts.completedBy')
                : isTerminated
                  ? t('paymentAccounts.terminatedBy')
                  : t('paymentAccounts.shiftStatus')}
            </p>
            <p className="mt-1 font-medium">
              {isCompleted
                ? completedByName || '—'
                : isTerminated
                  ? memberNameById.get(occurrence.terminatedBy || '') || '—'
                  : t(`paymentAccounts.shiftStatuses.${occurrence.status}`)}
            </p>
          </div>
          {occurrence.assignmentMode === 'scheduled' ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('paymentAccounts.scheduledStart')}
              </p>
              <p className="mt-1 font-medium">{formatDateTime(occurrence.scheduledStartAt)}</p>
            </div>
          ) : null}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('paymentAccounts.actualStart')}
            </p>
            <p className="mt-1 font-medium">{formatDateTime(occurrence.startedAt)}</p>
          </div>
          {occurrence.assignmentMode === 'scheduled' ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('paymentAccounts.scheduledEnd')}
              </p>
              <p className="mt-1 font-medium">{formatDateTime(occurrence.scheduledEndAt)}</p>
            </div>
          ) : null}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('paymentAccounts.actualEnd')}
            </p>
            <p className="mt-1 font-medium">{formatDateTime(occurrence.completedAt || occurrence.terminatedAt)}</p>
          </div>
        </CardContent>
      </Card>

      {isTerminated ? (
        <Card className="border-rose-500/25">
          <CardHeader className="border-b border-rose-500/15 pb-5">
            <CardTitle className="flex items-center gap-2 text-rose-700 dark:text-rose-300">
              <Ban className="h-5 w-5" />
              {t('paymentAccounts.termination')}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 pt-6 sm:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('paymentAccounts.terminatedAt')}
              </p>
              <p className="mt-1 text-sm">{formatDateTime(occurrence.terminatedAt)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('paymentAccounts.terminatedBy')}
              </p>
              <p className="mt-1 text-sm">{memberNameById.get(occurrence.terminatedBy || '') || '—'}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('paymentAccounts.terminationReason')}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{occurrence.terminationReason || '—'}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {occurrencePauseRequests.length > 0 ? (
        <Card className="border-amber-500/25">
          <CardHeader className="border-b border-amber-500/15 pb-5">
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-amber-700 dark:text-amber-300" />
              {t('paymentAccounts.pauseRequests')}
            </CardTitle>
            <p className="mt-1 text-sm font-normal text-muted-foreground">
              {t('paymentAccounts.pauseRequestsDescription')}
            </p>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="overflow-x-auto rounded-2xl border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('paymentAccounts.reason')}</TableHead>
                    <TableHead>{t('paymentAccounts.requestedPause')}</TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead>{t('paymentAccounts.requestedAt')}</TableHead>
                    <TableHead>{t('paymentAccounts.reviewedAt')}</TableHead>
                    <TableHead className="text-end">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {occurrencePauseRequests.map((request) => (
                    <TableRow key={request.id}>
                      <TableCell className="max-w-64 whitespace-pre-wrap">{request.reason}</TableCell>
                      <TableCell>
                        {request.requestedDurationMinutes
                          ? t('paymentAccounts.pauseDurationMinutes', {
                              count: request.requestedDurationMinutes
                            })
                          : formatDateTime(request.requestedResumeAt)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${request.status === 'pending' ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300' : request.status === 'approved' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300'}`}
                        >
                          {t(`paymentAccounts.pauseRequestStatuses.${request.status}`)}
                        </span>
                        {request.reviewNote ? (
                          <p
                            className="mt-1 max-w-48 truncate text-xs text-muted-foreground"
                            title={request.reviewNote}
                          >
                            {request.reviewNote}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>{formatDateTime(request.requestedAt)}</TableCell>
                      <TableCell>{formatDateTime(request.reviewedAt)}</TableCell>
                      <TableCell className="text-end">
                        {isAdmin && request.status === 'pending' ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button size="sm" onClick={() => openPauseReviewDialog(request.id, 'approved')}>
                              <Check className="mr-2 h-4 w-4" />
                              {t('paymentAccounts.approvePauseRequest')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openPauseReviewDialog(request.id, 'rejected')}
                            >
                              <X className="mr-2 h-4 w-4" />
                              {t('paymentAccounts.rejectPauseRequest')}
                            </Button>
                          </div>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className={isPaused ? 'border-amber-500/25' : undefined}>
        <CardHeader className="border-b border-border/60 pb-5">
          <CardTitle className="flex items-center gap-2">
            <PauseCircle className={`h-5 w-5 ${isPaused ? 'text-amber-700 dark:text-amber-300' : 'text-primary'}`} />
            {t('paymentAccounts.pauseHistory')}
          </CardTitle>
          <p className="mt-1 text-sm font-normal text-muted-foreground">
            {t('paymentAccounts.pauseHistoryDescription')}
          </p>
        </CardHeader>
        <CardContent className="pt-6">
          {occurrencePausePeriods.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              <TimerReset className="mx-auto mb-3 h-7 w-7" />
              {t('paymentAccounts.noPauseHistory')}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('paymentAccounts.pauseKind')}</TableHead>
                    <TableHead>{t('paymentAccounts.startedAt')}</TableHead>
                    <TableHead>{t('paymentAccounts.resumedAt')}</TableHead>
                    <TableHead>{t('paymentAccounts.initiatedBy')}</TableHead>
                    <TableHead>{t('paymentAccounts.pauseDuration')}</TableHead>
                    <TableHead>{t('paymentAccounts.note')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {occurrencePausePeriods.map((period) => (
                    <TableRow key={period.id}>
                      <TableCell>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${period.resumedAt ? 'border-slate-500/20 bg-slate-500/10 text-muted-foreground' : 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}
                        >
                          <PauseCircle className="h-3.5 w-3.5" />
                          {t(`paymentAccounts.pauseKinds.${period.kind}`)}
                        </span>
                      </TableCell>
                      <TableCell>{formatDateTime(period.startedAt)}</TableCell>
                      <TableCell>
                        {period.resumedAt ? formatDateTime(period.resumedAt) : t('paymentAccounts.pauseInProgress')}
                      </TableCell>
                      <TableCell>{memberNameById.get(period.initiatedBy) || '—'}</TableCell>
                      <TableCell>{formatPauseDuration(period)}</TableCell>
                      <TableCell className="max-w-64 whitespace-pre-wrap">{period.note || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {occurrence.assignmentMode === 'scheduled' &&
      occurrence.earlyFinishPolicy === 'request_approval' &&
      occurrence.earlyFinishRequestStatus !== 'not_requested' ? (
        <Card className="border-amber-500/25">
          <CardHeader className="border-b border-amber-500/15 pb-5">
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-amber-700 dark:text-amber-300" />
              {t('paymentAccounts.earlyFinishRequest')}
            </CardTitle>
            <p className="mt-1 text-sm font-normal text-muted-foreground">
              {t(`paymentAccounts.earlyFinishRequestStatuses.${occurrence.earlyFinishRequestStatus}`)}
            </p>
          </CardHeader>
          <CardContent className="grid gap-5 pt-6 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('paymentAccounts.earlyFinishReason')}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{occurrence.earlyFinishRequestReason || '—'}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('paymentAccounts.requestedAt')}
              </p>
              <p className="mt-1 text-sm">{formatDateTime(occurrence.earlyFinishRequestedAt)}</p>
            </div>
            {occurrence.earlyFinishReviewedAt ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('paymentAccounts.reviewedAt')}
                </p>
                <p className="mt-1 text-sm">{formatDateTime(occurrence.earlyFinishReviewedAt)}</p>
              </div>
            ) : null}
            {occurrence.earlyFinishReviewNote ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('paymentAccounts.reviewNote')}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{occurrence.earlyFinishReviewNote}</p>
              </div>
            ) : null}
            {isAdmin && earlyFinishRequestPending ? (
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button onClick={() => openReviewDialog('approved')}>
                  <Check className="mr-2 h-4 w-4" />
                  {t('paymentAccounts.approveEarlyFinishRequest')}
                </Button>
                <Button variant="outline" onClick={() => openReviewDialog('rejected')}>
                  <X className="mr-2 h-4 w-4" />
                  {t('paymentAccounts.rejectEarlyFinishRequest')}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">{t('paymentAccounts.shiftFinancialSummary')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('paymentAccounts.shiftFinancialSummaryDescription')}</p>
        </div>
        {summaries.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              <WalletCards className="mx-auto mb-3 h-8 w-8" />
              {t('paymentAccounts.noShiftTransactions')}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {summaries.map((summary) => (
              <Card key={summary.currency}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                    {summary.currency}
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{t('paymentAccounts.incoming')}</span>
                    <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                      {formatCurrency(summary.incomingAmount, summary.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{t('paymentAccounts.outgoing')}</span>
                    <span className="font-semibold text-rose-700 dark:text-rose-300">
                      {formatCurrency(summary.outgoingAmount, summary.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2">
                    <span className="font-medium">{t('paymentAccounts.netMovement')}</span>
                    <span className="font-bold tabular-nums">
                      {formatCurrency(summary.netAmount, summary.currency)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('paymentAccounts.shiftTransactionCount', {
                      count: summary.transactionCount
                    })}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <Card>
        <CardHeader className="border-b border-border/60 pb-5">
          <CardTitle className="flex items-center gap-2">
            <ReceiptText className="h-5 w-5 text-primary" />
            {t('paymentAccounts.shiftTransactions')}
          </CardTitle>
          <p className="mt-1 text-sm font-normal text-muted-foreground">
            {t('paymentAccounts.shiftTransactionsDescription')}
          </p>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="overflow-x-auto rounded-2xl border border-border/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('paymentAccounts.transactionTime')}</TableHead>
                  <TableHead>{t('paymentAccounts.transactionType')}</TableHead>
                  <TableHead>{t('paymentAccounts.reference')}</TableHead>
                  <TableHead>{t('paymentAccounts.direction')}</TableHead>
                  <TableHead>{t('paymentAccounts.postedBy')}</TableHead>
                  <TableHead className="text-end">{t('paymentAccounts.amount')}</TableHead>
                  <TableHead>{t('paymentAccounts.exceptions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {linkedTransactions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                      {t('paymentAccounts.noShiftTransactions')}
                    </TableCell>
                  </TableRow>
                ) : (
                  transactionRows(linkedTransactions)
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {unassignedTransactions.length > 0 ? (
        <Card className="border-amber-500/25">
          <CardHeader className="border-b border-amber-500/15 pb-5">
            <CardTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-5 w-5" />
              {t('paymentAccounts.unassignedTransactions')}
            </CardTitle>
            <p className="mt-1 text-sm font-normal text-muted-foreground">
              {t('paymentAccounts.unassignedTransactionsDescription')}
            </p>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="overflow-x-auto rounded-2xl border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('paymentAccounts.transactionTime')}</TableHead>
                    <TableHead>{t('paymentAccounts.transactionType')}</TableHead>
                    <TableHead>{t('paymentAccounts.reference')}</TableHead>
                    <TableHead>{t('paymentAccounts.direction')}</TableHead>
                    <TableHead>{t('paymentAccounts.postedBy')}</TableHead>
                    <TableHead className="text-end">{t('paymentAccounts.amount')}</TableHead>
                    <TableHead>{t('paymentAccounts.exceptions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>{transactionRows(unassignedTransactions, true)}</TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {linkedTransactions.some(
        (transaction) => transaction.createdBy && transaction.createdBy !== occurrence.cashierUserId
      ) ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm text-muted-foreground">
          <UserRound className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
          {t('paymentAccounts.otherCashierTransactionNotice')}
        </div>
      ) : null}

      <AppDialog
        open={reviewDecision !== null}
        onOpenChange={(open) => !reviewingRequest && !open && setReviewDecision(null)}
      >
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!reviewingRequest}
          onPointerDownOutside={(event) => reviewingRequest && event.preventDefault()}
          onEscapeKeyDown={(event) => reviewingRequest && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>
              {t(
                reviewDecision === 'approved'
                  ? 'paymentAccounts.approveEarlyFinishRequest'
                  : 'paymentAccounts.rejectEarlyFinishRequest'
              )}
            </AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-2">
              <label htmlFor="cashier-shift-early-finish-review-note" className="text-sm font-medium">
                {t('paymentAccounts.reviewNote')}
              </label>
              <Textarea
                id="cashier-shift-early-finish-review-note"
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                disabled={reviewingRequest}
              />
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setReviewDecision(null)} disabled={reviewingRequest}>
              {t('common.cancel')}
            </Button>
            <PressAndHoldButton
              onComplete={reviewEarlyFinishRequest}
              idleLabel={t(
                reviewDecision === 'approved'
                  ? 'paymentAccounts.holdToApproveEarlyFinishRequest'
                  : 'paymentAccounts.holdToRejectEarlyFinishRequest'
              )}
              holdingLabel={t('paymentAccounts.keepHoldingToReviewEarlyFinishRequest')}
              loadingLabel={t('paymentAccounts.reviewingEarlyFinishRequest')}
              isLoading={reviewingRequest}
              icon={reviewDecision === 'approved' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            />
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog open={pauseRequestOpen} onOpenChange={(open) => !savingPauseRequest && setPauseRequestOpen(open)}>
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!savingPauseRequest}
          onPointerDownOutside={(event) => savingPauseRequest && event.preventDefault()}
          onEscapeKeyDown={(event) => savingPauseRequest && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('paymentAccounts.requestPause')}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="cashier-shift-pause-reason">{t('paymentAccounts.pauseReason')}</Label>
                <Textarea
                  id="cashier-shift-pause-reason"
                  value={pauseReason}
                  onChange={(event) => setPauseReason(event.target.value)}
                  disabled={savingPauseRequest}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t('paymentAccounts.requestedPause')}</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    type="button"
                    variant={pauseTimingMode === 'duration' ? 'default' : 'outline'}
                    onClick={() => setPauseTimingMode('duration')}
                    disabled={savingPauseRequest}
                  >
                    <TimerReset className="mr-2 h-4 w-4" />
                    {t('paymentAccounts.requestDuration')}
                  </Button>
                  <Button
                    type="button"
                    variant={pauseTimingMode === 'resume' ? 'default' : 'outline'}
                    onClick={() => setPauseTimingMode('resume')}
                    disabled={savingPauseRequest}
                  >
                    <Clock3 className="mr-2 h-4 w-4" />
                    {t('paymentAccounts.requestResumeTime')}
                  </Button>
                </div>
              </div>
              {pauseTimingMode === 'duration' ? (
                <div className="grid gap-2">
                  <Label htmlFor="cashier-shift-pause-duration">{t('paymentAccounts.pauseDuration')}</Label>
                  <Input
                    id="cashier-shift-pause-duration"
                    type="number"
                    min="1"
                    inputMode="numeric"
                    placeholder="0"
                    value={pauseDurationMinutes}
                    onChange={(event) => setPauseDurationMinutes(event.target.value)}
                    disabled={savingPauseRequest}
                  />
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label>{t('paymentAccounts.requestedResumeAt')}</Label>
                  <DateTimePicker
                    mode="date-time"
                    date={pauseResumeAt}
                    setDate={setPauseResumeAt}
                    disabled={savingPauseRequest}
                    placeholder={t('paymentAccounts.selectRequestedResumeTime')}
                  />
                </div>
              )}
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setPauseRequestOpen(false)} disabled={savingPauseRequest}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={submitPauseRequest}
              disabled={savingPauseRequest || !pauseReason.trim() || !pauseRequestTimingValid}
            >
              <PauseCircle className="mr-2 h-4 w-4" />
              {t('paymentAccounts.submitPauseRequest')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog
        open={pauseReviewDecision !== null}
        onOpenChange={(open) => !savingPauseReview && !open && setPauseReviewDecision(null)}
      >
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!savingPauseReview}
          onPointerDownOutside={(event) => savingPauseReview && event.preventDefault()}
          onEscapeKeyDown={(event) => savingPauseReview && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>
              {t(
                pauseReviewDecision === 'approved'
                  ? 'paymentAccounts.approvePauseRequest'
                  : 'paymentAccounts.rejectPauseRequest'
              )}
            </AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-2">
              <Label htmlFor="cashier-shift-pause-review-note">{t('paymentAccounts.reviewNote')}</Label>
              <Textarea
                id="cashier-shift-pause-review-note"
                value={pauseReviewNote}
                onChange={(event) => setPauseReviewNote(event.target.value)}
                disabled={savingPauseReview}
              />
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setPauseReviewDecision(null)} disabled={savingPauseReview}>
              {t('common.cancel')}
            </Button>
            <PressAndHoldButton
              onComplete={reviewPauseRequest}
              idleLabel={t(
                pauseReviewDecision === 'approved'
                  ? 'paymentAccounts.holdToApprovePauseRequest'
                  : 'paymentAccounts.holdToRejectPauseRequest'
              )}
              holdingLabel={t('paymentAccounts.keepHoldingToReviewPauseRequest')}
              loadingLabel={t('paymentAccounts.reviewingPauseRequest')}
              isLoading={savingPauseReview}
              icon={pauseReviewDecision === 'approved' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            />
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog open={adminPauseOpen} onOpenChange={(open) => !savingAdminPause && setAdminPauseOpen(open)}>
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!savingAdminPause}
          onPointerDownOutside={(event) => savingAdminPause && event.preventDefault()}
          onEscapeKeyDown={(event) => savingAdminPause && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('paymentAccounts.pauseShift')}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-5">
              <p className="text-sm text-muted-foreground">{t('paymentAccounts.adminPauseDescription')}</p>
              <div className="grid gap-3">
                <Button
                  type="button"
                  variant={adminPauseKind === 'admin' ? 'default' : 'outline'}
                  className="h-auto justify-start p-4 text-left"
                  onClick={() => setAdminPauseKind('admin')}
                  disabled={savingAdminPause}
                >
                  <PauseCircle className="mr-3 h-5 w-5 shrink-0" />
                  <span>
                    <span className="block font-semibold">{t('paymentAccounts.adminPause')}</span>
                    <span className="mt-1 block text-xs font-normal opacity-80">
                      {t('paymentAccounts.adminPauseOptionDescription')}
                    </span>
                  </span>
                </Button>
                <Button
                  type="button"
                  variant={adminPauseKind === 'emergency' ? 'destructive' : 'outline'}
                  className="h-auto justify-start p-4 text-left"
                  onClick={() => setAdminPauseKind('emergency')}
                  disabled={savingAdminPause}
                >
                  <ShieldAlert className="mr-3 h-5 w-5 shrink-0" />
                  <span>
                    <span className="block font-semibold">{t('paymentAccounts.emergencyPause')}</span>
                    <span className="mt-1 block text-xs font-normal opacity-80">
                      {t('paymentAccounts.emergencyPauseOptionDescription')}
                    </span>
                  </span>
                </Button>
              </div>
              {adminPauseKind === 'emergency' ? (
                <div className="grid gap-2">
                  <Label htmlFor="cashier-shift-emergency-pause-note">{t('paymentAccounts.note')}</Label>
                  <Textarea
                    id="cashier-shift-emergency-pause-note"
                    value={adminPauseNote}
                    onChange={(event) => setAdminPauseNote(event.target.value)}
                    disabled={savingAdminPause}
                  />
                </div>
              ) : null}
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setAdminPauseOpen(false)} disabled={savingAdminPause}>
              {t('common.cancel')}
            </Button>
            <Button onClick={confirmAdminPause} disabled={savingAdminPause || !adminPauseKind}>
              <PauseCircle className="mr-2 h-4 w-4" />
              {t('paymentAccounts.confirmPause')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog open={resumeOpen} onOpenChange={(open) => !savingResume && setResumeOpen(open)}>
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!savingResume}
          onPointerDownOutside={(event) => savingResume && event.preventDefault()}
          onEscapeKeyDown={(event) => savingResume && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('paymentAccounts.resumeShift')}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            <p className="text-sm text-muted-foreground">{t('paymentAccounts.resumeShiftDescription')}</p>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setResumeOpen(false)} disabled={savingResume}>
              {t('common.cancel')}
            </Button>
            <PressAndHoldButton
              onComplete={resumeShift}
              idleLabel={t('paymentAccounts.holdToResumeShift')}
              holdingLabel={t('paymentAccounts.keepHoldingToResumeShift')}
              loadingLabel={t('paymentAccounts.resumingShift')}
              isLoading={savingResume}
              icon={<PlayCircle className="h-4 w-4" />}
            />
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog open={terminationOpen} onOpenChange={(open) => !savingTermination && setTerminationOpen(open)}>
        <AppDialogContent
          className="max-w-xl"
          showCloseButton={!savingTermination}
          onPointerDownOutside={(event) => savingTermination && event.preventDefault()}
          onEscapeKeyDown={(event) => savingTermination && event.preventDefault()}
        >
          <AppDialogHeader>
            <AppDialogTitle>{t('paymentAccounts.terminateShift')}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid gap-3">
              <p className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-3 text-sm text-muted-foreground">
                {t('paymentAccounts.terminateShiftDescription')}
              </p>
              <div className="grid gap-2">
                <Label htmlFor="cashier-shift-termination-reason">{t('paymentAccounts.terminationReason')}</Label>
                <Textarea
                  id="cashier-shift-termination-reason"
                  value={terminationReason}
                  onChange={(event) => setTerminationReason(event.target.value)}
                  disabled={savingTermination}
                />
              </div>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setTerminationOpen(false)} disabled={savingTermination}>
              {t('common.cancel')}
            </Button>
            <PressAndHoldButton
              onComplete={terminateShift}
              idleLabel={t('paymentAccounts.holdToTerminateShift')}
              holdingLabel={t('paymentAccounts.keepHoldingToTerminateShift')}
              loadingLabel={t('paymentAccounts.terminatingShift')}
              isLoading={savingTermination}
              icon={<Ban className="h-4 w-4" />}
            />
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>
    </div>
  )
}
