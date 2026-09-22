import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  Play,
  Plug,
  RefreshCw,
  Send,
  Square,
} from 'lucide-react'
import type {
  HexmorphState,
  HexmorphTreeNode,
  HexmorphRole,
} from '../../../shared/ipc-contracts'

/**
 * The Hexmorph workspace: the agent organization, its jobs and its candidates.
 *
 * This panel is a view over the controller. It renders what the controller
 * reports and nothing it cannot substantiate: a role with no resolvable route
 * says so, an unprobed dependency reads as unknown rather than healthy, and a
 * candidate the materializer refused is never shown as a working preview.
 */

const POLL_MS = 2000

type Tone = 'ready' | 'busy' | 'blocked' | 'unknown'

const toneClass: Record<Tone, string> = {
  ready: 'text-success',
  busy: 'text-accent',
  blocked: 'text-warning',
  unknown: 'text-muted',
}

function stateTone(state: string): Tone {
  if (['ready', 'available', 'succeeded'].includes(state)) return 'ready'
  if (['running', 'leased', 'queued', 'draining'].includes(state)) return 'busy'
  if (['unprobed', 'unknown'].includes(state)) return 'unknown'
  return 'blocked'
}

function Dot({ tone }: { tone: Tone }): React.JSX.Element {
  return <CircleDot className={`h-3 w-3 shrink-0 ${toneClass[tone]}`} aria-hidden />
}

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-xs font-semibold uppercase tracking-wide text-secondary">{title}</h2>
          {subtitle ? <span className="truncate text-[11px] text-muted">{subtitle}</span> : null}
        </div>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  )
}

