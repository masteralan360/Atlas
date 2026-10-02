import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
export default defineConfig({
    testDir: '../../src/dev/testing/salesOrderResilience/e2e',
    timeout: 180_000, expect: { timeout: 45_000 }, workers: 1, fullyParallel: false, retries: 0,
    outputDir: '../../.atlas-dev-testing/browser-results', reporter: [['list']],
    // Login traces include credentials and JWTs; retain only screenshots of masked UI.
    use: { baseURL: 'http://127.0.0.1:5175', trace: 'off', screenshot: 'only-on-failure', serviceWorkers: 'block' },
    projects: [
        { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
        { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } }
    ],
    webServer: { cwd: fileURLToPath(new URL('../../', import.meta.url)), command: 'node scripts/dev-testing/resilience.browser.mjs', url: 'http://127.0.0.1:5175', reuseExistingServer: false, timeout: 120_000 }
})
