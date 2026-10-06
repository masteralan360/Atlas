import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CalendarDays, CircleDollarSign, ClipboardList, Minus, Phone, Plus, Save, Ticket, Trash2, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { buildOrderExchangeRatesSnapshot } from '@/lib/orderCurrency'
import { normalizeOrderAdjustments, repriceOrderAdjustment } from '@/lib/orderAdjustments'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import {
    formatCurrency,
    formatLocalDateValue,
    formatNumericInput,
    parseFormattedNumber,
    parseLocalDateValue,
    sanitizeNumericInput
} from '@/lib/utils'
import {
    calculateTravelBookingAmounts,
    createTravelBooking,
    updateTravelBooking,
    type CurrencyCode,
    type OrderAdjustment,
    type PaymentAccount,
    type TravelBooking,
    type TravelPassenger,
    type TravelTransportationType,
    type WorkspacePaymentMethod
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CurrencySelector,
    DateTimePicker,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    Textarea,
    useToast
} from '@/ui/components'
import { OrderAdjustmentsDialog } from '@/ui/components/orders/OrderAdjustmentsDialog'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { PaymentMethodSelect } from '@/ui/components/payments/PaymentMethodSelect'

type PassengerDraft = {
    id: string
    name: string
    phoneNumber: string
    transportationType: TravelTransportationType | ''
    price: string
}

interface TravelBookingFormPageProps {
    workspaceId: string
    booking?: TravelBooking | null
    existingPassengers?: TravelPassenger[]
    onCancel: () => void
    onSaved: (bookingId: string) => void
}

function createPassengerDraft(id: string): PassengerDraft {
    return { id, name: '', phoneNumber: '', transportationType: '', price: '' }
}

function bookingStatusAllowsEditing(booking: TravelBooking | null | undefined) {
    return !booking || booking.status === 'draft' || booking.status === 'booked'
}

