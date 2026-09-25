import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../', import.meta.url))
if (!process.env.ATLAS_LIVE_SUPABASE_URL || !process.env.ATLAS_LIVE_SUPABASE_KEY
  || !process.env.ATLAS_LIVE_RUN_ID) throw new Error('live_config_missing')

export default defineConfig({
  root,
  envDir: false,
  resolve: { alias: { '@': path.join(root, 'src') } },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(process.env.ATLAS_LIVE_SUPABASE_URL),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(process.env.ATLAS_LIVE_SUPABASE_KEY),
    'import.meta.env.VITE_R2_WORKER_URL': JSON.stringify('https://atlas-tests.invalid'),
    'import.meta.env.VITE_WEB_USAGE_GATEWAY_URL': JSON.stringify(''),
    'import.meta.env.VITE_WEB_STORAGE_USAGE_GATEWAY_URL': JSON.stringify('')
  },
  test: {
    environment: 'node',
    include: ['src/dev/testing/suites/*Live.test.ts'],
    setupFiles: [path.join(root, 'scripts/dev-testing/liveNetworkGuard.ts')],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    retry: 0,
    isolate: true,
    pool: 'forks'
  }
})
