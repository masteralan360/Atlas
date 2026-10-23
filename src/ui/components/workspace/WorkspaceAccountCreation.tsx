import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AtSign, KeyRound, Loader2, UserPlus } from 'lucide-react'
import { isSupabaseConfigured, supabase } from '@/auth/supabase'
import { useAuth } from '@/auth'
import {
    buildWorkspaceAccountCreationRequest,
    getWorkspaceAccountCreationErrorKey,
    validateWorkspaceAccountCreationForm
} from '@/accounts/workspaceAccountCreation'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Button,
    Input,
    Label,
    useToast
} from '@/ui/components'

interface WorkspaceAccountCreationProps {
    onCreated?: () => void | Promise<void>
}

type AccountCreationErrorResponse = {
    code?: string
}

async function readAccountCreationErrorCode(error: unknown, data: unknown) {
    if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'string') {
        return data.code
    }

    if (error && typeof error === 'object' && 'context' in error) {
        const context = error.context
        if (context instanceof Response) {
            const body = await context.clone().json().catch(() => null) as AccountCreationErrorResponse | null
            return body?.code
        }
    }

    return undefined
}

export function WorkspaceAccountCreation({ onCreated }: WorkspaceAccountCreationProps) {
    const { user } = useAuth()
    const { t } = useTranslation()
    const { toast } = useToast()
    const [dialogOpen, setDialogOpen] = useState(false)
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [isCreating, setIsCreating] = useState(false)
    const [submitAttempted, setSubmitAttempted] = useState(false)

    const workspaceId = user?.workspaceId ?? ''
    const canManage = Boolean(
        isSupabaseConfigured
        && user?.role === 'admin'
        && workspaceId
        && (user.workspaceMode === 'cloud' || user.workspaceMode === 'hybrid')
    )

    const formValues = useMemo(() => ({ name, email, password, confirmPassword }), [name, email, password, confirmPassword])
    const validationError = validateWorkspaceAccountCreationForm(formValues)
    const hasInput = Boolean(name || email || password || confirmPassword)

    if (!canManage || !user) return null

    const resetForm = () => {
        setName('')
        setEmail('')
        setPassword('')
        setConfirmPassword('')
        setSubmitAttempted(false)
    }

    const handleOpenChange = (open: boolean) => {
        if (isCreating) return
        if (!open) resetForm()
        setDialogOpen(open)
    }

    const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setSubmitAttempted(true)
        if (isCreating || validationError) return

        const request = buildWorkspaceAccountCreationRequest(formValues)
        if (!request) return

        setIsCreating(true)
        try {
            const { data, error } = await supabase.functions.invoke('workspace-account-creation', {
                body: request
            })

            if (error || !data?.id) {
                const code = await readAccountCreationErrorCode(error, data)
                throw new Error(code ?? 'account_creation_failed')
            }

            setDialogOpen(false)
            resetForm()
            toast({
                title: t('common.success'),
                description: t('workspaceAccountCreation.success')
            })
            try {
                await onCreated?.()
            } catch (refreshError) {
                console.error('[WorkspaceAccountCreation] Account created but the module view did not refresh:', refreshError)
            }
        } catch (error) {
            console.error('[WorkspaceAccountCreation] Account creation failed:', error)
            const code = error instanceof Error ? error.message : undefined
            toast({
                title: t('common.error'),
                description: t(getWorkspaceAccountCreationErrorKey(code)),
                variant: 'destructive'
            })
        } finally {
            setIsCreating(false)
        }
    }

    const showValidationError = Boolean(validationError && (submitAttempted || hasInput))

    return (
        <>
            <Button type="button" size="sm" onClick={() => setDialogOpen(true)} disabled={isCreating}>
                <UserPlus className="me-2 h-4 w-4" aria-hidden="true" />
                {t('workspaceAccountCreation.create')}
            </Button>
            <AppDialog open={dialogOpen} onOpenChange={handleOpenChange}>
                <AppDialogContent className="max-w-xl" showCloseButton={!isCreating}>
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <UserPlus className="h-5 w-5 text-primary" aria-hidden="true" />
                            {t('workspaceAccountCreation.title')}
                        </AppDialogTitle>
                        <p className="text-sm text-muted-foreground">
                            {t('workspaceAccountCreation.description')}
                        </p>
                    </AppDialogHeader>

                    <form onSubmit={handleCreate} className="flex min-h-0 flex-1 flex-col">
                        <AppDialogBody className="space-y-4">
                            <div className="grid gap-2">
                                <Label htmlFor="workspace-account-name">
                                    {t('workspaceAccountCreation.name')} <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                    id="workspace-account-name"
                                    name="name"
                                    autoComplete="name"
                                    allowBrowserAutofill
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                    placeholder={t('workspaceAccountCreation.namePlaceholder')}
                                    disabled={isCreating}
                                    required
                                    maxLength={120}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="workspace-account-email">
                                    {t('workspaceAccountCreation.email')} <span className="text-destructive">*</span>
                                </Label>
                                <div className="relative">
                                    <AtSign className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                                    <Input
                                        id="workspace-account-email"
                                        className="ps-10"
                                        type="email"
                                        name="email"
                                        autoComplete="email"
                                        allowBrowserAutofill
                                        value={email}
                                        onChange={(event) => setEmail(event.target.value)}
                                        placeholder={t('workspaceAccountCreation.emailPlaceholder')}
                                        disabled={isCreating}
                                        required
                                        maxLength={254}
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="workspace-account-password">
                                    {t('workspaceAccountCreation.password')} <span className="text-destructive">*</span>
                                </Label>
                                <div className="relative">
                                    <KeyRound className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                                    <Input
                                        id="workspace-account-password"
                                        className="ps-10"
                                        type="password"
                                        name="new-password"
                                        autoComplete="new-password"
                                        allowBrowserAutofill
                                        value={password}
                                        onChange={(event) => setPassword(event.target.value)}
                                        placeholder={t('workspaceAccountCreation.passwordPlaceholder')}
                                        disabled={isCreating}
                                        required
                                        minLength={8}
                                        maxLength={128}
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="workspace-account-confirm-password">
                                    {t('workspaceAccountCreation.confirmPassword')} <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                    id="workspace-account-confirm-password"
                                    type="password"
                                    name="confirm-password"
                                    autoComplete="new-password"
                                    allowBrowserAutofill
                                    value={confirmPassword}
                                    onChange={(event) => setConfirmPassword(event.target.value)}
                                    placeholder={t('workspaceAccountCreation.confirmPasswordPlaceholder')}
                                    disabled={isCreating}
                                    required
                                    maxLength={128}
                                />
                            </div>

                            {showValidationError && validationError && (
                                <p role="alert" className="text-sm text-destructive">
                                    {t(`workspaceAccountCreation.errors.${validationError}`)}
                                </p>
                            )}
                        </AppDialogBody>

                        <AppDialogFooter>
                            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isCreating}>
                                {t('common.cancel')}
                            </Button>
                            <Button type="submit" disabled={Boolean(validationError) || isCreating}>
                                {isCreating ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <UserPlus className="me-2 h-4 w-4" aria-hidden="true" />}
                                {t(isCreating ? 'workspaceAccountCreation.creating' : 'workspaceAccountCreation.create')}
                            </Button>
                        </AppDialogFooter>
                    </form>
                </AppDialogContent>
            </AppDialog>
        </>
    )
}
