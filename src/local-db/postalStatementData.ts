import { postalStates, type PostalOrganization, type PostalState } from '@/postal/domain'
import type { PostalScope } from './postal'

export const postalStatementTables = [
  'postal_organizations', 'postal_shipments', 'postal_cod_records',
  'postal_delivery_fee_records', 'payment_transactions',
] as const
export type PostalStatementKind = 'all' | 'collection' | 'settlement' | 'delivery_fee'
export interface PostalStatementInput extends PostalScope {
  organizationId: string
  page: number
  pageSize: number
  start?: string
  end?: string
  search: string
  kind: PostalStatementKind
}
export interface PostalStatementEntry {
  id: string
  kind: Exclude<PostalStatementKind, 'all'>
  created_at: string
  shipment_id: string
  shipment_number: number
  shipment_created_at: string
  recipient_name: string
  primary_phone: string
  shipment_state: PostalState
  signed_amount: string
  debit: string
  credit: string
  balance: string
  payment_transaction_id: string
  payment_direction: 'incoming' | 'outgoing' | null
  payment_method: string | null
  account_name_snapshot: string | null
  notes: string | null
}
const moneyFields = [
  'opening_balance', 'debit_total', 'credit_total', 'closing_balance',
  'collections', 'settlements', 'delivery_fees', 'current_due_to',
  'current_due_from', 'recipient_due', 'recipient_refund_due',
] as const
export interface PostalStatement {
  organization: PostalOrganization
  entries: PostalStatementEntry[]
  total: number
  summary: Record<(typeof moneyFields)[number], string> & { missing_tariffs: number }
}
const invalid = () => new Error('postal_invalid_result')
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function money(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw invalid()
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw invalid()
  return value
}
function date(value: unknown): string {
  const result = text(value)
  if (!Number.isFinite(Date.parse(result))) throw invalid()
  return result
}
function nullableText(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') throw invalid()
  return value
}
export function normalizePostalOrganization(value: unknown, workspaceId: string): PostalOrganization {
  const row = record(value)
  if (row.workspace_id !== workspaceId) throw invalid()
  return {
    id: text(row.id), workspace_id: workspaceId, name: text(row.name),
    code: text(row.code), leader_id: text(row.leader_id),
  }
}
export function normalizePostalStatement(value: unknown, workspaceId: string, organizationId: string): PostalStatement {
  const data = record(value)
  const organization = normalizePostalOrganization(data.organization, workspaceId)
  if (organization.id !== organizationId || !Array.isArray(data.entries)
    || !Number.isSafeInteger(data.total) || Number(data.total) < data.entries.length) throw invalid()
  const rawSummary = record(data.summary)
  if (!Number.isSafeInteger(rawSummary.missing_tariffs) || Number(rawSummary.missing_tariffs) < 0) throw invalid()
  const summary: PostalStatement['summary'] = {
    ...Object.fromEntries(moneyFields.map((key) => [key, money(rawSummary[key])])) as Record<(typeof moneyFields)[number], string>,
    missing_tariffs: Number(rawSummary.missing_tariffs),
  }
  if (BigInt(summary.opening_balance) + BigInt(summary.credit_total) - BigInt(summary.debit_total) !== BigInt(summary.closing_balance)) throw invalid()
  const entries = data.entries.map((value): PostalStatementEntry => {
    const row = record(value)
    if (!['collection', 'settlement', 'delivery_fee'].includes(String(row.kind))
      || !postalStates.includes(row.shipment_state as PostalState)
      || !Number.isSafeInteger(row.shipment_number) || Number(row.shipment_number) <= 0
      || (row.payment_direction !== null && row.payment_direction !== 'incoming' && row.payment_direction !== 'outgoing')) throw invalid()
    const amount = money(row.signed_amount)
    const debit = money(row.debit)
    const credit = money(row.credit)
    const delta = row.kind === 'delivery_fee' ? 0n : BigInt(amount) * (row.kind === 'settlement' ? -1n : 1n)
    if (BigInt(amount) === 0n || BigInt(debit) !== (delta < 0n ? -delta : 0n)
      || BigInt(credit) !== (delta > 0n ? delta : 0n)) throw invalid()
    return {
      id: text(row.id), kind: row.kind as PostalStatementEntry['kind'],
      created_at: date(row.created_at), shipment_id: text(row.shipment_id),
      shipment_number: Number(row.shipment_number), shipment_created_at: date(row.shipment_created_at),
      recipient_name: text(row.recipient_name), primary_phone: text(row.primary_phone),
      shipment_state: row.shipment_state as PostalState, signed_amount: amount,
      debit, credit, balance: money(row.balance), payment_transaction_id: text(row.payment_transaction_id),
      payment_direction: row.payment_direction, payment_method: nullableText(row.payment_method),
      account_name_snapshot: nullableText(row.account_name_snapshot), notes: nullableText(row.notes),
    }
  })
  return { organization, entries, total: Number(data.total), summary }
}
export function canReadPostalStatement(scope: PostalScope) {
  return !!scope.workspaceId && !!scope.userId && (scope.role === 'admin'
    || (scope.role === 'office' && scope.permissionScope.split('|').includes('postService.officeEmployee')))
}
