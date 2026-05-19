/**
 * SyncEngine — orchestrateur du client de synchronisation.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4 (côté client) +
 * BRIEF_BLOC_1_CLIENT_SYNC.md.
 *
 * Session A scope (étapes 22-29) :
 *   activate() :
 *     1. activateKeys(password, salt) → masterKey/keyContent/keyPathMac/keyPathEnc en RAM
 *     2. openStateDb(workspaceRoot) → SQLite .prisma-sync/state.db
 *     3. setMeta { vault_id, device_id, salt, keyhash } si pas déjà initialisé
 *     4. createWsClient(wsUrl, syncToken).connect()
 *     5. on open → sendJson({op:'init', vault_id, keyhash, vault_version,
 *                            initial, device, crypto_version})
 *     6. attendre {op:'ready', vault_version, per_file_max, per_push_max}
 *     7. status = 'ready'
 *
 *   Pas de push/pull en Session A — le watcher (étape 27) ne fait que loguer
 *   les events fs pour valider la stack.
 *
 * SECURITY : `vaultPassword` ne doit JAMAIS être logué, ni stocké en attribut
 * de la classe au-delà du dérivage des clés. Il est consommé puis perdu.
 */

import { randomBytes } from "node:crypto"
import log from "electron-log"
import type {
  WsInitMessage,
  WsReadyMessage,
} from "@prisme/sync-crypto/contracts"
import { CRYPTO_VERSION } from "./constants"
import {
  activateKeys,
  deactivateKeys,
  hasActiveKeys,
} from "./keys"
import { openStateDb, type SyncStateDb } from "./state/db"
import { createWsClient, type WsClient } from "./transport/ws-client"
import { startFileWatcher, type FileWatcher } from "./watcher"

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

/** Génère un device_id stable de 21 chars base64url (équivalent nanoid 21). */
function generateDeviceId(): string {
  return randomBytes(16).toString("base64url").slice(0, 21)
}

/**
 * Récupère (ou crée + persiste) le device_id local pour ce workspace.
 *
 * Le device_id est stable pour une install — il identifie un device pour la
 * pub/sub multi-device côté serveur (`except_device_id`).
 */
function getOrCreateDeviceId(db: SyncStateDb): string {
  const existing = db.getMeta("device_id")
  if (existing) return existing
  const fresh = generateDeviceId()
  db.setMeta("device_id", fresh)
  return fresh
}

export class SyncEngine {
  private status: SyncStatus = { state: "idle" }
  private db: SyncStateDb | undefined
  private ws: WsClient | undefined
  private watcher: FileWatcher | undefined
  private vaultId: string | undefined
  private workspaceRoot: string | undefined

  getStatus(): SyncStatus {
    return this.status
  }

  /**
   * Active la sync sur un workspace.
   *
   * Session A : dérive les clés, ouvre la DB, connecte le WS, envoie `init`,
   * attend `ready`. Si tout OK le statut passe à `ready` avec `vault_version`.
   * Si le serveur ferme le WS (keyhash invalide, vault not found, etc.) le
   * statut passe à `error`.
   */
  async activate(config: SyncConfig): Promise<void> {
    if (this.status.state !== "idle") {
      throw new Error(`Cannot activate from state '${this.status.state}'`)
    }
    log.info("[sync] activate requested", {
      workspaceRoot: config.workspaceRoot,
      vaultId: config.vaultId,
      wsUrl: config.wsUrl,
      // SECURITY: pas de log de vaultPassword, syncToken, saltHex.
    })
    this.status = { state: "activating" }

    // 1. Dérivation clés crypto (~50-150ms). SECURITY: le password est passé
    //    par valeur ici, et n'est jamais réutilisé après activateKeys.
    const saltBuffer = Buffer.from(config.saltHex, "hex")
    if (saltBuffer.length !== 32) {
      this.status = { state: "error", message: `Invalid salt length: ${saltBuffer.length} (expected 32)` }
      throw new Error(this.status.message)
    }
    const { keyhash } = activateKeys(config.vaultPassword, saltBuffer, config.vaultId)
    const keyhashHex = keyhash.toString("hex")

    // 2. Ouvre / crée la DB locale.
    this.db = openStateDb(config.workspaceRoot)

    // 3. Persiste les meta non-secrets (rejouables au prochain démarrage).
    this.db.setMeta("vault_id", config.vaultId)
    this.db.setMeta("salt", config.saltHex)
    this.db.setMeta("keyhash", keyhashHex)
    const deviceId = getOrCreateDeviceId(this.db)
    const lastKnownVersion = Number.parseInt(
      this.db.getMeta("last_known_version") ?? "0",
      10,
    )
    const initial = this.db.getMeta("last_known_version") === undefined

    this.vaultId = config.vaultId
    this.workspaceRoot = config.workspaceRoot

    // 4. Connexion WS + handshake init.
    await this.connectAndHandshake({
      wsUrl: config.wsUrl,
      syncToken: config.syncToken,
      vaultId: config.vaultId,
      keyhashHex,
      vaultVersion: lastKnownVersion,
      initial,
      deviceId,
    })
  }

