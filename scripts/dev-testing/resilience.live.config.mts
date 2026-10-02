import { mergeConfig, defineConfig } from 'vitest/config'
import base from './vitest.live.config.mts'
export default mergeConfig(base, defineConfig({ test: {
    include: ['src/dev/testing/salesOrderResilience/**/*Live.test.ts', 'src/dev/testing/salesOrderResilience/fixtures/browserCatalog.setup.ts'], testTimeout: 3_600_000, hookTimeout: 120_000
} }))
