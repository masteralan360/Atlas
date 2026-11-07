import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { db } from '@/local-db/database'
import type { Beauty3AppointmentDraft } from '@/local-db/beauty3Appointments'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000731'

let appointments: typeof import('@/local-db/beauty3Appointments')

function visitDraft(overrides: Partial<Beauty3AppointmentDraft> = {}): Beauty3AppointmentDraft {
  return {
    clientId: null,
    name: 'Mira Hassan',
    age: 31,
    maritalStatus: 'married',
    address: 'Salim Street',
    phoneNumber: '07701234567',
    procedureTypes: ['builtin:botox'],
    procedureType: 'builtin:botox',
    procedureTypeOther: null,
    procedurePlace: 'sulaymaniyah',
    procedureDate: '2026-11-07',
    appointmentTotal: 50000,
    totalProfit: 15000,
    currency: 'iqd',
    ...overrides,
  }
}

describe('Beauty Center 3 client and visit register', () => {
  beforeAll(async () => {
    installTestBrowser()
    appointments = await import('@/local-db/beauty3Appointments')
  })

  beforeEach(async () => {
    installTestBrowser()
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
  })

  afterEach(() => clearWorkspaceModeSnapshot(WORKSPACE_ID))
  afterAll(async () => { await db.delete() })

  it('adds multiple visits to the same saved client profile', async () => {
    const first = await appointments.saveBeauty3Appointment(visitDraft(), WORKSPACE_ID)
    const second = await appointments.saveBeauty3Appointment(visitDraft({
      clientId: first.appointment.clientId,
      procedureDate: '2026-11-14',
      appointmentTotal: 30000,
    }), WORKSPACE_ID)

    expect(first.appointment.clientId).toBeTruthy()
    expect(second.appointment.clientId).toBe(first.appointment.clientId)
    expect(await db.beauty3_clients.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(1)
    expect(await db.beauty3_appointments.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(2)
  })

  it('edits a visit while keeping the existing profile and visit record', async () => {
    const created = await appointments.saveBeauty3Appointment(visitDraft(), WORKSPACE_ID)
    const edited = await appointments.saveBeauty3Appointment(visitDraft({
      clientId: created.appointment.clientId,
      name: 'Mira H.',
      phoneNumber: '07707654321',
      procedureDate: '2026-11-08',
      appointmentTotal: 60000,
    }), WORKSPACE_ID, undefined, created.appointment.id)

    expect(edited.appointment.id).toBe(created.appointment.id)
    expect(edited.appointment.clientId).toBe(created.appointment.clientId)
    expect(edited.appointment.version).toBe(2)
    expect(await db.beauty3_appointments.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(1)
    expect(await db.beauty3_clients.where('workspaceId').equals(WORKSPACE_ID).count()).toBe(1)
    await expect(db.beauty3_clients.get(created.appointment.clientId!)).resolves.toMatchObject({
      name: 'Mira H.',
      phoneNumber: '07707654321',
    })
  })
})
