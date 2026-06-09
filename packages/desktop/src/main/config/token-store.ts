/**
 * Cache chiffré du token `prism_*` self-service obtenu via /api/config/tokens/me.
 *
 * Même approche que `sync/auth.ts` : chiffrement OS via `safeStorage`
 * (Keychain/DPAPI/libsecret), persistance dans electron-store. Le token n'est
 * jamais loggé ni stocké en clair.
 *
 * On garde aussi `expiresAt` pour pouvoir régénérer le token avant expiration
 * sans appel réseau inutile.
 */

import { safeStorage } from "electron"
import log from "electron-log"
import Store from "electron-store"
import { SETTINGS_STORE } from "../constants"
import { fetchPrismToken } from "./api"

const TOKEN_KEY = "config.prism-token"
const EXPIRES_KEY = "config.prism-token-expires"
// Marge de sécurité : régénère si le token expire dans moins de 24h.
const EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000

interface ConfigTokenStore {
  [TOKEN_KEY]?: string // base64 du buffer chiffré
  [EXPIRES_KEY]?: string // ISO 8601
}

let store: Store<ConfigTokenStore> | undefined

function getStore(): Store<ConfigTokenStore> {
  if (!store) store = new Store<ConfigTokenStore>({ name: SETTINGS_STORE })
  return store
}

function storeToken(token: string, expiresAt: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS encryption (Keychain/DPAPI/libsecret) unavailable — cannot cache config token securely",
    )
  }
  const encrypted = safeStorage.encryptString(token)
  getStore().set(TOKEN_KEY, encrypted.toString("base64"))
  getStore().set(EXPIRES_KEY, expiresAt)
}

function loadCachedToken(): string | null {
  const encoded = getStore().get(TOKEN_KEY)
  const expires = getStore().get(EXPIRES_KEY)
  if (!encoded || !expires) return null
  if (!safeStorage.isEncryptionAvailable()) return null

  const expiresMs = Date.parse(expires)
  if (Number.isNaN(expiresMs) || expiresMs - EXPIRY_MARGIN_MS <= Date.now()) {
    // Expiré (ou bientôt) → forcer un refresh.
    return null
  }
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"))
  } catch (err) {
    log.warn("[config/token-store] failed to decrypt cached token", {
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function clearCachedToken(): void {
  getStore().delete(TOKEN_KEY)
  getStore().delete(EXPIRES_KEY)
}

/**
 * Retourne un token `prism_*` valide : depuis le cache si encore frais, sinon
 * en le régénérant via /api/config/tokens/me (nécessite d'être connecté au
 * compte Prisme Workspace — JWT sync présent).
 *
 * @param forceRefresh ignore le cache et régénère systématiquement.
 */
export async function getValidPrismToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = loadCachedToken()
    if (cached) return cached
  }
  const res = await fetchPrismToken()
  try {
    storeToken(res.token, res.expiresAt)
  } catch (err) {
    // safeStorage indisponible : on n'échoue pas la requête, on n'aura juste
    // pas de cache (re-fetch à chaque appel).
    log.warn("[config/token-store] token not cached", {
      message: err instanceof Error ? err.message : String(err),
    })
  }
  return res.token
}
