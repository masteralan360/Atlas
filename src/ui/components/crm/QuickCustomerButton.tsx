import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap } from 'lucide-react'

import { createBusinessPartner, type BusinessPartner } from '@/local-db'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Button, useToast } from '@/ui/components'
import {
    CompactBusinessPartnerFormDialog,
    type CompactBusinessPartnerFormPayload
} from './CompactBusinessPartnerFormDialog'

interface QuickCustomerButtonProps {
    workspaceId?: string
    className?: string
    disabled?: boolean
    /** Called after the saved customer is available for a caller to link or select. */
    onCreated?: (customer: BusinessPartner) => void
}

/**
 * Opens the compact customer form and exposes the saved customer so callers
 * can immediately link it to their current workflow.
 */
export function QuickCustomerButton({
    workspaceId,
    className,
    disabled = false,
    onCreated
}: QuickCustomerButtonProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { features } = useWorkspace()
    const [isOpen, setIsOpen] = useState(false)
    const [isSaving, setIsSaving] = useState(false)

    const handleSubmit = async (payload: CompactBusinessPartnerFormPayload) => {
        if (!workspaceId) return

        setIsSaving(true)
        try {
            const customer = await createBusinessPartner(workspaceId, payload)
            setIsOpen(false)
            onCreated?.(customer)
            toast({ title: t('customers.messages.addSuccess') })
        } catch {
            toast({
                title: t('common.error'),
                description: t('customers.messages.addError'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <>
            <Button
                type="button"
                variant="outline"
                onClick={() => setIsOpen(true)}
                className={cn('gap-2 rounded-xl', className)}
                disabled={disabled || !workspaceId}
            >
                <Zap className="h-4 w-4" />
                {t('customers.addQuickCustomer')}
            </Button>

            <CompactBusinessPartnerFormDialog
                isOpen={isOpen}
                onOpenChange={setIsOpen}
                workspaceId={workspaceId}
                defaultCurrency={features.default_currency}
                role="customer"
                title={t('customers.addQuickCustomer')}
                submitLabel={t('common.create')}
                isSaving={isSaving}
                onSubmit={handleSubmit}
            />
        </>
    )
}
