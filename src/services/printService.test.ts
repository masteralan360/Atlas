import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    isDesktop: vi.fn(),
    isAndroidPwa: vi.fn(),
    isTauriAndroid: vi.fn(),
    invoke: vi.fn(),
    listNativePrinters: vi.fn(),
    printNative: vi.fn(),
    testNative: vi.fn(),
    getAppSetting: vi.fn(),
    getAppSettingSync: vi.fn(),
    setAppSetting: vi.fn(),
    clearAppSetting: vi.fn(),
    qzIsActive: vi.fn(),
    qzConnect: vi.fn(),
    qzFindPrinters: vi.fn(),
    qzCreateConfig: vi.fn(),
    qzPrint: vi.fn(),
    renderReceiptImageToEscPos: vi.fn()
}))

vi.mock('@/lib/platform', () => ({
    isDesktop: mocks.isDesktop,
    isAndroidPwa: mocks.isAndroidPwa,
    isTauriAndroid: mocks.isTauriAndroid
}))

vi.mock('@tauri-apps/api/core', () => ({
    invoke: mocks.invoke
}))

vi.mock('@/i18n/config', () => ({
    default: {
        language: 'en',
        t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key
    }
}))

vi.mock('@/local-db/settings', () => ({
    getAppSetting: mocks.getAppSetting,
    getAppSettingSync: mocks.getAppSettingSync,
    setAppSetting: mocks.setAppSetting,
    clearAppSetting: mocks.clearAppSetting
}))

vi.mock('tauri-plugin-thermal-printer', () => ({
    list_thermal_printers: mocks.listNativePrinters,
    print_thermal_printer: mocks.printNative,
    test_thermal_printer: mocks.testNative
}))

vi.mock('qz-tray', () => ({
    default: {
        websocket: {
            isActive: mocks.qzIsActive,
            connect: mocks.qzConnect
        },
        printers: {
            find: mocks.qzFindPrinters
        },
        configs: {
            create: mocks.qzCreateConfig
        },
        print: mocks.qzPrint
    }
}))

vi.mock('@/services/mobileThermalPrinter', () => ({
    getDirectMobileThermalCapabilities: vi.fn(),
    listAuthorizedUsbThermalPrinters: vi.fn(),
    printToDirectMobileThermalPrinter: vi.fn(),
    renderReceiptImageToEscPos: mocks.renderReceiptImageToEscPos,
    requestBluetoothThermalPrinter: vi.fn(),
    requestUsbThermalPrinter: vi.fn(),
    testDirectMobileThermalPrinter: vi.fn()
}))

import { printService } from './printService'

