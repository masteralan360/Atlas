import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, AlertTriangle, Loader2, Copy, Check, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    playHoldFeedbackComplete,
    startHoldFeedback,
    stopHoldFeedback,
    updateHoldFeedback
} from '@/lib/holdFeedbackAudio'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Button,
    Input,
    Checkbox,
    Label
} from '@/ui/components'

const QUICK_DELETE_KEY = 'quickDeleteExpiry'
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000

function getQuickDeleteActive(): boolean {
    try {
        const stored = localStorage.getItem(QUICK_DELETE_KEY)
        if (!stored) return false
        const expiry = Number(stored)
        return !isNaN(expiry) && Date.now() < expiry
    } catch {
        return false
    }
}

function saveQuickDelete(): void {
    try {
        localStorage.setItem(QUICK_DELETE_KEY, String(Date.now() + TWENTY_FOUR_HOURS))
    } catch {
        // localStorage not available
    }
}

interface DeleteConfirmationModalProps {
    isOpen: boolean
    onClose: () => void
    onConfirm: () => void
    title?: string
    description?: string
    isLoading?: boolean
    itemName?: string
    simpleConfirmation?: boolean
    contentClassName?: string
    overlayClassName?: string
}

export function DeleteConfirmationModal({
    isOpen,
    onClose,
    onConfirm,
    title,
    description,
    isLoading = false,
    itemName = '',
    simpleConfirmation = false,
    contentClassName,
    overlayClassName
}: DeleteConfirmationModalProps) {
    const { t } = useTranslation()
    const [typedText, setTypedText] = useState('')
    const [copied, setCopied] = useState(false)
    const [enableQuickDelete, setEnableQuickDelete] = useState(false)
    const [holdProgress, setHoldProgress] = useState(0)
    const [isQuickDeleteActive, setIsQuickDeleteActive] = useState(false)
    const animationFrameRef = useRef<number | null>(null)
    const holdCompletedRef = useRef(false)
    const isDeleteEnabled = typedText === 'delete'
    const showSimpleConfirmation = simpleConfirmation || isQuickDeleteActive

    const cancelHold = useCallback(() => {
        if (animationFrameRef.current !== null) {
            cancelAnimationFrame(animationFrameRef.current)
            animationFrameRef.current = null
        }
        stopHoldFeedback()
        if (!holdCompletedRef.current) {
            setHoldProgress(0)
        }
    }, [])

    useEffect(() => {
        if (isOpen) {
            setIsQuickDeleteActive(getQuickDeleteActive())
            setTypedText('')
            setCopied(false)
            setEnableQuickDelete(false)
            holdCompletedRef.current = false
            cancelHold()
            setHoldProgress(0)
        }
    }, [cancelHold, isOpen])

    const beginHold = useCallback(() => {
        if (!isDeleteEnabled || isLoading || animationFrameRef.current !== null) return

        startHoldFeedback()
        holdCompletedRef.current = false
        const startedAt = performance.now()
        const holdDuration = 1500

        const updateProgress = (now: number) => {
            const progress = Math.min(((now - startedAt) / holdDuration) * 100, 100)
            setHoldProgress(progress)
            updateHoldFeedback(progress)

            if (progress >= 100) {
                animationFrameRef.current = null
                holdCompletedRef.current = true
                playHoldFeedbackComplete()
                if (enableQuickDelete) {
                    saveQuickDelete()
                }
                onConfirm()
                return
            }

            animationFrameRef.current = requestAnimationFrame(updateProgress)
        }

        animationFrameRef.current = requestAnimationFrame(updateProgress)
    }, [isDeleteEnabled, isLoading, onConfirm, enableQuickDelete])

    const handleSimpleDelete = () => {
        if (isLoading) return
        onConfirm()
    }

    const handleCopyDelete = async () => {
        try {
            await navigator.clipboard.writeText('delete')
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            // clipboard not available
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent overlayClassName={overlayClassName} className={cn(
                "max-w-md w-[95vw] sm:w-full overflow-hidden p-0 rounded-[2.5rem]",
                "dark:bg-zinc-950/90 backdrop-blur-2xl border-zinc-200 dark:border-zinc-800 shadow-2xl animate-in fade-in zoom-in duration-300",
                contentClassName
            )}>
                <div className="relative p-8 flex flex-col items-center text-center space-y-6">
                    {/* Background Glow */}
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-12 bg-destructive/20 blur-[60px] -z-10" />

                    {/* Icon Container */}
                    <div className="relative">
                        <div className="w-20 h-20 rounded-[2rem] bg-destructive/10 flex items-center justify-center border border-destructive/20 animate-pulse-subtle">
                            <Trash2 className="w-10 h-10 text-destructive" />
                        </div>
                        <div className="absolute -top-1 -right-1 w-8 h-8 rounded-full bg-background border border-border flex items-center justify-center shadow-lg">
                            <AlertTriangle className="w-4 h-4 text-amber-500" />
                        </div>
                    </div>

                    {/* Content */}
                    <div className="space-y-2">
                        <DialogHeader>
                            <DialogTitle className="text-2xl font-black text-foreground tracking-tight text-center">
                                {title || t('common.confirmDelete') || 'Confirm Deletion'}
                            </DialogTitle>
                        </DialogHeader>
                        <p className="text-muted-foreground font-medium text-sm leading-relaxed px-4">
                            {description || t('common.deleteWarning') || 'This action is irreversible. Are you sure you want to proceed?'}
                        </p>
                    </div>

                    {/* Item Preview */}
                    {itemName && (
                        <div className="w-full bg-muted/30 p-4 rounded-2xl border border-border/50 flex flex-col gap-1">
                            <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground opacity-60">
                                {t('common.targetItem') || 'Item to delete'}
                            </span>
                            <span className="text-base font-bold text-foreground truncate">
                                {itemName}
                            </span>
                        </div>
                    )}

                    {showSimpleConfirmation ? (
                        <>
                            {/* Quick delete badge */}
                            {!simpleConfirmation && (
                                <div className="w-full flex items-center justify-center gap-2 rounded-2xl bg-amber-500/10 border border-amber-500/20 px-4 py-3">
                                    <Zap className="w-4 h-4 text-amber-500" />
                                    <span className="text-xs font-bold text-amber-600 dark:text-amber-400">
                                        {t('common.quickDeleteActive') || 'Quick delete is active for 24 hours'}
                                    </span>
                                </div>
                            )}

                            {/* Simple delete button */}
                            <DialogFooter className="w-full grid grid-cols-2 gap-3 sm:gap-4 !flex-row sm:!flex-row">
                                <Button
                                    variant="ghost"
                                    onClick={onClose}
                                    disabled={isLoading}
                                    className="h-12 rounded-2xl font-bold bg-secondary/30 hover:bg-secondary/50 border border-transparent hover:border-border/50 transition-all"
                                >
                                    {t('common.cancel') || 'Cancel'}
                                </Button>
                                <Button
                                    variant="destructive"
                                    onClick={handleSimpleDelete}
                                    disabled={isLoading}
                                    className="h-12 rounded-2xl font-black shadow-lg shadow-destructive/20 bg-destructive hover:bg-destructive/90 border-t border-white/10 flex gap-2 items-center justify-center transition-all"
                                >
                                    {isLoading ? (
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                    ) : (
                                        <span className="flex items-center justify-center gap-2">
                                            <Trash2 className="w-4 h-4" />
                                            {t('common.delete') || 'Delete'}
                                        </span>
                                    )}
                                </Button>
                            </DialogFooter>
                        </>
                    ) : (
                        <>
                            {/* Type-to-delete confirmation */}
                            <div className="w-full space-y-2">
                                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground/60 flex items-center justify-center gap-1.5">
                                    {t('common.typeToConfirm')}
                                    <button
                                        type="button"
                                        onClick={handleCopyDelete}
                                        className="inline-flex items-center gap-1 font-black text-foreground underline underline-offset-2 decoration-dashed decoration-muted-foreground/40 hover:decoration-foreground transition-all cursor-pointer"
                                        title="Click to copy"
                                    >
                                        delete
                                        {copied ? (
                                            <Check className="w-3 h-3 text-green-500" />
                                        ) : (
                                            <Copy className="w-3 h-3 text-muted-foreground/60" />
                                        )}
                                    </button>
                                    {t('common.toConfirm') || 'to confirm'}
                                </label>
                                <Input
                                    value={typedText}
                                    onChange={(e) => setTypedText(e.target.value)}
                                    placeholder="delete"
                                    disabled={isLoading}
                                    className="h-12 rounded-2xl text-center text-base font-bold tracking-widest"
                                />
                            </div>

                            {/* Quick-delete checkbox */}
                            {isDeleteEnabled && (
                                <div className="w-full flex items-center justify-center gap-2">
                                    <Checkbox
                                        id="quick-delete"
                                        checked={enableQuickDelete}
                                        onCheckedChange={(checked) => setEnableQuickDelete(checked === true)}
                                    />
                                    <Label
                                        htmlFor="quick-delete"
                                        className="text-xs font-bold text-muted-foreground/70 cursor-pointer select-none"
                                    >
                                        {t('common.quickDeleteEnable') || 'Enable quick delete for 24 hours'}
                                    </Label>
                                </div>
                            )}

                            {/* Actions */}
                            <DialogFooter className="w-full grid grid-cols-2 gap-3 sm:gap-4 !flex-row sm:!flex-row">
                                <Button
                                    variant="ghost"
                                    onClick={onClose}
                                    disabled={isLoading}
                                    className="h-12 rounded-2xl font-bold bg-secondary/30 hover:bg-secondary/50 border border-transparent hover:border-border/50 transition-all"
                                >
                                    {t('common.cancel') || 'Cancel'}
                                </Button>
                                <Button
                                    variant="destructive"
                                    onClick={(event) => {
                                        event.preventDefault()
                                    }}
                                    onPointerDown={(event) => {
                                        if (!isDeleteEnabled || event.button !== 0) return
                                        event.preventDefault()
                                        event.currentTarget.setPointerCapture(event.pointerId)
                                        beginHold()
                                    }}
                                    onPointerUp={cancelHold}
                                    onPointerCancel={cancelHold}
                                    onPointerLeave={cancelHold}
                                    onKeyDown={(event) => {
                                        if (!isDeleteEnabled || event.repeat) return
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault()
                                            beginHold()
                                        }
                                    }}
                                    onKeyUp={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault()
                                            cancelHold()
                                        }
                                    }}
                                    disabled={isLoading || !isDeleteEnabled}
                                    className="relative h-12 overflow-hidden rounded-2xl font-black shadow-lg shadow-destructive/20 bg-destructive hover:bg-destructive/90 disabled:opacity-40 disabled:pointer-events-none border-t border-white/10 flex gap-2 items-center justify-center transition-all active:scale-95"
                                >
                                    <span
                                        aria-hidden="true"
                                        className="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-75"
                                        style={{ width: `${holdProgress}%` }}
                                    />
                                    {isLoading ? (
                                        <Loader2 className="relative w-5 h-5 animate-spin" />
                                    ) : (
                                        <span className="relative flex items-center justify-center gap-2">
                                            <Trash2 className="w-4 h-4" />
                                            {holdProgress > 0 && holdProgress < 100
                                                ? t('common.holdToDelete') || 'Hold To Delete'
                                                : t('common.delete') || 'Delete'}
                                        </span>
                                    )}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
