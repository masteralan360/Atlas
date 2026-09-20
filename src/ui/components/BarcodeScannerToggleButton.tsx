import { useEffect, useRef, type RefObject } from 'react'
import { ScanBarcode } from 'lucide-react'

import {
    BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT,
    BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS,
    classifyBarcodeScannerKeyTiming,
    getBarcodeScannerEventKey,
    isBarcodeScannerIgnoredKey,
    isBarcodeScannerTerminatorKey,
    normalizeBarcodeScannerText,
    shouldIgnoreBarcodeScannerKey
} from '@/lib/barcodeScanner'
import { cn } from '@/lib/utils'
import { Button } from '@/ui/components/button'

const DUPLICATE_SCAN_COOLDOWN_MS = 500
const LONG_PRESS_DELAY_MS = 650

interface BarcodeScannerToggleButtonProps {
    enabled: boolean
    onEnabledChange: (enabled: boolean) => void
    onScan: (value: string) => void
    label: string
    activeLabel?: string
    inactiveLabel?: string
    disabled?: boolean
    className?: string
    deviceStorageKey?: string
    targetInputRef?: RefObject<HTMLInputElement | null>
    idleCommitDelayMs?: number
}

type EditableScannerElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement

type EditableScannerSnapshot = {
    element: EditableScannerElement
    value?: string
    selectionStart?: number | null
    selectionEnd?: number | null
    textContent?: string | null
}

function getFocusedEditableElement(): EditableScannerElement | null {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLInputElement) {
        return activeElement
    }

    if (activeElement instanceof HTMLTextAreaElement) {
        return activeElement
    }

    if (activeElement instanceof HTMLSelectElement) {
        return activeElement
    }

    if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
        return activeElement
    }

    return null
}

function createEditableSnapshot(element: EditableScannerElement): EditableScannerSnapshot {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return {
            element,
            value: element.value,
            selectionStart: element.selectionStart,
            selectionEnd: element.selectionEnd
        }
    }

    if (element instanceof HTMLSelectElement) {
        return {
            element,
            value: element.value
        }
    }

    return {
        element,
        textContent: element.textContent
    }
}

function setNativeEditableValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set

    if (valueSetter) {
        valueSetter.call(element, value)
    } else {
        element.value = value
    }
}

function restoreEditableSnapshot(snapshot: EditableScannerSnapshot | null) {
    if (!snapshot) {
        return
    }

    const { element } = snapshot

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        setNativeEditableValue(element, snapshot.value ?? '')
        element.dispatchEvent(new Event('input', { bubbles: true }))
        if (
            typeof snapshot.selectionStart === 'number'
            && typeof snapshot.selectionEnd === 'number'
            && typeof element.setSelectionRange === 'function'
        ) {
            element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd)
        }
        element.blur()
        return
    }

    if (element instanceof HTMLSelectElement) {
        setNativeEditableValue(element, snapshot.value ?? '')
        element.dispatchEvent(new Event('change', { bubbles: true }))
        element.blur()
        return
    }

    element.textContent = snapshot.textContent ?? ''
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.blur()
}

function buildHidDeviceId(device: any) {
    const vendorId = typeof device?.vendorId === 'number' ? device.vendorId : 0
    const productId = typeof device?.productId === 'number' ? device.productId : 0
    const serial = device?.serialNumber ? String(device.serialNumber) : ''
    return `${vendorId}:${productId}:${serial}`
}

