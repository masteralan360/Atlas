import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { ArrowLeft, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { LanguageSwitcher, ThemeToggle } from '@/ui/components'
import { cn } from '@/lib/utils'

type MarketplaceLayoutProps = {
    title: string
    subtitle?: string | null
    backHref?: string
    backLabel?: string
    headerActions?: ReactNode
    children: ReactNode
}

export function MarketplaceLayout({
    title,
    subtitle,
    backHref,
    backLabel,
    headerActions,
    children
}: MarketplaceLayoutProps) {
    const { t } = useTranslation()

    return (
        <div
            className="min-h-screen bg-background text-foreground"
            style={{ fontFamily: 'Geist Variable, Inter, sans-serif' }}
        >
            <div className="fixed inset-0 -z-10 overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(20,184,166,0.16),transparent_34%),radial-gradient(circle_at_top_right,rgba(14,165,233,0.12),transparent_26%),linear-gradient(180deg,rgba(15,23,42,0.02),transparent_45%)]" />
                <div className="absolute left-[-8rem] top-12 h-72 w-72 rounded-full bg-emerald-400/12 blur-3xl" />
                <div className="absolute right-[-8rem] top-24 h-80 w-80 rounded-full bg-sky-400/12 blur-3xl" />
                <div className="absolute bottom-[-10rem] left-1/3 h-96 w-96 rounded-full bg-amber-400/10 blur-3xl" />
            </div>

            <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-5 sm:px-6 lg:px-8">
                <header className="rounded-[2rem] border border-border/60 bg-card/80 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-3">
                                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                                    <Store className="h-5 w-5" />
                                </div>
                                <div>
                                    {backHref && (
                                        <Link href={backHref} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                                            <ArrowLeft className={cn('h-4 w-4', (document?.dir || 'ltr') === 'rtl' && 'rotate-180')} />
                                            {backLabel || t('common.back', { defaultValue: 'Back' })}
                                        </Link>
                                    )}
                                    <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{title}</h1>
                                </div>
                            </div>
                            {subtitle && (
                                <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
                                    {subtitle}
                                </p>
                            )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            {headerActions}
                            <LanguageSwitcher />
                            <ThemeToggle />
                        </div>
                    </div>
                </header>

                <main className="flex-1 py-6">
                    {children}
                </main>

                <footer className="border-t border-border/50 py-6 text-center text-sm text-muted-foreground">
                    <a
                        href="/"
                        className="inline-flex items-center gap-2 transition-colors hover:text-foreground"
                    >
                        <span>{t('marketplace.footer', { defaultValue: 'Powered by Atlas' })}</span>
                    </a>
                </footer>
            </div>
        </div>
    )
}
