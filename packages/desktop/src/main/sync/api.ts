/**
 * Wrapper HTTP autour de l'API du site SaaS ③ (workspace.prisme.one).
 *
 * Injecte automatiquement le Bearer JWT stocké dans le keychain. Toutes les
 * requêtes passent par cette couche pour bénéficier d'une gestion d'erreur
 * uniforme (401 → token expiré → demander re-login).
 *
 * Endpoints utilisés :
 *   GET /api/vaults                  → liste des vaults du user
 *   GET /api/vaults/:id/membership   → sealed box + méta vault (key wrapping v2)
 *   GET /api/auth/me                 → profil + méta crypto user
 */

import log from "electron-log"
import { loadAuthToken } from "./auth"

const DEFAULT_SITE_URL = "https://workspace.prisme.one"

export interface VaultListItem {
  id: string
  name: string
  owner_type: "personal" | "team" | "company"
  region: string
  quota_bytes: number
  crypto_version: number
  /** Salt hex (64 chars = 32 bytes) — public, sert à dériver master_key côté client. */
  salt: string
  size_bytes: number
  version: number
  created_at: string
}

export interface ApiError {
  status: number
  code: string
  message: string
}

export class SyncApiError extends Error {
  status: number
  code: string
  constructor(err: ApiError) {
    super(err.message)
    this.status = err.status
    this.code = err.code
  }
}

function getSiteUrl(): string {
  return process.env.SYNC_SITE_URL ?? DEFAULT_SITE_URL
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = loadAuthToken()
  if (!token) {
    throw new SyncApiError({
      status: 401,
      code: "NO_TOKEN",
      message: "Not signed in to Prisme Workspace",
    })
  }
  const url = `${getSiteUrl()}${path}`
  const headers = new Headers(init.headers ?? {})
  headers.set("Authorization", `Bearer ${token}`)
  headers.set("Accept", "application/json")
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    let code = "HTTP_ERROR"
    let message = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      if (body.error) code = body.error
      if (body.message) message = body.message
    } catch {
      // body non-JSON, on garde les valeurs par défaut
    }
    throw new SyncApiError({ status: res.status, code, message })
  }
  return res
}

/**
 * Liste les vaults accessibles à l'utilisateur courant.
 */
export async function listVaults(): Promise<VaultListItem[]> {
  log.info("[sync/api] GET /api/vaults")
  const res = await authFetch("/api/vaults")
  const body = (await res.json()) as { vaults?: VaultListItem[] }
  return body.vaults ?? []
}

/**
 * Membership v2.0 : `encrypted_master_key` (sealed box) + méta du vault.
 * Renvoyé par GET /api/vaults/:id/membership. Le client unwrap localement
 * avec sa privateKey Curve25519 pour obtenir la masterKey en clair.
 */
export interface VaultMembership {
  vault_id: string
  user_id: string
  encrypted_master_key_hex: string
  role: "admin" | "member"
  added_at: string
  vault: {
    id: string
    name: string
    owner_type: "personal" | "team" | "company"
    crypto_version: number
    salt_hex: string
    keyhash_hex: string
  }
}

/**
 * Récupère le membership de l'utilisateur courant pour un vault v2.0.
 * Renvoie `encrypted_master_key` (sealed box) + méta nécessaires à l'engine.
 *
 * 404 si l'user n'est pas membre, le vault n'existe pas, ou est deleted.
 */
export async function getVaultMembership(
  vaultId: string,
): Promise<VaultMembership> {
  log.info("[sync/api] GET /api/vaults/:id/membership", { vaultId })
  const res = await authFetch(`/api/vaults/${vaultId}/membership`)
  return (await res.json()) as VaultMembership
}

/**
 * Méta crypto du user courant (keypair Curve25519 chiffré par account_kek).
 * Renvoyé par GET /api/auth/me, utilisé pour reconstruire la privateKey à
 * partir du password compte.
 */
export interface AccountCryptoMeta {
  public_key_hex: string
  encrypted_private_key_hex: string
  private_key_salt_hex: string
  private_key_nonce_hex: string
}

export interface CurrentUserResponse {
  id: string
  email: string
  plan: "free" | "sync" | "team"
  display_name: string | null
  crypto: AccountCryptoMeta | null
}

/**
 * Récupère le profil + méta crypto du user courant.
 *
 * `crypto: null` = compte legacy pré-v2.0 sans keypair (cas désormais
 * inexistant en prod, décision "pas de migration utilisateur" actée
 * 2026-06-02).
 */
export async function getCurrentUserProfile(): Promise<CurrentUserResponse> {
  log.info("[sync/api] GET /api/auth/me")
  const res = await authFetch("/api/auth/me")
  return (await res.json()) as CurrentUserResponse
}
