import { useEffect, useState, type FormEvent } from 'react'
import { BadgeDollarSign, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { SalesAgentCommissionMode } from '@/local-db'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Badge,
    Button,
    Label,
    Switch,
    useToast
} from '@/ui/components'
import { useWorkspace } from '@/workspace'

export function SalesAgentCommissionModeDialog({
    open,
    onOpenChange
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { features, updateSettings } = useWorkspace()
    const [commissionMode, setCommissionMode] = useState<SalesAgentCommissionMode>(features.sales_agent_commission_mode)
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        if (open) setCommissionMode(features.sales_agent_commission_mode)
    }, [features.sales_agent_commission_mode, open])

    const handleOpenChange = (nextOpen: boolean) => {
        if (!isSaving) onOpenChange(nextOpen)
    }

    const handleSave = async (event: FormEvent) => {
        event.preventDefault()
        if (isSaving || commissionMode === features.sales_agent_commission_mode) return

        setIsSaving(true)
        try {
            await updateSettings({ sales_agent_commission_mode: commissionMode })
            toast({ title: t('salesAgentCommissions.settingsSaved') })
            onOpenChange(false)
        } catch (error: any) {
            toast({
                title: t('salesAgentCommissions.couldNotSaveSettings'),
                description: error?.message || t('salesAgentCommissions.tryAgain'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <AppDialog open={open} onOpenChange={handleOpenChange}>
            <AppDialogContent
                className="max-w-xl"
                showCloseButton={!isSaving}
                onPointerDownOutside={(event) => isSaving && event.preventDefault()}
                onEscapeKeyDown={(event) => isSaving && event.preventDefault()}
            >
                <AppDialogHeader>
                    <AppDialogTitle className="flex items-center gap-2">
                        <BadgeDollarSign className="h-5 w-5 text-sky-600" />
                        {t('salesAgentCommissions.trackWithoutPayment')}
                    </AppDialogTitle>
                    <AppDialogDescription>
                        {t('salesAgentCommissions.trackWithoutPaymentDescription')}
                    </AppDialogDescription>
                </AppDialogHeader>

                <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
                    <AppDialogBody>
                        <section className="grid gap-4 rounded-2xl border border-sky-500/20 bg-sky-500/[0.04] p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                            <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Label htmlFor="track-commissions-without-payment" className="font-semibold">
                                        {t('salesAgentCommissions.trackWithoutPayment')}
                                    </Label>
                                    {commissionMode === 'tracked' ? (
                                        <>
                                            <Badge className="border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/10 dark:text-sky-300" variant="outline">
                                                {t('salesAgentCommissions.trackedCommission')}
                                            </Badge>
                                            <Badge variant="secondary">{t('salesAgentCommissions.nonpayable')}</Badge>
                                        </>
                                    ) : (
                                        <Badge variant="outline">{t('salesAgentCommissions.payableCommission')}</Badge>
                                    )}
                                </div>
                                <p className="text-sm text-muted-foreground">
                                    {t('salesAgentCommissions.trackedOrderDescription')}
                                </p>
                            </div>
                            <Switch
                                id="track-commissions-without-payment"
                                checked={commissionMode === 'tracked'}
                                onCheckedChange={(checked) => setCommissionMode(checked ? 'tracked' : 'payable')}
                                disabled={isSaving}
                                aria-label={t('salesAgentCommissions.trackWithoutPayment')}
                            />
                        </section>
                    </AppDialogBody>

                    <AppDialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isSaving}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            disabled={isSaving || commissionMode === features.sales_agent_commission_mode}
                        >
                            {isSaving ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : null}
                            {t('common.save')}
                        </Button>
                    </AppDialogFooter>
                </form>
            </AppDialogContent>
        </AppDialog>
    )
}
