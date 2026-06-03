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
  /** 1 = legacy password vault (v1.0), 2 = key wrapping (v2.0). */
  crypto_version: number
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

const STEP_NUMBER: Record<Step, number | null> = {
  signIn: 1,
  chooseVault: 2,
  unlock: 3,
  connecting: null,
  done: null,
  error: null,
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
  const [vaultsFetched, setVaultsFetched] = createSignal(false)
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
      !vaultsFetched() &&
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
      setVaultsFetched(true)
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
    const cryptoVersion = fromList?.crypto_version ?? 1

    if (!saltHex && cryptoVersion === 1) {
      setError(language.t("dialog.connectSync.error.saltMissing"))
      setStep("error")
      return
    }

    setStep("connecting")
    setError(null)
    try {
      // Branchement v1.0 vs v2.0 selon le crypto_version du vault.
      //  - v1.0 : on saisit le mot de passe DU VAULT (legacy)
      //  - v2.0 : on saisit le mot de passe DU COMPTE — déchiffre la
      //           privateKey user qui unwrap la masterKey du vault
      const res =
        cryptoVersion === 2
          ? await (api.syncConnectV2 ?? unsupportedV2)({
              workspaceRoot: props.target.workspaceRoot,
              vaultId,
              vaultName,
              accountPassword: password(),
            })
          : await api.syncConnect({
              workspaceRoot: props.target.workspaceRoot,
              vaultId,
              vaultName,
              saltHex: saltHex!,
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

  /** Fallback si une build desktop trop ancienne expose pas syncConnectV2. */
  async function unsupportedV2(): Promise<{ ok: false; error: string; status: { state: "idle" } }> {
    return {
      ok: false,
      error: "Cette build desktop ne supporte pas les vaults v2. Mettez à jour l'application.",
      status: { state: "idle" },
    }
  }

  const workspaceLabel = (): string =>
    props.target.workspaceName ?? basename(props.target.workspaceRoot)

  const selectedVaultName = (): string =>
    vaults().find((v) => v.id === selectedVaultId())?.name ?? existingEntry()?.vaultName ?? ""

  /**
   * crypto_version du vault sélectionné. 1 = legacy password vault, 2 = key
   * wrapping (l'user saisira son password compte au lieu d'un password vault).
   * Défaut 1 si on n'a pas l'info (cas paranoïaque, ne devrait pas arriver).
   */
  const selectedVaultCryptoVersion = (): number =>
    vaults().find((v) => v.id === selectedVaultId())?.crypto_version ?? 1

  const headerTitle = (): string => {
    switch (step()) {
      case "signIn":
        return language.t("dialog.connectSync.step1.title")
      case "chooseVault":
        return language.t("dialog.connectSync.step2.title")
      case "unlock":
        return selectedVaultCryptoVersion() === 2
          ? language.t("dialog.connectSync.step3.title_v2", { vault: selectedVaultName() })
          : language.t("dialog.connectSync.step3.title", { vault: selectedVaultName() })
      case "connecting":
        return language.t("dialog.connectSync.connecting.title")
      case "done":
        return language.t("dialog.connectSync.done.title")
      case "error":
        return language.t("dialog.connectSync.error.title")
    }
  }

  const headerSubtitle = (): string => {
    switch (step()) {
      case "signIn":
        return language.t("dialog.connectSync.step1.subtitle")
      case "chooseVault":
        return language.t("dialog.connectSync.step2.subtitle")
      case "unlock":
        return selectedVaultCryptoVersion() === 2
          ? language.t("dialog.connectSync.step3.subtitle_v2")
          : language.t("dialog.connectSync.step3.subtitle")
      case "connecting":
        return language.t("dialog.connectSync.connecting.subtitle")
      case "done":
        return language.t("dialog.connectSync.done.description")
      case "error":
        return error() ?? ""
    }
  }

  return (
    <Dialog>
      <div class="flex flex-col px-5 pb-5 pt-1 gap-5">
        {/* ─── Header ───────────────────────────────────────────────── */}
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-3">
            <div class="text-12-regular text-text-dim truncate">
              {language.t("dialog.connectSync.workspace", { workspace: workspaceLabel() })}
            </div>
            <Show when={STEP_NUMBER[step()] !== null}>
              <div class="text-12-regular text-text-dim shrink-0">
                {language.t("dialog.connectSync.stepCount", {
                  current: String(STEP_NUMBER[step()]!),
                  total: "3",
                })}
              </div>
            </Show>
          </div>
          <div>
            <div class="text-20-medium text-text-strong">{headerTitle()}</div>
            <div class="text-14-regular text-text mt-1">{headerSubtitle()}</div>
          </div>
        </div>

        {/* ─── Body ─────────────────────────────────────────────────── */}
        <Switch>
          {/* ─── Step 1 : Sign in ─────────────────────────────────── */}
          <Match when={step() === "signIn"}>
            <div class="flex flex-col gap-3">
              <Button variant="primary" onClick={handleSignIn} disabled={signingIn()}>
                {signingIn()
                  ? language.t("dialog.connectSync.step1.signingIn")
                  : language.t("dialog.connectSync.step1.cta")}
              </Button>
              <Show when={error()}>
                <div class="text-14-regular text-red-600">{error()}</div>
              </Show>
            </div>
          </Match>

          {/* ─── Step 2 : Choose vault ────────────────────────────── */}
          <Match when={step() === "chooseVault"}>
            <div class="flex flex-col gap-3">
              <Show when={loadingVaults()}>
                <div class="text-14-regular text-text text-center py-6">
                  {language.t("common.loading")}
                </div>
              </Show>
              <Show when={!loadingVaults() && vaults().length === 0}>
                <div class="flex flex-col items-center gap-1 py-6 text-center">
                  <div class="text-14-regular text-text-strong">
                    {language.t("dialog.connectSync.step2.noVaults")}
                  </div>
                  <div class="text-12-regular text-text-dim">
                    {language.t("dialog.connectSync.step2.noVaultsHint")}
                  </div>
                </div>
              </Show>
              <Show when={!loadingVaults() && vaults().length > 0}>
                <div class="flex flex-col gap-1.5 max-h-72 overflow-y-auto -mx-1 px-1">
                  <For each={vaults()}>
                    {(vault) => (
                      <button
                        type="button"
                        class="group flex items-center gap-3 text-left px-3 py-2.5 border border-border-base rounded-md hover:border-border-strong hover:bg-background-element transition-colors"
                        onClick={() => handleSelectVault(vault.id)}
                      >
                        <VaultIcon ownerType={vault.owner_type} />
                        <div class="flex-1 min-w-0">
                          <div class="text-14-medium text-text-strong truncate">{vault.name}</div>
                          <div class="text-12-regular text-text-dim mt-0.5">
                            <Show
                              when={vault.size_bytes > 0}
                              fallback={language.t("dialog.connectSync.step2.usageEmpty", {
                                quota: formatBytes(vault.quota_bytes),
                              })}
                            >
                              {language.t("dialog.connectSync.step2.usage", {
                                used: formatBytes(vault.size_bytes),
                                quota: formatBytes(vault.quota_bytes),
                              })}
                            </Show>
                          </div>
                        </div>
                        <div class="text-12-regular text-text-dim shrink-0 px-2 py-0.5 rounded-full bg-background-element border border-border-base">
                          <OwnerLabel ownerType={vault.owner_type} />
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={error()}>
                <div class="text-14-regular text-red-600">{error()}</div>
              </Show>
            </div>
          </Match>

          {/* ─── Step 3 : Unlock with password (v1 vault / v2 account) ─ */}
          <Match when={step() === "unlock"}>
            <form onSubmit={handleUnlockAndConnect} class="flex flex-col gap-3">
              <TextField
                type="password"
                placeholder={
                  selectedVaultCryptoVersion() === 2
                    ? language.t("dialog.connectSync.step3.passwordPlaceholder_v2")
                    : language.t("dialog.connectSync.step3.passwordPlaceholder")
                }
                value={password()}
                onChange={(v) => setPassword(v)}
                autofocus
              />
              <div class="text-12-regular text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                {selectedVaultCryptoVersion() === 2
                  ? language.t("dialog.connectSync.step3.warning_v2")
                  : language.t("dialog.connectSync.step3.warning")}
              </div>
              <div class="flex items-center justify-end gap-2 pt-1">
                <Show when={!existingEntry()}>
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
                </Show>
                <Button type="submit" variant="primary" disabled={password().length < 1}>
                  {language.t("dialog.connectSync.step3.cta")}
                </Button>
              </div>
              <Show when={error()}>
                <div class="text-14-regular text-red-600">{error()}</div>
              </Show>
            </form>
          </Match>

          {/* ─── Connecting ──────────────────────────────────────── */}
          <Match when={step() === "connecting"}>
            <div class="flex items-center justify-center py-8">
              <span class="inline-block w-6 h-6 border-2 border-border-base border-t-text-strong rounded-full animate-spin" />
            </div>
          </Match>

          {/* ─── Done ────────────────────────────────────────────── */}
          <Match when={step() === "done"}>
            <div class="flex items-center justify-center py-6">
              <div class="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-20-medium">
                ✓
              </div>
            </div>
          </Match>

          {/* ─── Error ───────────────────────────────────────────── */}
          <Match when={step() === "error"}>
            <div class="flex items-center justify-end gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  setError(null)
                  setStep(existingEntry() ? "unlock" : "chooseVault")
                }}
              >
                {language.t("common.retry")}
              </Button>
            </div>
          </Match>
        </Switch>

        {/* ─── Footer ───────────────────────────────────────────────── */}
        <div class="flex items-center justify-between gap-3 pt-3 border-t border-border-base">
          <div class="flex items-center gap-2 text-12-regular text-text-dim min-w-0">
            <span class="inline-block w-3.5 h-3.5 shrink-0" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M5 9V6.5a5 5 0 0110 0V9M4 9h12v8H4z" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="truncate">{language.t("dialog.connectSync.encryptionNote")}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <Show when={step() === "chooseVault"}>
              <Button variant="ghost" onClick={handleCreateVault}>
                + {language.t("dialog.connectSync.step2.createNew")}
              </Button>
            </Show>
            <Show when={step() !== "done" && step() !== "connecting"}>
              <Button variant="ghost" onClick={() => dialog.close()}>
                {language.t("dialog.connectSync.cancel")}
              </Button>
            </Show>
          </div>
        </div>

        {/* ─── Email signed-in (discret, sous le footer) ───────────── */}
        <Show when={sync.user() && step() !== "signIn"}>
          <div class="text-12-regular text-text-dim text-center -mt-2">
            {language.t("dialog.connectSync.step2.signedInAs", { email: sync.user()!.email })}
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

function OwnerLabel(props: { ownerType: "personal" | "team" | "company" }) {
  const language = useLanguage()
  return (
    <Switch>
      <Match when={props.ownerType === "personal"}>
        {language.t("dialog.connectSync.step2.ownerPersonal")}
      </Match>
      <Match when={props.ownerType === "team"}>
        {language.t("dialog.connectSync.step2.ownerTeam")}
      </Match>
      <Match when={props.ownerType === "company"}>
        {language.t("dialog.connectSync.step2.ownerCompany")}
      </Match>
    </Switch>
  )
}

function VaultIcon(props: { ownerType: "personal" | "team" | "company" }) {
  return (
    <div class="w-8 h-8 rounded-md bg-background-element flex items-center justify-center text-text-dim group-hover:text-text-strong transition-colors shrink-0">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" class="w-4 h-4">
        <Switch>
          <Match when={props.ownerType === "personal"}>
            <path d="M10 10a3 3 0 100-6 3 3 0 000 6zM4 17a6 6 0 0112 0" stroke-linecap="round" stroke-linejoin="round" />
          </Match>
          <Match when={props.ownerType === "team"}>
            <path d="M7 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM13 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM2 16a5 5 0 0110 0M10 16a5 5 0 018-4" stroke-linecap="round" stroke-linejoin="round" />
          </Match>
          <Match when={props.ownerType === "company"}>
            <path d="M3 17V5a1 1 0 011-1h7a1 1 0 011 1v12M12 9h4a1 1 0 011 1v7M6 8h2M6 11h2M6 14h2" stroke-linecap="round" stroke-linejoin="round" />
          </Match>
        </Switch>
      </svg>
    </div>
  )
}
