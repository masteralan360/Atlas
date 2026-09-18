import { vi } from 'vitest'

// All V1 tests use disposable IndexedDB and explicit request mocks. A missed
// mock must fail closed rather than contacting any developer backend.
vi.stubGlobal('fetch', async () => { throw new Error('Live network access is disabled in the developer test runner') })
