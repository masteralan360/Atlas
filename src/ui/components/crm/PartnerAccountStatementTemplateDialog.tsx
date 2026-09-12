import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Save,
  Settings2,
  Star,
  Trash2
} from 'lucide-react'

import {
  createPartnerAccountStatementTemplateConfiguration,
  DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION,
  isPartnerAccountStatementColumnVisible,
  type PartnerAccountStatementColumnId,
  type PartnerAccountStatementTemplate,
  type PartnerAccountStatementTemplateConfiguration,
  PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS
} from '@/lib/partnerAccountStatementTemplates'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  DeleteConfirmationModal,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useToast
} from '@/ui/components'

type TemplateSaveInput = {
  id?: string
  label: string
  configuration: PartnerAccountStatementTemplateConfiguration
}

type PartnerAccountStatementTemplateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  templates: PartnerAccountStatementTemplate[]
  activeTemplate: PartnerAccountStatementTemplate
  hasStoredTemplates: boolean
  canManageTemplates: boolean
  onSelectTemplate: (templateId: string | null) => void
  onSaveTemplate: (input: TemplateSaveInput) => Promise<string>
  onSetDefault: (templateId: string) => Promise<void>
  onDeleteTemplate: (templateId: string) => Promise<void>
}

const TEMPLATE_SELECT_BUILT_IN_VALUE = '__built-in-default__'

function cloneConfiguration(configuration: PartnerAccountStatementTemplateConfiguration) {
  return createPartnerAccountStatementTemplateConfiguration({
    ...configuration,
    columnOrder: [...configuration.columnOrder],
    hiddenColumns: [...configuration.hiddenColumns]
  })
}

function getColumnLabel(
  columnId: PartnerAccountStatementColumnId,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  const labels: Record<PartnerAccountStatementColumnId, [string, string]> = {
    date: ['businessPartners.accountStatement.templateColumns.date', 'Date'],
    reference: ['businessPartners.accountStatement.templateColumns.reference', 'Reference'],
    type: ['businessPartners.accountStatement.templateColumns.type', 'Type'],
    description: ['businessPartners.accountStatement.templateColumns.description', 'Description'],
    item: ['businessPartners.accountStatement.templateColumns.item', 'Item'],
    quantity: ['businessPartners.accountStatement.templateColumns.quantity', 'Quantity'],
    commissionPerProduct: ['businessPartners.accountStatement.templateColumns.commissionPerProduct', 'Product commission / unit'],
    totalProductCommission: ['businessPartners.accountStatement.templateColumns.totalProductCommission', 'Total product commission'],
    debit: ['businessPartners.accountStatement.templateColumns.debit', 'Debit'],
    credit: ['businessPartners.accountStatement.templateColumns.credit', 'Credit'],
    balance: ['businessPartners.accountStatement.templateColumns.balance', 'Balance']
  }
  const [key, defaultValue] = labels[columnId]
  return t(key, { defaultValue })
}

