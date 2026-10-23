import { useMemo, useRef, useState } from 'react'
import { UserRoundCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { type CurrencyCode, useSalesOrder } from '@/local-db'
import { useWorkspace } from '@/workspace'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Button,
    useToast
} from '@/ui/components'
import {
    SalesOrderCommissionAssignmentSection,
    type SalesOrderCommissionAssignmentHandle
} from './SalesOrderCommissionAssignmentSection'

interface OrderAgentAssignmentDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    orderId: string
    defaultCustomerCity?: string
    assignedBy?: string | null
}

export function OrderAgentAssignmentDialog({
    open,
    onOpenChange,
    workspaceId,
    orderId,
    defaultCustomerCity = '',
    assignedBy
}: OrderAgentAssignmentDialogProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { features } = useWorkspace()
    const order = useSalesOrder(orderId)
    const formRef = useRef<SalesOrderCommissionAssignmentHandle>(null)
    const [isSaving, setIsSaving] = useState(false)
    const availableCurrencies = useMemo(
        () => Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[],
        [features.allowed_currencies, features.default_currency]
    )

    async function handleSave() {
        if (!order) return
        setIsSaving(true)
        try {
            await formRef.current?.save(order)
            toast({ title: t('salesAgentCommissions.assignmentSaved') })
            onOpenChange(false)
        } catch (error: any) {
            toast({
                title: t('salesAgentCommissions.couldNotSaveAssignment'),
                description: error?.message || t('salesAgentCommissions.tryAgain'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <AppDialog open={open} onOpenChange={(nextOpen) => {
            if (isSaving && !nextOpen) return
            onOpenChange(nextOpen)
        }}>
            <AppDialogContent className="max-w-4xl">
                <AppDialogHeader>
                    <div className="flex items-start gap-3">
                        <div className="rounded-xl bg-violet-500/10 p-2 text-violet-700 dark:text-violet-300">
                            <UserRoundCheck className="h-5 w-5" />
                        </div>
                        <div className="space-y-1">
                            <AppDialogTitle>{t('salesAgentCommissions.salesAgentBeneficiaries')}</AppDialogTitle>
                            <AppDialogDescription>
                                {t('salesAgentCommissions.salesAgentBeneficiariesDescription')}
                            </AppDialogDescription>
                        </div>
                    </div>
                </AppDialogHeader>
                <AppDialogBody className="space-y-5">
                    {order ? (
                        <SalesOrderCommissionAssignmentSection
                            ref={formRef}
                            workspaceId={workspaceId}
                            editingOrderId={orderId}
                            customerCity={defaultCustomerCity}
                            assignedBy={assignedBy}
                            orderCurrency={order.currency || features.default_currency}
                            orderTotal={order.total || 0}
                            exchangeRates={order.exchangeRates ?? []}
                            availableCurrencies={availableCurrencies}
                            iqdDisplayPreference={features.iqd_display_preference}
                            disabled={isSaving}
                        />
                    ) : null}
                </AppDialogBody>
                <AppDialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
                        {t('salesAgentCommissions.cancel')}
                    </Button>
                    <Button type="button" onClick={() => void handleSave()} disabled={isSaving || !order}>
                        {isSaving ? t('salesAgentCommissions.saving') : t('salesAgentCommissions.saveAssignment')}
                    </Button>
                </AppDialogFooter>
            </AppDialogContent>
        </AppDialog>
    )
}
