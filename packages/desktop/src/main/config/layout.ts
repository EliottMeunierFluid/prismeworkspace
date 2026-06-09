/**
 * Layout disque de la configuration Prisme dans un projet, et helpers de chemins.
 *
 * Tout vit sous `<projectDir>/.prisme-one/` (le préfixe est purement local ; le
 * manifest stocke les paths non-préfixés = identifiants serveur). Calqué sur la
 * convention du skill /update (cf prisme-one-configuration .claude/skills/update).
 *
 *   <projectDir>/
 *   ├── .mcp.json                      → symlink relatif vers .prisme-one/cache/.mcp.json
 *   ├── .claude/skills/<nom>           → symlink vers ../../.prisme-one/skills/<pole>/<nom>
 *   └── .prisme-one/
 *       ├── state/manifest.json        # { lastSync, entries: [{path,hash,scope,permission}] }
 *       ├── cache/.mcp.json
 *       └── <path serveur>             # fichiers réels (skills/…, context/…)
 */

import { join } from "node:path"

export interface LocalManifestEntry {
  path: string
  hash: string
  scope: string
  permission: "read" | "write"
}

export interface LocalManifest {
  lastSync: string | null
  entries: LocalManifestEntry[]
}

export function prismeRoot(projectDir: string): string {
  return join(projectDir, ".prisme-one")
}

export function stateDir(projectDir: string): string {
  return join(prismeRoot(projectDir), "state")
}

export function cacheDir(projectDir: string): string {
  return join(prismeRoot(projectDir), "cache")
}

export function manifestPath(projectDir: string): string {
  return join(stateDir(projectDir), "manifest.json")
}

export function mcpCachePath(projectDir: string): string {
  return join(cacheDir(projectDir), ".mcp.json")
}

export function mcpSymlinkPath(projectDir: string): string {
  return join(projectDir, ".mcp.json")
}

/** Chemin disque réel d'un fichier de config à partir de son path serveur. */
export function localFilePath(projectDir: string, serverPath: string): string {
  return join(prismeRoot(projectDir), serverPath)
}

export const EMPTY_MANIFEST: LocalManifest = { lastSync: null, entries: [] }
