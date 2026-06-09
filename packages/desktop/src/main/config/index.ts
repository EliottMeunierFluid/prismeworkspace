/**
 * Module config — récupération native de la configuration plateforme (skills,
 * contexts, .mcp.json) depuis un bouton UI, sans passer par l'IA.
 *
 * Auth : variante 2a (cf docs/CONFIG_FETCH_BUTTON_PLAN.md) — le JWT sync est
 * échangé contre un token prism_ self-service via /api/config/tokens/me.
 *
 * Câblé dans le main via `registerConfigIpcHandlers()`.
 */

export { registerConfigIpcHandlers, type ConfigStatus } from "./ipc"
export type { PullReport, SyncPlan, SyncReport, ConflictResolution } from "./engine"
export type { DiffResult, DiffEntry, ConflictEntry } from "./diff"
