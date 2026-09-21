import type { DateRangeType } from '@/context/DateRangeContext'
import type { ClinicalAppointment } from '@/local-db/models'
import { formatLocalDateValue } from '@/lib/utils'

export interface BeautyCenterAppointmentFilterOptions {
  customDates: {
    start: string
    end: string
  }
  dateRange: DateRangeType
  nextVisitDate: string
  now?: Date
  searchQuery: string
}

export function filterBeautyCenterAppointments(
  appointments: ClinicalAppointment[] | undefined,
  {
    customDates,
    dateRange,
    nextVisitDate,
    now = new Date(),
    searchQuery,
  }: BeautyCenterAppointmentFilterOptions,
): ClinicalAppointment[] {
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

    if (dateRange === 'today' && issueDate !== todayValue) {
      return false
    }

    if (dateRange === 'month') {
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
      if (issueDate < monthStart) return false
    }

    if (dateRange === 'lastMonth') {
      const startOfLastMonth = formatLocalDateValue(new Date(now.getFullYear(), now.getMonth() - 1, 1))
      const startOfMonth = formatLocalDateValue(new Date(now.getFullYear(), now.getMonth(), 1))
      if (issueDate < startOfLastMonth || issueDate >= startOfMonth) return false
    }

    if (dateRange === 'custom') {
      if (customDates.start && issueDate < customDates.start) return false
      if (customDates.end && issueDate > customDates.end) return false
    }

    return !nextVisitDate || appointment.nextVisitDate === nextVisitDate
  })
}
