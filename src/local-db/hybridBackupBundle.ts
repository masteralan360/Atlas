import type { LocalModeSqliteScope } from './localModeSqlite'

export const ATLAS_BACKUP_FORMAT = 'atlas-workspace-backup' as const
export const ATLAS_BACKUP_VERSION = 1 as const
export const ATLAS_BACKUP_EXTENSION = 'atlasbackup'
export const ATLAS_BACKUP_MIME_TYPE = 'application/vnd.atlas.workspace-backup+zip'

const MANIFEST_PATH = 'manifest.json'
const DATABASE_PATH = 'database/database.sqlite'
const ASSET_PATH_PREFIX = 'assets/sha256/'
const PWA_ASSET_RESTORE_ROLLBACK_PATH = 'manifest.restore-rollback.json'
const UTF8_FLAG = 0x0800
const LOCAL_FILE_HEADER = 0x04034b50
const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP_VERSION = 20

export const WORKSPACE_BACKUP_ASSET_FOLDERS = [
  'product-images',
  'profile-images',
  'workspace-logos',
  'attached-images',
  'activity-images',
  'agents-images',
  'clinic-attachments',
  'uploads',
  'printed-invoices',
  'general',
  'branding',
  'profiles',
] as const

export interface AtlasBackupAssetInput {
  relativePath: string
  data: Uint8Array
  mimeType?: string | null
}

export interface AtlasBackupManifestAsset {
  relativePath: string
  contentPath: string
  sha256: string
  byteLength: number
  mimeType: string | null
}

export interface AtlasBackupManifest {
  format: typeof ATLAS_BACKUP_FORMAT
  version: typeof ATLAS_BACKUP_VERSION
  createdAt: string
  workspaceId: string
  userId: string
  encryption: 'none'
  hashAlgorithm: 'SHA-256'
  database: {
    contentPath: typeof DATABASE_PATH
    sha256: string
    byteLength: number
  }
  assets: AtlasBackupManifestAsset[]
}

export interface CreatedAtlasBackupBundle {
  bytes: Uint8Array
  manifest: AtlasBackupManifest
}

export interface ReadAtlasBackupBundle {
  database: Uint8Array
  assets: AtlasBackupAssetInput[]
  manifest: AtlasBackupManifest
}

export interface WorkspaceAssetRestorePlan {
  /** Publish the staged asset generation after the replacement DB is healthy. */
  commit(): Promise<void>
  /** Restore the exact pre-commit asset mappings/files. Safe to call repeatedly. */
  rollback(): Promise<void>
  /** Mark the asset generation durable after the database replacement finalizes. */
  finalize(): Promise<void>
  /** Remove staging data when commit or rollback has reached a safe terminal state. */
  cleanup(): Promise<void>
}

interface ZipEntry {
  name: string
  data: Uint8Array
}

let crcTable: Uint32Array | null = null

function getCrcTable() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    crcTable[index] = value >>> 0
  }
  return crcTable
}

