import { isTauri } from './platform';
import { platformService } from '@/services/platformService';
import { r2Service } from '@/services/r2Service';
import { db } from '@/local-db';
import { supabase } from '@/auth/supabase';
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode';

// Simple browser-compatible EventEmitter implementation
type Listener = (...args: any[]) => void;
class SimpleEventEmitter {
    private listeners: Record<string, Listener[]> = {};

    on(event: string, listener: Listener) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(listener);
        return this;
    }

    off(event: string, listener: Listener) {
        if (!this.listeners[event]) return this;
        this.listeners[event] = this.listeners[event].filter(l => l !== listener);
        return this;
    }

    emit(event: string, ...args: any[]) {
        if (!this.listeners[event]) return false;
        this.listeners[event].forEach(l => l(...args));
        return true;
    }
}

export interface AssetProgress {
    status: 'idle' | 'scanning' | 'downloading' | 'uploading' | 'error' | 'success';
    progress?: number;
    currentFile?: string;
    error?: string;
}

class AssetManager extends SimpleEventEmitter {
    private isScanning = false;
    private isInitialSync = true;
    private workspaceId: string | null = null;
    private watchInterval: any = null;

    constructor() {
        super();
    }

    initialize(workspaceId: string) {
        this.workspaceId = workspaceId;
        console.log('[AssetManager] Initialized for workspace:', workspaceId);

        // Start background watcher if in Tauri
        if (isTauri()) {
            this.startWatcher();
        }
    }

    private emitStatus(progress: AssetProgress) {
        this.emit('progress', progress);
    }

    public getProgress(): AssetProgress & { isInitialSync: boolean } {
        return {
            status: this.isScanning ? 'scanning' : 'idle',
            isInitialSync: this.isInitialSync
        };
    }

    public triggerScan() {
        if (this.workspaceId) {
            this.scanAndSync().catch(console.error);
        }
    }

    /**
     * Upload a file to R2 permanently
     */
    async uploadAsset(file: File, folder: string = 'general'): Promise<string | null> {
        if (!this.workspaceId) return null;
        if (isLocalWorkspaceMode(this.workspaceId)) return null;

        try {
            this.emitStatus({ status: 'uploading', currentFile: file.name });

            const fileName = file.name.replace(/\s+/g, '_');
            const storagePath = `${this.workspaceId}/${folder}/${fileName}`;

            const success = await r2Service.upload(storagePath, file);

            if (success) {
                this.emitStatus({ status: 'success' });
                return storagePath;
            }
            return null;
        } catch (e) {
            console.error('[AssetManager] Upload error:', e);
            this.emitStatus({ status: 'error', error: String(e) });
            return null;
        }
    }

    /**
     * Upload an invoice PDF to R2
     * Path format: {workspaceId}/printed-invoices/{A4|receipts}/{invoiceId}.pdf
     */
    async uploadInvoicePdf(
        invoiceId: string,
        pdfBlob: Blob,
        format: 'a4' | 'receipt',
        customPath?: string
    ): Promise<string | null> {
        if (!this.workspaceId) return null;
        if (isLocalWorkspaceMode(this.workspaceId)) return null;

        try {
            const folder = format === 'a4' ? 'A4' : 'receipts';
            // Use custom path if provided, otherwise fallback to standard ID-based path
            const r2Path = customPath || `${this.workspaceId}/printed-invoices/${folder}/${invoiceId}.pdf`;

            this.emitStatus({ status: 'uploading', currentFile: `${invoiceId}.pdf` });

            const url = await r2Service.upload(r2Path, pdfBlob, 'application/pdf');

            if (url) {
                this.emitStatus({ status: 'success' });
                console.log('[AssetManager] Invoice PDF uploaded:', r2Path);
                return r2Path;
            }
            return null;
        } catch (e) {
            console.error('[AssetManager] uploadInvoicePdf error:', e);
            this.emitStatus({ status: 'error', error: String(e) });
            return null;
        }
    }

