# Deployment Guide

## Overview

Atlas can be deployed to multiple platforms:

| Platform | Method | Notes |
|----------|--------|-------|
| Windows | Tauri NSIS Installer | Auto-updates via GitHub |
| macOS | Tauri DMG | Code signing required |
| Linux | Tauri AppImage/deb | No signing required |
| Android | Tauri APK/AAB | Play Store ready |
| Web | Cloudflare Workers Static Assets | PWA-enabled |

---
## Prerequisites

### Development Environment

```bash
# Node.js 18+
node --version

# Rust (for Tauri)
rustc --version

# Tauri CLI
cargo install tauri-cli

# Platform-specific
# Windows: Visual Studio Build Tools
# macOS: Xcode Command Line Tools
# Linux: webkit2gtk, libayatana-appindicator
```

---

## Environment Setup

### 1. Clone Repository

```bash
git clone https://github.com/masteralan360/Atlas.git
cd Atlas
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create `.env` file:

```env
# Supabase Configuration
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Optional: API Proxy for exchange rates (web only)
VITE_API_PROXY_URL=https://your-proxy.vercel.app/api
```

---

## Development

### Web Development

```bash
npm run dev
# Opens http://localhost:5173
```

### Desktop Development (Tauri)

```bash
npm run tauri dev
# Opens native window with hot reload
```

### Android Development

```bash
# Ensure Android SDK and NDK installed
npm run android:dev
# Deploys to connected device/emulator
```

---

## Building for Production

### Web Build

```bash
npm run build
# Output: dist/
```

Deploy `dist/` to any static host (Vercel, Netlify, S3, etc.)

### Desktop Build (Windows)

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/
```

Produces:
- `Atlas_x.x.x_x64-setup.exe` (NSIS installer)
- `Atlas_x.x.x_x64_en-US.msi` (MSI package)

### Desktop Build (macOS)

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/
```

Produces:
- `Atlas.app` (Application bundle)
- `Atlas_x.x.x_x64.dmg` (Disk image)

**Note**: For distribution, code signing is required.

### Desktop Build (Linux)

```bash
npm run tauri build
```

Produces:
- `atlas_x.x.x_amd64.AppImage`
- `atlas_x.x.x_amd64.deb`

### Android Build

```bash
# Debug APK
npm run android:build

# Release AAB (for Play Store)
npm run android:build:release
```

See `ANDROID_SIGNING_GUIDE.md` for signing setup.

---

## Auto-Updates (Desktop)

### Configuration

Location: `src-tauri/tauri.conf.json`

```json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/masteralan360/Atlas/releases/latest/download/latest.json"
      ],
      "dialog": true,
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6..."
    }
  }
}
```

### Release Process

1. Update version in `package.json` and `src-tauri/tauri.conf.json`
2. Create GitHub release with version tag (e.g., `v1.6.7`)
3. Build artifacts are automatically uploaded
4. App checks for updates on startup

### Signing Keys

Generate update signing keys:

```bash
tauri signer generate -w ~/.tauri/atlas.key
```

Set in environment for builds:
```bash
export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/atlas.key)
```

---

## Supabase Setup

### 1. Create Project

1. Go to [supabase.com](https://supabase.com)
2. Create new project
3. Note URL and anon key

### 2. Run Migrations

Execute SQL files in order:

```sql
-- Core schema
psql < supabase/schema.sql

-- RLS policies
psql < supabase/rls-policies.sql

-- Feature additions
psql < supabase/categories_migration.sql
psql < supabase/multi-currency-migration.sql
psql < supabase/payment-method-migration.sql
-- etc.
```

Or use Supabase CLI:

```bash
supabase db push
```

### 3. Configure Auth

In Supabase Dashboard:
- Enable Email auth
- Set Site URL and Redirect URLs
- Configure email templates

### 4. Create Storage Bucket

Create `p2p-sync` bucket for file synchronization:

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('p2p-sync', 'p2p-sync', false);
```

