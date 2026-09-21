import { useCallback, useEffect, useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, FileText, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'

import { isSupabaseConfigured, supabase, useAuth } from '@/auth'
import { Button } from '@/ui/components/button'
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast
} from '@/ui/components'
import {
    CUSTOM_TEMPLATE_TARGETS,
    cloneAtlasStandardOrderLayoutForReturn,
    createCustomTemplatePreview,
    getCustomTemplatePrintLanguageWarning,
    getCustomTemplateDisplayName,
    getCustomTemplateTarget,
    getStoredCustomTemplatePrintLanguage,
    ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
    ORDER_ATLAS_STANDARD_TEMPLATE_KEY,
    readCustomTemplateLayout,
    resolveCustomTemplatePrintLanguage,
    stampCustomTemplatePrintLanguage
} from '@/lib/customTemplates'
import { setPrintPreviewEditorSource, type CustomTemplateLayout } from '@/lib/printPreviewEditorStore'
import { formatDateTime } from '@/lib/utils'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { useWorkspace } from '@/workspace'
import { useWorkspaceContacts } from '@/local-db/hooks'
import { r2Service } from '@/services/r2Service'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import {
    deleteLocalCustomTemplate,
    listLocalCustomTemplates,
    replaceMirroredCustomTemplates,
    saveLocalCustomTemplate,
    updateLocalCustomTemplateStatus,
    type LocalCustomTemplateRow as CustomTemplateRow
} from '@/local-db'
import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'

function readStoredLayout(row?: CustomTemplateRow | null): CustomTemplateLayout | null {
    return readCustomTemplateLayout(row)
}

function countLayoutItems(row: CustomTemplateRow) {
    const layout = readStoredLayout(row)
    if (!layout) return 0
    return layout.annotations.length
        + layout.texts.length
        + layout.images.length
        + layout.shapes.length
        + Object.keys(layout.fields).length
        + Object.keys(layout.hiddenFields || {}).length
        + Object.values(layout.fieldOrders || {}).reduce((count, fieldOrder) => count + fieldOrder.length, 0)
        + Object.keys(layout.fieldLabelOverrides || {}).length
        + Object.keys(layout.fieldValueOverrides || {}).length
        + Object.keys(layout.fieldDisplayModes || {}).length
        + Object.keys(layout.componentPositions || {}).length
}

function collectLayoutImagePaths(layout?: CustomTemplateLayout | null) {
    const paths = new Set<string>()
    for (const image of layout?.images || []) {
        const path = typeof image?.path === 'string' ? image.path.trim() : ''
        if (!path || path.startsWith('http') || path.startsWith('data:') || path.startsWith('blob:')) {
            continue
        }
        paths.add(path.replace(/\\/g, '/'))
    }
    return paths
}

function getR2KeyForStoredMediaPath(path: string, workspaceId: string) {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length < 3) return null

    const [folderPart, wsPart, ...restPath] = parts
    if (wsPart !== workspaceId || restPath.length === 0) return null

    return `${wsPart}/${folderPart}/${restPath.join('/')}`
}

