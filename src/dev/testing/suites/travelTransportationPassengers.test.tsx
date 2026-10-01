import 'fake-indexeddb/auto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from '@/local-db/database'
import type { TravelBooking, TravelPassenger } from '@/local-db/models'

const remote = vi.hoisted(() => ({
    upserts: [] as Array<{ table: string; payload: Record<string, unknown>[]; options: Record<string, unknown> }>,
    offline: [] as Array<{ table: string; id: string; operation: string; entity: Record<string, unknown>; workspaceId: string }>,
    online: true,
    failPassengerUpsert: false
}))

vi.mock('@/lib/supabaseSchema', () => ({
    getSupabaseClientForTable: (table: string) => ({
        from: (requestedTable: string) => {
            if (requestedTable !== table) throw new Error(`Unexpected table ${requestedTable}`)
            return {
                upsert: async (payload: Record<string, unknown>[], options: Record<string, unknown>) => {
                    remote.upserts.push({ table, payload, options })
                    if (table === 'travel_passengers' && remote.failPassengerUpsert) {
                        return { error: { code: 'NETWORK', message: 'temporary network failure' } }
                    }
                    return { error: null }
                }
            }
        }
    })
}))

vi.mock('@/lib/network', () => ({ isOnline: () => remote.online }))
vi.mock('@/hooks/useNetworkStatus', () => ({ useNetworkStatus: () => true }))
vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: (_label: string, action: () => PromiseLike<unknown>) => action()
}))
vi.mock('@/local-db/hooks', () => ({
    addToOfflineMutations: async (table: string, id: string, operation: string, entity: Record<string, unknown>, workspaceId: string) => {
        remote.offline.push({ table, id, operation, entity, workspaceId })
    },
    fetchTableFromSupabase: vi.fn()
}))
vi.mock('react-i18next', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-i18next')>()
    const translate = (key: string) => key === 'travelTransportation.phoneNumber' ? 'Phone Number' : key
    return {
        ...actual,
        useTranslation: () => ({ t: translate, i18n: { language: 'en', getFixedT: () => translate } })
    }
})

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000701'
const NOW = '2026-09-04T10:00:00.000Z'

let createTravelBooking: typeof import('@/local-db/travelTransportation').createTravelBooking
let updateTravelBooking: typeof import('@/local-db/travelTransportation').updateTravelBooking

function bookingFixture(): TravelBooking {
    return {
        id: 'booking-print-1',
        workspaceId: WORKSPACE_ID,
        bookingNumber: 'TT-2026-00001',
        currency: 'usd',
        travelDate: '2026-09-15T00:00:00.000Z',
        passengerTotal: 100,
        bookingTotal: 100,
        adjustedBookingTotal: 100,
        bookingAdjustments: null,
        profitAmount: 0,
        paidProfitAmount: 0,
        outstandingProfitAmount: 0,
        paymentMethod: 'cash',
        status: 'draft',
        notes: null,
        createdBy: null,
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: NOW
    }
}

function passengerFixture(overrides: Partial<TravelPassenger> = {}): TravelPassenger {
    return {
        id: 'passenger-print-1',
        workspaceId: WORKSPACE_ID,
        bookingId: 'booking-print-1',
        name: 'Dana Passenger',
        phoneNumber: '+964 750 123 4567',
        transportationType: 'flight',
        price: 100,
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: NOW,
        ...overrides
    }
}

