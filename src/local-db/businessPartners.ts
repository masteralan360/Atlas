import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { convertCurrencyAmountWithSnapshot } from '@/lib/orderCurrency'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { getTravelSaleCost } from '@/lib/travelAgency'
import { generateId, toCamelCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { fetchTableFromSupabase } from './hooks'
import { addToOfflineMutations } from './offlineMutations'
import type {
    BusinessPartner,
    BusinessPartnerMergeCandidate,
    BusinessPartnerRole,
    CurrencyCode,
    Customer,
    Loan,
    PurchaseOrder,
    SalesOrder,
    Supplier,
    TravelAgencySale
} from './models'

type PartnerTableName = 'business_partners' | 'business_partner_merge_candidates' | 'customers' | 'suppliers'
type PartnerFacetType = 'customer' | 'supplier'
type SyncEntity = { id: string; version: number } & Record<string, unknown>
type PartnerFilterOptions = {
    roles?: BusinessPartnerRole[]
    includeMerged?: boolean
}

type BaseEntityPayload = {
    id: string
    workspaceId: string
    createdAt: string
    updatedAt: string
    syncStatus: 'pending' | 'synced' | 'conflict'
    lastSyncedAt: string | null
    version: number
    isDeleted: boolean
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

async function runMutation<T>(label: string, promiseFactory: () => PromiseLike<T>): Promise<T> {
    return runSupabaseAction(label, promiseFactory)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return {
            syncStatus: 'synced' as const,
            lastSyncedAt: timestamp
        }
    }

    return {
        syncStatus: 'pending' as const,
        lastSyncedAt: null
    }
}

function roundAmount(amount: number, currency: CurrencyCode) {
    if (currency === 'iqd') {
        return Math.round(amount)
    }

    return Math.round(amount * 100) / 100
}

function getMergeCandidateKey(
    primaryPartnerId: string,
    secondaryPartnerId: string,
    mergeType: BusinessPartnerMergeCandidate['mergeType'] = 'customer_supplier'
) {
    return `${primaryPartnerId}:${secondaryPartnerId}:${mergeType}`
}

function getMergeCandidateKeyFromEntity(
    entity: Pick<BusinessPartnerMergeCandidate, 'primaryPartnerId' | 'secondaryPartnerId' | 'mergeType'>
) {
    return getMergeCandidateKey(entity.primaryPartnerId, entity.secondaryPartnerId, entity.mergeType)
}

function getMergeCandidateSyncPriority(candidate: Pick<BusinessPartnerMergeCandidate, 'syncStatus' | 'version' | 'updatedAt' | 'isDeleted'>) {
    const syncRank = candidate.syncStatus === 'synced'
        ? 2
        : candidate.syncStatus === 'pending'
            ? 1
            : 0
    const updatedRank = Date.parse(candidate.updatedAt || '') || 0

    return [
        candidate.isDeleted ? 0 : 1,
        syncRank,
        candidate.version,
        updatedRank
    ]
}

function preferMergeCandidate(
    left: BusinessPartnerMergeCandidate,
    right: BusinessPartnerMergeCandidate
) {
    const leftPriority = getMergeCandidateSyncPriority(left)
    const rightPriority = getMergeCandidateSyncPriority(right)

    for (let index = 0; index < leftPriority.length; index += 1) {
        if (leftPriority[index] === rightPriority[index]) {
            continue
        }

        return leftPriority[index] > rightPriority[index] ? left : right
    }

    return left
}

async function removeOfflineMutationsForEntityIds(tableName: PartnerTableName, entityIds: string[]) {
    if (entityIds.length === 0) {
        return
    }

    const rows = await db.offline_mutations
        .where('entityId')
        .anyOf(entityIds)
        .and((item) => item.entityType === tableName)
        .toArray()

    if (rows.length > 0) {
        await db.offline_mutations.bulkDelete(rows.map((row) => row.id))
    }
}

function sanitizeSyncPayload(entity: Record<string, unknown>) {
    const payload = { ...entity }
    delete payload.syncStatus
    delete payload.lastSyncedAt

    return Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
            value
        ])
    )
}

async function markEntitiesSynced(tableName: PartnerTableName, ids: string[]) {
    const syncedAt = new Date().toISOString()
    const table = (db as unknown as Record<string, { update: (id: string, changes: Record<string, unknown>) => Promise<number> }>)[tableName]
    await Promise.all(ids.map((id) => table.update(id, { syncStatus: 'synced', lastSyncedAt: syncedAt })))
}

async function queueOfflineUpserts(tableName: PartnerTableName, entities: SyncEntity[], workspaceId: string) {
    await Promise.all(entities.map((entity) =>
        addToOfflineMutations(
            tableName,
            entity.id,
            entity.version > 1 ? 'update' : 'create',
            entity,
            workspaceId
        )
    ))
}

