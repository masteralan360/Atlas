import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { findPartnerProductPriceBookItem } from '@/lib/priceBooks'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'
import type { CurrencyCode, PriceBook, PriceBookItem } from './models'
import { addToOfflineMutations } from './offlineMutations'
import { rekeyPriceBookItemReferences } from './priceBookReferences'

export interface PriceBookQueryOptions {
    enabled?: boolean
    syncRemote?: boolean
}

export interface PriceBookItemInput {
    priceBookId: string
    costPrice: number | null
    price: number
    currency: CurrencyCode
}

const SUPPORTED_PRICE_BOOK_CURRENCIES = new Set<CurrencyCode>(['usd', 'eur', 'iqd', 'try'])

function shouldUseCloudData(workspaceId?: string | null) {
    return Boolean(workspaceId) && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    if (!shouldUseCloudData(workspaceId)) {
        return {
            syncStatus: 'synced' as const,
            lastSyncedAt: timestamp
        }
    }

    if (isOnline(workspaceId)) {
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

function toRemotePayload(entity: PriceBook | PriceBookItem) {
    return toSnakeCase({
        ...entity,
        syncStatus: undefined,
        lastSyncedAt: undefined
    } as unknown as Record<string, unknown>)
}

function normalizeName(value: string) {
    const name = value.trim()
    if (!name) {
        throw new Error('Price Book name is required')
    }
    return name
}

async function assertUniquePriceBookName(workspaceId: string, name: string, excludedId?: string) {
    const normalized = name.toLowerCase()
    const duplicate = await db.price_books
        .where('workspaceId')
        .equals(workspaceId)
        .and((row) => !row.isDeleted && row.id !== excludedId && row.name.trim().toLowerCase() === normalized)
        .first()
    if (duplicate) {
        throw new Error('A Price Book with this name already exists')
    }
}

function normalizeItemInputs(inputs: PriceBookItemInput[]) {
    const normalized: PriceBookItemInput[] = []
    const seen = new Set<string>()

    for (const input of inputs) {
        const priceBookId = input.priceBookId.trim()
        if (!priceBookId || seen.has(priceBookId)) {
            if (seen.has(priceBookId)) {
                throw new Error('A product can only have one item in each Price Book')
            }
            throw new Error('Select a Price Book for every custom price row')
        }

        const costPrice = input.costPrice == null ? null : Number(input.costPrice)
        const price = Number(input.price)
        if ((costPrice != null && (!Number.isFinite(costPrice) || costPrice < 0))
            || !Number.isFinite(price)
            || price < 0) {
            throw new Error('Price Book selling price must be zero or greater, and its cost must be zero or greater when provided')
        }
        if (!SUPPORTED_PRICE_BOOK_CURRENCIES.has(input.currency)) {
            throw new Error('Select a supported currency for every Price Book item')
        }

        seen.add(priceBookId)
        normalized.push({
            priceBookId,
            costPrice,
            price,
            currency: input.currency
        })
    }

    return normalized
}

async function retireQueuedPriceBookMutations(
    entityType: 'price_books' | 'price_book_items',
    throughTimestamp: string,
    matches: (mutation: { entityId: string; payload: Record<string, unknown> }) => boolean
) {
    await db.offline_mutations.toCollection().modify((mutation) => {
        if (
            mutation.entityType === entityType
            && (mutation.status === 'pending' || mutation.status === 'failed')
            && mutation.createdAt <= throughTimestamp
            && matches(mutation)
        ) {
            mutation.status = 'synced'
            mutation.error = undefined
        }
    })
}

async function hydratePriceBookTable(
    tableName: 'price_books' | 'price_book_items',
    workspaceId: string
) {
    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return
    }

    const table = tableName === 'price_books' ? db.price_books : db.price_book_items
    const remoteRows: Record<string, unknown>[] = []
    const pageSize = 1000

    for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .eq('workspace_id', workspaceId)
            .order('id', { ascending: true })
            .range(from, from + pageSize - 1)

        if (error) {
            throw normalizeSupabaseActionError(error)
        }

        const page = (data ?? []) as Record<string, unknown>[]
        remoteRows.push(...page)
        if (page.length < pageSize) {
            break
        }
    }

    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return
    }

    const syncedAt = new Date().toISOString()
    const remoteItems = remoteRows.map((row) => ({
        ...(toCamelCase(row) as unknown as PriceBook | PriceBookItem),
        syncStatus: 'synced' as const,
        lastSyncedAt: syncedAt
    }))
    const localItems = await table.where('workspaceId').equals(workspaceId).toArray() as Array<PriceBook | PriceBookItem>
    const pendingItems = localItems.filter((row) => row.syncStatus === 'pending')
    const pendingIds = new Set(pendingItems.map((row) => row.id))
    const pendingNaturalKeys = tableName === 'price_book_items'
        ? new Set((pendingItems as PriceBookItem[]).map((row) => `${row.priceBookId}:${row.productId}`))
        : new Set<string>()
    const pendingBookNameKeys = tableName === 'price_books'
        ? new Set((pendingItems as PriceBook[])
            .filter((row) => !row.isDeleted)
            .map((row) => row.name.trim().toLowerCase()))
        : new Set<string>()
    const applicableRemoteItems = remoteItems.filter((row) => {
        if (pendingIds.has(row.id)) {
            return false
        }
        if (tableName === 'price_book_items') {
            const item = row as PriceBookItem
            return !pendingNaturalKeys.has(`${item.priceBookId}:${item.productId}`)
        }
        if (tableName === 'price_books') {
            const book = row as PriceBook
            return book.isDeleted || !pendingBookNameKeys.has(book.name.trim().toLowerCase())
        }
        return true
    })
    const remoteIds = new Set(remoteItems.map((row) => row.id))
    const hiddenRemoteBookIds = tableName === 'price_books'
        ? new Set((remoteItems as PriceBook[])
            .filter((row) => !row.isDeleted && pendingBookNameKeys.has(row.name.trim().toLowerCase()))
            .map((row) => row.id))
        : new Set<string>()
    const deletedIds = localItems
        .filter((row) => row.syncStatus !== 'pending' && (!remoteIds.has(row.id) || hiddenRemoteBookIds.has(row.id)))
        .map((row) => row.id)

    if (!await canReconcileCloudWorkspaceData(workspaceId)) {
        return
    }

    await db.transaction('rw', table, async () => {
        if (deletedIds.length > 0) {
            await table.bulkDelete(deletedIds)
        }

        if (tableName === 'price_book_items') {
            for (const remoteItem of applicableRemoteItems as PriceBookItem[]) {
                const conflict = await db.price_book_items
                    .where('[priceBookId+productId]')
                    .equals([remoteItem.priceBookId, remoteItem.productId])
                    .first()
                if (conflict && conflict.id !== remoteItem.id && conflict.syncStatus !== 'pending') {
                    await db.price_book_items.delete(conflict.id)
                }
            }
        }

        if (applicableRemoteItems.length > 0) {
            if (tableName === 'price_books') {
                await db.price_books.bulkPut(applicableRemoteItems as PriceBook[])
            } else {
                await db.price_book_items.bulkPut(applicableRemoteItems as PriceBookItem[])
            }
        }
        if (pendingItems.length > 0) {
            if (tableName === 'price_books') {
                await db.price_books.bulkPut(pendingItems as PriceBook[])
            } else {
                await db.price_book_items.bulkPut(pendingItems as PriceBookItem[])
            }
        }
    })
}