function crc32(data: Uint8Array) {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function getDosDateTime(date = new Date()) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function concatenate(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function createStoredZip(entries: ZipEntry[]) {
  if (entries.length > 0xffff) throw new Error('This backup contains too many files for the portable archive format.')
  const encoder = new TextEncoder()
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let localOffset = 0
  const dos = getDosDateTime()

  for (const entry of entries) {
    if (entry.data.byteLength > 0xffffffff) throw new Error(`Backup entry ${entry.name} is too large.`)
    const name = encoder.encode(entry.name)
    const checksum = crc32(entry.data)
    const localHeader = new Uint8Array(30 + name.byteLength)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, LOCAL_FILE_HEADER, true)
    localView.setUint16(4, ZIP_VERSION, true)
    localView.setUint16(6, UTF8_FLAG, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(10, dos.time, true)
    localView.setUint16(12, dos.date, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, entry.data.byteLength, true)
    localView.setUint32(22, entry.data.byteLength, true)
    localView.setUint16(26, name.byteLength, true)
    localView.setUint16(28, 0, true)
    localHeader.set(name, 30)
    localChunks.push(localHeader, entry.data)

    const centralHeader = new Uint8Array(46 + name.byteLength)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, CENTRAL_DIRECTORY_HEADER, true)
    centralView.setUint16(4, ZIP_VERSION, true)
    centralView.setUint16(6, ZIP_VERSION, true)
    centralView.setUint16(8, UTF8_FLAG, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, dos.time, true)
    centralView.setUint16(14, dos.date, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, entry.data.byteLength, true)
    centralView.setUint32(24, entry.data.byteLength, true)
    centralView.setUint16(28, name.byteLength, true)
    centralView.setUint16(30, 0, true)
    centralView.setUint16(32, 0, true)
    centralView.setUint16(34, 0, true)
    centralView.setUint16(36, 0, true)
    centralView.setUint32(38, 0, true)
    centralView.setUint32(42, localOffset, true)
    centralHeader.set(name, 46)
    centralChunks.push(centralHeader)

    localOffset += localHeader.byteLength + entry.data.byteLength
    if (localOffset > 0xffffffff) throw new Error('This backup is too large for the portable archive format.')
  }

  const centralDirectory = concatenate(centralChunks)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralDirectory.byteLength, true)
  endView.setUint32(16, localOffset, true)
  endView.setUint16(20, 0, true)
  return concatenate([...localChunks, centralDirectory, end])
}

function assertRange(data: Uint8Array, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.byteLength) {
    throw new Error('The backup archive is truncated or invalid.')
  }
}

