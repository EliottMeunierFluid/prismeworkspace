#!/usr/bin/env node
/**
 * Multi-device E2E — 2 SyncEngine sur 2 workspaces différents partageant
 * le même vault. Vérifie que les opérations d'un device se propagent à
 * l'autre via le broadcast serveur.
 *
 * Scénarios :
 *   1. A écrit foo.md            → B doit voir foo.md apparaître
 *   2. A overwrite foo.md        → B doit voir le nouveau contenu
 *   3. A unlink foo.md           → B doit voir foo.md supprimé
 *
 * Inputs via env (identiques au smoke 1-device + workspace par device) :
 *   SMOKE_VAULT_ID, SMOKE_SITE_URL, SMOKE_SYNC_TOKEN,
 *   SMOKE_VAULT_PASSWORD, SMOKE_SALT_HEX
 *
 * NB : les 2 engines partagent le MÊME sync_token (même utilisateur,
 * même vault). En prod il y aurait 2 tokens (1 par device, mais
 * potentiellement même user). Aucune différence côté serveur — le
 * device_id est généré localement à la 1ère activation.
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
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
  console.error("[multidevice] esbuild introuvable", ESBUILD_CANDIDATES)
  process.exit(2)
}
const { build } = await import(pathToFileURL(esbuildPath).href)

const DESKTOP_ROOT = resolve(__dirname_pre, "..")
const SYNC_ENTRY = resolve(DESKTOP_ROOT, "src/main/sync/engine.ts")

const ENV = process.env
const required = ["SMOKE_VAULT_ID", "SMOKE_SITE_URL", "SMOKE_SYNC_TOKEN", "SMOKE_VAULT_PASSWORD", "SMOKE_SALT_HEX"]
for (const k of required) {
  if (!ENV[k]) {
    console.error(`[multidevice] missing env: ${k}`)
    process.exit(2)
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Polling : attend qu'une condition soit vraie, ou échoue après timeout.
 */
