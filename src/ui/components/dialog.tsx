import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Eye, EyeOff, ListTodo, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { ScrollIndicator } from "./ScrollIndicator"

type DialogLayout = "default" | "structured"

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean
    layout?: DialogLayout
    overlayClassName?: string
    mobileFullscreen?: boolean
}

type PendingChangesContextValue = {
    pendingCount: number
    setPendingCount: (count: number) => void
}

const PendingChangesContext = React.createContext<PendingChangesContextValue | null>(null)
const DialogOpenContext = React.createContext(false)

type DialogInsightProps = {
    /** Show the optional dialog insight panel on desktop viewports (1024px and wider). Defaults to false. */
    showInsight?: boolean
    /** CSS background color for the insight panel. Defaults to the Add Product Discount green gradient. */
    insightColor?: React.CSSProperties["backgroundColor"]
    /** Module-owned content rendered inside the insight panel. */
    insightContent?: React.ReactNode
    /** Plain-language save outcome from the module, automatically wrapped in the localized Preview card. */
    insightPreview?: React.ReactNode
    /** Optional classes for module-specific panel styling. */
    insightPanelClassName?: string
}

type DialogInsightContextValue = {
    /** The module requested insight and the viewport is large enough to show it. */
    isAvailable: boolean
    /** Insight is currently visible after applying the shared user preference. */
    showInsight: boolean
    toggleVisibility: () => void
} &
    Pick<DialogInsightProps, "insightColor" | "insightContent" | "insightPreview" | "insightPanelClassName">

const DialogInsightContext = React.createContext<DialogInsightContextValue>({
    isAvailable: false,
    showInsight: false,
    toggleVisibility: () => undefined,
})
const DESKTOP_INSIGHT_MEDIA_QUERY = "(min-width: 1024px)"
const INSIGHT_VISIBILITY_STORAGE_KEY = "showInsight"
const insightPreferenceSubscribers = new Set<() => void>()
let inMemoryInsightPreference: boolean | undefined

const readInsightPreference = () => {
    if (typeof window === "undefined") return true
    try {
        const storedPreference = window.localStorage.getItem(INSIGHT_VISIBILITY_STORAGE_KEY)
        if (storedPreference !== null) return storedPreference !== "false"
    } catch { /* Fall back to this session if local storage is unavailable. */ }
    return inMemoryInsightPreference ?? true
}

const subscribeToInsightPreference = (subscriber: () => void) => {
    insightPreferenceSubscribers.add(subscriber)
    const handleStorage = (event: StorageEvent) => {
        if (event.key !== INSIGHT_VISIBILITY_STORAGE_KEY && event.key !== null) return
        inMemoryInsightPreference = event.newValue === null
            ? undefined
            : event.newValue !== "false"
        subscriber()
    }
    window.addEventListener("storage", handleStorage)

    return () => {
        insightPreferenceSubscribers.delete(subscriber)
        window.removeEventListener("storage", handleStorage)
    }
}

const writeInsightPreference = (showInsight: boolean) => {
    inMemoryInsightPreference = showInsight
    try {
        window.localStorage.setItem(INSIGHT_VISIBILITY_STORAGE_KEY, String(showInsight))
    } catch {
        // Keep the in-memory preference working when storage is unavailable.
    }
    insightPreferenceSubscribers.forEach(subscriber => subscriber())
}

const useDesktopInsightAvailability = (requested: boolean) => {
    const [isDesktop, setIsDesktop] = React.useState(() => (
        requested
        && typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia(DESKTOP_INSIGHT_MEDIA_QUERY).matches
    ))

    React.useEffect(() => {
        if (!requested || typeof window === "undefined" || typeof window.matchMedia !== "function") {
            setIsDesktop(false)
            return
        }

        const mediaQuery = window.matchMedia(DESKTOP_INSIGHT_MEDIA_QUERY)
        const updateAvailability = () => setIsDesktop(mediaQuery.matches)
        updateAvailability()
        mediaQuery.addEventListener("change", updateAvailability)

        return () => mediaQuery.removeEventListener("change", updateAvailability)
    }, [requested])

    return isDesktop
}

type DialogRootProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> & DialogInsightProps