function readStoredZip(data: Uint8Array) {
  const entries = new Map<string, Uint8Array>()
  const decoder = new TextDecoder()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0

  while (offset + 4 <= data.byteLength) {
    const signature = view.getUint32(offset, true)
    if (signature === CENTRAL_DIRECTORY_HEADER || signature === END_OF_CENTRAL_DIRECTORY) break
    if (signature !== LOCAL_FILE_HEADER) throw new Error('The selected file is not an Atlas backup archive.')
    assertRange(data, offset, 30)
    const flags = view.getUint16(offset + 6, true)
    const compression = view.getUint16(offset + 8, true)
    const expectedCrc = view.getUint32(offset + 14, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const uncompressedSize = view.getUint32(offset + 22, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    if ((flags & 0x0008) !== 0 || compression !== 0 || compressedSize !== uncompressedSize) {
      throw new Error('This Atlas backup uses an unsupported ZIP encoding.')
    }
    const nameOffset = offset + 30
    const contentOffset = nameOffset + nameLength + extraLength
    assertRange(data, nameOffset, nameLength)
    assertRange(data, contentOffset, compressedSize)
    const name = decoder.decode(data.subarray(nameOffset, nameOffset + nameLength))
    if (entries.has(name)) throw new Error(`The backup contains duplicate entry ${name}.`)
    const content = data.slice(contentOffset, contentOffset + compressedSize)
    if (crc32(content) !== expectedCrc) throw new Error(`The backup entry ${name} is corrupted.`)
    entries.set(name, content)
    offset = contentOffset + compressedSize
  }

  if (entries.size === 0) throw new Error('The selected file is not an Atlas backup archive.')
  return entries
}

function encodeHex(data: Uint8Array) {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Bytes(data: Uint8Array) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable on this device.')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource)
  return encodeHex(new Uint8Array(digest))
}

function normalizeRelativePath(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const segments = normalized.split('/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))
  ) {
    throw new Error(`Unsafe backup asset path: ${path}`)
  }
  return normalized
}

export function normalizeWorkspaceBackupAssetPath(path: string, workspaceId: string) {
  const normalized = normalizeRelativePath(path)
  const segments = normalized.split('/')
  if (
    !WORKSPACE_BACKUP_ASSET_FOLDERS.includes(segments[0] as typeof WORKSPACE_BACKUP_ASSET_FOLDERS[number]) ||
    segments[1] !== workspaceId ||
    segments.length < 3
  ) {
    throw new Error('The asset path is outside this workspace’s recovery sidecar.')
  }
  return normalized
}

function assertScope(scope: LocalModeSqliteScope) {
  if (!scope.workspaceId.trim() || !scope.userId.trim()) {
    throw new Error('A workspace and user are required to create or restore a backup.')
  }
}

function isManifest(value: unknown): value is AtlasBackupManifest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AtlasBackupManifest>
  return candidate.format === ATLAS_BACKUP_FORMAT &&
    candidate.version === ATLAS_BACKUP_VERSION &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.workspaceId === 'string' &&
    typeof candidate.userId === 'string' &&
    candidate.encryption === 'none' &&
    candidate.hashAlgorithm === 'SHA-256' &&
    !!candidate.database &&
    candidate.database.contentPath === DATABASE_PATH &&
    typeof candidate.database.sha256 === 'string' &&
    Number.isSafeInteger(candidate.database.byteLength) &&
    Array.isArray(candidate.assets)
}

export async function createAtlasBackupBundle(input: {
  scope: LocalModeSqliteScope
  database: Uint8Array
  assets?: AtlasBackupAssetInput[]
  createdAt?: string
}): Promise<CreatedAtlasBackupBundle> {
  assertScope(input.scope)
  if (input.database.byteLength === 0) throw new Error('The database backup is empty.')

  const databaseHash = await sha256Bytes(input.database)
  const assets: AtlasBackupManifestAsset[] = []
  const contentByHash = new Map<string, Uint8Array>()
  const seenPaths = new Set<string>()

  for (const asset of input.assets ?? []) {
    const relativePath = normalizeWorkspaceBackupAssetPath(asset.relativePath, input.scope.workspaceId)
    if (seenPaths.has(relativePath)) throw new Error(`Duplicate backup asset path: ${relativePath}`)
    seenPaths.add(relativePath)
    const hash = await sha256Bytes(asset.data)
    const contentPath = `${ASSET_PATH_PREFIX}${hash}`
    contentByHash.set(hash, asset.data)
    assets.push({
      relativePath,
      contentPath,
      sha256: hash,
      byteLength: asset.data.byteLength,
      mimeType: asset.mimeType ?? null,
    })
  }

  assets.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const manifest: AtlasBackupManifest = {
    format: ATLAS_BACKUP_FORMAT,
    version: ATLAS_BACKUP_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    workspaceId: input.scope.workspaceId,
    userId: input.scope.userId,
    encryption: 'none',
    hashAlgorithm: 'SHA-256',
    database: {
      contentPath: DATABASE_PATH,
      sha256: databaseHash,
      byteLength: input.database.byteLength,
    },
    assets,
  }

  const entries: ZipEntry[] = [
    { name: MANIFEST_PATH, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
    { name: DATABASE_PATH, data: input.database },
    ...Array.from(contentByHash.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([hash, data]) => ({ name: `${ASSET_PATH_PREFIX}${hash}`, data })),
  ]
  return { bytes: createStoredZip(entries), manifest }
}

export async function readAtlasBackupBundle(
  bytes: Uint8Array,
  expectedScope?: LocalModeSqliteScope | null,
): Promise<ReadAtlasBackupBundle> {
  const entries = readStoredZip(bytes)
  const manifestBytes = entries.get(MANIFEST_PATH)
  if (!manifestBytes) throw new Error('The Atlas backup manifest is missing.')
  let manifestValue: unknown
  try {
    manifestValue = JSON.parse(new TextDecoder().decode(manifestBytes))
  } catch {
    throw new Error('The Atlas backup manifest is invalid.')
  }
  if (!isManifest(manifestValue)) throw new Error('The Atlas backup format or version is unsupported.')
  const manifest = manifestValue

  if (expectedScope && (
    manifest.workspaceId !== expectedScope.workspaceId ||
    manifest.userId !== expectedScope.userId
  )) {
    throw new Error('This backup belongs to a different workspace or user.')
  }

  const database = entries.get(manifest.database.contentPath)
  if (!database) throw new Error('The Atlas backup database is missing.')
  if (database.byteLength !== manifest.database.byteLength || await sha256Bytes(database) !== manifest.database.sha256) {
    throw new Error('The Atlas backup database failed its integrity check.')
  }

  const seenPaths = new Set<string>()
  const assets: AtlasBackupAssetInput[] = []
  for (const item of manifest.assets) {
    if (!item || typeof item !== 'object') throw new Error('The Atlas backup asset manifest is invalid.')
    const relativePath = normalizeWorkspaceBackupAssetPath(item.relativePath, manifest.workspaceId)
    if (
      seenPaths.has(relativePath) ||
      item.contentPath !== `${ASSET_PATH_PREFIX}${item.sha256}` ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.byteLength) ||
      item.byteLength < 0 ||
      (item.mimeType !== null && typeof item.mimeType !== 'string')
    ) {
      throw new Error('The Atlas backup asset manifest is invalid.')
    }
    seenPaths.add(relativePath)
    const content = entries.get(item.contentPath)
    if (!content || content.byteLength !== item.byteLength || await sha256Bytes(content) !== item.sha256) {
      throw new Error(`Backup asset ${relativePath} failed its integrity check.`)
    }
    assets.push({ relativePath, data: content, mimeType: item.mimeType })
  }

  return { database, assets, manifest }
}

export function looksLikeAtlasBackupBundle(bytes: Uint8Array) {
  return bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === LOCAL_FILE_HEADER
}

function mimeTypeFromPath(path: string) {
  const extension = path.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    svg: 'image/svg+xml', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  }
  return extension ? types[extension] ?? 'application/octet-stream' : 'application/octet-stream'
}

