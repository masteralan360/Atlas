import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MapPin, Plus, ShieldCheck } from 'lucide-react'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@/ui/components'
import {
  postalAddArea,
  type PostalAreaCreateInput,
  type PostalScope,
} from '@/local-db/postal'
import {
  locationLabel,
  type PostalLocationCatalog,
  type PostalTariffZone,
} from './domain'
import { usePostalAction } from './usePostalAccess'
import { PostalError, PostalLoading } from './shared'

type AreaLocale = 'en' | 'ar' | 'ku'

export function AddAreasPanel({
  scope,
  catalog,
  catalogLoading,
  catalogError,
  onRetry,
}: {
  scope: PostalScope
  catalog: PostalLocationCatalog
  catalogLoading: boolean
  catalogError: unknown
  onRetry: () => void
}) {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const action = usePostalAction()
  const [governorateId, setGovernorateId] = useState('')
  const [labelEn, setLabelEn] = useState('')
  const [labelAr, setLabelAr] = useState('')
  const [labelKu, setLabelKu] = useState('')
  const [tariffZone, setTariffZone] = useState<PostalTariffZone | ''>('')
  const [areaId, setAreaId] = useState(() => `area-${crypto.randomUUID()}`)

  const governorate = catalog.governorates.find((entry) => entry.id === governorateId)
  const northernGovernorate = governorate?.tariffProfile === 'northern'
  const hasAnyLabel = Boolean(labelEn.trim() || labelAr.trim() || labelKu.trim())
  const canSubmit = Boolean(
    governorate &&
    hasAnyLabel &&
    (!northernGovernorate || tariffZone) &&
    !catalogLoading &&
    !action.busy,
  )

  function changeGovernorate(value: string) {
    setGovernorateId(value)
    setTariffZone('')
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!governorate || !hasAnyLabel || (northernGovernorate && !tariffZone)) return

    const input: PostalAreaCreateInput = {
      governorate: governorate.id,
      area: areaId,
      label_en: labelEn.trim() || null,
      label_ar: labelAr.trim() || null,
      label_ku: labelKu.trim() || null,
      tariff_zone: northernGovernorate ? tariffZone as PostalTariffZone : null,
    }
    const signature = JSON.stringify(input)

    void action.run(signature, async () => {
      await postalAddArea(scope, input)
      toast({
        title: t('postal.areaAddedTitle'),
        description: t('postal.areaAddedDescription', {
          area: preferredLabel(i18n.language, labelEn, labelAr, labelKu),
          governorate: locationLabel(governorate.id, i18n.language, undefined, catalog),
        }),
      })
      setLabelEn('')
      setLabelAr('')
      setLabelKu('')
      setTariffZone('')
      setAreaId(`area-${crypto.randomUUID()}`)
    })
  }

  return (
    <section className="space-y-5 rounded-xl border bg-card p-4 sm:p-6">
      <header className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MapPin className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t('postal.addAreaTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('postal.addAreaDescription')}</p>
        </div>
      </header>

      {Boolean(catalogError) && <PostalError retry={onRetry} />}
      {catalogLoading && <PostalLoading />}

      <form className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)]" onSubmit={submit}>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="postal-add-area-governorate">{t('postal.governorate')} *</Label>
            <Select
              value={governorateId}
              onValueChange={changeGovernorate}
              disabled={action.busy || catalogLoading || !catalog.governorates.length}
              required
            >
              <SelectTrigger id="postal-add-area-governorate" aria-required="true">
                <SelectValue placeholder={t('postal.selectGovernorate')} />
              </SelectTrigger>
              <SelectContent>
                {catalog.governorates.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {locationLabel(entry.id, i18n.language, undefined, catalog)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {governorate && (
              <p className="text-xs text-muted-foreground">
                {t(`postal.tariffProfiles.${governorate.tariffProfile}`)}
              </p>
            )}
          </div>

          <fieldset className="space-y-3 rounded-lg border p-3 sm:p-4">
            <legend className="px-1 text-sm font-medium">{t('postal.areaLabels')} *</legend>
            {([
              ['en', 'settings.monthDisplay.english', labelEn, setLabelEn],
              ['ar', 'settings.monthDisplay.arabic', labelAr, setLabelAr],
              ['ku', 'settings.monthDisplay.kurdish', labelKu, setLabelKu],
            ] as const).map(([locale, labelKey, value, setValue]) => (
              <div key={locale} className="space-y-2">
                <Label htmlFor={`postal-add-area-label-${locale}`}>{t(labelKey)}</Label>
                <Input
                  id={`postal-add-area-label-${locale}`}
                  value={value}
                  maxLength={120}
                  disabled={action.busy}
                  onChange={(event) => setValue(event.target.value)}
                  dir={locale === 'ar' || locale === 'ku' ? 'auto' : 'ltr'}
                />
              </div>
            ))}
          </fieldset>

          {northernGovernorate ? (
            <div className="space-y-2">
              <Label htmlFor="postal-add-area-zone">{t('postal.tariffZone')} *</Label>
              <Select
                value={tariffZone}
                onValueChange={(value) => setTariffZone(value as PostalTariffZone)}
                disabled={action.busy}
                required
              >
                <SelectTrigger id="postal-add-area-zone" aria-required="true">
                  <SelectValue placeholder={t('postal.selectTariffZone')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="center">{t('postal.tariffZones.center')}</SelectItem>
                  <SelectItem value="outside">{t('postal.tariffZones.outside')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <Button type="submit" disabled={!canSubmit}>
            {action.busy ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="me-2 h-4 w-4" aria-hidden="true" />
            )}
            {t(action.busy ? 'postal.addingArea' : 'postal.addArea')}
          </Button>
        </div>

        <aside className="min-w-0 rounded-lg border bg-muted/20 p-4">
          <h3 className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            {t('postal.areasInGovernorate')}
          </h3>
          {governorate ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {locationLabel(governorate.id, i18n.language, undefined, catalog)}
              </p>
              {governorate.areas.length ? (
                <ul className="mt-3 space-y-2">
                  {governorate.areas.map((area) => (
                    <li key={area.id} className="flex min-w-0 items-start justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
                      <span className="min-w-0 break-words">{locationLabel(area.id, i18n.language, governorate.id, catalog)}</span>
                      {area.tariffZone && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t(`postal.tariffZones.${area.tariffZone}`)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">{t('postal.noAreasInGovernorate')}</p>
              )}
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">{t('postal.selectGovernorate')}</p>
          )}
        </aside>
      </form>
    </section>
  )
}

function preferredLabel(language: string, en: string, ar: string, ku: string) {
  const labels: Record<AreaLocale, string | undefined> = {
    en: en.trim() || undefined,
    ar: ar.trim() || undefined,
    ku: ku.trim() || undefined,
  }
  const preferred = language.startsWith('ar') ? 'ar' : language.startsWith('ku') ? 'ku' : 'en'
  return labels[preferred] ?? labels.en ?? labels.ar ?? labels.ku ?? ''
}
