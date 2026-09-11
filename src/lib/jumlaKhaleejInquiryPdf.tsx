import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import type { JumlaKhaleejInquiryPdfData, JumlaKhaleejInquiryPdfItem } from './jumlaKhaleejInquiryPdfData'

const PAGE_WIDTH_MM = 210
const PAGE_HEIGHT_MM = 297
const RENDER_SCALE = 2.5
const ROWS_PER_PAGE = 8

type InquiryPdfBranding = {
    name: string
    logoUrl: string | null
}

type RenderItem = JumlaKhaleejInquiryPdfItem & { imageData: string | null }

function money(value: number, currency: string) {
    const amount = Number.isFinite(value) ? value : 0
    if (currency.toLowerCase() === 'iqd') return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(amount)} IQD`
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 4 }).format(amount)
}

function dateTime(value: string) {
    const parsed = new Date(value)
    const date = Number.isFinite(parsed.getTime()) ? parsed : new Date()
    return {
        date: new Intl.DateTimeFormat('ku-Arab-IQ', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replace(/-/g, '/'),
        time: new Intl.DateTimeFormat('ku-Arab-IQ', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    }
}

function placeholder(label: string) {
    const letter = (label.trim().slice(0, 1) || '?').replace(/[<>&]/g, '')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#f3f4f6"/><text x="80" y="98" text-anchor="middle" fill="#6b7280" font-family="Arial" font-size="58" font-weight="700">${letter}</text></svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

async function imageData(url: string | null) {
    if (!url) return null
    try {
        const response = await fetch(url, { credentials: 'omit' })
        if (!response.ok) return null
        const blob = await response.blob()
        if (!blob.type.startsWith('image/')) return null
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Image data is unavailable.'))
            reader.onerror = () => reject(new Error('Unable to read image.'))
            reader.readAsDataURL(blob)
        })
    } catch {
        return null
    }
}

function field(label: string, value: string, wide = false) {
    return <div className={`jk-inquiry-field${wide ? ' wide' : ''}`}><strong>{label} : </strong>{value || '-'}</div>
}

function InquiryPage({
    document,
    brand,
    items,
    rowStart,
    isFirstPage,
    logoData
}: {
    document: JumlaKhaleejInquiryPdfData
    brand: InquiryPdfBranding
    items: RenderItem[]
    rowStart: number
    isFirstPage: boolean
    logoData: string | null
}) {
    const total = document.items.reduce((sum, item) => sum + item.lineTotal, 0)
    const totalWithDelivery = total + document.deliveryFee
    const stamp = dateTime(document.createdAt)
    const totalQuantity = document.items.reduce((sum, item) => sum + item.quantity, 0)

    return (
        <section className="jk-inquiry-page" dir="rtl">
            <header className="jk-inquiry-header">
                <div className="jk-inquiry-brand">
                    {logoData ? <img src={logoData} alt="" /> : <span>{brand.name.slice(0, 1).toUpperCase()}</span>}
                    <h1>{brand.name}</h1>
                </div>
                <div className="jk-inquiry-title">
                    <strong>داواکاری فرۆشتن</strong>
                    <small>{document.documentNumber}</small>
                </div>
            </header>

            {isFirstPage && <>
                <div className="jk-inquiry-details">
                    {field('کڕیار', document.customer.name, true)}
                    {field('تەلەفۆن', document.customer.phone)}
                    {field('ناونیشانی کڕیار', document.customer.address, true)}
                    {field('شار', document.customer.city)}
                    {field('ژمارەی بەڵگە', document.documentNumber, true)}
                    {field('بەرواری پسوڵە', stamp.date)}
                    {field('کات', stamp.time)}
                </div>
            </>}

            <table className="jk-inquiry-table">
                <thead><tr><th>صورة</th><th>رقم</th><th>ناوی کاڵا</th><th>بڕ</th><th>نرخ</th><th>کۆی گشتی داواکاری</th></tr></thead>
                <tbody>
                    {items.map((item, index) => <tr key={`${item.productId}-${rowStart + index}`}>
                        <td className="image"><img src={item.imageData || placeholder(item.name)} alt="" /></td>
                        <td>{rowStart + index + 1}</td>
                        <td>{item.name}</td>
                        <td>{item.quantity}{item.unit ? ` ${item.unit}` : ''}</td>
                        <td>{money(item.price, item.currency)}</td>
                        <td>{money(item.lineTotal, item.currency)}</td>
                    </tr>)}
                    {items.length < ROWS_PER_PAGE && Array.from({ length: ROWS_PER_PAGE - items.length }, (_, index) => <tr className="blank" key={`blank-${index}`}><td /><td /><td /><td /><td /><td /></tr>)}
                    <tr className="total"><td /><td /><td /><td>{totalQuantity}</td><td>{money(total, document.currency)}</td></tr>
                </tbody>
            </table>

            {isFirstPage && <div className="jk-inquiry-financial">
                {field('کۆی گشتی داواکاری', money(total, document.currency))}
                {field('کرێی گەیاندن', money(document.deliveryFee, 'iqd'))}
                {field('کۆی گشتی داواکاری لەگەڵ کرێی گەیاندن', money(totalWithDelivery, 'iqd'), true)}
                {field('تێبینی', document.customer.notes, true)}
            </div>}

            <footer className="jk-inquiry-footer"><span>لبيع مواد كوزمتيك بالجملة</span><span>0771 450 4323</span><span>كركوك - رحيماوا قرب اسماك دلشاد</span></footer>
        </section>
    )
}

function InquiryTemplate({ document, brand, items, logoData }: { document: JumlaKhaleejInquiryPdfData; brand: InquiryPdfBranding; items: RenderItem[]; logoData: string | null }) {
    const chunks: RenderItem[][] = []
    for (let index = 0; index < items.length; index += ROWS_PER_PAGE) chunks.push(items.slice(index, index + ROWS_PER_PAGE))
    if (chunks.length === 0) chunks.push([])

    return <div className="jk-inquiry-root">
        <style>{`
            .jk-inquiry-root { width: 210mm; color: #1f2937; background: #fff; font-family: Arial, Helvetica, sans-serif; }
            .jk-inquiry-root * { box-sizing: border-box; }
            .jk-inquiry-page { position: relative; width: 210mm; min-height: 297mm; padding: 8mm; background: #fff; }
            .jk-inquiry-header { display:flex; align-items:center; justify-content:space-between; min-height:15mm; border-bottom:2px solid #1f2937; padding-bottom:1.5mm; margin-bottom:2mm; }
            .jk-inquiry-brand { display:flex; align-items:center; gap:3mm; min-width:0; }
            .jk-inquiry-brand img,.jk-inquiry-brand span { width:12mm; height:12mm; object-fit:contain; border:1px solid #1f2937; display:grid; place-items:center; font-weight:700; }
            .jk-inquiry-brand h1 { margin:0; font-size:17px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .jk-inquiry-title { display:grid; gap:1mm; text-align:left; direction:rtl; }
            .jk-inquiry-title strong { font-size:15px; }.jk-inquiry-title small{font-size:10px;color:#4b5563}
            .jk-inquiry-details,.jk-inquiry-financial { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-right:1px solid #1f2937; border-bottom:1px solid #1f2937; margin-bottom:2mm; }
            .jk-inquiry-field { min-height:7mm; overflow:hidden; border-left:1px solid #1f2937; border-top:1px solid #1f2937; padding:1.4mm 2mm; font-size:11px; line-height:1.3; text-overflow:ellipsis; white-space:nowrap; }
            .jk-inquiry-field.wide { grid-column:span 2; }.jk-inquiry-financial .wide:last-child { white-space:pre-wrap; overflow-wrap:anywhere; }
            .jk-inquiry-table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:10px; direction:rtl; }
            .jk-inquiry-table th,.jk-inquiry-table td { border:1px solid #1f2937; padding:1mm; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .jk-inquiry-table th { height:8mm; background:#e5e7eb; font-size:9px; }.jk-inquiry-table th:nth-child(1){width:16%}.jk-inquiry-table th:nth-child(2){width:8%}.jk-inquiry-table th:nth-child(3){width:32%}.jk-inquiry-table th:nth-child(4){width:12%}.jk-inquiry-table th:nth-child(5){width:16%}.jk-inquiry-table th:nth-child(6){width:16%}
            .jk-inquiry-table tbody tr { height:18mm; }.jk-inquiry-table td.image { padding:.5mm; }.jk-inquiry-table td.image img { width:16mm;height:16mm;object-fit:contain; }.jk-inquiry-table .blank{height:18mm}.jk-inquiry-table .total{height:8mm;font-weight:700;background:#f3f4f6}
            .jk-inquiry-financial { margin-top:2mm; }.jk-inquiry-footer { position:absolute; left:8mm; right:8mm; bottom:8mm; display:grid; grid-template-columns:repeat(3,1fr); gap:2mm; border-top:1px solid #1f2937; padding-top:1.5mm; color:#374151; font-size:9px; font-weight:700; text-align:center; }
        `}</style>
        {chunks.map((chunk, index) => <InquiryPage key={index} document={document} brand={brand} items={chunk} rowStart={index * ROWS_PER_PAGE} isFirstPage={index === 0} logoData={logoData} />)}
    </div>
}

export async function createJumlaKhaleejInquiryPdf(data: JumlaKhaleejInquiryPdfData, brand: InquiryPdfBranding) {
    const [logoData, ...itemImages] = await Promise.all([imageData(brand.logoUrl), ...data.items.map((item) => imageData(item.imageUrl))])
    const items: RenderItem[] = data.items.map((item, index) => ({ ...item, imageData: itemImages[index] || null }))
    const host = window.document.createElement('div')
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:clip;contain:strict;isolation:isolate;pointer-events:none;opacity:0;'
    const container = window.document.createElement('div')
    container.style.cssText = `width:${PAGE_WIDTH_MM}mm;background:#fff;`
    host.appendChild(container)
    window.document.body.appendChild(host)
    const root = createRoot(container)

    try {
        flushSync(() => root.render(<InquiryTemplate document={data} brand={brand} items={items} logoData={logoData} />))
        await new Promise(requestAnimationFrame)
        await window.document.fonts?.ready
        const [{ toCanvas }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')])
        const pages = Array.from(container.querySelectorAll<HTMLElement>('.jk-inquiry-page'))
        const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

        for (const [index, page] of pages.entries()) {
            if (index > 0) pdf.addPage('a4', 'p')
            const canvas = await toCanvas(page, { pixelRatio: RENDER_SCALE, backgroundColor: '#ffffff', style: { opacity: '1' } })
            pdf.addImage(canvas, 'JPEG', 0, 0, PAGE_WIDTH_MM, PAGE_HEIGHT_MM, undefined, 'FAST')
            canvas.width = 1
            canvas.height = 1
        }

        return new Blob([pdf.output('arraybuffer')], { type: 'application/pdf' })
    } finally {
        root.unmount()
        host.remove()
    }
}
