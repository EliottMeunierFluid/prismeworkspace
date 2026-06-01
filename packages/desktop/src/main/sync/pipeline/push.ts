/**
 * Pipeline push — drainage de `pending_files` vers le serveur sync ②.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §3.3.3 + §4.4 +
 * contracts/ws.ts (WsPushMessage / WsNextMessage / WsOkMessage).
 *
 * Flow pour un push avec contenu :
 *   client → {op:"push", uid, path:encryptedPathB64, hash, pieces, size, ...}
 *   server → {op:"next"}
 *   client → BinaryMessage[0..pieces-1]   (chunks chiffrés)
 *   server → {op:"ok", uid, vault_version}
 *
 * Flow pour un delete :
 *   client → {op:"push", uid, path, hash:"", pieces:0, deleted:true, ...}
 *   server → {op:"ok", uid}
 *
 * Le drain est séquentiel : une op à la fois pour pouvoir lier les
 * réponses `next` / `ok` à l'op en cours. Si une op échoue (timeout, erreur
 * serveur, fichier disparu), on log et on passe à la suivante — la queue
 * reste persistée et sera retentée au prochain drain. La pending entry est
 * SUPPRIMÉE après `ok` reçu (pas avant), pour ne pas perdre l'op si l'engine
 * crashe entre push et ok.
 *
 * SECURITY : le `path` envoyé sur le WS est l'output de `encryptPath`
 * (AES-SIV en base64) — JAMAIS le path clair. L'extension elle est en clair
 * (legacy Obsidian, leak mineur du type de fichier, à durcir en v2).
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, extname, join } from "node:path"
import { SYNC_CONFIG_DIRNAME } from "../constants"
import {
  encryptContentChunked,
  encryptPath,
  payloadHash,
  type VaultKeys,
} from "@prisme/sync-crypto"
import type { WsPushMessage, WsRenameMessage } from "@prisme/sync-crypto/contracts"
import log from "electron-log"
import type { PendingOp, ServerFileData, SyncStateDb } from "../state/db"

/** Délai max d'attente pour un `next` ou `ok` du serveur. */
const PUSH_ROUND_TRIP_TIMEOUT_MS = 30_000

/**
 * Waiter pour matcher next/ok à l'op en cours. Le pipeline est séquentiel
 * donc une seule instance vit à la fois ; les autres messages WS sont
 * délégués à l'engine (qui les route vers ce waiter quand actif).
 */
export interface ConflictInfo {
  currentHash: string
  currentSize: number
  currentPieces: number
  currentCtime: number
  currentMtime: number
}

export interface PushWaiter {
  /**
   * Résout au prochain `{op:"next"}` (chunks attendus) ou `{op:"conflict"}`
   * (refus serveur avant chunks). Rejette sur timeout/error/close.
   */
  awaitNextOrConflict: () => Promise<{ kind: "next" } | { kind: "conflict"; info: ConflictInfo }>
  /** Résout au prochain `{op:"ok"}` reçu. */
  awaitOk: () => Promise<{ vaultVersion?: number }>
  /** Signaux à appeler par l'engine sur réception WS. */
  onNext: () => void
  onOk: (vaultVersion?: number) => void
  onConflict: (info: ConflictInfo) => void
  onError: (message: string) => void
  onClose: () => void
}

/** Crée un waiter pour la prochaine paire next/ok. */
export function createPushWaiter(): PushWaiter {
  type NextOrConflict = { kind: "next" } | { kind: "conflict"; info: ConflictInfo }
  let nocResolve: ((v: NextOrConflict) => void) | undefined
  let nocReject: ((err: Error) => void) | undefined
  let okResolve: ((v: { vaultVersion?: number }) => void) | undefined
  let okReject: ((err: Error) => void) | undefined

  return {
    awaitNextOrConflict: () =>
      new Promise<NextOrConflict>((resolve, reject) => {
        nocResolve = resolve
        nocReject = reject
        setTimeout(() => reject(new Error("timeout waiting for 'next'|'conflict'")), PUSH_ROUND_TRIP_TIMEOUT_MS)
      }),
    awaitOk: () =>
      new Promise<{ vaultVersion?: number }>((resolve, reject) => {
        okResolve = resolve
        okReject = reject
        setTimeout(() => reject(new Error("timeout waiting for 'ok'")), PUSH_ROUND_TRIP_TIMEOUT_MS)
      }),
    onNext: () => {
      nocResolve?.({ kind: "next" })
      nocResolve = undefined
      nocReject = undefined
    },
    onOk: (vaultVersion) => {
      okResolve?.({ vaultVersion })
      okResolve = undefined
      okReject = undefined
    },
    onConflict: (info) => {
      nocResolve?.({ kind: "conflict", info })
      nocResolve = undefined
      nocReject = undefined
    },
    onError: (message) => {
      const err = new Error(`server error: ${message}`)
      nocReject?.(err)
      okReject?.(err)
    },
    onClose: () => {
      const err = new Error("WS closed mid-push")
      nocReject?.(err)
      okReject?.(err)
    },
  }
}

