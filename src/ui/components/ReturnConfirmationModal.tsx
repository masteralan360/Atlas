import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isPositiveQuantity, roundQuantity } from '@/lib/quantity'
import type { PaymentAccount } from '@/local-db'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Button,
    Label,
    Textarea
} from '@/ui/components'

interface ReturnConfirmationModalProps {
    isOpen: boolean
    onClose: () => void
    onConfirm: (reason: string, quantity?: number) => void
    title: string
    message: string
    isItemReturn?: boolean
    maxQuantity?: number
    itemName?: string
    quantityUnitLabel?: string
    workspaceId?: string
    paymentAccount?: PaymentAccount | null
    onPaymentAccountChange?: (account: PaymentAccount | null) => void
    showPaymentAccount?: boolean
    cashDrawerOnly?: boolean
}

export function ReturnConfirmationModal({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    isItemReturn = false,
    maxQuantity = 1,
    itemName = '',
    quantityUnitLabel = '',
    workspaceId,
    paymentAccount = null,
    onPaymentAccountChange,
    showPaymentAccount = false,
    cashDrawerOnly = false
}: ReturnConfirmationModalProps) {
    const { t } = useTranslation()
    const [step, setStep] = useState<'confirmation' | 'quantity' | 'reason'>('confirmation')
    const [selectedReason, setSelectedReason] = useState<string>('customer_returned')
    const [otherReason, setOtherReason] = useState('')
    const [returnQuantity, setReturnQuantity] = useState('')
    const maxQuantityDescriptionId = useId()
    const isReturnQuantityValid = returnQuantity.trim() !== ''
        && isPositiveQuantity(returnQuantity)
        && Number(returnQuantity) <= maxQuantity

    const returnReasons = [
        { value: 'customer_returned', label: t('sales.return.reasons.customerReturned') || 'Customer returned item' },
        { value: 'wrong_item', label: t('sales.return.reasons.wrongItem') || 'Wrong item sold' },
        { value: 'pricing_mistake', label: t('sales.return.reasons.pricingMistake') || 'Pricing mistake' },
        { value: 'damaged_product', label: t('sales.return.reasons.damagedProduct') || 'Damaged product' },
        { value: 'duplicate_sale', label: t('sales.return.reasons.duplicateSale') || 'Duplicate sale' },
        { value: 'other', label: t('sales.return.reasons.other') || 'Other' }
    ]

    const handleContinue = () => {
        if (isItemReturn) {
            setStep('quantity')
        } else {
            setStep('reason')
        }
    }

    const handleQuantityContinue = () => {
        if (!isReturnQuantityValid) {
            return
        }
        setStep('reason')
    }

    const handleReturnConfirm = () => {
        const finalReason = selectedReason === 'other' ? otherReason.trim() : selectedReason
        onConfirm(
            finalReason,
            isItemReturn && isReturnQuantityValid ? roundQuantity(Number(returnQuantity)) : undefined
        )
        handleClose()
    }

    const handleClose = () => {
        setStep('confirmation')
        setSelectedReason('customer_returned')
        setOtherReason('')
        setReturnQuantity('')
        onClose()
    }

    return (
        <Dialog open={isOpen} onOpenChange={handleClose}>
            <DialogContent className={cn(
                "max-w-lg w-[95vw] sm:w-full max-h-[90vh] overflow-y-auto shadow-2xl animate-in fade-in zoom-in duration-300",
                "rounded-[2rem] border-[3px] border-primary/50 bg-background/95 backdrop-blur-3xl"
            )}
                data-tour-id="tutorial-return-confirmation-modal"
            >
                <DialogHeader>
                    <DialogTitle className="text-xl font-black text-foreground tracking-tight flex items-center gap-2">
                        <RotateCcw className="w-5 h-5 text-primary" />
                        {title}
                    </DialogTitle>
                </DialogHeader>

                <div className="py-4">
                    {step === 'confirmation' && (
                        <div className="space-y-4">
                            <p className="text-base text-muted-foreground font-medium leading-relaxed">
                                {message}
                            </p>
                            {isItemReturn && itemName && (
                                <div className="bg-muted/50 p-4 rounded-2xl border border-border/50">
                                    <p className="text-sm font-bold text-foreground">
                                        {itemName}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {t('sales.return.availableToReturn') || 'Available to return'}: {maxQuantity}{quantityUnitLabel ? ` ${quantityUnitLabel}` : ''}
                                    </p>
                                </div>
                            )}
                            <DialogFooter className="flex flex-col sm:flex-row gap-3 pt-6">
                                <Button
                                    variant="ghost"
                                    onClick={handleClose}
                                    className="w-full sm:w-auto h-11 px-6 text-sm font-bold order-2 sm:order-1"
                                >
                                    {t('common.cancel') || 'Cancel'}
                                </Button>
                                <Button
                                    onClick={handleContinue}
                                    className="w-full sm:w-auto h-11 px-8 text-sm font-black shadow-lg shadow-primary/20 order-1 sm:order-2"
                                >
                                    {t('common.continue') || 'Continue'}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}

                    {step === 'quantity' && (
                        <div className="space-y-6">
                            <div className="space-y-4">
                                <Label className="text-lg font-bold text-foreground block">
                                    {t('sales.return.selectQuantity', { item: itemName }) || `How many "${itemName}" would you like to return?`}
                                </Label>
                                <div className="flex flex-col gap-2">
                                    <div className="relative">
                                        <input
                                            type="text"
                                            lang="en"
                                            min="0.01"
                                            max={maxQuantity}
                                            step="0.01"
                                            inputMode="decimal"
                                            value={returnQuantity}
                                            autoFocus
                                            aria-describedby={maxQuantityDescriptionId}
                                            onChange={(e) => setReturnQuantity(e.target.value)}
                                            className="w-full h-16 pl-6 pr-24 text-left text-2xl font-black tabular-nums bg-muted/30 border-2 border-border/50 rounded-2xl focus:border-primary focus:ring-0 transition-all outline-none"
                                        />
                                        <div
                                            aria-hidden="true"
                                            className="pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 whitespace-nowrap tabular-nums text-muted-foreground font-bold"
                                        >
                                            / {maxQuantity}{quantityUnitLabel ? ` ${quantityUnitLabel}` : ''}
                                        </div>
                                    </div>
                                    <p id={maxQuantityDescriptionId} className="text-sm text-muted-foreground font-medium px-2">
                                        {t('sales.return.maxQuantity', { max: maxQuantity }) || `Maximum allowed: ${maxQuantity}`}{quantityUnitLabel ? ` ${quantityUnitLabel}` : ''}
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setReturnQuantity(String(Math.min(1, maxQuantity)))}
                                        className="h-9 px-4 rounded-lg font-bold"
                                    >
                                        1
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setReturnQuantity(String(maxQuantity))}
                                        className="h-9 px-4 rounded-lg font-bold"
                                    >
                                        {t('common.all') || 'All'} ({maxQuantity})
                                    </Button>
                                    {maxQuantity > 2 && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setReturnQuantity(String(roundQuantity(maxQuantity / 2)))}
                                            className="h-9 px-4 rounded-lg font-bold"
                                        >
                                            50%
                                        </Button>
                                    )}
                                </div>
                            </div>

                            <DialogFooter className="flex flex-col sm:flex-row gap-3 pt-6">
                                <Button
                                    variant="ghost"
                                    onClick={() => setStep('confirmation')}
                                    className="w-full sm:w-auto h-11 px-6 text-sm font-bold order-2 sm:order-1"
                                >
                                    {t('common.back') || 'Back'}
                                </Button>
                                <Button
                                    onClick={handleQuantityContinue}
                                    disabled={!isReturnQuantityValid}
                                    className="w-full sm:w-auto h-11 px-8 text-sm font-black shadow-lg shadow-primary/20 order-1 sm:order-2"
                                >
                                    {t('common.continue') || 'Continue'}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}

                    {step === 'reason' && (
                        <div className="space-y-6">
                            <div className="space-y-4">
                                <Label className="text-lg font-bold text-foreground block">
                                    {t('sales.return.selectReason') || 'Specify reason for return'}
                                </Label>
                                <div className="grid grid-cols-1 gap-2" data-tour-id="tutorial-return-reason">
                                    {returnReasons.map((reason) => (
                                        <label
                                            key={reason.value}
                                            className={cn(
                                                "flex items-center gap-3 p-4 rounded-2xl border-2 cursor-pointer transition-all",
                                                selectedReason === reason.value
                                                    ? "bg-primary/5 border-primary shadow-sm"
                                                    : "bg-muted/30 border-transparent hover:bg-muted/50 hover:border-border/50"
                                            )}
                                        >
                                            <input
                                                type="radio"
                                                name="returnReason"
                                                value={reason.value}
                                                checked={selectedReason === reason.value}
                                                onChange={(e) => setSelectedReason(e.target.value)}
                                                className="h-5 w-5 text-primary border-zinc-300 focus:ring-primary"
                                            />
                                            <span className="text-sm font-bold text-foreground">
                                                {reason.label}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            {selectedReason === 'other' && (
                                <div className="space-y-2 animate-in slide-in-from-top-2 duration-300">
                                    <Label htmlFor="other-reason" className="text-sm font-bold text-foreground px-1">
                                        {t('sales.return.specifyReason') || 'Please specify:'}
                                    </Label>
                                    <Textarea
                                        id="other-reason"
                                        value={otherReason}
                                        onChange={(e) => setOtherReason(e.target.value)}
                                        placeholder={t('sales.return.reasonPlaceholder') || 'Enter details...'}
                                        className="rounded-2xl border-2 focus:border-primary transition-all resize-none min-h-[100px]"
                                        maxLength={100}
                                    />
                                </div>
                            )}

                            {showPaymentAccount && workspaceId && onPaymentAccountChange ? (
                                <PaymentAccountSelector
                                    workspaceId={workspaceId}
                                    value={paymentAccount?.id ?? null}
                                    onValueChange={onPaymentAccountChange}
                                    cashDrawerOnly={cashDrawerOnly}
                                />
                            ) : null}

                            <DialogFooter className="flex flex-col sm:flex-row gap-3 pt-6">
                                <Button
                                    variant="ghost"
                                    onClick={() => setStep(isItemReturn ? 'quantity' : 'confirmation')}
                                    className="w-full sm:w-auto h-11 px-6 text-sm font-bold order-2 sm:order-1"
                                >
                                    {t('common.back') || 'Back'}
                                </Button>
                                <Button
                                    data-tour-id="tutorial-return-confirm-button"
                                    onClick={handleReturnConfirm}
                                    disabled={selectedReason === 'other' && !otherReason.trim()}
                                    className="w-full sm:w-auto h-11 px-8 text-sm font-black shadow-lg shadow-primary/20 order-1 sm:order-2"
                                >
                                    {t('sales.return.confirmReturn') || 'Confirm Return'}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
