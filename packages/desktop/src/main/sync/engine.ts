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
  getActiveKeys,
  hasActiveKeys,
} from "./keys"
import {
  createPullPipeline,
  type InboundPushMeta,
  type PullPipeline,
} from "./pipeline/pull"
import {
  createPushPipeline,
  createPushWaiter,
  type PushPipeline,
  type PushTransport,
  type PushWaiter,
} from "./pipeline/push"
import { stat as fsStat } from "node:fs/promises"
import { join } from "node:path"
import { openStateDb, type SyncStateDb } from "./state/db"
import { hashFile, runInitialSweep, type SweepResult } from "./sweep"
import { createWsClient, type WsClient } from "./transport/ws-client"
import { startFileWatcher, type FileWatcher, type FsEvent } from "./watcher"

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
  /** Promise du sweep initial post-ready (Étape 30) — pour les tests / IPC. */
  private initialSyncPromise: Promise<SweepResult> | undefined
  /** Pipeline push (Étape 31) — créé après ready, drainé après sweep. */
  private pushPipeline: PushPipeline | undefined
  /** Waiter actif pour le push courant — 1 à la fois (drain séquentiel). */
  private activePushWaiter: PushWaiter | undefined
  /** Empêche les drains concurrents — la queue est FIFO, 1 worker suffit. */
  private drainInFlight = false
  /** Pipeline pull (Étape 33) — réception broadcasts multi-device. */
  private pullPipeline: PullPipeline | undefined

  getStatus(): SyncStatus {
    return this.status
  }

  /**
   * Attend la fin du sweep initial post-`ready` (utile en tests / E2E).
   * Résout immédiatement avec `undefined` si l'engine n'a pas encore activé.
   */
  async awaitInitialSync(): Promise<SweepResult | undefined> {
    return this.initialSyncPromise
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
            // Étape 30 : sweep initial après ready, AVANT de démarrer le
            // watcher. Le sweep s'exécute en background — settle() libère
            // activate() immédiatement pour ne pas bloquer l'UI sur le scan
            // d'un gros workspace. Tests / E2E peuvent await awaitInitialSync().
            this.initialSyncPromise = this.runPostReadyTasks()
            settle(resolve)
            return
          }
          if (data.op === "error") {
            const msg = typeof data.message === "string" ? data.message : "unknown error"
            log.warn("[sync/engine] server error", { code: data.code, message: msg })
            // Si on a un push en cours, on le rejette plutôt que de tuer l'engine.
            if (this.activePushWaiter) {
              this.activePushWaiter.onError(msg)
              return
            }
            this.status = { state: "error", message: msg }
            settle(() => reject(new Error(`Sync server error: ${msg}`)))
            return
          }
          if (data.op === "pong") return
          // Étape 31 — routing des réponses push vers le waiter actif.
          if (data.op === "next") {
            this.activePushWaiter?.onNext()
            return
          }
          if (data.op === "ok") {
            const vv = typeof data.vault_version === "number" ? data.vault_version : undefined
            this.activePushWaiter?.onOk(vv)
            return
          }
          // Étape 33 — broadcast multi-device : un AUTRE device a push.
          // Le serveur filtre nos propres pushs (except_device_id), donc tout
          // {op:"push"} reçu vient d'un autre device.
          if (data.op === "push") {
            void this.handleInboundPush(data)
            return
          }
          log.info("[sync/engine] received op", { op: data.op })
        },
        onBinary: (chunk) => {
          // Étape 33 — chunk binaire = part d'un broadcast inbound.
          if (this.pullPipeline?.isReceiving()) {
            void this.pullPipeline.appendBinaryChunk(chunk)
            return
          }
          log.warn("[sync/engine] binary message without active inbound — ignored", {
            bytes: chunk.length,
          })
        },
        onClose: (code, reason) => {
          // Si un push est en vol, on le débloque pour libérer le drain.
          this.activePushWaiter?.onClose()
          // Reset l'inbound en cours — les chunks éventuellement reçus sont
          // corrompus si la connexion a coupé au milieu.
          this.pullPipeline?.reset()
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
   * Étapes 30 + 31 : tâches post-ready.
   *
   * Séquencement : sweep → pipeline push drain → watcher. Le sweep peuple
   * `pending_files` ; le pipeline drain la queue. Le watcher démarre après
   * pour capter les events ultérieurs (l'enqueue depuis le watcher viendra
   * en Étape 32).
   */
  private async runPostReadyTasks(): Promise<SweepResult> {
    if (!this.workspaceRoot || !this.db || !this.vaultId) {
      throw new Error("post-ready tasks called without workspaceRoot/db/vaultId")
    }
    const sweepResult = await runInitialSweep(this.workspaceRoot, this.db)

    // Étape 31 : pipeline push.
    const keys = getActiveKeys(this.vaultId)
    const transport: PushTransport = {
      sendJson: (msg) => this.ws?.sendJson(msg),
      sendBinary: (chunk) => this.ws?.sendBinary(chunk),
      beginPush: () => {
        const w = createPushWaiter()
        this.activePushWaiter = w
        return w
      },
      endPush: () => {
        this.activePushWaiter = undefined
      },
    }
    this.pushPipeline = createPushPipeline({
      workspaceRoot: this.workspaceRoot,
      db: this.db,
      keys,
      transport,
    })
    this.pullPipeline = createPullPipeline({
      workspaceRoot: this.workspaceRoot,
      db: this.db,
      keys,
    })
    await this.pushPipeline.drain()

    if (!this.watcher) {
      this.watcher = startFileWatcher({
        workspaceRoot: this.workspaceRoot,
        onEvent: (event) => {
          // Étape 32 : hash + enqueue + drain (non-bloquant).
          void this.handleFsEvent(event)
        },
      })
      await this.watcher.ready()
    }
    return sweepResult
  }

  /**
   * Étape 32 : traite un event fs et déclenche le drain push.
   *
   * - add / change : hash, skip si identique au cache, enqueue push + drain
   * - unlink : enqueue delete + drain
   * - addDir / unlinkDir : ignorés en v1 (folders pas push individuels)
   *
   * Erreurs silencieuses (warn) : si le fichier disparaît entre l'event et
   * le hash, le pipeline traitera ça comme un delete au moment du drain.
   */
  private async handleFsEvent(event: FsEvent): Promise<void> {
    if (!this.db || !this.workspaceRoot) return
    if (event.kind === "addDir" || event.kind === "unlinkDir") return

    if (event.kind === "unlink") {
      const cached = this.db.getLocalFile(event.path)
      if (!cached || cached.is_folder) return
      this.db.enqueuePending(
        event.path,
        "delete",
        JSON.stringify({ hash: cached.hash, mtime_ms: Date.now() }),
      )
      this.db.deleteLocalFile(event.path)
      void this.triggerDrain()
      return
    }

    // add / change : on hash et compare au cache pour éviter les push inutiles
    const absPath = join(this.workspaceRoot, event.path)
    let st
    try {
      st = await fsStat(absPath)
    } catch (err) {
      log.warn("[sync/engine] stat failed (race ?)", {
        path: event.path,
        err: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (!st.isFile()) return

    let hash: string
    try {
      hash = await hashFile(absPath)
    } catch (err) {
      log.warn("[sync/engine] hash failed (race ?)", {
        path: event.path,
        err: err instanceof Error ? err.message : String(err),
      })
      return
    }

    const cached = this.db.getLocalFile(event.path)
    if (cached && cached.hash === hash) return // pas de vrai changement

    const data = {
      hash,
      size: st.size,
      mtime_ms: Math.floor(st.mtimeMs),
      ctime_ms: Math.floor(st.ctimeMs),
      is_folder: false,
    }
    this.db.upsertLocalFile(event.path, data)
    this.db.enqueuePending(
      event.path,
      "push",
      JSON.stringify({
        hash: data.hash,
        size: data.size,
        mtime_ms: data.mtime_ms,
        ctime_ms: data.ctime_ms,
      }),
    )
    void this.triggerDrain()
  }

  /**
   * Étape 33 : traite un message {op:"push"} reçu = broadcast d'un autre
   * device. Le serveur filtre nos propres pushs via except_device_id, donc
   * tout ce qui arrive ici vient d'ailleurs.
   */
  private async handleInboundPush(msg: Record<string, unknown>): Promise<void> {
    if (!this.pullPipeline) return
    const meta: InboundPushMeta = {
      pathB64: typeof msg.path === "string" ? msg.path : "",
      hash: typeof msg.hash === "string" ? msg.hash : "",
      size: typeof msg.size === "number" ? msg.size : 0,
      pieces: typeof msg.pieces === "number" ? msg.pieces : 0,
      deleted: msg.deleted === true,
      ctime: typeof msg.ctime === "number" ? msg.ctime : 0,
      mtime: typeof msg.mtime === "number" ? msg.mtime : Date.now(),
      device: typeof msg.device === "string" ? msg.device : undefined,
      vaultVersion: typeof msg.vault_version === "number" ? msg.vault_version : undefined,
    }
    if (!meta.pathB64) {
      log.warn("[sync/engine] inbound push missing path — dropped")
      return
    }
    if (meta.deleted) {
      await this.pullPipeline.handleInboundDelete(meta)
      return
    }
    this.pullPipeline.beginInbound(meta)
  }

  /**
   * Lance un drain du pipeline push si aucun n'est en cours. La méthode est
   * non-bloquante : l'appelant ne doit pas await (l'erreur de drain est
   * loguée mais n'arrête pas l'engine).
   */
  private async triggerDrain(): Promise<void> {
    if (this.drainInFlight || !this.pushPipeline) return
    this.drainInFlight = true
    try {
      await this.pushPipeline.drain()
    } catch (err) {
      log.warn("[sync/engine] drain error", {
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.drainInFlight = false
    }
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
    this.initialSyncPromise = undefined
    this.pushPipeline = undefined
    this.activePushWaiter = undefined
    this.drainInFlight = false
    this.pullPipeline?.reset()
    this.pullPipeline = undefined
    this.status = { state: "idle" }
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null
}
