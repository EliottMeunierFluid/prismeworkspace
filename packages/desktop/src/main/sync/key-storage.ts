/**
 * Stockage chiffré OS de la master_key par vault.
 *
 * Utilisé par sync:connect (après unlock) pour permettre la réactivation
 * automatique de la sync au prochain démarrage (sync:reactivate) sans avoir
 * à ressaisir le password compte.
 *
 * Mécanisme : electron.safeStorage (macOS Keychain, Windows DPAPI, Linux
 * libsecret). Pas de native binding additionnel — c'est l'API officielle.
 *
 * SECURITY :
 *  - La masterKey (32B) est stockée chiffrée par le keystore OS.
 *  - Une autre app sur le même OS ne peut PAS la lire (sauf si root/admin).
 *  - Quand l'utilisateur sign out du vault, on efface la clé via clearMasterKey.
 *  - Si safeStorage n'est pas dispo (rare — Linux sans libsecret), on ne
 *    stocke rien → l'utilisateur ressaisira le password à chaque démarrage.
 */

import { safeStorage } from "electron"
import log from "electron-log"
import Store from "electron-store"
import { SETTINGS_STORE } from "../constants"

interface KeyStore {
  /** clé = `vault_master_key.${vaultId}`, valeur = base64 du buffer chiffré */
  [key: string]: string | undefined
}

let store: Store<KeyStore> | undefined

function getStore(): Store<KeyStore> {
  if (!store) {
    store = new Store<KeyStore>({ name: SETTINGS_STORE })
  }
  return store
}

function storageKey(vaultId: string): string {
  return `vault_master_key.${vaultId}`
}

/**
 * Stocke la master_key chiffrée pour le vault donné.
 * @throws si safeStorage n'est pas disponible.
 */
export function storeMasterKey(vaultId: string, masterKey: Buffer): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS encryption (Keychain/DPAPI/libsecret) is not available — cannot store master_key",
    )
  }
  const encrypted = safeStorage.encryptString(masterKey.toString("base64"))
  getStore().set(storageKey(vaultId), encrypted.toString("base64"))
  log.info("[sync/key-storage] master_key stored", { vaultId })
}

/**
 * Lit la master_key pour le vault donné. Retourne null si absente ou illisible.
 */
export function loadMasterKey(vaultId: string): Buffer | null {
  const encoded = getStore().get(storageKey(vaultId))
  if (!encoded) return null
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn("[sync/key-storage] cannot decrypt master_key — safeStorage unavailable")
    return null
  }
  try {
    const encrypted = Buffer.from(encoded, "base64")
    const b64 = safeStorage.decryptString(encrypted)
    return Buffer.from(b64, "base64")
  } catch (err) {
    log.warn("[sync/key-storage] failed to decrypt master_key", {
      vaultId,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Efface la master_key d'un vault (sign out de ce vault).
 */
export function clearMasterKey(vaultId: string): void {
  getStore().delete(storageKey(vaultId))
  log.info("[sync/key-storage] master_key cleared", { vaultId })
}

/**
 * Efface toutes les master_keys (global sign out / désactivation sync).
 */
export function clearAllMasterKeys(): void {
  const all = getStore().store
  let count = 0
  for (const key of Object.keys(all)) {
    if (key.startsWith("vault_master_key.")) {
      getStore().delete(key)
      count++
    }
  }
  log.info("[sync/key-storage] all master_keys cleared", { count })
}
