'use client'

import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

import type { CartItem, CustomerForm } from '@/components/storefront-ui-types'
import { getJumlaKhaleejDeliveryCity } from '@/lib/storefront-delivery'
import { storefrontApiUrl } from '@/lib/storefront-runtime'
import './storefront-atlas-standard-pdf.css'

type StorefrontPrintStore = {
  name: string
  logo_url: string | null
  contacts: Array<{ type: string; value: string; is_primary: boolean }>
}

type PrintInput = {
  customer: CustomerForm
  items: CartItem[]
  mode: 'retail' | 'wholesale'
  store: StorefrontPrintStore
  /** Immutable delivery values are supplied when rendering an existing order. */
  deliveryFee?: number
  deliveryCurrency?: string
  customerCityLabel?: string
  createdAt?: string
}

const PAGE_WIDTH_MM = 210
const PAGE_HEIGHT_MM = 297
const RENDER_SCALE = 2.5
const TABLE_DATA_AREA_MM = 145
const PDF_IMAGE_CACHE_LIMIT = 96
const PDF_IMAGE_INLINE_CONCURRENCY = 6
const PDF_IMAGE_WARMUP_CONCURRENCY = 3

type InquiryPdfImageAsset = {
  cacheKey: string
  mode: PrintInput['mode']
  productId?: string
  storeLogo?: boolean
}

const inquiryPdfImageCache = new Map<string, Promise<string | null>>()

// This is deliberately the supplied, frozen `orders.AtlasStandard` layout for
// V1 storefront inquiries. It is not persisted and it does not depend on an
// Atlas order record.
const ATLAS_STANDARD_LAYOUT = {
  page: { widthMm: 210, heightMm: 297 },
  label: 'وەسڵی فڕۆشتن',
  version: 1,
  updatedAt: '2026-08-09T14:17:23.375Z',
  moduleTypeKey: 'orders.AtlasStandard',
  nativeTemplateKey: 'orders.AtlasStandard',
  printLanguage: 'ku',
  fields: { hideUnit: 'false', showNotes: 'false', hideDueDate: 'false', hideNextDue: 'false', hideDiscount: 'false', tableRowCount: '10' },
  images: [],
  shapes: [],
  texts: [
    { x: 72.64808095494308, y: 7.303630757229554, id: 'xsq58ogzs', text: 'لبيع مواد كوزمتيك بالجملة', color: '#000000', width: 57.98220465695479, fontSize: 16, rotation: 0 },
    { x: 14.174189035072654, y: 2.8938927452822334, id: 'j8jtek824', text: '0771 450 4323', color: '#000000', width: 84, fontSize: 16, rotation: 0 },
    { x: 3.414287245750817, y: 10.963713335918598, id: 've07n55bx', text: 'كركوك - رحيماوا قرب اسماك دلشاد', color: '#000000', width: 74.959918567247, fontSize: 16, rotation: 0 }
  ],
  componentPositions: {
    atlasStandardWorkspaceLogo: { x: -35.45, y: 5.29, scale: 1 },
    atlasStandardWorkspaceName: { x: -84.64, y: -9.79, scale: 1 }
  },
  hiddenFields: {
    'atlasStandard.table.expiry': true,
    'atlasStandard.table.batchNumber': true,
    'atlasStandard.table.freeQuantity': true,
    'atlasStandard.invoiceDetails.salesPerson': true,
    'atlasStandard.invoiceDetails.status': true,
    'atlasStandard.financialSummary.paidAmount': true,
    'atlasStandard.financialSummary.currentBalance': true,
    'atlasStandard.financialSummary.printedBy': true
  },
  fieldOrders: {
    'atlasStandard.financialSummary': [
      'atlasStandard.financialSummary.outstanding',
      'atlasStandard.financialSummary.deliveryFee',
      'atlasStandard.financialSummary.orderTotalWithDeliveryFee',
      'atlasStandard.financialSummary.amountInWords',
      'atlasStandard.financialSummary.currentBalance',
      'atlasStandard.financialSummary.paymentMethod',
      'atlasStandard.financialSummary.notes'
    ]
  },
  annotations: [
    { type: 'pen', color: '#000000', points: [{ x: 126.16537363536949, y: 60.52449888641426 }], brushSize: 2 },
    { type: 'pen', color: '#000000', points: [{ x: 125.50389120599652, y: 60.52449888641426 }], brushSize: 2 },
    { type: 'pen', color: '#000000', points: [{ x: 125.50389120599652, y: 60.52449888641426 }], brushSize: 2 },
    { type: 'pen', color: '#000000', points: [{ x: 125.50389120599652, y: 60.52449888641426 }], brushSize: 2 }
  ],
  fieldDisplayModes: { 'atlasStandard.table.productImage.width': '18' },
  fieldLabelOverrides: {
    'atlasStandard.table.price': 'نرخ',
    'atlasStandard.table.total': 'کۆی گشتی داواکاری',
    'atlasStandard.table.number': 'رقم',
    'atlasStandard.table.product': 'ناوی کاڵا',
    'atlasStandard.table.quantity': 'بڕ',
    'atlasStandard.table.productImage': 'صورة',
    'atlasStandard.invoiceDetails.time': 'کات',
    'atlasStandard.invoiceDetails.number': 'تەلەفۆن',
    'atlasStandard.financialSummary.notes': 'تێبینی',
    'atlasStandard.invoiceDetails.invoice': 'پسوڵە',
    'atlasStandard.invoiceDetails.partner': 'کڕیار',
    'atlasStandard.invoiceDetails.city': 'شار',
    'atlasStandard.invoiceDetails.location': 'ناونیشانی کڕیار',
    'atlasStandard.invoiceDetails.invoiceDate': 'بەرواری پسوڵە',
    'atlasStandard.financialSummary.outstanding': 'کۆی گشتی داواکاری',
    'atlasStandard.financialSummary.deliveryFee': 'کرێی گەیاندن',
    'atlasStandard.financialSummary.orderTotalWithDeliveryFee': 'کۆی گشتی داواکاری لەگەڵ کرێی گەیاندن',
    'atlasStandard.invoiceDetails.documentNumber': 'ژمارەی بەڵگە',
    'atlasStandard.financialSummary.amountInWords': 'بڕ بە نووسین',
    'atlasStandard.financialSummary.paymentMethod': 'شێوازی پارەدان'
  }
} as const

