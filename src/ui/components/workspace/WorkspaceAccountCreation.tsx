import {
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type FormEvent,
    type KeyboardEvent,
    type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
    AtSign,
    Building2,
    KeyRound,
    Loader2,
    UserPlus,
    Users,
} from 'lucide-react'
import { isSupabaseConfigured, supabase } from '@/auth/supabase'
import { useAuth } from '@/auth'
import {
    buildWorkspaceAccountCreationRequest,
    getWorkspaceAccountCreationErrorKey,
    validateWorkspaceAccountCreationForm,
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
    useToast,
} from '@/ui/components'
import { useWorkspace } from '@/workspace'
import { queryClient } from '@/query/queryClient'
import { queryKeys } from '@/query/queryKeys'
import {
    formatPostalOrganizationCode,
    normalizePostalOrganizationCode,
} from '@/postal/domain'

interface WorkspaceAccountCreationProps {
    accountType?: 'staff' | 'postalMerchant' | 'coach'
    onCreated?: () => void | Promise<void>
    buttonLabel?: string
    dialogTitle?: string
    dialogDescription?: string
    createButtonLabel?: string
    additionalFields?: ReactNode | ((disabled: boolean) => ReactNode)
    additionalFieldsValid?: boolean
    coach?: { agentTypeId: string }
    onReset?: () => void
}

type AccountCreationErrorResponse = {
    code?: string
}

async function readAccountCreationErrorCode(error: unknown, data: unknown) {
    if (
        data &&
        typeof data === 'object' &&
        'code' in data &&
        typeof data.code === 'string'
    ) {
        return data.code
    }

    if (error && typeof error === 'object' && 'context' in error) {
        const context = error.context
        if (context instanceof Response) {
            const body = (await context
                .clone()
                .json()
                .catch(() => null)) as AccountCreationErrorResponse | null
            return body?.code
        }
    }

    return undefined
}