export function usePriceBooks(workspaceId: string | undefined, options: PriceBookQueryOptions = {}) {
    const online = useNetworkStatus()
    const enabled = options.enabled ?? true
    const syncRemote = options.syncRemote ?? true
    const rows = useLiveQuery(
        () => enabled && workspaceId
            ? db.price_books.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
            : [],
        [enabled, workspaceId]
    )

    useEffect(() => {
        if (!enabled || !syncRemote || !online || !workspaceId || !shouldUseCloudData(workspaceId)) {
            return
        }

        void hydratePriceBookTable('price_books', workspaceId).catch((error) => {
            console.error('[PriceBooks] Failed to hydrate Price Books:', error)
        })
    }, [enabled, online, syncRemote, workspaceId])

    return rows ?? []
}

export function usePriceBookItems(workspaceId: string | undefined, options: PriceBookQueryOptions = {}) {
    const online = useNetworkStatus()
    const enabled = options.enabled ?? true
    const syncRemote = options.syncRemote ?? true
    const rows = useLiveQuery(
        () => enabled && workspaceId
            ? db.price_book_items.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
            : [],
        [enabled, workspaceId]
    )

    useEffect(() => {
        if (!enabled || !syncRemote || !online || !workspaceId || !shouldUseCloudData(workspaceId)) {
            return
        }

        void hydratePriceBookTable('price_book_items', workspaceId).catch((error) => {
            console.error('[PriceBooks] Failed to hydrate Price Book items:', error)
        })
    }, [enabled, online, syncRemote, workspaceId])

    return rows ?? []
}

