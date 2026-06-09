/**
 * Client HTTP de l'API config (prisme-one-configuration).
 *
 * Distinct du client `sync/api.ts` (qui parle au site SaaS workspace.prisme.one) :
 * ici on parle au serveur de configuration (skills/contexts/MCP), sur un autre
 * domaine.
 *
 * Authentification en deux temps (cf docs/CONFIG_FETCH_BUTTON_PLAN.md, variante 2a) :
 *   1. `fetchPrismToken()` — POST /api/config/tokens/me avec le **JWT sync**
 *      (Bearer, réutilisé depuis le keychain via sync/auth.ts). Le serveur
 *      vérifie ce JWT (secret partagé) et renvoie un token `prism_*` self-service.
 *   2. Tous les autres appels (/api/config/fetch|get|diff|push, /api/mcp-config…)
 *      utilisent ce token `prism_*` en Bearer.
 *
 * Le token `prism_*` est mis en cache chiffré (cf config/token-store.ts) et
 * régénéré automatiquement à expiration.
 */

import log from "electron-log"
import { loadAuthToken } from "../sync/auth"

const DEFAULT_CONFIG_API_URL = "https://prisme-one-config.eliottmeunier.com"

export function getConfigApiUrl(): string {
  return process.env.CONFIG_API_URL ?? DEFAULT_CONFIG_API_URL
}

// ─── Types miroir des réponses serveur ──────────────────────────────────────
// Source : prisme-one-configuration/libs/shared/src/types/config-sync.types.ts

export interface ManifestEntry {
  path: string
  hash: string
  scope: string
  permission: "read" | "write"
}

export interface SelfTokenResponse {
  token: string
  apiUrl: string
  expiresAt: string
}

export interface FileContent {
  content: string
  path: string
  hash: string
}

export interface PushChange {
  path: string
  action: "create" | "update" | "delete"
  content?: string
}

export interface PushResult {
  accepted: { path: string; action: string; status: string }[]
  rejected: { path: string; action: string; reason?: string }[]
}

/** Entrée MCP au format `.mcp.json` (cf integrations.types côté serveur). */
export type McpServerEntry =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }

export interface McpConfigResponse {
  mcpServers: Record<string, McpServerEntry>
}

// ─── Erreurs ────────────────────────────────────────────────────────────────

export interface ApiError {
  status: number
  code: string
  message: string
}

export class ConfigApiError extends Error {
  status: number
  code: string
  constructor(err: ApiError) {
    super(err.message)
    this.name = "ConfigApiError"
    this.status = err.status
    this.code = err.code
  }
}

// ─── Couche fetch ─────────────────────────────────────────────────────────

async function parseError(res: Response): Promise<ConfigApiError> {
  let code = "HTTP_ERROR"
  let message = `${res.status} ${res.statusText}`
  try {
    const body = (await res.json()) as { error?: string; code?: string; message?: string }
    if (body.code) code = body.code
    else if (body.error) code = body.error
    if (body.message) message = body.message
  } catch {
    // body non-JSON : on garde les valeurs par défaut
  }
  return new ConfigApiError({ status: res.status, code, message })
}

/**
 * Appel authentifié par le **JWT sync** (uniquement pour /tokens/me).
 */
async function fetchWithSyncJwt(path: string, init: RequestInit = {}): Promise<Response> {
  const jwt = loadAuthToken()
  if (!jwt) {
    throw new ConfigApiError({
      status: 401,
      code: "NO_TOKEN",
      message: "Not signed in to Prisme Workspace",
    })
  }
  const headers = new Headers(init.headers ?? {})
  headers.set("Authorization", `Bearer ${jwt}`)
  headers.set("Accept", "application/json")
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  const res = await fetch(`${getConfigApiUrl()}${path}`, { ...init, headers })
  if (!res.ok) throw await parseError(res)
  return res
}

/**
 * Appel authentifié par un token `prism_*` (pour /api/config/* et /api/mcp-*).
 */
async function fetchWithPrismToken(
  prismToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set("Authorization", `Bearer ${prismToken}`)
  headers.set("Accept", "application/json")
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  const res = await fetch(`${getConfigApiUrl()}${path}`, { ...init, headers })
  if (!res.ok) throw await parseError(res)
  return res
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

/**
 * Échange le JWT sync contre un token `prism_*` self-service.
 * POST /api/config/tokens/me
 */
export async function fetchPrismToken(): Promise<SelfTokenResponse> {
  log.info("[config/api] POST /api/config/tokens/me")
  const res = await fetchWithSyncJwt("/api/config/tokens/me", { method: "POST" })
  return (await res.json()) as SelfTokenResponse
}

/** GET /api/config/fetch — manifest distant filtré par scope. */
export async function configFetch(prismToken: string): Promise<ManifestEntry[]> {
  log.info("[config/api] GET /api/config/fetch")
  const res = await fetchWithPrismToken(prismToken, "/api/config/fetch")
  const body = (await res.json()) as { entries?: ManifestEntry[] }
  return body.entries ?? []
}

/** GET /api/config/get?path= — contenu d'un fichier. */
export async function configGet(prismToken: string, path: string): Promise<FileContent> {
  log.info("[config/api] GET /api/config/get", { path })
  const res = await fetchWithPrismToken(
    prismToken,
    `/api/config/get?path=${encodeURIComponent(path)}`,
  )
  return (await res.json()) as FileContent
}

/** POST /api/config/push — envoi de modifications. */
export async function configPush(prismToken: string, changes: PushChange[]): Promise<PushResult> {
  log.info("[config/api] POST /api/config/push", { count: changes.length })
  const res = await fetchWithPrismToken(prismToken, "/api/config/push", {
    method: "POST",
    body: JSON.stringify({ changes }),
  })
  return (await res.json()) as PushResult
}

/** GET /api/mcp-config — serveurs MCP activés (format .mcp.json). */
export async function fetchMcpConfig(prismToken: string): Promise<McpConfigResponse> {
  log.info("[config/api] GET /api/mcp-config")
  const res = await fetchWithPrismToken(prismToken, "/api/mcp-config")
  return (await res.json()) as McpConfigResponse
}
