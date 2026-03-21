# Deployment and Build Guide

Atlas is a cross-platform application that leverages web technologies to ship to multiple targets from a single codebase.

## Prerequisites
- **Node.js**: v18 or later.
- **Rust**: Required for desktop builds via Tauri.
- **Android Studio / SDK**: Required for Android APK/AAB builds.
- **Supabase Account**: A configured Supabase project with database migrations applied.

## Environment Variables
Copy `.env.example` to `.env` and fill in the required Supabase credentials:
```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

## Local Development
Run the development servers:

- **Web (Vite)**: `npm run dev`
- **Desktop (Tauri)**: `npm run tauri dev`
- **Android**: `npm run android:dev`

*(Note: The Android dev command requires a connected device or a running emulator).*

## Production Builds

### 1. Web Application
To generate the static HTML/JS/CSS files for web hosting (e.g., Vercel, Netlify, Cloudflare Pages):
```bash
npm run build
```
The output will be placed in the `dist/` directory.

### 2. Desktop Application (Windows, Linux, macOS)
To build the native desktop installer:
```bash
npm run tauri build
```
This requires Rust and the C++ build tools installed on your host OS.
- Output goes to `src-tauri/target/release/`
- For Windows, this generates an NSIS installer (`.exe`) or an MSI.

### 3. Android Application
To build the release APK/AAB:
```bash
npm run android:build:release
```
**Important:** A release build for Android requires proper code signing. Refer to the `ANDROID_SIGNING_GUIDE.md` located in the root directory for instructions on configuring your keystore.

## Continuous Integration / Continuous Deployment (CI/CD)
The repository includes configuration to automatically build and pre-release desktop apps using GitHub Actions (`.github/workflows/`), integrated with Tauri's auto-updater feature using `@tauri-apps/plugin-updater`.

## Master Validation
Before any major release, ensure you run the project health check mechanisms:
```bash
python .agent/scripts/verify_all.py .
```
*(This script runs linting, tests, security audits, and bundle analysis).*
