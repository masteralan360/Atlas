import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT,
    BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS,
    BARCODE_SCANNER_ACTIVE_KEY_GRACE_MS,
    BARCODE_SCANNER_BLUETOOTH_ACTIVE_KEY_GRACE_MS,
    BARCODE_SCANNER_BLUETOOTH_AUTO_COMMIT_DELAY_MS,
    BARCODE_SCANNER_BLUETOOTH_FAST_KEY_THRESHOLD_MS,
    BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS,
    classifyBarcodeScannerKeyTiming,
    getBarcodeScannerEventKey,
    isBarcodeScannerIgnoredKey,
    isBarcodeScannerTerminatorKey,
    normalizeBarcodeDigits,
    normalizeBarcodeScannerText
} from '@/lib/barcodeScanner'
import { Input } from '@/ui/components/input'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components'
import { Camera, Settings as SettingsIcon } from 'lucide-react'
import { CameraBarcodeScanner } from '@/ui/components/pos/CameraBarcodeScanner'

const BARCODE_SCANNER_VERSION = '1.2'

interface BarcodeScannerModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    isCameraScannerAutoEnabled: boolean
    setIsCameraScannerAutoEnabled: (value: boolean) => void
    isDeviceScannerAutoEnabled: boolean
    setIsDeviceScannerAutoEnabled: (value: boolean) => void
    isBluetoothScannerModeEnabled: boolean
    setIsBluetoothScannerModeEnabled: (value: boolean) => void
    isDeviceScannerImmediateSubmitEnabled: boolean
    setIsDeviceScannerImmediateSubmitEnabled: (value: boolean) => void
    canImmediatelySubmitDeviceScan: (value: string) => boolean
    handleBarcodeDetected: (barcodes: any[], source: 'camera' | 'device') => void
    selectedCameraId: string
    setSelectedCameraId: (value: string) => void
    scanDelay: number
    setScanDelay: (value: number) => void
    cameras: MediaDeviceInfo[]
}

