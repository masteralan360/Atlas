import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { queryClient } from '@/query/queryClient'
import { db } from './database'
import type { Loan } from './models'

describe('source-transaction summary invalidation', () => {
  beforeAll(() => installTestBrowser())
  beforeEach(async () => {
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({workspaceId:'workspace',dataMode:'cloud'})
  })
  afterAll(async () => { await db.delete() })
  const loan = (id: string) => ({id,workspaceId:'workspace',version:1,isDeleted:false} as Loan)

  it('coalesces source rows and waits for a successful transaction commit', async () => {
    const invalidate = vi.spyOn(queryClient,'invalidateQueries')
    try {
      await db.transaction('rw',db.loans,async () => {
        await db.loans.bulkPut([loan('one'),loan('two')])
        expect(invalidate).not.toHaveBeenCalled()
      })
      await Promise.resolve()
      expect(invalidate).toHaveBeenCalledExactlyOnceWith({queryKey:['atlas','workspace','workspace','business-partners']})
      invalidate.mockClear()
      await expect(db.transaction('rw',db.loans,async () => {
        await db.loans.put(loan('rolled-back'))
        throw new Error('Rollback')
      })).rejects.toThrow('Rollback')
      await Promise.resolve()
      expect(invalidate).not.toHaveBeenCalled()
      expect(await db.loans.get('rolled-back')).toBeUndefined()
    } finally { invalidate.mockRestore() }
  })

  it('leaves Local-mode summaries on the existing local calculation path', async () => {
    writeWorkspaceModeSnapshot({workspaceId:'workspace',dataMode:'local'})
    const invalidate = vi.spyOn(queryClient,'invalidateQueries')
    try {
      await db.loans.put(loan('local'))
      await Promise.resolve()
      expect(invalidate).not.toHaveBeenCalled()
    } finally { invalidate.mockRestore() }
  })
})
