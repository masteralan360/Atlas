import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { IntegrityAuditResult } from '@/lib/integrityAudit/salesOrderAudit'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/ui/components', () => ({}))

import { AuditModelJsonPanel } from './SalesOrderIntegrityAuditDialog'

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
