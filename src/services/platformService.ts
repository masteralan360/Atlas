import { isDesktop, isMobile, isTauri, PlatformAPI } from '../lib/platform';
import { r2Service } from './r2Service';
import type { ImageUploadSource } from '@/lib/imageUploadProfiles';

/**
 * Service to handle platform-specific operations
 */
class PlatformService implements PlatformAPI {
    private appDataPath: string = '';
    private tauriConvert: ((path: string) => string) | null = null;

    private getImageContentType(ext?: string): string {
        const normalized = (ext || '').toLowerCase();
        if (normalized === 'png') return 'image/png';
        if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
        if (normalized === 'webp') return 'image/webp';
        if (normalized === 'gif') return 'image/gif';
        if (normalized === 'avif') return 'image/avif';
        return 'application/octet-stream';
    }

    private async pickImageFileFromInput(): Promise<File | null> {
        if (typeof document === 'undefined') return null;

        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/jpg,image/webp,image/gif,image/avif';
            input.style.position = 'fixed';
            input.style.left = '-9999px';

            let settled = false;

            const cleanup = () => {
                window.removeEventListener('focus', handleWindowFocus);
                input.removeEventListener('change', handleChange);
                input.remove();
            };

            const finalize = (file: File | null) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(file);
            };

            const handleChange = () => {
                finalize(input.files?.[0] ?? null);
            };

            const handleWindowFocus = () => {
                window.setTimeout(() => {
                    if (!settled && (!input.files || input.files.length === 0)) {
                        finalize(null);
                    }
                }, 300);
            };

