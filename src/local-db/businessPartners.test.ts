import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { setActiveBusinessUser, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
let createBusinessPartner: typeof import('./businessPartners').createBusinessPartner
let deleteBusinessPartner: typeof import('./businessPartners').deleteBusinessPartner
let mergeBusinessPartners: typeof import('./businessPartners').mergeBusinessPartners
let replaceAgentExcludedCategories: typeof import('./businessPartners').replaceAgentExcludedCategories
let updateBusinessPartner: typeof import('./businessPartners').updateBusinessPartner
let canAccessBusinessPartnerInLocalCache: typeof import('./businessPartnerAccess').canAccessBusinessPartnerInLocalCache

async function createAgentForExcludedCategoryTest() {
    const partner = await createBusinessPartner(WORKSPACE_ID, {
        partnerName: 'Excluded Category Agent',
        phone: '07500000008',
        defaultCurrency: 'iqd',
        creditLimit: 0,
        role: 'agent',
        agent: {
            zone: 'Central District',
            agentType: 'field_agent',
            status: 'active'
        }
    }, { allowAgentRole: true })

    return partner.agentFacetId!
}

async function createCategoryForExcludedCategoryTest() {
    const now = new Date().toISOString()
    const categoryId = '00000000-0000-4000-8000-000000000010'
    await db.categories.put({
        id: categoryId,
        workspaceId: WORKSPACE_ID,
        name: 'Restricted category',
        createdAt: now,
        updatedAt: now,
        syncStatus: 'synced',
        lastSyncedAt: now,
        version: 1,
        isDeleted: false
    })
    return categoryId
}

function installBrowserStorage() {
    const rows = new Map<string, string>()
    const storage = {
        get length() {
            return rows.size
        },
        getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => rows.set(key, value),
        removeItem: (key: string) => rows.delete(key),
        clear: () => rows.clear(),
        key: (index: number) => Array.from(rows.keys())[index] ?? null
    }

    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storage
    })
    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: storage
    })
    const browserTarget = {
        localStorage: storage,
        sessionStorage: storage,
        URL: globalThis.URL,
        location: { origin: 'http://localhost', hash: '', pathname: '/' },
        addEventListener: () => undefined,
        removeEventListener: () => undefined
    }

    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: browserTarget
    })
    const documentHead = {
        firstChild: null,
        appendChild: () => undefined,
        insertBefore: () => undefined
    }
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible',
            dir: 'ltr',
            documentElement: { lang: 'en', dir: 'ltr' },
            head: documentHead,
            getElementsByTagName: () => [documentHead],
            createElement: () => ({
                appendChild: () => undefined,
                setAttribute: () => undefined,
                styleSheet: null
            }),
            createTextNode: () => ({}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    // The partner module imports the shared application shell, which imports
    // drag-and-drop support. The test never renders it, but its module setup
    // performs an Element feature check.
    Object.defineProperty(globalThis, 'Element', {
        configurable: true,
        value: class Element {}
    })
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: false }
    })
    // Imported print utilities load pdfjs during this suite. These lightweight
    // browser constructors are sufficient because the partner tests do not
    // render or rasterize PDFs.
    Object.defineProperty(globalThis, 'DOMMatrix', {
        configurable: true,
        value: class DOMMatrix {}
    })
    Object.defineProperty(globalThis, 'ImageData', {
        configurable: true,
        value: class ImageData {}
    })
    Object.defineProperty(globalThis, 'Path2D', {
        configurable: true,
        value: class Path2D {}
    })
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
        configurable: true,
        value: () => 'blob:atlas-test'
    })
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
        configurable: true,
        value: () => undefined
    })
}

