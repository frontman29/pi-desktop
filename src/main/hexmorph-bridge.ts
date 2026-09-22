import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type {
  HexmorphState,
  HexmorphDispatchResult,
  HexmorphPreviewResult,
} from '../shared/ipc-contracts'

/**
 * Read-only bridge to the Hexmorph controller.
 *
 * The controller owns every durable fact about projects, agents, jobs and
 * connections. This app is a view over it: it never writes controller state
 * directly, never holds a provider credential, and never decides which model a
 * role uses. It asks, renders the answer, and reports honestly when the answer
 * is "not configured".
 *
 * The query runs in the controller's own pinned Node runtime rather than in
 * Electron's. That keeps its `node:sqlite` usage on the runtime it was built and
 * tested against, and keeps a failure there from taking down the window.
 */

export const HEXMORPH_ROOT = process.env.HEXMORPH_ROOT ?? '/home/rob/Documents/pi'
/** This app's own root, where the executor script ships. */
export const HEXMORPH_APP_ROOT = process.env.PI_DESKTOP_DIR ?? '/home/rob/Documents/pi-desktop'
const PINNED_NODE = join(HEXMORPH_ROOT, 'var/toolchain/node-v24.21.0-linux-x64/bin/node')
const WORKSPACE_MODULE = join(HEXMORPH_ROOT, 'dist/server/pi-extension/workspace.js')
const MONITOR_MODULE = join(HEXMORPH_ROOT, 'dist/server/pi-extension/monitor.js')
const QUERY_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export type HexmorphAvailability =
  | { available: true }
  | { available: false; reason: string; detail: string }

/** Whether the controller is present and built, with a specific reason when not. */
export function hexmorphAvailability(): HexmorphAvailability {
  if (!existsSync(HEXMORPH_ROOT)) {
    return { available: false, reason: 'missing-root', detail: HEXMORPH_ROOT }
  }
  if (!existsSync(PINNED_NODE)) {
    return { available: false, reason: 'missing-runtime', detail: PINNED_NODE }
  }
  if (!existsSync(WORKSPACE_MODULE)) {
    return { available: false, reason: 'not-built', detail: WORKSPACE_MODULE }
  }
  return { available: true }
}

/**
 * Run one query script in the controller runtime and parse its JSON answer.
 * The script is built here, never from renderer input; callers pass values as a
 * JSON argument that the script parses, so nothing is interpolated into code.
 */
async function query<T>(body: string, argument: unknown): Promise<T> {
  const availability = hexmorphAvailability()
  if (!availability.available) {
    throw new Error(`hexmorph-unavailable:${availability.reason}:${availability.detail}`)
  }
  const script = `
const { WorkspaceService, workspaceStorage } = await import(${JSON.stringify(WORKSPACE_MODULE)});
const monitor = await import(${JSON.stringify(MONITOR_MODULE)});
const input = JSON.parse(process.argv[1] ?? 'null');
const service = new WorkspaceService(workspaceStorage());
try {
  const result = await (async () => { ${body} })();
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false,
    code: error?.code ?? null, message: error?.safeMessage ?? error?.message ?? 'unknown' }));
} finally { service.close(); }
`
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      PINNED_NODE,
      ['--input-type=module', '-e', script, JSON.stringify(argument ?? null)],
      { cwd: HEXMORPH_ROOT, timeout: QUERY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, out, err) => {
        if (error && !out) reject(new Error(`hexmorph-query-failed: ${err || error.message}`))
        else resolve(out)
      }
    )
  })
  let parsed: { ok: boolean; result?: T; code?: string | null; message?: string }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`hexmorph-unreadable-response: ${stdout.slice(0, 300)}`)
  }
  if (!parsed.ok) throw new Error(`${parsed.code ?? 'ERROR'}: ${parsed.message ?? 'unknown'}`)
  return parsed.result as T
}