    /**
     * Helper to upload from path (Tauri)
     */
    async uploadFromPath(filePath: string, _folder: string = 'general'): Promise<string | null> {
        if (!isTauri()) return null;
        if (this.workspaceId && isLocalWorkspaceMode(this.workspaceId)) return null;

        try {
            const fileName = filePath.split(/[\\/]/).pop() || 'file';
            const fileData = await platformService.readFile(filePath);

            const ext = fileName.split('.').pop()?.toLowerCase() || '';
            const mimeTypes: Record<string, string> = {
                'png': 'image/png',
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'webp': 'image/webp'
            };
            const mimeType = mimeTypes[ext] || 'application/octet-stream';

            // Standardized R2 key: workspaceId/folder/filename
            const parts = filePath.replace(/\\/g, '/').split('/');
            let folder = _folder;
            let fileNameFull = fileName;

            if (parts.length >= 3) {
                folder = parts[0];
                fileNameFull = parts[parts.length - 1];
            }

            const r2Path = `${this.workspaceId}/${folder}/${fileNameFull}`;
            const file = new File([fileData as any], fileNameFull, { type: mimeType });

            this.emitStatus({ status: 'uploading', currentFile: fileNameFull });
            const success = await r2Service.upload(r2Path, file);
            if (success) {
                this.emitStatus({ status: 'success' });
                return r2Path;
            }
            return null;
        } catch (e) {
            console.error('[AssetManager] uploadFromPath error:', e);
            return null;
        }
    }

    /**
     * Delete an asset from R2 and locally
     */
    async deleteAsset(remotePath: string): Promise<void> {
        if (!this.workspaceId || !remotePath) return;
        if (isLocalWorkspaceMode(this.workspaceId)) return;

        if (remotePath.startsWith('data:') || remotePath.startsWith('blob:')) {
            return;
        }

        try {
            // 1. Resolve R2 key
            const parts = remotePath.split('/');
            let r2Key = '';
            if (parts.length >= 3) {
                const folderPart = parts[0];
                const wsIdPart = parts[1];
                const filePart = parts[parts.length - 1];
                r2Key = `${wsIdPart}/${folderPart}/${filePart}`;
            } else {
                r2Key = `${this.workspaceId}/general/${remotePath.split('/').pop()}`;
            }

            console.log('[AssetManager] Deleting asset:', r2Key);

            // 2. Delete from R2
            await r2Service.delete(r2Key).catch(e => console.error('[AssetManager] R2 delete error:', e));

            // 3. Delete locally
            if (isTauri()) {
                await platformService.removeFile(remotePath).catch(e => console.error('[AssetManager] Local delete error:', e));
            }
        } catch (e) {
            console.error('[AssetManager] deleteAsset error:', e);
        }
    }

    /**
     * Background watcher to ensure all DB assets are local
     */
    startWatcher(intervalMs: number = 60000) {
        if (this.watchInterval) clearInterval(this.watchInterval);

        // Initial scan
        this.scanAndSync();

        this.watchInterval = setInterval(() => {
            this.scanAndSync();
        }, intervalMs);
    }

