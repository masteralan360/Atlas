import {
  CalendarClock,
  CreditCard,
  Database,
  FileText,
  HandCoins,
  ListOrdered,
  Waypoints,
  Warehouse
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditCategory } from '@/lib/integrityAudit/types'
import { cn } from '@/lib/utils'

const categoryIcons = {
  order: FileText,
  items: ListOrdered,
  inventory: Warehouse,
  payments: CreditCard,
  loan: HandCoins,
  installments: CalendarClock,
  relationships: Waypoints,
  mirror: Database
} satisfies Record<AuditCategory, LucideIcon>

export function IntegrityAuditCategoryIcon({ category, className }: { category: AuditCategory; className?: string }) {
  const Icon = categoryIcons[category]
  return <Icon className={cn('h-4 w-4 shrink-0 text-muted-foreground', className)} aria-hidden="true" />
}
