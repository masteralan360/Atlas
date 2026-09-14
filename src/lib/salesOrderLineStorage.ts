type SalesOrderLineProductSelection = {
    productId: string
    productSearch: string
    unitPrice: string
    batchId: string
    priceBookId: string
    priceBookItemId: string
    priceSourceCurrency: string
    priceBookCostPrice: string
}

/** Clears product-specific values when a sales line moves to Services. */
export function clearSalesItemProductForServicesStorage(
    item: SalesOrderLineProductSelection
): SalesOrderLineProductSelection {
    return {
        ...item,
        productId: '',
        productSearch: '',
        unitPrice: '',
        batchId: '',
        priceBookId: '',
        priceBookItemId: '',
        priceSourceCurrency: '',
        priceBookCostPrice: ''
    }
}
