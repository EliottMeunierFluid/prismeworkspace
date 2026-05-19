#!/usr/bin/env node
/**
 * Smoke test du SyncEngine en isolation (sans Electron UI).
 *
 * Exerce le chemin complet activate() → ready :
 *   1. activateKeys (scrypt + HKDF — ~50-150ms)
 *   2. openStateDb (better-sqlite3 natif — tourne sous Node, pas sous bun)
 *   3. WebSocket vers ② avec JWT
 *   4. opcode init + attente ready
 *   5. watcher fs (3 events fichiers → log)
 *   6. deactivate (zeroize + close)
 *
 * Inputs via env :
 *   SMOKE_VAULT_ID, SMOKE_WS_URL, SMOKE_SYNC_TOKEN,
 *   SMOKE_VAULT_PASSWORD, SMOKE_SALT_HEX, SMOKE_WORKSPACE
 *
 * Build à la volée : bundle src/main/sync/index.ts via esbuild puis import().
 */

import { copyFileSync, writeFileSync, mkdtempSync, rmSync, unlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __dirname_pre = dirname(fileURLToPath(import.meta.url))
// esbuild vit dans le cache .bun hoisté (bun monorepo) — pas trouvable via
// l'algo de résolution ESM standard sans `node_modules/esbuild` symlink.
const MONO_ROOT = resolve(__dirname_pre, "../../..")
const ESBUILD_CANDIDATES = [
  join(MONO_ROOT, "node_modules/esbuild/lib/main.js"),
  join(MONO_ROOT, "node_modules/.bun/node_modules/esbuild/lib/main.js"),
]
const esbuildPath = ESBUILD_CANDIDATES.find(existsSync)
if (!esbuildPath) {
  console.error("[smoke] esbuild introuvable. Cherché :", ESBUILD_CANDIDATES)
  process.exit(2)
}
const { build } = await import(pathToFileURL(esbuildPath).href)

const DESKTOP_ROOT = resolve(__dirname_pre, "..")
// On bypasse src/main/sync/index.ts qui ré-exporte ipc.ts (import `electron`
// → plante hors process Electron). Le smoke n'a besoin que de SyncEngine.
const SYNC_ENTRY = resolve(DESKTOP_ROOT, "src/main/sync/engine.ts")

const ENV = process.env
const required = ["SMOKE_VAULT_ID", "SMOKE_SYNC_TOKEN", "SMOKE_VAULT_PASSWORD", "SMOKE_SALT_HEX"]
for (const k of required) {
  if (!ENV[k]) {
    console.error(`[smoke] missing env: ${k}`)
    process.exit(2)
  }
}
if (!ENV.SMOKE_WS_URL && !ENV.SMOKE_SITE_URL) {
  console.error("[smoke] missing env: either SMOKE_WS_URL or SMOKE_SITE_URL must be set")
  process.exit(2)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function bundleSync() {
  // Le bundle DOIT vivre à côté des node_modules du package desktop pour que
  // les externals (electron-log, better-sqlite3, ws, chokidar) soient résolus
  // par Node depuis le bon node_modules.
  const outFile = join(DESKTOP_ROOT, ".sync-smoke-bundle.mjs")
  // db.ts charge schema.sql via fileURLToPath(import.meta.url) — dans le
  // bundle, ça résout au path du bundle. On copie schema.sql à côté.
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
    // Native + Electron deps : externalisés (résolus depuis le node_modules du
    // package desktop à l'exécution). On garde miscreant + @prisme/sync-crypto
    // bundlés car ils peuvent vivre dans le link `@prisme/sync-crypto` qui
    // n'est pas toujours résolu côté Node depuis ce path.
    external: ["electron", "electron-log", "better-sqlite3", "ws", "chokidar"],
    logLevel: "warning",
    sourcemap: "inline",
  })
  return outFile
}

async function main() {
  console.log("[smoke] bundling SyncEngine via esbuild…")
  const bundlePath = await bundleSync()
  console.log("[smoke] bundle ready:", bundlePath)

  const { SyncEngine } = await import(bundlePath)

  // Sandbox workspace
  const workspaceRoot = ENV.SMOKE_WORKSPACE || mkdtempSync(join(tmpdir(), "sync-smoke-ws-"))
  console.log("[smoke] workspace:", workspaceRoot)

  const engine = new SyncEngine()

  console.log("[smoke] calling activate()…")
  // Si SMOKE_SITE_URL est fourni, on laisse l'engine fetch ws_url via
  // /api/vaults/:id/access (Étape 36). Sinon, SMOKE_WS_URL doit être direct.
  await engine.activate({
    workspaceRoot,
    vaultId: ENV.SMOKE_VAULT_ID,
    siteUrl: ENV.SMOKE_SITE_URL,
    wsUrl: ENV.SMOKE_WS_URL,
    syncToken: ENV.SMOKE_SYNC_TOKEN,
    vaultPassword: ENV.SMOKE_VAULT_PASSWORD,
    saltHex: ENV.SMOKE_SALT_HEX,
  })

  const status = engine.getStatus()
  console.log("[smoke] post-activate status:", status)
  if (status.state !== "ready") {
    console.error(`[smoke] ASSERT FAIL: expected state 'ready', got '${status.state}'`)
    await engine.deactivate()
    process.exit(1)
  }
  console.log(`[smoke] ✓ engine ready (vault_version=${status.vaultVersion})`)

  // Trigger watcher events
  console.log("[smoke] triggering fs events…")
  const f1 = join(workspaceRoot, "smoke-add.md")
  writeFileSync(f1, "hello smoke")
  await wait(900) // > FS_AWAIT_WRITE_FINISH_MS
  writeFileSync(f1, "hello smoke v2")
  await wait(900)
  unlinkSync(f1)
  await wait(900)
  console.log("[smoke] ✓ fs events emitted (check engine logs for [sync/watcher] entries)")

  console.log("[smoke] calling deactivate()…")
  await engine.deactivate()
  const after = engine.getStatus()
  if (after.state !== "idle") {
    console.error(`[smoke] ASSERT FAIL: expected state 'idle' after deactivate, got '${after.state}'`)
    process.exit(1)
  }
  console.log("[smoke] ✓ engine idle after deactivate")

  // Cleanup workspace if we created it
  if (!ENV.SMOKE_WORKSPACE) {
    try { rmSync(workspaceRoot, { recursive: true, force: true }) } catch {}
  }

  console.log("[smoke] ALL GOOD")
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err)
  process.exit(1)
})
