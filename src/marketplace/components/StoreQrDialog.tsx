import { useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import { ExternalLink, QrCode, Copy, Check } from 'lucide-react'
import { ReactQRCode } from '@lglab/react-qr-code'
import { useTranslation } from 'react-i18next'

import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    useToast
} from '@/ui/components'
import { cn } from '@/lib/utils'

import { StoreAvatar } from './StoreAvatar'

type StoreQrDialogProps = {
    name: string
    slug: string
    logoUrl?: string | null
    className?: string
}

function getMarketplaceBaseOrigin() {
    const configuredOrigin = (import.meta.env.VITE_MARKETPLACE_SITE_URL || '').trim().replace(/\/+$/, '')
    if (configuredOrigin) return configuredOrigin

    if (typeof window !== 'undefined' && /^https?:$/i.test(window.location.protocol)) {
        const hostname = window.location.hostname.toLowerCase()
        if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
            return window.location.origin.replace(/\/+$/, '')
        }
    }

    return 'https://marketplace-atlas.vercel.app'
}

function buildStoreUrl(slug: string) {
    return `${getMarketplaceBaseOrigin()}/s/${slug}`
}

export function StoreQrDialog({ name, slug, logoUrl, className }: StoreQrDialogProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const storeUrl = buildStoreUrl(slug)
    const [copied, setCopied] = useState(false)

    const stopPropagation = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement> | MouseEvent<HTMLDivElement>) => {
        event.stopPropagation()
    }

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(storeUrl)
            setCopied(true)
            toast({
                description: t('marketplace.linkCopied', { defaultValue: 'Store link copied to clipboard' })
            })
            setTimeout(() => setCopied(false), 2000)
        } catch (error) {
            console.error('Failed to copy', error)
        }
    }

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn('gap-2 rounded-xl border-border/60 bg-background/85', className)}
                    onClick={stopPropagation}
                    onKeyDown={stopPropagation}
                    aria-label={t('marketplace.storeQrButton', {
                        defaultValue: 'Show QR code for {{storeName}}',
                        storeName: name
                    })}
                >
                    <QrCode className="h-4 w-4" />
                    <span>{t('marketplace.qr', { defaultValue: 'QR' })}</span>
                </Button>
            </DialogTrigger>

            <DialogContent className="sm:max-w-md">
                <DialogHeader className="items-center text-center sm:text-center">
                    <StoreAvatar
                        logoUrl={logoUrl}
                        name={name}
                        className="h-20 w-20 rounded-[1.75rem]"
                        imageClassName="p-3"
                        iconClassName="h-8 w-8"
                    />
                    <DialogTitle>
                        {t('marketplace.storeQrTitle', {
                            defaultValue: '{{storeName}} QR Code',
                            storeName: name
                        })}
                    </DialogTitle>
                    <DialogDescription>
                        {t('marketplace.storeQrDescription', {
                            defaultValue: 'Scan to open this store directly on Atlas Marketplace.'
                        })}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="mx-auto flex w-fit items-center justify-center rounded-[2rem] border border-border/60 bg-white p-5 shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
                        <ReactQRCode value={storeUrl} size={208} level="M" />
                    </div>

                    <button 
                        type="button"
                        onClick={handleCopy}
                        className="group relative w-full rounded-2xl border border-border/60 bg-muted/35 p-3 text-center transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                            {t('marketplace.storeLink', { defaultValue: 'Store Link' })}
                        </p>
                        <div className="mt-2 flex items-center justify-center gap-2">
                            <p className="break-all font-mono text-xs text-foreground group-hover:text-primary transition-colors">
                                {storeUrl}
                            </p>
                            {copied ? (
                                <Check className="h-4 w-4 shrink-0 text-green-500" />
                            ) : (
                                <Copy className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
                            )}
                        </div>
                    </button>

                    <Button asChild className="w-full rounded-2xl">
                        <a href={storeUrl} target="_blank" rel="noreferrer">
                            <span>{t('marketplace.visitStore', { defaultValue: 'Visit Store' })}</span>
                            <ExternalLink className="h-4 w-4" />
                        </a>
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
