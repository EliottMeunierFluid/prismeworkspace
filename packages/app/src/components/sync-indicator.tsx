/**
 * Indicateur de sync E2EE dans la titlebar (Option C de
 * DESKTOP_UI_SYNC_INTEGRATION.md).
 *
 * Affiche l'état de la sync pour le workspace courant. Clic → ouvre le
 * wizard DialogConnectSync via usePrismeSync().openConnectDialog(...).
 *
 * 8 états visuels (cf doc) :
 *   not_synced     ◌ Connect to sync         (gris)
 *   signing_in     ↻ Signing in…             (spinner)
 *   unlock         🔒 Unlock to sync         (orange)
 *   connecting     ↻ Connecting…             (spinner)
 *   synced         ☁ Synced                  (vert)
 *   synced_idle    ☁ Synced                  (vert pâle)
 *   syncing        ↑ Syncing…                (bleu)
 *   error          ⚠ Sync error              (rouge)
 *
 * v1 : seul le workspace ACTIVEMENT ouvert peut avoir un indicateur
 * "synced/syncing" car l'engine est mono-instance (cf Q1). Les autres
 * workspaces connectés sont visibles dans Settings → Sync.
 */

import { createMemo, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { useLanguage } from "@/context/language"
import { usePrismeSync } from "@/context/prisme-sync"
import { usePlatform } from "@/context/platform"

type IndicatorState =
  | "hidden"
  | "not_synced"
  | "signing_in"
  | "connecting"
  | "synced"
  | "syncing"
  | "error"

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function SyncIndicator() {
  const language = useLanguage()
  const platform = usePlatform()
  const sync = usePrismeSync()
  const params = useParams()

  /** Path absolu du workspace courant (décodé depuis l'URL). */
  const workspaceRoot = createMemo<string | undefined>(() => {
    return decode64(params.dir)
  })

  /**
   * État affiché — dérivé de :
   *  - présence d'un workspace courant
   *  - workspace présent dans le registry (déjà connecté ou pas)
   *  - état de l'engine (idle/activating/ready/error)
   */
  const indicatorState = createMemo<IndicatorState>(() => {
    if (platform.platform !== "desktop") return "hidden"
    const root = workspaceRoot()
    if (!root) return "hidden"
    if (!sync.ready()) return "hidden"

    const isConnected = sync.isSyncingWorkspace(root)
    const status = sync.status()

    if (!isConnected) {
      // Workspace pas (encore) connecté à un vault
      return "not_synced"
    }

    // Workspace connecté — l'engine est-il dans cet état ?
    switch (status.state) {
      case "idle":
        // Connecté au registry mais engine pas démarré (v1 = besoin de
        // ressaisir le password à chaque démarrage app)
        return "not_synced"
      case "activating":
      case "connecting":
        return "connecting"
      case "ready":
        return "synced"
      case "disconnected":
        return "error"
      case "error":
        return "error"
      default:
        return "not_synced"
    }
  })

  const label = createMemo<string>(() => {
    switch (indicatorState()) {
      case "not_synced":
        return language.t("header.sync.notSynced")
      case "signing_in":
        return language.t("header.sync.signingIn")
      case "connecting":
        return language.t("header.sync.connecting")
      case "synced":
        return language.t("header.sync.synced")
      case "syncing":
        return language.t("header.sync.syncing")
      case "error":
        return language.t("header.sync.error")
      default:
        return ""
    }
  })

  function handleClick(): void {
    const root = workspaceRoot()
    if (!root) return
    sync.openConnectDialog({
      workspaceRoot: root,
      workspaceName: basename(root),
    })
  }

  return (
    <Show when={indicatorState() !== "hidden"}>
      <button
        type="button"
        onClick={handleClick}
        class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-12-medium transition-colors"
        classList={{
          "text-text hover:bg-background-element": indicatorState() === "not_synced",
          "text-blue-600 hover:bg-blue-50": indicatorState() === "connecting" || indicatorState() === "syncing" || indicatorState() === "signing_in",
          "text-emerald-700 hover:bg-emerald-50": indicatorState() === "synced",
          "text-red-600 hover:bg-red-50": indicatorState() === "error",
        }}
        title={label()}
      >
        <span aria-hidden="true">
          <Show when={indicatorState() === "not_synced"}>◌</Show>
          <Show when={indicatorState() === "signing_in" || indicatorState() === "connecting"}>
            <span class="inline-block animate-spin">↻</span>
          </Show>
          <Show when={indicatorState() === "synced"}>☁</Show>
          <Show when={indicatorState() === "syncing"}>↑</Show>
          <Show when={indicatorState() === "error"}>⚠</Show>
        </span>
        <span class="hidden sm:inline">{label()}</span>
      </button>
    </Show>
  )
}