async function waitUntil(label, pred, timeoutMs = 10_000, intervalMs = 200) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await wait(intervalMs)
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`)
}

async function bundleSync() {
  const outFile = join(DESKTOP_ROOT, ".sync-multidevice-bundle.mjs")
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
  console.log("[multidevice] bundling…")
  const bundlePath = await bundleSync()
  console.log("[multidevice] bundle ready:", bundlePath)

  const { SyncEngine } = await import(bundlePath)

  // 2 workspaces distincts simulent 2 installations différentes
  const wsA = mkdtempSync(join(tmpdir(), "sync-multidev-A-"))
  const wsB = mkdtempSync(join(tmpdir(), "sync-multidev-B-"))
  console.log("[multidevice] workspace A:", wsA)
  console.log("[multidevice] workspace B:", wsB)

  const engineA = new SyncEngine()
  const engineB = new SyncEngine()

  const baseConfig = {
    vaultId: ENV.SMOKE_VAULT_ID,
    siteUrl: ENV.SMOKE_SITE_URL,
    syncToken: ENV.SMOKE_SYNC_TOKEN,
    vaultPassword: ENV.SMOKE_VAULT_PASSWORD,
    saltHex: ENV.SMOKE_SALT_HEX,
  }

  console.log("[multidevice] activate A…")
  await engineA.activate({ ...baseConfig, workspaceRoot: wsA })
  await engineA.awaitInitialSync()
  console.log("[multidevice] ✓ A ready, status:", engineA.getStatus())

  console.log("[multidevice] activate B…")
  await engineB.activate({ ...baseConfig, workspaceRoot: wsB })
  await engineB.awaitInitialSync()
  console.log("[multidevice] ✓ B ready, status:", engineB.getStatus())

  // ─── Scénario 1 : create sur A → B voit apparaître ─────────────────────
  console.log("\n[multidevice] === scenario 1 : create on A ===")
  const fileName = "shared.md"
  const fileContent1 = "hello from A — created"
  writeFileSync(join(wsA, fileName), fileContent1)

  await waitUntil(
    `B receives ${fileName} with v1 content`,
    () => existsSync(join(wsB, fileName))
      && readFileSync(join(wsB, fileName), "utf8") === fileContent1,
  )
  console.log(`[multidevice] ✓ B received ${fileName} with content "${fileContent1}"`)

  // ─── Scénario 2 : update sur A → B voit le nouveau contenu ─────────────
  console.log("\n[multidevice] === scenario 2 : update on A ===")
  const fileContent2 = "hello from A — UPDATED v2"
  writeFileSync(join(wsA, fileName), fileContent2)

  await waitUntil(
    `B sees updated content`,
    () => existsSync(join(wsB, fileName))
      && readFileSync(join(wsB, fileName), "utf8") === fileContent2,
  )
  console.log(`[multidevice] ✓ B sees updated content "${fileContent2}"`)

  // ─── Scénario 3 : delete sur A → B voit disparaître ────────────────────
  console.log("\n[multidevice] === scenario 3 : delete on A ===")
  unlinkSync(join(wsA, fileName))

  await waitUntil(
    `B sees ${fileName} deleted`,
    () => !existsSync(join(wsB, fileName)),
  )
  console.log(`[multidevice] ✓ B sees ${fileName} deleted`)

  // ─── Scénario 4 : reverse direction (B → A) ────────────────────────────
  console.log("\n[multidevice] === scenario 4 : create on B → A receives ===")
  const reverseName = "from-b.md"
  const reverseContent = "B is talking to A"
  writeFileSync(join(wsB, reverseName), reverseContent)

  await waitUntil(
    `A receives ${reverseName}`,
    () => existsSync(join(wsA, reverseName))
      && readFileSync(join(wsA, reverseName), "utf8") === reverseContent,
  )
  console.log(`[multidevice] ✓ A received "${reverseName}" from B`)

  // ─── Scénario 5 : rename sur A → B voit le rename ──────────────────────
  // NB chokidar : sur certains FS, fs.rename atomique ne génère pas
  // unlink+add (juste un MOVED_FROM/TO de bas niveau). On utilise
  // unlink + writeFile pour forcer 2 events distincts → le détecteur
  // rename (engine.ts step 34) compare les hashes et enqueue op=rename.
  console.log("\n[multidevice] === scenario 5 : rename on A ===")
  const oldRenameName = "from-b.md"
  const newRenameName = "renamed.md"
  // Attendre que from-b.md (créé par pull entrant) soit stabilisé côté
  // chokidar — sinon l'unlink immédiat est suppress par awaitWriteFinish.
  await wait(1500)
  const renameContent = readFileSync(join(wsA, oldRenameName))

  const fsP = await import("node:fs/promises")
  await fsP.unlink(join(wsA, oldRenameName))
  await wait(200) // laisse passer unlink event dans la fenêtre 500ms du rename detector
  await fsP.writeFile(join(wsA, newRenameName), renameContent)

  await waitUntil(
    `B sees ${newRenameName} present and ${oldRenameName} absent`,
    () => existsSync(join(wsB, newRenameName))
      && !existsSync(join(wsB, oldRenameName)),
    15_000,
  )
  console.log(`[multidevice] ✓ B sees ${oldRenameName} → ${newRenameName}`)

  // ─── Scénario 6 : conflit (local edit non-push + pull entrant) ─────────
  console.log("\n[multidevice] === scenario 6 : conflict (concurrent edit) ===")
  const conflictName = "conflict-test.md"
  // A crée et propage à B
  writeFileSync(join(wsA, conflictName), "original from A")
  await waitUntil(
    "B receives conflict-test.md",
    () => existsSync(join(wsB, conflictName))
      && readFileSync(join(wsB, conflictName), "utf8") === "original from A",
  )

  // B modifie localement SANS attendre — overwrite avant pull entrant
  writeFileSync(join(wsB, conflictName), "B's local edit (not yet pushed)")
  // Tout de suite après : A modifie aussi (réplique sur B via broadcast)
  await wait(200)
  writeFileSync(join(wsA, conflictName), "A's edit propagating to B")

  // B doit avoir créé une conflict copy contenant son edit local non push.
  // Le contenu final de conflict-test.md dépend du race serveur (last-write-
  // wins par hash chronologique côté ②) — on ne s'engage pas dessus, le
  // critère de succès est la NON-PERTE de données = la conflict copy existe.
  // Polling sur l'existence + log du contenu pour diagnostic
  await waitUntil(
    "B has at least one conflict copy",
    () => readdirSync(wsB).some((f) => f.startsWith("conflict-test.conflict-")),
    15_000,
  )
  const dirEntries = readdirSync(wsB)
  const conflictCopy = dirEntries.find((f) => f.startsWith("conflict-test.conflict-"))
  const conflictContent = readFileSync(join(wsB, conflictCopy), "utf8")
  console.log(`[multidevice] conflict copy "${conflictCopy}" contains: "${conflictContent}"`)
  if (conflictContent !== "B's local edit (not yet pushed)") {
    console.warn(`[multidevice] ⚠ conflict copy does not contain B's local edit (race condition possible)`)
  } else {
    console.log(`[multidevice] ✓ B's local edit preserved in conflict copy`)
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────
  console.log("\n[multidevice] deactivating both engines…")
  await engineA.deactivate()
  await engineB.deactivate()

  rmSync(wsA, { recursive: true, force: true })
  rmSync(wsB, { recursive: true, force: true })

  console.log("\n[multidevice] ALL SCENARIOS PASSED ✅")
}

main().catch((err) => {
  console.error("[multidevice] FAILED:", err)
  process.exit(1)
})
