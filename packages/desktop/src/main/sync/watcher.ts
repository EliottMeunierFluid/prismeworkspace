/**
 * Watcher filesystem du workspace synchronisé.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4.3 + BRIEF_BLOC_1 §4.3.
 *
 * Session A scope :
 *   - Détecte add / change / unlink / addDir / unlinkDir via chokidar
 *   - Debounce stabilité fichier (FS_AWAIT_WRITE_FINISH_MS)
 *   - Ignore .prisma-sync, .git, node_modules (cf FS_IGNORED_PATTERNS)
 *   - LOG les events. Pas de pipeline push/encrypt — branché en Session B.
 *
 * Le watcher est démarré après le `ready` du handshake (cf engine.ts) pour ne
 * pas générer d'events avant d'avoir l'état serveur de référence.
 *
 * Convention paths : tous les chemins exposés au callback sont RELATIFS au
 * workspaceRoot (slash-style, pas de leading `/`). C'est ce format qui sera
 * chiffré côté pipeline push.
 */

import { relative, sep } from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import log from "electron-log"
import { FS_AWAIT_WRITE_FINISH_MS, FS_IGNORED_PATTERNS } from "./constants"

export type FsEventKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir"

export interface FsEvent {
  kind: FsEventKind
  /** Chemin relatif au workspaceRoot, slash-style (`docs/notes/hello.md`). */
  path: string
}

export interface FileWatcher {
  /** Ferme le watcher. Idempotent. */
  close: () => Promise<void>
}

export interface FileWatcherOptions {
  workspaceRoot: string
  onEvent: (event: FsEvent) => void
}

/**
 * Convertit un chemin absolu en path relatif slash-style stable cross-platform.
 */
function toRelativeSlash(workspaceRoot: string, absolute: string): string {
  const rel = relative(workspaceRoot, absolute)
  return sep === "/" ? rel : rel.split(sep).join("/")
}

/**
 * Démarre un watcher sur workspaceRoot.
 *
 * Filtres :
 *  - ignored : cf FS_IGNORED_PATTERNS (.prisma-sync / .git / node_modules)
 *  - awaitWriteFinish : attend FS_AWAIT_WRITE_FINISH_MS de stabilité avant de
 *    déclencher un `add`/`change` (gère les éditeurs qui font tempfile+rename)
 *  - ignoreInitial : true — on ne re-traite pas les fichiers existants au
 *    démarrage. La synchro initiale (full diff local/server) sera faite par un
 *    sweep séparé déclenché après `ready`, pas par le watcher.
 */
export function startFileWatcher(opts: FileWatcherOptions): FileWatcher {
  log.info("[sync/watcher] starting", { root: opts.workspaceRoot })

  const watcher: FSWatcher = chokidar.watch(opts.workspaceRoot, {
    ignored: FS_IGNORED_PATTERNS,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: FS_AWAIT_WRITE_FINISH_MS,
      pollInterval: 100,
    },
  })

  const emit = (kind: FsEventKind, absolutePath: string): void => {
    const path = toRelativeSlash(opts.workspaceRoot, absolutePath)
    if (path === "" || path.startsWith("..")) return
    log.info("[sync/watcher] event", { kind, path })
    opts.onEvent({ kind, path })
  }

  watcher.on("add", (p) => emit("add", p))
  watcher.on("change", (p) => emit("change", p))
  watcher.on("unlink", (p) => emit("unlink", p))
  watcher.on("addDir", (p) => emit("addDir", p))
  watcher.on("unlinkDir", (p) => emit("unlinkDir", p))
  watcher.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    log.warn("[sync/watcher] error", { message: msg })
  })

  let closed = false
  return {
    close: async () => {
      if (closed) return
      closed = true
      log.info("[sync/watcher] closing")
      await watcher.close()
    },
  }
}
