import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  FolderCog,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  UserRound,
} from 'lucide-react'
import { useAuth } from '@/auth/AuthContext'
import { DateRangeBadge } from '@/ui/components/DateRangeBadge'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  AppPagination,
  Button,
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
  useToast,
} from '@/ui/components'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { Beauty3ProcedureManagerDialog } from '@/ui/components/clinical/Beauty3ProcedureManagerDialog'
import { PaymentReversalDialog, type PaymentReversalDialogInput } from '@/ui/components/payments/PaymentReversalDialog'
import { SettlementDialog } from '@/ui/components/payments/SettlementDialog'
import {
  appendPaymentTransaction,
  getPaymentTransactionReversalState,
  reversePaymentTransaction,
} from '@/local-db/payments'
import { useClinicalPresetsByCategory } from '@/local-db/clinicalPresets'
import { useDateRange } from '@/context/DateRangeContext'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import { queryKeys } from '@/query/queryKeys'
import {
  BEAUTY3_APPOINTMENTS_TABLE,
  BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE,
  deleteBeauty3Appointment,
  getBeauty3AppointmentProfitTransactions,
  InvalidBeauty3ProcedureTypeError,
  saveBeauty3Appointment,
  useBeauty3AppointmentProfitTransactions,
  useBeauty3AppointmentPage,
  type Beauty3AppointmentDraft,
  type Beauty3AppointmentPageQuery,
} from '@/local-db/beauty3Appointments'
import {
  BEAUTY3_BUILT_IN_PROCEDURES,
  BEAUTY3_OTHER_PROCEDURE_TYPE,
  BEAUTY3_PROCEDURE_PRESET_CATEGORY,
} from '@/local-db/beauty3Procedures'
import { formatCurrency, formatDate, formatLocalDateValue, formatNumericInput, parseFormattedNumber, parseLocalDateValue, sanitizeNumericInput } from '@/lib/utils'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { isDemoWorkspaceMode, isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import type {
  Beauty3Appointment,
  CurrencyCode,
  PaymentObligation,
  PaymentTransaction,
  WorkspacePaymentMethod,
} from '@/local-db/models'

const PAGE_SIZE_OPTIONS = [10, 20, 50]
const PAYMENT_EPSILON = 0.000001
const columnHelper = createColumnHelper<Beauty3Appointment>()

type ActiveBeauty3ProfitPayment = {
  transaction: PaymentTransaction
  remainingAmount: number
}

type PendingBeauty3ProfitEdit = {
  appointment: Beauty3Appointment
  draft: Beauty3AppointmentDraft
  transaction: PaymentTransaction
  saveAppointment: boolean
  reversalInput?: PaymentReversalDialogInput
  appointmentSaved?: boolean
  reversalCompleted?: boolean
  paymentRecorded?: boolean
}

type Beauty3ProfitSettlementInput = {
  paymentMethod: WorkspacePaymentMethod
  paidAt: string
  note?: string
  accountId?: string | null
  accountNameSnapshot?: string | null
}

type Beauty3AppointmentSavePaymentMode = 'dialog' | 'immediate'

function getActiveBeauty3ProfitPayment(
  appointmentId: string,
  transactions: readonly PaymentTransaction[],
): ActiveBeauty3ProfitPayment | null {
  const relevant = transactions.filter((transaction) => (
    transaction.sourceType === BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE
    && transaction.sourceRecordId === appointmentId
    && !transaction.isDeleted
  ))
  const candidates = relevant
    .filter((transaction) => (
      !transaction.reversalOfTransactionId
      && !transaction.voidId
      && transaction.amount > PAYMENT_EPSILON
    ))
    .sort((left, right) => (
      left.paidAt.localeCompare(right.paidAt)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id)
    ))

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const transaction = candidates[index]
    const state = getPaymentTransactionReversalState(transaction, relevant)
    if (state.remainingAmount > PAYMENT_EPSILON) {
      return { transaction, remainingAmount: state.remainingAmount }
    }
  }

  return null
}

function isBeauty3ProfitPaymentCurrent(
  appointment: Beauty3Appointment,
  payment: ActiveBeauty3ProfitPayment,
) {
  return Math.abs(payment.remainingAmount - appointment.totalProfit) <= PAYMENT_EPSILON
    && payment.transaction.currency === appointment.currency
    && payment.transaction.counterpartyName === appointment.name
    && payment.transaction.referenceLabel === appointment.name
}

function toBeauty3AppointmentDraft(appointment: Beauty3Appointment): Beauty3AppointmentDraft {
  return {
    name: appointment.name,
    age: appointment.age,
    maritalStatus: appointment.maritalStatus,
    address: appointment.address,
    phoneNumber: appointment.phoneNumber,
    procedureType: appointment.procedureType,
    procedureTypeOther: appointment.procedureTypeOther,
    procedurePlace: appointment.procedurePlace,
    procedureDate: appointment.procedureDate,
    appointmentTotal: appointment.appointmentTotal,
    totalProfit: appointment.totalProfit,
    currency: appointment.currency,
  }
}

function getSavedPageSize() {
  if (typeof window === 'undefined') return 20
  const saved = Number(window.localStorage.getItem('beauty3_appointments_page_size'))
  return PAGE_SIZE_OPTIONS.includes(saved) ? saved : 20
}

