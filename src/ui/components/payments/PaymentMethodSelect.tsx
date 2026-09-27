import { useMemo, type PointerEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Banknote, CalendarClock, CircleHelp, CreditCard, HandCoins, Landmark, SlidersHorizontal } from 'lucide-react'

import { useAuth } from '@/auth'
import { DIGITAL_WALLET_PAYMENT_METHODS, usePaymentAccounts, type PaymentAccount } from '@/local-db'

import {
    STANDARD_PAYMENT_METHODS,
    getPaymentMethodLabel,
    type PaymentMethodOption
} from '@/lib/paymentMethods'

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/ui/components/select'
import { PaymentAccountIcon } from './PaymentAccountIcon'

interface SharedPaymentMethodSelectProps {
    value: PaymentMethodOption
    methods?: readonly PaymentMethodOption[]
    /** Methods that remain visible but cannot be selected in the current workflow. */
    disabledMethods?: readonly PaymentMethodOption[]
    id?: string
    disabled?: boolean
    placeholder?: string
    triggerClassName?: string
    onOptionPointerDown?: (event: PointerEvent<HTMLDivElement>, method: PaymentMethodOption) => void
    renderOptionEnd?: (method: PaymentMethodOption) => ReactNode
    /** Lets branded method rows show their linked Digital Wallet. */
    workspaceId?: string
    /** Called only for a branded method that has an active linked wallet. */
    onLinkedPaymentAccountSelect?: (account: PaymentAccount) => void
}

interface StandardPaymentMethodSelectProps extends SharedPaymentMethodSelectProps {
    value: PaymentMethodOption
    onValueChange: (value: PaymentMethodOption) => void
    allowNone?: false
    noneLabel?: never
}

interface NullablePaymentMethodSelectProps extends Omit<SharedPaymentMethodSelectProps, 'value'> {
    value: PaymentMethodOption | null
    onValueChange: (value: PaymentMethodOption | null) => void
    allowNone: true
    noneLabel: string
}

type PaymentMethodSelectProps = StandardPaymentMethodSelectProps | NullablePaymentMethodSelectProps

function PaymentMethodVisual({ method }: { method: PaymentMethodOption }) {
    const brandLogos: Partial<Record<PaymentMethodOption, string>> = {
        fib: '/icons/payment-methods/fib.svg',
        qicard: '/icons/payment-methods/qicard.svg',
        zaincash: '/icons/payment-methods/zaincash.svg',
        fastpay: '/icons/payment-methods/fastpay.svg'
    }
    const brandLogo = brandLogos[method]

    if (brandLogo) {
        return (
            <span className="flex h-5 w-5 shrink-0 items-center">
                <img src={brandLogo} alt="" aria-hidden="true" className="h-5 w-full object-contain object-left" />
            </span>
        )
    }

    const Icon = method === 'cash'
        ? Banknote
        : method === 'bank_transfer'
            ? Landmark
            : method === 'loan'
                ? HandCoins
                : method === 'installments'
                    ? CalendarClock
                    : method === 'loan_adjustment'
                        ? SlidersHorizontal
                        : method === 'credit'
                            ? CreditCard
                            : CircleHelp

    return (
        <span className="flex h-5 w-5 shrink-0 items-center">
            <Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        </span>
    )
}

export function PaymentMethodSelect({
    value,
    onValueChange,
    methods = STANDARD_PAYMENT_METHODS,
    disabledMethods = [],
    id,
    disabled = false,
    placeholder,
    triggerClassName,
    onOptionPointerDown,
    renderOptionEnd,
    workspaceId,
    onLinkedPaymentAccountSelect,
    allowNone = false,
    noneLabel,
}: PaymentMethodSelectProps) {
    const { t } = useTranslation()
    const { user } = useAuth()
    const accounts = usePaymentAccounts(workspaceId, user?.id)
    const linkedWalletByMethod = useMemo(
        () => new Map(
            accounts
                .filter((account) => account.isActive && account.accountType === 'digital_wallet' && !!account.linkedPaymentMethod)
                .map((account) => [account.linkedPaymentMethod!, account]),
        ),
        [accounts],
    )

    const handleValueChange = (nextValue: string) => {
        if (allowNone && nextValue === '__none__') {
            const onNullableValueChange = onValueChange as NullablePaymentMethodSelectProps['onValueChange']
            onNullableValueChange(null)
            return
        }
        const method = nextValue as PaymentMethodOption
        const onMethodValueChange = onValueChange as StandardPaymentMethodSelectProps['onValueChange']
        onMethodValueChange(method)

        if (!DIGITAL_WALLET_PAYMENT_METHODS.includes(method as typeof DIGITAL_WALLET_PAYMENT_METHODS[number])) return
        const linkedWallet = linkedWalletByMethod.get(method as typeof DIGITAL_WALLET_PAYMENT_METHODS[number])
        if (linkedWallet) onLinkedPaymentAccountSelect?.(linkedWallet)
    }

    const linkedWalletForMethod = (method: PaymentMethodOption) => (
        DIGITAL_WALLET_PAYMENT_METHODS.includes(method as typeof DIGITAL_WALLET_PAYMENT_METHODS[number])
            ? linkedWalletByMethod.get(method as typeof DIGITAL_WALLET_PAYMENT_METHODS[number])
            : null
    )

    return (
        <Select
            value={value ?? '__none__'}
            onValueChange={handleValueChange}
            disabled={disabled}
        >
            <SelectTrigger id={id} className={triggerClassName}>
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                {allowNone ? <SelectItem value="__none__">{noneLabel}</SelectItem> : null}
                {methods.map((method) => {
                    const linkedWallet = linkedWalletForMethod(method)

                    return (
                        <SelectItem
                            key={method}
                            value={method}
                            disabled={disabledMethods.includes(method)}
                            onPointerDown={(event) => onOptionPointerDown?.(event, method)}
                        >
                            <span className="flex min-w-0 items-center gap-1.5">
                                <PaymentMethodVisual method={method} />
                                <span>{getPaymentMethodLabel(method, t)}</span>
                                {linkedWallet ? (
                                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                                        <span aria-hidden="true">—</span>
                                        <PaymentAccountIcon iconKey={linkedWallet.iconKey} accountType={linkedWallet.accountType} className="h-3.5 w-3.5 shrink-0" />
                                        <span className="truncate">{linkedWallet.name}</span>
                                    </span>
                                ) : null}
                                {renderOptionEnd?.(method)}
                            </span>
                        </SelectItem>
                    )
                })}
            </SelectContent>
        </Select>
    )
}