export function usePriceBookCatalogState(
    workspaceId: string | undefined,
    options: PriceBookQueryOptions = {}
) {
    const online = useNetworkStatus()
    const enabled = options.enabled ?? true
    const syncRemote = options.syncRemote ?? true
    const needsRemoteHydration = Boolean(
        enabled && syncRemote && online && workspaceId && shouldUseCloudData(workspaceId)
    )
    const [remoteHydrationKey, setRemoteHydrationKey] = useState<string | null>(null)
    const [hydrationError, setHydrationError] = useState<Error | null>(null)
    const [retryNonce, setRetryNonce] = useState(0)
    const priceBooks = useLiveQuery(
        () => enabled && workspaceId
            ? db.price_books.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
            : [],
        [enabled, workspaceId]
    )
    const priceBookItems = useLiveQuery(
        () => enabled && workspaceId
            ? db.price_book_items.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
            : [],
        [enabled, workspaceId]
    )

    const expectedHydrationKey = needsRemoteHydration ? workspaceId ?? null : null

    useEffect(() => {
        if (!needsRemoteHydration || !workspaceId) {
            setRemoteHydrationKey(null)
            setHydrationError(null)
            return
        }

        let cancelled = false
        let retryTimer: ReturnType<typeof setTimeout> | undefined
        setRemoteHydrationKey(null)
        setHydrationError(null)
        void Promise.all([
            hydratePriceBookTable('price_books', workspaceId),
            hydratePriceBookTable('price_book_items', workspaceId)
        ]).then(() => {
            if (!cancelled) {
                setRemoteHydrationKey(workspaceId)
            }
        }).catch((error) => {
            const normalized = error instanceof Error ? error : new Error(String(error))
            console.error('[PriceBooks] Failed to hydrate Price Book catalog:', normalized)
            if (!cancelled) {
                setHydrationError(normalized)
                retryTimer = setTimeout(() => setRetryNonce((value) => value + 1), 5000)
            }
        })

        return () => {
            cancelled = true
            if (retryTimer) clearTimeout(retryTimer)
        }
    }, [needsRemoteHydration, retryNonce, workspaceId])

    return {
        priceBooks: priceBooks ?? [],
        priceBookItems: priceBookItems ?? [],
        isReady: priceBooks !== undefined
            && priceBookItems !== undefined
            && (!needsRemoteHydration || remoteHydrationKey === expectedHydrationKey),
        error: hydrationError,
        retry: () => setRetryNonce((value) => value + 1)
    }
}

export function useProductPriceBookItems(
    workspaceId: string | undefined,
    productId: string | undefined,
    options: PriceBookQueryOptions = {}
) {
    const online = useNetworkStatus()
    const enabled = options.enabled ?? true
    const syncRemote = options.syncRemote ?? true
    const rows = useLiveQuery(
        () => enabled && workspaceId && productId
            ? db.price_book_items
                .where('[workspaceId+productId]')
                .equals([workspaceId, productId])
                .and((row) => !row.isDeleted)
                .toArray()
            : [],
        [enabled, productId, workspaceId]
    )

    useEffect(() => {
        if (!enabled || !syncRemote || !online || !workspaceId || !productId || !shouldUseCloudData(workspaceId)) {
            return
        }

        void hydratePriceBookTable('price_book_items', workspaceId).catch((error) => {
            console.error('[PriceBooks] Failed to hydrate product Price Book items:', error)
        })
    }, [enabled, online, productId, syncRemote, workspaceId])

    return rows ?? []
}