const PRODUCT_IMAGE_COLUMN_WIDTH = Number(ATLAS_STANDARD_LAYOUT.fieldDisplayModes['atlasStandard.table.productImage.width']) || 9
const PRODUCT_IMAGE_SIZE_MM = Math.min(22, Math.max(7, Number((7 + (PRODUCT_IMAGE_COLUMN_WIDTH - 6) * 1.1).toFixed(1))))
const TABLE_ITEM_ROW_MM = Math.max(8, PRODUCT_IMAGE_SIZE_MM + 1)

const ATLAS_STANDARD_LABELS = {
  price: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.table.price'],
  total: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.table.total'],
  number: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.table.number'],
  product: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.table.product'],
  quantity: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.table.quantity'],
  productImage: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.table.productImage'],
  time: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.invoiceDetails.time'],
  phone: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.invoiceDetails.number'],
  salesPerson: 'کاشێر',
  status: 'دۆخ',
  notes: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.financialSummary.notes'],
  invoice: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.invoiceDetails.invoice'],
  partner: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.invoiceDetails.partner'],
  city: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.invoiceDetails.city'],
  location: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.invoiceDetails.location'],
  paidAmount: 'بڕی دراو',
  printedBy: 'چاپکراوە لەلایەن',
  invoiceDate: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.invoiceDetails.invoiceDate'],
  outstanding: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.financialSummary.outstanding'],
  deliveryFee: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.financialSummary.deliveryFee'],
  orderTotalWithDeliveryFee: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.financialSummary.orderTotalWithDeliveryFee'],
  documentNumber: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.invoiceDetails.documentNumber'],
  amountInWords: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.financialSummary.amountInWords'],
  paymentMethod: ATLAS_STANDARD_LAYOUT.fieldLabelOverrides['atlasStandard.financialSummary.paymentMethod']
} as const

const PRINT_UNIT_LABELS = {
  en: { pcs: 'pcs', kg: 'kg', gram: 'gram', liter: 'liter', bottle: 'bottle', can: 'can', box: 'box', pack: 'pack', carton: 'carton', bag: 'bag', 'm²': 'm²', Kg: 'Kg', Meter: 'Meter', ton: 'ton', activity: 'activity' },
  ar: { pcs: 'عدد', kg: 'كجم', gram: 'غرام', liter: 'لتر', bottle: 'بطل', can: 'دبة', box: 'صندوق', pack: 'باكيت', carton: 'كرتون', bag: 'كيس', 'm²': 'م²', Kg: 'كجم', Meter: 'متر', ton: 'طن', activity: 'فعالية' },
  ku: { pcs: 'دانە', kg: 'کیلۆگرام', gram: 'گرام', liter: 'لیتر', bottle: 'بوتڵ', can: 'قووطی', box: 'سندووق', pack: 'پاکەت', carton: 'کارتۆن', bag: 'کیس', 'm²': 'م²', Kg: 'Kg', Meter: 'مەتر', ton: 'تۆن', activity: 'چالاکی' }
} as const

