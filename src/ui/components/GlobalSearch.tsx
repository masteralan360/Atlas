import { Search, Command, LayoutDashboard, ShoppingCart, Package, ListOrdered, Settings as SettingsIcon, BarChart3, Users2, Globe, MessageSquare, Moon, Sun, LogOut, ChevronRight, ArrowRightLeft, NotebookPen, Wallet, Zap, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState, useEffect, useRef } from 'react'
import { useHashLocation } from '@/hooks/useHashLocation'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/ui/components/theme-provider'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'

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
    const { signOut } = useAuth()
    const { features } = useWorkspace()
    const inputRef = useRef<HTMLInputElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const hasFinanceAnalytics = features.net_revenue || features.budget || features.loans || features.crm || features.travel_agency || features.hr
    const hasPaymentsSurface = features.loans || features.crm || features.budget || features.hr

    const commands: CommandItem[] = [
        // Navigation (Matches Layout.tsx paths)
        { id: 'nav-dashboard', title: t('nav.dashboard'), category: 'Navigation', icon: LayoutDashboard, action: () => setLocation('/') },
        { id: 'nav-pos', title: t('nav.pos'), category: 'Navigation', icon: ShoppingCart, action: () => setLocation('/pos') },
        { id: 'nav-instant-pos', title: t('nav.instantPos') || 'Instant POS', category: 'Navigation', icon: Zap, action: () => setLocation('/instant-pos') },
        { id: 'nav-products', title: t('nav.products'), category: 'Navigation', icon: Package, action: () => setLocation('/products') },
        { id: 'nav-sales', title: t('nav.sales'), category: 'Navigation', icon: ListOrdered, action: () => setLocation('/sales') },
        { id: 'nav-settings', title: t('nav.settings'), category: 'Navigation', icon: SettingsIcon, action: () => setLocation('/settings') },
        ...(hasFinanceAnalytics ? [{ id: 'nav-finance', title: t('nav.finance', { defaultValue: 'Finance' }), category: 'Navigation' as const, icon: TrendingUp, action: () => setLocation('/finance') }] : []),
        ...(hasPaymentsSurface ? [{ id: 'nav-payments', title: t('nav.payments', { defaultValue: 'Payments' }), category: 'Navigation' as const, icon: Wallet, action: () => setLocation('/payments') }] : []),
        { id: 'nav-revenue', title: t('nav.revenue'), category: 'Navigation', icon: BarChart3, action: () => setLocation('/revenue') },
        { id: 'nav-budget', title: t('nav.budget'), category: 'Navigation', icon: Wallet, action: () => setLocation('/budget') },
        { id: 'nav-monthly-comparison', title: t('monthlyComparison.title'), category: 'Navigation', icon: ArrowRightLeft, action: () => setLocation('/monthly-comparison') },
        { id: 'nav-performance', title: t('nav.performance'), category: 'Navigation', icon: Users2, action: () => setLocation('/performance') },

        // Tools
        { id: 'tool-currency', title: t('nav.currencyConverter'), category: 'Tools', icon: Globe, action: () => setLocation('/currency-converter') },
        { id: 'tool-notebook', title: t('notebook.label') || 'Notebook', category: 'Tools', icon: NotebookPen, action: () => setLocation('/notebook') },
        { id: 'tool-whatsapp', title: t('nav.whatsapp'), category: 'Tools', icon: MessageSquare, action: () => setLocation('/whatsapp') },

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
                        style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" : "rounded-md border border-input shadow-sm",
                        "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        "pl-9 pr-12 text-center focus:text-left focus:bg-background/80 focus:shadow-lg"
                    )}
                    placeholder={placeholder || t('common.search', 'Search...') + ' (Ctrl+K)'}
                    spellCheck={false}
                />
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none hidden sm:flex">
                    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                        <span className="text-xs">âŒ˜</span>K
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