export function useProductPriceBookItemsState(
    workspaceId: string | undefined,
    productId: string | undefined,
    options: PriceBookQueryOptions = {}
) {
    const online = useNetworkStatus()
    const enabled = options.enabled ?? true
    const syncRemote = options.syncRemote ?? true
    const needsRemoteHydration = Boolean(
        enabled && syncRemote && online && workspaceId && productId && shouldUseCloudData(workspaceId)
    )
    const [remoteHydrationKey, setRemoteHydrationKey] = useState<string | null>(null)
    const [hydrationError, setHydrationError] = useState<Error | null>(null)
    const [retryNonce, setRetryNonce] = useState(0)
    const rows = useLiveQuery(
        () => enabled && workspaceId && productId
            ? db.price_book_items
                .where('[workspaceId+productId]')
                .equals([workspaceId, productId])
                .and((row) => !row.isDeleted)
                .toArray()
            : [],
        [enabled, productId, workspaceId]
    )

    const expectedHydrationKey = needsRemoteHydration ? `${workspaceId}:${productId}` : null

    useEffect(() => {
        if (!needsRemoteHydration || !workspaceId || !productId) {
            setRemoteHydrationKey(null)
            setHydrationError(null)
            return
        }

        let cancelled = false
        let retryTimer: ReturnType<typeof setTimeout> | undefined
        setRemoteHydrationKey(null)
        setHydrationError(null)
        void hydratePriceBookTable('price_book_items', workspaceId)
            .then(() => {
                if (!cancelled) {
                    setRemoteHydrationKey(`${workspaceId}:${productId}`)
                }
            })
            .catch((error) => {
                const normalized = error instanceof Error ? error : new Error(String(error))
                console.error('[PriceBooks] Failed to hydrate product Price Book items:', normalized)
                if (!cancelled) {
                    setHydrationError(normalized)
                    retryTimer = setTimeout(() => setRetryNonce((value) => value + 1), 5000)
                }
            })

        return () => {
            cancelled = true
            if (retryTimer) clearTimeout(retryTimer)
        }
    }, [needsRemoteHydration, productId, retryNonce, workspaceId])

    return {
        items: rows ?? [],
        isReady: rows !== undefined && (!needsRemoteHydration || remoteHydrationKey === expectedHydrationKey),
        error: hydrationError
    }
}

export async function createPriceBook(
    workspaceId: string,
    data: { name: string; createdBy?: string | null; saveWarn?: boolean }
) {
    const now = new Date().toISOString()
    const name = normalizeName(data.name)
    await assertUniquePriceBookName(workspaceId, name)
    const priceBook: PriceBook = {
        id: generateId(),
        workspaceId,
        name,
        saveWarn: data.saveWarn ?? true,
        createdBy: data.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    if (shouldUseCloudData(workspaceId) && isOnline(workspaceId)) {
        const { error } = await runSupabaseAction(
            'priceBooks.create',
            () => supabase.from('price_books').insert(toRemotePayload(priceBook))
        )
        if (error) {
            throw normalizeSupabaseActionError(error)
        }
    }

    await db.price_books.add(priceBook)
    if (shouldUseCloudData(workspaceId) && !isOnline(workspaceId)) {
        await addToOfflineMutations(
            'price_books',
            priceBook.id,
            'create',
            priceBook as unknown as Record<string, unknown>,
            workspaceId
        )
    }

    return priceBook
}

export async function updatePriceBook(id: string, data: { name: string; saveWarn?: boolean }) {
    const existing = await db.price_books.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Price Book not found')
    }

    const now = new Date().toISOString()
    const name = normalizeName(data.name)
    await assertUniquePriceBookName(existing.workspaceId, name, id)
    let updated: PriceBook = {
        ...existing,
        name,
        saveWarn: data.saveWarn ?? existing.saveWarn ?? true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }
    let wroteToCloud = false

    if (shouldUseCloudData(existing.workspaceId) && isOnline(existing.workspaceId)) {
        const { data: remoteData, error } = await runSupabaseAction(
            'priceBooks.update',
            () => supabase.from('price_books').upsert(toRemotePayload(updated)).select('*').single()
        )
        if (error) {
            throw normalizeSupabaseActionError(error)
        }
        if (remoteData) {
            updated = {
                ...(toCamelCase(remoteData as Record<string, unknown>) as unknown as PriceBook),
                syncStatus: 'synced',
                lastSyncedAt: new Date().toISOString()
            }
        }
        wroteToCloud = true
    }

    await db.price_books.put(updated)
    if (wroteToCloud) {
        await retireQueuedPriceBookMutations(
            'price_books',
            now,
            (mutation) => mutation.entityId === id
        )
    }
    if (shouldUseCloudData(existing.workspaceId) && !wroteToCloud && !isOnline(existing.workspaceId)) {
        await addToOfflineMutations(
            'price_books',
            id,
            'update',
            updated as unknown as Record<string, unknown>,
            existing.workspaceId
        )
    }
}

