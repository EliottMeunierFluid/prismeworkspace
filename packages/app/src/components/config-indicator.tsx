/**
 * Indicateur "Configuration" dans la titlebar, à côté de SyncIndicator.
 *
 * Permet de synchroniser la configuration plateforme (skills, contexts,
 * .mcp.json) d'un clic, SANS IA (cf docs/CONFIG_FETCH_BUTTON_PLAN.md).
 *
 * Flux :
 *   1. clic → `config:plan` calcule le diff 3-way (pull/push/conflits/révoqués)
 *   2. l'UI affiche le résumé ; pour chaque conflit, choix garder local / distant
 *      (pas de fusion IA) ; case "supprimer les révoqués"
 *   3. clic "Appliquer" → `config:apply` exécute la synchro
 *
 * Visible uniquement si desktop + projet ouvert + compte connecté.
 */

import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { useParams } from "@solidjs/router"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { decode64 } from "@/utils/base64"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"

type Resolution = "local" | "remote"

interface ConflictEntry {
  path: string
  localHash: string
  remoteHash: string
  ancestorHash: string | null
  writable: boolean
}

interface SyncPlan {
  diff: {
    pull: { path: string }[]
    push: { path: string }[]
    conflicts: ConflictEntry[]
    revoked: { path: string }[]
  }
}

