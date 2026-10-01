import { useTranslation } from 'react-i18next'

import type { IQDDisplayPreference, TravelBooking, TravelPassenger } from '@/local-db'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'

const PASSENGERS_PER_PRINT_TABLE = 14

interface TravelBookingPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    booking: TravelBooking
    passengers: TravelPassenger[]
    iqdPreference: IQDDisplayPreference
    logoUrl?: string | null
}

function isRtlLanguage(language: string) {
    const baseLanguage = language.split('-')[0]
    return baseLanguage === 'ar' || baseLanguage === 'ku'
}

function resolveLogoSource(logoUrl?: string | null) {
    if (!logoUrl) return null
    return logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)
}

function chunkPassengers(passengers: TravelPassenger[]) {
    if (passengers.length === 0) return [[]] as TravelPassenger[][]

    const chunks: TravelPassenger[][] = []
    for (let index = 0; index < passengers.length; index += PASSENGERS_PER_PRINT_TABLE) {
        chunks.push(passengers.slice(index, index + PASSENGERS_PER_PRINT_TABLE))
    }
    return chunks
}

function SummaryItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="border border-slate-400 px-3 py-2">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-600">{label}</p>
            <p className="mt-1 text-sm font-bold">{value}</p>
        </div>
    )
}

export function TravelBookingPrintTemplate({
    workspaceName,
    printLang,
    booking,
    passengers,
    iqdPreference,
    logoUrl
}: TravelBookingPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const logoSource = resolveLogoSource(logoUrl)
    const passengerChunks = chunkPassengers(passengers)
    const adjustmentTotal = booking.adjustedBookingTotal - booking.bookingTotal
    const formatAmount = (amount: number) => formatCurrency(amount, booking.currency, iqdPreference)

    return (
        <div
            dir={isRtlLanguage(printLang) ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '210mm' }}
            data-order-print-page
            data-page-width-mm="210"
            data-page-padding-mm="10"
            data-travel-booking-print
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; }
    [data-travel-booking-print] tr,
    [data-travel-booking-print] [data-pdf-keep-together] { break-inside: avoid; page-break-inside: avoid; }
    [data-travel-booking-print] thead { display: table-header-group; }
}
`
                }}
            />

            <section className="bg-white" style={{ minHeight: '297mm', padding: '10mm', boxSizing: 'border-box' }}>
                <header className="grid grid-cols-[auto_1fr] items-center gap-5 border-b-2 border-slate-900 pb-4" data-pdf-keep-together>
                    <div className="flex min-h-[25mm] min-w-[42mm] items-center justify-center border-e border-slate-300 pe-5">
                        {logoSource ? (
                            <img src={logoSource} alt="" className="max-h-[24mm] max-w-[42mm] object-contain" />
                        ) : (
                            <span className="text-center text-[14px] font-bold">{workspaceName || 'Atlas'}</span>
                        )}
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-[21px] font-bold tracking-tight">{workspaceName || 'Atlas'}</h1>
                        <p className="mt-1 text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-700">{t('travelTransportation.print.title')}</p>
                        <p className="mt-1 text-[9px] text-slate-600">{t('travelTransportation.print.printedAt')}: {formatDateTime(new Date())}</p>
                    </div>
                </header>

                <section className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-[10px]" data-pdf-keep-together>
                    <div className="flex items-center justify-between gap-3 border-b border-slate-300 pb-1"><span className="font-semibold text-slate-600">{t('travelTransportation.bookingNumber')}</span><strong>{booking.bookingNumber}</strong></div>
                    <div className="flex items-center justify-between gap-3 border-b border-slate-300 pb-1"><span className="font-semibold text-slate-600">{t('travelTransportation.travelDate')}</span><strong>{booking.travelDate ? formatDate(booking.travelDate) : '—'}</strong></div>
                    <div className="flex items-center justify-between gap-3 border-b border-slate-300 pb-1"><span className="font-semibold text-slate-600">{t('travelTransportation.table.status')}</span><strong>{t(`travelTransportation.statuses.${booking.status}`)}</strong></div>
                    <div className="flex items-center justify-between gap-3 border-b border-slate-300 pb-1"><span className="font-semibold text-slate-600">{t('travelTransportation.passengers')}</span><strong>{passengers.length}</strong></div>
                </section>

                <section className="mt-5" data-pdf-keep-together>
                    <div className="flex items-center justify-between border-x border-t border-slate-500 bg-slate-100 px-3 py-2">
                        <h2 className="text-[12px] font-bold">{t('travelTransportation.print.passengerList')}</h2>
                        <span className="text-[10px] font-semibold text-slate-600">{booking.currency.toUpperCase()}</span>
                    </div>
                </section>

                {passengerChunks.map((passengerChunk, chunkIndex) => (
                    <table
                        key={chunkIndex}
                        data-pdf-page-chunk
                        data-centered-table={chunkIndex > 0 ? '' : undefined}
                        className="w-full table-fixed border-collapse text-[10px]"
                    >
                        <thead>
                            {chunkIndex > 0 ? <tr className="bg-slate-100"><th className="border border-slate-500 px-2 py-1.5 text-start text-[10px]" colSpan={5}>{t('travelTransportation.print.passengerList')} · {t('travelTransportation.print.continued')}</th></tr> : null}
                            <tr className="bg-slate-900 text-white">
                                <th className="w-[7%] border border-slate-700 px-2 py-2 text-center">{t('travelTransportation.print.number')}</th>
                                <th className="w-[25%] border border-slate-700 px-2 py-2 text-start">{t('travelTransportation.name')}</th>
                                <th className="w-[23%] border border-slate-700 px-2 py-2 text-start">{t('travelTransportation.phoneNumber')}</th>
                                <th className="w-[25%] border border-slate-700 px-2 py-2 text-start">{t('travelTransportation.transportationType')}</th>
                                <th className="w-[20%] border border-slate-700 px-2 py-2 text-end">{t('travelTransportation.price')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {passengerChunk.length === 0 ? <tr style={{ height: '12mm' }}><td className="border border-slate-300 px-2 py-2 text-center text-slate-500" colSpan={5}>{t('travelTransportation.print.noPassengers')}</td></tr> : passengerChunk.map((passenger, index) => (
                                <tr key={passenger.id} data-pdf-keep-together style={{ height: '12mm' }}>
                                    <td className="border border-slate-300 px-2 py-1.5 text-center font-semibold">{(chunkIndex * PASSENGERS_PER_PRINT_TABLE) + index + 1}</td>
                                    <td className="border border-slate-300 px-2 py-1.5 font-medium break-words">{passenger.name}</td>
                                    <td className="border border-slate-300 px-2 py-1.5 break-words">{passenger.phoneNumber || '—'}</td>
                                    <td className="border border-slate-300 px-2 py-1.5">{t(`travelTransportation.${passenger.transportationType}`)}</td>
                                    <td className="border border-slate-300 px-2 py-1.5 text-end font-semibold whitespace-nowrap">{formatAmount(passenger.price)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ))}

                <section className="mt-5 ms-auto max-w-[112mm]" data-pdf-keep-together>
                    <h2 className="border-x border-t border-slate-500 bg-slate-100 px-3 py-2 text-[12px] font-bold">{t('travelTransportation.print.totalSummary')}</h2>
                    <div className="grid grid-cols-3">
                        <SummaryItem label={t('travelTransportation.passengerTotal')} value={formatAmount(booking.passengerTotal)} />
                        <SummaryItem label={t('travelTransportation.print.adjustments')} value={adjustmentTotal === 0 ? '—' : formatAmount(adjustmentTotal)} />
                        <SummaryItem label={t('travelTransportation.adjustedBookingTotal')} value={formatAmount(booking.adjustedBookingTotal)} />
                    </div>
                </section>

                {booking.notes ? <section className="mt-5 border-t border-slate-300 pt-3 text-[10px]" data-pdf-keep-together><h2 className="font-bold">{t('travelTransportation.notes')}</h2><p className="mt-1 whitespace-pre-wrap text-slate-700">{booking.notes}</p></section> : null}
            </section>
        </div>
    )
}
