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
        exclude: ['src/dev/testing/suites/*Live.test.ts', '**/node_modules/**', '**/dist/**'],
        include: [
            'src/**/*.{test,spec}.{ts,tsx}',
            'cloudflare-worker/src/**/*.{test,spec}.js',
            'cloudflare-web/src/**/*.{test,spec}.js',
            'scripts/**/*.{test,spec}.mjs'
        ]
    }
})
