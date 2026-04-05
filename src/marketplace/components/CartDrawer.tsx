import type { ReactNode } from 'react'
import { ShoppingCart, X } from 'lucide-react'

import { Button } from '@/ui/components'
import { cn } from '@/lib/utils'

type CartDrawerProps = {
    open: boolean
    title: string
    subtitle?: string
    onClose: () => void
    children: ReactNode
    className?: string
}

export function CartDrawer({ open, title, subtitle, onClose, children, className }: CartDrawerProps) {
    return (
        <div className={cn('fixed inset-0 z-[60] transition-opacity', open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0', className)}>
            <button
                type="button"
                className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm"
                onClick={onClose}
                aria-label="Close cart"
            />
            <aside
                className={cn(
                    'absolute inset-y-0 end-0 flex w-full max-w-md flex-col border-s border-border/60 bg-background/95 shadow-[0_24px_80px_rgba(15,23,42,0.2)] backdrop-blur-2xl transition-transform duration-300',
                    open ? 'translate-x-0' : 'translate-x-full'
                )}
            >
                <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
                    <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                            <ShoppingCart className="h-4 w-4" />
                        </div>
                        <div>
                            <h2 className="text-lg font-black">{title}</h2>
                            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
                        </div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={onClose}>
                        <X className="h-4 w-4" />
                    </Button>
                </div>
                <div className="flex-1 overflow-y-auto p-5">
                    {children}
                </div>
            </aside>
        </div>
    )
}