export function Beauty3Appointments() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { features } = useWorkspace()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { dateRange, customDates, dateFilterDayBoundary } = useDateRange()
  const workspaceId = user?.workspaceId ?? ''
  const [search, setSearch] = useState('')
  const [pageSize] = useState(getSavedPageSize)
  const savePageSize = useCallback((nextPageSize: number) => {
    if (typeof window !== 'undefined' && PAGE_SIZE_OPTIONS.includes(nextPageSize)) {
      window.localStorage.setItem('beauty3_appointments_page_size', String(nextPageSize))
    }
  }, [])
  const pagination = usePaginationState({
    initialPageSize: pageSize,
    resetOn: [search, dateRange, customDates.start, customDates.end],
    onPageSizeChange: savePageSize,
  })

  const dateBounds = useMemo(
    () => getDateRangeBounds(dateRange, customDates, new Date(), dateFilterDayBoundary),
    [customDates, dateFilterDayBoundary, dateRange],
  )
  const dateFrom = dateBounds.start ? formatLocalDateValue(dateBounds.start) : undefined
  const dateTo = dateBounds.end ? formatLocalDateValue(dateBounds.end) : undefined
  const isLocalSource = workspaceId
    ? isLocalWorkspaceMode(workspaceId) || isDemoWorkspaceMode(workspaceId)
    : false

  const pageQuery = useMemo<Beauty3AppointmentPageQuery>(() => ({
    workspaceId,
    page: pagination.currentPage,
    pageSize: pagination.pageSize,
    search,
    dateFrom,
    dateTo,
    sourceMode: isLocalSource ? 'local' : 'remote',
    sort: 'procedureDate:desc,id:desc',
  }), [
    dateFrom,
    dateTo,
    isLocalSource,
    pagination.currentPage,
    pagination.pageSize,
    search,
    workspaceId,
  ])
  const page = useBeauty3AppointmentPage(pageQuery, user?.id)
  const paginationBounds = usePaginationBounds({
    currentPage: pagination.currentPage,
    setCurrentPage: pagination.setCurrentPage,
    totalCount: page.totalCount,
    pageSize: pagination.pageSize,
    isLoading: page.isLoading,
    error: page.error,
  })
  const pageAppointmentIds = useMemo(() => page.items.map((appointment) => appointment.id), [page.items])
  const profitPaymentQuery = useBeauty3AppointmentProfitTransactions(
    workspaceId,
    pageAppointmentIds,
    user?.id,
  )
  const profitPaymentByAppointmentId = useMemo(() => {
    const byId = new Map<string, 'loading' | 'unavailable' | 'none' | 'paid' | 'unpaid' | 'adjustment'>()
    for (const appointment of page.items) {
      const activePayment = getActiveBeauty3ProfitPayment(
        appointment.id,
        profitPaymentQuery.transactions,
      )
      const status = profitPaymentQuery.error || !profitPaymentQuery.isAvailable
        ? 'unavailable'
        : profitPaymentQuery.isLoading
          ? 'loading'
          : appointment.totalProfit <= PAYMENT_EPSILON
          ? activePayment ? 'adjustment' : 'none'
          : activePayment
            ? isBeauty3ProfitPaymentCurrent(appointment, activePayment)
              ? 'paid'
              : 'adjustment'
            : 'unpaid'
      byId.set(appointment.id, status)
    }
    return byId
  }, [page.items, profitPaymentQuery.error, profitPaymentQuery.isAvailable, profitPaymentQuery.isLoading, profitPaymentQuery.transactions])

  const [isFormOpen, setIsFormOpen] = useState(false)
  const [isProcedureManagerOpen, setIsProcedureManagerOpen] = useState(false)
  const [editingAppointment, setEditingAppointment] = useState<Beauty3Appointment | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Beauty3Appointment | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [settlementTarget, setSettlementTarget] = useState<Beauty3Appointment | null>(null)
  const [isSettlementOpen, setIsSettlementOpen] = useState(false)
  const [reversalTarget, setReversalTarget] = useState<PaymentTransaction | null>(null)
  const [isReversalOpen, setIsReversalOpen] = useState(false)
  const [pendingProfitEdit, setPendingProfitEdit] = useState<PendingBeauty3ProfitEdit | null>(null)
  const [pendingDeleteAppointment, setPendingDeleteAppointment] = useState<Beauty3Appointment | null>(null)
  const [pendingProfitPaymentAppointment, setPendingProfitPaymentAppointment] = useState<Beauty3Appointment | null>(null)
  const [isPaymentSubmitting, setIsPaymentSubmitting] = useState(false)
  const paymentSubmittingRef = useRef(false)

  const openCreateForm = () => {
    setEditingAppointment(null)
    setIsFormOpen(true)
  }
  const openEditForm = (appointment: Beauty3Appointment) => {
    setEditingAppointment(appointment)
    setIsFormOpen(true)
  }
  const closeForm = () => {
    setIsFormOpen(false)
    setEditingAppointment(null)
  }
  const invalidateAppointments = useCallback(
    () => queryClient.invalidateQueries({
      queryKey: queryKeys.beauty3Appointments.all(workspaceId),
    }),
    [queryClient, workspaceId],
  )

  const recordProfitPayment = useCallback(async (
    appointment: Beauty3Appointment,
    input: Beauty3ProfitSettlementInput,
  ) => appendPaymentTransaction(workspaceId, {
    sourceModule: 'clinical_appointments',
    sourceType: BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE,
    sourceRecordId: appointment.id,
    direction: 'incoming',
    amount: appointment.totalProfit,
    currency: appointment.currency,
    paymentMethod: input.paymentMethod,
    paidAt: input.paidAt,
    counterpartyName: appointment.name,
    referenceLabel: appointment.name,
    note: input.note?.trim() || null,
    createdBy: user?.id ?? null,
    accountId: input.accountId ?? null,
    accountNameSnapshot: input.accountNameSnapshot ?? null,
    metadata: {
      beauty3AppointmentId: appointment.id,
      beauty3AppointmentProfit: appointment.totalProfit,
    },
  }), [workspaceId, user?.id])

  const handleSaved = async (draft: Beauty3AppointmentDraft, paymentMode: Beauty3AppointmentSavePaymentMode) => {
    try {
      if (editingAppointment) {
        if (profitPaymentQuery.isLoading || profitPaymentQuery.error || !profitPaymentQuery.isAvailable) {
          toast({ variant: 'destructive', title: t('beauty3Appointments.paymentStatusUnavailable') })
          return
        }
        const hasChanges = Object.keys(draft).some((key) => {
          const draftKey = key as keyof Beauty3AppointmentDraft
          return draft[draftKey] !== editingAppointment[draftKey]
        })
        const transactions = await getBeauty3AppointmentProfitTransactions(workspaceId, editingAppointment.id)
        const activePayment = getActiveBeauty3ProfitPayment(editingAppointment.id, transactions)

        if (activePayment && hasChanges) {
          setPendingProfitEdit({
            appointment: editingAppointment,
            draft,
            transaction: activePayment.transaction,
            saveAppointment: true,
          })
          setReversalTarget(activePayment.transaction)
          setIsReversalOpen(true)
          return
        }
      }

      const result = await saveBeauty3Appointment(draft, workspaceId, user?.id, editingAppointment?.id)
      await invalidateAppointments()
      if (result.appointment.totalProfit > PAYMENT_EPSILON) {
        const transactions = await getBeauty3AppointmentProfitTransactions(workspaceId, result.appointment.id)
        const activePayment = getActiveBeauty3ProfitPayment(result.appointment.id, transactions)
        if (!activePayment) {
          if (paymentMode === 'immediate' && !editingAppointment) {
            try {
              await recordProfitPayment(result.appointment, {
                paymentMethod: 'cash',
                paidAt: new Date().toISOString(),
              })
              await invalidateAppointments().catch((refreshError) => {
                console.warn('[Beauty3Appointments] Could not refresh after immediate payment:', refreshError)
              })
              closeForm()
              toast({ title: t('beauty3Appointments.appointmentAndPaymentSaved') })
            } catch (paymentError) {
              console.error('[Beauty3Appointments] Appointment saved but immediate payment failed:', paymentError)
              await invalidateAppointments().catch((refreshError) => {
                console.warn('[Beauty3Appointments] Could not refresh after failed immediate payment:', refreshError)
              })
              closeForm()
              toast({ variant: 'destructive', title: t('beauty3Appointments.appointmentSavedPaymentFailed') })
            }
            return
          }

          closeForm()
          setPendingProfitPaymentAppointment(result.appointment)
          setSettlementTarget(result.appointment)
          setIsSettlementOpen(true)
          return
        }
      }

      toast({
        title: result.syncPending
          ? t('beauty3Appointments.savedPendingSync')
          : t('beauty3Appointments.saved'),
      })
      closeForm()
    } catch (error) {
      console.error('[Beauty3Appointments] Failed to save appointment:', error)
      toast({
        variant: 'destructive',
        title: error instanceof InvalidBeauty3ProcedureTypeError
          ? t('beauty3Appointments.procedureNoLongerAvailable')
          : t('beauty3Appointments.saveFailed'),
      })
    }
  }

  const beginProfitPaymentFlow = async (appointment: Beauty3Appointment) => {
    if (!workspaceId || isPaymentSubmitting || profitPaymentQuery.isLoading || profitPaymentQuery.error || !profitPaymentQuery.isAvailable) return
    try {
      const transactions = await getBeauty3AppointmentProfitTransactions(workspaceId, appointment.id)
      const activePayment = getActiveBeauty3ProfitPayment(appointment.id, transactions)

      if (activePayment) {
        if (appointment.totalProfit <= PAYMENT_EPSILON) {
          setPendingProfitEdit({
            appointment,
            draft: toBeauty3AppointmentDraft(appointment),
            transaction: activePayment.transaction,
            saveAppointment: false,
          })
        } else if (!isBeauty3ProfitPaymentCurrent(appointment, activePayment)) {
          setPendingProfitEdit({
            appointment,
            draft: toBeauty3AppointmentDraft(appointment),
            transaction: activePayment.transaction,
            saveAppointment: false,
          })
        } else {
          return
        }

        setReversalTarget(activePayment.transaction)
        setIsReversalOpen(true)
        return
      }

      if (appointment.totalProfit > PAYMENT_EPSILON) {
        setPendingProfitPaymentAppointment(appointment)
        setSettlementTarget(appointment)
        setIsSettlementOpen(true)
      }
    } catch (error) {
      console.error('[Beauty3Appointments] Failed to load profit payment:', error)
      toast({ variant: 'destructive', title: t('beauty3Appointments.paymentFailed') })
    }
  }

  const completeProfitEdit = async (
    flow: PendingBeauty3ProfitEdit,
    settlementInput?: Beauty3ProfitSettlementInput,
  ) => {
    let currentFlow = flow
    if (currentFlow.saveAppointment && !currentFlow.appointmentSaved) {
      await saveBeauty3Appointment(
        currentFlow.draft,
        workspaceId,
        user?.id,
        currentFlow.appointment.id,
      )
      currentFlow = { ...currentFlow, appointmentSaved: true }
      setPendingProfitEdit(currentFlow)
      await invalidateAppointments().catch((error) => {
        console.warn('[Beauty3Appointments] Could not refresh after appointment update:', error)
      })
    }

    if (!currentFlow.reversalCompleted) {
      if (!currentFlow.reversalInput) return
      await reversePaymentTransaction(workspaceId, currentFlow.transaction.id, {
        ...currentFlow.reversalInput,
        createdBy: user?.id ?? null,
      })
      currentFlow = { ...currentFlow, reversalCompleted: true }
      setPendingProfitEdit(currentFlow)
      await invalidateAppointments().catch((error) => {
        console.warn('[Beauty3Appointments] Could not refresh after payment reversal:', error)
      })
    }

    if (currentFlow.draft.totalProfit > PAYMENT_EPSILON) {
      if (!settlementInput) return
      if (!currentFlow.paymentRecorded) {
        const replacementAppointment = { ...currentFlow.appointment, ...currentFlow.draft }
        await recordProfitPayment(replacementAppointment, settlementInput)
        currentFlow = { ...currentFlow, paymentRecorded: true }
        setPendingProfitEdit(currentFlow)
      }
    }

    await invalidateAppointments().catch((error) => {
      console.warn('[Beauty3Appointments] Could not refresh after payment update:', error)
    })
    setPendingProfitEdit(null)
    setPendingProfitPaymentAppointment(null)
    setSettlementTarget(null)
    setReversalTarget(null)
    setIsSettlementOpen(false)
    setIsReversalOpen(false)
    closeForm()
    toast({ title: t('beauty3Appointments.paymentUpdated') })
  }

  const handleSettlementSubmit = async (input: Beauty3ProfitSettlementInput) => {
    if (paymentSubmittingRef.current || !workspaceId) return
    paymentSubmittingRef.current = true
    setIsPaymentSubmitting(true)
    try {
      if (pendingProfitEdit) {
        await completeProfitEdit(pendingProfitEdit, input)
        return
      }
      if (!pendingProfitPaymentAppointment) return

      await recordProfitPayment(pendingProfitPaymentAppointment, input)
      await invalidateAppointments().catch((error) => {
        console.warn('[Beauty3Appointments] Could not refresh after payment:', error)
      })
      setPendingProfitPaymentAppointment(null)
      setSettlementTarget(null)
      setIsSettlementOpen(false)
      toast({ title: t('beauty3Appointments.paymentRecorded') })
    } catch (error) {
      console.error('[Beauty3Appointments] Failed to record profit payment:', error)
      toast({ variant: 'destructive', title: t('beauty3Appointments.paymentFailed') })
    } finally {
      paymentSubmittingRef.current = false
      setIsPaymentSubmitting(false)
    }
  }

  const handleReversalSubmit = async (input: PaymentReversalDialogInput) => {
    if (pendingDeleteAppointment) {
      if (paymentSubmittingRef.current || !workspaceId) return
      paymentSubmittingRef.current = true
      setIsPaymentSubmitting(true)
      setIsDeleting(true)
      const appointment = pendingDeleteAppointment
      let reversalRecorded = false
      try {
        if (!reversalTarget) {
          toast({ variant: 'destructive', title: t('beauty3Appointments.paymentFailed') })
          return
        }
        await reversePaymentTransaction(workspaceId, reversalTarget.id, {
          ...input,
          createdBy: user?.id ?? null,
        })
        reversalRecorded = true
        await deleteBeauty3Appointment(appointment.id, workspaceId)
        await invalidateAppointments().catch((error) => {
          console.warn('[Beauty3Appointments] Could not refresh after deletion:', error)
        })
        setPendingDeleteAppointment(null)
        setReversalTarget(null)
        setIsReversalOpen(false)
        toast({ title: t('beauty3Appointments.deleted') })
      } catch (error) {
        console.error('[Beauty3Appointments] Failed to reverse payment and delete appointment:', error)
        if (reversalRecorded) {
          await invalidateAppointments().catch((refreshError) => {
            console.warn('[Beauty3Appointments] Could not refresh after failed deletion:', refreshError)
          })
          setPendingDeleteAppointment(null)
          setReversalTarget(null)
          setIsReversalOpen(false)
          setDeleteTarget(appointment)
        }
        toast({ variant: 'destructive', title: t('beauty3Appointments.deleteFailed') })
      } finally {
        paymentSubmittingRef.current = false
        setIsPaymentSubmitting(false)
        setIsDeleting(false)
      }
      return
    }

    if (!pendingProfitEdit || paymentSubmittingRef.current) return
    const nextFlow = { ...pendingProfitEdit, reversalInput: input }
    setPendingProfitEdit(nextFlow)
    if (nextFlow.draft.totalProfit > PAYMENT_EPSILON) {
      setReversalTarget(nextFlow.transaction)
      setSettlementTarget({ ...nextFlow.appointment, ...nextFlow.draft })
      setIsReversalOpen(false)
      setIsSettlementOpen(true)
      return
    }

    if (!workspaceId) return
    paymentSubmittingRef.current = true
    setIsPaymentSubmitting(true)
    try {
      await completeProfitEdit(nextFlow)
    } catch (error) {
      console.error('[Beauty3Appointments] Failed to update profit payment:', error)
      toast({ variant: 'destructive', title: t('beauty3Appointments.paymentFailed') })
    } finally {
      paymentSubmittingRef.current = false
      setIsPaymentSubmitting(false)
    }
  }

  const handleReversalOpenChange = (open: boolean) => {
    if (open) {
      setIsReversalOpen(true)
      return
    }
    if (isPaymentSubmitting) return
    setIsReversalOpen(false)
    setReversalTarget(null)
    setPendingDeleteAppointment(null)
    setPendingProfitEdit(null)
  }

  const handleSettlementOpenChange = (open: boolean) => {
    if (isPaymentSubmitting) return
    setIsSettlementOpen(open)
    if (!open) {
      setSettlementTarget(null)
      setPendingProfitPaymentAppointment(null)
      setPendingProfitEdit(null)
      setReversalTarget(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget || !workspaceId || isDeleting) return
    if (profitPaymentQuery.isLoading || profitPaymentQuery.error || !profitPaymentQuery.isAvailable) {
      toast({ variant: 'destructive', title: t('beauty3Appointments.paymentStatusUnavailable') })
      return
    }
    setIsDeleting(true)
    const appointment = deleteTarget
    try {
      const transactions = await getBeauty3AppointmentProfitTransactions(workspaceId, appointment.id)
      const activePayment = getActiveBeauty3ProfitPayment(appointment.id, transactions)
      if (activePayment) {
        setPendingDeleteAppointment(appointment)
        setReversalTarget(activePayment.transaction)
        setDeleteTarget(null)
        setIsReversalOpen(true)
        return
      }

      const result = await deleteBeauty3Appointment(appointment.id, workspaceId)
      if (result) {
        await invalidateAppointments()
        toast({
          title: result.syncPending
            ? t('beauty3Appointments.deletePendingSync')
            : t('beauty3Appointments.deleted'),
        })
      }
      setDeleteTarget(null)
    } catch (error) {
      console.error('[Beauty3Appointments] Failed to delete appointment:', error)
      toast({ variant: 'destructive', title: t('beauty3Appointments.deleteFailed') })
    } finally {
      setIsDeleting(false)
    }
  }

  const formatProcedureType = useCallback((appointment: Beauty3Appointment) => {
    if (appointment.procedureType === BEAUTY3_OTHER_PROCEDURE_TYPE) {
      return appointment.procedureTypeOther || t('beauty3Appointments.procedureTypes.other')
    }
    const builtInProcedure = BEAUTY3_BUILT_IN_PROCEDURES.find(
      (procedure) => procedure.value === appointment.procedureType,
    )
    return builtInProcedure
      ? t(builtInProcedure.translationKey)
      : appointment.procedureType || '—'
  }, [t])

  const columns = useMemo(() => [
    columnHelper.accessor('name', {
      header: t('beauty3Appointments.name'),
      cell: (info) => <span className="font-medium">{info.getValue()}</span>,
    }),
    columnHelper.accessor('age', {
      header: t('beauty3Appointments.age'),
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('maritalStatus', {
      header: t('beauty3Appointments.maritalStatus'),
      cell: (info) => t('beauty3Appointments.' + info.getValue()),
    }),
    columnHelper.accessor('address', {
      header: t('beauty3Appointments.address'),
      cell: (info) => <span className="block max-w-48 truncate" title={info.getValue()}>{info.getValue()}</span>,
    }),
    columnHelper.accessor('phoneNumber', {
      header: t('beauty3Appointments.phoneNumber'),
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('procedureType', {
      header: t('beauty3Appointments.procedureType'),
      cell: (info) => formatProcedureType(info.row.original),
    }),
    columnHelper.accessor('procedurePlace', {
      header: t('beauty3Appointments.procedurePlace'),
      cell: (info) => t('commerceOperations.cities.' + info.getValue()),
    }),
    columnHelper.accessor('procedureDate', {
      header: t('beauty3Appointments.procedureDate'),
      cell: (info) => formatDate(parseLocalDateValue(info.getValue()) ?? info.getValue()),
    }),
    columnHelper.accessor('appointmentTotal', {
      header: t('beauty3Appointments.appointmentTotal'),
      cell: (info) => formatCurrency(info.getValue(), info.row.original.currency, features.iqd_display_preference),
    }),
    columnHelper.accessor('totalProfit', {
      header: t('beauty3Appointments.totalProfit'),
      cell: (info) => {
        const paymentStatus = profitPaymentByAppointmentId.get(info.row.original.id)
        return (
          <div className="space-y-1">
            <div className="font-medium">
              {formatCurrency(info.getValue(), info.row.original.currency, features.iqd_display_preference)}
            </div>
            {paymentStatus === 'paid' ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" />{t('beauty3Appointments.paid')}
              </span>
            ) : paymentStatus === 'loading' ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />{t('beauty3Appointments.paymentStatusLoading')}
              </span>
            ) : paymentStatus === 'unavailable' ? (
              <span className="text-xs text-destructive">{t('beauty3Appointments.paymentStatusUnavailable')}</span>
            ) : paymentStatus === 'unpaid' ? (
              <span className="text-xs text-amber-700 dark:text-amber-400">
                {t('beauty3Appointments.paymentNeeded')}
              </span>
            ) : paymentStatus === 'adjustment' ? (
              <span className="text-xs text-amber-700 dark:text-amber-400">
                {t('beauty3Appointments.paymentAdjustmentNeeded')}
              </span>
            ) : null}
          </div>
        )
      },
    }),
    columnHelper.display({
      id: 'actions',
      header: t('beauty3Appointments.actions'),
      cell: (info) => {
        const paymentStatus = profitPaymentByAppointmentId.get(info.row.original.id)
        return (
        <div className="flex items-center gap-1">
          {paymentStatus === 'unpaid' || paymentStatus === 'adjustment' ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void beginProfitPaymentFlow(info.row.original)}
              disabled={isPaymentSubmitting || profitPaymentQuery.isLoading || !!profitPaymentQuery.error || !profitPaymentQuery.isAvailable}
              aria-label={paymentStatus === 'adjustment'
                ? t('beauty3Appointments.updateProfitPayment')
                : t('beauty3Appointments.recordProfitPayment')}
              title={paymentStatus === 'adjustment'
                ? t('beauty3Appointments.updateProfitPayment')
                : t('beauty3Appointments.recordProfitPayment')}
            >
              <CircleDollarSign className="size-4" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => openEditForm(info.row.original)}
            disabled={profitPaymentQuery.isLoading || !!profitPaymentQuery.error || !profitPaymentQuery.isAvailable}
            aria-label={t('beauty3Appointments.edit')}
            title={t('beauty3Appointments.edit')}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setDeleteTarget(info.row.original)}
            disabled={profitPaymentQuery.isLoading || !!profitPaymentQuery.error || !profitPaymentQuery.isAvailable}
            aria-label={t('common.delete')}
            title={t('common.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        )
      },
    }),
  ], [
    beginProfitPaymentFlow,
    features.iqd_display_preference,
    formatProcedureType,
    isPaymentSubmitting,
    profitPaymentByAppointmentId,
    profitPaymentQuery.error,
    profitPaymentQuery.isAvailable,
    profitPaymentQuery.isLoading,
    t,
  ])

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

  return (
    <div className="w-full space-y-5 p-4 sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {t('beauty3Appointments.title')}
            <DateRangeBadge />
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('beauty3Appointments.subtitle')}
            <ModulePageFreshness
              className="ms-2"
              tableNames={[BEAUTY3_APPOINTMENTS_TABLE, 'clinical_presets', 'beauty3_appointment_profit_payments']}
            />
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="outline"
            onClick={() => setIsProcedureManagerOpen(true)}
            className="shrink-0"
          >
            <FolderCog className="me-2 size-4" />
            {t('beauty3Appointments.addProcedure')}
          </Button>
          <Button type="button" onClick={openCreateForm} className="shrink-0">
            <Plus className="me-2 size-4" />
            {t('beauty3Appointments.create')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="relative w-full xl:max-w-md">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('beauty3Appointments.search')}
            className="ps-9"
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CalendarDays className="size-4" />
            {t('beauty3Appointments.procedureDate')}
          </span>
          <DateRangeFilters />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {t('beauty3Appointments.recordCount', { count: page.totalCount })}
        </span>
        <AppPagination
          currentPage={paginationBounds.currentPage}
          totalCount={page.totalCount}
          pageCount={paginationBounds.pageCount}
          pageSize={pagination.pageSize}
          onPageChange={pagination.setCurrentPage}
          onPageSizeChange={pagination.setPageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </div>

      {page.isError && (
        <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          {t('beauty3Appointments.loadFailed')}
        </p>
      )}

      {page.isLoading ? (
        <div className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-5 animate-spin" />
          {t('beauty3Appointments.loading')}
        </div>
      ) : page.items.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center text-muted-foreground">
          <CalendarDays className="size-8 opacity-60" />
          <p>{t('beauty3Appointments.noAppointments')}</p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:hidden">
            {page.items.map((appointment) => {
              const paymentStatus = profitPaymentByAppointmentId.get(appointment.id)
              return (
              <article key={appointment.id} className="space-y-3 rounded-xl border bg-background p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <UserRound className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{appointment.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {t('beauty3Appointments.age')}: {appointment.age}
                        {' · '}
                        {t('beauty3Appointments.' + appointment.maritalStatus)}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {paymentStatus === 'unpaid' || paymentStatus === 'adjustment' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => void beginProfitPaymentFlow(appointment)}
                        disabled={isPaymentSubmitting || profitPaymentQuery.isLoading || !!profitPaymentQuery.error || !profitPaymentQuery.isAvailable}
                        aria-label={paymentStatus === 'adjustment'
                          ? t('beauty3Appointments.updateProfitPayment')
                          : t('beauty3Appointments.recordProfitPayment')}
                        title={paymentStatus === 'adjustment'
                          ? t('beauty3Appointments.updateProfitPayment')
                          : t('beauty3Appointments.recordProfitPayment')}
                      >
                        <CircleDollarSign className="size-4" />
                      </Button>
                    ) : null}
                    <Button type="button" variant="ghost" size="icon" onClick={() => openEditForm(appointment)} disabled={profitPaymentQuery.isLoading || !!profitPaymentQuery.error || !profitPaymentQuery.isAvailable} aria-label={t('beauty3Appointments.edit')}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" onClick={() => setDeleteTarget(appointment)} disabled={profitPaymentQuery.isLoading || !!profitPaymentQuery.error || !profitPaymentQuery.isAvailable} aria-label={t('common.delete')}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div className="min-w-0">
                    <span className="text-muted-foreground">{t('beauty3Appointments.address')}</span>
                    <p className="break-words font-medium">{appointment.address}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('beauty3Appointments.phoneNumber')}</span>
                    <p className="break-all font-medium">{appointment.phoneNumber}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('beauty3Appointments.procedureType')}</span>
                    <p className="break-words font-medium">{formatProcedureType(appointment)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('beauty3Appointments.procedurePlace')}</span>
                    <p className="inline-flex items-center gap-1 font-medium">
                      <MapPin className="size-3.5" />
                      {t('commerceOperations.cities.' + appointment.procedurePlace)}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('beauty3Appointments.procedureDate')}</span>
                    <p className="font-medium">{formatDate(parseLocalDateValue(appointment.procedureDate) ?? appointment.procedureDate)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('beauty3Appointments.appointmentTotal')}</span>
                    <p className="font-medium">{formatCurrency(appointment.appointmentTotal, appointment.currency, features.iqd_display_preference)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{t('beauty3Appointments.totalProfit')}</span>
                    <p className="font-medium">{formatCurrency(appointment.totalProfit, appointment.currency, features.iqd_display_preference)}</p>
                    {paymentStatus === 'paid' ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="size-3.5" />{t('beauty3Appointments.paid')}
                      </span>
                    ) : paymentStatus === 'loading' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />{t('beauty3Appointments.paymentStatusLoading')}
                      </span>
                    ) : paymentStatus === 'unavailable' ? (
                      <span className="text-xs text-destructive">{t('beauty3Appointments.paymentStatusUnavailable')}</span>
                    ) : paymentStatus === 'unpaid' ? (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        {t('beauty3Appointments.paymentNeeded')}
                      </span>
                    ) : paymentStatus === 'adjustment' ? (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        {t('beauty3Appointments.paymentAdjustmentNeeded')}
                      </span>
                    ) : null}
                  </div>
                </div>
              </article>
              )
            })}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border md:block">
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
                      <TableCell key={cell.id} className="max-w-56">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <Beauty3AppointmentFormDialog
        open={isFormOpen}
        onOpenChange={(open) => {
          if (!open) closeForm()
        }}
        appointment={editingAppointment}
        workspaceId={workspaceId}
        defaultCurrency={features.default_currency}
        onSaved={handleSaved}
        onManageProcedures={() => setIsProcedureManagerOpen(true)}
      />

      <Beauty3ProcedureManagerDialog
        open={isProcedureManagerOpen}
        onOpenChange={setIsProcedureManagerOpen}
        workspaceId={workspaceId}
      />

      <SettlementDialog
        open={isSettlementOpen}
        onOpenChange={handleSettlementOpenChange}
        obligation={settlementTarget ? {
          id: `beauty3-profit:${settlementTarget.id}`,
          workspaceId,
          sourceModule: 'clinical_appointments',
          sourceType: BEAUTY3_APPOINTMENT_PROFIT_SOURCE_TYPE,
          sourceRecordId: settlementTarget.id,
          direction: 'incoming',
          amount: settlementTarget.totalProfit,
          currency: settlementTarget.currency,
          dueDate: settlementTarget.procedureDate,
          counterpartyName: settlementTarget.name,
          referenceLabel: settlementTarget.name,
          title: settlementTarget.name,
          subtitle: t('beauty3Appointments.profitPayment'),
          status: 'open',
          routePath: '/clinical-appointments',
          metadata: { beauty3AppointmentId: settlementTarget.id },
        } satisfies PaymentObligation : null}
        isSubmitting={isPaymentSubmitting}
        onSubmit={handleSettlementSubmit}
      />

      <PaymentReversalDialog
        open={isReversalOpen}
        onOpenChange={handleReversalOpenChange}
        onSubmit={handleReversalSubmit}
        isProcessing={isPaymentSubmitting || isDeleting}
        transaction={reversalTarget}
        workspaceId={workspaceId}
        iqdPreference={features.iqd_display_preference}
      />

      <DeleteConfirmationModal
        isOpen={Boolean(deleteTarget)}
        onClose={() => {
          if (!isDeleting) setDeleteTarget(null)
        }}
        onConfirm={handleDelete}
        isLoading={isDeleting}
        itemName={deleteTarget?.name ?? ''}
        title={t('beauty3Appointments.deleteTitle')}
        description={t('beauty3Appointments.deleteDescription')}
      />
    </div>
  )
}

