import { useState, useEffect } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Input,
    Button,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/ui/components'
import { useTranslation } from 'react-i18next'
import { MessageCircle, Globe } from 'lucide-react'

interface WhatsAppNumberInputModalProps {
    isOpen: boolean
    onClose: () => void
    onConfirm: (phone: string, language: string) => void
}

export function WhatsAppNumberInputModal({ isOpen, onClose, onConfirm }: WhatsAppNumberInputModalProps) {
    const { t, i18n } = useTranslation()
    const [phone, setPhone] = useState('')
    const [language, setLanguage] = useState(i18n.language || 'en')

    useEffect(() => {
        if (isOpen) {
            setLanguage(i18n.language || 'en')
        }
    }, [isOpen, i18n.language])

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (phone.trim()) {
            onConfirm(phone.trim(), language)
            setPhone('')
            onClose()
        }
    }

    const languages = [
        { code: 'en', label: 'English' },
        { code: 'ar', label: 'العربية' },
        { code: 'ku', label: 'کوردی' },
    ]

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <MessageCircle className="w-5 h-5 text-emerald-600" />
                        {t('sales.share.whatsappTitle') || 'Share to WhatsApp'}
                    </DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-6 py-4">
                    <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                            <Globe className="w-4 h-4 text-muted-foreground" />
                            {t('settings.language') || 'Language'}
                        </Label>
                        <Select value={language} onValueChange={setLanguage}>
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {languages.map((lang) => (
                                    <SelectItem key={lang.code} value={lang.code}>
                                        {lang.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                            {t('sales.share.languageHint') || 'Message details will be formatted in this language.'}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="whatsapp-phone">
                            {t('sales.share.enterPhone') || 'Enter Customer Phone Number'}
                        </Label>
                        <Input
                            id="whatsapp-phone"
                            placeholder="e.g. 0770 123 4567"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            autoFocus
                            className="text-lg tracking-wider"
                        />
                        <p className="text-xs text-muted-foreground">
                            {t('sales.share.phoneHint') || 'Enter the number to open the chat directly.'}
                        </p>
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                            disabled={!phone.trim()}
                        >
                            {t('common.share') || 'Share'}
                            <MessageCircle className="w-4 h-4" />
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
