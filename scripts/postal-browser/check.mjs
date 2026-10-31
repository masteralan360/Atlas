import { chromium } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const pg = new PGlite();
const w = "00000000-0000-4000-8000-000000000001",
  admin = "00000000-0000-4000-8000-000000000010",
  merchant = "00000000-0000-4000-8000-000000000011",
  office = "00000000-0000-4000-8000-000000000012";
await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE SCHEMA crm; CREATE TABLE crm.business_partners(id uuid PRIMARY KEY,workspace_id uuid,partner_name text,is_deleted boolean); CREATE TABLE crm.agents(id uuid PRIMARY KEY,workspace_id uuid,business_partner_id uuid,agent_type text,status text,is_deleted boolean); CREATE FUNCTION public.workspace_module_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT COALESCE(nullif(current_setting('test.uid',true),''),'${merchant}')::uuid$$;
 CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$SELECT '${w}'::uuid$$;
 CREATE TABLE public.workspaces(id uuid PRIMARY KEY,data_mode text,deleted_at timestamptz,plan text DEFAULT 'enterprise');
 CREATE TABLE public.profiles(id uuid PRIMARY KEY,name text,role text,workspace_id uuid,current_workspace uuid);
 CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql AS $$SELECT role FROM public.profiles WHERE id=auth.uid()$$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}',raw_app_meta_data jsonb DEFAULT '{}');
 CREATE TABLE public.keys(key_name text,key_value text); INSERT INTO public.keys VALUES('staff','test-only');
 CREATE TABLE public.workspace_access_overrides(workspace_id uuid,type text,key text,value text);
 CREATE TABLE public.workspace_permissions(workspace_id uuid,user_uuid uuid,key text NOT NULL,module text NOT NULL,
  CONSTRAINT workspace_permissions_no_retired_modules CHECK(COALESCE(key,'') NOT LIKE 'postService.%' AND COALESCE(module,'')<>'postService'));
 CREATE TABLE public.payment_transactions(id uuid PRIMARY KEY,workspace_id uuid,source_module text,source_type text,source_record_id uuid,source_subrecord_id uuid,direction text,amount numeric,currency text,payment_method text,paid_at timestamptz,counterparty_name text,reference_label text,note text,created_by uuid,account_id uuid,account_name_snapshot text,metadata jsonb);
 INSERT INTO public.workspaces(id,data_mode,deleted_at) VALUES('${w}','cloud',NULL);
 INSERT INTO public.profiles VALUES('${admin}','Admin','admin','${w}','${w}');
 INSERT INTO public.profiles VALUES('${office}','Office','staff','${w}','${w}');
 INSERT INTO public.workspace_access_overrides VALUES('${w}','module','postal_service','grant');`);
await pg.exec(
  await readFile(
    new URL(
      "../../supabase/migrations/20261024003737_postal_service.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
await pg.exec(
  await readFile(
    new URL(
      "../../supabase/migrations/20261024004656_postal_registration_permission_keys.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
await pg.exec(
  await readFile(
    new URL(
      '../../supabase/migrations/20261024094518_postal_dashboard_summary.sql',
      import.meta.url,
    ),
    'utf8',
  ),
);
await pg.exec(
  await readFile(
    new URL(
      '../../supabase/migrations/20261024174745_add_postal_shipment_numbers.sql',
      import.meta.url,
    ),
    'utf8',
  ),
);
await pg.exec(
  await readFile(
    new URL(
      '../../supabase/migrations/20261024181523_postal_shipment_id_display_format.sql',
      import.meta.url,
    ),
    'utf8',
  ),
);
for (const name of [
  '20261027223702_postal_shipment_tariffs_and_delivery_fees',
  '20261031173159_postal_create_shipments_for_admin_and_office',
  '20261031203510_postal_assign_tariff_during_creation',
]) await pg.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
await pg.query("INSERT INTO public.workspace_permissions VALUES($1,$2,'postService.officeEmployee','postService')", [w,office]);
await pg.query("SELECT public.postal_prepare_registration($1,$2,$3::jsonb)", [
  merchant,
  "merchant@postal.test",
  JSON.stringify({
    workspace_id: w,
    actor_id: admin,
    mode: "create",
    name: "Browser merchant",
  }),
]);
await pg.query(
  `INSERT INTO auth.users(id,email) VALUES($1,'merchant@postal.test')`,
  [merchant],
);
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.PLAYWRIGHT_CHANNEL ??
    (process.platform === "win32" ? "msedge" : undefined),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultNavigationTimeout(90000);
await page.addInitScript(() => {
  window.__ATLAS_POSTAL_BROWSER_TEST__ = true;
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/rest/v1/**", async (route) => {
  const req = route.request();
  if (req.method() === "OPTIONS")
    return route.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "POST, GET, OPTIONS",
      },
    });
  if (req.method() === "GET" && req.url().includes("/postal_shipments")) {
    const qr = new URL(req.url()).searchParams
      .get("qr_id")
      ?.replace(/^eq\./, "");
    const result = await pg.query(
      "SELECT * FROM public.postal_shipments WHERE workspace_id=$1 AND qr_id=$2",
      [w, qr],
    );
    return route.fulfill({
      status: result.rows[0] ? 200 : 406,
      contentType: "application/json",
      body: JSON.stringify(result.rows[0] ?? { message: "Unavailable" }),
    });
  }
  if (req.method() === "GET" && req.url().includes("/postal_memberships")) {
    const org = new URL(req.url()).searchParams
      .get("organization_id")
      ?.replace(/^eq\./, "");
    const result = await pg.query(
      "SELECT m.user_id,m.organization_id,jsonb_build_object('name',p.name) AS profiles FROM public.postal_memberships m JOIN public.profiles p ON p.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.user_id",
      [org],
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(result.rows),
    });
  }
  if (req.method() === 'GET' && req.url().includes('/postal_branches')) {
    const branches = await pg.query('SELECT * FROM public.postal_branches WHERE workspace_id=$1 AND active ORDER BY created_at DESC,id DESC', [w]);
    return route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'content-range': `0-${branches.rows.length - 1}/${branches.rows.length}` },
      body: JSON.stringify(branches.rows) });
  }
  if (
    req.method() === "GET" &&
    /\/(accounts|balances|payment_account_member_restrictions|payment_accounts|payment_account_balances)/.test(
      req.url(),
    )
  )
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    });
  if (!req.url().endsWith("/rpc/postal_command"))
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "Unexpected fixture request" }),
    });
  const p = req.postDataJSON();
  try {
    const result = await pg.query(
      "SELECT public.postal_command($1,$2::jsonb,$3::uuid) AS result",
      [p.p_command, JSON.stringify(p.p_payload), p.p_request_id],
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(result.rows[0].result),
      headers: { "access-control-allow-origin": "*" },
    });
  } catch (error) {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ message: error.message }),
    });
  }
});
const base =
  process.env.POSTAL_BROWSER_URL ??
  "http://127.0.0.1:5188/scripts/postal-browser/index.html";
await mkdir("artifacts/postal", { recursive: true });
try {
  await page.goto(base);
  await page.getByRole("dialog").waitFor();
  await page
    .getByLabel("Primary Phone Number", { exact: false })
    .fill("07501234567");
  await page
    .getByLabel("Backup Phone Number", { exact: false })
    .fill("07701234567");
  await page
    .getByLabel("Recipient Name", { exact: false })
    .fill("Browser Recipient");
  await page.locator("#postal-governorate").click();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Erbil", exact: true })
    .click();
  await page.locator("#postal-area").click();
  await page.getByRole("button", { name: "Ankawa", exact: true }).click();
  await page.getByLabel("COD Amount", { exact: false }).fill("100000");
  assert.equal(await page.locator("#shipment-cod").inputValue(), "100,000");
  await page.getByRole("checkbox", { name: "Negative Amount" }).click();
  await page.getByLabel("COD Amount", { exact: false }).fill("");
  assert(
    await page
      .getByRole("button", { name: "Create Shipment", exact: true })
      .isDisabled(),
  );
  await page.getByLabel("COD Amount", { exact: false }).fill("25000");
  const create = page.getByRole('button', { name: 'Create Shipment', exact: true });
  const sizes = page.getByRole('group', { name: 'Shipment Size' });
  assert(await create.isDisabled());
  await sizes.getByRole('button', { name: /Small Package/ }).click();
  await page.locator('#postal-area').click();
  await page.getByRole('button', { name: 'Erbil Centre', exact: true }).click();
  assert.equal(await sizes.getByRole('button', { pressed: true }).count(), 0);
  assert(await create.isDisabled());
  await sizes.getByRole('button', { name: /Small Package.*5,000/ }).click();
  await page.locator('#postal-governorate').click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Baghdad', exact: true }).click();
  assert.equal(await sizes.getByRole('button').count(), 0);
  await page.locator('#postal-area').click();
  await page.getByRole('button', { name: 'Karrada', exact: true }).click();
  assert.equal(await sizes.getByRole('button').count(), 7);
  assert.equal(await sizes.getByRole('button', { pressed: true }).count(), 0);
  await sizes.getByRole('button', { name: /Carton.*8,000/ }).click();
  await page.locator('#postal-governorate').click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Erbil', exact: true }).click();
  await page.locator('#postal-area').click();
  await page.getByRole('button', { name: 'Ankawa', exact: true }).click();
  assert.equal(await sizes.getByRole('button', { pressed: true }).count(), 0);
  await sizes.getByRole('button', { name: /Small Package.*6,000/ }).click();
  // Reproduce a disabled form with an invalid phone above the scroll position.
  const backup = page.getByLabel("Backup Phone Number", { exact: false });
  await backup.fill("0770");
  await page.locator("#shipment-pieces").fill("5");
  const validation = page.getByTestId("shipment-validation");
  assert.match(
    await validation.innerText(),
    /Backup Phone Number: Enter a valid Iraqi mobile number/,
  );
  assert.equal(await backup.getAttribute("aria-invalid"), "true");
  assert(
    await page
      .getByRole("button", { name: "Create Shipment", exact: true })
      .isDisabled(),
  );
  await validation.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "artifacts/postal/form-validation-desktop.png",
    fullPage: true,
  });
  await validation.getByRole("button", { name: /Backup Phone Number/ }).click();
  assert.equal(
    await backup.evaluate((input) => document.activeElement === input),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await validation.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "artifacts/postal/form-validation-mobile.png",
    fullPage: true,
  });
  await validation.getByRole("button", { name: /Backup Phone Number/ }).click();
  assert.equal(
    await backup.evaluate((input) => document.activeElement === input),
    true,
  );
  const backupBox = await backup.boundingBox();
  assert(backupBox.y >= 0 && backupBox.y + backupBox.height <= 844);
  await backup.fill("07701234567");
  assert.equal(await validation.count(), 0);
  assert(
    await page
      .getByRole("button", { name: "Create Shipment", exact: true })
      .isEnabled(),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "artifacts/postal/form-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = page.getByRole("dialog");
  assert((await dialog.boundingBox()).width <= 390);
  await page.screenshot({
    path: "artifacts/postal/form-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create Shipment", exact: true })
    .click();
  await page.getByTestId("saved").waitFor();
  const saved = JSON.parse(await page.getByTestId("saved").innerText());
  assert.equal(saved.cod_amount, -25000);
  assert.equal(saved.state, "draft");
  assert.equal(saved.shipment_size, 'small_package');
  assert.equal(saved.delivery_fee, 6000);
  assert(saved.qr_id);
  const persisted = await pg.query(
    "SELECT * FROM public.postal_shipments WHERE id=$1",
    [saved.id],
  );
  assert.equal(persisted.rows.length, 1);
  await page.goto(
    `${base}?view=copy&qr=${encodeURIComponent(`atlas:postal:v1:${saved.qr_id}`)}`,
  );
  await page.getByRole("button", { name: "Read QR", exact: true }).click();
  assert.equal(
    await page.getByLabel("Recipient Name", { exact: false }).inputValue(),
    "Browser Recipient",
  );
  await page
    .getByRole("button", { name: "Create Shipment", exact: true })
    .click();
  await page.getByTestId("saved").waitFor();
  const copied = JSON.parse(await page.getByTestId("saved").innerText());
  assert.notEqual(copied.id, saved.id);
  assert.notEqual(copied.qr_id, saved.qr_id);
  assert.equal(copied.shipment_size, saved.shipment_size);
  assert.equal(copied.delivery_fee, saved.delivery_fee);
  assert.deepEqual(
    (
      await pg.query("SELECT * FROM public.postal_shipments WHERE id=$1", [
        saved.id,
      ])
    ).rows,
    persisted.rows,
  );
  await pg.query("SELECT set_config('test.uid',$1,false)", [admin]);
  const intakeBranch = (await pg.query(
    'SELECT public.postal_command($1,$2::jsonb,$3::uuid) AS result',
    ['save_branch', JSON.stringify({ workspace_id: w, name: 'Receiving Office', governorate: 'baghdad', area: 'karrada', active: true }), crypto.randomUUID()],
  )).rows[0].result;
  for (const role of ['admin', 'office']) {
    for (const override of [false, true]) {
      await pg.query("SELECT set_config('test.uid',$1,false)", [merchant]);
      const draft = (await pg.query(
        'SELECT public.postal_command($1,$2::jsonb,$3::uuid) AS result',
        ['create_shipment', JSON.stringify({ workspace_id: w, recipient_name: 'Intake review', primary_phone: '07501234567', backup_phone: '07701234567',
          governorate: 'baghdad', area: 'karrada', address: '', cod_amount: 0, pieces: null, fragile: false, delivery_notes: '', tariff_size: 'carton', delivery_fee: 8000 }), crypto.randomUUID()],
      )).rows[0].result;
      await pg.query("SELECT set_config('test.uid',$1,false)", [role === 'office' ? office : admin]);
      await page.goto(`${base}?view=receive&role=${role}&shipment=${encodeURIComponent(JSON.stringify(draft))}`);
      const reviewSizes = page.getByRole('group', { name: 'Shipment Size' });
      const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
      assert.match(await reviewSizes.getByRole('button', { pressed: true }).innerText(), /Carton[\s\S]*8,000/);
      assert(await confirm.isDisabled());
      await page.getByRole('button', { name: 'Select', exact: true }).click();
      await page.getByRole('dialog').last().getByRole('button', { name: /Receiving Office/ }).click();
      assert(await confirm.isEnabled());
      if (override) await reviewSizes.getByRole('button', { name: /Ship.*24,000/ }).click();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await page.waitForFunction(() => {
          const bounds = document.querySelector('[role="dialog"]').getBoundingClientRect();
          return bounds.width <= innerWidth && bounds.height <= innerHeight;
        });
        await reviewSizes.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `artifacts/postal/receive-${role}-${override ? 'override' : 'retain'}-${width}.png`, fullPage: true });
      }
      await confirm.click();
      await page.getByTestId('received').waitFor();
      const received = (await pg.query('SELECT * FROM public.postal_shipments WHERE id=$1', [draft.id])).rows[0];
      assert.equal(received.state, 'received');
      assert.equal(received.current_branch_id, intakeBranch.id);
      assert.equal(received.shipment_size, override ? 'ship' : 'carton');
      assert.equal(Number(received.delivery_fee), override ? 24000 : 8000);
      if (!override) assert.equal(received.tariff_assigned_by, merchant);
    }
  }
  await pg.query("SELECT set_config('test.uid',$1,false)", [merchant]);
  await page.goto(`${base}?view=timeline`);
  assert.equal(
    await page.getByTestId("postal-timeline").locator("li").count(),
    12,
  );
  assert.equal(
    await page
      .getByTestId("postal-timeline")
      .locator("ol")
      .evaluate((el) => getComputedStyle(el).flexDirection),
    "column",
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "artifacts/postal/timeline-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(
    await page
      .getByTestId("postal-timeline")
      .locator("ol")
      .evaluate((el) => getComputedStyle(el).flexDirection),
    "row",
  );
  const timeline = page.getByTestId("postal-timeline"),
    box = await timeline.boundingBox();
  await page.mouse.move(box.x + 800, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 20, { steps: 10 });
  await page.mouse.up();
  assert(await timeline.evaluate((el) => el.scrollLeft > 0));
  await page.screenshot({
    path: "artifacts/postal/timeline-desktop.png",
    fullPage: true,
  });
  for (const [choice, normalized] of [
    ["Primary Phone Number", "9647501234567"],
    ["Backup Phone Number", "9647701234567"],
  ]) {
    await page.goto(`${base}?view=contact`);
    await page.getByRole("button", { name: new RegExp(choice) }).click();
    assert.equal(
      await page
        .getByRole("link", { name: "Call", exact: true })
        .getAttribute("href"),
      `tel:+${normalized}`,
    );
    assert.equal(
      await page
        .getByRole("link", { name: "WhatsApp", exact: true })
        .getAttribute("href"),
      `https://wa.me/${normalized}`,
    );
    assert.equal(await page.getByRole("dialog").count(), 1);
  }
  await page.goto(`${base}?view=label`);
  await page.getByRole("img", { name: "Shipment QR" }).waitFor();
  const rgba = await page.evaluate(async () => {
    const svg = document.querySelector('svg[aria-label="Shipment QR"]');
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], {
        type: "image/svg+xml",
      }),
    );
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const data = Array.from(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    );
    URL.revokeObjectURL(url);
    return { data, width: canvas.width, height: canvas.height };
  });
  const { scanRGBABuffer } = await import("@undecaf/zbar-wasm");
  const decoded = await scanRGBABuffer(
    Uint8Array.from(rgba.data).buffer,
    rgba.width,
    rgba.height,
  );
  assert.equal(
    decoded[0].decode(),
    "atlas:postal:v1:00000000-0000-4000-8000-000000000022",
  );
  await page.screenshot({ path: "artifacts/postal/label.png", fullPage: true });
  await page.getByRole("button", { name: "Build PDF" }).click();
  await page.waitForFunction(() => window.pdfResult, undefined, {
    timeout: 60000,
  });
  const pdf = await page.evaluate(() => window.pdfResult);
  assert.equal(pdf.type, "application/pdf");
  assert(pdf.size > 1000);
  await writeFile(
    "artifacts/postal/shipment-label.pdf",
    Buffer.from(pdf.buffer),
  );
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: Uint8Array.from(pdf.buffer),
    useSystemFonts: true,
  }).promise;
  const firstPage = await document.getPage(1);
  assert.equal(document.numPages, 1);
  assert(Math.abs(firstPage.view[2] - (100 * 72) / 25.4) < 1);
  assert(Math.abs(firstPage.view[3] - (150 * 72) / 25.4) < 1);
  await document.destroy();
  const organization = (
    await pg.query(
      "SELECT organization_id FROM public.postal_memberships WHERE user_id=$1",
      [merchant],
    )
  ).rows[0].organization_id;
  for (const view of [
    "branch",
    "membership",
    "choose",
    "organization",
    "operation",
    "payment",
  ]) {
    await page.goto(`${base}?view=${view}&org=${organization}`);
    const modal = page.getByRole("dialog");
    await modal.waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: `artifacts/postal/${view}-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await modal.boundingBox();
    assert(bounds.width <= 390 && bounds.height <= 844);
    await page.screenshot({
      path: `artifacts/postal/${view}-mobile.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "Passed: creation tariffs and destination changes, copied tariff, admin/office intake retain/override, desktop/mobile dialogs, empty/negative IQD, repeated timeline, contact links and QR label PDF.",
  );
} finally {
  await browser.close();
  await pg.close();
}
