/**
 * Client WebSocket de synchronisation.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §3.3 + BRIEF_BLOC_1 §4.2.
 *
 * Connecte au serveur sync ② via wss://.../sync, JWT dans header upgrade.
 * Reconnexion backoff exponentiel 1s→60s avec jitter 30%. Heartbeat ping
 * toutes les 20s (cf constants.ts).
 *
 * State machine simple :
 *   disconnected ─connect()─► connecting ─open─► open ─error/close─► disconnected
 *   open ─ping 20s──► open
 *
 * Le handshake `init` est géré dans engine.ts (étape 26), pas ici.
 */

import log from "electron-log"
import { WebSocket } from "ws"
import {
  RECONNECT_INITIAL_MS,
  RECONNECT_JITTER,
  RECONNECT_MAX_MS,
  RECONNECT_MULTIPLIER,
  WS_PING_INTERVAL_MS,
} from "../constants"

export type WsClientState =
  | "disconnected"
  | "connecting"
  | "open"
  | "closing"

export interface WsClientOptions {
  url: string
  /** Bearer JWT dans le header Authorization de l'upgrade HTTP. */
  syncToken: string
  /** Appelé à chaque message texte reçu (JSON). */
  onMessage: (data: unknown) => void
  /** Appelé à chaque BinaryMessage reçu. */
  onBinary: (chunk: Buffer) => void
  /** Appelé une fois quand le WS s'ouvre (avant les premiers messages). */
  onOpen: () => void
  /** Appelé à chaque fermeture (incluant reconnect). */
  onClose: (code: number, reason: string) => void
}

export interface WsClient {
  /** Démarre la connexion. Idempotent — no-op si déjà connecté. */
  connect: () => void
  /** Envoie un message JSON (string sérialisé). */
  sendJson: (msg: object) => void
  /** Envoie un BinaryMessage (Buffer brut, déjà chiffré). */
  sendBinary: (chunk: Buffer) => void
  /** Ferme proprement la connexion (pas de reconnect après). */
  close: () => void
  /** État courant pour debug/UI. */
  getState: () => WsClientState
}

/**
 * Construit un client WS avec reconnect + heartbeat intégré.
 */
export function createWsClient(opts: WsClientOptions): WsClient {
  let socket: WebSocket | undefined
  let state: WsClientState = "disconnected"
  let reconnectAttempt = 0
  let reconnectTimer: NodeJS.Timeout | undefined
  let pingTimer: NodeJS.Timeout | undefined
  let stopped = false

  function clearTimers(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = undefined
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return
    const base = Math.min(
      RECONNECT_INITIAL_MS * Math.pow(RECONNECT_MULTIPLIER, reconnectAttempt),
      RECONNECT_MAX_MS,
    )
    const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1)
    const delay = Math.max(0, Math.floor(base + jitter))
    log.info("[sync/ws] scheduling reconnect", {
      attempt: reconnectAttempt + 1,
      delayMs: delay,
    })
    reconnectTimer = setTimeout(() => {
      reconnectAttempt++
      doConnect()
    }, delay)
  }

  function doConnect(): void {
    if (stopped || state === "connecting" || state === "open") return
    state = "connecting"
    log.info("[sync/ws] connecting", { url: opts.url })

    // SECURITY: le sync_token JWT va dans le header Authorization, pas l'URL
    // (pas de log d'URL contenant des tokens).
    socket = new WebSocket(opts.url, {
      headers: {
        Authorization: `Bearer ${opts.syncToken}`,
      },
    })

    socket.on("open", () => {
      state = "open"
      reconnectAttempt = 0
      log.info("[sync/ws] open")
      pingTimer = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: "ping" }))
        }
      }, WS_PING_INTERVAL_MS)
      opts.onOpen()
    })

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        opts.onBinary(data)
        return
      }
      const parsed: unknown = (() => {
        try {
          return JSON.parse(data.toString("utf8"))
        } catch {
          log.warn("[sync/ws] non-JSON text message", { len: data.length })
          return undefined
        }
      })()
      if (parsed !== undefined) opts.onMessage(parsed)
    })

    socket.on("close", (code: number, reason: Buffer) => {
      state = "disconnected"
      clearTimers()
      socket = undefined
      const reasonStr = reason.toString("utf8")
      log.info("[sync/ws] closed", { code, reason: reasonStr })
      opts.onClose(code, reasonStr)
      if (!stopped) scheduleReconnect()
    })

    socket.on("error", (err: Error) => {
      log.warn("[sync/ws] error", { message: err.message })
      // close suivra naturellement
    })
  }

  return {
    connect: doConnect,
    sendJson: (msg) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        log.warn("[sync/ws] sendJson while not open — dropped")
        return
      }
      socket.send(JSON.stringify(msg))
    },
    sendBinary: (chunk) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        log.warn("[sync/ws] sendBinary while not open — dropped")
        return
      }
      socket.send(chunk, { binary: true })
    },
    close: () => {
      stopped = true
      clearTimers()
      state = "closing"
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close(1000, "client requested close")
      }
    },
    getState: () => state,
  }
}
