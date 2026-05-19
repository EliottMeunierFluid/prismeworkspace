/**
 * Prisma Workspace Sync — Client de synchronisation E2EE.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §4 (côté client) et
 * docs/CRYPTO_SPEC-v2.md.
 *
 * Principe directeur (cf BRIEF_BLOC_1_CLIENT_SYNC.md §0) :
 *   Le `vault_password` et les clés dérivées vivent UNIQUEMENT dans le process
 *   main d'Electron, en RAM, jamais persistés en clair, jamais transmis sur le
 *   réseau. Seul le `keyhash` part au serveur. Si une clé ou le password touche
 *   le disque ou le réseau, c'est un bug de sécurité.
 *
 * Module exposé via IPC depuis `packages/desktop/src/main/ipc.ts`.
 */

export { SyncEngine } from "./engine"
export type { SyncConfig, SyncStatus } from "./engine"
