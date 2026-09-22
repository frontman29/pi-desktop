#!/usr/bin/env node
// Private MCP transport for a native runner.
//
// The Claude CLI spawns this as its only MCP server. It speaks newline-delimited
// JSON-RPC on stdio and forwards each request to the controller's scoped tool
// gateway, which is the same gateway the Pi runner uses — so a native agent gets
// exactly the tools its role profile allows and nothing else.
//
// The attempt context and grant arrive in the environment from the launcher. The
// model never supplies them: it can name a tool and its arguments, and nothing
// about which owner, project, run or attempt it is acting for.
import { resolve } from 'node:path'

const HEXMORPH_ROOT = process.env.HEXMORPH_ROOT ?? '/home/rob/Documents/pi'
const dist = (path) => resolve(HEXMORPH_ROOT, 'dist/server', path)

const raw = process.env.PI_HEXMORPH_CONTEXT
const grant = process.env.PI_HEXMORPH_GRANT
if (!raw || !grant) {
  process.stderr.write('hexmorph-mcp-bridge: no attempt context or grant in the environment\n')
  process.exit(2)
}
const context = JSON.parse(raw)

const { ControlStore } = await import(dist('store/control-store.js'))
const { DraftStore } = await import(dist('adapters/hexmorph/drafts.js'))
const { WorkerSupervisor } = await import(dist('workers/supervisor.js'))
const { ToolGateway } = await import(dist('tools/gateway.js'))
const { PrivateMcpSession } = await import(dist('tools/mcp.js'))
const { workspaceStorage } = await import(dist('pi-extension/workspace.js'))

const storage = workspaceStorage(HEXMORPH_ROOT)
const control = new ControlStore(storage.control)
const drafts = new DraftStore(storage.drafts)
const workers = new WorkerSupervisor(resolve(HEXMORPH_ROOT, 'var/control/workers.sqlite'))
const session = new PrivateMcpSession(new ToolGateway(control, drafts, workers), context, grant)

const close = () => {
  for (const store of [workers, drafts, control]) {
    try {
      store.close()
    } catch {
      // Already closed.
    }
  }
}
process.on('exit', close)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))

// Newline-delimited JSON-RPC. Bounded so a malformed or hostile stream cannot
// grow without limit, and a frame that cannot be parsed is answered rather than
// silently dropped.
let buffer = ''
const MAX_FRAME = 1_000_000

const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  if (buffer.length > MAX_FRAME) {
    buffer = ''
    reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeded its bound.' } })
    return
  }
  while (buffer.includes('\n')) {
    const at = buffer.indexOf('\n')
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Malformed JSON-RPC frame.' } })
      continue
    }
    // A notification has no id and takes no response.
    const isNotification = message && typeof message === 'object' && message.id === undefined
    try {
      const answer = await session.handle(message)
      if (!isNotification) reply(answer)
    } catch (error) {
      if (!isNotification) {
        reply({
          jsonrpc: '2.0',
          id: message?.id ?? null,
          error: { code: -32000, message: error?.safeMessage ?? 'The scoped gateway refused this call.' },
        })
      }
    }
  }
})
process.stdin.on('end', () => process.exit(0))
