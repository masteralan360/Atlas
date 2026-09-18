/**
 * Service to handle Cloudflare R2 storage operations via the authenticated proxy worker.
 * Public reads use shareable object URLs; privileged writes/lists use the user's Supabase session.
 */
import { refreshSupabaseSession, supabase } from '@/auth/supabase';
import { isTauri } from '@/lib/platform';
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode';
import {
    getTransferBodySize,
    recordWorkspaceDataTransfer
} from '@/lib/workspaceUsage';

const WORKSPACE_USAGE_CLIENT_RECORDED_PARAM = 'usage_client_recorded';

class R2Service {
    constructor() {
        this.removeStorageValue(['r2', 'auth', 'token'].join('_'));
    }

    private normalizePath(path: string): string {
        const cleanPath = path.startsWith('/') ? path.slice(1) : path;
        return cleanPath
            .split('/')
            .map(segment => {
                if (!segment) return '';

                // Avoid double-encoding already encoded keys while still supporting raw/unicode chars.
                let decoded = segment;
                try {
                    decoded = decodeURIComponent(segment);
                } catch {
                    decoded = segment;
                }
                return encodeURIComponent(decoded);
            })
            .join('/');
    }

    private getWorkspaceIdFromPath(path: string): string | null {
        const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
        if (parts.length === 0) return null;

        if (parts[0] === 'local-backup') {
            return parts[1] || null;
        }

        return parts[0] || null;
    }

    private isWorkspaceId(value: string | null): value is string {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
    }

    private async recordTransfer(path: string, bytes: number, source: string): Promise<void> {
        const workspaceId = this.getWorkspaceIdFromPath(path);
        if (!this.isWorkspaceId(workspaceId) || isLocalWorkspaceMode(workspaceId)) return;

        await recordWorkspaceDataTransfer(workspaceId, bytes, source);
    }

    private readEnvValue(value?: string | null): string | undefined {
        const trimmed = value?.trim();
        return trimmed ? trimmed : undefined;
    }

    private canUseStorage(): boolean {
        return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
    }

    private readStorageValue(key: string): string | undefined {
        if (!this.canUseStorage()) return undefined;
        try {
            return this.readEnvValue(window.localStorage.getItem(key));
        } catch {
            return undefined;
        }
    }

    private removeStorageValue(key: string): void {
        if (!this.canUseStorage()) return;
        try {
            window.localStorage.removeItem(key);
        } catch {
            // Ignore storage failures (e.g., disabled storage)
        }
    }

    private writeStorageValue(key: string, value?: string): void {
        if (!value || !this.canUseStorage()) return;
        try {
            window.localStorage.setItem(key, value);
        } catch {
            // Ignore storage failures (e.g., disabled storage)
        }
    }

    private get workerUrl(): string | undefined {
        const fromVite = this.readEnvValue(import.meta.env.VITE_R2_WORKER_URL);
        const fromStorage = this.readStorageValue('r2_worker_url');
        const resolved = fromVite || fromStorage;
        if (resolved && resolved !== fromStorage) {
            this.writeStorageValue('r2_worker_url', resolved);
        }
        return resolved;
    }

    private get webUsageGatewayUrl(): string | undefined {
        if (isTauri()) return undefined;

        const configured = this.readEnvValue(import.meta.env.VITE_WEB_R2_USAGE_GATEWAY_URL);
        if (configured) return configured;
        return import.meta.env.PROD ? '/api-workspace-r2' : undefined;
    }

    private get usesWebUsageGateway(): boolean {
        return Boolean(this.webUsageGatewayUrl);
    }

