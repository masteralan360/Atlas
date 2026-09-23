export const ORDER_SAVE_PROGRESS = {
    preparing: {
        fraction: 0.1,
        stageKey: 'orders.form.saveProgressPreparing'
    },
    payment: {
        fraction: 0.3,
        stageKey: 'orders.form.saveProgressPayment'
    },
    saving: {
        fraction: 0.6,
        stageKey: 'orders.form.saveProgressSaving'
    },
    confirming: {
        fraction: 0.85,
        stageKey: 'orders.form.saveProgressConfirming'
    },
    complete: {
        fraction: 1,
        stageKey: 'orders.form.saveProgressComplete'
    }
} as const

export type OrderSaveProgressStage = keyof typeof ORDER_SAVE_PROGRESS

export type OrderSaveProgress = (typeof ORDER_SAVE_PROGRESS)[OrderSaveProgressStage]

export const REMOTE_ORDER_SAVE_CONFIRMATION_ERROR = 'remote_order_save_confirmation_failed'
export const ORDER_SUMMARY_RECOVERY_PERSISTENCE_ERROR = 'order_summary_recovery_persistence_failed'

export function createRemoteOrderSaveConfirmationError(cause?: unknown) {
    const error = new Error(REMOTE_ORDER_SAVE_CONFIRMATION_ERROR)
    if (cause instanceof Error) {
        Object.defineProperty(error, 'cause', { value: cause })
    }
    return error
}

export function isRemoteOrderSaveConfirmationError(error: unknown) {
    return error instanceof Error && error.message === REMOTE_ORDER_SAVE_CONFIRMATION_ERROR
}
