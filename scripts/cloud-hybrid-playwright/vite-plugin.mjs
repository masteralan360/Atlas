import { cloudHybridPreflight, currentCloudHybridRun, prepareCloudHybridScenarioPlan, requestCloudHybridCancellation, startCloudHybridRun } from './run.mjs'

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
            let payload = {}
            if (request.method === 'POST') payload = await readJson(request)
            if (!authorizeLocalBrowserRequest(request, payload.baseUrl)) return send(response, 403, { error: 'This runner is available only from the local Atlas development app.' })

            if (request.method === 'GET' && action === 'preflight') {
              const readiness = await cloudHybridPreflight()
              return send(response, 200, readiness)
            }
            if (request.method === 'GET' && action === 'status') {
              return send(response, 200, { run: currentCloudHybridRun() })
            }
            if (request.method === 'POST' && action === 'start') {
              if (!payload.baseUrl) return send(response, 400, { error: 'Open the local POS app before starting the runner.' })
              try {
                const run = startCloudHybridRun({ baseUrl: payload.baseUrl, scenarioSelection: payload.scenarioSelection })
                return send(response, 202, { run })
              } catch (error) {
                return send(response, 409, { error: error instanceof Error ? error.message : 'A run could not be started.' })
              }
            }
            if (request.method === 'POST' && action === 'plan') {
              if (!payload.baseUrl) return send(response, 400, { error: 'Open the local POS app before preparing the scenario timeline.' })
              try {
                const run = prepareCloudHybridScenarioPlan({ baseUrl: payload.baseUrl })
                return send(response, 202, { run })
              } catch (error) {
                return send(response, 409, { error: error instanceof Error ? error.message : 'The scenario timeline could not be prepared.' })
              }
            }
            if (request.method === 'POST' && action === 'cancel') {
              return send(response, 200, { run: requestCloudHybridCancellation() })
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