    private getWebGatewayUrl(path: string): string {
        const gatewayUrl = this.webUsageGatewayUrl;
        if (!gatewayUrl) return '';

        const baseUrl = new URL(
            gatewayUrl,
            typeof window === 'undefined' ? undefined : window.location.origin
        );
        baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/${this.normalizePath(path)}`;
        return baseUrl.toString();
    }

    private async getAccessToken(forceRefresh = false): Promise<string | undefined> {
        if (forceRefresh) {
            const { data } = await refreshSupabaseSession();
            if (data.session?.access_token) {
                return data.session.access_token;
            }
        }

        const { data } = await supabase.auth.getSession();
        if (data.session?.access_token) {
            return data.session.access_token;
        }

        if (!forceRefresh) {
            const { data: refreshedData } = await refreshSupabaseSession();
            return refreshedData.session?.access_token;
        }

        return undefined;
    }

    private async fetchPrivileged(url: string, init: RequestInit): Promise<Response> {
        const requestWithToken = async (forceRefresh: boolean) => {
            const accessToken = await this.getAccessToken(forceRefresh);
            if (!accessToken) {
                throw new Error('R2 authentication missing. Please sign in again.');
            }

            const headers = new Headers(init.headers);
            headers.set('Authorization', `Bearer ${accessToken}`);
            return fetch(url, { ...init, headers });
        };

        const response = await requestWithToken(false);
        if (response.status === 401 || response.status === 403) {
            return requestWithToken(true);
        }

        return response;
    }

    /**
     * Get the public URL for an object
     */
    public getUrl(path: string): string {
        if (!this.workerUrl) return '';
        const cleanPath = this.normalizePath(path);
        const baseUrl = this.workerUrl.endsWith('/') ? this.workerUrl : `${this.workerUrl}/`;
        return `${baseUrl}${cleanPath}`;
    }

    private getClientRecordedUsageUrl(path: string): string {
        const url = new URL(this.getUrl(path));
        url.searchParams.set(WORKSPACE_USAGE_CLIENT_RECORDED_PARAM, '1');
        return url.toString();
    }

    private getMeteredRequestUrl(path: string): string {
        return this.usesWebUsageGateway
            ? this.getWebGatewayUrl(path)
            : this.getClientRecordedUsageUrl(path);
    }

    /**
     * Upload an object to R2
     */
    public async upload(path: string, data: Blob | ArrayBuffer | string, contentType?: string, force?: boolean): Promise<string> {
        if (!force) {
            const workspaceId = this.getWorkspaceIdFromPath(path);
            if (workspaceId && isLocalWorkspaceMode(workspaceId)) {
                return '';
            }
        }

        if (!this.workerUrl) {
            throw new Error('R2 configuration missing');
        }

        const url = this.getUrl(path);
        const requestUrl = this.getMeteredRequestUrl(path);
        const uploadBytes = getTransferBodySize(data);

        const response = await this.fetchPrivileged(requestUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': contentType || 'application/octet-stream'
            },
            body: data
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`R2 Upload Failed: ${response.status} ${errorText}`);
        }

        if (!this.usesWebUsageGateway) {
            await this.recordTransfer(path, uploadBytes, 'r2_upload');
        }
        return url;
    }

    /**
     * Delete an object from R2
     */
    public async delete(path: string): Promise<void> {
        const workspaceId = this.getWorkspaceIdFromPath(path);
        if (workspaceId && isLocalWorkspaceMode(workspaceId)) {
            return;
        }

        if (!this.workerUrl) {
            throw new Error('R2 configuration missing');
        }

        const url = this.usesWebUsageGateway ? this.getWebGatewayUrl(path) : this.getUrl(path);
        const response = await this.fetchPrivileged(url, {
            method: 'DELETE'
        });

        if (!response.ok && response.status !== 404) {
            const errorText = await response.text();
            throw new Error(`R2 Delete Failed: ${response.status} ${errorText}`);
        }
    }

    /**
     * List object keys by prefix
     */
    public async listObjects(prefix: string): Promise<string[]> {
        if (!this.workerUrl) {
            throw new Error('R2 configuration missing');
        }

        const baseUrl = this.usesWebUsageGateway
            ? this.getWebGatewayUrl('__list__')
            : (this.workerUrl.endsWith('/') ? this.workerUrl : `${this.workerUrl}/`);
        const url = new URL(baseUrl);
        url.searchParams.set('list', '1');
        url.searchParams.set('prefix', prefix);

        let response: Response;
        try {
            response = await this.fetchPrivileged(url.toString(), {
                method: 'GET'
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`R2 List Request Failed: ${message}`);
        }

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            if (response.status === 404 && errorText.toLowerCase().includes('object not found')) {
                throw new Error('R2 List Endpoint Missing: 404 Object Not Found');
            }
            throw new Error(`R2 List Failed: ${response.status}${errorText ? ` ${errorText}` : ''}`);
        }

        const payload = await response.json() as { keys?: unknown };
        if (!Array.isArray(payload.keys)) {
            return [];
        }

        return payload.keys.filter((key): key is string => typeof key === 'string');
    }

    /**
     * Requests an external product image through the authenticated R2 Worker.
     * The worker validates the URL, follows only safe redirects, and streams a
     * signature-checked image back to the browser. It never stores the source
     * URL or turns it into a public product-image URL.
     */
    public async fetchExternalProductImage(sourceUrl: string): Promise<Blob> {
        if (!this.workerUrl) {
            throw new Error('R2 configuration missing');
        }

        const response = await this.fetchPrivileged(this.getUrl('__product-image-import__'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: sourceUrl })
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`Product image import failed: ${response.status}${errorText ? ` ${errorText}` : ''}`);
        }

        return response.blob();
    }

    /**
     * Check if R2 is configured
     */
    public isConfigured(): boolean {
        return !!this.workerUrl;
    }
    /**
     * Download an object from R2
     */
    public async download(path: string): Promise<ArrayBuffer | null> {
        if (!this.workerUrl) return null;

        const url = this.getMeteredRequestUrl(path);
        const response = this.usesWebUsageGateway
            ? await this.fetchPrivileged(url, { method: 'GET' })
            : await fetch(url);

        if (!response.ok) {
            if (response.status === 404) return null;
            throw new Error(`R2 Download Failed: ${response.status}`);
        }

        const data = await response.arrayBuffer();
        if (!this.usesWebUsageGateway) {
            await this.recordTransfer(path, data.byteLength, 'r2_download');
        }
        return data;
    }

    /**
     * Load a URL generated by getUrl() through the authenticated R2 path. This
     * lets consumers such as PDF.js keep storing a stable object URL while web
     * reads are measured by the same-origin web gateway.
     */
    public async downloadFromUrl(url: string): Promise<ArrayBuffer | undefined> {
        if (!this.workerUrl || !url || url.startsWith('data:')) return undefined;

        let worker: URL;
        let objectUrl: URL;
        try {
            worker = new URL(this.workerUrl);
            objectUrl = new URL(url);
        } catch {
            return undefined;
        }

        const workerPath = worker.pathname.replace(/\/+$/, '');
        const requiredPrefix = `${workerPath}/`.replace(/\/{2,}/g, '/');
        if (objectUrl.origin !== worker.origin || !objectUrl.pathname.startsWith(requiredPrefix)) {
            return undefined;
        }

        const path = objectUrl.pathname
            .slice(requiredPrefix.length)
            .split('/')
            .filter(Boolean)
            .map((segment) => {
                try {
                    return decodeURIComponent(segment);
                } catch {
                    return segment;
                }
            })
            .join('/');

        return (await this.download(path)) ?? undefined;
    }
}

export const r2Service = new R2Service();
