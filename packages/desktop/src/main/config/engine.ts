/**
 * Moteur de synchronisation de configuration (côté desktop, natif).
 *
 * Remplace le script bash `sync.sh` + l'orchestration du skill /update : ici
 * tout est déterministe et piloté par le bouton UI, SANS IA.
 *
 * Deux opérations :
 *  - `pullConfig`  : pull simple (écrase le local) — utilisé pour la 1ère synchro.
 *  - `syncConfig`  : diff 3-way + application (pull + push + révocations +
 *                    résolutions de conflit fournies par l'UI).
 *
 * La fusion sémantique de conflit (rôle IA dans /update) est hors périmètre :
 * l'UI ne propose que "garder local" / "prendre distant".
 *
 * SÉCURITÉ : on refuse tout path serveur qui sortirait de .prisme-one/
 * (protection path-traversal), même si le serveur valide déjà de son côté.
 */

import { mkdir, writeFile, readFile, rm, symlink, readlink, readdir, stat } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import log from "electron-log"
import {
  configFetch,
  configGet,
  configPush,
  fetchMcpConfig,
  type ManifestEntry,
  type PushChange,
} from "./api"
import { getValidPrismToken } from "./token-store"
import { hashContent } from "./hash"
import { diff3Way, type DiffEntry, type DiffResult } from "./diff"
import {
  cacheDir,
  EMPTY_MANIFEST,
  localFilePath,
  manifestPath,
  mcpCachePath,
  mcpSymlinkPath,
  prismeRoot,
  stateDir,
  type LocalManifest,
  type LocalManifestEntry,
} from "./layout"

export interface PullReport {
  filesDownloaded: number
  byCategory: Record<string, number>
  skillSymlinks: number
  mcpServices: number
  mcpEnabled: boolean
  lastSync: string
}

/** Garde-fou path-traversal : le fichier doit rester sous .prisme-one/. */
function assertInsidePrisme(projectDir: string, serverPath: string): string {
  const root = resolve(prismeRoot(projectDir))
  const target = resolve(localFilePath(projectDir, serverPath))
  const rel = relative(root, target)
  if (rel.startsWith("..") || rel.startsWith(sep) || resolve(root, rel) !== target) {
    throw new Error(`Chemin invalide (hors .prisme-one/) : ${serverPath}`)
  }
  return target
}

async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  const tmp = `${absPath}.tmp`
  await writeFile(tmp, content, "utf8")
  // rm+rename pas dispo simplement ; writeFile sur tmp puis move via rename.
  await rm(absPath, { force: true })
  const { rename } = await import("node:fs/promises")
  await rename(tmp, absPath)
}

function categoryOf(serverPath: string): string {
  const top = serverPath.split("/")[0]
  if (top === "skills" || top === "context") return top
  return "autres"
}

/**
 * Crée/rafraîchit un symlink par skill : `.claude/skills/<nom>` →
 * `../../.prisme-one/skills/<pole>/<nom>`. Retourne le nombre de symlinks
 * créés/à jour. Les répertoires locaux non-Prism sont laissés intacts.
 */
