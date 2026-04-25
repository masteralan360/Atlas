import type { LucideIcon } from 'lucide-react'
import {
    ArrowRightLeft,
    BarChart3,
    Blocks,
    BriefcaseBusiness,
    Building2,
    CreditCard,
    Globe2,
    HandCoins,
    Languages,
    MessageSquareShare,
    PackageSearch,
    PlaneTakeoff,
    Receipt,
    ShieldCheck,
    Store,
    UsersRound,
    Warehouse,
    Wallet
} from 'lucide-react'

export interface WebsiteNavItem {
    id: string
    label: string
}

export interface WebsiteHeroMetric {
    value: string
    label: string
}

export interface WebsiteHeroCommand {
    label: string
    value: string
    note: string
    icon: LucideIcon
}

export interface WebsiteArchitectureBlock {
    eyebrow: string
    title: string
    description: string
    icon: LucideIcon
    accent: 'teal' | 'clay' | 'ink' | 'gold'
    points: string[]
}

export interface WebsiteSpotlight {
    eyebrow: string
    title: string
    description: string
    icon: LucideIcon
}

export interface WebsiteWorkflowStep {
    step: string
    title: string
    description: string
    outcome: string
    points: string[]
}

export interface WebsiteTestimonial {
    quote: string
    role: string
    company: string
}

export interface WebsitePricingPlan {
    name: string
    priceLabel: string
    description: string
    highlight?: boolean
    features: string[]
    cta: string
}

export const websiteNavItems: WebsiteNavItem[] = [
    { id: 'architecture', label: 'Architecture' },
    { id: 'modules', label: 'Modules' },
    { id: 'workflow', label: 'Workflow' },
    { id: 'pricing', label: 'Pricing' }
]

export const websiteHeroMetrics: WebsiteHeroMetric[] = [
    { value: '30+', label: 'Operational modules' },
    { value: '04', label: 'Operating currencies' },
    { value: '03', label: 'Interface languages' },
    { value: '01', label: 'Shared workspace' }
]

export const websiteHeroCommands: WebsiteHeroCommand[] = [
    {
        label: 'Frontline',
        value: 'POS and KDS',
        note: 'Checkout, kitchen flow, invoice output',
        icon: CreditCard
    },
    {
        label: 'Stock',
        value: 'Products and transfers',
        note: 'Catalog, storages, movement, discounts',
        icon: Warehouse
    },
    {
        label: 'Finance',
        value: 'Ledger and payments',
        note: 'Budgets, loans, installments, settlements',
        icon: Wallet
    },
    {
        label: 'Demand',
        value: 'CRM and marketplace',
        note: 'Orders, customers, suppliers, storefronts',
        icon: Store
    },
    {
        label: 'Service',
        value: 'Travel agency module',
        note: 'Tourists, supplier cuts, commissions',
        icon: PlaneTakeoff
    },
    {
        label: 'People',
        value: 'HR and workspace control',
        note: 'Members, roles, payroll context',
        icon: UsersRound
    }
]

export const websiteArchitectureBlocks: WebsiteArchitectureBlock[] = [
    {
        eyebrow: 'Commerce Engine',
        title: 'Sell, serve, and record every transaction once.',
        description: 'Atlas ties checkout, rapid-service flows, KDS visibility, sales history, and invoice output into the same operating layer.',
        icon: CreditCard,
        accent: 'teal',
        points: ['POS checkout flow', 'KDS dashboard', 'Sales history and returns', 'Receipt and A4 invoice output']
    },
    {
        eyebrow: 'Inventory Core',
        title: 'Make stock movement visible instead of reactive.',
        description: 'Products, storages, transfers, transaction logs, and stock adjustments are part of the same workflow, not a side spreadsheet.',
        icon: PackageSearch,
        accent: 'gold',
        points: ['Products and categories', 'Storages and replenishment', 'Inventory transfers', 'Adjustment audit trail']
    },
    {
        eyebrow: 'Finance Layer',
        title: 'Keep cash control close to daily operations.',
        description: 'Ledger, payments, direct transactions, loans, installments, budgets, and invoice archives stay anchored to the underlying activity.',
        icon: HandCoins,
        accent: 'ink',
        points: ['Ledger and payment flow', 'Loans and installments', 'Budget and finance views', 'Historical invoice access']
    },
    {
        eyebrow: 'Demand + Workspace',
        title: 'Run customers, suppliers, storefront demand, and internal teams from one system.',
        description: 'Atlas covers business partners, customers, suppliers, orders, public marketplace storefronts, inquiry-order follow-up, HR, WhatsApp desktop, and workspace roles.',
        icon: Building2,
        accent: 'clay',
        points: ['CRM and order surfaces', 'Marketplace storefront and order inbox', 'HR and workspace management', 'WhatsApp and follow-up tools']
    }
]