async function syncUpsertEntities(tableName: PartnerTableName, entities: SyncEntity[], workspaceId: string) {
    if (!entities.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline(workspaceId)) {
        await queueOfflineUpserts(tableName, entities, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const payload = entities.map((entity) => sanitizeSyncPayload(entity))

        if (tableName === 'business_partner_merge_candidates') {
            const mergeEntities = entities as unknown as BusinessPartnerMergeCandidate[]
            const dedupedEntities = Array.from(
                new Map(
                    mergeEntities.map((entity) => [getMergeCandidateKeyFromEntity(entity), entity])
                ).values()
            )
            const dedupedPayload = dedupedEntities.map((entity) => sanitizeSyncPayload(entity as unknown as SyncEntity))
            const { data, error } = await runMutation(`${tableName}.sync`, () =>
                client
                    .from(tableName)
                    .upsert(dedupedPayload, { onConflict: 'primary_partner_id,secondary_partner_id,merge_type' })
                    .select('*')
            )
            if (error) {
                throw error
            }

            const syncedAt = new Date().toISOString()
            const remoteRows = ((data || []) as Record<string, unknown>[])
                .map((row) => ({
                    ...(toCamelCase(row) as unknown as BusinessPartnerMergeCandidate),
                    syncStatus: 'synced' as const,
                    lastSyncedAt: syncedAt
                }))
            const remoteByKey = new Map(remoteRows.map((row) => [getMergeCandidateKeyFromEntity(row), row]))
            const replacedLocalIds: string[] = []

            await db.transaction('rw', [db.business_partner_merge_candidates, db.offline_mutations], async () => {
                for (const entity of dedupedEntities) {
                    const remote = remoteByKey.get(getMergeCandidateKeyFromEntity(entity))

                    if (!remote) {
                        await db.business_partner_merge_candidates.update(entity.id, {
                            syncStatus: 'synced',
                            lastSyncedAt: syncedAt
                        })
                        continue
                    }

                    await db.business_partner_merge_candidates.put(remote)

                    if (remote.id !== entity.id) {
                        replacedLocalIds.push(entity.id)
                    }
                }

                if (replacedLocalIds.length > 0) {
                    await db.business_partner_merge_candidates.bulkDelete(replacedLocalIds)
                    await removeOfflineMutationsForEntityIds(tableName, replacedLocalIds)
                }
            })

            return
        }

        const { error } = await runMutation(`${tableName}.sync`, () => client.from(tableName).upsert(payload))
        if (error) {
            throw error
        }

        await markEntitiesSynced(tableName, entities.map((entity) => entity.id))
    } catch (error) {
        console.error(`[BusinessPartners] Failed to sync ${tableName}:`, error)
        await queueOfflineUpserts(tableName, entities, workspaceId)
    }
}

async function syncSoftDelete(tableName: PartnerTableName, entityId: string, workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline(workspaceId)) {
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId }, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable(tableName)
        const { error } = await runMutation(`${tableName}.delete`, () =>
            client
                .from(tableName)
                .update({ is_deleted: true, updated_at: new Date().toISOString() })
                .eq('id', entityId)
        )
        if (error) {
            throw error
        }

        await markEntitiesSynced(tableName, [entityId])
    } catch (error) {
        console.error(`[BusinessPartners] Failed to delete ${tableName}:`, error)
        await addToOfflineMutations(tableName, entityId, 'delete', { id: entityId }, workspaceId)
    }
}

function buildBaseEntity<T extends Record<string, unknown>>(workspaceId: string, data: T): T & BaseEntityPayload {
    const now = new Date().toISOString()

    return {
        ...data,
        id: generateId(),
        workspaceId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }
}

function normalizeMatchValue(value?: string | null) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function roleIncludesCustomer(role: BusinessPartnerRole) {
    return role === 'customer' || role === 'both'
}

function roleIncludesSupplier(role: BusinessPartnerRole) {
    return role === 'supplier' || role === 'both'
}

function nextRoleWithFacet(role: BusinessPartnerRole, facetType: PartnerFacetType): BusinessPartnerRole {
    if (facetType === 'customer') {
        return role === 'supplier' ? 'both' : role
    }

    return role === 'customer' ? 'both' : role
}

function partnerToCustomer(partner: BusinessPartner): Customer {
    return {
        id: partner.id,
        workspaceId: partner.workspaceId,
        businessPartnerId: partner.id,
        name: partner.name,
        email: partner.email,
        phone: partner.phone,
        address: partner.address,
        city: partner.city,
        country: partner.country,
        defaultCurrency: partner.defaultCurrency,
        notes: partner.notes,
        totalOrders: partner.totalSalesOrders,
        totalSpent: partner.totalSalesValue,
        outstandingBalance: partner.receivableBalance,
        creditLimit: partner.creditLimit,
        isEcommerce: partner.isEcommerce ?? false,
        createdAt: partner.createdAt,
        updatedAt: partner.updatedAt,
        syncStatus: partner.syncStatus,
        lastSyncedAt: partner.lastSyncedAt,
        version: partner.version,
        isDeleted: partner.isDeleted
    }
}

function partnerToSupplier(partner: BusinessPartner): Supplier {
    return {
        id: partner.id,
        workspaceId: partner.workspaceId,
        businessPartnerId: partner.id,
        name: partner.name,
        contactName: partner.contactName,
        email: partner.email,
        phone: partner.phone,
        address: partner.address,
        city: partner.city,
        country: partner.country,
        defaultCurrency: partner.defaultCurrency,
        notes: partner.notes,
        totalPurchases: partner.totalPurchaseOrders,
        totalSpent: partner.totalPurchaseValue,
        creditLimit: partner.creditLimit,
        isEcommerce: partner.isEcommerce ?? false,
        createdAt: partner.createdAt,
        updatedAt: partner.updatedAt,
        syncStatus: partner.syncStatus,
        lastSyncedAt: partner.lastSyncedAt,
        version: partner.version,
        isDeleted: partner.isDeleted
    }
}

async function getPartnerByAnyId(id: string) {
    const direct = await db.business_partners.get(id)
    if (direct && !direct.isDeleted) {
        return direct
    }

    const customerFacet = await db.customers.get(id)
    if (customerFacet?.businessPartnerId) {
        const customerPartner = await db.business_partners.get(customerFacet.businessPartnerId)
        if (customerPartner && !customerPartner.isDeleted) {
            return customerPartner
        }
    }

    const supplierFacet = await db.suppliers.get(id)
    if (supplierFacet?.businessPartnerId) {
        const supplierPartner = await db.business_partners.get(supplierFacet.businessPartnerId)
        if (supplierPartner && !supplierPartner.isDeleted) {
            return supplierPartner
        }
    }

    return undefined
}

export async function getBusinessPartnerByAnyId(id: string) {
    return getPartnerByAnyId(id)
}

