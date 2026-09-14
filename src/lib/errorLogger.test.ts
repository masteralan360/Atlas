import { describe, expect, it } from 'vitest'
import ar from '@/i18n/locales/ar.json'
import en from '@/i18n/locales/en.json'
import ku from '@/i18n/locales/ku.json'
import {
    ERROR_LOG_RETENTION_DAYS,
    createErrorLogRecord,
    createToastErrorLogRecord,
    formatErrorLogRecord,
    isErrorLogRecordingControlAvailable,
    isErrorLogRecordingEnabled,
    isExpiredErrorLogFile,
    setErrorLogRecordingEnabled,
} from './errorLogger'

describe('errorLogger', () => {
    it('records console error arguments, routes, and supplied error stacks', () => {
        const error = new Error('Unable to save')
        error.stack = 'Error: Unable to save\n    at save (app.ts:1:1)'

        const record = createErrorLogRecord(['Save failed', error, { retry: false }], {
            now: new Date('2026-09-12T10:30:00.000Z'),
            route: '/settings?tab=storage',
        })

        expect(record.timestamp).toBe('2026-09-12T10:30:00.000Z')
        expect(record.route).toBe('/settings?tab=storage')
        expect(record.arguments).toHaveLength(3)
        expect(record.stacks).toEqual([error.stack])
        expect(formatErrorLogRecord(record)).toContain('Save failed')
    })

    it('serializes circular values without throwing', () => {
        const circular: { name: string; self?: unknown } = { name: 'cycle' }
        circular.self = circular

        const record = createErrorLogRecord([circular])
        expect(formatErrorLogRecord(record)).toContain('circular')
    })

    it('records destructive toast text as a toast error', () => {
        const record = createToastErrorLogRecord({
            title: 'Unable to save',
            description: 'Try again after reconnecting.',
        }, {
            now: new Date('2026-09-12T10:30:00.000Z'),
            route: '/settings',
        })

        expect(record.source).toBe('toast')
        expect(record.toast).toEqual({
            title: 'Unable to save',
            description: 'Try again after reconnecting.',
        })
        expect(record.arguments).toEqual(['Unable to save', 'Try again after reconnecting.'])
    })

    it('records localized Atlas toast text in English while preserving interpolated values', () => {
        const count = 'عميل خارجي'
        const localizedDescription = ar.subscriptionExpiryWarning.description.replace('{{count}}', count)
        const englishDescription = en.subscriptionExpiryWarning.description.replace('{{count}}', count)
        const record = createToastErrorLogRecord({
            title: ar.common.error,
            description: localizedDescription,
        })

        expect(record.toast).toEqual({
            title: en.common.error,
            description: englishDescription,
        })
        expect(record.arguments).toEqual([en.common.error, englishDescription])

        const KurdishRecord = createToastErrorLogRecord({ title: ku.common.error })
        expect(KurdishRecord.toast).toEqual({ title: en.common.error })
        expect(KurdishRecord.arguments).toEqual([en.common.error, { type: 'undefined' }])

        const consoleRecord = createErrorLogRecord([ku.common.error])
        expect(consoleRecord.arguments).toEqual([en.common.error])
    })

    it('keeps external toast values verbatim', () => {
        const externalDescription = 'قيمة خارجية مخصصة 9f3a701e'
        const record = createToastErrorLogRecord({
            title: ar.common.error,
            description: externalDescription,
        })

        expect(record.toast).toEqual({
            title: en.common.error,
            description: externalDescription,
        })
        expect(record.arguments).toEqual([en.common.error, externalDescription])
    })

    it('keeps console capture safe for values that cannot be inspected', () => {
        const uninspectable = new Proxy({}, {
            ownKeys: () => {
                throw new Error('No inspection')
            },
        })

        const record = createErrorLogRecord([uninspectable])
        expect(formatErrorLogRecord(record)).toContain('value could not be serialized')
    })

    it('keeps the most recent 30 daily log files and expires older files', () => {
        const now = new Date(2026, 8, 12, 15, 0, 0)
        const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ERROR_LOG_RETENTION_DAYS)
        const cutoffFile = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}.jsonl`
        const previousDay = new Date(cutoff)
        previousDay.setDate(previousDay.getDate() - 1)
        const expiredFile = `${previousDay.getFullYear()}-${String(previousDay.getMonth() + 1).padStart(2, '0')}-${String(previousDay.getDate()).padStart(2, '0')}.jsonl`

        expect(isExpiredErrorLogFile(cutoffFile, now)).toBe(false)
        expect(isExpiredErrorLogFile(expiredFile, now)).toBe(true)
        expect(isExpiredErrorLogFile('notes.jsonl', now)).toBe(false)
    })

    it('does not allow log recording to be disabled outside a Tauri development runtime', () => {
        expect(isErrorLogRecordingControlAvailable()).toBe(false)
        expect(setErrorLogRecordingEnabled(false)).toBe(false)
        expect(isErrorLogRecordingEnabled()).toBe(true)
    })
})
