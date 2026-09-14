import { isDesktop, isMobile, isTauri, PlatformAPI } from '../lib/platform';
import { r2Service } from './r2Service';
import { isDemoWorkspaceMode, isLocalWorkspaceMode } from '@/workspace/workspaceMode';
import { getActiveBusinessUserId, getActiveBusinessWorkspaceId } from '@/lib/network';
import { normalizeWorkspaceBackupAssetPath } from '@/local-db/hybridBackupBundle';
import { isPwaWorkspaceAssetScopeBound } from '@/local-db/pwaSqlite';

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
        return 'application/octet-stream';
    }

    private async uploadSavedImageToR2(workspaceId: string, subDir: string, fileName: string, data: Blob | ArrayBuffer, contentType: string): Promise<void> {
        if (!workspaceId || isLocalWorkspaceMode(workspaceId) || !r2Service.isConfigured()) return;

        const r2Path = `${workspaceId}/${subDir}/${fileName}`.replace(/\\/g, '/');
        try {
            await r2Service.upload(r2Path, data, contentType);
        } catch (error) {
            console.error('[PlatformService] Image upload to R2 failed:', error);
        }
    }

    private async pickImageFileFromInput(): Promise<File | null> {
        if (typeof document === 'undefined') return null;

        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/jpg,image/webp';
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

    private getImageExtension(file: File | Blob): string {
        if (file instanceof File) {
            const fileExt = file.name.split('.').pop()?.toLowerCase();
            if (fileExt) {
                return fileExt === 'jpeg' ? 'jpg' : fileExt;
            }
        }

        const mimeToExt: Record<string, string> = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/webp': 'webp'
        };

        return mimeToExt[file.type] || 'jpg';
    }

    private async blobToDataUrl(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('Failed to read image as data URL'));
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Retain a local recovery copy before the owning business record is saved.
     * Desktop files use their normal AppData path; PWA files use the scoped,
     * content-addressed OPFS sidecar included in Atlas backup bundles.
     */
    async persistWorkspaceAssetForBackup(
        workspaceId: string,
        relativePath: string,
        file: File | Blob,
    ): Promise<void> {
        if (!workspaceId || isDemoWorkspaceMode(workspaceId)) return;
        const normalizedPath = normalizeWorkspaceBackupAssetPath(relativePath, workspaceId);

        if (isTauri()) {
            const { mkdir, writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
            const lastSlash = normalizedPath.lastIndexOf('/');
            if (lastSlash > 0) {
                await mkdir(normalizedPath.slice(0, lastSlash), {
                    baseDir: BaseDirectory.AppData,
                    recursive: true,
                });
            }
            await writeFile(normalizedPath, new Uint8Array(await file.arrayBuffer()), {
                baseDir: BaseDirectory.AppData,
            });
            return;
        }

        const userId = getActiveBusinessUserId();
        if (!userId) throw new Error('A signed-in user is required to retain this asset offline.');
        const { storePwaWorkspaceBackupAsset } = await import('@/local-db/hybridBackupBundle');
        await storePwaWorkspaceBackupAsset(
            { workspaceId, userId },
            {
                relativePath: normalizedPath,
                data: new Uint8Array(await file.arrayBuffer()),
                mimeType: file.type || 'application/octet-stream',
            },
        );
    }

    private async resizeBrowserImage(file: File | Blob, maxWidth: number): Promise<Blob> {
        if (typeof document === 'undefined' || maxWidth <= 0) {
            return file;
        }

        const objectUrl = URL.createObjectURL(file);

        return new Promise((resolve) => {
            const img = new Image();

            img.onload = () => {
                URL.revokeObjectURL(objectUrl);

                if (img.width <= maxWidth) {
                    resolve(file);
                    return;
                }

                const width = maxWidth;
                const height = Math.round((maxWidth / img.width) * img.height);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(file);
                    return;
                }

                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob(
                    (resizedBlob) => resolve(resizedBlob || file),
                    'image/jpeg',
                    0.85
                );
            };

            img.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                resolve(file);
            };

            img.src = objectUrl;
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

        // PWA/Web: prefer the scoped OPFS recovery sidecar. The service worker
        // serves this stable virtual URL locally and falls back to the live R2
        // URL when an older asset has not been retained on this device yet.
        if (path && !path.startsWith('http') && !path.startsWith('data:') && !path.startsWith('blob:') && path.includes('/')) {
            const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
            const parts = normalizedPath.split('/');
            const workspaceId = parts.length >= 3 ? parts[1] : '';
            const userId = getActiveBusinessUserId();
            const activeWorkspaceId = getActiveBusinessWorkspaceId();
            let remoteUrl = '';
            if (r2Service.isConfigured()) {
                // DB paths are like: product-images/workspaceId/file.png
                // R2 keys are: workspaceId/product-images/file.png
                let r2Key = normalizedPath;
                if (parts.length >= 3) {
                    const folderPart = parts[0];
                    const wsIdPart = parts[1];
                    const assetPath = parts.slice(2).join('/');
                    r2Key = `${wsIdPart}/${folderPart}/${assetPath}`;
                }
                const url = r2Service.getUrl(r2Key);
                if (url) remoteUrl = url;
            }

            if (
                workspaceId
                && userId
                && workspaceId === activeWorkspaceId
                && isPwaWorkspaceAssetScopeBound({ workspaceId, userId })
            ) {
                try {
                    normalizeWorkspaceBackupAssetPath(normalizedPath, workspaceId);
                    const localUrl = new URL('/__atlas_workspace_asset__', window.location.origin);
                    localUrl.searchParams.set('path', normalizedPath);
                    localUrl.searchParams.set('workspace', workspaceId);
                    localUrl.searchParams.set('user', userId);
                    if (remoteUrl) localUrl.searchParams.set('remote', remoteUrl);
                    return localUrl.href;
                } catch {
                    // Non-sidecar relative paths retain their prior behavior.
                }
            }
            if (remoteUrl) return remoteUrl;
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
    async pickAndSaveImage(workspaceId: string, subDir: string = 'product-images'): Promise<string | null> {
        if (isDemoWorkspaceMode(workspaceId)) {
            const selectedFile = await this.pickImageFileFromInput();
            return selectedFile ? this.blobToDataUrl(selectedFile) : null;
        }

        if (isTauri()) {
            if (isMobile()) {
                try {
                    const selectedFile = await this.pickImageFileFromInput();
                    if (!selectedFile) return null;
                    return await this.saveImageFile(selectedFile, workspaceId, subDir);
                } catch (error) {
                    console.error('[PlatformService] Error picking/saving image on mobile:', error);
                    return null;
                }
            }

            try {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const { mkdir, copyFile, readFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');

                const selected = await open({
                    multiple: false,
                    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
                });

                if (selected && typeof selected === 'string') {
                    const ext = selected.split('.').pop();
                    const fileName = `${Date.now()}.${ext}`;
                    const relativeDir = `${subDir}/${workspaceId}`;

                    await mkdir(relativeDir.replace(/\\/g, '/'), { baseDir: BaseDirectory.AppData, recursive: true });

                    const relativeDest = `${relativeDir}/${fileName}`.replace(/\\/g, '/');
                    await copyFile(selected, relativeDest, { toPathBaseDir: BaseDirectory.AppData });
                    if (!isLocalWorkspaceMode(workspaceId) && r2Service.isConfigured()) {
                        const fileData = await readFile(relativeDest, { baseDir: BaseDirectory.AppData });
                        const arrayBuffer = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength);
                        await this.uploadSavedImageToR2(workspaceId, subDir, fileName, arrayBuffer, this.getImageContentType(ext));
                    }

                    // Return relative path (e.g. product-images/uuid/123.jpg)
                    return relativeDest;
                }
            } catch (error) {
                console.error('Error picking/saving image in Tauri:', error);
            }
        }

        try {
            const selectedFile = await this.pickImageFileFromInput();
            if (!selectedFile) return null;

            const fileToPersist = subDir === 'profile-images'
                ? await this.resizeBrowserImage(selectedFile, 512)
                : selectedFile;

            const ext = this.getImageExtension(fileToPersist);
            const fileName = `${Date.now()}.${ext}`;
            const relativeDest = `${subDir}/${workspaceId}/${fileName}`.replace(/\\/g, '/');
            const r2Path = `${workspaceId}/${subDir}/${fileName}`.replace(/\\/g, '/');

            await this.persistWorkspaceAssetForBackup(workspaceId, relativeDest, fileToPersist);

            if (!isLocalWorkspaceMode(workspaceId) && r2Service.isConfigured()) {
                try {
                    const uploadedUrl = await r2Service.upload(r2Path, fileToPersist, fileToPersist.type || this.getImageContentType(ext));
                    if (uploadedUrl) return relativeDest;
                } catch (error) {
                    console.error('[PlatformService] Web image upload failed, falling back to data URL:', error);
                }
            }

            return await this.blobToDataUrl(fileToPersist);
        } catch (error) {
            console.error('[PlatformService] Error picking/saving image on web:', error);
        }

        return null;
    }

    /**
     * Save an image from a File or Blob directly to AppData
     */
    async saveImageFile(file: File | Blob, workspaceId: string, subDir: string = 'product-images'): Promise<string | null> {
        if (isDemoWorkspaceMode(workspaceId)) {
            return this.blobToDataUrl(file);
        }

        if (isTauri()) {
            try {
                const { mkdir, writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');

                const arrayBuffer = await file.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);

                // Determine extension
                let ext = 'jpg';
                if (file instanceof File) {
                    ext = file.name.split('.').pop() || 'jpg';
                } else if (file.type) {
                    ext = file.type.split('/').pop() || 'jpg';
                }
                if (ext === 'jpeg') ext = 'jpg';

                const fileName = `${Date.now()}.${ext}`;
                const relativeDir = `${subDir}/${workspaceId}`;

                await mkdir(relativeDir.replace(/\\/g, '/'), { baseDir: BaseDirectory.AppData, recursive: true });

                const relativeDest = `${relativeDir}/${fileName}`.replace(/\\/g, '/');
                await writeFile(relativeDest, uint8Array, { baseDir: BaseDirectory.AppData });
                await this.uploadSavedImageToR2(workspaceId, subDir, fileName, file, file.type || this.getImageContentType(ext));

                return relativeDest;
            } catch (error) {
                console.error('[PlatformService] Error saving image file:', error);
            }
        }

        try {
            const ext = this.getImageExtension(file);
            const fileName = `${Date.now()}.${ext}`;
            const relativeDest = `${subDir}/${workspaceId}/${fileName}`.replace(/\\/g, '/');
            const r2Path = `${workspaceId}/${subDir}/${fileName}`.replace(/\\/g, '/');

            await this.persistWorkspaceAssetForBackup(workspaceId, relativeDest, file);

            if (!isLocalWorkspaceMode(workspaceId) && r2Service.isConfigured()) {
                const uploadedUrl = await r2Service.upload(r2Path, file, file.type || this.getImageContentType(ext));
                if (uploadedUrl) return relativeDest;
            }

            return await this.blobToDataUrl(file);
        } catch (error) {
            console.error('[PlatformService] Error saving image file on web:', error);
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

    async resizeImage(filePath: string, maxWidth: number = 512): Promise<string> {
        if (!isTauri()) return filePath;

        try {
            const { readFile, writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');

            // 1. Read the original file
            const fileData = await readFile(filePath, { baseDir: BaseDirectory.AppData });

            // 2. Load into a blob and then an Image object
            const blob = new Blob([fileData]);
            const url = URL.createObjectURL(blob);

            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = async () => {
                    URL.revokeObjectURL(url);

                    // Calculate new dimensions
                    let width = img.width;
                    let height = img.height;

                    if (width > maxWidth) {
                        height = (maxWidth / width) * height;
                        width = maxWidth;
                    }

                    // 3. Draw to canvas
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('Failed to get canvas context'));
                        return;
                    }

                    ctx.drawImage(img, 0, 0, width, height);

                    // 4. Convert back to blob/arraybuffer
                    canvas.toBlob(async (resizedBlob) => {
                        if (!resizedBlob) {
                            reject(new Error('Failed to create blob from canvas'));
                            return;
                        }

                        const resizedBuffer = await resizedBlob.arrayBuffer();

                        // 5. Overwrite the file with resized version
                        // Note: To be safe, we could use a new filename, but for profile pics, overwriting is fine
                        await writeFile(filePath, new Uint8Array(resizedBuffer), { baseDir: BaseDirectory.AppData });

                        console.log(`[PlatformService] Resized image to ${width}x${height}`);
                        resolve(filePath);
                    }, 'image/jpeg', 0.85); // Use JPEG with 85% quality
                };
                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    reject(new Error('Failed to load image for resizing'));
                };
                img.src = url;
            });
        } catch (error) {
            console.error('[PlatformService] Resize error:', error);
            return filePath; // Return original on error
        }
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
