// Dev-only visual harness, served by the development runner plugin. No app login
// or current workspace is needed to inspect and exercise the test modal.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import '@/i18n/config'
import '@/index.css'
import DeveloperTestButton from './DeveloperTestButton'
import DeveloperTestDialog from './DeveloperTestDialog'

export default function Preview() {
    const [open, setOpen] = useState(true)
    const { t } = useTranslation()
    const suiteId = new URLSearchParams(window.location.search).get('suite') === 'pos' ? 'pos' : 'sale-orders'
    return <main className="p-4">
        <nav className="mb-4 flex gap-4"><a href="?suite=sale-orders">{t('devTesting.saleOrders')}</a><a href="?suite=pos">{t('devTesting.pos')}</a></nav>
        <DeveloperTestButton suiteId={suiteId} />
        <DeveloperTestDialog suiteId={suiteId} open={open} onOpenChange={setOpen} />
    </main>
}

if (import.meta.env.DEV && __ATLAS_DEV_TESTING__) {
    const root = createRoot(document.getElementById('root')!)
    root.render(<StrictMode><Preview /></StrictMode>)
    import.meta.hot?.dispose(() => root.unmount())
}
