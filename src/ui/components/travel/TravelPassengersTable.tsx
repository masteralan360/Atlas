import { useTranslation } from 'react-i18next'
import { UsersRound } from 'lucide-react'

import { formatCurrency } from '@/lib/utils'
import type { CurrencyCode, IQDDisplayPreference, TravelPassenger } from '@/local-db'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/table'

interface TravelPassengersTableProps {
    passengers: TravelPassenger[]
    currency: CurrencyCode
    iqdPreference: IQDDisplayPreference
}

export function TravelPassengersTable({ passengers, currency, iqdPreference }: TravelPassengersTableProps) {
    const { t } = useTranslation()

    return (
        <Card className="border-border/60 shadow-sm">
            <CardHeader><CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5 text-primary" />{t('travelTransportation.passengers')}</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('travelTransportation.name')}</TableHead>
                            <TableHead>{t('travelTransportation.phoneNumber')}</TableHead>
                            <TableHead>{t('travelTransportation.transportationType')}</TableHead>
                            <TableHead className="text-end">{t('travelTransportation.price')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {passengers.map((passenger) => <TableRow key={passenger.id}>
                            <TableCell className="font-medium">{passenger.name}</TableCell>
                            <TableCell>{passenger.phoneNumber || '—'}</TableCell>
                            <TableCell>{t(`travelTransportation.${passenger.transportationType}`)}</TableCell>
                            <TableCell className="text-end">{formatCurrency(passenger.price, currency, iqdPreference)}</TableCell>
                        </TableRow>)}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    )
}
