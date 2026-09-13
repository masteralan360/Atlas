import { describe, expect, it } from 'vitest'
import type { ErrorLogRecord } from './errorLogger'
import {
    DUPLICATE_LOG_RECORD_LIMIT,
    DUPLICATE_LOG_WINDOW_MS,
    ErrorLogSpamBlocker,
    GLOBAL_LOG_RECORD_LIMIT,
    GLOBAL_LOG_WINDOW_MS,
} from './errorLogSpamBlocker'

function createRecord(argumentsToRecord: ErrorLogRecord['arguments'] = ['Repeated failure'], route = '/sales'): ErrorLogRecord {
    return {
        version: 1,
        id: 'record-id',
        timestamp: '2026-09-14T10:00:00.000Z',
        route,
        source: 'console',
        arguments: argumentsToRecord,
        stacks: [],
    }
}

describe('ErrorLogSpamBlocker', () => {
    it('keeps the first 100 exact repeats in a rolling minute and summarizes suppressed repeats', () => {
        const blocker = new ErrorLogSpamBlocker()
        const record = createRecord()

        for (let index = 0; index < DUPLICATE_LOG_RECORD_LIMIT; index += 1) {
            expect(blocker.evaluate(record, 0).persist).toBe(true)
        }

        expect(blocker.evaluate(record, 1)).toEqual({
            persist: false,
            summaries: [{ kind: 'duplicate', suppressedCount: 1 }],
        })
        expect(blocker.evaluate(record, 2)).toEqual({ persist: false, summaries: [] })

        expect(blocker.evaluate(record, DUPLICATE_LOG_WINDOW_MS + 2)).toEqual({
            persist: true,
            summaries: [{ kind: 'duplicate', suppressedCount: 1 }],
        })
    })

    it('only groups records with the same source, route, and rendered payload', () => {
        const blocker = new ErrorLogSpamBlocker()
        const repeatedRecord = createRecord(['Save failed'], '/sales')

        for (let index = 0; index < DUPLICATE_LOG_RECORD_LIMIT; index += 1) {
            blocker.evaluate(repeatedRecord, 0)
        }

        expect(blocker.evaluate(createRecord(['Save failed'], '/settings'), 1).persist).toBe(true)
        expect(blocker.evaluate(createRecord(['Different failure'], '/sales'), 1).persist).toBe(true)
        expect(blocker.evaluate(repeatedRecord, 1).persist).toBe(false)
    })

    it('applies a global ceiling across otherwise unique records and reopens after five minutes', () => {
        const blocker = new ErrorLogSpamBlocker()

        for (let index = 0; index < GLOBAL_LOG_RECORD_LIMIT; index += 1) {
            expect(blocker.evaluate(createRecord([`Failure ${index}`]), 0).persist).toBe(true)
        }

        expect(blocker.evaluate(createRecord(['Failure after ceiling']), 1)).toEqual({
            persist: false,
            summaries: [{ kind: 'global', suppressedCount: 1 }],
        })
        expect(blocker.evaluate(createRecord(['Failure after ceiling']), 2)).toEqual({
            persist: false,
            summaries: [],
        })
        expect(blocker.evaluate(createRecord(['Recovered']), GLOBAL_LOG_WINDOW_MS + 1).persist).toBe(true)
    })
})