            window.addEventListener('focus', handleWindowFocus);
            input.addEventListener('cancel', () => finalize(null), { once: true });
            input.addEventListener('change', handleChange);
            document.body.appendChild(input);
            input.click();
        });
    }

    async initialize() {
        if (isTauri()) {
            // Priority 1: Hydrate from cache immediately
            const cachedPath = localStorage.getItem('atlas_app_data_path');
            if (cachedPath) {
                this.appDataPath = cachedPath;
                console.log('[PlatformService] Hydrated AppData path from cache:', this.appDataPath);
            }

            try {
                // Priority 2: Refetch and refresh cache with a timeout to prevent hanging
                const initPromise = (async () => {
                    const { appDataDir } = await import('@tauri-apps/api/path');
                    const { convertFileSrc } = await import('@tauri-apps/api/core');

                    this.tauriConvert = convertFileSrc;
                    this.appDataPath = await appDataDir();

                    localStorage.setItem('atlas_app_data_path', this.appDataPath);
                    console.log('[PlatformService] Initialized AppData path:', this.appDataPath);
                })();

                //- [x] Phase 57: Implementation of Persistent Asset Migration (R2 CDN Model) [x]
                //- [x] Phase 58: R2 Path Mismatch and Download Reliability Fix [x]
                // 2s safety timeout - if it takes longer, we just keep using the cached path (or empty)
                // and avoid blocking the entire app initialization
                await Promise.race([
                    initPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Init Timeout')), 2000))
                ]);

                // On mobile, proactively request basic permissions if needed
                if (isMobile()) {
                    await this.requestMobilePermissions();
                }
            } catch (e) {
                console.error('[PlatformService] Failed to get AppData path:', e);
            }
        }
    }

    /**
     * Request essential mobile permissions for Tauri plugins
     */
    private async requestMobilePermissions() {
        if (!isMobile()) return;

        try {
            const { invoke } = await import('@tauri-apps/api/core');

            // Check and request permissions for dialog and fs plugins
            // Note: identifiers may vary by plugin, but these are standard for v2 mobile plugins

            const plugins = ['dialog', 'fs'];

            for (const plugin of plugins) {
                try {
                    const state = await invoke<any>(`plugin:${plugin}|checkPermissions`);
                    console.log(`[PlatformService] Permission state for ${plugin}:`, state);

                    // On Android, the keys are usually group names like 'mediaLibrary', 'storage', etc.
                    // We try to request anything that says 'prompt'
                    const toRequest = Object.entries(state)
                        .filter(([_, val]) => val === 'prompt' || val === 'prompt-with-rationale')
                        .map(([key, _]) => key);

                    if (toRequest.length > 0) {
                        console.log(`[PlatformService] Requesting permissions for ${plugin}:`, toRequest);
                        await invoke(`plugin:${plugin}|requestPermissions`, { permissions: toRequest });
                    }
                } catch (e) {
                    console.warn(`[PlatformService] Could not check permissions for ${plugin}:`, e);
                }
            }
        } catch (e) {
            console.error('[PlatformService] Error in requestMobilePermissions:', e);
        }
    }

    convertFileSrc(path: string): string {
        if (isTauri()) {
            try {
                let finalPath = path;

                // 1. Resolve relative paths if we have the cached AppData path
                // This handles "product-images/..." -> "C:/Users/.../AppData/.../product-images/..."
                if (this.appDataPath && !path.startsWith('http') && !path.includes(':') && !path.startsWith('/') && !path.startsWith('\\')) {
                    // Normalize everything to forward slashes
                    const cleanAppData = this.appDataPath.replace(/\\/g, '/');
                    const cleanPath = path.replace(/\\/g, '/');

                    const relPath = cleanPath.startsWith('/') ? cleanPath.substring(1) : cleanPath;
                    const base = cleanAppData.endsWith('/') ? cleanAppData.slice(0, -1) : cleanAppData;

                    finalPath = `${base}/${relPath}`;
                }

                // 2. Use Tauri v2 native converter if available
                // 2. Use Tauri v2 native converter
                if (this.tauriConvert) {
                    return this.tauriConvert(finalPath);
                }

                // 3. Fallback for older patterns / direct construction
                const normalizedPath = finalPath.replace(/\\/g, '/');
                const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;

                if (isMobile()) {
                    return `asset://localhost/${cleanPath}`;
                }

                // On Windows/Desktop, we must ensure absolute paths are correctly prefixed
                // for the Tauri asset protocol.
                if (cleanPath.includes(':/') || cleanPath.startsWith('C:')) {
                    return `https://asset.localhost/${cleanPath}`;
                }

                return `https://asset.localhost/${cleanPath}`;
            } catch (error) {
                console.error('Error converting file src:', error);
            }
        }

        // PWA/Web: resolve relative asset paths to live R2 URLs
        if (path && !path.startsWith('http') && !path.startsWith('data:') && !path.startsWith('blob:') && path.includes('/')) {
            if (r2Service.isConfigured()) {
                // DB paths are like: product-images/workspaceId/file.png
                // R2 keys are: workspaceId/product-images/file.png
                const parts = path.split('/');
                let r2Key = path;
                if (parts.length >= 3) {
                    const folderPart = parts[0];
                    const wsIdPart = parts[1];
                    const filePart = parts[parts.length - 1];
                    r2Key = `${wsIdPart}/${folderPart}/${filePart}`;
                }
                const url = r2Service.getUrl(r2Key);
                if (url) return url;
            }
        }

        return path;
    }

    async getAppDataDir(): Promise<string> {
        if (isTauri()) {
            const { appDataDir } = await import('@tauri-apps/api/path');
            return appDataDir();
        }
        return '';
    }

    async joinPath(...parts: string[]): Promise<string> {
        if (isTauri()) {
            const { join } = await import('@tauri-apps/api/path');
            return join(...parts);
        }
        return parts.join('/');
    }

    async message(message: string, options?: { title?: string; type?: 'info' | 'warning' | 'error' }): Promise<void> {
        if (isTauri()) {
            const { message: tauriMessage } = await import('@tauri-apps/plugin-dialog');
            await tauriMessage(message, {
                title: options?.title || 'Atlas',
                kind: options?.type as any || 'info'
            });
            return;
        }
        alert(message);
    }

    async confirm(message: string, options?: { title?: string; type?: 'info' | 'warning' | 'error' }): Promise<boolean> {
        if (isTauri()) {
            const { ask } = await import('@tauri-apps/plugin-dialog');
            return ask(message, {
                title: options?.title || 'Atlas',
                kind: options?.type as any || 'info'
            });
        }
        return window.confirm(message);
    }

    async getVersion(): Promise<string> {
        try {
            if (isTauri()) {
                const { getVersion } = await import('@tauri-apps/api/app');
                return await getVersion();
            }
        } catch (e) {
            console.error("Failed to get version:", e);
        }
        return '1.1.10'; // Default fallback
    }

    async relaunch(): Promise<void> {
        if (isDesktop()) {
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
        } else if (isMobile()) {
            // Mobile usually doesn't "relaunch" in the same way, but we can exit or reset
        } else {
            window.location.reload();
        }
    }
    async pickImageFile(): Promise<File | null> {
        if (!isTauri() || isMobile()) return this.pickImageFileFromInput();

        const { open } = await import('@tauri-apps/plugin-dialog');
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const selected = await open({
            multiple: false,
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }]
        });
        if (!selected || typeof selected !== 'string') return null;

        const bytes = await readFile(selected);
        const fileName = selected.split(/[\\/]/).pop() || 'image';
        const ext = fileName.split('.').pop()?.toLowerCase();
        return new File([bytes], fileName, { type: this.getImageContentType(ext) });
    }

    async pickAndSaveImage(workspaceId: string, subDir: string, source: ImageUploadSource): Promise<string | null> {
        const selectedFile = await this.pickImageFile();
        if (!selectedFile) return null;
        return this.saveImageFile(selectedFile, workspaceId, subDir, source);
    }

    /** All public image saves are routed through centralized compression. */
    async saveImageFile(file: File | Blob, workspaceId: string, subDir: string, source: ImageUploadSource): Promise<string | null> {
        const imageFile = file instanceof File
            ? file
            : new File([file], 'image', { type: file.type });
        const { mediaUploadService } = await import('@/services/mediaUploadService');
        const stored = await mediaUploadService.storeImageFile(imageFile, workspaceId, subDir, source);
        return stored.path;
    }

    /** Internal persistence hook used only after a compressed artifact exists. */
    async persistImageFile(file: File, workspaceId: string, subDir: string): Promise<string | null> {
        if (!isTauri()) return null;
        try {
            const { mkdir, writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
            const relativeDir = `${subDir}/${workspaceId}`.replace(/\\/g, '/');
            const relativeDest = `${relativeDir}/${file.name}`;
            await mkdir(relativeDir, { baseDir: BaseDirectory.AppData, recursive: true });
            await writeFile(relativeDest, new Uint8Array(await file.arrayBuffer()), { baseDir: BaseDirectory.AppData });
            return relativeDest;
        } catch (error) {
            console.error('[PlatformService] Failed to persist compressed image:', error);
            return null;
        }
    }

    /**
     * Save a downloaded file to AppData using BaseDirectory for mobile compatibility
     */
    async saveDownloadedFile(workspaceId: string, filePath: string, content: ArrayBuffer, defaultSubDir: string = 'product-images'): Promise<string | null> {
        if (isTauri()) {
            try {
                const { mkdir, writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
                const { dirname } = await import('@tauri-apps/api/path');

                // Normalize the path early
                const normalizedPath = filePath.replace(/\\/g, '/');
                let relativeDest = normalizedPath;

                // If filePath is just a filename (no slashes), use the default structure
                if (!normalizedPath.includes('/')) {
                    relativeDest = `${defaultSubDir}/${workspaceId}/${normalizedPath}`;
                }

                // Get directory part from the final path
                const dir = await dirname(relativeDest);
                const cleanDir = dir.replace(/\\/g, '/');

                console.log('[PlatformService] Target directory:', cleanDir);

                // Ensure directory exists in AppData
                await mkdir(cleanDir, { baseDir: BaseDirectory.AppData, recursive: true });
                console.log('[PlatformService] Directory ready:', cleanDir);

                // Write file to AppData
                console.log('[PlatformService] Writing file to:', relativeDest);
                await writeFile(relativeDest, new Uint8Array(content), { baseDir: BaseDirectory.AppData });

                console.log('[PlatformService] Saved file successfully:', relativeDest);
                return relativeDest;
            } catch (error) {
                console.error('[PlatformService] Error saving downloaded file:', error);
                throw error;
            }
        }
        return null;
    }

    async saveFile(path: string, content: ArrayBuffer): Promise<string | null> {
        if (isTauri()) {
            return this.saveDownloadedFile('', path, content);
        }
        return null;
    }

    async readFile(path: string): Promise<Uint8Array> {
        if (isTauri()) {
            const { readFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
            return await readFile(path, { baseDir: BaseDirectory.AppData });
        }
        throw new Error('readFile only supported in Tauri');
    }

    async removeFile(path: string): Promise<boolean> {
        if (isTauri()) {
            try {
                const { remove, BaseDirectory } = await import('@tauri-apps/plugin-fs');
                // Normalize path
                const cleanPath = path.replace(/\\/g, '/');
                await remove(cleanPath, { baseDir: BaseDirectory.AppData });
                return true;
            } catch (e) {
                console.error('[PlatformService] Error removing file:', path, e);
                return false;
            }
        }
        return false;
    }

    async exists(path: string): Promise<boolean> {
        if (isTauri()) {
            const { exists, BaseDirectory } = await import('@tauri-apps/plugin-fs');
            // Normalize path for check
            const cleanPath = path.replace(/\\/g, '/');
            return await exists(cleanPath, { baseDir: BaseDirectory.AppData });
        }
        return false;
    }

    async saveAs(content: Uint8Array, fileName: string, extensions: { name: string, extensions: string[] }[]): Promise<string | null> {
        if (isTauri()) {
            try {
                const { save } = await import('@tauri-apps/plugin-dialog');
                const { writeFile } = await import('@tauri-apps/plugin-fs');

                const filePath = await save({
                    defaultPath: fileName,
                    filters: extensions
                });

                if (filePath) {
                    await writeFile(filePath, content);
                    return filePath;
                }
            } catch (error) {
                console.error('[PlatformService] Error in saveAs:', error);
            }
        }
        return null;
    }

    uint8ArrayToBase64(uint8: Uint8Array): string {
        let binary = '';
        const len = uint8.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(uint8[i]);
        }
        return btoa(binary);
    }
}

export const platformService = new PlatformService();
