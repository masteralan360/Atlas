import i18n from '@/i18n/config'
import packageJson from '../../package.json'

export interface IndexedDbDiagnosticContext {
  databaseName: string
  operation: string
  requestedStores: string[]
  expectedStores: string[]
  availableStores?: string[]
  expectedVersion: number
  physicalVersion?: number
  route?: string
}

export interface IndexedDbSchemaMismatchDetails extends IndexedDbDiagnosticContext {
  appVersion: string
  errorName: string
  missingStores: string[]
}

const DIAGNOSTIC_ERROR_NAME = 'AtlasIndexedDbSchemaMismatchError'
const MAX_VISIBLE_STORES = 12

function getErrorName(error: unknown) {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name
  }
  return 'Error'
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

function isObjectStoreNotFoundError(error: unknown) {
  if (error instanceof IndexedDbSchemaMismatchError) return true

  const name = getErrorName(error).toLowerCase()
  const message = getErrorMessage(error).toLowerCase()
  return name === 'notfounderror'
    || message.includes("failed to execute 'objectstore'")
    || (message.includes('object store') && message.includes('not found'))
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function formatStoreList(values: readonly string[]) {
  if (values.length === 0) return i18n.t('localDatabaseErrors.unknownStore')
  if (values.length <= MAX_VISIBLE_STORES) return values.join(', ')

  const visible = values.slice(0, MAX_VISIBLE_STORES).join(', ')
  return i18n.t('localDatabaseErrors.storeListOverflow', {
    stores: visible,
    count: values.length - MAX_VISIBLE_STORES,
  })
}

function normalizePhysicalVersion(version: number | undefined) {
  if (version === undefined || !Number.isFinite(version)) return undefined
  // Dexie maps schema versions to IndexedDB integer versions by multiplying by ten.
  return version % 10 === 0 ? version / 10 : version
}

export class IndexedDbSchemaMismatchError extends Error {
  readonly details: IndexedDbSchemaMismatchDetails

  constructor(message: string, details: IndexedDbSchemaMismatchDetails, cause: unknown) {
    super(message)
    this.name = DIAGNOSTIC_ERROR_NAME
    this.details = details
    ;(this as Error & { cause?: unknown }).cause = cause
  }
}

export function enrichIndexedDbError(error: unknown, context: IndexedDbDiagnosticContext): unknown {
  if (error instanceof IndexedDbSchemaMismatchError) return error

  const expectedStores = uniqueSorted(context.expectedStores)
  const requestedStores = uniqueSorted(context.requestedStores)
  const availableStores = context.availableStores ? uniqueSorted(context.availableStores) : undefined
  const missingExpectedStores = availableStores
    ? expectedStores.filter((store) => !availableStores.includes(store))
    : []
  const missingRequestedStores = availableStores
    ? requestedStores.filter((store) => !availableStores.includes(store))
    : []
  const missingStores = missingRequestedStores.length > 0 ? missingRequestedStores : missingExpectedStores

  if (!isObjectStoreNotFoundError(error)) return error

  const physicalVersion = normalizePhysicalVersion(context.physicalVersion)
  const details: IndexedDbSchemaMismatchDetails = {
    ...context,
    requestedStores,
    expectedStores,
    ...(availableStores ? { availableStores } : {}),
    ...(physicalVersion !== undefined ? { physicalVersion } : {}),
    appVersion: packageJson.version,
    errorName: getErrorName(error),
    missingStores,
  }

  const message = i18n.t('localDatabaseErrors.schemaMismatchDetails', {
    missingStores: formatStoreList(missingStores),
    databaseName: context.databaseName,
    physicalVersion: physicalVersion ?? i18n.t('localDatabaseErrors.unknownVersion'),
    expectedVersion: context.expectedVersion,
    operation: context.operation,
    requestedStores: formatStoreList(requestedStores),
    availableStoreCount: availableStores?.length ?? i18n.t('localDatabaseErrors.unknownVersion'),
    route: context.route || i18n.t('localDatabaseErrors.unknownRoute'),
    appVersion: packageJson.version,
    errorName: details.errorName,
  })

  return new IndexedDbSchemaMismatchError(message, details, error)
}
