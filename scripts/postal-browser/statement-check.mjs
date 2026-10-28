import { chromium, expect } from '@playwright/test'
import { PGlite } from '@electric-sql/pglite'
import { readFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const pg = new PGlite()
await pg.exec(await readFile(new URL('./statement-fixture.sql', import.meta.url), 'utf8'))
for (const name of [
  '20261024003737_postal_service', '20261024004656_postal_registration_permission_keys',
  '20261024094518_postal_dashboard_summary', '20261024174745_add_postal_shipment_numbers',
  '20261024181523_postal_shipment_id_display_format', '20261025123951_postal_settlement_direction_guard',
  '20261027223702_postal_shipment_tariffs_and_delivery_fees', '20261028021022_postal_organization_account_statement',
]) await pg.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'))
await pg.exec(await readFile(new URL('./statement-seed.sql', import.meta.url), 'utf8'))
await pg.exec(`SELECT set_config('test.uid','00000000-0000-4000-8000-000000000012',false),set_config('test.workspace','00000000-0000-4000-8000-000000000001',false); SET ROLE authenticated`)
await mkdir('artifacts/postal', { recursive: true })
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
page.setDefaultTimeout(15000)
page.setDefaultNavigationTimeout(90000)
const errors = []
let failSearch = false, failStatement = false, delay = 0
page.on('pageerror', (error) => errors.push(error.message))
await page.addInitScript(() => {
  window.__ATLAS_POSTAL_BROWSER_TEST__ = true
  localStorage.setItem('global_date_range', 'allTime')
  localStorage.setItem('i18nextLng', new URL(location.href).searchParams.get('lang') || 'en')
})
await page.route('**/rest/v1/**', async (route) => {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' } })
  const endpoint = new URL(req.url()).pathname.split('/').at(-1)
  const p = req.postDataJSON()
  try {
    if ((endpoint === 'postal_statement_organizations' && failSearch) || (endpoint === 'postal_organization_statement' && failStatement)) throw new Error('Fixture connection unavailable')
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    let rows
    if (endpoint === 'postal_statement_organizations') {
      ({ rows } = await pg.query('SELECT public.postal_statement_organizations($1,$2) AS result', [p.p_workspace_id, p.p_search]))
    } else if (endpoint === 'postal_organization_statement') {
      ({ rows } = await pg.query('SELECT public.postal_organization_statement($1,$2,$3,$4,$5,$6,$7,$8) AS result', [p.p_workspace_id, p.p_organization_id, p.p_page, p.p_page_size, p.p_start, p.p_end, p.p_search, p.p_kind]))
    } else throw new Error(`Unexpected fixture request: ${endpoint}`)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows[0].result) })
  } catch (error) {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: error.message }) })
  }
})
const base = 'http://127.0.0.1:5188/scripts/postal-browser/index.html?view=statement'
try {
  await page.goto(base)
  const input = page.locator('#statement-organization')
  await expect(page.getByText('Select an organization', { exact: true })).toBeVisible()
  await input.fill('no organization')
  await expect(page.getByText('No matches found.', { exact: true })).toBeVisible()
  failSearch = true
  await input.fill('failed lookup')
  await expect(page.getByText('Search could not be completed. Try again.', { exact: true })).toBeVisible()
  failSearch = false
  await input.fill('statement')
  await expect(page.getByRole('option').filter({ hasText: 'Statement Merchant' })).toBeVisible()
  await input.press('ArrowUp')
  await input.press('Enter')
  await expect(page.getByText('60,000 IQD', { exact: true }).first()).toBeVisible()
  await expect(input).toHaveValue('Statement Merchant')
  await expect(page.getByText('Linked', { exact: true })).toBeVisible()
  await expect(page.getByText('PS-2026-000001', { exact: true }).first()).toBeVisible()
  assert.equal(await page.getByRole('table').locator('tbody tr').count(), 8)
  await page.screenshot({ path: 'artifacts/postal/organization-statement-desktop.png', fullPage: true })
  // Loading and failure hide balances while preserving the current selection.
  delay = 500
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Loading' }).first()).toBeVisible()
  await expect(input).toHaveValue('Statement Merchant')
  await expect(page.getByText('60,000 IQD', { exact: true }).first()).toBeVisible()
  delay = 0
  failStatement = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Try Again', exact: true })).toBeVisible()
  await expect(input).toHaveValue('Statement Merchant')
  await expect(page.getByText('60,000 IQD', { exact: true })).toHaveCount(0)
  failStatement = false
  await page.getByRole('button', { name: 'Try Again', exact: true }).click()
  await expect(page.getByText('60,000 IQD', { exact: true }).first()).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.screenshot({ path: 'artifacts/postal/organization-statement-mobile.png', fullPage: true })
  await page.getByRole('button', { name: 'Unlink', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(page.getByRole('table')).toHaveCount(0)
  for (const lang of ['ar', 'ku']) {
    await page.goto(`${base}&lang=${lang}`)
    await input.fill('STMT')
    await page.getByRole('option').filter({ hasText: 'Statement Merchant' }).click()
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(8)
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.equal(await page.getByText('postal.statement.', { exact: false }).count(), 0)
    await page.screenshot({ path: `artifacts/postal/organization-statement-${lang}-mobile.png`, fullPage: true })
  }
  // Exercise actual page navigation, reset-on-filter, and preservation of bounds while loading.
  for (let i = 0; i < 25; i++) {
    const { rows } = await pg.query(`SELECT revision FROM public.postal_shipments WHERE id='00000000-0000-4000-8000-000000000030'`)
    await pg.query('SELECT public.postal_command($1,$2::jsonb,$3)', ['collection', JSON.stringify({
      workspace_id: '00000000-0000-4000-8000-000000000001', id: '00000000-0000-4000-8000-000000000030',
      revision: rows[0].revision, signed_amount: 1000, direction: 'incoming', payment_method: 'cash',
    }), crypto.randomUUID()])
  }
  await page.goto(base)
  await input.fill('STMT')
  await page.getByRole('option').filter({ hasText: 'Statement Merchant' }).click()
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(22)
  delay = 500
  await page.getByLabel('Next', { exact: true }).click()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.locator('[aria-current="page"]')).toHaveText('2')
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(13)
  delay = 0
  await page.getByPlaceholder('Search shipment, recipient, phone, payment reference or notes').fill('Negative Recipient')
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(4)
  await expect(page.getByText('85,000 IQD', { exact: true }).first()).toBeVisible()
  await page.getByPlaceholder('Search shipment, recipient, phone, payment reference or notes').fill('')
  await expect(page.locator('[aria-current="page"]')).toHaveText('1')
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(22)
  assert.deepEqual(errors, [])
  console.log('Organization statement browser → RPC → PostgreSQL → UI checks passed: selection, keyboard, loading, failure, retry, unlink, source pagination, filter reset, desktop/mobile and Arabic/Kurdish RTL.')
} catch (error) {
  await page.screenshot({ path: 'artifacts/postal/organization-statement-failure.png', fullPage: true })
  console.error((await page.locator('body').innerText()).slice(0, 3000), errors)
  throw error
} finally {
  await browser.close()
  await pg.close()
}