describe('Travel & Transportation passenger phone records and print', () => {
    beforeAll(async () => {
        installTestBrowser()
        ;({ createTravelBooking, updateTravelBooking } = await import('@/local-db/travelTransportation'))
    })

    beforeEach(async () => {
        installTestBrowser()
        await db.delete()
        await db.open()
        remote.upserts.length = 0
        remote.offline.length = 0
        remote.online = true
        remote.failPassengerUpsert = false
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
    })

    afterEach(() => {
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        vi.restoreAllMocks()
    })

    afterAll(async () => { await db.delete() })

    it('stores passenger phones locally and sends phone_number on create and edit', async () => {
        const created = await createTravelBooking(WORKSPACE_ID, {
            passengers: [{ name: 'Dana Passenger', phoneNumber: '  +964 750 123 4567  ', transportationType: 'flight', price: 100 }],
            currency: 'usd',
            paymentMethod: 'cash'
        })

        expect(created.passengers[0]).toMatchObject({ name: 'Dana Passenger', phoneNumber: '+964 750 123 4567' })
        expect(await db.travel_passengers.get(created.passengers[0].id)).toMatchObject({ phoneNumber: '+964 750 123 4567', syncStatus: 'synced' })
        expect(remote.upserts.find((request) => request.table === 'travel_passengers')).toMatchObject({
            options: { onConflict: 'id' },
            payload: [expect.objectContaining({ phone_number: '+964 750 123 4567', booking_id: created.booking.id })]
        })

        const updated = await updateTravelBooking(created.booking.id, {
            passengers: [{
                id: created.passengers[0].id,
                name: 'Dana Passenger',
                phoneNumber: '+964 751 987 6543',
                transportationType: 'flight',
                price: 100
            }],
            currency: 'usd',
            paymentMethod: 'cash'
        })

        expect(updated.passengers[0]).toMatchObject({ id: created.passengers[0].id, phoneNumber: '+964 751 987 6543' })
        expect(await db.travel_passengers.get(created.passengers[0].id)).toMatchObject({ phoneNumber: '+964 751 987 6543' })
        expect(remote.upserts.filter((request) => request.table === 'travel_passengers').at(-1)?.payload[0])
            .toMatchObject({ phone_number: '+964 751 987 6543' })
    })

    it('keeps an optional blank phone empty and queues it for retry after a remote failure', async () => {
        remote.failPassengerUpsert = true
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        const created = await createTravelBooking(WORKSPACE_ID, {
            passengers: [{ name: 'No Phone', phoneNumber: '  ', transportationType: 'bus', price: 25 }],
            currency: 'usd',
            paymentMethod: 'cash'
        })

        expect(created.passengers[0].phoneNumber).toBeNull()
        expect(remote.offline).toContainEqual(expect.objectContaining({
            table: 'travel_passengers',
            id: created.passengers[0].id,
            operation: 'create',
            workspaceId: WORKSPACE_ID,
            entity: expect.objectContaining({ phoneNumber: null })
        }))
        expect(await db.travel_passengers.get(created.passengers[0].id)).toMatchObject({ phoneNumber: null })
        expect(consoleError).toHaveBeenCalled()
    })

    it('shows passenger phones and the requested columns in the booking print table', async () => {
        const passenger = passengerFixture()
        const { TravelPassengersTable } = await import('@/ui/components/travel/TravelPassengersTable')
        const { TravelBookingPrintTemplate } = await import('@/ui/components/travel/TravelBookingPrintTemplate')

        const details = renderToStaticMarkup(createElement(TravelPassengersTable, {
            passengers: [passenger], currency: 'usd', iqdPreference: 'IQD'
        }))
        const print = renderToStaticMarkup(createElement(TravelBookingPrintTemplate, {
            workspaceName: 'Atlas', printLang: 'en', booking: bookingFixture(), passengers: [passenger], iqdPreference: 'IQD'
        }))

        expect(details).toContain('Phone Number')
        expect(details).toContain('+964 750 123 4567')
        expect(print).toContain('Phone Number')
        expect(print).toContain('+964 750 123 4567')

        const passengerTable = print.match(/<table[\s\S]*?<\/table>/)?.[0] ?? ''
        const header = passengerTable.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? ''
        const columns = Array.from(header.matchAll(/<th[^>]*>(.*?)<\/th>/g), (match) => match[1])
        expect(columns).toEqual([
            'travelTransportation.print.number',
            'travelTransportation.name',
            'Phone Number',
            'travelTransportation.transportationType',
            'travelTransportation.price'
        ])
        expect(passengerTable).not.toContain('travelTransportation.travelDate')
        expect(print).toContain('travelTransportation.travelDate')
    })
})
