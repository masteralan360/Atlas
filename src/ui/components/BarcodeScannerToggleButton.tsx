import { useEffect, useRef, type RefObject } from 'react'
import { ScanBarcode } from 'lucide-react'

import {
    BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT,
    BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS,
    BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS,
    normalizeBarcodeScannerKey,
    normalizeBarcodeScannerText
} from '@/lib/barcodeScanner'
import { cn } from '@/lib/utils'
import { Button } from '@/ui/components/button'

const DUPLICATE_SCAN_COOLDOWN_MS = 2500
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
}

function getFocusedEditableElement() {
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
    targetInputRef
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

    useEffect(() => {
        onScanRef.current = onScan
    }, [onScan])

    useEffect(() => {
        if (!enabled || disabled) {
            scanBufferRef.current = ''
            scannerActiveRef.current = false
            fastKeyCountRef.current = 0
            lastKeyTimeRef.current = 0
            if (scanTimeoutRef.current) {
                window.clearTimeout(scanTimeoutRef.current)
                scanTimeoutRef.current = null
            }
            return
        }

        const commitScan = () => {
            const payload = normalizeBarcodeScannerText(scanBufferRef.current)
            scanBufferRef.current = ''
            scannerActiveRef.current = false
            fastKeyCountRef.current = 0
            lastKeyTimeRef.current = 0

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
            if (event.key === 'Shift' || event.key === 'CapsLock' || event.key === 'Escape') return

            const activeElement = document.activeElement
            const focusedEditableElement = getFocusedEditableElement()
            const targetInputIsFocused = Boolean(targetInputRef?.current && activeElement === targetInputRef.current)

            if (event.key === 'Enter' || event.key === 'Tab') {
                if (scanBufferRef.current) {
                    event.preventDefault()
                    event.stopPropagation()
                    if (focusedEditableElement) {
                        focusedEditableElement.blur()
                    }
                    commitScan()
                }
                return
            }

            if (event.key.length !== 1) {
                return
            }

            const normalizedKey = normalizeBarcodeScannerKey(event.key)
            if (normalizedKey.length !== 1) {
                return
            }

            if (focusedEditableElement || targetInputIsFocused) {
                event.preventDefault()
                event.stopPropagation()
                focusedEditableElement?.blur()
            }

            const now = Date.now()
            const delta = now - lastKeyTimeRef.current
            lastKeyTimeRef.current = now

            if (delta > 0 && delta <= BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS) {
                fastKeyCountRef.current += 1
            } else {
                fastKeyCountRef.current = 0
                scanBufferRef.current = ''
                scannerActiveRef.current = false
            }

            scanBufferRef.current += normalizedKey

            if (fastKeyCountRef.current >= BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT) {
                scannerActiveRef.current = true
            }

            if (scannerActiveRef.current) {
                if (focusedEditableElement) {
                    focusedEditableElement.blur()
                }
                event.preventDefault()
                event.stopPropagation()

                if (scanTimeoutRef.current) {
                    window.clearTimeout(scanTimeoutRef.current)
                }
                scanTimeoutRef.current = window.setTimeout(commitScan, BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS)
            }
        }

        window.addEventListener('keydown', handleKeyDown, true)
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true)
            if (scanTimeoutRef.current) {
                window.clearTimeout(scanTimeoutRef.current)
                scanTimeoutRef.current = null
            }
        }
    }, [disabled, enabled, targetInputRef])

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
