import { useEffect, useMemo, useState } from 'react'
import { Minus, PackageSearch, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn, formatCurrency } from '@/lib/utils'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/ui/components'

export interface EditableMarketplaceOrderItem {
    product_id: string
    name: string
    sku: string
    unit_price: number
    currency: string
    unit?: string | null
    quantity: number
    line_total: number
    image_url?: string | null
    storage_id?: string | null
    allocation_group_id?: string | null
}

export interface EditableMarketplaceOrder {
    id: string
    currency: string
    items: EditableMarketplaceOrderItem[]
}

interface EditMarketplaceOrderItemsDialogProps {
    isOpen: boolean
    order: EditableMarketplaceOrder
    isSaving?: boolean
    onOpenChange: (open: boolean) => void
    onSave: (items: EditableMarketplaceOrderItem[]) => Promise<void>
}

type DraftGroup = {
    key: string
    name: string
    sku: string
    imageUrl?: string | null
    currency: string
    lines: EditableMarketplaceOrderItem[]
    quantity: number
    lineTotal: number
}

function lineKey(line: EditableMarketplaceOrderItem) {
    return `${line.product_id}::${line.storage_id || ''}::${line.allocation_group_id || ''}`
}

function buildDraftGroups(lines: EditableMarketplaceOrderItem[]): DraftGroup[] {
    const groups = new Map<string, DraftGroup>()

    for (const [index, line] of lines.entries()) {
        const key = line.allocation_group_id
            ? `allocation:${line.allocation_group_id}`
            : `line:${index}`
        const existing = groups.get(key)

        if (!existing) {
            groups.set(key, {
                key,
                name: line.name,
                sku: line.sku,
                imageUrl: line.image_url,
                currency: line.currency,
                lines: [{ ...line }],
                quantity: Math.trunc(Number(line.quantity ?? 0)),
                lineTotal: roundLineTotal(line.unit_price, line.quantity)
            })
            continue
        }

        existing.lines.push({ ...line })
        existing.quantity += Math.trunc(Number(line.quantity ?? 0))
        existing.lineTotal = roundAmount(existing.lineTotal + roundLineTotal(line.unit_price, line.quantity))
    }

    return Array.from(groups.values())
}

function roundAmount(value: number) {
    return Math.round(value * 100) / 100
}

function roundLineTotal(unitPrice: number | undefined, quantity: number | undefined) {
    return roundAmount(Number(unitPrice || 0) * Math.trunc(Number(quantity || 0)))
}

function distributeReduction(lines: EditableMarketplaceOrderItem[], targetQuantity: number) {
    const updated = lines.map((line) => ({ ...line }))
    let toRemove = updated.reduce((sum, line) => sum + Math.trunc(Number(line.quantity || 0)), 0) - targetQuantity

    while (toRemove > 0) {
        let maxIndex = -1
        for (let index = 0; index < updated.length; index++) {
            if (updated[index].quantity <= 0) continue
            if (maxIndex === -1 || updated[index].quantity > updated[maxIndex].quantity) {
                maxIndex = index
            }
        }
        if (maxIndex === -1) break
        updated[maxIndex].quantity = Math.max(0, updated[maxIndex].quantity - 1)
        toRemove -= 1
    }

    return updated
}

