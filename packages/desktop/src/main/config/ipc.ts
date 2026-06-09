/**
 * Handlers IPC du module config (récupération de configuration sans IA).
 *
 * Surface :
 *   - config:status()                 → { configured: bool, lastSync: string|null }
 *   - config:pull(projectDir)         → PullReport
 *
 * `configured` = l'utilisateur est connecté au compte Prisme Workspace (JWT sync
 * présent) ; c'est le prérequis pour obtenir un token prism_ self-service.
 *
 * SÉCURITÉ : aucun token (JWT sync ou prism_) n'est renvoyé au renderer ni loggé.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import log from "electron-log"
import { loadAuthToken } from "../sync/auth"
import {
  applySync,
  planSync,
  pullConfig,
  readManifest,
  type ConflictResolution,
  type PullReport,
  type SyncPlan,
  type SyncReport,
} from "./engine"

export interface ConfigStatus {
  /** true si un JWT sync est présent (compte connecté). */
  configured: boolean
  /** Dernière synchro connue pour le projet, ou null. */
  lastSync: string | null
}

export function registerConfigIpcHandlers(): void {
  log.info("[config/ipc] registering handlers")

  ipcMain.handle(
    "config:status",
    async (_e: IpcMainInvokeEvent, projectDir?: string): Promise<ConfigStatus> => {
      const configured = loadAuthToken() !== null
      let lastSync: string | null = null
      if (projectDir) {
        const manifest = await readManifest(projectDir)
        lastSync = manifest.lastSync
      }
      return { configured, lastSync }
    },
  )

  ipcMain.handle(
    "config:pull",
    async (_e: IpcMainInvokeEvent, projectDir: string): Promise<PullReport> => {
      if (!projectDir) throw new Error("projectDir requis")
      // Timestamp injecté ici (process main) — l'engine reste pur/testable.
      const nowIso = new Date().toISOString()
      const report = await pullConfig(projectDir, nowIso)
      log.info("[config/ipc] pull done", {
        files: report.filesDownloaded,
        mcp: report.mcpServices,
      })
      return report
    },
  )

  // Calcule le plan de synchro (diff 3-way) sans rien appliquer — alimente l'UI.
  ipcMain.handle(
    "config:plan",
    async (_e: IpcMainInvokeEvent, projectDir: string): Promise<SyncPlan> => {
      if (!projectDir) throw new Error("projectDir requis")
      const plan = await planSync(projectDir)
      log.info("[config/ipc] plan", {
        pull: plan.diff.pull.length,
        push: plan.diff.push.length,
        conflicts: plan.diff.conflicts.length,
        revoked: plan.diff.revoked.length,
      })
      return plan
    },
  )

  // Applique la synchro avec les résolutions de conflit choisies par l'UI.
  ipcMain.handle(
    "config:apply",
    async (
      _e: IpcMainInvokeEvent,
      args: {
        projectDir: string
        resolutions?: Record<string, ConflictResolution>
        deleteRevoked?: boolean
      },
    ): Promise<SyncReport> => {
      if (!args?.projectDir) throw new Error("projectDir requis")
      const nowIso = new Date().toISOString()
      const report = await applySync(args.projectDir, {
        resolutions: args.resolutions,
        deleteRevoked: args.deleteRevoked,
        nowIso,
      })
      log.info("[config/ipc] apply done", {
        pulled: report.pulled,
        pushed: report.pushed,
        revoked: report.revoked,
        rejected: report.rejected.length,
      })
      return report
    },
  )
}
