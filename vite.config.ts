import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { execSync } from 'child_process'

function getGitInfo() {
    try {
        const message = execSync('git log -1 --pretty=%s', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim()
        const hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim()
        const date = execSync('git log -1 --pretty=%ci', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim()
        return { message, hash, date }
    } catch {
        return { message: '', hash: '', date: '' }
    }
}

export default defineConfig(({ mode }) => {
    const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM)
    const git = getGitInfo()

    // Debug: Log env loading during build
    console.log('[Vite Config] Mode:', mode)
    console.log('[Vite Config] __dirname:', __dirname)

    return {
        base: isTauriBuild ? './' : '/',
        plugins: [
            react(),
            VitePWA({
                disable: isTauriBuild,
                injectRegister: false,
                // `/sw.js` is the stable, locally controlled worker in public/.
                // Keep this generated Workbox artifact under another name so a
                // A web deployment never replaces that update gate.
                filename: 'workbox-sw.js',
                registerType: 'prompt',
                includeAssets: ['logo.png', 'pwa-icon.png'],
                manifest: {
                    name: 'Atlas',
                    short_name: 'Atlas',
                    description: 'Offline-first Enterprise Resource Planning System',
                    theme_color: '#0f172a',
                    background_color: '#0f172a',
                    display: 'standalone',
                    icons: [
                        {
                            src: 'pwa-icon.png',
                            sizes: '192x192',
                            type: 'image/png'
                        },
                        {
                            src: 'pwa-icon.png',
                            sizes: '512x512',
                            type: 'image/png'
                        },
                        {
                            src: 'pwa-icon.png',
                            sizes: '512x512',
                            type: 'image/png',
                            purpose: 'any maskable'
                        }
                    ]
                },
                workbox: {
                    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB limit
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,wasm}'],
                    cleanupOutdatedCaches: true,
                    clientsClaim: false,
                    skipWaiting: false,
                    navigateFallback: null,
                    runtimeCaching: [
                        {
                            urlPattern: ({ request, url }) =>
                                request.mode === 'navigate'
                                && !/^\/marketplace(?:\/.*)?$/.test(url.pathname)
                                && !/^\/s(?:\/.*)?$/.test(url.pathname),
                            handler: 'NetworkFirst',
                            options: {
                                cacheName: 'atlas-navigation',
                                expiration: {
                                    maxEntries: 20,
                                    maxAgeSeconds: 24 * 60 * 60
                                },
                                cacheableResponse: {
                                    statuses: [200]
                                },
                                precacheFallback: {
                                    fallbackURL: 'index.html'
                                }
                            }
                        },
                        {
                            urlPattern: /\.wasm$/,
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'atlas-wasm',
                                expiration: {
                                    maxEntries: 5,
                                    maxAgeSeconds: 60 * 60 * 24 * 30
                                },
                                cacheableResponse: {
                                    statuses: [200]
                                }
                            }
                        },
                        {
                            urlPattern: ({ url }) =>
                                url.pathname.startsWith('/api-xeiqd')
                                || url.pathname.startsWith('/api-forexfy')
                                || url.pathname.startsWith('/api-pmcgroup'),
                            handler: 'NetworkFirst',
                            options: {
                                cacheName: 'atlas-api-cache',
                                expiration: {
                                    maxEntries: 50,
                                    maxAgeSeconds: 60 * 60
                                },
                                cacheableResponse: {
                                    statuses: [0, 200]
                                }
                            }
                        }
                    ]
                }
            })
        ],
        // Fallback or explicit host parsing for Tauri mobile dev
        server: {
            // Tauri expects a fixed port, fail if that port is not available
            port: 1420,
            strictPort: true,
            // If the host is provided by Tauri CLI, tell Vite to listen on it
            host: process.env.TAURI_DEV_HOST || true,
            hmr: process.env.TAURI_DEV_HOST ? {
                protocol: 'ws',
                host: process.env.TAURI_DEV_HOST,
                port: 1421,
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
                },
                '/api-pmcgroup': {
                    target: 'https://t.me/s/PMCgroup',
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api-pmcgroup/, ''),
                    headers: {
                        'Referer': 'https://t.me/s/PMCgroup',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                }
            }
        },
        optimizeDeps: {
            exclude: ['@sqlite.org/sqlite-wasm']
        },
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src'),
                'react-native': path.resolve(__dirname, './src/lib/reactNativeWebShim.tsx')
            }
        },
        define: {
            __ATLAS_GIT_COMMIT_MESSAGE__: JSON.stringify(git.message),
            __ATLAS_GIT_COMMIT_HASH__: JSON.stringify(git.hash),
            __ATLAS_GIT_COMMIT_DATE__: JSON.stringify(git.date),
        },
        build: {
            // The custom service worker reads this at update time and caches
            // every generated JS/CSS asset before activating a deployment.
            // Without it, an offline PWA can receive a new index shell whose
            // dynamic imports are not yet available locally.
            manifest: 'atlas-assets.json',
            rollupOptions: {
                input: {
                    main: path.resolve(__dirname, 'index.html'),
                    marketplace: path.resolve(__dirname, 'marketplace.html')
                },
                output: {
                    manualChunks(id) {
                        const normalizedId = id.replace(/\\/g, '/')
                        const isPackage = (packageName: string) =>
                            normalizedId.includes(`/node_modules/${packageName}/`)

                        if (normalizedId.includes('vite/preload-helper')) {
                            return 'preload-helper'
                        }

                        if (normalizedId.includes('commonjsHelpers')) {
                            return 'commonjs-helpers'
                        }

                        if (!normalizedId.includes('/node_modules/')) {
                            return undefined
                        }

                        if (isPackage('@supabase/supabase-js') || normalizedId.includes('/node_modules/@supabase/')) {
                            return 'vendor-supabase'
                        }

                        if (
                            isPackage('dexie')
                            || isPackage('dexie-react-hooks')
                            || isPackage('@sqlite.org/sqlite-wasm')
                        ) {
                            return 'vendor-db'
                        }

                        if (
                            isPackage('react') ||
                            isPackage('react-dom') ||
                            isPackage('scheduler') ||
                            isPackage('wouter') ||
                            isPackage('i18next') ||
                            isPackage('react-i18next')
                        ) {
                            return 'vendor-react'
                        }

                        if (normalizedId.includes('/node_modules/@radix-ui/') || isPackage('lucide-react')) {
                            return 'vendor-ui'
                        }

                        if (isPackage('xlsx')) {
                            return 'vendor-xlsx'
                        }

                        if (
                            isPackage('react-spreadsheet') ||
                            isPackage('fast-formula-parser') ||
                            isPackage('use-context-selector') ||
                            isPackage('array.prototype.flatmap')
                        ) {
                            return 'vendor-spreadsheet'
                        }

                        if (
                            isPackage('html2canvas') ||
                            isPackage('jspdf') ||
                            isPackage('canvg') ||
                            isPackage('dompurify') ||
                            isPackage('fflate') ||
                            isPackage('fast-png')
                        ) {
                            return 'vendor-pdf'
                        }

                        if (
                            isPackage('@react-pdf/renderer') ||
                            normalizedId.includes('/node_modules/@react-pdf/') ||
                            isPackage('fontkit') ||
                            isPackage('yoga-layout')
                        ) {
                            return 'vendor-react-pdf'
                        }

                        if (
                            isPackage('@lyfie/luthor') ||
                            isPackage('@lyfie/luthor-headless') ||
                            isPackage('lexical') ||
                            normalizedId.includes('/node_modules/@lexical/')
                        ) {
                            return 'vendor-notebook'
                        }
                    }
                }
            },
            chunkSizeWarningLimit: 1000
        }
    }
})
