import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { completeWorkspaceDataHydration, startWorkspaceDataHydration } from '@/workspace/workspaceDataFreshness'
import { ModulePageFreshness } from './ModulePageFreshness'

vi.mock('@/auth', () => ({ useAuth: () => ({ user: { workspaceId: 'dashboard-cash-spinner-test' } }) }))
vi.mock('@/workspace', () => ({ useWorkspace: () => ({ features: { data_mode: 'cloud' } }) }))

describe('ModulePageFreshness loading icon', () => {
    const workspaceId = 'dashboard-cash-spinner-test'
    const tableNames = ['sales', 'payment_transactions', 'loans'] as const
    const renderIcon = () => renderToStaticMarkup(createElement(ModulePageFreshness, { tableNames, loadingIconOnly: true }))

    it('shows only a spinner for active scoped hydration and hides it afterward', () => {
        expect(renderIcon()).toBe('')

        startWorkspaceDataHydration(workspaceId, 'supabase', 'exchange_transactions')
        expect(renderIcon()).toBe('')

        startWorkspaceDataHydration(workspaceId, 'supabase', 'payment_transactions')
        const loadingMarkup = renderIcon()
        expect(loadingMarkup).toContain('animate-spin')
        expect(loadingMarkup).toContain('aria-label="Checking for updates')
        expect(loadingMarkup).toMatch(/<\/svg><\/span>$/)

        completeWorkspaceDataHydration(workspaceId, 'supabase', 'payment_transactions')
        expect(renderIcon()).toBe('')
        completeWorkspaceDataHydration(workspaceId, 'supabase', 'exchange_transactions')
    })
})
