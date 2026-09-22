import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { writePwaRelease } from './generate-pwa-release.mjs'

const require = createRequire(import.meta.url)
const npmCli = process.env.npm_execpath
const [target, ...targetArgs] = process.argv.slice(2)

function run(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        env,
        stdio: 'inherit',
        shell: false,
    })

    if (result.error) {
        console.error(`[build] Could not start ${command}:`, result.error.message)
        process.exit(1)
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1)
    }
}

if (target === 'android') {
    // `npm run build android` appends "android" to the build script. Route it
    // to the existing Android debug build instead of letting Vite treat it as
    // a project root and look for android/index.html.
    if (!npmCli) {
        console.error('[build] npm_execpath is unavailable; run this command through npm.')
        process.exit(1)
    }

    const androidEnv = { ...process.env }
    if (
        process.platform === 'win32'
        && [androidEnv.TEMP, androidEnv.TMP].some(
            (tempPath) => tempPath && (!path.win32.isAbsolute(tempPath) || tempPath.includes('~')),
        )
    ) {
        // Java's Windows AF_UNIX implementation can fail when its temporary
        // socket path uses an MSIX/Cygwin-style or 8.3 path. The canonical
        // user profile is a safe fallback and Tauri still receives TMP.
        if (
            androidEnv.USERPROFILE
            && path.win32.isAbsolute(androidEnv.USERPROFILE)
            && !androidEnv.USERPROFILE.includes('~')
        ) {
            androidEnv.TEMP = androidEnv.USERPROFILE
            androidEnv.TMP = androidEnv.USERPROFILE
        }
    }

    run(
        process.execPath,
        [npmCli, 'run', 'android:build', ...(targetArgs.length > 0 ? ['--', ...targetArgs] : [])],
        androidEnv,
    )
} else {
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'])
    const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')
    run(process.execPath, [viteCli, 'build', ...process.argv.slice(2)])

    writePwaRelease({
        workspaceRoot: process.cwd(),
        outputDirectory: path.resolve(process.cwd(), 'dist'),
    })

    // Vite intentionally omits underscore-prefixed public files. Cloudflare
    // parses this static-assets control file during deployment, so preserve it
    // in the final artifact after Vite completes.
    const cloudflareHeaders = path.resolve(process.cwd(), 'public', '_headers')
    const outputHeaders = path.resolve(process.cwd(), 'dist', '_headers')
    if (existsSync(cloudflareHeaders)) {
        copyFileSync(cloudflareHeaders, outputHeaders)
    }
}
