/**
 * Bootstrap pull — récupération initiale des fichiers existants d'un vault
 * lors de la connexion d'un nouveau device (workspace local vide ou non
 * synchronisé avec le serveur).
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §3.6 (extension Prisma
 * vs Obsidian) + contracts/ws.ts (WsListMessage / WsListMetaMessage).
 *
 * Flow :
 *   client → {op:"list", uid:0, since_version:0}
 *   server → {op:"list_meta", items:[{path, hash, size, pieces, ctime, mtime}]}
 *   for each item où server_files[path] absent OU hash différent :
 *     client → {op:"pull", uid, path}
 *     server → {op:"pull_meta", uid, hash, size, pieces, ctime, mtime}
 *     server → BinaryMessage[0..pieces-1]
 *     pull pipeline finalize → fichier écrit + DB updated + onComplete()
 *
 * Le bootstrap est lancé UNE SEULE FOIS, juste après ready, AVANT le sweep
 * (pour que le sweep ne re-push pas les fichiers qu'on vient de tirer).
 *
 * Les pulls sont séquentiels pour simplifier le state machine. Optimisation
 * future : pipelining N pulls en parallèle.
 */

import type { ListItem } from "@prisme/sync-crypto/contracts"
import log from "electron-log"
import type { SyncStateDb } from "../state/db"
import type { PullPipeline } from "./pull"

/** Délai max pour `list_meta` ou `pull_meta`. */
const META_TIMEOUT_MS = 30_000

interface PendingInbound {
  pathB64: string
  pullPipeline: PullPipeline
  onComplete: (ok: boolean) => void
}

/**
 * Waiter pour matcher un `list_meta` ou `pull_meta` à la requête en cours.
 * Une seule paire en vol à la fois (séquentiel).
 *
 * Le contrat important : à la réception synchrone d'un `pull_meta`, le
 * waiter doit déclencher `pullPipeline.beginInbound()` IMMÉDIATEMENT (avant
 * que les chunks binaires suivants ne soient traités). C'est pour ça qu'on
 * pré-enregistre le pending inbound (path + pipeline) avec
 * `setupInboundForNextPullMeta` AVANT d'envoyer le `{op:"pull"}`.
 */
export interface BootstrapWaiter {
  awaitListMeta: () => Promise<ListItem[]>
  setupInboundForNextPullMeta: (p: PendingInbound) => void
  onListMeta: (items: ListItem[]) => void
  /**
   * Reçoit le pull_meta synchronement. Si un PendingInbound est armé,
   * déclenche immédiatement beginInbound avec le path connu côté client.
   */
  onPullMeta: (meta: { hash: string; size: number; pieces: number; ctime: number; mtime: number }) => void
  onError: (message: string) => void
  onClose: () => void
}

export function createBootstrapWaiter(): BootstrapWaiter {
  let listResolve: ((items: ListItem[]) => void) | undefined
  let listReject: ((err: Error) => void) | undefined
  let pendingInbound: PendingInbound | undefined
  let pullTimeoutHandle: NodeJS.Timeout | undefined

  return {
    awaitListMeta: () =>
      new Promise((resolve, reject) => {
        listResolve = resolve
        listReject = reject
        setTimeout(() => reject(new Error("timeout waiting for 'list_meta'")), META_TIMEOUT_MS)
      }),
    setupInboundForNextPullMeta: (p) => {
      pendingInbound = p
      pullTimeoutHandle = setTimeout(() => {
        if (pendingInbound) {
          log.warn("[sync/bootstrap] pull_meta timeout — aborting pending inbound")
          const cb = pendingInbound.onComplete
          pendingInbound = undefined
          cb(false)
        }
      }, META_TIMEOUT_MS)
    },
    onListMeta: (items) => {
      listResolve?.(items)
      listResolve = undefined
      listReject = undefined
    },
    onPullMeta: (meta) => {
      if (!pendingInbound) {
        log.warn("[sync/bootstrap] pull_meta received without armed inbound — chunks will be lost")
        return
      }
      if (pullTimeoutHandle) {
        clearTimeout(pullTimeoutHandle)
        pullTimeoutHandle = undefined
      }
      // Déclenche beginInbound SYNCHRONEMENT pour ne pas perdre les chunks
      // binaires qui arrivent dans le même tick.
      const p = pendingInbound
      pendingInbound = undefined
      p.pullPipeline.beginInbound({
        pathB64: p.pathB64,
        hash: meta.hash,
        size: meta.size,
        pieces: meta.pieces,
        deleted: false,
        ctime: meta.ctime,
        mtime: meta.mtime,
        onComplete: p.onComplete,
      })
    },
    onError: (message) => {
      const err = new Error(`server error during bootstrap: ${message}`)
      listReject?.(err)
      if (pendingInbound) {
        pendingInbound.onComplete(false)
        pendingInbound = undefined
      }
    },
    onClose: () => {
      const err = new Error("WS closed during bootstrap")
      listReject?.(err)
      if (pendingInbound) {
        pendingInbound.onComplete(false)
        pendingInbound = undefined
      }
    },
  }
}