export async function collectTauriWorkspaceBackupAssets(
  scope: LocalModeSqliteScope,
): Promise<AtlasBackupAssetInput[]> {
  assertScope(scope)
  const { readDir, readFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
  const assets: AtlasBackupAssetInput[] = []

  const visit = async (directory: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readDir>>
    try {
      entries = await readDir(directory, { baseDir: BaseDirectory.AppData })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.name) continue
      const path = `${directory}/${entry.name}`.replace(/\\/g, '/')
      if (entry.isDirectory) await visit(path)
      else if (entry.isFile) {
        assets.push({
          relativePath: path,
          data: await readFile(path, { baseDir: BaseDirectory.AppData }),
          mimeType: mimeTypeFromPath(path),
        })
      }
    }
  }

  for (const folder of WORKSPACE_BACKUP_ASSET_FOLDERS) {
    await visit(`${folder}/${scope.workspaceId}`)
  }
  return assets
}

function pwaAssetDirectoryPath(scope: LocalModeSqliteScope) {
  return ['atlas-backup-assets', encodeURIComponent(scope.workspaceId), encodeURIComponent(scope.userId)]
}

const pwaAssetWriteQueues = new Map<string, Promise<unknown>>()

function pwaAssetScopeKey(scope: LocalModeSqliteScope) {
  return `${scope.workspaceId}:${scope.userId}`
}

async function enqueuePwaAssetMutation<T>(
  scope: LocalModeSqliteScope,
  task: () => Promise<T>,
) {
  const key = pwaAssetScopeKey(scope)
  const previous = pwaAssetWriteQueues.get(key) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(task)
  pwaAssetWriteQueues.set(key, write)
  try {
    return await write
  } finally {
    if (pwaAssetWriteQueues.get(key) === write) pwaAssetWriteQueues.delete(key)
  }
}

