type InquiryPdfRequest = {
  accessToken: string
  orderId: string
}

const MAX_PDF_BYTES = 20 * 1024 * 1024
const ATLAS_WEB_ORIGIN = 'https://atlaserp.dev'

function inquiryPdfEndpoint(orderId: string) {
  const path = `/api-ecommerce/inquiries/${encodeURIComponent(orderId)}/pdf`
  // The desktop shell (and a local Vite session) serves the app itself from a
  // different origin. A relative request there resolves to the app shell and
  // can return HTML with a successful status instead of the PDF stream.
  const isHostedAtlas = typeof window !== 'undefined' && window.location.origin === ATLAS_WEB_ORIGIN
  return isTauri() || !isHostedAtlas ? `${ATLAS_WEB_ORIGIN}${path}` : path
}

/**
 * The authenticated Atlas Worker streams the PDF. The browser never receives
 * a Files URL, signature, or credential for the private Files renderer.
 */
export async function requestJumlaKhaleejInquiryPdf({ accessToken, orderId }: InquiryPdfRequest) {
  const response = await fetch(inquiryPdfEndpoint(orderId), {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${accessToken}` }
  })

  if (!response.ok) throw new Error(`Unable to load the inquiry document (${response.status})`)
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')) {
    throw new Error('The inquiry service returned an unexpected response.')
  }

  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    throw new Error('The inquiry document is too large to display.')
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.byteLength || bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error('The inquiry document is invalid or too large to display.')
  }
  return bytes
}
import { isTauri } from '@/lib/platform'
