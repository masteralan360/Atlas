import { describe, expect, it } from 'vitest'

import { prepareRemoteMutationPayload } from './syncPayloadContract'

describe('Price Book sync payload', () => {
    it('includes assigned and cleared colors in remote mutations', () => {
        expect(prepareRemoteMutationPayload('price_books', {
            id: 'price-book-1',
            workspaceId: 'workspace-1',
            color: '#12abef',
            syncStatus: 'pending',
            lastSyncedAt: null
        })).toMatchObject({ color: '#12abef' })

        expect(prepareRemoteMutationPayload('price_books', {
            id: 'price-book-1',
            workspaceId: 'workspace-1',
            color: null
        })).toMatchObject({ color: null })
    })
})