export function WorkspaceAccountCreation({
    accountType = 'staff',
    onCreated,
    buttonLabel,
    dialogTitle,
    dialogDescription,
    createButtonLabel,
    additionalFields,
    additionalFieldsValid = true,
    coach,
    onReset,
}: WorkspaceAccountCreationProps) {
    const { user } = useAuth()
    const { hasFeature } = useWorkspace()
    const { t } = useTranslation()
    const { toast } = useToast()
    const [dialogOpen, setDialogOpen] = useState(false)
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [isCreating, setIsCreating] = useState(false)
    const creatingRef = useRef(false)
    const [submitAttempted, setSubmitAttempted] = useState(false)
    const merchantAccount = accountType === 'postalMerchant'
    const coachAccount = accountType === 'coach'
    const [organizationMode, setOrganizationMode] = useState<
        'join' | 'create' | ''
    >('')
    const [organizationValue, setOrganizationValue] = useState('')
    const [organizationPhone, setOrganizationPhone] = useState('')
    const organizationCodeInputRef = useRef<HTMLInputElement>(null)

    const workspaceId = user?.workspaceId ?? ''
    const canManage = Boolean(
        isSupabaseConfigured &&
            user?.role === 'admin' &&
            workspaceId &&
            (user.workspaceMode === 'cloud' ||
                user.workspaceMode === 'hybrid') &&
            (!merchantAccount || hasFeature('postal_service')) &&
            (!coachAccount || hasFeature('agents')),
    )

    const formValues = useMemo(
        () => ({ name, email, password, confirmPassword }),
        [name, email, password, confirmPassword],
    )
    const validationError = validateWorkspaceAccountCreationForm(formValues)
    const request = buildWorkspaceAccountCreationRequest(
        formValues,
        coachAccount
            ? { type: 'coach', agentTypeId: coach?.agentTypeId ?? '' }
            : merchantAccount
                ? {
                      type: 'postalMerchant',
                      organizationMode,
                      organizationValue,
                      organizationPhone,
                  }
                : { type: 'staff' },
    )
    const hasInput = Boolean(name || email || password || confirmPassword)

    if (!canManage || !user) return null

    const resetForm = () => {
        setName('')
        setEmail('')
        setPassword('')
        setConfirmPassword('')
        setSubmitAttempted(false)
        setOrganizationMode('')
        setOrganizationValue('')
        setOrganizationPhone('')
        onReset?.()
    }

    const handleOrganizationCodeChange = (
        event: ChangeEvent<HTMLInputElement>,
    ) => {
        const inputValue = event.currentTarget.value
        const cursor = event.currentTarget.selectionStart ?? inputValue.length
        const codeCharactersBeforeCursor = normalizePostalOrganizationCode(
            inputValue.slice(0, cursor),
        ).length
        const formattedCode = formatPostalOrganizationCode(inputValue)
        setOrganizationValue(formattedCode)

        const nextCursor =
            codeCharactersBeforeCursor +
            (codeCharactersBeforeCursor >= 4 ? 1 : 0)
        requestAnimationFrame(() => {
            organizationCodeInputRef.current?.setSelectionRange(
                Math.min(nextCursor, formattedCode.length),
                Math.min(nextCursor, formattedCode.length),
            )
        })
    }

    const handleOrganizationValueChange = (
        event: ChangeEvent<HTMLInputElement>,
    ) => {
        if (organizationMode === 'join') {
            handleOrganizationCodeChange(event)
            return
        }
        setOrganizationValue(event.currentTarget.value)
    }

    const handleOrganizationCodeKeyDown = (
        event: KeyboardEvent<HTMLInputElement>,
    ) => {
        const input = event.currentTarget
        const cursor = input.selectionStart ?? input.value.length
        const selectionEnd = input.selectionEnd ?? cursor
        if (cursor !== selectionEnd || input.value[4] !== '-') {
            return
        }

        const code = normalizePostalOrganizationCode(input.value)
        let nextCode: string
        let nextCursor: number
        if (event.key === 'Backspace' && cursor === 5) {
            if (code.length > 4) {
                nextCode = `${code.slice(0, 4)}${code.slice(5)}`
                nextCursor = 5
            } else {
                nextCode = code.slice(0, 3)
                nextCursor = 3
            }
        } else if (event.key === 'Delete' && cursor === 4 && code.length > 4) {
            nextCode = `${code.slice(0, 4)}${code.slice(5)}`
            nextCursor = 4
        } else {
            return
        }

        event.preventDefault()
        const formattedCode = formatPostalOrganizationCode(nextCode)
        setOrganizationValue(formattedCode)
        requestAnimationFrame(() => {
            organizationCodeInputRef.current?.setSelectionRange(
                nextCursor,
                nextCursor,
            )
        })
    }

    const handleOpenChange = (open: boolean) => {
        if (creatingRef.current) return
        if (!open) resetForm()
        setDialogOpen(open)
    }

    const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        setSubmitAttempted(true)
        if (creatingRef.current || !request || (coachAccount && !additionalFieldsValid)) return

        creatingRef.current = true
        setIsCreating(true)
        try {
            const { data, error } = await supabase.functions.invoke(
                'workspace-account-creation',
                {
                    body: request,
                },
            )

            if (error || !data?.id) {
                const code = await readAccountCreationErrorCode(error, data)
                throw new Error(code ?? 'account_creation_failed')
            }

            setDialogOpen(false)
            if (request.merchant)
                await queryClient.invalidateQueries({
                    queryKey: queryKeys.postal.all(workspaceId),
                })
            resetForm()
            toast({
                title: t('common.success'),
                description: t('workspaceAccountCreation.success'),
            })
            try {
                await onCreated?.()
            } catch (refreshError) {
                console.error(
                    '[WorkspaceAccountCreation] Account created but the module view did not refresh:',
                    refreshError,
                )
            }
        } catch (error) {
            console.error(
                '[WorkspaceAccountCreation] Account creation failed:',
                error,
            )
            const code = error instanceof Error ? error.message : undefined
            toast({
                title: t('common.error'),
                description: t(getWorkspaceAccountCreationErrorKey(code)),
                variant: 'destructive',
            })
        } finally {
            creatingRef.current = false
            setIsCreating(false)
        }
    }

    const showValidationError = Boolean(
        validationError && (submitAttempted || hasInput),
    )

    return (
        <>
            <Button
                type="button"
                size="sm"
                onClick={() => setDialogOpen(true)}
                disabled={isCreating}
            >
                <UserPlus className="me-2 h-4 w-4" aria-hidden="true" />
                {buttonLabel ?? t('workspaceAccountCreation.create')}
            </Button>
            <AppDialog open={dialogOpen} onOpenChange={handleOpenChange}>
                <AppDialogContent
                    className="max-w-xl"
                    showCloseButton={!isCreating}
                >
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <UserPlus
                                className="h-5 w-5 text-primary"
                                aria-hidden="true"
                            />
                            {dialogTitle ?? t('workspaceAccountCreation.title')}
                        </AppDialogTitle>
                        <p className="text-sm text-muted-foreground">
                            {dialogDescription ?? t('workspaceAccountCreation.description')}
                        </p>
                    </AppDialogHeader>

                    <form
                        onSubmit={handleCreate}
                        className="flex min-h-0 flex-1 flex-col"
                    >
                        <AppDialogBody className="space-y-4">
                            {typeof additionalFields === 'function'
                                ? additionalFields(isCreating)
                                : additionalFields}
                            {merchantAccount && (
                                <div className="space-y-3 rounded-xl border p-3">
                                    <Label id="postal-organization-path">
                                        {t('postal.organizationPath')} *
                                    </Label>
                                    <div
                                        className="grid gap-2 sm:grid-cols-2"
                                        role="group"
                                        aria-labelledby="postal-organization-path"
                                    >
                                        {(['join', 'create'] as const).map(
                                            (mode) => (
                                                <Button
                                                    key={mode}
                                                    type="button"
                                                    disabled={isCreating}
                                                    variant={
                                                        organizationMode ===
                                                        mode
                                                            ? 'default'
                                                            : 'outline'
                                                    }
                                                    aria-pressed={
                                                        organizationMode ===
                                                        mode
                                                    }
                                                    onClick={() => {
                                                        if (
                                                            mode !==
                                                            organizationMode
                                                        ) {
                                                            setOrganizationMode(
                                                                mode,
                                                            )
                                                            setOrganizationValue(
                                                                '',
                                                            )
                                                            setOrganizationPhone(
                                                                '',
                                                            )
                                                        }
                                                    }}
                                                >
                                                    {mode === 'join' ? (
                                                        <Users
                                                            className="me-2 h-4 w-4"
                                                            aria-hidden="true"
                                                        />
                                                    ) : (
                                                        <Building2
                                                            className="me-2 h-4 w-4"
                                                            aria-hidden="true"
                                                        />
                                                    )}
                                                    {t(
                                                        `postal.${mode}Organization`,
                                                    )}
                                                </Button>
                                            ),
                                        )}
                                    </div>
                                    {organizationMode && (
                                        <div className="space-y-2">
                                            <Label htmlFor="postal-organization">
                                                {t(
                                                    organizationMode === 'join'
                                                        ? 'postal.organizationCode'
                                                        : 'postal.organizationName',
                                                )}{' '}
                                                *
                                            </Label>
                                            <Input
                                                id="postal-organization"
                                                ref={organizationCodeInputRef}
                                                value={organizationValue}
                                                onChange={
                                                    handleOrganizationValueChange
                                                }
                                                onKeyDown={
                                                    organizationMode === 'join'
                                                        ? handleOrganizationCodeKeyDown
                                                        : undefined
                                                }
                                                disabled={isCreating}
                                                maxLength={
                                                    organizationMode === 'join'
                                                        ? 9
                                                        : 120
                                                }
                                                required
                                            />
                                        </div>
                                    )}
                                    {organizationMode === 'create' && (
                                        <div className="space-y-2">
                                            <Label htmlFor="postal-organization-phone">
                                                {t(
                                                    'postal.organizationPhoneNumber',
                                                )}{' '}
                                                *
                                            </Label>
                                            <Input
                                                id="postal-organization-phone"
                                                type="tel"
                                                autoComplete="tel"
                                                dir="ltr"
                                                value={organizationPhone}
                                                onChange={(event) =>
                                                    setOrganizationPhone(
                                                        event.target.value,
                                                    )
                                                }
                                                disabled={isCreating}
                                                maxLength={32}
                                                required
                                            />
                                        </div>
                                    )}
                                </div>
                            )}
                            <div className="grid gap-2">
                                <Label htmlFor="workspace-account-name">
                                    {t('workspaceAccountCreation.name')}{' '}
                                    <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                    id="workspace-account-name"
                                    name="name"
                                    autoComplete="name"
                                    allowBrowserAutofill
                                    value={name}
                                    onChange={(event) =>
                                        setName(event.target.value)
                                    }
                                    placeholder={t(
                                        'workspaceAccountCreation.namePlaceholder',
                                    )}
                                    disabled={isCreating}
                                    required
                                    maxLength={120}
                                />
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="workspace-account-email">
                                    {t('workspaceAccountCreation.email')}{' '}
                                    <span className="text-destructive">*</span>
                                </Label>
                                <div className="relative">
                                    <AtSign
                                        className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                                        aria-hidden="true"
                                    />
                                    <Input
                                        id="workspace-account-email"
                                        className="ps-10"
                                        type="email"
                                        name="email"
                                        autoComplete="email"
                                        allowBrowserAutofill
                                        value={email}
                                        onChange={(event) =>
                                            setEmail(event.target.value)
                                        }
                                        placeholder={t(
                                            'workspaceAccountCreation.emailPlaceholder',
                                        )}
                                        disabled={isCreating}
                                        required
                                        maxLength={254}
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="workspace-account-password">
                                    {t('workspaceAccountCreation.password')}{' '}
                                    <span className="text-destructive">*</span>
                                </Label>
                                <div className="relative">
                                    <KeyRound
                                        className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                                        aria-hidden="true"
                                    />
                                    <Input
                                        id="workspace-account-password"
                                        className="ps-10"
                                        type="password"
                                        name="new-password"
                                        autoComplete="new-password"
                                        allowBrowserAutofill
                                        value={password}
                                        onChange={(event) =>
                                            setPassword(event.target.value)
                                        }
                                        placeholder={t(
                                            'workspaceAccountCreation.passwordPlaceholder',
                                        )}
                                        disabled={isCreating}
                                        required
                                        minLength={8}
                                        maxLength={128}
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="workspace-account-confirm-password">
                                    {t(
                                        'workspaceAccountCreation.confirmPassword',
                                    )}{' '}
                                    <span className="text-destructive">*</span>
                                </Label>
                                <Input
                                    id="workspace-account-confirm-password"
                                    type="password"
                                    name="confirm-password"
                                    autoComplete="new-password"
                                    allowBrowserAutofill
                                    value={confirmPassword}
                                    onChange={(event) =>
                                        setConfirmPassword(event.target.value)
                                    }
                                    placeholder={t(
                                        'workspaceAccountCreation.confirmPasswordPlaceholder',
                                    )}
                                    disabled={isCreating}
                                    required
                                    maxLength={128}
                                />
                            </div>

                            {showValidationError && validationError && (
                                <p
                                    role="alert"
                                    className="text-sm text-destructive"
                                >
                                    {t(
                                        `workspaceAccountCreation.errors.${validationError}`,
                                    )}
                                </p>
                            )}
                        </AppDialogBody>

                        <AppDialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => handleOpenChange(false)}
                                disabled={isCreating}
                            >
                                {t('common.cancel')}
                            </Button>
                            <Button
                                type="submit"
                                disabled={!request || (coachAccount && !additionalFieldsValid) || isCreating}
                            >
                                {isCreating ? (
                                    <Loader2
                                        className="me-2 h-4 w-4 animate-spin"
                                        aria-hidden="true"
                                    />
                                ) : (
                                    <UserPlus
                                        className="me-2 h-4 w-4"
                                        aria-hidden="true"
                                    />
                                )}
                                {isCreating
                                    ? t('workspaceAccountCreation.creating')
                                    : createButtonLabel ?? t('workspaceAccountCreation.create')}
                            </Button>
                        </AppDialogFooter>
                    </form>
                </AppDialogContent>
            </AppDialog>
        </>
    )
}
