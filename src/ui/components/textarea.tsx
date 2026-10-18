import * as React from "react"
import { cn, convertArabicIndicToLatin } from "@/lib/utils"
import { useAuthRole } from "@/auth/AuthRoleContext"

export interface TextareaProps
    extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { }


export interface TextareaProps
    extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { }

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps & { allowViewer?: boolean }>(
    ({ className, allowViewer = false, disabled, ...props }, ref) => {
        const isViewer = useAuthRole() === 'viewer'
        const effectiveDisabled = disabled || (isViewer && !allowViewer)

        const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
            event.target.value = convertArabicIndicToLatin(event.target.value)
            props.onChange?.(event)
        }

        return (
            <textarea
                className={cn(
                    "flex min-h-[60px] w-full rounded-xl border border-border/80 bg-background/80 px-3 py-2 text-base shadow-sm shadow-black/[0.03] placeholder:text-muted-foreground transition-all hover:border-primary/45 hover:bg-background focus-visible:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-background/50 md:text-sm",
                    className
                )}
                ref={ref}
                disabled={effectiveDisabled}
                {...props}
                onChange={handleChange}
            />
        )
    }
)
Textarea.displayName = "Textarea"

export { Textarea }
