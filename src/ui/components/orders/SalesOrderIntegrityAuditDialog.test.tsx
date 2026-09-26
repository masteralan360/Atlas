import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { IntegrityAuditResult } from '@/lib/integrityAudit/salesOrderAudit'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/ui/components', async () => {
  const React = await import('react')
  return {
    Button: ({ children, size: _size, variant: _variant, allowViewer: _allowViewer, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      size?: string; variant?: string; allowViewer?: boolean
    }) => React.createElement('button', props, children)
  }
})

import { AuditModelJsonPanel } from './SalesOrderIntegrityAuditDialog'
import { SalesOrderAuditBreadcrumbAction } from './SalesOrderAuditBreadcrumbAction'

describe('Sales Order integrity audit JSON view', () => {
  it('renders a scrollable, selectable JSON snapshot for the audited transaction', () => {
    const result: IntegrityAuditResult = {
      transactionType: 'sales_order', transactionId: 'order-1', transactionNumber: '00001', workspaceId: 'workspace-1',
      auditedAt: '2026-09-26T00:00:00.000Z', sourceOfTruth: 'supabase', integrityStatus: 'PASS', mirrorStatus: null,
      checks: [], summary: { total: 0, passed: 0, warnings: 0, failed: 0 },
      expected: { orderTotal: 60 }, actual: { order: { id: 'order-1', status: 'completed', currency: 'usd' } } as any,
      mirrorActual: null
    }
    const html = renderToStaticMarkup(<AuditModelJsonPanel result={result} />)
    expect(html).toContain('transactionAudit.auditModelJson')
    expect(html).toContain('<pre')
    expect(html).toContain('overflow-auto')
    expect(html).toContain('select-text')
    expect(html).toContain('schemaVersion')
    expect(html).toContain('order-1')
    expect(html).toContain('orderTotal')
  })
})

describe('Sales Order audit breadcrumb action', () => {
  it('has a compact icon and an accessible name without visible button text', () => {
    const html = renderToStaticMarkup(<SalesOrderAuditBreadcrumbAction onClick={() => undefined} />)
    expect(html).toContain('aria-label="transactionAudit.run"')
    expect(html).toContain('title="transactionAudit.run"')
    expect(html).toContain('h-6 w-6')
    expect(html).toContain('!h-3.5 !w-3.5')
    expect(html).toContain('<svg')
    expect(html).not.toContain('>transactionAudit.run</button>')
  })
})
