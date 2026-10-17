import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Hybrid Playwright copy and every prepared scenario are localized in English, Kurdish, and Arabic', async () => {
  for (const locale of ['en', 'ku', 'ar']) {
    const content = JSON.parse(await readFile(new URL(`../../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'))
    const copy = content.devTesting.salesOrderHybrid
    assert.equal(copy.buttonLabel, 'Hybrid Playwright')
    assert.ok(copy.label.includes('Hybrid Playwright'))
    for (const id of ['SO-HYB-001', 'SO-HYB-002', 'SO-HYB-003', 'SO-HYB-004', 'SO-HYB-005', 'SO-HYB-006', 'SO-HYB-007', 'SO-HYB-008']) {
      assert.ok(copy.scenarioNames[id], `${locale} has no name for ${id}`)
    }
    for (const reason of ['liveConfigMissing', 'hybridRequired', 'capabilityUnavailable', 'runnerBoundary', 'desktopRuntimeUnavailable']) {
      assert.ok(copy.reasons[reason], `${locale} has no user-facing ${reason} explanation`)
    }
    for (const label of ['missingCapabilities', 'preparedDimensions', 'cleanupRequirementsHelp']) {
      assert.ok(copy[label], `${locale} has no user-facing ${label} label`)
    }
    for (const tag of ['customer-product-unlink', 'completion-fulfillment', 'approval-rejection', 'quantity-boundaries', 'discounts', 'payment-account-optional', 'payment-reversals', 'role-restrictions', 'plan-entitlements', 'service-items', 'alternate-uom', 'currency-conversion', 'payment-ledger', 'returns-refunds', 'approval-roles', 'failed-request-retry', 'lost-response-recovery', 'native-sqlite', 'desktop-restart']) {
      assert.ok(copy.coverage[tag], `${locale} has no user-facing ${tag} coverage label`)
    }
    assert.ok(copy.capabilities.payments, `${locale} has no payment capability label`)
  }
})
