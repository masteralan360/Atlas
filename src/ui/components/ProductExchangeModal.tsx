import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, CircleCheck, Loader2, LockKeyhole, PackageCheck, Warehouse } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatCurrency, cn } from '@/lib/utils'
import { isPositiveQuantity, roundQuantity } from '@/lib/quantity'
import type { PaymentAccount, Product, Storage } from '@/local-db'
import { ProductAutocompleteInput } from '@/ui/components/orders/ProductAutocompleteInput'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { ProductsViewModal, ProductsViewModalTrigger } from '@/ui/components/ProductsViewModal'
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
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
} from '@/ui/components'

export type ProductExchangeSettlementMethod = 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'bank_transfer'

export interface ProductExchangeSaleItem {
    /** The immutable sale-item id. */
    id: string
    productId: string
    name: string
    sku?: string | null
    unit?: string | null
    /** Quantity still eligible for return/exchange. */
    returnableQuantity: number
    /** The original unit price in the sale's settlement currency. */
    unitPrice: number
    /** Price Book that priced this sale item, when POS had one selected. */
    priceBookId?: string | null
}

export type ProductExchangeStorage = Storage

export interface ProductExchangeReplacementProduct {
    id: string
    storageId: string
    name: string
    sku?: string | null
    unit?: string | null
    /** Current product price, expressed in `currency`. */
    unitPrice: number
    currency: string
    /**
     * Current product price converted to the original sale settlement currency.
     * The parent owns conversion/rate selection so this dialog never performs
     * mixed-currency calculations itself.
     */
    replacementUnitAmount: number
    /** Quantity currently available in this storage. */
    availableQuantity: number
}

export interface ProductExchangeDraft {
    originalSaleItemId: string
    returnedProductId: string
    returnQuantity: number
    returnUnitPrice: number
    replacementStorageId: string
    replacementProductId: string
    replacementQuantity: number
    /** Replacement unit amount in the original sale settlement currency. */
    replacementUnitAmount: number
    returnedTotal: number
    replacementTotal: number
    /** Positive means collect from the customer; negative means refund. */
    difference: number
    settlementMethod?: ProductExchangeSettlementMethod
    accountId?: string | null
    accountNameSnapshot?: string | null
}

interface ProductExchangeModalProps {
    isOpen: boolean
    onClose: () => void
    saleItems: ProductExchangeSaleItem[]
    storages: ProductExchangeStorage[]
    /** Catalog records used by the standard autocomplete and browse-products modal. */
    productCatalog: Product[] & { readonly isLoading?: boolean }
    /** Product stock must be supplied per storage, with current price and availability. */
    replacementProducts: ProductExchangeReplacementProduct[]
    /** A preselected sale item is used when exchange begins from Sale Details. */
    lockedSaleItemId?: string | null
    settlementCurrency: string
    workspaceId: string
    /**
     * Returns the replacement unit amount for a product under a Price Book, in
     * the sale settlement currency, or null when the book has no override or
     * its currency does not match the sale.
     */
    resolvePriceBookReplacementAmount?: (priceBookId: string, productId: string) => number | null
    isSubmitting?: boolean
    onSubmit: (draft: ProductExchangeDraft) => Promise<void> | void
}

const SETTLEMENT_METHODS: ProductExchangeSettlementMethod[] = [
    'cash',
    'fib',
    'qicard',
    'zaincash',
    'fastpay',
    'bank_transfer',
]

function initialQuantity(maximum: number): string {
    if (!isPositiveQuantity(maximum)) return ''
    return String(roundQuantity(Math.min(1, maximum)))
}

function parseQuantity(value: string): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? roundQuantity(parsed) : 0
}

function displayProductName(product: { name: string; sku?: string | null }) {
    return product.sku ? `${product.name} (${product.sku})` : product.name
}

/**
 * Collects the complete, validated exchange draft. Persistence is intentionally
 * supplied by the parent so posting stock, return, payment, and loan changes
 * can be performed as a single transaction.
 */