export async function hardDeletePriceBook(id: string): Promise<void> {
    const priceBook = await db.price_books.get(id)
    if (!priceBook) {
        return
    }

    const workspaceId = priceBook.workspaceId
    const [priceBookItems, assignedPartners, workspaceMutations] = await Promise.all([
        db.price_book_items.where('priceBookId').equals(id).toArray(),
        db.business_partners.where('priceBookId').equals(id).toArray(),
        db.offline_mutations.where('workspaceId').equals(workspaceId).toArray()
    ])
    const itemIds = new Set(priceBookItems.map((item) => item.id))
    const shouldDeleteRemotely = shouldUseCloudData(workspaceId) && isOnline(workspaceId)

    if (shouldDeleteRemotely) {
        const { error } = await runSupabaseAction(
            'priceBooks.hardDelete',
            () => supabase.from('price_books').delete().eq('id', id)
        )
        if (error) {
            throw normalizeSupabaseActionError(error)
        }
    }

    const staleMutationIds = workspaceMutations
        .filter((mutation) => {
            if (mutation.entityType === 'price_books') {
                return mutation.entityId === id
            }
            if (mutation.entityType !== 'price_book_items') {
                return false
            }
            const mutationPriceBookId = mutation.payload.priceBookId ?? mutation.payload.price_book_id
            return itemIds.has(mutation.entityId) || mutationPriceBookId === id
        })
        .map((mutation) => mutation.id)
    const partnerMutationUpdates = workspaceMutations
        .filter((mutation) => mutation.entityType === 'business_partners')
        .flatMap((mutation) => {
            const priceBookId = mutation.payload.priceBookId ?? mutation.payload.price_book_id
            if (priceBookId !== id) return []

            return [{
                key: mutation.id,
                changes: {
                    payload: {
                        ...mutation.payload,
                        ...(mutation.payload.priceBookId === id ? { priceBookId: null } : {}),
                        ...(mutation.payload.price_book_id === id ? { price_book_id: null } : {})
                    }
                }
            }]
        })

    await db.transaction(
        'rw',
        [db.price_books, db.price_book_items, db.business_partners, db.offline_mutations],
        async () => {
            await db.price_books.delete(id)
            if (itemIds.size > 0) {
                await db.price_book_items.bulkDelete(Array.from(itemIds))
            }
            if (assignedPartners.length > 0) {
                await Promise.all(assignedPartners.map((partner) => (
                    db.business_partners.update(partner.id, { priceBookId: null })
                )))
            }
            if (staleMutationIds.length > 0) {
                await db.offline_mutations.bulkDelete(staleMutationIds)
            }
            if (partnerMutationUpdates.length > 0) {
                await db.offline_mutations.bulkUpdate(partnerMutationUpdates)
            }
        }
    )

    if (!shouldDeleteRemotely && shouldUseCloudData(workspaceId)) {
        await addToOfflineMutations(
            'price_books',
            id,
            'delete',
            { id, hardDelete: true },
            workspaceId
        )
    }
}

