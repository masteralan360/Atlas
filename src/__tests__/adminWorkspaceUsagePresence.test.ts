import { describe, expect, it } from 'vitest'
import { resolveWorkspaceUsageOwnerId } from '../../supabase/functions/admin-console/workspaceUsagePresence'

describe('workspace usage owner for registered user status', () => {
    it('uses the workspace itself when it is not a branch', () => {
        expect(resolveWorkspaceUsageOwnerId('source', new Map())).toBe('source')
    })

    it('uses the source usage row for direct and nested branches', () => {
        const sources = new Map([
            ['branch', 'source'],
            ['nested', 'branch']
        ])
        expect(resolveWorkspaceUsageOwnerId('branch', sources)).toBe('source')
        expect(resolveWorkspaceUsageOwnerId('nested', sources)).toBe('source')
    })

    it('stops at a cycle instead of looping', () => {
        const sources = new Map([
            ['branch-a', 'branch-b'],
            ['branch-b', 'branch-a']
        ])
        expect(resolveWorkspaceUsageOwnerId('branch-a', sources)).toBe('branch-b')
    })
})
