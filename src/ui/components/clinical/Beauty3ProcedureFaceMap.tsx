import { useId, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Maximize2, MapPin, Sparkles } from 'lucide-react'
import type { Beauty3ProcedureFaceArea } from '@/local-db/models'
import { normalizeBeauty3ProcedureFaceAreas } from '@/local-db/beauty3Procedures'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
} from '@/ui/components'

export type Beauty3FaceMapProcedure = {
  value: string
  label: string
  number: number
  areas: Beauty3ProcedureFaceArea[]
}

const FACE_AREAS: Array<{
  id: Beauty3ProcedureFaceArea
  x: number
  y: number
  rx: number
  ry: number
}> = [
  { id: 'forehead', x: 160, y: 101, rx: 40, ry: 15 },
  { id: 'glabella', x: 160, y: 138, rx: 13, ry: 11 },
  { id: 'left_temple', x: 95, y: 164, rx: 13, ry: 15 },
  { id: 'right_temple', x: 225, y: 164, rx: 13, ry: 15 },
  { id: 'left_under_eye', x: 130, y: 188, rx: 17, ry: 10 },
  { id: 'right_under_eye', x: 190, y: 188, rx: 17, ry: 10 },
  { id: 'left_cheek', x: 111, y: 207, rx: 20, ry: 16 },
  { id: 'right_cheek', x: 209, y: 207, rx: 20, ry: 16 },
  { id: 'nose', x: 160, y: 201, rx: 11, ry: 19 },
  { id: 'lips', x: 160, y: 232, rx: 22, ry: 10 },
  { id: 'chin', x: 160, y: 260, rx: 25, ry: 12 },
  { id: 'left_jawline', x: 91, y: 240, rx: 15, ry: 17 },
  { id: 'right_jawline', x: 229, y: 240, rx: 15, ry: 17 },
  { id: 'neck', x: 160, y: 300, rx: 26, ry: 12 },
]

const FACE_AREA_BY_ID = new Map(FACE_AREAS.map((area) => [area.id, area]))
const UNASSIGNED_AREA_POINT = { x: 272, y: 291 }

function getAreaLabelKey(area: Beauty3ProcedureFaceArea) {
  return `beauty3Appointments.faceMapAreas.${area}`
}

function Beauty3FaceOutline() {
  return (
    <>
      <path d="M126 271v35c-22 7-42 16-60 28h188c-18-12-38-21-60-28v-35" fill="hsl(var(--muted))" stroke="hsl(var(--foreground) / 0.58)" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M78 145c-13-6-20 3-17 19 2 13 8 21 19 22m162-41c13-6 20 3 17 19-2 13-8 21-19 22" fill="hsl(var(--background))" stroke="hsl(var(--foreground) / 0.58)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M160 39c-53 0-88 38-88 98v39c0 56 37 98 88 106 51-8 88-50 88-106v-39c0-60-35-98-88-98Z" fill="hsl(var(--background))" stroke="hsl(var(--foreground) / 0.72)" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M75 112c7-47 39-76 85-76s78 29 85 76c-15-18-34-28-55-32-15 13-52 19-102 12-5 7-9 14-13 20Z" fill="hsl(var(--muted))" stroke="hsl(var(--foreground) / 0.58)" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M104 151c11-7 23-7 34 0m44 0c11-7 23-7 34 0" fill="none" stroke="hsl(var(--foreground) / 0.72)" strokeWidth="3" strokeLinecap="round" />
      <path d="M108 166c9-8 20-8 29 0m46 0c9-8 20-8 29 0" fill="none" stroke="hsl(var(--foreground) / 0.84)" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="123" cy="166" r="2.5" fill="hsl(var(--foreground) / 0.84)" />
      <circle cx="197" cy="166" r="2.5" fill="hsl(var(--foreground) / 0.84)" />
      <path d="M160 168v30m-8 6c5 4 11 4 16 0m-25 27c10 8 26 8 36 0" fill="none" stroke="hsl(var(--foreground) / 0.65)" strokeWidth="2.5" strokeLinecap="round" />
    </>
  )
}

