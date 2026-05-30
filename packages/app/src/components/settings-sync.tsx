/**
 * Onglet Settings → Sync (Option B de DESKTOP_UI_SYNC_INTEGRATION.md).
 *
 * Affiche :
 *  - Account : email + plan, bouton Sign in / Sign out
 *  - Connected workspaces : liste depuis usePrismeSync().workspaces avec
 *    bouton Disconnect
 *  - Manage vaults : lien vers /account/sync sur le site SaaS
 *
 * Pour la v1 on n'affiche pas la liste des "Other open workspaces" (qui
 * demanderait de croiser les workspaces ouverts dans l'app avec le registry).
 * À faire en v1.1 quand la PR aura été éprouvée.
 */

import { Button } from "@opencode-ai/ui/button"
import { For, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePrismeSync } from "@/context/prisme-sync"
import { SettingsList } from "./settings-list"

const SITE_BASE = "https://workspace.prisme.one"

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function openExternal(url: string): void {
  const api = typeof window !== "undefined" ? window.api : undefined
  if (api?.openLink) {
    api.openLink(url)
  } else if (typeof window !== "undefined") {
    window.open(url, "_blank")
  }
}

export const SettingsSync: Component = () => {
  const language = useLanguage()
  const sync = usePrismeSync()

  async function handleSignIn(): Promise<void> {
    await sync.signIn()
  }

  async function handleSignOut(): Promise<void> {
    await sync.signOut()
  }

  async function handleDisconnect(workspaceRoot: string): Promise<void> {
    await sync.disconnect(workspaceRoot)
  }

  return (
    <div class="flex flex-col gap-6 p-6 max-w-3xl">
      <div>
        <h1 class="text-18-medium text-text-strong mb-1">{language.t("settings.sync.title")}</h1>
        <p class="text-13-regular text-text">{language.t("settings.sync.description")}</p>
      </div>

      {/* ─── Account ──────────────────────────────────────────── */}
      <section class="flex flex-col gap-2">
        <h2 class="text-14-medium text-text-strong">{language.t("settings.sync.account")}</h2>
        <SettingsList>
          <Show
            when={sync.user()}
            fallback={
              <div class="flex items-center justify-between py-3">
                <span class="text-13-regular text-text">
                  {language.t("settings.sync.account.notSignedIn")}
                </span>
                <Button variant="primary" onClick={handleSignIn}>
                  {language.t("settings.sync.account.signIn")}
                </Button>
              </div>
            }
          >
            <div class="flex items-center justify-between py-3">
              <div class="flex flex-col">
                <span class="text-14-medium text-text-strong">
                  {language.t("settings.sync.account.signedInAs", {
                    email: sync.user()!.email,
                  })}
                </span>
                <span class="text-12-regular text-text">
                  {language.t("settings.sync.account.plan", {
                    plan: language.t(`settings.sync.account.plan.${sync.user()!.plan}`),
                  })}
                </span>
              </div>
              <Button variant="ghost" onClick={handleSignOut}>
                {language.t("settings.sync.account.signOut")}
              </Button>
            </div>
          </Show>
        </SettingsList>
      </section>

      {/* ─── Connected workspaces ────────────────────────────── */}
      <Show when={sync.user()}>
        <section class="flex flex-col gap-2">
          <h2 class="text-14-medium text-text-strong">{language.t("settings.sync.connected")}</h2>
          <SettingsList>
            <Show
              when={sync.workspaces().length > 0}
              fallback={
                <div class="text-13-regular text-text py-3">
                  {language.t("settings.sync.connected.empty")}
                </div>
              }
            >
              <For each={sync.workspaces()}>
                {(ws) => (
                  <div class="flex items-center justify-between gap-4 py-3 border-b border-border-base last:border-b-0">
                    <div class="flex flex-col min-w-0">
                      <span class="text-14-medium text-text-strong truncate">
                        {ws.vaultName}
                      </span>
                      <span class="text-12-regular text-text truncate" title={ws.workspaceRoot}>
                        {basename(ws.workspaceRoot)}
                      </span>
                    </div>
                    <Button variant="ghost" onClick={() => void handleDisconnect(ws.workspaceRoot)}>
                      {language.t("settings.sync.disconnect")}
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </SettingsList>
        </section>
      </Show>

      {/* ─── Manage vaults link ──────────────────────────────── */}
      <Show when={sync.user()}>
        <section class="flex flex-col gap-2">
          <h2 class="text-14-medium text-text-strong">{language.t("settings.sync.vaults")}</h2>
          <SettingsList>
            <div class="flex items-center justify-between py-3">
              <span class="text-13-regular text-text">
                {language.t("settings.sync.vaults.description")}
              </span>
              <Button
                variant="ghost"
                onClick={() => openExternal(`${SITE_BASE}/account/sync`)}
              >
                {language.t("settings.sync.vaults.manage")}
              </Button>
            </div>
          </SettingsList>
        </section>
      </Show>
    </div>
  )
}
