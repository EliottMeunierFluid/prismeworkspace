import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { openStateDb, type SyncStateDb } from "./db"

// `better-sqlite3` ne tourne pas sous `bun test` (cf
// https://github.com/oven-sh/bun/issues/4290). En contexte Electron (Node) le
// module fonctionne normalement. On skippe ces tests sous bun ; ils sont
// exécutables via `node --experimental-vm-modules` ou validés en E2E via
// l'IPC sync:activate.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

describe.skipIf(isBun)("sync state db", () => {
  let dir: string
  let db: SyncStateDb

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-db-test-"))
    db = openStateDb(dir)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("meta set/get round-trips", () => {
    db.setMeta("vault_id", "abc-123")
    db.setMeta("device_id", "dev-xyz")
    expect(db.getMeta("vault_id")).toBe("abc-123")
    expect(db.getMeta("device_id")).toBe("dev-xyz")
    expect(db.getMeta("unknown")).toBeUndefined()
  })

  test("meta upsert overwrites existing value", () => {
    db.setMeta("last_known_version", "1")
    db.setMeta("last_known_version", "42")
    expect(db.getMeta("last_known_version")).toBe("42")
  })

  test("local_files CRUD + JSON round-trip", () => {
    db.upsertLocalFile("docs/hello.md", {
      hash: "deadbeef",
      size: 12,
      mtime_ms: 1700000000_000,
      ctime_ms: 1700000000_000,
      is_folder: false,
    })
    const got = db.getLocalFile("docs/hello.md")
    expect(got).toBeDefined()
    expect(got?.hash).toBe("deadbeef")
    expect(got?.size).toBe(12)
    expect(got?.is_folder).toBe(false)

    db.deleteLocalFile("docs/hello.md")
    expect(db.getLocalFile("docs/hello.md")).toBeUndefined()
  })

  test("server_files listing returns sorted paths", () => {
    db.upsertServerFile("z/b.md", {
      hash: "h2",
      size: 1,
      mtime_ms: 0,
      encrypted_path_b64: "",
      pieces: 1,
    })
    db.upsertServerFile("a/x.md", {
      hash: "h1",
      size: 1,
      mtime_ms: 0,
      encrypted_path_b64: "",
      pieces: 1,
    })
    const list = db.listServerFiles()
    expect(list.length).toBe(2)
    expect(list[0].path).toBe("a/x.md")
    expect(list[1].path).toBe("z/b.md")
  })

  test("pending queue enqueue / list / remove", () => {
    const uid1 = db.enqueuePending("a.md", "push", JSON.stringify({ size: 1 }))
    const uid2 = db.enqueuePending("b.md", "delete", "{}")
    expect(uid1).toBeGreaterThan(0)
    expect(uid2).toBeGreaterThan(uid1)

    const list = db.listPending()
    expect(list.length).toBe(2)
    expect(list[0].uid).toBe(uid1)
    expect(list[0].op).toBe("push")

    db.removePending(uid1)
    const after = db.listPending()
    expect(after.length).toBe(1)
    expect(after[0].uid).toBe(uid2)
  })
})
