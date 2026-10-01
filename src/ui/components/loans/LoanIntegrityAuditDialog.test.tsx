import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LoanIntegrityAuditResult } from '@/lib/integrityAudit/loanAudit'

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
      workspaceId="workspace-1" loanId="loan-1" mode="local" />)
    expect(dialog).toContain('transactionAudit.title')
    expect(dialog).toContain('transactionAudit.close')
  })
})
