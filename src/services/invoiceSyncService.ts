import { supabase } from '@/auth/supabase'
import { db } from '@/local-db'
import { assetManager } from '@/lib/assetManager'
import { isOnline } from '@/lib/network'
import { generateInvoicePdf } from './pdfGenerator'
import { toast } from '@/ui/components/use-toast'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

interface SyncInvoiceOptions {
    saleData: any
    features: any
    workspaceName: string
    workspaceId: string // Required for RLS Workspace Isolation
    user: {
        id: string
        name: string
    }
    format?: 'a4' | 'receipt'
}

/**
 * Handles the background synchronization of an invoice:
 * 1. Generates Receipt PDF
 * 2. Uploads to R2 (if online)
 * 3. Upserts to Supabase 'invoices' table
 * 4. Updates local Dexie status
 */
export async function triggerInvoiceSync(options: SyncInvoiceOptions): Promise<void> {
    const { saleData, features, workspaceName, user } = options;
    const invoiceId = saleData.id;
    const isLocalMode = isLocalWorkspaceMode(options.workspaceId);

    if (!invoiceId) {
        console.error('[InvoiceSyncService] No ID provided for sync');
        return;
    }

    // Immediate feedback toast (brief)
    toast({
        title: "Processing receipt...",
        description: `Finalizing record for #${saleData.invoiceid || invoiceId.slice(0, 8)}`,
    });

    try {
        const format = options.format || 'receipt';
        const now = new Date().toISOString()

        // 1. Generate PDF for the specific format
        const pdfBlob = await generateInvoicePdf({
            data: saleData,
            format: format,
            features,
            workspaceName: workspaceName || 'Asaas',
            workspaceId: options.workspaceId
        });

        if (isLocalMode) {
            const existingInvoice = await db.invoices.get(invoiceId)
            if (!existingInvoice) {
                await db.invoices.put({
                    id: invoiceId,
                    invoiceid: saleData.invoiceid || `#${invoiceId.slice(0, 8)}`,
                    sequenceId: saleData.sequenceId ?? saleData.sequence_id,
                    workspaceId: options.workspaceId,
                    customerId: saleData.customer_id || '',
                    status: 'paid',
                    totalAmount: saleData.total_amount ?? saleData.totalAmount ?? 0,
                    settlementCurrency: saleData.settlement_currency ?? saleData.settlementCurrency ?? features.default_currency ?? 'usd',
                    origin: saleData.origin || 'pos',
                    createdBy: user.id,
                    cashierName: saleData.cashier_name || user.name,
                    createdByName: saleData.created_by_name || user.name,
                    printFormat: format,
                    createdAt: saleData.created_at || now,
                    updatedAt: now,
                    syncStatus: 'synced',
                    lastSyncedAt: now,
                    version: 1,
                    isDeleted: false
                })
            }

            const dbUpdate: any = {
                printFormat: format,
                syncStatus: 'synced',
                lastSyncedAt: now,
                updatedAt: now
            };

            if (format === 'a4') {
                dbUpdate.pdfBlobA4 = pdfBlob;
            } else {
                dbUpdate.pdfBlobReceipt = pdfBlob;
            }

            await db.invoices.update(invoiceId, dbUpdate);

            toast({
                title: "Receipt saved",
                description: "Invoice snapshot was stored locally for this workspace.",
                variant: "default",
            });
            return;
        }

        let r2Path: string | undefined;

        // 2. Upload to R2 if online
        if (isOnline() && assetManager) {
            try {
                const uploadedPath = await assetManager.uploadInvoicePdf(invoiceId, pdfBlob, format);
                if (uploadedPath) r2Path = uploadedPath;
            } catch (uploadError) {
                console.warn(`[InvoiceSyncService] R2 Upload failed for ${format}, will sync later:`, uploadError);
            }
        }

        // 3. Upsert to Supabase
        const upsertData: any = {
            id: invoiceId,
            user_id: user.id,
            workspace_id: options.workspaceId || features.workspace_id || saleData.workspace_id,
            invoiceid: saleData.invoiceid || `#${invoiceId.slice(0, 8)}`,
            total_amount: saleData.total_amount,
            total: saleData.total_amount,
            settlement_currency: saleData.settlement_currency,
            origin: 'pos',
            cashier_name: saleData.cashier_name || user.name,
            created_by: user.id,
            created_by_name: user.name,
            print_format: format,
            updated_at: new Date().toISOString()
        };

        if (format === 'a4' && r2Path) {
            upsertData.r2_path_a4 = r2Path;
        } else if (format === 'receipt' && r2Path) {
            upsertData.r2_path_receipt = r2Path;
        }

        const { error: upsertError } = await supabase.from('invoices').upsert(upsertData);

        if (upsertError) throw upsertError;

        // 4. Update Local DB
        const dbUpdate: any = {
            syncStatus: r2Path ? 'synced' : 'pending',
            lastSyncedAt: r2Path ? new Date().toISOString() : null
        };

        if (format === 'a4') {
            dbUpdate.r2PathA4 = r2Path;
            dbUpdate.pdfBlobA4 = r2Path ? undefined : pdfBlob;
        } else {
            dbUpdate.r2PathReceipt = r2Path;
            dbUpdate.pdfBlobReceipt = r2Path ? undefined : pdfBlob;
        }

        await db.invoices.update(invoiceId, dbUpdate);

        // Success Toast
        toast({
            title: "Receipt saved",
            description: `Successfully persisted #${saleData.invoiceid || invoiceId.slice(0, 8)}`,
            variant: "default",
        });

    } catch (error: any) {
        console.error('[InvoiceSyncService] Background sync failed:', error);

        // Update local status to failed/pending for retry
        await db.invoices.update(invoiceId, {
            syncStatus: 'pending',
            lastSyncedAt: null
        });

        toast({
            title: "Sync Delayed",
            description: "Invoice saved locally. It will sync when connection improves.",
            variant: "destructive",
        });
    }
}