describe('PWA thermal printing through QZ Tray', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.isDesktop.mockReturnValue(false)
        mocks.isAndroidPwa.mockReturnValue(false)
        mocks.isTauriAndroid.mockReturnValue(false)
        mocks.qzIsActive.mockReturnValue(false)
        mocks.qzConnect.mockResolvedValue(undefined)
        mocks.qzCreateConfig.mockReturnValue({ printer: 'EPSON TM-T20' })
        mocks.qzPrint.mockResolvedValue(undefined)
        mocks.renderReceiptImageToEscPos.mockResolvedValue(new Uint8Array([27, 64, 29, 86, 0]))
    })

    it('discovers local PWA printers through QZ Tray', async () => {
        mocks.qzFindPrinters.mockResolvedValue(['EPSON TM-T20', 'Microsoft Print to PDF'])

        await expect(printService.listThermalPrinters()).resolves.toEqual([
            {
                name: 'EPSON TM-T20',
                identifier: 'EPSON TM-T20',
                interface_type: 'QZ Tray (local bridge)',
                status: 'Available',
                transport: 'qz'
            },
            {
                name: 'Microsoft Print to PDF',
                identifier: 'Microsoft Print to PDF',
                interface_type: 'QZ Tray (local bridge)',
                status: 'Available',
                transport: 'qz'
            }
        ])

        expect(mocks.qzConnect).toHaveBeenCalledWith({ retries: 0, delay: 0 })
    })

    it('persists auto-print upon checkout separately for this workspace and device', async () => {
        mocks.getAppSettingSync.mockImplementation((key: string) => (
            key === 'auto_print_upon_checkout_workspace-1' ? 'true' : null
        ))

        expect(printService.isAutoPrintUponCheckoutEnabled('workspace-1')).toBe(true)
        expect(printService.isAutoPrintUponCheckoutEnabled('workspace-2')).toBe(false)
        expect(printService.isAutoPrintUponCheckoutEnabled('')).toBe(false)

        await printService.setAutoPrintUponCheckoutEnabled('workspace-1', false)

        expect(mocks.setAppSetting).toHaveBeenCalledWith(
            'auto_print_upon_checkout_workspace-1',
            'false'
        )
    })

    it('sends the receipt image as a raw ESC/POS QZ print job', async () => {
        mocks.getAppSetting.mockResolvedValue(JSON.stringify({
            name: 'EPSON TM-T20',
            interface_type: 'QZ Tray (local bridge)',
            identifier: 'EPSON TM-T20',
            paper_size: 'Mm80',
            roll_width_mm: 80,
            transport: 'qz'
        }))

        await expect(printService.silentPrintImage({
            workspaceId: 'workspace-1',
            imageBase64: 'data:image/png;base64,abc123',
            maxWidth: 576
        })).resolves.toBe(true)

        expect(mocks.qzCreateConfig).toHaveBeenCalledWith('EPSON TM-T20', { jobName: 'Atlas Receipt' })
        expect(mocks.qzPrint).toHaveBeenCalledWith(
            { printer: 'EPSON TM-T20' },
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'raw',
                    format: 'image',
                    flavor: 'base64',
                    data: 'abc123',
                    options: expect.objectContaining({ language: 'ESCPOS', imageEncoding: 'gs_v_0' })
                }),
                '\x1DV\x00'
            ])
        )
    })

    it('lists Android Tauri Bluetooth Classic printers through the native bridge', async () => {
        mocks.isTauriAndroid.mockReturnValue(true)
        mocks.invoke.mockResolvedValue([
            {
                name: 'POS-58',
                interface_type: 'Bluetooth Classic (Tauri Android)',
                identifier: '00:11:22:33:44:55',
                status: 'Paired'
            }
        ])

        await expect(printService.listThermalPrinters()).resolves.toEqual([
            {
                name: 'POS-58',
                interface_type: 'Bluetooth Classic (Tauri Android)',
                identifier: '00:11:22:33:44:55',
                status: 'Paired',
                transport: 'tauri-android-bluetooth'
            }
        ])

        expect(mocks.invoke).toHaveBeenCalledWith('list_android_bluetooth_thermal_printers')
    })

    it('sends a native Android Bluetooth printer test and returns its error', async () => {
        mocks.invoke.mockRejectedValueOnce(new Error('Bluetooth permission was denied'))

        await expect(printService.testThermalPrinter('workspace-1', {
            name: 'POS-58',
            interface_type: 'Bluetooth Classic (Tauri Android)',
            identifier: '00:11:22:33:44:55',
            status: 'Paired',
            paper_size: 'Mm58',
            transport: 'tauri-android-bluetooth'
        })).rejects.toThrow('Bluetooth permission was denied')

        expect(mocks.invoke).toHaveBeenCalledWith('test_android_bluetooth_thermal_printer', {
            address: '00:11:22:33:44:55'
        })
    })

    it('renders and sends an ESC/POS receipt through the Android Bluetooth bridge', async () => {
        mocks.getAppSetting.mockResolvedValue(JSON.stringify({
            name: 'POS-58',
            interface_type: 'Bluetooth Classic (Tauri Android)',
            identifier: '00:11:22:33:44:55',
            paper_size: 'Mm58',
            roll_width_mm: 58,
            transport: 'tauri-android-bluetooth'
        }))
        mocks.invoke.mockResolvedValue(undefined)

        await expect(printService.silentPrintImage({
            workspaceId: 'workspace-1',
            imageBase64: 'data:image/png;base64,abc123',
            maxWidth: 384
        })).resolves.toBe(true)

        expect(mocks.renderReceiptImageToEscPos).toHaveBeenCalledWith('data:image/png;base64,abc123', 384)
        expect(mocks.invoke).toHaveBeenCalledWith('print_android_bluetooth_thermal_printer', {
            address: '00:11:22:33:44:55',
            payload: [27, 64, 29, 86, 0]
        })
    })
})
