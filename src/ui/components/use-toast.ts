import * as React from "react"

import type {
    ToastActionElement,
    ToastProps,
} from "@/ui/components/toast"
import { recordErrorToast } from '@/lib/errorLogger'

const TOAST_LIMIT = 3
const TOAST_DEFAULT_DURATION = 5000
const TOAST_REMOVE_DELAY = 300
const TOAST_OVERFLOW_DELAY = 500
const STANDING_HEIGHT_PER_TOAST = 96

export type ToastPlacement = 'floating' | 'sticky-bar'

export type ToastRecord = ToastProps & {
    id: string
    title?: React.ReactNode
    description?: React.ReactNode
    action?: ToastActionElement
    placement?: ToastPlacement
}

const actionTypes = {
    ADD_TOAST: "ADD_TOAST",
    UPDATE_TOAST: "UPDATE_TOAST",
    DISMISS_TOAST: "DISMISS_TOAST",
    REMOVE_TOAST: "REMOVE_TOAST",
} as const

let count = 0

function genId() {
    count = (count + 1) % Number.MAX_SAFE_INTEGER
    return count.toString()
}

type ActionType = typeof actionTypes

type Action =
    | {
        type: ActionType["ADD_TOAST"]
        toast: ToastRecord
    }
    | {
        type: ActionType["UPDATE_TOAST"]
        toast: Partial<ToastRecord>
    }
    | {
        type: ActionType["DISMISS_TOAST"]
        toastId?: ToastRecord["id"]
    }
    | {
        type: ActionType["REMOVE_TOAST"]
        toastId?: ToastRecord["id"]
    }

interface State {
    toasts: ToastRecord[]
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
const autoDismissTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const clearAutoDismissTimeout = (toastId: string) => {
    const timeout = autoDismissTimeouts.get(toastId)
    if (timeout) {
        clearTimeout(timeout)
        autoDismissTimeouts.delete(toastId)
    }
}

const scheduleAutoDismiss = (toastId: string, duration: number) => {
    clearAutoDismissTimeout(toastId)

    if (!Number.isFinite(duration) || duration <= 0) {
        return
    }

    const timeout = setTimeout(() => {
        autoDismissTimeouts.delete(toastId)
        dispatch({
            type: "DISMISS_TOAST",
            toastId,
        })
    }, duration)

    autoDismissTimeouts.set(toastId, timeout)
}

const addToRemoveQueue = (toastId: string, delay: number = TOAST_REMOVE_DELAY) => {
    if (toastTimeouts.has(toastId)) {
        return
    }

    const timeout = setTimeout(() => {
        toastTimeouts.delete(toastId)
        dispatch({
            type: "REMOVE_TOAST",
            toastId,
        })
    }, delay)

    toastTimeouts.set(toastId, timeout)
}

import { whatsappManager } from '@/lib/whatsappWebviewManager'

const reserveNotificationSpace = (count: number) => {
    if (count <= 0) {
        whatsappManager.clearNotificationSpace()
        return
    }
    whatsappManager.setNotificationSpace(Math.min(count, TOAST_LIMIT) * STANDING_HEIGHT_PER_TOAST)
}

export const reducer = (state: State, action: Action): State => {
    switch (action.type) {
        case "ADD_TOAST": {
            // Shrink webview to make room for toast notifications
            const standingToasts = state.toasts.filter((toast) => toast.open !== false)
            const next = [action.toast, ...standingToasts]
            const overflowing = next.slice(TOAST_LIMIT)
            const kept = next.slice(0, TOAST_LIMIT)

            // Overflowing toasts exit gracefully instead of vanishing instantly
            overflowing.forEach((toast) => addToRemoveQueue(toast.id, TOAST_OVERFLOW_DELAY))
            reserveNotificationSpace(kept.length)

            return {
                ...state,
                toasts: [
                    ...kept,
                    ...overflowing.map((toast) => ({ ...toast, open: false })),
                ],
            }
        }

        case "UPDATE_TOAST":
            return {
                ...state,
                toasts: state.toasts.map((t) =>
                    t.id === action.toast.id ? { ...t, ...action.toast } : t
                ),
            }

        case "DISMISS_TOAST": {
            const { toastId } = action

            // ! Side effects ! - This could be extracted into a dismissToast() action,
            // but I'll keep it here for simplicity
            if (toastId) {
                clearAutoDismissTimeout(toastId)
                addToRemoveQueue(toastId)
            } else {
                state.toasts.forEach((toast) => {
                    clearAutoDismissTimeout(toast.id)
                    addToRemoveQueue(toast.id)
                })
            }

            return {
                ...state,
                toasts: state.toasts.map((t) =>
                    t.id === toastId || action.toastId === undefined
                        ? {
                            ...t,
                            open: false,
                        }
                        : t
                ),
            }
        }
        case "REMOVE_TOAST": {
            if (action.toastId) {
                clearAutoDismissTimeout(action.toastId)
            } else {
                state.toasts.forEach((toast) => clearAutoDismissTimeout(toast.id))
            }

            // Restore webview to full height when all toasts are gone
            const remainingToasts = action.toastId === undefined
                ? []
                : state.toasts.filter((t) => t.id !== action.toastId);

            reserveNotificationSpace(
                remainingToasts.filter((t) => t.open !== false).length
            );

            if (action.toastId === undefined) {
                return {
                    ...state,
                    toasts: [],
                }
            }
            return {
                ...state,
                toasts: remainingToasts,
            }
        }
    }
}

const listeners: Array<(state: State) => void> = []

let memoryState: State = { toasts: [] }

function dispatch(action: Action) {
    memoryState = reducer(memoryState, action)
    listeners.forEach((listener) => {
        listener(memoryState)
    })
}

type Toast = Omit<ToastRecord, "id">

function toast({ ...props }: Toast) {
    const id = genId()

    if (props.variant === 'destructive') {
        recordErrorToast({ title: props.title, description: props.description })
    }

    const update = (props: ToastRecord) => {
        dispatch({
            type: "UPDATE_TOAST",
            toast: { ...props, id },
        })
        if (typeof props.duration === "number") {
            scheduleAutoDismiss(id, props.duration)
        }
    }
    const dismiss = () =>
        dispatch({ type: "DISMISS_TOAST", toastId: id })

    dispatch({
        type: "ADD_TOAST",
        toast: {
            ...props,
            id,
            open: true,
            onOpenChange: (open) => {
                if (!open) dismiss()
            },
        },
    })
    scheduleAutoDismiss(id, props.duration ?? TOAST_DEFAULT_DURATION)

    return {
        id,
        dismiss,
        update,
    }
}

function useToast() {
    const [state, setState] = React.useState<State>(memoryState)

    React.useEffect(() => {
        listeners.push(setState)
        return () => {
            const index = listeners.indexOf(setState)
            if (index > -1) {
                listeners.splice(index, 1)
            }
        }
    }, [state])

    return {
        ...state,
        toast,
        dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
    }
}

export { useToast, toast }