export function BarcodeScannerToggleButton({
    enabled,
    onEnabledChange,
    onScan,
    label,
    activeLabel = 'Scanner Enabled',
    inactiveLabel = 'Scanner Disabled',
    disabled = false,
    className,
    deviceStorageKey,
    targetInputRef,
    idleCommitDelayMs = BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS
}: BarcodeScannerToggleButtonProps) {
    const onScanRef = useRef(onScan)
    const scanBufferRef = useRef('')
    const scanTimeoutRef = useRef<number | null>(null)
    const lastKeyTimeRef = useRef(0)
    const fastKeyCountRef = useRef(0)
    const scannerActiveRef = useRef(false)
    const lastScannedValueRef = useRef('')
    const lastScannedTimeRef = useRef(0)
    const longPressTimerRef = useRef<number | null>(null)
    const suppressClickRef = useRef(false)
    const editableSnapshotRef = useRef<EditableScannerSnapshot | null>(null)

    useEffect(() => {
        onScanRef.current = onScan
    }, [onScan])

    useEffect(() => {
        const clearScanTimeout = () => {
            if (scanTimeoutRef.current) {
                window.clearTimeout(scanTimeoutRef.current)
                scanTimeoutRef.current = null
            }
        }

        const resetScanState = () => {
            clearScanTimeout()
            scanBufferRef.current = ''
            scannerActiveRef.current = false
            fastKeyCountRef.current = 0
            lastKeyTimeRef.current = 0
            editableSnapshotRef.current = null
        }

        if (!enabled || disabled) {
            resetScanState()
            return
        }

        const activateScannerCapture = () => {
            if (scannerActiveRef.current) {
                return
            }

            scannerActiveRef.current = true
            restoreEditableSnapshot(editableSnapshotRef.current)
        }

        const commitScan = () => {
            const payload = normalizeBarcodeScannerText(scanBufferRef.current)
            resetScanState()

            if (!payload) {
                return
            }

            const now = Date.now()
            if (
                payload === lastScannedValueRef.current
                && now - lastScannedTimeRef.current < DUPLICATE_SCAN_COOLDOWN_MS
            ) {
                return
            }

            lastScannedValueRef.current = payload
            lastScannedTimeRef.current = now
            onScanRef.current(payload)
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return

            const focusedEditableElement = getFocusedEditableElement()
            const isScannerTargetFocused = Boolean(
                focusedEditableElement
                && targetInputRef?.current
                && focusedEditableElement === targetInputRef.current
            )
            if (shouldIgnoreBarcodeScannerKey({
                hasFocusedEditable: Boolean(focusedEditableElement),
                isScannerTargetFocused
            })) {
                resetScanState()
                return
            }

            if (isBarcodeScannerIgnoredKey(event.key)) return

            if (isBarcodeScannerTerminatorKey(event.key)) {
                if (scannerActiveRef.current && scanBufferRef.current) {
                    event.preventDefault()
                    event.stopPropagation()
                    restoreEditableSnapshot(editableSnapshotRef.current)
                    commitScan()
                }
                return
            }

            const normalizedKey = getBarcodeScannerEventKey(event)
            if (normalizedKey.length !== 1) {
                return
            }

            const timestamp = event.timeStamp
            const wasActive = scannerActiveRef.current
            const timing = classifyBarcodeScannerKeyTiming(timestamp, lastKeyTimeRef.current, {
                hasBufferedValue: Boolean(scanBufferRef.current),
                isActive: wasActive
            })
            lastKeyTimeRef.current = timestamp

            if (timing.shouldReset) {
                clearScanTimeout()
                fastKeyCountRef.current = 0
                scanBufferRef.current = ''
                scannerActiveRef.current = false
                editableSnapshotRef.current = focusedEditableElement
                    ? createEditableSnapshot(focusedEditableElement)
                    : null
            }

            if (timing.isFast) {
                fastKeyCountRef.current += 1
            } else if (!wasActive) {
                fastKeyCountRef.current = 0
            }

            scanBufferRef.current += normalizedKey

            if (fastKeyCountRef.current >= BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT) {
                activateScannerCapture()
            }

            if (scannerActiveRef.current) {
                event.preventDefault()
                event.stopPropagation()

                clearScanTimeout()
                scanTimeoutRef.current = window.setTimeout(commitScan, idleCommitDelayMs)
            }
        }

        window.addEventListener('keydown', handleKeyDown, true)
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true)
            clearScanTimeout()
        }
    }, [disabled, enabled, idleCommitDelayMs, targetInputRef])

    useEffect(() => {
        return () => {
            if (longPressTimerRef.current) {
                window.clearTimeout(longPressTimerRef.current)
            }
        }
    }, [])

    const requestHidDeviceAccess = async () => {
        const hid = (navigator as any)?.hid
        if (!hid) {
            return
        }

        try {
            const devices = await hid.requestDevice({ filters: [] })
            const selectedDevice = devices?.[0]
            if (selectedDevice && deviceStorageKey && typeof localStorage !== 'undefined') {
                localStorage.setItem(deviceStorageKey, buildHidDeviceId(selectedDevice))
            }
        } catch (error) {
            console.warn('[BarcodeScannerToggleButton] HID request cancelled or failed:', error)
        }
    }

    const clearLongPressTimer = () => {
        if (!longPressTimerRef.current) {
            return
        }

        window.clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
    }

    const statusLabel = enabled ? activeLabel : inactiveLabel
    const title = `${label}: ${statusLabel}`

    return (
        <Button
            type="button"
            variant="outline"
            aria-label={title}
            aria-pressed={enabled}
            title={title}
            disabled={disabled}
            onClick={() => {
                if (suppressClickRef.current) {
                    suppressClickRef.current = false
                    return
                }
                onEnabledChange(!enabled)
            }}
            onContextMenu={(event) => {
                event.preventDefault()
                void requestHidDeviceAccess()
            }}
            onPointerDown={(event) => {
                if (event.pointerType !== 'touch' || disabled) {
                    return
                }

                clearLongPressTimer()
                longPressTimerRef.current = window.setTimeout(() => {
                    suppressClickRef.current = true
                    void requestHidDeviceAccess()
                }, LONG_PRESS_DELAY_MS)
            }}
            onPointerUp={clearLongPressTimer}
            onPointerCancel={clearLongPressTimer}
            onPointerLeave={clearLongPressTimer}
            className={cn(
                'h-12 shrink-0 rounded-xl px-4 relative flex items-center gap-2 overflow-hidden',
                enabled
                    ? 'border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400'
                    : 'border-red-500/30 text-red-700 hover:bg-red-500/10 dark:text-red-400',
                className
            )}
        >
            <ScanBarcode className="h-5 w-5" />
            <span
                className={cn(
                    'h-2.5 w-2.5 rounded-full border border-background shadow-sm',
                    enabled ? 'bg-emerald-500' : 'bg-red-500'
                )}
            />
        </Button>
    )
}
