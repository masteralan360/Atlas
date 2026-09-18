import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../', import.meta.url))
export default defineConfig({
    root,
    envDir: false,
    resolve: { alias: { '@': path.join(root, 'src') } },
    define: {
        'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://atlas-tests.invalid'),
        'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-test-placeholder'),
        'import.meta.env.VITE_R2_WORKER_URL': JSON.stringify('https://atlas-tests.invalid')
    },
    test: {
        environment: 'node',
        include: ['src/**/*.test.{ts,tsx}'],
        setupFiles: [path.join(root, 'scripts/dev-testing/networkGuard.ts')],
        testTimeout: 30_000,
        hookTimeout: 30_000,
        retry: 0,
        isolate: true,
        pool: 'forks'
    }
})
