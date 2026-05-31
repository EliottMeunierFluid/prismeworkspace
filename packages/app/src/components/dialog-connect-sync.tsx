/**
 * Wizard 3 étapes pour connecter un workspace à un vault sync E2EE.
 *
 * Source de vérité : DESKTOP_UI_SYNC_INTEGRATION.md (sandbox sync).
 *
 * Steps :
 *  1. signIn       — flow OAuth navigateur si pas loggé
 *  2. chooseVault  — liste les vaults du user + bouton "Create new vault"
 *  3. unlock       — saisie du vault_password + dérivation crypto serveur
 *
 * Composant autonome — ouvert depuis usePrismeSync().openConnectDialog(target).
 * Réutilisable depuis l'indicateur header (option C), Settings tab (option B),
 * ou home.tsx (option A future).
 */

import { createSignal, createEffect, Show, Match, Switch, For, onMount } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { usePrismeSync, type ConnectDialogTarget } from "@/context/prisme-sync"

type Vault = {
  id: string
  name: string
  owner_type: "personal" | "team" | "company"
  size_bytes: number
  quota_bytes: number
  salt: string
}

type Step = "signIn" | "chooseVault" | "unlock" | "connecting" | "done" | "error"

function getApi(): NonNullable<Window["api"]> | null {
  if (typeof window === "undefined") return null
  return window.api ?? null
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function DialogConnectSync(props: { target: ConnectDialogTarget }) {
  const dialog = useDialog()
  const language = useLanguage()
  const sync = usePrismeSync()

  /**
   * Si le workspace est DÉJÀ dans le registry, on a déjà une association
   * workspace → vault. On peut sauter le "choose vault" et aller direct à
   * "unlock" (cas typique : auto-reactivate a échoué car masterKey absente
   * du keychain, l'user clique l'indicateur orange pour ressaisir le password).
   */
  const existingEntry = (): { vaultId: string; vaultName: string; saltHex: string } | undefined => {
    const e = sync.getWorkspaceEntry(props.target.workspaceRoot)
    return e ? { vaultId: e.vaultId, vaultName: e.vaultName, saltHex: e.saltHex } : undefined
  }

  const initialStep = (): Step => {
    if (!sync.user()) return "signIn"
    if (existingEntry()) return "unlock"
    return "chooseVault"
  }

  const [step, setStep] = createSignal<Step>(initialStep())
  const [vaults, setVaults] = createSignal<Vault[]>([])
  const [selectedVaultId, setSelectedVaultId] = createSignal<string | null>(
    existingEntry()?.vaultId ?? null,
  )
  const [password, setPassword] = createSignal("")
  const [signingIn, setSigningIn] = createSignal(false)
  const [loadingVaults, setLoadingVaults] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Quand un user vient d'être signé in, passe automatiquement à l'étape suivante
  createEffect(() => {
    if (sync.user() && step() === "signIn" && !signingIn()) {
      setStep(existingEntry() ? "unlock" : "chooseVault")
    }
  })

  // Charge les vaults dès qu'on entre dans chooseVault
  // ET aussi quand on est en unlock direct (pour récupérer le nom + salt du vault)
  createEffect(() => {
    if (
      (step() === "chooseVault" || step() === "unlock") &&
      vaults().length === 0 &&
      !loadingVaults()
    ) {
      void loadVaults()
    }
  })

  onMount(() => {
    if (sync.user() && step() === "signIn") {
      setStep(existingEntry() ? "unlock" : "chooseVault")
    }
  })

  async function loadVaults(): Promise<void> {
    const api = getApi()
    if (!api?.vaultsList) return
    setLoadingVaults(true)
    setError(null)
    try {
      const list = await api.vaultsList()
      setVaults(list)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(language.t("dialog.connectSync.error.loadVaults", { error: msg }))
    } finally {
      setLoadingVaults(false)
    }
  }

  async function handleSignIn(): Promise<void> {
    setSigningIn(true)
    setError(null)
    try {
      const res = await sync.signIn()
      if (!res.ok) {
        setError(res.error ?? language.t("dialog.connectSync.error.signIn"))
        return
      }
      setStep("chooseVault")
    } finally {
      setSigningIn(false)
    }
  }

  function handleSelectVault(vaultId: string): void {
    setSelectedVaultId(vaultId)
    setStep("unlock")
  }

  function handleCreateVault(): void {
    const api = getApi()
    const url = "https://workspace.prisme.one/account/sync/new"
    if (api?.openLink) {
      api.openLink(url)
    } else if (typeof window !== "undefined") {
      window.open(url, "_blank")
    }
  }

  async function handleUnlockAndConnect(e: Event): Promise<void> {
    e.preventDefault()
    const vaultId = selectedVaultId()
    if (!vaultId) return
    const api = getApi()
    if (!api?.syncConnect) return

    // Récupère les méta du vault : soit depuis le registry local (cas
    // re-unlock d'un workspace déjà connecté), soit depuis la liste API
    // (cas connexion initiale).
    const fromRegistry = sync.getWorkspaceEntry(props.target.workspaceRoot)
    const fromList = vaults().find((v) => v.id === vaultId)
    const saltHex = fromList?.salt ?? fromRegistry?.saltHex
    const vaultName = fromList?.name ?? fromRegistry?.vaultName ?? ""

    if (!saltHex) {
      setError(language.t("dialog.connectSync.error.saltMissing"))
      setStep("error")
      return
    }

    setStep("connecting")
    setError(null)
    try {
      const res = await api.syncConnect({
        workspaceRoot: props.target.workspaceRoot,
        vaultId,
        vaultName,
        saltHex,
        vaultPassword: password(),
      })
      if (!res.ok) {
        setError(res.error ?? language.t("dialog.connectSync.error.connect"))
        setStep("error")
        return
      }
      await sync.onConnected()
      setStep("done")
      setTimeout(() => {
        dialog.close()
      }, 1500)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setStep("error")
    }
  }

  const workspaceLabel = (): string =>
    props.target.workspaceName ?? basename(props.target.workspaceRoot)

  return (
    <Dialog>
      <div class="flex flex-col gap-6 px-4 pb-4 min-w-[28rem] max-w-md">
        <div class="text-center">
          <div class="text-16-medium text-text-strong">
            {language.t("dialog.connectSync.title", { workspace: workspaceLabel() })}
          </div>
          <div class="text-13-regular text-text mt-1">
            {language.t("dialog.connectSync.subtitle")}
          </div>
        </div>

        <Switch>
          {/* ─── Step 1 : Sign in ──────────────────────────────────── */}
          <Match when={step() === "signIn"}>
            <div class="flex flex-col gap-3">
              <div class="text-14-regular text-text">
                {language.t("dialog.connectSync.step1.description")}
              </div>
              <Button variant="primary" onClick={handleSignIn} disabled={signingIn()}>
                {signingIn()
                  ? language.t("dialog.connectSync.step1.signingIn")
                  : language.t("dialog.connectSync.step1.cta")}
              </Button>
              <Show when={error()}>
                <div class="text-13-regular text-red-600">{error()}</div>
              </Show>
            </div>
          </Match>

          {/* ─── Step 2 : Choose vault ─────────────────────────────── */}
          <Match when={step() === "chooseVault"}>
            <div class="flex flex-col gap-3">
              <div class="text-14-regular text-text">
                {language.t("dialog.connectSync.step2.description")}
              </div>
              <Show when={sync.user()}>
                <div class="text-13-regular text-text px-3 py-2 bg-background-element rounded-md">
                  {language.t("dialog.connectSync.step2.signedInAs", {
                    email: sync.user()!.email,
                  })}
                </div>
              </Show>
              <Show when={loadingVaults()}>
                <div class="text-13-regular text-text text-center py-4">
                  {language.t("common.loading")}
                </div>
              </Show>
              <Show when={!loadingVaults() && vaults().length === 0}>
                <div class="text-13-regular text-text text-center py-4">
                  {language.t("dialog.connectSync.step2.noVaults")}
                </div>
              </Show>
              <Show when={!loadingVaults() && vaults().length > 0}>
                <div class="flex flex-col gap-2 max-h-64 overflow-y-auto">
                  <For each={vaults()}>
                    {(vault) => (
                      <button
                        type="button"
                        class="text-left px-3 py-2 border border-border-base rounded-md hover:bg-background-element transition-colors"
                        onClick={() => handleSelectVault(vault.id)}
                      >
                        <div class="text-14-medium text-text-strong">{vault.name}</div>
                        <div class="text-12-regular text-text mt-0.5">
                          {formatBytes(vault.size_bytes)} / {formatBytes(vault.quota_bytes)}
                          {" · "}
                          {vault.owner_type === "personal"
                            ? language.t("dialog.connectSync.step2.ownerPersonal")
                            : vault.owner_type === "team"
                              ? language.t("dialog.connectSync.step2.ownerTeam")
                              : language.t("dialog.connectSync.step2.ownerCompany")}
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Button variant="ghost" onClick={handleCreateVault}>
                {language.t("dialog.connectSync.step2.createNew")}
              </Button>
              <Show when={error()}>
                <div class="text-13-regular text-red-600">{error()}</div>
              </Show>
            </div>
          </Match>

          {/* ─── Step 3 : Unlock with password ─────────────────────── */}
          <Match when={step() === "unlock"}>
            <form onSubmit={handleUnlockAndConnect} class="flex flex-col gap-3">
              <div class="text-14-regular text-text">
                {language.t("dialog.connectSync.step3.description", {
                  vault:
                    vaults().find((v) => v.id === selectedVaultId())?.name ??
                    existingEntry()?.vaultName ??
                    "",
                })}
              </div>
              <div class="text-12-regular text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                {language.t("dialog.connectSync.step3.warning")}
              </div>
              <TextField
                type="password"
                placeholder={language.t("dialog.connectSync.step3.passwordPlaceholder")}
                value={password()}
                onChange={(v) => setPassword(v)}
                autofocus
              />
              <div class="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setStep("chooseVault")
                    setPassword("")
                  }}
                >
                  {language.t("common.back")}
                </Button>
                <Button type="submit" variant="primary" disabled={password().length < 1}>
                  {language.t("dialog.connectSync.step3.cta")}
                </Button>
              </div>
              <Show when={error()}>
                <div class="text-13-regular text-red-600">{error()}</div>
              </Show>
            </form>
          </Match>

          {/* ─── Connecting ────────────────────────────────────────── */}
          <Match when={step() === "connecting"}>
            <div class="text-14-regular text-text text-center py-8">
              {language.t("dialog.connectSync.connecting")}
            </div>
          </Match>

          {/* ─── Done ───────────────────────────────────────────────── */}
          <Match when={step() === "done"}>
            <div class="text-center py-6">
              <div class="text-16-medium text-emerald-600 mb-1">
                {language.t("dialog.connectSync.done.title")}
              </div>
              <div class="text-13-regular text-text">
                {language.t("dialog.connectSync.done.description")}
              </div>
            </div>
          </Match>

          {/* ─── Error ─────────────────────────────────────────────── */}
          <Match when={step() === "error"}>
            <div class="flex flex-col gap-3">
              <div class="text-13-regular text-red-600">{error()}</div>
              <Button
                variant="ghost"
                onClick={() => {
                  setError(null)
                  setStep("chooseVault")
                }}
              >
                {language.t("common.retry")}
              </Button>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
