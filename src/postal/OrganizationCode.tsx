import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import { Button, useToast } from '@/ui/components'
import { formatPostalOrganizationCode } from './domain'

export function OrganizationCode({ code }: { code: string }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)
  const formattedCode = formatPostalOrganizationCode(code)

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(formattedCode)
      setCopied(true)
      toast({
        title: t('common.success'),
        description: t('postal.organizationCodeCopied'),
      })
    } catch {
      setCopied(false)
      toast({
        title: t('common.error'),
        description: t('postal.organizationCodeCopyFailed'),
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">
          {t('postal.organizationCode')}
        </p>
        <p className="mt-1 break-all font-mono text-base" dir="ltr">
          {formattedCode}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void copyCode()}
      >
        {copied ? (
          <Check className="me-2 h-4 w-4" />
        ) : (
          <Copy className="me-2 h-4 w-4" />
        )}
        {copied
          ? t('postal.organizationCodeCopied')
          : t('postal.copyOrganizationCode')}
      </Button>
    </div>
  )
}
