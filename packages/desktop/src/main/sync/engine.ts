/**
 * SyncEngine — orchestrateur du client de synchronisation.
 *
 * Skeleton Session A — exposé via IPC, sans logique encore. Les sous-modules
 * (keys, state, transport, watcher) seront branchés dans les étapes suivantes.
 */

import log from "electron-log"

export interface SyncConfig {
  /** Chemin absolu du workspace (dossier racine que l'utilisateur veut sync). */
  workspaceRoot: string
  /** UUID du vault côté serveur (récupéré via /api/vaults). */
  vaultId: string
  /** URL du serveur sync (ex: ws://localhost:3010/sync). */
  wsUrl: string
  /** Bearer JWT obtenu via /api/auth/sync-token côté site SaaS. */
  syncToken: string
  /** Mot de passe E2EE du vault — utilisé une fois pour dériver les clés,
   *  puis OUBLIÉ. Ne JAMAIS persister, ne JAMAIS logger. */
  vaultPassword: string
  /** salt hex (32B) issu de la création du vault côté site SaaS. */
  saltHex: string
}

export type SyncStatus =
  | { state: "idle" }
  | { state: "activating" }
  | { state: "connecting" }
  | { state: "ready"; vaultVersion: number }
  | { state: "disconnected"; reason: string }
  | { state: "error"; message: string }

/**
 * Skeleton SyncEngine — à enrichir étape par étape.
 *
 * Une seule instance par process main Electron. La gestion multi-workspace
 * (vault par workspace) viendra dans une étape ultérieure.
 */
export class SyncEngine {
  private status: SyncStatus = { state: "idle" }

  getStatus(): SyncStatus {
    return this.status
  }

  /**
   * Active la sync sur un workspace. Étape 23+ : dérivera les clés crypto
   * et stockera salt/keyhash dans la DB locale. Cette session : juste un stub.
   */
  async activate(config: SyncConfig): Promise<void> {
    // SECURITY: on prend `vaultPassword` en input et on l'utilisera UNIQUEMENT
    // pour appeler deriveVaultKeys() à l'étape 23. Le password sera oublié
    // immédiatement après. Pas de log de cette valeur.
    log.info("[sync] activate requested", {
      workspaceRoot: config.workspaceRoot,
      vaultId: config.vaultId,
      // On NE LOG PAS : vaultPassword, syncToken, saltHex (sensibles)
    })
    this.status = { state: "activating" }
    // À implémenter aux étapes 23-27. Pour l'instant on simule :
    void config
    this.status = { state: "idle" }
    log.warn("[sync] activate is a no-op in Session A (skeleton)")
  }

  async deactivate(): Promise<void> {
    log.info("[sync] deactivate")
    this.status = { state: "idle" }
  }
}
