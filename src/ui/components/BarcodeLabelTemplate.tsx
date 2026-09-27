import {
    getBarcodeLabelPricePerUnit,
    getCode128BBarWidths,
    getCode128BModuleCount,
    formatBarcodeLabelPrice,
    type BarcodeLabelData,
    type BarcodeLabelPriceUnitTranslations,
    type BarcodeLabelProfile
} from '@/lib/barcodeLabel'

type BarcodeLabelTemplateProps = {
    labels: BarcodeLabelData[]
    profile: BarcodeLabelProfile
    showPrice?: boolean
    priceLabel: string
    barcodeLabel: string
    pricePerUnitTranslations?: Partial<BarcodeLabelPriceUnitTranslations>
}

function BarcodeGraphic({ value, label }: { value: string; label: string }) {
    const widths = getCode128BBarWidths(value)
    const moduleCount = getCode128BModuleCount(value)
    let cursor = 0

    return (
        <svg
            viewBox={`0 0 ${moduleCount} 100`}
            preserveAspectRatio="none"
            aria-label={`${label} ${value}`}
            className="h-full w-full"
            role="img"
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

function WideBarcodeLabel({
    label,
    profile,
    showPrice,
    priceLabel,
    barcodeLabel,
    pricePerUnitTranslations
}: {
    label: BarcodeLabelData
    profile: BarcodeLabelProfile
    showPrice: boolean
    priceLabel: string
    barcodeLabel: string
    pricePerUnitTranslations: Partial<BarcodeLabelPriceUnitTranslations>
}) {
    const pricePerUnitLabel = getBarcodeLabelPricePerUnit(label.unit, pricePerUnitTranslations)
    const price = formatBarcodeLabelPrice(
        label.price,
        label.currency,
        label.iqdDisplayPreference,
        label.unit,
        pricePerUnitTranslations
    )

    return (
        <section
            key={label.id}
            className="box-border flex shrink-0 flex-col overflow-hidden rounded-[0.8mm] border border-neutral-300 bg-white text-black"
            style={{ width: `${profile.widthMm}mm`, height: `${profile.heightMm}mm`, padding: `${profile.safeMarginMm}mm` }}
            data-barcode-label
            data-barcode-label-profile={profile.id}
        >
            <div className="flex min-h-0 items-start justify-between gap-[3mm]">
                <div
                    className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ellipsis font-sans text-[4.2mm] font-bold leading-tight"
                    style={{ maxHeight: '9mm' }}
                    dir="auto"
                    title={label.productName}
                >
                    {label.productName || label.displayValue}
                </div>
                {showPrice ? (
                    <div className="w-[39mm] shrink-0 text-right leading-none">
                        <div className="text-[1.8mm] font-medium">{priceLabel}</div>
                        <div className={`mt-[0.7mm] overflow-hidden text-ellipsis whitespace-nowrap font-sans font-bold tracking-tight ${pricePerUnitLabel ? 'text-[3.1mm]' : 'text-[4.2mm]'}`}>
                            {price}
                        </div>
                    </div>
                ) : null}
            </div>
            <div
                className="mt-[2mm] min-h-0 w-full"
                style={{ height: showPrice ? '23mm' : '28mm' }}
            >
                <BarcodeGraphic value={label.barcode} label={barcodeLabel} />
            </div>
            <div className="mt-[1mm] shrink-0 overflow-hidden text-center font-mono text-[3.2mm] font-bold leading-none tracking-[0.06em]">
                {label.displayValue}
            </div>
        </section>
    )
}

export function BarcodeLabelTemplate({
    labels,
    profile,
    showPrice = true,
    priceLabel,
    barcodeLabel,
    pricePerUnitTranslations = {}
}: BarcodeLabelTemplateProps) {
    return (
        <div
            className="flex flex-col bg-transparent text-black"
            style={{ width: `${profile.widthMm}mm`, gap: profile.layout === 'compact' ? '3mm' : undefined }}
        >
            {labels.map((label) => {
                if (profile.layout === 'wide') {
                    return (
                        <WideBarcodeLabel
                            key={label.id}
                            label={label}
                            profile={profile}
                            showPrice={showPrice}
                            priceLabel={priceLabel}
                            barcodeLabel={barcodeLabel}
                            pricePerUnitTranslations={pricePerUnitTranslations}
                        />
                    )
                }

                const pricePerUnitLabel = getBarcodeLabelPricePerUnit(label.unit, pricePerUnitTranslations)
                return (
                    <section
                        key={label.id}
                        className="box-border flex h-[15mm] w-[35mm] shrink-0 flex-col overflow-hidden rounded-[0.7mm] border border-neutral-300 bg-white px-[1.4mm] py-[0.7mm] shadow-sm"
                        data-barcode-label
                        data-barcode-label-profile={profile.id}
                    >
                        {showPrice ? (
                            <div className="shrink-0 leading-none">
                                <div className="text-[1.7mm] font-medium">{priceLabel}</div>
                                <div className={pricePerUnitLabel ? 'mt-[0.25mm] text-[2.35mm] font-bold tracking-tight' : 'mt-[0.25mm] text-[2.7mm] font-bold tracking-tight'}>
                                    {formatBarcodeLabelPrice(
                                        label.price,
                                        label.currency,
                                        label.iqdDisplayPreference,
                                        label.unit,
                                        pricePerUnitTranslations
                                    )}
                                </div>
                            </div>
                        ) : null}
                        <div className={showPrice ? 'mt-[0.55mm] h-[5.35mm]' : 'mt-[0.25mm] h-[8.15mm]'}>
                            <BarcodeGraphic value={label.barcode} label={barcodeLabel} />
                        </div>
                        <div className="mt-[0.35mm] shrink-0 text-center font-mono text-[1.65mm] font-bold leading-none tracking-[0.06em]">
                            {label.displayValue}
                        </div>
                    </section>
                )
            })}
        </div>
    )
}
