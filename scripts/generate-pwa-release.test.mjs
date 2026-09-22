import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPwaReleaseAssets, createPwaRelease } from './generate-pwa-release.mjs'

const temporaryDirectories = []

function fixture() {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'atlas-pwa-release-test-'))
    temporaryDirectories.push(workspaceRoot)
    const outputDirectory = path.join(workspaceRoot, 'dist')
    mkdirSync(path.join(outputDirectory, 'assets'), { recursive: true })
    writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    writeFileSync(path.join(outputDirectory, 'index.html'), '<!doctype html><script src="/assets/app.js"></script>')
    writeFileSync(path.join(outputDirectory, 'atlas-assets.json'), JSON.stringify({ main: { file: 'assets/app.js' } }))
    writeFileSync(path.join(outputDirectory, 'assets', 'app.js'), 'console.log("Atlas")')
    writeFileSync(path.join(outputDirectory, 'logo.png'), Buffer.from([1, 2, 3]))
    return { workspaceRoot, outputDirectory }
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

describe('PWA release generation', () => {
    it('creates a deterministic content build ID and complete asset inventory', () => {
        const paths = fixture()
        const first = createPwaRelease({ ...paths, releasedAt: '2026-09-22T00:00:00.000Z' })
        const second = createPwaRelease({ ...paths, releasedAt: '2026-09-23T00:00:00.000Z' })

        expect(first.version).toBe('1.2.3')
        expect(first.buildId).toMatch(/^sha256-[a-f0-9]{64}$/)
        expect(first.buildId).toBe(second.buildId)
        expect(first.assets.map((asset) => asset.url)).toEqual([
            '/',
            '/assets/app.js',
            '/atlas-assets.json',
            '/logo.png',
        ])
        expect(first.assets.every((asset) => asset.bytes > 0 && /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(true)
    })

    it('changes the build ID whenever a release asset changes', () => {
        const paths = fixture()
        const before = createPwaRelease(paths)
        writeFileSync(path.join(paths.outputDirectory, 'assets', 'app.js'), 'console.log("Atlas v2")')
        const after = createPwaRelease(paths)

        expect(after.buildId).not.toBe(before.buildId)
        expect(collectPwaReleaseAssets(paths.outputDirectory)).toHaveLength(4)
    })

    it('rejects an output directory without the shell or Vite asset manifest', () => {
        const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'atlas-pwa-release-empty-'))
        temporaryDirectories.push(workspaceRoot)
        const outputDirectory = path.join(workspaceRoot, 'dist')
        mkdirSync(outputDirectory)
        writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }))

        expect(() => createPwaRelease({ workspaceRoot, outputDirectory })).toThrow(/index\.html/)
    })
})
