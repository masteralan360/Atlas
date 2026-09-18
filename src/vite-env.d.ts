/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
declare const __ATLAS_DEV_TESTING__: boolean



interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL: string
    readonly VITE_SUPABASE_ANON_KEY: string
    readonly VITE_REQUIRE_BACKEND_CONFIGURATION?: string
    readonly VITE_R2_WORKER_URL?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