export interface PushTransport {
  sendJson: (msg: object) => void
  sendBinary: (chunk: Buffer) => void
  /** Crée un nouveau waiter et l'enregistre comme actif (1 à la fois). */
  beginPush: () => PushWaiter
  /** Désenregistre le waiter actif après ok/error. */
  endPush: () => void
}

export interface PushPipeline {
  /** Drain complet de la pending queue. Idempotent — no-op si vide. */
  drain: () => Promise<PushDrainResult>
}

export interface PushDrainResult {
  processed: number
  failed: number
}

export interface PushPipelineOptions {
  workspaceRoot: string
  db: SyncStateDb
  keys: VaultKeys
  transport: PushTransport
  /**
   * Étape 43 : callback appelé quand un push est rejeté par conflict.
   * Le caller doit pull le current_hash du serveur, faire conflict copy +
   * merge, puis re-enqueue le push (avec le nouveau expected_old_hash).
   * Sans cb, le push échoue silencieusement et le client perd les modifs.
   */
  onConflict?: (path: string, info: ConflictInfo, localPlaintext: Buffer) => Promise<void>
}

/**
 * Construit le pipeline push. Le caller (engine) est responsable de wirer
 * `transport.beginPush` au routing des messages WS (cf engine.ts).
 */
export function createPushPipeline(opts: PushPipelineOptions): PushPipeline {
  return {
    drain: async () => {
      let processed = 0
      let failed = 0
      // On itère op par op — listPending() renvoie un snapshot, mais on
      // re-récupère la liste à chaque tour pour absorber les enqueues
      // concurrents (watcher de l'Étape 32).
      while (true) {
        const queue = opts.db.listPending()
        if (queue.length === 0) break
        const op = queue[0]
        const ok = await pushOne(op, opts)
        if (ok) {
          opts.db.removePending(op.uid)
          processed++
        } else {
          failed++
          // Une op échouée bloque la queue (FIFO strict). On sort pour ne
          // pas tourner en boucle ; le caller relancera drain plus tard.
          break
        }
      }
      log.info("[sync/push] drain done", { processed, failed })
      return { processed, failed }
    },
  }
}

async function pushOne(op: PendingOp, opts: PushPipelineOptions): Promise<boolean> {
  if (op.op === "push") return await pushFile(op, opts)
  if (op.op === "delete") return await pushDelete(op, opts)
  if (op.op === "rename") return await pushRename(op, opts)
  log.warn("[sync/push] unsupported op", { op: op.op, uid: op.uid })
  return false
}

interface RenamePayload {
  old_path: string
  new_path: string
  mtime_ms: number
}

