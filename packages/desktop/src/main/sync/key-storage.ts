/**
 * Stockage chiffré OS de la master_key par vault.
 *
 * v1 : module présent mais NON utilisé activement — la masterKey est dérivée
 * en RAM à chaque sync:connect (cf KEYCHAIN_OS.md Q3 dans
 * DESKTOP_UI_SYNC_INTEGRATION.md). v1.1+ activera la persistance keychain
 * pour éviter la ressaisie du vault_password à chaque démarrage.
 *
 * On garde le module pour :
 *  - clearAllMasterKeys() appelé au sign out global pour nettoyer toute
 *    persistance résiduelle d'une éventuelle version antérieure
 *  - faciliter l'activation en v1.1 (juste appeler storeMasterKey dans
 *    sync:connect et ajouter un sync:reactivate)
 *
 * Mécanisme : electron.safeStorage (macOS Keychain, Windows DPAPI, Linux
 * libsecret). Pas de native binding additionnel — c'est l'API officielle.
 *
 * SECURITY :
 *  - La master_key dérivée scrypt(vault_password, salt) est stockée chiffrée.
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