async function linkSkills(projectDir: string): Promise<number> {
  const skillsRoot = join(prismeRoot(projectDir), "skills")
  let poles: string[]
  try {
    poles = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return 0 // pas de skills téléchargés
  }

  const claudeSkills = join(projectDir, ".claude", "skills")
  await mkdir(claudeSkills, { recursive: true })

  let count = 0
  for (const pole of poles) {
    const poleDir = join(skillsRoot, pole)
    const names = (await readdir(poleDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
    for (const name of names) {
      const linkPath = join(claudeSkills, name)
      const targetRel = relative(claudeSkills, join(poleDir, name))
      // Si un répertoire local non-symlink porte ce nom : conflit, on saute.
      try {
        const existing = await readlink(linkPath).catch(() => null)
        if (existing === targetRel) {
          count++
          continue
        }
        const st = await stat(linkPath).catch(() => null)
        if (st && !existing) {
          log.warn("[config/engine] skill name conflict, skipping symlink", { name })
          continue
        }
        await rm(linkPath, { force: true })
      } catch {
        // ignore
      }
      await symlink(targetRel, linkPath)
      count++
    }
  }
  return count
}

/**
 * Écrit .mcp.json (cache + symlink relatif) depuis /api/mcp-config.
 * Respecte l'opt-out `.prisme-one/no-mcp`. Retourne le nombre de services et si
 * le MCP est actif.
 */
async function syncMcp(
  projectDir: string,
  prismToken: string,
): Promise<{ services: number; enabled: boolean }> {
  // opt-out
  try {
    await stat(join(prismeRoot(projectDir), "no-mcp"))
    log.info("[config/engine] MCP opt-out (.prisme-one/no-mcp)")
    return { services: 0, enabled: false }
  } catch {
    // pas d'opt-out → continuer
  }

  const cfg = await fetchMcpConfig(prismToken)
  const json = JSON.stringify(cfg, null, 2)
  await mkdir(cacheDir(projectDir), { recursive: true })
  await writeFile(mcpCachePath(projectDir), json, "utf8")

  // symlink relatif <projectDir>/.mcp.json → .prisme-one/cache/.mcp.json
  const link = mcpSymlinkPath(projectDir)
  const targetRel = relative(projectDir, mcpCachePath(projectDir))
  const existing = await readlink(link).catch(() => null)
  if (existing !== targetRel) {
    // si un vrai fichier .mcp.json existe, on le sauvegarde plutôt que l'écraser
    const st = await stat(link).catch(() => null)
    if (st && existing === null) {
      const backup = `${link}.local-backup.${st.mtimeMs}`
      const { rename } = await import("node:fs/promises")
      await rename(link, backup)
      log.warn("[config/engine] existing .mcp.json backed up", { backup })
    } else {
      await rm(link, { force: true })
    }
    await symlink(targetRel, link)
  }

  return { services: Object.keys(cfg.mcpServers ?? {}).length, enabled: true }
}

async function writeManifest(projectDir: string, manifest: LocalManifest): Promise<void> {
  await mkdir(stateDir(projectDir), { recursive: true })
  await writeFile(manifestPath(projectDir), JSON.stringify(manifest, null, 2), "utf8")
}

export async function readManifest(projectDir: string): Promise<LocalManifest> {
  try {
    const raw = await readFile(manifestPath(projectDir), "utf8")
    return JSON.parse(raw) as LocalManifest
  } catch {
    return { ...EMPTY_MANIFEST }
  }
}

/**
 * PULL complet : récupère toute la configuration accessible et l'écrit sur
 * disque. Écrase le local (pas de diff à ce stade). Le manifest n'est écrit
 * qu'en cas de succès complet (atomicité — repris au prochain run sinon).
 *
 * @param projectDir chemin absolu du projet courant.
 * @param nowIso timestamp ISO 8601 (injecté par l'appelant — pas de Date.now ici
 *   pour rester testable/déterministe).
 */
export async function pullConfig(projectDir: string, nowIso: string): Promise<PullReport> {
  const prismToken = await getValidPrismToken()

  const entries: ManifestEntry[] = await configFetch(prismToken)

  const byCategory: Record<string, number> = {}
  for (const entry of entries) {
    const file = await configGet(prismToken, entry.path)
    // vérif d'intégrité : le hash renvoyé doit correspondre au contenu normalisé
    const localHash = hashContent(file.content)
    if (file.hash && localHash !== file.hash) {
      log.warn("[config/engine] hash mismatch on pull", { path: entry.path })
    }
    const abs = assertInsidePrisme(projectDir, entry.path)
    await writeFileAtomic(abs, file.content)
    const cat = categoryOf(entry.path)
    byCategory[cat] = (byCategory[cat] ?? 0) + 1
  }

  const skillSymlinks = await linkSkills(projectDir)
  const mcp = await syncMcp(projectDir, prismToken)

  const manifest: LocalManifest = {
    lastSync: nowIso,
    entries: entries.map((e) => ({
      path: e.path,
      hash: e.hash,
      scope: e.scope,
      permission: e.permission,
    })),
  }
  await writeManifest(projectDir, manifest)

  return {
    filesDownloaded: entries.length,
    byCategory,
    skillSymlinks,
    mcpServices: mcp.services,
    mcpEnabled: mcp.enabled,
    lastSync: nowIso,
  }
}

// ─── Diff 3-way + push ────────────────────────────────────────────────────

/** Répertoires de .prisme-one/ qui ne sont PAS des fichiers de config. */
const NON_CONFIG_DIRS = new Set(["state", "cache"])

/**
 * Parcourt .prisme-one/ et calcule l'état local réel : pour chaque fichier de
 * config (hors state/ et cache/), son path serveur + son hash normalisé.
 */
export async function computeLocalState(projectDir: string): Promise<DiffEntry[]> {
  const root = prismeRoot(projectDir)
  const out: DiffEntry[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      const rel = relative(root, abs)
      const top = rel.split(sep)[0]
      if (NON_CONFIG_DIRS.has(top)) continue
      if (e.name === "no-mcp") continue
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        await walk(abs)
      } else if (e.isFile()) {
        const content = await readFile(abs, "utf8")
        // path serveur = chemin relatif à .prisme-one/, séparateurs POSIX
        const serverPath = rel.split(sep).join("/")
        out.push({ path: serverPath, hash: hashContent(content) })
      }
    }
  }

  await walk(root)
  return out
}

export interface SyncPlan {
  diff: DiffResult
}

/**
 * Calcule le plan de synchro (diff 3-way) sans rien appliquer.
 * Remote est enrichi de `permission` pour que le diff sache ce qui est writable.
 */
