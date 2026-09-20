import { useState, useMemo, useCallback, useEffect, useRef, Fragment } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '@/auth'
import { db } from '@/local-db/database'
import { createClinicalAppointment, createClinicalPatient, searchClinicalPatients, useClinicalAppointments, useClinicalAppointment, updateClinicalAppointment, deleteClinicalAppointment, calculateAge } from '@/local-db/clinicalAppointments'
import {
  buildClinicalAppointmentPaymentObligation,
  getClinicalAppointmentPaymentSummary,
  recordObligationSettlement,
  reverseBeauty2AppointmentPayment,
  syncBeauty2AppointmentPayment,
  usePaymentTransactions,
  type PaymentObligation,
  type CurrencyCode,
  type PaymentAccount,
  type WorkspacePaymentMethod,
} from '@/local-db'
import type { ClinicalAppointment, ClinicalAppointmentStatus, ClinicalAppointmentType, ClinicalAppointmentPriority, ClinicalConfirmationMethod } from '@/local-db/clinicalAppointments'
import { useClinicalPresetsByCategory, useClinicalRegistryType } from '@/local-db/clinicalPresets'
import { isBeautyClinicalRegistryType } from '@/local-db/clinicalRegistryPreset'
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, Label, Card, CardContent, CardHeader, CardTitle, DateTimePicker, SettlementDialog, useToast, DeleteConfirmationModal, Dialog, DialogContent } from '@/ui/components'
import { Plus, Search, Upload, Trash2, FileText, ArrowLeft, CalendarClock, Edit, Check, ChevronDown, LayoutGrid, List, HandCoins, UserPlus, Phone, X } from 'lucide-react'
import { generateId, formatCurrency, formatLocalDateValue, formatNumberWithCommas, formatTime, formatNumericInput, parseFormattedNumber, parseLocalDateValue, sanitizeNumericInput } from '@/lib/utils'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { DateRangeBadge } from '@/ui/components/DateRangeBadge'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { createBusinessPartner, useBusinessPartners, recalculateBusinessPartnerSummary } from '@/local-db'
import { useDateRange } from '@/context/DateRangeContext'
import { r2Service } from '@/services/r2Service'
import { platformService } from '@/services/platformService'
import { useLocation, useRoute } from 'wouter'
import { useWorkspace } from '@/workspace'
import { isDemoWorkspaceMode, isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { isImageUploadCandidate } from '@/lib/imageCompression'
import { mediaUploadService } from '@/services/mediaUploadService'
import { getMediaUploadErrorCode } from '@/services/mediaUploadService'

const CLINIC_ATTACHMENTS_PREFIX = 'clinic-attachments'

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}

