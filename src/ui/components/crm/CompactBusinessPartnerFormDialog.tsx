import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import type { BusinessPartnerRole, CurrencyCode } from '@/local-db'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Label,
} from '@/ui/components'
import {
    BusinessPartnerDuplicateStatusDescription,
    BusinessPartnerDuplicateStatusIcon
} from './BusinessPartnerDuplicateStatusIcon'
import {
    shouldInterruptDuplicateSave,
    useBusinessPartnerDuplicateDetection,
    type BusinessPartnerDuplicateField
} from './useBusinessPartnerDuplicateDetection'

type CompactBusinessPartnerFormState = {
    partnerName: string
    phone: string
    address: string
    defaultCurrency: CurrencyCode
}

function createEmptyState(defaultCurrency: CurrencyCode): CompactBusinessPartnerFormState {
    return {
        partnerName: '',
        phone: '',
        address: '',
        defaultCurrency
    }
}

export interface CompactBusinessPartnerFormPayload {
    partnerName: string
    phone: string
    address: string
    /** Kept at zero because the compact flow does not collect credit limits. */
    creditLimit: number
    /** Supplied by the caller; intentionally not selectable in this dialog. */
    defaultCurrency: CurrencyCode
    /** Supplied by the caller; intentionally not selectable in this dialog. */
    role: BusinessPartnerRole
}

interface CompactBusinessPartnerFormDialogProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    /**
     * The integration must select the partner role. Keeping this required
     * prevents a compact form from creating an ambiguously typed partner.
     */
    role: BusinessPartnerRole
    /** The workspace/default currency to persist for the new partner. */
    defaultCurrency: CurrencyCode
    /** Used to compare the new partner with partners in this workspace. */
    workspaceId?: string
    title?: string
    submitLabel?: string
    isSaving?: boolean
    onSubmit: (payload: CompactBusinessPartnerFormPayload) => void | Promise<void>
}

/**
 * Create-only partner form for integrations that already know the role and
 * default currency. It deliberately exposes only the minimum customer-facing
 * fields while returning the required computed values with the submission.
 */
