#!/usr/bin/env node
// Execute one Hexmorph request end to end: dispatch it as a durable job, run the
// agent turn under the controller's lease with only the role's scoped tools, and
// record the outcome.
//
// This runs in the Hexmorph controller's own pinned Node runtime, not Electron's.
// It is launched detached by the desktop app; the panel watches the controller's
// own records rather than this process, so closing the window never cancels a job.
//
// Nothing here chooses a model, a role or a tool scope. The controller resolves
// the route, the role profile fixes the tool ceiling, and the lease and fencing
// token bound what this attempt may write.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const HEXMORPH_ROOT = process.env.HEXMORPH_ROOT ?? '/home/rob/Documents/pi'
const dist = (path) => resolve(HEXMORPH_ROOT, 'dist/server', path)

const input = JSON.parse(process.argv[2] ?? '{}')
const { ownerId, projectId, request } = input
if (!ownerId || !projectId || !request) {
  process.stdout.write(JSON.stringify({ ok: false, message: 'ownerId, projectId and request are required' }))
  process.exit(2)
}

const say = (stage, detail) => process.stderr.write(`[hexmorph] ${stage}${detail ? ` ${detail}` : ''}\n`)

// The SDK is resolved from the controller's own install: this script lives in the
// desktop app, which does not depend on the Pi SDK itself.
const { SessionManager } = await import(
  resolve(HEXMORPH_ROOT, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')
)
const { ControlStore } = await import(dist('store/control-store.js'))
const { DraftStore } = await import(dist('adapters/hexmorph/drafts.js'))
const { RoutingConfigStore } = await import(dist('routing/config-store.js'))
const { WorkerSupervisor } = await import(dist('workers/supervisor.js'))
const { ToolGateway } = await import(dist('tools/gateway.js'))
const { PiSessionBindings, isolatedModelRuntime, createManagedPiRuntime } = await import(dist('pi-runtime/managed.js'))
const { workspaceStorage } = await import(dist('pi-extension/workspace.js'))

const storage = workspaceStorage(HEXMORPH_ROOT)
const control = new ControlStore(storage.control)
const drafts = new DraftStore(storage.drafts)
const routing = new RoutingConfigStore(storage.routing)
const bindings = new PiSessionBindings(storage.control)
const workers = new WorkerSupervisor(resolve(HEXMORPH_ROOT, 'var/control/workers.sqlite'))

const scope = { ownerId, projectId }
let context = null
let runtime = null

const finish = (outcome, output) => {
  if (!context) return
  try {
    control.finish(context, outcome, String(output).slice(0, 8000))
  } catch (error) {
    say('finish-failed', error?.safeMessage ?? error?.message)
  }
}

try {
  const snapshot = routing.read(ownerId)
  if (!snapshot.connections.length) throw new Error('No provider connection is configured. Log in with Pi, then press Connect.')
  const draft = drafts.read(scope)

  // 1. Durable job with an immutable dispatch policy.
  const runInput = {
    schemaVersion: 1,
    request: String(request).trim().slice(0, 8000),
    sourceRevision: draft.revision,
    configurationRevision: snapshot.version,
    roleProfileVersion: 'v1',
    toolProfileVersion: 'v1',
  }
  const deadline = Date.now() + 600_000
  const created = control.createRun(scope, randomUUID().replace(/-/g, '').slice(0, 40), runInput, {
    deadline,
    maxAttempts: 3,
    maxOperations: 100,
  })
  say('run', created.runId)

  control.registerDispatch(
    scope,
    created.runId,
    {
      ...scope,
      roleId: 'implementation',
      sessionId: randomUUID(),
      dataClasses: [],
      allowedConnectionIds: snapshot.connections.map((connection) => connection.id),
      allowedRunners: [...new Set(snapshot.catalog.map((entry) => entry.runner))],
      inputTokens: Math.min(100_000, Math.max(1_000, runInput.request.length * 4)),
      outputTokens: 8_000,
      remainingTokens: 2_000_000,
      remainingCost: 5,
      deadline,
    },
    snapshot.version
  )

  // 2. Lease an attempt. The route, fence and grant all come from the controller.
  const leased = control.startDispatch(scope, created.runId, snapshot)
  context = {
    ownerId,
    projectId,
    runId: created.runId,
    jobId: created.jobId,
    attemptId: leased.attemptId,
    fencingToken: leased.fencingToken,
  }
  say('route', `${leased.route.runner}/${leased.route.model} (${leased.route.explanation})`)

  if (leased.route.runner !== 'pi-sdk') {
    throw new Error(`This runner is not executable yet: ${leased.route.runner}. Only the Pi runner is wired.`)
  }

  // 3. A Pi-owned workspace and session store for this project.
  const cwd = resolve(HEXMORPH_ROOT, 'var/agent-workspaces', projectId)
  const agentDir = process.env.HEXMORPH_AGENT_DIR ?? resolve(process.env.HOME ?? '/home/rob', '.pi/agent')
  const sessionDir = resolve(HEXMORPH_ROOT, 'var/agent-sessions', projectId)
  for (const path of [cwd, sessionDir]) mkdirSync(path, { recursive: true, mode: 0o700 })

  const modelRuntime = await isolatedModelRuntime(agentDir)

  // The isolated runtime suppresses ambient-key lookups, which also makes its
  // capability report say "no auth configured" even when the owner's own login is
  // present in the profile. Probe the real thing and correct the report from the
  // answer — this asserts nothing the profile does not actually provide, and a
  // profile with no credential still fails here rather than at dispatch.
  const probeModel = modelRuntime.getModel(leased.route.provider, leased.route.model)
  if (!probeModel) throw new Error(`The configured model is absent from the Pi catalog: ${leased.route.provider}/${leased.route.model}`)
  const probed = await modelRuntime.getAuth(probeModel, {}).catch(() => null)
  if (!probed) {
    throw new Error(
      `No credential for ${leased.route.provider} in ${agentDir}. Run "pi" in a terminal and use /login, then try again.`
    )
  }
  modelRuntime.hasConfiguredAuth = () => true
  const manager = SessionManager.create(cwd, sessionDir)
  const gateway = new ToolGateway(control, drafts, workers)

  runtime = await createManagedPiRuntime({
    cwd,
    agentDir,
    sessionDir: manager.getSessionDir(),
    manager,
    modelRuntime,
    control,
    context,
    grant: leased.grant,
    bindings,
    gateway,
    snapshot: () => routing.read(ownerId),
    outputTokens: 8_000,
  })
  await runtime.session.bindExtensions({})
  say('tools', runtime.session.getActiveToolNames().join(',') || 'none')

  // 4. The turn itself. The scoped tools are the only way it can touch anything.
  // prompt() resolves with nothing; the reply lands in the session transcript.
  await runtime.session.prompt(runInput.request)

  const textOf = (message) => {
    if (typeof message?.content === 'string') return message.content
    if (!Array.isArray(message?.content)) return ''
    return message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  }
  const replies = manager
    .getEntries()
    .filter((entry) => entry?.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => textOf(entry.message))
    .filter((value) => value.trim().length)
  const toolCalls = manager
    .getEntries()
    .filter((entry) => entry?.type === 'message' && Array.isArray(entry.message?.content))
    .flatMap((entry) => entry.message.content.filter((part) => part?.type === 'toolCall' || part?.type === 'tool_use'))
  const text = replies.at(-1) ?? ''
  say('reply', `${replies.length} message(s), ${toolCalls.length} tool call(s)`)

  finish('succeeded', text || 'The agent completed without text output.')
  say('done')
  process.stdout.write(
    JSON.stringify({ ok: true, runId: context.runId, toolCalls: toolCalls.length, output: String(text).slice(0, 4000) })
  )
} catch (error) {
  const message = error?.safeMessage ?? error?.message ?? String(error)
  say('failed', message)
  finish('failed', message)
  process.stdout.write(JSON.stringify({ ok: false, runId: context?.runId ?? null, message }))
  process.exitCode = 1
} finally {
  try {
    if (runtime) await runtime.dispose()
  } catch {
    // Disposal failure must not mask the outcome already recorded.
  }
  try {
    await workers.recover()
  } catch {
    // Same: the controller's record is what matters.
  }
  for (const store of [bindings, workers, routing, drafts, control]) {
    try {
      store.close()
    } catch {
      // Already closed or never opened.
    }
  }
}
