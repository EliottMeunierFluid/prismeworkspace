/**
 * Registry des workspaces synchronisés.
 *
 * Lien (workspaceRoot → vault_id, salt_hex). Persisté dans electron-store
 * pour pouvoir lister les workspaces connectés depuis Settings → Sync, et
 * réactiver automatiquement la sync au démarrage.
 *
 * NB : la même info existe déjà dans `<workspaceRoot>/.prisma-sync/state.db`
 * (table meta). Cette registry-ci est une vue agrégée à l'échelle de l'install
 * pour ne pas avoir à ouvrir N state.db pour la liste UI.
 */

import log from "electron-log"
import Store from "electron-store"
import { SETTINGS_STORE } from "../constants"

const REGISTRY_KEY = "sync.workspaces"

export interface WorkspaceSyncEntry {
  workspaceRoot: string
  vaultId: string
  vaultName: string
  /** salt hex pour pouvoir re-dériver master_key à la demande. */
  saltHex: string
  /** ISO date du moment de la connexion initiale. */
  connectedAt: string
}

interface RegistryStore {
  [REGISTRY_KEY]?: WorkspaceSyncEntry[]
}

let store: Store<RegistryStore> | undefined

function getStore(): Store<RegistryStore> {
  if (!store) {
    store = new Store<RegistryStore>({ name: SETTINGS_STORE })
  }
  return store
}

export function listConnectedWorkspaces(): WorkspaceSyncEntry[] {
  return getStore().get(REGISTRY_KEY) ?? []
}

export function getWorkspaceEntry(
  workspaceRoot: string,
): WorkspaceSyncEntry | undefined {
  return listConnectedWorkspaces().find((e) => e.workspaceRoot === workspaceRoot)
}

export function addOrUpdateWorkspace(entry: WorkspaceSyncEntry): void {
  const list = listConnectedWorkspaces()
  const idx = list.findIndex((e) => e.workspaceRoot === entry.workspaceRoot)
  if (idx >= 0) {
    list[idx] = entry
  } else {
    list.push(entry)
  }
  getStore().set(REGISTRY_KEY, list)
  log.info("[sync/registry] workspace upserted", {
    workspaceRoot: entry.workspaceRoot,
    vaultId: entry.vaultId,
  })
}

export function removeWorkspace(workspaceRoot: string): void {
  const list = listConnectedWorkspaces().filter(
    (e) => e.workspaceRoot !== workspaceRoot,
  )
  getStore().set(REGISTRY_KEY, list)
  log.info("[sync/registry] workspace removed", { workspaceRoot })
}

export function clearAllWorkspaces(): void {
  getStore().delete(REGISTRY_KEY)
  log.info("[sync/registry] all workspaces cleared")
}
