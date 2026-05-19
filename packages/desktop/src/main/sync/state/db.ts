/**
 * Wrapper better-sqlite3 pour l'état local de la sync.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4.2 + BRIEF_BLOC_1 §4.1.
 *
 * Convention : DB locale à `<workspace_root>/.prisma-sync/state.db`. Une DB
 * par workspace. Pas de mutualisation entre workspaces — c'est un choix.
 *
 * SECURITY : ne JAMAIS stocker password ni clés dérivées dans cette DB.
 * Seules `salt` et `keyhash` (transmissibles publiquement) sont stockés
 * pour pouvoir re-dériver les clés au login.
 */

import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import log from "electron-log"
import {
  SYNC_CONFIG_DIRNAME,
  SYNC_STATE_DB_FILENAME,
} from "../constants"

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "schema.sql",
)

// ─── Types data JSON stockés ────────────────────────────────────────────────

export interface LocalFileData {
  hash: string // SHA-256 hex du contenu en clair (pour détecter changement local)
  size: number
  mtime_ms: number
  ctime_ms: number
  is_folder: boolean
}

export interface ServerFileData {
  hash: string // SHA-256 hex du payload CHIFFRÉ entier (cf push opcode)
  size: number
  mtime_ms: number
  encrypted_path_b64: string // AES-SIV(path_clair) en base64
  pieces: number
}

export interface PendingOp {
  uid: number
  path: string
  op: "push" | "delete" | "rename"
  data: string // JSON sérialisé
}

// ─── Init / DB handle ────────────────────────────────────────────────────────

export interface SyncStateDb {
  setMeta: (key: string, value: string) => void
  getMeta: (key: string) => string | undefined
  upsertLocalFile: (path: string, data: LocalFileData) => void
  getLocalFile: (path: string) => LocalFileData | undefined
  deleteLocalFile: (path: string) => void
  listLocalFiles: () => Array<{ path: string; data: LocalFileData }>
  upsertServerFile: (path: string, data: ServerFileData) => void
  getServerFile: (path: string) => ServerFileData | undefined
  deleteServerFile: (path: string) => void
  listServerFiles: () => Array<{ path: string; data: ServerFileData }>
  enqueuePending: (path: string, op: PendingOp["op"], data: string) => number
  listPending: () => PendingOp[]
  removePending: (uid: number) => void
  close: () => void
}

/**
 * Ouvre (ou crée) la DB SQLite du workspace donné.
 *
 * Crée `<workspace_root>/.prisma-sync/state.db` si absent, applique le schema.
 */
export function openStateDb(workspaceRoot: string): SyncStateDb {
  const dir = join(workspaceRoot, SYNC_CONFIG_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, SYNC_STATE_DB_FILENAME)
  log.info("[sync/db] opening", { dbPath })

  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

  const schema = readFileSync(SCHEMA_PATH, "utf8")
  db.exec(schema)

  // ─── Prepared statements ─────────────────────────────────────────────────
  const stmts = {
    setMeta: db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),

    upsertLocal: db.prepare(
      "INSERT INTO local_files (path, data) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data",
    ),
    getLocal: db.prepare("SELECT data FROM local_files WHERE path = ?"),
    deleteLocal: db.prepare("DELETE FROM local_files WHERE path = ?"),
    listLocal: db.prepare("SELECT path, data FROM local_files ORDER BY path"),

    upsertServer: db.prepare(
      "INSERT INTO server_files (path, data) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data",
    ),
    getServer: db.prepare("SELECT data FROM server_files WHERE path = ?"),
    deleteServer: db.prepare("DELETE FROM server_files WHERE path = ?"),
    listServer: db.prepare("SELECT path, data FROM server_files ORDER BY path"),

    enqueuePending: db.prepare(
      "INSERT INTO pending_files (path, op, data) VALUES (?, ?, ?)",
    ),
    listPending: db.prepare("SELECT uid, path, op, data FROM pending_files ORDER BY uid"),
    removePending: db.prepare("DELETE FROM pending_files WHERE uid = ?"),
  }

  return {
    setMeta: (key, value) => {
      stmts.setMeta.run(key, value)
    },
    getMeta: (key) => {
      const row = stmts.getMeta.get(key) as { value: string } | undefined
      return row?.value
    },

    upsertLocalFile: (path, data) => {
      stmts.upsertLocal.run(path, JSON.stringify(data))
    },
    getLocalFile: (path) => {
      const row = stmts.getLocal.get(path) as { data: string } | undefined
      return row ? (JSON.parse(row.data) as LocalFileData) : undefined
    },
    deleteLocalFile: (path) => {
      stmts.deleteLocal.run(path)
    },
    listLocalFiles: () => {
      const rows = stmts.listLocal.all() as Array<{ path: string; data: string }>
      return rows.map((r) => ({ path: r.path, data: JSON.parse(r.data) as LocalFileData }))
    },

    upsertServerFile: (path, data) => {
      stmts.upsertServer.run(path, JSON.stringify(data))
    },
    getServerFile: (path) => {
      const row = stmts.getServer.get(path) as { data: string } | undefined
      return row ? (JSON.parse(row.data) as ServerFileData) : undefined
    },
    deleteServerFile: (path) => {
      stmts.deleteServer.run(path)
    },
    listServerFiles: () => {
      const rows = stmts.listServer.all() as Array<{ path: string; data: string }>
      return rows.map((r) => ({ path: r.path, data: JSON.parse(r.data) as ServerFileData }))
    },

    enqueuePending: (path, op, data) => {
      const info = stmts.enqueuePending.run(path, op, data)
      return Number(info.lastInsertRowid)
    },
    listPending: () => {
      return stmts.listPending.all() as PendingOp[]
    },
    removePending: (uid) => {
      stmts.removePending.run(uid)
    },

    close: () => {
      db.close()
    },
  }
}
