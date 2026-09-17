import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { ScrollIndicator } from "./ScrollIndicator"

type DialogLayout = "default" | "structured"

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    showCloseButton?: boolean
    layout?: DialogLayout
    overlayClassName?: string
}

const Dialog = DialogPrimitive.Root

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
    const internalRef = React.useRef<HTMLDivElement>(null)
    const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null)

    React.useLayoutEffect(() => {
        const content = internalRef.current
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
    }, [children])

    return (
        <DialogPortal>
            <DialogOverlay className={overlayClassName} />
            <DialogPrimitive.Content
                ref={(node) => {
                    // Handle both the forwarded ref and our internal ref
                    if (typeof ref === 'function') ref(node)
                    else if (ref) (ref as any).current = node
                        ; (internalRef as any).current = node
                }}
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
    ...props
}: React.HTMLAttributes<HTMLDivElement> & { layout?: DialogLayout }) => (
    <div
        className={cn(
            "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
            layout === "structured" && "border-t bg-muted/20 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-between sm:px-6",
            className
        )}
        {...props}
    />
)
DialogFooter.displayName = "DialogFooter"

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
