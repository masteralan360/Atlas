import { describe, expect, it } from 'vitest'

import { filterBeautyCenterAppointments } from './clinicalAppointmentFilters'
import type { ClinicalAppointment } from '@/local-db/models'

const NOW = new Date(2026, 8, 21, 12)

function appointment(
  id: string,
  issueDate: string,
  nextVisitDate: string | null,
): ClinicalAppointment {
  return {
    id,
    workspaceId: 'workspace-1',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    syncStatus: 'synced',
    lastSyncedAt: '2026-09-01T09:00:00.000Z',
    version: 1,
    isDeleted: false,
    patientId: `patient-${id}`,
    patientName: `Client ${id}`,
    patientPhone: null,
    isNewPatient: false,
    appointmentDate: issueDate,
    startTime: '09:00',
    appointmentType: 'treatment',
    reasonForVisit: 'Treatment',
    consultationFee: 0,
    estimatedPrice: 0,
    currency: 'iqd',
    paidAmount: 0,
    paymentStatus: 'no_fee',
    status: 'booked',
    confirmationMethod: 'phone',
    priority: 'normal',
    internalNotes: null,
    createdBy: 'user-1',
    issueDate,
    nextVisitDate,
  }
}

const appointments = [
  appointment('matching', '2026-09-01', '2026-10-10'),
  appointment('other-next-visit', '2026-09-02', '2026-10-11'),
  appointment('previous-month', '2026-08-31', '2026-10-10'),
  appointment('no-next-visit', '2026-09-03', null),
]

describe('Beauty Center appointment filters', () => {
  it('intersects the Issue Date range with the single Next Visit Date picker', () => {
    const result = filterBeautyCenterAppointments(appointments, {
      dateRange: 'month',
      customDates: { start: '', end: '' },
      nextVisitDate: '2026-10-10',
      now: NOW,
      searchQuery: '',
    })

    expect(result.map(({ id }) => id)).toEqual(['matching'])
  })

  it('uses the date range exclusively for Issue Date when the next-visit picker is clear', () => {
    const result = filterBeautyCenterAppointments(appointments, {
      dateRange: 'custom',
      customDates: { start: '2026-09-02', end: '2026-09-03' },
      nextVisitDate: '',
      now: NOW,
      searchQuery: '',
    })

    expect(result.map(({ id }) => id)).toEqual(['other-next-visit', 'no-next-visit'])
  })

  it('excludes appointments without an exact next-visit date match', () => {
    const result = filterBeautyCenterAppointments(appointments, {
      dateRange: 'allTime',
      customDates: { start: '', end: '' },
      nextVisitDate: '2026-10-10',
      now: NOW,
      searchQuery: '',
    })

    expect(result.map(({ id }) => id)).toEqual(['matching', 'previous-month'])
  })
})
