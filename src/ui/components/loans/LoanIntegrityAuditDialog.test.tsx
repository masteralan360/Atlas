import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LoanIntegrityAuditResult } from '@/lib/integrityAudit/loanAudit'
import { getTransactionIntegritySeverity } from '@/lib/integrityAudit/severity'
import { scheduleTransactionIntegrityAudit, type TransactionIntegrityAuditScheduler } from '@/ui/components/integrity-audit/useDeferredTransactionIntegrityAudit'

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})
vi.mock('@/ui/components', async () => {
  const React = await import('react')
  const Wrapper = ({ children }: React.PropsWithChildren) => React.createElement('div', null, children)
  return {
    Button: ({ children, size: _size, variant: _variant, allowViewer: _allowViewer, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      size?: string; variant?: string; allowViewer?: boolean
    }) => React.createElement('button', props, children),
    AppDialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? React.createElement('div', null, children) : null,
    AppDialogBody: Wrapper,
    AppDialogContent: Wrapper,
    AppDialogFooter: Wrapper,
    AppDialogHeader: Wrapper,
    AppDialogTitle: Wrapper
  }
})

import { AuditModelJsonPanel } from '@/ui/components/integrity-audit/AuditModelJsonPanel'
import { LoanIntegrityAuditDialog } from './LoanIntegrityAuditDialog'
import { LoanIntegrityAuditBreadcrumbAction } from './LoanIntegrityAuditBreadcrumbAction'

describe('Loan Transaction Integrity Audit UI', () => {
  it('matches the Sales Order audit breadcrumb button style and accessible label', () => {
    const html = renderToStaticMarkup(<LoanIntegrityAuditBreadcrumbAction onClick={() => undefined} />)
    expect(html).toContain('aria-label="transactionAudit.run"')
    expect(html).toContain('title="transactionAudit.run"')
    expect(html).toContain('h-6 w-6')
    expect(html).toContain('!h-3.5 !w-3.5')
    expect(html).toContain('<svg')
    expect(html).not.toContain('>transactionAudit.run</button>')

    const running = renderToStaticMarkup(<LoanIntegrityAuditBreadcrumbAction onClick={() => undefined} phase="running" />)
    expect(running).toContain('transactionAudit.iconStatus.running')
    expect(running).toContain('text-amber-600')
    expect(running).toContain('motion-safe:animate-pulse')
    const failed = renderToStaticMarkup(<LoanIntegrityAuditBreadcrumbAction onClick={() => undefined} phase="failed" />)
    expect(failed).toContain('text-destructive')

    expect(getTransactionIntegritySeverity({ passed: 199, warnings: 1, failed: 0 })).toBe('warning')
    expect(getTransactionIntegritySeverity({ passed: 199, warnings: 1, failed: 1 })).toBe('failed')
    expect(getTransactionIntegritySeverity({ passed: 200, warnings: 0, failed: 0 })).toBe('passed')

    let idleCallback: (() => void) | undefined
    let wasCancelled = false
    const scheduler: TransactionIntegrityAuditScheduler = {
      requestIdleCallback: callback => { idleCallback = callback; return 1 },
      cancelIdleCallback: () => { wasCancelled = true },
      setTimeout: () => 2,
      clearTimeout: () => undefined
    }
    let didRun = false
    const cancelScheduledAudit = scheduleTransactionIntegrityAudit(() => { didRun = true }, scheduler)
    expect(didRun).toBe(false)
    idleCallback?.()
    expect(didRun).toBe(true)
    cancelScheduledAudit()
    expect(wasCancelled).toBe(true)
  })

  it('renders a structured dialog and an inspectable loan snapshot', () => {
    const result: LoanIntegrityAuditResult = {
      transactionType: 'loan', transactionId: 'loan-1', transactionNumber: 'LN-00001', workspaceId: 'workspace-1',
      auditedAt: '2026-10-01T00:00:00.000Z', sourceOfTruth: 'sqlite', integrityStatus: 'PASS', mirrorStatus: null,
      checks: [], summary: { total: 0, passed: 0, warnings: 0, failed: 0 }, expected: { balanceAmount: 80 },
      actual: { loan: { id: 'loan-1', status: 'active', settlementCurrency: 'usd' } } as any, mirrorActual: null
    }
    const json = renderToStaticMarkup(<AuditModelJsonPanel result={result} />)
    expect(json).toContain('loan-1')
    expect(json).toContain('balanceAmount')

    const dialog = renderToStaticMarkup(<LoanIntegrityAuditDialog open onOpenChange={() => undefined}
      loanId="loan-1" result={result} errorKey={null} loading={false} />)
    expect(dialog).toContain('transactionAudit.title')
    expect(dialog).toContain('transactionAudit.close')
    expect(dialog).toContain('transactionAudit.summary')
  })
})
