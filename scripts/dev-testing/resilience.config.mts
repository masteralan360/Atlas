import { mergeConfig, defineConfig } from 'vitest/config'
import base from './vitest.config.mts'
export default mergeConfig(base, defineConfig({ test: {
    include: ['src/dev/testing/salesOrderResilience/*.test.ts'],
    exclude: ['src/dev/testing/salesOrderResilience/**/*Live.test.ts'], testTimeout: 600_000, hookTimeout: 120_000
} }))
