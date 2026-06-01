/**
 * Handlers IPC du module sync.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4 + BRIEF_BLOC_1 §4.5
 *                  + DESKTOP_UI_SYNC_INTEGRATION.md (sync UI v1).
 *
 * Surface IPC complète :
 *
 *   Auth (compte utilisateur sur workspace.prisme.one)
 *   --------------------------------------------------
 *   - auth:signIn()              → démarre le flow OAuth navigateur
 *   - auth:signOut()             → efface le JWT et toutes les master_keys
 *   - auth:currentUser()         → { email, plan } | null
 *
 *   Vaults (liste depuis le site SaaS ③)
 *   ------------------------------------
 *   - vaults:list()              → VaultListItem[]
 *
 *   Workspace registry (mapping workspace ↔ vault)
 *   ----------------------------------------------
 *   - workspaces:listConnected() → WorkspaceSyncEntry[]
 *   - workspaces:getEntry(root)  → WorkspaceSyncEntry | undefined
 *
 *   Sync engine
 *   -----------
 *   - sync:connect(workspaceRoot, vaultId, saltHex, vaultPassword, vaultName)
 *       → active l'engine (dérive master_key en interne, vérifie keyhash via
 *         handshake serveur) + ajoute au registry
 *   - sync:activate(config)      → low-level direct (compat smoke tests)
 *   - sync:deactivate()          → libère le WS + ferme la DB
 *   - sync:disconnect(workspaceRoot)
 *       → désactive + retire du registry + efface la master_key persistée
 *   - sync:status()              → SyncStatus
 *
 * NOTE v1 : pas de réactivation automatique au démarrage. L'utilisateur
 * ressaisit le password à chaque ouverture de l'app pour les workspaces déjà
 * connectés (cf DESKTOP_UI_SYNC_INTEGRATION.md Q3). v1.1+ pourra étendre
 * engine.activate pour accepter une masterKey précalculée et lire depuis le
 * keychain.
 *
 * SECURITY : on logue les retours non-sensibles mais JAMAIS le SyncConfig
 * complet (contient password + token), ni le password, ni la master_key, ni
 * le JWT.
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import log from "electron-log"
import { SyncEngine, type SyncConfig, type SyncStatus } from "./engine"
import { startAuthFlow } from "./auth-flow"
import { clearAuthToken, getCurrentUser, loadAuthToken } from "./auth"
import { listVaults, type VaultListItem } from "./api"
import {
  clearAllMasterKeys,
  clearMasterKey,
  loadMasterKey,
  storeMasterKey,
} from "./key-storage"
import { getActiveKeys } from "./keys"
import {
  addOrUpdateWorkspace,
  clearAllWorkspaces,
  getWorkspaceEntry,
  listConnectedWorkspaces,
  removeWorkspace,
  type WorkspaceSyncEntry,
} from "./workspace-registry"

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

export interface ConnectResult {
  ok: boolean
  error?: string
  status: SyncStatus
}

export interface CurrentUserPayload {
  email: string
  plan: "free" | "sync" | "team"
}

export interface AuthSignInResult {
  ok: boolean
  email?: string
  plan?: "free" | "sync" | "team"
  error?: string
}

/**
 * Default WS URL utilisé quand le client ne fournit pas explicitement de wsUrl.
 * En prod = wss://sync.workspace.prisme.one/sync. Configurable via env pour les
 * tests locaux.
 */
function defaultWsUrl(): string {
  return process.env.SYNC_WS_URL ?? "wss://sync.workspace.prisme.one/sync"
}

function defaultSiteUrl(): string {
  return process.env.SYNC_SITE_URL ?? "https://workspace.prisme.one"
}

