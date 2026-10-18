import { useState, useEffect } from 'react'
import { Input } from '@/ui/components/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components'
import { Plus, Trash2, CheckCircle2, AlertCircle, Phone, Mail, MapPin, Contact } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface AdminContact {
    type: 'phone' | 'email' | 'address'
    value: string
    label?: string
    isPrimary: boolean
}

interface RegisterWorkspaceContactsModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    contacts: AdminContact[]
    onContactsChange: (contacts: AdminContact[]) => void
}

export function RegisterWorkspaceContactsModal({
    open,
    onOpenChange,
    contacts,
    onContactsChange
}: RegisterWorkspaceContactsModalProps) {
    const { t } = useTranslation()
    const [localContacts, setLocalContacts] = useState<AdminContact[]>(contacts)

    useEffect(() => {
        if (open) {
            setLocalContacts(contacts.length > 0 ? [...contacts] : [{ type: 'phone', value: '', label: '', isPrimary: true }])
        }
    }, [open, contacts])

    const handleAdd = () => {
        const noPhoneExists = !localContacts.some(c => c.type === 'phone' && c.isPrimary)
        setLocalContacts([...localContacts, { type: 'phone', value: '', label: '', isPrimary: noPhoneExists }])
    }

    const handleUpdate = (index: number, field: keyof AdminContact, value: string | boolean) => {
        const newContacts = [...localContacts]
        newContacts[index] = { ...newContacts[index], [field]: value }

        if (field === 'type') {
            const hasPrimaryOfNewType = newContacts.some((c, i) => i !== index && c.type === value && c.isPrimary)
            if (hasPrimaryOfNewType) {
                newContacts[index].isPrimary = false
            } else {
                newContacts[index].isPrimary = true
            }
        }

        // If turning on primary, turn off others of SAME TYPE
        if (field === 'isPrimary' && value === true) {
            const currentType = newContacts[index].type
            for (let i = 0; i < newContacts.length; i++) {
                if (i !== index && newContacts[i].type === currentType) {
                    newContacts[i].isPrimary = false
                }
            }
        }

        setLocalContacts(newContacts)
    }

    const handleRemove = (index: number) => {
        const removedType = localContacts[index].type
        const newContacts = localContacts.filter((_, i) => i !== index)
        const hasPrimaryOfRemovedType = newContacts.some(p => p.type === removedType && p.isPrimary)
        if (!hasPrimaryOfRemovedType) {
            const firstOfRemovedType = newContacts.find(p => p.type === removedType)
            if (firstOfRemovedType) firstOfRemovedType.isPrimary = true
        }
        setLocalContacts(newContacts)
    }

    const handleSave = () => {
        const validContacts = localContacts.filter(p => p.value.trim() !== '')
        onContactsChange(validContacts)
        onOpenChange(false)
    }

    const getIcon = (type: string) => {
        if (type === 'email') return <Mail className="w-4 h-4" />
        if (type === 'address') return <MapPin className="w-4 h-4" />
        return <Phone className="w-4 h-4" />
    }

    const sortedContacts = [...localContacts].sort((a, b) => {
        if (a.isPrimary && !b.isPrimary) return -1
        if (!a.isPrimary && b.isPrimary) return 1
        return 0
    })

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                        <Contact className="w-6 h-6 text-primary" />
                    </div>
                    <DialogTitle className="text-center text-xl">{t('workspaceConfig.contacts.addContacts', "Add Workspace Contacts")}</DialogTitle>
                    <DialogDescription className="text-center">
                        {t('workspaceConfig.contacts.addContactsDesc', "Add contact details for your workspace. The primary contact will be used for main communications.")}
                    </DialogDescription>
                </DialogHeader>

                <div className="py-4 space-y-4 max-h-[60vh] overflow-y-auto px-1">
                    {sortedContacts.map((contactItem) => {
                        const index = localContacts.indexOf(contactItem)
                        return (
                            <div key={index} className="flex flex-col gap-2 p-3 border rounded-xl bg-card relative group transition-all focus-within:ring-2 focus-within:ring-primary/20 hover:border-primary/30">
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                                        {getIcon(contactItem.type)}
                                        {t('workspaceConfig.contacts.contact', "Contact")} {index + 1}
                                        {contactItem.isPrimary && (
                                            <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full inline-flex items-center gap-1">
                                                <CheckCircle2 className="w-3 h-3" />
                                                {t(`workspaceConfig.contacts.primary_${contactItem.type}`, `PRIMARY ${contactItem.type.toUpperCase()}`)}
                                            </span>
                                        )}
                                    </span>

                                    {localContacts.length > 1 && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 text-muted-foreground hover:bg-destructive/10 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all rounded-full"
                                            onClick={() => handleRemove(index)}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                                    <div className="sm:col-span-2 space-y-1.5">
                                        <Label className="text-[10px]">{t('workspaceConfig.contacts.typeLabel', 'Type')}</Label>
                                        <Select value={contactItem.type} onValueChange={(val: any) => handleUpdate(index, 'type', val)}>
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
                                    <div className="sm:col-span-4 space-y-1.5">
                                        <Label className="text-[10px]">{t('workspaceConfig.contacts.valueLabel', 'Contact Value')}</Label>
                                        <Input
                                            placeholder={contactItem.type === 'email' ? 'contact@example.com' : contactItem.type === 'address' ? '123 Main St' : '+1 234 567 890'}
                                            value={contactItem.value}
                                            onChange={(e) => handleUpdate(index, 'value', e.target.value)}
                                            className="h-9 transition-colors focus-visible:ring-1"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-1.5">
                                    <Label className="text-[10px]">{t('workspaceConfig.contacts.tagLabel', 'Label (Optional)')}</Label>
                                    <Input
                                        placeholder={t('workspaceConfig.contacts.tagPlaceholder', 'Sales, Support, etc.')}
                                        value={contactItem.label || ''}
                                        onChange={(e) => handleUpdate(index, 'label', e.target.value)}
                                        className="h-9 transition-colors focus-visible:ring-1"
                                    />
                                </div>

                                {!contactItem.isPrimary && (
                                    <div className="mt-1 flex justify-start">
                                        <button
                                            className="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 px-2 py-1 rounded-md hover:bg-muted"
                                            onClick={() => handleUpdate(index, 'isPrimary', true)}
                                        >
                                            <AlertCircle className="w-3 h-3" />
                                            {t('workspaceConfig.contacts.setPrimary', "Set as Primary")}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )
                    })}

                    <Button
                        variant="outline"
                        className="w-full border-dashed gap-2 h-10 text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
                        onClick={handleAdd}
                    >
                        <Plus className="w-4 h-4" />
                        {t('workspaceConfig.contacts.addAnother', "Add Another Contact")}
                    </Button>
                </div>

                <div className="mt-4 pt-4 border-t w-full flex gap-3">
                    <Button variant="outline" className="flex-1 transition-transform active:scale-95" onClick={() => onOpenChange(false)}>
                        {t('common.cancel', 'Cancel')}
                    </Button>
                    <Button className="flex-1 transition-transform active:scale-95 shadow-md shadow-primary/20" onClick={handleSave}>
                        {t('common.save', 'Save Contacts')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
