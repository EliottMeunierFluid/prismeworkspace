/**
 * Wrapper HTTP autour de l'API du site SaaS ③ (workspace.prisme.one).
 *
 * Injecte automatiquement le Bearer JWT stocké dans le keychain. Toutes les
 * requêtes passent par cette couche pour bénéficier d'une gestion d'erreur
 * uniforme (401 → token expiré → demander re-login).
 *
 * Endpoints utilisés :
 *   GET /api/vaults                  → liste des vaults du user
 *   POST /api/vaults/:id/access      → vérif keyhash + ws_url (pour engine)
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
 * Vérifie l'accès à un vault donné (envoie keyhash, reçoit ws_url + vault_version).
 *
 * NOTE : non utilisé dans la v1 — l'engine reçoit le ws_url directement via
 * la config IPC. À garder pour quand on passera ce flow par le site SaaS.
 */
export interface VaultAccessResponse {
  allowed: boolean
  ws_url: string
  vault_version: number
}

export async function getVaultAccess(
  vaultId: string,
  keyhashHex: string,
): Promise<VaultAccessResponse> {
  log.info("[sync/api] POST /api/vaults/:id/access", { vaultId })
  const res = await authFetch(`/api/vaults/${vaultId}/access`, {
    method: "POST",
    body: JSON.stringify({ keyhash: keyhashHex }),
  })
  return (await res.json()) as VaultAccessResponse
}
