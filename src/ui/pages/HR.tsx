import { useEffect, useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useAuth } from '@/auth'
import { useTranslation } from 'react-i18next'
import { Plus, Search, Mail, Phone, Trash2, Edit, AlertTriangle, Loader2, MessageCircle, UserRoundPlus } from 'lucide-react'
import { useLocation } from 'wouter'
import { useWorkspace } from '@/workspace'
import { useEmployees, createEmployee, updateEmployee, deleteEmployee, useWorkspaceUsers } from '@/local-db'
import type { CurrencyCode, Employee } from '@/local-db'
import { platformService } from '@/services/platformService'
import { whatsappManager } from '@/lib/whatsappWebviewManager'
import {
    Button,
    Input,
    Card, CardContent,
    AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle,
    Label,
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
    Switch,
    CurrencySelector,
    DateTimePicker,
    useToast
} from '@/ui/components'
import { formatDate, formatCurrency, cn, formatNumericInput, parseFormattedNumber, sanitizeNumericInput } from '@/lib/utils'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { FireConfirmationModal } from '@/ui/components/FireConfirmationModal'

const ROLE_HIERARCHY: Record<string, string[]> = {
    'Management': ['Manager', 'Assistant Manager', 'Supervisor'],
    'Staff': ['Salesman', 'Cashier', 'Accountant', 'Security', 'Cleaning', 'Driver'],
    'Technical': ['IT Support', 'Maintenance', 'Developer']
}

const MIN_EMPLOYEE_JOINING_DATE = '1900-01-01'

type EmployeeRoleCategory = keyof typeof ROLE_HIERARCHY

const ROLE_CATEGORY_LABELS: Record<EmployeeRoleCategory, string> = {
    Management: 'hr.form.categories.management',
    Staff: 'hr.form.categories.staff',
    Technical: 'hr.form.categories.technical'
}

const ROLE_LABELS: Record<string, string> = {
    Manager: 'hr.form.roles.manager',
    'Assistant Manager': 'hr.form.roles.assistantManager',
    Supervisor: 'hr.form.roles.supervisor',
    Salesman: 'hr.form.roles.salesman',
    Cashier: 'hr.form.roles.cashier',
    Accountant: 'hr.form.roles.accountant',
    Security: 'hr.form.roles.security',
    Cleaning: 'hr.form.roles.cleaning',
    Driver: 'hr.form.roles.driver',
    'IT Support': 'hr.form.roles.itSupport',
    Maintenance: 'hr.form.roles.maintenance',
    Developer: 'hr.form.roles.developer'
}

function isValidEmployeeJoiningDate(value: string) {
    const today = formatDateInputValue(new Date())
    return /^\d{4}-\d{2}-\d{2}$/.test(value)
        && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
        && value >= MIN_EMPLOYEE_JOINING_DATE
        && value <= today
}

