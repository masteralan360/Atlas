import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { hostedCatalog, hostedDenominator, hostedTestCount, selectedDenominator } from './salesOrdersManifest.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const label = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
const rows = hostedCatalog.map((domain, index) => `| ${domain.id} | ${cell(domain.name)} | ${domain.cases.length} | ${hostedDenominator[index].tests.toLocaleString('en-US')} |`).join('\n')
const domainDiagram = hostedCatalog.map(domain => `    D${domain.id}["${domain.id} · ${label(domain.name)}"]\n    Suite --> D${domain.id}`).join('\n')
const domainPages = hostedCatalog.map(domain => `## ${domain.id} · ${domain.name}

Hosted action surface: ${domain.route}.

Database graph: ${domain.db}.

Cross checks: ${domain.cross}.

\`\`\`mermaid
flowchart LR
    D${domain.id}["${label(domain.name)}"]
${domain.cases.map(family => `    ${family.id.replaceAll('-', '_')}["${family.id}<br/>${label(family.name)}"]\n    D${domain.id} --> ${family.id.replaceAll('-', '_')}`).join('\n')}
\`\`\`

| Family | Scenario | Action path | Independent integrity witness | Registered tests |
| --- | --- | --- | --- | ---: |
${domain.cases.map(family => `| ${family.id} | ${cell(family.name)} | ${cell(family.path)} | ${cell(family.integrity)} | ${selectedDenominator([family.id]).toLocaleString('en-US')} |`).join('\n')}`).join('\n\n')

