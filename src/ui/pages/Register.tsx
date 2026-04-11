import { useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '@/auth'
import { Button, Input, Label, Card, CardContent, CardHeader, CardTitle, CardDescription, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, LanguageSwitcher, ThemeToggle, RegisterWorkspaceContactsModal, type AdminContact } from '@/ui/components'
import { Mail, Lock, User, Loader2, Key, Contact } from 'lucide-react'
import type { UserRole } from '@/local-db/models'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useFavicon } from '@/hooks/useFavicon'

export function Register() {
    const [, setLocation] = useLocation()
    const { signUp, isSupabaseConfigured } = useAuth()
    const { t } = useTranslation()
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
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
                // Show real error message from database triggers
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
        <div className={`h-screen overflow-hidden flex items-center justify-center relative ${isTauri ? 'bg-transparent' : 'bg-background'}`}>
            <div className={cn(
                "w-full h-full overflow-y-auto flex items-center justify-center p-4 bg-background",
                isTauri && "mt-[var(--titlebar-height)] h-[calc(100vh-var(--titlebar-height))]"
            )}>

                {/* Theme & Language Switchers */}
                <div className={`fixed right-4 z-20 flex items-center gap-2 ${isTauri ? 'top-[60px]' : 'top-4'}`}>
                    <LanguageSwitcher />
                    <ThemeToggle />
                </div>

                <div className="w-full max-w-md space-y-6">
                    {/* Logo */}
                    <div className="flex flex-col items-center gap-2">
                        <div className="p-1 bg-primary/10 rounded-2xl overflow-hidden">
                            <img
                                src="/logo.png"
                                alt="Asas System"
                                className="w-16 h-16 object-contain rounded-xl shadow-sm hover:scale-105 transition-transform duration-300"
                            />
                        </div>
                        <h1 className="text-2xl font-bold gradient-text">{t('auth.systemName')}</h1>
                        <p className="text-sm text-muted-foreground">{t('auth.systemSubtitle')}</p>
                    </div>

                    <Card className="glass">
                        <CardHeader className="text-center">
                            <CardTitle>{t('auth.getStarted')}</CardTitle>
                            <CardDescription>{t('auth.createAccountSubtitle')}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {!isSupabaseConfigured && (
                                <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                                    <p className="text-sm text-amber-500">
                                        {t('auth.supabaseNotConfigured')}
                                    </p>
                                </div>
                            )}

                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="name">{t('auth.fullName')}</Label>
                                    <div className="relative">
                                        <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="name"
                                            type="text"
                                            placeholder="John Doe"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                            className="pl-10"
                                            required
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="email">{t('auth.email')}</Label>
                                    <div className="relative">
                                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="email"
                                            type="email"
                                            placeholder="you@example.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            className="pl-10"
                                            required
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="password">{t('auth.password')}</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="password"
                                            type="password"
                                            placeholder="••••••••"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            className="pl-10"
                                            required={isSupabaseConfigured}
                                            minLength={6}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="passkey">{t('auth.passkey')}</Label>
                                    <div className="relative">
                                        <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            id="passkey"
                                            type="text"
                                            placeholder={t('auth.passkeyPlaceholder')}
                                            value={passkey}
                                            onChange={(e) => setPasskey(e.target.value)}
                                            className="pl-10"
                                            required={isSupabaseConfigured}
                                            maxLength={32}
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                            spellCheck={false}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="role">{t('auth.role')}</Label>
                                    <Select value={role} onValueChange={(value) => setRole(value as UserRole)}>
                                        <SelectTrigger>
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
                                    <div className="space-y-4">
                                        <div className="space-y-2">
                                            <Label htmlFor="workspaceName">{t('auth.workspaceName')}</Label>
                                            <div className="relative">
                                                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                                <Input
                                                    id="workspaceName"
                                                    type="text"
                                                    placeholder="e.g. My Awesome Corp"
                                                    value={workspaceName}
                                                    onChange={(e) => setWorkspaceName(e.target.value)}
                                                    className="pl-10"
                                                    required
                                                />
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <Label>{t('workspaceConfig.contacts.title', 'Workspace Contacts')}</Label>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                className={cn("w-full justify-start text-left font-normal h-10", adminContacts.length > 0 ? "text-foreground" : "text-muted-foreground")}
                                                onClick={() => setContactsModalOpen(true)}
                                            >
                                                <Contact className="mr-2 h-4 w-4 opacity-50" />
                                                {adminContacts.length > 0
                                                    ? `${adminContacts.length} contact${adminContacts.length > 1 ? 's' : ''} added`
                                                    : (t('workspaceConfig.contacts.addContacts', 'Add Contacts'))}
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <Label htmlFor="workspaceCode">{t('auth.workspaceCode')}</Label>
                                        <div className="relative">
                                            <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                            <Input
                                                id="workspaceCode"
                                                type="text"
                                                placeholder="ABCD-1234"
                                                value={workspaceCode}
                                                onChange={(e) => setWorkspaceCode(e.target.value)}
                                                className="pl-10"
                                                required
                                            />
                                        </div>
                                    </div>
                                )}

                                {error && (
                                    <p className="text-sm text-destructive">{error}</p>
                                )}

                                <Button type="submit" className="w-full" disabled={isLoading}>
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            {t('auth.creatingAccount')}
                                        </>
                                    ) : (
                                        t('auth.createAccountBtn')
                                    )}
                                </Button>
                            </form>

                            <div className="mt-4 text-center">
                                <button
                                    onClick={() => setLocation('/login')}
                                    className="text-sm text-primary hover:underline"
                                >
                                    {t('auth.hasAccount')}
                                </button>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <RegisterWorkspaceContactsModal
                    open={contactsModalOpen}
                    onOpenChange={setContactsModalOpen}
                    contacts={adminContacts}
                    onContactsChange={setAdminContacts}
                />
            </div>
        </div>
    )
}