async function getPwaAssetDirectory(scope: LocalModeSqliteScope, create: boolean) {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return null
  let directory: any = await navigator.storage.getDirectory()
  try {
    for (const segment of pwaAssetDirectoryPath(scope)) {
      directory = await directory.getDirectoryHandle(segment, { create })
    }
    return directory
  } catch (error) {
    if (!create && isPwaFileNotFoundError(error)) return null
    throw error
  }
}

export async function storePwaWorkspaceBackupAsset(
  scope: LocalModeSqliteScope,
  asset: AtlasBackupAssetInput,
) {
  return enqueuePwaAssetMutation(scope, async () => {
    const relativePath = normalizeWorkspaceBackupAssetPath(asset.relativePath, scope.workspaceId)
    const hash = await sha256Bytes(asset.data)
    const directory = await getPwaAssetDirectory(scope, true)
    if (!directory) throw new Error('Browser asset storage is unavailable.')
    const contentHandle = await directory.getFileHandle(hash, { create: true })
    const contentWritable = await contentHandle.createWritable()
    await contentWritable.write(asset.data)
    await contentWritable.close()

    const indexHandle = await directory.getFileHandle('manifest.json', { create: true })
    let index: Record<string, { sha256: string; mimeType: string | null }> = {}
    try {
      const parsed = JSON.parse(await (await indexHandle.getFile()).text()) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        index = parsed as Record<string, { sha256: string; mimeType: string | null }>
      }
    } catch {
      // First write or a recoverable index. Content objects remain immutable.
    }
    index[relativePath] = { sha256: hash, mimeType: asset.mimeType ?? null }
    const indexWritable = await indexHandle.createWritable()
    await indexWritable.write(JSON.stringify(index))
    await indexWritable.close()
    return hash
  })
}

export async function collectPwaWorkspaceBackupAssets(
  scope: LocalModeSqliteScope,
): Promise<AtlasBackupAssetInput[]> {
  await pwaAssetWriteQueues.get(pwaAssetScopeKey(scope))?.catch(() => undefined)
  const directory = await getPwaAssetDirectory(scope, false)
  if (!directory) return []
  let index: Record<string, { sha256: string; mimeType: string | null }>
  try {
    const handle = await directory.getFileHandle('manifest.json')
    index = JSON.parse(await (await handle.getFile()).text())
  } catch {
    return []
  }
  const result: AtlasBackupAssetInput[] = []
  for (const [relativePath, item] of Object.entries(index)) {
    normalizeWorkspaceBackupAssetPath(relativePath, scope.workspaceId)
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Browser asset metadata is invalid.')
    const handle = await directory.getFileHandle(item.sha256)
    const data = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    if (await sha256Bytes(data) !== item.sha256) throw new Error(`Browser asset ${relativePath} is corrupted.`)
    result.push({ relativePath, data, mimeType: item.mimeType })
  }
  return result
}

async function readPwaAssetIndexSnapshot(directory: any) {
  let handle: any
  try {
    handle = await directory.getFileHandle('manifest.json')
  } catch (error) {
    if (!isPwaFileNotFoundError(error)) throw error
    return {
      existed: false,
      text: '',
      index: {} as Record<string, { sha256: string; mimeType: string | null }>,
    }
  }
  const text = await (await handle.getFile()).text()
  let index: Record<string, { sha256: string; mimeType: string | null }> = {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      index = parsed as Record<string, { sha256: string; mimeType: string | null }>
    }
  } catch {
    // Preserve malformed pre-restore bytes for rollback, but do not merge them.
  }
  return { existed: true, text, index }
}

function isPwaFileNotFoundError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown }
  return candidate.name === 'NotFoundError' ||
    (typeof candidate.message === 'string' && /not found/i.test(candidate.message))
}

async function writePwaAssetIndex(directory: any, text: string) {
  const indexHandle = await directory.getFileHandle('manifest.json', { create: true })
  const writable = await indexHandle.createWritable()
  await writable.write(text)
  await writable.close()
}

