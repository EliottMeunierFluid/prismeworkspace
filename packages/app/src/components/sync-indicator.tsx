/**
 * Indicateur de sync E2EE dans la titlebar (Option C de
 * DESKTOP_UI_SYNC_INTEGRATION.md).
 *
 * Affiche l'état de la sync pour le workspace courant. Selon l'état :
 *  - Actionnable (not_synced / unlock_required / error) → clic ouvre le
 *    wizard DialogConnectSync.
 *  - Passif (connecting / synced / syncing) → clic ouvre un dropdown
 *    avec infos du vault + bouton Disconnect.
 *
 * États visuels :
 *   not_synced       ◌ Connect to sync     (gris)   — workspace jamais connecté
 *   unlock_required  🔒 Unlock to sync     (orange) — dans registry mais masterKey absente
 *   connecting       ↻ Connecting…         (bleu)   — engine en cours d'activation
 *   synced           ☁ Synced              (vert)   — engine ready
 *   syncing          ↑ Syncing…            (bleu)   — push en flight
 *   error            ⚠ Sync error          (rouge)  — disconnected/error
 *   hidden                                          — pas desktop ou pas workspace ouvert
 *
 * Comportement auto-réactivation (cf KEYCHAIN_OS.md) :
 * Quand un workspace est dans le registry et l'engine est idle, on tente
 * automatiquement sync.tryReactivate(workspaceRoot) qui utilise la masterKey
 * stockée dans le keychain OS (skip scrypt). Si ça marche → state passe à
 * "ready". Si la masterKey n'est pas dispo → state "unlock_required" et
 * l'utilisateur doit cliquer pour ressaisir le password.
 */

import { createEffect, createMemo, createResource, createSignal, Match, Show, Switch, untrack } from "solid-js"
import { useParams } from "@solidjs/router"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { decode64 } from "@/utils/base64"
import { useLanguage } from "@/context/language"
import { usePrismeSync } from "@/context/prisme-sync"
import { usePlatform } from "@/context/platform"

type IndicatorState =
  | "hidden"
  | "not_synced"
  | "unlock_required"
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
  const [menuOpen, setMenuOpen] = createSignal(false)

  /** Path absolu du workspace courant (décodé depuis l'URL). */
  const workspaceRoot = createMemo<string | undefined>(() => {
    return decode64(params.dir)
  })

  /**
   * Indique si le workspace courant a une masterKey persistée dans le
   * keychain. Sert à distinguer "Connect" (rien stocké) de "Unlock" (stocké).
   * Refetch quand le workspace change.
   */
  const [hasStoredKey] = createResource(
    () => {
      const root = workspaceRoot()
      if (!root) return undefined
      if (!sync.isSyncingWorkspace(root)) return undefined
      return root
    },
    async (root) => {
      return await sync.hasStoredKey(root)
    },
  )

  /**
   * Auto-réactivation au montage si possible.
   *
   * Si :
   *  - on a un workspace courant
   *  - il est dans le registry
   *  - le status engine est idle
   *  - la masterKey est dispo dans le keychain
   * → on appelle tryReactivate pour faire passer l'engine en ready sans UI.
   */
  createEffect(() => {
    const root = workspaceRoot()
    if (!root) return
    if (!sync.ready()) return
    if (!sync.isSyncingWorkspace(root)) return
    const status = untrack(() => sync.status())
    if (status.state !== "idle") return
    const stored = hasStoredKey()
    if (stored !== true) return
    void sync.tryReactivate(root)
  })

  const indicatorState = createMemo<IndicatorState>(() => {
    if (platform.platform !== "desktop") return "hidden"
    const root = workspaceRoot()
    if (!root) return "hidden"
    if (!sync.ready()) return "hidden"

    const isConnected = sync.isSyncingWorkspace(root)
    const status = sync.status()

    if (!isConnected) {
      return "not_synced"
    }

    switch (status.state) {
      case "idle":
        return hasStoredKey() === true ? "connecting" : "unlock_required"
      case "activating":
      case "connecting":
        return "connecting"
      case "ready":
        return "synced"
      case "disconnected":
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
      case "unlock_required":
        return language.t("header.sync.unlockRequired")
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

  const isPassiveState = createMemo<boolean>(() => {
    const s = indicatorState()
    return s === "synced" || s === "connecting" || s === "syncing"
  })

  const workspaceEntry = createMemo(() => {
    const root = workspaceRoot()
    if (!root) return undefined
    return sync.getWorkspaceEntry(root)
  })

  function handleActionClick(): void {
    const root = workspaceRoot()
    if (!root) return
    sync.openConnectDialog({
      workspaceRoot: root,
      workspaceName: basename(root),
    })
  }

  async function handleDisconnect(): Promise<void> {
    const root = workspaceRoot()
    if (!root) return
    setMenuOpen(false)
    await sync.disconnect(root)
  }

  // Rendu du contenu du bouton (icône + label) — partagé entre les 2 variantes.
  const Indicator = () => (
    <>
      <span aria-hidden="true">
        <Show when={indicatorState() === "not_synced"}>◌</Show>
        <Show when={indicatorState() === "unlock_required"}>🔒</Show>
        <Show when={indicatorState() === "connecting"}>
          <span class="inline-block animate-spin">↻</span>
        </Show>
        <Show when={indicatorState() === "synced"}>☁</Show>
        <Show when={indicatorState() === "syncing"}>↑</Show>
        <Show when={indicatorState() === "error"}>⚠</Show>
      </span>
      <span class="hidden sm:inline">{label()}</span>
    </>
  )

  const buttonClasses =
    "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-12-medium transition-colors cursor-pointer"
  const buttonClassList = () => ({
    "text-text hover:bg-background-element": indicatorState() === "not_synced",
    "text-amber-600 hover:bg-amber-50": indicatorState() === "unlock_required",
    "text-blue-600 hover:bg-blue-50":
      indicatorState() === "connecting" || indicatorState() === "syncing",
    "text-emerald-700 hover:bg-emerald-50": indicatorState() === "synced",
    "text-red-600 hover:bg-red-50": indicatorState() === "error",
  })

  return (
    <Show when={indicatorState() !== "hidden"}>
      <Switch>
        {/* États passifs : DropdownMenu avec infos + Disconnect */}
        <Match when={isPassiveState()}>
          <DropdownMenu
            gutter={4}
            placement="bottom-end"
            open={menuOpen()}
            onOpenChange={setMenuOpen}
          >
            <DropdownMenu.Trigger
              class={buttonClasses}
              classList={buttonClassList()}
              title={label()}
            >
              <Indicator />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="min-w-[240px] py-1">
                <div class="px-3 py-2 border-b border-border-base">
                  <div class="text-14-medium text-text-strong truncate">
                    {workspaceEntry()?.vaultName ?? ""}
                  </div>
                  <div class="text-12-regular text-text-dim mt-0.5">
                    {label()}
                  </div>
                </div>
                <DropdownMenu.Item
                  class="px-3 py-2 text-12-regular text-red-600 cursor-pointer hover:bg-red-50 outline-none"
                  onSelect={handleDisconnect}
                >
                  {language.t("header.sync.disconnect")}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </Match>

        {/* États actionnables : button qui ouvre le wizard */}
        <Match when={!isPassiveState()}>
          <button
            type="button"
            onClick={handleActionClick}
            class={buttonClasses}
            classList={buttonClassList()}
            title={label()}
          >
            <Indicator />
          </button>
        </Match>
      </Switch>
    </Show>
  )
}
