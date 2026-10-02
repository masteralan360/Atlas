import 'fake-indexeddb/auto'
import { beforeAll, afterAll, vi } from 'vitest'
import { db } from '@/local-db/database'
import { installTestBrowser } from '../../fixtures/browser'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { writeWorkspaceModeSnapshot, clearWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import type { LabConfiguration } from '../model/modelTypes'
import { readManifest, authenticateActor, assertSalesOrderActorReady, dataOrThrow, type TestActor } from './testActor'
import { SupabaseDriver } from '../drivers/supabaseDriver'
import { LabSqlite } from './sqlite'
import { setLocalModeSqliteConnectionForTests, hydrateLocalModeCacheFromSqlite, runLocalModeSqliteWrite } from '@/local-db/localModeSqlite'

vi.mock('@/auth/supabase', async () => ({ supabase: (await import('./liveSession')).labSupabase, isSupabaseConfigured: true }))
let observer: TestActor
export function setupSupabaseLab() {
    beforeAll(async () => {
        installTestBrowser(); setNetworkStatus(true)
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
        const manifest = readManifest()
        const credential = manifest.actors['business.admin']
        const { labSupabase } = await import('./liveSession')
        const login = dataOrThrow(await labSupabase.auth.signInWithPassword({ email: credential.email, password: credential.password }), 'fixtures.actionLogin')
        if (login.user?.id !== credential.userId) throw new Error('fixtures.actionIdentity')
        observer = await authenticateActor('business.observer')
        await assertSalesOrderActorReady(observer)
        setActiveBusinessWorkspace(credential.workspaceId); setActiveBusinessUser(credential.userId, 'admin', credential.workspaceId)
        const workspace = manifest.workspaces.find(row => row.label === 'business')!
        writeWorkspaceModeSnapshot({ workspaceId: credential.workspaceId, dataMode: workspace.mode })
    }, 120_000)
    afterAll(async () => {
        const { labSupabase } = await import('./liveSession')
        clearWorkspaceModeSnapshot(observer?.workspaceId); setActiveBusinessWorkspace(null); setActiveBusinessUser(null); setNetworkStatus(true)
        await labSupabase.auth.signOut({ scope: 'local' }); await observer?.client.auth.signOut({ scope: 'local' }); await db.delete()
    })
}
export async function createSupabaseDriver(configuration: LabConfiguration) {
    const manifest = readManifest()
    const actor = manifest.actors['business.admin']
    const workspace = manifest.workspaces.find(row => row.label === 'business')!
    await db.delete(); await db.open()
    let sqlite = workspace.mode === 'hybrid' ? await LabSqlite.open() : undefined
    if (sqlite) setLocalModeSqliteConnectionForTests(sqlite)
    const { createBusinessPartner } = await import('@/local-db/businessPartners')
    const { createStorage, createProduct, fetchTableFromSupabase } = await import('@/local-db/hooks')
    const { savePaymentAccount } = await import('@/local-db/paymentAccounts')
    const { faults } = await import('./liveSession')
    faults.reset()
    if (!await fetchTableFromSupabase('storages', db.storages, actor.workspaceId, { force: true })) throw new Error('fixtures.storageHydration')
    if (configuration.account && !await fetchTableFromSupabase('payment_accounts', db.payment_accounts, actor.workspaceId, { force: true })) throw new Error('fixtures.accountHydration')
    const tag = `${manifest.namespace} ${crypto.randomUUID()}`
    const customers = []
    for (let index = 0; index < 2; index++) customers.push(await createBusinessPartner(actor.workspaceId, { partnerName: `${tag} customer ${index}`, phone: '',
        defaultCurrency: configuration.currency, creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer' }))
    const storage = await createStorage(actor.workspaceId, { name: `${tag} storage` })
    const products = []
    for (let index = 0; index < 3; index++) products.push(await createProduct(actor.workspaceId, { sku: `SORL-${crypto.randomUUID()}`, name: `${tag} product ${index}`,
        description: '', categoryId: null, category: null, storageId: storage.id, storageName: storage.name, price: 100, costPrice: 40, quantity: 100,
        minStockLevel: 0, unit: 'pcs', currency: configuration.currency, barcode: '', barcodes: [], imageUrl: '', canBeReturned: true, returnRules: '', createdBy: actor.userId }))
    const account = configuration.account ? await savePaymentAccount(actor.workspaceId, { name: `${tag} cash`, accountType: 'cash_drawer', iconKey: 'cash_drawer', openingBalances: [] }) : null
    const driver = new SupabaseDriver({ workspaceId: actor.workspaceId, userId: actor.userId, tag, customers, storage, products,
        accountId: account?.id ?? null, accountName: account?.name ?? null }, configuration, observer.client, faults, workspace.mode)
    const execute = driver.execute.bind(driver)
    driver.execute = async action => {
        await execute(action)
        if (sqlite && action.name === 'ReloadState') {
            const bytes = await runLocalModeSqliteWrite(async () => sqlite!.database.export())
            await sqlite.close(); sqlite = await LabSqlite.open(bytes)
            setLocalModeSqliteConnectionForTests(sqlite)
            await db.delete(); await db.open(); await hydrateLocalModeCacheFromSqlite(db, actor.workspaceId)
        }
    }
    const close = driver.close.bind(driver)
    driver.close = async () => { await close(); if (sqlite) { setLocalModeSqliteConnectionForTests(); await sqlite.close() } }
    return driver
}
