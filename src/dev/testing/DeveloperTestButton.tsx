import { lazy, Suspense, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/components/button'

const DeveloperTestDialog = lazy(() => import('./DeveloperTestDialog'))

export default function DeveloperTestButton({ suiteId, labelKey }: { suiteId: string; labelKey?: string }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    return <>
        <Button variant="outline" allowViewer onClick={() => setOpen(true)} className="gap-2">
            <FlaskConical className="h-4 w-4" />{t(labelKey ?? 'devTesting.button')}
        </Button>
        {open && <Suspense fallback={null}>
            <DeveloperTestDialog suiteId={suiteId} open={open} onOpenChange={setOpen} />
        </Suspense>}
    </>
}