    stopWatcher() {
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
            this.watchInterval = null;
        }
    }

    async scanAndSync() {
        if (this.isScanning || !isTauri() || !this.workspaceId) return;
        if (isLocalWorkspaceMode(this.workspaceId)) {
            this.isInitialSync = false;
            this.emitStatus({ status: 'idle' });
            return;
        }
        this.isScanning = true;

        try {
            // 0. Sync Pending Invoices (Priority)
            await this.syncPendingInvoices();

            // 1. Scan Products for missing images
            const products = await db.products.where('workspaceId').equals(this.workspaceId).toArray();
            for (const product of products) {
                if (product.imageUrl && this.isRemotePath(product.imageUrl)) {
                    await this.ensureLocal(product.imageUrl);
                }
            }

            // 2. Scan Users for profile pictures
            const users = await db.users.where('workspaceId').equals(this.workspaceId).toArray();
            for (const user of users) {
                if (user.profileUrl && this.isRemotePath(user.profileUrl)) {
                    await this.ensureLocal(user.profileUrl);
                }
            }

            // 3. Scan Workspace Settings for logo
            const workspaces = await db.workspaces.where('id').equals(this.workspaceId).toArray();
            for (const ws of workspaces) {
                if (ws.logo_url && this.isRemotePath(ws.logo_url)) {
                    await this.ensureLocal(ws.logo_url);
                }
            }

        } catch (e) {
            console.error('[AssetManager] Scan error:', e);
        } finally {
            this.isScanning = false;
            this.isInitialSync = false;
            this.emitStatus({ status: 'idle' });
        }
    }

    /**
     * Scans for invoices with pending PDF uploads and uploads them
     */
    private async syncPendingInvoices() {
        if (!this.workspaceId) return;
        if (isLocalWorkspaceMode(this.workspaceId)) return;

        try {
            // Find invoices with pending sync status and local blobs
            const pendingInvoices = await db.invoices
                .where('workspaceId').equals(this.workspaceId)
                .filter(i => i.syncStatus === 'pending')
                .toArray();

            if (pendingInvoices.length === 0) return;

            console.log(`[AssetManager] Found ${pendingInvoices.length} pending invoices to sync`);

            for (const invoice of pendingInvoices) {
                let updated = false;
                const updates: any = {};

                // Upload A4 PDF if exists and not yet uploaded (check r2PathA4 as well)
                if (invoice.pdfBlobA4 && !invoice.r2PathA4) {
                    const path = await this.uploadInvoicePdf(invoice.id, invoice.pdfBlobA4, 'a4');
                    if (path) {
                        updates.r2PathA4 = path;
                        updates.pdfBlobA4 = undefined; // Clear blob after upload to save space
                        updated = true;
                    }
                }

                // Upload Receipt PDF if exists
                if (invoice.pdfBlobReceipt && !invoice.r2PathReceipt) {
                    const path = await this.uploadInvoicePdf(invoice.id, invoice.pdfBlobReceipt, 'receipt');
                    if (path) {
                        updates.r2PathReceipt = path;
                        updates.pdfBlobReceipt = undefined; // Clear blob after upload
                        updated = true;
                    }
                }

                // If uploaded, update local DB and Supabase
                if (updated) {
                    updates.syncStatus = 'synced';
                    updates.lastSyncedAt = new Date().toISOString();

                    // Update Dexie
                    await db.invoices.update(invoice.id, updates);

                    // Update Supabase using upsert (more robust + RLS safety)
                    const upsertData: any = {
                        id: invoice.id,
                        user_id: invoice.createdBy,
                        workspace_id: this.workspaceId,
                        invoiceid: invoice.invoiceid,
                        total_amount: invoice.totalAmount,
                        total: invoice.totalAmount,
                        settlement_currency: invoice.settlementCurrency,
                        print_format: invoice.printFormat,
                        updated_at: new Date().toISOString()
                    };

                    if (updates.r2PathA4 || invoice.r2PathA4) {
                        upsertData.r2_path_a4 = updates.r2PathA4 || invoice.r2PathA4;
                    }
                    if (updates.r2PathReceipt || invoice.r2PathReceipt) {
                        upsertData.r2_path_receipt = updates.r2PathReceipt || invoice.r2PathReceipt;
                    }

                    const { error } = await supabase.from('invoices').upsert(upsertData);

                    if (error) {
                        console.error('[AssetManager] Failed to update invoice in Supabase:', error);
                        // Revert sync status if Supabase update fails, so we retry
                        await db.invoices.update(invoice.id, { syncStatus: 'pending' });
                    }
                }
            }
        } catch (e) {
            console.error('[AssetManager] syncPendingInvoices error:', e);
        }
    }

    private isRemotePath(path: string): boolean {
        if (!path) return false;
        const p = path.toLowerCase();
        // If it starts with http, it is a URL, but we treat it as remote if it isn't our CDN
        if (p.startsWith('http')) return false;

        // If it looks like an absolute path, it is definitely NOT a remote asset path that needs downloading
        if (p.includes(':/') || p.includes(':\\') || p.startsWith('/') || p.includes('appdata') || p.includes('roaming')) {
            return false;
        }

        // Asset paths are usually folder/workspaceId/file.png (relative)
        return path.includes('/');
    }

    private async ensureLocal(remotePath: string) {
        if (!this.workspaceId) return;
        if (isLocalWorkspaceMode(this.workspaceId)) return;

        try {
            // Check if we already have it locally
            const exists = await platformService.exists(remotePath);
            if (exists) return;

            console.log('[AssetManager] Downloading missing asset:', remotePath);
            this.emitStatus({ status: 'downloading', currentFile: remotePath });

            // R2 key standardized to: workspaceId/folder/filename
            // The DB path (remotePath) is usually folder/workspaceId/filename
            const parts = remotePath.split('/');
            let r2Key = '';
            if (parts.length >= 3) {
                const folderPart = parts[0];
                const wsIdPart = parts[1];
                const filePart = parts[parts.length - 1];
                r2Key = `${wsIdPart}/${folderPart}/${filePart}`;
            } else {
                // Fallback: currentWS/general/filename
                r2Key = `${this.workspaceId}/general/${remotePath.split('/').pop()}`;
            }

            console.log('[AssetManager] Fetching from R2 key:', r2Key);
            const data = await r2Service.download(r2Key);
            if (data) {
                await platformService.saveFile(remotePath, data);
            }
        } catch (e) {
            console.error('[AssetManager] ensureLocal error:', remotePath, e);
        }
    }
}

export const assetManager = new AssetManager();
