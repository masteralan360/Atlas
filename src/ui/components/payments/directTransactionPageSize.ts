export const DIRECT_TRANSACTION_PAGE_SIZES = [10, 20, 50, 100]
export function readDirectTransactionPageSize(key: string) {
  try {
    const size = Number(localStorage.getItem(key))
    return DIRECT_TRANSACTION_PAGE_SIZES.includes(size) ? size : 20
  } catch { return 20 }
}
export function saveDirectTransactionPageSize(key: string, size: number) {
  if (!DIRECT_TRANSACTION_PAGE_SIZES.includes(size)) return
  try { localStorage.setItem(key, String(size)) } catch { /* Preference storage can be unavailable. */ }
}
