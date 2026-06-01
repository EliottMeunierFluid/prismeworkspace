import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { runInitialSweep } from "./sweep"
import type { LocalFileData, PendingOp, ServerFileData, SyncStateDb } from "./state/db"

/**
 * Stub in-memory de SyncStateDb pour tester le sweep sans better-sqlite3
 * (bloqué par bun cf #4290). On respecte l'API exacte du wrapper réel.
 */
function makeInMemoryDb(): SyncStateDb {
  const meta = new Map<string, string>()
  const local = new Map<string, LocalFileData>()
  const server = new Map<string, ServerFileData>()
  const pending: PendingOp[] = []
  let nextUid = 1

  return {
    setMeta: (k, v) => { meta.set(k, v) },
    getMeta: (k) => meta.get(k),
    upsertLocalFile: (p, d) => { local.set(p, d) },
    getLocalFile: (p) => local.get(p),
    deleteLocalFile: (p) => { local.delete(p) },
    listLocalFiles: () => [...local.entries()].map(([path, data]) => ({ path, data })),
    upsertServerFile: (p, d) => { server.set(p, d) },
    getServerFile: (p) => server.get(p),
    deleteServerFile: (p) => { server.delete(p) },
    listServerFiles: () => [...server.entries()].map(([path, data]) => ({ path, data })),
    enqueuePending: (path, op, data) => {
      const uid = nextUid++
      pending.push({ uid, path, op, data })
      return uid
    },
    listPending: () => pending.slice(),
    removePending: (uid) => {
      const idx = pending.findIndex((p) => p.uid === uid)
      if (idx >= 0) pending.splice(idx, 1)
    },
    close: () => {},
  }
}

describe("sync sweep", () => {
  let dir: string
  let db: SyncStateDb

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-sweep-"))
    db = makeInMemoryDb()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("bootstrap : 3 fichiers neufs → 3 push enqueued", async () => {
    writeFileSync(join(dir, "a.md"), "alpha")
    writeFileSync(join(dir, "b.md"), "bravo")
    mkdirSync(join(dir, "sub"))
    writeFileSync(join(dir, "sub/c.md"), "charlie")

    const result = await runInitialSweep(dir, db)

    expect(result.pushed).toBe(3)
    expect(result.deleted).toBe(0)
    expect(result.unchanged).toBe(0)

    const queue = db.listPending()
    expect(queue.length).toBe(3)
    const paths = queue.map((p) => p.path).sort()
    expect(paths).toEqual(["a.md", "b.md", "sub/c.md"])
    expect(queue.every((p) => p.op === "push")).toBe(true)
  })

  test("re-sweep sans changement : 0 push", async () => {
    writeFileSync(join(dir, "a.md"), "alpha")
    await runInitialSweep(dir, db)

    // Vide la pending queue (simule un drain réussi du pipeline push)
    for (const p of db.listPending()) db.removePending(p.uid)

    const result = await runInitialSweep(dir, db)
    expect(result.pushed).toBe(0)
    expect(result.unchanged).toBe(1)
    expect(db.listPending().length).toBe(0)
  })

  test("fichier modifié : 1 push enqueued", async () => {
    const fileA = join(dir, "a.md")
    writeFileSync(fileA, "alpha")
    await runInitialSweep(dir, db)
    for (const p of db.listPending()) db.removePending(p.uid)

    writeFileSync(fileA, "alpha v2")
    const result = await runInitialSweep(dir, db)

    expect(result.pushed).toBe(1)
    expect(result.unchanged).toBe(0)
    const queue = db.listPending()
    expect(queue.length).toBe(1)
    expect(queue[0].path).toBe("a.md")
  })

  test("fichier supprimé : 1 delete enqueued", async () => {
    const fileA = join(dir, "a.md")
    writeFileSync(fileA, "alpha")
    await runInitialSweep(dir, db)
    for (const p of db.listPending()) db.removePending(p.uid)

    rmSync(fileA)
    const result = await runInitialSweep(dir, db)

    expect(result.pushed).toBe(0)
    expect(result.deleted).toBe(1)
    const queue = db.listPending()
    expect(queue.length).toBe(1)
    expect(queue[0].op).toBe("delete")
    expect(queue[0].path).toBe("a.md")
    // local_files doit avoir été nettoyé
    expect(db.getLocalFile("a.md")).toBeUndefined()
  })

  test("ignore .prisme-sync et .git", async () => {
    mkdirSync(join(dir, ".prisme-sync"), { recursive: true })
    writeFileSync(join(dir, ".prisme-sync/state.db"), "x")
    mkdirSync(join(dir, ".git"), { recursive: true })
    writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/main")
    writeFileSync(join(dir, "real.md"), "hello")

    const result = await runInitialSweep(dir, db)
    expect(result.pushed).toBe(1)
    const queue = db.listPending()
    expect(queue.length).toBe(1)
    expect(queue[0].path).toBe("real.md")
  })

  test("hash stable cross-run sur le même contenu", async () => {
    writeFileSync(join(dir, "a.md"), "alpha")
    await runInitialSweep(dir, db)
    const h1 = db.getLocalFile("a.md")?.hash
    expect(h1).toBeDefined()
    expect(h1?.length).toBe(64) // SHA-256 hex

    // Re-write le même contenu (hash identique attendu)
    writeFileSync(join(dir, "a.md"), "alpha")
    await runInitialSweep(dir, db)
    const h2 = db.getLocalFile("a.md")?.hash
    expect(h2).toBe(h1)
  })
})
