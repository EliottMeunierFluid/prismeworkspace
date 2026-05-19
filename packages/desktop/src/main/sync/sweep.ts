/**
 * Sweep initial du workspace après `ready` du handshake.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4.4 + BRIEF_BLOC_1 §4.4.
 *
 * Objectif : déterminer ce qui a changé sur disque depuis la dernière sync
 * connue (cache `local_files` en DB), et enqueue les diffs dans `pending_files`
 * pour drainage par le pipeline push (Étape 31).
 *
 * Diff calculé (Étape 30 — phase push only) :
 *   - Fichier sur disque, absent de local_files     → enqueue push (créé)
 *   - Fichier sur disque, hash ≠ local_files[p].hash → enqueue push (modifié)
 *   - Fichier dans local_files, absent du disque    → enqueue delete (supprimé)
 *
 * NB Étape 30 : le sweep ne touche pas encore `server_files`. La résolution
 * locale ↔ serveur (pull manquants, conflits 3-way) sera traitée en Étape 33+.
 * En bootstrap nouveau device, server_files sera peuplé via un full pull
 * AVANT que le sweep ne tourne.
 *
 * Performance : on hash en streaming (createHash + read par chunks de 64 KB)
 * pour ne pas charger un fichier de 200 MB entier en RAM. Les dossiers (mkdir)
 * sont ignorés du diff hash mais leur création est trackée (folder=true dans
 * local_files) pour pouvoir les synchroniser plus tard si besoin (snapshot).
 */

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import log from "electron-log"
import { FS_IGNORED_PATTERNS } from "./constants"
import type { LocalFileData, SyncStateDb } from "./state/db"

export interface SweepResult {
  scanned: number
  pushed: number
  deleted: number
  unchanged: number
}

interface ScannedEntry {
  /** Path relatif slash-style au workspaceRoot. */
  path: string
  is_folder: boolean
  size: number
  mtime_ms: number
  ctime_ms: number
  hash: string // SHA-256 hex du contenu clair (vide pour les folders)
}

function toRelativeSlash(workspaceRoot: string, absolute: string): string {
  const rel = relative(workspaceRoot, absolute)
  return sep === "/" ? rel : rel.split(sep).join("/")
}

function isIgnored(relativeSlashPath: string): boolean {
  return FS_IGNORED_PATTERNS.some((re) => re.test(relativeSlashPath))
}

/**
 * Hash SHA-256 d'un fichier en streaming (pas de chargement RAM complet).
 */
async function hashFile(absolutePath: string): Promise<string> {
  const h = createHash("sha256")
  const stream = createReadStream(absolutePath, { highWaterMark: 64 * 1024 })
  return new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => h.update(chunk))
    stream.on("end", () => resolve(h.digest("hex")))
    stream.on("error", (err) => reject(err))
  })
}

/**
 * Scan récursif du workspace, respecte FS_IGNORED_PATTERNS.
 */
async function scanWorkspace(workspaceRoot: string): Promise<ScannedEntry[]> {
  const out: ScannedEntry[] = []

  async function walk(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true })
    for (const e of entries) {
      const absPath = join(absDir, e.name)
      const relPath = toRelativeSlash(workspaceRoot, absPath)
      if (isIgnored(relPath)) continue

      if (e.isDirectory()) {
        const st = await stat(absPath)
        out.push({
          path: relPath,
          is_folder: true,
          size: 0,
          mtime_ms: Math.floor(st.mtimeMs),
          ctime_ms: Math.floor(st.ctimeMs),
          hash: "",
        })
        await walk(absPath)
      } else if (e.isFile()) {
        const st = await stat(absPath)
        const hash = await hashFile(absPath)
        out.push({
          path: relPath,
          is_folder: false,
          size: st.size,
          mtime_ms: Math.floor(st.mtimeMs),
          ctime_ms: Math.floor(st.ctimeMs),
          hash,
        })
      }
      // Symlinks et autres : ignorés volontairement (cf brief §4.3 — pas
      // de symlink dans la v1, source d'attaques path-traversal côté serveur).
    }
  }

  await walk(workspaceRoot)
  return out
}

/**
 * Exécute le sweep : scan disque, compare au cache local_files, enqueue les
 * diffs dans pending_files.
 *
 * @returns Compteurs pour log/UI (scanned, pushed, deleted, unchanged).
 */
export async function runInitialSweep(
  workspaceRoot: string,
  db: SyncStateDb,
): Promise<SweepResult> {
  log.info("[sync/sweep] starting", { workspaceRoot })

  const scanned = await scanWorkspace(workspaceRoot)
  const scannedByPath = new Map<string, ScannedEntry>(scanned.map((e) => [e.path, e]))

  let pushed = 0
  let deleted = 0
  let unchanged = 0

  // Pass 1 : disque → enqueue push si nouveau ou modifié, update local_files
  for (const entry of scanned) {
    if (entry.is_folder) {
      // Folders : on track dans local_files mais on ne push pas (Étape 31
      // décide si on les sync ou pas — Obsidian/Prisma n'envoient pas les
      // folders en push individuels en v1).
      const cached = db.getLocalFile(entry.path)
      if (!cached || cached.is_folder !== true) {
        const data: LocalFileData = {
          hash: "",
          size: 0,
          mtime_ms: entry.mtime_ms,
          ctime_ms: entry.ctime_ms,
          is_folder: true,
        }
        db.upsertLocalFile(entry.path, data)
      }
      continue
    }

    const cached = db.getLocalFile(entry.path)
    if (cached && !cached.is_folder && cached.hash === entry.hash) {
      unchanged++
      continue
    }

    const data: LocalFileData = {
      hash: entry.hash,
      size: entry.size,
      mtime_ms: entry.mtime_ms,
      ctime_ms: entry.ctime_ms,
      is_folder: false,
    }
    // On met à jour local_files MAINTENANT — le pipeline push (Étape 31)
    // s'attend à ce que local_files reflète l'état que le push va envoyer.
    db.upsertLocalFile(entry.path, data)

    const payload = JSON.stringify({
      hash: entry.hash,
      size: entry.size,
      mtime_ms: entry.mtime_ms,
      ctime_ms: entry.ctime_ms,
    })
    db.enqueuePending(entry.path, "push", payload)
    pushed++
  }

  // Pass 2 : local_files → enqueue delete si absent du disque
  const cachedFiles = db.listLocalFiles()
  for (const { path, data } of cachedFiles) {
    if (scannedByPath.has(path)) continue
    if (data.is_folder) {
      // Folder disparu : on retire du cache mais pas de delete WS (idem v1).
      db.deleteLocalFile(path)
      continue
    }
    db.enqueuePending(path, "delete", JSON.stringify({ hash: data.hash }))
    db.deleteLocalFile(path)
    deleted++
  }

  const result: SweepResult = {
    scanned: scanned.length,
    pushed,
    deleted,
    unchanged,
  }
  log.info("[sync/sweep] done", result)
  return result
}