const Dialog = ({
    open,
    defaultOpen = false,
    onOpenChange,
    showInsight = false,
    insightColor,
    insightContent,
    insightPreview,
    insightPanelClassName,
    ...props
}: DialogRootProps) => {
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
    const isOpen = open ?? uncontrolledOpen
    const isDesktopInsightViewport = useDesktopInsightAvailability(showInsight)
    const insightPreference = React.useSyncExternalStore(
        subscribeToInsightPreference,
        readInsightPreference,
        () => true
    )
    const isInsightAvailable = showInsight && isDesktopInsightViewport
    const showDesktopInsight = isInsightAvailable && insightPreference

    const toggleInsightVisibility = React.useCallback(() => {
        writeInsightPreference(!readInsightPreference())
    }, [])

    const handleOpenChange = React.useCallback((nextOpen: boolean) => {
        if (open === undefined) setUncontrolledOpen(nextOpen)
        onOpenChange?.(nextOpen)
    }, [onOpenChange, open])

    const insightConfig = React.useMemo(() => ({
        isAvailable: isInsightAvailable,
        showInsight: showDesktopInsight,
        toggleVisibility: toggleInsightVisibility,
        insightColor,
        insightContent,
        insightPreview,
        insightPanelClassName,
    }), [insightColor, insightContent, insightPanelClassName, insightPreview, showDesktopInsight, isInsightAvailable, toggleInsightVisibility])

    return (
        <DialogInsightContext.Provider value={insightConfig}>
            <DialogOpenContext.Provider value={isOpen}>
                <DialogPrimitive.Root
                    {...props}
                    open={open}
                    defaultOpen={defaultOpen}
                    onOpenChange={handleOpenChange}
                />
            </DialogOpenContext.Provider>
        </DialogInsightContext.Provider>
    )
}

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Overlay>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Overlay
        ref={ref}
        className={cn(
            "fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            className
        )}
        {...props}
    />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

type DialogInsightPreviewProps = React.HTMLAttributes<HTMLElement> & {
    children: React.ReactNode
}

const DialogInsightPreview = ({ className, children, ...props }: DialogInsightPreviewProps) => {
    const { t } = useTranslation()
    const titleId = React.useId()

    return (
        <section aria-labelledby={titleId} className={cn("mt-4 space-y-2", className)} {...props}>
            <h3 id={titleId} className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">
                {t("common.dialogInsightPreview")}
            </h3>
            <div className="rounded-2xl bg-white/10 p-4 text-lg font-semibold text-white">
                {children}
            </div>
        </section>
    )
}

const DialogContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    DialogContentProps
>(({ className, children, showCloseButton = true, layout = "default", overlayClassName, mobileFullscreen = true, ...props }, ref) => {
    const dialogOpen = React.useContext(DialogOpenContext)
    const insight = React.useContext(DialogInsightContext)
    const hasInsightBody = React.Children.toArray(insight.insightContent).length > 0
    const hasInsightPreview = React.Children.toArray(insight.insightPreview).length > 0
    const hasInsightContent = hasInsightBody || hasInsightPreview
    const { t, i18n } = useTranslation()
    const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null)
    const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null)
    const [pendingCount, setPendingCount] = React.useState(0)
    const insightPanelRef = React.useRef<HTMLElement | null>(null)
    const insightToggleRef = React.useRef<HTMLButtonElement | null>(null)
    const contentRef = React.useCallback((node: HTMLDivElement | null) => {
        setContentNode(node)
        if (typeof ref === "function") ref(node)
        else if (ref) ref.current = node
    }, [ref])
    const pendingChanges = React.useMemo(() => ({
        pendingCount,
        setPendingCount,
    }), [pendingCount])

    React.useLayoutEffect(() => {
        const panel = insightPanelRef.current
        if (!panel) return

        const focusWasInsidePanel = panel.contains(document.activeElement)
        panel.inert = !insight.showInsight
        if (!insight.showInsight && focusWasInsidePanel) {
            const focusTarget = insightToggleRef.current ?? contentNode
            focusTarget?.focus({ preventScroll: true })
        }
    }, [contentNode, insight.showInsight])

    React.useLayoutEffect(() => {
        const content = contentNode
        if (content) {
            // Prefer an explicitly marked body so structured dialogs can keep
            // their header and footer fixed while the body scrolls.
            const markedScroller = content.querySelector<HTMLDivElement>("[data-dialog-scroll-area]")
            if (markedScroller) {
                setScroller(markedScroller)
                return
            }

            const insightMain = content.querySelector<HTMLDivElement>("[data-dialog-insight-main]")
            if (insightMain && window.getComputedStyle(insightMain).overflowY === "auto") {
                setScroller(insightMain)
                return
            }

            // Try to find if the content itself is the scroller.
            const style = window.getComputedStyle(content)
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                setScroller(content)
                return
            }

            // Otherwise check the first child for backwards compatibility.
            const firstChild = content.firstElementChild as HTMLDivElement
            if (firstChild) {
                const childStyle = window.getComputedStyle(firstChild)
                if (childStyle.overflowY === 'auto' || childStyle.overflowY === 'scroll') {
                    setScroller(firstChild)
                    return
                }
            }

            setScroller(null)
        }
    }, [children, contentNode])

    React.useEffect(() => {
        const content = contentNode
        if (!dialogOpen || !content) {
            setPendingCount(0)
            return
        }

        const title = content.querySelector<HTMLElement>("[data-dialog-title]")?.textContent?.trim().toLocaleLowerCase() ?? ""
        const editPrefix = t("common.edit", { defaultValue: "Edit" }).trim().toLocaleLowerCase()
        const language = (i18n.resolvedLanguage ?? i18n.language).toLowerCase()
        const editPrefixes = [
            editPrefix,
            "edit",
            ...(language.startsWith("en") ? ["editing"] : []),
            ...(language.startsWith("ku") ? ["دەستکاری"] : []),
        ]
        const isEditDialog = editPrefixes.some(prefix =>
            title === prefix || title.startsWith(`${prefix} `) || title.startsWith(`${prefix}:`)
        )
        if (!isEditDialog) {
            setPendingCount(0)
            return
        }

        const fieldSelector = [
            "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='file'])",
            "textarea",
            "select",
            "[role='combobox']",
            "[role='switch']",
            "[role='checkbox']",
            "[role='radio']",
            "[role='slider']",
            "button[aria-haspopup='dialog']",
        ].join(",")

        const readFieldValue = (element: HTMLElement) => {
            if (element instanceof HTMLInputElement) {
                if (element.type === "checkbox" || element.type === "radio") return String(element.checked)
                return element.value
            }
            if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value
            if (element.getAttribute("role") === "switch" || element.getAttribute("role") === "checkbox" || element.getAttribute("role") === "radio") {
                return element.getAttribute("aria-checked") ?? element.getAttribute("data-state") ?? "false"
            }
            if (element.getAttribute("role") === "slider") {
                return element.getAttribute("aria-valuenow") ?? ""
            }
            return element.textContent?.replace(/\s+/g, " ").trim() ?? ""
        }

        const getFieldIdentity = (element: HTMLElement, index: number) => {
            const namedElement = element as HTMLInputElement
            const label = "labels" in element
                ? Array.from((element as HTMLInputElement).labels ?? []).map(item => item.textContent?.trim()).filter(Boolean).join(" ")
                : ""
            const identity = element.dataset.pendingChangeId
                || element.id
                || namedElement.name
                || element.getAttribute("aria-label")
                || element.getAttribute("aria-labelledby")
                || label
                || `${element.tagName.toLowerCase()}:${element.getAttribute("role") ?? "field"}:${index}`
            return identity
        }

        const readFields = () => {
            const elements = Array.from(content.querySelectorAll<HTMLElement>(fieldSelector))
                .filter(element => !element.closest("[data-pending-change-ignore='true']"))
            const occurrences = new Map<string, number>()
            const values = new Map<string, string>()
            elements.forEach((element, index) => {
                const identity = getFieldIdentity(element, index)
                const occurrence = occurrences.get(identity) ?? 0
                occurrences.set(identity, occurrence + 1)
                values.set(`${identity}::${occurrence}`, readFieldValue(element))
            })
            return values
        }

        const baseline = readFields()
        setPendingCount(0)
        let hasUserInteracted = false
        let frame = 0
        let baselineInterval: number | undefined

        const updateCount = () => {
            const current = readFields()
            let count = 0
            current.forEach((value, key) => {
                if (baseline.has(key) && baseline.get(key) !== value) count += 1
            })
            setPendingCount(count)
        }

        const scheduleUpdate = () => {
            if (frame) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                frame = 0
                if (!hasUserInteracted) {
                    // Rebase async form hydration that completes after the dialog opens.
                    baseline.clear()
                    const current = readFields()
                    current.forEach((value, key) => baseline.set(key, value))
                    setPendingCount(0)
                    return
                }
                updateCount()
            })
        }

        const markInteraction = (event: Event) => {
            if (!event.isTrusted) return
            const target = event.target
            if (!(target instanceof Element)) return
            const field = target.closest<HTMLElement>(fieldSelector)
            if (!field || !content.contains(field)) return
            if (["click", "keydown", "pointerdown"].includes(event.type) && field.matches("input, textarea, select")) return
            hasUserInteracted = true
            if (baselineInterval !== undefined) window.clearInterval(baselineInterval)
            scheduleUpdate()
        }

        content.addEventListener("input", markInteraction, true)
        content.addEventListener("change", markInteraction, true)
        content.addEventListener("click", markInteraction, true)
        content.addEventListener("keydown", markInteraction, true)
        content.addEventListener("pointerdown", markInteraction, true)

        const observer = new MutationObserver(scheduleUpdate)
        observer.observe(content, { subtree: true, childList: true, characterData: true, attributes: true })
        // Controlled input values can hydrate in a parent effect without a DOM
        // mutation. Keep the initial snapshot current until the first user edit.
        baselineInterval = window.setInterval(() => {
            if (hasUserInteracted) return
            baseline.clear()
            const current = readFields()
            current.forEach((value, key) => baseline.set(key, value))
            setPendingCount(0)
        }, 100)

        return () => {
            if (frame) cancelAnimationFrame(frame)
            if (baselineInterval !== undefined) window.clearInterval(baselineInterval)
            content.removeEventListener("input", markInteraction, true)
            content.removeEventListener("change", markInteraction, true)
            content.removeEventListener("click", markInteraction, true)
            content.removeEventListener("keydown", markInteraction, true)
            content.removeEventListener("pointerdown", markInteraction, true)
            observer.disconnect()
            setPendingCount(0)
        }
    }, [contentNode, dialogOpen, i18n.language, i18n.resolvedLanguage, t])

    return (
        <DialogPortal>
            <DialogOverlay className={overlayClassName} />
            <PendingChangesContext.Provider value={pendingChanges}>
                <DialogPrimitive.Content
                    ref={contentRef}
                    className={cn(
                        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
                        layout === "structured" && "top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] flex max-h-[calc(var(--atlas-dialog-viewport-height)-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-0.75rem)] w-[calc(100vw-0.75rem)] max-w-3xl flex-col overflow-hidden rounded-[1.25rem] border-border/60 p-0 sm:w-full sm:max-h-[min(calc(var(--atlas-dialog-viewport-height)-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),820px)] sm:rounded-[1.75rem]",
                        className,
                        insight.isAvailable && "flex max-h-[calc(var(--atlas-dialog-viewport-height)-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem)] w-[calc(100vw-0.75rem)] flex-col overflow-hidden p-0 transition-[max-width] duration-200 ease-in-out sm:w-[calc(100vw-2rem)] sm:max-h-[min(calc(var(--atlas-dialog-viewport-height)-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),920px)]",
                        insight.isAvailable && (insight.showInsight ? "max-w-5xl" : "max-w-3xl"),
                        mobileFullscreen && "max-sm:!left-0 max-sm:!right-0 max-sm:!top-[var(--titlebar-height)] max-sm:!bottom-0 max-sm:!h-[calc(var(--atlas-dialog-viewport-height)-var(--titlebar-height))] max-sm:!max-h-[calc(var(--atlas-dialog-viewport-height)-var(--titlebar-height))] max-sm:!w-screen max-sm:!max-w-none max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!rounded-none max-sm:!border-0",
                        mobileFullscreen && (layout === "structured" ? "max-sm:!overflow-hidden" : "max-sm:!overflow-y-auto")
                    )}
                    {...props}
                >
                    {insight.isAvailable ? (
                        <div className={cn(
                            "grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-0 transition-[grid-template-columns] duration-200 ease-in-out",
                            insight.showInsight
                                ? "lg:grid-cols-[minmax(0,1fr)_20rem]"
                                : "lg:grid-cols-[minmax(0,1fr)_0fr]"
                        )}>
                            <div className={cn(
                                "min-h-0 min-w-0",
                                layout === "structured" ? "flex flex-col" : "flex-1 overflow-y-auto"
                            )} data-dialog-insight-main="">
                                {children}
                            </div>
                            <aside
                                ref={insightPanelRef}
                                aria-hidden={!insight.showInsight || !hasInsightContent}
                                aria-label={insight.showInsight && hasInsightContent ? t("common.dialogInsights") : undefined}
                                className={cn(
                                    "min-h-0 min-w-0 overflow-hidden transition-[opacity,transform] duration-200 ease-in-out lg:rounded-e-[inherit]",
                                    insight.showInsight ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-2 opacity-0",
                                    insight.insightColor
                                        ? "bg-none"
                                        : "atlas-insight-surface text-white",
                                    insight.insightPanelClassName
                                )}
                                style={insight.insightColor ? { backgroundColor: insight.insightColor } : undefined}
                            >
                                <div className="h-full w-80 overflow-y-auto p-4 sm:p-6 lg:pe-14">
                                    {insight.showInsight && hasInsightBody ? (
                                        <div
                                            data-dialog-insight-content
                                            className="space-y-4 font-medium [&_h3]:text-2xl [&_h3]:font-semibold [&_h3]:leading-tight [&_h3]:tracking-tight [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-emerald-100/85"
                                        >
                                            {insight.insightContent}
                                        </div>
                                    ) : null}
                                    {insight.showInsight && hasInsightPreview ? (
                                        <DialogInsightPreview className={hasInsightBody ? undefined : "mt-0"}>
                                            {insight.insightPreview}
                                        </DialogInsightPreview>
                                    ) : null}
                                </div>
                            </aside>
                        </div>
                    ) : children}
                    {layout === "default" && scroller && <ScrollIndicator containerRef={{ current: scroller }} />}
                    {showCloseButton ? (
                        <DialogPrimitive.Close className="absolute right-4 top-[calc(1rem+var(--safe-area-top))] rtl:right-auto rtl:left-4 rounded-lg bg-destructive/10 p-1.5 text-destructive opacity-80 ring-offset-background transition-all hover:bg-destructive hover:text-destructive-foreground hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground z-[70]">
                            <X className="h-4 w-4" />
                            <span className="sr-only">Close</span>
                        </DialogPrimitive.Close>
                    ) : null}
                    {insight.isAvailable ? (
                        <button
                            ref={insightToggleRef}
                            type="button"
                            aria-label={insight.showInsight ? t("common.hideDialogInsights") : t("common.showDialogInsights")}
                            aria-pressed={insight.showInsight}
                            title={insight.showInsight ? t("common.hideDialogInsights") : t("common.showDialogInsights")}
                            onClick={insight.toggleVisibility}
                            className={cn(
                                "absolute top-[calc(1rem+var(--safe-area-top))] z-[70] rounded-lg bg-muted/70 p-1.5 text-muted-foreground opacity-90 ring-offset-background transition-all hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                                showCloseButton ? "right-14 rtl:right-auto rtl:left-14" : "right-4 rtl:right-auto rtl:left-4"
                            )}
                        >
                            {insight.showInsight ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
                            <span className="sr-only">{insight.showInsight ? t("common.hideDialogInsights") : t("common.showDialogInsights")}</span>
                        </button>
                    ) : null}
                </DialogPrimitive.Content>
            </PendingChangesContext.Provider>
        </DialogPortal>
    )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
    className,
    layout = "default",
    ...props
}: React.HTMLAttributes<HTMLDivElement> & { layout?: DialogLayout }) => (
    <div
        className={cn(
            "flex flex-col space-y-1.5 text-center sm:text-start",
            layout === "structured" && "border-b bg-muted/30 px-4 py-4 pr-14 pt-[calc(1rem+var(--safe-area-top))] text-start sm:px-6 sm:py-5",
            className
        )}
        {...props}
    />
)
DialogHeader.displayName = "DialogHeader"

