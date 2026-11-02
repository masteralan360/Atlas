import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, Printer, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
} from '@/ui/components'
import {
  AutoScanNativePrintingUnavailableError,
  printService,
  type SystemPrinterInfo,
} from '@/services/printService'
import { savePostalAutoScanPrinter } from './autoScanSettings'

type PrinterLoadError = 'native' | 'load' | 'save' | null

export function AutoScanPrinterDialog({
  open,
  onOpenChange,
  workspaceId,
  selectedPrinterName,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  selectedPrinterName: string | null
  onSaved: (printerName: string) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [printers, setPrinters] = useState<SystemPrinterInfo[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<PrinterLoadError>(null)

  const refreshPrinters = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const available = await printService.listSystemPrinters()
      setPrinters(available)
      setError(null)
    } catch (loadError) {
      setPrinters([])
      setError(loadError instanceof AutoScanNativePrintingUnavailableError ? 'native' : 'load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setSelectedName(selectedPrinterName ?? '')
    void refreshPrinters()
  }, [open, workspaceId, selectedPrinterName, refreshPrinters])

  const selectedIsAvailable = printers.some((printer) => printer.name === selectedName)

  const savePrinter = async () => {
    if (!selectedIsAvailable || saving) return
    setSaving(true)
    setError(null)
    try {
      await savePostalAutoScanPrinter(workspaceId, selectedName)
      await onSaved(selectedName)
    } catch {
      setError('save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (saving && !nextOpen) return
        onOpenChange(nextOpen)
      }}
    >
      <AppDialogContent
        className="max-w-xl"
        showCloseButton={!saving}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault()
        }}
      >
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5 text-primary" />
            {t('postal.autoScan.printerTitle')}
          </AppDialogTitle>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('postal.autoScan.printerDescription')}
          </p>
          <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t('postal.autoScan.scannerHint')}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{t('postal.autoScan.availablePrinters')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void refreshPrinters()}
            >
              {loading ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <RefreshCw className="me-2 h-4 w-4" />}
              {t('postal.autoScan.refreshPrinters')}
            </Button>
          </div>

          {selectedPrinterName && !printers.some((printer) => printer.name === selectedPrinterName) && !loading && (
            <p role="status" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {t('postal.autoScan.savedPrinterUnavailable', { printer: selectedPrinterName })}
            </p>
          )}
          {error === 'native' && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {t('postal.autoScan.nativeUnavailable')}
            </p>
          )}
          {error === 'save' && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {t('postal.autoScan.saveFailed')}
            </p>
          )}
          {error === 'load' && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {t('postal.autoScan.printerListFailed')}
            </p>
          )}

          {loading ? (
            <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : printers.length ? (
            <div className="max-h-64 space-y-2 overflow-y-auto" role="radiogroup" aria-required="true" aria-label={t('postal.autoScan.availablePrinters')}>
              {printers.map((printer) => {
                const selected = selectedName === printer.name
                return (
                  <Button
                    key={printer.name}
                    type="button"
                    variant={selected ? 'default' : 'outline'}
                    className="h-auto w-full justify-between whitespace-normal px-3 py-3 text-start"
                    role="radio"
                    aria-checked={selected}
                    disabled={saving}
                    onClick={() => setSelectedName(printer.name)}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Printer className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 break-words">{printer.name}</span>
                    </span>
                    {selected && <Check className="ms-3 h-4 w-4 shrink-0" />}
                  </Button>
                )
              })}
            </div>
          ) : error !== 'native' ? (
            <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
              {t('postal.autoScan.noPrinters')}
            </p>
          ) : null}
        </AppDialogBody>
        <AppDialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={!selectedIsAvailable || loading || saving} onClick={() => void savePrinter()}>
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {saving ? t('postal.autoScan.savingPrinter') : t('postal.autoScan.savePrinter')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
