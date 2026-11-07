import { describe, expect, it } from 'vitest'
import type { Beauty3Client } from '@/local-db/models'
import {
  beauty3ClientSelectionReducer,
  initialBeauty3ClientSelectionState,
} from './beauty3ClientSelection'

const client: Beauty3Client = {
  id: 'client-1',
  workspaceId: 'workspace-1',
  name: 'Ava Client',
  age: 31,
  maritalStatus: 'single',
  address: 'Slemani',
  phoneNumber: '07700000000',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  version: 1,
  isDeleted: false,
  syncStatus: 'synced',
  lastSyncedAt: '2026-10-01T10:00:00.000Z',
}

describe('Beauty Center 3 client selection', () => {
  it('keeps the selected client while options are loading or fail to refresh', () => {
    const selected = beauty3ClientSelectionReducer(initialBeauty3ClientSelectionState, {
      type: 'select',
      client,
    })
    const loading = beauty3ClientSelectionReducer(selected, { type: 'options-loading' })
    const failed = beauty3ClientSelectionReducer(loading, { type: 'options-error' })

    expect(loading.selectedClient).toEqual(client)
    expect(failed.selectedClient).toEqual(client)
    expect(failed.optionsStatus).toBe('error')
  })

  it('refreshes the selected profile without clearing its selection', () => {
    const selected = beauty3ClientSelectionReducer(initialBeauty3ClientSelectionState, {
      type: 'select',
      client,
    })
    const refreshedClient = { ...client, phoneNumber: '07701112233', updatedAt: '2026-11-01T10:00:00.000Z' }
    const refreshed = beauty3ClientSelectionReducer(selected, {
      type: 'options-loaded',
      clients: [refreshedClient],
    })

    expect(refreshed.selectedClient).toEqual(refreshedClient)
    expect(refreshed.selectedUnavailable).toBe(false)
  })

  it('retains a missing selection and marks it unavailable until the user changes or clears it', () => {
    const selected = beauty3ClientSelectionReducer(initialBeauty3ClientSelectionState, {
      type: 'select',
      client,
    })
    const refreshed = beauty3ClientSelectionReducer(selected, {
      type: 'options-loaded',
      clients: [],
    })
    const changed = beauty3ClientSelectionReducer(refreshed, { type: 'input', value: 'Ava C' })
    const selectedAgain = beauty3ClientSelectionReducer(changed, { type: 'select', client })
    const cleared = beauty3ClientSelectionReducer(selectedAgain, { type: 'clear' })

    expect(refreshed.selectedClient).toEqual(client)
    expect(refreshed.selectedUnavailable).toBe(true)
    expect(changed.selectedClient).toBeNull()
    expect(changed.selectedUnavailable).toBe(false)
    expect(cleared.search).toBe('')
    expect(cleared.selectedClient).toBeNull()
  })

  it('clears an existing selection when switching the visit to a new client', () => {
    const selected = beauty3ClientSelectionReducer(initialBeauty3ClientSelectionState, {
      type: 'select',
      client,
    })
    const newClient = beauty3ClientSelectionReducer(selected, {
      type: 'create-new',
      search: '',
    })

    expect(newClient.selectedClient).toBeNull()
    expect(newClient.search).toBe('')
  })
})
