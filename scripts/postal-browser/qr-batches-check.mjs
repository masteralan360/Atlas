import { chromium, expect } from '@playwright/test'
import { PGlite } from '@electric-sql/pglite'
import { readFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const pg = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const w = id(1), admin = id(10), merchant = id(11)
await pg.exec(await readFile(new URL('./statement-fixture.sql', import.meta.url), 'utf8'))
for (const name of [
  '20261024003737_postal_service', '20261024004656_postal_registration_permission_keys',
  '20261024174745_add_postal_shipment_numbers', '20261024181523_postal_shipment_id_display_format',
  '20261027223702_postal_shipment_tariffs_and_delivery_fees', '20261028021022_postal_organization_account_statement',
  '20261031164557_postal_organizations_without_members',
  '20261031173159_postal_create_shipments_for_admin_and_office', '20261031203510_postal_assign_tariff_during_creation',
  '20261031213902_postal_backup_phone_optional', '20261101232108_postal_extra_large_carton_tariff',
  '20261101232111_postal_governorate_bulk_branches', '20261101232114_postal_branch_area_optional',
  '20261102160133_postal_generated_qr_batches',
  '20261102160411_postal_generated_qr_shipment_index',
  '20261102231139_postal_optional_shipment_size_and_manual_delivery_fee',
  '20261102231146_postal_additive_shipment_delivery_fee',
]) await pg.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'))
await pg.exec(await readFile(new URL('./statement-seed.sql', import.meta.url), 'utf8'))
async function actor(user) {
  await pg.exec('RESET ROLE')
  await pg.query("SELECT set_config('test.uid',$1,false),set_config('test.workspace',$2,false)", [user, w])
  await pg.exec('SET ROLE authenticated')
}
async function command(command, payload) {
  return (await pg.query('SELECT public.postal_command($1,$2::jsonb,$3) AS result',
    [command, JSON.stringify({ workspace_id: w, ...payload }), crypto.randomUUID()])).rows[0].result
}
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.setDefaultTimeout(15000)
page.setDefaultNavigationTimeout(90000)
const errors = []
let viewer = admin, delay = 0, failRead = false, failShipment = false, delayCommand = 0, failSearch = false
page.on('pageerror', (error) => errors.push(error.message))
await page.addInitScript(() => {
  window.__ATLAS_POSTAL_BROWSER_TEST__ = true
  localStorage.setItem('global_date_range', 'allTime')
  localStorage.setItem('i18nextLng', new URL(location.href).searchParams.get('lang') || 'en')
  // The real scanner and BarcodeDetector decode this canvas stream. No scan
  // callbacks or decoded results are replaced by the test harness.
  navigator.mediaDevices.getUserMedia = async () => {
    if (!window.qrCameraImage) throw new DOMException('No test camera', 'NotFoundError')
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480
    const context = canvas.getContext('2d'), img = new Image()
    img.src = window.qrCameraImage; await img.decode()
    const paint = () => { context.fillStyle = 'white'; context.fillRect(0, 0, 640, 480); context.drawImage(img, 120, 40, 400, 400) }
    paint()
    const timer = setInterval(paint, 100), stream = canvas.captureStream(10)
    stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer))
    return stream
  }
})
await page.route('**/rest/v1/**', async (route) => {
  const req = route.request(), url = new URL(req.url()), endpoint = url.pathname.split('/').at(-1)
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-expose-headers': 'content-range' }
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers })
  try {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    await actor(viewer)
    let body, extra = {}
    if (req.method() === 'POST') {
      const p = req.postDataJSON()
      if (endpoint === 'postal_command') {
        if (delayCommand) await new Promise((resolve) => setTimeout(resolve, delayCommand))
        if (failShipment && p.p_command === 'create_shipment') throw new Error('postal_invalid_tariff')
        body = (await pg.query('SELECT public.postal_command($1,$2::jsonb,$3) AS result', [p.p_command, JSON.stringify(p.p_payload), p.p_request_id])).rows[0].result
      } else if (endpoint === 'postal_validate_generated_qr') {
        body = (await pg.query('SELECT public.postal_validate_generated_qr($1,$2) AS result', [p.p_workspace_id, p.p_qr_id])).rows[0].result
      } else if (endpoint === 'postal_statement_organizations') {
        if (failSearch) throw new Error('Connection unavailable')
        body = (await pg.query('SELECT public.postal_statement_organizations($1,$2) AS result', [p.p_workspace_id, p.p_search])).rows[0].result
      } else throw new Error(`Unexpected RPC ${endpoint}`)
    } else if (['postal_qr_batch_summaries', 'postal_generated_qrs', 'postal_shipments'].includes(endpoint)) {
      if (failRead) throw new Error('Connection unavailable')
      const filters = ['workspace_id=$1'], values = [w]
      for (const key of ['id', 'batch_id', 'qr_id']) {
        const value = url.searchParams.get(key)
        if (value?.startsWith('eq.')) { values.push(value.slice(3)); filters.push(`${key}=$${values.length}`) }
      }
      for (const [key, value] of url.searchParams.entries()) {
        if (key === 'created_at' && /^(gte|lt)\./.test(value)) { values.push(value.replace(/^(gte|lt)\./, '')); filters.push(`created_at ${value.startsWith('gte') ? '>=' : '<'} $${values.length}`) }
      }
      const claimed = url.searchParams.get('claimed_at')
      if (claimed) filters.push(`claimed_at IS ${claimed.startsWith('not.') ? 'NOT ' : ''}NULL`)
      const predicate = filters.join(' AND ')
      const total = (await pg.query(`SELECT count(*)::int AS count FROM public.${endpoint} WHERE ${predicate}`, values)).rows[0].count
      const from = Number(url.searchParams.get('offset') ?? 0), size = Number(url.searchParams.get('limit') ?? 100)
      const order = endpoint === 'postal_qr_batch_summaries' ? 'created_at DESC,id DESC' : 'id'
      const rows = (await pg.query(`SELECT * FROM public.${endpoint} WHERE ${predicate} ORDER BY ${order} LIMIT ${size} OFFSET ${from}`, values)).rows
      body = req.headers().accept?.includes('vnd.pgrst.object') ? rows[0] : rows
      extra = { 'content-range': `${from}-${from + rows.length - 1}/${total}` }
    } else throw new Error(`Unexpected request ${endpoint}`)
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  } catch (error) {
    await route.fulfill({ status: 400, contentType: 'application/json', headers, body: JSON.stringify({ message: error.message }) })
  }
})
const base = 'http://127.0.0.1:5188/scripts/postal-browser/index.html'
await mkdir('artifacts/postal/qr-batches', { recursive: true })
async function getImage(qr) {
  const imagePage = await browser.newPage()
  await imagePage.addInitScript(() => { window.__ATLAS_POSTAL_BROWSER_TEST__ = true })
  await imagePage.goto(`${base}?view=qr-code&qr=${qr}`)
  const image = await imagePage.locator('svg[role="img"]').screenshot()
  await imagePage.close()
  return image
}
async function openClaim(image, camera = false) {
  viewer = merchant
  await page.goto(`${base}?view=qr-claim`)
  if (camera) await page.evaluate((data) => { window.qrCameraImage = data }, `data:image/png;base64,${image.toString('base64')}`)
  const choices = await page.getByRole('dialog').getByRole('button').allTextContents()
  assert(choices.indexOf('Claim QR') === choices.indexOf('Read Shipment QR') + 1)
  await page.getByRole('button', { name: 'Claim QR', exact: true }).click()
  if (!camera) await page.locator('input[type=file]').setInputFiles({ name: 'generated-qr.png', mimeType: 'image/png', buffer: image })
}
async function fillShipment() {
  await expect(page.locator('#shipment-recipient_name')).toBeVisible()
  await page.locator('#shipment-recipient_name').fill('QR Browser Recipient')
  await page.locator('#shipment-primary_phone').fill('07501234567')
  await page.locator('#shipment-backup_phone').fill('07701234567')
  await page.locator('#postal-governorate').click()
  await page.getByRole('button', { name: 'Erbil', exact: true }).click()
  await page.locator('#postal-area').click()
  await page.getByRole('button', { name: 'Ankawa', exact: true }).click()
  await page.locator('#shipment-cod').fill('25000')
  await page.getByRole('group', { name: 'Shipment Size' }).getByRole('button', { name: /Small Package/ }).click()
}
try {
  if (!process.argv.includes('--label-only')) {
    console.log('Checking batch generation and organization selection')
    await page.goto(`${base}?view=qr-batches`)
    await page.getByRole('button', { name: 'Generate Batch', exact: true }).click()
    const generate = page.getByRole('dialog').getByRole('button', { name: 'Generate Batch', exact: true })
    await expect(generate).toBeDisabled()
    await page.locator('#qr-quantity').fill('1000'); await expect(page.locator('#qr-quantity')).toHaveValue('1,000')
    await page.locator('#qr-quantity').fill(''); await expect(generate).toBeDisabled()
    await page.locator('#qr-quantity').fill('23')
    await page.locator('#qr-organization').fill('STMT')
    await page.getByRole('option').filter({ hasText: 'Statement Merchant' }).click()
    await expect(page.getByText('Linked', { exact: true })).toBeVisible()
    await page.locator('#qr-organization').focus()
    failSearch = true
    await page.waitForTimeout(400)
    await expect(page.locator('#qr-organization')).toHaveValue('Statement Merchant')
    await expect(generate).toBeEnabled()
    failSearch = false
    await page.getByRole('button', { name: 'Unlink', exact: true }).click()
    await expect(page.locator('#qr-organization')).toHaveValue('')
    await page.locator('#qr-organization').fill('STMT')
    await page.getByRole('option').filter({ hasText: 'Statement Merchant' }).click()
    await page.screenshot({ path: 'artifacts/postal/qr-batches/generate-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => {
      const dialog = await page.getByRole('dialog').boundingBox()
      return dialog.width <= 391 && dialog.height <= 845
    }).toBe(true)
    await page.screenshot({ path: 'artifacts/postal/qr-batches/generate-mobile.png', fullPage: true })
    delayCommand = 800
    await generate.click()
    await expect(generate).toBeDisabled()
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    delayCommand = 0
    await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(1)
    const batch = (await pg.query('SELECT * FROM public.postal_qr_batches')).rows[0]
    assert.equal(batch.quantity, 23); assert.equal(batch.organization_id, id(20))
    const qrs = (await pg.query('SELECT id FROM public.postal_generated_qrs ORDER BY id')).rows.map((row) => row.id)
    await page.reload(); await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(1)
    await page.getByRole('button', { name: 'Deactivate', exact: true }).click()
    await expect(page.getByText('Inactive', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Activate', exact: true }).click()
    await expect(page.getByText('Active', { exact: true })).toBeVisible()
    await page.goto(`${base}?view=qr-batch&batch=${batch.id}`)
    console.log('Checking detail pagination, reload and retry')
    await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(20)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: 'artifacts/postal/qr-batches/detail-desktop.png', fullPage: true })
    delay = 600
    await page.getByLabel('Next', { exact: true }).click()
    await expect(page.getByRole('table')).toHaveCount(0)
    await expect(page.locator('[aria-current="page"]')).toHaveText('2')
    await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(3)
    delay = 0
    await page.reload(); await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(20)
    failRead = true
    await page.reload(); await expect(page.getByRole('button', { name: 'Try Again', exact: true }).first()).toBeVisible()
    failRead = false
    await page.getByRole('button', { name: 'Try Again', exact: true }).first().click()
    await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(20)
    for (const lang of ['ar', 'ku']) {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${base}?view=qr-batch&batch=${batch.id}&lang=${lang}`)
      await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(20)
      assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      assert.equal(await page.getByText('postal.qr.', { exact: false }).count(), 0)
      await page.screenshot({ path: `artifacts/postal/qr-batches/detail-${lang}-mobile.png`, fullPage: true })
    }
    const image = await getImage(qrs[0])
    console.log('Checking image upload, cancellation, failed submission and retry')
    await openClaim(image)
    await expect(page.locator('#shipment-recipient_name')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await actor(admin)
    assert.equal((await pg.query('SELECT claimed_at FROM public.postal_generated_qrs WHERE id=$1', [qrs[0]])).rows[0].claimed_at, null)
    await openClaim(image)
    await fillShipment()
    failShipment = true
    await page.getByRole('button', { name: 'Create Shipment', exact: true }).click()
    await expect(page.getByText('Choose a valid shipment size and tariff for this destination.', { exact: false })).toBeVisible()
    await actor(admin)
    assert.equal((await pg.query('SELECT claimed_at FROM public.postal_generated_qrs WHERE id=$1', [qrs[0]])).rows[0].claimed_at, null)
    failShipment = false
    delayCommand = 600
    await page.getByRole('button', { name: 'Create Shipment', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Create Shipment', exact: true })).toBeDisabled()
    await expect(page.getByTestId('saved')).toBeVisible()
    delayCommand = 0
    assert.equal(JSON.parse(await page.getByTestId('saved').innerText()).qr_id, qrs[0])
    // Decode real QR pixels through the camera path, then submit normally.
    console.log('Checking camera stream decoding and shipment submission')
    await openClaim(await getImage(qrs[1]), true)
    await fillShipment()
    await page.getByRole('button', { name: 'Create Shipment', exact: true }).click()
    await expect(page.getByTestId('saved')).toBeVisible()
    assert.equal(JSON.parse(await page.getByTestId('saved').innerText()).qr_id, qrs[1])
    viewer = admin
    await page.goto(`${base}?view=qr-batch&batch=${batch.id}`)
    await expect(page.getByText('Claimed', { exact: true })).toHaveCount(2)
    await page.reload(); await expect(page.getByText('Claimed', { exact: true })).toHaveCount(2)
    await page.goto(`${base}?view=qr-batches`)
    await expect(page.getByRole('table').getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
    await actor(admin)
    const unused = await command('generate_qr_batch', { quantity: 2 })
    await page.reload()
    const unusedRow = page.getByRole('row').filter({ hasText: unused.id })
    await unusedRow.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('dialog').getByRole('textbox').fill('delete')
    const confirm = page.getByRole('dialog').getByRole('button', { name: /Delete/ }).last()
    await confirm.focus()
    await page.keyboard.down('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.up('Enter')
    await expect(page.getByRole('row').filter({ hasText: unused.id })).toHaveCount(0)
    console.log('Checking existing shipment QR reading, copying, regular creation and label PDF')
    viewer = merchant
    await page.goto(`${base}?view=qr-claim`)
    await page.getByRole('button', { name: 'Read Shipment QR', exact: true }).click()
    await page.locator('input[type=file]').setInputFiles({ name: 'claimed-shipment.png', mimeType: 'image/png', buffer: image })
    await expect(page.locator('#shipment-recipient_name')).toHaveValue('QR Browser Recipient')
    await expect(page.getByText('This QR will be claimed only after', { exact: false })).toHaveCount(0)
    await page.getByRole('button', { name: 'Create Shipment', exact: true }).click()
    await expect(page.getByTestId('saved')).toBeVisible()
    const copy = JSON.parse(await page.getByTestId('saved').innerText())
    assert.notEqual(copy.qr_id, qrs[0])
    await page.goto(`${base}?view=qr-claim`)
    await page.getByRole('button', { name: 'Create Shipment QR', exact: true }).click()
    await fillShipment()
    await page.getByRole('button', { name: 'Create Shipment', exact: true }).click()
    await expect(page.getByTestId('saved')).toBeVisible()
    const regular = JSON.parse(await page.getByTestId('saved').innerText())
    assert(!qrs.includes(regular.qr_id))
    assert.notEqual(regular.qr_id, copy.qr_id)
  }
  // This exercises only the pre-existing shipment-label fixture/print pipeline;
  // generated QR batches deliberately have no printing or export controls.
  await page.goto(`${base}?view=label`)
  await expect(page.getByRole('img', { name: 'Shipment QR', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Build PDF', exact: true }).click()
  await page.waitForFunction(() => window.pdfResult, undefined, { timeout: 60000 })
  const pdf = await page.evaluate(() => window.pdfResult)
  assert.equal(pdf.type, 'application/pdf'); assert(pdf.size > 1000)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await getDocument({ data: Uint8Array.from(pdf.buffer), useSystemFonts: true }).promise
  assert.equal(document.numPages, 1)
  const firstPage = await document.getPage(1)
  assert(Math.abs(firstPage.view[2] - (100 * 72) / 25.4) < 1)
  assert(Math.abs(firstPage.view[3] - (100 * 72) / 25.4) < 1)
  await document.destroy()
  assert.deepEqual(errors, [])
  console.log(process.argv.includes('--label-only') ? 'Passed: existing 100 × 100 mm shipment label PDF.' : 'Passed: real browser → RPC → PostgreSQL generation, organization selection/unlink, reload, activation, pagination/loading/retry, mobile/RTL, upload and camera QR decoding, cancel/failure/retry, atomic persisted claims, guarded deletion, existing QR reading/copying/creation and label PDF.')
} catch (error) {
  await page.screenshot({ path: 'artifacts/postal/qr-batches/failure.png', fullPage: true })
  console.error((await page.locator('body').innerText()).slice(0, 3500), errors)
  throw error
} finally {
  await browser.close(); await pg.close()
}
