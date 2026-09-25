export const WORKSPACE_PLANS = ['basic', 'business', 'enterprise'] as const

export type WorkspacePlan = typeof WORKSPACE_PLANS[number]
export type WorkspaceCurrencyCode = 'usd' | 'eur' | 'iqd' | 'try'

export type PlanModuleKey =
    | 'pos'
    | 'instant_pos'
    | 'kds'
    | 'sales_history'
    | 'products'
    | 'services'
    | 'storages'
    | 'inventory_transfer'
    | 'inventory_transactions'
    | 'stock_adjustments'
    | 'ledger'
    | 'payments'
    | 'payment_accounts'
    | 'cashier_shift_control'
    | 'direct_transactions'
    | 'members'
    | 'business_partners'
    | 'agents'
    | 'sales_agent_commissions'
    | 'agent_sales_accounts'
    | 'post_service'
    | 'car_rental'
    | 'travel_transportation'
    | 'customers'
    | 'suppliers'
    | 'orders'
    | 'ecommerce'
    | 'real_estate'
    | 'activities'
    | 'currency_exchange'
    | 'clinical_appointments'
    | 'loans'
    | 'installments'
    | 'discounts'
    | 'revenue_analytics'
    | 'team_performance'
    | 'invoice_history'
    | 'accounting'
    | 'hr'
    | 'expenses'
    | 'payroll'
    | 'whatsapp'
    | 'manual_entry'

export type WorkspaceFeatureKey =
    | 'pos'
    | 'instant_pos'
    | 'kds'
    | 'sales_history'
    | 'crm'
    | 'orders'
    | 'agents'
    | 'sales_agent_commissions'
    | 'agent_sales_accounts'
    | 'post_service'
    | 'car_rental'
    | 'travel_transportation'
    | 'ecommerce'
    | 'real_estate'
    | 'activities'
    | 'currency_exchange'
    | 'clinical_appointments'
    | 'loans'
    | 'installments'
    | 'net_revenue'
    | 'budget'
    | 'monthly_comparison'
    | 'team_performance'
    | 'products'
    | 'services'
    | 'discounts'
    | 'storages'
    | 'inventory_transfer'
    | 'inventory_transactions'
    | 'stock_adjustments'
    | 'invoices_history'
    | 'hr'
    | 'members'
    | 'allow_whatsapp'
    | 'payments'
    | 'payment_accounts'
    | 'cashier_shift_control'
    | 'ledger'
    | 'direct_transactions'
    | 'manual_entry'

export type PlanCapabilityKey =
    | 'receiptPrinting'
    | 'a4PdfInvoices'
    | 'pdfInvoiceGeneration'
    | 'barcodeScanner'
    | 'thermalPrinter'
    | 'multipleWorkspaceContacts'
    | 'marketplaceInquiries'
    | 'marketplaceStorefronts'
    | 'loanInstallmentInvoices'
    | 'multiCurrency'
    | 'excelExportSales'
    | 'excelExportLedger'
    | 'excelExportRevenue'
    | 'workspaceStorageUploads'
    | 'workspacePdfUploads'
    | 'workspaceImageUploads'
    | 'workspaceAudioUploads'
    | 'workspaceManagementPermissions'
    | 'whatsappIntegration'
    | 'whatsappSharing'
    | 'stockBatches'
    | 'orderFreeBonus'
    | 'priceBooks'
    | 'quickOrder'
    | 'businessPartnerGroupPrivacy'

export interface WorkspacePlanLimits {
    maxMembers: number
    maxBranches: number
    maxWorkspaceContacts: number | null
    maxUploadSizeMb: number
    allowedUploadMimeTypes: string[]
}

interface WorkspacePlanDefinition {
    inherits?: WorkspacePlan
    modules: PlanModuleKey[]
    capabilities: PlanCapabilityKey[]
    allowedCurrencies: WorkspaceCurrencyCode[]
    limits: WorkspacePlanLimits
}

export interface ResolvedWorkspacePlan {
    plan: WorkspacePlan
    modules: PlanModuleKey[]
    capabilities: PlanCapabilityKey[]
    allowedCurrencies: WorkspaceCurrencyCode[]
    limits: WorkspacePlanLimits
}