export async function replaceProductPriceBookItems(
    workspaceId: string,
    productId: string,
    inputs: PriceBookItemInput[],
    createdBy?: string | null
) {
    const normalizedInputs = normalizeItemInputs(inputs)
    const product = await db.products.get(productId)
    if (!product || product.isDeleted || product.workspaceId !== workspaceId) {
        throw new Error('Product not found')
    }

    const selectedBooks = await db.price_books.bulkGet(normalizedInputs.map((input) => input.priceBookId))
    if (selectedBooks.some((book) => !book || book.isDeleted || book.workspaceId !== workspaceId)) {
        throw new Error('One or more selected Price Books are not available')
    }

    const existingRows = await db.price_book_items
        .where('[workspaceId+productId]')
        .equals([workspaceId, productId])
        .toArray()
    const existingByBookId = new Map(existingRows.map((row) => [row.priceBookId, row]))
    const inputBookIds = new Set(normalizedInputs.map((input) => input.priceBookId))
    const existingIds = new Set(existingRows.map((row) => row.id))
    const now = new Date().toISOString()
    const metadata = getSyncMetadata(workspaceId, now)

    const nextRows: PriceBookItem[] = normalizedInputs.map((input) => {
        const existing = existingByBookId.get(input.priceBookId)
        if (existing) {
            return {
                ...existing,
                ...input,
                productId,
                isDeleted: false,
                updatedAt: now,
                version: existing.version + 1,
                ...metadata
            }
        }

        return {
            id: generateId(),
            workspaceId,
            productId,
            ...input,
            createdBy: createdBy ?? null,
            createdAt: now,
            updatedAt: now,
            version: 1,
            isDeleted: false,
            ...metadata
        }
    })

    for (const existing of existingRows) {
        if (!existing.isDeleted && !inputBookIds.has(existing.priceBookId)) {
            nextRows.push({
                ...existing,
                isDeleted: true,
                updatedAt: now,
                version: existing.version + 1,
                ...metadata
            })
        }
    }

    if (nextRows.length === 0) {
        return []
    }

    if (shouldUseCloudData(workspaceId) && isOnline(workspaceId)) {
        const { data: remoteExistingData, error: remoteExistingError } = await runSupabaseAction(
            'priceBookItems.loadExistingProductItems',
            () => supabase
                .from('price_book_items')
                .select('*')
                .eq('workspace_id', workspaceId)
                .eq('product_id', productId)
        )
        if (remoteExistingError) {
            throw normalizeSupabaseActionError(remoteExistingError)
        }

        const remoteExistingRows = (remoteExistingData ?? []).map((row) => (
            toCamelCase(row as Record<string, unknown>) as unknown as PriceBookItem
        ))
        const remoteExistingByBookId = new Map(remoteExistingRows.map((row) => [row.priceBookId, row]))
        const canonicalRows = nextRows.map((row) => {
            const remoteExisting = remoteExistingByBookId.get(row.priceBookId)
            if (!remoteExisting) return row

            return {
                ...row,
                id: remoteExisting.id,
                createdAt: remoteExisting.createdAt || row.createdAt,
                createdBy: remoteExisting.createdBy ?? row.createdBy ?? null,
                version: Math.max(row.version, Number(remoteExisting.version ?? 0) + 1)
            }
        })
        const { data, error } = await runSupabaseAction(
            'priceBookItems.replaceProduct',
            () => supabase
                .from('price_book_items')
                .upsert(canonicalRows.map(toRemotePayload), { onConflict: 'price_book_id,product_id' })
                .select('*')
        )
        if (error) {
            throw normalizeSupabaseActionError(error)
        }

        const syncedAt = new Date().toISOString()
        const remoteRows = (data ?? []).map((row) => ({
            ...(toCamelCase(row as Record<string, unknown>) as unknown as PriceBookItem),
            syncStatus: 'synced' as const,
            lastSyncedAt: syncedAt
        }))
        const conflictsToRekey: Array<{ previousId: string; canonicalId: string }> = []
        for (const remoteRow of remoteRows) {
            const conflict = await db.price_book_items
                .where('[priceBookId+productId]')
                .equals([remoteRow.priceBookId, remoteRow.productId])
                .first()
            if (conflict && conflict.id !== remoteRow.id) {
                conflictsToRekey.push({ previousId: conflict.id, canonicalId: remoteRow.id })
            }
        }
        for (const conflict of conflictsToRekey) {
            await rekeyPriceBookItemReferences(conflict.previousId, conflict.canonicalId)
        }
        await db.transaction('rw', db.price_book_items, async () => {
            for (const remoteRow of remoteRows) {
                const conflict = await db.price_book_items
                    .where('[priceBookId+productId]')
                    .equals([remoteRow.priceBookId, remoteRow.productId])
                    .first()
                if (conflict && conflict.id !== remoteRow.id) {
                    await db.price_book_items.delete(conflict.id)
                }
            }
            await db.price_book_items.bulkPut(remoteRows)
        })
        const savedNaturalKeys = new Set(canonicalRows.map((row) => `${row.priceBookId}:${row.productId}`))
        await retireQueuedPriceBookMutations(
            'price_book_items',
            now,
            (mutation) => {
                const priceBookId = mutation.payload.priceBookId ?? mutation.payload.price_book_id
                const queuedProductId = mutation.payload.productId ?? mutation.payload.product_id
                return typeof priceBookId === 'string'
                    && typeof queuedProductId === 'string'
                    && savedNaturalKeys.has(`${priceBookId}:${queuedProductId}`)
            }
        )
        return remoteRows.filter((row) => !row.isDeleted)
    }

    await db.price_book_items.bulkPut(nextRows)
    if (shouldUseCloudData(workspaceId)) {
        await Promise.all(nextRows.map((row) => addToOfflineMutations(
            'price_book_items',
            row.id,
            existingIds.has(row.id) ? 'update' : 'create',
            row as unknown as Record<string, unknown>,
            workspaceId
        )))
    }

    return nextRows.filter((row) => !row.isDeleted)
}

export { findPartnerProductPriceBookItem }
