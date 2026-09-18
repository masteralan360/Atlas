// Dev-only visual harness, served by the opted-in runner plugin. No app login
// or current workspace is needed to inspect and exercise the test modal.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@/i18n/config'
import '@/index.css'
import DeveloperTestButton from './DeveloperTestButton'
import DeveloperTestDialog from './DeveloperTestDialog'

export default function Preview() {
    const [open, setOpen] = useState(true)
    return <main className="p-4">
        <DeveloperTestButton suiteId="sale-orders" />
        <DeveloperTestDialog suiteId="sale-orders" open={open} onOpenChange={setOpen} />
    </main>
}

if (import.meta.env.DEV && __ATLAS_DEV_TESTING__) {
    const root = createRoot(document.getElementById('root')!)
    root.render(<StrictMode><Preview /></StrictMode>)
    import.meta.hot?.dispose(() => root.unmount())
}
