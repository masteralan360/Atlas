export function installTestBrowser() {
    const rows = new Map<string, string>()
    const storage = {
        get length() { return rows.size },
        getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => rows.set(key, value),
        removeItem: (key: string) => rows.delete(key),
        clear: () => rows.clear(),
        key: (index: number) => Array.from(rows.keys())[index] ?? null
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis.URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' })
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: storage, sessionStorage: storage,
            location: { origin: 'http://localhost', hash: '', pathname: '/' },
            URL: globalThis.URL,
            addEventListener: () => undefined, removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible', dir: 'ltr',
            documentElement: { lang: 'en', dir: 'ltr', style: {} },
            head: { appendChild: () => undefined },
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            createElement: () => ({ appendChild: () => undefined, setAttribute: () => undefined, style: {} }),
            createTextNode: () => ({}), addEventListener: () => undefined, removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    for (const name of ['DOMMatrix', 'ImageData', 'Path2D', 'Element', 'HTMLElement']) {
        Object.defineProperty(globalThis, name, { configurable: true, value: class {} })
    }
}