export const websiteSpotlights: WebsiteSpotlight[] = [
    {
        eyebrow: 'Offline-first',
        title: 'Keep operating when the network drops.',
        description: 'Atlas is built to keep local work moving and sync later instead of blocking frontline tasks on connectivity.',
        icon: Globe2
    },
    {
        eyebrow: 'Exchange-aware',
        title: 'Work in USD, EUR, IQD, and TRY with context.',
        description: 'Multi-currency selling and reporting are part of the product surface, not an afterthought added in exports.',
        icon: ArrowRightLeft
    },
    {
        eyebrow: 'Workspace control',
        title: 'Gate modules by role and workspace configuration.',
        description: 'Admins can expose only the modules a business uses while keeping viewer, staff, and admin visibility separated.',
        icon: ShieldCheck
    },
    {
        eyebrow: 'Service modules',
        title: 'Handle travel workflows next to retail and finance.',
        description: 'Tourist groups, supplier cuts, payment collection, and commission logic sit beside the rest of the ERP instead of in a separate tool.',
        icon: PlaneTakeoff
    },
    {
        eyebrow: 'People ops',
        title: 'Connect HR records to real workspace users.',
        description: 'Employees, payroll context, dividends, member accounts, and internal visibility are built into the same workspace model.',
        icon: BriefcaseBusiness
    },
    {
        eyebrow: 'Marketplace',
        title: 'Publish a store and pull inquiry orders back into operations.',
        description: 'Atlas supports public store links, QR sharing, category browsing, cart-based inquiry checkout, and an internal order inbox for follow-up and fulfillment.',
        icon: MessageSquareShare
    }
]

export const websiteWorkflowSteps: WebsiteWorkflowStep[] = [
    {
        step: '01',
        title: 'Capture demand at the edge of the business',
        description: 'Atlas starts where the work starts: checkout, order intake, partner activity, marketplace inquiry orders, or travel service sales.',
        outcome: 'One entry point for revenue capture',
        points: ['POS and KDS', 'Orders, customers, and suppliers', 'Marketplace storefront and inquiry checkout']
    },
    {
        step: '02',
        title: 'Move stock, money, and obligations in context',
        description: 'Inventory events, payment events, and finance events stay linked so the system explains the business instead of only recording fragments.',
        outcome: 'Operations and finance stay attached',
        points: ['Transfers, stock logs, adjustments, discounts', 'Ledger, payments, and direct transactions', 'Loans, installments, budgets, and invoice archives']
    },
    {
        step: '03',
        title: 'Read performance without rebuilding the picture',
        description: 'Dashboards, revenue analytics, monthly comparison, team performance, and finance views turn operating data into direction.',
        outcome: 'Reporting that starts from the actual workflow',
        points: ['Revenue and margin views', 'Monthly and team comparison', 'Workspace, member, and follow-up signals']
    }
]

export const websiteTestimonials: WebsiteTestimonial[] = [
    {
        quote: 'Atlas replaced the handoff between POS, inventory sheets, and finance updates. Our team works from one operating board now.',
        role: 'Retail operations lead',
        company: 'Multi-branch store group'
    },
    {
        quote: 'Orders, partner balances, marketplace follow-up, and payments finally live in the same workflow instead of four separate systems.',
        role: 'Commercial coordinator',
        company: 'Wholesale and demand management'
    },
    {
        quote: 'Travel sales, commissions, HR records, and reporting stopped being side tools. Atlas made them part of the main business rhythm.',
        role: 'Service business manager',
        company: 'Travel and back-office operations'
    }
]

export const websitePricingPlans: WebsitePricingPlan[] = [
    {
        name: 'Commerce Core',
        priceLabel: '75,000 IQD',
        description: 'For small businesses that need checkout, stock control, and clean sales records in one place.',
        features: [
            'POS and KDS',
            'Products, categories, and storages',
            'Inventory transfers and stock adjustments',
            'Sales history, returns, and invoice output',
            'Dashboard overview'
        ],
        cta: 'Choose Commerce Core'
    },
    {
        name: 'Operations Suite',
        priceLabel: '100,000 IQD',
        description: 'For growing teams that need customer operations, finance control, and demand tracking connected to daily sales.',
        highlight: true,
        features: [
            'Everything in Commerce Core',
            'Business partners, customers, suppliers, and orders',
            'Marketplace storefront, QR sharing, and inquiry order inbox',
            'Ledger, payments, direct transactions, and finance views',
            'Discounts, promotions, and revenue analytics'
        ],
        cta: 'Choose Operations Suite'
    },
    {
        name: 'Enterprise Flow',
        priceLabel: '150,000 IQD',
        description: 'For businesses running multiple departments that want people operations, finance depth, and admin control in one workspace.',
        features: [
            'Everything in Operations Suite',
            'HR, members, and payroll context',
            'Budget, loans, installments, and invoice archive',
            'Workspace roles, permissions, and configuration',
            'Advanced reporting, team performance, and WhatsApp follow-up'
        ],
        cta: 'Choose Enterprise Flow'
    }
]

export const websiteProofStrip = [
    'POS',
    'KDS',
    'Inventory',
    'Discounts',
    'Ledger',
    'Marketplace',
    'Orders',
    'Business Partners',
    'Budget',
    'Currency',
    'HR',
    'Analytics',
    'WhatsApp',
    'Workspace Control'
]

export const websiteDesignSignals = [
    {
        label: 'Workflow',
        value: 'Commerce, finance, and marketplace',
        icon: Blocks
    },
    {
        label: 'Localization',
        value: 'English, Arabic, Kurdish',
        icon: Languages
    },
    {
        label: 'Business output',
        value: 'Receipt and invoice ready',
        icon: Receipt
    },
    {
        label: 'Insights',
        value: 'Dashboard and analytics',
        icon: BarChart3
    }
]
