import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, CalendarDays, Camera, CircleDollarSign, Eye, Plane, Plus, Trash2, TriangleAlert, Upload, UserRound, UsersRound, Lock } from 'lucide-react'
import { useLocation, useRoute } from 'wouter'

import { useAuth } from '@/auth'
import {
    createSupplier,
    createTravelAgencySale,
    updateTravelAgencySale,
    useSuppliers,
    useTravelAgencySale,
    type CurrencyCode,
    type Supplier,
    type TravelAgencyPaymentMethod,
    type TravelAgencyReceiver,
    type TravelAgencySale,
    type TravelAgencySaleStatus,
    type TravelAgencyTourist,
    type TravelAgencyTravelMethod,
    type TravelAgencyTravelPlan,
    type TravelAgencyTripType
} from '@/local-db'
import { travelMethodOptions, travelPaymentMethodOptions, travelReceiverOptions, travelStatusOptions } from '@/lib/travelAgency'
import { fetchUSDToIQDRate } from '@/lib/exchangeRate'
import { cn, formatCurrency, formatNumberWithCommas, generateId, parseFormattedNumber } from '@/lib/utils'
import { TouristMrzScanDialog, type TouristMrzScanMode, type TouristMrzScanResult } from '@/ui/components/travel/TouristMrzScanDialog'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    Tabs,
    TabsList,
    TabsTrigger,
    Textarea,
    useToast
} from '@/ui/components'

type TravelPlanFormState = {
    method: TravelAgencyTravelMethod | ''
    departure: string
    arrival: string
    tripType: TravelAgencyTripType
    details: string
}

type TouristFormState = {
    id: string
    fullName: string
    surname: string
    dateOfBirth: string
    revenue: string
    notes: string
    travelPlans: TravelPlanFormState[]
}

type TravelAgencyFormState = {
    saleDate: string
    groupName: string
    groupRevenue: string
    groupTravelPlans: TravelPlanFormState[]
    tourists: TouristFormState[]
    supplierId: string
    supplierCost: string
    currency: CurrencyCode
    travelPackages: string[]
    paymentMethod: TravelAgencyPaymentMethod
    paidAmount: string
    receiver: TravelAgencyReceiver
    notes: string
    isPaid: boolean
    status: TravelAgencySaleStatus
    exchangeRatePair: string
    exchangeRateValue: string
    exchangeRateSource: string
}

type SupplierQuickCreateState = {
    name: string
    contactName: string
    email: string
    phone: string
    defaultCurrency: CurrencyCode
    notes: string
}

const NO_VALUE = '__none__'
const ADD_SUPPLIER_VALUE = '__add_supplier__'

function createEmptyTravelPlan(): TravelPlanFormState {
    return {
        method: '',
        departure: '',
        arrival: '',
        tripType: 'one_way',
        details: ''
    }
}

function createEmptyTourist(): TouristFormState {
    return {
        id: generateId(),
        fullName: '',
        surname: '',
        dateOfBirth: '',
        revenue: '',
        notes: '',
        travelPlans: [createEmptyTravelPlan()]
    }
}

function normalizeTourists(count: number, tourists: TouristFormState[]) {
    const nextCount = Math.max(1, count)
    const nextTourists = tourists.slice(0, nextCount)

    while (nextTourists.length < nextCount) {
        nextTourists.push(createEmptyTourist())
    }

    return nextTourists
}

function getDefaultExchangePair(currency: CurrencyCode) {
    return currency === 'iqd' ? 'IQD/USD' : 'USD/IQD'
}

function createEmptyTravelAgencyForm(defaultCurrency: CurrencyCode): TravelAgencyFormState {
    return {
        saleDate: new Date().toISOString().split('T')[0],
        groupName: '',
        groupRevenue: '',
        groupTravelPlans: [createEmptyTravelPlan()],
        tourists: [createEmptyTourist()],
        supplierId: '',
        supplierCost: '',
        currency: defaultCurrency,
        travelPackages: [],
        paymentMethod: 'cash',
        paidAmount: '',
        receiver: 'office',
        notes: '',
        isPaid: false,
        status: 'completed',
        exchangeRatePair: getDefaultExchangePair(defaultCurrency),
        exchangeRateValue: '',
        exchangeRateSource: ''
    }
}

function buildTravelPlan(plan: TravelPlanFormState) {
    if (!plan.method) {
        return null
    }

    return {
        method: plan.method,
        departure: plan.method === 'plane' ? plan.departure.trim() || undefined : undefined,
        arrival: plan.method === 'plane' ? plan.arrival.trim() || undefined : undefined,
        tripType: plan.method === 'plane' ? plan.tripType : undefined,
        details: plan.details.trim() || undefined
    }
}

