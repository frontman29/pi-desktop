import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type {
  HexmorphState,
  HexmorphDispatchResult,
  HexmorphPreviewResult,
} from '../../shared/ipc-contracts'
import {
  readHexmorphState,
  selectHexmorphProject,
  connectHexmorph,
  dispatchHexmorphRequest,
  previewHexmorph,
  hexmorphAvailability,
} from '../hexmorph-bridge'
import { isString, isObject } from './validation'

/**
 * Hexmorph workspace handlers.
 *
 * The renderer supplies only a project identifier and request text. It never
 * supplies an owner, a role, a model or a tool scope: those come from the
 * controller, which is the only thing entitled to decide them. A project id from
 * the renderer is a selector to authorize, never authorization.
 */

/** The owner identity the controller recorded. Not renderer input. */
const OWNER_FILE_OWNER = 'ownerId'

async function resolveOwner(): Promise<string> {
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')
  const { HEXMORPH_ROOT } = await import('../hexmorph-bridge')
  try {
    const raw = await readFile(join(HEXMORPH_ROOT, 'var/control/owner.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const owner = parsed[OWNER_FILE_OWNER]
    if (isString(owner) && /^[a-zA-Z0-9_-]{1,100}$/.test(owner)) return owner
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error('hexmorph-no-owner')
}

function projectFrom(payload: unknown): string {
  if (!isObject(payload) || !isString(payload.projectId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(payload.projectId)) {
    throw new Error('hexmorph-invalid-project')
  }
  return payload.projectId
}

export function registerHexmorphHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.HEXMORPH_STATE, async (_event, payload: unknown): Promise<HexmorphState> => {
    const owner = await resolveOwner()
    const projectId = isObject(payload) && isString(payload.projectId) ? payload.projectId : null
    return await readHexmorphState(owner, projectId)
  })

  ipcMain.handle(IPC_CHANNELS.HEXMORPH_SELECT_PROJECT, async (_event, payload: unknown): Promise<HexmorphState> => {
    const owner = await resolveOwner()
    return await selectHexmorphProject(owner, projectFrom(payload))
  })

  ipcMain.handle(IPC_CHANNELS.HEXMORPH_CONNECT, async () => {
    const owner = await resolveOwner()
    return await connectHexmorph(owner)
  })

  ipcMain.handle(
    IPC_CHANNELS.HEXMORPH_DISPATCH,
    async (_event, payload: unknown): Promise<HexmorphDispatchResult> => {
      const owner = await resolveOwner()
      if (!isObject(payload) || !isString(payload.request)) throw new Error('hexmorph-invalid-request')
      const request = payload.request.trim()
      // Bound here as well as in the controller, so an oversized payload never
      // reaches a child process.
      if (!request || request.length > 8000) throw new Error('hexmorph-invalid-request')
      return await dispatchHexmorphRequest(owner, projectFrom(payload), request)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.HEXMORPH_PREVIEW,
    async (_event, payload: unknown): Promise<HexmorphPreviewResult> => {
      const owner = await resolveOwner()
      if (!isObject(payload) || (payload.action !== 'start' && payload.action !== 'stop')) {
        throw new Error('hexmorph-invalid-action')
      }
      return await previewHexmorph(owner, projectFrom(payload), payload.action)
    }
  )
}

export { hexmorphAvailability }
