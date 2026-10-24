import { describe, it, expect } from 'vitest'
import { resolveWorkspacePermission } from '@/permissions/resolveWorkspacePermission'
import type { WorkspacePermissionKey } from '@/permissions/workspacePermissionDefinitions'
import { getPlanCapabilities } from '@/plans/workspacePlans'
describe('Post Service access', () => {
  it('remains admin-grant only on every workspace plan', () => {
    for (const plan of ['basic', 'business', 'enterprise'])
      expect(getPlanCapabilities(plan).modules).not.toContain('postal_service')
  })
  it('does not inherit permissive plan or global permission fallbacks', () => {
    const keys = new Set<WorkspacePermissionKey>()
    expect(
      resolveWorkspacePermission('staff', false, keys, 'postService.merchant'),
    ).toBe(false)
    expect(
      resolveWorkspacePermission(
        'staff',
        false,
        keys,
        'postService.officeEmployee',
      ),
    ).toBe(false)
    expect(
      resolveWorkspacePermission('viewer', false, keys, 'postService.merchant'),
    ).toBe(false)
    keys.add('postService.merchant')
    expect(
      resolveWorkspacePermission('staff', false, keys, 'postService.merchant'),
    ).toBe(true)
    expect(
      resolveWorkspacePermission(
        'staff',
        true,
        keys,
        'postService.officeEmployee',
      ),
    ).toBe(false)
    expect(
      resolveWorkspacePermission('viewer', true, keys, 'postService.merchant'),
    ).toBe(false)
    expect(
      resolveWorkspacePermission(
        'admin',
        false,
        keys,
        'postService.officeEmployee',
      ),
    ).toBe(true)
  })
})