async function syncCustomerFacet(customer: Customer) {
    await db.customers.put(customer)
    await syncUpsertEntities('customers', [customer as unknown as SyncEntity], customer.workspaceId)
}

async function syncSupplierFacet(supplier: Supplier) {
    await db.suppliers.put(supplier)
    await syncUpsertEntities('suppliers', [supplier as unknown as SyncEntity], supplier.workspaceId)
}

async function mirrorPartnerToFacets(partner: BusinessPartner) {
    const updates: Promise<void>[] = []

    if (partner.customerFacetId) {
        const customer = await db.customers.get(partner.customerFacetId)
        if (customer && !customer.isDeleted) {
            const mirroredCustomer: Customer = {
                ...customer,
                businessPartnerId: partner.id,
                name: partner.name,
                email: partner.email,
                phone: partner.phone,
                address: partner.address,
                city: partner.city,
                country: partner.country,
                defaultCurrency: partner.defaultCurrency,
                notes: partner.notes,
                creditLimit: partner.creditLimit,
                isEcommerce: partner.isEcommerce ?? customer.isEcommerce ?? false,
                updatedAt: partner.updatedAt,
                version: Math.max(customer.version + 1, partner.version),
                ...getSyncMetadata(partner.workspaceId, partner.updatedAt)
            }
            updates.push(syncCustomerFacet(mirroredCustomer))
        }
    }

    if (partner.supplierFacetId) {
        const supplier = await db.suppliers.get(partner.supplierFacetId)
        if (supplier && !supplier.isDeleted) {
            const mirroredSupplier: Supplier = {
                ...supplier,
                businessPartnerId: partner.id,
                name: partner.name,
                contactName: partner.contactName,
                email: partner.email,
                phone: partner.phone,
                address: partner.address,
                city: partner.city,
                country: partner.country,
                defaultCurrency: partner.defaultCurrency,
                notes: partner.notes,
                creditLimit: partner.creditLimit,
                isEcommerce: partner.isEcommerce ?? supplier.isEcommerce ?? false,
                updatedAt: partner.updatedAt,
                version: Math.max(supplier.version + 1, partner.version),
                ...getSyncMetadata(partner.workspaceId, partner.updatedAt)
            }
            updates.push(syncSupplierFacet(mirroredSupplier))
        }
    }

    await Promise.all(updates)
}
async function getPartnerSalesOrders(partner: BusinessPartner) {
    const rows = await db.sales_orders.where('workspaceId').equals(partner.workspaceId).and((item) => {
        if (item.isDeleted) {
            return false
        }

        if (item.businessPartnerId && item.businessPartnerId === partner.id) {
            return true
        }

        return Boolean(partner.customerFacetId && item.customerId === partner.customerFacetId)
    }).toArray()

    return rows as SalesOrder[]
}

async function getPartnerPurchaseOrders(partner: BusinessPartner) {
    const rows = await db.purchase_orders.where('workspaceId').equals(partner.workspaceId).and((item) => {
        if (item.isDeleted) {
            return false
        }

        if (item.businessPartnerId && item.businessPartnerId === partner.id) {
            return true
        }

        return Boolean(partner.supplierFacetId && item.supplierId === partner.supplierFacetId)
    }).toArray()

    return rows as PurchaseOrder[]
}

async function getPartnerTravelSales(partner: BusinessPartner) {
    const rows = await db.travel_agency_sales.where('workspaceId').equals(partner.workspaceId).and((item) => {
        if (item.isDeleted) {
            return false
        }

        if (item.businessPartnerId && item.businessPartnerId === partner.id) {
            return true
        }

        return Boolean(partner.supplierFacetId && item.supplierId === partner.supplierFacetId)
    }).toArray()

    return rows as TravelAgencySale[]
}

async function getPartnerLoans(partner: BusinessPartner) {
    const rows = await db.loans.where('workspaceId').equals(partner.workspaceId).and((item) => {
        if (item.isDeleted) {
            return false
        }

        return item.linkedPartyType === 'business_partner' && item.linkedPartyId === partner.id
    }).toArray()

    return rows as Loan[]
}

