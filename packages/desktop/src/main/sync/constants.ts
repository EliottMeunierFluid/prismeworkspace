/**
 * Constantes du client de synchronisation.
 *
 * Source de vérité : docs/SYNC_ARCHITECTURE_SPEC.md §3.3.2 (constantes
 * opérationnelles) et §4 (côté client).
 */

// ─── WebSocket ──────────────────────────────────────────────────────────────
/** Intervalle entre deux ping client → serveur (heartbeat). */
export const WS_PING_INTERVAL_MS = 20_000

/** Délai avant de considérer la connexion morte si pas de pong reçu. */
export const WS_PONG_TIMEOUT_MS = 10_000

/** Idle disconnect serveur — on doit envoyer au moins 1 message dans cette fenêtre. */
export const WS_IDLE_TIMEOUT_MS = 120_000

// ─── Reconnect backoff ──────────────────────────────────────────────────────
/** Délai initial avant la 1ère tentative de reconnexion. */
export const RECONNECT_INITIAL_MS = 1_000

/** Délai maximum entre deux tentatives (cap). */
export const RECONNECT_MAX_MS = 60_000

/** Multiplicateur exponentiel (1s → 2s → 4s → 8s → ... → 60s). */
export const RECONNECT_MULTIPLIER = 2

/** Jitter (variation aléatoire ±N%) pour éviter les "thundering herds". */
export const RECONNECT_JITTER = 0.3

// ─── File watcher ───────────────────────────────────────────────────────────
/** Délai d'attente après un événement filesystem avant de considérer le
 *  fichier stable (debounce + détection rename atomique tempfile+rename). */
export const FS_AWAIT_WRITE_FINISH_MS = 500

/** Intervalle de re-sweep périodique (safety-net si watcher rate un event). */
export const PERIODIC_SWEEP_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

/** Patterns à exclure du watcher (en plus des défauts chokidar). */
export const FS_IGNORED_PATTERNS = [/\.prisma-sync/, /\.git/, /node_modules/]

// ─── Crypto / payload ───────────────────────────────────────────────────────
/** Version byte attendue/produite. Cf @prisme/sync-crypto VERSION_BYTE. */
export const CRYPTO_VERSION = 1

// ─── Chemins locaux ─────────────────────────────────────────────────────────
/** Dossier de configuration sync par workspace (à la racine du workspace). */
export const SYNC_CONFIG_DIRNAME = ".prisma-sync"

/** Nom du fichier SQLite de state. */
export const SYNC_STATE_DB_FILENAME = "state.db"
