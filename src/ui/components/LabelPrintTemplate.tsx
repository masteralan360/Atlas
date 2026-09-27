import {
    formatBarcodeLabelPrice,
    getCode128BBarWidths,
    getCode128BModuleCount,
    type BarcodeLabelData
} from '@/lib/barcodeLabel'
import { useTranslation } from 'react-i18next'

function LabelBarcode({ label }: { label: BarcodeLabelData }) {
    const { t } = useTranslation()
    const widths = getCode128BBarWidths(label.barcode)
    const moduleCount = getCode128BModuleCount(label.barcode)
    let cursor = 0

    return (
        <svg
            viewBox={`0 0 ${moduleCount} 100`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t('products.barcodePrint.barcodeValue', {
                value: label.displayValue,
                defaultValue: `Barcode ${label.displayValue}`
            })}
            className="h-full w-full"
        >
            {widths.map((width, index) => {
                const x = cursor
                cursor += width
                return index % 2 === 0
                    ? <rect key={`${index}-${x}`} x={x} y="0" width={width} height="100" fill="black" />
                    : null
            })}
        </svg>
    )
}

export function LabelPrintTemplate({ label }: { label?: BarcodeLabelData }) {
    const { t } = useTranslation()
    const displayLabel: BarcodeLabelData = label || {
        id: 'label-print-sample',
        productName: t('customTemplates.labelPrint.sampleProduct', { defaultValue: 'Sample Product' }),
        barcode: '1234567890',
        displayValue: '1234567890',
        price: 1234,
        currency: 'IQD',
        unit: '',
        iqdDisplayPreference: 'IQD'
    }
    const pricePerUnitTranslations = {
        perSquareMeter: t('products.barcodePrint.perSquareMeter', { defaultValue: 'per 1m²' }),
        perDynamicKilogram: t('products.barcodePrint.perDynamicKilogram', { defaultValue: 'per 1 Kg' }),
        perMeter: t('products.barcodePrint.perMeter', { defaultValue: 'per 1 Meter' })
    }

    const price = formatBarcodeLabelPrice(
        displayLabel.price,
        displayLabel.currency,
        displayLabel.iqdDisplayPreference,
        displayLabel.unit,
        pricePerUnitTranslations
    )

    return (
        <div
            className="absolute inset-0 flex flex-col overflow-hidden bg-white px-[4%] py-[3%] text-black"
            data-label-print-content
            style={{ containerType: 'size' }}
        >
            <div className="flex min-h-0 items-center justify-between gap-[3%] overflow-hidden">
                <div
                    className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-sans font-bold leading-tight"
                    style={{ fontSize: 'clamp(1mm, 11cqh, 4.5mm)' }}
                    dir="auto"
                    title={displayLabel.productName}
                >
                    {displayLabel.productName || displayLabel.displayValue}
                </div>
                <div
                    className="shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-right font-sans font-semibold leading-tight"
                    style={{ fontSize: 'clamp(1mm, 9cqh, 3.5mm)', maxWidth: '48%' }}
                >
                    {price}
                </div>
            </div>
            <div className="mt-[3%] min-h-0 flex-1 overflow-hidden">
            <LabelBarcode label={displayLabel} />
            </div>
            <div
                className="mt-[2%] shrink-0 overflow-hidden text-center font-mono font-bold leading-none tracking-[0.04em]"
                style={{ fontSize: 'clamp(1mm, 8cqh, 3mm)' }}
            >
                {displayLabel.displayValue}
            </div>
        </div>
    )
}
