/**
 * Handlers IPC du module sync.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4 + BRIEF_BLOC_1 §4.5.
 *
 * Surface IPC Session A (debug-only — pas encore d'UI dédiée) :
 *   - sync:activate(config)   → Promise<{ ok: true } | { ok: false, error }>
 *   - sync:deactivate()       → Promise<void>
 *   - sync:status()           → SyncStatus
 *
 * Le renderer obtient le `syncToken` via fetch NextAuth côté site SaaS ③ et
 * le passe à `sync:activate`. Le `vaultPassword` arrive aussi par IPC depuis
 * un prompt UI (à ne JAMAIS persister).
 *
 * SECURITY : on logue le retour de status mais JAMAIS le SyncConfig en clair
 * (contient password + token).
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import log from "electron-log"
import { SyncEngine, type SyncConfig, type SyncStatus } from "./engine"

// Instance unique par process main (cf engine.ts — multi-workspace = futur).
let engine: SyncEngine | undefined

function getEngine(): SyncEngine {
  if (!engine) engine = new SyncEngine()
  return engine
}

export interface SyncActivateResult {
  ok: boolean
  error?: string
  status: SyncStatus
}

export function registerSyncIpcHandlers(): void {
  ipcMain.handle(
    "sync:activate",
    async (_event: IpcMainInvokeEvent, config: SyncConfig): Promise<SyncActivateResult> => {
      const eng = getEngine()
      // SECURITY: on ne log PAS le config complet (password, token, salt).
      log.info("[sync/ipc] activate", {
        workspaceRoot: config?.workspaceRoot,
        vaultId: config?.vaultId,
        wsUrl: config?.wsUrl,
      })
      try {
        await eng.activate(config)
        return { ok: true, status: eng.getStatus() }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn("[sync/ipc] activate failed", { message })
        return { ok: false, error: message, status: eng.getStatus() }
      }
    },
  )

  ipcMain.handle("sync:deactivate", async (): Promise<void> => {
    if (!engine) return
    log.info("[sync/ipc] deactivate")
    await engine.deactivate()
  })

  ipcMain.handle("sync:status", (): SyncStatus => {
    return engine ? engine.getStatus() : { state: "idle" }
  })
}

/**
 * Tear-down : à appeler avant `app.quit()` pour libérer WS + DB proprement.
 */
export async function shutdownSync(): Promise<void> {
  if (!engine) return
  log.info("[sync/ipc] shutdown")
  await engine.deactivate()
  engine = undefined
}