export function ProductExchangeModal({
    isOpen,
    onClose,
    saleItems,
    storages,
    productCatalog,
    replacementProducts,
    lockedSaleItemId,
    settlementCurrency,
    workspaceId,
    resolvePriceBookReplacementAmount,
    isSubmitting = false,
    onSubmit,
}: ProductExchangeModalProps) {
    const { t } = useTranslation()
    const isProductsLoading = Boolean(productCatalog.isLoading)
    const [saleItemId, setSaleItemId] = useState('')
    const [returnQuantity, setReturnQuantity] = useState('')
    const [storageId, setStorageId] = useState('')
    const [replacementProductId, setReplacementProductId] = useState('')
    const [replacementProductSearch, setReplacementProductSearch] = useState('')
    const [replacementQuantity, setReplacementQuantity] = useState('')
    const [isReplacementProductsViewOpen, setIsReplacementProductsViewOpen] = useState(false)
    const [settlementMethod, setSettlementMethod] = useState<ProductExchangeSettlementMethod>('cash')
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [submitError, setSubmitError] = useState('')

    const selectedSaleItem = useMemo(
        () => saleItems.find((item) => item.id === saleItemId),
        [saleItemId, saleItems],
    )
    const storageProducts = useMemo(
        () => replacementProducts.filter((product) => product.storageId === storageId && isPositiveQuantity(product.availableQuantity)),
        [replacementProducts, storageId],
    )
    const selectedReplacementProduct = useMemo(
        () => storageProducts.find((product) => product.id === replacementProductId),
        [replacementProductId, storageProducts],
    )
    const autocompleteReplacementProducts = useMemo(() => {
        const availableIds = new Set(storageProducts.map((product) => product.id))
        return productCatalog.filter((product) => availableIds.has(product.id))
    }, [productCatalog, storageProducts])

    const returnedQuantityValue = parseQuantity(returnQuantity)
    const replacementQuantityValue = parseQuantity(replacementQuantity)
    const returnedTotal = selectedSaleItem ? roundQuantity(selectedSaleItem.unitPrice * returnedQuantityValue) : 0
    const effectiveReplacementUnitAmount = selectedSaleItem?.priceBookId && selectedReplacementProduct
        ? (resolvePriceBookReplacementAmount?.(selectedSaleItem.priceBookId, selectedReplacementProduct.id)
            ?? selectedReplacementProduct.replacementUnitAmount)
        : (selectedReplacementProduct?.replacementUnitAmount ?? 0)
    const replacementTotal = selectedReplacementProduct
        ? roundQuantity(effectiveReplacementUnitAmount * replacementQuantityValue)
        : 0
    const difference = roundQuantity(replacementTotal - returnedTotal)

    const isReturnQuantityValid = !!selectedSaleItem
        && isPositiveQuantity(returnedQuantityValue)
        && returnedQuantityValue <= selectedSaleItem.returnableQuantity
    const isReplacementQuantityValid = !!selectedReplacementProduct
        && isPositiveQuantity(replacementQuantityValue)
        && replacementQuantityValue <= selectedReplacementProduct.availableQuantity
    const canSubmit = isReturnQuantityValid && isReplacementQuantityValid && !!storageId
    const hasReturnQuantityError = !!selectedSaleItem && !isReturnQuantityValid
    const hasReplacementQuantityError = !!selectedReplacementProduct && !isReplacementQuantityValid
    const returnQuantityError = !selectedSaleItem
        ? ''
        : !isPositiveQuantity(returnedQuantityValue)
            ? t('sales.exchange.returnQuantityRequired', { defaultValue: 'Enter a return quantity greater than zero.' })
            : t('sales.exchange.returnQuantityExceedsAvailable', {
                defaultValue: 'Return quantity cannot exceed {{quantity}}.',
                quantity: selectedSaleItem.returnableQuantity,
            })
    const replacementQuantityError = !selectedReplacementProduct
        ? ''
        : !isPositiveQuantity(replacementQuantityValue)
            ? t('sales.exchange.replacementQuantityRequired', { defaultValue: 'Enter a replacement quantity greater than zero.' })
            : t('sales.exchange.replacementQuantityExceedsAvailable', {
                defaultValue: 'Replacement quantity cannot exceed the available stock of {{quantity}}.',
                quantity: selectedReplacementProduct.availableQuantity,
            })

    const reset = () => {
        setSaleItemId('')
        setReturnQuantity('')
        setStorageId('')
        setReplacementProductId('')
        setReplacementProductSearch('')
        setReplacementQuantity('')
        setIsReplacementProductsViewOpen(false)
        setSettlementMethod('cash')
        setPaymentAccount(null)
        setSubmitError('')
    }

    useEffect(() => {
        if (!isOpen) reset()
    }, [isOpen])

    useEffect(() => {
        if (!isOpen || !lockedSaleItemId) return
        const item = saleItems.find((candidate) => candidate.id === lockedSaleItemId)
        if (!item) return
        setSaleItemId(item.id)
        setReturnQuantity(initialQuantity(item.returnableQuantity))
        setSubmitError('')
    }, [isOpen, lockedSaleItemId, saleItems])

    const handleSaleItemChange = (nextSaleItemId: string) => {
        const item = saleItems.find((candidate) => candidate.id === nextSaleItemId)
        setSaleItemId(nextSaleItemId)
        setReturnQuantity(item ? initialQuantity(item.returnableQuantity) : '')
        setSubmitError('')
    }

    const handleStorageChange = (nextStorageId: string) => {
        setStorageId(nextStorageId)
        setReplacementProductId('')
        setReplacementProductSearch('')
        setReplacementQuantity('')
        setSubmitError('')
    }

    const selectReplacementProduct = (nextProductId: string, nextStorageId = storageId) => {
        const product = replacementProducts.find((candidate) => (
            candidate.id === nextProductId && candidate.storageId === nextStorageId
        ))
        setStorageId(nextStorageId)
        setReplacementProductId(product?.id || '')
        setReplacementProductSearch(product?.name || '')
        setReplacementQuantity(product ? initialQuantity(product.availableQuantity) : '')
        setSubmitError('')
    }

    const handleReplacementSearchChange = (value: string) => {
        setReplacementProductSearch(value)
        if (replacementProductId) {
            setReplacementProductId('')
            setReplacementQuantity('')
        }
        setSubmitError('')
    }

    const productViewFilter = (catalog: Product[], selectedStorageId: string) => {
        const availableIds = new Set(
            replacementProducts
                .filter((product) => product.storageId === selectedStorageId && isPositiveQuantity(product.availableQuantity))
                .map((product) => product.id),
        )
        return catalog.filter((product) => availableIds.has(product.id))
    }

    const handleSubmit = async () => {
        if (!selectedSaleItem || !selectedReplacementProduct || !canSubmit) {
            setSubmitError(t('sales.exchange.completeAllFields', { defaultValue: 'Select both products and enter valid quantities.' }))
            return
        }

        setSubmitError('')
        try {
            await onSubmit({
                originalSaleItemId: selectedSaleItem.id,
                returnedProductId: selectedSaleItem.productId,
                returnQuantity: returnedQuantityValue,
                returnUnitPrice: selectedSaleItem.unitPrice,
                replacementStorageId: storageId,
                replacementProductId: selectedReplacementProduct.id,
                replacementQuantity: replacementQuantityValue,
                replacementUnitAmount: effectiveReplacementUnitAmount,
                returnedTotal,
                replacementTotal,
                difference,
                settlementMethod: difference === 0 ? undefined : settlementMethod,
                accountId: difference === 0 ? null : paymentAccount?.id ?? null,
                accountNameSnapshot: difference === 0 ? null : paymentAccount?.name ?? null,
            })
            onClose()
        } catch (error) {
            console.error('[ProductExchangeModal] Failed to submit exchange', error)
            setSubmitError(t('sales.exchange.submitFailed', { defaultValue: 'The exchange could not be completed. Please try again.' }))
        }
    }

    const currency = settlementCurrency || 'usd'
    const methodLabel = (method: ProductExchangeSettlementMethod) => t(`directTransactions.paymentMethod.${method === 'bank_transfer' ? 'bankTransfer' : method}`, {
        defaultValue: method === 'bank_transfer' ? 'Bank Transfer' : method.toUpperCase(),
    })

    return (
        <>
            <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !isSubmitting) onClose() }}>
            <DialogContent layout="structured" className="max-w-3xl" showCloseButton={!isSubmitting}>
                <DialogHeader layout="structured">
                    <DialogTitle className="flex items-center gap-2 text-xl font-bold">
                        <ArrowRightLeft className="h-5 w-5 text-primary" />
                        {t('sales.exchange.title', { defaultValue: 'Product Exchange' })}
                    </DialogTitle>
                    <DialogDescription>
                        {t('sales.exchange.description', { defaultValue: 'Return a product from this sale and replace it from a selected storage.' })}
                    </DialogDescription>
                </DialogHeader>

                <DialogBody className="space-y-6">
                    {saleItems.length === 0 ? (
                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
                            {t('sales.exchange.noReturnableItems', { defaultValue: 'There are no products remaining in this sale that can be exchanged.' })}
                        </div>
                    ) : (
                        <>
                            <section className="space-y-3 rounded-2xl border border-border/70 bg-muted/20 p-4">
                                <div className="flex items-center gap-2 text-sm font-semibold">
                                    <PackageCheck className="h-4 w-4 text-primary" />
                                    {t('sales.exchange.returnItem', { defaultValue: 'Product to return' })}
                                </div>
                                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                                    <div className="space-y-2">
                                        <Label>{t('sales.exchange.returnItem', { defaultValue: 'Product to return' })}</Label>
                                        {lockedSaleItemId ? (
                                            <div className="flex h-10 items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 text-sm font-medium text-foreground">
                                                <LockKeyhole className="h-4 w-4 shrink-0 text-primary" />
                                                <span className="truncate">{selectedSaleItem ? displayProductName(selectedSaleItem) : t('sales.exchange.selectSaleProduct', { defaultValue: 'Select a product from the sale' })}</span>
                                            </div>
                                        ) : (
                                            <Select value={saleItemId} onValueChange={handleSaleItemChange} disabled={isSubmitting}>
                                                <SelectTrigger><SelectValue placeholder={t('sales.exchange.selectSaleProduct', { defaultValue: 'Select a product from the sale' })} /></SelectTrigger>
                                                <SelectContent>
                                                    {saleItems.map((item) => (
                                                        <SelectItem key={item.id} value={item.id}>
                                                            {displayProductName(item)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        )}
                                        {selectedSaleItem && (
                                            <p className="text-xs text-muted-foreground">
                                                {t('sales.exchange.availableToExchange', {
                                                    defaultValue: 'Available to exchange: {{quantity}}',
                                                    quantity: selectedSaleItem.returnableQuantity,
                                                })}
                                            </p>
                                        )}
                                    </div>
                                    <QuantityField
                                        label={t('sales.exchange.returnQuantity', { defaultValue: 'Return quantity' })}
                                        value={returnQuantity}
                                        onChange={setReturnQuantity}
                                        max={selectedSaleItem?.returnableQuantity}
                                        disabled={!selectedSaleItem || isSubmitting}
                                        invalid={hasReturnQuantityError}
                                        errorMessage={returnQuantityError}
                                        errorId="exchange-return-quantity-error"
                                    />
                                </div>
                                <SummaryLine
                                    label={t('sales.exchange.returnTotal', { defaultValue: 'Return total' })}
                                    value={formatCurrency(returnedTotal, currency)}
                                />
                            </section>

                            <section className="space-y-3 rounded-2xl border border-border/70 p-4">
                                <div className="flex items-center gap-2 text-sm font-semibold">
                                    <Warehouse className="h-4 w-4 text-primary" />
                                    {t('sales.exchange.replacementProduct', { defaultValue: 'Replacement product' })}
                                </div>
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label>{t('sales.exchange.replacementStorage', { defaultValue: 'Replacement storage' })}</Label>
                                        <Select value={storageId} onValueChange={handleStorageChange} disabled={isSubmitting}>
                                            <SelectTrigger><SelectValue placeholder={t('sales.exchange.selectStorage', { defaultValue: 'Select storage' })} /></SelectTrigger>
                                            <SelectContent>
                                                {storages.map((storage) => (
                                                    <SelectItem key={storage.id} value={storage.id}>{storage.name}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label isLoading={isProductsLoading}>{t('sales.exchange.replacementProduct', { defaultValue: 'Replacement product' })}</Label>
                                        <div className="flex items-center">
                                            <ProductsViewModalTrigger
                                                label={t('sales.exchange.browseProducts', { defaultValue: 'Browse products' })}
                                                onClick={() => setIsReplacementProductsViewOpen(true)}
                                            />
                                            <ProductAutocompleteInput
                                                className="min-w-0 flex-1"
                                                inputClassName="rounded-s-none"
                                                value={replacementProductSearch}
                                                onChange={handleReplacementSearchChange}
                                                onSelectProduct={(product) => selectReplacementProduct(product.id)}
                                                products={autocompleteReplacementProducts}
                                                isLoading={isProductsLoading}
                                                placeholder={t('sales.exchange.searchReplacementProduct', { defaultValue: 'Search by product name or SKU' })}
                                                disabled={!storageId || storageProducts.length === 0 || isSubmitting}
                                                hasSelection={!!selectedReplacementProduct}
                                                linkedLabel={t('common.selected', { defaultValue: 'Selected' })}
                                                showLinkedIndicator={!!selectedReplacementProduct}
                                            />
                                        </div>
                                        {storageId && storageProducts.length === 0 && (
                                            <p className="text-xs text-amber-700 dark:text-amber-300">
                                                {t('sales.exchange.noProductsInStorage', { defaultValue: 'This storage has no products available for exchange.' })}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
                                    <QuantityField
                                        label={t('sales.exchange.replacementQuantity', { defaultValue: 'Replacement quantity' })}
                                        value={replacementQuantity}
                                        onChange={setReplacementQuantity}
                                        max={selectedReplacementProduct?.availableQuantity}
                                        disabled={!selectedReplacementProduct || isSubmitting}
                                        invalid={hasReplacementQuantityError}
                                        errorMessage={replacementQuantityError}
                                        errorId="exchange-replacement-quantity-error"
                                    />
                                    <div className="flex items-end">
                                        {selectedReplacementProduct && (
                                            <div className="grid gap-1 pb-1 text-xs text-muted-foreground">
                                                <p>
                                                    {t('sales.exchange.availableStock', {
                                                        defaultValue: 'Available stock: {{quantity}}',
                                                        quantity: selectedReplacementProduct.availableQuantity,
                                                    })}
                                                </p>
                                                <p>
                                                    {t('sales.exchange.unitPrice', { defaultValue: 'Unit price' })}: {formatCurrency(effectiveReplacementUnitAmount, currency)}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <SummaryLine
                                    label={t('sales.exchange.replacementTotal', { defaultValue: 'Replacement total' })}
                                    value={formatCurrency(replacementTotal, currency)}
                                />
                            </section>

                            <section className={cn(
                                'rounded-2xl border p-4',
                                difference > 0 && 'border-amber-500/40 bg-amber-500/10',
                                difference < 0 && 'border-sky-500/40 bg-sky-500/10',
                                difference === 0 && 'border-primary/25 bg-primary/5',
                            )}>
                                <SummaryLine
                                    label={t('sales.exchange.difference', { defaultValue: 'Difference' })}
                                    value={formatCurrency(Math.abs(difference), currency)}
                                    valueClassName="text-base"
                                />
                                {difference === 0 ? (
                                    <div className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
                                        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                        <p>{t('sales.exchange.evenExchange', { defaultValue: 'Even exchange - no payment or refund is needed.' })}</p>
                                    </div>
                                ) : (
                                    <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_13rem] sm:items-end">
                                        <div className="flex items-start gap-3" role="status">
                                            <span className={cn(
                                                'grid h-10 w-10 shrink-0 place-items-center rounded-full',
                                                difference > 0 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
                                            )}>
                                                {difference > 0 ? <ArrowDownToLine className="h-5 w-5" /> : <ArrowUpFromLine className="h-5 w-5" />}
                                            </span>
                                            <div className="space-y-0.5">
                                                <p className="text-sm font-semibold">
                                                    {difference > 0
                                                        ? t('sales.exchange.collectionRequired', { defaultValue: 'Collection required' })
                                                        : t('sales.exchange.refundRequired', { defaultValue: 'Refund required' })}
                                                </p>
                                                <p className="text-sm text-muted-foreground">
                                                    {difference > 0
                                                        ? t('sales.exchange.customerPaysDifference', {
                                                            defaultValue: 'Collect {{amount}} from the customer.',
                                                            amount: formatCurrency(Math.abs(difference), currency),
                                                        })
                                                        : t('sales.exchange.customerReceivesRefund', {
                                                            defaultValue: 'Refund {{amount}} to the customer.',
                                                            amount: formatCurrency(Math.abs(difference), currency),
                                                        })}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label>
                                                {difference > 0
                                                    ? t('sales.exchange.paymentMethod', { defaultValue: 'Payment method' })
                                                    : t('sales.exchange.refundMethod', { defaultValue: 'Refund method' })}
                                            </Label>
                                            <Select value={settlementMethod} onValueChange={(value) => setSettlementMethod(value as ProductExchangeSettlementMethod)} disabled={isSubmitting}>
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    {SETTLEMENT_METHODS.map((method) => (
                                                        <SelectItem key={method} value={method}>{methodLabel(method)}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <PaymentAccountSelector
                                            workspaceId={workspaceId}
                                            value={paymentAccount?.id ?? null}
                                            onValueChange={setPaymentAccount}
                                            disabled={isSubmitting}
                                            cashDrawerOnly={settlementMethod === 'cash'}
                                        />
                                    </div>
                                )}
                            </section>
                        </>
                    )}
                    {submitError && <p className="text-sm font-medium text-destructive" role="alert">{submitError}</p>}
                </DialogBody>

                <DialogFooter layout="structured">
                    <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                        {t('common.cancel', { defaultValue: 'Cancel' })}
                    </Button>
                    <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit || isSubmitting}>
                        {isSubmitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                        {isSubmitting
                            ? t('sales.exchange.processing', { defaultValue: 'Completing…' })
                            : t('sales.exchange.complete', { defaultValue: 'Complete Exchange' })}
                    </Button>
                </DialogFooter>
            </DialogContent>
            </Dialog>
            <ProductsViewModal
                open={isReplacementProductsViewOpen}
                onOpenChange={setIsReplacementProductsViewOpen}
                products={productCatalog}
                storages={storages}
                initialStorageId={storageId}
                filterProducts={productViewFilter}
                labels={{
                    title: t('sales.exchange.browseProducts', { defaultValue: 'Browse products' }),
                    description: t('sales.exchange.browseProductsDescription', { defaultValue: 'Choose an in-stock replacement product from a storage.' }),
                    searchLabel: t('common.search', { defaultValue: 'Search' }),
                    searchPlaceholder: t('sales.exchange.searchReplacementProduct', { defaultValue: 'Search by product name or SKU' }),
                    storageLabel: t('sales.exchange.replacementStorage', { defaultValue: 'Replacement storage' }),
                    storagePlaceholder: t('sales.exchange.selectStorage', { defaultValue: 'Select storage' }),
                    noProductsLabel: t('sales.exchange.noProductsInStorage', { defaultValue: 'This storage has no products available for exchange.' }),
                    noResultsLabel: t('common.noResults', { defaultValue: 'No matching products found.' }),
                }}
                onSelectProduct={(product, selectedStorageId) => {
                    selectReplacementProduct(product.id, selectedStorageId)
                }}
            />
        </>
    )
}

function QuantityField({
    label,
    value,
    onChange,
    max,
    disabled,
    invalid = false,
    errorMessage,
    errorId,
}: {
    label: string
    value: string
    onChange: (value: string) => void
    max?: number
    disabled: boolean
    invalid?: boolean
    errorMessage?: string
    errorId?: string
}) {
    return (
        <div className="space-y-2">
            <Label>{label}</Label>
            <Input
                inputMode="decimal"
                type="number"
                min="0"
                max={max}
                step="any"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                disabled={disabled}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                className={cn(invalid && 'border-destructive bg-destructive/5 text-destructive focus-visible:ring-destructive')}
            />
            {invalid && errorMessage && (
                <p id={errorId} className="flex items-start gap-1.5 text-xs font-medium text-destructive" role="alert">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {errorMessage}
                </p>
            )}
        </div>
    )
}

function SummaryLine({
    label,
    value,
    valueClassName,
}: {
    label: string
    value: string
    valueClassName?: string
}) {
    return (
        <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-3 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className={cn('font-semibold text-foreground', valueClassName)}>{value}</span>
        </div>
    )
}
