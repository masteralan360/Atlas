import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src')
        }
    },
    test: {
        environment: 'node',
        exclude: ['src/dev/testing/**/*Live.test.ts', 'src/dev/testing/salesOrderResilience/e2e/**', '**/node_modules/**', '**/dist/**'],
        include: [
            'src/**/*.{test,spec}.{ts,tsx}',
            'cloudflare-worker/src/**/*.{test,spec}.js',
            'cloudflare-web/src/**/*.{test,spec}.js',
            'scripts/**/*.{test,spec}.mjs'
        ]
    }
})
