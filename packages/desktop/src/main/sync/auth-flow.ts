/**
 * Flow OAuth desktop : ouvre le navigateur sur workspace.prisme.one/oauth/desktop
 * et attend le retour via un serveur HTTP local éphémère.
 *
 * Architecture (cf DESKTOP_UI_SYNC_INTEGRATION.md §PR 1) :
 *  1. Démarre un serveur HTTP sur 127.0.0.1:<port-random> (0 = port libre OS)
 *  2. Génère un nonce CSRF (`state`)
 *  3. Ouvre dans le navigateur système :
 *     https://workspace.prisme.one/oauth/desktop?callback=http://127.0.0.1:PORT/cb&state=NONCE
 *  4. Attend la requête GET /cb sur le serveur local
 *  5. Vérifie ?state= == nonce attendu, sinon rejet (CSRF protection)
 *  6. Si ?token= présent → stocke dans le keychain via auth.ts
 *  7. Si ?error= → reject avec le code d'erreur
 *  8. Affiche une page de confirmation HTML simple à l'utilisateur
 *  9. Ferme le serveur HTTP
 *
 * Timeout : 5 minutes max (au-delà, on assume que l'user a abandonné).
 */

import { createServer, type Server } from "node:http"
import { randomBytes } from "node:crypto"
import { shell } from "electron"
import log from "electron-log"
import { storeAuthToken, decodeJwtPayload } from "./auth"

const AUTH_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Prisme Workspace — Connected</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: #fafafa; color: #1a1a1a; display: flex; align-items: center;
    justify-content: center; min-height: 100vh; margin: 0; padding: 2rem; }
  .card { max-width: 28rem; text-align: center; padding: 2rem;
    background: white; border: 1px solid #e5e5e5; border-radius: 0.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { color: #666; font-size: 0.875rem; line-height: 1.5; margin: 0; }
  .check { width: 3rem; height: 3rem; margin: 0 auto 1rem; color: #16a34a; }
</style></head>
<body><div class="card">
<svg class="check" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
<h1>Connected to Prisme Workspace</h1>
<p>You can close this tab and return to the desktop app.</p>
</div></body></html>`

const ERROR_HTML = (msg: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Prisme Workspace — Error</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: #fafafa; color: #1a1a1a; display: flex; align-items: center;
    justify-content: center; min-height: 100vh; margin: 0; padding: 2rem; }
  .card { max-width: 28rem; text-align: center; padding: 2rem;
    background: white; border: 1px solid #e5e5e5; border-radius: 0.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #dc2626; }
  p { color: #666; font-size: 0.875rem; line-height: 1.5; margin: 0; }
</style></head>
<body><div class="card">
<h1>Authorization failed</h1>
<p>${escapeHtml(msg)}</p>
</div></body></html>`

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!)
}

export interface AuthFlowResult {
  ok: boolean
  email?: string
  plan?: "free" | "sync" | "team"
  error?: string
}

export interface AuthFlowOptions {
  /** Base URL du site SaaS. Défaut : https://workspace.prisme.one */
  siteUrl?: string
}

/**
 * Démarre le flow OAuth. Bloque jusqu'à ce que l'utilisateur ait autorisé
 * ou refusé, ou que le timeout soit atteint.
 */
export async function startAuthFlow(
  opts: AuthFlowOptions = {},
): Promise<AuthFlowResult> {
  const siteUrl = opts.siteUrl ?? "https://workspace.prisme.one"
  const state = randomBytes(16).toString("base64url")

  // Promise qui se résout quand la requête /cb arrive
  let resolveResult: (r: AuthFlowResult) => void = () => {}
  const resultPromise = new Promise<AuthFlowResult>((res) => {
    resolveResult = res
  })

  // Crée un serveur HTTP local éphémère
  const server: Server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400
      res.end()
      return
    }
    // Parse URL relative
    const url = new URL(req.url, `http://127.0.0.1`)
    if (url.pathname !== "/cb") {
      res.statusCode = 404
      res.end()
      return
    }
    const receivedState = url.searchParams.get("state") ?? ""
    const token = url.searchParams.get("token")
    const error = url.searchParams.get("error")

    if (receivedState !== state) {
      log.warn("[sync/auth-flow] state mismatch — possible CSRF")
      res.statusCode = 400
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(ERROR_HTML("CSRF state mismatch. Please retry."))
      resolveResult({ ok: false, error: "csrf_state_mismatch" })
      return
    }

    if (error) {
      log.info("[sync/auth-flow] user denied", { error })
      res.statusCode = 200
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(ERROR_HTML(`Authorization was denied (${error}).`))
      resolveResult({ ok: false, error })
      return
    }

    if (!token) {
      res.statusCode = 400
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(ERROR_HTML("Missing token in callback."))
      resolveResult({ ok: false, error: "missing_token" })
      return
    }

    try {
      storeAuthToken(token)
      const payload = decodeJwtPayload(token)
      log.info("[sync/auth-flow] token stored", {
        email: payload?.email,
        plan: payload?.plan,
      })
      res.statusCode = 200
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(SUCCESS_HTML)
      resolveResult({
        ok: true,
        email: payload?.email,
        plan: payload?.plan,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error("[sync/auth-flow] failed to store token", { message: msg })
      res.statusCode = 500
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(ERROR_HTML(msg))
      resolveResult({ ok: false, error: msg })
    }
  })

  // Bind sur un port libre OS-assigned
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const addr = server.address()
  if (!addr || typeof addr === "string") {
    server.close()
    return { ok: false, error: "failed_to_bind_local_server" }
  }
  const port = addr.port
  const callback = `http://127.0.0.1:${port}/cb`
  const oauthUrl = `${siteUrl}/oauth/desktop?callback=${encodeURIComponent(callback)}&state=${encodeURIComponent(state)}`

  log.info("[sync/auth-flow] starting", { siteUrl, port })
  await shell.openExternal(oauthUrl)

  // Timeout safety net
  const timeoutHandle = setTimeout(() => {
    log.warn("[sync/auth-flow] timeout")
    resolveResult({ ok: false, error: "timeout" })
  }, AUTH_TIMEOUT_MS)

  try {
    const result = await resultPromise
    clearTimeout(timeoutHandle)
    return result
  } finally {
    // Ferme le serveur HTTP local. Petit délai pour laisser la page de
    // confirmation se rendre côté navigateur.
    setTimeout(() => {
      server.close()
    }, 1000)
  }
}
