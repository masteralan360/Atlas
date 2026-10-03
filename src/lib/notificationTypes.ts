export const WORKSPACE_NOTIFICATION_TYPES = [
    'marketplace_order_pending',
    'order_approval_request',
    'order_approval_approved',
    'loan_installment_overdue',
    'expense_item_overdue',
    'payroll_overdue',
    'inventory_low_stock',
    'garden_job_assigned',
    'garden_job_rescheduled',
    'garden_job_completed',
] as const

export type WorkspaceNotificationType = typeof WORKSPACE_NOTIFICATION_TYPES[number]

const WORKSPACE_NOTIFICATION_TYPE_SET = new Set<string>(WORKSPACE_NOTIFICATION_TYPES)

export function isWorkspaceNotificationType(value: unknown): value is WorkspaceNotificationType {
    return typeof value === 'string' && WORKSPACE_NOTIFICATION_TYPE_SET.has(value)
}
