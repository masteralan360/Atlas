import { useLayoutEffect, useState, type CSSProperties } from 'react'
import { Link } from 'wouter'
import { CircleHelp, LayoutDashboard, PanelRightOpen, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigationRailDisplay } from './NavigationRailDisplayContext'
import {
  NAVIGATION_RAIL_COLLAPSED_WIDTH,
  NAVIGATION_RAIL_WIDTH
} from './navigationRail'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/ui/components/ui/dropdown-menu'

interface NavigationRailProps {
  location: string
  hasSettings: boolean
  onNavigate: () => void
}

export function NavigationRail({ location, hasSettings, onNavigate }: NavigationRailProps) {
  const { t } = useTranslation()
  const { mode, setMode } = useNavigationRailDisplay()
  const [isPointerInside, setIsPointerInside] = useState(false)
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false)
  const [isControlMenuOpen, setIsControlMenuOpen] = useState(false)

  const isExpanded = mode === 'expanded' || isPointerInside || isKeyboardFocused || isControlMenuOpen
  const railWidth = isExpanded ? NAVIGATION_RAIL_WIDTH : NAVIGATION_RAIL_COLLAPSED_WIDTH

  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--navigation-rail-current-width', `${railWidth}px`)

    return () => {
      root.style.setProperty('--navigation-rail-current-width', `${NAVIGATION_RAIL_WIDTH}px`)
    }
  }, [railWidth])

  const contentStyle: CSSProperties = {
    opacity: isExpanded ? 1 : 0,
    visibility: isExpanded ? 'visible' : 'hidden',
    transition: isExpanded
      ? 'opacity 140ms ease 60ms, visibility 0s linear 0s'
      : 'opacity 140ms ease 0s, visibility 0s linear 140ms'
  }

  return (
    <aside
      id="atlas-navigation-rail"
      className="fixed inset-y-0 z-50 flex flex-col overflow-hidden bg-background/90 shadow-sm backdrop-blur-xl sidebar-gradient transition-[width] duration-300 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      style={{ insetInlineStart: 0, width: railWidth }}
      onPointerEnter={() => setIsPointerInside(true)}
      onPointerLeave={() => setIsPointerInside(false)}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement && event.target.matches(':focus-visible')) {
          setIsKeyboardFocused(true)
        }
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsKeyboardFocused(false)
        }
      }}
      tabIndex={mode === 'expand-on-hover' && !isExpanded ? 0 : -1}
      aria-label={t('nav.navigationRail')}
    >
      <div className="flex h-full w-14 shrink-0 flex-col" aria-hidden={!isExpanded} style={contentStyle}>
        <div className="h-12 shrink-0" />
        <nav className="flex flex-1 flex-col items-center gap-2 px-2 py-3" aria-label={t('nav.navigationRail')}>
          <Link
            href="/"
            onClick={onNavigate}
            tabIndex={isExpanded ? 0 : -1}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              location === '/' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-primary/5 hover:text-primary'
            )}
            title={t('nav.dashboard')}
            aria-label={t('nav.dashboard')}
            aria-current={location === '/' ? 'page' : undefined}
          >
            <LayoutDashboard className="h-5 w-5" />
          </Link>
          <Link
            href="/help"
            onClick={onNavigate}
            tabIndex={isExpanded ? 0 : -1}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              location === '/help' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-primary/5 hover:text-primary'
            )}
            title={t('nav.help')}
            aria-label={t('nav.help')}
            aria-current={location === '/help' ? 'page' : undefined}
          >
            <CircleHelp className="h-5 w-5" />
          </Link>
        </nav>
        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border/70 px-2 py-3">
          <DropdownMenu open={isControlMenuOpen} onOpenChange={setIsControlMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                tabIndex={isExpanded ? 0 : -1}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                title={t('nav.sidebarControl')}
                aria-label={t('nav.sidebarControl')}
              >
                <PanelRightOpen className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="center"
              sideOffset={8}
              className="w-48 rounded-xl border-border/70 bg-popover/95 p-2 backdrop-blur-xl"
            >
              <DropdownMenuLabel className="px-2 pb-2 text-xs font-medium text-muted-foreground">
                {t('nav.sidebarControl')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={mode}
                onValueChange={(value) => {
                  if (value === 'expanded' || value === 'expand-on-hover') setMode(value)
                }}
              >
                <DropdownMenuRadioItem value="expanded" className="rounded-lg py-2">
                  {t('nav.expanded')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="expand-on-hover" className="rounded-lg py-2">
                  {t('nav.expandOnHover')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {hasSettings && (
            <Link
              href="/settings"
              onClick={onNavigate}
              tabIndex={isExpanded ? 0 : -1}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                location === '/settings' || location.startsWith('/settings/')
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-primary/5 hover:text-primary'
              )}
              title={t('nav.settings')}
              aria-label={t('nav.settings')}
              aria-current={location === '/settings' || location.startsWith('/settings/') ? 'page' : undefined}
            >
              <Settings className="h-5 w-5" />
            </Link>
          )}
        </div>
      </div>
    </aside>
  )
}