async function restorePwaAssetIndexSnapshot(
  directory: any,
  snapshot: { existed: boolean; text: string },
) {
  if (snapshot.existed) {
    await writePwaAssetIndex(directory, snapshot.text)
    return
  }
  try {
    await directory.removeEntry('manifest.json')
  } catch (error) {
    // It may already be absent after a failed first write.
    if (!isPwaFileNotFoundError(error)) throw error
  }
}

interface PwaAssetRestoreRollback {
  version: 1
  workspaceId: string
  userId: string
  existed: boolean
  text: string
}

async function readPwaAssetRestoreRollback(
  directory: any,
  scope: LocalModeSqliteScope,
): Promise<PwaAssetRestoreRollback | null> {
  let handle: any
  try {
    handle = await directory.getFileHandle(PWA_ASSET_RESTORE_ROLLBACK_PATH)
  } catch (error) {
    if (isPwaFileNotFoundError(error)) return null
    throw error
  }
  const text = await (await handle.getFile()).text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The pending browser asset restore record is invalid.')
  }
  const candidate = parsed as Partial<PwaAssetRestoreRollback> | null
  if (
    !candidate
    || candidate.version !== 1
    || candidate.workspaceId !== scope.workspaceId
    || candidate.userId !== scope.userId
    || typeof candidate.existed !== 'boolean'
    || typeof candidate.text !== 'string'
  ) {
    throw new Error('The pending browser asset restore record has the wrong scope or format.')
  }
  return candidate as PwaAssetRestoreRollback
}

async function writePwaAssetRestoreRollback(
  directory: any,
  scope: LocalModeSqliteScope,
  snapshot: { existed: boolean; text: string },
) {
  if (await readPwaAssetRestoreRollback(directory, scope)) {
    throw new Error('A previous browser asset restore still requires recovery.')
  }
  const rollback: PwaAssetRestoreRollback = {
    version: 1,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    existed: snapshot.existed,
    text: snapshot.text,
  }
  const text = JSON.stringify(rollback)
  const handle = await directory.getFileHandle(PWA_ASSET_RESTORE_ROLLBACK_PATH, { create: true })
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
  const persisted = await (await handle.getFile()).text()
  if (persisted !== text) throw new Error('The browser asset rollback record failed verification.')
}

async function removePwaAssetRestoreRollback(directory: any) {
  try {
    await directory.removeEntry(PWA_ASSET_RESTORE_ROLLBACK_PATH)
  } catch (error) {
    if (!isPwaFileNotFoundError(error)) throw error
  }
}

/**
 * Reconcile the durable asset-manifest rollback record with the database
 * worker's recovery result before the workspace UI is allowed to mount.
 */
export async function reconcilePwaWorkspaceBackupAssetRestore(
  scope: LocalModeSqliteScope,
  databaseRecoveredPendingReplacement: boolean,
) {
  assertScope(scope)
  await enqueuePwaAssetMutation(scope, async () => {
    const directory = await getPwaAssetDirectory(scope, false)
    if (!directory) return
    const rollback = await readPwaAssetRestoreRollback(directory, scope)
    if (!rollback) return
    if (databaseRecoveredPendingReplacement) {
      await restorePwaAssetIndexSnapshot(directory, rollback)
    }
    await removePwaAssetRestoreRollback(directory)
  })
}

/**
 * Stage browser assets by hash without changing the active logical-path map.
 * The manifest swap is serialized and carries its own rollback snapshot.
 */
