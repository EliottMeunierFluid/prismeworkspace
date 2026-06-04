/**
 * Prisma Workspace Sync — Client de synchronisation E2EE (key wrapping v2.0).
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4 (côté client) +
 * docs/CRYPTO_SPEC-v2.md + BRIEF_KEY_WRAPPING.md.
 *
 * Principe directeur :
 *   Le password compte, la privateKey user et la masterKey du vault vivent
 *   UNIQUEMENT dans le process main d'Electron, en RAM (la masterKey est
 *   aussi persistée chiffrée dans le keystore OS pour la réactivation auto).
 *   Jamais transmis sur le réseau en clair. Seul le `keyhash` (preuve de
 *   possession publique) part au serveur. Si une clé en clair touche le
 *   disque ou le réseau, c'est un bug de sécurité.
 *
 * Module exposé via IPC depuis `packages/desktop/src/main/ipc.ts`.
 */

export { SyncEngine } from "./engine"
export type { SyncConfig, SyncStatus } from "./engine"
export { registerSyncIpcHandlers, shutdownSync } from "./ipc"
