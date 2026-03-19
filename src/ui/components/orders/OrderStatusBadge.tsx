import { cn } from '@/lib/utils'

const statusStyles: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-700 border-slate-200',
    pending: 'bg-amber-100 text-amber-800 border-amber-200',
    ordered: 'bg-blue-100 text-blue-800 border-blue-200',
    received: 'bg-cyan-100 text-cyan-800 border-cyan-200',
    completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    cancelled: 'bg-rose-100 text-rose-800 border-rose-200'
}

export function OrderStatusBadge({ status, label }: { status: string; label?: string }) {
    return (
        <span
            className={cn(
                'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide',
                statusStyles[status] || 'bg-muted text-muted-foreground border-border'
            )}
        >
            {label || status}
        </span>
    )
}
