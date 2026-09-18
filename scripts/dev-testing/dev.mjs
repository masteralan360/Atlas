// Convenience local-only server; npm run dev also enables developer testing.
const { createServer } = await import('vite')
const portIndex = process.argv.indexOf('--port')
const port = portIndex === -1 ? 1420 : Number(process.argv[portIndex + 1])
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid development port')
const server = await createServer({ server: { port, host: '127.0.0.1' } })
await server.listen()
server.printUrls()
server.bindCLIShortcuts({ print: true })
