import { createContext, useContext, useEffect, useState } from "react"
import { isTauri } from "@/lib/platform"
import { platformService } from "@/services/platformService"

type Theme = "dark" | "light" | "system"
type ThemeStyle = "modern" | "legacy" | "primary" | "emerald" | "neo-orange" | "gold" | "low-power"

type ThemeProviderProps = {
    children: React.ReactNode
    defaultTheme?: Theme
    defaultStyle?: ThemeStyle
    storageKey?: string
    styleStorageKey?: string
}

type ThemeProviderState = {
    theme: Theme
    style: ThemeStyle
    setTheme: (theme: Theme) => void
    setStyle: (style: ThemeStyle) => void
}

const initialState: ThemeProviderState = {
    theme: "light",
    style: "emerald",
    setTheme: () => null,
    setStyle: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
    children,
    defaultTheme = "light",
    defaultStyle = "emerald",
    storageKey = "vite-ui-theme",
    styleStorageKey = "vite-ui-theme-style",
}: ThemeProviderProps) {
    const [theme, setTheme] = useState<Theme>(
        () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
    )
    const [style, setStyle] = useState<ThemeStyle>(
        () => (localStorage.getItem(styleStorageKey) as ThemeStyle) || defaultStyle
    )

    useEffect(() => {
        const root = window.document.documentElement

        root.classList.remove("light", "dark")

        if (theme === "system") {
            const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
                .matches
                ? "dark"
                : "light"

            root.classList.add(systemTheme)
        } else {
            root.classList.add(theme)
        }
    }, [theme])

    useEffect(() => {
        const root = window.document.documentElement
        root.classList.remove("theme-modern", "theme-legacy", "theme-primary", "theme-emerald", "theme-neo-orange", "theme-gold", "theme-low-power", "low-power")
        
        if (style === "low-power") {
            root.classList.add("low-power")
            // Fallback color scheme if low-power is the style
            root.classList.add("theme-primary")
        } else {
            root.classList.add(`theme-${style}`)
        }
    }, [style])

    const value = {
        theme,
        style,
        setTheme: (theme: Theme) => {
            localStorage.setItem(storageKey, theme)
            setTheme(theme)
        },
        setStyle: async (newStyle: ThemeStyle) => {
            const isSwitchingToLowPower = newStyle === "low-power" && style !== "low-power"
            const isLeavingLowPower = newStyle !== "low-power" && style === "low-power"

            if (isTauri() && (isSwitchingToLowPower || isLeavingLowPower)) {
                // We'll use a standard confirm for now as we're at the root level
                // Localization will be handled by passing message or hardcoded for now
                const confirmed = window.confirm(
                    isSwitchingToLowPower 
                        ? "Relaunch the app to apply memory-saving optimizations?" 
                        : "Relaunch the app to restore full visual effects?"
                )
                if (!confirmed) return
                
                localStorage.setItem(styleStorageKey, newStyle)
                setStyle(newStyle)
                await platformService.relaunch()
                return
            }

            localStorage.setItem(styleStorageKey, newStyle)
            setStyle(newStyle)
        },
    }

    return (
        <ThemeProviderContext.Provider value={value}>
            {children}
        </ThemeProviderContext.Provider>
    )
}

export const useTheme = () => {
    const context = useContext(ThemeProviderContext)

    if (context === undefined)
        throw new Error("useTheme must be used within a ThemeProvider")

    return context
}
