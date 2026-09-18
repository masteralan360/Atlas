import type { PosCheckoutInput } from '@/local-db/posCheckout'

export class PosCheckoutPendingError extends Error {
    constructor(public readonly saleId: string) { super('pos_checkout_pending') }
}

/** Retain the frozen sale, financing IDs and rates after an uncertain response. */
export class PosCheckoutAttempt {
    private attempt: { signature: string; input: PosCheckoutInput } | null = null
    get input() { return this.attempt?.input }
    getOrCreate(signature: string, create: () => PosCheckoutInput) {
        if (this.attempt && this.attempt.signature !== signature) throw new PosCheckoutPendingError(this.attempt.input.payload.id)
        this.attempt ??= { signature, input: structuredClone(create()) }
        return this.attempt.input
    }
    clear() { this.attempt = null }
}
