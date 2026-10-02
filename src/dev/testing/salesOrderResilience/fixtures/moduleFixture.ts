import { db } from '@/local-db/database'
import { createBusinessPartner } from '@/local-db/businessPartners'
import { createProduct, createStorage } from '@/local-db/hooks'
import { savePaymentAccount } from '@/local-db/paymentAccounts'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { writeWorkspaceModeSnapshot, clearWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { setLocalModeSqliteConnectionForTests } from '@/local-db/localModeSqlite'
import type { LabConfiguration } from '../model/modelTypes'
import { ModuleDriver } from '../drivers/moduleDriver'
import { LabSqlite } from './sqlite'

export async function createModuleDriver(configuration: LabConfiguration) {
    await db.delete(); await db.open()
    const workspaceId = crypto.randomUUID()
    const tag = `DEV TEST SORL ${workspaceId}`
    writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'local' })
    setActiveBusinessWorkspace(workspaceId); setActiveBusinessUser(null); setNetworkStatus(true)
    let sqlite = await LabSqlite.open()
    setLocalModeSqliteConnectionForTests(sqlite)
    const customers = []
    for (let index = 0; index < 2; index++) customers.push(await createBusinessPartner(workspaceId, {
        partnerName: `${tag} customer ${index}`, phone: '', defaultCurrency: configuration.currency, creditLimit: 0,
        receivableCreditLimit: null, payableCreditLimit: null, role: 'customer' }))
    const storage = await createStorage(workspaceId, { name: `${tag} storage` })
    const products = []
    for (let index = 0; index < 3; index++) products.push(await createProduct(workspaceId, {
        sku: `SORL-${index}`, name: `${tag} product ${index}`, description: '', categoryId: null, category: null,
        storageId: storage.id, storageName: storage.name, price: 100, costPrice: 40, quantity: 100, minStockLevel: 0,
        unit: 'pcs', currency: configuration.currency, barcode: '', barcodes: [], imageUrl: '', canBeReturned: true,
        returnRules: '', createdBy: null }))
    const account = configuration.account ? await savePaymentAccount(workspaceId, { name: `${tag} cash`, accountType: 'cash_drawer', iconKey: 'cash_drawer', openingBalances: [] }) : null
    const driver = new ModuleDriver({ workspaceId, tag, userId: null, customers, storage, products, accountId: account?.id ?? null, accountName: account?.name ?? null }, configuration)
    const close = driver.close.bind(driver)
    const execute = driver.execute.bind(driver)
    driver.execute = async action => {
        await execute(action)
        if (action.name === 'ReloadState') {
            const bytes = sqlite.database.export()
            await sqlite.close()
            sqlite = await LabSqlite.open(bytes)
            setLocalModeSqliteConnectionForTests(sqlite)
            await db.delete(); await db.open()
            const { hydrateLocalModeCacheFromSqlite } = await import('@/local-db/localModeSqlite')
            await hydrateLocalModeCacheFromSqlite(db, workspaceId)
        }
    }
    driver.close = async () => { await close(); setLocalModeSqliteConnectionForTests(); await sqlite.close(); clearWorkspaceModeSnapshot(workspaceId); setActiveBusinessWorkspace(null); setActiveBusinessUser(null); await db.delete() }
    return driver
}