export function CompactBusinessPartnerFormDialog({
    isOpen,
    onOpenChange,
    role,
    defaultCurrency,
    workspaceId,
    title,
    submitLabel,
    isSaving = false,
    onSubmit
}: CompactBusinessPartnerFormDialogProps) {
    const { t } = useTranslation()
    const [formState, setFormState] = useState<CompactBusinessPartnerFormState>(() => createEmptyState(defaultCurrency))
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [duplicateWarningField, setDuplicateWarningField] = useState<BusinessPartnerDuplicateField | null>(null)
    const acknowledgedDuplicateStateRef = useRef<string | null>(null)
    const nameInputRef = useRef<HTMLInputElement>(null)
    const phoneInputRef = useRef<HTMLInputElement>(null)
    const isProcessing = isSaving || isSubmitting
    const { statuses: duplicateStatuses, firstDuplicateField, duplicateStateKey, checkNow } = useBusinessPartnerDuplicateDetection({
        isOpen,
        workspaceId,
        name: formState.partnerName,
        phone: formState.phone
    })

    useEffect(() => {
        if (isOpen) {
            setFormState(createEmptyState(defaultCurrency))
        }
    }, [defaultCurrency, isOpen])

    useEffect(() => {
        acknowledgedDuplicateStateRef.current = null
        setDuplicateWarningField(null)
    }, [formState.partnerName, formState.phone, isOpen])

    const canSubmit = Boolean(
        formState.partnerName.trim()
        && formState.phone.trim()
        && formState.address.trim()
    )

    const handleOpenChange = (open: boolean) => {
        if (!isProcessing) {
            onOpenChange(open)
        }
    }

    const showDuplicateWarning = (field: BusinessPartnerDuplicateField) => {
        acknowledgedDuplicateStateRef.current = duplicateStateKey
        setDuplicateWarningField(field)
        window.requestAnimationFrame(() => {
            const input = field === 'name' ? nameInputRef.current : phoneInputRef.current
            input?.focus()
            input?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
    }

    const updateDuplicateCheckedValue = (field: 'partnerName' | 'phone', value: string) => {
        acknowledgedDuplicateStateRef.current = null
        setDuplicateWarningField(null)
        setFormState((current) => ({ ...current, [field]: value }))
    }

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        // Dialogs rendered from a page form still bubble through React's tree.
        // Keep this compact partner submission from invoking the host workflow.
        event.stopPropagation()
        if (!canSubmit || isProcessing) {
            return
        }
        if (shouldInterruptDuplicateSave(firstDuplicateField, acknowledgedDuplicateStateRef.current, duplicateStateKey)) {
            checkNow()
            showDuplicateWarning(firstDuplicateField)
            return
        }

        setIsSubmitting(true)
        try {
            await onSubmit({
                partnerName: formState.partnerName.trim(),
                phone: formState.phone.trim(),
                address: formState.address.trim(),
                creditLimit: 0,
                defaultCurrency: formState.defaultCurrency,
                role
            })
        } finally {
            setIsSubmitting(false)
        }
    }

    return (
        <AppDialog open={isOpen} onOpenChange={handleOpenChange}>
            <AppDialogContent
                className="max-w-lg"
                showCloseButton={!isProcessing}
                onPointerDownOutside={(event) => {
                    if (isProcessing) event.preventDefault()
                }}
                onEscapeKeyDown={(event) => {
                    if (isProcessing) event.preventDefault()
                }}
            >
                <AppDialogHeader>
                    <AppDialogTitle>
                        {title || t('businessPartners.addPartner')}
                    </AppDialogTitle>
                </AppDialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <AppDialogBody className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="compact-business-partner-name">
                                {t('businessPartners.form.partnerName')} <span className="text-destructive">*</span>
                            </Label>
                            <div className="relative">
                                <Input
                                    ref={nameInputRef}
                                    id="compact-business-partner-name"
                                    name="partnerName"
                                    value={formState.partnerName}
                                    onChange={(event) => updateDuplicateCheckedValue('partnerName', event.target.value)}
                                    className={duplicateWarningField === 'name'
                                        ? 'pe-11 border-amber-500 ring-2 ring-amber-500/20'
                                        : 'pe-11'}
                                    required
                                />
                                <BusinessPartnerDuplicateStatusIcon field="name" status={duplicateStatuses.name} />
                            </div>
                            <BusinessPartnerDuplicateStatusDescription field="name" status={duplicateStatuses.name} />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="compact-business-partner-phone">
                                {t('customers.form.phone')} <span className="text-destructive">*</span>
                            </Label>
                            <div className="relative">
                                <Input
                                    ref={phoneInputRef}
                                    id="compact-business-partner-phone"
                                    name="phone"
                                    value={formState.phone}
                                    onChange={(event) => updateDuplicateCheckedValue('phone', event.target.value)}
                                    className={duplicateWarningField === 'phone'
                                        ? 'pe-11 border-amber-500 ring-2 ring-amber-500/20'
                                        : 'pe-11'}
                                    required
                                />
                                <BusinessPartnerDuplicateStatusIcon field="phone" status={duplicateStatuses.phone} />
                            </div>
                            <BusinessPartnerDuplicateStatusDescription field="phone" status={duplicateStatuses.phone} />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="compact-business-partner-address">
                                {t('customers.form.address')} <span className="text-destructive">*</span>
                            </Label>
                            <Input
                                id="compact-business-partner-address"
                                name="address"
                                value={formState.address}
                                onChange={(event) => setFormState((current) => ({
                                    ...current,
                                    address: event.target.value
                                }))}
                                required
                            />
                        </div>
                    </AppDialogBody>

                    <AppDialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => handleOpenChange(false)}
                            disabled={isProcessing}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button type="submit" disabled={!canSubmit || isProcessing}>
                            {isProcessing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            {isProcessing ? t('common.saving') : (submitLabel || t('common.create'))}
                        </Button>
                    </AppDialogFooter>
                </form>
            </AppDialogContent>
        </AppDialog>
    )
}
