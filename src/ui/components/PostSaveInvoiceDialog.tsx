import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { CheckCircle2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/ui/components'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from './dialog'
import {
    clearPendingPDFPreview,
    getPendingPDFPreview,
    setPDFPreviewSource,
    subscribeToPendingPDFPreview
} from '@/lib/pdfPreviewStore'

export function PostSaveInvoiceDialog() {
    const { t } = useTranslation()
    const [, setLocation] = useLocation()

    const pendingPDFPreview = useSyncExternalStore(
        subscribeToPendingPDFPreview,
        getPendingPDFPreview,
        getPendingPDFPreview,
    )

    if (!pendingPDFPreview) return null

    return (
        <Dialog open={true} onOpenChange={(open) => {
            if (!open) clearPendingPDFPreview()
        }}>
            <DialogContent className={cn(
                "max-w-md w-[95vw] sm:w-full overflow-hidden p-0 rounded-[2.5rem]",
                "dark:bg-zinc-950/90 backdrop-blur-2xl border-zinc-200 dark:border-zinc-800 shadow-2xl animate-in fade-in zoom-in duration-300"
            )}>
                <div className="relative p-8 flex flex-col items-center text-center space-y-6">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-12 bg-emerald-500/20 blur-[60px] -z-10" />

                    <div className="relative">
                        <div className="w-20 h-20 rounded-[2rem] bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
                        </div>
                        <div className="absolute -top-1 -right-1 rtl:right-auto rtl:-left-1 w-8 h-8 rounded-full bg-background border border-border flex items-center justify-center shadow-lg">
                            <Check className="w-4 h-4 text-emerald-500" />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <DialogHeader>
                            <DialogTitle className="text-2xl font-black text-foreground tracking-tight text-center">
                                {t('print.saveSuccess') || 'Invoice Saved'}
                            </DialogTitle>
                        </DialogHeader>
                        <p className="text-muted-foreground font-medium text-sm leading-relaxed px-4">
                            {t('print.saveSuccessDesc') || 'A record of this invoice has been added to history.'}
                        </p>
                    </div>

                    <div className="w-full bg-muted/30 p-4 rounded-2xl border border-border/50">
                        <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground opacity-60">
                            {t('common.invoice') || 'Invoice'}
                        </span>
                        <p className="text-base font-bold text-foreground truncate mt-1">
                            {pendingPDFPreview.title}
                        </p>
                    </div>

                    <DialogFooter className="w-full grid grid-cols-2 gap-3 sm:gap-4 !flex-row sm:!flex-row">
                        <Button
                            variant="ghost"
                            onClick={() => clearPendingPDFPreview()}
                            className="h-12 rounded-2xl font-bold bg-secondary/30 hover:bg-secondary/50 border border-transparent hover:border-border/50 transition-all"
                        >
                            {t('common.close') || 'Close'}
                        </Button>
                        <Button
                            onClick={() => {
                                setPDFPreviewSource({
                                    url: pendingPDFPreview.url,
                                    title: pendingPDFPreview.title
                                })
                                clearPendingPDFPreview()
                                setLocation('/pdf-preview')
                            }}
                            className="h-12 rounded-2xl font-black shadow-lg shadow-primary/20 bg-primary hover:bg-primary/90 border-t border-white/10 flex gap-2 items-center justify-center transition-all active:scale-95"
                        >
                            <CheckCircle2 className="w-4 h-4" />
                            {t('common.view') || 'View Invoice'}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    )
}
