import { useEffect, useRef } from 'react'

import {
    BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT,
    BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS,
    classifyBarcodeScannerKeyTiming,
    getBarcodeScannerEventKey,
    isBarcodeScannerIgnoredKey,
    isBarcodeScannerTerminatorKey,
    normalizeBarcodeScannerText
} from '@/lib/barcodeScanner'
import { findProductByOrderBarcode, getOrderBarcodeTargetIndex } from '@/lib/orderBarcodeScan'
import type { Product, ProductBarcode } from '@/local-db/models'

type OrderBarcodeLine = {
    storageId?: string | null
    productId?: string | null
}

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement

type EditableSnapshot = {
    element: EditableElement
    value?: string
    selectionStart?: number | null
    selectionEnd?: number | null
    textContent?: string | null
}

type OrderBarcodeScannerOptions<TItem extends OrderBarcodeLine> = {
    enabled: boolean
    items: TItem[]
    products: Product[]
    productBarcodes: ProductBarcode[]
    onProductScanned: (product: Product, itemIndex: number) => void
    onProductNotFound: () => void
}

function getEditableElement(target: EventTarget | null): EditableElement | null {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return target
    }

    return target instanceof HTMLElement && target.isContentEditable ? target : null
}

function createEditableSnapshot(element: EditableElement | null): EditableSnapshot | null {
    if (!element) return null

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return {
            element,
            value: element.value,
            selectionStart: element.selectionStart,
            selectionEnd: element.selectionEnd
        }
    }

    if (element instanceof HTMLSelectElement) {
        return { element, value: element.value }
    }

    return { element, textContent: element.textContent }
}

function setNativeEditableValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
    if (valueSetter) {
        valueSetter.call(element, value)
        return
    }
    element.value = value
}

function restoreEditableSnapshot(snapshot: EditableSnapshot | null) {
    if (!snapshot) return

    const { element } = snapshot
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        setNativeEditableValue(element, snapshot.value ?? '')
        element.dispatchEvent(new Event('input', { bubbles: true }))
        if (typeof snapshot.selectionStart === 'number' && typeof snapshot.selectionEnd === 'number') {
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

function getFocusedProductInputIndex(target: EventTarget | null): number | null {
    if (!(target instanceof Element)) return null

    const input = target.closest<HTMLInputElement>('[data-order-product-input="true"]')
    const index = Number(input?.dataset.orderProductIndex)
    return Number.isInteger(index) ? index : null
}

/**
 * Captures hardware-scanner keystrokes once for an order form. The line that
 * owns a scan is captured when scanning starts, so focus always wins over the
 * next unfilled-line fallback.
 */
export function useOrderBarcodeScanner<TItem extends OrderBarcodeLine>(options: OrderBarcodeScannerOptions<TItem>) {
    const optionsRef = useRef(options)
    const scanBufferRef = useRef('')
    const scanTimeoutRef = useRef<number | null>(null)
    const lastKeyTimeRef = useRef(0)
    const fastKeyCountRef = useRef(0)
    const scannerActiveRef = useRef(false)
    const scanTargetIndexRef = useRef<number | null>(null)
    const editableSnapshotRef = useRef<EditableSnapshot | null>(null)

    useEffect(() => {
        optionsRef.current = options
    }, [options])

    useEffect(() => {
        const clearScanTimeout = () => {
            if (scanTimeoutRef.current !== null) {
                window.clearTimeout(scanTimeoutRef.current)
                scanTimeoutRef.current = null
            }
        }

        const resetScanState = () => {
            clearScanTimeout()
            scanBufferRef.current = ''
            lastKeyTimeRef.current = 0
            fastKeyCountRef.current = 0
            scannerActiveRef.current = false
            scanTargetIndexRef.current = null
            editableSnapshotRef.current = null
        }

        const commitScan = () => {
            const scannedValue = normalizeBarcodeScannerText(scanBufferRef.current)
            const targetIndex = scanTargetIndexRef.current
            const { products, productBarcodes, onProductNotFound, onProductScanned } = optionsRef.current
            resetScanState()

            if (!scannedValue || targetIndex === null) return

            const product = findProductByOrderBarcode(products, productBarcodes, scannedValue)
            if (!product) {
                onProductNotFound()
                return
            }

            onProductScanned(product, targetIndex)
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!optionsRef.current.enabled || event.ctrlKey || event.metaKey || event.altKey || isBarcodeScannerIgnoredKey(event.key)) {
                return
            }

            if (isBarcodeScannerTerminatorKey(event.key)) {
                if (scannerActiveRef.current && scanBufferRef.current) {
                    event.preventDefault()
                    event.stopPropagation()
                    restoreEditableSnapshot(editableSnapshotRef.current)
                    commitScan()
                }
                return
            }

            const key = getBarcodeScannerEventKey(event)
            if (key.length !== 1) return

            const wasScannerActive = scannerActiveRef.current
            const timing = classifyBarcodeScannerKeyTiming(event.timeStamp, lastKeyTimeRef.current, {
                hasBufferedValue: Boolean(scanBufferRef.current),
                isActive: wasScannerActive
            })
            lastKeyTimeRef.current = event.timeStamp

            if (timing.shouldReset) {
                clearScanTimeout()
                scanBufferRef.current = ''
                fastKeyCountRef.current = 0
                scannerActiveRef.current = false
                scanTargetIndexRef.current = getOrderBarcodeTargetIndex(
                    optionsRef.current.items,
                    getFocusedProductInputIndex(event.target)
                )
                editableSnapshotRef.current = createEditableSnapshot(getEditableElement(event.target))
            }

            fastKeyCountRef.current = timing.isFast
                ? fastKeyCountRef.current + 1
                : wasScannerActive ? fastKeyCountRef.current : 0
            scanBufferRef.current += key

            if (
                !scannerActiveRef.current
                && scanTargetIndexRef.current !== null
                && fastKeyCountRef.current >= BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT
            ) {
                scannerActiveRef.current = true
                restoreEditableSnapshot(editableSnapshotRef.current)
            }

            if (!scannerActiveRef.current) return

            event.preventDefault()
            event.stopPropagation()
            clearScanTimeout()
            scanTimeoutRef.current = window.setTimeout(commitScan, BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS)
        }

        window.addEventListener('keydown', handleKeyDown, true)
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true)
            clearScanTimeout()
        }
    }, [])
}
