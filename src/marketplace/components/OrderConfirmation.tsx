import { CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button, Card, CardContent } from '@/ui/components'

type OrderConfirmationProps = {
    orderNumber: string
    storeName: string
    phone: string
    onBackToStore: () => void
}

export function OrderConfirmation({ orderNumber, storeName, phone, onBackToStore }: OrderConfirmationProps) {
    const { t } = useTranslation()

    return (
        <Card className="border-emerald-500/20 bg-emerald-500/5 shadow-[0_24px_80px_rgba(16,185,129,0.12)]">
            <CardContent className="space-y-5 p-6 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600">
                    <CheckCircle2 className="h-8 w-8" />
                </div>
                <div className="space-y-2">
                    <h2 className="text-2xl font-black">
                        {t('marketplace.confirmation.title', { defaultValue: 'Order Submitted!' })}
                    </h2>
                    <p className="text-muted-foreground">
                        {t('marketplace.confirmation.message', {
                            defaultValue: '{{storeName}} will contact you at {{phone}} to confirm your order.',
                            storeName,
                            phone
                        })}
                    </p>
                    <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                        {t('marketplace.confirmation.orderNumber', {
                            defaultValue: 'Order #{{number}}',
                            number: orderNumber
                        })}
                    </p>
                </div>
                <Button className="rounded-2xl" onClick={onBackToStore}>
                    {t('marketplace.confirmation.backToStore', { defaultValue: 'Back to Store' })}
                </Button>
            </CardContent>
        </Card>
    )
}
