import { Search, Command, LayoutDashboard, ShoppingCart, Package, ListOrdered, Settings as SettingsIcon, BarChart3, Users2, UserRound, Globe, MessageSquare, Moon, Sun, LogOut, ChevronRight, ArrowRightLeft, NotebookPen, Wallet, Zap, FileSpreadsheet, Building2, FileText, MapPinned, LocateFixed, CalendarClock, Monitor, Car } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState, useEffect, useRef } from 'react'
import { useHashLocation } from '@/hooks/useHashLocation'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/ui/components/theme-provider'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useWorkspacePermissions } from '@/permissions'

interface GlobalSearchProps {
    className?: string
    placeholder?: string
}

interface CommandItem {
    id: string
    title: string
    description?: string
    icon: React.ComponentType<{ className?: string }>
    category: 'Navigation' | 'Actions' | 'Tools'
    action: () => void
}

export function GlobalSearch({ className, placeholder }: GlobalSearchProps) {
    const [query, setQuery] = useState('')
    const [isOpen, setIsOpen] = useState(false)
    const [activeIndex, setActiveIndex] = useState(0)
    const [, setLocation] = useHashLocation()
    const { t } = useTranslation()
    const { theme, setTheme, style } = useTheme()
    const { signOut, user } = useAuth()
    const { features } = useWorkspace()
    const { hasPermission } = useWorkspacePermissions()
    const inputRef = useRef<HTMLInputElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    const hasLedgerSurface = features.pos || features.instant_pos || features.sales_history || features.crm || features.budget || features.hr || features.loans || features.real_estate || features.activities || features.currency_exchange || features.car_rental
    const hasPaymentsSurface = features.loans || features.crm || features.budget || features.hr || features.real_estate || features.activities || features.currency_exchange || features.car_rental

    const commands: CommandItem[] = [
        // Navigation (Matches Layout.tsx paths)
        { id: 'nav-dashboard', title: t('nav.dashboard'), category: 'Navigation', icon: LayoutDashboard, action: () => setLocation('/') },
        ...(features.pos ? [{ id: 'nav-pos', title: t('nav.pos'), category: 'Navigation' as const, icon: ShoppingCart, action: () => setLocation('/pos') }] : []),
        ...(features.instant_pos ? [{ id: 'nav-instant-pos', title: t('nav.instantPos') || 'Instant POS', category: 'Navigation' as const, icon: Zap, action: () => setLocation('/instant-pos') }] : []),
        ...(features.kds ? [{ id: 'nav-kds', title: t('nav.kdsDashboard', { defaultValue: 'KDS Dashboard' }), category: 'Navigation' as const, icon: Monitor, action: () => setLocation('/kds') }] : []),
        ...(features.products ? [{ id: 'nav-products', title: t('nav.products'), category: 'Navigation' as const, icon: Package, action: () => setLocation('/products') }] : []),
        ...(features.sales_history ? [{ id: 'nav-sales', title: t('nav.sales'), category: 'Navigation' as const, icon: ListOrdered, action: () => setLocation('/sales') }] : []),
        { id: 'nav-settings', title: t('nav.settings'), category: 'Navigation', icon: SettingsIcon, action: () => setLocation('/settings') },

        ...(hasLedgerSurface && hasPermission('ledger.access') ? [{ id: 'nav-ledger', title: t('nav.ledger', { defaultValue: 'Ledger' }), category: 'Navigation' as const, icon: Wallet, action: () => setLocation('/ledger') }] : []),
        ...(hasPaymentsSurface && hasPermission('payment.access') ? [{ id: 'nav-payments', title: t('nav.payments', { defaultValue: 'Payments' }), category: 'Navigation' as const, icon: Wallet, action: () => setLocation('/payments') }] : []),
        ...(hasPaymentsSurface && hasPermission('directTransaction.access') ? [{ id: 'nav-direct-transactions', title: t('nav.directTransactions', { defaultValue: 'Direct Transactions' }), category: 'Navigation' as const, icon: ArrowRightLeft, action: () => setLocation('/direct-transactions') }] : []),
        ...(features.net_revenue && hasPermission('revenueAnalytics.access') ? [{ id: 'nav-revenue', title: t('nav.revenue'), category: 'Navigation' as const, icon: BarChart3, action: () => setLocation('/revenue') }] : []),
        ...(features.customer_profitability && hasPermission('revenueAnalytics.access') ? [{ id: 'nav-customer-profitability', title: t('customerProfitability.title'), category: 'Navigation' as const, icon: BarChart3, action: () => setLocation('/customer-profitability') }] : []),
        ...(features.budget && hasPermission('accounting.access') ? [{ id: 'nav-budget', title: t('nav.budget', { defaultValue: 'Accounting and Expenses' }), category: 'Navigation' as const, icon: FileSpreadsheet, action: () => setLocation('/budget') }] : []),
        ...(features.real_estate && hasPermission('realEstate.access') ? [{ id: 'nav-real-estate', title: t('realEstate.title', { defaultValue: 'Real Estate' }), category: 'Navigation' as const, icon: Building2, action: () => setLocation('/real-estate') }] : []),
        ...(features.car_rental && hasPermission('carRental.access') ? [{ id: 'nav-car-rental', title: t('carRental.title'), category: 'Navigation' as const, icon: Car, action: () => setLocation('/car-rental') }] : []),
        ...(features.activities && hasPermission('activities.access') ? [{ id: 'nav-activities', title: t('activities.title', { defaultValue: 'Activities' }), category: 'Navigation' as const, icon: CalendarClock, action: () => setLocation('/activities') }] : []),
        ...(features.currency_exchange && hasPermission('currencyExchange.access') ? [{ id: 'nav-currency-exchange', title: t('currencyExchange.title', { defaultValue: 'Currency Exchange Service' }), category: 'Navigation' as const, icon: ArrowRightLeft, action: () => setLocation('/currency-exchange') }] : []),
        ...(features.agents && hasPermission('agents.access') ? [{ id: 'nav-agents', title: t('agents.title', { defaultValue: 'Agents' }), category: 'Navigation' as const, icon: UserRound, action: () => setLocation('/agents') }] : []),
        ...(features.agents && hasPermission('fleet.access') ? [{ id: 'nav-fleet', title: t('fleet.title', { defaultValue: 'Fleet Management' }), category: 'Navigation' as const, icon: MapPinned, action: () => setLocation('/agents/fleet') }] : []),
        ...(features.agents ? [{ id: 'nav-share-location', title: t('fleet.shareLocation', { defaultValue: 'Share My Location' }), category: 'Navigation' as const, icon: LocateFixed, action: () => setLocation('/agents/location-sharing') }] : []),
        ...(features.currency_exchange && hasPermission('currencyExchangeFeeRules.access') ? [{ id: 'nav-currency-exchange-rules', title: t('currencyExchange.feeRules.title', { defaultValue: 'Fee/Commission Rules' }), category: 'Navigation' as const, icon: FileText, action: () => setLocation('/currency-exchange/rules') }] : []),
        ...(user?.role === 'admin' ? [{ id: 'nav-custom-templates', title: t('customTemplates.title', { defaultValue: 'Custom Templates' }), category: 'Navigation' as const, icon: FileText, action: () => setLocation('/custom-templates') }] : []),
        ...(features.monthly_comparison ? [{ id: 'nav-monthly-comparison', title: t('monthlyComparison.title'), category: 'Navigation' as const, icon: ArrowRightLeft, action: () => setLocation('/monthly-comparison') }] : []),
        ...(features.team_performance && hasPermission('teamPerformance.access') ? [{ id: 'nav-performance', title: t('nav.performance'), category: 'Navigation' as const, icon: Users2, action: () => setLocation('/performance') }] : []),

        // Tools
        ...(features.allowed_currencies.length > 1 ? [{ id: 'tool-currency', title: t('nav.currencyConverter'), category: 'Tools' as const, icon: Globe, action: () => setLocation('/currency-converter') }] : []),
        { id: 'tool-notebook', title: t('notebook.label') || 'Notebook', category: 'Tools', icon: NotebookPen, action: () => setLocation('/notebook') },
        ...(features.allow_whatsapp ? [{ id: 'tool-whatsapp', title: t('nav.whatsapp'), category: 'Tools' as const, icon: MessageSquare, action: () => setLocation('/whatsapp') }] : []),

        // Actions
        {
            id: 'action-theme',
            title: theme === 'dark' ? t('settings.theme.light') || 'Switch to Light Mode' : t('settings.theme.dark') || 'Switch to Dark Mode',
            category: 'Actions',
            icon: theme === 'dark' ? Sun : Moon,
            action: () => setTheme(theme === 'dark' ? 'light' : 'dark')
        },
        {
            id: 'action-logout',
            title: t('common.signOut') || 'Sign Out',
            category: 'Actions',
            icon: LogOut,
            action: () => signOut()
        }
    ]

    const filteredCommands = query.trim() === ''
        ? commands
        : commands.filter(cmd =>
            cmd.title.toLowerCase().includes(query.toLowerCase()) ||
            cmd.category.toLowerCase().includes(query.toLowerCase())
        )

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault()
                inputRef.current?.focus()
            }
            if (e.key === 'Escape') {
                setIsOpen(false)
                inputRef.current?.blur()
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIndex(prev => (prev + 1) % filteredCommands.length)
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIndex(prev => (prev - 1 + filteredCommands.length) % filteredCommands.length)
        } else if (e.key === 'Enter') {
            e.preventDefault()
            if (filteredCommands[activeIndex]) {
                filteredCommands[activeIndex].action()
                setIsOpen(false)
                setQuery('')
            }
        }
    }

    return (
        <div ref={containerRef} className={cn("relative w-full max-w-md group", className)}>
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Search className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value)
                        setIsOpen(true)
                        setActiveIndex(0)
                    }}
                    onFocus={() => setIsOpen(true)}
                    onKeyDown={handleKeyDown}
                    className={cn(
                        "flex h-9 w-full bg-secondary/30 px-3 py-1 text-sm transition-all duration-300",
                        style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" : "rounded-md border border-input dark:border-primary/40 shadow-sm",
                        "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        "pl-9 pr-12 text-center focus:text-left focus:bg-background/80 focus:shadow-lg"
                    )}
                    placeholder={placeholder || t('common.search', 'Search...')}
                    spellCheck={false}
                />
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none hidden sm:flex">
                    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                        <span className="text-xs">Ctrl+K</span>
                    </kbd>
                </div>
            </div>

            {/* Dropdown Results */}
            {isOpen && (filteredCommands.length > 0 || query.trim() !== '') && (
                <div className={cn(
                    "absolute top-full left-0 right-0 mt-2 py-2 bg-background/95 backdrop-blur-md z-[200] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200",
                    style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]" : "rounded-xl border border-white/10 shadow-2xl"
                )}>
                    <div className="max-h-[min(400px,70vh)] overflow-y-auto custom-scrollbar">
                        {filteredCommands.length === 0 ? (
                            <div className="px-4 py-8 text-center text-muted-foreground">
                                <Command className="w-8 h-8 mx-auto mb-2 opacity-20" />
                                <p className="text-sm">{t('common.noData', 'No commands found for')} "{query}"</p>
                            </div>
                        ) : (
                            <div className="space-y-4 px-2">
                                {['Navigation', 'Actions', 'Tools'].map(category => {
                                    const catCommands = filteredCommands.filter(c => c.category === category)
                                    if (catCommands.length === 0) return null

                                    let catTitle = category;
                                    if (category === 'Navigation') catTitle = t('common.search'); // Or 'Menus'
                                    if (category === 'Actions') catTitle = t('nav.actions');
                                    if (category === 'Tools') catTitle = t('nav.tools');

                                    return (
                                        <div key={category} className="space-y-1">
                                            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/50">
                                                {catTitle}
                                            </div>
                                            {catCommands.map((cmd) => {
                                                const globalIndex = filteredCommands.indexOf(cmd)
                                                const isActive = globalIndex === activeIndex

                                                return (
                                                    <button
                                                        key={cmd.id}
                                                        className={cn(
                                                            "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-200 group/item",
                                                            isActive ? "bg-primary text-primary-foreground shadow-lg" : "hover:bg-primary/10 text-muted-foreground hover:text-primary"
                                                        )}
                                                        onClick={() => {
                                                            cmd.action()
                                                            setIsOpen(false)
                                                            setQuery('')
                                                        }}
                                                        onMouseEnter={() => setActiveIndex(globalIndex)}
                                                    >
                                                        <div className={cn(
                                                            "w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
                                                            isActive ? "bg-white/20" : "bg-muted group-hover/item:bg-primary/20"
                                                        )}>
                                                            <cmd.icon className={cn("w-4 h-4", isActive ? "text-primary-foreground" : "text-muted-foreground group-hover/item:text-primary")} />
                                                        </div>
                                                        <span className="flex-1 font-medium text-left">{cmd.title}</span>
                                                        <ChevronRight className={cn(
                                                            "w-4 h-4 transition-all duration-300",
                                                            isActive ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2"
                                                        )} />
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