function Beauty3FaceDiagram({
  procedures,
  expanded = false,
  interactiveAreas,
  onToggleArea,
  disabled = false,
}: {
  procedures?: Beauty3FaceMapProcedure[]
  expanded?: boolean
  interactiveAreas?: Beauty3ProcedureFaceArea[]
  onToggleArea?: (area: Beauty3ProcedureFaceArea) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const isAreaPicker = interactiveAreas !== undefined
  const selectedAreaSet = new Set(normalizeBeauty3ProcedureFaceAreas(interactiveAreas))
  const markersByArea = new Map<string, Array<{ procedure: Beauty3FaceMapProcedure; markerKey: string }>>()

  for (const procedure of procedures ?? []) {
    const areas = normalizeBeauty3ProcedureFaceAreas(procedure.areas)
    const markerAreas: Array<Beauty3ProcedureFaceArea | null> = areas.length > 0 ? areas : [null]
    for (const area of markerAreas) {
      const key = area ?? 'unassigned'
      const current = markersByArea.get(key) ?? []
      current.push({ procedure, markerKey: `${procedure.value}-${key}` })
      markersByArea.set(key, current)
    }
  }

  const markers = [...markersByArea.entries()].flatMap(([areaId, uses]) => {
    const area = FACE_AREA_BY_ID.get(areaId as Beauty3ProcedureFaceArea)
    const origin = area ?? UNASSIGNED_AREA_POINT
    return uses.map(({ procedure, markerKey }, index) => ({
      x: origin.x + (index - (uses.length - 1) / 2) * (expanded ? 12 : 17),
      y: origin.y,
      key: `${markerKey}-${procedure.number}`,
      number: procedure.number,
    }))
  })

  const handleAreaKeyDown = (event: KeyboardEvent<SVGGElement>, areaId: Beauty3ProcedureFaceArea) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    if (!disabled) onToggleArea?.(areaId)
  }

  return (
    <svg
      viewBox={expanded ? '26 25 268 285' : '0 0 320 350'}
      className={`mx-auto h-auto w-full ${expanded ? 'max-w-[520px]' : isAreaPicker ? 'max-w-[280px]' : 'max-w-[300px]'}`}
      role={isAreaPicker ? 'group' : 'img'}
      aria-label={isAreaPicker ? t('beauty3Appointments.faceMapAreaPickerTitle') : undefined}
      aria-labelledby={!isAreaPicker ? `${id}-title ${id}-description` : undefined}
    >
      {!isAreaPicker ? (
        <>
          <title id={`${id}-title`}>{t('beauty3Appointments.faceMapTitle')}</title>
          <desc id={`${id}-description`}>{t('beauty3Appointments.faceMapDescription')}</desc>
        </>
      ) : null}
      <Beauty3FaceOutline />

      {expanded && procedures ? (
        <g fill="none" stroke="hsl(var(--primary) / 0.38)" strokeWidth="1.5" strokeDasharray="4 4">
          {[...new Set(procedures.flatMap((procedure) => normalizeBeauty3ProcedureFaceAreas(procedure.areas)))].map((areaId) => {
            const area = FACE_AREA_BY_ID.get(areaId)
            return area ? <ellipse key={area.id} cx={area.x} cy={area.y} rx={area.rx} ry={area.ry} /> : null
          })}
        </g>
      ) : null}

      {isAreaPicker ? FACE_AREAS.map((area) => {
        const selected = selectedAreaSet.has(area.id)
        return (
          <g
            key={area.id}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={t(getAreaLabelKey(area.id))}
            aria-pressed={selected}
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled) onToggleArea?.(area.id)
            }}
            onKeyDown={(event) => handleAreaKeyDown(event, area.id)}
            className={disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
          >
            <ellipse
              cx={area.x}
              cy={area.y}
              rx={Math.max(7, area.rx * 0.58)}
              ry={Math.max(7, area.ry * 0.7)}
              fill={selected ? 'hsl(var(--primary) / 0.25)' : 'hsl(var(--background) / 0.8)'}
              stroke={selected ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground) / 0.65)'}
              strokeWidth={selected ? 2 : 1.5}
              strokeDasharray={selected ? undefined : '3 3'}
            />
            <circle cx={area.x} cy={area.y} r="2.5" fill={selected ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))'} />
            <title>{t(getAreaLabelKey(area.id))}</title>
          </g>
        )
      }) : null}

      {markers.map((marker) => (
        <g key={marker.key}>
          <circle cx={marker.x} cy={marker.y} r={expanded ? 6 : 8.5} fill="hsl(var(--background))" stroke="hsl(var(--primary))" strokeWidth={expanded ? 1.25 : 1.75} />
          <text x={marker.x} y={marker.y + (expanded ? 2.7 : 3.2)} textAnchor="middle" fontSize={expanded ? 5.8 : 7.6} fontWeight="700" fill="hsl(var(--foreground))">
            {marker.number}
          </text>
        </g>
      ))}
    </svg>
  )
}