export async function recalculateBusinessPartnerSummary(workspaceId: string, partnerId: string) {
    const partner = await db.business_partners.get(partnerId)
    if (!partner || partner.isDeleted) {
        return partner
    }

    const [salesOrders, purchaseOrders, travelSales, loans] = await Promise.all([
        getPartnerSalesOrders(partner),
        getPartnerPurchaseOrders(partner),
        getPartnerTravelSales(partner),
        getPartnerLoans(partner)
    ])

    const activeSalesOrders = salesOrders.filter((order) => order.status !== 'cancelled')
    const activePurchaseOrders = purchaseOrders.filter((order) => order.status !== 'cancelled')
    const activeTravelSales = travelSales.filter((sale) => sale.status === 'completed')
    const activeLentLoans = loans.filter((loan) =>
        loan.balanceAmount > 0
        && loan.status !== 'completed'
        && (loan.direction ?? 'lent') !== 'borrowed'
    )
    const activeBorrowedLoans = loans.filter((loan) =>
        loan.balanceAmount > 0
        && loan.status !== 'completed'
        && loan.direction === 'borrowed'
    )

    const totalSalesOrders = activeSalesOrders.length
    const totalSalesValue = roundAmount(
        activeSalesOrders
            .filter((order) => order.status === 'completed')
            .reduce(
                (sum, order) => sum + convertCurrencyAmountWithSnapshot(order.total, order.currency, partner.defaultCurrency, order.exchangeRates),
                0
            ),
        partner.defaultCurrency
    )
    const receivableBalance = roundAmount(
        activeSalesOrders
            .filter((order) => (order.status === 'pending' || order.status === 'completed') && !order.isPaid)
            .reduce(
                (sum, order) => sum + convertCurrencyAmountWithSnapshot(order.total, order.currency, partner.defaultCurrency, order.exchangeRates),
                0
            ),
        partner.defaultCurrency
    )

    const purchaseOrderValue = activePurchaseOrders
        .filter((order) => order.status === 'received' || order.status === 'completed')
        .reduce(
            (sum, order) => sum + convertCurrencyAmountWithSnapshot(order.total, order.currency, partner.defaultCurrency, order.exchangeRates),
            0
        )
    const travelSaleValue = activeTravelSales.reduce(
        (sum, sale) => sum + convertCurrencyAmountWithSnapshot(
            getTravelSaleCost(sale),
            sale.currency,
            partner.defaultCurrency,
            sale.exchangeRateSnapshot ? [sale.exchangeRateSnapshot] as any : undefined
        ),
        0
    )
    const totalPurchaseOrders = activePurchaseOrders.length + activeTravelSales.length
    const totalPurchaseValue = roundAmount(purchaseOrderValue + travelSaleValue, partner.defaultCurrency)
    const payableBalance = roundAmount(
        activePurchaseOrders
            .filter((order) => (order.status === 'ordered' || order.status === 'received' || order.status === 'completed') && !order.isPaid)
            .reduce(
                (sum, order) => sum + convertCurrencyAmountWithSnapshot(order.total, order.currency, partner.defaultCurrency, order.exchangeRates),
                0
            )
            + activeTravelSales
                .filter((sale) => !sale.isPaid)
                .reduce(
                    (sum, sale) => sum + convertCurrencyAmountWithSnapshot(
                        getTravelSaleCost(sale),
                        sale.currency,
                        partner.defaultCurrency,
                        sale.exchangeRateSnapshot ? [sale.exchangeRateSnapshot] as any : undefined
                    ),
                    0
                )
            + activeBorrowedLoans.reduce(
                (sum, loan) => sum + convertCurrencyAmountWithSnapshot(loan.balanceAmount, loan.settlementCurrency, partner.defaultCurrency),
                0
            ),
        partner.defaultCurrency
    )

    const totalLoanCount = loans.length
    const loanOutstandingBalance = roundAmount(
        activeLentLoans.reduce((sum, loan) => sum + convertCurrencyAmountWithSnapshot(loan.balanceAmount, loan.settlementCurrency, partner.defaultCurrency), 0),
        partner.defaultCurrency
    )
    const netExposure = roundAmount(receivableBalance + loanOutstandingBalance - payableBalance, partner.defaultCurrency)

    if (
        partner.totalSalesOrders === totalSalesOrders
        && partner.totalSalesValue === totalSalesValue
        && partner.receivableBalance === receivableBalance
        && partner.totalPurchaseOrders === totalPurchaseOrders
        && partner.totalPurchaseValue === totalPurchaseValue
        && partner.payableBalance === payableBalance
        && partner.totalLoanCount === totalLoanCount
        && partner.loanOutstandingBalance === loanOutstandingBalance
        && partner.netExposure === netExposure
    ) {
        return partner
    }

    const now = new Date().toISOString()
    const updated: BusinessPartner = {
        ...partner,
        totalSalesOrders,
        totalSalesValue,
        receivableBalance,
        totalPurchaseOrders,
        totalPurchaseValue,
        payableBalance,
        totalLoanCount,
        loanOutstandingBalance,
        netExposure,
        updatedAt: now,
        version: partner.version + 1,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.business_partners.put(updated)
    await syncUpsertEntities('business_partners', [updated as unknown as SyncEntity], workspaceId)
    return updated
}

export async function recalculateAllBusinessPartnerSummaries(workspaceId: string) {
    const partners = await db.business_partners.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted && !item.mergedIntoBusinessPartnerId).toArray()
    await Promise.all(partners.map((partner) => recalculateBusinessPartnerSummary(workspaceId, partner.id)))
}

async function countSupplierHistory(partner: BusinessPartner) {
    const [purchaseOrders, travelSales] = await Promise.all([
        getPartnerPurchaseOrders(partner),
        getPartnerTravelSales(partner)
    ])

    return purchaseOrders.length + travelSales.length
}

async function countCustomerHistory(partner: BusinessPartner) {
    const [salesOrders, loans] = await Promise.all([
        getPartnerSalesOrders(partner),
        getPartnerLoans(partner)
    ])

    return salesOrders.length + loans.length
}

async function assertRoleRemovalAllowed(partner: BusinessPartner, nextRole: BusinessPartnerRole) {
    if (roleIncludesCustomer(partner.role) && !roleIncludesCustomer(nextRole)) {
        const customerHistory = await countCustomerHistory(partner)
        if (customerHistory > 0) {
            throw new Error('Cannot remove customer role while sales orders or loans exist')
        }
    }

    if (roleIncludesSupplier(partner.role) && !roleIncludesSupplier(nextRole)) {
        const supplierHistory = await countSupplierHistory(partner)
        if (supplierHistory > 0) {
            throw new Error('Cannot remove supplier role while purchase or travel transactions exist')
        }
    }
}

