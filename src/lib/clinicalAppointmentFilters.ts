import type { DateRangeType } from '@/context/DateRangeContext'
import type { ClinicalAppointment } from '@/local-db/models'
import { isDateInDateRange } from '@/lib/dateRangeFilters'

export interface BeautyCenterAppointmentFilterOptions {
  customDates: {
    start: string
    end: string
  }
  dateRange: DateRangeType
  nextVisitDate: string
  dayBoundary?: string
  now?: Date
  searchQuery: string
}

export function filterBeautyCenterAppointments(
  appointments: ClinicalAppointment[] | undefined,
  {
    customDates,
    dateRange,
    nextVisitDate,
    dayBoundary,
    now = new Date(),
    searchQuery,
  }: BeautyCenterAppointmentFilterOptions,
): ClinicalAppointment[] {
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

    if (!isDateInDateRange(issueDate, dateRange, customDates, now, dayBoundary)) return false

    return !nextVisitDate || appointment.nextVisitDate === nextVisitDate
  })
}
