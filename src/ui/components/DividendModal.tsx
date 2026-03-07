import { useRef } from 'react'
import { useReactToPrint } from 'react-to-print'
import {
    Dialog,
    DialogContent
} from '@/ui/components'
import { DividendDistributionPanel } from '@/ui/components/budget/DividendDistributionPanel'
import type { DividendRecipient } from '@/ui/components/budget/DividendDistributionPanel'

interface DividendDistributionModalProps {
    isOpen: boolean
    onClose: () => void
    recipients: DividendRecipient[]
    surplus: number
    baseCurrency: string
    iqdPreference: 'IQD' | 'Ø¯.Ø¹'
}

export type { DividendRecipient }

export function DividendDistributionModal({
    isOpen,
    onClose,
    recipients,
    surplus,
    baseCurrency,
    iqdPreference
}: DividendDistributionModalProps) {
    const printRef = useRef<HTMLDivElement>(null)
    const handlePrint = useReactToPrint({
        contentRef: printRef,
        documentTitle: `Dividend_Distribution_Report_${new Date().toISOString().split('T')[0]}`
    })

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="max-w-4xl p-0 bg-background/95 backdrop-blur-3xl overflow-hidden rounded-[2.5rem] shadow-2xl transition-all duration-500 border-[3px] border-sky-500/50 shadow-sky-500/10">
                <DividendDistributionPanel
                    recipients={recipients}
                    surplus={surplus}
                    paidAmount={0}
                    baseCurrency={baseCurrency}
                    iqdPreference={iqdPreference}
                    onPrint={handlePrint}
                    containerRef={printRef}
                    className="p-6 md:p-8 max-h-[90vh] overflow-y-auto custom-scrollbar"
                />
            </DialogContent>
        </Dialog>
    )
}