const DialogBody = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        data-dialog-scroll-area
        className={cn(
            "min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6",
            className
        )}
        {...props}
    />
))
DialogBody.displayName = "DialogBody"

const DialogFooter = ({
    className,
    layout = "default",
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & { layout?: DialogLayout }) => (
    <PendingChangesFooter className={className} layout={layout} {...props}>
        {children}
    </PendingChangesFooter>
)
DialogFooter.displayName = "DialogFooter"

const PendingChangesFooter = ({
    className,
    layout = "default",
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & { layout: DialogLayout }) => {
    const pendingChanges = React.useContext(PendingChangesContext)
    const { t } = useTranslation()
    const count = pendingChanges?.pendingCount ?? 0

    return (
        <div
            className={cn(
                "flex flex-col-reverse gap-2 sm:flex-row sm:gap-0 sm:justify-end sm:space-x-2",
                layout === "structured" && "border-t bg-muted/20 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-between sm:px-6",
                className
            )}
            {...props}
        >
            {count > 0 ? (
                <span aria-live="polite" aria-atomic="true" className="order-last inline-flex items-center gap-2 self-start text-sm font-medium text-yellow-700 dark:text-yellow-300 sm:order-first sm:mr-auto sm:self-center">
                    <ListTodo aria-hidden="true" className="h-4 w-4" />
                    {count === 1
                        ? t("common.pendingChangeSingular", { defaultValue: "1 Pending Change" })
                        : t("common.pendingChangePlural", { count, defaultValue: "{{count}} Pending Changes" })}
                </span>
            ) : null}
            {children}
        </div>
    )
}

/**
 * Atlas's standard dialog façade. Use these components for workflow, form,
 * and detail dialogs so their shell, header, and footer stay consistent.
 *
 * Use the base Dialog primitives only for an intentional compact or custom
 * interaction (for example, a one-purpose confirmation dialog).
 */
type AppDialogContentProps = Omit<DialogContentProps, "layout">
type AppDialogRegionProps = Omit<React.ComponentPropsWithoutRef<typeof DialogHeader>, "layout">

const AppDialog = Dialog

const AppDialogContent = React.forwardRef<
    React.ElementRef<typeof DialogContent>,
    AppDialogContentProps
>(({ className, ...props }, ref) => (
    <DialogContent ref={ref} className={className} {...props} layout="structured" />
))
AppDialogContent.displayName = "AppDialogContent"

const AppDialogHeader = ({ className, ...props }: AppDialogRegionProps) => (
    <DialogHeader className={className} {...props} layout="structured" />
)
AppDialogHeader.displayName = "AppDialogHeader"

const AppDialogBody = DialogBody

const AppDialogFooter = ({ className, ...props }: AppDialogRegionProps) => (
    <DialogFooter className={className} {...props} layout="structured" />
)
AppDialogFooter.displayName = "AppDialogFooter"

const DialogTitle = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Title>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Title
        ref={ref}
        className={cn(
            "text-lg font-semibold leading-none tracking-tight",
            className
        )}
        {...props}
        data-dialog-title=""
    />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Description>,
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
    <DialogPrimitive.Description
        ref={ref}
        className={cn("text-sm text-muted-foreground", className)}
        {...props}
    />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

const AppDialogTitle = DialogTitle
const AppDialogDescription = DialogDescription

export {
    Dialog,
    DialogPortal,
    DialogOverlay,
    DialogTrigger,
    DialogClose,
    DialogContent,
    DialogHeader,
    DialogBody,
    DialogFooter,
    DialogTitle,
    DialogDescription,
    AppDialog,
    DialogInsightPreview,
    AppDialogContent,
    AppDialogHeader,
    AppDialogBody,
    AppDialogFooter,
    AppDialogTitle,
    AppDialogDescription,
    ScrollIndicator,
}
