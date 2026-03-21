# Deployment Guide

## Overview

Atlas can be deployed to multiple platforms:

| Platform | Method | Notes |
|----------|--------|-------|
| Windows | Tauri NSIS Installer | Auto-updates via GitHub |
| macOS | Tauri DMG | Code signing required |
| Linux | Tauri AppImage/deb | No signing required |
| Android | Tauri APK/AAB | Play Store ready |
| Web | Vercel/Netlify | PWA-enabled |

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

## Vercel Deployment (Web)

### 1. Connect Repository

1. Import GitHub repo to Vercel
2. Select `Vite` framework preset

### 2. Environment Variables

Add in Vercel dashboard:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### 3. Build Settings

```
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

### 4. Deploy

Push to `main` branch triggers automatic deployment.

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
