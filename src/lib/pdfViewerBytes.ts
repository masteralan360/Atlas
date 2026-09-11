import { r2Service } from '@/services/r2Service'

export async function resolvePdfBytes(url: string): Promise<Uint8Array> {
    if (url.startsWith('data:')) {
        const commaIndex = url.indexOf(',')
        if (commaIndex < 0) throw new Error('Invalid PDF data URL.')
        const binary = atob(url.slice(commaIndex + 1))
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        return bytes
    }

    const r2Bytes = await r2Service.downloadFromUrl(url)
    if (r2Bytes !== undefined) return new Uint8Array(r2Bytes)

    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load PDF (${response.status}).`)
    return new Uint8Array(await response.arrayBuffer())
}
