import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Invoice } from '@/local-db/models'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'

const remote = vi.hoisted(() => ({
    uploads: [] as string[],
    parents: [] as Record<string, unknown>[],
    versionRequests: [] as Record<string, unknown>[],
    parentError: null as { message: string } | null,
    versionError: null as { message: string } | null,
    deletedPaths: [] as string[]
}))

vi.mock('@/auth/supabase', () => {
    const supabase = {
        from: (table: string) => {
            if (table !== 'invoices') throw new Error(`Unexpected table: ${table}`)
            return { upsert: async (payload: Record<string, unknown>) => {
                remote.parents.push(payload)
                return { error: remote.parentError }
            } }
        },
        rpc: (name: string, payload: Record<string, unknown>) => {
            if (name !== 'create_invoice_version') throw new Error(`Unexpected RPC: ${name}`)
            remote.versionRequests.push(payload)
            return { single: async () => ({
                data: remote.versionError ? null : {
                    id: payload.p_id,
                    invoice_id: payload.p_invoice_id,
                    workspace_id: payload.p_workspace_id,
                    source_id: payload.p_source_id,
                    origin: payload.p_origin,
                    version_number: 1,
                    format: payload.p_format,
                    r2_path: payload.p_r2_path,
                    file_size: payload.p_file_size,
                    created_at: new Date().toISOString()
                },
                error: remote.versionError
            }) }
        },
        schema: () => supabase
    }
    return { supabase }
})
vi.mock('@/lib/assetManager', () => ({
    assetManager: { uploadInvoicePdf: async (_id: string, _blob: Blob, _format: string, path: string) => {
        remote.uploads.push(path)
        return path
    } }
}))
vi.mock('./r2Service', () => ({ r2Service: { delete: async (path: string) => { remote.deletedPaths.push(path) } } }))
vi.mock('@/lib/network', () => ({ isOnline: () => true }))
vi.mock('@/workspace/workspaceMode', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/workspace/workspaceMode')>(),
    isLocalWorkspaceMode: () => false
}))

let db: typeof import('@/local-db/database').db
let persistInvoiceVersion: typeof import('./invoiceVersionService').persistInvoiceVersion

const workspaceId = '00000000-0000-4000-8000-000000000672'
const transactionId = '00000000-0000-4000-8000-000000000673'
const invoice = {
    id: transactionId,
    workspaceId,
    sourceId: transactionId,
    invoiceid: 'DT-000023',
    origin: 'direct_transaction',
    totalAmount: 1500,
    settlementCurrency: 'usd',
    createdBy: '00000000-0000-4000-8000-000000000674',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isDeleted: false,
    version: 1,
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString()
} as Invoice
const pdf = new Blob(['%PDF-1.4'], { type: 'application/pdf' })

describe('Cloud and Hybrid voucher PDF version request contract', () => {
    beforeAll(async () => {
        installTestBrowser()
        ;({ db } = await import('@/local-db/database'))
        ;({ persistInvoiceVersion } = await import('./invoiceVersionService'))
    }, 90_000)
    beforeEach(async () => {
        installTestBrowser()
        await db.delete()
        await db.open()
        await db.invoices.put(invoice)
        remote.uploads.length = 0
        remote.parents.length = 0
        remote.versionRequests.length = 0
        remote.deletedPaths.length = 0
        remote.parentError = null
        remote.versionError = null
    })
    afterAll(async () => { await db.delete() })

    it('uploads the A4 voucher and creates a workspace-scoped immutable version', async () => {
        const saved = await persistInvoiceVersion({
            invoice, blob: pdf, format: 'a4', author: { id: invoice.createdBy, name: 'Cashier' },
            metadata: { documentType: 'voucher' }
        })
        expect(remote.uploads[0]).toContain(`${workspaceId}/printed-invoices/versions/direct_transaction/${transactionId}/A4/`)
        expect(remote.parents[0]).toMatchObject({ id: transactionId, workspace_id: workspaceId, origin: 'direct_transaction' })
        expect(remote.versionRequests[0]).toMatchObject({
            p_invoice_id: transactionId,
            p_workspace_id: workspaceId,
            p_source_id: transactionId,
            p_origin: 'direct_transaction',
            p_format: 'a4',
            p_metadata: { documentType: 'voucher' }
        })
        expect(saved.versionNumber).toBe(1)
        expect((await db.invoice_versions.get(saved.id))?.r2Path).toBe(remote.uploads[0])
        expect((await db.invoices.get(transactionId))?.latestVersionId).toBe(saved.id)
    })

    it('cleans up the uploaded PDF and reports a remote version failure', async () => {
        remote.versionError = { message: 'Permission denied' }
        await expect(persistInvoiceVersion({
            invoice, blob: pdf, format: 'a4', author: {}, metadata: { documentType: 'voucher' }
        })).rejects.toMatchObject({ message: 'Permission denied' })
        expect(remote.deletedPaths).toEqual([remote.uploads[0]])
        expect(await db.invoice_versions.count()).toBe(0)
    })
})