export function EditMarketplaceOrderItemsDialog({
    isOpen,
    order,
    isSaving = false,
    onOpenChange,
    onSave
}: EditMarketplaceOrderItemsDialogProps) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const [draftLines, setDraftLines] = useState<EditableMarketplaceOrderItem[]>([])

    useEffect(() => {
        if (!isOpen) return
        setDraftLines(order.items.map((line) => ({ ...line })))
    }, [isOpen, order])

    const groups = useMemo(() => buildDraftGroups(draftLines), [draftLines])
    const subtotal = useMemo(
        () => groups.reduce((sum, group) => sum + group.lineTotal, 0),
        [groups]
    )
    const isDirty = useMemo(() => {
        const expectedQuantities = new Map<string, number>()
        for (const line of order.items) {
            const key = lineKey(line)
            expectedQuantities.set(key, (expectedQuantities.get(key) || 0) + Math.trunc(Number(line.quantity || 0)))
        }
        for (const line of draftLines) {
            const key = lineKey(line)
            expectedQuantities.set(key, (expectedQuantities.get(key) || 0) - Math.trunc(Number(line.quantity || 0)))
        }
        return Array.from(expectedQuantities.values()).some((quantity) => quantity !== 0)
    }, [order.items, draftLines])

    function removeGroup(groupKey: string) {
        setDraftLines((current) => {
            const group = buildDraftGroups(current).find((entry) => entry.key === groupKey)
            if (!group) return current
            const removedKeys = new Set(group.lines.map((line) => lineKey(line)))
            return current.filter((line) => !removedKeys.has(lineKey(line)))
        })
    }

    function decreaseGroup(groupKey: string) {
        setDraftLines((current) => {
            const group = buildDraftGroups(current).find((entry) => entry.key === groupKey)
            if (!group) return current
            const nextQuantity = group.quantity - 1

            if (nextQuantity <= 0) {
                const removedKeys = new Set(group.lines.map((line) => lineKey(line)))
                return current.filter((line) => !removedKeys.has(lineKey(line)))
            }

            const updated = distributeReduction(group.lines, nextQuantity)
            const updatedLines = new Map(updated.map((line) => [lineKey(line), line]))
            const groupKeys = new Set(group.lines.map((line) => lineKey(line)))
            return current
                .filter((line) => {
                    const key = lineKey(line)
                    return !groupKeys.has(key) || (updatedLines.get(key)?.quantity ?? 0) > 0
                })
                .map((line) => updatedLines.get(lineKey(line)) || line)
        })
    }

    async function handleSave() {
        const items = groups.flatMap((group) => group.lines).map((line) => ({
            ...line,
            line_total: roundLineTotal(line.unit_price, line.quantity)
        }))
        try {
            await onSave(items)
            onOpenChange(false)
        } catch {
            // The caller surfaces the error toast and keeps the dialog open.
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent layout="structured" className="sm:max-w-xl">
                <DialogHeader layout="structured">
                    <DialogTitle>{t('ecommerce.editItems', { defaultValue: 'Edit Order Items' })}</DialogTitle>
                    <DialogDescription>
                        {t('ecommerce.editItemsHint', {
                            defaultValue: 'Quantities can only be reduced or items removed before the order is delivered.'
                        })}
                    </DialogDescription>
                </DialogHeader>

                <DialogBody className="space-y-3">
                    {groups.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border/60 bg-card/50 p-8 text-center text-muted-foreground">
                            <PackageSearch className="h-8 w-8 opacity-50" />
                            <p className="text-sm">
                                {t('ecommerce.editItemsEmpty', {
                                    defaultValue: 'All items were removed. An order must keep at least one item.'
                                })}
                            </p>
                        </div>
                    ) : groups.map((group) => (
                        <div key={group.key} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/60 p-3">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40">
                                {group.imageUrl ? (
                                    <img
                                        src={group.imageUrl}
                                        alt=""
                                        className="h-full w-full object-contain p-1"
                                        loading="lazy"
                                    />
                                ) : (
                                    <PackageSearch className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                                )}
                            </div>

                            <div className="min-w-0 flex-1">
                                <div className="truncate font-semibold">{group.name}</div>
                                <div className="truncate text-sm text-muted-foreground">{group.sku}</div>
                                <div className="text-sm font-semibold">
                                    {formatCurrency(group.lineTotal, group.currency || order.currency, features.iqd_display_preference)}
                                </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className={cn('h-9 w-9 rounded-xl', group.quantity <= 1 && 'pointer-events-none opacity-40')}
                                    disabled={isSaving || group.quantity <= 1}
                                    onClick={() => decreaseGroup(group.key)}
                                    aria-label={`${t('common.decrease', { defaultValue: 'Decrease' })} ${group.name}`}
                                >
                                    <Minus className="h-4 w-4" />
                                </Button>
                                <span className="min-w-10 text-center font-black">{group.quantity}</span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className="h-9 w-9 rounded-xl border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-300"
                                    disabled={isSaving}
                                    onClick={() => removeGroup(group.key)}
                                    aria-label={`${t('common.remove', { defaultValue: 'Remove' })} ${group.name}`}
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    ))}
                </DialogBody>

                <DialogFooter layout="structured">
                    <span className="text-sm text-muted-foreground">
                        {t('common.total', { defaultValue: 'Total' })}:{' '}
                        <span className="font-black text-foreground">
                            {formatCurrency(subtotal, order.currency, features.iqd_display_preference)}
                        </span>
                    </span>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row">
                        <Button variant="outline" disabled={isSaving} onClick={() => onOpenChange(false)}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button disabled={isSaving || groups.length === 0 || !isDirty} onClick={handleSave}>
                            {t('common.save', { defaultValue: 'Save' })}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