async function createFacetFromPartner(partner: BusinessPartner, facetType: PartnerFacetType) {
    const base = buildBaseEntity(partner.workspaceId, {
        businessPartnerId: partner.id,
        name: partner.name,
        email: partner.email,
        phone: partner.phone,
        address: partner.address,
        city: partner.city,
        country: partner.country,
        defaultCurrency: partner.defaultCurrency,
        notes: partner.notes,
        creditLimit: partner.creditLimit,
        isEcommerce: partner.isEcommerce ?? false
    })

    if (facetType === 'customer') {
        const customer: Customer = {
            ...base,
            totalOrders: 0,
            totalSpent: 0,
            outstandingBalance: 0
        }
        await syncCustomerFacet(customer)
        return customer
    }

    const supplier: Supplier = {
        ...base,
        contactName: partner.contactName,
        totalPurchases: 0,
        totalSpent: 0
    }
    await syncSupplierFacet(supplier)
    return supplier
}
export async function ensurePartnerFacet(partnerId: string, facetType: PartnerFacetType) {
    const partner = await db.business_partners.get(partnerId)
    if (!partner || partner.isDeleted || partner.mergedIntoBusinessPartnerId) {
        throw new Error('Business partner not found')
    }

    if (facetType === 'customer' && partner.customerFacetId) {
        const existing = await db.customers.get(partner.customerFacetId)
        if (existing && !existing.isDeleted) {
            return existing
        }
    }

    if (facetType === 'supplier' && partner.supplierFacetId) {
        const existing = await db.suppliers.get(partner.supplierFacetId)
        if (existing && !existing.isDeleted) {
            return existing
        }
    }

    const facet = await createFacetFromPartner(partner, facetType)
    const now = new Date().toISOString()
    const updatedPartner: BusinessPartner = {
        ...partner,
        role: nextRoleWithFacet(partner.role, facetType),
        customerFacetId: facetType === 'customer' ? facet.id : partner.customerFacetId,
        supplierFacetId: facetType === 'supplier' ? facet.id : partner.supplierFacetId,
        updatedAt: now,
        version: partner.version + 1,
        ...getSyncMetadata(partner.workspaceId, now)
    }

    await db.business_partners.put(updatedPartner)
    await syncUpsertEntities('business_partners', [updatedPartner as unknown as SyncEntity], partner.workspaceId)
    return facet
}

async function refreshBusinessPartnerMergeCandidates(workspaceId: string) {
    const partners = await db.business_partners.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted && !item.mergedIntoBusinessPartnerId).toArray()
    const currentCandidates = await db.business_partner_merge_candidates.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
    const currentByKey = new Map<string, BusinessPartnerMergeCandidate>()
    const duplicateCandidateIds: string[] = []
    const nextRows: BusinessPartnerMergeCandidate[] = []

    for (const candidate of currentCandidates) {
        const key = getMergeCandidateKeyFromEntity(candidate)
        const existing = currentByKey.get(key)
        if (!existing) {
            currentByKey.set(key, candidate)
            continue
        }

        const preferred = preferMergeCandidate(existing, candidate)
        currentByKey.set(key, preferred)
        duplicateCandidateIds.push(preferred.id === existing.id ? candidate.id : existing.id)
    }

    if (duplicateCandidateIds.length > 0) {
        await db.transaction('rw', [db.business_partner_merge_candidates, db.offline_mutations], async () => {
            await db.business_partner_merge_candidates.bulkDelete(duplicateCandidateIds)
            await removeOfflineMutationsForEntityIds('business_partner_merge_candidates', duplicateCandidateIds)
        })
    }

    const customerPartners = partners.filter((partner) => roleIncludesCustomer(partner.role))
    const supplierPartners = partners.filter((partner) => roleIncludesSupplier(partner.role))

    for (const customerPartner of customerPartners) {
        const customerName = normalizeMatchValue(customerPartner.name)
        const customerPhone = normalizeMatchValue(customerPartner.phone)
        const customerEmail = normalizeMatchValue(customerPartner.email)

        for (const supplierPartner of supplierPartners) {
            if (customerPartner.id === supplierPartner.id) {
                continue
            }

            const supplierName = normalizeMatchValue(supplierPartner.name)
            const supplierPhone = normalizeMatchValue(supplierPartner.phone)
            const supplierEmail = normalizeMatchValue(supplierPartner.email)
            const exactName = customerName && customerName === supplierName
            const phoneMatch = customerPhone && customerPhone === supplierPhone
            const emailMatch = customerEmail && customerEmail === supplierEmail

            if (!exactName && !phoneMatch && !emailMatch) {
                continue
            }

            const existing = currentByKey.get(getMergeCandidateKey(customerPartner.id, supplierPartner.id))
            const reasons = [
                exactName ? 'matching name' : '',
                phoneMatch ? 'matching phone' : '',
                emailMatch ? 'matching email' : ''
            ].filter(Boolean)
            const confidence = exactName && (phoneMatch || emailMatch)
                ? 0.98
                : exactName
                    ? 0.86
                    : 0.78
            const timestamp = new Date().toISOString()

            nextRows.push({
                ...(existing || buildBaseEntity(workspaceId, {
                    primaryPartnerId: customerPartner.id,
                    secondaryPartnerId: supplierPartner.id,
                    mergeType: 'customer_supplier',
                    reason: reasons.join(', '),
                    confidence,
                    status: 'pending'
                })),
                workspaceId,
                primaryPartnerId: customerPartner.id,
                secondaryPartnerId: supplierPartner.id,
                mergeType: 'customer_supplier',
                reason: reasons.join(', '),
                confidence,
                status: existing?.status || 'pending',
                updatedAt: timestamp,
                version: (existing?.version || 0) + 1,
                ...getSyncMetadata(workspaceId, timestamp)
            } as BusinessPartnerMergeCandidate)
        }
    }

    if (nextRows.length > 0) {
        await db.business_partner_merge_candidates.bulkPut(nextRows)
        await syncUpsertEntities('business_partner_merge_candidates', nextRows as unknown as SyncEntity[], workspaceId)
    }
}

