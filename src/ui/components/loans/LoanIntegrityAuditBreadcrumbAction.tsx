import { ClipboardCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/components'

export function LoanIntegrityAuditBreadcrumbAction({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  const label = t('transactionAudit.run')

  return <Button
    type="button"
    variant="ghost"
    size="icon"
    allowViewer
    className="h-6 w-6 shrink-0 rounded-md p-0 text-muted-foreground hover:text-foreground"
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    <ClipboardCheck className="!h-3.5 !w-3.5" aria-hidden="true" />
  </Button>
}
