const repository = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN
const apiBase = `https://api.github.com/repos/${repository}`
const apiVersion = '2022-11-28'

if (!repository || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.')
}

async function githubRequest(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': apiVersion,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })

    if (!response.ok) {
        const details = await response.text()
        throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${details}`)
    }

    const text = await response.text()
    return text ? JSON.parse(text) : null
}

async function readMainReleaseConfig() {
    const file = await githubRequest('/contents/.release-config.json?ref=main')
    const config = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
    return { file, config }
}

async function updateMainReleaseConfig(scheduleId, update) {
    const { file, config } = await readMainReleaseConfig()
    if (config.schedule_id !== scheduleId || !config.schedule_enabled) {
        return false
    }

    update(config)
    await githubRequest('/contents/.release-config.json', {
        method: 'PUT',
        body: {
            message: `Update scheduled release ${scheduleId}`,
            content: Buffer.from(`${JSON.stringify(config, null, 2)}\n`).toString('base64'),
            sha: file.sha,
            branch: 'main',
        },
    })
    return true
}

async function hasDispatchRun(workflowFile, displayTitle) {
    const result = await githubRequest(
        `/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=100`,
    )
    return result.workflow_runs.some((run) => run.display_title === displayTitle)
}

async function dispatchIfNeeded({ workflowFile, ref, scheduleId, displayTitle, dispatchKey }) {
    let { config } = await readMainReleaseConfig()
    if (config.schedule_id !== scheduleId || !config.schedule_enabled) {
        throw new Error('The pending release schedule changed before dispatch completed.')
    }

    if (config.schedule_dispatches?.[dispatchKey]) {
        return
    }

    const alreadyDispatched = await hasDispatchRun(workflowFile, displayTitle)
    if (!alreadyDispatched) {
        await githubRequest(`/actions/workflows/${workflowFile}/dispatches`, {
            method: 'POST',
            body: {
                ref,
                inputs: { schedule_id: scheduleId },
            },
        })
    }

    const updated = await updateMainReleaseConfig(scheduleId, (releaseConfig) => {
        releaseConfig.schedule_status = 'dispatching'
        releaseConfig.schedule_dispatches = {
            ...releaseConfig.schedule_dispatches,
            [dispatchKey]: true,
        }
    })
    if (!updated) {
        throw new Error('The pending release schedule changed while recording a dispatch.')
    }
}

const { config } = await readMainReleaseConfig()
if (!config.schedule_enabled || !['pending', 'dispatching'].includes(config.schedule_status)) {
    console.log('No scheduled release is waiting.')
    process.exit(0)
}

const { schedule_id: scheduleId, scheduled_tag: scheduledTag, scheduled_at_utc: scheduledAt } = config
if (!scheduleId || !/^v\d+(?:\.\d+)*$/.test(scheduledTag ?? '') || !scheduledAt) {
    throw new Error('The pending release schedule is missing a valid ID, tag, or UTC time.')
}

const scheduledAtMs = Date.parse(scheduledAt)
if (!Number.isFinite(scheduledAtMs)) {
    throw new Error(`Invalid scheduled_at_utc value: ${scheduledAt}`)
}
if (Date.now() < scheduledAtMs) {
    console.log(`Scheduled release ${scheduledTag} is not due yet.`)
    process.exit(0)
}

try {
    await githubRequest(`/git/ref/tags/${encodeURIComponent(scheduledTag)}`)
} catch (error) {
    if (String(error).includes('(404)')) {
        console.log(`Tag ${scheduledTag} is not available yet; the next dispatcher run will retry.`)
        process.exit(0)
    }
    throw error
}

if (config.schedule_status === 'pending') {
    const updated = await updateMainReleaseConfig(scheduleId, (releaseConfig) => {
        releaseConfig.schedule_status = 'dispatching'
        releaseConfig.schedule_dispatches = { release: false, cloudflare: false }
    })
    if (!updated) {
        console.log('The pending schedule changed before dispatch started.')
        process.exit(0)
    }
}

await dispatchIfNeeded({
    workflowFile: 'release.yml',
    ref: scheduledTag,
    scheduleId,
    displayTitle: `Release ${scheduleId}`,
    dispatchKey: 'release',
})

await dispatchIfNeeded({
    workflowFile: 'deploy-cloudflare.yml',
    ref: 'main',
    scheduleId,
    displayTitle: `Cloudflare deployment ${scheduleId}`,
    dispatchKey: 'cloudflare',
})

const finished = await updateMainReleaseConfig(scheduleId, (releaseConfig) => {
    const dispatches = releaseConfig.schedule_dispatches ?? {}
    if (!dispatches.release || !dispatches.cloudflare) {
        throw new Error('Cannot complete a scheduled release before both workflows are dispatched.')
    }
    releaseConfig.schedule_enabled = false
    releaseConfig.schedule_status = 'completed'
})

if (!finished) {
    throw new Error('The release schedule changed before it could be marked complete.')
}

console.log(`Dispatched scheduled release ${scheduledTag} (${scheduleId}).`)
