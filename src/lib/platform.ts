/**
 * Platform detection and abstraction for Tauri (Desktop) and Capacitor (Mobile/Android)
 */
import type { ImageUploadSource } from '@/lib/imageUploadProfiles';

export const isTauri = () =>
    typeof window !== 'undefined'
    && (!!(window as any).__TAURI__
        || !!(window as any).__TAURI_METADATA__
        || !!(window as any).__TAURI_INTERNALS__);
export const isMobile = () => typeof navigator !== 'undefined'
    && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
export const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
export const isAndroidPwa = () => isAndroid() && !isTauri();
/** Android native app shell, including the Tauri WebView. */
export const isTauriAndroid = () => isAndroid() && isTauri();
export const isDesktop = () => isTauri() && !isMobile();
export const isPwaDesktop = () => {
    if (isTauri() || isMobile()) return false;

    const pwaNavigator = navigator as Navigator & { standalone?: boolean };
    if (pwaNavigator.standalone === true) return true;

    try {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.matchMedia('(display-mode: window-controls-overlay)').matches;
    } catch {
        return false;
    }
};
export const isWeb = () => !isTauri();

export type Platform = 'desktop' | 'mobile' | 'web';

export const getPlatform = (): Platform => {
    if (isDesktop()) return 'desktop';
    if (isMobile()) return 'mobile';
    return 'web';
};

/**
 * Common platform interface to abstract away host-specific APIs
 */
export interface PlatformAPI {
    // Filesystem
    convertFileSrc: (path: string) => string;
    getAppDataDir: () => Promise<string>;
    joinPath: (...parts: string[]) => Promise<string>;

    // Dialogs
    message: (message: string, options?: { title?: string; type?: 'info' | 'warning' | 'error' }) => Promise<void>;
    confirm: (message: string, options?: { title?: string; type?: 'info' | 'warning' | 'error' }) => Promise<boolean>;

    // App info
    getVersion: () => Promise<string>;
    relaunch: () => Promise<void>;

    // Media
    pickImageFile: () => Promise<File | null>;
    pickAndSaveImage: (workspaceId: string, subDir: string, source: ImageUploadSource) => Promise<string | null>;
    saveImageFile: (file: File | Blob, workspaceId: string, subDir: string, source: ImageUploadSource) => Promise<string | null>;
    persistImageFile: (file: File, workspaceId: string, subDir: string) => Promise<string | null>;
    saveAs: (content: Uint8Array, fileName: string, extensions: { name: string, extensions: string[] }[]) => Promise<string | null>;
}
