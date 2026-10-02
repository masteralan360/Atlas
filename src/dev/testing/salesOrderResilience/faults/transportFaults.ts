export interface RequestEvidence { method: string; path: string; status?: number; fault?: 'before' | 'lost-response'; body?: unknown }
export class TransportFaults {
    readonly requests: RequestEvidence[] = []
    private armed?: { path: string; kind: 'before' | 'lost-response' }
    arm(path: string, kind: 'before' | 'lost-response') { this.armed = { path, kind } }
    reset() { this.armed = undefined; this.requests.length = 0 }
    readonly fetch: typeof globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
        const method = init.method ?? (input instanceof Request ? input.method : 'GET')
        const write = !['GET', 'HEAD'].includes(method)
        const evidence: RequestEvidence = { path: url.pathname, method }
        if (write && url.pathname.startsWith('/rest/v1/') && typeof init.body === 'string') {
            try { evidence.body = JSON.parse(init.body) } catch { /* No secret headers or auth request bodies are recorded. */ }
        }
        const fault = write && this.armed && url.pathname.includes(this.armed.path) ? this.armed : undefined
        if (fault) { this.armed = undefined; evidence.fault = fault.kind }
        this.requests.push(evidence)
        if (fault?.kind === 'before') throw new TypeError('SORL injected disconnect before request')
        const response = await globalThis.fetch(input, init)
        evidence.status = response.status
        if (fault?.kind === 'lost-response' && response.ok) throw new TypeError('SORL injected response loss after commit')
        return response
    }
}