export async function stagePwaWorkspaceBackupAssets(
  scope: LocalModeSqliteScope,
  assets: AtlasBackupAssetInput[],
): Promise<WorkspaceAssetRestorePlan> {
  assertScope(scope)
  const staged = await enqueuePwaAssetMutation(scope, async () => {
    const directory = await getPwaAssetDirectory(scope, true)
    if (!directory) throw new Error('Browser asset storage is unavailable.')
    const index: Record<string, { sha256: string; mimeType: string | null }> = {}
    for (const asset of assets) {
      const relativePath = normalizeWorkspaceBackupAssetPath(asset.relativePath, scope.workspaceId)
      const hash = await sha256Bytes(asset.data)
      const contentHandle = await directory.getFileHandle(hash, { create: true })
      const writable = await contentHandle.createWritable()
      await writable.write(asset.data)
      await writable.close()
      const persisted = new Uint8Array(await (await contentHandle.getFile()).arrayBuffer())
      if (await sha256Bytes(persisted) !== hash) {
        throw new Error(`Browser asset ${relativePath} failed staging verification.`)
      }
      index[relativePath] = { sha256: hash, mimeType: asset.mimeType ?? null }
    }
    return { directory, index }
  })

  let snapshot: Awaited<ReturnType<typeof readPwaAssetIndexSnapshot>> | null = null
  let committed = false
  let finalized = false
  let rollbackComplete = true
  const rollback = async () => {
    await enqueuePwaAssetMutation(scope, async () => {
      const durableSnapshot = snapshot
        ?? await readPwaAssetRestoreRollback(staged.directory, scope)
      if (!durableSnapshot) return
      await restorePwaAssetIndexSnapshot(staged.directory, durableSnapshot)
      await removePwaAssetRestoreRollback(staged.directory)
      committed = false
      rollbackComplete = true
    })
  }

  return {
    async commit() {
      if (committed) return
      await enqueuePwaAssetMutation(scope, async () => {
        snapshot = await readPwaAssetIndexSnapshot(staged.directory)
        try {
          await writePwaAssetRestoreRollback(staged.directory, scope, snapshot)
          rollbackComplete = false
          const text = JSON.stringify(staged.index)
          await writePwaAssetIndex(staged.directory, text)
          const verified = await readPwaAssetIndexSnapshot(staged.directory)
          if (verified.text !== text) throw new Error('Browser asset manifest verification failed.')
          committed = true
        } catch (error) {
          await restorePwaAssetIndexSnapshot(staged.directory, snapshot)
          await removePwaAssetRestoreRollback(staged.directory)
          rollbackComplete = true
          throw error
        }
      })
    },
    rollback,
    async finalize() {
      finalized = true
      await enqueuePwaAssetMutation(scope, async () => {
        await removePwaAssetRestoreRollback(staged.directory)
        rollbackComplete = true
      })
    },
    async cleanup() {
      if (!rollbackComplete && !finalized) return
      if (finalized) {
        await enqueuePwaAssetMutation(scope, async () => {
          await removePwaAssetRestoreRollback(staged.directory)
          rollbackComplete = true
        })
      }
      // Content-addressed staging objects are safe, unreachable orphans until
      // a later backup references them; OPFS exposes no atomic generation GC.
    },
  }
}

