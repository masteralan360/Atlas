import { useState } from 'react'
import { Plus, Trash2, Phone, Star, StarOff, Mail, MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/ui/components/input'
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components'
import { useWorkspaceContacts, createWorkspaceContact, updateWorkspaceContact, deleteWorkspaceContact } from '@/local-db/hooks'
import type { WorkspaceContact } from '@/local-db/models'

interface WorkspaceContactsManagerProps {
    workspaceId: string
}

export function WorkspaceContactsManager({ workspaceId }: WorkspaceContactsManagerProps) {
    const { t } = useTranslation()
    const contacts = useWorkspaceContacts(workspaceId)

    const [newValue, setNewValue] = useState('')
    const [newType, setNewType] = useState<'phone' | 'email' | 'address'>('phone')
    const [newLabel, setNewLabel] = useState('')
    const [isAdding, setIsAdding] = useState(false)

    const handleAdd = async () => {
        if (!newValue) return

        try {
            const primaryOfTypeExists = contacts.some(c => c.type === newType && c.isPrimary)
            await createWorkspaceContact(workspaceId, {
                type: newType,
                value: newValue,
                label: newLabel || undefined,
                isPrimary: !primaryOfTypeExists
            })
            setNewValue('')
            setNewLabel('')
            setNewType('phone')
            setIsAdding(false)
        } catch (error) {
            console.error('Failed to add contact:', error)
        }
    }

    const handleTogglePrimary = async (contact: WorkspaceContact) => {
        if (contact.isPrimary) return

        try {
            // Unset current primary of same type
            const currentPrimary = contacts.find(p => p.type === contact.type && p.isPrimary)
            if (currentPrimary) {
                await updateWorkspaceContact(currentPrimary.id, { isPrimary: false })
            }
            // Set new primary
            await updateWorkspaceContact(contact.id, { isPrimary: true })
        } catch (error) {
            console.error('Failed to update primary contact:', error)
        }
    }

    const handleDelete = async (id: string) => {
        try {
            await deleteWorkspaceContact(id)
        } catch (error) {
            console.error('Failed to delete contact:', error)
        }
    }

    const getIcon = (type: string) => {
        if (type === 'email') return <Mail className="w-4 h-4" />
        if (type === 'address') return <MapPin className="w-4 h-4" />
        return <Phone className="w-4 h-4" />
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <Label className="text-base font-semibold flex items-center gap-2">
                    <Phone className="w-4 h-4 text-primary" />
                    {t('workspaceConfig.contacts.title', 'Workspace Contacts')}
                </Label>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsAdding(!isAdding)}
                    className="h-8 gap-1 text-xs"
                >
                    <Plus className="w-3 h-3" />
                    {isAdding ? t('common.cancel') : t('common.add')}
                </Button>
            </div>

            {isAdding && (
                <div className="p-3 border rounded-lg bg-muted/30 space-y-3 animate-in fade-in slide-in-from-top-1">
                    <div className="grid grid-cols-6 gap-2">
                        <div className="col-span-2 space-y-1">
                            <Label className="text-[10px] uppercase text-muted-foreground">{t('workspaceConfig.contacts.typeLabel', 'Type')}</Label>
                            <Select value={newType} onValueChange={(val: any) => setNewType(val)}>
                                <SelectTrigger className="h-9">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="phone">{t('workspaceConfig.contacts.types.phone', 'Phone')}</SelectItem>
                                    <SelectItem value="email">{t('workspaceConfig.contacts.types.email', 'Email')}</SelectItem>
                                    <SelectItem value="address">{t('workspaceConfig.contacts.types.address', 'Address')}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="col-span-4 space-y-1">
                            <Label className="text-[10px] uppercase text-muted-foreground">{t('workspaceConfig.contacts.valueLabel', 'Contact Value')}</Label>
                            <Input
                                placeholder={newType === 'email' ? 'contact@example.com' : newType === 'address' ? '123 Main St' : '+1 234 567 890'}
                                value={newValue}
                                onChange={(e) => setNewValue(e.target.value)}
                                className="h-9"
                            />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase text-muted-foreground">{t('workspaceConfig.contacts.tagLabel', 'Label (Optional)')}</Label>
                        <Input
                            placeholder={t('workspaceConfig.contacts.tagPlaceholder', 'Sales, Support, etc.')}
                            value={newLabel}
                            onChange={(e) => setNewLabel(e.target.value)}
                            className="h-9"
                        />
                    </div>
                    <Button onClick={handleAdd} className="w-full h-9" disabled={!newValue}>
                        {t('common.save')}
                    </Button>
                </div>
            )}

            <div className="space-y-2">
                {contacts.length === 0 && !isAdding && (
                    <p className="text-sm text-muted-foreground italic text-center py-2">
                        {t('workspaceConfig.contacts.noContacts', 'No contacts added yet.')}
                    </p>
                )}
                {contacts.map((c) => (
                    <div
                        key={c.id}
                        className={`group flex items-center justify-between p-3 rounded-xl border-2 transition-all ${c.isPrimary ? 'border-primary/30 bg-primary/5' : 'border-border bg-card'}`}
                    >
                        <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${c.isPrimary ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                                {getIcon(c.type)}
                            </div>
                            <div>
                                <div className="font-medium flex items-center gap-2 text-sm">
                                    {c.value}
                                    {c.isPrimary && (
                                        <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full font-bold">
                                            {t(`workspaceConfig.contacts.primary_${c.type}`, `PRIMARY ${c.type.toUpperCase()}`)}
                                        </span>
                                    )}
                                </div>
                                {c.label && <div className="text-xs text-muted-foreground">{c.label}</div>}
                            </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-primary"
                                onClick={() => handleTogglePrimary(c)}
                                title={t('workspaceConfig.contacts.setPrimary', 'Set Primary')}
                            >
                                {c.isPrimary ? <Star className="w-4 h-4 fill-primary text-primary" /> : <StarOff className="w-4 h-4" />}
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => handleDelete(c.id)}
                                title={t('common.delete')}
                            >
                                <Trash2 className="w-4 h-4" />
                            </Button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