function Beauty3AppointmentFormDialog({
  open,
  onOpenChange,
  appointment,
  workspaceId,
  defaultCurrency,
  onSaved,
  onManageProcedures,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  appointment: Beauty3Appointment | null
  workspaceId: string
  defaultCurrency: CurrencyCode
  onSaved: (draft: Beauty3AppointmentDraft, paymentMode: Beauty3AppointmentSavePaymentMode) => Promise<void>
  onManageProcedures: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [ageText, setAgeText] = useState('')
  const [maritalStatus, setMaritalStatus] = useState<Beauty3Appointment['maritalStatus'] | ''>('')
  const [address, setAddress] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [procedureType, setProcedureType] = useState('')
  const [procedureTypeOtherText, setProcedureTypeOtherText] = useState('')
  const [procedurePlace, setProcedurePlace] = useState<Beauty3Appointment['procedurePlace'] | ''>('')
  const [procedureDate, setProcedureDate] = useState<Date | undefined>()
  const [appointmentTotalText, setAppointmentTotalText] = useState('')
  const [totalProfitText, setTotalProfitText] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isSavingAndRecording, setIsSavingAndRecording] = useState(false)
  const currency = appointment?.currency ?? defaultCurrency
  const customProcedurePresets = useClinicalPresetsByCategory(
    workspaceId,
    BEAUTY3_PROCEDURE_PRESET_CATEGORY,
  )
  const customProcedures = (customProcedurePresets ?? []).filter((preset) => preset.isActive)
  const customProcedureNames = new Set(customProcedures.map((preset) => preset.name))

  useEffect(() => {
    if (!open) return
    setName(appointment?.name ?? '')
    setAgeText(appointment ? String(appointment.age) : '')
    setMaritalStatus(appointment?.maritalStatus ?? '')
    setAddress(appointment?.address ?? '')
    setPhoneNumber(appointment?.phoneNumber ?? '')
    setProcedureType(appointment?.procedureType ?? '')
    setProcedureTypeOtherText(appointment?.procedureTypeOther ?? '')
    setProcedurePlace(appointment?.procedurePlace ?? '')
    setProcedureDate(parseLocalDateValue(appointment?.procedureDate))
    setAppointmentTotalText(
      appointment ? formatNumericInput(String(appointment.appointmentTotal)) : '',
    )
    setTotalProfitText(
      appointment ? formatNumericInput(String(appointment.totalProfit)) : '',
    )
  }, [appointment, open])

  const isProcedureTypeBuiltin = BEAUTY3_BUILT_IN_PROCEDURES.some(
    (option) => option.value === procedureType,
  )
  const procedureTypeUnavailable = Boolean(
    procedureType
    && !isProcedureTypeBuiltin
    && customProcedurePresets !== undefined
    && !customProcedureNames.has(procedureType),
  )
  const procedureTypeIsValid = Boolean(
    procedureType
    && (
      procedureType === BEAUTY3_OTHER_PROCEDURE_TYPE
        ? procedureTypeOtherText.trim().length > 0
        : isProcedureTypeBuiltin
          ? true
          : customProcedurePresets !== undefined && customProcedureNames.has(procedureType)
    ),
  )

  const parsedAge = ageText.trim() === '' ? Number.NaN : Number(ageText)
  const parsedTotal = appointmentTotalText.trim() === ''
    ? Number.NaN
    : parseFormattedNumber(appointmentTotalText)
  const parsedProfit = totalProfitText.trim() === ''
    ? Number.NaN
    : parseFormattedNumber(totalProfitText)
  const isValid = Boolean(
    workspaceId
    && name.trim()
    && Number.isInteger(parsedAge)
    && parsedAge >= 0
    && maritalStatus
    && address.trim()
    && phoneNumber.trim()
    && procedureTypeIsValid
    && procedurePlace
    && procedureDate
    && Number.isFinite(parsedTotal)
    && parsedTotal >= 0
    && Number.isFinite(parsedProfit)
    && parsedProfit >= 0,
  )

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isValid || !maritalStatus || !procedureType || !procedurePlace || !procedureDate || isSaving) return
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    const paymentMode: Beauty3AppointmentSavePaymentMode = submitter instanceof HTMLButtonElement
      && submitter.value === 'save-and-record-payment'
      ? 'immediate'
      : 'dialog'
    setIsSaving(true)
    setIsSavingAndRecording(paymentMode === 'immediate')
    const draft: Beauty3AppointmentDraft = {
      name: name.trim(),
      age: parsedAge,
      maritalStatus,
      address: address.trim(),
      phoneNumber: phoneNumber.trim(),
      procedureType: procedureType.trim(),
      procedureTypeOther: procedureType === BEAUTY3_OTHER_PROCEDURE_TYPE
        ? procedureTypeOtherText.trim()
        : null,
      procedurePlace,
      procedureDate: formatLocalDateValue(procedureDate),
      appointmentTotal: parsedTotal,
      totalProfit: parsedProfit,
      currency,
    }
    try {
      await onSaved(draft, paymentMode)
    } finally {
      setIsSaving(false)
      setIsSavingAndRecording(false)
    }
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isSaving) return
    onOpenChange(nextOpen)
  }

  return (
    <AppDialog open={open} onOpenChange={handleOpenChange}>
      <AppDialogContent
        className="max-w-3xl"
        showCloseButton={!isSaving}
        onPointerDownOutside={(event) => {
          if (isSaving) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (isSaving) event.preventDefault()
        }}
      >
        <AppDialogHeader>
          <AppDialogTitle>
            {appointment ? t('beauty3Appointments.edit') : t('beauty3Appointments.create')}
          </AppDialogTitle>
          <p className="text-sm text-muted-foreground">{t('beauty3Appointments.formDescription')}</p>
        </AppDialogHeader>
        <form onSubmit={handleSave} className="contents">
          <AppDialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="beauty3-name">{t('beauty3Appointments.name')} *</Label>
                <Input id="beauty3-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="beauty3-age">{t('beauty3Appointments.age')} *</Label>
                <Input
                  id="beauty3-age"
                  value={ageText}
                  onChange={(event) => setAgeText(sanitizeNumericInput(event.target.value, { allowDecimal: false }))}
                  placeholder={t('beauty3Appointments.zeroPlaceholder')}
                  inputMode="numeric"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="beauty3-marital-status">{t('beauty3Appointments.maritalStatus')} *</Label>
                <Select value={maritalStatus} onValueChange={(value) => setMaritalStatus(value as Beauty3Appointment['maritalStatus'])}>
                  <SelectTrigger id="beauty3-marital-status">
                    <SelectValue placeholder={t('beauty3Appointments.selectMaritalStatus')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">{t('beauty3Appointments.single')}</SelectItem>
                    <SelectItem value="married">{t('beauty3Appointments.married')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="beauty3-phone">{t('beauty3Appointments.phoneNumber')} *</Label>
                <Input
                  id="beauty3-phone"
                  type="tel"
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  autoComplete="tel"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="beauty3-address">{t('beauty3Appointments.address')} *</Label>
                <Input
                  id="beauty3-address"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  autoComplete="street-address"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="beauty3-procedure-type">{t('beauty3Appointments.procedureType')} *</Label>
                <Select value={procedureType} onValueChange={setProcedureType}>
                  <SelectTrigger id="beauty3-procedure-type">
                    <SelectValue placeholder={t('beauty3Appointments.procedureTypeEmpty')} />
                  </SelectTrigger>
                  <SelectContent>
                    {procedureType
                      && !isProcedureTypeBuiltin
                      && (procedureTypeUnavailable || customProcedurePresets === undefined) ? (
                        <SelectItem value={procedureType} disabled>
                          {procedureTypeUnavailable
                            ? t('beauty3Appointments.procedureTypeUnavailable', { value: procedureType })
                            : procedureType}
                        </SelectItem>
                      ) : null}
                    {BEAUTY3_BUILT_IN_PROCEDURES
                      .filter((procedure) => procedure.value !== BEAUTY3_OTHER_PROCEDURE_TYPE)
                      .map((procedure) => (
                        <SelectItem key={procedure.value} value={procedure.value}>
                          {t(procedure.translationKey)}
                        </SelectItem>
                      ))}
                    {customProcedures.map((procedure) => (
                      <SelectItem key={procedure.id} value={procedure.name}>
                        {procedure.name}
                      </SelectItem>
                    ))}
                    <SelectItem value={BEAUTY3_OTHER_PROCEDURE_TYPE}>
                      {t('beauty3Appointments.procedureTypes.other')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  onClick={onManageProcedures}
                  disabled={isSaving}
                >
                  <Plus className="me-1 size-3.5" />
                  {t('beauty3Appointments.addProcedure')}
                </Button>
              </div>
              {procedureType === BEAUTY3_OTHER_PROCEDURE_TYPE ? (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="beauty3-procedure-type-other">
                    {t('beauty3Appointments.otherProcedureDetails')} *
                  </Label>
                  <Input
                    id="beauty3-procedure-type-other"
                    value={procedureTypeOtherText}
                    onChange={(event) => setProcedureTypeOtherText(event.target.value)}
                    placeholder={t('beauty3Appointments.otherProcedurePlaceholder')}
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="beauty3-procedure-place">{t('beauty3Appointments.procedurePlace')} *</Label>
                <Select value={procedurePlace} onValueChange={(value) => setProcedurePlace(value as Beauty3Appointment['procedurePlace'])}>
                  <SelectTrigger id="beauty3-procedure-place">
                    <SelectValue placeholder={t('beauty3Appointments.selectProcedurePlace')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sulaymaniyah">{t('commerceOperations.cities.sulaymaniyah')}</SelectItem>
                    <SelectItem value="erbil">{t('commerceOperations.cities.erbil')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="beauty3-procedure-date">{t('beauty3Appointments.procedureDate')} *</Label>
                <DateTimePicker
                  id="beauty3-procedure-date"
                  mode="date"
                  date={procedureDate}
                  setDate={setProcedureDate}
                  placeholder={t('beauty3Appointments.datePlaceholder')}
                  buttonClassName="w-full justify-start"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="beauty3-appointment-total">{t('beauty3Appointments.appointmentTotal')} *</Label>
                <Input
                  id="beauty3-appointment-total"
                  value={appointmentTotalText}
                  onChange={(event) => {
                    const sanitized = sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 2 })
                    setAppointmentTotalText(formatNumericInput(sanitized))
                  }}
                  placeholder={t('beauty3Appointments.zeroPlaceholder')}
                  inputMode="decimal"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="beauty3-total-profit">{t('beauty3Appointments.totalProfit')} *</Label>
                <Input
                  id="beauty3-total-profit"
                  value={totalProfitText}
                  onChange={(event) => {
                    const sanitized = sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 2 })
                    setTotalProfitText(formatNumericInput(sanitized))
                  }}
                  placeholder={t('beauty3Appointments.zeroPlaceholder')}
                  inputMode="decimal"
                />
              </div>
            </div>
          </AppDialogBody>
          <AppDialogFooter className="!flex-col-reverse !items-stretch lg:!flex-row lg:!items-start">
            <Button type="button" className="w-full lg:w-auto" variant="outline" disabled={isSaving} onClick={() => handleOpenChange(false)}>
              {t('beauty3Appointments.cancel')}
            </Button>
            <Button type="submit" className="h-auto min-h-10 w-full whitespace-normal py-2 text-center leading-tight lg:w-auto" name="saveAction" value="save" variant={appointment ? 'default' : 'outline'} disabled={!isValid || isSaving}>
              {isSaving && !isSavingAndRecording ? <Loader2 className="me-2 size-4 animate-spin" /> : <Save className="me-2 size-4" />}
              {isSaving && !isSavingAndRecording ? t('beauty3Appointments.saving') : t('beauty3Appointments.save')}
            </Button>
            {!appointment ? (
              <div className="flex w-full flex-col items-stretch gap-1 lg:w-auto">
                <Button type="submit" className="h-auto min-h-10 w-full whitespace-normal py-2 text-center leading-tight lg:w-auto" name="saveAction" value="save-and-record-payment" disabled={!isValid || isSaving || !(parsedProfit > 0)}>
                  {isSavingAndRecording ? <Loader2 className="me-2 size-4 animate-spin" /> : <CircleDollarSign className="me-2 size-4" />}
                  {isSavingAndRecording ? t('beauty3Appointments.saving') : t('beauty3Appointments.saveAndRecordPayment')}
                </Button>
                {parsedProfit > 0 ? (
                  <span className="text-xs text-muted-foreground">{t('beauty3Appointments.immediatePaymentDetails')}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('beauty3Appointments.paymentRequiresPositiveProfit')}</span>
                )}
              </div>
            ) : null}
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </AppDialog>
  )
}
