import { createServer } from 'vite'
import { randomBytes } from 'node:crypto'
const manifest = JSON.parse(process.env.SORL_MANIFEST ?? '{}')
if (!/^DEV TEST SORL [0-9a-f-]{36}$/.test(manifest.namespace ?? '')) throw new Error('resilience_browser_manifest_missing')
const server = await createServer({ envDir: false, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(manifest.url),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(manifest.key),
  'import.meta.env.VITE_ENCRYPTION_KEY': JSON.stringify(randomBytes(32).toString('hex')),
  'import.meta.env.VITE_WEB_USAGE_GATEWAY_URL': JSON.stringify(''),
  'import.meta.env.VITE_WEB_STORAGE_USAGE_GATEWAY_URL': JSON.stringify(''),
  'import.meta.env.VITE_R2_WORKER_URL': JSON.stringify('https://atlas-tests.invalid')
}, server: { host: '127.0.0.1', port: 5175, strictPort: true } })
await server.listen()
process.once('SIGTERM', async () => { await server.close(); process.exit(0) })
