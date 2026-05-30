/**
 * Stockage et lecture du JWT longue durée obtenu via le flow OAuth desktop.
 *
 * Architecture (cf DESKTOP_UI_SYNC_INTEGRATION.md §PR 1) :
 *  - JWT signé HS256 par le site SaaS ③ (workspace.prisme.one)
 *  - TTL 30 jours, sliding rotation au démarrage desktop (Q2)
 *  - Stocké chiffré côté OS via electron.safeStorage (macOS Keychain, Windows
 *    DPAPI, Linux libsecret/kwallet). Plus simple que keytar (pas de native
 *    binding à compiler) et c'est l'API officielle Electron.
 *  - Persisté à côté du settings electron-store sous `auth.sync-token`.
 *
 * SECURITY :
 *  - safeStorage chiffre avec une clé liée à la session OS — un autre user du
 *    même OS ne peut pas lire la valeur (sauf si root/admin)
 *  - Si safeStorage.isEncryptionAvailable() est false (Linux sans libsecret),
 *    on refuse de stocker en clair → l'utilisateur doit ressaisir à chaque
 *    démarrage. C'est un compromis sécurité acceptable.
 *  - Le JWT n'est JAMAIS loggé.
 */

import { safeStorage } from "electron"
import log from "electron-log"
import Store from "electron-store"
import { SETTINGS_STORE } from "../constants"

const TOKEN_STORE_KEY = "auth.sync-token"

interface AuthStore {
  [TOKEN_STORE_KEY]?: string // base64 du buffer chiffré par safeStorage
}

let store: Store<AuthStore> | undefined

function getStore(): Store<AuthStore> {
  if (!store) {
    store = new Store<AuthStore>({ name: SETTINGS_STORE })
  }
  return store
}

/**
 * Décodage minimal d'un JWT (juste le payload — pas de vérification de
 * signature, c'est le serveur qui le fait au handshake WS).
 *
 * Sert uniquement à extraire `email`, `plan`, `exp` pour l'UI desktop.
 */
export interface DecodedTokenPayload {
  sub: string
  email: string
  plan: "free" | "sync" | "team"
  iat: number
  exp: number
  iss: string
  aud: string
}

export function decodeJwtPayload(token: string): DecodedTokenPayload | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8")
    const parsed = JSON.parse(payload) as DecodedTokenPayload
    if (!parsed.sub || !parsed.email) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Stocke le JWT chiffré dans le store electron.
 * @throws si safeStorage n'est pas disponible (Linux sans secret service).
 */
export function storeAuthToken(token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS encryption (Keychain/DPAPI/libsecret) is not available — cannot store auth token securely",
    )
  }
  const encrypted = safeStorage.encryptString(token)
  getStore().set(TOKEN_STORE_KEY, encrypted.toString("base64"))
  log.info("[sync/auth] token stored", {
    // log SEULEMENT les non-secrets (email, exp). Le token n'est JAMAIS loggé.
    decoded: redactedPayload(decodeJwtPayload(token)),
  })
}

/**
 * Lit le JWT stocké. Retourne null si absent, illisible, ou expiré.
 * Si expiré, on l'efface du store automatiquement.
 */
export function loadAuthToken(): string | null {
  const encoded = getStore().get(TOKEN_STORE_KEY)
  if (!encoded) return null
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn("[sync/auth] cannot decrypt token — safeStorage unavailable")
    return null
  }
  try {
    const encrypted = Buffer.from(encoded, "base64")
    const token = safeStorage.decryptString(encrypted)
    const payload = decodeJwtPayload(token)
    if (!payload) {
      log.warn("[sync/auth] stored token is malformed — clearing")
      clearAuthToken()
      return null
    }
    const nowSec = Math.floor(Date.now() / 1000)
    if (payload.exp <= nowSec) {
      log.info("[sync/auth] stored token is expired — clearing")
      clearAuthToken()
      return null
    }
    return token
  } catch (err) {
    log.warn("[sync/auth] failed to decrypt token", {
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Efface le JWT du store (sign out).
 */
export function clearAuthToken(): void {
  getStore().delete(TOKEN_STORE_KEY)
  log.info("[sync/auth] token cleared")
}

/**
 * Retourne les claims décodés du JWT stocké, ou null si pas de token valide.
 */
export function getCurrentUser(): DecodedTokenPayload | null {
  const token = loadAuthToken()
  return token ? decodeJwtPayload(token) : null
}

function redactedPayload(p: DecodedTokenPayload | null): object {
  if (!p) return { decoded: false }
  return {
    sub_prefix: p.sub.slice(0, 8),
    email: p.email,
    plan: p.plan,
    exp: new Date(p.exp * 1000).toISOString(),
  }
}
