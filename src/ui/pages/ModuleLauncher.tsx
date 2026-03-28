import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
    ArrowRightLeft,
    ArrowUpRight,
    BarChart3,
    Calculator,
    CreditCard,
    FileSpreadsheet,
    FileText,
    HandCoins,
    LayoutDashboard,
    type LucideIcon,
    MessageSquare,
    Monitor,
    Package,
    Plane,
    Receipt,
    Search,
    Settings,
    ShoppingCart,
    TrendingUp,
    Truck,
    Users,
    UsersRound,
    Warehouse,
    Wallet,
    X,
    Zap
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { isDesktop } from '@/lib/platform'
import { Input } from '@/ui/components/input'
import { ThemeAwareLogo } from '@/ui/components/ThemeAwareLogo'

interface ModuleTile {
    key: string
    href: string
    label: string
    description: string
    icon: LucideIcon
    enabled: boolean
    badge: string
}

interface ModuleSection {
    key: string
    title: string
    eyebrow: string
    description: string
    icon: LucideIcon
    theme: {
        shell: string
        surface: string
        text: string
        border: string
        glow: string
    }
    modules: ModuleTile[]
}

export function ModuleLauncher() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { workspaceName, hasFeature, features } = useWorkspace()
    const [query, setQuery] = useState('')

    const isCoreRole = user?.role === 'admin' || user?.role === 'staff' || user?.role === 'viewer'
    const hasLedgerSurface = features.pos || features.instant_pos || features.sales_history || features.crm || features.budget || features.hr || features.loans
    const hasPaymentsSurface = features.loans || features.crm || features.budget || features.hr
    const search = query.trim().toLowerCase()

    const sections = useMemo<ModuleSection[]>(() => {
        const themes = {
            commerce: { shell: 'from-emerald-500/18 via-teal-500/10 to-transparent', surface: 'bg-emerald-500/12 ring-1 ring-emerald-500/20', text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-500/20 hover:border-emerald-400/40', glow: 'bg-emerald-400/18' },
            inventory: { shell: 'from-amber-500/18 via-orange-500/10 to-transparent', surface: 'bg-amber-500/12 ring-1 ring-amber-500/20', text: 'text-amber-700 dark:text-amber-300', border: 'border-amber-500/20 hover:border-amber-400/40', glow: 'bg-amber-400/18' },
            finance: { shell: 'from-sky-500/18 via-cyan-500/10 to-transparent', surface: 'bg-sky-500/12 ring-1 ring-sky-500/20', text: 'text-sky-700 dark:text-sky-300', border: 'border-sky-500/20 hover:border-sky-400/40', glow: 'bg-sky-400/18' },
            crm: { shell: 'from-rose-500/18 via-orange-500/10 to-transparent', surface: 'bg-rose-500/12 ring-1 ring-rose-500/20', text: 'text-rose-700 dark:text-rose-300', border: 'border-rose-500/20 hover:border-rose-400/40', glow: 'bg-rose-400/18' },
            analytics: { shell: 'from-indigo-500/18 via-blue-500/10 to-transparent', surface: 'bg-indigo-500/12 ring-1 ring-indigo-500/20', text: 'text-indigo-700 dark:text-indigo-300', border: 'border-indigo-500/20 hover:border-indigo-400/40', glow: 'bg-indigo-400/18' },
            operations: { shell: 'from-slate-500/18 via-zinc-500/10 to-transparent', surface: 'bg-slate-500/12 ring-1 ring-slate-500/20', text: 'text-slate-700 dark:text-slate-300', border: 'border-slate-500/20 hover:border-slate-400/40', glow: 'bg-slate-400/16' }
        }

        const groups: ModuleSection[] = [
            {
                key: 'sell-and-serve',
                title: 'Sell & Serve',
                eyebrow: 'Frontline operations',
                description: 'Checkout, service, and sales-touch workflows grouped into one fast-launch section.',
                icon: CreditCard,
                theme: themes.commerce,
                modules: [
                    { key: 'pos', href: '/pos', label: t('nav.pos', { defaultValue: 'Point of Sale' }), description: 'Run the main checkout and in-store selling flow.', icon: CreditCard, enabled: isCoreRole && hasFeature('pos'), badge: 'Checkout' },
                    { key: 'instant-pos', href: '/instant-pos', label: t('nav.instantPos', { defaultValue: 'Instant POS' }), description: 'Handle rapid-service orders with the faster POS flow.', icon: Zap, enabled: isCoreRole && hasFeature('instant_pos'), badge: 'Fast lane' },
                    { key: 'kds', href: '/kds', label: t('nav.kdsDashboard', { defaultValue: 'KDS Dashboard' }), description: 'Track kitchen-ready work and live preparation status.', icon: Monitor, enabled: isCoreRole && hasFeature('pos'), badge: 'Live' },
                    { key: 'sales', href: '/sales', label: t('nav.sales', { defaultValue: 'Sales History' }), description: 'Review completed sales, returns, and sales records.', icon: Receipt, enabled: hasFeature('sales_history'), badge: 'History' },
                    { key: 'travel-agency', href: '/travel-agency', label: t('nav.travelAgency', { defaultValue: 'Travel Agency' }), description: 'Manage travel-related bookings and service sales.', icon: Plane, enabled: isCoreRole && hasFeature('travel_agency'), badge: 'Service' }
                ]
            },
            {
                key: 'stock-and-supply',
                title: 'Stock & Supply',
                eyebrow: 'Inventory control',
                description: 'Inventory visibility, movement, and warehouse control in one place.',
                icon: Warehouse,
                theme: themes.inventory,
                modules: [
                    { key: 'products', href: '/products', label: t('nav.products', { defaultValue: 'Products' }), description: 'Maintain product catalog, stock rules, and pricing.', icon: Package, enabled: hasFeature('products'), badge: 'Catalog' },
                    { key: 'storages', href: '/storages', label: t('nav.storages', { defaultValue: 'Storages' }), description: 'Manage warehouses, storage locations, and availability.', icon: Warehouse, enabled: hasFeature('storages'), badge: 'Warehouses' },
                    { key: 'inventory-transfer', href: '/inventory-transfer', label: t('nav.inventoryTransfer', { defaultValue: 'Inventory Transfer' }), description: 'Move stock across locations and coordinate replenishment.', icon: ArrowRightLeft, enabled: hasFeature('inventory_transfer'), badge: 'Movement' }
                ]
            },
            {
                key: 'cash-and-control',
                title: 'Cash & Control',
                eyebrow: 'Finance operations',
                description: 'Money movement, finance records, and payment follow-up organized for faster scanning.',
                icon: Wallet,
                theme: themes.finance,
                modules: [
                    { key: 'ledger', href: '/ledger', label: t('nav.ledger', { defaultValue: 'Ledger' }), description: 'Inspect cross-module inflows, outflows, and payment trails.', icon: Wallet, enabled: isCoreRole && hasLedgerSurface, badge: 'Flow' },
                    { key: 'budget', href: '/budget', label: t('nav.budget', { defaultValue: 'Accounting' }), description: 'Track accounting records, budgets, and financial controls.', icon: FileSpreadsheet, enabled: isCoreRole && hasFeature('budget'), badge: 'Books' },
                    { key: 'payments', href: '/payments', label: t('nav.payments', { defaultValue: 'Payments' }), description: 'Settle obligations and review transaction timelines.', icon: CreditCard, enabled: isCoreRole && hasPaymentsSurface, badge: 'Settlement' },
                    { key: 'direct-transactions', href: '/direct-transactions', label: t('nav.directTransactions', { defaultValue: 'Direct Transactions' }), description: 'Record standalone inflows and outflows outside linked records.', icon: ArrowRightLeft, enabled: isCoreRole && hasPaymentsSurface, badge: 'Manual' },
                    { key: 'loans', href: '/loans', label: t('nav.loans', { defaultValue: 'Loans' }), description: 'Manage issued and received loans with their histories.', icon: HandCoins, enabled: isCoreRole && hasFeature('loans'), badge: 'Credit' },
                    { key: 'installments', href: '/installments', label: t('nav.installments', { defaultValue: 'Installments' }), description: 'Review staged repayments and installment collection flow.', icon: Receipt, enabled: isCoreRole && hasFeature('loans'), badge: 'Plans' },
                    { key: 'invoices-history', href: '/invoices-history', label: t('nav.invoicesHistory', { defaultValue: 'Invoices History' }), description: 'Browse invoice records and audit issued invoice activity.', icon: FileText, enabled: hasFeature('invoices_history'), badge: 'Archive' },
                    { key: 'currency-converter', href: '/currency-converter', label: t('nav.currencyConverter', { defaultValue: 'Currency Converter' }), description: 'Check exchange values and switch currencies with current rates.', icon: Calculator, enabled: isCoreRole, badge: 'Rates' }
                ]
            },
            {
                key: 'partners-and-demand',
                title: 'Partners & Demand',
                eyebrow: 'Relationship management',
                description: 'Customer-facing and partner-facing workflows grouped around trade relationships.',
                icon: UsersRound,
                theme: themes.crm,
                modules: [
                    { key: 'business-partners', href: '/business-partners', label: t('businessPartners.title', { defaultValue: 'Business Partners' }), description: 'View trading entities, balances, and relationship data.', icon: UsersRound, enabled: isCoreRole && hasFeature('crm'), badge: 'Network' },
                    { key: 'customers', href: '/customers', label: t('nav.customers', { defaultValue: 'Customers' }), description: 'Track customer records, histories, and engagement context.', icon: Users, enabled: isCoreRole && hasFeature('crm'), badge: 'Demand' },
                    { key: 'suppliers', href: '/suppliers', label: t('nav.suppliers', { defaultValue: 'Suppliers' }), description: 'Manage supplier relationships and procurement context.', icon: Truck, enabled: isCoreRole && hasFeature('crm'), badge: 'Supply' },
                    { key: 'orders', href: '/orders', label: t('nav.orders', { defaultValue: 'Orders' }), description: 'Open, settle, and review purchase or sales orders.', icon: ShoppingCart, enabled: isCoreRole && hasFeature('crm'), badge: 'Pipeline' }
                ]
            },
            {
                key: 'insights-and-trends',
                title: 'Insights & Trends',
                eyebrow: 'Analytics',
                description: 'Performance reading and comparison views that turn activity into direction.',
                icon: BarChart3,
                theme: themes.analytics,
                modules: [
                    { key: 'dashboard', href: '/', label: t('nav.dashboard', { defaultValue: 'Dashboard' }), description: 'Return to the main business overview and headline numbers.', icon: LayoutDashboard, enabled: true, badge: 'Overview' },
                    { key: 'revenue', href: '/revenue', label: t('nav.revenue', { defaultValue: 'Revenue Analytics' }), description: 'Analyze revenue behavior, inflows, and reporting trends.', icon: TrendingUp, enabled: isCoreRole && hasFeature('net_revenue'), badge: 'Revenue' },
                    { key: 'monthly-comparison', href: '/monthly-comparison', label: t('monthlyComparison.title', { defaultValue: 'Monthly Comparison' }), description: 'Compare monthly movement side by side and track change over time.', icon: BarChart3, enabled: isCoreRole && hasFeature('monthly_comparison'), badge: 'Compare' }
                ]
            },
            {
                key: 'people-and-workspace',
                title: 'People & Workspace',
                eyebrow: 'Operations support',
                description: 'Internal team operations and workspace-level tools collected into one calmer utility layer.',
                icon: UsersRound,
                theme: themes.operations,
                modules: [
                    { key: 'hr', href: '/hr', label: t('nav.hr', { defaultValue: 'HR' }), description: 'Manage HR workflows, records, and team operations.', icon: UsersRound, enabled: isCoreRole && hasFeature('hr'), badge: 'People' },
                    { key: 'performance', href: '/performance', label: t('nav.performance', { defaultValue: 'Team Performance' }), description: 'Read team output, progress, and contribution trends.', icon: TrendingUp, enabled: isCoreRole && hasFeature('team_performance'), badge: 'Performance' },
                    { key: 'whatsapp', href: '/whatsapp', label: t('nav.whatsapp', { defaultValue: 'WhatsApp' }), description: 'Open the desktop communication surface for live follow-up.', icon: MessageSquare, enabled: isCoreRole && hasFeature('allow_whatsapp') && isDesktop(), badge: 'Desktop' },
                    { key: 'members', href: '/members', label: t('members.title', { defaultValue: 'Members' }), description: 'Review workspace members and role visibility.', icon: Users, enabled: isCoreRole && hasFeature('members'), badge: 'Access' },
                    { key: 'settings', href: '/settings', label: t('nav.settings', { defaultValue: 'Settings' }), description: 'Adjust workspace configuration, behavior, and system preferences.', icon: Settings, enabled: isCoreRole, badge: 'Control' }
                ]
            }
        ]

        return groups.map((section) => ({
            ...section,
            modules: section.modules.filter((module) => module.enabled)
        })).filter((section) => section.modules.length > 0)
    }, [features, hasFeature, isCoreRole, t, hasLedgerSurface, hasPaymentsSurface])

    const filteredSections = useMemo(() => {
        if (!search) return sections
        return sections.map((section) => ({
            ...section,
            modules: section.modules.filter((module) => {
                const haystack = `${section.title} ${section.description} ${module.label} ${module.description} ${module.badge}`.toLowerCase()
                return haystack.includes(search)
            })
        })).filter((section) => section.modules.length > 0)
    }, [search, sections])

    const totalModuleCount = sections.reduce((sum, section) => sum + section.modules.length, 0)
    const visibleModuleCount = filteredSections.reduce((sum, section) => sum + section.modules.length, 0)

    return (
        <div className="relative min-h-full overflow-hidden pb-10">
            <div className="pointer-events-none absolute inset-0">
                <div className="absolute left-[-8rem] top-[-7rem] h-72 w-72 rounded-full bg-emerald-400/12 blur-3xl" />
                <div className="absolute right-[-6rem] top-20 h-80 w-80 rounded-full bg-sky-400/10 blur-3xl" />
                <div className="absolute bottom-[-8rem] left-1/3 h-80 w-80 rounded-full bg-amber-400/10 blur-3xl" />
            </div>

            <div className="relative space-y-6">
                <section className="overflow-hidden rounded-[2rem] border border-border/60 bg-card/75 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-xl">
                    <div className="relative p-6 sm:p-8 lg:p-10">
                        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(16,185,129,0.08),transparent_35%,rgba(59,130,246,0.06))]" />
                        <div className="relative flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
                            <div className="max-w-3xl">
                                <div className="inline-flex items-center gap-3 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                                    <ThemeAwareLogo className="h-5 w-5" />
                                    Workspace launcher
                                </div>
                                <h1 className="mt-5 text-3xl font-black tracking-tight sm:text-4xl lg:text-5xl">
                                    Navigate {workspaceName || 'Atlas'} by workflow
                                </h1>
                                <p className="mt-4 max-w-2xl text-sm text-muted-foreground sm:text-base">
                                    Modules are organized around your dashboard brief, but regrouped with clearer workflow labels and stronger visual separation.
                                </p>
                                <div className="mt-6 flex flex-wrap gap-3">
                                    <SummaryCard label="Visible Sections" value={filteredSections.length} />
                                    <SummaryCard label={search ? 'Matching Modules' : 'Available Modules'} value={visibleModuleCount} />
                                    <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3 backdrop-blur-sm">
                                        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">Experience</div>
                                        <div className="mt-1 text-sm font-semibold text-muted-foreground">Color-coded, task-first navigation</div>
                                    </div>
                                </div>
                            </div>

                            <div className="w-full max-w-xl">
                                <div className="rounded-[1.75rem] border border-border/60 bg-background/80 p-3 shadow-[0_20px_48px_rgba(15,23,42,0.07)] backdrop-blur-md">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-secondary/70 text-muted-foreground">
                                            <Search className="h-5 w-5" />
                                        </div>
                                        <Input
                                            value={query}
                                            onChange={(event) => setQuery(event.target.value)}
                                            placeholder="Search modules, workflows, or roles..."
                                            className="h-11 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                                        />
                                        {query && (
                                            <button
                                                type="button"
                                                onClick={() => setQuery('')}
                                                className="flex h-10 w-10 items-center justify-center rounded-2xl border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:text-foreground"
                                                title="Clear search"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-3">
                                    <Link href="/" className="inline-flex items-center justify-center rounded-2xl border border-border/60 bg-background/75 px-4 py-2.5 text-sm font-semibold text-foreground transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-primary/5">
                                        Open {t('nav.dashboard', { defaultValue: 'Dashboard' })}
                                    </Link>
                                    <div className="text-xs font-medium text-muted-foreground">
                                        {search ? `Showing ${visibleModuleCount} of ${totalModuleCount} modules for "${query.trim()}".` : `Browse ${totalModuleCount} modules grouped by business purpose.`}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {filteredSections.length === 0 ? (
                    <section className="rounded-[2rem] border border-dashed border-border/70 bg-card/60 p-10 text-center shadow-[0_18px_60px_rgba(15,23,42,0.06)] backdrop-blur-md">
                        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-secondary/70 text-muted-foreground">
                            <Search className="h-7 w-7" />
                        </div>
                        <h2 className="mt-5 text-2xl font-black tracking-tight">No matching modules</h2>
                        <p className="mt-2 text-sm text-muted-foreground">Try a different keyword or clear the search to bring the full launcher back.</p>
                        <button type="button" onClick={() => setQuery('')} className="mt-6 inline-flex items-center justify-center rounded-2xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90">
                            Reset search
                        </button>
                    </section>
                ) : (
                    <div className="grid gap-6 xl:grid-cols-2">
                        {filteredSections.map((section) => (
                            <section key={section.key} className={cn('relative overflow-hidden rounded-[2rem] border border-border/60 bg-card/75 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-xl', section.theme.border)}>
                                <div className={cn('absolute inset-0 bg-gradient-to-br', section.theme.shell)} />
                                <div className={cn('absolute -right-16 -top-16 h-44 w-44 rounded-full blur-3xl', section.theme.glow)} />
                                <div className="relative p-6 sm:p-7">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="max-w-xl">
                                            <div className={cn('inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em]', section.theme.surface, section.theme.text)}>
                                                {section.eyebrow}
                                            </div>
                                            <h2 className="mt-4 text-2xl font-black tracking-tight">{section.title}</h2>
                                            <p className="mt-2 text-sm leading-6 text-muted-foreground">{section.description}</p>
                                        </div>
                                        <div className={cn('flex h-14 w-14 shrink-0 items-center justify-center rounded-3xl backdrop-blur-sm', section.theme.surface, section.theme.text)}>
                                            <section.icon className="h-6 w-6" />
                                        </div>
                                    </div>
                                    <div className="mt-6 grid gap-3 sm:grid-cols-2">
                                        {section.modules.map((module) => (
                                            <Link key={module.key} href={module.href} className={cn('group relative overflow-hidden rounded-[1.5rem] border border-border/60 bg-background/80 p-4 shadow-[0_14px_38px_rgba(15,23,42,0.05)] backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_48px_rgba(15,23,42,0.10)]', section.theme.border)}>
                                                <div className={cn('absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-current to-transparent opacity-30', section.theme.text)} />
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className={cn('flex h-11 w-11 items-center justify-center rounded-2xl', section.theme.surface, section.theme.text)}>
                                                        <module.icon className="h-5 w-5" />
                                                    </div>
                                                    <ArrowUpRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5', section.theme.text)} />
                                                </div>
                                                <div className="mt-4">
                                                    <h3 className="text-base font-black tracking-tight">{module.label}</h3>
                                                    <p className="mt-1.5 line-clamp-2 text-sm leading-6 text-muted-foreground">{module.description}</p>
                                                </div>
                                                <div className="mt-4 flex items-center justify-between gap-3">
                                                    <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.16em]', section.theme.surface, section.theme.text)}>
                                                        {module.badge}
                                                    </span>
                                                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">Open</span>
                                                </div>
                                            </Link>
                                        ))}
                                    </div>
                                </div>
                            </section>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3 backdrop-blur-sm">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">{label}</div>
            <div className="mt-1 text-2xl font-black tracking-tight">{value}</div>
        </div>
    )
}
