import { r2Service } from '@/services/r2Service';
import { platformService } from '@/services/platformService';

export const WORKSPACE_RESOURCE_FOLDERS = [
    'product-images',
    'profile-images',
    'workspace-logos',
    'attached-images',
] as const;

export interface WorkspaceResourceProgress {
    current: number;
    total: number;
    fileName: string;
}

export interface WorkspaceResourceResult {
    total: number;
    downloaded: number;
    skipped: number;
    failed: number;
}

export interface DownloadWorkspaceResourcesOptions {
    workspaceId: string;
    folders?: string[];
    onProgress?: (progress: WorkspaceResourceProgress) => void;
}

/**
 * Lists every object under the workspace media folders in R2 and downloads
 * the ones that are not yet present locally. Mirrors what the "Download
 * Workspace Media" button in Settings does, so the cold-start sync and the
 * manual action behave identically.
 */
export async function downloadWorkspaceResources({
    workspaceId,
    folders = [...WORKSPACE_RESOURCE_FOLDERS],
    onProgress,
}: DownloadWorkspaceResourcesOptions): Promise<WorkspaceResourceResult> {
    const keySet = new Set<string>();

    for (const folder of folders) {
        const prefix = `${workspaceId}/${folder}/`;
        const keys = await r2Service.listObjects(prefix);
        for (const key of keys) {
            keySet.add(key);
        }
    }

    const keys = Array.from(keySet);
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const parts = key.split('/');
        const wsPart = parts[0];
        const folderPart = parts[1];
        const restPath = parts.slice(2).join('/');

        onProgress?.({ current: i + 1, total: keys.length, fileName: restPath || key });

        if (wsPart !== workspaceId || !folderPart || !restPath) {
            console.warn('[WorkspaceResourceSync] Skipping unexpected R2 key:', key);
            failed++;
            continue;
        }

        try {
            const localRelativePath = `${folderPart}/${workspaceId}/${restPath}`;
            if (await platformService.exists(localRelativePath)) {
                skipped++;
                continue;
            }

            const data = await r2Service.download(key);
            if (!data) {
                console.warn('[WorkspaceResourceSync] No data for key:', key);
                failed++;
                continue;
            }

            const savedPath = await platformService.saveDownloadedFile(workspaceId, localRelativePath, data, folderPart);
            if (savedPath) {
                downloaded++;
            } else {
                failed++;
            }
        } catch (error) {
            console.warn('[WorkspaceResourceSync] Download failed:', key, error);
            failed++;
        }
    }

    return { total: keys.length, downloaded, skipped, failed };
}
