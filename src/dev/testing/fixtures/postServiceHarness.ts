import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { db } from '@/local-db/database'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from './browser'
import { POST_WORKSPACE, POST_OTHER_WORKSPACE, POST_COURIER, POST_COURIER_PARTNER, POST_MERCHANT, postInput, seedPostParties } from './postService'

vi.mock('@/auth/supabase', () => {
    const unexpected = () => { throw new Error('Unexpected Supabase request in isolated Local Post Service test') }
    return { supabase: { from: unexpected, rpc: unexpected, schema: () => ({ from: unexpected }) } }
})

export function usePostServiceHarness() {
    let service: typeof import('@/local-db/postService')
    beforeAll(async () => { installTestBrowser(); service = await import('@/local-db/postService') })
    beforeEach(async () => {
        await db.delete(); await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode: 'local' })
        writeWorkspaceModeSnapshot({ workspaceId: POST_OTHER_WORKSPACE, dataMode: 'local' })
        setNetworkStatus(false); setActiveBusinessUser(null); setActiveBusinessWorkspace(null)
        await seedPostParties()
    })
    afterEach(() => {
        vi.restoreAllMocks(); vi.useRealTimers(); clearWorkspaceModeSnapshot(POST_WORKSPACE)
        clearWorkspaceModeSnapshot(POST_OTHER_WORKSPACE)
        setNetworkStatus(true); setActiveBusinessUser(null); setActiveBusinessWorkspace(null)
    })
    afterAll(async () => { await db.delete() })
    return {
        get service() { return service },
        async profile() {
            return service.createDeliveryMerchantProfile(POST_WORKSPACE, {
                businessPartnerId: POST_MERCHANT, defaultFeeAmount: 10, defaultFeePayer: 'merchant' })
        },
        async shipment(overrides: Parameters<typeof postInput>[1] = {}, dispatch = false) {
            // Keep these single-currency scenarios independent of live exchange-rate state.
            const defaultCurrency = overrides.currency ?? 'usd'
            await db.business_partners.update(POST_MERCHANT, { defaultCurrency })
            await db.business_partners.update(POST_COURIER_PARTNER, { defaultCurrency })
            const profile = await this.profile()
            const shipment = await service.createDeliveryShipment(POST_WORKSPACE, postInput(profile.id, overrides))
            if (dispatch) await service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [shipment.id] })
            return (await db.delivery_shipments.get(shipment.id))!
        },
        async delivered(overrides: Parameters<typeof postInput>[1] = {}) {
            const shipment = await this.shipment(overrides, true)
            await service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered', actorAgentId: POST_COURIER })
            return (await db.delivery_shipments.get(shipment.id))!
        }
    }
}
