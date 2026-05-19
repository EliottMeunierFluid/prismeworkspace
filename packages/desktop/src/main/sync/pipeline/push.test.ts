import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { deriveVaultKeys, generateSalt, decryptContent, decryptPath } from "@prisme/sync-crypto"
import {
  createPushPipeline,
  createPushWaiter,
  type PushTransport,
  type PushWaiter,
} from "./push"
import type { LocalFileData, PendingOp, ServerFileData, SyncStateDb } from "../state/db"

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

/**
 * Fake transport : capture sendJson / sendBinary, expose waiter pour piloter
 * next/ok depuis le test. `simulate.next()` / `simulate.ok(version?)` doivent
 * être appelés EN ASYNC pour débloquer le drain qui est en `await`.
 */
function makeFakeTransport() {
  const sent: { kind: "json" | "binary"; data: unknown }[] = []
  let activeWaiter: PushWaiter | undefined
  const transport: PushTransport = {
    sendJson: (msg) => { sent.push({ kind: "json", data: msg }) },
    sendBinary: (chunk) => { sent.push({ kind: "binary", data: chunk }) },
    beginPush: () => {
      activeWaiter = createPushWaiter()
      return activeWaiter
    },
    endPush: () => { activeWaiter = undefined },
  }
  return {
    transport,
    sent,
    next: () => activeWaiter?.onNext(),
    ok: (vv?: number) => activeWaiter?.onOk(vv),
    err: (m: string) => activeWaiter?.onError(m),
  }
}

describe("sync push pipeline", () => {
  let dir: string
  let db: SyncStateDb
  const keys = deriveVaultKeys("vault-pw-test", generateSalt())

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-push-"))
    db = makeInMemoryDb()
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test("push 1 fichier : sendJson + 1 binary + ok → server_files mis à jour", async () => {
    writeFileSync(join(dir, "hello.md"), "alpha")
    db.upsertLocalFile("hello.md", {
      hash: "x",
      size: 5,
      mtime_ms: 111,
      ctime_ms: 100,
      is_folder: false,
    })
    db.enqueuePending(
      "hello.md",
      "push",
      JSON.stringify({ hash: "x", size: 5, mtime_ms: 111, ctime_ms: 100 }),
    )

    const fake = makeFakeTransport()
    const pipeline = createPushPipeline({
      workspaceRoot: dir,
      db,
      keys,
      transport: fake.transport,
    })

    // Pilote async : on simule next puis ok après le sendJson.
    const drainPromise = pipeline.drain()
    await new Promise((r) => setTimeout(r, 10))
    fake.next()
    await new Promise((r) => setTimeout(r, 10))
    fake.ok(42)

    const result = await drainPromise
    expect(result.processed).toBe(1)
    expect(result.failed).toBe(0)

    // Vérifications sur les messages envoyés
    const jsonMsgs = fake.sent.filter((s) => s.kind === "json")
    const binaryMsgs = fake.sent.filter((s) => s.kind === "binary")
    expect(jsonMsgs.length).toBe(1)
    expect(binaryMsgs.length).toBe(1) // "alpha" < 2 MB → 1 chunk

    const pushMsg = jsonMsgs[0].data as Record<string, unknown>
    expect(pushMsg.op).toBe("push")
    expect(pushMsg.deleted).toBe(false)
    expect(pushMsg.pieces).toBe(1)
    expect(pushMsg.extension).toBe("md")

    // Path doit être l'AES-SIV(path) base64, déchiffrable
    const encryptedPathB64 = pushMsg.path as string
    const decrypted = await decryptPath(Buffer.from(encryptedPathB64, "base64"), keys)
    expect(decrypted).toBe("hello.md")

    // Chunk binaire = AES-GCM(plaintext) → décryptable en "alpha"
    const chunk = binaryMsgs[0].data as Buffer
    const plain = decryptContent(chunk, keys)
    expect(plain.toString("utf8")).toBe("alpha")

    // server_files persisté
    const stored = db.getServerFile("hello.md")
    expect(stored).toBeDefined()
    expect(stored?.pieces).toBe(1)
    expect(db.getMeta("last_known_version")).toBe("42")

    // Pending queue vidée
    expect(db.listPending().length).toBe(0)
  })

  test("delete : push avec deleted=true, pas de binary, server_files supprimé", async () => {
    db.upsertServerFile("gone.md", {
      hash: "old", size: 10, mtime_ms: 0,
      encrypted_path_b64: "x", pieces: 1,
    })
    db.enqueuePending("gone.md", "delete", JSON.stringify({ hash: "old", mtime_ms: 200 }))

    const fake = makeFakeTransport()
    const pipeline = createPushPipeline({
      workspaceRoot: dir, db, keys, transport: fake.transport,
    })

    const drainPromise = pipeline.drain()
    await new Promise((r) => setTimeout(r, 10))
    fake.ok(43)
    const result = await drainPromise

    expect(result.processed).toBe(1)
    const jsonMsgs = fake.sent.filter((s) => s.kind === "json")
    expect(jsonMsgs.length).toBe(1)
    const msg = jsonMsgs[0].data as Record<string, unknown>
    expect(msg.deleted).toBe(true)
    expect(msg.pieces).toBe(0)
    expect(msg.size).toBe(0)
    expect(fake.sent.filter((s) => s.kind === "binary").length).toBe(0)

    expect(db.getServerFile("gone.md")).toBeUndefined()
    expect(db.listPending().length).toBe(0)
  })

  test("fichier disparu entre enqueue et drain → converti en delete", async () => {
    db.enqueuePending(
      "vanished.md",
      "push",
      JSON.stringify({ hash: "x", size: 5, mtime_ms: 111, ctime_ms: 100 }),
    )
    // pas de writeFileSync → readFile va échouer

    const fake = makeFakeTransport()
    const pipeline = createPushPipeline({
      workspaceRoot: dir, db, keys, transport: fake.transport,
    })

    const drainPromise = pipeline.drain()
    await new Promise((r) => setTimeout(r, 10))
    fake.ok(50)
    const result = await drainPromise

    expect(result.processed).toBe(1)
    const msg = fake.sent.find((s) => s.kind === "json")?.data as Record<string, unknown>
    expect(msg.deleted).toBe(true)
  })

  test("server error pendant un push → 1 failed, drain s'arrête", async () => {
    writeFileSync(join(dir, "fail.md"), "boom")
    db.enqueuePending(
      "fail.md",
      "push",
      JSON.stringify({ hash: "x", size: 4, mtime_ms: 1, ctime_ms: 1 }),
    )
    db.enqueuePending(
      "ok-but-blocked.md",
      "push",
      JSON.stringify({ hash: "y", size: 2, mtime_ms: 1, ctime_ms: 1 }),
    )

    const fake = makeFakeTransport()
    const pipeline = createPushPipeline({
      workspaceRoot: dir, db, keys, transport: fake.transport,
    })

    const drainPromise = pipeline.drain()
    await new Promise((r) => setTimeout(r, 10))
    fake.err("QUOTA_EXCEEDED")
    const result = await drainPromise

    expect(result.processed).toBe(0)
    expect(result.failed).toBe(1)
    // 2 pending toujours là (drain stop on first fail, FIFO strict)
    expect(db.listPending().length).toBe(2)
  })

  test("drain vide : no-op", async () => {
    const fake = makeFakeTransport()
    const pipeline = createPushPipeline({
      workspaceRoot: dir, db, keys, transport: fake.transport,
    })
    const result = await pipeline.drain()
    expect(result.processed).toBe(0)
    expect(result.failed).toBe(0)
    expect(fake.sent.length).toBe(0)
  })
})