export const PLAN_DEFINITIONS: Record<WorkspacePlan, WorkspacePlanDefinition> = {
    basic: {
        modules: [
            'pos',
            'sales_history',
            'products',
            'storages',
            'inventory_transfer',
            'inventory_transactions',
            'stock_adjustments',
            'ledger',
            'payments',
            'direct_transactions',
            'members'
        ],
        capabilities: ['receiptPrinting'],
        allowedCurrencies: ['iqd'],
        limits: {
            maxMembers: 3,
            maxBranches: 0,
            maxWorkspaceContacts: 1,
            maxUploadSizeMb: 0,
            allowedUploadMimeTypes: []
        }
    },
    business: {
        inherits: 'basic',
        modules: [
            'business_partners',
            'customers',
            'suppliers',
            'orders',
            'ecommerce',
            'loans',
            'installments',
            'discounts',
            'revenue_analytics',
            'team_performance',
            'invoice_history',
            'payment_accounts'
        ],
        capabilities: [
            'a4PdfInvoices',
            'pdfInvoiceGeneration',
            'barcodeScanner',
            'thermalPrinter',
            'multipleWorkspaceContacts',
            'marketplaceInquiries',
            'marketplaceStorefronts',
            'loanInstallmentInvoices',
            'multiCurrency',
            'excelExportSales',
            'excelExportLedger',
            'excelExportRevenue',
            'workspaceStorageUploads',
            'workspacePdfUploads',
            'stockBatches'
        ],
        allowedCurrencies: ['iqd', 'usd', 'eur', 'try'],
        limits: {
            maxMembers: 10,
            maxBranches: 2,
            maxWorkspaceContacts: null,
            maxUploadSizeMb: 100,
            allowedUploadMimeTypes: ['application/pdf']
        }
    },
    enterprise: {
        inherits: 'business',
        modules: [
            'accounting',
            'hr',
            'expenses',
            'payroll',
            'whatsapp'
        ],
        capabilities: [
            'workspaceManagementPermissions',
            'whatsappIntegration',
            'whatsappSharing',
            'stockBatches',
            'workspaceImageUploads',
            'workspaceAudioUploads'
        ],
        allowedCurrencies: ['iqd', 'usd', 'eur', 'try'],
        limits: {
            maxMembers: 20,
            maxBranches: 5,
            maxWorkspaceContacts: null,
            maxUploadSizeMb: 1024,
            allowedUploadMimeTypes: [
                'application/pdf',
                'image/png',
                'image/jpeg',
                'audio/mpeg',
                'text/plain'
            ]
        }
    }
}

export const WORKSPACE_FEATURE_MODULE_MAP: Record<WorkspaceFeatureKey, PlanModuleKey | null> = {
    pos: 'pos',
    instant_pos: 'instant_pos',
    kds: 'kds',
    sales_history: 'sales_history',
    crm: 'customers',
    agents: 'agents',
    sales_agent_commissions: 'sales_agent_commissions',
    agent_sales_accounts: 'agent_sales_accounts',
    post_service: 'post_service',
    car_rental: 'car_rental',
    travel_transportation: 'travel_transportation',
    ecommerce: 'ecommerce',
    orders: 'orders',
    real_estate: 'real_estate',
    activities: 'activities',
    currency_exchange: 'currency_exchange',
    clinical_appointments: 'clinical_appointments',
    manual_entry: 'manual_entry',
    loans: 'loans',
    installments: 'installments',
    net_revenue: 'revenue_analytics',
    budget: 'accounting',
    monthly_comparison: 'revenue_analytics',
    team_performance: 'team_performance',
    products: 'products',
    services: 'services',
    discounts: 'discounts',
    storages: 'storages',
    inventory_transfer: 'inventory_transfer',
    inventory_transactions: 'inventory_transactions',
    stock_adjustments: 'stock_adjustments',
    invoices_history: 'invoice_history',
    hr: 'hr',
    members: 'members',
    allow_whatsapp: 'whatsapp',
    payments: 'payments',
    payment_accounts: 'payment_accounts',
    cashier_shift_control: 'cashier_shift_control',
    ledger: 'ledger',
    direct_transactions: 'direct_transactions'
}

function mergeUnique<T>(base: T[], next: T[]) {
    return Array.from(new Set([...base, ...next]))
}

export function normalizeWorkspacePlan(plan: unknown): WorkspacePlan {
    return WORKSPACE_PLANS.includes(plan as WorkspacePlan)
        ? plan as WorkspacePlan
        : 'basic'
}

