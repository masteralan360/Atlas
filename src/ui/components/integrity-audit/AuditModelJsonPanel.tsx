import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Braces } from 'lucide-react'
import { buildIntegrityAuditModel } from '@/lib/integrityAudit/auditModel'
import type { IntegrityAuditResult } from '@/lib/integrityAudit/types'

export function AuditModelJsonPanel({ result }: { result: IntegrityAuditResult }) {
  const { t } = useTranslation()
  const auditModelJson = useMemo(() => JSON.stringify(buildIntegrityAuditModel(result), null, 2), [result])
  return <details className="min-w-0 overflow-hidden rounded-lg border p-3">
    <summary className="flex cursor-pointer items-center gap-2 font-medium"><Braces className="h-4 w-4" />{t('transactionAudit.auditModelJson')}</summary>
    <p className="mt-2 text-xs text-muted-foreground">{t('transactionAudit.auditModelDescription')}</p>
    <pre aria-label={t('transactionAudit.auditModelJson')} className="mt-3 max-h-[28rem] max-w-full overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-5 select-text">{auditModelJson}</pre>
  </details>
}