/** Everything the panel renders, in one round trip. */
export async function readHexmorphState(ownerId: string, projectId: string | null): Promise<HexmorphState> {
  return await query<HexmorphState>(
    `
    const owner = input.ownerId;
    const projects = service.projects(owner);
    // The requested project is honoured only if it is one this owner actually has.
    const selected = projects.some(p => p.projectId === input.projectId)
      ? input.projectId
      : (service.selected(owner) ?? projects[0]?.projectId ?? null);
    const state = service.status(owner, selected, input.engine);
    const scope = selected ? { ownerId: owner, projectId: selected } : null;
    return {
      ownerId: owner,
      projectId: selected,
      projects,
      roles: state.roles,
      runs: state.runs,
      draft: state.draft,
      readiness: state.readiness,
      connections: service.connections(owner),
      activity: scope ? service.activity(scope) : { runs: 0, active: 0, succeeded: 0, failed: 0, cancelled: 0, operations: 0 },
      events: scope ? service.recentEvents(scope, 120) : [],
      tree: scope ? service.projectTree(scope) : [],
      preview: scope ? service.currentPreview(scope) : null,
      readAt: Date.now(),
    };
  `,
    { ownerId, projectId, engine: 'unprobed' }
  )
}

/** Select which project this window is looking at. Selection grants nothing. */
export async function selectHexmorphProject(ownerId: string, projectId: string): Promise<HexmorphState> {
  await query(`service.select(input.ownerId, input.projectId); return true;`, { ownerId, projectId })
  return await readHexmorphState(ownerId, projectId)
}

/** Refresh providers and models from the owner's own Pi login. */
export async function connectHexmorph(ownerId: string): Promise<{ providers: string[]; models: number; version: number }> {
  return await query(`return service.discoverConnections(input.ownerId);`, { ownerId })
}

/**
 * Dispatch a request as a real job. The role is chosen by the controller's own
 * rules; the renderer supplies only the request text and the project.
 */
export async function dispatchHexmorphRequest(
  ownerId: string,
  projectId: string,
  request: string
): Promise<HexmorphDispatchResult> {
  return await query<HexmorphDispatchResult>(
    `
    const job = service.submitRequest({ ownerId: input.ownerId, projectId: input.projectId }, input.request);
    return { runId: job.runId, roleId: job.roleId, request: job.request,
      model: job.route.model, runner: job.route.runner, toolProfile: job.route.toolProfile,
      explanation: job.route.explanation, estimatedCost: job.route.estimatedCost };
  `,
    { ownerId, projectId, request }
  )
}

/**
 * Run a request as a real agent turn, detached.
 *
 * The job's durable record is the controller's, not this process's: the window
 * can close, and the panel still reports the outcome from the controller. The
 * child is fully detached and its streams are released so the app never blocks
 * on it, and it is never awaited.
 */
export function executeHexmorphRequest(ownerId: string, projectId: string, request: string): { started: true } {
  const availability = hexmorphAvailability()
  if (!availability.available) {
    throw new Error(`hexmorph-unavailable:${availability.reason}:${availability.detail}`)
  }
  // The full workflow, not a single agent: the pipeline decides which agents a
  // request needs and runs the reviewers after the builder.
  const script = join(__dirname, '../../scripts/hexmorph-pipeline.mjs')
  const executor = existsSync(script) ? script : join(HEXMORPH_APP_ROOT, 'scripts/hexmorph-pipeline.mjs')
  const child = spawn(PINNED_NODE, [executor, JSON.stringify({ ownerId, projectId, request })], {
    cwd: HEXMORPH_ROOT,
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', HEXMORPH_ROOT },
  })
  child.unref()
  return { started: true }
}

/** Start or stop the pinned Apache preview for a project. */
export async function previewHexmorph(
  ownerId: string,
  projectId: string,
  action: 'start' | 'stop'
): Promise<HexmorphPreviewResult> {
  return await query<HexmorphPreviewResult>(
    `
    const scope = { ownerId: input.ownerId, projectId: input.projectId };
    if (input.action === 'stop') {
      const stopped = await service.stopPreview(scope);
      return { started: false, stopped: stopped.stopped, url: null, revision: null, blocking: [] };
    }
    const result = await service.startPreview(scope);
    return result.started
      ? { started: true, stopped: 0, url: result.preview.url, revision: result.revision, blocking: [] }
      : { started: false, stopped: 0, url: null, revision: result.revision, blocking: result.blocking };
  `,
    { ownerId, projectId, action }
  )
}
