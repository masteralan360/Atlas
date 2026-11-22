import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/auth/supabase'
import { Beauty3AppointmentInlineEntry } from '@/ui/pages/Beauty3Appointments'
import { useToast } from '@/ui/components'
import { queryKeys } from '@/query/queryKeys'
import { normalizeBeauty3ProcedureFaceAreas } from '@/local-db/beauty3Procedures'
import type { Beauty3AppointmentDraft } from '@/local-db/beauty3Appointments'
import type { ClinicalPreset, CurrencyCode, IQDDisplayPreference } from '@/local-db/models'

const SIVA_WORKSPACE_ID = '903503d2-cb83-49b8-9243-3f175f55b389'

type ProcedurePreset = Pick<
  ClinicalPreset,
  'id' | 'name' | 'displayName' | 'consultationFee' | 'isActive' | 'faceMapAreas'
>

type PublicVisitConfiguration = {
  defaultCurrency: CurrencyCode
  iqdPreference: IQDDisplayPreference
  procedurePresets: ProcedurePreset[]
}

const CURRENCIES = new Set<CurrencyCode>(['usd', 'eur', 'iqd', 'try'])

async function fetchPublicVisitConfiguration(): Promise<PublicVisitConfiguration> {
  const { data, error } = await supabase.functions.invoke('siva-public-visit', {
    body: { action: 'configuration' },
  })
  if (error) throw error

  const currency = String(data?.defaultCurrency ?? '').toLowerCase() as CurrencyCode
  const iqdPreference = data?.iqdPreference
  if (!CURRENCIES.has(currency) || !['IQD', 'د.ع'].includes(iqdPreference)) {
    throw new Error('Public visit form configuration is invalid')
  }

  const procedurePresets = Array.isArray(data?.procedurePresets)
    ? data.procedurePresets.flatMap((preset: Record<string, unknown>) => {
      if (
        typeof preset.id !== 'string'
        || typeof preset.name !== 'string'
        || !Number.isFinite(Number(preset.consultationFee))
        || preset.isActive !== true
      ) return []

      return [{
        id: preset.id,
        name: preset.name,
        displayName: typeof preset.displayName === 'string' ? preset.displayName : null,
        consultationFee: Number(preset.consultationFee),
        isActive: true,
        faceMapAreas: normalizeBeauty3ProcedureFaceAreas(preset.faceMapAreas),
      } satisfies ProcedurePreset]
    })
    : []

  return {
    defaultCurrency: currency,
    iqdPreference: iqdPreference as IQDDisplayPreference,
    procedurePresets,
  }
}

export function SivaPublicVisit() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [formKey, setFormKey] = useState(0)
  const configuration = useQuery({
    queryKey: queryKeys.sivaPublicVisit.configuration(SIVA_WORKSPACE_ID),
    queryFn: fetchPublicVisitConfiguration,
  })

  const savePublicVisit = async (
    draft: Beauty3AppointmentDraft,
    honeypot?: string,
  ) => {
    const { data, error } = await supabase.functions.invoke('siva-public-visit', {
      body: {
        action: 'submit',
        honeypot,
        visit: {
          name: draft.name,
          age: draft.age,
          maritalStatus: draft.maritalStatus,
          address: draft.address,
          phoneNumber: draft.phoneNumber,
          procedureTypes: draft.procedureTypes,
          procedureType: draft.procedureType,
          procedureTypeOther: draft.procedureTypeOther,
          procedurePlace: draft.procedurePlace,
          procedureDate: draft.procedureDate,
          appointmentTotal: draft.appointmentTotal,
          totalProfit: draft.totalProfit,
          currency: draft.currency,
        },
      },
    })

    if (error || data?.ok !== true) {
      const status = (error as { context?: Response } | null)?.context?.status
      toast({
        variant: 'destructive',
        title: status === 429
          ? t('beauty3Appointments.publicRateLimited')
          : t('beauty3Appointments.saveFailed'),
      })
      return false
    }

    toast({ title: t('beauty3Appointments.saved') })
    setFormKey((current) => current + 1)
    return true
  }

  if (configuration.isLoading) {
    return (
      <main className="flex min-h-screen w-full items-center justify-center bg-background p-4 text-foreground" role="status">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          {t('beauty3Appointments.publicFormLoading')}
        </div>
      </main>
    )
  }

  if (configuration.isError || !configuration.data) {
    return (
      <main className="flex min-h-screen w-full items-center justify-center bg-background p-4 text-foreground">
        <p role="alert" className="text-center text-sm text-destructive">
          {t('beauty3Appointments.publicFormUnavailable')}
        </p>
      </main>
    )
  }

  return (
    <main className="min-h-screen w-full bg-background p-4 text-foreground sm:p-6">
      <Beauty3AppointmentInlineEntry
        key={formKey}
        workspaceId={SIVA_WORKSPACE_ID}
        defaultCurrency={configuration.data.defaultCurrency}
        iqdPreference={configuration.data.iqdPreference}
        procedurePresetOverrides={configuration.data.procedurePresets}
        publicMode
        onSave={savePublicVisit}
      />
    </main>
  )
}
