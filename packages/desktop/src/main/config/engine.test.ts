/**
 * Tests d'intégration du moteur de sync config sur disque réel (temp dir).
 *
 * On mocke uniquement la couche réseau (`./api`) et le token store
 * (`./token-store`) ; tout le reste (écriture fichiers, manifest, diff,
 * symlinks, MCP, garde path-traversal) s'exécute pour de vrai.
 *
 * NB : `engine.ts` importe transitivement `electron`/`electron-store` via
 * `token-store.ts`. On neutralise ces modules pour pouvoir charger l'engine
 * sous bun:test.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// ── Neutralisation des dépendances electron (chargées via token-store) ──────
mock.module("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
mock.module("electron-store", () => ({
  default: function Store() {
    return {}
  },
}))
mock.module("electron-log", () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}))

// ── Mocks réseau pilotables par test ────────────────────────────────────────
interface RemoteFile {
  hash: string
  scope: string
  permission: "read" | "write"
  content: string
}
let remote: Map<string, RemoteFile>
const pushed: { path: string; action: string; content?: string }[] = []

mock.module("./token-store", () => ({
  getValidPrismToken: async () => "prism_test",
  clearCachedToken: () => {},
}))

mock.module("./api", () => {
  // hashContent réel pour cohérence des hashes mock.
  const { hashContent }: typeof import("./hash") = require("./hash")
  return {
    configFetch: async () =>
      [...remote.entries()].map(([path, f]) => ({
        path,
        hash: f.hash,
        scope: f.scope,
        permission: f.permission,
      })),
    configGet: async (_t: string, path: string) => {
      const f = remote.get(path)
      if (!f) throw new Error(`not found: ${path}`)
      return { path, content: f.content, hash: f.hash }
    },
    configPush: async (_t: string, changes: { path: string; action: string; content?: string }[]) => {
      const accepted: { path: string; action: string; status: string }[] = []
      for (const c of changes) {
        pushed.push(c)
        if (c.action !== "delete" && c.content !== undefined) {
          remote.set(c.path, {
            hash: hashContent(c.content),
            scope: "company",
            permission: "write",
            content: c.content,
          })
        }
        accepted.push({ path: c.path, action: c.action, status: "accepted" })
      }
      return { accepted, rejected: [] }
    },
    fetchMcpConfig: async () => ({ mcpServers: {} }),
  }
})

// Import APRÈS les mocks.
const { applySync, computeLocalState, pullConfig, readManifest } = await import("./engine")
const { hashContent } = await import("./hash")

function rf(content: string, permission: "read" | "write" = "write"): RemoteFile {
  return { hash: hashContent(content), scope: "company", permission, content }
}

describe("engine — intégration disque", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-engine-"))
    remote = new Map()
    pushed.length = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("pullConfig écrit les fichiers et le manifest", async () => {
    remote.set("skills/delivery/foo/SKILL.md", rf("# Foo\n"))
    remote.set("context/team.md", rf("team\n"))

    const report = await pullConfig(dir, "2026-06-09T00:00:00Z")

    expect(report.filesDownloaded).toBe(2)
    const foo = await readFile(join(dir, ".prisme-one/skills/delivery/foo/SKILL.md"), "utf8")
    expect(foo).toBe("# Foo\n")

    const manifest = await readManifest(dir)
    expect(manifest.lastSync).toBe("2026-06-09T00:00:00Z")
    expect(manifest.entries).toHaveLength(2)
  })

  test("computeLocalState ignore state/ et cache/", async () => {
    await mkdir(join(dir, ".prisme-one/skills/x"), { recursive: true })
    await writeFile(join(dir, ".prisme-one/skills/x/SKILL.md"), "a\n")
    await mkdir(join(dir, ".prisme-one/state"), { recursive: true })
    await writeFile(join(dir, ".prisme-one/state/manifest.json"), "{}")
    await mkdir(join(dir, ".prisme-one/cache"), { recursive: true })
    await writeFile(join(dir, ".prisme-one/cache/.mcp.json"), "{}")

    const state = await computeLocalState(dir)
    expect(state.map((e) => e.path)).toEqual(["skills/x/SKILL.md"])
    expect(state.find((e) => e.path === "skills/x/SKILL.md")?.hash).toBe(hashContent("a\n"))
  })

  test("applySync : pull d'un fichier modifié côté serveur", async () => {
    // 1ère synchro
    remote.set("context/a.md", rf("v1\n"))
    await pullConfig(dir, "t0")
    // le serveur change
    remote.set("context/a.md", rf("v2\n"))

    const report = await applySync(dir, { nowIso: "t1" })

    expect(report.pulled).toBe(1)
    expect(report.pushed).toBe(0)
    const a = await readFile(join(dir, ".prisme-one/context/a.md"), "utf8")
    expect(a).toBe("v2\n")
  })

  test("applySync : push d'un fichier modifié localement", async () => {
    remote.set("skills/delivery/s/SKILL.md", rf("base\n"))
    await pullConfig(dir, "t0")
    // modif locale
    await writeFile(join(dir, ".prisme-one/skills/delivery/s/SKILL.md"), "local-edit\n")

    const report = await applySync(dir, { nowIso: "t1" })

    expect(report.pushed).toBe(1)
    expect(pushed[0]).toMatchObject({ path: "skills/delivery/s/SKILL.md", action: "update" })
    expect(remote.get("skills/delivery/s/SKILL.md")!.content).toBe("local-edit\n")
  })

  test("applySync : conflit résolu 'remote' → pull, 'local' → push", async () => {
    remote.set("skills/d/c/SKILL.md", rf("base\n"))
    await pullConfig(dir, "t0")
    // modif des deux côtés
    await writeFile(join(dir, ".prisme-one/skills/d/c/SKILL.md"), "local\n")
    remote.set("skills/d/c/SKILL.md", rf("remote\n"))

    const report = await applySync(dir, {
      nowIso: "t1",
      resolutions: { "skills/d/c/SKILL.md": "remote" },
    })

    expect(report.conflictsResolved).toBe(1)
    expect(report.pulled).toBe(1)
    const c = await readFile(join(dir, ".prisme-one/skills/d/c/SKILL.md"), "utf8")
    expect(c).toBe("remote\n")
  })

  test("applySync : révocation supprime le fichier si deleteRevoked", async () => {
    remote.set("context/old.md", rf("old\n"))
    await pullConfig(dir, "t0")
    remote.delete("context/old.md") // révoqué côté serveur

    const report = await applySync(dir, { nowIso: "t1", deleteRevoked: true })

    expect(report.revoked).toBe(1)
    const exists = await readFile(join(dir, ".prisme-one/context/old.md"), "utf8").then(
      () => true,
      () => false,
    )
    expect(exists).toBe(false)
  })

  test("applySync : sans deleteRevoked, le fichier reste", async () => {
    remote.set("context/old.md", rf("old\n"))
    await pullConfig(dir, "t0")
    remote.delete("context/old.md")

    const report = await applySync(dir, { nowIso: "t1", deleteRevoked: false })

    expect(report.revoked).toBe(0)
    const still = await readFile(join(dir, ".prisme-one/context/old.md"), "utf8")
    expect(still).toBe("old\n")
  })

  test("applySync : aucun changement → tout à zéro", async () => {
    remote.set("context/a.md", rf("same\n"))
    await pullConfig(dir, "t0")

    const report = await applySync(dir, { nowIso: "t1" })

    expect(report.pulled).toBe(0)
    expect(report.pushed).toBe(0)
    expect(report.revoked).toBe(0)
  })
})
