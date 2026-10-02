import type { BusinessPartner, Inventory, InventoryTransaction, Loan, LoanInstallment, LoanPayment, OrderInstallment,
    OrderReturn, OrderReturnItem, PaymentAccountBalance, PaymentAccountMovement, PaymentTransaction, Product, SalesOrder, Storage } from '@/local-db/models'
import type { Action, LabConfiguration } from '../model/modelTypes'

export interface LabFixture {
    workspaceId: string
    tag: string
    userId: string | null
    customers: BusinessPartner[]
    storage: Storage
    products: Product[]
    accountId: string | null
    accountName: string | null
}
export interface SalesOrderGraph {
    orders: SalesOrder[]
    inventory: Inventory[]
    movements: InventoryTransaction[]
    payments: PaymentTransaction[]
    returns: OrderReturn[]
    returnItems: OrderReturnItem[]
    installments: OrderInstallment[]
    loans: Loan[]
    loanPayments: LoanPayment[]
    loanInstallments: LoanInstallment[]
    accountMovements: PaymentAccountMovement[]
    accountBalances: PaymentAccountBalance[]
}
export interface SalesOrderDriver {
    readonly boundary: 'module' | 'supabase' | 'browser'
    readonly fixture: LabFixture
    readonly configuration: LabConfiguration
    readonly mode: 'local' | 'cloud' | 'hybrid'
    execute(action: Action): Promise<void>
    readOrder(): Promise<SalesOrder | undefined>
    readDatabaseGraph(): Promise<SalesOrderGraph>
    close(): Promise<void>
    diagnostics(): unknown
}