function Tree({ nodes, depth = 0 }: { nodes: HexmorphTreeNode[]; depth?: number }): React.JSX.Element {
  const [closed, setClosed] = useState<Set<string>>(new Set())
  return (
    <ul className="text-[12px]">
      {nodes.map((node) => {
        const key = `${depth}/${node.name}`
        const isFolder = node.kind === 'folder'
        const isOpen = isFolder && !closed.has(key)
        return (
          <li key={key}>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-2 py-0.5 text-left hover:bg-elevated"
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => {
                if (!isFolder) return
                setClosed((previous) => {
                  const next = new Set(previous)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }}
            >
              {isFolder ? (
                isOpen ? (
                  <ChevronDown className="h-3 w-3 text-muted" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted" />
                )
              ) : node.kind === 'asset' ? (
                <ImageIcon className="h-3 w-3 text-faint" />
              ) : (
                <FileText className="h-3 w-3 text-faint" />
              )}
              <span className={isFolder ? 'text-secondary' : 'text-muted'}>{node.name}</span>
            </button>
            {isFolder && isOpen && node.children?.length ? <Tree nodes={node.children} depth={depth + 1} /> : null}
          </li>
        )
      })}
      {!nodes.length ? <li className="px-3 py-2 text-[12px] text-faint">No pages yet.</li> : null}
    </ul>
  )
}

function RoleRow({ role, busy }: { role: HexmorphRole; busy: boolean }): React.JSX.Element {
  const tone: Tone = !role.effective ? 'unknown' : busy ? 'busy' : 'ready'
  return (
    <div className="flex items-center gap-2 px-3 py-1 hover:bg-surface-hover">
      <Dot tone={tone} />
      <span className="w-44 shrink-0 truncate text-[12px] text-primary">
        {role.roleId}
        {role.reviewer ? <span className="ml-1 text-faint" title="independent reviewer">*</span> : null}
      </span>
      <span className="w-36 shrink-0 truncate text-[11px] text-muted">{role.slot}</span>
      <span className={`min-w-0 flex-1 truncate text-[11px] ${role.effective ? 'text-secondary' : 'text-faint'}`}>
        {role.effective ? `${role.effective.runner}/${role.effective.model}` : 'no route'}
      </span>
      {role.pending ? (
        <span className="shrink-0 rounded bg-warning-bg px-1.5 py-0.5 text-[10px] text-warning">
          queued {role.pending.binding.model}
        </span>
      ) : (
        <span className="shrink-0 text-[10px] text-faint">{role.source}</span>
      )}
    </div>
  )
}

export function HexmorphPanel(): React.JSX.Element {
  const [state, setState] = useState<HexmorphState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [request, setRequest] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const alive = useRef(true)

  const load = useCallback(async (projectId?: string | null) => {
    try {
      const next = await window.piDesktop.hexmorph.state(projectId ?? null)
      if (!alive.current) return
      setState(next)
      setError(null)
    } catch (caught) {
      if (!alive.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const timer = setInterval(() => void load(state?.projectId ?? null), POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
    // Poll against the selected project so a switch takes effect immediately.
  }, [load, state?.projectId])

  const run = useCallback(
    async (label: string, action: () => Promise<string | null>) => {
      setBusy(label)
      setNotice(null)
      try {
        const message = await action()
        if (message) setNotice(message)
        await load(state?.projectId ?? null)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(null)
      }
    },
    [load, state?.projectId]
  )

  const activeRuns = useMemo(() => state?.runs.filter((entry) => entry.active) ?? [], [state])
  const routed = useMemo(() => state?.roles.filter((role) => role.effective).length ?? 0, [state])

  if (error && !state) {
    const missingOwner = error.includes('hexmorph-no-owner')
    const notBuilt = error.includes('not-built') || error.includes('missing-runtime')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-warning" />
        <h2 className="text-sm font-semibold text-primary">The Hexmorph workspace is not available</h2>
        <p className="max-w-lg text-[12px] text-muted">
          {missingOwner
            ? 'No owner identity is configured. Write var/control/owner.json in the Hexmorph project, then reopen this panel.'
            : notBuilt
              ? 'The controller is not built. Run "node scripts/run.mjs build" in the Hexmorph project.'
              : 'The controller could not be read.'}
        </p>
        <code className="max-w-lg overflow-auto rounded bg-elevated px-2 py-1 text-[11px] text-muted">{error}</code>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-border-strong px-3 py-1 text-[12px] text-secondary hover:bg-surface-hover"
        >
          Try again
        </button>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading the workspace…
      </div>
    )
  }

  const blockers = state.readiness.missing
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <header className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
        <Box className="h-4 w-4 text-accent" />
        <span className="text-sm font-semibold text-primary">Hexmorph</span>
        <select
          value={state.projectId ?? ''}
          onChange={(event) =>
            void run('select', async () => {
              const next = await window.piDesktop.hexmorph.selectProject(event.target.value)
              setState(next)
              return null
            })
          }
          className="rounded border border-border-strong bg-elevated px-2 py-1 text-[12px] text-primary"
        >
          {!state.projects.length ? <option value="">no projects</option> : null}
          {state.projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.projectId}
              {project.hasDraft ? ` · r${project.revision}` : ' · no draft'}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted">
          {routed}/{state.roles.length} agents routed · {activeRuns.length} active
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run('connect', async () => {
                const result = await window.piDesktop.hexmorph.connect()
                return `${result.providers.join(', ') || 'no provider'} · ${result.models} model(s)`
              })
            }
            className="flex items-center gap-1 rounded border border-border-strong px-2 py-1 text-[11px] text-secondary hover:bg-surface-hover disabled:opacity-50"
            title="Refresh providers and models from your Pi login"
          >
            <Plug className="h-3 w-3" /> Connect
          </button>
          <button
            type="button"
            disabled={busy !== null || !state.projectId}
            onClick={() =>
              void run('preview', async () => {
                const result = await window.piDesktop.hexmorph.preview(state.projectId!, state.preview ? 'stop' : 'start')
                if (result.blocking.length) return `Preview refused: ${result.blocking[0]}`
                return result.url ? `Preview at ${result.url}` : 'Preview stopped'
              })
            }
            className="flex items-center gap-1 rounded border border-border-strong px-2 py-1 text-[11px] text-secondary hover:bg-surface-hover disabled:opacity-50"
          >
            {state.preview ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {state.preview ? 'Stop preview' : 'Preview'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void load(state.projectId)}
            className="rounded border border-border-strong p-1 text-muted hover:bg-surface-hover disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {state.preview ? (
        <a
          href={state.preview.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded border border-success bg-success-bg px-3 py-1.5 text-[12px] text-success hover:bg-success-bg"
        >
          <Globe className="h-3 w-3" /> Preview serving revision {state.preview.revision} at {state.preview.url}
        </a>
      ) : null}

      {notice ? <div className="rounded border border-border bg-elevated px-3 py-1.5 text-[12px] text-secondary">{notice}</div> : null}
      {error ? <div className="rounded border border-error bg-error-bg px-3 py-1.5 text-[12px] text-error">{error}</div> : null}

      {blockers.length ? (
        <div className="rounded border border-warning bg-warning-bg px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
            <AlertTriangle className="h-3 w-3" /> {blockers.length} blocker{blockers.length === 1 ? '' : 's'}
          </div>
          <ul className="mt-1 space-y-0.5">
            {blockers.map((blocker) => (
              <li key={blocker} className="text-[11px] text-warning">
                {blocker}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-2">
        <div className="col-span-3 flex min-h-0 flex-col gap-2">
          <Panel title="Candidate" subtitle={state.draft ? `revision ${state.draft.revision} · detached` : 'no draft'}>
            <Tree nodes={state.tree} />
          </Panel>
        </div>

        <div className="col-span-5 flex min-h-0 flex-col gap-2">
          <Panel title="Agents" subtitle={`${routed} of ${state.roles.length} routed`}>
            {state.roles.map((role) => (
              <RoleRow key={role.roleId} role={role} busy={activeRuns.length > 0 && role.roleId === 'implementation'} />
            ))}
          </Panel>
          <Panel title="Jobs" subtitle={`${state.activity.active} active · ${state.activity.succeeded} done · ${state.activity.failed} failed`}>
            {state.runs.length ? (
              state.runs.map((entry) => (
                <div key={entry.runId} className="flex items-center gap-2 px-3 py-1 hover:bg-surface-hover">
                  <Dot tone={stateTone(entry.state)} />
                  <code className="w-52 shrink-0 truncate text-[11px] text-muted">{entry.runId}</code>
                  <span className={`text-[11px] ${toneClass[stateTone(entry.state)]}`}>{entry.state}</span>
                  <span className="ml-auto text-[11px] text-faint">{entry.operations} op</span>
                </div>
              ))
            ) : (
              <p className="px-3 py-2 text-[12px] text-faint">No jobs yet. Describe a change below to dispatch one.</p>
            )}
          </Panel>
        </div>

        <div className="col-span-4 flex min-h-0 flex-col gap-2">
          <Panel title="Connections" subtitle={`catalog v${state.readiness.connectionsVersion} · ${state.readiness.catalogEntries} models`}>
            {state.connections.length ? (
              state.connections.map((connection) => (
                <div key={connection.id} className="flex items-center gap-2 px-3 py-1">
                  <Dot tone={stateTone(connection.state)} />
                  <span className="text-[12px] text-primary">{connection.id}</span>
                  <span className="ml-auto text-[11px] text-muted">{connection.provider}</span>
                </div>
              ))
            ) : (
              <p className="px-3 py-2 text-[12px] text-faint">
                No provider connected. Log in with Pi, then press Connect.
              </p>
            )}
            {state.readiness.runners.map((runner) => (
              <div key={runner.runner} className="flex items-center gap-2 px-3 py-1" title={runner.reason}>
                <Dot tone={stateTone(runner.state)} />
                <span className="text-[12px] text-secondary">{runner.runner}</span>
                <span className="ml-auto text-[11px] text-muted">{runner.state}</span>
              </div>
            ))}
          </Panel>
          <Panel title="Events" subtitle="from the controller" action={<Activity className="h-3 w-3 text-faint" />}>
            {state.events.length ? (
              state.events.map((event) => (
                <div key={`${event.runId}-${event.sequence}`} className="flex gap-2 px-3 py-0.5">
                  <span className="shrink-0 text-[10px] text-faint">
                    {event.at ? new Date(event.at).toLocaleTimeString() : '--:--:--'}
                  </span>
                  <span className="shrink-0 text-[11px] text-secondary">{event.kind}</span>
                  <span className="min-w-0 truncate text-[11px] text-muted">{event.detail}</span>
                </div>
              ))
            ) : (
              <p className="px-3 py-2 text-[12px] text-faint">No controller events for this project yet.</p>
            )}
          </Panel>
        </div>
      </div>

      <form
        className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          const text = request.trim()
          if (!text || !state.projectId) return
          void run('dispatch', async () => {
            const job = await window.piDesktop.hexmorph.dispatch(state.projectId!, text)
            setRequest('')
            return `Dispatched to ${job.roleId} on ${job.runner}/${job.model} (${job.explanation})`
          })
        }}
      >
        <input
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder={
            state.projectId
              ? 'Describe a change, for example: Update the home-page headline to mention winter hours'
              : 'Select a project first'
          }
          disabled={!state.projectId || busy !== null}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-primary outline-none placeholder:text-faint disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!request.trim() || !state.projectId || busy !== null}
          className="flex items-center gap-1 rounded bg-accent px-3 py-1 text-[12px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
        >
          <Send className="h-3 w-3" /> Dispatch
        </button>
      </form>
    </div>
  )
}
