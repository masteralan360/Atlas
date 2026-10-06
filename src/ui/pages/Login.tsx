import { useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '@/auth'
import { Button, Input, Label, LanguageSwitcher, ThemeToggle } from '@/ui/components'
import { Mail, Lock, Loader2, Eye, EyeOff, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isMobile } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useFavicon } from '@/hooks/useFavicon'

const GeometricPattern = () => (
    <div className="absolute inset-0 overflow-hidden bg-[#042f2e]">
        <svg
            className="absolute inset-0 w-full h-full opacity-60"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <defs>
                <linearGradient id="sh1" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#0d9488" stopOpacity="0.4" />
                    <stop offset="100%" stopColor="transparent" />
                </linearGradient>
                <linearGradient id="sh2" x1="100%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#14b8a6" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="transparent" />
                </linearGradient>
            </defs>
            
            <path d="M0 0L40 0L20 40Z" fill="url(#sh1)" />
            <path d="M40 0L100 0L70 30Z" fill="url(#sh2)" />
            <path d="M100 0L100 60L60 40Z" fill="url(#sh1)" />
            <path d="M100 60L100 100L40 80Z" fill="url(#sh2)" />
            <path d="M100 100L0 100L30 50Z" fill="url(#sh1)" />
            <path d="M0 100L0 40L40 60Z" fill="url(#sh2)" />
            <path d="M0 40L0 0L50 50Z" fill="url(#sh1)" />
            
            <path d="M20 40L70 30L60 70Z" fill="#0d9488" opacity="0.1" />
            <path d="M30 50L60 40L40 80Z" fill="#14b8a6" opacity="0.1" />
        </svg>

        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(45,212,191,0.15),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_80%,rgba(13,148,136,0.2),transparent_70%)]" />
    </div>
)

