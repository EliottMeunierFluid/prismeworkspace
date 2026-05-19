import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  deriveVaultKeys,
  encryptContentChunked,
  encryptPath,
  generateSalt,
  payloadHash,
} from "@prisme/sync-crypto"
import { createPullPipeline, type InboundPushMeta } from "./pull"
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

async function buildPushMessageFor(
  path: string,
  plaintext: string,
  keys: Awaited<ReturnType<typeof deriveVaultKeys>>,
): Promise<{ meta: InboundPushMeta; chunks: Buffer[] }> {
  const chunks = encryptContentChunked(Buffer.from(plaintext, "utf8"), keys)
  const pathBuf = await encryptPath(path, keys)
  const concatenated = Buffer.concat(chunks)
  return {
    meta: {
      pathB64: pathBuf.toString("base64"),
      hash: payloadHash(concatenated).toString("hex"),
      size: concatenated.length,
      pieces: chunks.length,
      deleted: false,
      ctime: 100,
      mtime: 200,
      device: "other-device-xyz",
      vaultVersion: 42,
    },
    chunks,
  }
}

describe("sync pull pipeline", () => {
  let dir: string
  let db: SyncStateDb
  const keys = deriveVaultKeys("pull-test-pw", generateSalt())

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-pull-"))
    db = makeInMemoryDb()
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test("inbound 1 chunk : decrypt + write atomique + DB updates", async () => {
    const pipeline = createPullPipeline({ workspaceRoot: dir, db, keys })
    const { meta, chunks } = await buildPushMessageFor("docs/note.md", "from other device", keys)

    pipeline.beginInbound(meta)
    expect(pipeline.isReceiving()).toBe(true)
    await pipeline.appendBinaryChunk(chunks[0])
    expect(pipeline.isReceiving()).toBe(false)

    // Fichier écrit
    const written = readFileSync(join(dir, "docs/note.md"), "utf8")
    expect(written).toBe("from other device")

    // DB
    const local = db.getLocalFile("docs/note.md")
    expect(local).toBeDefined()
    expect(local?.size).toBe("from other device".length)

    const server = db.getServerFile("docs/note.md")
    expect(server?.hash).toBe(meta.hash)
    expect(server?.pieces).toBe(1)

    expect(db.getMeta("last_known_version")).toBe("42")
  })

  test("inbound delete : supprime fichier + DB cleanup", async () => {
    // Pré-état : on a un fichier
    writeFileSync(join(dir, "gone.md"), "to delete")
    db.upsertLocalFile("gone.md", {
      hash: "x", size: 9, mtime_ms: 0, ctime_ms: 0, is_folder: false,
    })
    db.upsertServerFile("gone.md", {
      hash: "x", size: 9, mtime_ms: 0, encrypted_path_b64: "x", pieces: 1,
    })

    const pipeline = createPullPipeline({ workspaceRoot: dir, db, keys })
    const pathBuf = await encryptPath("gone.md", keys)
    const meta: InboundPushMeta = {
      pathB64: pathBuf.toString("base64"),
      hash: "",
      size: 0,
      pieces: 0,
      deleted: true,
      ctime: 0,
      mtime: 500,
      device: "other",
      vaultVersion: 43,
    }
    await pipeline.handleInboundDelete(meta)

    expect(existsSync(join(dir, "gone.md"))).toBe(false)
    expect(db.getLocalFile("gone.md")).toBeUndefined()
    expect(db.getServerFile("gone.md")).toBeUndefined()
    expect(db.getMeta("last_known_version")).toBe("43")
  })

  test("chunks dans le désordre interdits — concat reconstruit ordre d'arrivée", async () => {
    // Cas valide : 2 chunks dans l'ordre
    const pipeline = createPullPipeline({ workspaceRoot: dir, db, keys })
    // Plaintext > 2 MB pour avoir 2 chunks réels
    const big = Buffer.alloc(3 * 1024 * 1024, 0x41) // 3 MB de 'A'
    const chunks = encryptContentChunked(big, keys)
    expect(chunks.length).toBe(2)

    const pathBuf = await encryptPath("big.bin", keys)
    const concatenated = Buffer.concat(chunks)
    pipeline.beginInbound({
      pathB64: pathBuf.toString("base64"),
      hash: payloadHash(concatenated).toString("hex"),
      size: concatenated.length,
      pieces: 2,
      deleted: false,
      ctime: 0, mtime: 0,
    })
    await pipeline.appendBinaryChunk(chunks[0])
    expect(pipeline.isReceiving()).toBe(true)
    await pipeline.appendBinaryChunk(chunks[1])
    expect(pipeline.isReceiving()).toBe(false)

    const written = readFileSync(join(dir, "big.bin"))
    expect(written.length).toBe(big.length)
    expect(written[0]).toBe(0x41)
  })

  test("path traversal rejeté", async () => {
    // Forge un path "../escape.md" et encrypte
    const pipeline = createPullPipeline({ workspaceRoot: dir, db, keys })
    const chunks = encryptContentChunked(Buffer.from("pwn"), keys)
    const pathBuf = await encryptPath("../escape.md", keys)
    pipeline.beginInbound({
      pathB64: pathBuf.toString("base64"),
      hash: payloadHash(Buffer.concat(chunks)).toString("hex"),
      size: chunks[0].length,
      pieces: 1,
      deleted: false, ctime: 0, mtime: 0,
    })
    await pipeline.appendBinaryChunk(chunks[0])
    // Rien ne doit avoir été écrit en dehors du workspace
    expect(existsSync(join(dir, "..", "escape.md"))).toBe(false)
    expect(db.getLocalFile("../escape.md")).toBeUndefined()
  })

  test("chunk sans inbound actif : ignoré silencieusement", async () => {
    const pipeline = createPullPipeline({ workspaceRoot: dir, db, keys })
    // Aucun beginInbound → on append
    await pipeline.appendBinaryChunk(Buffer.from("orphan"))
    expect(pipeline.isReceiving()).toBe(false)
  })

  test("reset() interrompt un inbound en cours", async () => {
    const pipeline = createPullPipeline({ workspaceRoot: dir, db, keys })
    const { meta, chunks } = await buildPushMessageFor("partial.md", "abcd", keys)
    pipeline.beginInbound({ ...meta, pieces: 2 }) // attend 2 mais on a 1
    await pipeline.appendBinaryChunk(chunks[0])
    expect(pipeline.isReceiving()).toBe(true)
    pipeline.reset()
    expect(pipeline.isReceiving()).toBe(false)
  })
})