/** Stage a complete native asset generation without touching live files. */
export async function stageTauriWorkspaceBackupAssets(
  scope: LocalModeSqliteScope,
  assets: AtlasBackupAssetInput[],
): Promise<WorkspaceAssetRestorePlan> {
  assertScope(scope)
  const stageRoot = `atlas-asset-restore-${crypto.randomUUID()}`
  const newRoot = `${stageRoot}/new`
  const oldRoot = `${stageRoot}/old`
  const {
    exists,
    mkdir,
    readFile,
    remove,
    rename,
    writeFile,
    BaseDirectory,
  } = await import('@tauri-apps/plugin-fs')
  let liveMutationStarted = false
  let finalized = false
  let rollbackComplete = true
  const movedFolders: Array<{
    target: string
    oldPath: string
    oldMoved: boolean
    newInstalled: boolean
  }> = []

  try {
    for (const asset of assets) {
      const relativePath = normalizeWorkspaceBackupAssetPath(asset.relativePath, scope.workspaceId)
      const stagedPath = `${newRoot}/${relativePath}`
      const lastSlash = stagedPath.lastIndexOf('/')
      await mkdir(stagedPath.slice(0, lastSlash), {
        baseDir: BaseDirectory.AppData,
        recursive: true,
      })
      await writeFile(stagedPath, asset.data, { baseDir: BaseDirectory.AppData })
      const persisted = await readFile(stagedPath, { baseDir: BaseDirectory.AppData })
      if (await sha256Bytes(persisted) !== await sha256Bytes(asset.data)) {
        throw new Error(`Native asset ${relativePath} failed staging verification.`)
      }
    }
  } catch (error) {
    await remove(stageRoot, { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => undefined)
    throw error
  }

  const rollback = async () => {
    if (!liveMutationStarted || rollbackComplete) return
    const errors: unknown[] = []
    for (const folder of [...movedFolders].reverse()) {
      try {
        if (folder.newInstalled) {
          if (await exists(folder.target, { baseDir: BaseDirectory.AppData })) {
            await remove(folder.target, {
              baseDir: BaseDirectory.AppData,
              recursive: true,
            })
          }
          folder.newInstalled = false
        }
        if (folder.oldMoved) {
          await rename(folder.oldPath, folder.target, {
            oldPathBaseDir: BaseDirectory.AppData,
            newPathBaseDir: BaseDirectory.AppData,
          })
          folder.oldMoved = false
        }
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) {
      const error = new Error('The previous native asset generation could not be fully restored.')
      ;(error as Error & { cause?: unknown }).cause = errors
      throw error
    }
    rollbackComplete = true
  }

  return {
    async commit() {
      if (liveMutationStarted && !rollbackComplete) return
      liveMutationStarted = true
      rollbackComplete = false
      try {
        for (const folderName of WORKSPACE_BACKUP_ASSET_FOLDERS) {
          const target = `${folderName}/${scope.workspaceId}`
          const stagedPath = `${newRoot}/${target}`
          const oldPath = `${oldRoot}/${target}`
          const state = { target, oldPath, oldMoved: false, newInstalled: false }
          movedFolders.push(state)

          if (await exists(target, { baseDir: BaseDirectory.AppData })) {
            await mkdir(`${oldRoot}/${folderName}`, {
              baseDir: BaseDirectory.AppData,
              recursive: true,
            })
            await rename(target, oldPath, {
              oldPathBaseDir: BaseDirectory.AppData,
              newPathBaseDir: BaseDirectory.AppData,
            })
            state.oldMoved = true
          }
          if (await exists(stagedPath, { baseDir: BaseDirectory.AppData })) {
            await mkdir(folderName, { baseDir: BaseDirectory.AppData, recursive: true })
            await rename(stagedPath, target, {
              oldPathBaseDir: BaseDirectory.AppData,
              newPathBaseDir: BaseDirectory.AppData,
            })
            state.newInstalled = true
          }
        }
      } catch (error) {
        await rollback()
        throw error
      }
    },
    rollback,
    async finalize() {
      finalized = true
    },
    async cleanup() {
      if (!finalized && !rollbackComplete) return
      await remove(stageRoot, { baseDir: BaseDirectory.AppData, recursive: true }).catch(() => undefined)
    },
  }
}

export async function restorePwaWorkspaceBackupAssets(
  scope: LocalModeSqliteScope,
  assets: AtlasBackupAssetInput[],
) {
  const plan = await stagePwaWorkspaceBackupAssets(scope, assets)
  try {
    await plan.commit()
    await plan.finalize()
  } finally {
    await plan.cleanup()
  }
}

export async function restoreTauriWorkspaceBackupAssets(
  scope: LocalModeSqliteScope,
  assets: AtlasBackupAssetInput[],
) {
  const plan = await stageTauriWorkspaceBackupAssets(scope, assets)
  try {
    await plan.commit()
    await plan.finalize()
  } finally {
    await plan.cleanup()
  }
}
