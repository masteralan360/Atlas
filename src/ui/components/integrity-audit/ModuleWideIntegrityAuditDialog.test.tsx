import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ModuleWideIntegrityAuditAdapter } from '@/lib/integrityAudit/moduleWide'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.count === 'number' ? `${key} ${options.count}` : key
  })
}))
vi.mock('@/lib/utils', () => ({ cn: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' ') }))
vi.mock('@/ui/components', async () => {
  const React = await import('react')
  const Shell = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children)
  return {
    AppDialog: Shell,
    AppDialogBody: Shell,
    AppDialogContent: Shell,
    AppDialogFooter: Shell,
    AppDialogHeader: Shell,
    AppDialogTitle: Shell,
    Button: ({ children, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement('button', { disabled }, children)
  }
})

import { ModuleWideIntegrityAuditDialog, ModuleWideIntegrityAuditResults } from './ModuleWideIntegrityAuditDialog'

describe('ModuleWideIntegrityAuditDialog', () => {
  it('opens with a Start Audit action and does not show audit details before the user starts', () => {
    const auditTransaction = vi.fn(async () => ({ summary: { passed: 1, warnings: 0, failed: 0 } }))
    const adapter: ModuleWideIntegrityAuditAdapter<{ id: string; reference: string }, { summary: { passed: number; warnings: number; failed: number } }> = {
      getTransactionId: transaction => transaction.id,
      getTransactionReference: transaction => transaction.reference,
      auditTransaction,
      getSummary: result => result.summary
    }

    const html = renderToStaticMarkup(
      <ModuleWideIntegrityAuditDialog
        open
        onOpenChange={() => undefined}
        transactions={[{ id: 'order-1', reference: 'SO-2026-0001' }]}
        adapter={adapter}
        transactionLabel="Sales Orders"
      />
    )

    expect(html).toContain('moduleWideIntegrityAudit.title')
    expect(html).toContain('moduleWideIntegrityAudit.start')
    expect(html).not.toContain('SO-2026-0001')
    expect(html).not.toContain('<details')
    expect(auditTransaction).not.toHaveBeenCalled()
  })

  it('renders one compact summary row per transaction with severity styling and no expanded details', () => {
    const html = renderToStaticMarkup(
      <ModuleWideIntegrityAuditResults rows={[
        { transactionId: 'order-1', transactionReference: 'SO-2026-0001', passed: 200, warnings: 0, failed: 0, status: 'PASS' },
        { transactionId: 'order-2', transactionReference: 'SO-2026-0002', passed: 199, warnings: 1, failed: 0, status: 'WARNING' },
        { transactionId: 'order-3', transactionReference: 'SO-2026-0003', passed: 197, warnings: 2, failed: 1, status: 'FAIL' }
      ]} />
    )

    expect(html.match(/role="listitem"/g)).toHaveLength(3)
    expect(html).toContain('SO-2026-0001')
    expect(html).toContain('moduleWideIntegrityAudit.counts.passed 200')
    expect(html).toContain('moduleWideIntegrityAudit.counts.warnings 1')
    expect(html).toContain('moduleWideIntegrityAudit.counts.failed 1')
    expect(html).toContain('bg-emerald-500/5')
    expect(html).toContain('bg-amber-500/5')
    expect(html).toContain('bg-destructive/5')
    expect(html).not.toContain('<details')
    expect(html).not.toContain('order-1')
  })
})
