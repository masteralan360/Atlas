import * as React from "react"
import { X } from "lucide-react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const ToastProvider = ToastPrimitives.Provider

const ToastViewport = React.forwardRef<
    React.ElementRef<typeof ToastPrimitives.Viewport>,
    React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
    <ToastPrimitives.Viewport
        ref={ref}
        className={cn(
            "pointer-events-none fixed bottom-0 right-0 z-[10010] flex max-h-screen w-full flex-col-reverse items-end gap-2 p-4 pb-[calc(var(--safe-area-bottom,0px)+1rem)] outline-none rtl:left-0 rtl:right-auto",
            className
        )}
        {...props}
    />
))
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const toastVariants = cva(
    "group pointer-events-auto relative flex w-full max-w-[420px] items-start justify-between gap-3 overflow-hidden rounded-2xl border p-4 pr-9 shadow-[0_10px_34px_-12px_rgba(0,0,0,0.3)] ring-1 ring-inset ring-black/5 backdrop-blur-xl transition-[transform,opacity] duration-300 ease-out data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
    {
        variants: {
            variant: {
                default:
                    "border-border/70 bg-background/85 text-foreground dark:border-border",
                destructive:
                    "border-red-500/40 bg-red-50/90 text-foreground dark:border-red-500/30 dark:bg-red-950/60",
                success:
                    "border-emerald-500/40 bg-emerald-50/90 text-foreground dark:border-emerald-500/30 dark:bg-emerald-950/60",
                warning:
                    "border-amber-500/40 bg-amber-50/90 text-foreground dark:border-amber-500/30 dark:bg-amber-950/60",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
)

type ToastMotion = 'default' | 'drop'

const Toast = React.forwardRef<
    React.ElementRef<typeof ToastPrimitives.Root>,
    React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants> & { motion?: ToastMotion }
>(({ className, variant, motion = 'default', ...props }, ref) => {
    return (
        <ToastPrimitives.Root
            ref={ref}
            className={cn(
                toastVariants({ variant }),
                motion === 'drop'
                    ? 'origin-top data-[state=open]:animate-toast-drop-in data-[state=closed]:animate-toast-drop-out'
                    : 'origin-bottom data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out',
                className
            )}
            {...props}
        />
    )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
    React.ElementRef<typeof ToastPrimitives.Action>,
    React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
    <ToastPrimitives.Action
        ref={ref}
        className={cn(
            "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 self-center rounded-lg border border-border/70 bg-background/60 px-3 text-xs font-semibold text-foreground backdrop-blur transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-red-500/30 group-[.destructive]:hover:bg-red-500 group-[.destructive]:hover:text-white group-[.destructive]:focus:ring-red-500 group-[.success]:border-emerald-500/30 group-[.success]:hover:bg-emerald-500 group-[.success]:hover:text-white group-[.warning]:border-amber-500/30 group-[.warning]:hover:bg-amber-500 group-[.warning]:hover:text-white",
            className
        )}
        {...props}
    />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
    React.ElementRef<typeof ToastPrimitives.Close>,
    React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
    <ToastPrimitives.Close
        ref={ref}
        className={cn(
            "absolute right-1.5 top-1.5 rounded-full p-1 text-muted-foreground/70 transition-all duration-200 hover:bg-black/5 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 dark:hover:bg-white/10",
            className
        )}
        toast-close=""
        {...props}
    >
        <X className="h-4 w-4" />
    </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
    React.ElementRef<typeof ToastPrimitives.Title>,
    React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
    <ToastPrimitives.Title
        ref={ref}
        className={cn("text-sm font-semibold leading-snug text-foreground", className)}
        {...props}
    />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
    React.ElementRef<typeof ToastPrimitives.Description>,
    React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
    <ToastPrimitives.Description
        ref={ref}
        className={cn("mt-0.5 text-[13px] leading-relaxed text-muted-foreground", className)}
        {...props}
    />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
    type ToastProps,
    type ToastActionElement,
    ToastProvider,
    ToastViewport,
    Toast,
    ToastTitle,
    ToastDescription,
    ToastClose,
    ToastAction,
}
