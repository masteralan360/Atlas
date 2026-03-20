import { useState, useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, X, Sun, Moon, ArrowUpCircle, RotateCw } from 'lucide-react'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useTheme } from '@/ui/components/theme-provider'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { GlobalSearch } from './GlobalSearch'
import { NotificationCenter } from './NotificationCenter'
import { ThemeAwareTitleLogo } from './ThemeAwareTitleLogo'


export function TitleBar() {
    const [isMaximized, setIsMaximized] = useState(false)
    const { workspaceName, pendingUpdate, isFullscreen } = useWorkspace()
    const { theme, setTheme, style } = useTheme()
    const { t } = useTranslation()
    // @ts-ignore
    const isTauri = !!window.__TAURI_INTERNALS__

    useEffect(() => {
        if (!isTauri) return
        document.documentElement.setAttribute('data-tauri', 'true')

        const updateState = async () => {
            try {
                const window = getCurrentWindow()
                const maximized = await window.isMaximized()
                setIsMaximized(maximized)
            } catch (e) {
                console.error(e)
            }
        }

        updateState()

        let unlisten: () => void

        const setupListener = async () => {
            try {
                const window = getCurrentWindow()
                unlisten = await window.onResized(updateState)
            } catch (e) {
                console.error(e)
            }
        }
        setupListener()

        return () => {
            if (unlisten) unlisten()
        }
    }, [isTauri])

    const minimize = async () => {
        if (!isTauri) return
        await getCurrentWindow().minimize()
    }

    // Toggle Maximize / Restore
    const toggleMaximize = async () => {
        if (!isTauri) return
        const window = getCurrentWindow()
        const maximized = await window.isMaximized()

        if (maximized) {
            await window.unmaximize()
            setIsMaximized(false)
        } else {
            await window.maximize()
            setIsMaximized(true)
        }
    }

    const close = async () => {
        if (!isTauri) return
        await getCurrentWindow().close()
    }

    const toggleTheme = (event: React.MouseEvent) => {
        const x = event.clientX;
        const y = event.clientY;

        // @ts-ignore
        if (!document.startViewTransition) {
            setTheme(theme === 'dark' ? 'light' : 'dark');
            return;
        }

        document.documentElement.style.setProperty('--x', `${x}px`);
        document.documentElement.style.setProperty('--y', `${y}px`);

        // @ts-ignore
        document.startViewTransition(() => {
            setTheme(theme === 'dark' ? 'light' : 'dark');
        });
    };

    if (!isTauri) return null

    return (
        <div dir="ltr" data-tauri-drag-region className={cn(
            "fixed top-0 left-0 right-0 h-[48px] z-[100] flex items-center justify-between px-3 select-none bg-background/80 backdrop-blur-md border-b border-white/10 transition-all duration-300",
            isFullscreen && "opacity-0 pointer-events-none -translate-y-full"
        )}>
            <div data-tauri-drag-region className="flex items-center gap-3 w-1/3">
                <ThemeAwareTitleLogo className="w-10 h-10 opacity-90" />
                <span data-tauri-drag-region className="text-sm font-medium opacity-80 truncate">
                    {workspaceName || t('auth.titleName')}
                </span>
            </div>

            {/* Center: Search Box */}
            <div data-tauri-drag-region className="flex-1 flex justify-center max-w-md">
                <GlobalSearch className="max-w-[400px]" />
            </div>

            {/* Right: Window Controls */}
            <div data-tauri-drag-region className="flex items-center justify-end gap-1 w-1/3">
                {pendingUpdate && (
                    <button
                        onClick={() => {
                            // Logic to trigger update dialog - we can just let App.tsx handle it 
                            // or better, we can expose the check function.
                            // For now, let's assume we want to re-run the check.
                            window.dispatchEvent(new CustomEvent('check-for-updates'))
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 mr-2 rounded-full bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 transition-all border border-blue-500/20 group"
                        title={t('updater.available')}
                    >
                        <ArrowUpCircle className="w-3.5 h-3.5 group-hover:animate-bounce" />
                        <span className="text-xs font-medium">{t('updater.available')}</span>
                    </button>
                )}
                <button
                    onClick={() => window.location.reload()}
                    className={cn(
                        "p-2 transition-colors mr-1",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                    )}
                    title={t('common.refresh') || "Refresh"}
                >
                    <RotateCw className="w-4 h-4" />
                </button>
                <button
                    onClick={toggleTheme}
                    className={cn(
                        "p-2 transition-colors mr-1",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                    )}
                    title={theme === 'dark' ? "Switch to Light Mode" : "Switch to Dark Mode"}
                >
                    {theme === 'dark' ? (
                        <Sun className="w-4 h-4" />
                    ) : (
                        <Moon className="w-4 h-4" />
                    )}
                </button>
                {!isFullscreen && <NotificationCenter />}
                <button
                    onClick={minimize}
                    className={cn(
                        "p-2 transition-colors",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                    )}
                    title="Minimize"
                >
                    <Minus className="w-4 h-4" />
                </button>
                <button
                    onClick={toggleMaximize}
                    className={cn(
                        "p-2 transition-colors",
                        style === 'neo-orange' ? "neo-indicator" : "hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground"
                    )}
                    title={isMaximized ? "Restore" : "Maximize"}
                >
                    <Square className="w-3.5 h-3.5" />
                </button>
                <button
                    onClick={close}
                    className={cn(
                        "p-2 transition-colors",
                        style === 'neo-orange' ? "neo-indicator bg-red-500/10 border-red-500/50 hover:bg-red-500 hover:text-white" : "hover:bg-red-500/10 hover:text-red-500 rounded-md text-muted-foreground"
                    )}
                    title="Close"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}
