import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ATLAS_BACKUP_FORMAT,
  createAtlasBackupBundle,
  looksLikeAtlasBackupBundle,
  readAtlasBackupBundle,
  collectPwaWorkspaceBackupAssets,
  reconcilePwaWorkspaceBackupAssetRestore,
  stagePwaWorkspaceBackupAssets,
  storePwaWorkspaceBackupAsset,
} from './hybridBackupBundle'

const scope = {
  workspaceId: '10000000-0000-0000-0000-000000000001',
  userId: '20000000-0000-0000-0000-000000000002',
}

function bytes(value: string) {
  return new TextEncoder().encode(value)
}

class MemoryFile {
  data = new Uint8Array()
  async getFile() {
    const snapshot = this.data.slice()
    return {
      text: async () => new TextDecoder().decode(snapshot),
      arrayBuffer: async () => snapshot.buffer,
    }
  }
  async createWritable() {
    return {
      write: async (value: string | Uint8Array) => {
        this.data = typeof value === 'string' ? bytes(value) : value.slice()
      },
      close: async () => undefined,
    }
  }
}

class MemoryDirectory {
  directories = new Map<string, MemoryDirectory>()
  files = new Map<string, MemoryFile>()
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let directory = this.directories.get(name)
    if (!directory && options?.create) {
      directory = new MemoryDirectory()
      this.directories.set(name, directory)
    }
    if (!directory) throw new Error('Directory not found')
    return directory
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name)
    if (!file && options?.create) {
      file = new MemoryFile()
      this.files.set(name, file)
    }
    if (!file) throw new Error('File not found')
    return file
  }
  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.directories.delete(name)) {
      throw new Error('Entry not found')
    }
  }
}

function installMemoryOpfs() {
  const root = new MemoryDirectory()
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } })
  return root
}

