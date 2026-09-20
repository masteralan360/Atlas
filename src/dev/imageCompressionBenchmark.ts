import { compressImage } from '@/lib/imageCompression'
import { IMAGE_UPLOAD_PROFILES, type ImageUploadSource } from '@/lib/imageUploadProfiles'

type FixtureKind = 'product' | 'logo' | 'portrait' | 'activity' | 'print'

export interface ImageBenchmarkResult {
    source: ImageUploadSource
    fixture: FixtureKind
    inputBytes: number
    outputBytes: number
    reductionPercent: number
    width: number
    height: number
    attempts: number
    elapsedMs: number
    targetBytes: number
    targetMet: boolean
}

const FIXTURE_BY_SOURCE: Record<ImageUploadSource, FixtureKind> = {
    'product-primary': 'product',
    'product-additional': 'product',
    'product-variant': 'product',
    'service-image': 'product',
    'activity-image': 'activity',
    'workspace-logo': 'logo',
    'profile-image': 'portrait',
    'print-attachment': 'print',
    'print-watermark': 'logo',
    'clinical-attachment': 'print',
    'generic-upload': 'print',
}

function dimensions(kind: FixtureKind): [number, number] {
    if (kind === 'product') return [3200, 2400]
    if (kind === 'logo') return [1600, 800]
    if (kind === 'portrait') return [1800, 2400]
    if (kind === 'activity') return [2400, 1600]
    return [2400, 3200]
}

function seededNoise(seed: number): number {
    const value = Math.sin(seed * 12.9898) * 43758.5453
    return value - Math.floor(value)
}

function addSensorNoise(context: CanvasRenderingContext2D, width: number, height: number, amplitude: number) {
    const image = context.getImageData(0, 0, width, height)
    let state = 0x6d2b79f5
    for (let index = 0; index < image.data.length; index += 4) {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        const delta = (((state >>> 0) & 0xff) / 255 - 0.5) * amplitude
        image.data[index] = Math.max(0, Math.min(255, image.data[index] + delta))
        image.data[index + 1] = Math.max(0, Math.min(255, image.data[index + 1] + delta))
        image.data[index + 2] = Math.max(0, Math.min(255, image.data[index + 2] + delta))
    }
    context.putImageData(image, 0, 0)
}

async function createFixture(kind: FixtureKind): Promise<File> {
    const [width, height] = dimensions(kind)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!

    if (kind === 'logo') {
        context.clearRect(0, 0, width, height)
        context.fillStyle = '#4f46e5'
        context.beginPath()
        context.roundRect(120, 120, width - 240, height - 240, 120)
        context.fill()
        context.fillStyle = '#ffffff'
        context.font = 'bold 240px system-ui'
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText('ATLAS', width / 2, height / 2)
    } else {
        const gradient = context.createLinearGradient(0, 0, width, height)
        gradient.addColorStop(0, kind === 'portrait' ? '#8b5cf6' : '#0f766e')
        gradient.addColorStop(0.5, kind === 'print' ? '#f8fafc' : '#f59e0b')
        gradient.addColorStop(1, '#1e293b')
        context.fillStyle = gradient
        context.fillRect(0, 0, width, height)

        const cell = kind === 'print' ? 48 : 24
        for (let y = 0; y < height; y += cell) {
            for (let x = 0; x < width; x += cell) {
                const noise = seededNoise(x * 17 + y * 31)
                context.fillStyle = `rgba(${Math.round(noise * 255)},${Math.round((1 - noise) * 180)},220,${kind === 'print' ? 0.08 : 0.2})`
                context.fillRect(x, y, cell, cell)
            }
        }
        addSensorNoise(context, width, height, kind === 'product' ? 36 : kind === 'activity' ? 24 : kind === 'portrait' ? 20 : 7)
        context.fillStyle = kind === 'print' ? '#0f172a' : '#ffffff'
        context.font = `bold ${Math.round(width / 13)}px system-ui`
        context.fillText(kind.toUpperCase(), width * 0.08, height * 0.16)
        if (kind === 'print') {
            context.font = '42px system-ui'
            for (let row = 0; row < 42; row += 1) {
                context.fillText(`Invoice row ${String(row + 1).padStart(2, '0')}   Product description   1,250,000`, 140, 420 + row * 62)
            }
        }
    }

    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Fixture encoding failed')), 'image/png'))
    return new File([blob], `${kind}.png`, { type: 'image/png' })
}

export async function runImageCompressionBenchmark(): Promise<ImageBenchmarkResult[]> {
    const fixtureCache = new Map<FixtureKind, File>()
    const results: ImageBenchmarkResult[] = []
    for (const source of Object.keys(IMAGE_UPLOAD_PROFILES) as ImageUploadSource[]) {
        const fixture = FIXTURE_BY_SOURCE[source]
        let file = fixtureCache.get(fixture)
        if (!file) {
            file = await createFixture(fixture)
            fixtureCache.set(fixture, file)
        }
        const started = performance.now()
        const artifact = await compressImage(file, source)
        const elapsedMs = performance.now() - started
        const targetBytes = IMAGE_UPLOAD_PROFILES[source].softTargetBytes
        results.push({
            source,
            fixture,
            inputBytes: artifact.originalBytes,
            outputBytes: artifact.outputBytes,
            reductionPercent: Number(((1 - artifact.outputBytes / artifact.originalBytes) * 100).toFixed(1)),
            width: artifact.width,
            height: artifact.height,
            attempts: artifact.attempts,
            elapsedMs: Number(elapsedMs.toFixed(1)),
            targetBytes,
            targetMet: artifact.outputBytes <= targetBytes,
        })
    }
    return results
}

declare global {
    interface Window { __atlasImageBenchmark?: ImageBenchmarkResult[] }
}

const runButton = document.querySelector<HTMLButtonElement>('#run')
const status = document.querySelector<HTMLDivElement>('#status')
const resultsContainer = document.querySelector<HTMLDivElement>('#results')
const jsonContainer = document.querySelector<HTMLPreElement>('#json')

async function renderBenchmark() {
    if (!runButton || !status || !resultsContainer || !jsonContainer) return
    runButton.disabled = true
    status.textContent = 'Running production compression pipeline…'
    try {
        const results = await runImageCompressionBenchmark()
        window.__atlasImageBenchmark = results
        resultsContainer.innerHTML = `<table><thead><tr><th>Source</th><th>Fixture</th><th>Input</th><th>Output</th><th>Reduction</th><th>Dimensions</th><th>Attempts</th><th>Time</th><th>Target</th></tr></thead><tbody>${results.map((result) => `<tr><td>${result.source}</td><td>${result.fixture}</td><td>${Math.round(result.inputBytes / 1024)} KiB</td><td>${Math.round(result.outputBytes / 1024)} KiB</td><td>${result.reductionPercent}%</td><td>${result.width}×${result.height}</td><td>${result.attempts}</td><td>${result.elapsedMs} ms</td><td class="${result.targetMet ? 'pass' : 'miss'}">${result.targetMet ? 'met' : 'missed'}</td></tr>`).join('')}</tbody></table>`
        jsonContainer.textContent = JSON.stringify(results, null, 2)
        status.textContent = `Complete: ${results.filter((result) => result.targetMet).length}/${results.length} profiles met their soft byte target.`
    } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
        runButton.disabled = false
    }
}

runButton?.addEventListener('click', () => void renderBenchmark())