export function BarcodeScannerModal({
    open,
    onOpenChange,
    isCameraScannerAutoEnabled,
    setIsCameraScannerAutoEnabled,
    isDeviceScannerAutoEnabled,
    setIsDeviceScannerAutoEnabled,
    isBluetoothScannerModeEnabled,
    setIsBluetoothScannerModeEnabled,
    isDeviceScannerImmediateSubmitEnabled,
    setIsDeviceScannerImmediateSubmitEnabled,
    canImmediatelySubmitDeviceScan,
    handleBarcodeDetected,
    selectedCameraId,
    setSelectedCameraId,
    scanDelay,
    setScanDelay,
    cameras
}: BarcodeScannerModalProps) {
    const { t } = useTranslation()
    const [scannerMode, setScannerMode] = useState<'camera' | 'device'>(() => {
        if (typeof localStorage === 'undefined') return 'camera'
        return (localStorage.getItem('pos_barcode_scanner_mode') as 'camera' | 'device') || 'camera'
    })
    const [deviceInput, setDeviceInput] = useState('')
    const deviceInputValueRef = useRef('')
    const deviceInputRef = useRef<HTMLInputElement>(null)
    const deviceScanTimeoutRef = useRef<number | null>(null)
    const lastKeyTimeRef = useRef(0)
    const fastKeyCountRef = useRef(0)
    const scannerActiveRef = useRef(false)
    const [hidDevices, setHidDevices] = useState<Array<{ id: string; label: string }>>([])
    const [selectedHidDeviceId, setSelectedHidDeviceId] = useState(() => {
        if (typeof localStorage === 'undefined') return ''
        return localStorage.getItem('pos_barcode_hid_device_id') || ''
    })
    const [isHidSupported, setIsHidSupported] = useState(true)
    const [isHidLoading, setIsHidLoading] = useState(false)
    const deviceFastKeyThreshold = isBluetoothScannerModeEnabled
        ? BARCODE_SCANNER_BLUETOOTH_FAST_KEY_THRESHOLD_MS
        : BARCODE_SCANNER_FAST_KEY_THRESHOLD_MS
    const deviceActiveKeyGrace = isBluetoothScannerModeEnabled
        ? BARCODE_SCANNER_BLUETOOTH_ACTIVE_KEY_GRACE_MS
        : BARCODE_SCANNER_ACTIVE_KEY_GRACE_MS
    const deviceAutoCommitDelay = isBluetoothScannerModeEnabled
        ? BARCODE_SCANNER_BLUETOOTH_AUTO_COMMIT_DELAY_MS
        : BARCODE_SCANNER_AUTO_COMMIT_DELAY_MS

    useEffect(() => {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem('pos_barcode_scanner_mode', scannerMode)
    }, [scannerMode])

    useEffect(() => {
        deviceInputValueRef.current = deviceInput
    }, [deviceInput])

    useEffect(() => {
        if (!open) return

        if (isDeviceScannerAutoEnabled) {
            setScannerMode('device')
            return
        }

        if (isCameraScannerAutoEnabled) {
            setScannerMode('camera')
        }
    }, [open, isCameraScannerAutoEnabled, isDeviceScannerAutoEnabled])

    const formatHidLabel = (device: any) => {
        const vendorId = typeof device?.vendorId === 'number'
            ? device.vendorId.toString(16).padStart(4, '0')
            : '????'
        const productId = typeof device?.productId === 'number'
            ? device.productId.toString(16).padStart(4, '0')
            : '????'
        const name = device?.productName || t('pos.hidDeviceFallback', { defaultValue: 'HID Device' })
        return `${name} (${vendorId}:${productId})`
    }

    const buildHidId = (device: any) => {
        const vendorId = typeof device?.vendorId === 'number' ? device.vendorId : 0
        const productId = typeof device?.productId === 'number' ? device.productId : 0
        const serial = device?.serialNumber ? String(device.serialNumber) : ''
        return `${vendorId}:${productId}:${serial}`
    }

    const syncHidSelection = (devices: Array<{ id: string; label: string }>) => {
        if (devices.length === 0) {
            setSelectedHidDeviceId('')
            return
        }
        const exists = devices.some((device) => device.id === selectedHidDeviceId)
        if (!exists) {
            setSelectedHidDeviceId(devices[0].id)
        }
    }

    const loadHidDevices = async () => {
        const hid = (navigator as any)?.hid
        if (!hid) {
            setIsHidSupported(false)
            setHidDevices([])
            return
        }

        setIsHidSupported(true)
        setIsHidLoading(true)
        try {
            const devices = await hid.getDevices()
            const mapped = devices.map((device: any) => ({
                id: buildHidId(device),
                label: formatHidLabel(device)
            }))
            setHidDevices(mapped)
            syncHidSelection(mapped)
        } catch (error) {
            console.error('[BarcodeScannerModal] Failed to load HID devices:', error)
            setHidDevices([])
        } finally {
            setIsHidLoading(false)
        }
    }

    const requestHidDevices = async () => {
        const hid = (navigator as any)?.hid
        if (!hid) {
            setIsHidSupported(false)
            return
        }

        setIsHidSupported(true)
        setIsHidLoading(true)
        try {
            await hid.requestDevice({ filters: [] })
        } catch (error) {
            console.warn('[BarcodeScannerModal] HID request cancelled or failed:', error)
        } finally {
            setIsHidLoading(false)
        }

        await loadHidDevices()
    }

    useEffect(() => {
        if (!open || scannerMode !== 'device') return
        void loadHidDevices()
    }, [open, scannerMode])

    useEffect(() => {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem('pos_barcode_hid_device_id', selectedHidDeviceId)
    }, [selectedHidDeviceId])

    const clearDeviceScanTimeout = useCallback(() => {
        if (deviceScanTimeoutRef.current !== null) {
            window.clearTimeout(deviceScanTimeoutRef.current)
            deviceScanTimeoutRef.current = null
        }
    }, [])

    const resetDeviceScanState = useCallback(() => {
        clearDeviceScanTimeout()
        deviceInputValueRef.current = ''
        setDeviceInput('')
        scannerActiveRef.current = false
        fastKeyCountRef.current = 0
        lastKeyTimeRef.current = 0
    }, [clearDeviceScanTimeout])

    useEffect(() => clearDeviceScanTimeout, [clearDeviceScanTimeout])

    useEffect(() => {
        if (!open || scannerMode !== 'device' || !isDeviceScannerAutoEnabled) {
            resetDeviceScanState()
        }
    }, [isDeviceScannerAutoEnabled, open, resetDeviceScanState, scannerMode])

    const commitDeviceScan = (value: string) => {
        const trimmed = normalizeBarcodeScannerText(value)
        resetDeviceScanState()
        if (!trimmed) return
        handleBarcodeDetected([{ rawValue: trimmed }], 'device')
    }

    const scheduleDeviceScan = (value: string) => {
        clearDeviceScanTimeout()
        deviceScanTimeoutRef.current = window.setTimeout(() => {
            commitDeviceScan(value)
        }, deviceAutoCommitDelay)
    }

    const registerScannerKeystroke = (timestamp: number) => {
        const wasActive = scannerActiveRef.current
        const timing = classifyBarcodeScannerKeyTiming(timestamp, lastKeyTimeRef.current, {
            hasBufferedValue: Boolean(deviceInputValueRef.current),
            isActive: wasActive,
            fastKeyThresholdMs: deviceFastKeyThreshold,
            activeKeyGraceMs: deviceActiveKeyGrace
        })
        lastKeyTimeRef.current = timestamp

        if (timing.shouldReset) {
            fastKeyCountRef.current = 0
            scannerActiveRef.current = false
        } else if (timing.isFast) {
            fastKeyCountRef.current += 1
        }

        if (fastKeyCountRef.current >= BARCODE_SCANNER_ACTIVE_FAST_KEY_COUNT) {
            scannerActiveRef.current = true
        }
    }

    const insertDeviceScannerKey = (input: HTMLInputElement, key: string) => {
        const currentValue = deviceInputValueRef.current
        const selectionStart = input.selectionStart ?? currentValue.length
        const selectionEnd = input.selectionEnd ?? currentValue.length
        const nextValue = normalizeBarcodeDigits(
            `${currentValue.slice(0, selectionStart)}${key}${currentValue.slice(selectionEnd)}`
        )
        const nextCursor = selectionStart + key.length

        deviceInputValueRef.current = nextValue
        input.value = nextValue
        setDeviceInput(nextValue)
        window.requestAnimationFrame(() => {
            input.setSelectionRange(nextCursor, nextCursor)
        })

        if (scannerActiveRef.current && isDeviceScannerAutoEnabled) {
            if (isDeviceScannerImmediateSubmitEnabled && canImmediatelySubmitDeviceScan(nextValue)) {
                commitDeviceScan(nextValue)
                return
            }
            scheduleDeviceScan(nextValue)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl w-[95vw] sm:w-full max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Camera className="w-5 h-5 text-primary" />
                        {t('pos.barcodeScanner')}
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-6 py-4">
                    <div className="rounded-xl border border-border bg-muted/20 p-4">
                        <div className="space-y-2">
                            <Label className="text-xs uppercase text-muted-foreground">
                                {t('pos.scanSource', { defaultValue: 'Scan Source' })}
                            </Label>
                            <Select
                                value={scannerMode}
                                onValueChange={(value) => setScannerMode(value as 'camera' | 'device')}
                            >
                                <SelectTrigger className="h-9 max-w-[260px]">
                                    <SelectValue placeholder={t('pos.scanSourcePlaceholder', { defaultValue: 'Choose scan source' })} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="camera">{t('pos.camera') || 'Camera'}</SelectItem>
                                    <SelectItem value="device">
                                        {t('pos.barcodeScannerHid', { defaultValue: 'Barcode Scanner (HID)' })}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground">
                                {t('pos.scanSourceDesc', {
                                    defaultValue: 'Choose between the built-in camera or an external HID barcode scanner.'
                                })}
                            </p>
                        </div>
                    </div>

                    {scannerMode === 'camera' ? (
                        <div className="space-y-6">
                            {/* Scanner View */}
                            <div className="relative aspect-video bg-muted rounded-xl overflow-hidden border border-border shadow-inner group">
                                {isCameraScannerAutoEnabled ? (
                                    <CameraBarcodeScanner
                                        selectedCameraId={selectedCameraId}
                                        onCapture={(barcodes) => handleBarcodeDetected(barcodes, 'camera')}
                                    />
                                ) : (
                                    <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground bg-muted/50">
                                        <Camera className="w-12 h-12 opacity-20 mb-2" />
                                        <p className="font-medium">{t('pos.scannerDisabled')}</p>
                                    </div>
                                )}

                                {/* Scanner Overlay */}
                                {isCameraScannerAutoEnabled && (
                                    <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-0.5 bg-primary/50 shadow-[0_0_15px_rgba(var(--primary),0.5)] animate-pulse" />
                                )}
                            </div>

                            {/* Controls */}
                            <div className="grid gap-6 md:grid-cols-2">
                                <div className="space-y-4 p-4 rounded-xl bg-muted/30 border border-border">
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <Label className="text-base">{t('pos.autoScanner')}</Label>
                                            <p className="text-xs text-muted-foreground">{t('pos.autoScannerDesc')}</p>
                                        </div>
                                        <Switch
                                            checked={isCameraScannerAutoEnabled}
                                            onCheckedChange={(val) => {
                                                if (val) {
                                                    setScannerMode('camera')
                                                }
                                                setIsCameraScannerAutoEnabled(val)
                                            }}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-4 p-4 rounded-xl bg-muted/30 border border-border">
                                    <div className="space-y-2">
                                        <Label className="text-sm font-medium">{t('pos.scanDelay')} (ms)</Label>
                                        <Input
                                            type="number"
                                            value={scanDelay}
                                            onChange={(e) => {
                                                const val = Number(e.target.value)
                                                setScanDelay(val)
                                                localStorage.setItem('scanner_scan_delay', String(val))
                                            }}
                                            min={0}
                                            max={10000}
                                            step={100}
                                            className="h-9"
                                        />
                                        <p className="text-[10px] text-muted-foreground">{t('pos.scanDelayDesc')}</p>
                                    </div>
                                </div>

                                <div className="space-y-2 col-span-full">
                                    <Label className="text-sm font-medium flex items-center gap-2">
                                        <SettingsIcon className="w-4 h-4" />
                                        {t('pos.selectCamera')}
                                    </Label>
                                    <select
                                        className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                                        value={selectedCameraId}
                                        onChange={(e) => {
                                            setSelectedCameraId(e.target.value)
                                            localStorage.setItem('scanner_camera_id', e.target.value)
                                        }}
                                    >
                                        {cameras.map((camera) => (
                                            <option key={camera.deviceId} value={camera.deviceId}>
                                                {camera.label || `Camera ${camera.deviceId.slice(0, 5)}`}
                                            </option>
                                        ))}
                                        {cameras.length === 0 && (
                                            <option value="">{t('pos.cameraNotFound')}</option>
                                        )}
                                    </select>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {isHidSupported && (
                                <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                                    <div className="space-y-2">
                                        <Label className="text-sm font-medium">{t('pos.scannerDevice') || 'Scanner Device'}</Label>
                                        <Select
                                            value={selectedHidDeviceId}
                                            onValueChange={setSelectedHidDeviceId}
                                            disabled={hidDevices.length === 0}
                                        >
                                            <SelectTrigger className="h-9">
                                                <SelectValue placeholder={t('pos.scannerDevicePlaceholder') || 'Select a scanner'} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {hidDevices.map((device) => (
                                                    <SelectItem key={device.id} value={device.id}>
                                                        {device.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        {hidDevices.length === 0 && (
                                            <p className="text-[11px] text-muted-foreground">
                                                {t('pos.noScannerDevices', { defaultValue: 'No scanner devices detected.' })}
                                            </p>
                                        )}
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="h-9"
                                        onClick={requestHidDevices}
                                        disabled={isHidLoading}
                                    >
                                        {t('pos.refreshDevices', { defaultValue: 'Refresh' })}
                                    </Button>
                                </div>
                            )}

                            <div className="rounded-xl border border-border bg-muted/30 p-4">
                                <p className="text-sm font-semibold">{t('pos.barcodeScanner') || 'Barcode Scanner'}</p>
                                <p className="text-xs text-muted-foreground">
                                    {t('pos.autoScannerGlobalDesc', {
                                        defaultValue: 'Automatic scanner works globally in POS. Turn it on and scan from anywhere without focusing an input first.'
                                    })}
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-sm font-medium">{t('pos.scanInput') || 'Scanner Input'}</Label>
                                <Input
                                    ref={deviceInputRef}
                                    data-pos-barcode-scanner-input
                                    value={deviceInput}
                                    onChange={(e) => {
                                        const nextValue = normalizeBarcodeDigits(e.target.value)
                                        deviceInputValueRef.current = nextValue
                                        setDeviceInput(nextValue)
                                        if (!nextValue) {
                                            resetDeviceScanState()
                                            return
                                        }
                                        if (scannerActiveRef.current && isDeviceScannerAutoEnabled) {
                                            if (isDeviceScannerImmediateSubmitEnabled && canImmediatelySubmitDeviceScan(nextValue)) {
                                                commitDeviceScan(nextValue)
                                                return
                                            }
                                            scheduleDeviceScan(nextValue)
                                        }
                                    }}
                                    onKeyDown={(e) => {
                                        if (isBarcodeScannerTerminatorKey(e.key)) {
                                            e.preventDefault()
                                            commitDeviceScan(deviceInputValueRef.current)
                                            return
                                        }

                                        if (isBarcodeScannerIgnoredKey(e.key)) {
                                            return
                                        }

                                        if (isDeviceScannerAutoEnabled) {
                                            const scannerKey = getBarcodeScannerEventKey(e.nativeEvent)
                                            if (scannerKey.length === 1) {
                                                registerScannerKeystroke(e.nativeEvent.timeStamp)
                                                e.preventDefault()
                                                insertDeviceScannerKey(e.currentTarget, scannerKey)
                                            }
                                        }
                                    }}
                                    placeholder={t('pos.scanInputPlaceholder') || 'Scan a barcode...'}
                                    className="h-10"
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    {t('pos.scanInputOptionalDesc', { defaultValue: 'Manual input is optional. Automatic scanner captures completed scans anywhere in POS.' })}
                                </p>
                            </div>

                            <div className="grid gap-6 md:grid-cols-2">
                                <div className="space-y-4 p-4 rounded-xl bg-muted/30 border border-border">
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <Label className="text-base">{t('pos.autoScanner')}</Label>
                                            <p className="text-xs text-muted-foreground">{t('pos.autoScannerDesc')}</p>
                                        </div>
                                        <Switch
                                            checked={isDeviceScannerAutoEnabled}
                                            onCheckedChange={(val) => {
                                                if (val) {
                                                    setScannerMode('device')
                                                }
                                                setIsDeviceScannerAutoEnabled(val)
                                            }}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-4 p-4 rounded-xl bg-muted/30 border border-border">
                                    <div className="space-y-2">
                                        <Label className="text-sm font-medium">{t('pos.scanDelay')} (ms)</Label>
                                        <Input
                                            type="number"
                                            value={scanDelay}
                                            onChange={(e) => {
                                                const val = Number(e.target.value)
                                                setScanDelay(val)
                                                localStorage.setItem('scanner_scan_delay', String(val))
                                            }}
                                            min={0}
                                            max={10000}
                                            step={100}
                                            className="h-9"
                                        />
                                        <p className="text-[10px] text-muted-foreground">{t('pos.scanDelayDesc')}</p>
                                    </div>
                                </div>

                                <div className="space-y-4 p-4 rounded-xl bg-muted/30 border border-border md:col-span-2">
                                    <div className="flex items-center justify-between gap-4">
                                        <div className="space-y-0.5">
                                            <Label className="text-base">
                                                {t('pos.bluetoothScannerMode', { defaultValue: 'Bluetooth scanner mode' })}
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                {t('pos.bluetoothScannerModeDesc', {
                                                    defaultValue: 'Use wider timing windows for wireless scanners that pause or wake during a scan.'
                                                })}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={isBluetoothScannerModeEnabled}
                                            onCheckedChange={setIsBluetoothScannerModeEnabled}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-4 p-4 rounded-xl bg-muted/30 border border-border md:col-span-2">
                                    <div className="flex items-center justify-between gap-4">
                                        <div className="space-y-0.5">
                                            <Label className="text-base">
                                                {t('pos.scannerImmediateSubmit', { defaultValue: 'Auto-submit scans without Enter' })}
                                            </Label>
                                            <p className="text-xs text-muted-foreground">
                                                {/*t('pos.scannerImmediateSubmitDesc', {defaultValue: 'Adds a recognized barcode immediately, as if Enter was pressed. Barcodes that share a prefix still wait until the scan is complete.'})*/}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={isDeviceScannerImmediateSubmitEnabled}
                                            onCheckedChange={setIsDeviceScannerImmediateSubmitEnabled}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        {t('common.cancel')}
                    </Button>
                </DialogFooter>

                <p className="text-center text-[11px] text-muted-foreground">
                    {t('pos.barcodeScannerVersion', { defaultValue: 'Barcode Scanner' })} v{BARCODE_SCANNER_VERSION}
                </p>
            </DialogContent>
        </Dialog>
    )
}