function localizedPrintUnit(unit: string | null | undefined, language = ATLAS_STANDARD_LAYOUT.printLanguage) {
  const code = unit?.trim() || ''
  const labels = PRINT_UNIT_LABELS[language as keyof typeof PRINT_UNIT_LABELS]
  return labels?.[code as keyof typeof labels] || code
}

function atlasMoney(value: number, currency: string) {
  const amount = Number.isFinite(value) ? value : 0
  if (currency.toLowerCase() === 'iqd') {
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(amount)} IQD`
  }
  if (currency.toLowerCase() === 'eur') {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 }).format(amount)
  }
  if (currency.toLowerCase() === 'try') {
    return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 4 }).format(amount)
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(amount)
}

function numberToKurdishWords(value: number) {
  const wholeValue = Math.floor(Math.abs(Number(value) || 0))
  if (wholeValue === 0) return 'سفر'

  const underTwenty = ['', 'یەک', 'دوو', 'سێ', 'چوار', 'پێنج', 'شەش', 'حەوت', 'هەشت', 'نۆ', 'دە', 'یازدە', 'دوازدە', 'سێزدە', 'چواردە', 'پانزە', 'شانزە', 'حەڤدە', 'هەژدە', 'نۆزدە']
  const tens = ['', '', 'بیست', 'سی', 'چل', 'پەنجا', 'شەست', 'حەفتا', 'هەشتا', 'نەوەت']
  const hundreds = ['', 'سەد', 'دووسەد', 'سێسەد', 'چوارسەد', 'پێنجسەد', 'شەشسەد', 'حەوتسەد', 'هەشتسەد', 'نۆسەد']
  const scales = ['', 'هەزار', 'ملیۆن', 'ملیار', 'تریلیۆن']
  const underThousand = (amount: number) => {
    const parts: string[] = []
    if (amount >= 100) {
      parts.push(hundreds[Math.floor(amount / 100)])
      amount %= 100
    }
    if (amount >= 20) {
      const ones = amount % 10
      parts.push(ones > 0 ? `${tens[Math.floor(amount / 10)]} و ${underTwenty[ones]}` : tens[Math.floor(amount / 10)])
    } else if (amount > 0) {
      parts.push(underTwenty[amount])
    }
    return parts.join(' و ')
  }

  const parts: string[] = []
  let remaining = wholeValue
  let scale = 0
  while (remaining > 0 && scale < scales.length) {
    const chunk = remaining % 1000
    if (chunk > 0) {
      const words = underThousand(chunk)
      parts.unshift(scale === 0 ? words : `${words} ${scales[scale]}`)
    }
    remaining = Math.floor(remaining / 1000)
    scale += 1
  }
  return parts.join(' و ')
}

function formatDateTime(value: Date) {
  const date = new Intl.DateTimeFormat('ku-Arab-IQ', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value).replace(/-/g, '/')
  const time = new Intl.DateTimeFormat('ku-Arab-IQ', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
  return { date, time }
}

function contactValue(contacts: StorefrontPrintStore['contacts'], type: string) {
  return contacts.filter((contact) => contact.type === type).map((contact) => contact.value.trim()).filter(Boolean)
}

const RTL_LETTER_PATTERN = /[\u05d0-\u05ea\u0620-\u064a\u066e-\u06ef\u06fa-\u06ff\u0750-\u077f\u0870-\u0887\u0889-\u088f\u08a0-\u08c9\ufb1d-\ufb4f\ufb50-\ufdff\ufe70-\ufefc]/
const LETTER_PATTERN = /\p{L}/u

function resolveIsolatedTextDirection(text: string): 'ltr' | 'rtl' {
  for (const character of text) {
    if (RTL_LETTER_PATTERN.test(character)) return 'rtl'
    if (LETTER_PATTERN.test(character)) return 'ltr'
  }
  return 'ltr'
}

type PrintField = {
  key: string
  label: string
  value: string
  span: 1 | 2 | 3 | 4
  showLabel?: boolean
  multiline?: boolean
}

function orderFieldsForAtlasLayout(fields: PrintField[], fieldOrder?: readonly string[]) {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]))
  const usedKeys = new Set<string>()
  const orderedKeys = (fieldOrder || [])
    .filter((key) => fieldsByKey.has(key) && !usedKeys.has(key))
    .filter((key) => {
      usedKeys.add(key)
      return true
    })

  fields.forEach((field) => {
    if (!usedKeys.has(field.key)) orderedKeys.push(field.key)
  })

  let layoutRow = 0
  let usedColumns = 0
  return orderedKeys.map((key) => {
    const field = fieldsByKey.get(key)!
    const slot = field
    if (usedColumns + slot.span > 4) {
      layoutRow += 1
      usedColumns = 0
    }
    const fieldLayoutRow = layoutRow
    usedColumns += slot.span
    if (usedColumns === 4) {
      layoutRow += 1
      usedColumns = 0
    }
    return { ...field, layoutRow: fieldLayoutRow }
  })
}

function AtlasFieldsSection({ fields, fieldOrder, className }: { fields: PrintField[]; fieldOrder?: readonly string[]; className?: string }) {
  const visibleFields = orderFieldsForAtlasLayout(fields, fieldOrder)
    .filter((field) => !ATLAS_STANDARD_LAYOUT.hiddenFields[field.key as keyof typeof ATLAS_STANDARD_LAYOUT.hiddenFields])
  const rows = visibleFields.reduce<Array<Array<typeof visibleFields[number]>>>((currentRows, field) => {
    const row = currentRows[field.layoutRow] || []
    row.push(field)
    currentRows[field.layoutRow] = row
    return currentRows
  }, [])

  return (
    <section className={`storefront-atlas-details ${className || ''}`}>
      {rows.filter(Boolean).map((row, rowIndex) => {
        const baseSpan = Math.floor(4 / row.length)
        const remainingColumns = 4 % row.length
        return <div className="storefront-atlas-field-row" key={rowIndex}>{row.map((field, index) => {
          const span = baseSpan + (index < remainingColumns ? 1 : 0)
          return <div className={`storefront-atlas-field${field.multiline ? ' is-multiline' : ''}`} style={{ gridColumn: `span ${span} / span ${span}` }} key={field.key}>{field.showLabel === false ? (field.value || '-') : <><strong>{field.label} : </strong>{field.value || '-'}</>}</div>
        })}</div>
      })}
    </section>
  )
}

function ProductImage({ item }: { item: CartItem }) {
  const fallback = fallbackImageDataUrl(item.name.slice(0, 1).toUpperCase())
  return item.image_url
    ? <img className="storefront-atlas-product-image" src={fallback} data-inquiry-product-id={item.product_id} data-inquiry-image-url={item.image_url} data-inquiry-fallback={item.name.slice(0, 1).toUpperCase()} alt="" />
    : <span className="storefront-atlas-product-image placeholder">{item.name.slice(0, 1).toUpperCase()}</span>
}

function cartQuantityUnit(items: CartItem[]) {
  const units = Array.from(new Set(items.map((item) => item.unit?.trim()).filter((unit): unit is string => Boolean(unit))))
  return units.length === 1 ? localizedPrintUnit(units[0]) : ''
}

function AtlasItemsTable({
  items,
  rowStart,
  allItems,
  total,
  currency
}: {
  items: CartItem[]
  rowStart: number
  allItems: CartItem[]
  total: number
  currency: string
}) {
  const emptyHeight = Math.max(0, TABLE_DATA_AREA_MM - (items.length * TABLE_ITEM_ROW_MM))
  const totalQuantity = allItems.reduce((sum, item) => sum + item.quantity, 0)
  const totalUnit = cartQuantityUnit(allItems)

  return (
    <table className="storefront-atlas-table">
      <colgroup><col style={{ width: `${PRODUCT_IMAGE_COLUMN_WIDTH}%` }} /><col style={{ width: '6%' }} /><col style={{ width: '32%' }} /><col style={{ width: '12%' }} /><col style={{ width: '16%' }} /><col style={{ width: '16%' }} /></colgroup>
      <thead><tr><th>{ATLAS_STANDARD_LABELS.productImage}</th><th>{ATLAS_STANDARD_LABELS.number}</th><th>{ATLAS_STANDARD_LABELS.product}</th><th>{ATLAS_STANDARD_LABELS.quantity}</th><th>{ATLAS_STANDARD_LABELS.price}</th><th>{ATLAS_STANDARD_LABELS.total}</th></tr></thead>
      <tbody>
        {items.map((item, index) => <tr className="item" key={`${item.product_id}-${rowStart + index}`}><td className="image"><ProductImage item={item} /></td><td>{rowStart + index + 1}</td><td>{item.name || '\u00a0'}</td><td>{item.quantity}{item.unit ? ` ${localizedPrintUnit(item.unit)}` : ''}</td><td>{atlasMoney(item.price, item.currency)}</td><td>{atlasMoney(item.price * item.quantity, item.currency)}</td></tr>)}
        {emptyHeight > 0 && <tr className="empty"><td style={{ height: `${emptyHeight}mm` }}>{'\u00a0'}</td><td>{'\u00a0'}</td><td>{'\u00a0'}</td><td>{'\u00a0'}</td><td>{'\u00a0'}</td><td>{'\u00a0'}</td></tr>}
        <tr className="total"><td>{'\u00a0'}</td><td>{'\u00a0'}</td><td>{'\u00a0'}</td><td>{totalQuantity}{totalUnit ? ` ${totalUnit}` : ''}</td><td>{'\u00a0'}</td><td>{atlasMoney(total, currency)}</td></tr>
      </tbody>
    </table>
  )
}

function StorefrontAtlasStandardTemplate({ input, createdAt, documentNumber }: { input: PrintInput; createdAt: Date; documentNumber: string }) {
  const total = input.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const deliveryCity = getJumlaKhaleejDeliveryCity(input.customer.city)
  const deliveryFee = Number.isFinite(input.deliveryFee) ? Number(input.deliveryFee) : deliveryCity?.fee ?? 0
  // Display-only PDF value. The marketplace order total remains product-only.
  const orderTotalWithDeliveryFee = total + deliveryFee
  const currency = input.items[0]?.currency || 'iqd'
  const dateTime = formatDateTime(createdAt)
  const footerAddress = contactValue(input.store.contacts, 'address')
  const footerPhone = contactValue(input.store.contacts, 'phone')
  const footerEmail = contactValue(input.store.contacts, 'email')
  const maxRowsPerTable = Math.max(1, Math.floor(TABLE_DATA_AREA_MM / TABLE_ITEM_ROW_MM))
  const itemChunks: CartItem[][] = []
  if (input.items.length === 0) itemChunks.push([])
  for (let index = 0; index < input.items.length; index += maxRowsPerTable) itemChunks.push(input.items.slice(index, index + maxRowsPerTable))
  const label = ATLAS_STANDARD_LABELS
  const namePosition = ATLAS_STANDARD_LAYOUT.componentPositions.atlasStandardWorkspaceName
  const logoPosition = ATLAS_STANDARD_LAYOUT.componentPositions.atlasStandardWorkspaceLogo
  const invoiceDetailFields: PrintField[] = [
    { key: 'atlasStandard.invoiceDetails.partner', label: label.partner, value: input.customer.name, span: 2 },
    { key: 'atlasStandard.invoiceDetails.invoice', label: label.invoice, value: 'داواکاری فرۆشتن', span: 1 },
    { key: 'atlasStandard.invoiceDetails.number', label: label.phone, value: input.customer.phone, span: 1 },
    { key: 'atlasStandard.invoiceDetails.location', label: label.location, value: input.customer.address, span: 2 },
    { key: 'atlasStandard.invoiceDetails.city', label: label.city, value: input.customerCityLabel?.trim() || deliveryCity?.names.ku || '-', span: 2 },
    { key: 'atlasStandard.invoiceDetails.salesPerson', label: label.salesPerson, value: '-', span: 2 },
    { key: 'atlasStandard.invoiceDetails.status', label: label.status, value: 'ڕەشنووس', span: 1 },
    { key: 'atlasStandard.invoiceDetails.documentNumber', label: label.documentNumber, value: documentNumber, span: 2 },
    { key: 'atlasStandard.invoiceDetails.invoiceDate', label: label.invoiceDate, value: dateTime.date, span: 1 },
    { key: 'atlasStandard.invoiceDetails.time', label: label.time, value: dateTime.time, span: 1 }
  ]
  const financialFields: PrintField[] = [
    { key: 'atlasStandard.financialSummary.paidAmount', label: label.paidAmount, value: atlasMoney(0, currency), span: 4 },
    { key: 'atlasStandard.financialSummary.outstanding', label: label.outstanding, value: atlasMoney(total, currency), span: 2 },
    { key: 'atlasStandard.financialSummary.deliveryFee', label: label.deliveryFee, value: atlasMoney(deliveryFee, input.deliveryCurrency || 'iqd'), span: 2 },
    { key: 'atlasStandard.financialSummary.orderTotalWithDeliveryFee', label: label.orderTotalWithDeliveryFee, value: atlasMoney(orderTotalWithDeliveryFee, input.deliveryCurrency || 'iqd'), span: 4 },
    { key: 'atlasStandard.financialSummary.currentBalance', label: 'باڵانسی ئێستای هاوبەش', value: '-', span: 4 },
    { key: 'atlasStandard.financialSummary.paymentMethod', label: label.paymentMethod, value: '-', span: 2 },
    { key: 'atlasStandard.financialSummary.amountInWords', label: label.amountInWords, value: numberToKurdishWords(total), span: 2, showLabel: false },
    { key: 'atlasStandard.financialSummary.printedBy', label: label.printedBy, value: '-', span: 2 },
    { key: 'atlasStandard.financialSummary.notes', label: label.notes, value: input.customer.notes, span: 4, multiline: true }
  ]

  return (
    <div className="storefront-atlas-standard" dir="rtl">

      <section className="storefront-atlas-page">
        <header>
          <div className="storefront-atlas-component" style={{ transform: `translate(${namePosition.x}mm, ${namePosition.y}mm) scale(${namePosition.scale})` }}>
            <h1 dir={resolveIsolatedTextDirection(input.store.name || 'Atlas')}>{input.store.name || 'Atlas'}</h1>
          </div>
          <div className="storefront-atlas-component" style={{ transform: `translate(${logoPosition.x}mm, ${logoPosition.y}mm) scale(${logoPosition.scale})` }}>
            <div className="storefront-atlas-logo">{input.store.logo_url ? <img src={fallbackImageDataUrl('LOGO')} data-inquiry-store-logo="true" data-inquiry-fallback="LOGO" alt="" /> : 'LOGO'}</div>
          </div>
        </header>

        <AtlasFieldsSection fields={invoiceDetailFields} />

        <AtlasItemsTable items={itemChunks[0]} rowStart={0} allItems={input.items} total={total} currency={currency} />

        <AtlasFieldsSection fields={financialFields} fieldOrder={ATLAS_STANDARD_LAYOUT.fieldOrders['atlasStandard.financialSummary']} className="storefront-atlas-financial" />

        <div className="storefront-atlas-footer-copy">
          <div>{footerEmail.length ? `Email: ${footerEmail.join(' - ')}` : ''}</div>
          <div>{footerAddress.length ? <div>{footerAddress.join(' - ')}</div> : null}{footerPhone.length ? <div>{footerPhone.join(' - ')}</div> : null}</div>
        </div>
        <footer className="storefront-atlas-footer"><span>دروستکراوە لەلایەن AtlasERP</span><span>لاپەڕە 1 لە 1</span><span>بەرواری چاپ: {dateTime.date}</span></footer>

        <div className="storefront-atlas-overlay" aria-hidden="true">
          {ATLAS_STANDARD_LAYOUT.texts.map((text, index) => <div key={text.id} dir={resolveIsolatedTextDirection(text.text)} className="storefront-atlas-overlay-text" style={{ left: `${(text.x / PAGE_WIDTH_MM) * 100}%`, top: `${text.y}mm`, width: `${(text.width / PAGE_WIDTH_MM) * 100}%`, color: text.color, fontSize: `${text.fontSize}px`, transform: `rotate(${text.rotation}deg)`, zIndex: 100 + index }}>{text.text}</div>)}
          <svg viewBox={`0 0 ${PAGE_WIDTH_MM} ${PAGE_HEIGHT_MM}`} preserveAspectRatio="none" width="100%" height="100%">
            {ATLAS_STANDARD_LAYOUT.annotations.map((annotation, index) => <path key={index} d={`M ${annotation.points.map((point) => `${point.x},${point.y}`).join(' L ')}`} fill="none" stroke={annotation.color} strokeWidth={annotation.brushSize} strokeLinecap="round" strokeLinejoin="round" opacity={(annotation.type as string) === 'brush' ? .5 : 1} />)}
          </svg>
        </div>
      </section>

      {itemChunks.slice(1).map((chunk, index) => <section className="storefront-atlas-page storefront-atlas-continuation-page" key={`items-page-${index + 2}`}><AtlasItemsTable items={chunk} rowStart={(index + 1) * maxRowsPerTable} allItems={input.items} total={total} currency={currency} /></section>)}
    </div>
  )
}

async function waitForImages(container: HTMLElement) {
  await Promise.all(Array.from(container.querySelectorAll('img')).map(async (image) => {
    if (!image.complete) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(settle, 10_000)
        function settle() {
          window.clearTimeout(timeout)
          resolve()
        }
        image.addEventListener('load', settle, { once: true })
        image.addEventListener('error', settle, { once: true })
      })
    }
    if (image.naturalWidth > 0 && typeof image.decode === 'function') await image.decode().catch(() => undefined)
  }))
}

function fallbackImageDataUrl(label: string) {
  const safeLabel = label.replace(/[<>&]/g, '').slice(0, 2) || '?'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#f3f4f6"/><text x="80" y="93" text-anchor="middle" fill="#6b7280" font-family="Arial, sans-serif" font-size="54" font-weight="700">${safeLabel}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

async function imageBlobToPdfDataUrl(blob: Blob) {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const source = new Image()
    source.decoding = 'async'
    source.src = objectUrl
    await source.decode()

    const longestSide = Math.max(source.naturalWidth, source.naturalHeight, 1)
    const scale = Math.min(1, 180 / longestSide)
    const width = Math.max(1, Math.round(source.naturalWidth * scale))
    const height = Math.max(1, Math.round(source.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Unable to prepare inquiry image.')

    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(source, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.82)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function storedImageDataUrl(url: string) {
  // A live inquiry is a bearer URL. Product image requests must not forward
  // that signed URL to an asset host through a Referer header.
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!response.ok) return null
  const blob = await response.blob()
  if (!blob.type.startsWith('image/')) return null
  return await imageBlobToPdfDataUrl(blob)
}

async function forEachWithConcurrency<T>(items: T[], limit: number, callback: (item: T) => Promise<void>) {
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await callback(item)
    }
  }))
}

function productImageAsset(mode: PrintInput['mode'], productId: string): InquiryPdfImageAsset {
  return { cacheKey: `${mode}:product:${productId}`, mode, productId }
}

function storeLogoImageAsset(mode: PrintInput['mode']): InquiryPdfImageAsset {
  return { cacheKey: `${mode}:store-logo`, mode, storeLogo: true }
}

function cacheInquiryPdfImage(asset: InquiryPdfImageAsset) {
  const existing = inquiryPdfImageCache.get(asset.cacheKey)
  if (existing) return existing

  const query = new URLSearchParams({ mode: asset.mode })
  if (asset.productId) query.set('productId', asset.productId)
  else if (asset.storeLogo) query.set('storeLogo', '1')

  const imageData = fetch(storefrontApiUrl(`/api/inquiries/product-image?${query.toString()}`))
    .then(async (response) => {
      if (!response.ok) return null
      const blob = await response.blob()
      if (!blob.type.startsWith('image/')) return null
      return await imageBlobToPdfDataUrl(blob)
    })
    .catch(() => null)
    .then((dataUrl) => {
      if (!dataUrl) inquiryPdfImageCache.delete(asset.cacheKey)
      return dataUrl
    })

  inquiryPdfImageCache.set(asset.cacheKey, imageData)
  while (inquiryPdfImageCache.size > PDF_IMAGE_CACHE_LIMIT) {
    const oldestKey = inquiryPdfImageCache.keys().next().value
    if (!oldestKey) break
    inquiryPdfImageCache.delete(oldestKey)
  }
  return imageData
}

export async function warmStorefrontInquiryPdfAssets({
  items,
  mode,
  includeStoreLogo = false
}: {
  items: Pick<CartItem, 'product_id'>[]
  mode: PrintInput['mode']
  includeStoreLogo?: boolean
}) {
  const assetsByKey = new Map<string, InquiryPdfImageAsset>()
  items.forEach((item) => {
    assetsByKey.set(item.product_id, productImageAsset(mode, item.product_id))
  })
  if (includeStoreLogo) assetsByKey.set('store-logo', storeLogoImageAsset(mode))
  const assets = Array.from(assetsByKey.values())
  await forEachWithConcurrency(assets, PDF_IMAGE_WARMUP_CONCURRENCY, async (asset) => {
    await cacheInquiryPdfImage(asset)
  })
}

async function inlineImages(
  container: HTMLElement,
  mode: PrintInput['mode'],
  onProgress?: (completed: number, total: number) => void
) {
  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img'))
  let completed = 0

  if (images.length === 0) onProgress?.(0, 0)

  await forEachWithConcurrency(images, PDF_IMAGE_INLINE_CONCURRENCY, async (image) => {
    const productId = image.dataset.inquiryProductId
    const isStoreLogo = image.dataset.inquiryStoreLogo === 'true'
    const storedImageUrl = image.dataset.inquiryImageUrl
    const fallback = fallbackImageDataUrl(image.dataset.inquiryFallback || '?')
    const asset = productId
      ? productImageAsset(mode, productId)
      : isStoreLogo ? storeLogoImageAsset(mode) : null

    const storedImage = storedImageUrl ? await storedImageDataUrl(storedImageUrl).catch(() => null) : null
    image.src = storedImage || (asset ? (await cacheInquiryPdfImage(asset)) || fallback : fallback)
    completed += 1
    onProgress?.(completed, images.length)
  })

  await waitForImages(container)
}

type A4KeepTogetherBlock = { topMm: number; bottomMm: number }

function collectA4KeepTogetherBlocks(container: HTMLElement) {
  const rect = container.getBoundingClientRect()
  if (rect.width <= 0) return [] as A4KeepTogetherBlock[]
  const pxToMm = PAGE_WIDTH_MM / rect.width
  const candidates = new Set([
    ...container.querySelectorAll<HTMLElement>('[data-pdf-keep-together], table, tr, .break-inside-avoid, .page-break-inside-avoid')
  ])

  return Array.from(candidates).flatMap((element) => {
    const bounds = element.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return []
    const topMm = (bounds.top - rect.top) * pxToMm
    const bottomMm = (bounds.bottom - rect.top) * pxToMm
    return Number.isFinite(topMm) && Number.isFinite(bottomMm) ? [{ topMm, bottomMm }] : []
  })
}

function getA4PageStarts(contentHeightMm: number, blocks: readonly A4KeepTogetherBlock[]) {
  const epsilon = 0.01
  if (!Number.isFinite(contentHeightMm) || contentHeightMm <= 0) return [0]
  const keepTogetherBlocks = blocks.filter((block) => {
    const height = block.bottomMm - block.topMm
    return Number.isFinite(block.topMm) && Number.isFinite(block.bottomMm) && height > epsilon && height <= PAGE_HEIGHT_MM + epsilon
  })
  const pageStarts = [0]
  let pageStartMm = 0

  while (pageStartMm + PAGE_HEIGHT_MM < contentHeightMm - epsilon) {
    const naturalPageEndMm = pageStartMm + PAGE_HEIGHT_MM
    const crossingBlocks = keepTogetherBlocks.filter((block) => block.topMm > pageStartMm + epsilon && block.topMm < naturalPageEndMm - epsilon && block.bottomMm > naturalPageEndMm + epsilon)
    const nextPageStartMm = crossingBlocks.length > 0
      ? Math.min(...crossingBlocks.map((block) => block.topMm))
      : naturalPageEndMm
    pageStartMm = nextPageStartMm > pageStartMm + epsilon ? nextPageStartMm : naturalPageEndMm
    pageStarts.push(pageStartMm)
  }

  return pageStarts
}

function sliceCanvas(source: HTMLCanvasElement, sourceHeightMm: number, startMm: number, endMm: number) {
  const top = Math.max(0, Math.floor((startMm / sourceHeightMm) * source.height))
  const bottom = Math.min(source.height, Math.ceil((endMm / sourceHeightMm) * source.height))
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = Math.max(1, bottom - top)
  canvas.getContext('2d')?.drawImage(source, 0, top, source.width, canvas.height, 0, 0, source.width, canvas.height)
  return canvas
}

export async function createStorefrontInquiryPdf(input: PrintInput & {
  documentNumber: string
  onProgress?: (value: number) => void
}) {
  const reportProgress = (value: number) => input.onProgress?.(Math.max(0, Math.min(100, value)))
  const parsedCreatedAt = input.createdAt ? new Date(input.createdAt) : null
  const now = parsedCreatedAt && Number.isFinite(parsedCreatedAt.getTime()) ? parsedCreatedAt : new Date()
  const documentNumber = input.documentNumber
  const renderDependencies = Promise.all([import('html-to-image'), import('jspdf')])
  // Keep the A4 render tree out of the document's scrollable area. Rendering it
  // directly in <body> can make a narrow, RTL mobile page horizontally overflow
  // while html-to-image is capturing the PDF.
  const renderHost = document.createElement('div')
  renderHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:clip;contain:strict;isolation:isolate;pointer-events:none;opacity:0;'
  const container = document.createElement('div')
  container.style.cssText = `width:${PAGE_WIDTH_MM}mm;background:#fff;pointer-events:none;`
  renderHost.appendChild(container)
  document.body.appendChild(renderHost)
  const root = createRoot(container)

  try {
    reportProgress(2)
    flushSync(() => {
      root.render(<StorefrontAtlasStandardTemplate input={input} createdAt={now} documentNumber={documentNumber} />)
    })
    await new Promise(requestAnimationFrame)
    await document.fonts?.ready
    reportProgress(8)
    await inlineImages(container, input.mode, (completed, total) => {
      reportProgress(total === 0 ? 46 : 8 + (completed / total) * 38)
    })

    const [{ toCanvas }, { jsPDF }] = await renderDependencies
    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })
    const pageElements = Array.from(container.querySelectorAll<HTMLElement>('.storefront-atlas-page'))
    let outputPageCount = 0

    for (const [pageElementIndex, pageElement] of pageElements.entries()) {
      reportProgress(50 + (pageElementIndex / Math.max(pageElements.length, 1)) * 40)
      const canvas = await toCanvas(pageElement, { pixelRatio: RENDER_SCALE, backgroundColor: '#ffffff', style: { opacity: '1' } })
      const renderedHeightMm = (canvas.height * (PAGE_WIDTH_MM / pageElement.offsetWidth)) / RENDER_SCALE
      const pageStarts = getA4PageStarts(renderedHeightMm, collectA4KeepTogetherBlocks(pageElement))

      for (let page = 0; page < pageStarts.length; page += 1) {
        if (outputPageCount > 0) pdf.addPage('a4', 'p')
        const start = pageStarts[page]
        const end = pageStarts[page + 1] || renderedHeightMm
        pdf.addImage(sliceCanvas(canvas, renderedHeightMm, start, end), 'JPEG', 0, 0, PAGE_WIDTH_MM, end - start, undefined, 'FAST')
        outputPageCount += 1
      }

      canvas.width = 1
      canvas.height = 1
      reportProgress(50 + ((pageElementIndex + 1) / Math.max(pageElements.length, 1)) * 40)
    }

    reportProgress(96)
    const blob = pdf.output('blob')
    reportProgress(100)
    return {
      documentNumber,
      filename: `${documentNumber}.pdf`,
      blob
    }
  } finally {
    root.unmount()
    renderHost.remove()
  }
}
