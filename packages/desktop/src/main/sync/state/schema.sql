-- ============================================================================
-- Prisma Workspace Sync — Schema SQLite local (côté client desktop).
--
-- Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4.2 + BRIEF_BLOC_1 §3.
--
-- 4 tables — pattern 3-way state tracking observé chez obsidian-headless :
--   * meta          — vault_id, device_id, salt hex, keyhash hex, last_known_version
--   * local_files   — ce que le client voit sur disque (état actuel)
--   * server_files  — dernier état serveur connu (snapshot pour diff/merge)
--   * pending_files — opérations en attente d'ack (offline queue)
--
-- IMPORTANT : aucun secret ne va dans cette DB. Pas de password, pas de
-- master_key, pas de keyContent/keyPath*. Seuls salt+keyhash (transmissibles
-- au serveur) y sont stockés pour rejouer deriveVaultKeys au login.
-- ============================================================================

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Clés attendues :
--   vault_id          : UUID
--   device_id         : nanoid 21 char (généré localement à la 1ère sync)
--   salt              : hex 64 chars (32B salt scrypt)
--   keyhash           : hex 64 chars (32B SHA-256(scrypt(password, salt)))
--   last_known_version: int (vault_version connu au dernier sync OK)

CREATE TABLE IF NOT EXISTS local_files (
  path TEXT PRIMARY KEY,
  data TEXT NOT NULL          -- JSON: { hash, size, mtime_ms, ctime_ms, is_folder }
);

CREATE TABLE IF NOT EXISTS server_files (
  path TEXT PRIMARY KEY,
  data TEXT NOT NULL          -- JSON: snapshot du dernier état serveur connu
                              --  { hash, size, mtime_ms, encrypted_path_b64, pieces }
);

CREATE TABLE IF NOT EXISTS pending_files (
  uid  INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  op   TEXT NOT NULL CHECK (op IN ('push', 'delete', 'rename')),
  data TEXT NOT NULL          -- JSON: payload de l'op (offline queue)
);

CREATE INDEX IF NOT EXISTS idx_pending_path ON pending_files(path);