describe('Atlas workspace backup bundle', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('round-trips a scoped database and a content-addressed asset sidecar', async () => {
    const sharedContent = bytes('same image bytes')
    const created = await createAtlasBackupBundle({
      scope,
      database: bytes('SQLite format 3\0database payload'),
      createdAt: '2026-09-14T10:00:00.000Z',
      assets: [
        {
          relativePath: `${'product-images'}/${scope.workspaceId}/first.png`,
          data: sharedContent,
          mimeType: 'image/png',
        },
        {
          relativePath: `workspace-logos/${scope.workspaceId}/logo.png`,
          data: sharedContent,
          mimeType: 'image/png',
        },
      ],
    })

    expect(looksLikeAtlasBackupBundle(created.bytes)).toBe(true)
    expect(created.manifest).toMatchObject({
      format: ATLAS_BACKUP_FORMAT,
      version: 1,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      encryption: 'none',
      hashAlgorithm: 'SHA-256',
    })
    expect(created.manifest.assets[0].contentPath).toBe(created.manifest.assets[1].contentPath)

    const restored = await readAtlasBackupBundle(created.bytes, scope)
    expect(new TextDecoder().decode(restored.database)).toBe('SQLite format 3\0database payload')
    expect(restored.assets).toHaveLength(2)
    expect(restored.assets.map((asset) => asset.relativePath)).toEqual([
      `product-images/${scope.workspaceId}/first.png`,
      `workspace-logos/${scope.workspaceId}/logo.png`,
    ])
  })

  it('refuses to restore a backup into another workspace/user database', async () => {
    const created = await createAtlasBackupBundle({
      scope,
      database: bytes('database'),
    })

    await expect(readAtlasBackupBundle(created.bytes, {
      workspaceId: scope.workspaceId,
      userId: 'different-user',
    })).rejects.toThrow('different workspace or user')
  })

  it('detects corruption before returning database or asset bytes', async () => {
    const created = await createAtlasBackupBundle({
      scope,
      database: bytes('database bytes'),
      assets: [{
        relativePath: `attached-images/${scope.workspaceId}/proof.png`,
        data: bytes('asset bytes that must survive'),
      }],
    })
    const corrupted = created.bytes.slice()
    const marker = bytes('asset bytes that must survive')
    let offset = -1
    outer: for (let index = 0; index <= corrupted.length - marker.length; index += 1) {
      for (let byteIndex = 0; byteIndex < marker.length; byteIndex += 1) {
        if (corrupted[index + byteIndex] !== marker[byteIndex]) continue outer
      }
      offset = index
      break
    }
    expect(offset).toBeGreaterThanOrEqual(0)
    corrupted[offset] ^= 0xff

    await expect(readAtlasBackupBundle(corrupted, scope)).rejects.toThrow(/corrupt|integrity/i)
  })

  it('rejects paths which could escape the AppData asset root', async () => {
    await expect(createAtlasBackupBundle({
      scope,
      database: bytes('database'),
      assets: [{ relativePath: '../outside.txt', data: bytes('no') }],
    })).rejects.toThrow('Unsafe backup asset path')
  })

  it('serializes concurrent PWA sidecar index updates without losing assets', async () => {
    installMemoryOpfs()
    await Promise.all([
      storePwaWorkspaceBackupAsset(scope, {
        relativePath: `product-images/${scope.workspaceId}/one.png`,
        data: bytes('one'),
      }),
      storePwaWorkspaceBackupAsset(scope, {
        relativePath: `workspace-logos/${scope.workspaceId}/two.png`,
        data: bytes('two'),
      }),
    ])

    const assets = await collectPwaWorkspaceBackupAssets(scope)
    expect(assets.map((asset) => asset.relativePath).sort()).toEqual([
      `product-images/${scope.workspaceId}/one.png`,
      `workspace-logos/${scope.workspaceId}/two.png`,
    ])
  })

  it('keeps PWA asset mappings unchanged until commit and restores them on rollback', async () => {
    installMemoryOpfs()
    const firstPath = `product-images/${scope.workspaceId}/one.png`
    const secondPath = `workspace-logos/${scope.workspaceId}/two.png`
    await storePwaWorkspaceBackupAsset(scope, { relativePath: firstPath, data: bytes('old-one') })
    await storePwaWorkspaceBackupAsset(scope, { relativePath: secondPath, data: bytes('old-two') })

    const plan = await stagePwaWorkspaceBackupAssets(scope, [
      { relativePath: firstPath, data: bytes('restored-one'), mimeType: 'image/png' },
    ])

    let active = await collectPwaWorkspaceBackupAssets(scope)
    expect(active.map((asset) => asset.relativePath).sort()).toEqual([firstPath, secondPath])
    expect(new TextDecoder().decode(active.find((asset) => asset.relativePath === firstPath)!.data))
      .toBe('old-one')

    await plan.commit()
    active = await collectPwaWorkspaceBackupAssets(scope)
    expect(active.map((asset) => asset.relativePath)).toEqual([firstPath])
    expect(new TextDecoder().decode(active[0].data)).toBe('restored-one')

    await plan.rollback()
    active = await collectPwaWorkspaceBackupAssets(scope)
    expect(active.map((asset) => asset.relativePath).sort()).toEqual([firstPath, secondPath])
    expect(new TextDecoder().decode(active.find((asset) => asset.relativePath === firstPath)!.data))
      .toBe('old-one')
    await plan.cleanup()
  })

  it('durably restores the prior asset manifest when SQLite recovers after a crash', async () => {
    installMemoryOpfs()
    const firstPath = `product-images/${scope.workspaceId}/one.png`
    const secondPath = `workspace-logos/${scope.workspaceId}/two.png`
    await storePwaWorkspaceBackupAsset(scope, { relativePath: firstPath, data: bytes('old-one') })
    await storePwaWorkspaceBackupAsset(scope, { relativePath: secondPath, data: bytes('old-two') })

    const plan = await stagePwaWorkspaceBackupAssets(scope, [
      { relativePath: firstPath, data: bytes('new-one'), mimeType: 'image/png' },
    ])
    await plan.commit()

    await reconcilePwaWorkspaceBackupAssetRestore(scope, true)
    const active = await collectPwaWorkspaceBackupAssets(scope)
    expect(active.map((asset) => asset.relativePath).sort()).toEqual([firstPath, secondPath])
    expect(new TextDecoder().decode(active.find((asset) => asset.relativePath === firstPath)!.data))
      .toBe('old-one')
  })

  it('keeps the new asset manifest when SQLite finalized before a crash', async () => {
    installMemoryOpfs()
    const firstPath = `product-images/${scope.workspaceId}/one.png`
    await storePwaWorkspaceBackupAsset(scope, { relativePath: firstPath, data: bytes('old-one') })

    const plan = await stagePwaWorkspaceBackupAssets(scope, [
      { relativePath: firstPath, data: bytes('new-one'), mimeType: 'image/png' },
    ])
    await plan.commit()

    await reconcilePwaWorkspaceBackupAssetRestore(scope, false)
    const active = await collectPwaWorkspaceBackupAssets(scope)
    expect(active).toHaveLength(1)
    expect(new TextDecoder().decode(active[0].data)).toBe('new-one')
  })
})
