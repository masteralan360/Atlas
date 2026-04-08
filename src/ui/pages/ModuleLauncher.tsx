import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
    ArrowUpRight,
    LayoutGrid,
    Rows3,
    Search,
    type LucideIcon,
    X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { isDesktop, isMobile } from '@/lib/platform'
import { Input } from '@/ui/components/input'
import { ThemeAwareLogo } from '@/ui/components/ThemeAwareLogo'
import { buildWorkspaceNavigation, flattenWorkspaceNavigation } from '@/ui/navigation/workspaceNavigation'
import {
    launcherSectionOrder,
    launcherSections,
    moduleMetaByHref
} from '@/ui/navigation/navigationMeta'

export function ModuleLauncher() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { workspaceName, hasFeature, features } = useWorkspace()
    const [query, setQuery] = useState('')
    const [viewMode, setViewMode] = useState<'detail' | 'grid'>(() => (isMobile() ? 'grid' : 'detail'))

    const navigation = useMemo(() => buildWorkspaceNavigation({
        t,
        role: user?.role,
        hasFeature,
        features,
        isDesktopDevice: isDesktop()
    }), [features, hasFeature, t, user?.role])

    const sections = useMemo(() => {
        const visibleSidebarItems = flattenWorkspaceNavigation(navigation).filter((item) => !item.mobileOnly || isMobile())
        const grouped = new Map<(typeof launcherSectionOrder)[number], Array<{
            href: string
            label: string
            icon: LucideIcon
            description: string
            badge: string
        }>>()

        visibleSidebarItems.forEach((item) => {
            const meta = moduleMetaByHref[item.href] || {
                section: 'people-and-workspace' as const,
                description: 'Open this workspace module from the launcher.',
                badge: 'Module'
            }
            const list = grouped.get(meta.section) || []
            list.push({
                href: item.href,
                label: item.name,
                icon: item.icon,
                description: meta.description,
                badge: meta.badge
            })
            grouped.set(meta.section, list)
        })

        return launcherSectionOrder
            .map((key) => ({
                key,
                ...launcherSections[key],
                modules: grouped.get(key) || []
            }))
            .filter((section) => section.modules.length > 0)
    }, [navigation])

    const search = query.trim().toLowerCase()
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

    const gridModules = useMemo(() => (
        filteredSections.flatMap((section) => (
            section.modules.map((module) => ({
                ...module,
                theme: section.theme
            }))
        ))
    ), [filteredSections])

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
                    <div className="relative p-5 sm:p-6 lg:p-7">
                        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(16,185,129,0.08),transparent_35%,rgba(59,130,246,0.06))]" />
                        <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
                            <div className="max-w-3xl">
                                <div className="inline-flex items-center gap-2.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                                    <ThemeAwareLogo className="h-4 w-4" />
                                    Workspace launcher
                                </div>
                                <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl lg:text-[2.8rem]">
                                    Navigate {workspaceName || 'Atlas'} by workflow
                                </h1>
                                <div className="mt-5 flex flex-wrap gap-3">
                                    <SummaryCard label="Visible Sections" value={filteredSections.length} />
                                    <SummaryCard label={search ? 'Matching Modules' : 'Available Modules'} value={visibleModuleCount} />
                                    <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3 backdrop-blur-sm">
                                        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">Source</div>
                                        <div className="mt-1 text-sm font-semibold text-muted-foreground">Same visibility logic as the sidebar</div>
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
                                            placeholder="Search visible modules..."
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
                                    <div className="inline-flex items-center rounded-2xl border border-border/60 bg-background/75 p-1 shadow-sm">
                                        <button
                                            type="button"
                                            onClick={() => setViewMode('detail')}
                                            className={cn(
                                                'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-all',
                                                viewMode === 'detail'
                                                    ? 'bg-primary text-primary-foreground shadow-sm'
                                                    : 'text-muted-foreground hover:text-foreground'
                                            )}
                                        >
                                            <Rows3 className="h-4 w-4" />
                                            Detail
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setViewMode('grid')}
                                            className={cn(
                                                'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-all',
                                                viewMode === 'grid'
                                                    ? 'bg-primary text-primary-foreground shadow-sm'
                                                    : 'text-muted-foreground hover:text-foreground'
                                            )}
                                        >
                                            <LayoutGrid className="h-4 w-4" />
                                            Grid
                                        </button>
                                    </div>
                                    <Link href="/" className="inline-flex items-center justify-center rounded-2xl border border-border/60 bg-background/75 px-4 py-2.5 text-sm font-semibold text-foreground transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-primary/5">
                                        Open {t('nav.dashboard', { defaultValue: 'Dashboard' })}
                                    </Link>
                                    <div className="text-xs font-medium text-muted-foreground">
                                        {search ? `Showing ${visibleModuleCount} of ${totalModuleCount} modules for "${query.trim()}".` : `Browsing ${totalModuleCount} modules currently visible in the sidebar.`}
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
                ) : viewMode === 'grid' ? (
                    <section className="rounded-[2rem] border border-border/60 bg-card/70 p-4 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur-xl sm:p-5">
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                            {gridModules.map((module) => (
                                <Link
                                    key={module.href}
                                    href={module.href}
                                    className={cn(
                                        'group relative flex aspect-square min-h-[118px] flex-col items-center justify-center gap-3 overflow-hidden rounded-[1.35rem] border border-border/60 bg-background/85 p-4 text-center shadow-[0_12px_28px_rgba(15,23,42,0.05)] backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_18px_36px_rgba(15,23,42,0.10)]',
                                        module.theme.border
                                    )}
                                >
                                    <div className={cn('absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-xl border border-border/50 bg-background/80 shadow-sm transition-all duration-300 group-hover:scale-105', module.theme.text)}>
                                        <ArrowUpRight className="h-3.5 w-3.5" />
                                    </div>
                                    <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-current to-transparent opacity-25" />
                                    <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 opacity-80">
                                        <span className={cn('h-1.5 w-1.5 rounded-full', module.theme.surface)} />
                                        <span className={cn('h-1.5 w-1.5 rounded-full', module.theme.surface)} />
                                        <span className={cn('h-1.5 w-1.5 rounded-full', module.theme.surface)} />
                                    </div>
                                    <div className="relative z-10 flex flex-col items-center gap-3">
                                        <div className={cn('flex h-12 w-12 items-center justify-center rounded-2xl shadow-sm', module.theme.surface, module.theme.text)}>
                                            <module.icon className="h-5 w-5" />
                                        </div>
                                        <h3 className="max-w-[10rem] text-sm font-black leading-5 tracking-tight text-foreground">
                                            {module.label}
                                        </h3>
                                        <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em]', module.theme.surface, module.theme.text)}>
                                            {module.badge}
                                        </span>
                                    </div>
                                </Link>
                            ))}
                        </div>
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
                                            <Link key={module.href} href={module.href} className={cn('group relative overflow-hidden rounded-[1.5rem] border border-border/60 bg-background/80 p-4 shadow-[0_14px_38px_rgba(15,23,42,0.05)] backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_48px_rgba(15,23,42,0.10)]', section.theme.border)}>
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
