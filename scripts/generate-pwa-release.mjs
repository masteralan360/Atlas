import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const PWA_RELEASE_SCHEMA_VERSION = 1
export const PWA_UPDATE_PROTOCOL_VERSION = 2

const ROOT_RUNTIME_ASSET_PATTERN = /\.(?:webmanifest|wasm|png|svg|ico|woff2?)$/i

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex')
}

function listFiles(directory) {
    if (!existsSync(directory)) return []
    const result = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name)
        if (entry.isDirectory()) result.push(...listFiles(absolutePath))
        else if (entry.isFile()) result.push(absolutePath)
    }
    return result
}

function gitCommit(workspaceRoot) {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: workspaceRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
    } catch {
        return ''
    }
}

export function collectPwaReleaseAssets(outputDirectory) {
    const rootRuntimeFiles = existsSync(outputDirectory)
        ? readdirSync(outputDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && ROOT_RUNTIME_ASSET_PATTERN.test(entry.name))
            .map((entry) => entry.name)
        : []
    const candidates = [
        { file: path.join(outputDirectory, 'index.html'), url: '/' },
        { file: path.join(outputDirectory, 'atlas-assets.json'), url: '/atlas-assets.json' },
        ...rootRuntimeFiles.map((name) => ({
            file: path.join(outputDirectory, name),
            url: `/${name}`,
        })),
        ...listFiles(path.join(outputDirectory, 'assets')).map((file) => ({
            file,
            url: `/${path.relative(outputDirectory, file).replaceAll(path.sep, '/')}`,
        })),
    ]

    const seen = new Set()
    return candidates
        .filter(({ file }) => existsSync(file) && statSync(file).isFile())
        .filter(({ url }) => {
            if (seen.has(url)) return false
            seen.add(url)
            return true
        })
        .map(({ file, url }) => {
            const contents = readFileSync(file)
            return {
                url,
                bytes: contents.byteLength,
                sha256: sha256(contents),
            }
        })
        .sort((left, right) => left.url.localeCompare(right.url))
}

export function createPwaRelease({ outputDirectory, workspaceRoot, releasedAt = new Date().toISOString() }) {
    const assets = collectPwaReleaseAssets(outputDirectory)
    if (!assets.some((asset) => asset.url === '/')) {
        throw new Error('The PWA release cannot be generated without dist/index.html')
    }
    if (!assets.some((asset) => asset.url === '/atlas-assets.json')) {
        throw new Error('The PWA release cannot be generated without dist/atlas-assets.json')
    }

    const packageJson = JSON.parse(readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'))
    const inventory = assets.map(({ url, bytes, sha256: digest }) => `${url}\0${bytes}\0${digest}`).join('\n')
    const buildId = `sha256-${sha256(Buffer.from(inventory))}`

    return {
        schemaVersion: PWA_RELEASE_SCHEMA_VERSION,
        updateProtocol: PWA_UPDATE_PROTOCOL_VERSION,
        channel: 'production',
        version: String(packageJson.version || ''),
        buildId,
        commit: gitCommit(workspaceRoot),
        releasedAt,
        shell: '/',
        assetManifest: '/atlas-assets.json',
        assets,
    }
}

export function writePwaRelease({ outputDirectory, workspaceRoot }) {
    const release = createPwaRelease({ outputDirectory, workspaceRoot })
    const destination = path.join(outputDirectory, 'pwa-release.json')
    writeFileSync(destination, `${JSON.stringify(release, null, 2)}\n`, 'utf8')
    return { destination, release }
}

function main() {
    const workspaceRoot = process.cwd()
    const outputDirectory = path.resolve(workspaceRoot, process.argv[2] || 'dist')
    const { destination, release } = writePwaRelease({ outputDirectory, workspaceRoot })
    console.log(`[pwa-release] ${release.buildId} (${release.assets.length} assets) -> ${destination}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main()
}
