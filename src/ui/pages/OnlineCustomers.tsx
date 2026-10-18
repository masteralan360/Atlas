import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { Search, Store, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth/AuthContext'
import { useBusinessPartners } from '@/local-db'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { Input } from '@/ui/components/input'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/ui/components'
import { formatDateTime } from '@/lib/utils'

export function OnlineCustomers() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const [search, setSearch] = useState('')
    const partners = useBusinessPartners(user?.workspaceId)

    const onlineCustomers = useMemo(
        () => partners
            .filter((partner) => Boolean(partner.isEcommerce))
            .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')),
        [partners]
    )

    const filteredCustomers = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) {
            return onlineCustomers
        }

        return onlineCustomers.filter((partner) =>
            [partner.partnerName, partner.phone, partner.city]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .some((value) => value.toLowerCase().includes(query))
        )
    }, [onlineCustomers, search])

    return (
        <div className="space-y-6 max-w-3xl">
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <Users className="w-6 h-6 text-primary" />
                    {t('onlineCustomers.title', { defaultValue: 'Online Customers' })}
                </h1>
                <p className="text-muted-foreground">
                    {t('onlineCustomers.subtitle', { defaultValue: 'Customers who ordered through your marketplace storefronts.' })}
                    <ModulePageFreshness className="ms-2" />
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Store className="h-5 w-5" />
                        {t('onlineCustomers.title', { defaultValue: 'Online Customers' })}
                    </CardTitle>
                    <div className="relative w-full max-w-sm">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('onlineCustomers.searchPlaceholder', { defaultValue: 'Search customers...' })}
                            className="pl-9"
                        />
                    </div>
                </CardHeader>
                <CardContent>
                    {filteredCustomers.length === 0 ? (
                        <div className="rounded-2xl border border-border/60 bg-muted/20 p-8 text-center text-sm text-muted-foreground">
                            {t('onlineCustomers.noCustomers', {
                                defaultValue: 'No online customers yet. Customers who order from your storefront will appear here.'
                            })}
                        </div>
                    ) : (
                        <div className="divide-y divide-border/60">
                            {filteredCustomers.map((partner) => (
                                <Link
                                    key={partner.id}
                                    href={`/online-customers/${partner.id}`}
                                    className="flex items-center justify-between gap-3 px-1 py-3 hover:bg-muted/30 transition-colors rounded-lg"
                                >
                                    <div className="flex min-w-0 items-center gap-3">
                                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                            <Users className="h-5 w-5" />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="truncate font-semibold">{partner.partnerName}</div>
                                            <div className="truncate text-xs text-muted-foreground">
                                                {partner.phone || partner.city || t('common.na', { defaultValue: 'N/A' })}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="shrink-0 text-right">
                                        <div className="text-sm font-medium">
                                            {formatDateTime(partner.createdAt || '')}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {t('onlineCustomers.firstOrdered', { defaultValue: 'First order' })}
                                        </div>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
