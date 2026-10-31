import * as React from "react"

import { cn } from "@/lib/utils"
import {
    Dialog,
    DialogBody,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogOverlay,
    DialogPortal,
    DialogTitle,
    DialogTrigger
} from "./dialog"

/**
 * Dialog primitives for focused, compact interactions.
 *
 * This shares the accessible Radix integration used by `Dialog`, while keeping
 * small modals centered and compact on mobile and desktop.
 */
const SmallDialog = Dialog

const SmallDialogTrigger = DialogTrigger

const SmallDialogPortal = DialogPortal

const SmallDialogOverlay = DialogOverlay

const SmallDialogClose = DialogClose

const SmallDialogContent = React.forwardRef<
    React.ElementRef<typeof DialogContent>,
    React.ComponentPropsWithoutRef<typeof DialogContent>
>(({ className, ...props }, ref) => (
    <DialogContent
        ref={ref}
        {...props}
        className={cn(
            "sm:max-w-md max-sm:top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] max-sm:w-[calc(100vw-2rem)] max-sm:max-h-[calc(var(--atlas-dialog-viewport-height)-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem)] max-sm:overflow-y-auto max-sm:rounded-xl",
            className
        )}
        mobileFullscreen={false}
    />
))
SmallDialogContent.displayName = "SmallDialogContent"

const SmallDialogHeader = DialogHeader

const SmallDialogBody = DialogBody

const SmallDialogFooter = DialogFooter

const SmallDialogTitle = DialogTitle

const SmallDialogDescription = DialogDescription

export {
    SmallDialog,
    SmallDialogPortal,
    SmallDialogOverlay,
    SmallDialogTrigger,
    SmallDialogClose,
    SmallDialogContent,
    SmallDialogHeader,
    SmallDialogBody,
    SmallDialogFooter,
    SmallDialogTitle,
    SmallDialogDescription
}