export function useBusinessPartners(workspaceId: string | undefined, filters?: PartnerFilterOptions) {
    const online = useNetworkStatus()

    const partners = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.business_partners.where('workspaceId').equals(workspaceId).and((item) => {
                if (item.isDeleted) {
                    return false
                }

                if (!filters?.includeMerged && item.mergedIntoBusinessPartnerId) {
                    return false
                }

                if (filters?.roles?.length) {
                    return filters.roles.some((role) => item.role === role || (item.role === 'both' && (role === 'customer' || role === 'supplier')))
                }

                return true
            }).toArray()
            return rows.sort((a, b) => a.name.localeCompare(b.name))
        },
        [workspaceId, JSON.stringify(filters || {})]
    )

    useEffect(() => {
        if (!workspaceId) {
            return
        }

        const hydrate = async () => {
            if (online && shouldUseCloudBusinessData(workspaceId)) {
                await Promise.all([
                    fetchTableFromSupabase('business_partners', db.business_partners, workspaceId),
                    fetchTableFromSupabase('business_partner_merge_candidates', db.business_partner_merge_candidates, workspaceId),
                    fetchTableFromSupabase('customers', db.customers, workspaceId),
                    fetchTableFromSupabase('suppliers', db.suppliers, workspaceId),
                    fetchTableFromSupabase('sales_orders', db.sales_orders, workspaceId),
                    fetchTableFromSupabase('purchase_orders', db.purchase_orders, workspaceId),
                    fetchTableFromSupabase('travel_agency_sales', db.travel_agency_sales, workspaceId),
                    fetchTableFromSupabase('loans', db.loans, workspaceId)
                ])
            }

            await recalculateAllBusinessPartnerSummaries(workspaceId)
            await refreshBusinessPartnerMergeCandidates(workspaceId)
        }

        void hydrate().catch((error) => {
            console.error('[BusinessPartners] Failed to hydrate partners:', error)
        })
    }, [online, workspaceId])

    return partners ?? []
}

export function useBusinessPartner(partnerId: string | undefined) {
    return useLiveQuery(() => partnerId ? getPartnerByAnyId(partnerId) : undefined, [partnerId])
}

export function useBusinessPartnerMergeCandidates(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const candidates = useLiveQuery(
        async () => {
            if (!workspaceId) return []
            const rows = await db.business_partner_merge_candidates.where('workspaceId').equals(workspaceId).and((item) => !item.isDeleted).toArray()
            return rows.sort((a, b) => b.confidence - a.confidence)
        },
        [workspaceId]
    )

    useEffect(() => {
        if (!workspaceId) {
            return
        }

        const hydrate = async () => {
            if (online && shouldUseCloudBusinessData(workspaceId)) {
                await fetchTableFromSupabase('business_partner_merge_candidates', db.business_partner_merge_candidates, workspaceId)
            }
            await refreshBusinessPartnerMergeCandidates(workspaceId)
        }

        void hydrate().catch((error) => {
            console.error('[BusinessPartners] Failed to hydrate merge candidates:', error)
        })
    }, [online, workspaceId])

    return candidates ?? []
}

export async function createBusinessPartner(
    workspaceId: string,
    data: Omit<BusinessPartner, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'customerFacetId' | 'supplierFacetId' | 'totalSalesOrders' | 'totalSalesValue' | 'receivableBalance' | 'totalPurchaseOrders' | 'totalPurchaseValue' | 'payableBalance' | 'totalLoanCount' | 'loanOutstandingBalance' | 'netExposure' | 'mergedIntoBusinessPartnerId'>
) {
    const partner = buildBaseEntity(workspaceId, {
        ...data,
        isEcommerce: data.isEcommerce ?? false,
        customerFacetId: null,
        supplierFacetId: null,
        totalSalesOrders: 0,
        totalSalesValue: 0,
        receivableBalance: 0,
        totalPurchaseOrders: 0,
        totalPurchaseValue: 0,
        payableBalance: 0,
        totalLoanCount: 0,
        loanOutstandingBalance: 0,
        netExposure: 0,
        mergedIntoBusinessPartnerId: null
    }) as BusinessPartner

    await db.business_partners.put(partner)
    await syncUpsertEntities('business_partners', [partner as unknown as SyncEntity], workspaceId)

    let workingPartner = partner
    if (roleIncludesCustomer(partner.role)) {
        const customer = await createFacetFromPartner(workingPartner, 'customer')
        workingPartner = {
            ...workingPartner,
            customerFacetId: customer.id
        }
    }
    if (roleIncludesSupplier(partner.role)) {
        const supplier = await createFacetFromPartner(workingPartner, 'supplier')
        workingPartner = {
            ...workingPartner,
            supplierFacetId: supplier.id
        }
    }

    if (workingPartner.customerFacetId !== partner.customerFacetId || workingPartner.supplierFacetId !== partner.supplierFacetId) {
        const now = new Date().toISOString()
        workingPartner = {
            ...workingPartner,
            updatedAt: now,
            version: workingPartner.version + 1,
            ...getSyncMetadata(workspaceId, now)
        }
        await db.business_partners.put(workingPartner)
        await syncUpsertEntities('business_partners', [workingPartner as unknown as SyncEntity], workspaceId)
    }

    await refreshBusinessPartnerMergeCandidates(workspaceId)
    return workingPartner
}

