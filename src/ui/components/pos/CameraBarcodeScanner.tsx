import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useCamera, useScanning, type DetectedBarcode } from 'react-barcode-scanner'
import 'react-barcode-scanner/polyfill'

const CAMERA_SCAN_OPTIONS = {
    formats: [
        'code_128',
        'code_39',
        'code_93',
        'codabar',
        'ean_13',
        'ean_8',
        'itf',
        'upc_a',
        'upc_e',
        'qr_code'
    ],
    delay: 1000
}

interface CameraBarcodeScannerProps {
    selectedCameraId: string
    onCapture: (barcodes: DetectedBarcode[]) => void
    onCameraStateChange?: (state: { isReady: boolean; error?: Error }) => void
    paused?: boolean
}

/**
 * Keeps the scanner library's reference-sensitive props stable. The library
 * opens a new MediaStream whenever `trackConstraints` changes, so recreating
 * that object during ordinary POS renders makes the camera preview stutter.
 */
export function CameraBarcodeScanner({ selectedCameraId, onCapture, onCameraStateChange, paused = false }: CameraBarcodeScannerProps) {
    const videoRef = useRef<HTMLVideoElement>(null)
    const onCaptureRef = useRef(onCapture)
    const onCameraStateChangeRef = useRef(onCameraStateChange)

    useEffect(() => {
        onCaptureRef.current = onCapture
    }, [onCapture])

    useEffect(() => {
        onCameraStateChangeRef.current = onCameraStateChange
    }, [onCameraStateChange])

    const handleCapture = useCallback((barcodes: DetectedBarcode[]) => {
        onCaptureRef.current(barcodes)
    }, [])

    const trackConstraints = useMemo<MediaTrackConstraints>(() => ({
        deviceId: selectedCameraId || undefined,
        facingMode: selectedCameraId ? undefined : { ideal: 'environment' },
        // Barcode detection does not need the package's default 1920px
        // preference. Capping the stream at 720p keeps preview rendering and
        // detector work smooth on lower-powered POS devices.
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 30, max: 30 },
        advanced: []
    }), [selectedCameraId])

    // Keep the package's camera and BarcodeDetector hooks, options, and
    // constraints, while exposing readiness and permission errors to the
    // reusable scanner dialog. The public BarcodeScanner component doesn't
    // expose its useCamera error state.
    const { isCameraReady, error } = useCamera(videoRef, trackConstraints)
    const { detectedBarcodes, startScan, stopScan } = useScanning(videoRef, CAMERA_SCAN_OPTIONS)

    useEffect(() => {
        if (detectedBarcodes !== undefined) {
            handleCapture(detectedBarcodes)
        }
    }, [detectedBarcodes, handleCapture])

    useEffect(() => {
        onCameraStateChangeRef.current?.({ isReady: isCameraReady, error })
    }, [error, isCameraReady])

    useEffect(() => {
        if (isCameraReady && !paused) {
            startScan()
        } else {
            stopScan()
        }
    }, [isCameraReady, paused, startScan, stopScan])

    useEffect(() => {
        const video = videoRef.current
        if (!video) return
        // Keep the camera preview live when decoding is paused between scans.
        if (isCameraReady) {
            video.play().catch((playError: unknown) => {
                if (playError instanceof DOMException && playError.name === 'AbortError') return
                console.error('[CameraBarcodeScanner] Failed to play camera preview:', playError)
            })
        } else {
            video.pause()
        }
    }, [isCameraReady])

    return (
        <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
    )
}
