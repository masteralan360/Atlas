import type { TFunction } from 'i18next'
import {
    ArrowRightLeft,
    BarChart3,
    Calculator,
    Copy,
    CreditCard,
    FileSpreadsheet,
    FileText,
    HandCoins,
    LayoutDashboard,
    type LucideIcon,
    MessageSquare,
    Monitor,
    Package,
    Percent,
    Plane,
    Receipt,
    Settings,
    Store,
    ShoppingCart,
    TrendingUp,
    Truck,
    Users,
    UsersRound,
    Upload,
    Warehouse,
    Wallet,
    Zap
} from 'lucide-react'
import type { WorkspaceFeatures } from '@/workspace'
import type { ModuleFeatureKey } from '@/workspace/WorkspaceContext'

export interface WorkspaceNavigationChild {
    name: string
    href: string
    icon?: LucideIcon
}

export interface WorkspaceNavigationItem {
    name: string
    href: string
    icon: LucideIcon
    status?: string
    alert?: boolean
    mobileOnly?: boolean
    children?: WorkspaceNavigationChild[]
}

export interface WorkspaceNavigationGroup {
    title: string
    items: WorkspaceNavigationItem[]
    icon: LucideIcon
}

export interface FlattenedWorkspaceNavigationItem {
    name: string
    href: string
    icon: LucideIcon
    mobileOnly?: boolean
    parentHref?: string
}

interface BuildWorkspaceNavigationOptions {
    t: TFunction
    role?: string
    hasFeature: (feature: ModuleFeatureKey) => boolean
    features: WorkspaceFeatures
    isDesktopDevice: boolean
    whatsappStatus?: 'live' | 'off'
}

import {
    launcherSectionOrder,
    launcherSections,
    moduleMetaByHref,
    type NavigationSectionKey
} from './navigationMeta'