interface SyncReport {
  pulled: number
  pushed: number
  revoked: number
  conflictsResolved: number
  rejected: { path: string; reason: string }[]
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function ConfigIndicator() {
  const platform = usePlatform()
  const language = useLanguage()
  const params = useParams()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [plan, setPlan] = createSignal<SyncPlan | null>(null)
  const [report, setReport] = createSignal<SyncReport | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [resolutions, setResolutions] = createSignal<Record<string, Resolution>>({})
  const [deleteRevoked, setDeleteRevoked] = createSignal(true)

  const projectDir = createMemo<string | undefined>(() => decode64(params.dir))
  const isDesktop = createMemo(() => platform.platform === "desktop")

  const [status, { refetch: refetchStatus }] = createResource(
    () => (isDesktop() ? projectDir() ?? "__none__" : null),
    async (dir) => {
      const api = window.api
      if (!api?.configStatus) return { configured: false, lastSync: null as string | null }
      return api.configStatus(dir === "__none__" ? undefined : dir)
    },
  )

  const visible = createMemo(
    () => isDesktop() && !!projectDir() && (status()?.configured ?? false),
  )

  const lastSyncText = createMemo(() => {
    const ls = status()?.lastSync
    return ls
      ? language.t("header.config.lastSync", { date: new Date(ls).toLocaleString() })
      : language.t("header.config.neverSynced")
  })

  const diff = createMemo(() => plan()?.diff ?? null)
  const hasChanges = createMemo(() => {
    const d = diff()
    return !!d && (d.pull.length > 0 || d.push.length > 0 || d.conflicts.length > 0 || d.revoked.length > 0)
  })
  const allConflictsResolved = createMemo(() => {
    const d = diff()
    if (!d) return true
    return d.conflicts.every((c) => resolutions()[c.path])
  })

  async function loadPlan() {
    const dir = projectDir()
    const api = window.api
    if (!dir || !api?.configPlan) return
    setBusy(true)
    setError(null)
    setReport(null)
    setPlan(null)
    setResolutions({})
    try {
      setPlan(await api.configPlan(dir))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function setResolution(path: string, r: Resolution) {
    setResolutions((prev) => ({ ...prev, [path]: r }))
  }

  async function apply() {
    const dir = projectDir()
    const api = window.api
    if (!dir || !api?.configApply) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.configApply({
        projectDir: dir,
        resolutions: resolutions(),
        deleteRevoked: deleteRevoked(),
      })
      setReport(res)
      setPlan(null)
      await refetchStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function onOpenChange(open: boolean) {
    setMenuOpen(open)
    if (open) {
      setReport(null)
      void loadPlan()
    }
  }

  const buttonClasses =
    "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-12-medium transition-colors cursor-pointer text-text hover:bg-background-element"

  return (
    <Show when={visible()}>
      <DropdownMenu gutter={4} placement="bottom-end" open={menuOpen()} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger class={buttonClasses} title={lastSyncText()}>
          <span aria-hidden="true">
            <Show when={busy()} fallback={<span>⬇</span>}>
              <span class="inline-block animate-spin">↻</span>
            </Show>
          </span>
          <span class="hidden sm:inline">{language.t("header.config.label")}</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="min-w-[320px] max-w-[420px] py-1">
            <div class="px-3 py-2 border-b border-border-base">
              <div class="text-14-medium text-text-strong">{language.t("header.config.title")}</div>
              <div class="text-12-regular text-text-dim mt-0.5">{lastSyncText()}</div>
            </div>

            <Switch>
              {/* Erreur */}
              <Match when={error()}>
                <div class="px-3 py-2 text-12-regular text-red-600">{error()}</div>
              </Match>

              {/* Rapport après application */}
              <Match when={report()}>
                <div class="px-3 py-2 text-12-regular text-text flex flex-col gap-0.5">
                  <div>{language.t("header.config.report.pulled", { count: report()!.pulled })}</div>
                  <div>{language.t("header.config.report.pushed", { count: report()!.pushed })}</div>
                  <div>{language.t("header.config.report.revoked", { count: report()!.revoked })}</div>
                  <div>
                    {language.t("header.config.report.conflictsResolved", {
                      count: report()!.conflictsResolved,
                    })}
                  </div>
                  <Show when={report()!.rejected.length > 0}>
                    <div class="text-amber-600 mt-1">
                      {language.t("header.config.report.rejected", {
                        count: report()!.rejected.length,
                      })}
                    </div>
                  </Show>
                </div>
              </Match>

              {/* Calcul en cours */}
              <Match when={busy() && !plan()}>
                <div class="px-3 py-3 text-12-regular text-text-dim">
                  {language.t("header.config.computing")}
                </div>
              </Match>

              {/* À jour */}
              <Match when={plan() && !hasChanges()}>
                <div class="px-3 py-3 text-12-regular text-emerald-700">
                  {language.t("header.config.upToDate")}
                </div>
              </Match>

              {/* Plan avec changements */}
              <Match when={plan() && hasChanges()}>
                <div class="px-3 py-2 text-12-regular text-text flex flex-col gap-0.5 border-b border-border-base">
                  <div>⬇ {language.t("header.config.pull", { count: diff()!.pull.length })}</div>
                  <div>⬆ {language.t("header.config.push", { count: diff()!.push.length })}</div>
                  <Show when={diff()!.conflicts.length > 0}>
                    <div class="text-amber-600">
                      ⚠ {language.t("header.config.conflicts", { count: diff()!.conflicts.length })}
                    </div>
                  </Show>
                  <Show when={diff()!.revoked.length > 0}>
                    <div class="text-red-600">
                      ✕ {language.t("header.config.revoked", { count: diff()!.revoked.length })}
                    </div>
                  </Show>
                </div>

                {/* Résolution de conflits */}
                <Show when={diff()!.conflicts.length > 0}>
                  <div class="px-3 py-2 border-b border-border-base max-h-[200px] overflow-auto">
                    <For each={diff()!.conflicts}>
                      {(c) => (
                        <div class="flex items-center justify-between gap-2 py-1">
                          <span class="text-12-regular text-text truncate" title={c.path}>
                            {basename(c.path)}
                          </span>
                          <div class="flex gap-1 shrink-0">
                            <button
                              type="button"
                              class="px-1.5 py-0.5 rounded text-11-medium border"
                              classList={{
                                "bg-blue-50 border-blue-300 text-blue-700":
                                  resolutions()[c.path] === "local",
                                "border-border-base text-text-dim":
                                  resolutions()[c.path] !== "local",
                              }}
                              disabled={!c.writable}
                              title={c.writable ? "" : language.t("header.config.conflict.readOnly")}
                              onClick={() => setResolution(c.path, "local")}
                            >
                              {language.t("header.config.conflict.local")}
                            </button>
                            <button
                              type="button"
                              class="px-1.5 py-0.5 rounded text-11-medium border"
                              classList={{
                                "bg-blue-50 border-blue-300 text-blue-700":
                                  resolutions()[c.path] === "remote",
                                "border-border-base text-text-dim":
                                  resolutions()[c.path] !== "remote",
                              }}
                              onClick={() => setResolution(c.path, "remote")}
                            >
                              {language.t("header.config.conflict.remote")}
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Suppression des révoqués */}
                <Show when={diff()!.revoked.length > 0}>
                  <label class="px-3 py-2 flex items-center gap-2 text-12-regular text-text cursor-pointer border-b border-border-base">
                    <input
                      type="checkbox"
                      checked={deleteRevoked()}
                      onChange={(e) => setDeleteRevoked(e.currentTarget.checked)}
                    />
                    {language.t("header.config.deleteRevoked")}
                  </label>
                </Show>

                <DropdownMenu.Item
                  class="px-3 py-2 text-12-medium text-text cursor-pointer hover:bg-background-element outline-none disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={busy() || !allConflictsResolved()}
                  closeOnSelect={false}
                  onSelect={apply}
                >
                  {busy()
                    ? language.t("header.config.applying")
                    : allConflictsResolved()
                      ? language.t("header.config.apply")
                      : language.t("header.config.resolveFirst")}
                </DropdownMenu.Item>
              </Match>
            </Switch>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
