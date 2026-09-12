const ERROR_LOG_DIRECTORY = 'Logs'
export const ERROR_LOG_RETENTION_DAYS = 30

const ERROR_LOG_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/
const MAX_SERIALIZATION_DEPTH = 8
const CONSOLE_ERROR_LOGGER_INSTALLED = Symbol.for('atlas.console-error-logger-installed')

export type ErrorLogSource = 'console' | 'toast'

export type SerializedConsoleValue =
    | null
    | string
    | boolean
    | number
    | {
        type: 'undefined' | 'bigint' | 'symbol' | 'function' | 'number' | 'circular' | 'truncated' | 'accessor'
        value?: string
        name?: string
    }
    | {
        type: 'error'
        name: string
        message: string
        stack?: string
        cause?: SerializedConsoleValue
    }
    | {
        type: 'date'
        value: string
    }
    | {
        type: 'array'
        values: SerializedConsoleValue[]
    }
    | {
        type: 'map'
        entries: Array<[SerializedConsoleValue, SerializedConsoleValue]>
    }
    | {
        type: 'set'
        values: SerializedConsoleValue[]
    }
    | {
        type: 'object'
        constructor?: string
        properties: Record<string, SerializedConsoleValue>
    }

export interface ErrorLogRecord {
    version: 1
    id: string
    timestamp: string
    route: string
    source: ErrorLogSource
    arguments: SerializedConsoleValue[]
    stacks: string[]
    toast?: {
        title?: string
        description?: string
    }
}

export interface CreateErrorLogRecordOptions {
    now?: Date
    route?: string
    source?: ErrorLogSource
    toast?: ErrorLogRecord['toast']
}

export interface ErrorToastLogInput {
    title?: unknown
    description?: unknown
}

type FileSystemApi = typeof import('@tauri-apps/plugin-fs')

let fileSystemPromise: Promise<FileSystemApi> | undefined
let writeQueue: Promise<void> = Promise.resolve()
let cleanupScheduled = false
let consoleErrorLoggerInstalled = false

function isTauriRuntime() {
    return typeof window !== 'undefined'
        && ('__TAURI__' in window || '__TAURI_METADATA__' in window || '__TAURI_INTERNALS__' in window)
}

function loadFileSystem() {
    fileSystemPromise ??= import('@tauri-apps/plugin-fs')
    return fileSystemPromise
}