export function getPlanCapabilities(planInput: unknown): ResolvedWorkspacePlan {
    const plan = normalizeWorkspacePlan(planInput)
    const definition = PLAN_DEFINITIONS[plan]

    if (!definition.inherits) {
        return {
            plan,
            modules: definition.modules,
            capabilities: definition.capabilities,
            allowedCurrencies: definition.allowedCurrencies,
            limits: definition.limits
        }
    }

    const inherited = getPlanCapabilities(definition.inherits)

    return {
        plan,
        modules: mergeUnique(inherited.modules, definition.modules),
        capabilities: mergeUnique(inherited.capabilities, definition.capabilities),
        allowedCurrencies: mergeUnique(inherited.allowedCurrencies, definition.allowedCurrencies),
        limits: {
            ...inherited.limits,
            ...definition.limits
        }
    }
}

export function planHasModule(plan: unknown, module: PlanModuleKey) {
    return getPlanCapabilities(plan).modules.includes(module)
}

export function planHasCapability(plan: unknown, capability: PlanCapabilityKey) {
    return getPlanCapabilities(plan).capabilities.includes(capability)
}

export function planHasWorkspaceFeature(plan: unknown, feature: WorkspaceFeatureKey) {
    const module = WORKSPACE_FEATURE_MODULE_MAP[feature]
    return module ? planHasModule(plan, module) : false
}

export function getPlanAllowedCurrencies(plan: unknown) {
    return getPlanCapabilities(plan).allowedCurrencies
}

export function isCurrencyAllowedForPlan(plan: unknown, currency: unknown) {
    return getPlanAllowedCurrencies(plan).includes(String(currency).toLowerCase() as WorkspaceCurrencyCode)
}

export function getPrimaryCurrencyForPlan(plan: unknown): WorkspaceCurrencyCode {
    return getPlanAllowedCurrencies(plan)[0] ?? 'usd'
}

export type WorkspaceAccessOverrideType = 'module' | 'capability' | 'currency' | 'limit'

export interface WorkspaceAccessOverride {
    id: string
    workspace_id: string
    type: WorkspaceAccessOverrideType
    key: string
    value: string | null
    created_by: string | null
    created_at: string
}

export function applyWorkspaceOverrides(
    resolved: ResolvedWorkspacePlan,
    overrides: WorkspaceAccessOverride[]
): ResolvedWorkspacePlan {
    if (!overrides || overrides.length === 0) return resolved

    let modules = [...resolved.modules]
    let capabilities = [...resolved.capabilities]
    let allowedCurrencies = [...resolved.allowedCurrencies]
    const limits = { ...resolved.limits }

    for (const override of overrides) {
        const val = override.value ?? 'grant'
        switch (override.type) {
            case 'module': {
                const key = override.key as PlanModuleKey
                if (val === 'grant') {
                    if (!modules.includes(key)) modules.push(key)
                } else if (val === 'revoke') {
                    modules = modules.filter(m => m !== key)
                }
                break
            }
            case 'capability': {
                const key = override.key as PlanCapabilityKey
                if (val === 'grant') {
                    if (!capabilities.includes(key)) capabilities.push(key)
                } else if (val === 'revoke') {
                    capabilities = capabilities.filter(c => c !== key)
                }
                break
            }
            case 'currency': {
                const key = override.key.toLowerCase() as WorkspaceCurrencyCode
                if (val === 'grant') {
                    if (!allowedCurrencies.includes(key)) allowedCurrencies.push(key)
                } else if (val === 'revoke') {
                    allowedCurrencies = allowedCurrencies.filter(c => c !== key)
                }
                break
            }
            case 'limit': {
                const numVal = parseInt(val, 10)
                if (isNaN(numVal)) break
                switch (override.key) {
                    case 'maxMembers': limits.maxMembers = numVal; break
                    case 'maxBranches': limits.maxBranches = numVal; break
                    case 'maxWorkspaceContacts': limits.maxWorkspaceContacts = numVal; break
                    case 'maxUploadSizeMb': limits.maxUploadSizeMb = numVal; break
                }
                break
            }
        }
    }

    // Agent add-ons are never independently available. An orphaned or legacy
    // override must not expose a financial or commission workflow without the
    // base Agents and Orders modules.
    for (const agentAddOn of ['sales_agent_commissions', 'agent_sales_accounts'] as const) {
        if (modules.includes(agentAddOn) && (!modules.includes('agents') || !modules.includes('orders'))) {
            modules = modules.filter(module => module !== agentAddOn)
        }
    }

    return {
        plan: resolved.plan,
        modules,
        capabilities,
        allowedCurrencies,
        limits
    }
}
