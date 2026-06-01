import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { startFileWatcher, type FileWatcher, type FsEvent } from "./watcher"

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Délai > FS_AWAIT_WRITE_FINISH_MS (500ms) pour laisser le debounce passer.
const SETTLE_MS = 900

describe("sync watcher", () => {
  let dir: string
  let events: FsEvent[]
  let watcher: FileWatcher

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sync-watch-"))
    events = []
    watcher = startFileWatcher({
      workspaceRoot: dir,
      onEvent: (e) => events.push(e),
    })
    await watcher.ready()
  })

  afterEach(async () => {
    await watcher.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("emits add event with relative slash path", async () => {
    writeFileSync(join(dir, "hello.md"), "hi")
    await wait(SETTLE_MS)
    const add = events.find((e) => e.kind === "add" && e.path === "hello.md")
    expect(add).toBeDefined()
  })

  test("emits unlink event with relative path", async () => {
    const file = join(dir, "bye.md")
    writeFileSync(file, "x")
    await wait(SETTLE_MS)
    unlinkSync(file)
    await wait(SETTLE_MS)
    const unlink = events.find((e) => e.kind === "unlink" && e.path === "bye.md")
    expect(unlink).toBeDefined()
  })

  test("ignores .prisme-sync subdirectory", async () => {
    mkdirSync(join(dir, ".prisme-sync"), { recursive: true })
    writeFileSync(join(dir, ".prisme-sync", "state.db"), "fake")
    await wait(SETTLE_MS)
    const leaked = events.find((e) => e.path.startsWith(".prisme-sync"))
    expect(leaked).toBeUndefined()
  })
})
