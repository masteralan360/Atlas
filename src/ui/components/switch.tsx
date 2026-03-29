import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

import { useTranslation } from "react-i18next"
import { useOptionalAuth } from "@/auth"

const Switch = React.forwardRef<
    React.ElementRef<typeof SwitchPrimitives.Root>,
    React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & { allowViewer?: boolean }
>(({ className, allowViewer = false, disabled, ...props }, ref) => {
    const user = useOptionalAuth()?.user
    const isViewer = user?.role === 'viewer'
    const effectiveDisabled = disabled || (isViewer && !allowViewer)
    const { i18n } = useTranslation()
    const dir = i18n.language === 'ar' || i18n.language === 'ku' ? 'rtl' : 'ltr'
    
    return (
        <SwitchPrimitives.Root
            dir={dir}
            className={cn(
                "peer inline-flex h-[24px] w-[44px] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
                className
            )}
            {...props}
            disabled={effectiveDisabled}
            ref={ref}
        >
            <SwitchPrimitives.Thumb
                className={cn(
                    "pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:ltr:translate-x-5 data-[state=checked]:rtl:-translate-x-5 data-[state=unchecked]:translate-x-0"
                )}
            />
        </SwitchPrimitives.Root>
    )
})
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
