import 'fake-indexeddb/auto'
import { installTestBrowser } from '../../src/dev/testing/fixtures/browser'

// Production transport modules inspect browser state during module evaluation.
// Initialize the minimal environment before importing any scenario handlers.
installTestBrowser()
Object.assign(window, { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