async function pushRename(op: PendingOp, opts: PushPipelineOptions): Promise<boolean> {
  const meta = JSON.parse(op.data) as RenamePayload
  const oldB64 = (await encryptPath(meta.old_path, opts.keys)).toString("base64")
  const newB64 = (await encryptPath(meta.new_path, opts.keys)).toString("base64")

  const renameMsg: WsRenameMessage = {
    op: "rename",
    uid: op.uid,
    old_path: oldB64,
    new_path: newB64,
    mtime: meta.mtime_ms,
  }

  log.info("[sync/push] sending rename", {
    uid: op.uid,
    old_path: meta.old_path,
    new_path: meta.new_path,
  })
  const waiter = opts.transport.beginPush()
  try {
    opts.transport.sendJson(renameMsg)
    const okResult = await waiter.awaitOk()
    log.info("[sync/push] rename ok", { uid: op.uid, vault_version: okResult.vaultVersion })

    // Update local state : déplace l'entry dans local_files + server_files
    const oldLocal = opts.db.getLocalFile(meta.old_path)
    if (oldLocal) {
      opts.db.upsertLocalFile(meta.new_path, oldLocal)
      opts.db.deleteLocalFile(meta.old_path)
    }
    const oldServer = opts.db.getServerFile(meta.old_path)
    if (oldServer) {
      opts.db.upsertServerFile(meta.new_path, { ...oldServer, encrypted_path_b64: newB64 })
      opts.db.deleteServerFile(meta.old_path)
    }
    if (okResult.vaultVersion !== undefined) {
      opts.db.setMeta("last_known_version", String(okResult.vaultVersion))
    }
    return true
  } catch (err) {
    log.warn("[sync/push] rename failed", {
      uid: op.uid,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  } finally {
    opts.transport.endPush()
  }
}

async function pushFile(op: PendingOp, opts: PushPipelineOptions): Promise<boolean> {
  // Lire le fichier clair
  const absPath = join(opts.workspaceRoot, op.path)
  let plaintext: Buffer
  try {
    plaintext = await readFile(absPath)
  } catch (err) {
    // Le fichier a disparu entre l'enqueue et le drain (rare) — on traite
    // comme un delete pour ne pas bloquer la queue.
    log.warn("[sync/push] file vanished, converting to delete", {
      path: op.path,
      err: err instanceof Error ? err.message : String(err),
    })
    return pushDelete({ ...op, op: "delete" }, opts)
  }

  // Chiffrer contenu (chunks 2 MB) + path (déterministe).
  // NB : encryptPath est async (miscreant SIV).
  const chunks = encryptContentChunked(plaintext, opts.keys)
  const encryptedPathBuf = await encryptPath(op.path, opts.keys)
  const encryptedPathB64 = encryptedPathBuf.toString("base64")
  const concatenated = Buffer.concat(chunks)
  const hashHex = payloadHash(concatenated).toString("hex")
  const sizeBytes = concatenated.length

  // ctime/mtime persistés à l'enqueue (cf sweep.ts)
  const meta = parsePushPayload(op.data)
  const extension = extname(op.path).slice(1) // "md" pas ".md"

  // Étape 43 : optimistic concurrency control. Si on a déjà sync ce fichier,
  // on envoie le hash de la dernière version serveur connue. Le serveur
  // rejette le push si sa version courante diffère = autre device a push.
  const cachedServer = opts.db.getServerFile(op.path)

  const pushMsg: WsPushMessage = {
    op: "push",
    uid: op.uid,
    path: encryptedPathB64,
    extension,
    hash: hashHex,
    ctime: meta.ctime_ms,
    mtime: meta.mtime_ms,
    folder: false,
    deleted: false,
    size: sizeBytes,
    pieces: chunks.length,
    ...(cachedServer ? { expected_old_hash: cachedServer.hash } : {}),
  }

  log.info("[sync/push] sending", {
    uid: op.uid,
    path: op.path, // path CLAIR uniquement en log local (debug), JAMAIS sur le WS
    pieces: chunks.length,
    sizeBytes,
  })

  const waiter = opts.transport.beginPush()
  try {
    opts.transport.sendJson(pushMsg)
    const firstResponse = await waiter.awaitNextOrConflict()
    if (firstResponse.kind === "conflict") {
      log.warn("[sync/push] conflict — server has newer version", {
        uid: op.uid,
        path: op.path,
        current_hash: firstResponse.info.currentHash,
      })
      await opts.onConflict?.(op.path, firstResponse.info, plaintext)
      return false
    }
    for (const chunk of chunks) opts.transport.sendBinary(chunk)
    const okResult = await waiter.awaitOk()
    log.info("[sync/push] ok", { uid: op.uid, vault_version: okResult.vaultVersion })

    // Persister l'état serveur connu pour ce fichier (pour résolution Étape 33+)
    const serverData: ServerFileData = {
      hash: hashHex,
      size: sizeBytes,
      mtime_ms: meta.mtime_ms,
      encrypted_path_b64: encryptedPathB64,
      pieces: chunks.length,
    }
    opts.db.upsertServerFile(op.path, serverData)
    if (okResult.vaultVersion !== undefined) {
      opts.db.setMeta("last_known_version", String(okResult.vaultVersion))
    }
    // Étape 44 : met à jour la base ancestor (= ce qu'on vient de push,
    // qui devient le nouveau "dernier remote sync connu").
    await writeBaseCache(opts.workspaceRoot, op.path, plaintext)
    return true
  } catch (err) {
    log.warn("[sync/push] failed", {
      uid: op.uid,
      path: op.path,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  } finally {
    opts.transport.endPush()
  }
}

async function pushDelete(op: PendingOp, opts: PushPipelineOptions): Promise<boolean> {
  const meta = parsePushPayload(op.data, { tolerantMissingMtime: true })
  const encryptedPathBuf = await encryptPath(op.path, opts.keys)
  const encryptedPathB64 = encryptedPathBuf.toString("base64")

  // NB serveur ② : WsPushSchema exige hash: /^[0-9a-f]{64}$/i même pour les
  // deletes (le hash n'est pas utilisé côté handler delete mais validé en
  // amont). On envoie un hash factice "00...0" (64 zéros hex).
  const deleteMsg: WsPushMessage = {
    op: "push",
    uid: op.uid,
    path: encryptedPathB64,
    extension: extname(op.path).slice(1),
    hash: "0".repeat(64),
    ctime: meta.ctime_ms ?? 0,
    mtime: meta.mtime_ms ?? Date.now(),
    folder: false,
    deleted: true,
    size: 0,
    pieces: 0,
  }

  log.info("[sync/push] sending delete", { uid: op.uid, path: op.path })
  const waiter = opts.transport.beginPush()
  try {
    opts.transport.sendJson(deleteMsg)
    const okResult = await waiter.awaitOk()
    log.info("[sync/push] delete ok", { uid: op.uid, vault_version: okResult.vaultVersion })
    opts.db.deleteServerFile(op.path)
    if (okResult.vaultVersion !== undefined) {
      opts.db.setMeta("last_known_version", String(okResult.vaultVersion))
    }
    return true
  } catch (err) {
    log.warn("[sync/push] delete failed", {
      uid: op.uid,
      path: op.path,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  } finally {
    opts.transport.endPush()
  }
}

interface PushPayloadMeta {
  hash?: string
  size?: number
  mtime_ms?: number
  ctime_ms?: number
}

function parsePushPayload(
  raw: string,
  options: { tolerantMissingMtime?: boolean } = {},
): { hash: string; size: number; mtime_ms: number; ctime_ms: number } & PushPayloadMeta {
  const parsed = safeJsonObject(raw)
  const mtime = typeof parsed.mtime_ms === "number" ? parsed.mtime_ms : undefined
  const ctime = typeof parsed.ctime_ms === "number" ? parsed.ctime_ms : undefined
  if (!options.tolerantMissingMtime && (mtime === undefined || ctime === undefined)) {
    throw new Error(`pending payload missing mtime/ctime: ${raw}`)
  }
  return {
    hash: typeof parsed.hash === "string" ? parsed.hash : "",
    size: typeof parsed.size === "number" ? parsed.size : 0,
    mtime_ms: mtime ?? 0,
    ctime_ms: ctime ?? 0,
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  const v = JSON.parse(raw) as unknown
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

/**
 * Hash SHA-256 hex utilitaire (utile pour vérification, pas utilisé dans le
 * flux push lui-même — on a déjà payloadHash du crypto kit pour ça).
 */
export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

/**
 * Met à jour la base ancestor cache après un push réussi (Étape 44).
 * Le fichier vivant à `<workspaceRoot>/.prisme-sync/base/<sha256(path).hex>`
 * est la référence pour un futur merge 3-way si conflit pull entrant.
 */
async function writeBaseCache(
  workspaceRoot: string,
  relPath: string,
  content: Buffer,
): Promise<void> {
  const hashed = createHash("sha256").update(relPath).digest("hex")
  const dest = join(workspaceRoot, SYNC_CONFIG_DIRNAME, "base", hashed)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, content)
}
