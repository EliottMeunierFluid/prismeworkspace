/**
 * Context Prisme Sync — vault E2EE de fichiers (Bloc ②).
 *
 * À ne pas confondre avec context/sync.tsx qui sync les sessions OpenCode
 * via le SDK. Ce context-ci gère la connexion au serveur sync
 * sync.workspace.prisme.one pour synchroniser les fichiers d'un workspace
 * de manière E2EE multi-device.
 *
 * Source de vérité : DESKTOP_UI_SYNC_INTEGRATION.md (sandbox sync).
 *
 * Expose :
 *  - currentUser    : info compte loggé (email, plan) ou null
 *  - currentStatus  : état de la sync engine pour le workspace courant
 *  - connectedWorkspaces : Array<WorkspaceSyncEntry> persisté localement
 *  - signIn()       : démarre le flow OAuth navigateur
 *  - signOut()      : déconnexion globale (efface token + master keys)
 *  - openConnectDialog(workspaceRoot, vaultName) : ouvre le wizard
 *  - disconnect(workspaceRoot) : déconnecte un workspace
 *
 * Polling : status engine toutes les 3s (cohérent avec le pattern
 * health polling de context/server.tsx).
 */

import { createMemo, createSignal, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"

const POLL_INTERVAL_MS = 3000

export type SyncEngineStatus =
  | { state: "idle" }
  | { state: "activating" }
  | { state: "connecting" }
  | { state: "ready"; vaultVersion: number }
  | { state: "disconnected"; reason: string }
  | { state: "error"; message: string }

export interface CurrentUser {
  email: string
  plan: "free" | "sync" | "team"
}

export interface ConnectedWorkspace {
  workspaceRoot: string
  vaultId: string
  vaultName: string
  saltHex: string
  connectedAt: string
}

export interface ConnectDialogTarget {
  /** Chemin absolu du workspace à connecter. */
  workspaceRoot: string
  /** Nom affiché de l'item ouvert (souvent basename(workspaceRoot)). */
  workspaceName?: string
}

interface PrismeSyncStore {
  ready: boolean
  user: CurrentUser | null
  status: SyncEngineStatus
  workspaces: ConnectedWorkspace[]
  /**
   * Si true, le wizard de connexion s'ouvre automatiquement quand
   * l'utilisateur ouvre un workspace pas encore connecté à un vault
   * (Option A — opt-in volontaire dans Settings → Sync).
   */
  askOnOpen: boolean
}

const STORE_NAME = "opencode.settings"
const STORE_KEY_ASK_ON_OPEN = "sync.askOnOpen"

/**
 * Accès safe à window.api — en mode web (sans Electron) on retourne null
 * et toute opération sync est désactivée.
 */
function getApi(): NonNullable<Window["api"]> | null {
  if (typeof window === "undefined") return null
  return window.api ?? null
}

export const { use: usePrismeSync, provider: PrismeSyncProvider } = createSimpleContext({
  name: "PrismeSync",
  init: () => {
    const [store, setStore] = createStore<PrismeSyncStore>({
      ready: false,
      user: null,
      status: { state: "idle" },
      workspaces: [],
      askOnOpen: false,
    })

    const [dialogTarget, setDialogTarget] = createSignal<ConnectDialogTarget | null>(null)

    // ─── Setting persisté askOnOpen ─────────────────────────────────────
    async function loadAskOnOpen(): Promise<void> {
      const api = getApi()
      if (!api?.storeGet) return
      try {
        const v = await api.storeGet(STORE_NAME, STORE_KEY_ASK_ON_OPEN)
        setStore("askOnOpen", v === "true")
      } catch {
        setStore("askOnOpen", false)
      }
    }

    async function setAskOnOpen(value: boolean): Promise<void> {
      setStore("askOnOpen", value)
      const api = getApi()
      if (!api?.storeSet) return
      try {
        await api.storeSet(STORE_NAME, STORE_KEY_ASK_ON_OPEN, value ? "true" : "false")
      } catch {
        // silencieux — la valeur reste en mémoire jusqu'au prochain démarrage
      }
    }

    // ─── Fetch initial + polling ────────────────────────────────────────
    async function refreshUser(): Promise<void> {
      const api = getApi()
      if (!api?.authCurrentUser) {
        setStore("user", null)
        return
      }
      try {
        const u = await api.authCurrentUser()
        setStore("user", u ?? null)
      } catch {
        setStore("user", null)
      }
    }

    async function refreshStatus(): Promise<void> {
      const api = getApi()
      if (!api?.syncStatus) {
        setStore("status", { state: "idle" })
        return
      }
      try {
        const s = await api.syncStatus()
        setStore("status", s)
      } catch {
        // silencieux — n'écrase pas en cas d'erreur réseau ponctuelle
      }
    }

    async function refreshWorkspaces(): Promise<void> {
      const api = getApi()
      if (!api?.workspacesListConnected) {
        setStore("workspaces", [])
        return
      }
      try {
        const ws = await api.workspacesListConnected()
        setStore("workspaces", ws ?? [])
      } catch {
        setStore("workspaces", [])
      }
    }

    async function refreshAll(): Promise<void> {
      await Promise.all([refreshUser(), refreshStatus(), refreshWorkspaces(), loadAskOnOpen()])
      setStore("ready", true)
    }

    void refreshAll()

    // Polling status seulement (user + workspaces sont mutés par les actions)
    createEffect(() => {
      let alive = true
      const tick = (): void => {
        if (!alive) return
        void refreshStatus()
      }
      const handle = setInterval(tick, POLL_INTERVAL_MS)
      onCleanup(() => {
        alive = false
        clearInterval(handle)
      })
    })

    // ─── Actions ────────────────────────────────────────────────────────
    async function signIn(): Promise<{ ok: boolean; error?: string }> {
      const api = getApi()
      if (!api?.authSignIn) return { ok: false, error: "Desktop API unavailable" }
      const res = await api.authSignIn()
      if (res.ok) {
        await refreshUser()
      }
      return res
    }

    async function signOut(): Promise<void> {
      const api = getApi()
      if (!api?.authSignOut) return
      await api.authSignOut()
      setStore({ user: null, status: { state: "idle" }, workspaces: [] })
    }

    async function disconnect(workspaceRoot: string): Promise<void> {
      const api = getApi()
      if (!api?.syncDisconnect) return
      await api.syncDisconnect(workspaceRoot)
      await refreshWorkspaces()
      await refreshStatus()
    }

    /**
     * Tente une réactivation rapide d'un workspace en utilisant la masterKey
     * stockée dans le keychain OS (skip scrypt). Retourne true si l'engine
     * est passé en état `ready`, false sinon (raisons : pas de masterKey
     * stockée, pas signedIn, erreur réseau...).
     *
     * Idempotent : si l'engine est déjà actif pour ce workspace, no-op.
     */
    async function tryReactivate(workspaceRoot: string): Promise<boolean> {
      const api = getApi()
      if (!api?.syncReactivate) return false
      const currentStatus = store.status
      // Déjà actif → rien à faire
      if (currentStatus.state === "ready" || currentStatus.state === "activating" || currentStatus.state === "connecting") {
        return currentStatus.state === "ready"
      }
      try {
        const res = await api.syncReactivate(workspaceRoot)
        setStore("status", res.status)
        return res.ok
      } catch {
        return false
      }
    }

    /**
     * Indique si une masterKey est stockée dans le keychain pour ce workspace.
     * Utilisé par l'UI pour différencier "Connect to sync" (rien en mémoire)
     * de "Unlock to sync" (clé absente mais workspace dans registry).
     */
    async function hasStoredKey(workspaceRoot: string): Promise<boolean> {
      const api = getApi()
      if (!api?.syncHasStoredKey) return false
      try {
        return await api.syncHasStoredKey(workspaceRoot)
      } catch {
        return false
      }
    }

    function openConnectDialog(target: ConnectDialogTarget): void {
      setDialogTarget(target)
    }

    function closeConnectDialog(): void {
      setDialogTarget(null)
    }

    async function onConnected(): Promise<void> {
      setDialogTarget(null)
      await refreshWorkspaces()
      await refreshStatus()
    }

    return {
      ready: createMemo(() => store.ready),
      user: createMemo(() => store.user),
      status: createMemo(() => store.status),
      workspaces: createMemo(() => store.workspaces),
      askOnOpen: createMemo(() => store.askOnOpen),
      dialogTarget,
      signIn,
      signOut,
      disconnect,
      tryReactivate,
      hasStoredKey,
      openConnectDialog,
      closeConnectDialog,
      onConnected,
      refreshWorkspaces,
      setAskOnOpen,
      isSyncingWorkspace(workspaceRoot: string): boolean {
        return store.workspaces.some((w) => w.workspaceRoot === workspaceRoot)
      },
      getWorkspaceEntry(workspaceRoot: string): ConnectedWorkspace | undefined {
        return store.workspaces.find((w) => w.workspaceRoot === workspaceRoot)
      },
    }
  },
})