export async function updateBusinessPartner(id: string, data: Partial<BusinessPartner>) {
    const existing = await getPartnerByAnyId(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Business partner not found')
    }

    const nextRole = (data.role || existing.role) as BusinessPartnerRole
    await assertRoleRemovalAllowed(existing, nextRole)

    const now = new Date().toISOString()
    let updated: BusinessPartner = {
        ...existing,
        ...data,
        role: nextRole,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.business_partners.put(updated)
    await syncUpsertEntities('business_partners', [updated as unknown as SyncEntity], existing.workspaceId)

    if (roleIncludesCustomer(nextRole) && !updated.customerFacetId) {
        const customer = await createFacetFromPartner(updated, 'customer')
        updated = {
            ...updated,
            customerFacetId: customer.id,
            role: nextRoleWithFacet(updated.role, 'customer')
        }
    }

    if (roleIncludesSupplier(nextRole) && !updated.supplierFacetId) {
        const supplier = await createFacetFromPartner(updated, 'supplier')
        updated = {
            ...updated,
            supplierFacetId: supplier.id,
            role: nextRoleWithFacet(updated.role, 'supplier')
        }
    }

    if (updated.customerFacetId !== existing.customerFacetId || updated.supplierFacetId !== existing.supplierFacetId) {
        const timestamp = new Date().toISOString()
        updated = {
            ...updated,
            updatedAt: timestamp,
            version: updated.version + 1,
            ...getSyncMetadata(existing.workspaceId, timestamp)
        }
        await db.business_partners.put(updated)
        await syncUpsertEntities('business_partners', [updated as unknown as SyncEntity], existing.workspaceId)
    }

    await mirrorPartnerToFacets(updated)
    await recalculateBusinessPartnerSummary(existing.workspaceId, updated.id)
    await refreshBusinessPartnerMergeCandidates(existing.workspaceId)
    return updated
}

export async function deleteBusinessPartner(id: string) {
    const partner = await getPartnerByAnyId(id)
    if (!partner || partner.isDeleted) {
        return
    }

    const [salesOrders, purchaseOrders, travelSales, loans] = await Promise.all([
        getPartnerSalesOrders(partner),
        getPartnerPurchaseOrders(partner),
        getPartnerTravelSales(partner),
        getPartnerLoans(partner)
    ])

    if (salesOrders.length > 0 || purchaseOrders.length > 0 || travelSales.length > 0 || loans.length > 0) {
        throw new Error('Business partner with transaction history cannot be deleted')
    }

    const now = new Date().toISOString()
    const deletedPartner: BusinessPartner = {
        ...partner,
        isDeleted: true,
        updatedAt: now,
        version: partner.version + 1,
        ...getSyncMetadata(partner.workspaceId, now)
    }
    await db.business_partners.put(deletedPartner)
    await syncSoftDelete('business_partners', deletedPartner.id, deletedPartner.workspaceId)

    if (partner.customerFacetId) {
        const customer = await db.customers.get(partner.customerFacetId)
        if (customer && !customer.isDeleted) {
            await db.customers.put({
                ...customer,
                isDeleted: true,
                updatedAt: now,
                version: customer.version + 1,
                ...getSyncMetadata(customer.workspaceId, now)
            })
            await syncSoftDelete('customers', customer.id, customer.workspaceId)
        }
    }

    if (partner.supplierFacetId) {
        const supplier = await db.suppliers.get(partner.supplierFacetId)
        if (supplier && !supplier.isDeleted) {
            await db.suppliers.put({
                ...supplier,
                isDeleted: true,
                updatedAt: now,
                version: supplier.version + 1,
                ...getSyncMetadata(supplier.workspaceId, now)
            })
            await syncSoftDelete('suppliers', supplier.id, supplier.workspaceId)
        }
    }
}

export async function mergeBusinessPartners(primaryPartnerId: string, secondaryPartnerId: string) {
    const primary = await db.business_partners.get(primaryPartnerId)
    const secondary = await db.business_partners.get(secondaryPartnerId)
    if (!primary || !secondary || primary.isDeleted || secondary.isDeleted) {
        throw new Error('Business partner not found')
    }
    if (primary.workspaceId !== secondary.workspaceId) {
        throw new Error('Partners must belong to the same workspace')
    }

    const now = new Date().toISOString()
    const mergedRole: BusinessPartnerRole = primary.role === secondary.role
        ? primary.role
        : 'both'
    const mergedPrimary: BusinessPartner = {
        ...primary,
        name: primary.name || secondary.name,
        contactName: primary.contactName || secondary.contactName,
        email: primary.email || secondary.email,
        phone: primary.phone || secondary.phone,
        address: primary.address || secondary.address,
        city: primary.city || secondary.city,
        country: primary.country || secondary.country,
        notes: primary.notes || secondary.notes,
        role: mergedRole,
        creditLimit: Math.max(primary.creditLimit || 0, secondary.creditLimit || 0),
        customerFacetId: primary.customerFacetId || secondary.customerFacetId || null,
        supplierFacetId: primary.supplierFacetId || secondary.supplierFacetId || null,
        isEcommerce: Boolean(primary.isEcommerce || secondary.isEcommerce),
        updatedAt: now,
        version: primary.version + 1,
        ...getSyncMetadata(primary.workspaceId, now)
    }
    const mergedSecondary: BusinessPartner = {
        ...secondary,
        mergedIntoBusinessPartnerId: primary.id,
        updatedAt: now,
        version: secondary.version + 1,
        ...getSyncMetadata(secondary.workspaceId, now)
    }

    await db.business_partners.bulkPut([mergedPrimary, mergedSecondary])
    await syncUpsertEntities('business_partners', [mergedPrimary as unknown as SyncEntity, mergedSecondary as unknown as SyncEntity], primary.workspaceId)

    if (secondary.customerFacetId) {
        const customer = await db.customers.get(secondary.customerFacetId)
        if (customer) {
            await syncCustomerFacet({
                ...customer,
                businessPartnerId: primary.id,
                updatedAt: now,
                version: customer.version + 1,
                ...getSyncMetadata(primary.workspaceId, now)
            })
        }
    }

    if (secondary.supplierFacetId) {
        const supplier = await db.suppliers.get(secondary.supplierFacetId)
        if (supplier) {
            await syncSupplierFacet({
                ...supplier,
                businessPartnerId: primary.id,
                updatedAt: now,
                version: supplier.version + 1,
                ...getSyncMetadata(primary.workspaceId, now)
            })
        }
    }

    const salesOrders = await db.sales_orders.where('workspaceId').equals(primary.workspaceId).and((item) => !item.isDeleted && item.businessPartnerId === secondary.id).toArray()
    const purchaseOrders = await db.purchase_orders.where('workspaceId').equals(primary.workspaceId).and((item) => !item.isDeleted && item.businessPartnerId === secondary.id).toArray()
    const travelSales = await db.travel_agency_sales.where('workspaceId').equals(primary.workspaceId).and((item) => !item.isDeleted && item.businessPartnerId === secondary.id).toArray()
    const loans = await db.loans.where('workspaceId').equals(primary.workspaceId).and((item) => !item.isDeleted && item.linkedPartyId === secondary.id).toArray()

    await Promise.all(salesOrders.map((order) => db.sales_orders.update(order.id, { businessPartnerId: primary.id, customerId: mergedPrimary.customerFacetId || order.customerId })))
    await Promise.all(purchaseOrders.map((order) => db.purchase_orders.update(order.id, { businessPartnerId: primary.id, supplierId: mergedPrimary.supplierFacetId || order.supplierId })))
    await Promise.all(travelSales.map((sale) => db.travel_agency_sales.update(sale.id, { businessPartnerId: primary.id, supplierId: mergedPrimary.supplierFacetId || sale.supplierId })))
    await Promise.all(loans.map((loan) => db.loans.update(loan.id, { linkedPartyId: primary.id, linkedPartyType: 'business_partner' })))

    const candidates = await db.business_partner_merge_candidates.where('workspaceId').equals(primary.workspaceId).and((item) => {
        if (item.isDeleted) {
            return false
        }

        return item.primaryPartnerId === primary.id && item.secondaryPartnerId === secondary.id
            || item.primaryPartnerId === secondary.id
            || item.secondaryPartnerId === secondary.id
    }).toArray()

    const updatedCandidates = candidates.map((candidate) => ({
        ...candidate,
        status: candidate.primaryPartnerId === primary.id && candidate.secondaryPartnerId === secondary.id ? 'accepted' : candidate.status,
        isDeleted: candidate.primaryPartnerId === primary.id && candidate.secondaryPartnerId === secondary.id ? candidate.isDeleted : true,
        updatedAt: now,
        version: candidate.version + 1,
        ...getSyncMetadata(primary.workspaceId, now)
    })) as BusinessPartnerMergeCandidate[]
    if (updatedCandidates.length > 0) {
        await db.business_partner_merge_candidates.bulkPut(updatedCandidates)
        await syncUpsertEntities('business_partner_merge_candidates', updatedCandidates as unknown as SyncEntity[], primary.workspaceId)
    }

    await mirrorPartnerToFacets(mergedPrimary)
    await recalculateBusinessPartnerSummary(primary.workspaceId, primary.id)
    await refreshBusinessPartnerMergeCandidates(primary.workspaceId)
    return mergedPrimary
}

export async function dismissBusinessPartnerMergeCandidate(id: string) {
    const candidate = await db.business_partner_merge_candidates.get(id)
    if (!candidate || candidate.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    const updated: BusinessPartnerMergeCandidate = {
        ...candidate,
        status: 'dismissed',
        updatedAt: now,
        version: candidate.version + 1,
        ...getSyncMetadata(candidate.workspaceId, now)
    }

    await db.business_partner_merge_candidates.put(updated)
    await syncUpsertEntities('business_partner_merge_candidates', [updated as unknown as SyncEntity], candidate.workspaceId)
}

export function useCustomers(workspaceId: string | undefined) {
    const partners = useBusinessPartners(workspaceId, { roles: ['customer'] })
    return partners.filter((partner) => roleIncludesCustomer(partner.role)).map(partnerToCustomer)
}

export function useSuppliers(workspaceId: string | undefined) {
    const partners = useBusinessPartners(workspaceId, { roles: ['supplier'] })
    return partners.filter((partner) => roleIncludesSupplier(partner.role)).map(partnerToSupplier)
}

export function useCustomer(customerId: string | undefined) {
    return useLiveQuery(async () => {
        if (!customerId) {
            return undefined
        }

        const partner = await getPartnerByAnyId(customerId)
        if (!partner || !roleIncludesCustomer(partner.role)) {
            return undefined
        }

        return partnerToCustomer(partner)
    }, [customerId])
}

export function useSupplier(supplierId: string | undefined) {
    return useLiveQuery(async () => {
        if (!supplierId) {
            return undefined
        }

        const partner = await getPartnerByAnyId(supplierId)
        if (!partner || !roleIncludesSupplier(partner.role)) {
            return undefined
        }

        return partnerToSupplier(partner)
    }, [supplierId])
}

export async function createCustomer(
    workspaceId: string,
    data: Omit<Customer, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'totalOrders' | 'totalSpent' | 'outstandingBalance'>
) {
    const partner = await createBusinessPartner(workspaceId, {
        name: data.name,
        contactName: undefined,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        country: data.country,
        defaultCurrency: data.defaultCurrency,
        notes: data.notes,
        role: 'customer',
        creditLimit: data.creditLimit
    })

    return partnerToCustomer(partner)
}

export async function createSupplier(
    workspaceId: string,
    data: Omit<Supplier, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted' | 'totalPurchases' | 'totalSpent'>
) {
    const partner = await createBusinessPartner(workspaceId, {
        name: data.name,
        contactName: data.contactName,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        country: data.country,
        defaultCurrency: data.defaultCurrency,
        notes: data.notes,
        role: 'supplier',
        creditLimit: data.creditLimit
    })

    return partnerToSupplier(partner)
}

export async function updateCustomer(id: string, data: Partial<Customer>) {
    const partner = await updateBusinessPartner(id, {
        name: data.name,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        country: data.country,
        defaultCurrency: data.defaultCurrency,
        notes: data.notes,
        creditLimit: data.creditLimit
    })

    return partnerToCustomer(partner)
}

export async function updateSupplier(id: string, data: Partial<Supplier>) {
    const partner = await updateBusinessPartner(id, {
        name: data.name,
        contactName: data.contactName,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        country: data.country,
        defaultCurrency: data.defaultCurrency,
        notes: data.notes,
        creditLimit: data.creditLimit
    })

    return partnerToSupplier(partner)
}

export async function deleteCustomer(id: string) {
    await deleteBusinessPartner(id)
}

export async function deleteSupplier(id: string) {
    await deleteBusinessPartner(id)
}
