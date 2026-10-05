import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  ClipboardCheck,
  ClipboardList,
  DollarSign,
  Flower2,
  Home,
  Leaf,
  MapPin,
  Pencil,
  Plus,
  Sprout,
  Users,
  Unlink,
} from 'lucide-react'

import { useAuth } from '@/auth'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import { formatNumberWithCommas, formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import {
  assignGardenJob,
  completeGardenJob,
  createGardenConstructionProject,
  createGardenJob,
  createGardenMaintenanceContract,
  createGardenSite,
  formatGardenMoney,
  unassignGardenJob,
  updateGardenJob,
  useGardenData,
  useWorkspaceUsers,
  type BusinessPartner,
  type CurrencyCode,
  type GardenConstructionProject,
  type GardenJob,
  type GardenJobKind,
  type GardenJobOutcome,
  type GardenMaintenanceContract,
  type GardenSite,
} from '@/local-db'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CurrencySelector,
  DateTimePicker,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@/ui/components'
import { useWorkspace } from '@/workspace'

type GardenTab = 'overview' | 'projects' | 'contracts' | 'schedule' | 'myJobs'
type JobForm = {
  siteId: string
  kind: GardenJobKind
  title: string
  scheduledAt: Date
  timeZone: string
  plannedDurationMinutes: string
  routeOrder: string
  instructions: string
  projectId: string
  contractId: string
  assigneeIds: string[]
}

const GARDEN_TABLES = [
  'garden_sites',
  'garden_construction_projects',
  'garden_maintenance_contracts',
  'garden_jobs',
  'garden_job_assignments',
  'garden_job_activity',
] as const

const todayAt = (hour: number) => {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  return date
}

function localDateOnly(date: Date) {
  return String(date.getFullYear()) + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

function parseMoney(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value.replace(/,/g, ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function moneyInput(value: string) {
  return formatNumericInput(sanitizeNumericInput(value, { allowDecimal: true, maxFractionDigits: 2 }))
}

function emptyJobForm(siteId = ''): JobForm {
  return {
    siteId,
    kind: 'maintenance',
    title: '',
    scheduledAt: todayAt(9),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Baghdad',
    plannedDurationMinutes: '60',
    routeOrder: '1',
    instructions: '',
    projectId: '',
    contractId: '',
    assigneeIds: [],
  }
}

function RequiredLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return <Label htmlFor={htmlFor}>{children} *</Label>
}

function StatusBadge({ status, t }: { status: GardenJob['status']; t: (key: string) => string }) {
  const variant = status === 'completed' ? 'default' : status === 'in_progress' ? 'secondary' : status === 'cancelled' ? 'destructive' : 'outline'
  return <Badge variant={variant}>{t('gardenManagement.status.' + status)}</Badge>
}

function GardenJobDialog({
  open,
  setOpen,
  workspaceId,
  actorUserId,
  sites,
  projects,
  contracts,
  users,
  assignments,
  job,
  onSaved,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  workspaceId: string
  actorUserId: string
  sites: GardenSite[]
  projects: GardenConstructionProject[]
  contracts: GardenMaintenanceContract[]
  users: Array<{ id: string; name: string }>
  assignments: ReturnType<typeof useGardenData>['assignments']
  job?: GardenJob
  onSaved: (message: string) => void
}) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [validationAttempted, setValidationAttempted] = useState(false)
  const [form, setForm] = useState<JobForm>(() => emptyJobForm(sites[0]?.id ?? ''))

  const resetForm = () => {
    if (!job) {
      setForm(emptyJobForm(sites[0]?.id ?? ''))
      return
    }
    const activeAssigneeIds = assignments
      .filter((assignment) => assignment.jobId === job.id && !assignment.unassignedAt && !assignment.isDeleted)
      .map((assignment) => assignment.userId)
    setForm({
      siteId: job.siteId,
      kind: job.kind,
      title: job.title,
      scheduledAt: new Date(job.scheduledAt),
      timeZone: job.timeZone,
      plannedDurationMinutes: String(job.plannedDurationMinutes ?? 60),
      routeOrder: String(job.routeOrder ?? 1),
      instructions: job.instructions ?? '',
      projectId: job.projectId ?? '',
      contractId: job.contractId ?? '',
      assigneeIds: activeAssigneeIds,
    })
  }
  useEffect(() => {
    if (open) {
      resetForm()
      setValidationAttempted(false)
    }
  }, [open, job?.id])

  const availableProjects = projects.filter((project) => project.siteId === form.siteId && !project.isDeleted)
  const availableContracts = contracts.filter((contract) => contract.siteId === form.siteId && !contract.isDeleted)
  const titleValid = form.title.trim().length > 0
  const siteValid = Boolean(form.siteId)
  const scheduleValid = form.scheduledAt instanceof Date && !Number.isNaN(form.scheduledAt.getTime())
  const relatedRecordValid = form.kind === 'construction'
    ? Boolean(form.projectId)
    : form.kind === 'maintenance'
      ? Boolean(form.contractId)
      : true
  const isValid = titleValid && siteValid && scheduleValid && relatedRecordValid
  const update = <K extends keyof JobForm>(key: K, value: JobForm[K]) => setForm((current) => ({ ...current, [key]: value }))
  const close = (nextOpen: boolean) => {
    if (saving && !nextOpen) return
    if (!nextOpen) setValidationAttempted(false)
    setOpen(nextOpen)
  }

  const save = async () => {
    setValidationAttempted(true)
    if (!isValid || saving) return
    setSaving(true)
    try {
      if (job) {
        await updateGardenJob(workspaceId, job.id, {
          siteId: form.siteId,
          kind: form.kind,
          projectId: form.kind === 'construction' ? form.projectId : null,
          contractId: form.kind === 'maintenance' ? form.contractId : null,
          title: form.title.trim(),
          scheduledAt: form.scheduledAt.toISOString(),
          timeZone: form.timeZone,
          plannedDurationMinutes: Number(form.plannedDurationMinutes) || 60,
          routeOrder: Number(form.routeOrder) || 1,
          instructions: form.instructions.trim() || null,
        }, actorUserId)
        const current = assignments.filter((assignment) => assignment.jobId === job.id && !assignment.unassignedAt && !assignment.isDeleted)
        const currentIds = new Set(current.map((assignment) => assignment.userId))
        for (const userId of form.assigneeIds) {
          if (!currentIds.has(userId)) {
            const member = users.find((candidate) => candidate.id === userId)
            if (member) await assignGardenJob(workspaceId, job.id, member.id, member.name, actorUserId)
          }
        }
        for (const userId of currentIds) {
          if (!form.assigneeIds.includes(userId)) await unassignGardenJob(workspaceId, job.id, userId, actorUserId)
        }
      } else {
        const created = await createGardenJob(workspaceId, {
          siteId: form.siteId,
          kind: form.kind,
          title: form.title.trim(),
          scheduledAt: form.scheduledAt.toISOString(),
          timeZone: form.timeZone,
          plannedDurationMinutes: Number(form.plannedDurationMinutes) || 60,
          status: 'scheduled',
          routeOrder: Number(form.routeOrder) || 1,
          instructions: form.instructions.trim() || null,
          projectId: form.kind === 'construction' ? form.projectId : null,
          contractId: form.kind === 'maintenance' ? form.contractId : null,
          createdBy: actorUserId,
        })
        for (const userId of form.assigneeIds) {
          const member = users.find((candidate) => candidate.id === userId)
          if (member) await assignGardenJob(workspaceId, created.id, member.id, member.name, actorUserId)
        }
      }
      onSaved(t(job ? 'gardenManagement.toast.jobUpdated' : 'gardenManagement.toast.jobCreated'))
      setOpen(false)
    } catch (error) {
      console.error('[Garden] Could not save job:', error)
      onSaved(t('gardenManagement.toast.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppDialog open={open} onOpenChange={close}>
      <AppDialogContent className="max-w-2xl" showCloseButton={!saving}>
        <AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><CalendarDays className="h-5 w-5 text-primary" />{t(job ? 'gardenManagement.dialog.editJob' : 'gardenManagement.dialog.newJob')}</AppDialogTitle></AppDialogHeader>
        <AppDialogBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <RequiredLabel>{t('gardenManagement.fields.site')}</RequiredLabel>
              <Select value={form.siteId} onValueChange={(value) => {
                update('siteId', value)
                update('projectId', '')
                update('contractId', '')
              }}>
                <SelectTrigger><SelectValue placeholder={t('gardenManagement.placeholders.chooseSite')} /></SelectTrigger>
                <SelectContent>{sites.filter((site) => site.status === 'active').map((site) => <SelectItem key={site.id} value={site.id}>{site.name} · {site.homeownerName}</SelectItem>)}</SelectContent>
              </Select>
              {validationAttempted && !siteValid && <p className="text-sm text-destructive">{t('gardenManagement.validation.siteRequired')}</p>}
            </div>
            <div className="space-y-2">
              <RequiredLabel>{t('gardenManagement.fields.jobType')}</RequiredLabel>
              <Select value={form.kind} onValueChange={(value) => {
                update('kind', value as GardenJobKind)
                update('projectId', '')
                update('contractId', '')
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="maintenance">{t('gardenManagement.kind.maintenance')}</SelectItem>
                  <SelectItem value="construction">{t('gardenManagement.kind.construction')}</SelectItem>
                  <SelectItem value="ad_hoc">{t('gardenManagement.kind.ad_hoc')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.kind === 'construction' && <div className="space-y-2"><RequiredLabel>{t('gardenManagement.fields.project')}</RequiredLabel><Select value={form.projectId} onValueChange={(value) => update('projectId', value)}><SelectTrigger><SelectValue placeholder={t('gardenManagement.placeholders.chooseProject')} /></SelectTrigger><SelectContent>{availableProjects.map((project) => <SelectItem key={project.id} value={project.id}>{project.projectNo} · {project.title}</SelectItem>)}</SelectContent></Select>{validationAttempted && !form.projectId && <p className="text-sm text-destructive">{t('gardenManagement.validation.projectRequired')}</p>}</div>}
            {form.kind === 'maintenance' && <div className="space-y-2"><RequiredLabel>{t('gardenManagement.fields.contract')}</RequiredLabel><Select value={form.contractId} onValueChange={(value) => update('contractId', value)}><SelectTrigger><SelectValue placeholder={t('gardenManagement.placeholders.chooseContract')} /></SelectTrigger><SelectContent>{availableContracts.map((contract) => <SelectItem key={contract.id} value={contract.id}>{contract.contractNo}</SelectItem>)}</SelectContent></Select>{validationAttempted && !form.contractId && <p className="text-sm text-destructive">{t('gardenManagement.validation.contractRequired')}</p>}</div>}
            <div className="space-y-2 sm:col-span-2"><RequiredLabel>{t('gardenManagement.fields.jobTitle')}</RequiredLabel><Input value={form.title} onChange={(event) => update('title', event.target.value)} placeholder={t('gardenManagement.placeholders.jobTitle')} />{validationAttempted && !titleValid && <p className="text-sm text-destructive">{t('gardenManagement.validation.titleRequired')}</p>}</div>
            <div className="space-y-2"><RequiredLabel>{t('gardenManagement.fields.scheduledAt')}</RequiredLabel><DateTimePicker date={form.scheduledAt} setDate={(date) => date && update('scheduledAt', date)} mode="date-time" placeholder={t('gardenManagement.fields.scheduledAt')} />{validationAttempted && !scheduleValid && <p className="text-sm text-destructive">{t('gardenManagement.validation.scheduleRequired')}</p>}</div>
            <div className="space-y-2"><Label htmlFor="garden-route-order">{t('gardenManagement.fields.routeOrder')}</Label><Input id="garden-route-order" inputMode="numeric" value={form.routeOrder} onChange={(event) => update('routeOrder', sanitizeNumericInput(event.target.value, { allowDecimal: false }))} placeholder="1" /></div>
            <div className="space-y-2 sm:col-span-2">
              <Label>{t('gardenManagement.fields.assignedStaff')}</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {users.map((member) => {
                  const selected = form.assigneeIds.includes(member.id)
                  return <button key={member.id} type="button" onClick={() => update('assigneeIds', selected ? form.assigneeIds.filter((id) => id !== member.id) : [...form.assigneeIds, member.id])} className={'flex min-h-11 items-center gap-2 rounded-xl border px-3 text-start text-sm transition-colors ' + (selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}><span className={'flex h-5 w-5 items-center justify-center rounded-md border ' + (selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40')}>{selected && <Check className="h-3.5 w-3.5" />}</span><Users className="h-4 w-4 text-muted-foreground" /><span className="truncate">{member.name}</span></button>
                })}
                {users.length === 0 && <p className="text-sm text-muted-foreground">{t('gardenManagement.empty.noStaff')}</p>}
              </div>
            </div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="garden-job-instructions">{t('gardenManagement.fields.instructions')}</Label><Textarea id="garden-job-instructions" value={form.instructions} onChange={(event) => update('instructions', event.target.value)} rows={3} /></div>
          </div>
        </AppDialogBody>
        <AppDialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => close(false)}>{t('gardenManagement.actions.cancel')}</Button><Button type="button" disabled={!isValid || saving} onClick={() => void save()}>{saving && <Clock3 className="me-2 h-4 w-4 animate-spin" />}{t(saving ? 'gardenManagement.actions.saving' : 'gardenManagement.actions.save')}</Button></AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}

function CompletionDialog({
  job,
  open,
  setOpen,
  workspaceId,
  userId,
  onSaved,
}: {
  job?: GardenJob
  open: boolean
  setOpen: (open: boolean) => void
  workspaceId: string
  userId: string
  onSaved: (message: string) => void
}) {
  const { t } = useTranslation()
  const [outcome, setOutcome] = useState<GardenJobOutcome>('ok')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const close = (nextOpen: boolean) => {
    if (saving && !nextOpen) return
    if (!nextOpen) {
      setOutcome('ok')
      setNote('')
    }
    setOpen(nextOpen)
  }
  const save = async () => {
    if (!job || saving) return
    setSaving(true)
    try {
      await completeGardenJob(workspaceId, job.id, userId, outcome, note)
      onSaved(t('gardenManagement.toast.jobCompleted'))
      setOutcome('ok')
      setNote('')
      setOpen(false)
    } catch (error) {
      console.error('[Garden] Could not complete job:', error)
      onSaved(t('gardenManagement.toast.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  return <AppDialog open={open} onOpenChange={close}><AppDialogContent className="max-w-lg" showCloseButton={!saving}><AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 text-primary" />{t('gardenManagement.dialog.completeJob')}</AppDialogTitle></AppDialogHeader><AppDialogBody><p className="font-semibold">{job?.title}</p><div className="mt-4 grid gap-2 sm:grid-cols-2"><Button type="button" variant={outcome === 'ok' ? 'default' : 'outline'} onClick={() => setOutcome('ok')}><CheckCircle2 className="me-2 h-4 w-4" />{t('gardenManagement.outcome.ok')}</Button><Button type="button" variant={outcome === 'needs_follow_up' ? 'default' : 'outline'} onClick={() => setOutcome('needs_follow_up')}><ClipboardList className="me-2 h-4 w-4" />{t('gardenManagement.outcome.needs_follow_up')}</Button></div><div className="mt-4 space-y-2"><Label htmlFor="garden-completion-note">{t('gardenManagement.fields.completionNote')}</Label><Textarea id="garden-completion-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} /></div></AppDialogBody><AppDialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => close(false)}>{t('gardenManagement.actions.cancel')}</Button><Button type="button" disabled={saving} onClick={() => void save()}>{saving && <Clock3 className="me-2 h-4 w-4 animate-spin" />}{t(saving ? 'gardenManagement.actions.saving' : 'gardenManagement.actions.confirmComplete')}</Button></AppDialogFooter></AppDialogContent></AppDialog>
}

export default function GardenManagement() {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { features, activeWorkspace } = useWorkspace()
  const { toast } = useToast()
  const workspaceId = user?.workspaceId ?? activeWorkspace?.id
  const actorUserId = user?.id ?? ''
  const isAdmin = user?.role === 'admin'
  const workspaceUsers = useWorkspaceUsers(workspaceId) ?? []
  const { sites, projects, contracts, jobs, assignments } = useGardenData(workspaceId)
  const [tab, setTab] = useState<GardenTab>(isAdmin ? 'overview' : 'myJobs')
  const [dialog, setDialog] = useState<'site' | 'project' | 'contract' | 'job' | null>(null)
  const [activeJob, setActiveJob] = useState<GardenJob | undefined>()
  const [completionJob, setCompletionJob] = useState<GardenJob | undefined>()
  const [completionOpen, setCompletionOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [validationAttempted, setValidationAttempted] = useState(false)
  const [dateRange, setDateRange] = useState<'today' | 'yesterday' | 'month' | 'lastMonth' | 'allTime' | 'custom'>('allTime')
  const [customDates, setCustomDates] = useState({ start: '', end: '' })

  const [siteName, setSiteName] = useState('')
  const [homeownerName, setHomeownerName] = useState('')
  const [homeownerPhone, setHomeownerPhone] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [accessNotes, setAccessNotes] = useState('')
  const [partnerId, setPartnerId] = useState('')
  const [partnerName, setPartnerName] = useState('')

  const [projectSiteId, setProjectSiteId] = useState('')
  const [projectNo, setProjectNo] = useState('')
  const [projectTitle, setProjectTitle] = useState('')
  const [projectScope, setProjectScope] = useState('')
  const [projectCurrency, setProjectCurrency] = useState<CurrencyCode>(features.default_currency)
  const [quotedAmount, setQuotedAmount] = useState('')
  const [agreedAmount, setAgreedAmount] = useState('')
  const [estimatedCost, setEstimatedCost] = useState('')
  const [actualCost, setActualCost] = useState('')
  const [projectStart, setProjectStart] = useState<Date | undefined>()
  const [projectTarget, setProjectTarget] = useState<Date | undefined>()

  const [contractSiteId, setContractSiteId] = useState('')
  const [contractNo, setContractNo] = useState('')
  const [contractStart, setContractStart] = useState<Date>(() => new Date())
  const [contractEnd, setContractEnd] = useState<Date>(() => {
    const end = new Date()
    end.setFullYear(end.getFullYear() + 1)
    end.setDate(end.getDate() - 1)
    return end
  })
  const [monthlyFee, setMonthlyFee] = useState('')
  const [contractCurrency, setContractCurrency] = useState<CurrencyCode>(features.default_currency)
  const [visitsPerMonth, setVisitsPerMonth] = useState('4')
  const [visitDays, setVisitDays] = useState('1, 8, 15, 22')
  const [serviceTime, setServiceTime] = useState<Date>(() => todayAt(8))
  const [contractNotes, setContractNotes] = useState('')

  useEffect(() => {
    setTab(isAdmin ? 'overview' : 'myJobs')
  }, [isAdmin])

  const memberOptions = useMemo(
    () => workspaceUsers.filter((member) => member.role !== 'viewer').map((member) => ({ id: member.id, name: member.name })),
    [workspaceUsers],
  )
  const activeSites = sites.filter((site) => !site.isDeleted && site.status === 'active')
  const locale = i18n.resolvedLanguage || i18n.language
  const visibleJobs = jobs
    .filter((job) => !job.isDeleted)
    .filter((job) => isAdmin || assignments.some((assignment) => assignment.jobId === job.id && assignment.userId === actorUserId && !assignment.unassignedAt && !assignment.isDeleted))
    .filter((job) => isDateInDateRange(job.scheduledAt, dateRange, customDates))
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt) || left.routeOrder - right.routeOrder)
  const visibleProjects = projects.filter((project) => !project.isDeleted && isDateInDateRange(project.createdAt, dateRange, customDates)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const visibleContracts = contracts.filter((contract) => !contract.isDeleted && isDateInDateRange(contract.createdAt, dateRange, customDates)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const siteById = new Map(sites.map((site) => [site.id, site]))
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const contractById = new Map(contracts.map((contract) => [contract.id, contract]))

  const notify = (message: string, variant: 'default' | 'destructive' = 'default') => toast({ title: message, variant })
  const resetSite = () => {
    setSiteName(''); setHomeownerName(''); setHomeownerPhone(''); setAddress(''); setCity(''); setAccessNotes('')
    setPartnerId(''); setPartnerName(''); setValidationAttempted(false)
  }
  const resetProject = () => {
    setProjectSiteId(''); setProjectNo(''); setProjectTitle(''); setProjectScope(''); setProjectCurrency(features.default_currency)
    setQuotedAmount(''); setAgreedAmount(''); setEstimatedCost(''); setActualCost(''); setProjectStart(undefined); setProjectTarget(undefined)
    setValidationAttempted(false)
  }
  const resetContract = () => {
    setContractSiteId(''); setContractNo(''); setContractStart(new Date())
    const end = new Date(); end.setFullYear(end.getFullYear() + 1); end.setDate(end.getDate() - 1); setContractEnd(end)
    setMonthlyFee(''); setContractCurrency(features.default_currency); setVisitsPerMonth('4'); setVisitDays('1, 8, 15, 22')
    setServiceTime(todayAt(8)); setContractNotes(''); setValidationAttempted(false)
  }
  const closeMainDialog = () => {
    if (saving) return
    finishMainDialog()
  }
  const finishMainDialog = () => {
    if (dialog === 'site') resetSite()
    if (dialog === 'project') resetProject()
    if (dialog === 'contract') resetContract()
    setDialog(null)
  }
  const runSave = async (action: () => Promise<void>) => {
    if (saving) return
    setSaving(true)
    try {
      await action()
      finishMainDialog()
    } catch (error) {
      console.error('[Garden] Could not save record:', error)
      notify(t('gardenManagement.toast.saveFailed'), 'destructive')
    } finally {
      setSaving(false)
    }
  }
  const saveSite = () => {
    setValidationAttempted(true)
    if (!workspaceId || !siteName.trim() || !homeownerName.trim() || !address.trim()) return
    void runSave(async () => {
      await createGardenSite(workspaceId, {
        name: siteName.trim(), homeownerName: homeownerName.trim(), homeownerPhone: homeownerPhone.trim() || null,
        address: address.trim(), city: city.trim() || null, accessNotes: accessNotes.trim() || null,
        businessPartnerId: partnerId || null, createdBy: actorUserId,
      })
      notify(t('gardenManagement.toast.siteCreated'))
    })
  }
  const saveProject = () => {
    setValidationAttempted(true)
    if (!workspaceId || !projectSiteId || !projectNo.trim() || !projectTitle.trim()) return
    void runSave(async () => {
      await createGardenConstructionProject(workspaceId, {
        siteId: projectSiteId,
        businessPartnerId: siteById.get(projectSiteId)?.businessPartnerId ?? null,
        projectNo: projectNo.trim(), title: projectTitle.trim(), scope: projectScope.trim() || null,
        status: 'draft', quotedAmount: parseMoney(quotedAmount), agreedAmount: parseMoney(agreedAmount),
        estimatedCost: parseMoney(estimatedCost), actualCost: parseMoney(actualCost), currency: projectCurrency,
        startsOn: projectStart ? localDateOnly(projectStart) : null,
        targetCompletionOn: projectTarget ? localDateOnly(projectTarget) : null,
        notes: null, createdBy: actorUserId,
      })
      notify(t('gardenManagement.toast.projectCreated'))
    })
  }
  const parsedVisitDays = visitDays.split(',').map((value) => Number(value.trim())).filter(Number.isInteger)
  const validContractAmount = parseMoney(monthlyFee) !== null
  const validContractDays = parsedVisitDays.length >= Number(visitsPerMonth) && new Set(parsedVisitDays).size === parsedVisitDays.length && parsedVisitDays.every((day) => day >= 1 && day <= 31)
  const saveContract = () => {
    setValidationAttempted(true)
    const count = Number(visitsPerMonth)
    if (!workspaceId || !contractSiteId || !contractNo.trim() || !validContractAmount || count < 1 || count > 31 || !validContractDays || localDateOnly(contractEnd) < localDateOnly(contractStart)) return
    void runSave(async () => {
      const fee = parseMoney(monthlyFee)
      if (fee === null) return
      const totalMinutes = serviceTime.getHours() * 60 + serviceTime.getMinutes()
      const serviceTimeText = String(Math.floor(totalMinutes / 60)).padStart(2, '0') + ':' + String(totalMinutes % 60).padStart(2, '0')
      await createGardenMaintenanceContract(workspaceId, {
        siteId: contractSiteId,
        businessPartnerId: siteById.get(contractSiteId)?.businessPartnerId ?? null,
        contractNo: contractNo.trim(), status: 'active', startsOn: localDateOnly(contractStart), endsOn: localDateOnly(contractEnd),
        monthlyFee: fee, currency: contractCurrency, visitsPerMonth: count, visitDays: parsedVisitDays,
        serviceTime: serviceTimeText,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Baghdad',
        notes: contractNotes.trim() || null, createdBy: actorUserId,
      })
      notify(t('gardenManagement.toast.contractCreated'))
    })
  }

  const renderDateFilters = () => <DateRangeFilters className="w-full lg:max-w-2xl" label={t('gardenManagement.filters.activityDate')} dateRange={dateRange} customDates={customDates} onDateRangeChange={setDateRange} onCustomDatesChange={setCustomDates} />

  const renderJobs = (staffView = false) => (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {renderDateFilters()}
        {!staffView && <Button onClick={() => { setActiveJob(undefined); setDialog('job') }} disabled={activeSites.length === 0}><Plus className="me-2 h-4 w-4" />{t('gardenManagement.actions.newJob')}</Button>}
      </div>
      {visibleJobs.length === 0 ? <Card><CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground"><CalendarDays className="h-10 w-10 opacity-40" /><p className="font-medium">{t(staffView ? 'gardenManagement.empty.noMyJobs' : 'gardenManagement.empty.noJobs')}</p>{!staffView && <p className="text-sm">{t('gardenManagement.empty.jobsHelp')}</p>}</CardContent></Card> : (
        <div className="grid gap-3">
          {visibleJobs.map((job) => {
            const site = siteById.get(job.siteId)
            const activeAssignments = assignments.filter((assignment) => assignment.jobId === job.id && !assignment.unassignedAt && !assignment.isDeleted)
            const linkedRecord = job.projectId ? projectById.get(job.projectId)?.projectNo : job.contractId ? contractById.get(job.contractId)?.contractNo : null
            return <Card key={job.id} className="overflow-hidden"><CardContent className="p-4 md:p-5"><div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="flex min-w-0 flex-1 gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Leaf className="h-5 w-5" /></div><div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold">{job.title}</h3><StatusBadge status={job.status} t={t} />{job.outcome && <Badge variant={job.outcome === 'ok' ? 'secondary' : 'destructive'}>{t('gardenManagement.outcome.' + job.outcome)}</Badge>}<Badge variant="outline">{t('gardenManagement.kind.' + job.kind)}</Badge></div>
                <div className="mt-2 grid gap-x-5 gap-y-1.5 text-sm text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                  <span className="flex min-w-0 items-center gap-1.5"><Home className="h-4 w-4 shrink-0" /><span className="truncate">{site?.name ?? t('gardenManagement.labels.unknownSite')}</span></span>
                  <span className="flex min-w-0 items-center gap-1.5"><MapPin className="h-4 w-4 shrink-0" /><span className="truncate">{site?.address ?? t('gardenManagement.labels.addressUnavailable')}</span></span>
                  <span className="flex items-center gap-1.5"><CalendarDays className="h-4 w-4 shrink-0" />{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(job.scheduledAt))} · {new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(job.scheduledAt))}</span>
                  <span className="flex items-center gap-1.5"><Users className="h-4 w-4 shrink-0" />{activeAssignments.map((assignment) => assignment.userNameSnapshot).join(', ') || t('gardenManagement.labels.unassigned')}</span>
                </div>
                {(linkedRecord || job.instructions) && <p className="mt-2 line-clamp-2 text-sm">{linkedRecord && <span className="me-2 font-medium">{linkedRecord}</span>}{job.instructions}</p>}
                {job.completionNote && <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">{job.completionNote}</p>}
              </div></div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                {isAdmin ? <><Badge variant="outline" className="gap-1"><MapPin className="h-3.5 w-3.5" />{t('gardenManagement.labels.routeStop', { count: job.routeOrder })}</Badge><Button size="sm" variant="outline" onClick={() => { setActiveJob(job); setDialog('job') }}><Pencil className="me-1.5 h-4 w-4" />{t('gardenManagement.actions.editSchedule')}</Button></> : job.status === 'scheduled' ? <Button size="sm" onClick={() => { void updateGardenJob(workspaceId!, job.id, { status: 'in_progress' }, actorUserId).catch(() => notify(t('gardenManagement.toast.saveFailed'), 'destructive')) }}><Sprout className="me-1.5 h-4 w-4" />{t('gardenManagement.actions.startJob')}</Button> : job.status === 'in_progress' ? <Button size="sm" onClick={() => { setCompletionJob(job); setCompletionOpen(true) }}><CheckCircle2 className="me-1.5 h-4 w-4" />{t('gardenManagement.actions.completeJob')}</Button> : null}
              </div>
            </div></CardContent></Card>
          })}
        </div>
      )}
    </div>
  )

  const renderProjects = () => <div className="space-y-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">{renderDateFilters()}<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setDialog('site')}><Plus className="me-2 h-4 w-4" />{t('gardenManagement.actions.newSite')}</Button><Button onClick={() => { setProjectSiteId(activeSites[0]?.id ?? ''); setDialog('project') }} disabled={activeSites.length === 0}><Plus className="me-2 h-4 w-4" />{t('gardenManagement.actions.newProject')}</Button></div></div>
    {visibleProjects.length === 0 ? <Card><CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground"><Flower2 className="h-10 w-10 opacity-40" /><p className="font-medium">{t('gardenManagement.empty.noProjects')}</p><p className="text-sm">{t('gardenManagement.empty.projectsHelp')}</p></CardContent></Card> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{visibleProjects.map((project) => { const site = siteById.get(project.siteId); return <Card key={project.id}><CardHeader className="pb-2"><CardTitle className="flex items-start justify-between gap-2 text-base"><span className="min-w-0"><span className="block text-xs font-medium text-muted-foreground">{project.projectNo}</span><span className="mt-1 block truncate">{project.title}</span></span><Badge variant="outline">{t('gardenManagement.projectStatus.' + project.status)}</Badge></CardTitle></CardHeader><CardContent className="space-y-3"><p className="flex items-center gap-2 text-sm text-muted-foreground"><Home className="h-4 w-4 shrink-0" /><span className="truncate">{site?.name} · {site?.homeownerName}</span></p>{project.scope && <p className="line-clamp-2 text-sm">{project.scope}</p>}<div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/50 p-3 text-sm"><div><p className="text-xs text-muted-foreground">{t('gardenManagement.fields.agreedAmount')}</p><p className="font-semibold">{formatGardenMoney(project.agreedAmount ?? project.quotedAmount, project.currency, locale)}</p></div><div><p className="text-xs text-muted-foreground">{t('gardenManagement.fields.estimatedCost')}</p><p className="font-semibold">{formatGardenMoney(project.actualCost ?? project.estimatedCost, project.currency, locale)}</p></div></div><p className="text-xs text-muted-foreground">{t('gardenManagement.labels.created')} · {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(project.createdAt))}</p></CardContent></Card>})}</div>}</div>

  const renderContracts = () => <div className="space-y-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">{renderDateFilters()}<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setDialog('site')}><Plus className="me-2 h-4 w-4" />{t('gardenManagement.actions.newSite')}</Button><Button onClick={() => { setContractSiteId(activeSites[0]?.id ?? ''); setDialog('contract') }} disabled={activeSites.length === 0}><Plus className="me-2 h-4 w-4" />{t('gardenManagement.actions.newContract')}</Button></div></div>
    {visibleContracts.length === 0 ? <Card><CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground"><ClipboardList className="h-10 w-10 opacity-40" /><p className="font-medium">{t('gardenManagement.empty.noContracts')}</p><p className="text-sm">{t('gardenManagement.empty.contractsHelp')}</p></CardContent></Card> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{visibleContracts.map((contract) => { const site = siteById.get(contract.siteId); const contractJobs = jobs.filter((job) => job.contractId === contract.id && !job.isDeleted); const completedJobs = contractJobs.filter((job) => job.status === 'completed').length; return <Card key={contract.id}><CardHeader className="pb-2"><CardTitle className="flex items-start justify-between gap-2 text-base"><span className="min-w-0"><span className="block text-xs font-medium text-muted-foreground">{contract.contractNo}</span><span className="mt-1 block truncate">{site?.name ?? t('gardenManagement.labels.unknownSite')}</span></span><Badge variant={contract.status === 'active' ? 'default' : 'outline'}>{t('gardenManagement.contractStatus.' + contract.status)}</Badge></CardTitle></CardHeader><CardContent className="space-y-3"><p className="flex items-center gap-2 text-sm text-muted-foreground"><Home className="h-4 w-4" />{site?.homeownerName}</p><div className="flex items-center justify-between rounded-xl bg-muted/50 p-3"><span className="text-sm text-muted-foreground">{t('gardenManagement.fields.monthlyFee')}</span><span className="font-bold">{formatGardenMoney(contract.monthlyFee, contract.currency, locale)}<span className="ms-1 text-xs font-normal text-muted-foreground">{t('gardenManagement.labels.perMonth')}</span></span></div><div className="flex items-center justify-between text-sm"><span className="text-muted-foreground">{t('gardenManagement.labels.visitsMonthly', { count: contract.visitsPerMonth })}</span><span>{completedJobs}/{contractJobs.length} {t('gardenManagement.labels.completed')}</span></div><p className="text-xs text-muted-foreground">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(contract.startsOn + 'T00:00:00'))} — {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(contract.endsOn + 'T00:00:00'))}</p></CardContent></Card>})}</div>}</div>

  const tabs: Array<{ id: GardenTab; label: string; icon: typeof Leaf }> = isAdmin
    ? [{ id: 'overview', label: t('gardenManagement.tabs.overview'), icon: Sprout }, { id: 'projects', label: t('gardenManagement.tabs.projects'), icon: Flower2 }, { id: 'contracts', label: t('gardenManagement.tabs.contracts'), icon: ClipboardList }, { id: 'schedule', label: t('gardenManagement.tabs.schedule'), icon: CalendarDays }]
    : [{ id: 'myJobs', label: t('gardenManagement.tabs.myJobs'), icon: ClipboardCheck }]

  if (!workspaceId || !actorUserId) return null
  return <div className="h-full min-h-full w-full space-y-5 p-3 sm:p-5 lg:p-7">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div className="min-w-0"><div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"><Leaf className="h-6 w-6" /></span><div><h1 className="text-2xl font-black tracking-tight sm:text-3xl">{t('gardenManagement.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t(isAdmin ? 'gardenManagement.description.admin' : 'gardenManagement.description.staff')}</p></div></div></div><ModulePageFreshness className="shrink-0" tableNames={GARDEN_TABLES} /></div>
    <div className="flex flex-wrap gap-2 rounded-2xl border border-border/70 bg-muted/30 p-2">{tabs.map(({ id, label, icon: Icon }) => <Button key={id} variant={tab === id ? 'default' : 'ghost'} onClick={() => setTab(id)} className="gap-2"><Icon className="h-4 w-4" />{label}</Button>)}</div>

    {isAdmin && tab === 'overview' && <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">{[
      { label: t('gardenManagement.summary.sites'), value: activeSites.length, icon: Home },
      { label: t('gardenManagement.summary.projects'), value: projects.filter((project) => !project.isDeleted && !['completed', 'cancelled'].includes(project.status)).length, icon: Flower2 },
      { label: t('gardenManagement.summary.activeContracts'), value: contracts.filter((contract) => !contract.isDeleted && contract.status === 'active').length, icon: ClipboardList },
      { label: t('gardenManagement.summary.upcomingJobs'), value: jobs.filter((job) => !job.isDeleted && job.status === 'scheduled' && new Date(job.scheduledAt) >= new Date()).length, icon: CalendarDays },
    ].map((item) => <Card key={item.label} className="overflow-hidden"><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">{item.label}</p><p className="mt-2 text-3xl font-black">{formatNumberWithCommas(item.value)}</p></div><span className="rounded-xl bg-primary/10 p-3 text-primary"><item.icon className="h-5 w-5" /></span></CardContent></Card>)}</div>
      <div className="flex flex-wrap gap-2"><Button onClick={() => { resetSite(); setDialog('site') }}><Plus className="me-2 h-4 w-4" />{t('gardenManagement.actions.newSite')}</Button><Button variant="outline" onClick={() => { setProjectSiteId(activeSites[0]?.id ?? ''); setDialog('project') }} disabled={activeSites.length === 0}><Flower2 className="me-2 h-4 w-4" />{t('gardenManagement.actions.newProject')}</Button><Button variant="outline" onClick={() => { setContractSiteId(activeSites[0]?.id ?? ''); setDialog('contract') }} disabled={activeSites.length === 0}><ClipboardList className="me-2 h-4 w-4" />{t('gardenManagement.actions.newContract')}</Button><Button variant="outline" onClick={() => { setActiveJob(undefined); setDialog('job') }} disabled={activeSites.length === 0}><CalendarDays className="me-2 h-4 w-4" />{t('gardenManagement.actions.newJob')}</Button></div>
      <div className="grid gap-5 xl:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2"><CalendarDays className="h-5 w-5 text-primary" />{t('gardenManagement.sections.nextVisits')}</CardTitle></CardHeader><CardContent>{renderJobs()}</CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2"><Home className="h-5 w-5 text-primary" />{t('gardenManagement.sections.sites')}</CardTitle></CardHeader><CardContent><div className="grid gap-2 sm:grid-cols-2">{sites.filter((site) => !site.isDeleted).slice(0, 8).map((site) => <div key={site.id} className="rounded-xl border p-3"><p className="font-semibold">{site.name}</p><p className="mt-1 text-sm text-muted-foreground">{site.homeownerName} · {site.city || site.address}</p></div>)}{sites.length === 0 && <p className="py-5 text-sm text-muted-foreground">{t('gardenManagement.empty.noSites')}</p>}</div></CardContent></Card></div></div>}
    {isAdmin && tab === 'projects' && renderProjects()}
    {isAdmin && tab === 'contracts' && renderContracts()}
    {isAdmin && tab === 'schedule' && renderJobs()}
    {!isAdmin && tab === 'myJobs' && renderJobs(true)}

    <AppDialog open={dialog === 'site'} onOpenChange={(open) => open ? setDialog('site') : closeMainDialog()}><AppDialogContent className="max-w-2xl" showCloseButton={!saving}><AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><Home className="h-5 w-5 text-primary" />{t('gardenManagement.dialog.newSite')}</AppDialogTitle></AppDialogHeader><AppDialogBody><div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2"><RequiredLabel htmlFor="garden-site-name">{t('gardenManagement.fields.siteName')}</RequiredLabel><Input id="garden-site-name" value={siteName} onChange={(event) => setSiteName(event.target.value)} placeholder={t('gardenManagement.placeholders.siteName')} />{validationAttempted && !siteName.trim() && <p className="text-sm text-destructive">{t('gardenManagement.validation.required')}</p>}</div>
      <div className="space-y-2 sm:col-span-2"><Label>{t('gardenManagement.fields.linkedCustomer')}</Label><div className="flex items-start gap-2"><PartnerAutocompleteInput value={partnerName} onChange={(value) => { setPartnerName(value); if (partnerId) { setPartnerId(''); setHomeownerName(''); setHomeownerPhone('') } }} onSelectPartner={(partner: BusinessPartner) => { setPartnerId(partner.id); setPartnerName(partner.partnerName); setHomeownerName(partner.partnerName); setHomeownerPhone(partner.phone ?? '') }} workspaceId={workspaceId} placeholder={t('gardenManagement.placeholders.searchCustomer')} roles={['customer']} />{partnerId && <div className="flex shrink-0 items-center gap-1"><Badge variant="secondary"><Check className="me-1 h-3 w-3" />{t('gardenManagement.labels.linked')}</Badge><Button type="button" size="icon" variant="ghost" aria-label={t('gardenManagement.actions.unlinkCustomer')} onClick={() => { setPartnerId(''); setPartnerName(''); setHomeownerName(''); setHomeownerPhone('') }}><Unlink className="h-4 w-4" /></Button></div>}</div></div>
      <div className="space-y-2"><RequiredLabel htmlFor="garden-homeowner">{t('gardenManagement.fields.homeowner')}</RequiredLabel><Input id="garden-homeowner" value={homeownerName} onChange={(event) => setHomeownerName(event.target.value)} />{validationAttempted && !homeownerName.trim() && <p className="text-sm text-destructive">{t('gardenManagement.validation.required')}</p>}</div>
      <div className="space-y-2"><Label htmlFor="garden-phone">{t('gardenManagement.fields.phone')}</Label><Input id="garden-phone" value={homeownerPhone} onChange={(event) => setHomeownerPhone(event.target.value)} /></div>
      <div className="space-y-2 sm:col-span-2"><RequiredLabel htmlFor="garden-address">{t('gardenManagement.fields.address')}</RequiredLabel><Input id="garden-address" value={address} onChange={(event) => setAddress(event.target.value)} />{validationAttempted && !address.trim() && <p className="text-sm text-destructive">{t('gardenManagement.validation.required')}</p>}</div>
      <div className="space-y-2"><Label htmlFor="garden-city">{t('gardenManagement.fields.city')}</Label><Input id="garden-city" value={city} onChange={(event) => setCity(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="garden-access-notes">{t('gardenManagement.fields.accessNotes')}</Label><Input id="garden-access-notes" value={accessNotes} onChange={(event) => setAccessNotes(event.target.value)} /></div>
    </div></AppDialogBody><AppDialogFooter><Button type="button" variant="outline" disabled={saving} onClick={closeMainDialog}>{t('gardenManagement.actions.cancel')}</Button><Button type="button" disabled={saving || !siteName.trim() || !homeownerName.trim() || !address.trim()} onClick={saveSite}>{saving && <Clock3 className="me-2 h-4 w-4 animate-spin" />}{t(saving ? 'gardenManagement.actions.saving' : 'gardenManagement.actions.save')}</Button></AppDialogFooter></AppDialogContent></AppDialog>

    <AppDialog open={dialog === 'project'} onOpenChange={(open) => open ? setDialog('project') : closeMainDialog()}><AppDialogContent className="max-w-2xl" showCloseButton={!saving}><AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><Flower2 className="h-5 w-5 text-primary" />{t('gardenManagement.dialog.newProject')}</AppDialogTitle></AppDialogHeader><AppDialogBody><div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2"><RequiredLabel>{t('gardenManagement.fields.site')}</RequiredLabel><Select value={projectSiteId} onValueChange={setProjectSiteId}><SelectTrigger><SelectValue placeholder={t('gardenManagement.placeholders.chooseSite')} /></SelectTrigger><SelectContent>{activeSites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name} · {site.homeownerName}</SelectItem>)}</SelectContent></Select>{validationAttempted && !projectSiteId && <p className="text-sm text-destructive">{t('gardenManagement.validation.siteRequired')}</p>}</div>
      <div className="space-y-2"><RequiredLabel htmlFor="garden-project-no">{t('gardenManagement.fields.projectNo')}</RequiredLabel><Input id="garden-project-no" value={projectNo} onChange={(event) => setProjectNo(event.target.value)} />{validationAttempted && !projectNo.trim() && <p className="text-sm text-destructive">{t('gardenManagement.validation.required')}</p>}</div>
      <div className="space-y-2"><RequiredLabel htmlFor="garden-project-title">{t('gardenManagement.fields.projectTitle')}</RequiredLabel><Input id="garden-project-title" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} />{validationAttempted && !projectTitle.trim() && <p className="text-sm text-destructive">{t('gardenManagement.validation.required')}</p>}</div>
      <div className="space-y-2 sm:col-span-2"><Label htmlFor="garden-project-scope">{t('gardenManagement.fields.scope')}</Label><Textarea id="garden-project-scope" rows={3} value={projectScope} onChange={(event) => setProjectScope(event.target.value)} /></div>
      <div className="sm:col-span-2"><CurrencySelector value={projectCurrency} onChange={setProjectCurrency} label={t('gardenManagement.fields.currency') + ' *'} /></div>
      {[
        { id: 'quoted', label: t('gardenManagement.fields.quotedAmount'), value: quotedAmount, set: setQuotedAmount },
        { id: 'agreed', label: t('gardenManagement.fields.agreedAmount'), value: agreedAmount, set: setAgreedAmount },
        { id: 'estimated', label: t('gardenManagement.fields.estimatedCost'), value: estimatedCost, set: setEstimatedCost },
        { id: 'actual', label: t('gardenManagement.fields.actualCost'), value: actualCost, set: setActualCost },
      ].map((field) => <div key={field.id} className="space-y-2"><Label htmlFor={'garden-' + field.id}>{field.label}</Label><div className="relative"><DollarSign className="pointer-events-none absolute start-3 top-3 h-4 w-4 text-muted-foreground" /><Input id={'garden-' + field.id} inputMode="decimal" className="ps-9" value={field.value} placeholder="0" onChange={(event) => field.set(moneyInput(event.target.value))} /></div></div>)}
      <div className="space-y-2"><Label>{t('gardenManagement.fields.startDate')}</Label><DateTimePicker date={projectStart} setDate={setProjectStart} mode="date" placeholder={t('gardenManagement.fields.startDate')} /></div><div className="space-y-2"><Label>{t('gardenManagement.fields.targetDate')}</Label><DateTimePicker date={projectTarget} setDate={setProjectTarget} mode="date" placeholder={t('gardenManagement.fields.targetDate')} /></div>
    </div></AppDialogBody><AppDialogFooter><Button type="button" variant="outline" disabled={saving} onClick={closeMainDialog}>{t('gardenManagement.actions.cancel')}</Button><Button type="button" disabled={saving || !projectSiteId || !projectNo.trim() || !projectTitle.trim()} onClick={saveProject}>{saving && <Clock3 className="me-2 h-4 w-4 animate-spin" />}{t(saving ? 'gardenManagement.actions.saving' : 'gardenManagement.actions.save')}</Button></AppDialogFooter></AppDialogContent></AppDialog>

    <AppDialog open={dialog === 'contract'} onOpenChange={(open) => open ? setDialog('contract') : closeMainDialog()}><AppDialogContent className="max-w-2xl" showCloseButton={!saving}><AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><ClipboardList className="h-5 w-5 text-primary" />{t('gardenManagement.dialog.newContract')}</AppDialogTitle></AppDialogHeader><AppDialogBody><div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2"><RequiredLabel>{t('gardenManagement.fields.site')}</RequiredLabel><Select value={contractSiteId} onValueChange={setContractSiteId}><SelectTrigger><SelectValue placeholder={t('gardenManagement.placeholders.chooseSite')} /></SelectTrigger><SelectContent>{activeSites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name} · {site.homeownerName}</SelectItem>)}</SelectContent></Select>{validationAttempted && !contractSiteId && <p className="text-sm text-destructive">{t('gardenManagement.validation.siteRequired')}</p>}</div>
      <div className="space-y-2"><RequiredLabel htmlFor="garden-contract-no">{t('gardenManagement.fields.contractNo')}</RequiredLabel><Input id="garden-contract-no" value={contractNo} onChange={(event) => setContractNo(event.target.value)} />{validationAttempted && !contractNo.trim() && <p className="text-sm text-destructive">{t('gardenManagement.validation.required')}</p>}</div>
      <div className="space-y-2"><RequiredLabel htmlFor="garden-monthly-fee">{t('gardenManagement.fields.monthlyFee')}</RequiredLabel><Input id="garden-monthly-fee" inputMode="decimal" value={monthlyFee} placeholder="0" onChange={(event) => setMonthlyFee(moneyInput(event.target.value))} />{validationAttempted && !validContractAmount && <p className="text-sm text-destructive">{t('gardenManagement.validation.amountRequired')}</p>}</div>
      <div className="sm:col-span-2"><CurrencySelector value={contractCurrency} onChange={setContractCurrency} label={t('gardenManagement.fields.currency') + ' *'} /></div>
      <div className="space-y-2"><RequiredLabel>{t('gardenManagement.fields.startDate')}</RequiredLabel><DateTimePicker date={contractStart} setDate={(date) => date && setContractStart(date)} mode="date" placeholder={t('gardenManagement.fields.startDate')} /></div><div className="space-y-2"><RequiredLabel>{t('gardenManagement.fields.endDate')}</RequiredLabel><DateTimePicker date={contractEnd} setDate={(date) => date && setContractEnd(date)} mode="date" placeholder={t('gardenManagement.fields.endDate')} /></div>
      <div className="space-y-2"><RequiredLabel htmlFor="garden-visits">{t('gardenManagement.fields.visitsPerMonth')}</RequiredLabel><Input id="garden-visits" inputMode="numeric" value={visitsPerMonth} onChange={(event) => setVisitsPerMonth(sanitizeNumericInput(event.target.value, { allowDecimal: false }))} /></div>
      <div className="space-y-2"><RequiredLabel htmlFor="garden-visit-days">{t('gardenManagement.fields.visitDays')}</RequiredLabel><Input id="garden-visit-days" value={visitDays} onChange={(event) => setVisitDays(event.target.value.replace(/[^\d,\s]/g, ''))} placeholder="1, 8, 15, 22" /></div>
      <div className="space-y-2"><RequiredLabel>{t('gardenManagement.fields.serviceTime')}</RequiredLabel><DateTimePicker date={serviceTime} setDate={(date) => date && setServiceTime(date)} mode="time" placeholder={t('gardenManagement.fields.serviceTime')} /></div>
      <div className="space-y-2 sm:col-span-2"><Label htmlFor="garden-contract-notes">{t('gardenManagement.fields.notes')}</Label><Textarea id="garden-contract-notes" rows={3} value={contractNotes} onChange={(event) => setContractNotes(event.target.value)} /></div>
    {validationAttempted && !validContractDays && <p className="text-sm text-destructive sm:col-span-2">{t('gardenManagement.validation.visitDays')}</p>}{validationAttempted && localDateOnly(contractEnd) < localDateOnly(contractStart) && <p className="text-sm text-destructive sm:col-span-2">{t('gardenManagement.validation.contractDates')}</p>}<p className="text-xs text-muted-foreground sm:col-span-2">{t('gardenManagement.hints.contractGeneration')}</p>
    </div></AppDialogBody><AppDialogFooter><Button type="button" variant="outline" disabled={saving} onClick={closeMainDialog}>{t('gardenManagement.actions.cancel')}</Button><Button type="button" disabled={saving || !contractSiteId || !contractNo.trim() || !validContractAmount || Number(visitsPerMonth) < 1 || !validContractDays || localDateOnly(contractEnd) < localDateOnly(contractStart)} onClick={saveContract}>{saving && <Clock3 className="me-2 h-4 w-4 animate-spin" />}{t(saving ? 'gardenManagement.actions.saving' : 'gardenManagement.actions.save')}</Button></AppDialogFooter></AppDialogContent></AppDialog>

    <GardenJobDialog open={dialog === 'job'} setOpen={(open) => { if (!open && !saving) setDialog(null); else if (open) setDialog('job') }} workspaceId={workspaceId} actorUserId={actorUserId} sites={sites} projects={projects} contracts={contracts} users={memberOptions} assignments={assignments} job={activeJob} onSaved={notify} />
    <CompletionDialog job={completionJob} open={completionOpen} setOpen={setCompletionOpen} workspaceId={workspaceId} userId={actorUserId} onSaved={notify} />
  </div>
}