export interface BootstrapResult {
  listed: number
  pulled: number
  skipped: number
  failed: number
}

export interface BootstrapTransport {
  sendJson: (msg: object) => void
  beginBootstrap: () => BootstrapWaiter
  endBootstrap: () => void
}

export interface BootstrapOptions {
  db: SyncStateDb
  pullPipeline: PullPipeline
  transport: BootstrapTransport
}

/**
 * Lance le bootstrap : list + pulls pour tous les fichiers que le client n'a pas
 * déjà synchronisés.
 */
export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const result: BootstrapResult = { listed: 0, pulled: 0, skipped: 0, failed: 0 }

  const waiter = opts.transport.beginBootstrap()
  try {
    opts.transport.sendJson({ op: "list", uid: 0, since_version: 0 })
    const items = await waiter.awaitListMeta()
    result.listed = items.length
    log.info("[sync/bootstrap] list_meta received", { count: items.length })

    let pullUid = 0
    for (const item of items) {
      // Skip si on a déjà ce fichier avec le même hash (cas reconnexion)
      const knownByPathB64 = findServerFileByPathB64(opts.db, item.path)
      if (knownByPathB64 && knownByPathB64.hash === item.hash) {
        result.skipped++
        continue
      }

      pullUid++
      const pulled = await pullOneItem(item, pullUid, waiter, opts)
      if (pulled) result.pulled++
      else result.failed++
    }
  } finally {
    opts.transport.endBootstrap()
  }

  log.info("[sync/bootstrap] done", result)
  return result
}

function findServerFileByPathB64(
  db: SyncStateDb,
  pathB64: string,
): { hash: string } | undefined {
  // Linear scan — acceptable au bootstrap (qu'on lance 1 fois par activate).
  for (const { data } of db.listServerFiles()) {
    if (data.encrypted_path_b64 === pathB64) return { hash: data.hash }
  }
  return undefined
}

async function pullOneItem(
  item: ListItem,
  uid: number,
  waiter: BootstrapWaiter,
  opts: BootstrapOptions,
): Promise<boolean> {
  log.info("[sync/bootstrap] pulling", { uid, pathB64Prefix: item.path.slice(0, 16) })

  // On promet le pull AVANT d'envoyer la requête : ainsi l'engine, à la
  // réception synchrone du pull_meta, fera lui-même beginInbound. Le
  // onComplete sera signalé via la promise finalize ci-dessous.
  const inboundDone = new Promise<boolean>((resolve) => {
    waiter.setupInboundForNextPullMeta({
      pathB64: item.path,
      pullPipeline: opts.pullPipeline,
      onComplete: (ok) => resolve(ok),
    })
  })

  opts.transport.sendJson({ op: "pull", uid, path: item.path })

  // On attend juste l'écoulement du pull_meta + chunks ; le finalize signale
  // via la promise inboundDone ci-dessus.
  return await inboundDone
}
