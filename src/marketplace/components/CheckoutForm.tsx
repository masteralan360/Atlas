import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input, Label, Textarea } from '@/ui/components'
import type { MarketplaceOrderCustomer } from '../lib/marketplaceApi'

type CheckoutFormProps = {
    submitting: boolean
    onCancel: () => void
    onSubmit: (payload: MarketplaceOrderCustomer) => Promise<void>
}

export function CheckoutForm({ submitting, onCancel, onSubmit }: CheckoutFormProps) {
    const { t } = useTranslation()
    const [name, setName] = useState('')
    const [phone, setPhone] = useState('')
    const [email, setEmail] = useState('')
    const [city, setCity] = useState('')
    const [address, setAddress] = useState('')
    const [notes, setNotes] = useState('')

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        await onSubmit({
            name,
            phone,
            email,
            city,
            address,
            notes
        })
    }

    return (
        <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1.5">
                <Label htmlFor="marketplace-customer-name">
                    {t('marketplace.checkout.name', { defaultValue: 'Full Name' })} *
                </Label>
                <Input
                    id="marketplace-customer-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    placeholder={t('marketplace.checkout.name', { defaultValue: 'Full Name' })}
                />
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="marketplace-customer-phone">
                    {t('marketplace.checkout.phone', { defaultValue: 'Phone Number' })} *
                </Label>
                <Input
                    id="marketplace-customer-phone"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    required
                    placeholder={t('marketplace.checkout.phone', { defaultValue: 'Phone Number' })}
                />
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="marketplace-customer-email">
                    {t('marketplace.checkout.email', { defaultValue: 'Email' })}
                </Label>
                <Input
                    id="marketplace-customer-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={t('marketplace.checkout.email', { defaultValue: 'Email' })}
                />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                    <Label htmlFor="marketplace-customer-city">
                        {t('marketplace.checkout.city', { defaultValue: 'City' })}
                    </Label>
                    <Input
                        id="marketplace-customer-city"
                        value={city}
                        onChange={(event) => setCity(event.target.value)}
                        placeholder={t('marketplace.checkout.city', { defaultValue: 'City' })}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="marketplace-customer-address">
                        {t('marketplace.checkout.address', { defaultValue: 'Delivery Address' })}
                    </Label>
                    <Input
                        id="marketplace-customer-address"
                        value={address}
                        onChange={(event) => setAddress(event.target.value)}
                        placeholder={t('marketplace.checkout.address', { defaultValue: 'Delivery Address' })}
                    />
                </div>
            </div>

            <div className="space-y-1.5">
                <Label htmlFor="marketplace-customer-notes">
                    {t('marketplace.checkout.notes', { defaultValue: 'Notes' })}
                </Label>
                <Textarea
                    id="marketplace-customer-notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder={t('marketplace.checkout.notes', { defaultValue: 'Notes' })}
                    rows={4}
                />
            </div>

            <div className="rounded-[1.5rem] border border-border/60 bg-muted/35 p-4 text-sm leading-6 text-muted-foreground">
                {t('marketplace.checkout.inquiryNotice', {
                    defaultValue: 'This is an inquiry order. The store will contact you to confirm and arrange delivery.'
                })}
            </div>

            <div className="flex gap-3">
                <Button type="button" variant="outline" className="flex-1 rounded-2xl" onClick={onCancel}>
                    {t('common.back', { defaultValue: 'Back' })}
                </Button>
                <Button type="submit" className="flex-1 rounded-2xl" disabled={submitting}>
                    {submitting
                        ? t('common.loading', { defaultValue: 'Loading...' })
                        : t('marketplace.checkout.submit', { defaultValue: 'Submit Order' })}
                </Button>
            </div>
        </form>
    )
}