const document = `# Sales Orders hosted Supabase coverage

This document is generated from the executable catalog and choice matrix. Rebuild it with \`node scripts/dev-testing/buildSalesOrdersCoverage.mjs\` after changing registration.

The generated hosted catalog exposes **30 action groups, 418 scenario families, and ${hostedTestCount.toLocaleString('en-US')} registered tests**. The suite registry also exposes the standalone \`agent-refund-statement\` and \`agent-account-netting\` hosted checks. These are Supabase-only selections. The runner launches live wrappers directly, without first running the isolated Sales Orders suite. The existing isolated selection remains independently available.

The finite Quick Order product is exhaustively enumerated. Continuous amounts, unlimited line counts, arbitrary historical database contents, external services, and unbounded action sequences cannot have a finite exhaustive enumeration. Those use explicit boundary partitions, prepared fixtures, replay/race probes, and seeded sequences. A catalog family describes its coverage objective; a passing representative does not establish every unbounded permutation in that family. Missing prerequisites remain blocked and do not count as passes.

## Run commands

\`\`\`powershell
# Inspect the exact registered denominator without credentials or database writes.
node scripts/dev-testing/cli.mjs --list-hosted-sales-orders

# All thirty hosted groups. This is a long-running selection.
node scripts/dev-testing/cli.mjs --suite sale-orders --environment hosted-supabase

# One independently selectable group.
node scripts/dev-testing/cli.mjs --suite sale-orders --environment hosted-supabase --groups hosted-financing
node scripts/dev-testing/cli.mjs --suite sale-orders --environment hosted-supabase --groups agent-account-netting

# Stable family IDs select every generated variant within those families.
node scripts/dev-testing/cli.mjs --suite sale-orders --environment hosted-supabase --cases SO-H12-01,SO-H17-01,SO-H20-03 --seed 20260918 --samples 16
\`\`\`

Use the group IDs in \`src/dev/testing/suites.json\`; the CLI rejects unknown IDs. \`--samples\` affects generated model sequences only. It never reduces the finite Quick Order product, currency pairs, or schedule counts. Each test has its full variant in the result title and evidence. A selected family cannot silently reduce to an empty passing group.

The Quick Order group permits a seven-day group timeout; other groups permit one day. Each ordinary test is bounded separately. The 11,187 Quick Order cases alone can require days of hosted requests. Cancel stops the owned hosted child and retains its checkpoint and completed evidence. Do not run the full matrix unintentionally while checking one change.

## Verified target and prerequisites

Credentials are read from the existing gitignored \`.env.atlas-live-tests.local\`. Use a public Supabase key and ordinary authenticated DEV TEST account. The preflight verifies project origin, exact workspace ID/name, admin identity, accessible workspaces, cloud/hybrid mode, schema, and services capability. It never accepts a service-role key. All HTTP traffic is restricted to that Supabase HTTPS origin; external rate feeds, R2, browser printing, native SQLite, and local sync are outside this hosted selection.

The configured account is the main action actor. An independent Supabase client observes the resulting records with the same verified actor session. Observation is a fresh Data API read; mutation return values and Dexie rows do not supply integrity evidence. The production helpers need IndexedDB for their cache, so the runner provides an in-memory browser cache and hydrates prerequisites from Supabase. Repayment prerequisites use forced hosted hydration so an earlier table freshness window cannot omit a just-created loan. A successful cache write cannot make a failed hosted write pass.

Additional personas, prepared DEV TEST fixtures, and an optional private read-only observer are supplied through gitignored \`.atlas-sales-order-hosted.local.json\`. The suite does not create or impersonate missing accounts. Example shape, with placeholders only:

\`\`\`json
{
  "personas": {
    "staff": { "email": "configured staff email", "password": "local secret", "role": "staff", "workspaceId": "DEV TEST workspace UUID", "workspaceName": "DEV TEST Atlas" },
    "viewer": { "email": "configured viewer email", "password": "local secret", "role": "viewer", "workspaceId": "DEV TEST workspace UUID", "workspaceName": "DEV TEST Atlas" },
    "foreign-workspace": { "email": "second test account email", "password": "local secret", "role": "admin", "workspaceId": "second DEV TEST workspace UUID", "workspaceName": "DEV TEST Other" }
  },
  "fixtures": {
    "SO-H05-03": { "customUnitId": "existing unit UUID", "unitName": "test custom unit" },
    "SO-H13-11": { "customUnitId": "existing unit UUID", "unitName": "test custom unit" },
    "SO-H24-01": { "marketplaceOrderId": "prepared pending DEV TEST order UUID" },
    "SO-H29-01": { "orderId": "prepared legacy DEV TEST order UUID" },
    "SO-H30-08": { "orderId": "owned interrupted DEV TEST order UUID", "operationPayload": { "p_order_id": "same order UUID", "p_workspace_id": "same test workspace UUID", "p_operation_id": "original operation UUID", "p_items": [], "p_changes": [] } }
  },
  "observer": { "url": "https://configured-project.supabase.co/functions/v1/read-only-test-observer", "bearer": "local observer token" }
}
\`\`\`

The example is a shape guide, not executable seed data. Prepared fixtures must have the required existing records and scenario state. Fixture requirements are implemented in \`src/dev/testing/hosted/salesOrders/requirements.ts\` and validated by their handler. Historical orders and marketplace fixtures must identify themselves as DEV TEST. Persona roles and workspace membership are checked against the server. Special permission persona names are \`revoked-member\`, \`orders-disabled\`, \`own-only\`, \`storage-restricted\`, \`revoked-permission\`, \`commission-restricted\`, and \`restricted-staff\`.

The optional observer is needed for private operation receipts in SO-H12-12/13. It must be an already configured read-only Edge Function on the same project origin. Its response must declare \`readOnly: true\`, the correct \`workspaceId\`, and a \`receipts\` array with operation ID and payload hash. The suite does not deploy an observer or use elevated database credentials. Its full request/response contract is in \`security.ts\`.

Fixtures for legacy corruption, changed permissions, disabled entitlements, storefront placement, tracked commissions, automatic settlement, shifts, and invoice versions are explicit prerequisites. The runner reports them as blocked when absent. A blocked test prevents the run from becoming green. It is different from a rejected action that successfully proves a validation rule.

## Choice and action diagrams

\`\`\`mermaid
flowchart TD
    Suite["Sales Orders · hosted Supabase"]
${domainDiagram}
\`\`\`

\`\`\`mermaid
flowchart LR
    Actor["Verified actor / configured permission persona"] --> Request["Actual production helper, Data API, RPC or Edge Function"]
    Request --> Commit["Supabase validation and committed records"]
    Commit --> Read["Independent paginated database reads"]
    Read --> Oracle["Independent arithmetic, links, conservation and immutability checks"]
    Oracle --> Evidence["Per-step evidence and checkpoint"]
    Evidence --> Next["Next action or terminal sweep"]
    Next --> Request
    Oracle --> Failure["Failure graph retained; no automatic business repair"]
    Actor --> Missing["Missing prerequisite → blocked"]
\`\`\`

\`\`\`mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Requested: approval required
    Requested --> Draft: admin approval
    Draft --> Pending: valid payment or financing + reservation
    Pending --> Completed: atomic stock completion
    Draft --> Cancelled: permitted cancellation
    Pending --> Cancelled: financing and payment reversal
    Completed --> PartialReturn: posted paid/free return
    PartialReturn --> PartialReturn: another remaining portion
    PartialReturn --> FullReturn: final remaining portions
    Completed --> FullReturn: whole order return
    PartialReturn --> PartialReturn: immutable post-return correction
    FullReturn --> FullReturn: immutable post-return correction
    Cancelled --> Archived: eligible terminal order
    FullReturn --> Archived: eligible terminal order
    Archived --> Unarchived: flag-only round trip
\`\`\`

Quick Order family SO-H13-11 enumerates **9,600 tuples**: eight payment methods × three target states × four currencies × paid/unpaid × account/no account × approval/no approval × physical/service/mixed/free lines × applicable base/carton/custom unit × financing initial payment 0/25. Service-only uses its applicable base-unit branch. Financed methods have both initial payment classes. Unsupported tuples are retained as explicit negative probes. SO-H13-01…10 add focused method/state matrices, bringing generated Quick Order tuples to **11,184**, plus three non-tuple contract families.

Other explicit expansions include all 16 ordered currency pairs for create/draft currency edits; 15 rate-source/side provenance branches; every installment count 1…120 across weekly/biweekly/monthly; leap/month/year date partitions; 32 post-return correction currency/sign combinations; 24 standard method/currency account variants; zero/positive fixed commissions and both manual commission types; 45 status/payment/return filter combinations; hosted pagination populations 0/1/199/200/201/501/1001; and 26 request/response interruption boundaries across save, approval, cancellation, settlement, and return chains. Atomic cancellation can be interrupted at its RPC boundary; this suite cannot pause inside a server transaction.

## Independent database oracle

The graph reader paginates every scoped table with stable primary-key ordering, batches large ID sets, discovers tagged orders whose response was lost, and rejects missing results, duplicate/repeated pages, denial, and schema drift. It reads the order, catalog, inventory/batches/history, payment transactions and their counter-entries, loan/schedule/repayments, return headers/items, assignments/commission lanes, payment account balances/movements, invoice metadata, and marketplace origins.

After each action and again at the terminal step, independent calculations check tenant and identity links; selected-to-base paid/free quantities; line and commercial totals; net payment and balance; immutable linked reversals; stock changes explained by movement history; batch bounds; account movement and balance derivation; loan and installment balance; net receipt remaining after partial refunds; original and returned amounts; post-return history; commission attribution; invoice version links; and eligible terminal flags. Scenario-specific assertions verify exact expected values, response-loss replay, rejection atomicity, and permitted race results. Ledger scenarios also read the persisted partner summary and compare currency-specific statements to independently derived obligations.

Money is compared at the application's three-decimal boundary and inventory at six decimals. A partial financed return reduces the current principal by the returned amount; a full financed return preserves the prior current principal as history. An original loan payment remains positive and its refund remains a separate negative linked transaction; the loan receipt stores its remaining net portion. These distinctions are tested rather than treating a historical original amount as the remaining balance.

## Sales-agent account credit netting

The standalone \`agent-account-netting\` selection creates two DEV TEST sales-account-agent order loans and a persisted partner-account credit. It checks that Payments applies the credit oldest-first, that the remaining obligation equals the partner statement balance, that an overpayment rejected by the hosted loan-payment RPC adds no repayment records, and that Collect records the reduced amount through the existing loan-payment and payment-transaction path. Independent Supabase reads confirm the older loan remains unchanged, the collected loan has the expected remaining gross balance, and the partner has no remaining collectible net balance. The source loans and account-credit transaction stay in Supabase for audit.

## Reports, retention, and review

The main checkpoint/report is \`.atlas-test-runs/<run-id>/report.json\`; step evidence is under \`hosted/<family-id>/<fixture-tag>.json\`. It records variant, seed, fixture IDs, action path, request method/path/status, before/after SHA-256 hashes, row counts, named checks, and failed before/after graphs. Credentials, JWTs, and optional persona/observer secrets are redacted from shared runner diagnostics. Checkpoints are serialized and atomically replaced. Denominators are calculated from the executable matrix; a final count mismatch fails the selection.

Passed fixture cleanup retires the main owned product through the supported production action and verifies the persisted deletion flag, zero/deleted inventory positions, stock change explained by archive movements, and unchanged order/payment/return/loan/commission/account history. Cleanup verification failure fails the test. Orders, positive and reversal payments, inventory history, returns, commissions, loans, accounts, and extra catalog fixtures remain for audit. Failed fixtures are retained. There is no recursive table wipe, balance rewrite, or repair during assertions. Long runs consequently grow the DEV TEST database. Retention is not proof that every commercial workflow has been financially unwound.

The runner families SO-H30-01/02 verify registration and hosted evidence structure; the controller's integration tests verify independent group dispatch and exact full-selection counting. They do not recursively launch another 12,000-case run. SO-H30-08 verifies exact replay of a configured original operation payload; it does not automatically infer missing payloads or restart every incomplete historical run.

Database-only checks cannot establish modal behavior, browser printing, actual PDF bytes stored in R2, mobile layout, native SQLite resilience, or external exchange-rate feeds. Invoice-version checks use already prepared hosted metadata; Realtime needs the configured publication. Rate-history checks use actual hosted orders with separately supplied historical snapshots, not a change to an external market-rate service.

## Group totals

| Domain | Hosted group | Families | Tests |
| --- | --- | ---: | ---: |
${rows}
| Total | | 418 | ${hostedTestCount.toLocaleString('en-US')} |

The following pages preserve every catalog family, its action path, integrity witness, and generated denominator. Review execution results alongside the catalog: registration is not a claim that every test has run or passed.

${domainPages}
`
await mkdir(`${root}/docs`, { recursive: true })
await writeFile(`${root}/docs/sales-orders-hosted-coverage.md`, document, 'utf8')
const registry = JSON.parse(await readFile(`${root}/src/dev/testing/suites.json`, 'utf8'))
console.log(`Wrote hosted Sales Orders coverage: ${hostedCatalog.length} groups, 418 families, ${hostedTestCount} tests. Registry parsed: ${Boolean(registry)}.`)