function formatDateInputValue(date: Date | undefined) {
    if (!date || Number.isNaN(date.getTime())) return ''

    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function toLocalDate(value: string | undefined) {
    if (!value) return undefined
    const date = new Date(`${value.slice(0, 10)}T00:00:00`)
    return Number.isNaN(date.getTime()) ? undefined : date
}

function isDayOfMonth(value: string) {
    const day = Number(value)
    return Number.isInteger(day) && day >= 1 && day <= 31
}

export default function HR() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin' || user?.role === 'staff'

    const { t } = useTranslation()
    const { toast } = useToast()
    const { activeWorkspace, features } = useWorkspace()
    const workspaceId = activeWorkspace?.id
    const employees = useEmployees(workspaceId)
    const [search, setSearch] = useState('')
    const [, setLocation] = useLocation()
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingEmployee, setEditingEmployee] = useState<Employee | undefined>(undefined)
    const workspaceUsers = useWorkspaceUsers(workspaceId)

    const [employeeName, setEmployeeName] = useState('')
    const [selectedCategory, setSelectedCategory] = useState<EmployeeRoleCategory | ''>('')
    const [selectedRole, setSelectedRole] = useState<string>('')
    const [hasDividends, setHasDividends] = useState(false)
    const [dividendType, setDividendType] = useState<'fixed' | 'percentage'>('fixed')
    const [salaryCurrency, setSalaryCurrency] = useState<CurrencyCode>((features.default_currency || 'usd') as CurrencyCode)
    const [dividendCurrency, setDividendCurrency] = useState<CurrencyCode>((features.default_currency || 'usd') as CurrencyCode)
    const [salaryPayday, setSalaryPayday] = useState('30')
    const [dividendPayday, setDividendPayday] = useState('30')
    const [joiningDate, setJoiningDate] = useState<Date | undefined>(() => new Date())
    const [salaryDisplay, setSalaryDisplay] = useState<string>('')
    const [dividendAmountDisplay, setDividendAmountDisplay] = useState<string>('')

    const [showLinkAccount, setShowLinkAccount] = useState(false)
    const [linkedUserId, setLinkedUserId] = useState<string | undefined>(undefined)

    // Confirmation Modals State
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
    const [isFireModalOpen, setIsFireModalOpen] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [confirmTarget, setConfirmTarget] = useState<Employee | undefined>(undefined)

    useEffect(() => {
        if (editingEmployee) {
            const [cat, role] = editingEmployee.role.includes(':')
                ? editingEmployee.role.split(':')
                : ['', editingEmployee.role]
            setEmployeeName(editingEmployee.name)
            setSelectedCategory((cat in ROLE_HIERARCHY ? cat : '') as EmployeeRoleCategory | '')
            setSelectedRole(role || editingEmployee.role || '')
            setHasDividends(editingEmployee.hasDividends || false)
            setDividendType(editingEmployee.dividendType || 'fixed')
            setSalaryCurrency((editingEmployee.salaryCurrency || features.default_currency || 'usd') as CurrencyCode)
            setDividendCurrency((editingEmployee.dividendCurrency || features.default_currency || 'usd') as CurrencyCode)
            setSalaryPayday(String(editingEmployee.salaryPayday ?? 30))
            setDividendPayday(String(editingEmployee.dividendPayday ?? 30))
            setJoiningDate(toLocalDate(editingEmployee.joiningDate))
            setSalaryDisplay(editingEmployee.salary === undefined ? '' : String(editingEmployee.salary))
            setDividendAmountDisplay(editingEmployee.dividendAmount === undefined ? '' : String(editingEmployee.dividendAmount))
            setShowLinkAccount(!!editingEmployee.linkedUserId)
            setLinkedUserId(editingEmployee.linkedUserId)
        } else if (isDialogOpen === false) {
            setEmployeeName('')
            setSelectedCategory('')
            setSelectedRole('')
            setHasDividends(false)
            setDividendType('fixed')
            setSalaryCurrency((features.default_currency || 'usd') as CurrencyCode)
            setDividendCurrency((features.default_currency || 'usd') as CurrencyCode)
            setSalaryPayday('30')
            setDividendPayday('30')
            setJoiningDate(new Date())
            setSalaryDisplay('')
            setDividendAmountDisplay('')
            setShowLinkAccount(false)
            setLinkedUserId(undefined)
        }
    }, [editingEmployee, isDialogOpen, features.default_currency])

    const filteredEmployees = useMemo(() => {
        return employees.filter(e =>
            e.name.toLowerCase().includes(search.toLowerCase()) ||
            e.role.toLowerCase().includes(search.toLowerCase()) ||
            e.email?.toLowerCase().includes(search.toLowerCase())
        )
    }, [employees, search])

    const othersTotalPercentage = useMemo(() => {
        return employees
            .filter(emp => emp.id !== editingEmployee?.id && emp.hasDividends && emp.dividendType === 'percentage' && !emp.isFired)
            .reduce((sum, emp) => sum + (emp.dividendAmount || 0), 0)
    }, [employees, editingEmployee])

    const availablePercentage = Math.max(0, 100 - othersTotalPercentage)

    const isEmployeeFormValid = Boolean(
        employeeName.trim()
        && selectedCategory
        && selectedRole
        && isValidEmployeeJoiningDate(formatDateInputValue(joiningDate))
        && salaryDisplay.trim()
        && Number.isFinite(parseFormattedNumber(salaryDisplay))
        && isDayOfMonth(salaryPayday)
        && (!showLinkAccount || linkedUserId)
        && (!hasDividends || (
            dividendAmountDisplay.trim()
            && Number.isFinite(parseFormattedNumber(dividendAmountDisplay))
            && isDayOfMonth(dividendPayday)
        ))
    )

    const handleEmployeeDialogOpenChange = (open: boolean) => {
        if (!open && isSaving) return

        setIsDialogOpen(open)
        if (!open) setEditingEmployee(undefined)
    }

    const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (!workspaceId || isSaving) return

        const formData = new FormData(e.currentTarget)
        const joiningDateValue = formatDateInputValue(joiningDate)
        const salary = parseFormattedNumber(salaryDisplay)
        const dividendAmount = parseFormattedNumber(dividendAmountDisplay)

        if (!isEmployeeFormValid) {
            toast({
                variant: 'destructive',
                description: t('hr.form.completeRequiredFields')
            })
            return
        }

        if (!isValidEmployeeJoiningDate(joiningDateValue)) {
            toast({
                variant: 'destructive',
                description: t('hr.invalidJoiningDate')
            })
            return
        }

        if (hasDividends && dividendType === 'percentage') {
            const newPercentage = parseFormattedNumber(dividendAmountDisplay)
            if (othersTotalPercentage + newPercentage > 100) {
                toast({
                    variant: 'destructive',
                    description: t('hr.dividendExceeds', { percentage: availablePercentage })
                })
                return
            }
        }
        const data = {
            name: employeeName.trim(),
            email: formData.get('email') as string,
            phone: formData.get('phone') as string,
            role: `${selectedCategory}:${selectedRole}`,
            gender: formData.get('gender') as 'male' | 'female' | 'other',
            location: formData.get('location') as string,
            joiningDate: joiningDateValue,
            salary,
            salaryCurrency,
            hasDividends,
            dividendType: hasDividends ? dividendType : undefined,
            dividendAmount: hasDividends ? dividendAmount : undefined,
            dividendCurrency: hasDividends ? dividendCurrency : undefined,
            salaryPayday: Number(salaryPayday),
            dividendPayday: hasDividends ? Number(dividendPayday) : undefined,
            isFired: editingEmployee?.isFired || false,
            linkedUserId: showLinkAccount ? linkedUserId : undefined
        }

        setIsSaving(true)

        try {
            if (editingEmployee) {
                await updateEmployee(editingEmployee.id, data)
                toast({ description: t('hr.updateSuccess', 'Employee updated successfully') })
            } else {
                await createEmployee(workspaceId, data)
                toast({ description: t('hr.addSuccess', 'Employee added successfully') })
            }
            setIsDialogOpen(false)
            setEditingEmployee(undefined)
        } catch (error) {
            console.error('Save error:', error)
            toast({ variant: 'destructive', description: t('common.error', 'Something went wrong') })
        } finally {
            setIsSaving(false)
        }
    }

    const handleDeleteClick = (employee: Employee) => {
        setConfirmTarget(employee)
        setIsDeleteModalOpen(true)
    }

    const handleConfirmDelete = async () => {
        if (!confirmTarget) return
        try {
            await deleteEmployee(confirmTarget.id)
            toast({ description: t('hr.deleteSuccess', 'Employee removed successfully') })
            setIsDeleteModalOpen(false)
            setConfirmTarget(undefined)
        } catch (error) {
            toast({ variant: 'destructive', description: t('common.error', 'Something went wrong') })
        }
    }

    const handleFireClick = (employee: Employee) => {
        setConfirmTarget(employee)
        setIsFireModalOpen(true)
    }

    const handleConfirmFire = async () => {
        if (!confirmTarget) return
        try {
            await updateEmployee(confirmTarget.id, { isFired: !confirmTarget.isFired })
            toast({ description: confirmTarget.isFired ? t('hr.rehireSuccess', 'Employee rehired') : t('hr.fireSuccess', 'Employee fired') })
            setIsFireModalOpen(false)
            setConfirmTarget(undefined)
        } catch (error) {
            toast({ variant: 'destructive', description: t('common.error', 'Something went wrong') })
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">{t('nav.hr', 'HR')}</h1>
                    <p className="text-muted-foreground">
                        {t('hr.subtitle', 'Manage your team and payroll')} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                {canEdit && (
                    <Button onClick={() => setIsDialogOpen(true)} className="gap-2">
                        <Plus className="w-4 h-4" />
                        {t('hr.addEmployee', 'Add Employee')}
                    </Button>
                )}
            </div>

            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                    placeholder={t('hr.searchPlaceholder', 'Search by name, role, or email...')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    allowViewer={true}
                    className="pl-10"
                />
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredEmployees.map((employee) => (
                    <Card key={employee.id} className={cn(
                        "group hover:border-primary/50 transition-all bg-secondary/20 overflow-hidden",
                        employee.isFired && "opacity-60 grayscale-[0.8] brightness-90"
                    )}>
                        {employee.isFired && (
                            <div className="absolute top-2 right-12 px-2 py-0.5 bg-destructive/10 text-destructive text-[10px] font-black uppercase rounded-full">
                                {t('hr.firedLabel', 'Suspended / Fired')}
                            </div>
                        )}
                        <CardContent className="p-6">
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary overflow-hidden">
                                        {(() => {
                                            const linkedUser = workspaceUsers.find(u => u.id === employee.linkedUserId);
                                            const profileUrl = linkedUser?.profileUrl;

                                            if (employee.linkedUserId && profileUrl) {
                                                return (
                                                    <img
                                                        src={platformService.convertFileSrc(profileUrl)}
                                                        className="w-full h-full object-cover"
                                                        alt={employee.name}
                                                        onError={(e) => {
                                                            (e.target as any).style.display = 'none';
                                                            (e.target as any).parentElement.innerHTML = `<span class="font-bold text-lg">${employee.name[0]}</span>`;
                                                        }}
                                                    />
                                                );
                                            }

                                            return <span className="font-bold text-lg">{employee.name[0]}</span>;
                                        })()}
                                    </div>
                                    <div>
                                        <div className="font-bold text-lg">{employee.name}</div>
                                        <div className="text-xs font-black uppercase tracking-widest text-primary/70">
                                            {employee.role.includes(':') ? employee.role.split(':')[1] : employee.role}
                                        </div>
                                        {employee.role.includes(':') && (
                                            <div className="text-[10px] text-muted-foreground/50 font-bold uppercase tracking-tighter -mt-0.5">
                                                {employee.role.split(':')[0]}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                {canEdit && (
                                    <div className="flex items-center gap-1 transition-opacity">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className={cn(employee.isFired ? "text-primary" : "text-destructive")}
                                            onClick={() => handleFireClick(employee)}
                                            title={employee.isFired ? t('hr.rehire', 'Rehire') : t('hr.fire', 'Suspended / Fire')}
                                        >
                                            <Plus className={cn("w-4 h-4", !employee.isFired && "rotate-45")} />
                                        </Button>
                                        <Button 
                                            variant="ghost" 
                                            size="icon" 
                                            onClick={() => {
                                                setEditingEmployee(employee)
                                                setIsDialogOpen(true)
                                            }}
                                            title={t('common.edit', 'Edit')}
                                        >
                                            <Edit className="w-4 h-4" />
                                        </Button>
                                        <Button 
                                            variant="ghost" 
                                            size="icon" 
                                            className="text-destructive hover:text-destructive" 
                                            onClick={() => handleDeleteClick(employee)}
                                            title={t('common.delete', 'Delete')}
                                            disabled={!canDelete}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                )}
                            </div>

                            <div className="mt-6 space-y-3">
                                {employee.email && (
                                    <div className="flex items-center gap-2 text-sm">
                                        <Mail className="w-4 h-4 text-muted-foreground" />
                                        <span>{employee.email}</span>
                                    </div>
                                )}
                                {employee.phone && (
                                    <div className="flex items-center justify-between gap-2 text-sm w-full group/phone">
                                        <div className="flex items-center gap-2">
                                            <Phone className="w-4 h-4 text-muted-foreground" />
                                            <span>{employee.phone}</span>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            allowViewer={true}
                                            className="h-6 w-6 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                if (employee.phone) {
                                                    void whatsappManager.openChat(employee.phone).catch((error) => {
                                                        console.error('[HR] Failed to open WhatsApp chat:', error)
                                                    })
                                                    setLocation('/whatsapp')
                                                }
                                            }}
                                            title="Open WhatsApp Chat"
                                        >
                                            <MessageCircle className="w-4 h-4" />
                                        </Button>
                                    </div>
                                )}
                                <div className="space-y-2 pt-4 border-t border-border/50">
                                    <div className="flex justify-between items-center">
                                        <div className="text-sm font-medium">
                                            <div className="text-muted-foreground text-xs">{t('hr.salary', 'Salary')}</div>
                                            <div className="text-primary font-bold">
                                                {formatCurrency(employee.salary, employee.salaryCurrency, features.iqd_display_preference)}
                                            </div>
                                        </div>
                                        <div className="text-sm text-end">
                                            <div className="text-muted-foreground text-xs">{t('hr.joined', 'Joined')}</div>
                                            <div className="font-medium">{formatDate(employee.joiningDate)}</div>
                                        </div>
                                    </div>

                                    {employee.hasDividends && employee.dividendAmount && employee.dividendAmount > 0 && (
                                        <div className="flex justify-between items-center pt-2 border-t border-dashed border-border/30">
                                            <div className="text-[10px] font-black uppercase text-muted-foreground opacity-60">
                                                {t('hr.dividends', 'Dividends / Equity')}
                                            </div>
                                            <div className="text-xs font-bold text-primary italic">
                                                {employee.dividendType === 'percentage'
                                                    ? `${employee.dividendAmount}%`
                                                    : formatCurrency(employee.dividendAmount, employee.dividendCurrency, features.iqd_display_preference)}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            <AppDialog open={isDialogOpen} onOpenChange={handleEmployeeDialogOpenChange}>
                <AppDialogContent className="max-w-3xl" showCloseButton={!isSaving}>
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <UserRoundPlus className="h-5 w-5 text-primary" />
                            {editingEmployee ? t('hr.editEmployee') : t('hr.addEmployee')}
                        </AppDialogTitle>
                    </AppDialogHeader>
                    <AppDialogBody>
                        <form id="employee-form" onSubmit={handleSave} className="space-y-5">
                            <div className="grid gap-5 md:grid-cols-2">
                                <div className="space-y-2 md:col-span-2">
                                    <Label htmlFor="employee-name">{t('hr.form.name')} *</Label>
                                    <Input
                                        id="employee-name"
                                        name="name"
                                        value={employeeName}
                                        onChange={(event) => setEmployeeName(event.target.value)}
                                        disabled={isSaving}
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>{t('hr.form.category')} *</Label>
                                    <Select
                                        value={selectedCategory}
                                        onValueChange={(value) => {
                                            setSelectedCategory(value as EmployeeRoleCategory)
                                            setSelectedRole('')
                                            if (value !== 'Management') setHasDividends(false)
                                        }}
                                        disabled={isSaving}
                                    >
                                        <SelectTrigger>
                                            <SelectValue placeholder={t('hr.form.selectCategory')} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {(Object.keys(ROLE_HIERARCHY) as EmployeeRoleCategory[]).map((category) => (
                                                <SelectItem key={category} value={category}>{t(ROLE_CATEGORY_LABELS[category])}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label>{t('hr.form.role')} *</Label>
                                    <Select
                                        value={selectedRole}
                                        onValueChange={setSelectedRole}
                                        disabled={!selectedCategory || isSaving}
                                    >
                                        <SelectTrigger>
                                            <SelectValue placeholder={t('hr.form.selectRole')} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {(ROLE_HIERARCHY[selectedCategory] || []).map((role) => (
                                                <SelectItem key={role} value={role}>{t(ROLE_LABELS[role])}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="employee-gender">{t('hr.form.gender')}</Label>
                                    <Select name="gender" defaultValue={editingEmployee?.gender || 'male'} disabled={isSaving}>
                                        <SelectTrigger id="employee-gender">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="male">{t('hr.form.male')}</SelectItem>
                                            <SelectItem value="female">{t('hr.form.female')}</SelectItem>
                                            <SelectItem value="other">{t('hr.form.other')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="employee-email">{t('hr.form.email')}</Label>
                                    <Input id="employee-email" name="email" type="email" defaultValue={editingEmployee?.email} disabled={isSaving} />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="employee-phone">{t('hr.form.phone')}</Label>
                                    <Input id="employee-phone" name="phone" defaultValue={editingEmployee?.phone} disabled={isSaving} />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="employee-joining-date">{t('hr.form.joiningDate')} *</Label>
                                    <DateTimePicker
                                        id="employee-joining-date"
                                        mode="date"
                                        date={joiningDate}
                                        setDate={setJoiningDate}
                                        disabled={isSaving}
                                        placeholder={t('hr.form.selectJoiningDate')}
                                        calendarProps={{
                                            disabled: {
                                                before: new Date(1900, 0, 1),
                                                after: new Date()
                                            }
                                        }}
                                    />
                                </div>
                                <div className="space-y-2 md:col-span-2">
                                    <Label htmlFor="employee-salary">{t('hr.form.salary')} *</Label>
                                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
                                        <Input
                                            id="employee-salary"
                                            inputMode="decimal"
                                            value={formatNumericInput(salaryDisplay)}
                                            onChange={(event) => setSalaryDisplay(sanitizeNumericInput(event.target.value, { allowDecimal: true }))}
                                            placeholder="0"
                                            disabled={isSaving}
                                            required
                                        />
                                        <CurrencySelector
                                            value={salaryCurrency}
                                            onChange={setSalaryCurrency}
                                            iqdDisplayPreference={features.iqd_display_preference}
                                            disabled={isSaving}
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="employee-salary-payday">{t('hr.form.salaryPayday')} *</Label>
                                    <Input
                                        id="employee-salary-payday"
                                        inputMode="numeric"
                                        value={salaryPayday}
                                        onChange={(event) => setSalaryPayday(sanitizeNumericInput(event.target.value, { allowDecimal: false }))}
                                        placeholder="0"
                                        disabled={isSaving}
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="employee-location">{t('hr.form.location')}</Label>
                                    <Input id="employee-location" name="location" defaultValue={editingEmployee?.location} disabled={isSaving} />
                                </div>

                                <div className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4 md:col-span-2">
                                    <div className="flex items-center justify-between gap-4">
                                        <div className="space-y-0.5">
                                            <Label className="text-sm font-bold uppercase tracking-wider text-primary">{t('hr.form.linkAccount')}</Label>
                                            <p className="text-xs text-muted-foreground">{t('hr.form.linkAccountDesc')}</p>
                                        </div>
                                        <Switch checked={showLinkAccount} onCheckedChange={(value) => {
                                            setShowLinkAccount(value)
                                            if (!value) setLinkedUserId(undefined)
                                        }} disabled={isSaving} />
                                    </div>

                                    {showLinkAccount && (
                                        <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                                            <Label>{t('hr.form.selectMember')} *</Label>
                                            <Select value={linkedUserId} onValueChange={setLinkedUserId} disabled={isSaving}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder={t('hr.form.selectMember')} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {workspaceUsers.map((workspaceUser) => (
                                                        <SelectItem key={workspaceUser.id} value={workspaceUser.id}>
                                                            {workspaceUser.name}{workspaceUser.email ? ` (${workspaceUser.email})` : ''}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </div>

                                {selectedCategory === 'Management' && (
                                    <div className="space-y-4 rounded-xl border border-border/50 bg-muted/30 p-4 md:col-span-2">
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="space-y-0.5">
                                                <Label className="text-sm font-bold uppercase tracking-wider">{t('hr.form.dividends')}</Label>
                                                <p className="text-xs text-muted-foreground">{t('hr.form.dividendDesc')}</p>
                                            </div>
                                            <Switch checked={hasDividends} onCheckedChange={setHasDividends} disabled={isSaving} />
                                        </div>

                                        {hasDividends && (
                                            <div className="grid gap-5 animate-in fade-in slide-in-from-top-1 duration-200 md:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label>{t('hr.form.dividendType')}</Label>
                                                    <Select value={dividendType} onValueChange={(value) => setDividendType(value as 'fixed' | 'percentage')} disabled={isSaving}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="fixed">{t('hr.form.fixedValue')}</SelectItem>
                                                            <SelectItem value="percentage">{t('hr.form.percentageValue')}</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="employee-dividend-payday">{t('hr.form.payday')} *</Label>
                                                    <Input
                                                        id="employee-dividend-payday"
                                                        inputMode="numeric"
                                                        value={dividendPayday}
                                                        onChange={(event) => setDividendPayday(sanitizeNumericInput(event.target.value, { allowDecimal: false }))}
                                                        placeholder="0"
                                                        disabled={isSaving}
                                                        required
                                                    />
                                                </div>
                                                <div className="space-y-2 md:col-span-2">
                                                    <Label htmlFor="employee-dividend-amount">{t('hr.form.amount')} *</Label>
                                                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
                                                        <Input
                                                            id="employee-dividend-amount"
                                                            inputMode={dividendType === 'percentage' ? 'numeric' : 'decimal'}
                                                            value={formatNumericInput(dividendAmountDisplay)}
                                                            onChange={(event) => setDividendAmountDisplay(sanitizeNumericInput(event.target.value, { allowDecimal: dividendType !== 'percentage' }))}
                                                            placeholder="0"
                                                            disabled={isSaving}
                                                            required
                                                        />
                                                        {dividendType === 'percentage' ? (
                                                            <div className="flex h-10 items-center justify-center rounded-xl border bg-muted text-sm font-bold">%</div>
                                                        ) : (
                                                            <CurrencySelector
                                                                value={dividendCurrency}
                                                                onChange={setDividendCurrency}
                                                                iqdDisplayPreference={features.iqd_display_preference}
                                                                disabled={isSaving}
                                                            />
                                                        )}
                                                    </div>
                                                    {dividendType === 'percentage' && (
                                                        <div className={cn(
                                                            'mt-1.5 flex items-center gap-1.5 text-xs font-medium',
                                                            availablePercentage <= 0 ? 'text-destructive' : 'text-muted-foreground'
                                                        )}>
                                                            {availablePercentage <= 0 ? (
                                                                <><AlertTriangle className="h-3.5 w-3.5" /> {t('hr.noPercentageLeft')}</>
                                                            ) : (
                                                                t('hr.availablePercentage', { percentage: availablePercentage })
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </form>
                    </AppDialogBody>
                    <AppDialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleEmployeeDialogOpenChange(false)} disabled={isSaving}>
                            {t('common.cancel')}
                        </Button>
                        <Button type="submit" form="employee-form" disabled={isSaving || !isEmployeeFormValid}>
                            {isSaving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                            {isSaving ? t('common.saving') : editingEmployee ? t('hr.updateEmployee') : t('common.save')}
                        </Button>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>

            <DeleteConfirmationModal
                isOpen={isDeleteModalOpen}
                onClose={() => {
                    setIsDeleteModalOpen(false)
                    setConfirmTarget(undefined)
                }}
                onConfirm={handleConfirmDelete}
                itemName={confirmTarget?.name}
                title={t('hr.deleteTitle', 'Remove Employee')}
                description={t('hr.deleteWarning', 'This will permanently remove this employee from the records. This action cannot be undone.')}
            />

            <FireConfirmationModal
                isOpen={isFireModalOpen}
                onClose={() => {
                    setIsFireModalOpen(false)
                    setConfirmTarget(undefined)
                }}
                onConfirm={handleConfirmFire}
                employeeName={confirmTarget?.name || ''}
                isFired={confirmTarget?.isFired || false}
            />
        </div>
    )
}
