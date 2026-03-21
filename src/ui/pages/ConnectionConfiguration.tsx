import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button, Input, Label } from '@/ui/components'
import { setAppSetting } from '@/local-db/settings'
import { Server, Globe, Shield, RefreshCw, AlertCircle } from 'lucide-react'
import { relaunch } from '@tauri-apps/plugin-process';

export function ConnectionConfiguration() {
    const [url, setUrl] = useState('')
    const [anonKey, setAnonKey] = useState('')
    const [isSaving, setIsSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)

        const trimmedUrl = url.trim()
        const trimmedKey = anonKey.trim()

        if (!trimmedUrl || !trimmedKey) {
            setError('Please fill in both URL and Anon Key')
            return
        }

        // Allow if starts with https:// OR looks like a CryptoJS AES encrypted string
        const isEncrypted = /^U2FsdGVkX1/.test(trimmedUrl)
        if (!trimmedUrl.startsWith('https://') && !isEncrypted) {
            setError('URL must start with https://')
            return
        }

        try {
            setIsSaving(true)
            await setAppSetting('supabase_url', trimmedUrl)
            await setAppSetting('supabase_anon_key', trimmedKey)

            // Reload the app to apply changes
            await relaunch();
        } catch (err) {
            setError('Failed to save settings. Please try again.')
            setIsSaving(false)
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-background to-background">
            <Card className="w-full max-w-lg border-primary/20 shadow-2xl shadow-primary/5">
                <CardHeader className="space-y-1 text-center">
                    <div className="flex justify-center mb-4">
                        <div className="p-3 rounded-2xl bg-primary/10 text-primary animate-pulse">
                            <Server className="w-8 h-8" />
                        </div>
                    </div>
                    <CardTitle className="text-3xl font-bold tracking-tight">Backend Configuration</CardTitle>
                    <CardDescription className="text-base">
                        Setup your Supabase connection to start using Atlas.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleSave} className="space-y-6">
                        {error && (
                            <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                                <AlertCircle className="w-5 h-5 text-destructive mt-0.5" />
                                <p className="text-sm text-destructive font-medium">{error}</p>
                            </div>
                        )}

                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="url" className="text-sm font-semibold flex items-center gap-2">
                                    <Globe className="w-4 h-4 text-muted-foreground" />
                                    Supabase Project URL
                                </Label>
                                <Input
                                    id="url"
                                    placeholder="https://your-project.supabase.co"
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                    className="h-11 bg-secondary/30 transition-all focus:ring-2 focus:ring-primary/20"
                                />
                                <p className="text-[11px] text-muted-foreground">
                                    Found in Project Settings &gt; API &gt; Project URL
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="key" className="text-sm font-semibold flex items-center gap-2">
                                    <Shield className="w-4 h-4 text-muted-foreground" />
                                    Supabase Anon Key
                                </Label>
                                <Input
                                    id="key"
                                    type="password"
                                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                                    value={anonKey}
                                    onChange={(e) => setAnonKey(e.target.value)}
                                    className="h-11 bg-secondary/30 transition-all focus:ring-2 focus:ring-primary/20"
                                />
                                <p className="text-[11px] text-muted-foreground">
                                    Found in Project Settings &gt; API &gt; Project API keys (anon/public)
                                </p>
                            </div>
                        </div>

                        <Button
                            type="submit"
                            className="w-full h-12 text-base font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
                            disabled={isSaving}
                        >
                            {isSaving ? (
                                <>
                                    <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
                                    Saving & Reconnecting...
                                </>
                            ) : (
                                'Restart & Connect'
                            )}
                        </Button>

                        <div className="text-center">
                            <p className="text-xs text-muted-foreground">
                                These settings are stored locally in this Electron instance.
                            </p>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </div>
    )
}