function isSameConfiguration(
  left: PartnerAccountStatementTemplateConfiguration,
  right: PartnerAccountStatementTemplateConfiguration
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function PartnerAccountStatementTemplateDialog({
  open,
  onOpenChange,
  templates,
  activeTemplate,
  hasStoredTemplates,
  canManageTemplates,
  onSelectTemplate,
  onSaveTemplate,
  onSetDefault,
  onDeleteTemplate
}: PartnerAccountStatementTemplateDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [draftTemplateId, setDraftTemplateId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftConfiguration, setDraftConfiguration] = useState<PartnerAccountStatementTemplateConfiguration>(
    DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION
  )
  const [isProcessing, setIsProcessing] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PartnerAccountStatementTemplate | null>(null)

  const resetDraft = (template: PartnerAccountStatementTemplate, draftId: string | null = template.id) => {
    setDraftTemplateId(draftId)
    setDraftLabel(template.label)
    setDraftConfiguration(cloneConfiguration(template.configuration))
  }

  useEffect(() => {
    if (open) resetDraft(activeTemplate, hasStoredTemplates ? activeTemplate.id : null)
  }, [activeTemplate, hasStoredTemplates, open])

  const editedTemplate = useMemo(
    () => draftTemplateId ? templates.find((template) => template.id === draftTemplateId) || null : null,
    [draftTemplateId, templates]
  )
  const isNewTemplate = draftTemplateId === null
  const visibleColumnCount = PARTNER_ACCOUNT_STATEMENT_COLUMN_IDS.filter((columnId) =>
    isPartnerAccountStatementColumnVisible(draftConfiguration, columnId)
  ).length
  const isDirty = isNewTemplate
    || !editedTemplate
    || draftLabel.trim() !== editedTemplate.label
    || !isSameConfiguration(draftConfiguration, editedTemplate.configuration)
  const canSave = canManageTemplates && draftLabel.trim().length > 0 && visibleColumnCount > 0 && !isProcessing

  const handleOpenChange = (nextOpen: boolean) => {
    if (!isProcessing) onOpenChange(nextOpen)
  }

  const selectTemplate = (templateId: string) => {
    const nextTemplate = templates.find((template) => template.id === templateId)
    if (!nextTemplate) return
    onSelectTemplate(nextTemplate.id)
    resetDraft(nextTemplate)
  }

  const createNewTemplate = (copyFromActive: boolean) => {
    setDraftTemplateId(null)
    setDraftLabel(copyFromActive
      ? t('businessPartners.accountStatement.copyOfTemplate', {
        defaultValue: 'Copy of {{name}}',
        name: activeTemplate.label
      })
      : '')
    setDraftConfiguration(cloneConfiguration(
      copyFromActive ? activeTemplate.configuration : DEFAULT_PARTNER_ACCOUNT_STATEMENT_TEMPLATE_CONFIGURATION
    ))
  }

  const toggleColumnVisibility = (columnId: PartnerAccountStatementColumnId, visible: boolean) => {
    setDraftConfiguration((current) => ({
      ...current,
      hiddenColumns: visible
        ? current.hiddenColumns.filter((candidate) => candidate !== columnId)
        : [...current.hiddenColumns, columnId]
    }))
  }

  const moveColumn = (columnId: PartnerAccountStatementColumnId, direction: -1 | 1) => {
    setDraftConfiguration((current) => {
      const index = current.columnOrder.indexOf(columnId)
      const destination = index + direction
      if (index < 0 || destination < 0 || destination >= current.columnOrder.length) return current
      const columnOrder = [...current.columnOrder]
      const [moved] = columnOrder.splice(index, 1)
      columnOrder.splice(destination, 0, moved)
      return { ...current, columnOrder }
    })
  }

  const saveTemplate = async () => {
    if (!canSave) return
    setIsProcessing(true)
    try {
      const savedId = await onSaveTemplate({
        id: draftTemplateId || undefined,
        label: draftLabel.trim(),
        configuration: cloneConfiguration(draftConfiguration)
      })
      onSelectTemplate(savedId)
      toast({
        title: t('businessPartners.accountStatement.templateSavedTitle', { defaultValue: 'Statement template saved' }),
        description: t('businessPartners.accountStatement.templateSavedDescription', {
          defaultValue: 'The template is now available to this workspace.'
        })
      })
    } catch {
      toast({
        title: t('businessPartners.accountStatement.templateSaveFailedTitle', { defaultValue: 'Could not save template' }),
        description: t('businessPartners.accountStatement.templateSaveFailedDescription', {
          defaultValue: 'Check your connection and try again.'
        }),
        variant: 'destructive'
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const setDefault = async () => {
    if (!editedTemplate || editedTemplate.primary || isProcessing) return
    setIsProcessing(true)
    try {
      await onSetDefault(editedTemplate.id)
      toast({
        title: t('businessPartners.accountStatement.defaultTemplateSavedTitle', { defaultValue: 'Default template updated' }),
        description: t('businessPartners.accountStatement.defaultTemplateSavedDescription', {
          defaultValue: 'New account statements will use this template by default.'
        })
      })
    } catch {
      toast({
        title: t('businessPartners.accountStatement.templateSaveFailedTitle', { defaultValue: 'Could not save template' }),
        description: t('businessPartners.accountStatement.templateSaveFailedDescription', {
          defaultValue: 'Check your connection and try again.'
        }),
        variant: 'destructive'
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const deleteTemplate = async () => {
    if (!deleteTarget || isProcessing) return
    setIsProcessing(true)
    try {
      await onDeleteTemplate(deleteTarget.id)
      onSelectTemplate(null)
      setDeleteTarget(null)
      toast({
        title: t('businessPartners.accountStatement.templateDeletedTitle', { defaultValue: 'Statement template deleted' }),
        description: t('businessPartners.accountStatement.templateDeletedDescription', {
          defaultValue: 'The template was removed from this workspace.'
        })
      })
    } catch {
      toast({
        title: t('businessPartners.accountStatement.templateDeleteFailedTitle', { defaultValue: 'Could not delete template' }),
        description: t('businessPartners.accountStatement.templateDeleteFailedDescription', {
          defaultValue: 'Check your connection and try again.'
        }),
        variant: 'destructive'
      })
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <>
      <AppDialog open={open} onOpenChange={handleOpenChange}>
        <AppDialogContent className="max-w-4xl" showCloseButton={!isProcessing}>
          <AppDialogHeader>
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-primary/10 p-2 text-primary">
                <Settings2 className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <AppDialogTitle>{t('businessPartners.accountStatement.templatesTitle', { defaultValue: 'Partner Account Statement Templates' })}</AppDialogTitle>
                <p className="text-sm text-muted-foreground">
                  {canManageTemplates
                    ? t('businessPartners.accountStatement.templatesAdminDescription', {
                      defaultValue: 'Choose the current statement template, then manage its columns and presentation settings.'
                    })
                    : t('businessPartners.accountStatement.templatesUserDescription', {
                      defaultValue: 'Choose the workspace template to use for this statement.'
                    })}
                </p>
              </div>
            </div>
          </AppDialogHeader>
          <AppDialogBody className="space-y-6">
            <section className="rounded-2xl border bg-muted/20 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0 flex-1 space-y-2">
                  <label htmlFor="partner-account-statement-template" className="text-sm font-semibold">
                    {t('businessPartners.accountStatement.currentTemplate', { defaultValue: 'Current statement template' })}
                  </label>
                  <Select
                    value={hasStoredTemplates ? activeTemplate.id : TEMPLATE_SELECT_BUILT_IN_VALUE}
                    onValueChange={(value) => {
                      if (value === TEMPLATE_SELECT_BUILT_IN_VALUE) {
                        onSelectTemplate(null)
                        resetDraft(activeTemplate, null)
                        return
                      }
                      selectTemplate(value)
                    }}
                    disabled={isProcessing || (canManageTemplates && isDirty)}
                  >
                    <SelectTrigger id="partner-account-statement-template" className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {!hasStoredTemplates ? (
                        <SelectItem value={TEMPLATE_SELECT_BUILT_IN_VALUE}>{activeTemplate.label}</SelectItem>
                      ) : templates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          <span className="flex items-center gap-2">
                            {template.primary ? <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" /> : null}
                            {template.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {hasStoredTemplates && activeTemplate.primary ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                    <Star className="h-3.5 w-3.5 fill-current" />
                    {t('businessPartners.accountStatement.defaultTemplate', { defaultValue: 'Workspace default' })}
                  </span>
                ) : null}
              </div>
            </section>

            {canManageTemplates ? (
              <>
                <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
                  <div>
                    <h3 className="font-semibold">
                      {isNewTemplate
                        ? t('businessPartners.accountStatement.newTemplate', { defaultValue: 'New template' })
                        : editedTemplate?.label}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {isNewTemplate
                        ? t('businessPartners.accountStatement.newTemplateDescription', {
                          defaultValue: 'Create a shared presentation for future statements.'
                        })
                        : t('businessPartners.accountStatement.editTemplateDescription', {
                          defaultValue: 'Changes affect statements that use this template after you save.'
                        })}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => createNewTemplate(false)} disabled={isProcessing}>
                      <Plus className="h-4 w-4" />
                      {t('businessPartners.accountStatement.newTemplate', { defaultValue: 'New template' })}
                    </Button>
                    {!isNewTemplate ? (
                      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => createNewTemplate(true)} disabled={isProcessing}>
                        <Copy className="h-4 w-4" />
                        {t('businessPartners.accountStatement.duplicateTemplate', { defaultValue: 'Duplicate' })}
                      </Button>
                    ) : null}
                  </div>
                </section>

                <section className="space-y-3 rounded-2xl border p-4">
                  <div className="space-y-2">
                    <label htmlFor="partner-account-statement-template-name" className="text-sm font-semibold">
                      {t('businessPartners.accountStatement.templateName', { defaultValue: 'Template name' })} *
                    </label>
                    <Input
                      id="partner-account-statement-template-name"
                      value={draftLabel}
                      onChange={(event) => setDraftLabel(event.target.value)}
                      placeholder={t('businessPartners.accountStatement.templateNamePlaceholder', { defaultValue: 'e.g. Detailed collections' })}
                      disabled={isProcessing}
                    />
                  </div>
                </section>

                <section className="space-y-3 rounded-2xl border p-4">
                  <div>
                    <h3 className="flex items-center gap-2 font-semibold"><Settings2 className="h-4 w-4 text-primary" />{t('businessPartners.accountStatement.templateSettings', { defaultValue: 'Statement settings' })}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('businessPartners.accountStatement.templateSettingsDescription', {
                        defaultValue: 'These options are saved in the template and apply to both the screen and printout.'
                      })}
                    </p>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="rounded-xl bg-muted/30 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <label htmlFor="partner-template-show-order-items" className="text-sm font-medium">
                            {t('businessPartners.accountStatement.showOrderItems')}
                          </label>
                          <p className="text-xs text-muted-foreground">
                            {t('businessPartners.accountStatement.showOrderItemsDescription')}
                          </p>
                        </div>
                        <Switch
                          id="partner-template-show-order-items"
                          checked={draftConfiguration.showOrderItems}
                          onCheckedChange={(showOrderItems) => setDraftConfiguration((current) => ({ ...current, showOrderItems }))}
                          disabled={isProcessing}
                        />
                      </div>
                    </div>
                    <div className="rounded-xl bg-muted/30 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <label htmlFor="partner-template-show-pos-sale-items" className="text-sm font-medium">
                            {t('businessPartners.accountStatement.showPosSaleItems')}
                          </label>
                          <p className="text-xs text-muted-foreground">
                            {t('businessPartners.accountStatement.showPosSaleItemsDescription')}
                          </p>
                        </div>
                        <Switch
                          id="partner-template-show-pos-sale-items"
                          checked={draftConfiguration.showPosSaleItems}
                          onCheckedChange={(showPosSaleItems) => setDraftConfiguration((current) => ({ ...current, showPosSaleItems }))}
                          disabled={isProcessing}
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-3 rounded-2xl border p-4">
                  <div>
                    <h3 className="font-semibold">{t('businessPartners.accountStatement.tableColumns', { defaultValue: 'Account activity columns' })}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('businessPartners.accountStatement.tableColumnsDescription', {
                        defaultValue: 'Show, hide, and reorder any activity or audit column. Keep at least one column visible.'
                      })}
                    </p>
                  </div>
                  <div className="divide-y rounded-xl border bg-muted/10">
                    {draftConfiguration.columnOrder.map((columnId, index) => {
                      const isVisible = isPartnerAccountStatementColumnVisible(draftConfiguration, columnId)
                      const canHide = !isVisible || visibleColumnCount > 1
                      return (
                        <div key={columnId} className="flex items-center gap-3 px-3 py-2.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => toggleColumnVisibility(columnId, !isVisible)}
                            disabled={isProcessing || !canHide}
                            aria-label={isVisible
                              ? t('businessPartners.accountStatement.hideColumn', { defaultValue: 'Hide {{column}}', column: getColumnLabel(columnId, t) })
                              : t('businessPartners.accountStatement.showColumn', { defaultValue: 'Show {{column}}', column: getColumnLabel(columnId, t) })}
                          >
                            {isVisible ? <Eye className="h-4 w-4 text-primary" /> : <EyeOff className="h-4 w-4 text-muted-foreground" />}
                          </Button>
                          <span className={isVisible ? 'min-w-0 flex-1 text-sm font-medium' : 'min-w-0 flex-1 text-sm text-muted-foreground line-through'}>
                            {getColumnLabel(columnId, t)}
                          </span>
                          <div className="flex shrink-0 gap-1">
                            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => moveColumn(columnId, -1)} disabled={isProcessing || index === 0} aria-label={t('businessPartners.accountStatement.moveColumnUp', { defaultValue: 'Move {{column}} up', column: getColumnLabel(columnId, t) })}>
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => moveColumn(columnId, 1)} disabled={isProcessing || index === draftConfiguration.columnOrder.length - 1} aria-label={t('businessPartners.accountStatement.moveColumnDown', { defaultValue: 'Move {{column}} down', column: getColumnLabel(columnId, t) })}>
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>

                {!isNewTemplate && editedTemplate ? (
                  <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed p-4">
                    <div className="text-sm text-muted-foreground">
                      {editedTemplate.primary
                        ? t('businessPartners.accountStatement.defaultTemplateCannotDelete', {
                          defaultValue: 'Set another template as the workspace default before deleting this one.'
                        })
                        : t('businessPartners.accountStatement.templateLifecycleDescription', {
                          defaultValue: 'Set this template as default, or remove it when it is no longer needed.'
                        })}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" className="gap-2" onClick={setDefault} disabled={isProcessing || editedTemplate.primary || isDirty}>
                        <Star className="h-4 w-4" />
                        {t('businessPartners.accountStatement.setDefaultTemplate', { defaultValue: 'Set as default' })}
                      </Button>
                      <Button type="button" variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(editedTemplate)} disabled={isProcessing || editedTemplate.primary || templates.length <= 1 || isDirty}>
                        <Trash2 className="h-4 w-4" />
                        {t('common.delete')}
                      </Button>
                    </div>
                  </section>
                ) : null}
              </>
            ) : null}
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isProcessing}>
              {t('common.close')}
            </Button>
            {canManageTemplates ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" className="gap-2" onClick={() => resetDraft(activeTemplate, hasStoredTemplates ? activeTemplate.id : null)} disabled={isProcessing || !isDirty}>
                  <Check className="h-4 w-4" />
                  {t('businessPartners.accountStatement.discardTemplateChanges', { defaultValue: 'Discard unsaved changes' })}
                </Button>
                <Button type="button" className="gap-2" onClick={saveTemplate} disabled={!canSave || !isDirty}>
                  {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {isNewTemplate
                    ? t('businessPartners.accountStatement.saveTemplateAsNew', { defaultValue: 'Save as new template' })
                    : t('businessPartners.accountStatement.updateTemplate', { defaultValue: 'Update template' })}
                </Button>
              </div>
            ) : null}
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <DeleteConfirmationModal
        isOpen={Boolean(deleteTarget)}
        onClose={() => {
          if (!isProcessing) setDeleteTarget(null)
        }}
        onConfirm={deleteTemplate}
        isLoading={isProcessing}
        simpleConfirmation
        itemName={deleteTarget?.label}
        title={t('businessPartners.accountStatement.deleteTemplateTitle', { defaultValue: 'Delete statement template?' })}
        description={t('businessPartners.accountStatement.deleteTemplateDescription', {
          defaultValue: 'This removes the shared template. Existing statements keep their live accounting data.'
        })}
      />
    </>
  )
}