  /**
   * Étape 26 — handshake init après l'ouverture du WS.
   *
   * @returns Promise qui résout quand le serveur envoie `ready`, rejette si le
   *          WS ferme avant `ready` ou envoie un message d'erreur.
   */
  private connectAndHandshake(args: {
    wsUrl: string
    syncToken: string
    vaultId: string
    keyhashHex: string
    vaultVersion: number
    initial: boolean
    deviceId: string
  }): Promise<void> {
    this.status = { state: "connecting" }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }

      const ws = createWsClient({
        url: args.wsUrl,
        syncToken: args.syncToken,
        onOpen: () => {
          const initMsg: WsInitMessage = {
            op: "init",
            vault_id: args.vaultId,
            keyhash: args.keyhashHex,
            vault_version: args.vaultVersion,
            initial: args.initial,
            device: args.deviceId,
            crypto_version: CRYPTO_VERSION,
          }
          log.info("[sync/engine] sending init", {
            vault_id: initMsg.vault_id,
            vault_version: initMsg.vault_version,
            initial: initMsg.initial,
            device: initMsg.device,
            crypto_version: initMsg.crypto_version,
            // SECURITY: on ne log pas le keyhash en clair (preuve de possession).
          })
          ws.sendJson(initMsg)
        },
        onMessage: (data) => {
          if (!isObject(data) || typeof data.op !== "string") {
            log.warn("[sync/engine] unexpected message shape", { data })
            return
          }
          if (data.op === "ready") {
            const ready = data as unknown as WsReadyMessage
            log.info("[sync/engine] ready", {
              vault_version: ready.vault_version,
              per_file_max: ready.per_file_max,
              per_push_max: ready.per_push_max,
            })
            this.status = { state: "ready", vaultVersion: ready.vault_version }
            this.db?.setMeta("last_known_version", String(ready.vault_version))
            // Session A : watcher démarre après ready, log only, pas de push.
            if (this.workspaceRoot && !this.watcher) {
              this.watcher = startFileWatcher({
                workspaceRoot: this.workspaceRoot,
                onEvent: (event) => {
                  // Session A : no-op applicatif (logué par le watcher). Le
                  // pipeline push (encrypt + enqueue + WS push) sera branché
                  // ici en Session B.
                  void event
                },
              })
            }
            settle(resolve)
            return
          }
          if (data.op === "error") {
            const msg = typeof data.message === "string" ? data.message : "unknown error"
            log.warn("[sync/engine] server error", { code: data.code, message: msg })
            this.status = { state: "error", message: msg }
            settle(() => reject(new Error(`Sync server error: ${msg}`)))
            return
          }
          if (data.op === "pong") return
          // Les autres opcodes (pull_meta, ok, next, …) seront gérés en Session B.
          log.info("[sync/engine] received op", { op: data.op })
        },
        onBinary: (chunk) => {
          // Session A : pas de pull en place. On accepte mais on ignore.
          log.info("[sync/engine] binary message ignored (Session A)", { bytes: chunk.length })
        },
        onClose: (code, reason) => {
          if (settled) {
            // Fermeture après ready — passage en disconnected, le reconnect
            // est géré par le ws-client. Le re-handshake init après reconnect
            // sera fait en Session B (besoin de re-stocker le callback open).
            this.status = { state: "disconnected", reason: `${code}: ${reason}` }
            return
          }
          // Fermeture avant ready = handshake refusé par le serveur (keyhash
          // invalide, vault not found, crypto_version unsupported, …).
          this.status = { state: "error", message: `Handshake failed (${code}): ${reason}` }
          settle(() => reject(new Error(this.status.state === "error" ? this.status.message : `closed: ${code}`)))
        },
      })
      this.ws = ws
      ws.connect()
    })
  }

  /**
   * Désactive la sync — ferme le WS, zeroïse les clés, ferme la DB.
   * Idempotent.
   */
  async deactivate(): Promise<void> {
    log.info("[sync] deactivate")
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = undefined
    }
    this.ws?.close()
    this.ws = undefined
    if (hasActiveKeys()) deactivateKeys()
    this.db?.close()
    this.db = undefined
    this.vaultId = undefined
    this.workspaceRoot = undefined
    this.status = { state: "idle" }
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null
}
