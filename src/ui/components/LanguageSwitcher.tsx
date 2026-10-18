import { useTranslation } from 'react-i18next'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/ui/components/select'
import { cn } from '@/lib/utils'
import { getLanguageDirection, parseLangFromHash, getPathWithLang } from '@/lib/i18nRouting'

export function LanguageSwitcher({ className }: { className?: string }) {
    const { i18n } = useTranslation()

    const changeLanguage = async (lng: string) => {
        await i18n.changeLanguage(lng)
        localStorage.setItem('i18nextLng', lng)

        const dir = getLanguageDirection(lng)
        document.dir = dir
        document.documentElement.dir = dir
        document.documentElement.lang = lng

        const hash = window.location.hash.replace(/^#/, '') || '/'
        const { path } = parseLangFromHash(hash)
        window.location.hash = getPathWithLang(path, lng)
    }

    const languages = [
        { code: 'en', label: 'English' },
        { code: 'ar', label: 'العربية' },
        { code: 'ku', label: 'کوردی' },
    ]

    return (
        <Select value={i18n.language} onValueChange={changeLanguage}>
            <SelectTrigger className={cn("w-[140px]", className)} allowViewer={true}>
                <SelectValue placeholder="Language" />
            </SelectTrigger>
            <SelectContent>
                {languages.map((lang) => (
                    <SelectItem key={lang.code} value={lang.code}>
                        {lang.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    )
}