export function registerSyncIpcHandlers(): void {
  // ─── Auth ────────────────────────────────────────────────────────────
  ipcMain.handle("auth:signIn", async (): Promise<AuthSignInResult> => {
    log.info("[sync/ipc] auth:signIn")
    return await startAuthFlow({ siteUrl: defaultSiteUrl() })
  })

  ipcMain.handle("auth:signOut", async (): Promise<void> => {
    log.info("[sync/ipc] auth:signOut")
    // Désactive l'engine actif s'il y en a un
    if (engine) {
      try {
        await engine.deactivate()
      } catch {
        // ignore
      }
    }
    clearAuthToken()
    clearAllMasterKeys()
    clearAllWorkspaces()
  })

  ipcMain.handle("auth:currentUser", (): CurrentUserPayload | null => {
    const u = getCurrentUser()
    if (!u) return null
    return { email: u.email, plan: u.plan }
  })

  // ─── Vaults ──────────────────────────────────────────────────────────
  ipcMain.handle("vaults:list", async (): Promise<VaultListItem[]> => {
    log.info("[sync/ipc] vaults:list")
    return await listVaults()
  })

  // ─── Workspace registry ──────────────────────────────────────────────
  ipcMain.handle(
    "workspaces:listConnected",
    (): WorkspaceSyncEntry[] => listConnectedWorkspaces(),
  )

  ipcMain.handle(
    "workspaces:getEntry",
    (_e, workspaceRoot: string): WorkspaceSyncEntry | undefined =>
      getWorkspaceEntry(workspaceRoot),
  )

  // ─── High-level connect (dérive master_key + persiste + active) ──────
  ipcMain.handle(
    "sync:connect",
    async (
      _e,
      args: {
        workspaceRoot: string
        vaultId: string
        vaultName: string
        saltHex: string
        vaultPassword: string
      },
    ): Promise<ConnectResult> => {
      const { workspaceRoot, vaultId, vaultName, saltHex, vaultPassword } = args
      log.info("[sync/ipc] sync:connect", { workspaceRoot, vaultId })

      const token = loadAuthToken()
      if (!token) {
        return {
          ok: false,
          error: "Not signed in. Please sign in first.",
          status: { state: "idle" },
        }
      }

      // Active l'engine — dérive master_key via scrypt en interne et vérifie
      // le keyhash contre le serveur au handshake init.
      const eng = getEngine()
      // Reset si l'engine est resté dans un état non-idle suite à un précédent
      // échec (ex: handshake 4001 keyhash mismatch). activate() exige `idle`.
      if (eng.getStatus().state !== "idle") {
        log.info("[sync/ipc] sync:connect resetting engine before activate", {
          previousState: eng.getStatus().state,
        })
        await eng.deactivate()
      }
      try {
        await eng.activate({
          workspaceRoot,
          vaultId,
          syncToken: token,
          wsUrl: defaultWsUrl(),
          vaultPassword,
          saltHex,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn("[sync/ipc] sync:connect activate failed", { message })
        return { ok: false, error: message, status: eng.getStatus() }
      }

      // Persiste la master_key dans le keychain OS pour permettre la
      // réactivation automatique au prochain démarrage (sync:reactivate).
      // Non-fatal si safeStorage indispo : l'utilisateur ressaisira le
      // password.
      try {
        const keys = getActiveKeys(vaultId)
        storeMasterKey(vaultId, keys.masterKey)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn("[sync/ipc] storeMasterKey failed (non-fatal)", { message })
      }

      // Enregistre dans le registry pour l'UI Settings → Sync.
      addOrUpdateWorkspace({
        workspaceRoot,
        vaultId,
        vaultName,
        saltHex,
        connectedAt: new Date().toISOString(),
      })

      return { ok: true, status: eng.getStatus() }
    },
  )

  // ─── Réactivation auto (masterKey persistée → skip scrypt) ───────────
  ipcMain.handle(
    "sync:reactivate",
    async (_e, workspaceRoot: string): Promise<ConnectResult> => {
      log.info("[sync/ipc] sync:reactivate", { workspaceRoot })

      const entry = getWorkspaceEntry(workspaceRoot)
      if (!entry) {
        return {
          ok: false,
          error: "This workspace is not in the sync registry",
          status: { state: "idle" },
        }
      }
      const token = loadAuthToken()
      if (!token) {
        return {
          ok: false,
          error: "Not signed in. Please sign in first.",
          status: { state: "idle" },
        }
      }
      const masterKey = loadMasterKey(entry.vaultId)
      if (!masterKey) {
        return {
          ok: false,
          error: "Encryption key not stored. Please unlock the vault with your password.",
          status: { state: "idle" },
        }
      }

      const eng = getEngine()
      if (eng.getStatus().state !== "idle") {
        log.info("[sync/ipc] sync:reactivate resetting engine before activate", {
          previousState: eng.getStatus().state,
        })
        await eng.deactivate()
      }
      try {
        await eng.activate({
          workspaceRoot: entry.workspaceRoot,
          vaultId: entry.vaultId,
          syncToken: token,
          wsUrl: defaultWsUrl(),
          precomputedMasterKey: masterKey,
          saltHex: entry.saltHex,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn("[sync/ipc] sync:reactivate activate failed", { message })
        return { ok: false, error: message, status: eng.getStatus() }
      }

      return { ok: true, status: eng.getStatus() }
    },
  )

  // ─── Has stored master_key (UI hint pour différencier les états) ─────
  ipcMain.handle(
    "sync:hasStoredKey",
    (_e, workspaceRoot: string): boolean => {
      const entry = getWorkspaceEntry(workspaceRoot)
      if (!entry) return false
      return loadMasterKey(entry.vaultId) !== null
    },
  )

  // ─── Disconnect propre (désactive + retire du registry + efface key) ─
  ipcMain.handle(
    "sync:disconnect",
    async (_e, workspaceRoot: string): Promise<void> => {
      log.info("[sync/ipc] sync:disconnect", { workspaceRoot })
      const entry = getWorkspaceEntry(workspaceRoot)
      if (engine) {
        try {
          await engine.deactivate()
        } catch {
          // ignore
        }
      }
      if (entry) {
        clearMasterKey(entry.vaultId)
        removeWorkspace(workspaceRoot)
      }
    },
  )

  // ─── Low-level activate (compat smoke tests + scripts) ───────────────
  ipcMain.handle(
    "sync:activate",
    async (
      _e: IpcMainInvokeEvent,
      config: SyncConfig,
    ): Promise<SyncActivateResult> => {
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