const STATUS_COLORS: Record<string, { badge: string; dot: string }> = {
  draft: { badge: 'bg-slate-100 text-slate-700', dot: 'bg-slate-400' },
  booked: { badge: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
  arrived: { badge: 'bg-indigo-100 text-indigo-700', dot: 'bg-indigo-500' },
  in_progress: { badge: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' },
  completed: { badge: 'bg-emerald-100 text-emerald-700', dot: 'bg-green-500' },
  cancelled: { badge: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  no_show: { badge: 'bg-rose-100 text-rose-700', dot: 'bg-rose-500' },
}

const STATUS_GROUPS = [
  ['draft', 'booked', 'arrived', 'in_progress', 'completed'],
  ['cancelled', 'no_show'],
]

const PAYMENT_STATUS_CLASSES = {
  no_fee: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  unpaid: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  paid: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
} as const

type ClinicalPaymentStatus = keyof typeof PAYMENT_STATUS_CLASSES

function PaymentStatusBadge({ status }: { status: ClinicalPaymentStatus }) {
  const { t } = useTranslation()
  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${PAYMENT_STATUS_CLASSES[status]}`}>
      {t(`clinicalAppointments.paymentStatuses.${status}`, {
        defaultValue: status === 'no_fee'
          ? 'No Fee'
          : status.charAt(0).toUpperCase() + status.slice(1),
      })}
    </span>
  )
}

function StatusCell({ status, appointmentId, onStatusChange, disabled }: {
  status: string
  appointmentId: string
  onStatusChange: (id: string, newStatus: string) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        ref.current && !ref.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onScroll = () => setOpen(false)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [open])

  const currentColors = STATUS_COLORS[status] ?? STATUS_COLORS.draft
  const currentLabel = t('clinicalAppointments.statuses.' + status, {
    defaultValue: status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  })

  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect()
      const menuWidth = 220
      const estimatedMenuHeight = 320
      const padding = 8
      const maxLeft = window.innerWidth - menuWidth - padding
      const left = Math.max(padding, Math.min(rect.left, maxLeft))
      const topDown = rect.bottom + 4
      const topUp = rect.top - estimatedMenuHeight - 4
      const top = topDown + estimatedMenuHeight > window.innerHeight ? topUp : topDown
      setPos({ top, left })
    }
    setOpen(!open)
  }

  const menu = (
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 100 }}
      className="min-w-[220px] bg-white border border-slate-200 rounded-xl shadow-lg py-1.5"
    >
      {STATUS_GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <div className="mx-2 my-1 border-t border-slate-100" />}
          {group.map((s) => {
            const c = STATUS_COLORS[s] ?? STATUS_COLORS.draft
            const label = t('clinicalAppointments.statuses.' + s, {
              defaultValue: s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
            })
            const desc = t('clinicalAppointments.statusDescriptions.' + s, { defaultValue: '' })
            const selected = s === status
            return (
              <button
                key={s}
                type="button"
                onClick={() => { onStatusChange(appointmentId, s); setOpen(false) }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-slate-50 transition-colors"
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.dot}`} />
                <span className="font-medium text-slate-900">{label}</span>
                <span className="text-xs text-slate-400 flex-1 truncate">{desc}</span>
                {selected && <Check size={14} className="text-slate-500 flex-shrink-0 ml-auto" />}
              </button>
            )
          })}
        </Fragment>
      ))}
    </div>
  )

  return (
    <div className="inline-block" ref={ref}>
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-xs font-semibold border-0 cursor-pointer whitespace-nowrap transition-opacity disabled:opacity-50 ${currentColors.badge}`}
      >
        {currentLabel}
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && createPortal(menu, document.body)}
    </div>
  )
}

function NextVisitDateFilter({
  value,
  onValueChange,
}: {
  value: string
  onValueChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const label = t('clinicalAppointmentDateFilters.nextVisitDate', { defaultValue: 'Next visit date' })

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200/70 bg-emerald-50/50 p-2 shadow-sm dark:border-emerald-900/50 dark:bg-emerald-950/20">
      <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
        <CalendarClock className="h-4 w-4" />
        <span>{label}</span>
      </div>

      <div className="w-44">
        <DateTimePicker
          mode="date"
          date={parseLocalDateValue(value)}
          setDate={(date) => onValueChange(date ? formatLocalDateValue(date) : '')}
          buttonClassName="h-8 rounded-lg bg-background/80 text-xs"
          placeholder={label}
        />
      </div>

      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          allowViewer={true}
          onClick={() => onValueChange('')}
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          aria-label={t('clinicalAppointmentDateFilters.clearNextVisit', { defaultValue: 'Clear next visit filter' })}
          title={t('clinicalAppointmentDateFilters.clearNextVisit', { defaultValue: 'Clear next visit filter' })}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

export function ClinicalAppointments() {
  const { user } = useAuth()
  const [, navigate] = useLocation()
  const [createMatch] = useRoute('/clinical-appointments/new')
  const [editMatch, editParams] = useRoute('/clinical-appointments/:id/edit')
  const workspaceId = user?.workspaceId ?? ''
  const editAppointment = useClinicalAppointment(editMatch ? editParams?.id : undefined)
  const registryType = useClinicalRegistryType(workspaceId || undefined)
  const isBeauty2 = registryType === 'beauty2'

  if (!workspaceId) return null

  if (createMatch) {
    const AppointmentForm = isBeauty2 ? Beauty2AppointmentForm : CreateAppointmentForm
    return (
      <AppointmentForm
        workspaceId={workspaceId}
        onCancel={() => navigate('/clinical-appointments')}
        onSaved={() => navigate('/clinical-appointments')}
      />
    )
  }

  if (editMatch && editAppointment) {
    const AppointmentForm = isBeauty2 ? Beauty2AppointmentForm : CreateAppointmentForm
    return (
      <AppointmentForm
        workspaceId={workspaceId}
        appointment={editAppointment}
        onCancel={() => navigate('/clinical-appointments')}
        onSaved={() => navigate('/clinical-appointments')}
      />
    )
  }

  if (editMatch && !editAppointment) return null

  return isBeauty2
    ? <Beauty2AppointmentList workspaceId={workspaceId} navigate={navigate} />
    : <AppointmentList workspaceId={workspaceId} navigate={navigate} />
}

function Beauty2AppointmentList({ workspaceId, navigate }: { workspaceId: string; navigate: (path: string) => void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { features } = useWorkspace()
  const { toast } = useToast()
  const { dateRange, customDates } = useDateRange()
  const appointments = useClinicalAppointments(workspaceId)
  const [searchQuery, setSearchQuery] = useState('')
  const [nextVisitDateFilter, setNextVisitDateFilter] = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const filtered = useMemo(() => {
    const now = new Date()
    const todayValue = formatLocalDateValue(now)
    const query = searchQuery.trim().toLowerCase()
    return (appointments || []).filter((appointment) => {
      const issueDate = appointment.issueDate || appointment.appointmentDate
      if (query && ![
        appointment.appointmentNumber,
        appointment.receivedFromName,
        appointment.patientName,
        appointment.patientPhone,
        appointment.internalNotes,
      ].some((value) => value?.toLowerCase().includes(query))) {
        return false
      }
      if (dateRange === 'today') {
        return issueDate === todayValue
      }
      if (dateRange === 'month') {
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
        return issueDate >= monthStart
      }
      if (dateRange === 'lastMonth') {
        const startOfLastMonth = formatLocalDateValue(new Date(now.getFullYear(), now.getMonth() - 1, 1))
        const startOfMonth = formatLocalDateValue(new Date(now.getFullYear(), now.getMonth(), 1))
        return issueDate >= startOfLastMonth && issueDate < startOfMonth
      }
      if (dateRange === 'custom') {
        if (customDates.start && issueDate < customDates.start) return false
        if (customDates.end && issueDate > customDates.end) return false
      }
      if (nextVisitDateFilter && appointment.nextVisitDate !== nextVisitDateFilter) {
        return false
      }
      return true
    })
  }, [
    appointments,
    customDates.end,
    customDates.start,
    dateRange,
    nextVisitDateFilter,
    searchQuery,
  ])

  const handleDelete = useCallback(async () => {
    if (!deleteConfirmId) return
    setIsDeleting(true)
    try {
      const appointment = appointments?.find((item) => item.id === deleteConfirmId)
      if (appointment) {
        await reverseBeauty2AppointmentPayment(workspaceId, appointment, user?.id || null)
      }
      await deleteClinicalAppointment(deleteConfirmId, workspaceId)
      toast({ title: t('clinicalAppointments.messages.deleted', { defaultValue: 'Appointment deleted' }) })
    } catch (error) {
      console.error('[ClinicalAppointments] Failed to delete beauty2 appointment:', error)
      toast({
        variant: 'destructive',
        title: t('clinicalAppointments.messages.deleteFailed', { defaultValue: 'Failed to delete appointment' }),
      })
    } finally {
      setIsDeleting(false)
      setDeleteConfirmId(null)
    }
  }, [appointments, deleteConfirmId, t, toast, user?.id, workspaceId])

  const renderActions = (appointment: ClinicalAppointment) => (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon" onClick={() => navigate(`/clinical-appointments/${appointment.id}/edit`)}>
        <Edit className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" onClick={() => setDeleteConfirmId(appointment.id)}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {t('clinicalAppointments.title', { defaultValue: 'Beauty Center Appointments' })}
            <DateRangeBadge />
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('clinicalAppointments.subtitle', { defaultValue: 'Manage Beauty Center appointment records.' })} <ModulePageFreshness className="ms-2" />
          </p>
        </div>
        <Button onClick={() => navigate('/clinical-appointments/new')}>
          <Plus className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">{t('clinicalAppointments.createButton', { defaultValue: 'Create Appointment' })}</span>
        </Button>
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('clinicalAppointments.searchPlaceholder', { defaultValue: 'Search appointments...' })}
              className="pl-10"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('clinicalAppointmentDateFilters.issueDate', { defaultValue: 'Issue date' })}
            </span>
            <DateRangeFilters />
          </div>
        </div>
        <NextVisitDateFilter
          value={nextVisitDateFilter}
          onValueChange={setNextVisitDateFilter}
        />
      </div>

      <div className="grid gap-4 md:hidden">
        {filtered.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            {t('clinicalAppointments.noAppointments', { defaultValue: 'No appointments found' })}
          </div>
        ) : filtered.map((appointment) => (
          <div key={appointment.id} className="space-y-3 rounded-2xl border bg-background p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">{appointment.receivedFromName || appointment.patientName}</p>
                <p className="text-xs text-muted-foreground">{appointment.appointmentNumber || '—'}</p>
              </div>
              {renderActions(appointment)}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-muted-foreground">{t('clinicalAppointments.amountIqd', { defaultValue: 'Amount in IQD' })}</span><p className="font-medium">{formatCurrency(appointment.amountIqd || 0, 'iqd', features.iqd_display_preference)}</p></div>
              <div><span className="text-muted-foreground">{t('clinicalAppointments.amountUsd', { defaultValue: 'Amount in USD' })}</span><p className="font-medium">{formatCurrency(appointment.amountUsd || 0, 'usd', features.iqd_display_preference)}</p></div>
              <div><span className="text-muted-foreground">{t('clinicalAppointments.calculatedAmount', { defaultValue: 'Amount (Real Calculation)' })}</span><p className="font-medium">{formatCurrency(appointment.calculatedAmount || 0, appointment.calculatedAmountCurrency || 'iqd', features.iqd_display_preference)}</p></div>
              <div><span className="text-muted-foreground">{t('clinicalAppointments.phoneNumber', { defaultValue: 'Phone Number' })}</span><p className="font-medium">{appointment.patientPhone || '—'}</p></div>
              <div><span className="text-muted-foreground">{t('clinicalAppointments.issueDate', { defaultValue: 'Issue Date' })}</span><p className="font-medium">{appointment.issueDate || appointment.appointmentDate}</p></div>
              <div><span className="text-muted-foreground">{t('clinicalAppointments.nextVisitDate', { defaultValue: 'Next Visit Date' })}</span><p className="font-medium">{appointment.nextVisitDate || '—'}</p></div>
            </div>
            <div className="text-sm"><span className="text-muted-foreground">{t('clinicalAppointments.note', { defaultValue: 'Note' })}: </span>{appointment.internalNotes || '—'}</div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('clinicalAppointments.appointmentNumber', { defaultValue: 'Appointment Number' })}</TableHead>
              <TableHead>{t('clinicalAppointments.issueDate', { defaultValue: 'Issue Date' })}</TableHead>
              <TableHead>{t('clinicalAppointments.receivedFrom', { defaultValue: 'Received From' })}</TableHead>
              <TableHead>{t('clinicalAppointments.amountIqd', { defaultValue: 'Amount in IQD' })}</TableHead>
              <TableHead>{t('clinicalAppointments.amountUsd', { defaultValue: 'Amount in USD' })}</TableHead>
              <TableHead>{t('clinicalAppointments.calculatedAmount', { defaultValue: 'Amount (Real Calculation)' })}</TableHead>
              <TableHead>{t('clinicalAppointments.phoneNumber', { defaultValue: 'Phone Number' })}</TableHead>
              <TableHead>{t('clinicalAppointments.note', { defaultValue: 'Note' })}</TableHead>
              <TableHead>{t('clinicalAppointments.nextVisitDate', { defaultValue: 'Next Visit Date' })}</TableHead>
              <TableHead>{t('clinicalAppointments.actions', { defaultValue: 'Actions' })}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow><TableCell colSpan={10} className="py-12 text-center text-muted-foreground">{t('clinicalAppointments.noAppointments', { defaultValue: 'No appointments found' })}</TableCell></TableRow>
            ) : filtered.map((appointment) => (
              <TableRow key={appointment.id}>
                <TableCell className="font-medium">{appointment.appointmentNumber || '—'}</TableCell>
                <TableCell>{appointment.issueDate || appointment.appointmentDate}</TableCell>
                <TableCell>{appointment.receivedFromName || appointment.patientName}</TableCell>
                <TableCell className="whitespace-nowrap">{formatCurrency(appointment.amountIqd || 0, 'iqd', features.iqd_display_preference)}</TableCell>
                <TableCell className="whitespace-nowrap">{formatCurrency(appointment.amountUsd || 0, 'usd', features.iqd_display_preference)}</TableCell>
                <TableCell className="whitespace-nowrap">{formatCurrency(appointment.calculatedAmount || 0, appointment.calculatedAmountCurrency || 'iqd', features.iqd_display_preference)}</TableCell>
                <TableCell>{appointment.patientPhone || '—'}</TableCell>
                <TableCell className="max-w-56 truncate" title={appointment.internalNotes || undefined}>{appointment.internalNotes || '—'}</TableCell>
                <TableCell>{appointment.nextVisitDate || '—'}</TableCell>
                <TableCell>{renderActions(appointment)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <DeleteConfirmationModal
        isOpen={!!deleteConfirmId}
        onClose={() => setDeleteConfirmId(null)}
        onConfirm={handleDelete}
        isLoading={isDeleting}
        itemName={deleteConfirmId
          ? appointments?.find((appointment) => appointment.id === deleteConfirmId)?.appointmentNumber || ''
          : ''}
      />
    </div>
  )
}

function Beauty2AppointmentForm({ workspaceId, appointment, onCancel, onSaved }: { workspaceId: string; appointment?: ClinicalAppointment; onCancel: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { toast } = useToast()
  const [amountIqd, setAmountIqd] = useState(appointment?.amountIqd ? String(appointment.amountIqd) : '')
  const [amountUsd, setAmountUsd] = useState(appointment?.amountUsd ? String(appointment.amountUsd) : '')
  const [receivedFromName, setReceivedFromName] = useState(appointment?.receivedFromName || appointment?.patientName || '')
  const [calculatedAmount, setCalculatedAmount] = useState(appointment?.calculatedAmount ? String(appointment.calculatedAmount) : '')
  const [calculatedAmountCurrency, setCalculatedAmountCurrency] = useState<'iqd' | 'usd'>(
    appointment?.calculatedAmountCurrency === 'usd' ? 'usd' : 'iqd',
  )
  const [phoneNumber, setPhoneNumber] = useState(appointment?.patientPhone || '')
  const [note, setNote] = useState(appointment?.internalNotes || '')
  const [appointmentNumber, setAppointmentNumber] = useState(appointment?.appointmentNumber || '')
  const [issueDate, setIssueDate] = useState(appointment?.issueDate || appointment?.appointmentDate || '')
  const [nextVisitDate, setNextVisitDate] = useState(appointment?.nextVisitDate || '')
  const [sentByName, setSentByName] = useState(appointment?.sentByName || '')
  const [sentByPartnerId, setSentByPartnerId] = useState<string | null>(appointment?.sentByPartnerId || null)
  const [showSavePartner, setShowSavePartner] = useState(false)
  const [savePartnerPhone, setSavePartnerPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
  const [hasPaymentAccountSelection, setHasPaymentAccountSelection] = useState(false)
  const supplierPartners = useBusinessPartners(workspaceId, { roles: ['supplier'] })
  const sentByPartner = useMemo(() => supplierPartners.find(p => p.id === sentByPartnerId), [supplierPartners, sentByPartnerId])

  const handleSubmit = async () => {
    if (!appointmentNumber.trim() || !receivedFromName.trim() || !issueDate) return
    setSaving(true)
    try {
      const beauty2Fields = {
        appointmentNumber: appointmentNumber.trim(),
        issueDate,
        nextVisitDate: nextVisitDate || null,
        receivedFromName: receivedFromName.trim(),
        amountIqd: parseFormattedNumber(amountIqd || '0'),
        amountUsd: parseFormattedNumber(amountUsd || '0'),
        calculatedAmount: parseFormattedNumber(calculatedAmount || '0'),
        calculatedAmountCurrency,
        patientName: receivedFromName.trim(),
        patientPhone: phoneNumber.trim() || null,
        appointmentDate: issueDate,
        consultationFee: parseFormattedNumber(calculatedAmount || '0'),
        currency: calculatedAmountCurrency,
        internalNotes: note.trim() || null,
        sentByName: sentByName.trim() || null,
        sentByPartnerId: sentByPartnerId || null,
      }

      let savedAppointment: ClinicalAppointment | null
      if (appointment) {
        savedAppointment = await updateClinicalAppointment(appointment.id, beauty2Fields, workspaceId)
      } else {
        savedAppointment = await createClinicalAppointment({
          ...beauty2Fields,
          patientId: generateId(),
          isNewPatient: true,
          startTime: '00:00',
          appointmentType: 'consultation',
          reasonForVisit: null,
          serviceProcedure: null,
          estimatedPrice: 0,
          status: 'draft',
          confirmationMethod: null,
          priority: 'normal',
          createdBy: user?.id || null,
        }, workspaceId)
      }
      if (!savedAppointment) throw new Error('Appointment could not be saved')
      await syncBeauty2AppointmentPayment(workspaceId, savedAppointment, user?.id || null, hasPaymentAccountSelection
        ? { accountId: paymentAccount?.id ?? null, accountNameSnapshot: paymentAccount?.name ?? null }
        : {})
      const typedCustomName = sentByName.trim() && !sentByPartnerId
      if (typedCustomName) {
        setSavePartnerPhone(phoneNumber)
        setShowSavePartner(true)
      } else {
        onSaved()
      }
    } catch (error) {
      console.error('[ClinicalAppointments] Failed to save beauty2 appointment:', error)
      toast({
        variant: 'destructive',
        title: t('clinicalAppointments.messages.saveFailed', { defaultValue: 'Failed to save appointment' }),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-background p-4 lg:p-6">
      <form onSubmit={(event) => { event.preventDefault(); void handleSubmit() }} className="mx-auto max-w-2xl space-y-4">
        <Button type="button" variant="ghost" className="h-auto gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={onCancel}>
          <ArrowLeft className="h-4 w-4" />
          {t('clinicalAppointments.title', { defaultValue: 'Beauty Center Appointments' })}
        </Button>
        <h1 className="text-3xl font-bold tracking-tight">
          {appointment
            ? t('clinicalAppointments.editTitle', { defaultValue: 'Edit Appointment' })
            : t('clinicalAppointments.createTitle', { defaultValue: 'Create Appointment' })}
        </h1>

        <div className="grid gap-2">
          <Label htmlFor="beauty2-amount-iqd">{t('clinicalAppointments.amountIqd', { defaultValue: 'Amount in IQD' })}</Label>
          <Input id="beauty2-amount-iqd" inputMode="numeric" value={formatNumericInput(amountIqd)} onChange={(event) => setAmountIqd(sanitizeNumericInput(event.target.value, { allowDecimal: false }))} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="beauty2-amount-usd">{t('clinicalAppointments.amountUsd', { defaultValue: 'Amount in USD' })}</Label>
          <Input id="beauty2-amount-usd" inputMode="decimal" value={formatNumericInput(amountUsd)} onChange={(event) => setAmountUsd(sanitizeNumericInput(event.target.value, { allowDecimal: true }))} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="beauty2-received-from">{t('clinicalAppointments.receivedFrom', { defaultValue: 'Received From (Name)' })}</Label>
          <Input id="beauty2-received-from" value={receivedFromName} onChange={(event) => setReceivedFromName(event.target.value)} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="beauty2-calculated-amount">{t('clinicalAppointments.calculatedAmount', { defaultValue: 'Amount (Real Calculation)' })}</Label>
          <div className="flex gap-2">
            <Input className="flex-1" id="beauty2-calculated-amount" inputMode={calculatedAmountCurrency === 'iqd' ? 'numeric' : 'decimal'} value={formatNumericInput(calculatedAmount)} onChange={(event) => setCalculatedAmount(sanitizeNumericInput(event.target.value, { allowDecimal: calculatedAmountCurrency !== 'iqd' }))} />
            <Select value={calculatedAmountCurrency} onValueChange={(value: 'iqd' | 'usd') => setCalculatedAmountCurrency(value)}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="iqd">IQD</SelectItem>
                <SelectItem value="usd">USD</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {parseFormattedNumber(calculatedAmount || '0') > 0 ? (
          <PaymentAccountSelector
            workspaceId={workspaceId}
            value={paymentAccount?.id ?? null}
            onValueChange={(account) => {
              setPaymentAccount(account)
              setHasPaymentAccountSelection(true)
            }}
            disabled={saving}
          />
        ) : null}
        <div className="grid gap-2">
          <Label htmlFor="beauty2-phone">{t('clinicalAppointments.phoneNumber', { defaultValue: 'Phone Number' })}</Label>
          <Input id="beauty2-phone" type="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="beauty2-note">{t('clinicalAppointments.note', { defaultValue: 'Note' })}</Label>
          <Textarea id="beauty2-note" value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="beauty2-appointment-number">{t('clinicalAppointments.appointmentNumber', { defaultValue: 'Appointment Number' })}</Label>
          <Input id="beauty2-appointment-number" value={appointmentNumber} onChange={(event) => setAppointmentNumber(event.target.value)} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="beauty2-sent-by" isLoading={supplierPartners.isLoading}>{t('clinicalAppointments.sentBy', { defaultValue: 'Sent by' })}</Label>
          <PartnerAutocompleteInput
            workspaceId={workspaceId}
            value={sentByName}
            onChange={(value) => { setSentByName(value); if (value !== sentByName) setSentByPartnerId(null) }}
            onSelectPartner={(partner) => { setSentByName(partner.partnerName); setSentByPartnerId(partner.id) }}
            roles={['supplier']}
            isLoading={supplierPartners.isLoading}
            placeholder={t('clinicalAppointments.sentByPlaceholder', { defaultValue: 'Search supplier or type a name...' })}
          />
          {sentByPartner ? (
            <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                  {t('businessPartners.linked', { defaultValue: 'Linked' })}
                </div>
                <div className="truncate text-sm font-semibold">{sentByPartner.partnerName}</div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 px-2 text-muted-foreground"
                onClick={() => { setSentByPartnerId(null); setSentByName('') }}
              >
                {t('common.remove', { defaultValue: 'Remove' })}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="beauty2-issue-date">{t('clinicalAppointments.issueDate', { defaultValue: 'Issue Date' })}</Label>
          <DateTimePicker
            id="beauty2-issue-date"
            mode="date"
            date={parseLocalDateValue(issueDate)}
            setDate={(value) => setIssueDate(value ? formatLocalDateValue(value) : '')}
            placeholder={t('clinicalAppointments.issueDate', { defaultValue: 'Issue Date' })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="beauty2-next-visit-date">{t('clinicalAppointments.nextVisitDate', { defaultValue: 'Next Visit Date' })}</Label>
          <DateTimePicker
            id="beauty2-next-visit-date"
            mode="date"
            date={parseLocalDateValue(nextVisitDate)}
            setDate={(value) => setNextVisitDate(value ? formatLocalDateValue(value) : '')}
            placeholder={t('clinicalAppointments.nextVisitDate', { defaultValue: 'Next Visit Date' })}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button type="submit" disabled={saving || !appointmentNumber.trim() || !receivedFromName.trim() || !issueDate}>
            {saving ? t('common.saving', { defaultValue: 'Saving...' }) : t('common.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      </form>

      <Dialog open={showSavePartner} onOpenChange={() => { }}>
        <DialogContent
          className="sm:max-w-md overflow-hidden [&>button:last-child]:hidden"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex flex-col items-center gap-3 pb-1 pt-2 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-4 ring-primary/5">
              <UserPlus className="h-7 w-7" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-lg font-semibold leading-tight">
                {t('clinicalAppointments.saveAsPartnerTitle', { defaultValue: 'Save as Business Partner?' })}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('clinicalAppointments.saveAsPartnerDescription', {
                  name: sentByName,
                  defaultValue: '{{name}} is not linked to a business partner. Would you like to save them as a supplier for future use?'
                })}
              </p>
            </div>
          </div>

          <div className="rounded-xl border bg-muted/30 px-4 py-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/70">
              {t('clinicalAppointments.partnerDetails', { defaultValue: 'Partner Details' })}
            </div>
            <div className="mt-2 space-y-1.5">
              <div className="text-[15px] font-semibold leading-tight">{sentByName}</div>
              {savePartnerPhone && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Phone className="h-3.5 w-3.5 shrink-0" />
                  <span>{savePartnerPhone}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 pt-1">
            <Button
              type="button"
              className="w-full gap-2"
              onClick={async () => {
                try {
                  const partner = await createBusinessPartner(workspaceId, {
                    partnerName: sentByName,
                    phone: savePartnerPhone || undefined,
                    role: 'supplier',
                    creditLimit: 0,
                    defaultCurrency: 'iqd',
                  })
                  await recalculateBusinessPartnerSummary(workspaceId, partner.id)
                } catch (e) {
                  console.error('[ClinicalAppointments] Failed to save partner:', e)
                }
                setShowSavePartner(false)
                onSaved()
              }}
            >
              <UserPlus className="h-4 w-4" />
              {t('clinicalAppointments.saveAsPartner', { defaultValue: 'Save as Partner' })}
            </Button>
            <button
              type="button"
              className="mx-auto py-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => { setShowSavePartner(false); onSaved() }}
            >
              {t('common.skip', { defaultValue: 'Skip' })}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AppointmentList({ workspaceId, navigate }: { workspaceId: string; navigate: (path: string) => void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { features } = useWorkspace()
  const { toast } = useToast()
  const appointments = useClinicalAppointments(workspaceId)
  const paymentTransactions = usePaymentTransactions(workspaceId, {
    sourceModule: 'clinical_appointments',
    sourceType: 'clinical_appointment',
    includeReversals: true,
  }, { hydrateSourceTables: false })
  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
    return (localStorage.getItem('clinical_appointments_view_mode') as 'table' | 'grid') || 'table'
  })
  useEffect(() => { localStorage.setItem('clinical_appointments_view_mode', viewMode) }, [viewMode])
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [paymentObligation, setPaymentObligation] = useState<PaymentObligation | null>(null)
  const [isCollectingPayment, setIsCollectingPayment] = useState(false)
  const { dateRange, customDates } = useDateRange()

  const handleStatusChange = useCallback(async (id: string, newStatus: string) => {
    setUpdatingId(id)
    try {
      await updateClinicalAppointment(id, { status: newStatus as any }, workspaceId)
    } catch (e) {
      console.error('[ClinicalAppointments] Failed to update status:', e)
    } finally {
      setUpdatingId(null)
    }
  }, [workspaceId])

  const handleDelete = useCallback(async () => {
    if (!deleteConfirmId) return
    setIsDeleting(true)
    try {
      await deleteClinicalAppointment(deleteConfirmId, workspaceId)
      toast({ title: t('clinicalAppointments.messages.deleted', { defaultValue: 'Appointment deleted' }) })
    } catch (e) {
      console.error('[ClinicalAppointments] Failed to delete appointment:', e)
      toast({ variant: 'destructive', title: t('clinicalAppointments.messages.deleteFailed', { defaultValue: 'Failed to delete appointment' }) })
    } finally {
      setIsDeleting(false)
      setDeleteConfirmId(null)
    }
  }, [deleteConfirmId, workspaceId, toast, t])

  const filtered = useMemo(() => {
    if (!appointments) return []
    let result = appointments
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((a) =>
        a.patientName.toLowerCase().includes(q) ||
        (a.patientPhone && a.patientPhone.includes(q)) ||
        a.appointmentType.toLowerCase().includes(q)
      )
    }
    const now = new Date()
    if (dateRange === 'today') {
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      result = result.filter((a) => a.appointmentDate === todayStr)
    } else if (dateRange === 'month') {
      const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
      result = result.filter((a) => a.appointmentDate >= startOfMonth)
    } else if (dateRange === 'lastMonth') {
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      result = result.filter((a) => {
        const appointmentDate = new Date(`${a.appointmentDate}T00:00:00`)
        return appointmentDate >= startOfLastMonth && appointmentDate < startOfMonth
      })
    } else if (dateRange === 'custom' && (customDates.start || customDates.end)) {
      result = result.filter((a) => {
        if (customDates.start && a.appointmentDate < customDates.start) return false
        if (customDates.end && a.appointmentDate > customDates.end) return false
        return true
      })
    }
    if (filter === 'today') {
      const d = new Date()
      const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      result = result.filter((a) => a.appointmentDate === todayStr)
    } else if (filter === 'upcoming') {
      const d = new Date()
      const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      result = result.filter((a) => a.appointmentDate > todayStr && !['completed', 'cancelled', 'no_show'].includes(a.status))
    } else if (filter !== 'all') {
      result = result.filter((a) => a.status === filter)
    }
    return result
  }, [appointments, searchQuery, filter, dateRange, customDates])

  const handleCollectPayment = (appointment: ClinicalAppointment) => {
    const obligation = buildClinicalAppointmentPaymentObligation(appointment, paymentTransactions, features.default_currency)
    if (obligation) {
      setPaymentObligation(obligation)
    }
  }

  const handlePaymentSubmit = async (input: {
    paymentMethod: WorkspacePaymentMethod
    paidAt: string
    amount?: number
    note?: string
    accountId?: string | null
    accountNameSnapshot?: string | null
  }) => {
    if (!paymentObligation) return

    setIsCollectingPayment(true)
    try {
      await recordObligationSettlement(workspaceId, paymentObligation, {
        ...input,
        createdBy: user?.id || null,
      })
      toast({
        title: t('clinicalAppointments.paymentCollected', { defaultValue: 'Payment collected successfully' }),
      })
      setPaymentObligation(null)
    } catch (error) {
      toast({
        title: t('common.error', { defaultValue: 'Error' }),
        description: error instanceof Error
          ? error.message
          : t('clinicalAppointments.paymentFailed', { defaultValue: 'Failed to collect payment' }),
        variant: 'destructive',
      })
    } finally {
      setIsCollectingPayment(false)
    }
  }

  const renderPaymentAction = (appointment: ClinicalAppointment) => {
    const summary = getClinicalAppointmentPaymentSummary(appointment, paymentTransactions)
    if (appointment.paymentStatus === 'paid'
      || (appointment.paymentStatus === 'partial' && summary.activeTransactions.length === 0)) {
      return null
    }
    if (!summary.canCollect) return null

    return (
      <Button type="button" variant="outline" size="sm" onClick={() => handleCollectPayment(appointment)}>
        <HandCoins className="mr-1.5 h-3.5 w-3.5" />
        {t('clinicalAppointments.collectPayment', { defaultValue: 'Collect Payment' })}
      </Button>
    )
  }

  const renderPaymentStatus = (appointment: ClinicalAppointment) => (
    <PaymentStatusBadge status={
      appointment.paymentStatus
      || getClinicalAppointmentPaymentSummary(appointment, paymentTransactions).paymentStatus
    } />
  )

  const getDisplayedPaidAmount = (appointment: ClinicalAppointment) => {
    const summary = getClinicalAppointmentPaymentSummary(appointment, paymentTransactions)
    return summary.activeTransactions.length > 0
      ? summary.paidAmount
      : appointment.paidAmount ?? summary.paidAmount
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {t('clinicalAppointments.title', { defaultValue: 'Clinical Appointments Registry' })}
            <DateRangeBadge />
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('clinicalAppointments.subtitle', { defaultValue: 'Manage patient appointments and scheduling' })}
          </p>
        </div>
        <Button onClick={() => navigate('/clinical-appointments/new')}>
          <Plus className="w-4 h-4 sm:mr-2" />
          <span className="hidden sm:inline">{t('clinicalAppointments.createButton', { defaultValue: 'Create Appointment' })}</span>
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={t('clinicalAppointments.searchPlaceholder', { defaultValue: 'Search appointments...' })}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      <DateRangeFilters />

      <div className="flex items-center gap-2 flex-wrap">
        {[
          { value: 'all', label: t('clinicalAppointments.filters.all', { defaultValue: 'All' }) },
          { value: 'draft', label: t('clinicalAppointments.statuses.draft', { defaultValue: 'Draft' }) },
          { value: 'booked', label: t('clinicalAppointments.statuses.booked', { defaultValue: 'Booked' }) },
          { value: 'today', label: t('clinicalAppointments.filters.today', { defaultValue: 'Today' }) },
          { value: 'upcoming', label: t('clinicalAppointments.filters.upcoming', { defaultValue: 'Upcoming' }) },
          { value: 'completed', label: t('clinicalAppointments.statuses.completed', { defaultValue: 'Completed' }) },
        ].map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => setFilter(chip.value)}
            className={`px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${filter === chip.value
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:bg-accent hover:text-accent-foreground'
              }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="hidden md:flex items-center gap-2">
        <div className="flex items-center bg-muted/30 p-1 rounded-lg border border-border/40">
          <Button
            size="sm"
            variant={viewMode === 'table' ? 'default' : 'ghost'}
            onClick={() => setViewMode('table')}
          >
            <List className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="sm"
            variant={viewMode === 'grid' ? 'default' : 'ghost'}
            onClick={() => setViewMode('grid')}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:hidden">
        {filtered.length === 0 ? (
          <div className="text-center text-muted-foreground py-12">
            {t('clinicalAppointments.noAppointments', { defaultValue: 'No appointments found' })}
          </div>
        ) : (
          filtered.map((appt) => (
            <div key={appt.id} className="p-4 border shadow-sm space-y-3 transition-all active:scale-[0.98] bg-background rounded-2xl border-border">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold truncate">{appt.patientName}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {appt.appointmentDate}{' '}
                    <span>{formatTime(`${appt.appointmentDate}T${appt.startTime}`)}</span>
                  </p>
                </div>
                <StatusCell
                  status={appt.status}
                  appointmentId={appt.id}
                  onStatusChange={handleStatusChange}
                  disabled={updatingId === appt.id}
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="capitalize text-muted-foreground">
                  {t('clinicalAppointments.types.' + appt.appointmentType, { defaultValue: appt.appointmentType.replace(/_/g, ' ') })}
                </span>
                <span className="capitalize text-xs font-medium text-muted-foreground">
                  {t('clinicalAppointments.priorities.' + appt.priority, { defaultValue: appt.priority })}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('clinicalAppointments.consultationFee', { defaultValue: 'Service Fee' })}</span>
                <span className="font-semibold">{formatCurrency(appt.consultationFee, appt.currency || features.default_currency, features.iqd_display_preference)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('clinicalAppointments.finalPayment', { defaultValue: 'Final Payment' })}</span>
                <span className="font-semibold">{formatCurrency(getDisplayedPaidAmount(appt), appt.currency || features.default_currency, features.iqd_display_preference)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('clinicalAppointments.currency', { defaultValue: 'Currency' })}</span>
                <span className="font-semibold uppercase">{appt.currency || features.default_currency}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t('clinicalAppointments.paymentStatus', { defaultValue: 'Payment Status' })}</span>
                {renderPaymentStatus(appt)}
              </div>
              <div className="flex items-center justify-end gap-2">
                {renderPaymentAction(appt)}
                <Button variant="ghost" size="sm" onClick={() => navigate(`/clinical-appointments/${appt.id}/edit`)}>
                  <Edit className="w-3.5 h-3.5 mr-1.5" />
                  {t('clinicalAppointments.actions', { defaultValue: 'Edit' })}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmId(appt.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="hidden md:block">
        {viewMode === 'grid' ? (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {filtered.length === 0 ? (
              <div className="col-span-full text-center text-muted-foreground py-12">
                {t('clinicalAppointments.noAppointments', { defaultValue: 'No appointments found' })}
              </div>
            ) : (
              filtered.map((appt) => (
                <div key={appt.id} className="p-4 border shadow-sm space-y-3 transition-all active:scale-[0.98] bg-background rounded-2xl border-border">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold truncate">{appt.patientName}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {appt.appointmentDate}{' '}
                        <span>{formatTime(`${appt.appointmentDate}T${appt.startTime}`)}</span>
                      </p>
                    </div>
                    <StatusCell
                      status={appt.status}
                      appointmentId={appt.id}
                      onStatusChange={handleStatusChange}
                      disabled={updatingId === appt.id}
                    />
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="capitalize text-muted-foreground">
                      {t('clinicalAppointments.types.' + appt.appointmentType, { defaultValue: appt.appointmentType.replace(/_/g, ' ') })}
                    </span>
                    <span className="capitalize text-xs font-medium text-muted-foreground">
                      {t('clinicalAppointments.priorities.' + appt.priority, { defaultValue: appt.priority })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('clinicalAppointments.consultationFee', { defaultValue: 'Service Fee' })}</span>
                    <span className="font-semibold">{formatCurrency(appt.consultationFee, appt.currency || features.default_currency, features.iqd_display_preference)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('clinicalAppointments.finalPayment', { defaultValue: 'Final Payment' })}</span>
                    <span className="font-semibold">{formatCurrency(getDisplayedPaidAmount(appt), appt.currency || features.default_currency, features.iqd_display_preference)}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('clinicalAppointments.currency', { defaultValue: 'Currency' })}</span>
                    <span className="font-semibold uppercase">{appt.currency || features.default_currency}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{t('clinicalAppointments.paymentStatus', { defaultValue: 'Payment Status' })}</span>
                    {renderPaymentStatus(appt)}
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    {renderPaymentAction(appt)}
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/clinical-appointments/${appt.id}/edit`)}>
                      <Edit className="w-3.5 h-3.5 mr-1.5" />
                      {t('clinicalAppointments.actions', { defaultValue: 'Edit' })}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmId(appt.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('clinicalAppointments.patient', { defaultValue: 'Patient' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.dateTime', { defaultValue: 'Date & Time' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.type', { defaultValue: 'Type' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.status', { defaultValue: 'Status' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.priority', { defaultValue: 'Priority' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.consultationFee', { defaultValue: 'Service Fee' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.finalPayment', { defaultValue: 'Final Payment' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.currency', { defaultValue: 'Currency' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.paymentStatus', { defaultValue: 'Payment Status' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.actions', { defaultValue: 'Actions' })}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-12">
                      {t('clinicalAppointments.noAppointments', { defaultValue: 'No appointments found' })}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((appt) => (
                    <TableRow key={appt.id}>
                      <TableCell className="font-medium">{appt.patientName}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {appt.appointmentDate}{' '}
                        <span className="text-muted-foreground">{formatTime(`${appt.appointmentDate}T${appt.startTime}`)}</span>
                      </TableCell>
                      <TableCell className="capitalize">{t('clinicalAppointments.types.' + appt.appointmentType, { defaultValue: appt.appointmentType.replace(/_/g, ' ') })}</TableCell>
                      <TableCell>
                        <StatusCell
                          status={appt.status}
                          appointmentId={appt.id}
                          onStatusChange={handleStatusChange}
                          disabled={updatingId === appt.id}
                        />
                      </TableCell>
                      <TableCell className="capitalize">{t('clinicalAppointments.priorities.' + appt.priority, { defaultValue: appt.priority })}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">
                        {formatCurrency(appt.consultationFee, appt.currency || features.default_currency, features.iqd_display_preference)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-medium">
                        {formatCurrency(getDisplayedPaidAmount(appt), appt.currency || features.default_currency, features.iqd_display_preference)}
                      </TableCell>
                      <TableCell className="font-semibold uppercase">{appt.currency || features.default_currency}</TableCell>
                      <TableCell>{renderPaymentStatus(appt)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {renderPaymentAction(appt)}
                          <Button variant="ghost" size="icon" onClick={() => navigate(`/clinical-appointments/${appt.id}/edit`)}>
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleteConfirmId(appt.id)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      <SettlementDialog
        open={!!paymentObligation}
        onOpenChange={(open) => { if (!open && !isCollectingPayment) setPaymentObligation(null) }}
        obligation={paymentObligation}
        isSubmitting={isCollectingPayment}
        onSubmit={handlePaymentSubmit}
      />
      <DeleteConfirmationModal
        isOpen={!!deleteConfirmId}
        onClose={() => setDeleteConfirmId(null)}
        onConfirm={handleDelete}
        isLoading={isDeleting}
        itemName={deleteConfirmId ? appointments?.find(a => a.id === deleteConfirmId)?.patientName || '' : ''}
      />
    </div>
  )
}

function CreateAppointmentForm({ workspaceId, appointment, onCancel, onSaved }: { workspaceId: string; appointment?: ClinicalAppointment; onCancel: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user } = useAuth()
  const { features } = useWorkspace()
  const registryType = useClinicalRegistryType(workspaceId)
  const appointmentPaymentTransactions = usePaymentTransactions(workspaceId, {
    sourceModule: 'clinical_appointments',
    sourceType: 'clinical_appointment',
    includeReversals: true,
  }, { hydrateSourceTables: false })
  const isEditing = !!appointment

  const [patientSearch, setPatientSearch] = useState('')
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(appointment?.patientId ?? null)
  const [patientName, setPatientName] = useState(appointment?.patientName ?? '')
  const [patientPhone, setPatientPhone] = useState(appointment?.patientPhone ?? '')
  const [isNewPatient, setIsNewPatient] = useState<boolean>(appointment?.isNewPatient ?? true)
  const [showPatientCreate, setShowPatientCreate] = useState(false)
  const [newPatientName, setNewPatientName] = useState('')
  const [newPatientPhone, setNewPatientPhone] = useState('')
  const [patientBirthYear, setPatientBirthYear] = useState<number | null>(null)
  const [newPatientBirthYear, setNewPatientBirthYear] = useState('')

  const [appointmentDate, setAppointmentDate] = useState(appointment?.appointmentDate ?? '')
  const [startTime, setStartTime] = useState(appointment?.startTime ?? '')
  const [combinedDateTime, setCombinedDateTime] = useState<Date | undefined>(() => {
    if (appointment?.appointmentDate && appointment?.startTime) {
      const parts = appointment.appointmentDate.split('-').map(Number)
      const timeParts = appointment.startTime.split(':').map(Number)
      if (parts.length === 3 && timeParts.length >= 2) {
        return new Date(parts[0], parts[1] - 1, parts[2], timeParts[0], timeParts[1])
      }
    }
    return undefined
  })
  const handleDateTimeChange = useCallback((date: Date | undefined) => {
    setCombinedDateTime(date)
    if (date) {
      const y = date.getFullYear()
      const m = String(date.getMonth() + 1).padStart(2, '0')
      const d = String(date.getDate()).padStart(2, '0')
      setAppointmentDate(`${y}-${m}-${d}`)
      const hh = String(date.getHours()).padStart(2, '0')
      const mm = String(date.getMinutes()).padStart(2, '0')
      setStartTime(`${hh}:${mm}`)
    } else {
      setAppointmentDate('')
      setStartTime('')
    }
  }, [])
  const [appointmentType, setAppointmentType] = useState<ClinicalAppointmentType>(appointment?.appointmentType ?? 'consultation')
  const [reasonForVisit, setReasonForVisit] = useState(appointment?.reasonForVisit ?? '')
  const [showReasonSuggestions, setShowReasonSuggestions] = useState(false)
  const reasonForVisitPresets = useClinicalPresetsByCategory(workspaceId, 'reason_for_visit')
  const appointmentTypePresets = useClinicalPresetsByCategory(workspaceId, 'appointment_type')
  const [consultationFee, setConsultationFee] = useState(appointment?.consultationFee ?? 0)
  const [currency, setCurrency] = useState<CurrencyCode>(appointment?.currency ?? features.default_currency)
  useEffect(() => {
    if (!appointmentTypePresets || appointment) return
    const preset = appointmentTypePresets.find((p) => p.name === appointmentType)
    if (preset?.consultationFee) setConsultationFee(preset.consultationFee)
  }, [appointmentTypePresets, appointment, appointmentType])
  const [estimatedPrice, setEstimatedPrice] = useState(appointment?.estimatedPrice ?? 0)
  const [status, setStatus] = useState<ClinicalAppointmentStatus>(appointment?.status ?? 'draft')
  const [confirmationMethod, setConfirmationMethod] = useState<ClinicalConfirmationMethod>(appointment?.confirmationMethod ?? 'phone')
  const [priority, setPriority] = useState<ClinicalAppointmentPriority>(appointment?.priority ?? 'normal')
  const [internalNotes, setInternalNotes] = useState(appointment?.internalNotes ?? '')
  const [attachments, setAttachments] = useState<File[]>([])

  const currencyOptions = useMemo(
    () => Array.from(new Set([
      appointment?.currency,
      features.default_currency,
      ...(features.allowed_currencies || []),
    ].filter(Boolean))) as CurrencyCode[],
    [appointment?.currency, features.allowed_currencies, features.default_currency],
  )
  const appointmentPaymentSummary = useMemo(
    () => appointment
      ? getClinicalAppointmentPaymentSummary(
        { ...appointment, consultationFee, currency },
        appointmentPaymentTransactions,
      )
      : null,
    [appointment, appointmentPaymentTransactions, consultationFee, currency],
  )
  const formPaymentStatus: ClinicalPaymentStatus = appointmentPaymentSummary?.activeTransactions.length
    ? appointmentPaymentSummary.paymentStatus
    : appointment?.paymentStatus
    || appointmentPaymentSummary?.paymentStatus
    || (consultationFee > 0 ? 'unpaid' : 'no_fee')
  const formPaidAmount = appointmentPaymentSummary?.activeTransactions.length
    ? appointmentPaymentSummary.paidAmount
    : appointment?.paidAmount
    ?? appointmentPaymentSummary?.paidAmount
    ?? 0
  const hasActivePayments = (appointmentPaymentSummary?.activeTransactions.length || 0) > 0
    || appointment?.paymentStatus === 'partial'
    || appointment?.paymentStatus === 'paid'

  const [saving, setSaving] = useState(false)

  const matchingPatients = useLiveQuery(async () => {
    if (!patientSearch.trim() || !workspaceId) return []
    return searchClinicalPatients(workspaceId, patientSearch)
  }, [patientSearch, workspaceId])

  const handlePatientSelect = useCallback(async (patientId: string) => {
    const patient = await db.clinical_patients.get(patientId)
    if (patient) {
      setSelectedPatientId(patientId)
      setPatientName(patient.name)
      setPatientPhone(patient.phone ?? '')
      setPatientBirthYear(patient.birthYear ?? null)
      setIsNewPatient(patient.isNewPatient)
      setShowPatientCreate(false)
      setPatientSearch('')
    }
  }, [])

  const handleCreateNewPatient = useCallback(async () => {
    if (!newPatientName.trim() || !workspaceId) return
    const by = newPatientBirthYear ? parseInt(newPatientBirthYear, 10) : null
    const patient = await createClinicalPatient(
      { name: newPatientName.trim(), phone: newPatientPhone.trim() || null, email: null, isNewPatient: true, notes: null, birthYear: by && !isNaN(by) ? by : null, createdBy: user?.id ?? null } as any,
      workspaceId,
    )
    setSelectedPatientId(patient.id)
    setPatientName(patient.name)
    setPatientPhone(patient.phone ?? '')
    setPatientBirthYear(patient.birthYear ?? null)
    setIsNewPatient(true)
    setShowPatientCreate(false)
    setNewPatientName('')
    setNewPatientPhone('')
    setNewPatientBirthYear('')
  }, [newPatientName, newPatientPhone, newPatientBirthYear, workspaceId, user])

  const handleFileAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setAttachments((prev) => [...prev, ...files])
  }, [])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!workspaceId || !patientName.trim() || !appointmentDate || !startTime) return
    setSaving(true)
    try {
      let apptId = isEditing ? appointment!.id : ''
      if (isEditing && appointment) {
        await updateClinicalAppointment(
          appointment.id,
          {
            patientName: patientName.trim(),
            patientPhone: patientPhone.trim() || null,
            isNewPatient,
            appointmentDate,
            startTime,
            appointmentType,
            reasonForVisit: reasonForVisit.trim() || null,
            consultationFee,
            estimatedPrice,
            currency,
            status,
            confirmationMethod,
            priority,
            internalNotes: internalNotes.trim() || null,
          } as any,
          workspaceId,
        )
      } else {
        const created = await createClinicalAppointment(
          {
            patientId: selectedPatientId ?? generateId(),
            patientName: patientName.trim(),
            patientPhone: patientPhone.trim() || null,
            isNewPatient,
            appointmentDate,
            startTime,
            appointmentType,
            reasonForVisit: reasonForVisit.trim() || null,
            consultationFee,
            estimatedPrice,
            currency,
            status,
            confirmationMethod,
            priority,
            internalNotes: internalNotes.trim() || null,
            createdBy: user?.id ?? null,
          } as any,
          workspaceId,
        )
        apptId = created.id
      }

      for (const file of attachments) {
        const fileName = `${apptId}/${file.name}`
        const r2Path = `${workspaceId}/${CLINIC_ATTACHMENTS_PREFIX}/${fileName}`
        const isDemoMode = isDemoWorkspaceMode(workspaceId)
        const isImage = await isImageUploadCandidate(file)

        if (isImage) {
          const stored = await mediaUploadService.storeImageFile(
            file,
            workspaceId,
            `${CLINIC_ATTACHMENTS_PREFIX}/${apptId}`,
            'clinical-attachment',
          )
          const { createClinicalAttachment } = await import('@/local-db/clinicalAppointments')
          await createClinicalAttachment(
            {
              appointmentId: apptId,
              fileName: file.name,
              fileType: stored.artifact.file.type,
              fileSize: stored.artifact.outputBytes,
              r2Path: stored.r2Key,
              localPath: stored.path,
              createdBy: user?.id ?? null,
            } as any,
            workspaceId,
          )
          continue
        }

        const localPath = await platformService.joinPath(
          await platformService.getAppDataDir(),
          CLINIC_ATTACHMENTS_PREFIX,
          workspaceId,
          fileName,
        )
        if (!isLocalWorkspaceMode(workspaceId) && r2Service.isConfigured()) {
          try {
            await r2Service.uploadObject(r2Path.replace(/\\/g, '/'), file, file.type)
          } catch (e) {
            console.error('[ClinicalAppointments] R2 upload failed:', e)
          }
        }
        let storedLocalPath = localPath
        if (isDemoMode) {
          storedLocalPath = await fileToDataUrl(file)
        } else {
          try {
            const { writeTextFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
            const buffer = await file.arrayBuffer()
            await writeTextFile(localPath, new Uint8Array(buffer) as any, { baseDir: BaseDirectory.AppData })
          } catch (e) {
            console.warn('[ClinicalAppointments] Local file save not available:', e)
          }
        }
        const { createClinicalAttachment } = await import('@/local-db/clinicalAppointments')
        await createClinicalAttachment(
          {
            appointmentId: apptId,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            r2Path: isDemoMode ? null : r2Path.replace(/\\/g, '/'),
            localPath: storedLocalPath,
            createdBy: user?.id ?? null,
          } as any,
          workspaceId,
        )
      }

      onSaved()
    } catch (e) {
      console.error('[ClinicalAppointments] Failed to save appointment:', e)
      const mediaCode = getMediaUploadErrorCode(e)
      if (mediaCode) {
        toast({
          title: t('common.error'),
          description: t(`mediaUpload.errors.${mediaCode}`),
          variant: 'destructive',
        })
      }
    } finally {
      setSaving(false)
    }
  }, [isEditing, appointment, workspaceId, patientName, patientPhone, selectedPatientId, isNewPatient, appointmentDate, startTime, appointmentType, reasonForVisit, consultationFee, estimatedPrice, currency, status, confirmationMethod, priority, internalNotes, attachments, user, onSaved, t, toast])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <form onSubmit={(e) => { e.preventDefault(); handleSubmit() }} className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 lg:p-6 custom-scrollbar">
          <div className="space-y-5 pb-5">
            <div className="space-y-1">
              <Button
                type="button"
                variant="ghost"
                className="h-auto gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                onClick={onCancel}
              >
                <ArrowLeft className="h-4 w-4" />
                {t('clinicalAppointments.title', { defaultValue: 'Clinical Appointments' })}
              </Button>
              <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
                <CalendarClock className="h-7 w-7" />
                {isEditing
                  ? t('clinicalAppointments.editTitle', { defaultValue: 'Edit Appointment' })
                  : t('clinicalAppointments.createTitle', { defaultValue: 'Create Appointment' })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {isEditing
                  ? t('clinicalAppointments.editDescription', { defaultValue: 'Update the appointment details.' })
                  : t('clinicalAppointments.createDescription', { defaultValue: 'Fill in the details to schedule a new appointment.' })}
              </p>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>{t('clinicalAppointments.patientSection', { defaultValue: 'Patient' })}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4">
                  {!showPatientCreate ? (
                    <div className="grid gap-2">
                      <Label>{t('clinicalAppointments.patient', { defaultValue: 'Patient' })}</Label>
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                          placeholder={t('clinicalAppointments.searchPatient', { defaultValue: 'Search existing patient...' })}
                          value={patientSearch}
                          onChange={(e) => {
                            setPatientSearch(e.target.value)
                            if (!e.target.value) {
                              setSelectedPatientId(null)
                              setPatientName('')
                            }
                          }}
                          className="pl-10"
                        />
                      </div>
                      {patientSearch.trim() && matchingPatients && matchingPatients.length > 0 && (
                        <div className="border rounded-md max-h-40 overflow-y-auto">
                          {matchingPatients.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              className="w-full text-left px-3 py-2 hover:bg-accent text-sm"
                              onClick={() => handlePatientSelect(p.id)}
                            >
                              <span className="font-medium">{p.name}</span>
                              {p.phone && <span className="text-muted-foreground ml-2">{p.phone}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                      {!selectedPatientId && (
                        <Button variant="outline" size="sm" type="button" onClick={() => setShowPatientCreate(true)}>
                          <Plus className="w-3 h-3 mr-1" />
                          {t('clinicalAppointments.createNewPatient', { defaultValue: 'Create new patient' })}
                        </Button>
                      )}
                      {selectedPatientId && (
                        <div className="flex items-center gap-2 text-sm p-2 bg-accent/50 rounded-md">
                          <span className="font-medium">{patientName}</span>
                          {patientPhone && <span className="text-muted-foreground">{patientPhone}</span>}
                          {patientBirthYear && <span className="text-muted-foreground">· {t('clinicalAppointments.age', { defaultValue: 'Age' })}: {calculateAge(patientBirthYear)}</span>}
                          <button
                            type="button"
                            className="ml-auto text-muted-foreground hover:text-foreground"
                            onClick={() => { setSelectedPatientId(null); setPatientName(''); setPatientPhone(''); setPatientBirthYear(null); setPatientSearch('') }}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="grid gap-3 p-4 border rounded-lg">
                      <div className="grid gap-2">
                        <Label>{t('clinicalAppointments.patientName', { defaultValue: 'Patient Name' })}</Label>
                        <Input value={newPatientName} onChange={(e) => setNewPatientName(e.target.value)} />
                      </div>
                      <div className="grid gap-2">
                        <Label>{t('clinicalAppointments.phone', { defaultValue: 'Phone' })}</Label>
                        <Input value={newPatientPhone} onChange={(e) => setNewPatientPhone(e.target.value)} />
                      </div>
                      <div className="grid gap-2">
                        <Label>{t('clinicalAppointments.birthYear', { defaultValue: 'Birth Year' })}</Label>
                        <Input
                          type="number"
                          min={1900}
                          max={new Date().getFullYear()}
                          value={newPatientBirthYear}
                          onChange={(e) => setNewPatientBirthYear(e.target.value)}
                          placeholder="e.g. 1990"
                        />
                        {newPatientBirthYear && (
                          <p className="text-xs text-muted-foreground">{t('clinicalAppointments.age', { defaultValue: 'Age' })}: {new Date().getFullYear() - parseInt(newPatientBirthYear)}</p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" type="button" onClick={handleCreateNewPatient} disabled={!newPatientName.trim()}>
                          {t('clinicalAppointments.savePatient', { defaultValue: 'Save Patient' })}
                        </Button>
                        <Button size="sm" variant="ghost" type="button" onClick={() => setShowPatientCreate(false)}>
                          {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('clinicalAppointments.appointmentSection', { defaultValue: 'Appointment' })}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="grid gap-2">
                      <Label>{t('clinicalAppointments.dateTime', { defaultValue: 'Date & Time' })}</Label>
                      <DateTimePicker
                        id="clinical-appointment-datetime"
                        mode="date-time"
                        date={combinedDateTime}
                        setDate={handleDateTimeChange}
                        placeholder={t('clinicalAppointments.dateTime', { defaultValue: 'Select date and time' })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>{t('clinicalAppointments.appointmentType', { defaultValue: 'Appointment Type' })}</Label>
                      <Select value={appointmentType} onValueChange={(v: ClinicalAppointmentType) => { setAppointmentType(v); const atPreset = appointmentTypePresets?.find((p) => p.name === v); const rvPreset = reasonForVisit.trim() ? reasonForVisitPresets?.find((p) => p.name === reasonForVisit) : null; if (atPreset?.consultationFee && (!rvPreset || atPreset.sortOrder <= rvPreset.sortOrder)) setConsultationFee(atPreset.consultationFee) }}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {['consultation', 'follow_up', 'emergency', 'checkup', 'procedure', 'treatment'].map((type) => (
                            <SelectItem key={type} value={type}>
                              {t('clinicalAppointments.types.' + type, { defaultValue: type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2 relative">
                      <Label>{t('clinicalAppointments.reasonForVisit', { defaultValue: 'Reason for Visit' })}</Label>
                      <Input
                        value={reasonForVisit}
                        onChange={(e) => { setReasonForVisit(e.target.value); setShowReasonSuggestions(true) }}
                        onFocus={() => setShowReasonSuggestions(true)}
                        onBlur={() => setShowReasonSuggestions(false)}
                        placeholder={t('clinicalAppointments.reasonForVisitPlaceholder', { defaultValue: 'e.g. Tooth pain' })}
                      />
                      {showReasonSuggestions && reasonForVisit.trim() && reasonForVisitPresets && reasonForVisitPresets.length > 0 && (
                        <div className="absolute top-full mt-1 left-0 right-0 border rounded-md max-h-40 overflow-y-auto bg-background z-10 shadow-lg">
                          {reasonForVisitPresets
                            .filter((p) => p.name.toLowerCase().includes(reasonForVisit.toLowerCase()))
                            .map((preset) => (
                              <button
                                key={preset.id}
                                type="button"
                                className="w-full text-left px-3 py-2 hover:bg-accent text-sm"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { setReasonForVisit(preset.name); const atPreset = appointmentTypePresets?.find((p) => p.name === appointmentType); if (preset.consultationFee && (!atPreset || preset.sortOrder < atPreset.sortOrder)) setConsultationFee(preset.consultationFee); setShowReasonSuggestions(false) }}
                              >
                                {preset.name}
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('clinicalAppointments.pricingSection', { defaultValue: 'Pricing' })}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
                  <div className="grid gap-2">
                    <Label>{t('clinicalAppointments.consultationFee', { defaultValue: 'Consultation Fee' })}</Label>
                    <div className="relative">
                      <Input disabled={hasActivePayments} className="pr-12" value={consultationFee ? formatNumberWithCommas(consultationFee) : ''} onChange={(e) => setConsultationFee(Number(e.target.value.replace(/,/g, '')))} />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currency}</span>
                    </div>
                  </div>
                  <div className="grid content-start gap-2">
                    <Label>{t('clinicalAppointments.finalPayment', { defaultValue: 'Final Payment' })}</Label>
                    <div className="flex h-10 items-center rounded-md border bg-muted/30 px-3 font-semibold">
                      {formatCurrency(formPaidAmount, currency, features.iqd_display_preference)}
                    </div>
                  </div>
                  {!isBeautyClinicalRegistryType(registryType) && (
                    <div className="grid gap-2">
                      <Label>{t('clinicalAppointments.estimatedPrice', { defaultValue: 'Estimated Price' })}</Label>
                      <div className="relative">
                        <Input className="pr-12" value={estimatedPrice ? formatNumberWithCommas(estimatedPrice) : ''} onChange={(e) => setEstimatedPrice(Number(e.target.value.replace(/,/g, '')))} />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{currency}</span>
                      </div>
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Label>{t('clinicalAppointments.currency', { defaultValue: 'Currency' })}</Label>
                    <Select value={currency} onValueChange={(value: CurrencyCode) => setCurrency(value)} disabled={hasActivePayments}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {currencyOptions.map((option) => (
                          <SelectItem key={option} value={option}>{option.toUpperCase()}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {hasActivePayments && (
                      <p className="text-xs text-muted-foreground">
                        {t('clinicalAppointments.currencyLockedAfterPayment', { defaultValue: 'Currency and service fee are locked after payment collection.' })}
                      </p>
                    )}
                  </div>
                  <div className="grid content-start gap-2">
                    <Label>{t('clinicalAppointments.paymentStatus', { defaultValue: 'Payment Status' })}</Label>
                    <div className="flex h-10 items-center">
                      <PaymentStatusBadge status={formPaymentStatus} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('clinicalAppointments.statusSection', { defaultValue: 'Status' })}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className="grid gap-2">
                      <Label>{t('clinicalAppointments.status', { defaultValue: 'Status' })}</Label>
                      <Select value={status} onValueChange={(v: ClinicalAppointmentStatus) => setStatus(v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {['draft', 'booked', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_show'].map((s) => (
                            <SelectItem key={s} value={s}>{t('clinicalAppointments.statuses.' + s, { defaultValue: s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) })}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>{t('clinicalAppointments.confirmationMethod', { defaultValue: 'Method' })}</Label>
                      <Select value={confirmationMethod} onValueChange={(v: ClinicalConfirmationMethod) => setConfirmationMethod(v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {['phone', 'sms', 'whatsapp', 'email', 'other'].map((m) => (
                            <SelectItem key={m} value={m}>{t('clinicalAppointments.confirmationMethods.' + m, { defaultValue: m.charAt(0).toUpperCase() + m.slice(1) })}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>{t('clinicalAppointments.priority', { defaultValue: 'Priority' })}</Label>
                      <Select value={priority} onValueChange={(v: ClinicalAppointmentPriority) => setPriority(v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="normal">{t('clinicalAppointments.priorities.normal', { defaultValue: 'Normal' })}</SelectItem>
                          <SelectItem value="urgent">{t('clinicalAppointments.priorities.urgent', { defaultValue: 'Urgent' })}</SelectItem>
                          <SelectItem value="emergency">{t('clinicalAppointments.priorities.emergency', { defaultValue: 'Emergency' })}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('clinicalAppointments.notesSection', { defaultValue: 'Notes' })}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label>{t('clinicalAppointments.internalNotes', { defaultValue: 'Internal Notes' })}</Label>
                    <Textarea value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} rows={3} />
                  </div>
                  <div className="grid gap-2">
                    <Label>{t('clinicalAppointments.attachments', { defaultValue: 'Attachments' })}</Label>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" type="button" onClick={() => document.getElementById('file-upload')?.click()}>
                        <Upload className="w-4 h-4 mr-1" />
                        {t('clinicalAppointments.uploadFiles', { defaultValue: 'Upload Files' })}
                      </Button>
                      <input id="file-upload" type="file" multiple className="hidden" onChange={handleFileAttach} />
                    </div>
                    {attachments.length > 0 && (
                      <div className="space-y-1 mt-2">
                        {attachments.map((file, i) => (
                          <div key={i} className="flex items-center gap-2 text-sm p-2 bg-accent/50 rounded-md">
                            <FileText className="w-4 h-4 text-muted-foreground" />
                            <span className="flex-1 truncate">{file.name}</span>
                            <span className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
                            <button type="button" onClick={() => removeAttachment(i)}>
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="flex-shrink-0 border-t bg-background/95 px-4 py-2 backdrop-blur lg:px-6">
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onCancel} disabled={saving}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={saving || !patientName.trim() || !appointmentDate || !startTime}>
              {saving
                ? t('common.saving', { defaultValue: 'Saving...' })
                : isEditing
                  ? t('clinicalAppointments.saveChanges', { defaultValue: 'Save Changes' })
                  : t('clinicalAppointments.createAppointment', { defaultValue: 'Create Appointment' })}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
