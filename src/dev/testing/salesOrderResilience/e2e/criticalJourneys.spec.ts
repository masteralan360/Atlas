import { test, expect } from '@playwright/test'
import { BrowserDriver } from '../drivers/browserDriver'

test('Business admin creates a draft through the real form and reloads persisted state', async ({ page }) => {
    const driver = new BrowserDriver(page)
    await driver.login('business.admin'); await driver.createDraft()
})
test('plan grant and revoke control the actual route; cached grant survives disconnected reload', async ({ browser }, testInfo) => {
    for (const [name, allowed] of [['basic.admin', false], ['grant.admin', true], ['revoke.admin', false]] as const) {
        const context = await browser.newContext()
        try {
            const page = await context.newPage(); const driver = new BrowserDriver(page)
            const bootstrap: string[] = []
            page.on('console', message => {
                const text = message.text()
                if (/^\[(Auth|Workspace|SupabaseAction)\]/.test(text)) bootstrap.push(text
                    .replace(/sorl-\S+@example\.com/g, '[actor]')
                    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]'))
            })
            await driver.login(name); await driver.openOrders()
            try {
                if (!allowed) await expect(page.getByText('Plan Restricted', { exact: true })).toBeVisible()
                else {
                    await expect(page.getByRole('button', { name: /New Sales Order|Create Order/ }).first()).toBeVisible()
                    await page.route(`${driver.manifest.url}/**`, route => route.abort('internetdisconnected'))
                    await page.reload()
                    await expect(page.getByText('Plan Restricted', { exact: true })).toHaveCount(0)
                    await expect(page.getByRole('button', { name: /New Sales Order|Create Order/ }).first()).toBeVisible()
                }
            } finally { await testInfo.attach(`${name}-bootstrap`, { body: bootstrap.join('\n'), contentType: 'text/plain' }) }
        } finally { await context.close() }
    }
})
test('Enterprise staff permission controls the real route and the lab dialog fits the viewport', async ({ browser, page }) => {
    for (const [name, allowed] of [['allowed', true], ['denied', false]] as const) {
        const context = await browser.newContext()
        try {
            const actorPage = await context.newPage(); const driver = new BrowserDriver(actorPage)
            await driver.login(`enterprise.${name}`); await driver.openOrders()
            if (!allowed) await expect(actorPage.getByText('403', { exact: true })).toBeVisible()
            else await expect(actorPage.getByRole('button', { name: /New Sales Order|Create Order/ }).first()).toBeVisible()
        } finally { await context.close() }
    }
    const driver = new BrowserDriver(page); await driver.login('business.admin'); await driver.openOrders()
    await page.getByRole('button', { name: 'Sales Order Resilience Lab', exact: true }).click()
    const dialog = page.getByRole('dialog'); await expect(dialog.getByText('SORL · Stateful generation', { exact: false })).toBeVisible()
    await expect(dialog.getByLabel('Random seed')).toBeVisible()
    await expect(dialog.getByText('Stateful generation · real Local SQLite', { exact: true })).toBeVisible()
    await expect(dialog.getByText('devTesting.layers.model', { exact: true })).toHaveCount(0)
    const bounds = await dialog.boundingBox()
    expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.screenshot({ path: `.atlas-dev-testing/lab-${page.viewportSize()!.width}.png`, fullPage: true })
})