---

## Cloudflare Workers Deployment (Web)

Atlas Web deploys as a Worker with Static Assets. The Worker serves the Vite
SPA, the `shop.atlaserp.dev` marketplace entry point, and the authenticated
same-origin usage gateways. It does not replace Supabase or the existing
`asaas-r2-proxy` Worker.

### 1. Configure Cloudflare

1. Upgrade the Cloudflare account to Workers Paid.
2. Create a Worker named `atlas`, or allow `wrangler deploy` to create it.
3. Bind the production app domain and `shop.atlaserp.dev` to that Worker.
4. Keep the Vercel project attached until the production cutover has been
   validated; it is the rollback target.

### 2. Worker secrets

Set these encrypted Worker secrets with `wrangler secret put <NAME> --config
cloudflare-web/wrangler.toml`, or through **Workers & Pages → atlas-web →
Settings → Variables and Secrets**:

- `SUPABASE_URL` — the Supabase project URL
- `SUPABASE_ANON_KEY` — server-side copy of the public anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` — server-only; never prefix it with `VITE_`
- `R2_WORKER_URL` — URL of the existing authenticated R2 Worker

For local Worker development, put the same values in
`cloudflare-web/.dev.vars`. That file is ignored by Git.

### 3. Build-time public variables

The Vite build still needs these public values. Configure them as GitHub
Actions secrets (the included workflow reads them) or export them before a
local deploy:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### Web Live usage charging

The browser build routes metered Supabase REST and authenticated R2 CRUD through
the same-origin Worker routes at `/api-workspace-data/*`,
`/api-workspace-storage/*`, and `/api-workspace-r2/*`. Those routes record Web
Live at 20×, while the Tauri app records at 10×.

Keep the server variables above restricted to the Cloudflare Worker. Do not
publish the service-role key in the Vite build.
`VITE_WEB_USAGE_GATEWAY_URL` and `VITE_WEB_STORAGE_USAGE_GATEWAY_URL` are
optional overrides for the two same-origin Supabase paths when using a custom
domain or routing layer.

### 4. Deploy

```
npm ci
npm run cf:deploy
```

The included `.github/workflows/deploy-cloudflare.yml` deploys `main` after the
required GitHub and Worker secrets have been configured. It creates no Vercel
deployment.

After the first deployment, enable Cloudflare Web Analytics from the Worker
dashboard if analytics is desired. The Vercel Analytics client has been
removed because it relies on Vercel's collection routes.

---

## Docker Deployment (Self-Hosted)

### Dockerfile

```dockerfile
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### nginx.conf

```nginx
server {
    listen 80;
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
}
```

### Build & Run

```bash
docker build -t atlas .
docker run -p 80:80 atlas
```

---

## Release Script

Location: `release.py`

Automated release process:

```bash
python release.py --version 1.6.7 --platform all
```

Features:
- Updates version in package.json
- Updates Tauri config
- Builds all platforms
- Creates GitHub release
- Uploads artifacts

In the release helper, **Schedule GitHub deployments** is off by default. When
enabled, choose a time in the computer's local timezone. The Windows and
Ubuntu/Android release jobs and the Cloudflare deployment are held until that
time, then dispatched together. GitHub checks for due schedules every five
minutes, so deployments can start a little after the selected time during
Actions load. Only one scheduled release can be pending at a time.

---

## Monitoring & Logs

### Tauri Logs

Desktop apps log to:
- Windows: `%APPDATA%/com.atlas.app/logs/`
- macOS: `~/Library/Logs/com.atlas.app/`
- Linux: `~/.local/share/com.atlas.app/logs/`

### Supabase Logs

Access via Supabase Dashboard:
- Database logs
- Auth logs
- Function invocation logs

### Error Tracking

Consider integrating:
- Sentry for error reporting
- LogRocket for session replay
- Supabase built-in analytics
