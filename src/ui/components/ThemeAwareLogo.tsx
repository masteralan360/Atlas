import { useTheme } from '@/ui/components/theme-provider'
import { cn } from '@/lib/utils'

interface ThemeAwareLogoProps {
    className?: string
}

export function ThemeAwareLogo({ className }: ThemeAwareLogoProps) {
    const { theme, style } = useTheme()

    // Determine the fill color based on both mode (light/dark) and style
    const getFillColor = () => {
        // Base colors for each style
        const colors = {
            modern: { dark: '#6366f1', light: '#4f46e5' }, // Cyan-Teal / Indigo
            emerald: { dark: '#1ACBB1', light: '#1ACBB1' }, // Emerald / Teal (Light color used in both)
            'neo-orange': { dark: '#f97316', light: '#ea580c' }, // Orange
            legacy: { dark: '#3b82f6', light: '#3b82f6' }, // Indigo / Blue
            primary: { dark: '#ffffff', light: '#0f172a' }  // White / Dark Slate
        }

        const currentStyle = colors[style] || colors.primary
        return theme === 'dark' ? currentStyle.dark : currentStyle.light
    }

    const fillColor = getFillColor()

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            className={cn("w-10 h-10 object-contain", className)}
            viewBox="0 0 100 109.99889557993635"
        >
            <g transform="translate(-4.999449888030604, 0) scale(1.0999889557993634)" fill={fillColor} className="transition-colors duration-300">
                <path d="M86.363,0H13.636c-5.02,0-9.091,6.105-9.091,13.636h90.91C95.455,6.105,91.385,0,86.363,0z" />
                <path d="M86.363,100H13.636c-5.021,0-9.091-6.105-9.091-13.637h90.91C95.455,93.895,91.385,100,86.363,100z" />
                <rect x="20.846" y="66.295" transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 97.9808 104.8644)" width="12.856" height="12.856" />
                <rect x="20.845" y="43.572" transform="matrix(-0.7071 -0.7071 0.7071 -0.7071 11.2043 104.6398)" width="12.856" height="12.856" />
                <rect x="20.846" y="20.844" transform="matrix(0.7071 -0.7071 0.7071 0.7071 -11.2967 27.2733)" width="12.856" height="12.857" />
                <rect x="43.572" y="66.293" transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 136.7781 88.7868)" width="12.856" height="12.857" />
                <rect x="43.576" y="43.571" transform="matrix(-0.7072 -0.707 0.707 -0.7072 50.0198 120.7127)" width="12.857" height="12.856" />
                <rect x="43.57" y="20.84" transform="matrix(0.7072 -0.707 0.707 0.7072 -4.6396 43.3354)" width="12.856" height="12.858" />
                <rect x="66.298" y="66.299" transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 175.5753 72.7284)" width="12.855" height="12.856" />
                <rect x="66.294" y="43.572" transform="matrix(-0.7071 -0.7071 0.7071 -0.7071 88.7877 136.7785)" width="12.857" height="12.856" />
                <rect x="66.3" y="20.848" transform="matrix(0.7071 -0.7071 0.7071 0.7071 2.0128 59.4124)" width="12.857" height="12.856" />
                <rect x="33.538" y="56.266" transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 109.345 77.4322)" width="10.195" height="10.194" />
                <rect x="33.539" y="33.539" transform="matrix(-0.7071 0.7071 -0.7071 -0.7071 93.2749 38.6367)" width="10.194" height="10.194" />
                <polygon points="38.636,76.883 33.702,81.818 43.571,81.818 " />
                <polygon points="43.571,18.182 33.702,18.182 38.636,23.117 " />
                <polygon points="61.363,76.883 56.428,81.818 66.299,81.818 " />
                <polygon points="66.299,18.182 56.428,18.182 61.363,23.117 " />
                <rect x="56.273" y="56.266" transform="matrix(-0.7071 0.7072 -0.7072 -0.7071 148.1537 61.3524)" width="10.193" height="10.194" />
                <rect x="56.272" y="33.538" transform="matrix(-0.707 0.7072 -0.7072 -0.707 132.0796 22.5535)" width="10.193" height="10.194" />
                <line x1="16.787" y1="22.24" x2="11.852" y2="27.174" stroke="none" />
                <polygon points="20.844,18.182 4.545,18.182 4.545,36.364 20.844,36.364 11.852,27.174 " />
                <polygon points="20.844,59.091 4.545,59.091 4.545,40.909 20.844,40.909 11.852,50.098 " />
                <polygon points="20.844,63.637 4.545,63.637 4.545,81.818 20.844,81.818 11.852,72.629 " />
                <polygon points="79.156,18.182 95.455,18.182 95.455,36.364 79.156,36.364 88.148,27.174 " />
                <polygon points="79.156,59.091 95.455,59.091 95.455,40.909 79.156,40.909 88.148,50.098 " />
                <polygon points="79.156,63.637 95.455,63.637 95.455,81.818 79.156,81.818 88.148,72.629 " />
            </g>
        </svg>
    )
}
