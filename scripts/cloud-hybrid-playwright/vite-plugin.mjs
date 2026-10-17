import { cloudHybridPreflight, currentCloudHybridRun, prepareCloudHybridScenarioPlan, requestCloudHybridCancellation, startCloudHybridRun } from './run.mjs'
import { normalizePlaywrightSuiteId, PLAYWRIGHT_SUITE_IDS } from './executionState.mjs'

const API_PREFIX = '/api/cloud-hybrid-playwright/'

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function send(response, status, body) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  let value = ''
  for await (const chunk of request) {
    value += chunk
    if (value.length > 16_384) throw new Error('Request is too large.')
  }
  return value ? JSON.parse(value) : {}
}

function authorizeLocalBrowserRequest(request, requestedBaseUrl) {
  const host = String(request.headers.host ?? '').split(':')[0]
  if (!isLoopback(host)) return false
  const originHeader = request.headers.origin
  if (!originHeader) return request.method === 'GET'
  let origin
  try { origin = new URL(originHeader) } catch { return false }
  if (!isLoopback(origin.hostname) || origin.host !== request.headers.host) return false
  if (requestedBaseUrl) {
    try {
      const base = new URL(requestedBaseUrl)
      if (!isLoopback(base.hostname) || base.origin !== origin.origin) return false
    } catch { return false }
  }
  return true
}

export function cloudHybridPlaywrightPlugin(enabled) {
  return {
    name: 'atlas-cloud-hybrid-playwright',
    apply: 'serve',
    configureServer(server) {
      if (!enabled) return
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? ''
        if (!path.startsWith(API_PREFIX)) return next()
        void (async () => {
          try {
            const action = path.slice(API_PREFIX.length)
            const requestUrl = new URL(request.url ?? '/', 'http://localhost')
            let payload = {}
            if (request.method === 'POST') payload = await readJson(request)
            if (!authorizeLocalBrowserRequest(request, payload.baseUrl)) return send(response, 403, { error: 'This runner is available only from the local Atlas development app.' })

            if (request.method === 'GET' && action === 'preflight') {
              const suiteId = normalizePlaywrightSuiteId(requestUrl.searchParams.get('suiteId') ?? PLAYWRIGHT_SUITE_IDS.POS)
              const readiness = await cloudHybridPreflight(suiteId)
              return send(response, 200, readiness)
            }
            if (request.method === 'GET' && action === 'status') {
              const suiteId = normalizePlaywrightSuiteId(requestUrl.searchParams.get('suiteId') ?? PLAYWRIGHT_SUITE_IDS.POS)
              return send(response, 200, { run: currentCloudHybridRun(suiteId) })
            }
            if (request.method === 'POST' && action === 'start') {
              const suiteId = normalizePlaywrightSuiteId(payload.suiteId ?? PLAYWRIGHT_SUITE_IDS.POS)
              if (!payload.baseUrl) return send(response, 400, { error: 'Open the local Atlas app before starting the runner.' })
              try {
                const run = startCloudHybridRun({ suiteId, baseUrl: payload.baseUrl, scenarioSelection: payload.scenarioSelection })
                return send(response, 202, { run })
              } catch (error) {
                return send(response, 409, { error: error instanceof Error ? error.message : 'A run could not be started.' })
              }
            }
            if (request.method === 'POST' && action === 'plan') {
              const suiteId = normalizePlaywrightSuiteId(payload.suiteId ?? PLAYWRIGHT_SUITE_IDS.POS)
              if (!payload.baseUrl) return send(response, 400, { error: 'Open the local Atlas app before preparing the scenario timeline.' })
              try {
                const run = prepareCloudHybridScenarioPlan({ suiteId, baseUrl: payload.baseUrl })
                return send(response, 202, { run })
              } catch (error) {
                return send(response, 409, { error: error instanceof Error ? error.message : 'The scenario timeline could not be prepared.' })
              }
            }
            if (request.method === 'POST' && action === 'cancel') {
              const suiteId = normalizePlaywrightSuiteId(payload.suiteId ?? PLAYWRIGHT_SUITE_IDS.POS)
              const run = requestCloudHybridCancellation(suiteId, payload.runId)
              return send(response, 200, { run })
            }
            return send(response, 404, { error: 'Runner endpoint not found.' })
          } catch (error) {
            return send(response, 500, { error: error instanceof Error ? error.message : 'The independent runner request failed.' })
          }
        })()
      })
    }
  }
}
