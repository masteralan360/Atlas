import { useState, useMemo } from 'react'
import { Bell, BellOff, RotateCcw, ArrowUpRight, TrendingUp, HandCoins, FileSpreadsheet, Inbox } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/components'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/ui/components/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/ui/components/tabs'
import { formatCurrency, cn } from '@/lib/utils'
import { useUnifiedSnooze, type SnoozedItem } from '@/context/UnifiedSnoozeContext'
import { useWorkspace } from '@/workspace'

export function UnifiedSnoozedRemindersBell() {
    const { items } = useUnifiedSnooze()
    const { features } = useWorkspace()
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [activeTab, setActiveTab] = useState('all')

    const iqdPreference = features.iqd_display_preference

    const filteredItems = useMemo(() => {
        if (activeTab === 'all') return items
        return items.filter(item => item.type === activeTab)
    }, [items, activeTab])

    const counts = useMemo(() => ({
        all: items.length,
        loan: items.filter(i => i.type === 'loan').length,
        budget: items.filter(i => i.type === 'budget').length,
        exchange: items.filter(i => i.type === 'exchange').length,
    }), [items])

    if (items.length === 0) return null

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button 
                    variant="ghost" 
                    size="icon" 
                    className="relative h-10 w-10 btn-premium rounded-full hover:bg-amber-500/10 group"
                >
                    <Bell className={cn(
                        "h-5 w-5 transition-all duration-500",
                        items.length > 0 ? "text-amber-500 fill-amber-500/20 animate-bell-ring" : "text-muted-foreground"
                    )} />
                    <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white ring-2 ring-background animate-in zoom-in duration-300 shadow-sm">
                        {items.length}
                    </span>
                    <div className="absolute inset-0 rounded-full border border-amber-500/0 group-hover:border-amber-500/20 transition-all scale-110 opacity-0 group-hover:opacity-100" />
                </Button>
            </DialogTrigger>

            <DialogContent className="sm:max-w-[540px] p-0 overflow-hidden bg-background/95 backdrop-blur-xl border border-white/10 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.5)] rounded-3xl">
                <div className="relative">
                    {/* Header with Subtle Gradient */}
                    <div className="p-6 bg-gradient-to-br from-amber-500/5 via-transparent to-transparent border-b border-border/50">
                        <DialogHeader>
                            <div className="flex items-center justify-between mb-1">
                                <DialogTitle className="flex items-center gap-2.5 text-xl font-bold tracking-tight text-foreground">
                                    <div className="p-2 bg-amber-500/15 rounded-xl border border-amber-500/20">
                                        <BellOff className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                                    </div>
                                    {t('common.snoozedItems') || 'Snoozed Reminders'}
                                </DialogTitle>
                                <div className="px-2.5 py-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-black uppercase tracking-wider rounded-lg border border-amber-500/20">
                                    {items.length} {t('common.items') || 'Items'}
                                </div>
                            </div>
                            <p className="text-xs text-muted-foreground font-medium leading-normal max-w-[90%]">
                                {t('common.snoozedItemsDesc') || 'Focus on what matters now. These alerts will wait until you un-snooze them.'}
                            </p>
                        </DialogHeader>
                    </div>

                    {/* Content with Tabs */}
                    <div className="p-4">
                        <Tabs defaultValue="all" className="w-full" onValueChange={setActiveTab}>
                            <TabsList className="grid w-full grid-cols-4 h-11 bg-muted/60 p-1 rounded-xl mb-4">
                                <TabsTrigger value="all" className="rounded-lg font-bold text-[10px] uppercase tracking-tighter">
                                    {t('common.all') || 'All'} ({counts.all})
                                </TabsTrigger>
                                <TabsTrigger value="loan" className="rounded-lg font-bold text-[10px] uppercase tracking-tighter">
                                    {t('nav.installments', { defaultValue: 'Installments' })} ({counts.loan})
                                </TabsTrigger>
                                <TabsTrigger value="budget" className="rounded-lg font-bold text-[10px] uppercase tracking-tighter">
                                    {t('nav.budget', { defaultValue: 'Accounting' })} ({counts.budget})
                                </TabsTrigger>
                                <TabsTrigger value="exchange" className="rounded-lg font-bold text-[10px] uppercase tracking-tighter">
                                    {t('exchange.rates') || 'Rates'} ({counts.exchange})
                                </TabsTrigger>
                            </TabsList>

                            <div className="max-h-[45vh] overflow-y-auto px-0.5 space-y-3 custom-scrollbar min-h-[320px]">
                                {filteredItems.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-20 text-center opacity-30">
                                        <div className="p-4 bg-muted/50 rounded-full mb-3">
                                            <Inbox className="h-8 w-8 text-muted-foreground" />
                                        </div>
                                        <p className="font-bold text-xs tracking-wide uppercase">{t('common.noItemsFound') || 'No items found'}</p>
                                    </div>
                                ) : (
                                    filteredItems.map((item) => (
                                        <ReminderCard key={item.id} item={item} iqdPreference={iqdPreference} t={t} closeDialog={() => setOpen(false)} />
                                    ))
                                )}
                            </div>
                        </Tabs>
                    </div>

                    {/* Footer Actions */}
                    <div className="px-6 py-4 bg-muted/20 border-t border-border/50 flex justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} className="font-bold text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground">
                            {t('common.close')}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}

