/**
 * Pipeline pull — réception des broadcasts multi-device.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §3.6 + serveur ②
 * `channels.ts` (broadcast metadata + N chunks).
 *
 * Quand un autre device push, le serveur ② broadcast à nos sockets :
 *   serveur → {op:"push", path:encryptedPathB64, hash, pieces, size,
 *              deleted, ctime, mtime, device, vault_version}
 *   serveur → BinaryMessage[0..pieces-1]   (sauf si deleted=true)
 *
 * On collecte les chunks, déchiffre le path + le contenu, et écrit le
 * fichier atomiquement (tempfile + rename) dans le workspace local.
 *
 * NB : on n'envoie PAS de message au serveur en retour. Le serveur garde
 * vault_version comme source de vérité ; on met juste à jour notre
 * last_known_version au passage.
 *
 * SECURITY : on ne fait JAMAIS confiance au path déchiffré pour écrire en
 * dehors du workspace. Toute traversée (".." dans le path) est rejetée
 * silencieusement avec un warn.
 */

import { createHash } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, normalize, relative, sep } from "node:path"
import { decryptContentChunked, decryptPath, type VaultKeys } from "@prisme/sync-crypto"
import log from "electron-log"
import type { LocalFileData, ServerFileData, SyncStateDb } from "../state/db"

export interface InboundPushMeta {
  /** AES-SIV(path) base64 — chiffré, à déchiffrer avec keyPathMac+keyPathEnc. */
  pathB64: string
  /** SHA-256 hex du payload chiffré entier (somme des chunks). */
  hash: string
  size: number
  pieces: number
  deleted: boolean
  ctime: number
  mtime: number
  /** Device émetteur (pour log). */
  device?: string
  vaultVersion?: number
  /** Optionnel : callback appelé à la fin du finalize (utile au bootstrap
   *  pour await chaque pull séquentiellement). */
  onComplete?: (ok: boolean) => void
}

export interface PullState {
  meta: InboundPushMeta
  receivedChunks: Buffer[]
}

export interface PullPipeline {
  /** Commence à recevoir un push entrant (cas non-deleted, pieces > 0). */
  beginInbound: (meta: InboundPushMeta) => void
  /** Push entrant deleted=true : traite immédiatement. */
  handleInboundDelete: (meta: InboundPushMeta) => Promise<void>
  /** Append un chunk binaire à l'inbound en cours. */
  appendBinaryChunk: (chunk: Buffer) => Promise<void>
  /** Reset si erreur (close WS, etc.). */
  reset: () => void
  /** True si on collecte des chunks d'un push entrant. */
  isReceiving: () => boolean
}

export interface PullPipelineOptions {
  workspaceRoot: string
  db: SyncStateDb
  keys: VaultKeys
}

export function createPullPipeline(opts: PullPipelineOptions): PullPipeline {
  let state: PullState | undefined

  return {
    beginInbound: (meta) => {
      if (state) {
        log.warn("[sync/pull] inbound already in progress — dropping previous", {
          previousPieces: state.meta.pieces,
          previousReceived: state.receivedChunks.length,
        })
      }
      state = { meta, receivedChunks: [] }
      log.info("[sync/pull] inbound begin", {
        pieces: meta.pieces,
        size: meta.size,
        device: meta.device,
        vault_version: meta.vaultVersion,
      })
    },

    handleInboundDelete: async (meta) => {
      const path = await safeDecryptPath(meta.pathB64, opts.keys, opts.workspaceRoot)
      if (!path) return
      log.info("[sync/pull] inbound delete", { path, device: meta.device })
      const absPath = join(opts.workspaceRoot, path)
      await rm(absPath, { force: true })
      opts.db.deleteLocalFile(path)
      opts.db.deleteServerFile(path)
      if (meta.vaultVersion !== undefined) {
        opts.db.setMeta("last_known_version", String(meta.vaultVersion))
      }
    },

    appendBinaryChunk: async (chunk) => {
      if (!state) {
        log.warn("[sync/pull] binary chunk received without active inbound — ignored")
        return
      }
      state.receivedChunks.push(chunk)
      if (state.receivedChunks.length < state.meta.pieces) return

      // Tous les chunks reçus → traitement
      const current = state
      state = undefined
      await finalizeInbound(current, opts)
    },

    reset: () => {
      state = undefined
    },

    isReceiving: () => state !== undefined,
  }
}

async function finalizeInbound(s: PullState, opts: PullPipelineOptions): Promise<void> {
  const path = await safeDecryptPath(s.meta.pathB64, opts.keys, opts.workspaceRoot)
  if (!path) {
    s.meta.onComplete?.(false)
    return
  }

  let ok = false
  try {
    const plaintext = await decryptContentChunked(s.receivedChunks, opts.keys)
    const absPath = join(opts.workspaceRoot, path)
    await mkdir(dirname(absPath), { recursive: true })
    await atomicWrite(absPath, plaintext)
    log.info("[sync/pull] inbound write OK", {
      path,
      bytes: plaintext.length,
      device: s.meta.device,
    })

    const localData: LocalFileData = {
      hash: sha256Hex(plaintext),
      size: plaintext.length,
      mtime_ms: s.meta.mtime,
      ctime_ms: s.meta.ctime,
      is_folder: false,
    }
    opts.db.upsertLocalFile(path, localData)

    const serverData: ServerFileData = {
      hash: s.meta.hash,
      size: s.meta.size,
      mtime_ms: s.meta.mtime,
      encrypted_path_b64: s.meta.pathB64,
      pieces: s.meta.pieces,
    }
    opts.db.upsertServerFile(path, serverData)

    if (s.meta.vaultVersion !== undefined) {
      opts.db.setMeta("last_known_version", String(s.meta.vaultVersion))
    }
    ok = true
  } catch (err) {
    log.warn("[sync/pull] inbound finalize failed", {
      path,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  s.meta.onComplete?.(ok)
}

/**
 * Écrit le fichier atomiquement : write dans tempfile à côté puis rename.
 * Évite qu'un éditeur ouvert sur le fichier voie un état partiel.
 */
async function atomicWrite(absPath: string, data: Buffer): Promise<void> {
  const tmp = `${absPath}.prisma-sync.${Date.now()}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, absPath)
}

/**
 * Déchiffre le path et valide qu'il ne sort pas du workspace.
 * Retourne undefined si invalide / dangereux.
 */
async function safeDecryptPath(
  pathB64: string,
  keys: VaultKeys,
  workspaceRoot: string,
): Promise<string | undefined> {
  let decrypted: string
  try {
    decrypted = await decryptPath(Buffer.from(pathB64, "base64"), keys)
  } catch (err) {
    log.warn("[sync/pull] path decrypt failed (wrong key ?)", {
      err: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
  // SECURITY : on normalise et vérifie qu'on reste dans le workspace.
  const normalized = normalize(decrypted)
  if (normalized.startsWith("..") || normalized.startsWith(sep) || normalized.includes("\0")) {
    log.warn("[sync/pull] path traversal attempt rejected", { path: decrypted })
    return undefined
  }
  // Double check : le path résolu doit rester sous workspaceRoot
  const abs = join(workspaceRoot, normalized)
  const rel = relative(workspaceRoot, abs)
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    log.warn("[sync/pull] path escape rejected", { path: decrypted })
    return undefined
  }
  // Retourne le path slash-style canonique
  return sep === "/" ? normalized : normalized.split(sep).join("/")
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}