export function buildWorkspaceNavigation({
    t,
    role,
    hasFeature,
    features,
    isDesktopDevice,
    whatsappStatus
}: BuildWorkspaceNavigationOptions): WorkspaceNavigationGroup[] {
    const isCoreRole = role === 'admin' || role === 'staff' || role === 'viewer'
    const hasLedgerSurface = features.pos || features.instant_pos || features.sales_history || features.crm || features.budget || features.hr || features.loans
    const hasPaymentsSurface = features.loans || features.crm || features.budget || features.hr
    const canUseEcommerce = features.data_mode !== 'local' && hasFeature('ecommerce')

    // 1. Define all possible individual navigation items with their visibility logic
    const dashboardItem: WorkspaceNavigationItem = { name: t('nav.dashboard', { defaultValue: 'Dashboard' }), href: '/', icon: LayoutDashboard }

    const otherItems: WorkspaceNavigationItem[] = [
        ...(isCoreRole && hasFeature('pos') ? [
            { name: t('nav.pos', { defaultValue: 'Point of Sale' }), href: '/pos', icon: CreditCard },
            {
                name: t('nav.instantPos', { defaultValue: 'Instant POS' }),
                href: '/instant-pos',
                icon: Zap,
                children: [{ name: t('nav.kdsDashboard', { defaultValue: 'KDS Dashboard' }), href: '/kds', icon: Monitor }]
            }
        ] : []),
        ...(hasFeature('sales_history') ? [{ name: t('nav.sales', { defaultValue: 'Sales History' }), href: '/sales', icon: Receipt }] : []),
        ...(isCoreRole && hasFeature('crm') ? [
            { name: t('businessPartners.title', { defaultValue: 'Business Partners' }), href: '/business-partners', icon: UsersRound },
            { name: t('nav.customers', { defaultValue: 'Customers' }), href: '/customers', icon: Users },
            { name: t('nav.suppliers', { defaultValue: 'Suppliers' }), href: '/suppliers', icon: Truck },
            { name: t('nav.orders', { defaultValue: 'Orders' }), href: '/orders', icon: ShoppingCart }
        ] : []),
        ...(isCoreRole && canUseEcommerce ? [
            { name: t('nav.ecommerce', { defaultValue: 'E-Commerce' }), href: '/ecommerce', icon: Store }
        ] : []),
        ...(isCoreRole && hasFeature('travel_agency') ? [{ name: t('nav.travelAgency', { defaultValue: 'Travel Agency' }), href: '/travel-agency', icon: Plane }] : []),
        ...(hasFeature('loans') ? [
            { name: t('nav.loans', { defaultValue: 'Loans' }), href: '/loans', icon: HandCoins },
            { name: t('nav.installments', { defaultValue: t('loans.title', { defaultValue: 'Installments' }) }), href: '/installments', icon: Copy }
        ] : []),
        ...(isCoreRole ? [
            ...(hasLedgerSurface ? [{ name: t('nav.ledger', { defaultValue: 'Ledger' }), href: '/ledger', icon: Wallet }] : []),
            ...(hasPaymentsSurface ? [{ name: t('nav.payments', { defaultValue: 'Payments' }), href: '/payments', icon: CreditCard }] : []),
            ...(hasPaymentsSurface ? [{ name: t('nav.directTransactions', { defaultValue: 'Direct Transactions' }), href: '/direct-transactions', icon: ArrowRightLeft }] : []),
            ...(hasFeature('net_revenue') ? [{ name: t('nav.revenue', { defaultValue: 'Revenue Analytics' }), href: '/revenue', icon: BarChart3 }] : []),
            ...(hasFeature('budget') ? [{ name: t('nav.budget', { defaultValue: 'Accounting' }), href: '/budget', icon: FileSpreadsheet }] : []),
            ...(hasFeature('monthly_comparison') ? [{ name: t('monthlyComparison.title', { defaultValue: 'Monthly Comparison' }), href: '/monthly-comparison', icon: ArrowRightLeft }] : []),
            ...(hasFeature('team_performance') ? [{ name: t('nav.performance', { defaultValue: 'Team Performance' }), href: '/performance', icon: TrendingUp }] : [])
        ] : []),
        { name: t('nav.currencyConverter', { defaultValue: 'Currency Converter' }), href: '/currency-converter', icon: Calculator, mobileOnly: true },
        ...(isCoreRole && hasFeature('allow_whatsapp') && isDesktopDevice ? [{ name: t('nav.whatsapp', { defaultValue: 'WhatsApp' }), href: '/whatsapp', icon: MessageSquare, status: whatsappStatus }] : []),
        ...(hasFeature('products') ? [{ name: t('nav.products', { defaultValue: 'Products' }), href: '/products', icon: Package }] : []),
        ...(hasFeature('discounts') ? [{ name: t('nav.discounts', { defaultValue: 'Discounts' }), href: '/discounts', icon: Percent }] : []),
        ...(hasFeature('storages') ? [{ name: t('nav.storages', { defaultValue: 'Storages' }), href: '/storages', icon: Warehouse }] : []),
        ...(hasFeature('inventory_transfer') ? [{ name: t('nav.inventoryTransfer', { defaultValue: 'Inventory Transfer' }), href: '/inventory-transfer', icon: ArrowRightLeft }] : []),
        ...(hasFeature('invoices_history') ? [{
            name: t('nav.invoicesHistory', { defaultValue: 'Invoices History' }),
            href: '/invoices-history',
            icon: FileText,
            children: [{
                name: t('nav.uploadFiles', { defaultValue: 'Upload Files' }),
                href: '/invoices-history/upload-files',
                icon: Upload
            }]
        }] : []),
        ...(isCoreRole ? [
            ...(hasFeature('hr') ? [{ name: t('nav.hr', { defaultValue: 'HR' }), href: '/hr', icon: UsersRound }] : []),
            ...(hasFeature('members') ? [{ name: t('members.title', { defaultValue: 'Members' }), href: '/members', icon: Users }] : []),
            { name: t('nav.settings', { defaultValue: 'Settings' }), href: '/settings', icon: Settings }
        ] : [])
    ]

    // 2. Group items into launcher-style sections
    const grouped = new Map<NavigationSectionKey, WorkspaceNavigationItem[]>()

    otherItems.forEach(item => {
        const meta = moduleMetaByHref[item.href] || { section: 'people-and-workspace' as const }
        const sectionItems = grouped.get(meta.section) || []
        sectionItems.push(item)
        grouped.set(meta.section, sectionItems)
    })

    // 3. Convert map back to ordered array of WorkspaceNavigationGroup
    const launcherGroups = launcherSectionOrder
        .map(key => ({
            title: launcherSections[key].title,
            icon: launcherSections[key].icon,
            items: grouped.get(key) || []
        }))
        .filter(group => group.items.length > 0)

    return [
        {
            title: '', // Standalone Dashboard has no group title
            icon: LayoutDashboard,
            items: [dashboardItem]
        },
        ...launcherGroups
    ]
}

export function flattenWorkspaceNavigation(groups: WorkspaceNavigationGroup[]): FlattenedWorkspaceNavigationItem[] {
    return groups.flatMap((group) => group.items.flatMap((item) => [
        {
            name: item.name,
            href: item.href,
            icon: item.icon,
            mobileOnly: item.mobileOnly
        },
        ...(item.children || []).map((child) => ({
            name: child.name,
            href: child.href,
            icon: child.icon || item.icon,
            mobileOnly: item.mobileOnly,
            parentHref: item.href
        }))
    ]))
}
