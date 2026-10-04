import { useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '@/auth'
import { Button, Input, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, LanguageSwitcher, ThemeToggle, RegisterWorkspaceContactsModal, type AdminContact } from '@/ui/components'
import { Mail, Lock, User, Loader2, Key, Contact, Sparkles, Eye, EyeOff, LayoutDashboard, Users, ShieldCheck } from 'lucide-react'
import type { UserRole } from '@/local-db/models'
import { useTranslation } from 'react-i18next'
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

export function Register() {
    const [, setLocation] = useLocation()
    const { signUp, isSupabaseConfigured } = useAuth()
    const { t } = useTranslation()
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [passkey, setPasskey] = useState('')
    const [role, setRole] = useState<UserRole>('staff')
    const [workspaceName, setWorkspaceName] = useState('')
    const [workspaceCode, setWorkspaceCode] = useState('')
    const [adminContacts, setAdminContacts] = useState<AdminContact[]>([])
    const [contactsModalOpen, setContactsModalOpen] = useState(false)
    const [error, setError] = useState('')
    const [isLoading, setIsLoading] = useState(false)

    // Static favicon
    useFavicon()

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setIsLoading(true)

        try {
            const { error } = await signUp({
                email,
                password,
                name,
                role,
                passkey,
                workspaceName: role === 'admin' ? workspaceName : undefined,
                workspaceCode: role !== 'admin' ? workspaceCode : undefined,
                adminContacts: role === 'admin' ? adminContacts : undefined
            })
            if (error) {
                setError(error.message)
            } else {
                if (role === 'admin') {
                    setLocation('/workspace-configuration')
                } else {
                    setLocation('/')
                }
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
                                    {t('auth.registerPatternTitle', 'Join the Future of Business').split('Business').map((part, i, arr) => (
                                        <span key={i}>
                                            {part}
                                            {i < arr.length - 1 && <span className="text-teal-400">{t('common.business', 'Business')}</span>}
                                        </span>
                                    ))}
                                </h2>
                                <p className="text-xl text-teal-100/80 max-w-md font-light leading-relaxed">
                                    {t('auth.registerPatternSubtitle', 'Create your organization account and unlock the full potential of Atlas today.')}
                                </p>
                            </div>
                        </div>

                        <div className="relative mt-auto group w-full max-w-2xl self-center">
                            <div className="relative overflow-hidden rounded-2xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.6)] border border-gray-500/30 bg-teal-900/40 backdrop-blur-sm transition-all duration-500">
                                <div className="p-8 space-y-6">
                                    <div className="flex items-start gap-4 group/item transition-all">
                                        <div className="p-3 bg-teal-500/20 rounded-xl group-hover/item:bg-teal-500/30 transition-colors">
                                            <LayoutDashboard className="w-6 h-6 text-teal-400" />
                                        </div>
                                        <div className="space-y-1">
                                            <h3 className="text-lg font-semibold text-white">{t('auth.benefits.suiteTitle', 'Complete Enterprise Suite')}</h3>
                                            <p className="text-sm text-teal-100/60 leading-relaxed font-light">
                                                {t('auth.benefits.suiteDesc', 'Access POS, Inventory, Accounting and Expenses, and HR in one seamless platform.')}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-start gap-4 group/item transition-all">
                                        <div className="p-3 bg-teal-500/20 rounded-xl group-hover/item:bg-teal-500/30 transition-colors">
                                            <Users className="w-6 h-6 text-teal-400" />
                                        </div>
                                        <div className="space-y-1">
                                            <h3 className="text-lg font-semibold text-white">{t('auth.benefits.teamTitle', 'Team Ready')}</h3>
                                            <p className="text-sm text-teal-100/60 leading-relaxed font-light">
                                                {t('auth.benefits.teamDesc', 'Manage permissions and roles for your entire organization with ease.')}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-start gap-4 group/item transition-all">
                                        <div className="p-3 bg-teal-500/20 rounded-xl group-hover/item:bg-teal-500/30 transition-colors">
                                            <ShieldCheck className="w-6 h-6 text-teal-400" />
                                        </div>
                                        <div className="space-y-1">
                                            <h3 className="text-lg font-semibold text-white">{t('auth.benefits.secureTitle', 'Scalable & Secure')}</h3>
                                            <p className="text-sm text-teal-100/60 leading-relaxed font-light">
                                                {t('auth.benefits.secureDesc', 'Built on high-performance infrastructure to grow with your business goal.')}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Right Side: Register Form */}
            <div className="w-full lg:w-1/2 flex flex-col items-center p-6 md:p-12 lg:p-16 bg-white dark:bg-slate-950 overflow-y-auto">
                <div className="w-full max-w-xl space-y-8 my-auto">
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
                        <h2 className="text-3xl font-bold text-gray-900 dark:text-white">{t('auth.getStarted')}</h2>
                        <p className="text-sm text-gray-400 dark:text-slate-500">{t('auth.createAccountSubtitle')}</p>
                    </div>

                    {!isSupabaseConfigured && (
                        <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/30 text-sm text-amber-600 dark:text-amber-400 animate-in fade-in slide-in-from-top-1">
                            {t('auth.supabaseNotConfigured')}
                        </div>
                    )}

                    {error && (
                        <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30 text-sm text-red-600 dark:text-red-400 animate-in fade-in slide-in-from-top-1">
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="name" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                    {t('auth.fullName')}
                                </Label>
                                <div className="relative group">
                                    <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-slate-500 group-focus-within:text-teal-600 dark:group-focus-within:text-teal-400 transition-colors" />
                                    <Input
                                        id="name"
                                        type="text"
                                        placeholder={t('auth.fullNamePlaceholder')}
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        className="h-12 pl-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white"
                                        required
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                    {t('auth.email')}
                                </Label>
                                <div className="relative group">
                                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-slate-500 group-focus-within:text-teal-600 dark:group-focus-within:text-teal-400 transition-colors" />
                                    <Input
                                        id="email"
                                        type="email"
                                        placeholder={t('auth.emailPlaceholder')}
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        className="h-12 pl-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white"
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
                                        type={showPassword ? "text" : "password"}
                                        placeholder={t('auth.passwordPlaceholder')}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className="h-12 pl-12 pr-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white"
                                        required={isSupabaseConfigured}
                                        minLength={6}
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

                            <div className="space-y-2">
                                <Label htmlFor="passkey" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                    {t('auth.passkey')}
                                </Label>
                                <div className="relative group">
                                    <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-slate-500 group-focus-within:text-teal-600 dark:group-focus-within:text-teal-400 transition-colors" />
                                    <Input
                                        id="passkey"
                                        type="text"
                                        placeholder={t('auth.passkeyPlaceholder')}
                                        value={passkey}
                                        onChange={(e) => setPasskey(e.target.value)}
                                        className="h-12 pl-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white"
                                        required={isSupabaseConfigured}
                                        maxLength={32}
                                        autoCapitalize="off"
                                        autoCorrect="off"
                                        spellCheck={false}
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="role" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                    {t('auth.role')}
                                </Label>
                                <Select value={role} onValueChange={(value) => setRole(value as UserRole)}>
                                    <SelectTrigger className="h-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white">
                                        <SelectValue placeholder={t('auth.selectRole')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="admin">{t('auth.roles.admin')}</SelectItem>
                                        <SelectItem value="staff">{t('auth.roles.staff')}</SelectItem>
                                        <SelectItem value="viewer">{t('auth.roles.viewer')}</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            {role === 'admin' ? (
                                <>
                                    <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                                        <Label htmlFor="workspaceName" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                            {t('auth.workspaceName')}
                                        </Label>
                                        <div className="relative group">
                                            <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-slate-500 group-focus-within:text-teal-600 dark:group-focus-within:text-teal-400 transition-colors" />
                                            <Input
                                                id="workspaceName"
                                                type="text"
                                                placeholder={t('auth.workspaceNamePlaceholder')}
                                                value={workspaceName}
                                                onChange={(e) => setWorkspaceName(e.target.value)}
                                                className="h-12 pl-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white"
                                                required
                                            />
                                        </div>
                                    </div>
                                    <div className="col-span-full space-y-2 animate-in fade-in slide-in-from-top-2">
                                        <Label className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                            {t('workspaceConfig.contacts.title', 'Workspace Contacts')}
                                        </Label>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className={cn(
                                                "w-full h-12 justify-start text-left font-normal bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl hover:bg-gray-50 dark:hover:bg-slate-800 transition-all",
                                                adminContacts.length > 0 ? "text-gray-900 dark:text-white" : "text-gray-400 dark:text-slate-500"
                                            )}
                                            onClick={() => setContactsModalOpen(true)}
                                        >
                                            <Contact className="mr-3 h-5 w-5 opacity-50" />
                                            {adminContacts.length > 0
                                                ? `${adminContacts.length} contact${adminContacts.length > 1 ? 's' : ''} added`
                                                : (t('workspaceConfig.contacts.addContacts', 'Add Contacts'))}
                                        </Button>
                                    </div>
                                </>
                            ) : (
                                <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                                    <Label htmlFor="workspaceCode" className="text-xs font-semibold text-gray-700 dark:text-slate-300 uppercase tracking-wider pl-1">
                                        {t('auth.workspaceCode')}
                                    </Label>
                                    <div className="relative group">
                                        <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-slate-500 group-focus-within:text-teal-600 dark:group-focus-within:text-teal-400 transition-colors" />
                                        <Input
                                            id="workspaceCode"
                                            type="text"
                                            placeholder={t('auth.workspaceCodePlaceholder')}
                                            value={workspaceCode}
                                            onChange={(e) => setWorkspaceCode(e.target.value)}
                                            className="h-12 pl-12 bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-800 rounded-xl focus:ring-teal-500 dark:focus:ring-teal-400 focus:border-teal-500 dark:focus:border-teal-400 transition-all text-gray-900 dark:text-white"
                                            required
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        <Button 
                            type="submit" 
                            className="w-full h-12 bg-teal-600 hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-600 text-white font-semibold rounded-xl shadow-md hover:shadow-lg transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed" 
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <>
                                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                                    {t('auth.creatingAccount')}
                                </>
                            ) : (
                                t('auth.createAccountBtn')
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
                        <button
                            onClick={() => setLocation('/login')}
                            className="text-sm text-gray-500 dark:text-slate-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
                        >
                            {t('auth.hasAccount')}
                        </button>
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

            <RegisterWorkspaceContactsModal
                open={contactsModalOpen}
                onOpenChange={setContactsModalOpen}
                contacts={adminContacts}
                onContactsChange={setAdminContacts}
            />
        </div>
    )
}
