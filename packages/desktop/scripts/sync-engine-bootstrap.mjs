#!/usr/bin/env node
/**
 * Bootstrap E2E — vérifie qu'un nouveau device qui rejoint un vault
 * existant rapatrie automatiquement les fichiers déjà stockés côté ②.
 *
 * Scénario :
 *   1. Device A active, écrit foo.md + bar.md, attend les push ok.
 *   2. Device A deactivate (le vault est dormant côté serveur).
 *   3. Device B active sur un workspace vide → bootstrap doit list +
 *      pull foo.md + bar.md.
 *   4. Vérifie que foo.md et bar.md existent dans wsB avec le bon contenu.
 *
 * Inputs via env (identiques au smoke 1-device) :
 *   SMOKE_VAULT_ID, SMOKE_SITE_URL, SMOKE_SYNC_TOKEN,
 *   SMOKE_VAULT_PASSWORD, SMOKE_SALT_HEX
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __dirname_pre = dirname(fileURLToPath(import.meta.url))
const MONO_ROOT = resolve(__dirname_pre, "../../..")
const ESBUILD_CANDIDATES = [
  join(MONO_ROOT, "node_modules/esbuild/lib/main.js"),
  join(MONO_ROOT, "node_modules/.bun/node_modules/esbuild/lib/main.js"),
]
const esbuildPath = ESBUILD_CANDIDATES.find(existsSync)
if (!esbuildPath) {
  console.error("[bootstrap] esbuild introuvable", ESBUILD_CANDIDATES)
  process.exit(2)
}
const { build } = await import(pathToFileURL(esbuildPath).href)

const DESKTOP_ROOT = resolve(__dirname_pre, "..")
const SYNC_ENTRY = resolve(DESKTOP_ROOT, "src/main/sync/engine.ts")

const ENV = process.env
const required = ["SMOKE_VAULT_ID", "SMOKE_SITE_URL", "SMOKE_SYNC_TOKEN", "SMOKE_VAULT_PASSWORD", "SMOKE_SALT_HEX"]
for (const k of required) {
  if (!ENV[k]) {
    console.error(`[bootstrap] missing env: ${k}`)
    process.exit(2)
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function bundleSync() {
  const outFile = join(DESKTOP_ROOT, ".sync-bootstrap-bundle.mjs")
  copyFileSync(
    resolve(DESKTOP_ROOT, "src/main/sync/state/schema.sql"),
    join(DESKTOP_ROOT, "schema.sql"),
  )
  await build({
    entryPoints: [SYNC_ENTRY],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["electron", "electron-log", "better-sqlite3", "ws", "chokidar"],
    logLevel: "warning",
    sourcemap: "inline",
  })
  return outFile
}

async function main() {
  console.log("[bootstrap] bundling…")
  const bundlePath = await bundleSync()
  const { SyncEngine } = await import(bundlePath)

  const wsA = mkdtempSync(join(tmpdir(), "sync-boot-A-"))
  const wsB = mkdtempSync(join(tmpdir(), "sync-boot-B-"))
  console.log("[bootstrap] wsA:", wsA)
  console.log("[bootstrap] wsB:", wsB)

  const baseConfig = {
    vaultId: ENV.SMOKE_VAULT_ID,
    siteUrl: ENV.SMOKE_SITE_URL,
    syncToken: ENV.SMOKE_SYNC_TOKEN,
    vaultPassword: ENV.SMOKE_VAULT_PASSWORD,
    saltHex: ENV.SMOKE_SALT_HEX,
  }

  // ─── Phase 1 : A push 2 fichiers ───────────────────────────────────────
  console.log("\n[bootstrap] === phase 1 : A pushes 2 files ===")
  const engineA = new SyncEngine()
  await engineA.activate({ ...baseConfig, workspaceRoot: wsA })
  await engineA.awaitInitialSync()
  console.log("[bootstrap] A ready, status:", engineA.getStatus())

  const fooContent = "foo content from A"
  const barContent = "bar content from A — second file"
  writeFileSync(join(wsA, "foo.md"), fooContent)
  await wait(1500) // laisser le push s'effectuer (watcher → push → ok)
  writeFileSync(join(wsA, "bar.md"), barContent)
  await wait(1500)
  console.log("[bootstrap] A pushed foo.md + bar.md, deactivating…")
  await engineA.deactivate()

  // ─── Phase 2 : B se connecte vierge → bootstrap doit pull ──────────────
  console.log("\n[bootstrap] === phase 2 : B activates on empty workspace ===")
  const engineB = new SyncEngine()
  await engineB.activate({ ...baseConfig, workspaceRoot: wsB })
  await engineB.awaitInitialSync()
  console.log("[bootstrap] B ready, status:", engineB.getStatus())

  // ─── Phase 3 : Assert ──────────────────────────────────────────────────
  console.log("\n[bootstrap] === phase 3 : assert files on B ===")
  let ok = true
  if (!existsSync(join(wsB, "foo.md"))) {
    console.error("[bootstrap] FAIL: foo.md not present on B")
    ok = false
  } else {
    const got = readFileSync(join(wsB, "foo.md"), "utf8")
    if (got !== fooContent) {
      console.error(`[bootstrap] FAIL: foo.md content mismatch on B. Got "${got}", expected "${fooContent}"`)
      ok = false
    } else {
      console.log("[bootstrap] ✓ foo.md present on B with correct content")
    }
  }
  if (!existsSync(join(wsB, "bar.md"))) {
    console.error("[bootstrap] FAIL: bar.md not present on B")
    ok = false
  } else {
    const got = readFileSync(join(wsB, "bar.md"), "utf8")
    if (got !== barContent) {
      console.error(`[bootstrap] FAIL: bar.md content mismatch on B. Got "${got}", expected "${barContent}"`)
      ok = false
    } else {
      console.log("[bootstrap] ✓ bar.md present on B with correct content")
    }
  }

  await engineB.deactivate()
  rmSync(wsA, { recursive: true, force: true })
  rmSync(wsB, { recursive: true, force: true })

  if (!ok) {
    console.error("\n[bootstrap] FAILED ❌")
    process.exit(1)
  }
  console.log("\n[bootstrap] ALL GOOD ✅")
}

main().catch((err) => {
  console.error("[bootstrap] FAILED:", err)
  process.exit(1)
})