export async function planSync(projectDir: string): Promise<SyncPlan> {
  const prismToken = await getValidPrismToken()
  const remoteEntries = await configFetch(prismToken)

  const remote: DiffEntry[] = remoteEntries.map((e) => ({
    path: e.path,
    hash: e.hash,
    scope: e.scope,
    permission: e.permission,
  }))

  const manifest = await readManifest(projectDir)
  const ancestor: DiffEntry[] = manifest.entries.map((e) => ({
    path: e.path,
    hash: e.hash,
    scope: e.scope,
    permission: e.permission,
  }))

  const local = await computeLocalState(projectDir)

  return { diff: diff3Way(local, ancestor, remote) }
}

/** Résolution d'un conflit choisie par l'UI. */
export type ConflictResolution = "local" | "remote"

export interface SyncReport {
  pulled: number
  pushed: number
  revoked: number
  conflictsResolved: number
  rejected: { path: string; reason: string }[]
  lastSync: string
}

/**
 * Applique un plan de synchro. Le diff est recalculé en interne (source de
 * vérité), `resolutions` mappe path→choix pour les conflits, `deleteRevoked`
 * autorise la suppression des fichiers révoqués.
 *
 * Le manifest n'est mis à jour qu'en fin de parcours sans erreur fatale.
 */
export async function applySync(
  projectDir: string,
  opts: {
    resolutions?: Record<string, ConflictResolution>
    deleteRevoked?: boolean
    nowIso: string
  },
): Promise<SyncReport> {
  const prismToken = await getValidPrismToken()
  const { diff } = await planSync(projectDir)
  const resolutions = opts.resolutions ?? {}

  const rejected: { path: string; reason: string }[] = []
  const manifest = await readManifest(projectDir)
  const ancestorPaths = new Set(manifest.entries.map((e) => e.path))

  // ── 1. Pull (remote → disque) ──────────────────────────────────────────
  let pulled = 0
  const toPull = [...diff.pull]
  // conflits résolus "remote" → traités comme un pull
  for (const c of diff.conflicts) {
    if (resolutions[c.path] === "remote") {
      toPull.push({ path: c.path, hash: c.remoteHash })
    }
  }
  for (const entry of toPull) {
    const file = await configGet(prismToken, entry.path)
    const abs = assertInsidePrisme(projectDir, entry.path)
    await writeFileAtomic(abs, file.content)
    pulled++
  }

  // ── 2. Push (disque → remote) ──────────────────────────────────────────
  const pushChanges: PushChange[] = []
  const toPush = [...diff.push]
  // conflits résolus "local" → traités comme un push
  for (const c of diff.conflicts) {
    if (resolutions[c.path] === "local") {
      if (!c.writable) {
        rejected.push({ path: c.path, reason: "Fichier en lecture seule (push impossible)" })
        continue
      }
      toPush.push({ path: c.path, hash: c.localHash })
    }
  }
  for (const entry of toPush) {
    const abs = assertInsidePrisme(projectDir, entry.path)
    let content: string
    try {
      content = await readFile(abs, "utf8")
    } catch {
      rejected.push({ path: entry.path, reason: "Fichier local introuvable" })
      continue
    }
    // create si le path n'était pas connu du serveur (pas dans l'ancestor), sinon update
    const action: PushChange["action"] = ancestorPaths.has(entry.path) ? "update" : "create"
    pushChanges.push({ path: entry.path, action, content })
  }

  let pushed = 0
  if (pushChanges.length > 0) {
    const res = await configPush(prismToken, pushChanges)
    pushed = res.accepted.length
    for (const r of res.rejected) {
      rejected.push({ path: r.path, reason: r.reason ?? "rejeté par le serveur" })
    }
  }

  // ── 3. Révocations ─────────────────────────────────────────────────────
  let revoked = 0
  if (opts.deleteRevoked) {
    for (const entry of diff.revoked) {
      const abs = assertInsidePrisme(projectDir, entry.path)
      await rm(abs, { force: true })
      revoked++
    }
  }

  // ── 4. Symlinks + MCP + manifest ───────────────────────────────────────
  await linkSkills(projectDir)
  await syncMcp(projectDir, prismToken)

  // Nouveau manifest = remote courant (reflète pull + push appliqués) moins
  // les révoqués retirés. On re-fetch pour avoir l'état serveur final.
  const finalRemote = await configFetch(prismToken)
  const revokedPaths = new Set(opts.deleteRevoked ? diff.revoked.map((e) => e.path) : [])
  const entries: LocalManifestEntry[] = finalRemote
    .filter((e) => !revokedPaths.has(e.path))
    .map((e) => ({ path: e.path, hash: e.hash, scope: e.scope, permission: e.permission }))

  await writeManifest(projectDir, { lastSync: opts.nowIso, entries })

  const conflictsResolved = Object.keys(resolutions).filter((p) =>
    diff.conflicts.some((c) => c.path === p),
  ).length

  return {
    pulled,
    pushed,
    revoked,
    conflictsResolved,
    rejected,
    lastSync: opts.nowIso,
  }
}
