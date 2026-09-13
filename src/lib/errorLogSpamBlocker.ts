import type { ErrorLogRecord } from './errorLogger'

export const DUPLICATE_LOG_WINDOW_MS = 60_000
export const DUPLICATE_LOG_RECORD_LIMIT = 100
export const GLOBAL_LOG_WINDOW_MS = 5 * 60_000
export const GLOBAL_LOG_RECORD_LIMIT = 2_000
export const LOG_SPAM_SUMMARY_INTERVAL_MS = 60_000
export const MAX_TRACKED_LOG_SIGNATURES = 2_000

export interface ErrorLogSpamSummary {
    kind: 'duplicate' | 'global'
    suppressedCount: number
}

export interface ErrorLogSpamDecision {
    persist: boolean
    summaries: ErrorLogSpamSummary[]
}

interface SignatureState {
    acceptedTimestamps: number[]
    lastSeenAt: number
    lastSummaryAt?: number
    suppressedSinceSummary: number
}

function createRecordSignature(record: ErrorLogRecord) {
    return JSON.stringify({
        source: record.source,
        route: record.route,
        arguments: record.arguments,
        stacks: record.stacks,
        toast: record.toast,
    })
}

function discardExpiredTimestamps(timestamps: number[], now: number, windowMs: number) {
    const cutoff = now - windowMs
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift()
    }
}

/**
 * Keeps log persistence bounded while retaining enough repeated records to diagnose an issue.
 * It is intentionally in-memory only: restarting the app starts a fresh observation window.
 */
export class ErrorLogSpamBlocker {
    private readonly persistedTimestamps: number[] = []
    private readonly signatures = new Map<string, SignatureState>()
    private globalLastSummaryAt?: number
    private globalSuppressedSinceSummary = 0

    evaluate(record: ErrorLogRecord, now = Date.now()): ErrorLogSpamDecision {
        discardExpiredTimestamps(this.persistedTimestamps, now, GLOBAL_LOG_WINDOW_MS)

        if (this.persistedTimestamps.length >= GLOBAL_LOG_RECORD_LIMIT) {
            return this.suppressGlobally(now)
        }

        const signature = createRecordSignature(record)
        const state = this.getSignatureState(signature, now)
        discardExpiredTimestamps(state.acceptedTimestamps, now, DUPLICATE_LOG_WINDOW_MS)
        state.lastSeenAt = now

        const pendingSummary = this.createPendingDuplicateSummary(state, now)
        const summaries = pendingSummary ? [pendingSummary] : []
        if (state.acceptedTimestamps.length >= DUPLICATE_LOG_RECORD_LIMIT) {
            state.suppressedSinceSummary += 1
            const summary = this.createPendingDuplicateSummary(state, now)
            if (summary) summaries.push(summary)
            return { persist: false, summaries }
        }

        state.acceptedTimestamps.push(now)
        this.persistedTimestamps.push(now)
        return { persist: true, summaries }
    }

    private suppressGlobally(now: number): ErrorLogSpamDecision {
        this.globalSuppressedSinceSummary += 1
        if (
            this.globalLastSummaryAt === undefined
            || now - this.globalLastSummaryAt >= LOG_SPAM_SUMMARY_INTERVAL_MS
        ) {
            const summary: ErrorLogSpamSummary = {
                kind: 'global',
                suppressedCount: this.globalSuppressedSinceSummary,
            }
            this.globalSuppressedSinceSummary = 0
            this.globalLastSummaryAt = now
            return { persist: false, summaries: [summary] }
        }

        return { persist: false, summaries: [] }
    }

    private createPendingDuplicateSummary(state: SignatureState, now: number) {
        if (
            state.suppressedSinceSummary === 0
            || (state.lastSummaryAt !== undefined && now - state.lastSummaryAt < LOG_SPAM_SUMMARY_INTERVAL_MS)
        ) {
            return undefined
        }

        const summary: ErrorLogSpamSummary = {
            kind: 'duplicate',
            suppressedCount: state.suppressedSinceSummary,
        }
        state.suppressedSinceSummary = 0
        state.lastSummaryAt = now
        return summary
    }

    private getSignatureState(signature: string, now: number) {
        const existing = this.signatures.get(signature)
        if (existing) return existing

        this.removeStaleSignatures(now)
        if (this.signatures.size >= MAX_TRACKED_LOG_SIGNATURES) {
            this.removeLeastRecentSignature()
        }

        const state: SignatureState = {
            acceptedTimestamps: [],
            lastSeenAt: now,
            suppressedSinceSummary: 0,
        }
        this.signatures.set(signature, state)
        return state
    }

    private removeStaleSignatures(now: number) {
        const cutoff = now - DUPLICATE_LOG_WINDOW_MS
        for (const [signature, state] of this.signatures) {
            if (state.lastSeenAt <= cutoff) this.signatures.delete(signature)
        }
    }

    private removeLeastRecentSignature() {
        let leastRecentSignature: string | undefined
        let leastRecentTime = Number.POSITIVE_INFINITY

        for (const [signature, state] of this.signatures) {
            if (state.lastSeenAt < leastRecentTime) {
                leastRecentSignature = signature
                leastRecentTime = state.lastSeenAt
            }
        }

        if (leastRecentSignature) this.signatures.delete(leastRecentSignature)
    }
}
