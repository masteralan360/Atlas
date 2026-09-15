import { Link } from 'wouter'
import { MapPin, Phone, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent } from '@/ui/components'
import { cn } from '@/lib/utils'

import { StorefrontLayout } from '../components/StorefrontLayout'
import { useCart } from '../hooks/useCart'
import { usePageMeta } from '../hooks/usePageMeta'
import { useStoreCatalog } from '../hooks/useStoreCatalog'
import type { MarketplaceStoreContact } from '../lib/marketplaceApi'
import type { StorefrontRules } from '../templates/types'

function getContactsOfType(contacts: MarketplaceStoreContact[], type: 'phone' | 'address') {
    return contacts
        .filter((contact) => contact.type.toLowerCase() === type && contact.value.trim().length > 0)
        .sort((left, right) => Number(right.is_primary) - Number(left.is_primary))
}

function ContactRows({
    contacts,
    type,
    emptyLabel
}: {
    contacts: MarketplaceStoreContact[]
    type: 'phone' | 'address'
    emptyLabel: string
}) {
    const { t } = useTranslation()
    const Icon = type === 'phone' ? Phone : MapPin

    if (contacts.length === 0) {
        return (
            <div className="rounded-3xl border border-dashed border-[#d5dce4] p-6 text-sm text-[#4d5856]">
                {emptyLabel}
            </div>
        )
    }

    return (
        <div className="space-y-3">
            {contacts.map((contact, index) => {
                const label = contact.label || (contact.is_primary
                    ? t('marketplace.primaryContact', { defaultValue: 'Primary' })
                    : t('marketplace.contact', { defaultValue: 'Contact' }))

                return (
                    <div
                        key={`${contact.type}-${contact.value}-${index}`}
                        className="flex items-start gap-4 rounded-3xl border border-[#e3e8ef] bg-white p-5"
                    >
                        <div className={cn(
                            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
                            contact.is_primary ? 'bg-[#d3e7e1] text-[#00756f]' : 'bg-[#eef2f6] text-[#4d5856]'
                        )}>
                            <Icon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-black uppercase tracking-[0.16em] text-[#4d5856]">
                                    {label}
                                </p>
                                {contact.is_primary && (
                                    <span className="rounded-full bg-[#d3e7e1] px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-[#00756f]">
                                        {t('marketplace.primaryContact', { defaultValue: 'Primary' })}
                                    </span>
                                )}
                            </div>
                            {type === 'phone' ? (
                                <a
                                    href={`tel:${contact.value}`}
                                    className="mt-2 block break-words text-lg font-semibold text-[#111827] hover:text-[#00756f]"
                                >
                                    {contact.value}
                                </a>
                            ) : (
                                <p className="mt-2 break-words text-lg font-semibold leading-7 text-[#111827]">
                                    {contact.value}
                                </p>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

type StoreContactPageProps = {
    storeSlug: string
    rules?: StorefrontRules
}

export function StoreContactPage({ storeSlug, rules = {} }: StoreContactPageProps) {
    const { t } = useTranslation()
    const { catalog, isLoading, error } = useStoreCatalog(storeSlug, { includeProducts: false })
    const cart = useCart(storeSlug)
    const storeName = catalog?.store.name || t('marketplace.storeTitle', { defaultValue: 'Store' })
    const phoneContacts = getContactsOfType(catalog?.store.contacts ?? [], 'phone')
    const addressContacts = getContactsOfType(catalog?.store.contacts ?? [], 'address')

    usePageMeta(
        t('marketplace.contactPageTitle', {
            defaultValue: '{{storeName}} Contact',
            storeName
        }),
        catalog?.store.description || t('marketplace.storeSubtitle', { defaultValue: 'Browse products and send an inquiry order directly to the store.' })
    )

    return (
        <StorefrontLayout
            storeName={storeName}
            storeSlug={storeSlug}
            activeItem="contact"
            cartCount={cart.itemCount}
            showCart={!rules.hideAddToCart}
            onCartClick={() => {
                window.location.href = `/s/${storeSlug}`
            }}
            onNewArrivalsClick={() => {
                window.location.href = `/s/${storeSlug}?sort=new`
            }}
        >
            {isLoading ? (
                <div className="mx-auto max-w-[1180px] space-y-6">
                    <div className="h-32 animate-pulse rounded-[2.5rem] border border-[#e3e8ef] bg-white" />
                    <div className="grid gap-6 md:grid-cols-2">
                        <div className="h-[360px] animate-pulse rounded-[2.5rem] border border-[#e3e8ef] bg-white" />
                        <div className="h-[360px] animate-pulse rounded-[2.5rem] border border-[#e3e8ef] bg-white" />
                    </div>
                </div>
            ) : error || !catalog ? (
                <Card className="mx-auto max-w-2xl border-destructive/20 bg-destructive/5">
                    <CardContent className="space-y-4 p-6">
                        <div className="flex items-center gap-3 text-destructive">
                            <Store className="h-5 w-5" />
                            <h2 className="text-xl font-black">
                                {t('marketplace.storeNotFound', { defaultValue: 'Store not found' })}
                            </h2>
                        </div>
                        <p className="text-sm text-muted-foreground">{error || t('marketplace.storeNotFoundHint', { defaultValue: 'This store may be private or the link may be incorrect.' })}</p>
                        <Link href="/" className="inline-flex text-sm font-semibold text-primary hover:underline">
                            {t('marketplace.backToMarketplace', { defaultValue: 'Back to Marketplace' })}
                        </Link>
                    </CardContent>
                </Card>
            ) : (
                <section className="mx-auto max-w-[1180px] space-y-6">
                    <div className="rounded-[2.5rem] border border-[#e3e8ef] bg-[#fbfbfd] p-8">
                        <h1 className="text-4xl font-black tracking-tight text-[#111827]">
                            {t('marketplace.contactStore', {
                                defaultValue: 'Contact {{storeName}}',
                                storeName: catalog.store.name
                            })}
                        </h1>
                        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#4d5856]">
                            {catalog.store.description || t('marketplace.storeSubtitle', { defaultValue: 'Browse products and send an inquiry order directly to the store.' })}
                        </p>
                    </div>

                    <div className="grid gap-6 md:grid-cols-2">
                        <Card className="rounded-[2.5rem] border-[#e3e8ef] bg-[#fbfbfd]">
                            <CardContent className="space-y-5 p-6">
                                <div>
                                    <h2 className="text-2xl font-black text-[#111827]">
                                        {t('marketplace.phoneNumbers', { defaultValue: 'Phone Numbers' })}
                                    </h2>
                                    <p className="mt-1 text-sm text-[#4d5856]">
                                        {t('marketplace.primaryFirst', { defaultValue: 'Primary contacts are listed first.' })}
                                    </p>
                                </div>
                                <ContactRows
                                    contacts={phoneContacts}
                                    type="phone"
                                    emptyLabel={t('marketplace.noPhoneContacts', { defaultValue: 'No phone numbers available.' })}
                                />
                            </CardContent>
                        </Card>

                        <Card className="rounded-[2.5rem] border-[#e3e8ef] bg-[#fbfbfd]">
                            <CardContent className="space-y-5 p-6">
                                <div>
                                    <h2 className="text-2xl font-black text-[#111827]">
                                        {t('marketplace.addresses', { defaultValue: 'Addresses' })}
                                    </h2>
                                    <p className="mt-1 text-sm text-[#4d5856]">
                                        {t('marketplace.primaryFirst', { defaultValue: 'Primary contacts are listed first.' })}
                                    </p>
                                </div>
                                <ContactRows
                                    contacts={addressContacts}
                                    type="address"
                                    emptyLabel={t('marketplace.noAddressContacts', { defaultValue: 'No addresses available.' })}
                                />
                            </CardContent>
                        </Card>
                    </div>
                </section>
            )}
        </StorefrontLayout>
    )
}
