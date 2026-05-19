/**
 * Client REST minimal vers le site SaaS ③ (workspace-prisme-one).
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §3.2 + contracts/rest.ts
 * de `@prisme/sync-crypto/contracts`.
 *
 * Le sync_token JWT (HS256, TTL 1h) est obtenu côté renderer via NextAuth ;
 * il est passé ici en input — pas de gestion de session côté main.
 *
 * Endpoints utilisés :
 *   - POST /api/vaults                 : créer un vault
 *   - POST /api/vaults/:id/access      : valide keyhash, retourne ws_url
 *
 * SECURITY : les erreurs HTTP ne doivent PAS contenir le sync_token. On log
 * le code HTTP + corps si non-2xx, mais jamais les headers d'auth.
 */

import log from "electron-log"
import type {
  Vault,
  VaultAccessResponse,
  VaultCreateRequest,
} from "@prisme/sync-crypto/contracts"

export interface RestClientOptions {
  /** Base URL du site SaaS ③, ex: https://workspace.prisme.one ou http://localhost:3000 */
  baseUrl: string
  /** JWT sync_token (HS256, TTL 1h) — Bearer pour toutes les requêtes. */
  syncToken: string
}

export interface RestClient {
  createVault: (req: VaultCreateRequest) => Promise<Vault>
  /**
   * Demande à ③ l'URL du serveur sync ② pour ce vault, après vérification
   * keyhash (preuve de possession). Retourne 403 INVALID_KEYHASH si mauvais
   * password.
   */
  getVaultAccess: (vaultId: string, keyhashHex: string) => Promise<VaultAccessResponse>
}

export function createRestClient(opts: RestClientOptions): RestClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, "")

  async function request<T>(
    method: string,
    path: string,
    body?: object,
  ): Promise<T> {
    const url = `${baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.syncToken}`,
      Accept: "application/json",
    }
    if (body !== undefined) headers["Content-Type"] = "application/json"

    log.info("[sync/rest] request", { method, path })
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      // SECURITY: pas de log d'headers (Authorization contiendrait le sync_token).
      log.warn("[sync/rest] non-2xx", { method, path, status: res.status, body: text.slice(0, 500) })
      throw new Error(`HTTP ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }

  return {
    createVault: (req) => request<Vault>("POST", "/api/vaults", req),
    getVaultAccess: (vaultId, keyhashHex) =>
      request<VaultAccessResponse>(
        "POST",
        `/api/vaults/${encodeURIComponent(vaultId)}/access`,
        { keyhash: keyhashHex },
      ),
  }
}
