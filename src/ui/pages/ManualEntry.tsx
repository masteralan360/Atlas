import { createElement, useCallback, useEffect, useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FileText, Loader2, Printer, Save } from 'lucide-react'
import { useAuth } from '@/auth'
import { db, saveInvoiceFromSnapshot } from '@/local-db'
import { saveManualEntry, useManualEntryCloudData } from '@/local-db/manualEntrySync'
import type { ManualEntryTemplate } from '@/local-db/models'
import { Button } from '@/ui/components/button'
import { Input } from '@/ui/components/input'
import {
  Card, CardContent, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
  useToast,
} from '@/ui/components'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { persistInvoiceVersion } from '@/services/invoiceVersionService'

const ROW_COUNT = 20

type CellData = Record<string, string[]>

function renderTableElement(template: ManualEntryTemplate, data: CellData, detailValues?: Record<string, string>) {
  const sortedRows = [...template.rows]
    .filter((r) => r.label.trim())
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const headerLines = [
    template.headerName,
    template.headerPhone1,
    template.headerPhone2,
  ].filter(Boolean)

  const detailRows: { key: string; label: string | undefined; value: string | undefined }[] = [
    { key: 'detail1', label: template.detailsLabel1, value: detailValues?.detail1 },
    { key: 'detail2', label: template.detailsLabel2, value: detailValues?.detail2 },
    { key: 'detail3', label: template.detailsLabel3, value: detailValues?.detail3 },
  ].filter((r): r is typeof r & { label: string } => !!r.label)

  const detailsSection = detailRows.length > 0
    ? createElement(
        'div',
        {
          style: {
            borderLeft: '1px solid #d1d5db',
            borderRight: '1px solid #d1d5db',
            fontFamily: 'Arial, sans-serif',
            fontSize: '13px',
          },
        },
        detailRows.map((r, idx) =>
          createElement(
            'div',
            { key: r.key, style: { display: 'flex', ...(idx < detailRows.length - 1 ? { borderBottom: '1px solid #d1d5db' } : {}) } },
            [
              createElement(
                'div',
                { key: 'label', style: { width: '33.33%', background: '#f9fafb', padding: '9px 14px', fontWeight: 600, color: '#374151', borderLeft: '1px solid #d1d5db', boxSizing: 'border-box' } },
                r.label,
              ),
              createElement(
                'div',
                { key: 'value', style: { flex: 1, padding: '9px 14px', boxSizing: 'border-box' } },
                r.value || '',
              ),
            ],
          ),
        ),
      )
    : null

  return createElement(
    'div',
    { style: { width: '210mm', minHeight: '297mm', background: '#ffffff', padding: '10mm 15mm', direction: 'rtl', display: 'flex', flexDirection: 'column', justifyContent: 'center', boxSizing: 'border-box' } },
    headerLines.length > 0
      ?         createElement(
          'div',
          {
            style: {
              marginBottom: 0,
              padding: '18px',
              border: '1px solid #d1d5db',
              borderTopLeftRadius: '8px',
              borderTopRightRadius: '8px',
              background: '#f9fafb',
              fontFamily: 'Arial, sans-serif',
              fontSize: '16px',
              lineHeight: '1.8',
            },
          },
          headerLines.map((line, idx) =>
            createElement('div', { key: idx, style: { marginBottom: '8px', fontWeight: 500 } }, line),
          ),
        )
      : null,
    detailsSection,
    createElement(
      'table',
      {
        style: {
          width: '100%', borderCollapse: 'collapse', border: '1px solid #d1d5db',
          fontFamily: 'Arial, sans-serif', fontSize: '13px',
        },
      },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          createElement(
            'th',
            {
              style: {
                border: '1px solid #d1d5db', background: '#f3f4f6', padding: 0,
                textAlign: 'center', fontWeight: 600, color: '#374151',
                width: '36px', whiteSpace: 'nowrap',
              },
            },
            createElement('div', {
              style: { padding: '9px 14px', lineHeight: '1.3' },
            }, '#'),
          ),
          ...sortedRows.map((row, idx) =>
            createElement(
              'th',
              {
                key: row.id,
                style: {
                  border: '1px solid #d1d5db', background: '#f3f4f6', padding: 0,
                  textAlign: 'center', fontWeight: 600, color: '#374151',
                  width: idx === 0 ? '40%' : undefined,
                },
              },
              createElement('div', {
                style: { padding: '9px 14px', lineHeight: '1.3' },
              }, row.label),
            ),
          ),
        ),
      ),
      createElement(
        'tbody',
        null,
        ...Array.from({ length: ROW_COUNT }, (_, rowIdx) =>
          createElement(
            'tr',
            { key: rowIdx },
            createElement(
              'td',
              {
                style: {
                  border: '1px solid #d1d5db', padding: 0,
                  textAlign: 'center', color: '#6b7280', fontSize: '13px',
                },
              },
              createElement('div', {
                style: { padding: '9px 14px', lineHeight: '1.3' },
              }, String(rowIdx + 1)),
            ),
            ...sortedRows.map((row) =>
              createElement(
                'td',
                {
                  key: row.id,
                  style: { border: '1px solid #d1d5db', padding: 0, fontSize: '13px' },
                  dir: 'rtl',
                },
                createElement('div', {
                  style: { padding: '9px 14px', lineHeight: '1.3' },
                }, data[row.id]?.[rowIdx] || ''),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

interface ManualEntryA4PreviewProps {
  template: ManualEntryTemplate
  onBack: () => void
  onSaveAndPrint: (data: CellData, detailValues?: Record<string, string>) => Promise<string | undefined>
}

function ManualEntryA4Preview({ template, onBack, onSaveAndPrint }: ManualEntryA4PreviewProps) {
  const { t } = useTranslation()
  const [isSaving, setIsSaving] = useState(false)

  const sortedRows = useMemo(
    () => [...template.rows]
      .filter((r) => r.label.trim())
      .sort((a, b) => a.sortOrder - b.sortOrder),
    [template.rows],
  )

  const [cellData, setCellData] = useState<CellData>(() => {
    const data: CellData = {}
    for (const row of sortedRows) {
      data[row.id] = Array.from({ length: ROW_COUNT }, () => '')
    }
    return data
  })

  const [detailValues, setDetailValues] = useState<Record<string, string>>({
    detail1: '',
    detail2: '',
    detail3: '',
  })

  const updateCell = useCallback((rowId: string, rowIndex: number, value: string) => {
    setCellData((prev) => {
      const col = [...(prev[rowId] || [])]
      col[rowIndex] = value
      return { ...prev, [rowId]: col }
    })
  }, [])

  const updateDetail = useCallback((key: string, value: string) => {
    setDetailValues((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleSaveAndPrint = useCallback(async () => {
    setIsSaving(true)
    try {
      await onSaveAndPrint(cellData, detailValues)
    } finally {
      setIsSaving(false)
    }
  }, [cellData, detailValues, onSaveAndPrint])

  return (
    <div className="mx-auto p-4 sm:p-6">
      <div className="no-print mb-4 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('common.back') || 'Back'}
        </Button>
        <div className="text-lg font-semibold">{template.name}</div>
        <Button onClick={handleSaveAndPrint} disabled={isSaving}>
          {isSaving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              <Printer className="mr-2 h-4 w-4" />
            </>
          )}
          {t('manualEntry.print.saveAndPrint') || 'Save & Print'}
        </Button>
      </div>

      <div className="overflow-auto max-w-full">
      <div className="mx-auto bg-white" style={{ width: '210mm', minHeight: '297mm', display: 'flex', flexDirection: 'column', justifyContent: 'center', boxSizing: 'border-box' }}>
        <div style={{ padding: '10mm 15mm' }}>
          <div style={{ direction: 'rtl', marginBottom: 0 }}>
            {(() => {
              const lines = [
                template.headerName,
                template.headerPhone1,
                template.headerPhone2,
              ].filter(Boolean)
              if (lines.length === 0) return null
              return (
                <div className="border border-gray-300 bg-gray-50 rounded-t-lg p-4 mb-0" style={{ fontFamily: 'Arial, sans-serif' }}>
                  {lines.map((line, idx) => (
                    <div key={idx} className="text-base font-medium leading-relaxed mb-1.5 last:mb-0">{line}</div>
                  ))}
                </div>
              )
            })()}
          </div>
          {template.detailsLabel1 || template.detailsLabel2 || template.detailsLabel3 ? (
            <div style={{ direction: 'rtl' }} className="border border-gray-300 border-t-0">
            {([['detail1', template.detailsLabel1], ['detail2', template.detailsLabel2], ['detail3', template.detailsLabel3]] as const)
              .filter(([, label]) => label)
              .map(([key, label], idx, arr) => (
                <div key={key} className={`flex ${idx < arr.length - 1 ? 'border-b' : ''} border-gray-300`}>
                  <div className="w-1/3 bg-gray-50 px-3.5 py-[9px] text-xs font-semibold text-gray-700 leading-tight border-l border-gray-300">
                    {label}
                  </div>
                  <div className="flex-1 px-3.5 py-[9px] leading-tight">
                    <input
                      autoComplete="off"
                      value={detailValues[key]}
                      onChange={(e) => updateDetail(key, e.target.value)}
                      className="w-full rounded-none border-0 bg-transparent p-0 text-xs shadow-none outline-none focus:bg-blue-50"
                      style={{ direction: 'rtl' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ direction: 'rtl' }}>
            <table className="w-full border-collapse border border-gray-300 text-base">
              <thead>
                <tr>
                  <th className="border border-gray-300 bg-gray-100 text-center text-xs font-semibold text-gray-700 w-[36px] whitespace-nowrap">
                    <div className="px-3.5 py-[9px] leading-tight">#</div>
                  </th>
                  {sortedRows.map((row, idx) => (
                    <th key={row.id} className="border border-gray-300 bg-gray-100 text-center text-xs font-semibold text-gray-700" style={idx === 0 ? { width: '40%' } : {}}>
                      <div className="px-3.5 py-[9px] leading-tight">{row.label}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: ROW_COUNT }, (_, rowIdx) => (
                  <tr key={rowIdx}>
                    <td className="border border-gray-300 p-0 text-center text-xs text-gray-500 whitespace-nowrap">
                      <div className="px-3.5 py-[9px] leading-tight">{rowIdx + 1}</div>
                    </td>
                    {sortedRows.map((row) => (
                      <td key={row.id} className="border border-gray-300 p-0">
                        <div style={{ direction: 'rtl', padding: 0 }}>
                          <Input
                            value={cellData[row.id]?.[rowIdx] || ''}
                            onChange={(e) => updateCell(row.id, rowIdx, e.target.value)}
                            className="min-w-0 flex-1 rounded-none border-0 bg-transparent px-3.5 py-[9px] text-xs leading-tight shadow-none focus:bg-blue-50 focus:ring-0"
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}

export function ManualEntry() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user } = useAuth()
  const workspaceId = user?.workspaceId

  const [templates, setTemplates] = useState<ManualEntryTemplate[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const isCloudReady = useManualEntryCloudData(workspaceId)
  const [selectedTemplate, setSelectedTemplate] = useState<ManualEntryTemplate | null>(null)
  const [isSelectionOpen, setIsSelectionOpen] = useState(false)

  useEffect(() => {
    if (!workspaceId || !isCloudReady) return
    db.manual_entry_templates
      .where('workspaceId')
      .equals(workspaceId)
      .filter((t) => !t.isDeleted && t.status === 'active')
      .toArray()
      .then((all) => {
        setTemplates(all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
      })
      .catch(console.error)
      .finally(() => setIsLoading(false))
  }, [workspaceId, isCloudReady])

  const activeTemplates = useMemo(
    () => templates.filter((t) => !t.isDeleted && t.status === 'active'),
    [templates],
  )

  const handleCreateEntry = useCallback(() => {
    if (activeTemplates.length === 0) return
    if (activeTemplates.length === 1) {
      setSelectedTemplate(activeTemplates[0])
    } else {
      setIsSelectionOpen(true)
    }
  }, [activeTemplates])

  const handleSelectTemplate = useCallback((template: ManualEntryTemplate) => {
    setIsSelectionOpen(false)
    setSelectedTemplate(template)
  }, [])

  const handleSaveAndPrint = useCallback(async (data: CellData, detailValues?: Record<string, string>): Promise<string | undefined> => {
    if (!workspaceId || !selectedTemplate) return
    let entryId: string
    try {
      entryId = await saveManualEntry({
        workspaceId,
        templateId: selectedTemplate.id,
        templateName: selectedTemplate.name,
        rows: selectedTemplate.rows.map((r) => ({
          id: r.id,
          label: r.label,
          sortOrder: r.sortOrder,
        })),
        data,
        detailValues: detailValues ?? { detail1: '', detail2: '', detail3: '' },
      })
    } catch (err) {
      console.error('Failed to save manual entry:', err)
      toast({ title: 'Error', description: 'Failed to save entry.', variant: 'destructive' })
      return
    }
    const invoiceId = entryId

    // Create invoice record first (without PDF blob)
    try {
      await saveInvoiceFromSnapshot(workspaceId, {
        sourceId: entryId,
        invoiceid: invoiceId,
        totalAmount: 0,
        settlementCurrency: 'iqd',
        origin: 'manual',
        status: 'draft',
        printFormat: 'a4',
        createdBy: user?.id,
        createdByName: user?.name,
        cashierName: user?.name,
      }, invoiceId)
    } catch (err) {
      console.error('Failed to create invoice record:', err)
      toast({ title: 'Error', description: 'Failed to create invoice record.', variant: 'destructive' })
      return
    }

    // Generate PDF blob and attach it to the invoice
    try {
      const tableElement = renderTableElement(selectedTemplate, data, detailValues)
      const pdfBlob = await generateTemplatePdf({ element: tableElement })

      const invoice = await db.invoices.get(invoiceId)
      if (!invoice) throw new Error('Invoice record was not created')
      await persistInvoiceVersion({
        invoice,
        blob: pdfBlob,
        format: 'a4',
        author: { id: user?.id, name: user?.name },
        metadata: {
          module: 'manual_entry',
          manualEntryId: entryId,
          templateId: selectedTemplate.id,
          templateName: selectedTemplate.name,
        },
      })
    } catch (err) {
      console.error('Failed to generate or save PDF:', err)
    }

    toast({
      title: (t('print.saveSuccess') as string) || 'Saved',
      description: (t('print.saveSuccessDesc') as string) || 'Manual entry saved successfully.',
    })

    return invoiceId
  }, [workspaceId, selectedTemplate, t, toast, user?.id, user?.name])

  if (selectedTemplate) {
    return (
      <ManualEntryA4Preview
        template={selectedTemplate}
        onBack={() => setSelectedTemplate(null)}
        onSaveAndPrint={handleSaveAndPrint}
      />
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="container mx-auto p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{t('manualEntry.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('manualEntry.description')} <ModulePageFreshness className="ms-2" />
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <Button size="lg" onClick={handleCreateEntry} disabled={activeTemplates.length === 0}>
            <Printer className="mr-2 h-5 w-5" />
            {t('manualEntry.create')}
          </Button>
          {activeTemplates.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('manualEntry.noTemplates')}</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={isSelectionOpen} onOpenChange={(open) => !open && setIsSelectionOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              {t('manualEntry.selectTemplate')}
            </DialogTitle>
            <DialogDescription>{t('manualEntry.selectTemplateDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[55vh] grid-cols-1 gap-3 overflow-y-auto py-2">
            {activeTemplates.map((template) => (
              <Button
                key={template.id}
                variant="outline"
                className="flex h-auto flex-col items-start gap-1 p-4 text-left"
                onClick={() => handleSelectTemplate(template)}
              >
                <span className="font-medium">{template.name}</span>
                <span className="text-xs text-muted-foreground">
                  {template.rows.length} {(t('manualEntry.rows') as string) || 'rows'}
                </span>
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