export function Login() {
    const [, setLocation] = useLocation()
    const { signIn, isSupabaseConfigured } = useAuth()
    const { t } = useTranslation()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [error, setError] = useState('')
    const [isLoading, setIsLoading] = useState(false)

    // Static favicon
    useFavicon()

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setIsLoading(true)

        try {
            const { error } = await signIn(email, password)
            if (error) {
                setError(error.message)
            } else {
                // Biometric Enrollment Logic
                // @ts-ignore
                const isTauri = !!window.__TAURI_INTERNALS__
                if (isTauri && isMobile()) {
                    const biometricChoice = localStorage.getItem('biometric_enabled')
                    if (biometricChoice === null) {
                        try {
                            const { checkStatus } = await import('@tauri-apps/plugin-biometric')
                            const support = await checkStatus()

                            if (support.isAvailable) {
                                const { ask } = await import('@tauri-apps/plugin-dialog')
                                const wantsBiometrics = await ask(
                                    t('auth.biometricPromptMessage', 'Would you like to enable biometric unlock for quicker access next time?'),
                                    {
                                        title: t('auth.biometricPromptTitle', 'Enable Biometric Unlock'),
                                        kind: 'info',
                                        okLabel: t('common.yes', 'Yes'),
                                        cancelLabel: t('common.no', 'No')
                                    }
                                )
                                localStorage.setItem('biometric_enabled', wantsBiometrics ? 'true' : 'false')
                                if (wantsBiometrics) {
                                    localStorage.setItem('biometric_frequency', '24h')
                                    localStorage.setItem('biometric_last_auth', Date.now().toString())
                                }
                            } else {
                                // Mark as false if not supported to avoid checking again
                                localStorage.setItem('biometric_enabled', 'false')
                            }
                        } catch (e) {
                            console.error('Biometric support check failed:', e)
                        }
                    }
                }

                setLocation('/')
            }
        } catch (err) {
            setError(t('common.error') || 'An unexpected error occurred')
        } finally {
            setIsLoading(false)
        }
    }

    // @ts-ignore
    const isTauri = !!window.__TAURI_INTERNALS__

    return (
        <div className={cn(
            "flex bg-white dark:bg-slate-950 transition-colors duration-300",
            isTauri 
                ? "h-[calc(100vh-var(--titlebar-height))] mt-[var(--titlebar-height)]" 
                : "h-screen w-full"
        )}>
            {/* Left Side: Geometric Pattern */}
            <div className="hidden lg:flex lg:w-1/2 relative bg-white dark:bg-slate-950 transition-colors duration-300">
                <div className="absolute inset-4 overflow-hidden rounded-[2.5rem] bg-teal-950 shadow-2xl shadow-teal-900/20 border border-teal-800/50">
                    <GeometricPattern />
                    
                    <div className="relative z-10 w-full h-full p-12 flex flex-col justify-between text-white">
                        <div className="space-y-12">
                            <img 
                                src="/logo-wide.png" 
                                alt="Atlas Logo" 
                                className="h-10 w-auto object-contain brightness-0 invert" 
                            />
                        
                        <div className="space-y-4">
                            <h2 className="text-5xl font-bold tracking-tight leading-tight">
                                {t('auth.patternTitle', 'Built for Modern Business').split('Modern Business').map((part, i, arr) => (
                                    <span key={i}>
                                        {part}
                                        {i < arr.length - 1 && <span className="text-teal-400">{t('common.modernBusiness', 'Modern Business')}</span>}
                                    </span>
                                ))}
                            </h2>
                            <p className="text-xl text-teal-100/80 max-w-md font-light leading-relaxed">
                                {t('auth.patternSubtitle', 'The all-in-one ERP platform designed to scale your operations and simplify your workflows.')}
                            </p>
                        </div>
                    </div>

                    <div className="relative mt-auto group w-full max-w-2xl self-center [perspective:2000px]">
                        <div className="absolute -inset-12 bg-teal-500/20 blur-3xl rounded-full opacity-20 group-hover:opacity-40 transition-opacity duration-1000" />
                        <div className="relative overflow-hidden rounded-2xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.6)] border border-gray-500/30 bg-teal-900/40 backdrop-blur-sm transition-all duration-1000 ease-out [transform:rotateX(12deg)_rotateY(-12deg)_rotateZ(1deg)] group-hover:[transform:rotateX(0deg)_rotateY(0deg)_rotateZ(0deg)] group-hover:scale-[1.05] group-hover:-translate-y-12">
                            <img 
                                src="/dashboard.png" 
                                alt="Dashboard Preview" 
                                className="w-full h-auto object-cover opacity-90 group-hover:opacity-100 transition-opacity duration-1000 shadow-inner"
                            />
                            {/* Reflex highlight effect */}
                            <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-1000" />
                        </div>
                    </div>
                </div>
            </div>
        </div>

            {/* Right Side: Login Form */}
            <div className="w-full lg:w-1/2 flex flex-col items-center p-6 md:p-12 lg:p-16 bg-white dark:bg-slate-950 overflow-y-auto">
                <div className="w-full max-w-sm space-y-8 my-auto">
                    {/* Branding */}
                    <div className="flex flex-col items-center text-center space-y-4">
                        <div className="w-16 h-16 bg-black dark:bg-slate-900 rounded-2xl flex items-center justify-center p-2 shadow-lg border border-white/10">
                            <img
                                src="/logo.png"
                                alt="Atlas"
                                className="w-full h-full object-contain"
                            />
                        </div>
                        <div className="space-y-1">
                            <h1 className="text-2xl font-bold text-teal-800 dark:text-teal-400 tracking-tight">{t('auth.systemName')}</h1>
                            <p className="text-sm text-gray-500 dark:text-slate-400 font-medium">{t('auth.systemSubtitle')}</p>
                        </div>
                    </div>

                    {/* Welcome Text */}
                    <div className="text-center space-y-2">
                        <h2 className="text-3xl font-bold text-gray-900 dark:text-white">{t('auth.welcomeBack')}</h2>
                        <p className="text-sm text-gray-400 dark:text-slate-500">{t('auth.signInSubtitle')}</p>
                    </div>

                    {error && (
                        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30 text-sm text-red-600 dark:text-red-400 animate-in fade-in slide-in-from-top-1">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-5">
                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                    {t('auth.email')}
                                </Label>
                                <div className="relative group">
                                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-slate-500 group-focus-within:text-teal-600 dark:group-focus-within:text-teal-400 transition-colors" />
                                    <Input
                                        id="email"
                                        name="username"
                                        type="email"
                                        autoComplete="username"
                                        allowBrowserAutofill
                                        placeholder={t('auth.emailPlaceholder', 'you@example.com')}
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        className="h-12 pl-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white placeholder:text-gray-300 dark:placeholder:text-slate-600"
                                        required
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="password" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                    {t('auth.password')}
                                </Label>
                                <div className="relative group">
                                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-slate-500 group-focus-within:text-teal-600 dark:group-focus-within:text-teal-400 transition-colors" />
                                    <Input
                                        id="password"
                                        name="password"
                                        type={showPassword ? "text" : "password"}
                                        autoComplete="current-password"
                                        allowBrowserAutofill
                                        placeholder="••••••••••••"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className="h-12 pl-12 pr-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white placeholder:text-gray-300 dark:placeholder:text-slate-600"
                                        required={isSupabaseConfigured}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                                    >
                                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <Button 
                            type="submit" 
                            className="w-full h-12 bg-teal-600 hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-600 text-white font-semibold rounded-xl shadow-md hover:shadow-lg transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed" 
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <>
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                                    {t('auth.signingIn')}
                                </>
                            ) : (
                                t('auth.signIn')
                            )}
                        </Button>
                    </form>

                    {import.meta.env.VITE_ENABLE_DEMO === 'true' && (
                        <>
                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <span className="w-full border-t border-gray-200 dark:border-slate-800"></span>
                                </div>
                                <div className="relative flex justify-center text-xs uppercase">
                                    <span className="bg-white dark:bg-slate-950 px-4 text-gray-400 dark:text-slate-500 font-medium">{t('common.or', 'or')}</span>
                                </div>
                            </div>

                            <Button
                                type="button"
                                onClick={() => setLocation('/demo-setup')}
                                className="w-full h-12 bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600 text-white font-semibold rounded-xl shadow-md hover:shadow-lg transition-all active:scale-[0.98]"
                            >
                                <Sparkles className="w-5 h-5 mr-2" />
                                {t('auth.tryDemo', 'Try Demo')}
                            </Button>
                        </>
                    )}

                    <div className="text-center">
                        <p className="text-sm text-gray-500 dark:text-slate-400">
                            {t('auth.noAccount').includes('?') 
                                ? t('auth.noAccount').split('?')[0] + '? ' 
                                : t('auth.noAccount').replace(t('auth.register'), '').trim()}
                            <button
                                onClick={() => setLocation('/register')}
                                className="text-teal-600 dark:text-teal-400 font-semibold hover:underline"
                            >
                                {t('auth.register')}
                            </button>
                        </p>
                    </div>

                    {/* Theme & Language Switchers (Floating) */}
                    <div className={cn(
                        "fixed max-sm:hidden flex flex-col sm:flex-row items-center gap-3 transition-all duration-300 z-[100]",
                        isTauri ? "top-[60px] end-6" : "top-2 end-6"
                    )}>
                        <LanguageSwitcher className="w-[110px] sm:w-[140px]" />
                        <ThemeToggle className="w-[100px] sm:w-[130px]" />
                    </div>
                </div>
            </div>
        </div>
    )
}
