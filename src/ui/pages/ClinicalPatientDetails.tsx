import { useTranslation } from 'react-i18next'
import { useClinicalPatient, useClinicalAppointmentsByPatient, calculateAge } from '@/local-db/clinicalAppointments'
import { Button } from '@/ui/components/button'
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components'
import { ArrowLeft } from 'lucide-react'
import { useRoute, useLocation } from 'wouter'

const STATUS_VARIANTS: Record<string, string> = {
  draft: 'secondary',
  booked: 'default',
  arrived: 'outline',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'destructive',
  no_show: 'destructive',
}

export function ClinicalPatientDetails() {
  const { t } = useTranslation()
  const [, params] = useRoute('/clinical-appointments/patients/:patientId')
  const [, navigate] = useLocation()
  const patient = useClinicalPatient(params?.patientId)
  const appointments = useClinicalAppointmentsByPatient(params?.patientId)

  if (!patient) {
    return (
      <div className="p-6">
        <div className="text-center text-muted-foreground py-12">
          {t('clinicalAppointments.patientNotFound', { defaultValue: 'Patient not found' })}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/clinical-appointments/patients')}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        {t('clinicalAppointments.backToPatients', { defaultValue: 'Back to Patients' })}
      </Button>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1 space-y-4">
          <div className="border rounded-lg p-4 space-y-3">
            <h2 className="text-lg font-semibold">{patient.name}</h2>
            {patient.phone && (
              <div className="text-sm">
                <span className="text-muted-foreground">{t('clinicalAppointments.phone', { defaultValue: 'Phone' })}:</span>
                <span className="ml-2">{patient.phone}</span>
              </div>
            )}
            {patient.birthYear && (
              <div className="text-sm">
                <span className="text-muted-foreground">{t('clinicalAppointments.age', { defaultValue: 'Age' })}:</span>
                <span className="ml-2">{calculateAge(patient.birthYear)}</span>
              </div>
            )}
            {patient.email && (
              <div className="text-sm">
                <span className="text-muted-foreground">{t('clinicalAppointments.email', { defaultValue: 'Email' })}:</span>
                <span className="ml-2">{patient.email}</span>
              </div>
            )}
            <div className="text-sm">
              <span className="text-muted-foreground">{t('clinicalAppointments.type', { defaultValue: 'Type' })}:</span>
              <Badge variant="outline" className="ml-2">
                {patient.isNewPatient
                  ? t('clinicalAppointments.newPatient', { defaultValue: 'New Patient' })
                  : t('clinicalAppointments.existingPatient', { defaultValue: 'Existing Patient' })}
              </Badge>
            </div>
            {patient.notes && (
              <div className="text-sm">
                <span className="text-muted-foreground">{t('clinicalAppointments.notes', { defaultValue: 'Notes' })}:</span>
                <p className="mt-1 text-sm">{patient.notes}</p>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              {t('clinicalAppointments.registeredOn', { defaultValue: 'Registered on' })}:{' '}
              {new Date(patient.createdAt).toLocaleDateString()}
            </div>
          </div>
        </div>

        <div className="md:col-span-2 space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('clinicalAppointments.appointmentHistory', { defaultValue: 'Appointment History' })} ({appointments?.length ?? 0})
          </h3>

          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('clinicalAppointments.date', { defaultValue: 'Date' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.time', { defaultValue: 'Time' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.type', { defaultValue: 'Type' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.status', { defaultValue: 'Status' })}</TableHead>
                  <TableHead>{t('clinicalAppointments.priority', { defaultValue: 'Priority' })}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!appointments || appointments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      {t('clinicalAppointments.noAppointments', { defaultValue: 'No appointments found' })}
                    </TableCell>
                  </TableRow>
                ) : (
                  appointments.map((appt) => (
                    <TableRow key={appt.id}>
                      <TableCell>{appt.appointmentDate}</TableCell>
                      <TableCell>{appt.startTime}</TableCell>
                      <TableCell className="capitalize">{t('clinicalAppointments.types.' + appt.appointmentType, {defaultValue: appt.appointmentType.replace(/_/g, ' ')})}</TableCell>
                      <TableCell>
                        <Badge variant={(STATUS_VARIANTS[appt.status] as any) ?? 'secondary'}>
                          {t('clinicalAppointments.statuses.' + appt.status, {defaultValue: appt.status.replace(/_/g, ' ')})}
                        </Badge>
                      </TableCell>
                      <TableCell className="capitalize">{t('clinicalAppointments.priorities.' + appt.priority, {defaultValue: appt.priority})}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  )
}