function mapSaleToForm(sale: TravelAgencySale): TravelAgencyFormState {
    return {
        saleDate: sale.saleDate,
        groupName: sale.groupName || '',
        groupRevenue: formatNumberWithCommas(sale.groupRevenue),
        groupTravelPlans: sale.groupTravelPlans?.length > 0
            ? sale.groupTravelPlans.map(plan => ({
                method: plan.method || '',
                departure: plan.departure || '',
                arrival: plan.arrival || '',
                tripType: plan.tripType || 'one_way',
                details: plan.details || ''
            }))
            : [createEmptyTravelPlan()],
        tourists: normalizeTourists(
            sale.touristCount,
            sale.tourists.map((tourist) => ({
                id: tourist.id,
                fullName: tourist.fullName,
                surname: tourist.surname,
                dateOfBirth: tourist.dateOfBirth || '',
                revenue: tourist.revenue ? formatNumberWithCommas(tourist.revenue) : '',
                notes: tourist.notes || '',
                travelPlans: tourist.travelPlans?.length > 0
                    ? tourist.travelPlans.map(plan => ({
                        method: plan.method || '',
                        departure: plan.departure || '',
                        arrival: plan.arrival || '',
                        tripType: plan.tripType || 'one_way',
                        details: plan.details || ''
                    }))
                    : [createEmptyTravelPlan()]
            }))
        ),
        supplierId: sale.supplierId || '',
        supplierCost: formatNumberWithCommas(sale.supplierCost),
        currency: sale.currency,
        travelPackages: sale.travelPackages || [],
        paymentMethod: sale.paymentMethod,
        paidAmount: formatNumberWithCommas(sale.paidAmount),
        receiver: sale.receiver,
        notes: sale.notes || '',
        isPaid: sale.isPaid,
        status: sale.status || 'completed',
        exchangeRatePair: sale.exchangeRateSnapshot?.pair || getDefaultExchangePair(sale.currency),
        exchangeRateValue: sale.exchangeRateSnapshot?.rate != null ? formatNumberWithCommas(sale.exchangeRateSnapshot.rate) : '',
        exchangeRateSource: sale.exchangeRateSnapshot?.source || ''
    }
}

