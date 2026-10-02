import { expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import type { LabManifest } from '../fixtures/testActor'

/** Compact real UI adapter. Generated sequences use module/Supabase drivers. */
export class BrowserDriver {
    readonly boundary = 'browser'
    readonly manifest = JSON.parse(process.env.SORL_MANIFEST ?? '{}') as LabManifest
    constructor(readonly page: Page) {
        const redact = (message: string) => {
            let safe = message.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
            for (const actor of Object.values(this.manifest.actors ?? {})) {
                safe = safe.split(actor.password).join('[credential]').split(actor.email).join('[actor]')
            }
            return safe
        }
        page.on('pageerror', error => console.error(`[SORL browser error] ${redact(error.message)}`))
        page.on('console', message => {
            if (message.type() === 'error' && /^\[(Atlas|Critical)\]/.test(message.text())) {
                console.error(`[SORL browser startup] ${redact(message.text())}`)
            }
        })
    }
    async login(actorName: string) {
        this.page.setDefaultTimeout(30_000)
        const actor = this.manifest.actors[actorName]
        if (!actor || !this.manifest.namespace.startsWith('DEV TEST SORL ')) throw new Error('browser.actorMissing')
        await this.page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
        await this.page.goto('/#/en/login')
        await this.page.locator('#email').fill(actor.email)
        await this.page.locator('#password').fill(actor.password)
        await this.page.locator('form button[type="submit"]').click()
        await expect(this.page.locator('#password')).toHaveCount(0)
        // The form performs its own post-login navigation after auth state changes.
        await expect(this.page).toHaveURL(/#\/en\/?$/)
    }
    async openOrders() { await this.page.goto('/#/en/orders/sales') }
    async observe(actorName = 'business.observer') {
        const actor = this.manifest.actors[actorName]
        const client = createClient(this.manifest.url, this.manifest.key, { auth: { persistSession: false, autoRefreshToken: false } })
        const result = await client.auth.signInWithPassword({ email: actor.email, password: actor.password })
        if (result.error) throw new Error('browser.observerLoginFailed')
        return { actor, client }
    }
    async createDraft() {
        const { actor, client } = await this.observe()
        try {
            const partners = await client.schema('crm').rpc('list_visible_business_partners', { p_workspace_id: actor.workspaceId })
            const products = await client.from('products').select('name,storage_id').eq('workspace_id', actor.workspaceId).or('is_deleted.eq.false,is_deleted.is.null').limit(1)
            if (partners.error || products.error) throw new Error(`browser.catalogReadFailed: ${partners.error?.code ?? products.error?.code}`)
            if (!partners.data?.length || !products.data?.length) throw new Error('browser.catalogMissing')
            const tag = `${this.manifest.namespace} browser ${crypto.randomUUID()}`
            await this.page.goto('/#/en/orders/new/sales')
            const customer = this.page.getByPlaceholder('Select Customer', { exact: true })
            await expect(customer).toBeEnabled()
            await customer.fill(partners.data[0].partner_name)
            await expect(customer).toHaveValue(partners.data[0].partner_name)
            await this.page.getByRole('button').filter({ hasText: partners.data[0].partner_name }).first().click()
            await expect(this.page.getByRole('button', { name: 'Clear Link', exact: true })).toBeVisible()
            const storage = await client.from('storages').select('name').eq('workspace_id', actor.workspaceId).eq('id', products.data[0].storage_id).single()
            if (storage.error) throw new Error('browser.storageReadFailed')
            const storageSelector = this.page.getByRole('combobox').filter({ hasText: 'Select Storage' }).first()
            if (await storageSelector.count()) {
                await storageSelector.click()
                await this.page.getByRole('option', { name: storage.data.name, exact: true }).click()
            }
            const product = this.page.getByPlaceholder('Select Product', { exact: true }).first()
            await product.fill(products.data[0].name)
            await this.page.getByRole('button').filter({ hasText: products.data[0].name }).first().click()
            await this.page.getByPlaceholder('Order notes, special instructions...').fill(tag)
            const save = this.page.getByRole('button', { name: 'Save Order', exact: true })
            await expect(save).toBeEnabled()
            // The label changes during processing and navigation removes the form.
            // Retain the clicked node to verify its immediate disabled state.
            const submittedButton = await save.elementHandle()
            await save.click()
            expect(await submittedButton!.evaluate(button => (button as HTMLButtonElement).disabled)).toBe(true)
            await expect.poll(async () => {
                const result = await client.schema('crm').from('sales_orders').select('id,total,items,status').eq('workspace_id', actor.workspaceId).eq('notes', tag)
                if (result.error) throw result.error
                return result.data?.length
            }).toBe(1)
            const saved = await client.schema('crm').from('sales_orders').select('*').eq('workspace_id', actor.workspaceId).eq('notes', tag).single()
            expect(saved.error).toBeNull(); expect(saved.data.status).toBe('draft'); expect(saved.data.items).toHaveLength(1)
            await this.page.goto(`/#/en/orders/edit/sales/${saved.data.id}`)
            await expect(this.page.getByPlaceholder('Select Customer')).toHaveValue(partners.data[0].partner_name)
            await this.page.reload()
            await expect(this.page.getByPlaceholder('Order notes, special instructions...')).toHaveValue(tag)
            expect(Number(saved.data.total)).toBeGreaterThan(0)
            return saved.data
        } finally { await client.auth.signOut({ scope: 'local' }) }
    }
}
