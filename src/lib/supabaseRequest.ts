import { isWeb } from '@/lib/platform'
import { connectionManager } from '@/lib/connectionManager'
import i18n from '@/i18n/config'

export const WEB_REQUEST_TIMEOUT_MS = 12000

const RETRY_ERROR_MESSAGE = 'The request did not finish. Please try again.'

type RunSupabaseActionOptions = {
    timeoutMs?: number
    platform?: 'web-only' | 'all'
}

type AbortableSupabaseAction<T> = PromiseLike<T> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<T> | Promise<T> | T
}

export class SupabaseRequestTimeoutError extends Error {
    readonly code = 'SUPABASE_REQUEST_TIMEOUT'

    constructor(message = RETRY_ERROR_MESSAGE) {
        super(message)
        this.name = 'SupabaseRequestTimeoutError'
    }
}

export class SupabaseNetworkError extends Error {
    readonly code = 'SUPABASE_NETWORK_ERROR'
    readonly status?: number

    constructor(message = RETRY_ERROR_MESSAGE, status?: number) {
        super(message)
        this.name = 'SupabaseNetworkError'
        this.status = status
    }
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
        return (error as { message: string }).message
    }
    return String(error)
}

function getErrorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined
    const status = (error as { status?: unknown }).status
    return typeof status === 'number' ? status : undefined
}

function localizePaymentAccountInsufficientFundsError(error: unknown): Error | null {
    const message = getErrorMessage(error)
    const transactionMatch = message.match(/^You do not have enough balance in (.+) to proceed with this transaction\. Current balance: (.+)\.$/)
    if (transactionMatch) {
        return new Error(i18n.t('paymentAccounts.errors.insufficientFunds', {
            account: transactionMatch[1],
            balance: transactionMatch[2],
            defaultValue: 'You do not have enough balance in {{account}} to proceed with this transaction. Current balance: {{balance}}.'
        }))
    }

    const withdrawalMatch = message.match(/^You do not have enough balance in this payment account to make this withdrawal\. Current balance: (.+)\.$/)
    if (withdrawalMatch) {
        return new Error(i18n.t('paymentAccounts.errors.insufficientFundsWithdrawal', {
            balance: withdrawalMatch[1],
            defaultValue: 'You do not have enough balance in this payment account to make this withdrawal. Current balance: {{balance}}.'
        }))
    }

    return null
}

function localizeInsufficientInventoryError(error: unknown): Error | null {
    const message = getErrorMessage(error)
    const inventoryMatch = message.match(/^Insufficient inventory for (.+) in storage (.+?)(?:\.)?$/)
    if (!inventoryMatch) return null

    const storage = inventoryMatch[2] === 'Unknown storage'
        ? i18n.t('inventoryTransfer.unknownStorage', { defaultValue: 'Unknown storage' })
        : inventoryMatch[2]

    return new Error(i18n.t('inventory.errors.insufficientInventory', {
        product: inventoryMatch[1],
        storage,
        defaultValue: '{{product}} does not have enough inventory in {{storage}}.'
    }))
}

function isNetworkLikeError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase()
    const status = getErrorStatus(error)

    return (
        status === 0 ||
        message.includes('failed to fetch') ||
        message.includes('fetch failed') ||
        message.includes('networkerror') ||
        message.includes('network error') ||
        message.includes('load failed') ||
        message.includes('aborterror')
    )
}

export function normalizeSupabaseActionError(error: unknown): Error {
    if (error instanceof SupabaseRequestTimeoutError || error instanceof SupabaseNetworkError) {
        return error
    }

    if (isNetworkLikeError(error)) {
        return new SupabaseNetworkError(RETRY_ERROR_MESSAGE, getErrorStatus(error))
    }

    const localizedPaymentAccountError = localizePaymentAccountInsufficientFundsError(error)
    if (localizedPaymentAccountError) {
        return localizedPaymentAccountError
    }

    const localizedInventoryError = localizeInsufficientInventoryError(error)
    if (localizedInventoryError) {
        return localizedInventoryError
    }

    if (error instanceof Error) {
        return error
    }

    return new Error(getErrorMessage(error))
}

export function isRetriableWebRequestError(error: unknown): boolean {
    const normalized = normalizeSupabaseActionError(error)
    return normalized instanceof SupabaseRequestTimeoutError || normalized instanceof SupabaseNetworkError
}

export function getRetriableActionToast(error: unknown): { title: string; description: string } {
    const normalized = normalizeSupabaseActionError(error)

    if (normalized instanceof SupabaseRequestTimeoutError) {
        return {
            title: 'Action timed out',
            description: RETRY_ERROR_MESSAGE
        }
    }

    return {
        title: 'Action failed',
        description: RETRY_ERROR_MESSAGE
    }
}

function reportRetriableConnectionFailure(label: string, error: Error) {
    if (error instanceof SupabaseRequestTimeoutError || error instanceof SupabaseNetworkError) {
        connectionManager.reportConnectivityFailure(label)
    }
}

export async function runSupabaseAction<T>(
    label: string,
    promiseFactory: () => PromiseLike<T> | Promise<T> | T,
    options: RunSupabaseActionOptions = {}
): Promise<T> {
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? WEB_REQUEST_TIMEOUT_MS
    const shouldApplyTimeout = options.platform === 'all' ? true : isWeb()
    const executeAction = (controller?: AbortController | null) => Promise.resolve().then(() => {
        const action = promiseFactory() as AbortableSupabaseAction<T> | PromiseLike<T> | Promise<T> | T

        if (controller && action && typeof action === 'object' && typeof (action as AbortableSupabaseAction<T>).abortSignal === 'function') {
            return (action as AbortableSupabaseAction<T>).abortSignal!(controller.signal)
        }

        return action
    })

    const logResult = (status: 'ok' | 'failed', error?: unknown) => {
        const duration = Date.now() - startedAt
        if (status === 'ok') {
            console.debug(`[SupabaseAction] ${label} succeeded in ${duration}ms`)
            return
        }
        console.warn(`[SupabaseAction] ${label} failed in ${duration}ms`, error)
    }

    if (!shouldApplyTimeout) {
        try {
            const result = await executeAction()
            logResult('ok')
            return result
        } catch (error) {
            const normalized = normalizeSupabaseActionError(error)
            reportRetriableConnectionFailure(label, normalized)
            logResult('failed', normalized)
            throw normalized
        }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null

    try {
        const result = await Promise.race<T>([
            executeAction(controller).catch((error) => {
                throw normalizeSupabaseActionError(error)
            }),
            new Promise<T>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    controller?.abort()
                    reject(new SupabaseRequestTimeoutError())
                }, timeoutMs)
            })
        ])

        logResult('ok')
        return result
    } catch (error) {
        const normalized = normalizeSupabaseActionError(error)
        reportRetriableConnectionFailure(label, normalized)
        logResult('failed', normalized)
        throw normalized
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle)
        }
    }
}
