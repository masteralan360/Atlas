import { useTranslation } from 'react-i18next'
import { Warehouse } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/ui/components/select'
import type { Storage } from '@/local-db'

export type StorageSelectorOption = Pick<Storage, 'id' | 'name' | 'isSystem'> & {
    /** A POS-only destination such as the Activities catalog. */
    isVirtual?: boolean
}

interface StorageSelectorProps {
    storages: StorageSelectorOption[]
    selectedStorageId: string
    onSelect: (storageId: string) => void
    className?: string
}

export function StorageSelector({ storages, selectedStorageId, onSelect, className }: StorageSelectorProps) {

    const { t } = useTranslation()

    return (
        <Select value={selectedStorageId} onValueChange={onSelect}>
            <SelectTrigger data-testid="pos-storage-selector" className={cn("w-[180px] bg-background/50 backdrop-blur-sm", className)}>
                <div className="flex items-center gap-2 truncate">
                    <Warehouse className="w-4 h-4 text-muted-foreground shrink-0" />
                    <SelectValue placeholder={t('storages.selectStorage') || "Select Storage"} />
                </div>
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    <SelectLabel>{t('storages.label') || "Storages"}</SelectLabel>
                    {storages.map((storage) => (
                        <SelectItem key={storage.id} value={storage.id} data-storage-id={storage.id}>
                            <span className="flex items-center gap-2">
                                {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                {storage.isSystem && (
                                    <span className="text-[10px] text-muted-foreground ml-1">({t('storages.system') || 'System'})</span>
                                )}
                            </span>
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    )
}