export function Beauty3ProcedureAreaPicker({
  selectedAreas,
  onChange,
  disabled = false,
  required = false,
}: {
  selectedAreas: Beauty3ProcedureFaceArea[]
  onChange: (areas: Beauty3ProcedureFaceArea[]) => void
  disabled?: boolean
  required?: boolean
}) {
  const { t } = useTranslation()
  const selectedAreaSet = new Set(normalizeBeauty3ProcedureFaceAreas(selectedAreas))
  const toggleArea = (area: Beauty3ProcedureFaceArea) => {
    onChange(selectedAreaSet.has(area)
      ? selectedAreas.filter((current) => current !== area)
      : [...selectedAreas, area])
  }

  return (
    <section className="space-y-3 rounded-xl border border-border/70 bg-background p-3 sm:p-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <MapPin className="size-4 text-primary" />
          {t('beauty3Appointments.faceMapAreaPickerTitle')}
          {required ? <span className="text-destructive">*</span> : <span className="text-xs font-normal text-muted-foreground">{t('beauty3Appointments.faceMapAreaPickerOptional')}</span>}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(required
            ? 'beauty3Appointments.faceMapAreaPickerRequiredDescription'
            : 'beauty3Appointments.faceMapAreaPickerOptionalDescription')}
        </p>
      </div>

      <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Beauty3FaceDiagram interactiveAreas={selectedAreas} onToggleArea={toggleArea} disabled={disabled} />
        <div className="flex flex-wrap gap-2">
          {FACE_AREAS.map((area) => {
            const selected = selectedAreaSet.has(area.id)
            return (
              <Button
                key={area.id}
                type="button"
                size="sm"
                variant={selected ? 'default' : 'outline'}
                className="h-auto min-h-8 whitespace-normal px-2 py-1.5 text-start"
                aria-pressed={selected}
                onClick={() => toggleArea(area.id)}
                disabled={disabled}
              >
                {selected ? <Check className="me-1.5 size-3.5 shrink-0" /> : null}
                {t(getAreaLabelKey(area.id))}
              </Button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export function Beauty3ProcedureFaceMap({ procedures }: { procedures: Beauty3FaceMapProcedure[] }) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  if (procedures.length === 0) return null

  const renderLegend = () => (
    <div className="space-y-2" role="list" aria-label={t('beauty3Appointments.faceMapSelectedProcedures')}>
      {procedures.map((procedure) => (
        <div key={procedure.value} role="listitem" className="flex items-start gap-2 text-sm">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/50 bg-background text-xs font-semibold text-primary">
            {procedure.number}
          </span>
          <div className="min-w-0">
            <span className="break-words">{procedure.label}</span>
            {normalizeBeauty3ProcedureFaceAreas(procedure.areas).length === 0 ? (
              <span className="block text-xs text-muted-foreground">{t('beauty3Appointments.faceMapAreaUnspecified')}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )

  return (
    <>
      <section className="space-y-3 rounded-lg border bg-muted/20 p-3 sm:p-4" aria-labelledby="beauty3-face-map-title">
        <div>
          <h3 id="beauty3-face-map-title">
            <Button type="button" variant="ghost" className="h-auto w-full justify-between px-0 py-0 text-sm font-semibold hover:bg-transparent" onClick={() => setIsOpen(true)} aria-haspopup="dialog">
              <span className="flex items-center gap-2 text-start">
                <Sparkles className="size-4 shrink-0 text-primary" />
                {t('beauty3Appointments.faceMapTitle')}
              </span>
              <Maximize2 className="ms-2 size-4 shrink-0 text-muted-foreground" />
            </Button>
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('beauty3Appointments.faceMapDescription')}</p>
        </div>

        <div className="grid items-center gap-4 md:grid-cols-2">
          <button
            type="button"
            className="w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setIsOpen(true)}
            aria-haspopup="dialog"
            aria-label={t('beauty3Appointments.faceMapTitle')}
          >
            <Beauty3FaceDiagram procedures={procedures} />
          </button>
          {renderLegend()}
        </div>
      </section>

      <AppDialog open={isOpen} onOpenChange={setIsOpen}>
        <AppDialogContent className="max-w-5xl">
          <AppDialogHeader>
            <AppDialogTitle>{t('beauty3Appointments.faceMapTitle')}</AppDialogTitle>
            <p className="text-sm text-muted-foreground">{t('beauty3Appointments.faceMapDescription')}</p>
          </AppDialogHeader>
          <AppDialogBody>
            <div className="grid items-center gap-4 md:grid-cols-2">
              <Beauty3FaceDiagram procedures={procedures} expanded />
              {renderLegend()}
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>{t('common.close')}</Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>
    </>
  )
}
