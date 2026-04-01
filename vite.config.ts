import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, __dirname, '')
    const r2WorkerUrl = env.VITE_R2_WORKER_URL || ''
    const r2AuthToken = env.VITE_R2_AUTH_TOKEN || ''
    const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM)

    // Debug: Log env loading during build
    console.log('[Vite Config] Mode:', mode)
    console.log('[Vite Config] __dirname:', __dirname)
    console.log('[Vite Config] R2 Worker URL loaded:', r2WorkerUrl ? 'YES' : 'NO (empty)')
    console.log('[Vite Config] R2 Auth Token loaded:', r2AuthToken ? 'YES' : 'NO (empty)')

    return {
        base: isTauriBuild ? './' : '/',
        define: {
            __R2_WORKER_URL__: JSON.stringify(r2WorkerUrl),
            __R2_AUTH_TOKEN__: JSON.stringify(r2AuthToken)
        },
        plugins: [
            react(),
            VitePWA({
                disable: isTauriBuild,
                injectRegister: null,
                registerType: 'autoUpdate',
                includeAssets: ['logo.ico', 'logo.png'],
                manifest: {
                    name: 'Atlas',
                    short_name: 'Atlas',
                    description: 'Offline-first Enterprise Resource Planning System',
                    theme_color: '#0f172a',
                    background_color: '#0f172a',
                    display: 'standalone',
                    icons: [
                        {
                            src: 'logo.png',
                            sizes: '192x192',
                            type: 'image/png'
                        },
                        {
                            src: 'logo.png',
                            sizes: '512x512',
                            type: 'image/png'
                        },
                        {
                            src: 'logo.png',
                            sizes: '512x512',
                            type: 'image/png',
                            purpose: 'any maskable'
                        }
                    ]
                },
                workbox: {
                    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB limit
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
                    // Keep the public marketplace on its own HTML entrypoint.
                    // If the service worker serves index.html here, refreshes jump into the ERP shell.
                    navigateFallbackDenylist: [/^\/marketplace(?:\/.*)?$/, /^\/s(?:\/.*)?$/]
                }
            })
        ],
        // Fallback or explicit host parsing for Tauri mobile dev
        server: {
            // Tauri expects a fixed port, fail if that port is not available
            port: 5173,
            strictPort: true,
            // If the host is provided by Tauri CLI, tell Vite to listen on it
            host: process.env.TAURI_DEV_HOST || true,
            hmr: process.env.TAURI_DEV_HOST ? {
                protocol: 'ws',
                host: process.env.TAURI_DEV_HOST,
                port: 5174,
            } : undefined,
            // Setup watch to ignore Tauri files
            watch: {
                ignored: ['**/src-tauri/**']
            },
            proxy: {
                '/api-xeiqd': {
                    target: 'https://xeiqd.com',
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api-xeiqd/, ''),
                    headers: {
                        'Referer': 'https://xeiqd.com',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                },
                '/api-forexfy': {
                    target: 'https://forexfy.app',
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api-forexfy/, ''),
                    headers: {
                        'Referer': 'https://forexfy.app',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                }
            }
        },
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src')
            }
        },
        build: {
            rollupOptions: {
                input: {
                    main: path.resolve(__dirname, 'index.html'),
                    marketplace: path.resolve(__dirname, 'marketplace.html')
                },
                output: {
                    manualChunks: {
                        'vendor-supabase': ['@supabase/supabase-js'],
                        'vendor-db': ['dexie', 'dexie-react-hooks'],
                        'vendor-react': ['react', 'react-dom', 'wouter', 'i18next', 'react-i18next'],
                        'vendor-ui': [
                            '@radix-ui/react-dialog',
                            '@radix-ui/react-dropdown-menu',
                            '@radix-ui/react-select',
                            '@radix-ui/react-switch',
                            '@radix-ui/react-tabs',
                            '@radix-ui/react-toast',
                            'lucide-react'
                        ],
                        'vendor-charts': ['recharts'],
                        'vendor-spreadsheet': ['xlsx', 'react-spreadsheet', 'scheduler'],
                        'vendor-pdf': ['@react-pdf/renderer', 'jspdf', 'html2canvas']
                    }
                }
            },
            chunkSizeWarningLimit: 1000
        }
    }
})