export function CustomTemplates() {
    const { t, i18n } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const {
        features,
        hasFeature,
        workspaceName,
        isLocalMode,
        isDemoMode,
        isHybridMode
    } = useWorkspace()
    const [location, setLocation] = useLocation()
    const [templates, setTemplates] = useState<CustomTemplateRow[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [isAddOpen, setIsAddOpen] = useState(false)
    const [selectedModuleTypeKey, setSelectedModuleTypeKey] = useState(CUSTOM_TEMPLATE_TARGETS[0]?.moduleTypeKey || '')
    const [returnCloneSource, setReturnCloneSource] = useState<CustomTemplateRow | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<CustomTemplateRow | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    const workspaceId = user?.workspaceId
    const canPersistTemplates = isLocalMode || isSupabaseConfigured
    const currentPrintLanguage = resolveCustomTemplatePrintLanguage(features.print_lang, i18n.language)
    const workspaceContacts = useWorkspaceContacts(workspaceId)
    const canManageTemplates = user?.role === 'admin'
    const workspaceFooterContacts = useMemo(() => {
        const pickContactPair = (type: 'address' | 'email' | 'phone') => {
            const contactsOfType = workspaceContacts.filter((contact) =>
                contact.type === type
                && typeof contact.value === 'string'
                && contact.value.trim().length > 0
            )

            if (contactsOfType.length === 0) return {}

            const primaryContact = contactsOfType.find((contact) => contact.isPrimary) || contactsOfType[0]
            const nonPrimaryContact = contactsOfType.find((contact) => contact.id !== primaryContact.id)

            return {
                primary: primaryContact.value.trim(),
                nonPrimary: nonPrimaryContact?.value.trim()
            }
        }

        return {
            address: pickContactPair('address'),
            email: pickContactPair('email'),
            phone: pickContactPair('phone')
        }
    }, [workspaceContacts])
    const availableTargets = useMemo(
        () => CUSTOM_TEMPLATE_TARGETS.filter((target) => hasFeature(target.workspaceModuleKey)),
        [hasFeature]
    )
    const selectedTarget = useMemo(
        () => availableTargets.find((target) => target.moduleTypeKey === selectedModuleTypeKey),
        [availableTargets, selectedModuleTypeKey]
    )
    const atlasStandardOrderCloneSource = useMemo(() => templates
        .filter((template) => template.module_type_key === ORDER_ATLAS_STANDARD_TEMPLATE_KEY && Boolean(readStoredLayout(template)))
        .sort((left, right) => {
            if (left.primary !== right.primary) return left.primary ? -1 : 1
            return new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime()
        })[0] || null, [templates])

    useEffect(() => {
        if (availableTargets.length === 0) return
        if (!availableTargets.some((target) => target.moduleTypeKey === selectedModuleTypeKey)) {
            setSelectedModuleTypeKey(availableTargets[0].moduleTypeKey)
        }
    }, [availableTargets, selectedModuleTypeKey])

    useEffect(() => {
        if (!location.includes('new=return')
            || !availableTargets.some((target) => target.moduleTypeKey === ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY)) {
            return
        }

        setSelectedModuleTypeKey(ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY)
        setIsAddOpen(true)
        setLocation('/custom-templates')
    }, [availableTargets, location, setLocation])

    const loadCloudTemplates = useCallback(async () => {
        if (!workspaceId) {
            throw new Error('Missing workspace context.')
        }
        return fetchCachedCustomTemplates(workspaceId)
    }, [workspaceId])

    const fetchTemplates = useCallback(async () => {
        if (!workspaceId || (!isLocalMode && !isSupabaseConfigured)) {
            setTemplates([])
            setIsLoading(false)
            return
        }

        setIsLoading(true)
        setError(null)
        try {
            if (isLocalMode) {
                setTemplates(await listLocalCustomTemplates(workspaceId))
            } else {
                setTemplates(await loadCloudTemplates())
            }
        } catch (err) {
            const message = isLocalMode
                ? (err instanceof Error ? err.message : String(err))
                : normalizeSupabaseActionError(err).message
            setError(message)
            if (isHybridMode && workspaceId) {
                try {
                    setTemplates(await listLocalCustomTemplates(workspaceId))
                } catch {
                    setTemplates([])
                }
            } else {
                setTemplates([])
            }
        } finally {
            setIsLoading(false)
        }
    }, [isHybridMode, isLocalMode, loadCloudTemplates, workspaceId])

    useEffect(() => {
        void fetchTemplates()
    }, [fetchTemplates])

    const saveTemplateLayout = useCallback(async (
        layout: CustomTemplateLayout,
        options?: { label?: string },
        templateId?: string
    ) => {
        if (!workspaceId || !user?.id) {
            throw new Error('Missing workspace context.')
        }

        const label = options?.label?.trim() || layout.label?.trim() || getCustomTemplateDisplayName(layout.moduleTypeKey)
        const layoutWithLabel = stampCustomTemplatePrintLanguage({
            ...layout,
            label
        }, currentPrintLanguage)

        if (isLocalMode) {
            await saveLocalCustomTemplate({
                id: templateId,
                workspaceId,
                moduleTypeKey: layout.moduleTypeKey,
                label,
                layoutJson: layoutWithLabel,
                userId: user.id
            })
        } else {
            if (!isSupabaseConfigured) {
                throw new Error('Supabase must be configured before custom templates can be saved.')
            }

            const existingTemplate = templateId
                ? templates.find((template) => template.id === templateId)
                : undefined
            const previousImagePaths = collectLayoutImagePaths(readStoredLayout(existingTemplate))
            const nextImagePaths = collectLayoutImagePaths(layoutWithLabel)
            const pathsUsedByOtherTemplates = new Set<string>()
            for (const template of templates) {
                if (template.id === existingTemplate?.id) continue
                for (const path of collectLayoutImagePaths(readStoredLayout(template))) {
                    pathsUsedByOtherTemplates.add(path)
                }
            }
            const removedImagePaths = Array.from(previousImagePaths).filter((path) =>
                !nextImagePaths.has(path) && !pathsUsedByOtherTemplates.has(path)
            )
            const payload = {
                workspace_id: workspaceId,
                module_type_key: layout.moduleTypeKey,
                label,
                layout_json: layoutWithLabel,
                updated_by: user.id
            }
            const { error: saveError } = existingTemplate
                ? await runSupabaseAction('customTemplates.update', () =>
                    supabase
                        .from('custom_templates')
                        .update(payload)
                        .eq('id', existingTemplate.id)
                        .eq('workspace_id', workspaceId)
                )
                : await runSupabaseAction('customTemplates.create', () =>
                    supabase
                        .from('custom_templates')
                        .insert({
                            ...payload,
                            created_by: user.id,
                            active: true,
                            primary: false
                        })
                )
            if (saveError) throw normalizeSupabaseActionError(saveError)

            if (removedImagePaths.length > 0 && r2Service.isConfigured()) {
                const deleteResults = await Promise.allSettled(
                    removedImagePaths.map(async (path) => {
                        const r2Key = getR2KeyForStoredMediaPath(path, workspaceId)
                        if (r2Key) await r2Service.delete(r2Key)
                    })
                )
                deleteResults.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        console.error('[CustomTemplates] Failed to delete removed template image from R2:', removedImagePaths[index], result.reason)
                    }
                })
            }
        }

        if (isLocalMode) {
            await fetchTemplates()
        } else {
            setTemplates(await loadCloudTemplates())
        }

        toast({
            title: t('customTemplates.savedTitle', { defaultValue: 'Template saved' }),
            description: isDemoMode
                ? t('customTemplates.savedDemoDescription', {
                    defaultValue: 'The custom print layout was saved in IndexedDB for this demo session.'
                })
                : isLocalMode
                ? t('customTemplates.savedLocalDescription', {
                    defaultValue: 'The custom print layout was saved to atlas-local-mode.db.'
                })
                : isHybridMode
                    ? t('customTemplates.savedHybridDescription', {
                        defaultValue: 'The custom print layout was saved to Supabase and mirrored to atlas-local-mode.db.'
                    })
                : t('customTemplates.savedDescription', {
                    defaultValue: 'The custom print layout was saved to Supabase.'
                })
        })
    }, [currentPrintLanguage, fetchTemplates, isDemoMode, isHybridMode, isLocalMode, loadCloudTemplates, t, templates, toast, user?.id, workspaceId])

    const openPreview = useCallback((
        moduleTypeKey: string,
        template?: CustomTemplateRow,
        initialTemplateLayout?: CustomTemplateLayout | null
    ) => {
        const target = availableTargets.find((item) => item.moduleTypeKey === moduleTypeKey)
        if (!target || !workspaceId) return
        const resolvedInitialLayout = initialTemplateLayout || readStoredLayout(template)

        setPrintPreviewEditorSource({
            title: t('customTemplates.previewTitle', {
                defaultValue: '{{name}} Custom Template',
                name: getCustomTemplateDisplayName(moduleTypeKey)
            }),
            printFormat: target.printFormat,
            workspaceId,
            templatePreview: createCustomTemplatePreview(target, {
                workspaceId,
                workspaceName,
                features,
                workspaceFooterContacts,
                printLang: features.print_lang && features.print_lang !== 'auto'
                    ? features.print_lang
                    : i18n.language
            }),
            customTemplate: {
                moduleTypeKey,
                nativeTemplateKey: target.nativeTemplateKey,
                templateId: template?.id,
                label: template?.label?.trim() || resolvedInitialLayout?.label || getCustomTemplateDisplayName(moduleTypeKey)
            },
            effectiveId: template?.id || `custom-template-${moduleTypeKey}`,
            initialTemplateLayout: resolvedInitialLayout,
            onSaveTemplateLayout: (layout, options) => saveTemplateLayout(layout, options, template?.id)
        })

        setIsAddOpen(false)
        setLocation('/print-preview-editor')
    }, [availableTargets, features, i18n.language, saveTemplateLayout, setLocation, t, workspaceFooterContacts, workspaceId, workspaceName])

    const openSelectedTemplatePreview = useCallback(() => {
        if (!selectedTarget) return

        if (selectedTarget.moduleTypeKey === ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY && atlasStandardOrderCloneSource) {
            setReturnCloneSource(atlasStandardOrderCloneSource)
            return
        }

        openPreview(selectedTarget.moduleTypeKey)
    }, [atlasStandardOrderCloneSource, openPreview, selectedTarget])

    const updateTemplateStatus = useCallback(async (
        template: CustomTemplateRow,
        changes: Partial<Pick<CustomTemplateRow, 'active' | 'primary'>>
    ) => {
        if (!workspaceId || !canManageTemplates) return

        if (changes.primary && !(changes.active ?? template.active)) {
            toast({
                title: t('customTemplates.statusErrorTitle', { defaultValue: 'Invalid template status' }),
                description: t('customTemplates.primaryRequiresActive', {
                    defaultValue: 'Activate the template before making it primary.'
                }),
                variant: 'destructive'
            })
            return
        }

        if (changes.active === false && template.primary) {
            const hasReplacement = templates.some((candidate) =>
                candidate.id !== template.id
                && candidate.module_type_key === template.module_type_key
                && candidate.active
            )
            if (!hasReplacement) {
                toast({
                    title: t('customTemplates.statusErrorTitle', { defaultValue: 'Invalid template status' }),
                    description: t('customTemplates.primaryReplacementRequired', {
                        defaultValue: 'Create or activate another template before deactivating the current primary template.'
                    }),
                    variant: 'destructive'
                })
                return
            }
        }

        try {
            const nextChanges = changes.active === false
                ? { ...changes, primary: false }
                : changes
            if (isLocalMode) {
                await updateLocalCustomTemplateStatus(workspaceId, template.id, nextChanges, user?.id)
            } else {
                const { error: updateError } = await runSupabaseAction('customTemplates.updateStatus', () =>
                    supabase
                        .from('custom_templates')
                        .update({
                            ...nextChanges,
                            updated_by: user?.id || null
                        })
                        .eq('id', template.id)
                        .eq('workspace_id', workspaceId)
                )
                if (updateError) throw normalizeSupabaseActionError(updateError)
            }
            if (isLocalMode) {
                await fetchTemplates()
            } else {
                setTemplates(await loadCloudTemplates())
            }
        } catch (statusError) {
            toast({
                title: t('customTemplates.statusErrorTitle', { defaultValue: 'Could not update template' }),
                description: isLocalMode
                    ? (statusError instanceof Error ? statusError.message : String(statusError))
                    : normalizeSupabaseActionError(statusError).message,
                variant: 'destructive'
            })
        }
    }, [canManageTemplates, fetchTemplates, isLocalMode, loadCloudTemplates, t, templates, toast, user?.id, workspaceId])

    const deleteTemplate = useCallback(async () => {
        if (!deleteTarget || !workspaceId || !canManageTemplates || isDeleting) return

        setIsDeleting(true)
        try {
            const deletedLayout = readStoredLayout(deleteTarget)
            const imagePathsUsedByOtherTemplates = new Set<string>()
            for (const template of templates) {
                if (template.id === deleteTarget.id) continue
                for (const path of collectLayoutImagePaths(readStoredLayout(template))) {
                    imagePathsUsedByOtherTemplates.add(path)
                }
            }
            const imagePathsToDelete = Array.from(collectLayoutImagePaths(deletedLayout)).filter(
                (path) => !imagePathsUsedByOtherTemplates.has(path)
            )

            if (isLocalMode) {
                await deleteLocalCustomTemplate(workspaceId, deleteTarget.id, user?.id)
                await fetchTemplates()
            } else {
                if (!isSupabaseConfigured) {
                    throw new Error('Supabase must be configured before custom templates can be deleted.')
                }

                let replacement: CustomTemplateRow | undefined
                if (deleteTarget.primary) {
                    replacement = templates.find((template) =>
                        template.id !== deleteTarget.id
                        && template.module_type_key === deleteTarget.module_type_key
                        && template.active
                    )
                    if (replacement) {
                        const replacementIdForPromotion = replacement.id
                        const { error: promoteError } = await runSupabaseAction('customTemplates.promoteBeforeDelete', () =>
                            supabase
                                .from('custom_templates')
                                .update({
                                    primary: true,
                                    updated_by: user?.id || null
                                })
                                .eq('id', replacementIdForPromotion)
                                .eq('workspace_id', workspaceId)
                        )
                        if (promoteError) throw normalizeSupabaseActionError(promoteError)
                    }
                }

                const { data: deletedRows, error: deleteError } = await runSupabaseAction('customTemplates.delete', () =>
                    supabase
                        .from('custom_templates')
                        .delete()
                        .eq('id', deleteTarget.id)
                        .eq('workspace_id', workspaceId)
                        .select('id')
                )
                if (deleteError) throw normalizeSupabaseActionError(deleteError)
                if (!deletedRows?.some((row) => row.id === deleteTarget.id)) {
                    throw new Error('The custom template was not found or you do not have permission to delete it.')
                }

                const deletedAt = new Date().toISOString()
                const replacementId = replacement?.id
                const remainingTemplates = templates
                    .filter((template) => template.id !== deleteTarget.id)
                    .map((template) => replacementId && template.id === replacementId
                        ? {
                            ...template,
                            primary: true,
                            updated_by: user?.id || null,
                            updated_at: deletedAt
                        }
                        : template
                    )
                setTemplates(remainingTemplates)
                if (isHybridMode) {
                    try {
                        await replaceMirroredCustomTemplates(workspaceId, remainingTemplates)
                    } catch (mirrorError) {
                        console.error('[CustomTemplates] Failed to update the local template mirror after deletion:', mirrorError)
                    }
                }

                if (imagePathsToDelete.length > 0 && r2Service.isConfigured()) {
                    const deleteResults = await Promise.allSettled(
                        imagePathsToDelete.map(async (path) => {
                            const r2Key = getR2KeyForStoredMediaPath(path, workspaceId)
                            if (r2Key) await r2Service.delete(r2Key)
                        })
                    )
                    deleteResults.forEach((result, index) => {
                        if (result.status === 'rejected') {
                            console.error(
                                '[CustomTemplates] Failed to delete template image from R2:',
                                imagePathsToDelete[index],
                                result.reason
                            )
                        }
                    })
                }
            }

            toast({
                title: t('customTemplates.deletedTitle', { defaultValue: 'Template deleted' }),
                description: t('customTemplates.deletedDescription', {
                    defaultValue: 'The custom print template was deleted successfully.'
                })
            })
            setDeleteTarget(null)
        } catch (deleteError) {
            toast({
                title: t('customTemplates.deleteErrorTitle', { defaultValue: 'Could not delete template' }),
                description: isLocalMode
                    ? (deleteError instanceof Error ? deleteError.message : String(deleteError))
                    : normalizeSupabaseActionError(deleteError).message,
                variant: 'destructive'
            })
        } finally {
            setIsDeleting(false)
        }
    }, [
        canManageTemplates,
        deleteTarget,
        fetchTemplates,
        isHybridMode,
        isDeleting,
        isLocalMode,
        t,
        templates,
        toast,
        user?.id,
        workspaceId
    ])

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
                        <FileText className="h-7 w-7" />
                        {t('customTemplates.title', { defaultValue: 'Custom Templates' })}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t('customTemplates.subtitle', {
                            defaultValue: 'Manage workspace print layout customizations by module and print type.'
                        })} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" className="gap-2" onClick={() => void fetchTemplates()} disabled={isLoading || !canPersistTemplates}>
                        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        {t('common.refresh', { defaultValue: 'Refresh' })}
                    </Button>
                    <Button className="gap-2" onClick={() => setIsAddOpen(true)} disabled={!canPersistTemplates || !canManageTemplates || availableTargets.length === 0}>
                        <Plus className="h-4 w-4" />
                        {t('customTemplates.addNew', { defaultValue: 'Add New Template' })}
                    </Button>
                </div>
            </div>

            {!isLocalMode && !isSupabaseConfigured && (
                <Card>
                    <CardContent className="py-6 text-sm text-muted-foreground">
                        {t('customTemplates.supabaseRequired', {
                            defaultValue: 'Supabase must be configured before custom templates can be saved in cloud or hybrid mode.'
                        })}
                    </CardContent>
                </Card>
            )}

            {error && (
                <Card className="border-destructive/40">
                    <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
                </Card>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>{t('customTemplates.existingTitle', { defaultValue: 'Existing Custom Templates' })}</CardTitle>
                    <CardDescription>
                        {t('customTemplates.existingDescription', {
                            defaultValue: 'Saved layout JSON is scoped to the current workspace and module/type key.'
                        })}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {isLoading ? (
                        <div className="flex min-h-48 items-center justify-center">
                            <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        </div>
                    ) : templates.length === 0 ? (
                        <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-md border border-dashed text-center">
                            <FileText className="h-8 w-8 text-muted-foreground" />
                            <div>
                                <p className="font-medium">
                                    {t('customTemplates.emptyTitle', { defaultValue: 'No custom templates yet' })}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {t('customTemplates.emptyDescription', {
                                        defaultValue: 'Create a print customization to save the first layout.'
                                    })}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('customTemplates.table.template', { defaultValue: 'Template' })}</TableHead>
                                    <TableHead>{t('customTemplates.table.key', { defaultValue: 'Module/Type Key' })}</TableHead>
                                    <TableHead>{t('customTemplates.table.layout', { defaultValue: 'Layout Items' })}</TableHead>
                                    <TableHead>{t('customTemplates.table.active', { defaultValue: 'Active' })}</TableHead>
                                    <TableHead>{t('customTemplates.table.primary', { defaultValue: 'Primary' })}</TableHead>
                                    <TableHead>{t('customTemplates.table.updated', { defaultValue: 'Updated' })}</TableHead>
                                    <TableHead className="text-end">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {templates.map((template) => {
                                    const target = getCustomTemplateTarget(template.module_type_key)
                                    const targetAvailable = availableTargets.some((item) => item.moduleTypeKey === template.module_type_key)
                                    const storedLayout = readStoredLayout(template)
                                    const templateLabel = template.label?.trim() || storedLayout?.label || getCustomTemplateDisplayName(template.module_type_key)
                                    const storedPrintLanguage = getStoredCustomTemplatePrintLanguage(template)
                                    const printLanguageWarning = getCustomTemplatePrintLanguageWarning(
                                        template,
                                        currentPrintLanguage,
                                        t
                                    )
                                    return (
                                        <TableRow key={template.id}>
                                            <TableCell>
                                                <div className="font-medium">{templateLabel}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    {getCustomTemplateDisplayName(template.module_type_key)}
                                                    {target?.description
                                                        ? ` - ${target.description}`
                                                        : ` - ${t('customTemplates.unknownTarget', { defaultValue: 'Custom print layout' })}`}
                                                </div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                    {t('customTemplates.printLanguageLabel', {
                                                        defaultValue: 'Print language: {{language}}',
                                                        language: storedPrintLanguage?.toUpperCase() || t('common.unknown', { defaultValue: 'Unknown' })
                                                    })}
                                                </div>
                                                {printLanguageWarning ? (
                                                    <div className="mt-2 flex max-w-xl items-start gap-1.5 rounded-md border border-amber-300/70 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                                                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                                        <span>{printLanguageWarning}</span>
                                                    </div>
                                                ) : null}
                                            </TableCell>
                                            <TableCell className="font-mono text-xs">{template.module_type_key}</TableCell>
                                            <TableCell>{countLayoutItems(template)}</TableCell>
                                            <TableCell>
                                                <Switch
                                                    checked={template.active}
                                                    onCheckedChange={(checked) => void updateTemplateStatus(template, { active: checked })}
                                                    disabled={!canPersistTemplates || !canManageTemplates}
                                                    aria-label={`Toggle ${templateLabel} active status`}
                                                />
                                            </TableCell>
                                            <TableCell>
                                                <Switch
                                                    checked={template.primary}
                                                    onCheckedChange={(checked) => {
                                                        if (checked) void updateTemplateStatus(template, { primary: true })
                                                    }}
                                                    disabled={!canPersistTemplates || !canManageTemplates || !template.active || template.primary}
                                                    aria-label={`Make ${templateLabel} primary`}
                                                />
                                            </TableCell>
                                            <TableCell>{formatDateTime(template.updated_at)}</TableCell>
                                            <TableCell className="text-end">
                                                <div className="flex justify-end gap-2">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="gap-2"
                                                        onClick={() => openPreview(template.module_type_key, template)}
                                                        disabled={!canPersistTemplates || !canManageTemplates || !targetAvailable}
                                                    >
                                                        <FileText className="h-4 w-4" />
                                                        {t('customTemplates.customize', { defaultValue: 'Customize' })}
                                                    </Button>
                                                    {canManageTemplates && (
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                            onClick={() => setDeleteTarget(template)}
                                                            disabled={!canPersistTemplates || isDeleting}
                                                            aria-label={t('customTemplates.deleteTemplate', {
                                                                defaultValue: 'Delete {{name}}',
                                                                name: templateLabel
                                                            })}
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('customTemplates.addTitle', { defaultValue: 'Add New Template' })}</DialogTitle>
                        <DialogDescription>
                            {t('customTemplates.addDescription', {
                                defaultValue: 'Select the module and print type to customize.'
                            })}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <p className="text-sm font-medium">
                                {t('customTemplates.moduleTypeLabel', { defaultValue: 'Module / Print Type' })}
                            </p>
                            <Select value={selectedModuleTypeKey} onValueChange={setSelectedModuleTypeKey}>
                                <SelectTrigger>
                                    <SelectValue placeholder={t('customTemplates.selectPlaceholder', { defaultValue: 'Select module/type' })} />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectGroup>
                                        <SelectLabel>{t('customTemplates.availableTypes', { defaultValue: 'Available Print Types' })}</SelectLabel>
                                        {availableTargets.map((target) => (
                                            <SelectItem key={target.moduleTypeKey} value={target.moduleTypeKey}>
                                                {getCustomTemplateDisplayName(target.moduleTypeKey)}
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                </SelectContent>
                            </Select>
                        </div>

                        {availableTargets.length === 0 && (
                            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                                {t('customTemplates.noSupportedTargets', {
                                    defaultValue: 'No supported print template types are available for this workspace.'
                                })}
                            </div>
                        )}

                        {selectedTarget && (
                            <div className="rounded-md border bg-muted/30 p-3 text-sm">
                                <div className="font-medium">{selectedTarget.moduleTypeKey}</div>
                                <div className="mt-1 text-muted-foreground">{selectedTarget.description}</div>
                            </div>
                        )}
                    </div>

                    <DialogFooter>
                        {selectedTarget && (
                            <Button className="gap-2" onClick={openSelectedTemplatePreview}>
                                {t('customTemplates.openPreview', { defaultValue: 'Open Print Preview' })}
                                <ArrowRight className="h-4 w-4" />
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={returnCloneSource !== null} onOpenChange={(open) => {
                if (!open) setReturnCloneSource(null)
            }}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t('customTemplates.returnClone.title', {
                            templateName: getCustomTemplateDisplayName(ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
                        })}</DialogTitle>
                        <DialogDescription>
                            {t('customTemplates.returnClone.description', {
                                templateName: getCustomTemplateDisplayName(ORDER_ATLAS_STANDARD_TEMPLATE_KEY)
                            })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                        <p>{t('customTemplates.returnClone.copied', {
                            defaultValue: 'Copied: page setup, positions, static text, photos, shapes, background, and table layout.'
                        })}</p>
                        <p className="mt-2">{t('customTemplates.returnClone.reset', {
                            defaultValue: 'Reset: document labels, column names, and dynamic field values for the return document.'
                        })}</p>
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button variant="outline" onClick={() => {
                            setReturnCloneSource(null)
                            openPreview(ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY)
                        }}>
                            {t('customTemplates.returnClone.defaults', { defaultValue: 'Start with Return defaults' })}
                        </Button>
                        <Button onClick={() => {
                            const returnLayout = returnCloneSource
                                ? cloneAtlasStandardOrderLayoutForReturn(returnCloneSource)
                                : null
                            setReturnCloneSource(null)
                            openPreview(ORDER_ATLAS_STANDARD_RETURN_TEMPLATE_KEY, undefined, returnLayout)
                        }}>
                            {t('customTemplates.returnClone.copy', { defaultValue: 'Copy layout' })}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={Boolean(deleteTarget)}
                onClose={() => {
                    if (!isDeleting) setDeleteTarget(null)
                }}
                onConfirm={() => void deleteTemplate()}
                isLoading={isDeleting}
                itemName={deleteTarget?.label}
                title={t('customTemplates.deleteTitle', { defaultValue: 'Delete Custom Template' })}
                description={t('customTemplates.deleteDescription', {
                    defaultValue: 'This permanently deletes the custom print template. This action cannot be undone.'
                })}
            />
        </div>
    )
}