function TravelPlanEditor({
    title,
    description,
    value,
    onChange,
    action
}: {
    title: string
    description?: string
    value: TravelPlanFormState[]
    onChange: (nextValue: TravelPlanFormState[]) => void
    action?: React.ReactNode
}) {
    const addPlan = () => {
        onChange([...value, createEmptyTravelPlan()])
    }

    const removePlan = (index: number) => {
        onChange(value.filter((_, i) => i !== index))
    }

    const updatePlan = (index: number, nextPlan: TravelPlanFormState) => {
        onChange(value.map((p, i) => i === index ? nextPlan : p))
    }

    return (
        <div className="space-y-4 rounded-2xl border border-border/80 bg-muted/30 p-4">
            <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                    <h3 className="font-semibold">{title}</h3>
                    {description && <p className="text-sm text-muted-foreground">{description}</p>}
                </div>
                <div className="flex items-center gap-2">
                    {action}
                    <Button type="button" variant="outline" size="sm" onClick={addPlan}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add Item
                    </Button>
                </div>
            </div>

            <div className="grid gap-6">
                {value.map((plan, index) => (
                    <div key={index} className="relative space-y-4 rounded-xl border border-border/50 p-4">
                        {value.length > 1 && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="absolute -right-2 -top-2 h-8 w-8 rounded-full bg-background border shadow-sm hover:text-destructive"
                                onClick={() => removePlan(index)}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        )}
                        <div className="space-y-2">
                            <Label>Travel Method</Label>
                            <Select
                                value={plan.method || NO_VALUE}
                                onValueChange={(nextMethod) => updatePlan(index, {
                                    ...plan,
                                    method: nextMethod === NO_VALUE ? '' : nextMethod as TravelAgencyTravelMethod,
                                    departure: nextMethod === 'plane' ? plan.departure : '',
                                    arrival: nextMethod === 'plane' ? plan.arrival : '',
                                    tripType: nextMethod === 'plane' ? plan.tripType : 'one_way'
                                })}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Select method" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NO_VALUE}>Not set</SelectItem>
                                    {travelMethodOptions.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {plan.method === 'plane' && (
                            <div className="space-y-4 rounded-xl bg-primary/5 p-4">
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>Departure Airport</Label>
                                        <Input
                                            value={plan.departure}
                                            onChange={(event) => updatePlan(index, { ...plan, departure: event.target.value })}
                                            placeholder="Code or Name"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Arrival Airport</Label>
                                        <Input
                                            value={plan.arrival}
                                            onChange={(event) => updatePlan(index, { ...plan, arrival: event.target.value })}
                                            placeholder="Code or Name"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label>Trip Type</Label>
                                    <Tabs
                                        value={plan.tripType}
                                        onValueChange={(v) => updatePlan(index, { ...plan, tripType: v as TravelAgencyTripType })}
                                        className="w-full"
                                    >
                                        <TabsList className="grid w-full grid-cols-2">
                                            <TabsTrigger value="one_way">One Way</TabsTrigger>
                                            <TabsTrigger value="round_trip">Round Trip</TabsTrigger>
                                        </TabsList>
                                    </Tabs>
                                </div>
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label>Extra Details</Label>
                            <Input
                                value={plan.details}
                                onChange={(event) => updatePlan(index, { ...plan, details: event.target.value })}
                                placeholder="Additional info..."
                            />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

function SupplierQuickCreateDialog({
    isOpen,
    onClose,
    defaultCurrency,
    availableCurrencies,
    workspaceId,
    onCreated
}: {
    isOpen: boolean
    onClose: () => void
    defaultCurrency: CurrencyCode
    availableCurrencies: CurrencyCode[]
    workspaceId?: string
    onCreated: (supplier: Supplier) => void
}) {
    const { toast } = useToast()
    const [isSaving, setIsSaving] = useState(false)
    const [formState, setFormState] = useState<SupplierQuickCreateState>({
        name: '',
        contactName: '',
        email: '',
        phone: '',
        defaultCurrency,
        notes: ''
    })

    useEffect(() => {
        if (!isOpen) {
            setFormState({
                name: '',
                contactName: '',
                email: '',
                phone: '',
                defaultCurrency,
                notes: ''
            })
            setIsSaving(false)
        }
    }, [defaultCurrency, isOpen])

    async function handleSubmit(event: FormEvent) {
        event.preventDefault()
        if (!workspaceId) {
            return
        }

        setIsSaving(true)
        try {
            const supplier = await createSupplier(workspaceId, {
                name: formState.name.trim(),
                contactName: formState.contactName.trim() || undefined,
                email: formState.email.trim() || undefined,
                phone: formState.phone.trim() || undefined,
                defaultCurrency: formState.defaultCurrency,
                notes: formState.notes.trim() || undefined,
                address: undefined,
                city: undefined,
                country: undefined,
                creditLimit: 0
            })

            toast({ title: 'Supplier created' })
            onCreated(supplier)
            onClose()
        } catch (error: any) {
            toast({
                title: 'Error',
                description: error?.message || 'Failed to create supplier',
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-2xl rounded-3xl">
                <DialogHeader>
                    <DialogTitle>Add Supplier</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="travel-supplier-name">Company Name</Label>
                            <Input
                                id="travel-supplier-name"
                                value={formState.name}
                                onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))}
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="travel-supplier-contact">Contact Name</Label>
                            <Input
                                id="travel-supplier-contact"
                                value={formState.contactName}
                                onChange={(event) => setFormState((current) => ({ ...current, contactName: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="travel-supplier-email">Email</Label>
                            <Input
                                id="travel-supplier-email"
                                type="email"
                                value={formState.email}
                                onChange={(event) => setFormState((current) => ({ ...current, email: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="travel-supplier-phone">Phone</Label>
                            <Input
                                id="travel-supplier-phone"
                                value={formState.phone}
                                onChange={(event) => setFormState((current) => ({ ...current, phone: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                            <Label>Default Currency</Label>
                            <Select
                                value={formState.defaultCurrency}
                                onValueChange={(value) => setFormState((current) => ({ ...current, defaultCurrency: value as CurrencyCode }))}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {availableCurrencies.map((currency) => (
                                        <SelectItem key={currency} value={currency}>
                                            {currency.toUpperCase()}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2 md:col-span-2">
                            <Label htmlFor="travel-supplier-notes">Notes</Label>
                            <Textarea
                                id="travel-supplier-notes"
                                rows={4}
                                value={formState.notes}
                                onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
                            />
                        </div>
                    </div>
                    <DialogFooter className="sm:justify-between">
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={isSaving}>
                            {isSaving ? 'Saving...' : 'Create Supplier'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}

function TravelAgencySaleEditor({ saleId, readOnly = false }: { saleId?: string; readOnly?: boolean }) {
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const suppliers = useSuppliers(user?.workspaceId)
    const sale = useTravelAgencySale(saleId)
    const isEditing = Boolean(saleId)
    const [packageDraft, setPackageDraft] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const [supplierDialogOpen, setSupplierDialogOpen] = useState(false)
    const [mrzDialogState, setMrzDialogState] = useState<{
        touristIndex: number | null
        mode: TouristMrzScanMode
    }>({
        touristIndex: null,
        mode: 'upload'
    })
    const [formState, setFormState] = useState<TravelAgencyFormState>(() => createEmptyTravelAgencyForm(features.default_currency))
    const initialFormSnapshot = useRef<string | null>(null)

    const isDirty = useMemo(() => {
        if (sale?.isLocked) return false
        if (!initialFormSnapshot.current) return false
        return JSON.stringify(formState) !== initialFormSnapshot.current
    }, [formState, sale?.isLocked])

    const { showGuard, confirmNavigation, cancelNavigation, requestNavigation } = useUnsavedChangesGuard(isDirty)

    const availableCurrencies = useMemo(() => {
        const currencies: CurrencyCode[] = ['usd', 'iqd']
        if (features.eur_conversion_enabled) currencies.push('eur')
        if (features.try_conversion_enabled) currencies.push('try')
        return currencies
    }, [features.eur_conversion_enabled, features.try_conversion_enabled])

    const supplierOptions = useMemo(() => {
        if (!formState.supplierId || suppliers.some((supplier) => supplier.id === formState.supplierId)) {
            return suppliers
        }

        return [
            ...suppliers,
            {
                id: formState.supplierId,
                name: sale?.supplierName || 'Archived supplier'
            } as Supplier
        ]
    }, [formState.supplierId, sale?.supplierName, suppliers])

    const computedTotals = useMemo(() => {
        const touristRevenue = formState.tourists.reduce((sum, tourist) => sum + (parseFormattedNumber(tourist.revenue) || 0), 0)
        const groupRevenue = parseFormattedNumber(formState.groupRevenue) || 0
        const supplierCost = parseFormattedNumber(formState.supplierCost) || 0
        const paidAmount = parseFormattedNumber(formState.paidAmount) || 0

        return {
            touristRevenue,
            groupRevenue,
            supplierCost,
            paidAmount,
            totalRevenue: touristRevenue + groupRevenue,
            net: touristRevenue + groupRevenue - supplierCost
        }
    }, [formState.groupRevenue, formState.supplierCost, formState.tourists, formState.paidAmount])

    useEffect(() => {
        if (sale) {
            const mapped = mapSaleToForm(sale)
            setFormState(mapped)
            initialFormSnapshot.current = JSON.stringify(mapped)
        }
    }, [sale])

    // Set initial snapshot for new sales once the component mounts
    useEffect(() => {
        if (!isEditing && !initialFormSnapshot.current) {
            initialFormSnapshot.current = JSON.stringify(formState)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Fetch live exchange rate once on mount for new sales
    const liveRateFetched = useRef(false)
    useEffect(() => {
        if (isEditing || liveRateFetched.current) return
        liveRateFetched.current = true

        fetchUSDToIQDRate().then((result) => {
            setFormState((current) => {
                // Only set if user hasn't already typed a value
                if (current.exchangeRateValue) return current
                return {
                    ...current,
                    exchangeRateValue: formatNumberWithCommas(result.rate),
                    exchangeRateSource: result.source === 'manual' ? 'manual' : 'live'
                }
            })
        }).catch(() => {
            // Silently fail — user can enter manually
        })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const [sidebarWidth, setSidebarWidth] = useState(() => {
        const saved = localStorage.getItem('travel-sale-sidebar-width')
        return saved ? Number(saved) : 380
    })
    const [isResizing, setIsResizing] = useState(false)

    useEffect(() => {
        if (!isResizing) return

        const handleMouseMove = (e: MouseEvent) => {
            const container = document.getElementById('travel-sale-form-container')
            if (!container) return

            const containerRect = container.getBoundingClientRect()
            const newWidth = containerRect.right - e.clientX

            if (newWidth >= 250 && newWidth <= 800) {
                setSidebarWidth(newWidth)
            }
        }

        const handleMouseUp = () => {
            setIsResizing(false)
            document.body.style.cursor = 'default'
        }

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = 'col-resize'

        return () => {
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
            document.body.style.cursor = 'default'
        }
    }, [isResizing])

    useEffect(() => {
        localStorage.setItem('travel-sale-sidebar-width', String(sidebarWidth))
    }, [sidebarWidth])

    function updateTourist(index: number, updater: (tourist: TouristFormState) => TouristFormState) {
        setFormState((current) => {
            const nextTourists = current.tourists.map((tourist, touristIndex) => (
                touristIndex === index ? updater(tourist) : tourist
            ))

            let nextGroupName = current.groupName
            if (index === 0) {
                const oldTourist = current.tourists[0]
                const newTourist = nextTourists[0]

                const oldName = [oldTourist.fullName, oldTourist.surname].filter(Boolean).join(' ').trim()
                const newName = [newTourist.fullName, newTourist.surname].filter(Boolean).join(' ').trim()

                if (!current.groupName || current.groupName === oldName) {
                    nextGroupName = newName
                }
            }

            return {
                ...current,
                tourists: nextTourists,
                groupName: nextGroupName
            }
        })
    }

    function syncGroupTravelPlanToTourists() {
        setFormState((current) => ({
            ...current,
            tourists: current.tourists.map((tourist) => ({
                ...tourist,
                travelPlans: [...current.groupTravelPlans]
            }))
        }))
        toast({ title: 'Synced travel plan to all tourists' })
    }

    function handleTouristCountChange(rawValue: string) {
        const nextCount = Math.max(1, Number(rawValue || 1))
        setFormState((current) => ({
            ...current,
            tourists: normalizeTourists(nextCount, current.tourists)
        }))
    }

    function addTravelPackage() {
        const normalized = packageDraft.trim()
        if (!normalized) {
            return
        }

        setFormState((current) => ({
            ...current,
            travelPackages: current.travelPackages.includes(normalized)
                ? current.travelPackages
                : [...current.travelPackages, normalized]
        }))
        setPackageDraft('')
    }

    function openMrzDialog(touristIndex: number, mode: TouristMrzScanMode) {
        setMrzDialogState({
            touristIndex,
            mode
        })
    }

    function closeMrzDialog() {
        setMrzDialogState({
            touristIndex: null,
            mode: 'upload'
        })
    }

    function applyMrzResult(result: TouristMrzScanResult) {
        if (mrzDialogState.touristIndex === null) {
            return
        }

        updateTourist(mrzDialogState.touristIndex, (current) => ({
            ...current,
            fullName: result.fullName || current.fullName,
            surname: result.surname || current.surname,
            dateOfBirth: result.dateOfBirth || current.dateOfBirth
        }))

        closeMrzDialog()
    }

    function removeTravelPackage(travelPackage: string) {
        setFormState((current) => ({
            ...current,
            travelPackages: current.travelPackages.filter((entry) => entry !== travelPackage)
        }))
    }

    function buildTravelPlans(plans: TravelPlanFormState[]): TravelAgencyTravelPlan[] {
        return plans
            .map((p) => buildTravelPlan(p))
            .filter(Boolean) as TravelAgencyTravelPlan[]
    }

    async function handleSubmit(event: FormEvent, explicitStatus?: TravelAgencySaleStatus) {
        event.preventDefault()
        if (!user?.workspaceId) {
            return
        }

        if (!formState.saleDate) {
            toast({
                title: 'Sale date is required',
                variant: 'destructive'
            })
            return
        }

        setIsSaving(true)
        try {
            const statusToSave = explicitStatus || formState.status
            const touristCount = formState.tourists.length
            const normalizedTourists = formState.tourists.map((tourist) => ({
                id: tourist.id,
                fullName: tourist.fullName.trim(),
                surname: tourist.surname.trim(),
                dateOfBirth: tourist.dateOfBirth || undefined,
                travelPlans: buildTravelPlans(tourist.travelPlans),
                revenue: parseFormattedNumber(tourist.revenue) || 0,
                notes: tourist.notes.trim() || undefined
            })) satisfies TravelAgencyTourist[]

            const selectedSupplier = suppliers.find((supplier) => supplier.id === formState.supplierId)
            const payload = {
                saleDate: formState.saleDate,
                touristCount,
                tourists: normalizedTourists,
                groupTravelPlans: buildTravelPlans(formState.groupTravelPlans),
                groupName: formState.groupName.trim() || null,
                groupRevenue: parseFormattedNumber(formState.groupRevenue) || 0,
                supplierId: formState.supplierId || null,
                supplierName: selectedSupplier?.name || sale?.supplierName || null,
                supplierCost: parseFormattedNumber(formState.supplierCost) || 0,
                currency: formState.currency,
                travelPackages: formState.travelPackages,
                paymentMethod: formState.paymentMethod,
                paidAmount: parseFormattedNumber(formState.paidAmount) || 0,
                receiver: formState.receiver,
                notes: formState.notes.trim() || undefined,
                isPaid: formState.isPaid,
                status: statusToSave,
                paidAt: formState.isPaid ? (sale?.paidAt || new Date().toISOString()) : null,
                exchangeRateSnapshot: parseFormattedNumber(formState.exchangeRateValue)
                    ? {
                        pair: formState.exchangeRatePair,
                        rate: parseFormattedNumber(formState.exchangeRateValue) || 0,
                        source: formState.exchangeRateSource || 'manual',
                        timestamp: sale?.exchangeRateSnapshot?.timestamp || new Date().toISOString()
                    }
                    : null
            }

            if (isEditing && saleId) {
                await updateTravelAgencySale(saleId, payload)
                toast({ title: 'Travel sale updated' })
            } else {
                await createTravelAgencySale(user.workspaceId, payload)
                toast({ title: 'Travel sale created' })
            }

            navigate('/travel-agency')
        } catch (error: any) {
            toast({
                title: 'Error',
                description: error?.message || 'Failed to save travel sale',
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    if (isEditing && !sale) {
        return (
            <div className="flex min-h-[50vh] items-center justify-center">
                <div className="text-sm text-muted-foreground">Loading sale...</div>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-2">
                    <Button variant="ghost" className="w-fit gap-2 px-0" onClick={() => {
                        if (readOnly) { navigate('/travel-agency'); return }
                        if (!requestNavigation('/travel-agency')) navigate('/travel-agency')
                    }}>
                        <ArrowLeft className="h-4 w-4" />
                        Back to Travel Agency
                    </Button>
                    <div>
                        <h1 className="flex items-center gap-2 text-2xl font-bold">
                            <Plane className="h-6 w-6 text-primary" />
                            {readOnly ? (sale?.saleNumber || 'View Travel Sale') : isEditing ? (sale?.saleNumber || 'Edit Travel Sale') : 'New Travel Sale'}
                        </h1>
                        <p className="text-muted-foreground">{readOnly ? 'Viewing sale details in read-only mode.' : 'Date, tourists, packages, supplier cut, and payment details are all saved on this sale.'}</p>
                    </div>
                </div>
                {!readOnly && (
                    <div className="rounded-2xl bg-primary/10 px-4 py-3 text-sm font-semibold text-primary">
                        Date is user-controlled and never auto-overwritten.
                    </div>
                )}
            </div>

            {readOnly && (
                <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800 flex items-center gap-2">
                    <Eye className="h-5 w-5" />
                    You are viewing this sale in read-only mode.
                </div>
            )}

            {!readOnly && sale?.isLocked && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 flex items-center gap-2">
                    <Lock className="h-5 w-5" />
                    This sale is locked. It can be viewed but changes cannot be saved.
                </div>
            )}

            <form onSubmit={readOnly ? (e) => e.preventDefault() : handleSubmit} className={cn('space-y-6', readOnly && 'pointer-events-none')} id="travel-sale-form-container">
                <div className="flex flex-col gap-6 xl:flex-row">
                    <div className="min-w-0 flex-1">
                    <Card className="border-border/60 shadow-sm">
                        <CardHeader className="space-y-1">
                            <CardTitle className="flex items-center gap-2">
                                <UsersRound className="h-5 w-5 text-primary" />
                                Tourists
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">When tourist count is above one, the sale becomes a group and gets its own travel plan and revenue.</p>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="travel-sale-date" className="flex items-center gap-2">
                                        <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                        Sale Date
                                    </Label>
                                    <Input
                                        id="travel-sale-date"
                                        type="date"
                                        value={formState.saleDate}
                                        onChange={(event) => setFormState((current) => ({ ...current, saleDate: event.target.value }))}
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="travel-tourist-count">Tourists Number</Label>
                                    <Input
                                        id="travel-tourist-count"
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={formState.tourists.length}
                                        onChange={(event) => handleTouristCountChange(event.target.value)}
                                    />
                                </div>
                            </div>

                            {formState.tourists.length > 1 && (
                                <TravelPlanEditor
                                    title="Group Travel Plan"
                                    description="Apply a common plan to all tourists in this group"
                                    value={formState.groupTravelPlans}
                                    onChange={(nextPlans) => setFormState((current) => ({ ...current, groupTravelPlans: nextPlans }))}
                                    action={
                                        <Button type="button" variant="outline" size="sm" onClick={syncGroupTravelPlanToTourists}>
                                            <UsersRound className="mr-2 h-4 w-4" />
                                            Apply to all
                                        </Button>
                                    }
                                />
                            )}

                            {formState.tourists.map((tourist, index) => (
                                <div key={tourist.id} className="space-y-4 rounded-3xl border border-primary/20 bg-background p-6 shadow-sm transition-shadow hover:shadow-md">
                                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                        <div>
                                            <div className="flex items-center gap-2 text-lg font-semibold">
                                                <UserRound className="h-5 w-5 text-primary" />
                                                Tourist {index + 1}
                                            </div>
                                            <p className="text-sm text-muted-foreground">Fields can stay empty. You can add tourists now and complete their details later.</p>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="gap-2"
                                                onClick={() => openMrzDialog(index, 'upload')}
                                            >
                                                <Upload className="h-4 w-4" />
                                                Upload
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="gap-2"
                                                onClick={() => openMrzDialog(index, 'camera')}
                                            >
                                                <Camera className="h-4 w-4" />
                                                Camera
                                            </Button>
                                            <div className="rounded-2xl bg-muted px-3 py-2 text-sm font-medium">
                                                Revenue {formatCurrency(parseFormattedNumber(tourist.revenue) || 0, formState.currency, features.iqd_display_preference)}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid gap-4 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>Full Name</Label>
                                            <Input value={tourist.fullName} onChange={(event) => updateTourist(index, (current) => ({ ...current, fullName: event.target.value }))} placeholder="Given names" />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Surname</Label>
                                            <Input value={tourist.surname} onChange={(event) => updateTourist(index, (current) => ({ ...current, surname: event.target.value }))} placeholder="Family name" />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Date of Birth</Label>
                                            <Input type="date" value={tourist.dateOfBirth} onChange={(event) => updateTourist(index, (current) => ({ ...current, dateOfBirth: event.target.value }))} />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Revenue</Label>
                                            <Input value={tourist.revenue} onChange={(event) => updateTourist(index, (current) => ({ ...current, revenue: formatNumberWithCommas(event.target.value) }))} placeholder="0" />
                                        </div>
                                        <div className="space-y-2 md:col-span-2">
                                            <Label>Notes</Label>
                                            <Textarea rows={2} value={tourist.notes} onChange={(event) => updateTourist(index, (current) => ({ ...current, notes: event.target.value }))} placeholder="Anything specific about this tourist" />
                                        </div>
                                    </div>

                                    <TravelPlanEditor
                                        title="Individual Travel Plan"
                                        description="Custom plan for this tourist"
                                        value={tourist.travelPlans}
                                        onChange={(nextPlans) => updateTourist(index, (current) => ({ ...current, travelPlans: nextPlans }))}
                                    />
                                </div>
                            ))}
                        </CardContent>
                    </Card>
                </div>

                    <div
                        className={cn(
                            "hidden xl:flex w-2 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/30",
                            isResizing && "bg-primary/50"
                        )}
                        onMouseDown={(e) => {
                            e.preventDefault()
                            setIsResizing(true)
                        }}
                    >
                        <div className="h-10 w-[3px] rounded-full bg-border" />
                    </div>

                    <div className="space-y-6" style={{ width: `var(--sidebar-width, ${sidebarWidth}px)` }}>
                        <style dangerouslySetInnerHTML={{ __html: `@media (min-width: 1280px) { :root { --sidebar-width: ${sidebarWidth}px; } }` }} />
                        <Card className="border-border/60 shadow-sm">
                            <CardHeader className="space-y-1">
                                <CardTitle>Sale Setup</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>Currency</Label>
                                        <Select value={formState.currency} onValueChange={(value) => setFormState((current) => ({ ...current, currency: value as CurrencyCode }))}>
                                            <SelectTrigger><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                {availableCurrencies.map((currency) => (
                                                    <SelectItem key={currency} value={currency}>{currency.toUpperCase()}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Group Name</Label>
                                        <Input value={formState.groupName} onChange={(event) => setFormState((current) => ({ ...current, groupName: event.target.value }))} placeholder="Optional group name" />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Group Revenue</Label>
                                        <Input value={formState.groupRevenue} onChange={(event) => setFormState((current) => ({ ...current, groupRevenue: formatNumberWithCommas(event.target.value) }))} placeholder="0" />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Supplier Cost</Label>
                                        <Input value={formState.supplierCost} onChange={(event) => setFormState((current) => ({ ...current, supplierCost: formatNumberWithCommas(event.target.value) }))} placeholder="0" />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label>Supplier</Label>
                                    <Select
                                        value={formState.supplierId || NO_VALUE}
                                        onValueChange={(value) => {
                                            if (value === ADD_SUPPLIER_VALUE) {
                                                setSupplierDialogOpen(true)
                                                return
                                            }
                                            setFormState((current) => ({ ...current, supplierId: value === NO_VALUE ? '' : value }))
                                        }}
                                    >
                                        <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={NO_VALUE}>No supplier</SelectItem>
                                            {supplierOptions.map((supplier) => (
                                                <SelectItem key={supplier.id} value={supplier.id}>{supplier.name}</SelectItem>
                                            ))}
                                            <SelectItem value={ADD_SUPPLIER_VALUE}>Add Supplier...</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="space-y-2">
                                    <Label>Travel Packages</Label>
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={packageDraft}
                                            onChange={(event) => setPackageDraft(event.target.value)}
                                            placeholder="Add package name, for example Berlin Package"
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                    event.preventDefault()
                                                    addTravelPackage()
                                                }
                                            }}
                                        />
                                        <Button type="button" className="gap-2" onClick={addTravelPackage}>
                                            <Plus className="h-4 w-4" />
                                            Add Package
                                        </Button>
                                    </div>
                                    <div className="flex flex-wrap gap-2 pt-2">
                                        {formState.travelPackages.length === 0 && <span className="text-sm text-muted-foreground">No packages added yet.</span>}
                                        {formState.travelPackages.map((travelPackage) => (
                                            <button key={travelPackage} type="button" onClick={() => removeTravelPackage(travelPackage)} className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                                                {travelPackage}
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label>Payment Method</Label>
                                    <Select value={formState.paymentMethod} onValueChange={(value) => setFormState((current) => ({ ...current, paymentMethod: value as TravelAgencyPaymentMethod }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {travelPaymentMethodOptions.map((option) => (
                                                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label>Receiver</Label>
                                    <Select value={formState.receiver} onValueChange={(value) => setFormState((current) => ({ ...current, receiver: value as TravelAgencyReceiver }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {travelReceiverOptions.map((option) => (
                                                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="space-y-2">
                                    <Label>Sale Status</Label>
                                    <Select value={formState.status} onValueChange={(value) => setFormState((current) => ({ ...current, status: value as TravelAgencySaleStatus }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {travelStatusOptions.map((option) => (
                                                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="flex items-center justify-between rounded-2xl border bg-muted/20 px-4 py-3">
                                    <div>
                                        <div className="text-sm font-medium">Paid on save</div>
                                        <div className="text-xs text-muted-foreground">You can still pay or unpay this sale later from the list page.</div>
                                    </div>
                                    <Switch checked={formState.isPaid} onCheckedChange={(checked) => setFormState((current) => ({ ...current, isPaid: checked }))} />
                                </div>

                                <div className="space-y-2">
                                    <Label>Sale Notes</Label>
                                    <Textarea rows={4} value={formState.notes} onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))} placeholder="Optional notes about this sale" />
                                </div>

                                {/* Exchange Rate Section */}
                                <div className="space-y-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
                                    <div className="flex items-center justify-between">
                                        <div className="text-sm font-semibold">Exchange Rate</div>
                                        {formState.exchangeRateSource && (
                                            <span className={cn(
                                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                                                formState.exchangeRateSource === 'live'
                                                    ? 'bg-emerald-100 text-emerald-700'
                                                    : formState.exchangeRateSource === 'manual'
                                                        ? 'bg-amber-100 text-amber-700'
                                                        : 'bg-blue-100 text-blue-700'
                                            )}>
                                                {formState.exchangeRateSource === 'live' ? 'Live' : formState.exchangeRateSource === 'manual' ? 'Manual' : 'From Sale'}
                                            </span>
                                        )}
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="space-y-1">
                                            <Label className="text-xs text-muted-foreground">Pair</Label>
                                            <Select
                                                value={formState.exchangeRatePair}
                                                onValueChange={(value) => setFormState((current) => ({ ...current, exchangeRatePair: value }))}
                                            >
                                                <SelectTrigger className="h-9">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="IQD/USD">IQD / USD</SelectItem>
                                                    <SelectItem value="USD/IQD">USD / IQD</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs text-muted-foreground">Rate</Label>
                                            <Input
                                                className="h-9"
                                                value={formState.exchangeRateValue}
                                                onChange={(event) => setFormState((current) => ({
                                                    ...current,
                                                    exchangeRateValue: formatNumberWithCommas(event.target.value),
                                                    exchangeRateSource: 'manual'
                                                }))}
                                                placeholder="e.g. 148,500"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="border-border/60 shadow-sm">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <CircleDollarSign className="h-5 w-5 text-primary" />
                                    Commercial Summary
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <div className="flex items-center justify-between text-sm"><span>Tourist Revenue</span><span className="font-semibold">{formatCurrency(computedTotals.touristRevenue, formState.currency, features.iqd_display_preference)}</span></div>
                                <div className="flex items-center justify-between text-sm"><span>Group Revenue</span><span className="font-semibold">{formatCurrency(computedTotals.groupRevenue, formState.currency, features.iqd_display_preference)}</span></div>
                                <div className="flex items-center justify-between text-sm"><span>Supplier Cost</span><span className="font-semibold">{formatCurrency(computedTotals.supplierCost, formState.currency, features.iqd_display_preference)}</span></div>
                                <div className="border-t pt-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-medium">Commission</span>
                                        <span className={cn('text-xl font-black', computedTotals.net >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                                            {formatCurrency(computedTotals.net, formState.currency, features.iqd_display_preference)}
                                        </span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>

                {readOnly ? (
                    <div className="flex border-t pt-6 pointer-events-auto">
                        <Button type="button" variant="outline" onClick={() => navigate('/travel-agency')}>Back to Travel Agency</Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:justify-between">
                        <Button type="button" variant="outline" onClick={() => {
                            if (!requestNavigation('/travel-agency')) navigate('/travel-agency')
                        }}>Cancel</Button>
                        <div className="flex flex-col gap-3 sm:flex-row">
                            <Button
                                type="button"
                                variant="secondary"
                                className="bg-slate-200 text-slate-700 hover:bg-slate-300"
                                disabled={isSaving || sale?.isLocked}
                                onClick={(e) => handleSubmit(e, 'draft')}
                            >
                                {isSaving ? 'Saving...' : 'Save as Draft'}
                            </Button>
                            <Button
                                type="submit"
                                disabled={isSaving || sale?.isLocked}
                                onClick={() => setFormState(prev => ({ ...prev, status: 'completed' }))}
                            >
                                {isSaving ? 'Saving...' : isEditing ? 'Save Sale' : 'Create Sale'}
                            </Button>
                        </div>
                    </div>
                )}
            </form>

            {!readOnly && (
                <>
                    <SupplierQuickCreateDialog
                        isOpen={supplierDialogOpen}
                        onClose={() => setSupplierDialogOpen(false)}
                        defaultCurrency={formState.currency}
                        availableCurrencies={availableCurrencies}
                        workspaceId={user?.workspaceId}
                        onCreated={(supplier) => setFormState((current) => ({ ...current, supplierId: supplier.id }))}
                    />

                    <TouristMrzScanDialog
                        open={mrzDialogState.touristIndex !== null}
                        onOpenChange={(open) => {
                            if (!open) {
                                closeMrzDialog()
                            }
                        }}
                        touristLabel={mrzDialogState.touristIndex !== null ? `Tourist ${mrzDialogState.touristIndex + 1}` : 'Tourist'}
                        initialMode={mrzDialogState.mode}
                        onScanned={applyMrzResult}
                    />

                    {/* Unsaved Changes Guard Dialog */}
                    <Dialog open={showGuard} onOpenChange={(open) => { if (!open) cancelNavigation() }}>
                        <DialogContent className="max-w-md rounded-3xl">
                            <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                    <TriangleAlert className="h-5 w-5 text-amber-500" />
                                    Unsaved Changes
                                </DialogTitle>
                            </DialogHeader>
                            <p className="text-sm text-muted-foreground">
                                You have unsaved changes. Would you like to save your work before leaving?
                            </p>
                            <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => confirmNavigation()}>
                                    Discard
                                </Button>
                                <div className="flex gap-2">
                                    <Button
                                        variant="secondary"
                                        className="bg-slate-200 text-slate-700 hover:bg-slate-300"
                                        disabled={isSaving}
                                        onClick={async (e) => {
                                            await handleSubmit(e, 'draft')
                                            confirmNavigation()
                                        }}
                                    >
                                        {isSaving ? 'Saving...' : 'Save as Draft'}
                                    </Button>
                                    <Button
                                        disabled={isSaving}
                                        onClick={async (e) => {
                                            await handleSubmit(e, 'completed')
                                            confirmNavigation()
                                        }}
                                    >
                                        {isSaving ? 'Saving...' : 'Save & Complete'}
                                    </Button>
                                </div>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                </>
            )}
        </div>
    )
}

export function TravelAgencySaleCreate() {
    return <TravelAgencySaleEditor />
}

export function TravelAgencySaleEdit() {
    const [, params] = useRoute('/travel-agency/:saleId')
    return <TravelAgencySaleEditor saleId={params?.saleId} />
}

export function TravelAgencySaleView() {
    const [, params] = useRoute('/travel-agency/:saleId/view')
    return <TravelAgencySaleEditor saleId={params?.saleId} readOnly />
}
