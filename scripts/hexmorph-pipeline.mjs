#!/usr/bin/env node
// The agent workflow: decide which agents a request needs, run them in order, and
// put the reviewers after the builder rather than alongside it.
//
// Stage selection is deterministic and inspectable. A model does not choose which
// agents run, what they may touch, or whether its own work passed review — those
// are the controller's decisions, and a builder that could pick its own reviewer
// is not reviewed at all.
//
// Each stage is its own durable run with its own lease, route and tool ceiling, so
// a stage that fails leaves the earlier stages' records intact and the pipeline
// stops with a reason rather than silently continuing.
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
const { roles } = await import(dist('routing/resolver.js'))

const storage = workspaceStorage(HEXMORPH_ROOT)
const control = new ControlStore(storage.control)
const drafts = new DraftStore(storage.drafts)
const routing = new RoutingConfigStore(storage.routing)
const bindings = new PiSessionBindings(storage.control)
const workers = new WorkerSupervisor(resolve(HEXMORPH_ROOT, 'var/control/workers.sqlite'))
const gateway = new ToolGateway(control, drafts, workers)
const scope = { ownerId, projectId }

/**
 * Which agents a request needs.
 *
 * Deterministic rules over the request text and the project's own state. Review
 * stages are not optional extras: any change to the candidate gets checked, and a
 * read-only question gets no reviewers because there is nothing to review.
 */
export function planStages(text) {
  const lower = String(text).toLowerCase()
  const readOnly = /^(what|which|how many|list|show|tell me|read|describe|explain|does|is |are )/.test(lower.trim())
    && !/\b(change|update|edit|fix|add|remove|replace|rewrite|set|make)\b/.test(lower)

  if (readOnly) {
    return { kind: 'question', stages: [{ roleId: 'discovery', purpose: 'Answer from the candidate without changing it.' }] }
  }

  const stages = [{ roleId: 'implementation', purpose: 'Make the requested change in the candidate.' }]
  // Reviewers, each looking at a different failure class. They run after the
  // builder and read the same candidate it produced.
  stages.push({ roleId: 'functional-qa', purpose: 'Check the change works and nothing else broke.', reviews: 'implementation' })
  if (/\b(script|form|link|url|redirect|meta|canonical|noindex|booking|checkout|password|secret|token)\b/.test(lower)) {
    stages.push({ roleId: 'security-review', purpose: 'Check for unsafe markup, leaked values or a wrong destination.', reviews: 'implementation' })
  }
  if (/\b(headline|heading|copy|text|content|title|seo|keyword|description)\b/.test(lower)) {
    stages.push({ roleId: 'performance-seo', purpose: 'Check the change keeps the page findable and well formed.', reviews: 'implementation' })
  }
  if (/\b(layout|design|colour|color|image|mobile|menu|nav|button|contrast|spacing)\b/.test(lower)) {
    stages.push({ roleId: 'visual-accessibility', purpose: 'Check the change stays legible and usable.', reviews: 'implementation' })
  }
  stages.push({ roleId: 'documentation', purpose: 'Record what changed and why, for the project record.' })
  return { kind: 'change', stages }
}

/**
 * Clear a writer slot held by an attempt that is no longer live.
 *
 * A single writer per project is the point, so this never takes the slot from a
 * job that is actually running: a live lease is reported as a busy project and
 * the pipeline refuses. Only an expired or drained attempt is reconciled, which
 * is the same reconciliation the controller performs on its own schedule.
 */