describe('business partner agent facets', () => {
    beforeAll(async () => {
        installBrowserStorage()
        const businessPartners = await import('./businessPartners')
        createBusinessPartner = businessPartners.createBusinessPartner
        deleteBusinessPartner = businessPartners.deleteBusinessPartner
        mergeBusinessPartners = businessPartners.mergeBusinessPartners
        replaceAgentExcludedCategories = businessPartners.replaceAgentExcludedCategories
        updateBusinessPartner = businessPartners.updateBusinessPartner
        const access = await import('./businessPartnerAccess')
        canAccessBusinessPartnerInLocalCache = access.canAccessBusinessPartnerInLocalCache
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        setActiveBusinessUser(null)
        setNetworkStatus(true)
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    })

    afterEach(async () => {
        setActiveBusinessUser(null)
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        setNetworkStatus(true)
    })

    afterAll(async () => {
        await db.delete()
    })

    it('rejects the Agent role without module access', async () => {
        await expect(createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Unauthorized Agent',
            phone: '07500000999',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'Restricted District',
                agentType: 'field_agent',
                status: 'active'
            }
        })).rejects.toThrow('Agent roles require workspace Agents module access')
    })

    it('uses partnerName as the only active identity across commercial facets', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Northwind Trading',
            phone: '07500000009',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'both'
        })

        const customer = await db.customers.get(partner.customerFacetId!)
        const supplier = await db.suppliers.get(partner.supplierFacetId!)
        expect(partner).toMatchObject({ partnerName: 'Northwind Trading' })
        expect(customer).toMatchObject({ partnerName: 'Northwind Trading' })
        expect(supplier).toMatchObject({ partnerName: 'Northwind Trading' })
        expect(partner).not.toHaveProperty('name')
        expect(partner).not.toHaveProperty('contactName')
        expect(customer).not.toHaveProperty('name')
        expect(supplier).not.toHaveProperty('name')

        await updateBusinessPartner(partner.id, { partnerName: 'Northwind Group' })
        expect((await db.customers.get(partner.customerFacetId!))?.partnerName).toBe('Northwind Group')
        expect((await db.suppliers.get(partner.supplierFacetId!))?.partnerName).toBe('Northwind Group')
    })

    it('removes retired email and country values from legacy partner input', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Northwind Trading',
            phone: '07500000018',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'customer',
            email: 'legacy@example.test',
            country: 'Iraq'
        } as unknown as Parameters<typeof createBusinessPartner>[1])

        expect(partner).not.toHaveProperty('email')
        expect(partner).not.toHaveProperty('country')
        const stored = await db.business_partners.get(partner.id)
        expect(stored).not.toHaveProperty('email')
        expect(stored).not.toHaveProperty('country')
    })

    it('rejects a blank partnerName without persisting a partner', async () => {
        await expect(createBusinessPartner(WORKSPACE_ID, {
            partnerName: '   ',
            phone: '07500000010',
            address: 'Erbil',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'customer'
        })).rejects.toThrow('Partner name is required')

        expect(await db.business_partners.count()).toBe(0)
    })

    it('persists the compact customer payload as a customer partner', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Quick Customer',
            phone: '07500000012',
            address: 'Erbil',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'customer'
        })

        expect(partner).toMatchObject({
            partnerName: 'Quick Customer',
            phone: '07500000012',
            address: 'Erbil',
            role: 'customer',
            defaultCurrency: 'usd',
            creditLimit: 0
        })
        expect(await db.customers.get(partner.customerFacetId!)).toMatchObject({
            businessPartnerId: partner.id,
            partnerName: 'Quick Customer'
        })
    })

    it('makes newly created customer records accessible to the workspace', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Workspace customer',
            phone: '07500000020',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'customer'
        })

        expect(partner).not.toHaveProperty('staffVisibility')
        expect(partner).not.toHaveProperty('ownerUserId')
        await expect(canAccessBusinessPartnerInLocalCache(
            WORKSPACE_ID,
            partner.id,
            'customer'
        )).resolves.toBe(true)
        await expect(canAccessBusinessPartnerInLocalCache(
            '00000000-0000-4000-8000-000000000099',
            partner.id,
            'customer'
        )).resolves.toBe(false)
    })

    it('lets staff create and access suppliers without a visibility setting', async () => {
        await db.workspaces.put({
            id: WORKSPACE_ID,
            workspaceId: WORKSPACE_ID,
            data_mode: 'local',
            suppliers_admin_only: true
        } as never)

        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Workspace supplier',
            phone: '07500000027',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'supplier'
        })

        expect(partner.role).toBe('supplier')
        await expect(canAccessBusinessPartnerInLocalCache(
            WORKSPACE_ID,
            partner.id,
            'supplier'
        )).resolves.toBe(true)
    })

    it('ignores retired private flags on cached partner rows', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Legacy private customer',
            phone: '07500000028',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'customer'
        })
        await db.business_partners.put({
            ...partner,
            staffVisibility: 'owner_private',
            ownerUserId: '00000000-0000-4000-8000-000000000029'
        } as typeof partner)

        await expect(canAccessBusinessPartnerInLocalCache(
            WORKSPACE_ID,
            partner.id,
            'customer'
        )).resolves.toBe(true)
    })

    it('lets staff update the role of a mixed partner', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Existing mixed partner',
            phone: '07500000024',
            defaultCurrency: 'iqd',
            creditLimit: 250,
            role: 'both'
        })

        await updateBusinessPartner(partner.id, {
            partnerName: 'Updated partner',
            role: 'customer',
            creditLimit: 0,
            payableCreditLimit: null
        })

        expect(await db.business_partners.get(partner.id)).toMatchObject({
            partnerName: 'Updated partner',
            role: 'customer',
            payableCreditLimit: null
        })
    })
    it('creates an agent facet linked to the business partner', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'North Route Agent',
            phone: '07500000000',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'North District',
                agentType: 'field_agent',
                linkedUserId: null,
                status: 'active'
            }
        }, { allowAgentRole: true })

        expect(partner.agentFacetId).toBeTruthy()
        const agent = await db.agents.get(partner.agentFacetId!)
        expect(agent).toMatchObject({
            businessPartnerId: partner.id,
            zone: 'North District',
            agentType: 'field_agent',
            status: 'active'
        })
        expect(agent).not.toHaveProperty('imageUrl')
    })

    it('rejects a driver without vehicle details before persisting the partner', async () => {
        await expect(createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Driver Without Vehicle',
            phone: '07500000001',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'Central District',
                agentType: 'driver',
                status: 'active'
            }
        }, { allowAgentRole: true })).rejects.toThrow('Car model and plate number are required for drivers')

        expect(await db.business_partners.count()).toBe(0)
        expect(await db.agents.count()).toBe(0)
    })

    it('marks the agent facet inactive when the partner changes roles', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Convertible Agent',
            phone: '07500000002',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'West District',
                agentType: 'driver',
                carModel: 'Toyota Hilux',
                plateNumber: '12 A 3456',
                status: 'active'
            }
        }, { allowAgentRole: true })

        const activeAssignment = await db.fleet_vehicle_assignments
            .where('agentId')
            .equals(partner.agentFacetId!)
            .first()
        const vehicle = activeAssignment
            ? await db.fleet_vehicles.get(activeAssignment.vehicleId)
            : undefined
        expect(vehicle).toMatchObject({
            plateNumber: '12 A 3456',
            model: 'Toyota Hilux'
        })
        expect(activeAssignment?.status).toBe('active')

        await updateBusinessPartner(partner.id, { role: 'customer' }, { allowAgentRole: true })

        const agent = await db.agents.get(partner.agentFacetId!)
        expect(agent?.status).toBe('inactive')
        const endedAssignment = await db.fleet_vehicle_assignments.get(activeAssignment!.id)
        expect(endedAssignment?.status).toBe('ended')
        expect(endedAssignment?.endedAt).toBeTruthy()
    })

    it('prevents one workspace user from being linked to multiple agents', async () => {
        const linkedUserId = '00000000-0000-4000-8000-000000000099'
        await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'First Linked Agent',
            phone: '07500000004',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'North District',
                agentType: 'field_agent',
                linkedUserId,
                status: 'active'
            }
        }, { allowAgentRole: true })

        await expect(createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Second Linked Agent',
            phone: '07500000005',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'South District',
                agentType: 'field_agent',
                linkedUserId,
                status: 'active'
            }
        }, { allowAgentRole: true })).rejects.toThrow('Workspace user is already linked to another agent')

        expect(await db.business_partners.count()).toBe(1)
        expect(await db.agents.count()).toBe(1)
    })

    it('rejects reassigning an agent to a workspace user linked elsewhere', async () => {
        const linkedUserId = '00000000-0000-4000-8000-000000000098'
        await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Assigned Agent',
            phone: '07500000006',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'East District',
                agentType: 'field_agent',
                linkedUserId,
                status: 'active'
            }
        }, { allowAgentRole: true })
        const unassignedAgent = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Unassigned Agent',
            phone: '07500000007',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'West District',
                agentType: 'field_agent',
                status: 'active'
            }
        }, { allowAgentRole: true })

        await expect(updateBusinessPartner(unassignedAgent.id, {
            partnerName: 'Must Not Persist',
            agent: { linkedUserId }
        }, { allowAgentRole: true })).rejects.toThrow('Workspace user is already linked to another agent')

        const unchangedPartner = await db.business_partners.get(unassignedAgent.id)
        const unchangedAgent = await db.agents.get(unassignedAgent.agentFacetId!)
        expect(unchangedPartner?.partnerName).toBe('Unassigned Agent')
        expect(unchangedAgent?.linkedUserId).toBeNull()
    })

    it('does not collapse agent and commercial roles during a merge', async () => {
        const agent = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Shared Name',
            phone: '07500000003',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'South District',
                agentType: 'field_agent',
                status: 'active'
            }
        }, { allowAgentRole: true })
        const customer = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Shared Name',
            phone: '07500000003',
            defaultCurrency: 'usd',
            creditLimit: 0,
            role: 'customer'
        })

        await expect(mergeBusinessPartners(agent.id, customer.id))
            .rejects.toThrow('Agents can only be merged with other agents')
    })

    it('hard deletes a removed excluded-category row', async () => {
        const [agentId, categoryId] = await Promise.all([
            createAgentForExcludedCategoryTest(),
            createCategoryForExcludedCategoryTest()
        ])

        await replaceAgentExcludedCategories(WORKSPACE_ID, agentId, [categoryId])
        const exclusion = await db.agent_excluded_categories
            .where('[agentId+categoryId]')
            .equals([agentId, categoryId])
            .first()
        expect(exclusion).toBeDefined()

        await replaceAgentExcludedCategories(WORKSPACE_ID, agentId, [])

        expect(await db.agent_excluded_categories.get(exclusion!.id)).toBeUndefined()
        expect(await db.agent_excluded_categories.where('agentId').equals(agentId).count()).toBe(0)
    })

    it('queues a hard delete for a removed cloud exclusion while offline', async () => {
        const [agentId, categoryId] = await Promise.all([
            createAgentForExcludedCategoryTest(),
            createCategoryForExcludedCategoryTest()
        ])
        const now = new Date().toISOString()
        const exclusionId = '00000000-0000-4000-8000-000000000011'
        await db.agent_excluded_categories.add({
            id: exclusionId,
            workspaceId: WORKSPACE_ID,
            agentId,
            categoryId,
            createdAt: now,
            updatedAt: now,
            syncStatus: 'synced',
            lastSyncedAt: now,
            version: 1,
            isDeleted: false
        })

        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
        setNetworkStatus(false)
        await replaceAgentExcludedCategories(WORKSPACE_ID, agentId, [])

        expect(await db.agent_excluded_categories.get(exclusionId)).toBeUndefined()
        expect(await db.offline_mutations
            .where('[entityType+entityId+status]')
            .equals(['agent_excluded_categories', exclusionId, 'pending'])
            .first())
            .toMatchObject({
                operation: 'delete',
                payload: { id: exclusionId, hardDelete: true }
            })
    })

    it('queues an agent retirement with its business-partner reference', async () => {
        const partner = await createBusinessPartner(WORKSPACE_ID, {
            partnerName: 'Agent to retire',
            phone: '07500000009',
            defaultCurrency: 'iqd',
            creditLimit: 0,
            role: 'agent',
            agent: {
                zone: 'Central District',
                agentType: 'field_agent',
                status: 'active'
            }
        }, { allowAgentRole: true })

        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
        setNetworkStatus(false)
        await deleteBusinessPartner(partner.id)

        const queued = await db.offline_mutations
            .where('workspaceId')
            .equals(WORKSPACE_ID)
            .toArray()
        const agentMutation = queued.find((mutation) => mutation.entityType === 'agents')
        const partnerMutation = queued.find((mutation) => mutation.entityType === 'business_partners')

        expect(agentMutation).toMatchObject({
            operation: 'delete',
            payload: { id: partner.agentFacetId, businessPartnerId: partner.id }
        })
        expect(partnerMutation).toMatchObject({
            operation: 'delete',
            payload: { id: partner.id }
        })
    })
})
