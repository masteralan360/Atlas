import type { CartItem, CustomerForm } from '@/components/storefront-ui-types'
import { isTauri } from '@/lib/platform'
import { createFreshStorefrontPdfAssetMode } from '@/lib/storefront-runtime'

type InquirySnapshotRequest = {
  accessToken: string
  orderId: string
}

export type JumlaKhaleejInquirySnapshot = {
  documentNumber: string
  createdAt: string
  mode: 'retail' | 'wholesale'
  customer: CustomerForm & { cityLabel: string }
  items: Array<CartItem & { line_total: number }>
  deliveryFee: number
  deliveryCurrency: string
  store: {
    name: string
    logo_url: string | null
    contacts: Array<{ type: string; value: string; is_primary: boolean }>
  }
}

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MAX_PDF_BYTES = 20 * 1024 * 1024
const ATLAS_WEB_ORIGIN = 'https://atlaserp.dev'

function inquirySnapshotEndpoint(orderId: string) {
  const path = `/api-ecommerce/inquiries/${encodeURIComponent(orderId)}/snapshot`
  const isHostedAtlas = typeof window !== 'undefined' && window.location.origin === ATLAS_WEB_ORIGIN
  return isTauri() || !isHostedAtlas ? `${ATLAS_WEB_ORIGIN}${path}` : path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isCustomer(value: unknown): value is JumlaKhaleejInquirySnapshot['customer'] {
  if (!isRecord(value)) return false
  return ['name', 'phone', 'email', 'city', 'cityLabel', 'address', 'notes']
    .every((key) => typeof value[key] === 'string')
}

function isItem(value: unknown): value is JumlaKhaleejInquirySnapshot['items'][number] {
  if (!isRecord(value)) return false
  return typeof value.product_id === 'string'
    && Boolean(value.product_id)
    && typeof value.name === 'string'
    && Boolean(value.name)
    && (value.image_url === null || typeof value.image_url === 'string')
    && isFiniteNumber(value.price)
    && typeof value.currency === 'string'
    && typeof value.unit === 'string'
    && isFiniteNumber(value.quantity)
    && value.quantity > 0
    && isFiniteNumber(value.line_total)
}

function isContact(value: unknown): value is JumlaKhaleejInquirySnapshot['store']['contacts'][number] {
  return isRecord(value)
    && typeof value.type === 'string'
    && Boolean(value.type)
    && typeof value.value === 'string'
    && Boolean(value.value)
    && typeof value.is_primary === 'boolean'
}

export function isJumlaKhaleejInquirySnapshot(value: unknown): value is JumlaKhaleejInquirySnapshot {
  if (!isRecord(value) || !/^MKT-[0-9]{5,}$/.test(String(value.documentNumber || ''))) return false
  if (typeof value.createdAt !== 'string' || !value.createdAt) return false
  if (value.mode !== 'retail' && value.mode !== 'wholesale') return false
  if (!isCustomer(value.customer)) return false
  if (!Array.isArray(value.items) || value.items.length === 0 || !value.items.every(isItem)) return false
  if (!isFiniteNumber(value.deliveryFee) || typeof value.deliveryCurrency !== 'string') return false
  if (!isRecord(value.store) || typeof value.store.name !== 'string' || !value.store.name) return false
  if (value.store.logo_url !== null && typeof value.store.logo_url !== 'string') return false
  return Array.isArray(value.store.contacts) && value.store.contacts.every(isContact)
}

export async function requestJumlaKhaleejInquirySnapshot({ accessToken, orderId }: InquirySnapshotRequest) {
  const response = await fetch(inquirySnapshotEndpoint(orderId), {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${accessToken}` }
  })

  if (!response.ok) throw new Error(`Unable to load the inquiry snapshot (${response.status})`)
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('The inquiry service returned an unexpected response.')
  }

  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('The inquiry snapshot is too large.')
  }

  const rawSnapshot = await response.text()
  if (!rawSnapshot || new TextEncoder().encode(rawSnapshot).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('The inquiry snapshot is invalid or too large.')
  }

  let snapshot: unknown
  try {
    snapshot = JSON.parse(rawSnapshot)
  } catch {
    throw new Error('The inquiry snapshot is invalid.')
  }
  if (!isJumlaKhaleejInquirySnapshot(snapshot)) throw new Error('The inquiry snapshot is invalid.')
  return snapshot
}

export async function generateJumlaKhaleejInquiryPdf(request: InquirySnapshotRequest) {
  const snapshot = await requestJumlaKhaleejInquirySnapshot(request)
  const { createStorefrontInquiryPdf } = await import('@/lib/storefront-atlas-standard-pdf')
  const generated = await createStorefrontInquiryPdf({
    documentNumber: snapshot.documentNumber,
    createdAt: snapshot.createdAt,
    customer: snapshot.customer,
    customerCityLabel: snapshot.customer.cityLabel,
    items: snapshot.items,
    // This invalidates the vendored renderer's private image cache without
    // changing the source copied from JumlaKhaleej.
    mode: createFreshStorefrontPdfAssetMode(snapshot.mode),
    deliveryFee: snapshot.deliveryFee,
    deliveryCurrency: snapshot.deliveryCurrency,
    store: snapshot.store
  })
  const bytes = new Uint8Array(await generated.blob.arrayBuffer())
  if (!bytes.byteLength || bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error('The generated inquiry PDF is invalid or too large.')
  }
  return { ...generated, bytes, snapshot }
}