function ReminderCard({ item, iqdPreference, t, closeDialog }: { item: SnoozedItem, iqdPreference: any, t: any, closeDialog: () => void }) {
    return (
        <div className={cn(
            "group relative rounded-2xl border p-4 transition-all duration-300 hover:shadow-xl hover:-translate-y-0.5 animate-in fade-in slide-in-from-bottom-2",
            item.priority === 'warning'
                ? "bg-amber-500/[0.03] border-amber-500/10 hover:bg-amber-500/[0.05] hover:border-amber-500/20"
                : "bg-blue-500/[0.03] border-blue-500/10 hover:bg-blue-500/[0.05] hover:border-blue-500/20"
        )}>
            <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex gap-3.5 min-w-0">
                    <div className={cn(
                        "mt-0.5 p-2 rounded-xl shrink-0 transition-all duration-500 group-hover:scale-105 group-hover:shadow-lg",
                        item.type === 'loan' ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" :
                        item.type === 'budget' ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" :
                        "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    )}>
                        {item.type === 'loan' && <HandCoins className="h-4.5 w-4.5" />}
                        {item.type === 'budget' && <FileSpreadsheet className="h-4.5 w-4.5" />}
                        {item.type === 'exchange' && <TrendingUp className="h-4.5 w-4.5" />}
                    </div>
                    <div className="min-w-0">
                        <div className="font-bold text-[13px] tracking-tight truncate leading-tight mb-0.5">
                            {item.title}
                        </div>
                        {item.subtitle && (
                            <div className="text-[10px] text-muted-foreground/80 font-semibold truncate uppercase tracking-widest leading-none">
                                {item.subtitle}
                            </div>
                        )}
                    </div>
                </div>

                {item.amount !== undefined && (
                    <div className="text-right shrink-0">
                        <div className="text-[14px] font-black tracking-tight whitespace-nowrap flex items-baseline justify-end gap-1">
                            {formatCurrency(item.amount, item.currency || 'USD', iqdPreference)}
                        </div>
                        <div className="text-[9px] text-muted-foreground/60 uppercase font-bold tracking-widest">
                            {t('common.amount')}
                        </div>
                    </div>
                )}
            </div>

            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    className="h-8 flex-[1.6] text-[10px] font-bold uppercase tracking-wider gap-2 rounded-lg shadow-sm active:scale-[0.98] transition-all"
                    onClick={() => {
                        closeDialog()
                        item.onAction()
                    }}
                >
                    <ArrowUpRight className="h-3 w-3" />
                    {item.type === 'loan' ? (t('loans.reminder.payNow') || 'View Loan') :
                     item.type === 'exchange' ? (t('exchange.editManual') || 'Open Editor') :
                     (t('budget.reminder.yesPaid') || 'Open Details')}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    className="h-8 flex-1 text-[10px] font-bold uppercase tracking-wider gap-2 rounded-lg bg-background/50 border-border/50 hover:bg-muted/30 transition-all hover:border-border duration-200"
                    onClick={() => item.onUnsnooze()}
                >
                    <RotateCcw className="h-3 w-3" />
                    {t('common.unsnooze') || 'Remind'}
                </Button>
            </div>
        </div>
    )
}