function reconcileStaleWriter() {
  control.reconcileExpired()
  for (const run of control.listRuns(scope, 50)) {
    if (['succeeded', 'failed', 'cancelled'].includes(run.state)) continue
    const info = control.inspect(scope, run.runId)
    for (const attempt of info.attempts) {
      if (!['leased', 'running', 'draining'].includes(attempt.state)) continue
      const context = {
        ...scope,
        runId: run.runId,
        jobId: info.jobId,
        attemptId: attempt.id,
        fencingToken: attempt.fence,
      }
      const expired = Number(attempt.lease_until) <= Date.now()
      if (!expired && attempt.state !== 'draining') {
        throw new Error(
          `Another job is still running for ${projectId} (run ${String(run.runId).slice(0, 8)}). Wait for it to finish, or cancel it.`
        )
      }
      try {
        if (attempt.state === 'draining') {
          control.recordQuiescence(
            context,
            { summary: 'Reconciled: the attempt stopped without reporting an outcome.', candidateRevision: 0, remainingWork: [], evidenceRefs: [] },
            `reconcile-${Date.now()}`
          )
          control.releaseDrained(context)
        } else {
          control.finish(context, 'failed', 'Reconciled: the lease expired without an outcome.')
        }
        say('reconciled', `${String(run.runId).slice(0, 8)} (${attempt.state})`)
      } catch (error) {
        say('reconcile-failed', error?.safeMessage ?? error?.message)
      }
    }
    const after = control.inspect(scope, run.runId).state
    try {
      if (after === 'checking') control.closeUnchecked(scope, run.runId, 'Reconciled; no check was performed.')
      else if (['queued', 'interrupted'].includes(after)) control.cancel(scope, run.runId)
    } catch {
      // Whatever state it reached, it no longer holds the writer slot.
    }
  }
}

const plan = planStages(request)
say('plan', `${plan.kind}: ${plan.stages.map((stage) => stage.roleId).join(' → ')}`)

const results = []
let builder = null
let failure = null

/** Run one agent as its own durable job, and return what it produced. */
async function runStage(stage, snapshot, index) {
  const role = roles.find((entry) => entry.id === stage.roleId)
  if (!role) throw new Error(`Unknown role ${stage.roleId}`)
  const draft = drafts.read(scope)
  const deadline = Date.now() + 600_000

  const prompt = [
    stage.purpose,
    '',
    `The owner asked: ${String(request).trim()}`,
    stage.reviews && builder
      ? `\nYou are reviewing the work of the ${stage.reviews} agent, which reported:\n${builder.output.slice(0, 2000)}\n\nYou cannot edit. Report what you find, and say plainly if you find nothing wrong.`
      : '',
    '\nUse your scoped tools. Report incomplete checks accurately rather than assuming they passed.',
  ]
    .filter(Boolean)
    .join('\n')

  const runInput = {
    schemaVersion: 1,
    request: prompt.slice(0, 8000),
    sourceRevision: draft.revision,
    configurationRevision: snapshot.version,
    roleProfileVersion: 'v1',
    toolProfileVersion: 'v1',
  }
  const created = control.createRun(scope, randomUUID().replace(/-/g, '').slice(0, 40), runInput, {
    deadline,
    maxAttempts: 3,
    maxOperations: 100,
  })

  const sessionId = randomUUID()
  control.registerDispatch(
    scope,
    created.runId,
    {
      ...scope,
      roleId: role.id,
      sessionId,
      dataClasses: [],
      allowedConnectionIds: snapshot.connections.map((connection) => connection.id),
      allowedRunners: [...new Set(snapshot.catalog.map((entry) => entry.runner))],
      inputTokens: Math.min(100_000, Math.max(1_000, runInput.request.length * 4)),
      outputTokens: 8_000,
      remainingTokens: 2_000_000,
      remainingCost: 5,
      deadline,
      // A reviewer must be independent of the work it reviews. The controller
      // refuses the route otherwise, so this is a check, not a formality.
      ...(stage.reviews && builder
        ? {
            reviewerAgainst: {
              sessionId: builder.sessionId,
              model: builder.model,
              provider: builder.provider,
              toolProfile: builder.toolProfile,
            },
            differentModelRequired: true,
          }
        : {}),
    },
    snapshot.version
  )

  const leased = control.startDispatch(scope, created.runId, snapshot)
  const context = {
    ownerId,
    projectId,
    runId: created.runId,
    jobId: created.jobId,
    attemptId: leased.attemptId,
    fencingToken: leased.fencingToken,
  }
  say(`stage ${index + 1}/${plan.stages.length}`, `${role.id} → ${leased.route.model} [${leased.route.toolProfile}]`)

  const cwd = resolve(HEXMORPH_ROOT, 'var/agent-workspaces', projectId)
  const sessionDir = resolve(HEXMORPH_ROOT, 'var/agent-sessions', projectId)
  const agentDir = process.env.HEXMORPH_AGENT_DIR ?? resolve(process.env.HOME ?? '/home/rob', '.pi/agent')
  for (const path of [cwd, sessionDir]) mkdirSync(path, { recursive: true, mode: 0o700 })

  const modelRuntime = await isolatedModelRuntime(agentDir)
  const probeModel = modelRuntime.getModel(leased.route.provider, leased.route.model)
  if (!probeModel) throw new Error(`Model absent from the Pi catalog: ${leased.route.provider}/${leased.route.model}`)
  const probed = await modelRuntime.getAuth(probeModel, {}).catch(() => null)
  if (!probed) throw new Error(`No credential for ${leased.route.provider} in ${agentDir}. Run "pi" and use /login.`)
  modelRuntime.hasConfiguredAuth = () => true

  const manager = SessionManager.create(cwd, sessionDir)
  let runtime = null
  try {
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
    await runtime.session.prompt(runInput.request)

    const textOf = (message) => {
      if (typeof message?.content === 'string') return message.content
      if (!Array.isArray(message?.content)) return ''
      return message.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }
    const entries = manager.getEntries()
    const replies = entries
      .filter((entry) => entry?.type === 'message' && entry.message?.role === 'assistant')
      .map((entry) => textOf(entry.message))
      .filter((value) => value.trim().length)
    const toolCalls = entries
      .filter((entry) => entry?.type === 'message' && Array.isArray(entry.message?.content))
      .flatMap((entry) => entry.message.content.filter((part) => part?.type === 'toolCall' || part?.type === 'tool_use'))

    const output = replies.at(-1) ?? ''
    control.finish(context, 'succeeded', output || 'Completed without text output.')
    // A succeeded attempt leaves its run awaiting trusted candidate checks, which
    // are a later stage and do not exist yet. Close it while recording that no
    // check ran, so the run does not wait forever and the job list stays honest.
    try {
      control.closeUnchecked(scope, created.runId, 'Trusted candidate checks are not built yet; no check was performed.')
    } catch {
      // Already terminal, or a check pipeline exists and owns the transition.
    }
    say('  done', `${toolCalls.length} tool call(s)`)
    return {
      roleId: role.id,
      runId: created.runId,
      model: leased.route.model,
      provider: leased.route.provider,
      toolProfile: leased.route.toolProfile,
      sessionId,
      reviewer: role.reviewer,
      toolCalls: toolCalls.length,
      output,
    }
  } catch (error) {
    const message = error?.safeMessage ?? error?.message ?? String(error)
    try {
      control.finish(context, 'failed', message)
    } catch {
      // The attempt may already be terminal; the recorded outcome stands.
    }
    throw error
  } finally {
    try {
      if (runtime) await runtime.dispose()
    } catch {
      // Disposal failure must not mask an outcome already recorded.
    }
  }
}

