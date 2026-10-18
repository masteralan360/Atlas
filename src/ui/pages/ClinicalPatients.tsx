import { useState, useMemo } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/AuthContext'
import { useClinicalPatients } from '@/local-db/clinicalAppointments'
import { calculateAge } from '@/local-db/clinicalAppointments'
import { useLocation } from 'wouter'
import { Input } from '@/ui/components/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components'
import { Search } from 'lucide-react'

export function ClinicalPatients() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const workspaceId = user?.workspaceId ?? ''
  const patients = useClinicalPatients(workspaceId)
  const [searchQuery, setSearchQuery] = useState('')
  const [, navigate] = useLocation()

  const filtered = useMemo(() => {
    if (!patients) return []
    if (!searchQuery.trim()) return patients
    const q = searchQuery.toLowerCase()
    return patients.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.phone && p.phone.includes(q))
    )
  }, [patients, searchQuery])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('clinicalAppointments.patients', { defaultValue: 'Patients' })}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('clinicalAppointments.patientsSubtitle', { defaultValue: 'View and manage patient records' })} <ModulePageFreshness className="ms-2" />
        </p>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={t('clinicalAppointments.searchPatient', { defaultValue: 'Search patients...' })}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('clinicalAppointments.patientName', { defaultValue: 'Name' })}</TableHead>
              <TableHead>{t('clinicalAppointments.age', { defaultValue: 'Age' })}</TableHead>
              <TableHead>{t('clinicalAppointments.phone', { defaultValue: 'Phone' })}</TableHead>
              <TableHead>{t('clinicalAppointments.type', { defaultValue: 'Type' })}</TableHead>
              <TableHead>{t('clinicalAppointments.createdAt', { defaultValue: 'Created' })}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground py-12">
                  {t('clinicalAppointments.noPatients', { defaultValue: 'No patients found' })}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((patient) => (
                <TableRow
                  key={patient.id}
                  className="cursor-pointer hover:bg-accent/50"
                  onClick={() => navigate(`/clinical-appointments/patients/${patient.id}`)}
                >
                  <TableCell className="font-medium">{patient.name}</TableCell>
                  <TableCell>{calculateAge(patient.birthYear) ?? '—'}</TableCell>
                  <TableCell>{patient.phone ?? '—'}</TableCell>
                  <TableCell>
                    {patient.isNewPatient
                      ? t('clinicalAppointments.newPatient', { defaultValue: 'New Patient' })
                      : t('clinicalAppointments.existingPatient', { defaultValue: 'Existing Patient' })}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(patient.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
