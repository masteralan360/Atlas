import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { NotionLikeEditor, type ExtensiveEditorRef } from '@lyfie/luthor'
import { ArrowLeft, CheckCircle2, Loader2, NotebookPen, Save, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { Button, Input } from '@/ui/components'
import { useTheme } from '@/ui/components/theme-provider'
import { getNotebookDocument, getNotebookStorageKey, saveNotebookDocument, type NotebookDocument } from '@/local-db/notebook'
import '@lyfie/luthor/styles.css'

const AUTOSAVE_INTERVAL_MS = 1500

function resolveEditorTheme(theme: 'dark' | 'light' | 'system'): 'dark' | 'light' {
    if (theme === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }

    return theme
}

export function Notebook() {
    const [, setLocation] = useLocation()
    const { user } = useAuth()
    const { theme } = useTheme()
    const { t } = useTranslation()
    const isMountedRef = useRef(true)
    const editorRef = useRef<ExtensiveEditorRef | null>(null)
    const storageKeyRef = useRef<string | null>(null)
    const titleRef = useRef('')
    const lastSavedRef = useRef<NotebookDocument | null>(null)

    const [title, setTitle] = useState('')
    const [initialContent, setInitialContent] = useState<string | undefined>(undefined)
    const [isLoading, setIsLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [saveStatus, setSaveStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading')
    const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)

    const formatSavedAt = useCallback((updatedAt: string | null) => {
        if (!updatedAt) {
            return t('notebook.status.localDraft') || 'Local draft'
        }

        const savedDate = new Date(updatedAt)
        if (Number.isNaN(savedDate.getTime())) {
            return t('notebook.status.localDraft') || 'Local draft'
        }

        return t('notebook.status.savedAt', {
            date: savedDate.toLocaleString()
        }) || `Saved ${savedDate.toLocaleString()}`
    }, [t])

    useEffect(() => {
        return () => {
            isMountedRef.current = false
        }
    }, [])

    const persistDocument = useCallback(async (force = false) => {
        const storageKey = storageKeyRef.current

        if (!storageKey) {
            return false
        }

        const content = editorRef.current?.getJSON() ?? lastSavedRef.current?.content ?? ''
        const nextTitle = titleRef.current.trim()
        const previous = lastSavedRef.current

        if (!force && previous?.title === nextTitle && previous?.content === content) {
            return false
        }

        if (isMountedRef.current) {
            setSaveStatus('saving')
        }

        const documentToSave: NotebookDocument = {
            title: nextTitle,
            content,
            updatedAt: new Date().toISOString()
        }

        try {
            await saveNotebookDocument(storageKey, documentToSave)
            lastSavedRef.current = documentToSave

            if (isMountedRef.current) {
                setLastSavedAt(documentToSave.updatedAt)
                setSaveStatus('saved')
            }

            return true
        } catch (error) {
            console.error('[Notebook] Failed to save notebook locally:', error)

            if (isMountedRef.current) {
                setSaveStatus('error')
            }

            return false
        }
    }, [])

    useEffect(() => {
        if (!user) {
            return
        }

        const storageKey = getNotebookStorageKey({
            workspaceId: user.workspaceId,
            userId: user.id
        })

        storageKeyRef.current = storageKey

        let cancelled = false

        async function loadNotebook() {
            setIsLoading(true)
            setLoadError(null)

            try {
                const document = await getNotebookDocument(storageKey)

                if (cancelled) {
                    return
                }

                const nextTitle = document?.title || ''
                titleRef.current = nextTitle
                setTitle(nextTitle)
                setInitialContent(document?.content || undefined)
                lastSavedRef.current = document
                setLastSavedAt(document?.updatedAt || null)
                setSaveStatus('saved')
            } catch (error) {
                console.error('[Notebook] Failed to load notebook:', error)

                if (cancelled) {
                    return
                }

                setLoadError(t('notebook.messages.loadError') || 'Failed to load your local notebook.')
                setSaveStatus('error')
            } finally {
                if (!cancelled) {
                    setIsLoading(false)
                }
            }
        }

        void loadNotebook()

        return () => {
            cancelled = true
        }
    }, [t, user])

    useEffect(() => {
        if (isLoading) {
            return
        }

        const interval = window.setInterval(() => {
            void persistDocument()
        }, AUTOSAVE_INTERVAL_MS)

        return () => {
            window.clearInterval(interval)
        }
    }, [isLoading, persistDocument])

    useEffect(() => {
        if (isLoading) {
            return
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                void persistDocument(true)
            }
        }

        const handleBeforeUnload = () => {
            void persistDocument(true)
        }

        document.addEventListener('visibilitychange', handleVisibilityChange)
        window.addEventListener('beforeunload', handleBeforeUnload)

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            window.removeEventListener('beforeunload', handleBeforeUnload)
            void persistDocument(true)
        }
    }, [isLoading, persistDocument])

    const handleBack = () => {
        if (window.history.length > 1) {
            window.history.back()
            return
        }

        setLocation('/')
    }

    const handleTitleChange = (value: string) => {
        titleRef.current = value
        setTitle(value)
    }

    return (
        <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-6">
            <section className="relative overflow-hidden rounded-[28px] border border-border/60 bg-card/90 p-5 shadow-xl shadow-primary/5 sm:p-6">
                <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-r from-primary/10 via-transparent to-emerald-500/10 pointer-events-none" />

                <div className="relative flex flex-col gap-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="flex items-start gap-3">
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleBack}
                                className="rounded-full border border-border/60 bg-background/70"
                                title={t('common.back') || 'Back'}
                            >
                                <ArrowLeft className="w-4 h-4" />
                            </Button>

                            <div className="space-y-2">
                                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.24em] text-primary/80">
                                    <NotebookPen className="w-4 h-4" />
                                    {t('notebook.label') || 'Notebook'}
                                </div>
                                <h1 className="text-2xl font-black tracking-tight text-foreground sm:text-3xl">
                                    {t('notebook.title') || 'Local notebook'}
                                </h1>
                                <p className="max-w-2xl text-sm text-muted-foreground">
                                    {t('notebook.description') || 'Rich notes stored only on this device. They are not saved to the database and do not sync to other devices.'}
                                </p>
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                                {saveStatus === 'saving' && (
                                    <>
                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                                        {t('notebook.status.saving') || 'Saving locally'}
                                    </>
                                )}
                                {saveStatus === 'saved' && (
                                    <>
                                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                        {formatSavedAt(lastSavedAt)}
                                    </>
                                )}
                                {saveStatus === 'error' && (
                                    <>
                                        <TriangleAlert className="w-3.5 h-3.5 text-amber-500" />
                                        {t('notebook.status.saveFailed') || 'Save failed'}
                                    </>
                                )}
                                {saveStatus === 'loading' && (
                                    <>
                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                                        {t('notebook.status.loading') || 'Loading notebook'}
                                    </>
                                )}
                            </div>

                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-2 rounded-full"
                                onClick={() => {
                                    void persistDocument(true)
                                }}
                                disabled={isLoading}
                            >
                                <Save className="w-3.5 h-3.5" />
                                {t('notebook.actions.saveNow') || 'Save now'}
                            </Button>
                        </div>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
                        <div className="rounded-[24px] border border-border/70 bg-background/75 backdrop-blur-sm">
                            <div className="border-b border-border/60 px-4 py-4 sm:px-6">
                                <Input
                                    value={title}
                                    onChange={(event) => handleTitleChange(event.target.value)}
                                    placeholder={t('notebook.fields.titlePlaceholder') || 'Notebook title'}
                                    className="h-auto border-0 bg-transparent px-0 text-2xl font-black tracking-tight shadow-none focus-visible:ring-0 sm:text-3xl"
                                />
                            </div>

                            <div className="p-4 sm:p-6">
                                {isLoading ? (
                                    <div className="flex min-h-[60vh] items-center justify-center rounded-[20px] border border-dashed border-border/70 bg-muted/20">
                                        <div className="flex items-center gap-3 text-sm text-muted-foreground">
                                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                                            {t('notebook.messages.loadingEditor') || 'Loading notebook editor...'}
                                        </div>
                                    </div>
                                ) : (
                                    <NotionLikeEditor
                                        className="[&_.luthor-editor]:min-h-[60vh] [&_.luthor-editor]:rounded-[20px] [&_.luthor-editor]:border [&_.luthor-editor]:border-border/70 [&_.luthor-editor]:bg-card [&_.luthor-editor-header]:mb-4 [&_.luthor-richtext-container]:min-h-[52vh]"
                                        defaultContent={initialContent}
                                        initialTheme={resolveEditorTheme(theme)}
                                        availableModes={['visual']}
                                        isToolbarEnabled
                                        onReady={(methods) => {
                                            editorRef.current = methods
                                        }}
                                        placeholder={t('notebook.fields.editorPlaceholder') || "Start writing, or type '/' for commands..."}
                                        toolbarAlignment="left"
                                        toolbarPosition="top"
                                        featureFlags={{
                                            image: false,
                                            iframeEmbed: false,
                                            youTubeEmbed: false,
                                            themeToggle: false
                                        }}
                                    />
                                )}
                            </div>
                        </div>

                        <aside className="rounded-[24px] border border-border/70 bg-background/75 p-5 backdrop-blur-sm sm:p-6">
                            <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-muted-foreground">
                                {t('notebook.sections.notes') || 'Notes'}
                            </h2>
                            <div className="mt-4 space-y-3 text-sm leading-6">
                                <div className="rounded-2xl border border-border/60 bg-card/70 p-4">
                                    <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">EN</p>
                                    <p className="mt-2 text-foreground/90">
                                        These notes stay only on this device and will not be saved to the database.
                                    </p>
                                </div>
                                <div dir="rtl" className="rounded-2xl border border-border/60 bg-card/70 p-4 text-right">
                                    <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">AR</p>
                                    <p className="mt-2 text-foreground/90">
                                        هذه الملاحظات تبقى على هذا الجهاز فقط ولن يتم حفظها في قاعدة البيانات.
                                    </p>
                                </div>
                                <div dir="rtl" className="rounded-2xl border border-border/60 bg-card/70 p-4 text-right">
                                    <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">KU</p>
                                    <p className="mt-2 text-foreground/90">
                                        ئەم تێبینییانە تەنها لەم ئامێرەدا دەمێننەوە و لە داتابەیس یان سێرڤەر هەژمار ناکرێت.
                                    </p>
                                </div>
                            </div>

                            {loadError && (
                                <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                                    {loadError}
                                </div>
                            )}
                        </aside>
                    </div>
                </div>
            </section>
        </div>
    )
}

export default Notebook