try {
  const snapshot = routing.read(ownerId)
  if (!snapshot.connections.length) throw new Error('No provider connection is configured. Log in with Pi, then press Connect.')
  reconcileStaleWriter()

  for (const [index, stage] of plan.stages.entries()) {
    try {
      const result = await runStage(stage, snapshot, index)
      results.push(result)
      if (stage.roleId === 'implementation' || stage.roleId === 'discovery') builder = result
    } catch (error) {
      const message = error?.safeMessage ?? error?.message ?? String(error)
      failure = { stage: stage.roleId, message }
      say('  stopped', `${stage.roleId}: ${message}`)
      // A reviewer that cannot run is a missing check, not a pass: stop rather
      // than reporting the remaining stages as if they had been performed.
      break
    }
  }

  process.stdout.write(
    JSON.stringify({
      ok: !failure,
      kind: plan.kind,
      planned: plan.stages.map((stage) => stage.roleId),
      completed: results.map((result) => ({
        roleId: result.roleId,
        runId: result.runId,
        model: result.model,
        reviewer: result.reviewer,
        toolCalls: result.toolCalls,
        output: result.output.slice(0, 2000),
      })),
      failure,
    })
  )
  if (failure) process.exitCode = 1
} catch (error) {
  const message = error?.safeMessage ?? error?.message ?? String(error)
  say('failed', message)
  process.stdout.write(JSON.stringify({ ok: false, planned: plan.stages.map((s) => s.roleId), completed: results, message }))
  process.exitCode = 1
} finally {
  try {
    await workers.recover()
  } catch {
    // The controller's record is what matters.
  }
  for (const store of [bindings, workers, routing, drafts, control]) {
    try {
      store.close()
    } catch {
      // Already closed.
    }
  }
}