function getCurrentRoute() {
    if (typeof window === 'undefined') return 'unknown'
    return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function getLogFileName(now: Date) {
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}.jsonl`
}

function createLogId(now: Date) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }

    return `${now.getTime()}-${Math.random().toString(36).slice(2)}`
}

function getConstructorName(value: object) {
    try {
        const constructor = value.constructor
        return typeof constructor?.name === 'string' ? constructor.name : undefined
    } catch {
        return undefined
    }
}

function serializeValue(value: unknown, ancestors: WeakSet<object>, depth: number): SerializedConsoleValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : { type: 'number', value: String(value) }
    }

    if (typeof value === 'undefined') return { type: 'undefined' }
    if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() }
    if (typeof value === 'symbol') return { type: 'symbol', value: value.toString() }
    if (typeof value === 'function') return { type: 'function', name: value.name || undefined }

    if (depth >= MAX_SERIALIZATION_DEPTH) return { type: 'truncated', value: 'maximum depth reached' }
    if (ancestors.has(value)) return { type: 'circular' }

    ancestors.add(value)
    try {
        if (value instanceof Error) {
            const error = value as Error & { cause?: unknown }
            return {
                type: 'error',
                name: error.name || 'Error',
                message: error.message,
                ...(typeof error.stack === 'string' && error.stack ? { stack: error.stack } : {}),
                ...('cause' in error ? { cause: serializeValue(error.cause, ancestors, depth + 1) } : {}),
            }
        }

        if (value instanceof Date) {
            return { type: 'date', value: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() }
        }

        if (Array.isArray(value)) {
            return { type: 'array', values: value.map((item) => serializeValue(item, ancestors, depth + 1)) }
        }

        if (value instanceof Map) {
            return {
                type: 'map',
                entries: Array.from(value.entries(), ([key, item]) => [
                    serializeValue(key, ancestors, depth + 1),
                    serializeValue(item, ancestors, depth + 1),
                ]),
            }
        }

        if (value instanceof Set) {
            return {
                type: 'set',
                values: Array.from(value.values(), (item) => serializeValue(item, ancestors, depth + 1)),
            }
        }

        const properties: Record<string, SerializedConsoleValue> = {}
        for (const key of Reflect.ownKeys(value)) {
            const propertyName = typeof key === 'symbol' ? key.toString() : key
            try {
                const descriptor = Object.getOwnPropertyDescriptor(value, key)
                properties[propertyName] = descriptor && 'value' in descriptor
                    ? serializeValue(descriptor.value, ancestors, depth + 1)
                    : { type: 'accessor' }
            } catch {
                properties[propertyName] = { type: 'accessor' }
            }
        }

        return {
            type: 'object',
            ...(getConstructorName(value) ? { constructor: getConstructorName(value) } : {}),
            properties,
        }
    } finally {
        ancestors.delete(value)
    }
}

function collectStacks(value: SerializedConsoleValue, stacks: string[]) {
    if (value && typeof value === 'object') {
        if (value.type === 'error') {
            if (value.stack) stacks.push(value.stack)
            if (value.cause) collectStacks(value.cause, stacks)
            return
        }

        if (value.type === 'array' || value.type === 'set') {
            value.values.forEach((item) => collectStacks(item, stacks))
            return
        }

        if (value.type === 'map') {
            value.entries.forEach(([key, item]) => {
                collectStacks(key, stacks)
                collectStacks(item, stacks)
            })
            return
        }

        if (value.type === 'object') {
            Object.values(value.properties).forEach((item) => collectStacks(item, stacks))
        }
    }
}

function safelySerializeValue(value: unknown) {
    try {
        return serializeValue(value, new WeakSet(), 0)
    } catch {
        return { type: 'truncated' as const, value: 'value could not be serialized' }
    }
}

export function createErrorLogRecord(argumentsToRecord: unknown[], options: CreateErrorLogRecordOptions = {}): ErrorLogRecord {
    const now = options.now ?? new Date()
    const argumentsSnapshot = argumentsToRecord.map(safelySerializeValue)
    const stacks: string[] = []
    argumentsSnapshot.forEach((value) => collectStacks(value, stacks))

    return {
        version: 1,
        id: createLogId(now),
        timestamp: now.toISOString(),
        route: options.route ?? getCurrentRoute(),
        source: options.source ?? 'console',
        arguments: argumentsSnapshot,
        stacks,
        ...(options.toast ? { toast: options.toast } : {}),
    }
}

function extractToastText(value: unknown, depth = 0): string | undefined {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'bigint') return value.toString()
    if (depth >= 4 || !value || typeof value !== 'object') return undefined

    try {
        if (Array.isArray(value)) {
            const parts = value
                .map((item) => extractToastText(item, depth + 1))
                .filter((part): part is string => Boolean(part))
            return parts.length > 0 ? parts.join(' ') : undefined
        }

        const props = Reflect.get(value, 'props')
        if (props && typeof props === 'object') {
            return extractToastText(Reflect.get(props, 'children'), depth + 1)
        }
    } catch {
        // A toast must still display even if its content cannot be read for logging.
    }

    return undefined
}

export function createToastErrorLogRecord(input: ErrorToastLogInput, options: Omit<CreateErrorLogRecordOptions, 'source' | 'toast'> = {}) {
    const title = extractToastText(input.title)
    const description = extractToastText(input.description)
    const toast = {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
    }

    return createErrorLogRecord([input.title, input.description], {
        ...options,
        source: 'toast',
        ...(Object.keys(toast).length > 0 ? { toast } : {}),
    })
}

export function formatErrorLogRecord(record: ErrorLogRecord) {
    return JSON.stringify(record, null, 2)
}

function parseLogFileDate(fileName: string) {
    const match = ERROR_LOG_FILE_PATTERN.exec(fileName)
    if (!match) return null

    const year = Number(match[1])
    const month = Number(match[2]) - 1
    const day = Number(match[3])
    const date = new Date(year, month, day)
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null
    return date
}

export function isExpiredErrorLogFile(fileName: string, now = new Date()) {
    const fileDate = parseLogFileDate(fileName)
    if (!fileDate) return false

    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ERROR_LOG_RETENTION_DAYS)
    return fileDate < cutoff
}

export async function cleanExpiredErrorLogs(now = new Date()) {
    if (!isTauriRuntime()) return

    try {
        const { BaseDirectory, readDir, remove } = await loadFileSystem()
        const entries = await readDir(ERROR_LOG_DIRECTORY, { baseDir: BaseDirectory.AppData })
        await Promise.all(entries
            .filter((entry) => entry.isFile && isExpiredErrorLogFile(entry.name, now))
            .map((entry) => remove(`${ERROR_LOG_DIRECTORY}/${entry.name}`, { baseDir: BaseDirectory.AppData })))
    } catch {
        // Logging must never create another console error or interrupt the app.
    }
}

async function persistErrorLog(record: ErrorLogRecord) {
    if (!isTauriRuntime()) return

    const { BaseDirectory, mkdir, writeTextFile } = await loadFileSystem()
    await mkdir(ERROR_LOG_DIRECTORY, { baseDir: BaseDirectory.AppData, recursive: true })

    if (!cleanupScheduled) {
        cleanupScheduled = true
        await cleanExpiredErrorLogs()
    }

    await writeTextFile(
        `${ERROR_LOG_DIRECTORY}/${getLogFileName(new Date(record.timestamp))}`,
        `${JSON.stringify(record)}\n`,
        { baseDir: BaseDirectory.AppData, append: true },
    )
}

function queueErrorLog(record: ErrorLogRecord) {
    writeQueue = writeQueue
        .catch(() => undefined)
        .then(() => persistErrorLog(record))
        .catch(() => undefined)
}

export function recordErrorToast(input: ErrorToastLogInput) {
    try {
        queueErrorLog(createToastErrorLogRecord(input))
    } catch {
        // Toast display and error handling must remain independent from persistence.
    }
}

export function installConsoleErrorLogger() {
    if (typeof console === 'undefined' || consoleErrorLoggerInstalled) return

    try {
        const consoleWithFlag = console as Console & { [CONSOLE_ERROR_LOGGER_INSTALLED]?: boolean }
        if (consoleWithFlag[CONSOLE_ERROR_LOGGER_INSTALLED]) {
            consoleErrorLoggerInstalled = true
            return
        }

        const originalConsoleError = console.error
        console.error = (...argumentsToRecord: unknown[]) => {
            try {
                queueErrorLog(createErrorLogRecord(argumentsToRecord))
            } catch {
                // Preserve the original console call even if recording is unavailable.
            }
            originalConsoleError.apply(console, argumentsToRecord)
        }

        consoleErrorLoggerInstalled = true
        try {
            consoleWithFlag[CONSOLE_ERROR_LOGGER_INSTALLED] = true
        } catch {
            // A non-extensible console can still use this module's installation flag.
        }

        if (!cleanupScheduled) {
            cleanupScheduled = true
            void cleanExpiredErrorLogs()
        }
    } catch {
        // Error recording is optional and must never prevent the app from booting.
    }
}

export async function readErrorLogs(): Promise<ErrorLogRecord[]> {
    if (!isTauriRuntime()) return []

    const { BaseDirectory, readDir, readTextFile } = await loadFileSystem()
    let entries: Awaited<ReturnType<typeof readDir>>
    try {
        entries = await readDir(ERROR_LOG_DIRECTORY, { baseDir: BaseDirectory.AppData })
    } catch {
        return []
    }

    const files = entries
        .filter((entry) => entry.isFile && ERROR_LOG_FILE_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort((first, second) => second.localeCompare(first))

    const logFiles = await Promise.all(files.map(async (fileName) => {
        try {
            const contents = await readTextFile(`${ERROR_LOG_DIRECTORY}/${fileName}`, { baseDir: BaseDirectory.AppData })
            return contents.split('\n').flatMap((line) => {
                if (!line.trim()) return []
                try {
                    const record = JSON.parse(line) as Partial<ErrorLogRecord>
                    return record.version === 1 && typeof record.timestamp === 'string' && Array.isArray(record.arguments)
                        ? [{ ...record, source: record.source === 'toast' ? 'toast' : 'console' } as ErrorLogRecord]
                        : []
                } catch {
                    return []
                }
            })
        } catch {
            return []
        }
    }))

    return logFiles.flat().sort((first, second) => second.timestamp.localeCompare(first.timestamp))
}

export async function copyErrorLogRecord(record: ErrorLogRecord) {
    const content = formatErrorLogRecord(record)
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content)
        return true
    }

    if (typeof document === 'undefined') return false
    const textarea = document.createElement('textarea')
    textarea.value = content
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
}

export async function exportErrorLogRecord(record: ErrorLogRecord) {
    const content = formatErrorLogRecord(record)
    const fileName = `atlas-error-${record.timestamp.replace(/[:.]/g, '-')}.json`

    if (isTauriRuntime()) {
        const [{ save }, { writeTextFile }] = await Promise.all([
            import('@tauri-apps/plugin-dialog'),
            loadFileSystem(),
        ])
        const destination = await save({
            defaultPath: fileName,
            filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!destination) return false
        await writeTextFile(destination, content)
        return true
    }

    if (typeof document === 'undefined') return false
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    return true
}

export function isErrorLogStorageAvailable() {
    return isTauriRuntime()
}