export function TravelBookingFormPage({ workspaceId, booking, existingPassengers = [], onCancel, onSaved }: TravelBookingFormPageProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const initializedBookingId = useRef<string | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [passengers, setPassengers] = useState<PassengerDraft[]>(() => [createPassengerDraft(crypto.randomUUID())])
    const [currency, setCurrency] = useState<CurrencyCode>(features.default_currency)
    const [travelDate, setTravelDate] = useState('')
    const [bookingAdjustments, setBookingAdjustments] = useState<OrderAdjustment[]>([])
    const [isAdjustmentsOpen, setIsAdjustmentsOpen] = useState(false)
    const [profitAmount, setProfitAmount] = useState('')
    const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
    const [paidOnSave, setPaidOnSave] = useState(false)
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [notes, setNotes] = useState('')

    const isEditing = Boolean(booking)
    const isEditable = bookingStatusAllowsEditing(booking)
    const availableCurrencies = useMemo(
        () => Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[],
        [features.allowed_currencies, features.default_currency]
    )
    const adjustmentExchangeRates = useMemo(
        () => buildOrderExchangeRatesSnapshot({ exchangeData, eurRates, tryRates }),
        [eurRates, exchangeData, tryRates]
    )

    useEffect(() => {
        const bookingKey = booking?.id ?? '__new__'
        if (initializedBookingId.current === bookingKey) return
        initializedBookingId.current = bookingKey

        setPassengers(booking && existingPassengers.length > 0
            ? existingPassengers.map((passenger) => ({
                id: passenger.id,
                name: passenger.name,
                phoneNumber: passenger.phoneNumber ?? '',
                transportationType: passenger.transportationType,
                price: String(passenger.price)
            }))
            : [createPassengerDraft(crypto.randomUUID())])
        setCurrency(booking?.currency ?? features.default_currency)
        setTravelDate(booking?.travelDate ? formatLocalDateValue(booking.travelDate) : '')
        setBookingAdjustments(normalizeOrderAdjustments(booking?.bookingAdjustments, booking?.currency ?? features.default_currency))
        setProfitAmount(booking?.profitAmount ? String(booking.profitAmount) : '')
        setPaymentMethod(booking?.paymentMethod ?? 'cash')
        setPaidOnSave(false)
        setPaymentAccount(null)
        setNotes(booking?.notes ?? '')
    }, [booking, existingPassengers, features.default_currency])

    const amounts = useMemo(() => calculateTravelBookingAmounts(
        passengers.map((passenger) => ({ price: parseFormattedNumber(passenger.price || '0') })),
        bookingAdjustments
    ), [bookingAdjustments, passengers])
    const parsedProfit = useMemo(() => parseFormattedNumber(profitAmount || '0'), [profitAmount])
    const hasCompletePassengers = passengers.length > 0 && passengers.every((passenger) => (
        passenger.name.trim().length > 0
        && (passenger.transportationType === 'flight' || passenger.transportationType === 'bus')
        && parseFormattedNumber(passenger.price || '0') > 0
    ))
    const canSubmit = isEditable && Boolean(travelDate) && hasCompletePassengers && !isSaving

    const updatePassenger = (id: string, changes: Partial<PassengerDraft>) => {
        setPassengers((current) => current.map((passenger) => passenger.id === id ? { ...passenger, ...changes } : passenger))
    }

    const changeCurrency = (nextCurrency: CurrencyCode) => {
        const repriced = bookingAdjustments.map((adjustment) => repriceOrderAdjustment(adjustment, nextCurrency, adjustmentExchangeRates))
        if (repriced.some((adjustment) => !adjustment)) {
            toast({
                title: t('common.error'),
                description: t('orders.adjustments.exchangeRateUnavailable'),
                variant: 'destructive'
            })
            return
        }
        setCurrency(nextCurrency)
        setBookingAdjustments(repriced.filter((adjustment): adjustment is OrderAdjustment => Boolean(adjustment)))
    }

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!canSubmit) {
            toast({
                title: t('common.error'),
                description: !travelDate
                    ? t('travelTransportation.errors.travelDateRequired')
                    : t('travelTransportation.errors.passengerRequired'),
                variant: 'destructive'
            })
            return
        }

        setIsSaving(true)
        const input = {
            passengers: passengers.map((passenger) => ({
                id: passenger.id,
                name: passenger.name,
                phoneNumber: passenger.phoneNumber.trim() || null,
                transportationType: passenger.transportationType as TravelTransportationType,
                price: parseFormattedNumber(passenger.price)
            })),
            currency,
            travelDate: travelDate || null,
            bookingAdjustments,
            profitAmount: parsedProfit,
            paymentMethod,
            notes: notes.trim() || null
        }

        try {
            if (booking) {
                const result = await updateTravelBooking(booking.id, input)
                toast({ title: t('common.success'), description: t('travelTransportation.bookingSaved') })
                onSaved(result.booking.id)
            } else {
                const result = await createTravelBooking(workspaceId, {
                    ...input,
                    paidOnSave,
                    createdBy: user?.id ?? null,
                    accountId: paidOnSave ? paymentAccount?.id ?? null : null,
                    accountNameSnapshot: paidOnSave ? paymentAccount?.name ?? null : null
                })
                toast({ title: t('common.success'), description: t('travelTransportation.bookingSaved') })
                onSaved(result.booking.id)
            }
        } catch (error: unknown) {
            toast({
                title: t('common.error'),
                description: error instanceof Error ? error.message : t('travelTransportation.errors.saveFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="w-full space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <Button type="button" variant="ghost" size="icon" onClick={onCancel} disabled={isSaving} aria-label={t('common.back')}>
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <div className="min-w-0">
                        <h1 className="truncate text-2xl font-bold tracking-tight">{isEditing ? t('travelTransportation.editBooking') : t('travelTransportation.newBooking')}</h1>
                        <p className="text-sm text-muted-foreground">{t('travelTransportation.subtitle')}</p>
                    </div>
                </div>
                {booking ? <span className="rounded-full border bg-muted px-3 py-1 text-sm font-semibold">{booking.bookingNumber}</span> : null}
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,2.5fr)_minmax(400px,0.9fr)]">
                <div className="space-y-6">
                    <Card className="border-border/60 shadow-sm">
                        <CardHeader className="flex flex-row items-center justify-between gap-3">
                            <CardTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5 text-primary" />{t('travelTransportation.passengers')}</CardTitle>
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => setPassengers((current) => [...current, createPassengerDraft(crypto.randomUUID())])}
                                disabled={!isEditable || isSaving}
                            >
                                <Plus className="mr-1 h-4 w-4" />{t('travelTransportation.addPassenger')}
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {passengers.map((passenger, index) => (
                                <div key={passenger.id} className="grid gap-3 rounded-2xl border bg-muted/15 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(150px,0.8fr)_minmax(120px,0.6fr)_auto] sm:items-end">
                                    <div className="space-y-2">
                                        <Label htmlFor={`travel-passenger-name-${passenger.id}`}>{t('travelTransportation.name')} *</Label>
                                        <Input
                                            id={`travel-passenger-name-${passenger.id}`}
                                            value={passenger.name}
                                            disabled={!isEditable || isSaving}
                                            onChange={(event) => updatePassenger(passenger.id, { name: event.target.value })}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor={`travel-passenger-phone-${passenger.id}`} className="flex items-center gap-2"><Phone className="h-4 w-4 text-muted-foreground" />{t('travelTransportation.phoneNumber')}</Label>
                                        <Input
                                            id={`travel-passenger-phone-${passenger.id}`}
                                            type="tel"
                                            autoComplete="off"
                                            value={passenger.phoneNumber}
                                            disabled={!isEditable || isSaving}
                                            onChange={(event) => updatePassenger(passenger.id, { phoneNumber: event.target.value })}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>{t('travelTransportation.transportationType')} *</Label>
                                        <Select
                                            value={passenger.transportationType}
                                            disabled={!isEditable || isSaving}
                                            onValueChange={(value) => updatePassenger(passenger.id, { transportationType: value as TravelTransportationType })}
                                        >
                                            <SelectTrigger><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="flight">{t('travelTransportation.flight')}</SelectItem>
                                                <SelectItem value="bus">{t('travelTransportation.bus')}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor={`travel-passenger-price-${passenger.id}`}>{t('travelTransportation.price')} *</Label>
                                        <Input
                                            id={`travel-passenger-price-${passenger.id}`}
                                            value={formatNumericInput(passenger.price)}
                                            placeholder="0"
                                            inputMode={currency === 'iqd' ? 'numeric' : 'decimal'}
                                            disabled={!isEditable || isSaving}
                                            onChange={(event) => updatePassenger(passenger.id, {
                                                price: sanitizeNumericInput(event.target.value, { allowDecimal: currency !== 'iqd' })
                                            })}
                                        />
                                    </div>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive sm:col-span-2 sm:justify-self-end lg:col-span-1"
                                        disabled={!isEditable || isSaving || passengers.length === 1}
                                        onClick={() => setPassengers((current) => current.filter((row) => row.id !== passenger.id))}
                                        aria-label={`${t('common.delete')} ${index + 1}`}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            ))}
                        </CardContent>
                    </Card>

                    <Card className="border-border/60 shadow-sm">
                        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2"><ClipboardList className="h-5 w-5 text-primary" />{t('travelTransportation.bookingDetailsCard')}</CardTitle></CardHeader>
                        <CardContent className="space-y-3">
                            <div className="grid gap-3 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="travel-booking-date" className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-muted-foreground" />{t('travelTransportation.travelDate')} *</Label>
                                    <DateTimePicker
                                        id="travel-booking-date"
                                        mode="date"
                                        date={parseLocalDateValue(travelDate)}
                                        setDate={(value) => setTravelDate(value ? formatLocalDateValue(value) : '')}
                                        disabled={!isEditable || isSaving}
                                    />
                                </div>
                                <CurrencySelector
                                    value={currency}
                                    onChange={changeCurrency}
                                    label={`${t('travelTransportation.currency')} *`}
                                    iqdDisplayPreference={features.iqd_display_preference}
                                    allowedCurrencies={availableCurrencies}
                                    disabled={!isEditable || isSaving}
                                />
                            </div>

                            <div className="grid gap-3 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="travel-booking-profit" className="flex items-center gap-2"><CircleDollarSign className="h-4 w-4 text-muted-foreground" />{t('travelTransportation.profit')}</Label>
                                    <Input
                                        id="travel-booking-profit"
                                        value={formatNumericInput(profitAmount)}
                                        placeholder="0"
                                        inputMode={currency === 'iqd' ? 'numeric' : 'decimal'}
                                        disabled={!isEditable || isSaving}
                                        onChange={(event) => setProfitAmount(sanitizeNumericInput(event.target.value, { allowDecimal: currency !== 'iqd' }))}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="travel-booking-payment-method">{t('travelTransportation.paymentMethod')} *</Label>
                                    <PaymentMethodSelect
                                        id="travel-booking-payment-method"
                                        value={paymentMethod}
                                        onValueChange={(value) => setPaymentMethod(value as WorkspacePaymentMethod)}
                                        onLinkedPaymentAccountSelect={setPaymentAccount}
                                        workspaceId={workspaceId}
                                        methods={STANDARD_PAYMENT_METHODS}
                                        disabled={!isEditable || isSaving}
                                    />
                                </div>
                            </div>

                            <p className="text-xs text-muted-foreground">{t('travelTransportation.profitDescription')}</p>

                            {!isEditing ? <div className="space-y-3 rounded-xl border bg-muted/20 p-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium">{t('travelTransportation.paidOnSave')}</p>
                                        <p className="text-xs text-muted-foreground">{t('travelTransportation.paidOnSaveDescription')}</p>
                                    </div>
                                    <Switch checked={paidOnSave} onCheckedChange={setPaidOnSave} disabled={isSaving || parsedProfit <= 0} />
                                </div>
                                {paidOnSave && parsedProfit > 0 ? <PaymentAccountSelector
                                    workspaceId={workspaceId}
                                    value={paymentAccount?.id ?? null}
                                    onValueChange={setPaymentAccount}
                                    disabled={isSaving}
                                    cashDrawerOnly={paymentMethod === 'cash'}
                                /> : null}
                            </div> : null}

                            <div className="space-y-2">
                                <Label htmlFor="travel-booking-notes">{t('travelTransportation.notes')}</Label>
                                <Textarea id="travel-booking-notes" rows={3} value={notes} disabled={!isEditable || isSaving} onChange={(event) => setNotes(event.target.value)} />
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <div className="space-y-6">
                    <Card className="border-border/60 shadow-sm">
                        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2"><Ticket className="h-5 w-5 text-primary" />{t('travelTransportation.bookingAdjustments')}</CardTitle></CardHeader>
                        <CardContent className="space-y-3">
                            <p className="text-xs text-muted-foreground">{t('travelTransportation.adjustmentsDescription')}</p>
                            <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setIsAdjustmentsOpen(true)} disabled={!isEditable || isSaving}>
                                <Plus className="mr-2 h-4 w-4" />{t('travelTransportation.bookingAdjustments')}
                            </Button>
                            <div className="space-y-2 rounded-xl bg-muted/30 p-3">
                                <AmountRow label={t('travelTransportation.passengerTotal')} amount={amounts.passengerTotal} currency={currency} iqdPreference={features.iqd_display_preference} />
                                <AmountRow label={t('travelTransportation.bookingTotal')} amount={amounts.bookingTotal} currency={currency} iqdPreference={features.iqd_display_preference} strong />
                                <AmountRow label={t('travelTransportation.adjustedBookingTotal')} amount={amounts.adjustedBookingTotal} currency={currency} iqdPreference={features.iqd_display_preference} strong />
                                <AmountRow label={t('travelTransportation.profit')} amount={parsedProfit} currency={currency} iqdPreference={features.iqd_display_preference} />
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="border-border/60 shadow-sm">
                        <CardContent className="space-y-3 pt-5">
                            <Button type="submit" className="h-11 w-full rounded-xl font-semibold" disabled={!canSubmit}>
                                <Save className="mr-2 h-4 w-4" />{isSaving ? t('common.loading') : t('common.save')}
                            </Button>
                            <Button type="button" variant="outline" className="h-11 w-full rounded-xl" onClick={onCancel} disabled={isSaving}>
                                <Minus className="mr-2 h-4 w-4" />{t('common.cancel')}
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </div>

            <OrderAdjustmentsDialog
                open={isAdjustmentsOpen}
                onOpenChange={setIsAdjustmentsOpen}
                adjustments={bookingAdjustments}
                onAdjustmentsChange={setBookingAdjustments}
                orderCurrency={currency}
                exchangeRates={adjustmentExchangeRates}
                availableCurrencies={availableCurrencies}
                iqdDisplayPreference={features.iqd_display_preference}
                translationKeyPrefix="travelTransportation.adjustmentDialog"
            />
        </form>
    )
}

function AmountRow({
    label,
    amount,
    currency,
    iqdPreference,
    strong = false
}: {
    label: string
    amount: number
    currency: CurrencyCode
    iqdPreference: 'IQD' | 'د.ع'
    strong?: boolean
}) {
    return (
        <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className={strong ? 'font-bold' : 'font-medium'}>{formatCurrency(amount, currency, iqdPreference)}</span>
        </div>
    )
}
