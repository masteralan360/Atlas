import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { ListTodo, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { ScrollIndicator } from "./ScrollIndicator"

type DialogLayout = "default" | "structured"

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean
    layout?: DialogLayout
    overlayClassName?: string
}

type PendingChangesContextValue = {
    pendingCount: number
    setPendingCount: (count: number) => void
}

const PendingChangesContext = React.createContext<PendingChangesContextValue | null>(null)
const DialogOpenContext = React.createContext(false)

type DialogRootProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>

const Dialog = ({ open, defaultOpen = false, onOpenChange, ...props }: DialogRootProps) => {
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
    const isOpen = open ?? uncontrolledOpen

    const handleOpenChange = React.useCallback((nextOpen: boolean) => {
        if (open === undefined) setUncontrolledOpen(nextOpen)
        onOpenChange?.(nextOpen)
    }, [onOpenChange, open])

    return (
        <DialogOpenContext.Provider value={isOpen}>
            <DialogPrimitive.Root
                {...props}
                open={open}
                defaultOpen={defaultOpen}
                onOpenChange={handleOpenChange}
            />
        </DialogOpenContext.Provider>
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

const DialogContent = React.forwardRef<
    React.ElementRef<typeof DialogPrimitive.Content>,
    DialogContentProps
>(({ className, children, showCloseButton = true, layout = "default", overlayClassName, ...props }, ref) => {
    const dialogOpen = React.useContext(DialogOpenContext)
    const { t, i18n } = useTranslation()
    const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null)
    const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null)
    const [pendingCount, setPendingCount] = React.useState(0)
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
        const content = contentNode
        if (content) {
            // Prefer an explicitly marked body so structured dialogs can keep
            // their header and footer fixed while the body scrolls.
            const markedScroller = content.querySelector<HTMLDivElement>("[data-dialog-scroll-area]")
            if (markedScroller) {
                setScroller(markedScroller)
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
        let baselineInterval: ReturnType<typeof window.setInterval> | undefined

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
                        layout === "structured" && "top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-0.75rem)] w-[calc(100vw-0.75rem)] max-w-3xl flex-col overflow-hidden rounded-[1.25rem] border-border/60 p-0 sm:w-full sm:max-h-[min(calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),820px)] sm:rounded-[1.75rem]",
                        className
                    )}
                    {...props}
                >
                    {children}
                    {layout === "default" && scroller && <ScrollIndicator containerRef={{ current: scroller }} />}
                    {showCloseButton ? (
                        <DialogPrimitive.Close className="absolute right-4 top-4 rtl:right-auto rtl:left-4 rounded-lg bg-destructive/10 p-1.5 text-destructive opacity-80 ring-offset-background transition-all hover:bg-destructive hover:text-destructive-foreground hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground z-[70]">
                            <X className="h-4 w-4" />
                            <span className="sr-only">Close</span>
                        </DialogPrimitive.Close>
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
            layout === "structured" && "border-b bg-muted/30 px-4 py-4 pr-14 text-start sm:px-6 sm:py-5",
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
    AppDialogContent,
    AppDialogHeader,
    AppDialogBody,
    AppDialogFooter,
    AppDialogTitle,
    AppDialogDescription,
    ScrollIndicator,
}
