import { supabase } from '@/auth/supabase'

export interface WorkspaceUsageStatus {
    workspace_id: string
    has_limits: boolean
    storage_units: number
    storage_unit_limit: number | null
    /** The one persisted plan-consumption total used for quota enforcement. */
    charged_usage_bytes: number
    /** Charged-usage allowance, not a raw network-transfer limit. */
    monthly_data_transfer_limit_bytes: number | null
    transfer_period_start: string
}

export const WORKSPACE_STORAGE_LIMIT_MESSAGE = 'Workspace storage limit exceeded'
// Legacy wire text kept for compatibility. "Data transfer" here means the
// charged-usage allowance; raw actual transfer is never compared to this limit.
export const WORKSPACE_TRANSFER_LIMIT_MESSAGE = 'Workspace monthly data transfer limit exceeded'
const WORKSPACE_USAGE_UPDATED_EVENT = 'workspace-usage-updated'

function notifyWorkspaceUsageUpdated(workspaceId: string) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(WORKSPACE_USAGE_UPDATED_EVENT, {
        detail: { workspaceId }
    }))
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
        return (error as { message: string }).message
    }
    return String(error)
}

export function isWorkspaceUsageLimitError(error: unknown): boolean {
    const message = getErrorMessage(error)
    return message.includes(WORKSPACE_STORAGE_LIMIT_MESSAGE)
        || message.includes(WORKSPACE_TRANSFER_LIMIT_MESSAGE)
}

export function getWorkspaceUsageLimitMessage(error: unknown): string {
    const message = getErrorMessage(error)

    if (message.includes(WORKSPACE_STORAGE_LIMIT_MESSAGE)) {
        return WORKSPACE_STORAGE_LIMIT_MESSAGE
    }

    if (message.includes(WORKSPACE_TRANSFER_LIMIT_MESSAGE)) {
        return WORKSPACE_TRANSFER_LIMIT_MESSAGE
    }

    return message
}

export function getTransferBodySize(data: Blob | ArrayBuffer | ArrayBufferView | string): number {
    if (typeof data === 'string') {
        return new TextEncoder().encode(data).byteLength
    }

    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        return data.size
    }

    if (data instanceof ArrayBuffer) {
        return data.byteLength
    }

    if (ArrayBuffer.isView(data)) {
        return data.byteLength
    }

    return 0
}

export function parseContentLength(value: string | null): number | null {
    if (!value) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null
}

/** Returns a safe client-side representation of the one charged counter. */
export function getChargedWorkspaceUsageBytes(
    usage: Pick<WorkspaceUsageStatus, 'charged_usage_bytes'>
): number {
    const value = Number(usage.charged_usage_bytes ?? 0)
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

export async function recordWorkspaceDataTransfer(
    workspaceId: string,
    actualBytes: number,
    source?: string
): Promise<void> {
    // p_bytes is measured for this request only. The database applies the Tauri
    // channel rate and persists charged usage rather than raw bytes.
    const normalizedBytes = Math.trunc(actualBytes)
    if (!workspaceId || normalizedBytes <= 0) return

    const { error } = await supabase
        .rpc('record_workspace_data_transfer', {
            p_workspace_id: workspaceId,
            p_bytes: normalizedBytes,
            p_source: source ?? null,
            p_channel: 'tauri'
        })

    if (error) {
        throw error
    }

    notifyWorkspaceUsageUpdated(workspaceId)
}

export async function getWorkspaceUsageStatus(workspaceId?: string, signal?: AbortSignal): Promise<WorkspaceUsageStatus | null> {
    let request = supabase.rpc('get_workspace_usage_status', {
        p_workspace_id: workspaceId ?? null
    })
    if (signal) request = request.abortSignal(signal)

    const { data, error } = await request.maybeSingle()

    if (error) {
        throw error
    }

    if (!data) return null

    const row = data as unknown as Record<string, unknown>
    const chargedUsageBytes = Number(row.charged_usage_bytes ?? row.data_transfer_bytes ?? 0)
    return {
        ...row,
        charged_usage_bytes: Number.isFinite(chargedUsageBytes) && chargedUsageBytes > 0
            ? Math.trunc(chargedUsageBytes)
            : 0
    } as unknown as WorkspaceUsageStatus
}
